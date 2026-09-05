import { randomUUID } from 'node:crypto';
import {
  type RedisLike,
  roomKeys,
  LEASE_TTL_MS,
  LEASE_RENEW_MS,
  MAX_TICKER_MS,
  EMPTY_GRACE_MS,
  acquireLease,
  renewLease,
  releaseLease,
  tickerShouldExit,
  createOwnershipClock,
  renewAttempted,
  renewConfirmed,
  renewFailed,
  mayPublish,
  renewDue,
  type OwnershipClock,
  CHECKPOINT_VERSION,
  JOIN_HEARTBEAT_MS,
  PRESENCE_TIMEOUT_HEARTBEATS,
  packCheckpoint,
  inspectCheckpoint,
  PlayoutBuffer,
  PLAYOUT_MAX_AHEAD,
  StarveTracker,
  Inbox,
  RollingHistogram,
  type RoomRuntime,
  type RoomEnvelope,
  type ClientInput,
  type CheckpointEnvelope,
  type RoomStats,
  type Logger,
} from '../core/index.js';
import { writeCheckpoint, readCheckpoint, STATE_TTL_S } from './checkpoint.js';
import type { Subscriber } from './redis.js';


/**
 * The leased, fixed-timestep authoritative tick loop. This is the engine
 * that makes "exactly one authoritative writer per room, and a successor
 * takes over inside a second when the platform kills this one" true. A host
 * implements `RoomRuntime` for its own simulation and calls `runTicker`
 * from whatever the platform invokes to run a long-lived function (a route
 * handler, a queue worker, a container's main loop); everything below is
 * the part that never changes between hosts.
 */
export interface TickerOptions<TState, TEvent> {
  runtime: RoomRuntime<TState, TEvent>;
  /** The shared command client (see `server/redis.ts`, `getRedis`). Never a subscriber connection: this ticker opens its own via `createSubscriber`. */
  redis: RedisLike;
  /** Builds a fresh subscriber connection for this ticker's own `keys.in` subscription. */
  createSubscriber(): Subscriber;
  roomId: string;
  namespace?: string | undefined;
  /**
   * Spawns a successor for this exact room. Given the room id, must issue
   * an authenticated request back to whatever endpoint runs `runTicker`
   * (see `session.ts`'s spawn token). Called from `finally`, not gated on
   * still holding the lease: see the long comment at the call site for why
   * both of those are load-bearing.
   *
   * A SPAWN IS A DELIVERY, NOT A CONVERSATION: this must resolve once the
   * request has been DELIVERED, and reject only when it never left. The
   * endpoint being called does not answer until the ticker it started EXITS,
   * minutes later, so the response is the successor's whole life and must not
   * be awaited; a host that awaits it reports a healthy room as a failed spawn
   * (see `SPAWN_ACK_MS` in `adapters/vercel.ts`, and `spawnTicker` in
   * `server/relay.ts`, which states the same contract). A rejection is read
   * here as "no ticker was started" and is the only thing worth the
   * `ticker.spawn-failed` line. The library never aborts the request it
   * issued: it stops WAITING (`EXIT_SPAWN_WAIT_MS` on the exit path, which is
   * sized to outlast a host's delivery receipt) and leaves the connection to
   * the platform.
   *
   * `opts.standby` says WHICH of the two spawns this is, and the host has to
   * pass it through to the successor's own `standbyMs`. `standby: false` is
   * the historical one, fired as this ticker exits, where the successor is
   * expected to win the acquire immediately because this ticker has already
   * released. `standby: true` is fired `standbyLeadMs` BEFORE the duration
   * cap, so the successor is already booted, already past its own `init`, and
   * already polling for the lease at the instant this one lets go: it turns
   * the planned handoff from "spawn, cold start, acquire, restore" into one
   * acquire. A host that ignores the flag and starts an ordinary ticker gets
   * the old behaviour minus one wasted invocation, because that ticker loses
   * its acquire and returns 'busy' immediately.
   */
  spawnSuccessor?: ((roomId: string, opts: { standby: boolean }) => Promise<unknown>) | undefined;
  /**
   * One-time asynchronous setup this ticker needs before it can simulate:
   * instantiating a wasm module, spinning up a worker, loading a baked
   * table off disk. Awaited AFTER the lease is won and before anything
   * touches the runtime (including `deserialize`, which for a physics-backed
   * simulation is itself a consumer of whatever this initialises).
   *
   * THE ORDERING IS THE ENTIRE POINT AND IT IS NOT COSMETIC. The obvious
   * placement is in the caller, before `runTicker`, and that is wrong in a
   * way that only shows up under exactly the conditions this library exists
   * to survive. Acquiring the lease is a race that almost every invocation
   * LOSES: when a room's lease genuinely lapses, every socket's jittered
   * poll fires a spawn at once, and all but one of them are supposed to
   * discover that within a single Redis round trip and return 'busy' having
   * done nothing. Put a multi-megabyte wasm init in front of the acquire and
   * every one of those losers pays it in full before finding out it had no
   * work to do: a cold start, a compile, and a heap allocation, repeated
   * once per connected socket, on the one code path whose entire budget is
   * the sub-second handoff gap players are not supposed to notice.
   *
   * Behind the acquire it is paid exactly once, by the ticker that is
   * actually going to use it.
   *
   * A throw here is fatal to this invocation and handled as such: the lease
   * is released so a successor is not locked out for the whole TTL, and the
   * ticker returns 'error' without spawning one, because a successor would
   * hit the identical failure and the pair would spin.
   */
  init?: (() => Promise<void>) | undefined;
  /**
   * A digest of the world geometry / rules this room's state must have been
   * simulated against. THE SINGLE MOST IMPORTANT OPTIONAL FIELD HERE: see
   * the restore block below for what silently breaks without it.
   */
  geomKey?: (() => string) | undefined;
  /**
   * What to do when a checkpoint's `geom` does not match `geomKey()`.
   *
   * `'reset'` (the default, and today's behaviour) discards the checkpoint
   * and builds a fresh room. It is always safe and always correct, and for
   * most hosts it is the right answer: a geometry-changing deploy costs
   * every live room its in-progress state once, which is the honest price
   * and is why such deploys belong outside peak hours.
   *
   * A FUNCTION is for the host that can do better than that. Some state
   * survives a geometry change perfectly well (who is in the room, their
   * names, their scores, the tick count) while only some of it does not
   * (positions relative to a wall that moved, a physics world built from the
   * old colliders). Such a host can rebuild the parts that are stale and
   * keep the parts that are not, turning "every room in the fleet is wiped"
   * into "everyone keeps their score, the map reloads". Return the partially
   * restored state to use it, or `null` to fall back to a full reset.
   *
   * The envelope is handed over whole, including its `tick` and `geom`, so
   * the callback can decide based on HOW stale the state is rather than only
   * that it is. A throw is treated as `null`: a partial restore that failed
   * is a corrupt room, and the fresh start is already the correct handling
   * for one.
   *
   * The restored room KEEPS THE CHECKPOINT'S INCARNATION on this path,
   * exactly as an ordinary restore does, because a partial restore is a
   * continuation of the same room and not a new one. An idempotency key
   * derived from it must stay stable across a restore or a replayed event
   * pays twice.
   */
  onGeomMismatch?: 'reset' | ((envelope: CheckpointEnvelope) => TState | null) | undefined;
  /** Events this tick emitted, handed to the host OFF the hot path (no await happens before or after this call inside the loop). */
  onEvents?: ((events: TEvent[], ctx: { roomId: string; tick: number; incarnation: string; redis: RedisLike }) => void) | undefined;
  onStats?: ((stats: RoomStats) => void) | undefined;
  log?: Logger | undefined;
  /** How often the state is checkpointed to Redis. Default 1000ms. */
  checkpointMs?: number | undefined;
  /** How often the stats gauge is flushed. Default 1000ms. */
  statsMs?: number | undefined;
  /** Hard ceiling on this ticker's own lifetime, ahead of the platform's kill. Default `MAX_TICKER_MS`. */
  maxRunMs?: number | undefined;
  /** How long an empty room is kept alive before exiting. Default `EMPTY_GRACE_MS`. */
  emptyGraceMs?: number | undefined;
  /** TTL refreshed on the meta hash every stats flush, so a hard-killed ticker cannot strand a phantom roster forever. Default 120s. */
  metaTtlS?: number | undefined;
  /**
   * Formats the roster broadcast published on the metaout channel.
   * Defaults to today's `{ t: 'meta', map }`.
   *
   * The symmetric half of the relay's `metaSeedPayload`, and for the same
   * reason: this frame is a CLIENT-VISIBLE WIRE SHAPE that, unlike a
   * snapshot, carries no version byte, so a host adopting this library
   * cannot use a protocol bump to force already-loaded bundles onto the new
   * shape. A client that parses its own established roster format typically
   * early-returns on anything it does not recognise, which is SILENT: no
   * throw, no console error, just an empty roster for every player (no name
   * tags, no presence count, no join and leave notifications) and no gate
   * anywhere that fails on it.
   *
   * Pair it with the relay's `metaSeedPayload`: that one shapes the SEED a
   * socket gets on connect, this one shapes the BROADCAST every socket gets
   * on a roster change. A host that overrides one and forgets the other
   * ships two different shapes down the same channel, so treat them as one
   * decision.
   *
   * Returning a value that does not serialise (`undefined`) suppresses the
   * broadcast entirely rather than publishing the string "undefined", which
   * is how a host seeding its roster by some other route opts out.
   */
  metaPayload?: ((map: Record<string, unknown>) => unknown) | undefined;
  /** Stamped into `RoomStats.build` for whoever reads the stats gauge. */
  buildId?: string | undefined;
  /**
   * Copied verbatim into `RoomStats.labels` on every flush, so a scraper can
   * dimension this room's gauges by something the library has no concept of
   * (which world it is, which region, which shard). Fixed for the lifetime
   * of the ticker on purpose: these become metric label values, and one whose
   * value varies with room state is unbounded cardinality in the backend.
   */
  statsLabels?: Record<string, string | number> | undefined;
  /**
   * How far past the tick being consumed a stamped input may be buffered.
   * Defaults to TWO SECONDS of ticks: `max(PLAYOUT_MAX_AHEAD, ceil(2000 /
   * tickMs))`, which is 40 at 20Hz (byte-identical to the old literal) and 120
   * at 60Hz.
   *
   * THE OVERFLOW POLICY IS A DISTANCE BOUND WITH REFUSAL, NOT A SIZE BOUND
   * WITH EVICTION, and the two are different in kind rather than at the
   * edges. Both keep memory bounded, so the choice looks arbitrary until a
   * client's clock runs away.
   *
   * Evicting the oldest entry once the buffer exceeds some SIZE means a
   * sender stamping ever-further-future ticks (a broken clock, a re-anchor
   * gone wrong, an adversary) pushes out precisely the entries that were
   * about to be consumed. Its own imminent, legitimate inputs are destroyed
   * to make room for inputs that will not be due for minutes, so the player
   * starves continuously while the buffer sits full, and the starvation
   * backstop decays their controls the whole time. The failure is
   * self-inflicted, invisible from the server, and does not clear until the
   * client happens to re-anchor.
   *
   * Refusing a push more than `maxAhead` ticks past the consumed floor
   * inverts that: the runaway stamps are the ones dropped, everything
   * already buffered is protected, and the moment the sender's stamps come
   * back into range they are accepted again. It is also a memory bound for
   * free, since the admissible window is exactly `maxAhead` distinct slots.
   * The cost is that a genuine burst of far-ahead input is refused rather
   * than half-kept, which is the correct trade: an input due 2 seconds from
   * now was going to be superseded by the redundancy window anyway.
   *
   * So the KIND is fixed deliberately and only the DISTANCE is tunable.
   * Raise it for a host with a very long client lead, lower it to make a
   * badly-clocked sender fail faster.
   *
   * THE DEFAULT IS A DURATION BECAUSE A TOLERANCE IS A TIME, NOT BECAUSE THIS
   * LIBRARY'S OWN CLIENT NEEDS IT. `RoomConnection` cannot reach the bound at
   * any tick rate, and the arithmetic is worth stating so nobody re-derives it
   * as a scare story. It stamps `desiredTick()`, which adds a whole round trip
   * on top of `estimateServerTick()`, but that estimate LAGS the true server
   * tick by the downstream one-way and the stamp then spends the upstream
   * one-way in flight, so the two halves of the round trip cancel: the distance
   * from the consumed floor AT ARRIVAL is `leadTicks + feedbackTicks`,
   * independent of RTT. `connection.ts` caps that sum at `PLAYOUT_MAX_AHEAD / 2`
   * (20 ticks), so the shipped client sits at most half way to the old literal
   * however bad the link is.
   *
   * WHAT THE DURATION SIZING IS ACTUALLY FOR is a THIRD-PARTY client of the
   * documented wire, which is a supported thing to write: one that stamps a
   * full RTT ahead of the server's CURRENT tick, rather than ahead of a lagged
   * estimate, really does sit an RTT past the floor. Against a fixed 40 that
   * sender is refused three times sooner at 60Hz than at 20Hz purely because
   * the constant is counted in ticks; against two seconds of ticks the same
   * sender gets the same tolerance at every rate. That is also the only honest
   * reading of the constant's own name: `PLAYOUT_MAX_AHEAD` was chosen as two
   * seconds, and it stops being two seconds the moment `tickHz` moves.
   *
   * Refusals are counted on `RoomStats.refusedInputs`, because the symptom
   * without a name was starves climbing for a reason no gauge in the room could
   * distinguish from packet loss.
   */
  playoutMaxAhead?: number | undefined;
  /**
   * Overrides `LEASE_TTL_MS`/`LEASE_RENEW_MS` from `core/lease.ts`. A host
   * has no reason to touch these in production (the defaults are the ones
   * this whole architecture was measured against), but a test that wants to
   * exercise the split-brain guard or a handoff without waiting out a real
   * multi-second lease window needs to shrink them, so they ride the same
   * options object rather than a separate test-only entry point.
   */
  leaseTtlMs?: number | undefined;
  leaseRenewMs?: number | undefined;
  /**
   * How long a pid may go without a `join` before this ticker synthesises a
   * `leave` for it. Defaults to `PRESENCE_TIMEOUT_HEARTBEATS` (5) of the
   * relay's `JOIN_HEARTBEAT_MS`, the one constant both sides are written
   * against.
   *
   * THE RELAY HEARTBEATS A JOIN EVERY SECOND AND THE ONLY REMOVAL WAS ONE
   * FIRE-AND-FORGET `leave`, so a departure that landed in a handoff gap (the
   * window where no ticker is subscribed, which is precisely when a relay is
   * most likely to be closing sockets) was simply lost. The player stayed in
   * the roster, in the meta hash, and in every successor's restored
   * checkpoint, forever: measured as a phantom player a room could never
   * drain, holding a capacity slot nobody could reclaim.
   *
   * The synthesised envelope carries no `c`, so it is honoured exactly like a
   * relay's own leave (see the connection-id rule on `RoomEnvelope`), and a
   * runtime with a disconnect grace sees it as an ordinary socket close: the
   * grace runs, a player who reconnects inside it resumes, and `presentPids`
   * still owns the final say on when the roster entry goes.
   *
   * A host that lowers the relay's `heartbeatMs`, or raises it, must keep
   * this at AT LEAST THREE of them: below that a live player is repeatedly
   * declared gone between beats, because one lost beat is then most of the
   * budget.
   */
  presenceTimeoutMs?: number | undefined;
  /**
   * Turns this invocation into a STANDBY: instead of returning 'busy' the
   * moment the acquire fails, it polls for the lease for this long and only
   * then gives up. Zero (the default) is the historical behaviour.
   *
   * This is the half of the handoff the successor spawn could not fix on its
   * own. The spawn lives in `finally`, so the successor only STARTS once the
   * predecessor has finished: the room then pays spawn plus cold start plus
   * acquire plus restore, 0.5 to 1.2s, where the client's interpolation delay
   * and extrapolation cover at most 650ms. A standby spawned `standbyLeadMs`
   * before the cap has already paid all of that and is sitting on the poll
   * when the lease is released, so the gap collapses to one acquire.
   *
   * IN STANDBY MODE `init` RUNS BEFORE THE ACQUIRE, which is the exact
   * opposite of the ordinary path and is not a contradiction of it. The
   * ordinary path puts `init` behind the acquire because losing the acquire is
   * the NORMAL outcome there (every connected socket's poll fires a spawn at
   * once and all but one must discover they have no work inside a round trip),
   * so a wasm compile in front of it is paid by every loser. A standby is the
   * DESIGNATED successor, fired by the incumbent and by nothing else, so there
   * are no losers to protect, and paying `init` while waiting is the entire
   * point of waiting.
   *
   * SIZE IT ABOVE `standbyLeadMs` PLUS THE INCUMBENT'S OWN EXIT. A standby
   * spawned `standbyLeadMs` before the cap has to still be polling when the
   * incumbent finally lets go, and the incumbent's last act is a final
   * checkpoint (a gzip of the whole room plus a round trip) followed by a
   * release. A `standbyMs` shorter than that gives up moments before the lease
   * frees, the room takes the cold handoff anyway, and the standby's cost was
   * paid for nothing. The adapters use 8000 against a 3000 lead.
   *
   * AND IT COMES OUT OF `maxRunMs`, WHICH BOUNDS THE INVOCATION. The lifetime
   * cap is measured from when this function was CALLED, not from when it won
   * the lease, because the platform that will kill this invocation is timing
   * the invocation. A standby that polls for four seconds therefore has four
   * seconds less in which to tick, and a host sizing `maxRunMs` against a
   * platform timeout has to leave room for `standbyMs` inside it.
   */
  standbyMs?: number | undefined;
  /**
   * How long before `maxRunMs` the standby successor is spawned. Default
   * 3000ms: long enough for a cold function start plus `init`, short enough
   * that the standby's own `standbyMs` poll is not most of its lifetime.
   *
   * Nothing is spawned when the room is empty, on the same reasoning the exit
   * spawn already uses: a room with nobody in it does not need a handoff.
   */
  standbyLeadMs?: number | undefined;
}

/**
 * Every `TickerOptions` field a HOST decides, with the four an adapter owns
 * removed. An adapter takes one of these and spreads it into its own
 * `runTicker` call, so a new ticker option is reachable from a route the day
 * it lands rather than after somebody remembers to copy the field through.
 * The same shape and the same reasoning as `HostRelayOptions`.
 */
export type HostTickerOptions<TState, TEvent> = Omit<
  TickerOptions<TState, TEvent>,
  'redis' | 'createSubscriber' | 'roomId' | 'spawnSuccessor'
>;

export interface TickerResult {
  /**
   * Why the loop stopped. `'input-dead'` is the one that needs explaining:
   * the ticker's own liveness probe never came back through its subscriber,
   * so it holds the lease over a room whose inputs it can no longer receive.
   * Handled exactly like `'duration'` (release, spawn a successor, which opens
   * a fresh subscriber) and reported separately because the two mean opposite
   * things about the health of the deployment.
   */
  reason: 'duration' | 'empty' | 'lease-lost' | 'busy' | 'error' | 'input-dead';
  ticks: number;
  uptimeMs: number;
}

// STATS_TTL_MS is ticker-specific presentation (how long the stats gauge
// key survives with nobody refreshing it) and has no counterpart in core.
// Everything else that used to live here (the bounded per-sender inbox, the
// percentile calculator) is now imported from `core`: see the import block
// above. Keeping a second copy of either was the actual bug this refactor
// fixes, not a style preference: two implementations of the per-sender
// quota WILL drift, and the failure mode if the global cap ever binds
// before the per-sender one is that a single flooding sender sheds EVERY
// player's input, not just their own.
const STATS_TTL_MS = 5000;

/**
 * How many snapshot publishes may be awaiting the bus before the next one is
 * SKIPPED rather than queued.
 *
 * A snapshot is full state, so one that cannot go out now is worthless later:
 * the next supersedes it. Queueing them anyway is actively harmful, because
 * ioredis buffers commands across a reconnect and then replays them, so a bus
 * blip becomes a burst of seconds-old snapshots delivered back to back the
 * moment it clears. Measured: every client's adaptive interpolation delay
 * inflated to about 470ms and held there for six seconds by one such burst,
 * which is the jitter buffer correctly absorbing a burst that should never
 * have been sent. Four is one publish in flight plus three ticks of slack at
 * 20Hz, i.e. the bus has to be at least 150ms behind before anything is
 * dropped.
 */
const MAX_IN_FLIGHT_PUBLISHES = 4;

/**
 * How far into the PAST a restored tick grid may be and still be continued,
 * in ticks. See the adoption window in `runTicker` for why it is asymmetric
 * and why this is 2 rather than 3: past two ticks the loop's own drift rule
 * resyncs on the first iteration, so a wider window would buy one stamp and
 * then abandon the grid regardless.
 */
const GRID_CATCHUP_TICKS = 2;

/**
 * Longest `pid` this ticker will accept off the wire. A pid is a Map key, a
 * Redis hash FIELD and a roster entry every client renders, so it is bounded
 * on the same reasoning the room id is bounded in `core/ids.ts`.
 */
const MAX_PID_LENGTH = 128;

/**
 * How much TIME of stamped input the playout buffer holds by default. The
 * bound `PlayoutBuffer` takes is in ticks, which means different things at
 * different tick rates, so the ticker sizes it from this instead: two seconds
 * at any rate, which is byte-identical to `PLAYOUT_MAX_AHEAD` at 20Hz.
 */
const PLAYOUT_AHEAD_MS = 2000;

/** Shortest gap between two `room-reject` frames for the same pid. One second, so the relay's own once-per-second join heartbeat is answered every time and anything faster is not. */
const REJECT_INTERVAL_MS = 1000;

/** How often a STANDBY invocation retries the acquire. Fast enough that the handoff gap is dominated by the predecessor's own release rather than by this poll. */
const STANDBY_POLL_MS = 25;

/** Default `standbyLeadMs`: a cold function start plus a host's `init`, with room to spare. */
const DEFAULT_STANDBY_LEAD_MS = 3000;

/**
 * Default `presenceTimeoutMs`, DERIVED from the relay's own join cadence
 * rather than retyped as a number beside it: `PRESENCE_TIMEOUT_HEARTBEATS`
 * (5) of `JOIN_HEARTBEAT_MS`. Exported so a test can pin the coupling that
 * used to be two literals in two files.
 */
export const DEFAULT_PRESENCE_TIMEOUT_MS = PRESENCE_TIMEOUT_HEARTBEATS * JOIN_HEARTBEAT_MS;

/**
 * Consecutive crashes after which a room is restarted FRESH instead of from
 * its checkpoint. A ticker that throws on restored state throws again in its
 * successor, and again in its successor's successor: the state that kills it
 * is the state every one of them restores. Three is enough to rule out a
 * one-off (a transient Redis reply, an unlucky race) and few enough that a
 * genuinely poisoned room recovers in seconds rather than never.
 */
const CRASH_LOOP_LIMIT = 3;

/** How long the crash counter survives. Short, so crashes minutes apart are never mistaken for a loop. */
const CRASH_KEY_TTL_S = 60;

/** How long the crash path waits for its own counter write before giving up on it. Short: the record is a heuristic, and an exit that cannot write it must not hang on it. */
const CRASH_RECORD_TIMEOUT_MS = 500;

/**
 * How long the exit spawn waits for `spawnSuccessor` to settle before it stops
 * waiting and lets `runTicker` return.
 *
 * THE BUDGET IS A DELIVERY RECEIPT, SO IT MUST OUTLAST A HOST'S OWN RECEIPT
 * WINDOW. `spawnSuccessor` resolves when the request has been DELIVERED and
 * rejects only when it never left (see its doc), and a host that decides
 * delivery on a timer needs longer than that timer to decide it. This was
 * 2000 against the Vercel adapter's 3000ms `SPAWN_ACK_MS`, so the race always
 * finished first: the exit spawn's receipt was never observed and
 * `ticker.spawn-failed` could not fire for an exit spawn on that host at all.
 *
 * THE EXIT SPAWN IS THE ONE THAT HAS TO REPORT, which is why the number moved
 * rather than the line being written off as redundant. The standby spawn
 * reports itself from inside a still-running loop, but it only fires on a
 * PLANNED duration exit with players present; a 'lease-lost', 'input-dead',
 * 'empty' or refused-standby exit never sent one, and on those paths this
 * rejection is the only thing that ever says the room has no ticker.
 *
 * 3500 is 3000 plus 500ms for the promise hop and timer slop. The coupling is
 * pinned by a test in `adapters/vercel.test.ts` rather than by an import,
 * because the ticker must not depend on an adapter and because 3000 is argued
 * from DNS, TLS and the platform accepting the request rather than derived
 * from this. The extra 1500ms comes out of `TICKER_EXIT_MARGIN_MS` (30s in
 * `adapters/vercel.ts`), the slice of the platform cap reserved for the final
 * checkpoint, the release and this spawn; that arithmetic clears the new
 * total by an order of magnitude. Exported so the test can pin it.
 */
export const EXIT_SPAWN_WAIT_MS = 3500;

/**
 * How often the input subscription is probed, and how long it may go
 * unanswered before it is declared dead.
 *
 * THEY ARE THEIR OWN CONSTANTS AND NOT A MULTIPLE OF `statsMs`, WHICH IS THE
 * BUG THIS REPLACES. The probe used to ride the stats flush, so the deadline
 * was three stats windows: a host that set `statsMs` to 40 to get a finer
 * metrics resolution, a change with no relationship to liveness at all, gave
 * itself a 120ms deadline and tore down a perfectly healthy room the moment
 * the bus took 150ms. A knob documented as a metrics cadence must not be able
 * to decide when a room dies.
 */
const PROBE_INTERVAL_MS = 1000;
const PROBE_DEAD_MS = 3000;

/** How many times a THROWN checkpoint read is retried before the ticker gives up rather than starting fresh over a transient fault. */
const CHECKPOINT_READ_ATTEMPTS = 3;

/** Gap between those retries. */
const CHECKPOINT_READ_RETRY_MS = 200;

const defaultLog: Logger = (ev) => {
  try {
    const fn = ev.lvl === 'error' ? console.error : ev.lvl === 'warn' ? console.warn : console.log;
    fn(`[tickroom:ticker] ${ev.kind}`, ev);
  } catch {
    // A logger must never throw into its caller. If console itself is
    // broken there is nothing useful left to do.
  }
};

/** `RoomEnvelope['t'] === 'join'` narrowing helper kept as a free function so `handleEnvelope` reads as a plain switch rather than a wall of type guards. */
function envelopePid(env: RoomEnvelope): string | null {
  return 't' in env && typeof (env as { pid?: unknown }).pid === 'string' ? ((env as { pid: string }).pid) : null;
}

/**
 * Publish a `custom` envelope onto a room's input channel, for the live
 * ticker to hand to `RoomRuntime.onCustom`.
 *
 * THE PRODUCER SIDE OF THE CONTROL CHANNEL, and it exists because for a
 * while there was not one: `RoomEnvelope` declared the variant, the ticker
 * consumed it, and nothing in the library ever emitted one, so the only way
 * to reach `onCustom` was to hand-roll the JSON at a call site and hope its
 * shape matched. A shape that did not match was not an error, it was
 * silence, because the ticker's switch had no default branch either. Both
 * halves are closed now: this produces the envelope, and an unrecognised `t`
 * is counted and summarised rather than dropped.
 *
 * NEVER CALL THIS FROM ANYTHING A CLIENT CAN REACH. `onCustom` is an
 * administrative surface: forcing a phase, resetting a round, injecting a
 * fixture. The relay deliberately does not produce this variant, so the only
 * envelopes of this kind on the bus are the ones a server-side caller put
 * there. Gate the endpoint that calls this exactly as hard as you would gate
 * direct write access to the room's state, because that is what it is.
 *
 * Fire-and-forget by nature (pub/sub drops a message with no subscriber, so a
 * room with no live ticker simply does not receive it); the returned promise
 * resolves when the PUBLISH is acknowledged, not when the ticker has acted.
 */
export async function publishCustom(
  redis: RedisLike,
  roomId: string,
  name: string,
  data?: unknown,
  opts?: { namespace?: string; pid?: string }
): Promise<void> {
  const keys = roomKeys(roomId, opts?.namespace);
  const envelope: RoomEnvelope = { t: 'custom', name, data, pid: opts?.pid };
  await redis.publish(keys.in, JSON.stringify(envelope));
}

export async function runTicker<TState, TEvent>(opts: TickerOptions<TState, TEvent>): Promise<TickerResult> {
  const {
    runtime,
    redis,
    createSubscriber,
    roomId,
    namespace,
    spawnSuccessor,
    init,
    geomKey,
    onGeomMismatch = 'reset',
    onEvents,
    onStats,
    log = defaultLog,
    checkpointMs = 1000,
    statsMs = 1000,
    maxRunMs = MAX_TICKER_MS,
    emptyGraceMs = EMPTY_GRACE_MS,
    metaTtlS = 120,
    metaPayload,
    buildId,
    statsLabels,
    playoutMaxAhead,
    leaseTtlMs = LEASE_TTL_MS,
    leaseRenewMs,
    presenceTimeoutMs = DEFAULT_PRESENCE_TIMEOUT_MS,
    standbyMs = 0,
    standbyLeadMs = DEFAULT_STANDBY_LEAD_MS,
  } = opts;

  // THE LIFETIME CLOCK, AND IT STARTS AT INVOCATION ENTRY RATHER THAN AT THE
  // ACQUIRE. `maxRunMs` exists to get this ticker out of the way before the
  // PLATFORM kills it, and the platform is timing the invocation, not the
  // ownership: a standby that polls for the lease for several seconds and then
  // measures its cap from the acquire outlives its own budget by the whole
  // wait, which is time the host's fit check never accounted for. The
  // OWNERSHIP clock is a different fact and still starts at the acquire
  // attempt; see `createOwnershipClock` below.
  const startedAt = Date.now();
  const keys = roomKeys(roomId, namespace);
  const tickMs = 1000 / runtime.tickHz;
  const owner = `${roomId}:${randomUUID()}`;
  const renewEveryMs = leaseRenewMs ?? LEASE_RENEW_MS;
  // A TOLERANCE IS A TIME, SO IT IS SIZED AS ONE. `PLAYOUT_MAX_AHEAD` is 40,
  // chosen as two seconds at 20Hz, and it silently stops being two seconds the
  // moment `tickHz` moves: 667ms at 60Hz. This library's OWN client never
  // approaches it either way (its stamps land `leadTicks + feedbackTicks` from
  // the floor, capped at half this bound, with the round trip cancelling out;
  // see `playoutMaxAhead`), so this is for a third-party client of the
  // documented wire that stamps a full RTT ahead of the server's current tick:
  // that sender gets the same tolerance at 60Hz as at 20Hz instead of a third
  // of it. The `max` keeps 20Hz byte-identical at 40 ticks.
  const defaultPlayoutMaxAhead = Math.max(PLAYOUT_MAX_AHEAD, Math.ceil(PLAYOUT_AHEAD_MS / tickMs));

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

  /** Runs the host's `init`, reporting rather than throwing. The two call sites differ only in whether a lease has to be released after a failure. */
  async function runInit(): Promise<boolean> {
    if (!init) return true;
    try {
      await init();
      return true;
    } catch (err) {
      log({ lvl: 'error', kind: 'ticker.init-failed', room: roomId, meta: { error: String(err) } });
      return false;
    }
  }

  // A STANDBY pays `init` in front of the acquire, and only a standby does.
  // See `standbyMs` for why the losers-pay-init argument that puts `init`
  // behind the acquire everywhere else does not apply to an invocation the
  // incumbent ticker spawned specifically to take over from it.
  if (standbyMs > 0 && !(await runInit())) {
    return { reason: 'error', ticks: 0, uptimeMs: 0 };
  }

  // --- 1. acquire the lease or bail immediately ---
  //
  // Exactly one ticker may own a room at a time; this is the primitive that
  // makes that true. Losing the acquire race is not an error, it is the
  // expected outcome for every invocation except the one that wins, so
  // callers should treat 'busy' as a normal, silent return rather than a
  // failure to log.
  //
  // A STANDBY keeps trying for `standbyMs` instead, because it EXPECTS to lose
  // the first acquire: it was spawned while the incumbent was still ticking,
  // so the whole point is to be waiting on the key at the instant that
  // incumbent releases it.
  //
  // THE OWNERSHIP CLOCK IS CREATED FROM THE ATTEMPT TIME, NOT FROM WHEN THE
  // REPLY LANDED, and not from a timestamp taken earlier in this function.
  // Redis set the key with its TTL when it PROCESSED the command, so the
  // attempt time is the last instant this ticker can prove anything about, and
  // anything later credits itself with ownership it may not have. Same rule as
  // the two renew sites below.
  let acquireAttemptAt = Date.now();
  let acquired = await acquireLease(redis, keys.lease, owner, { leaseTtlMs });
  if (!acquired && standbyMs > 0) {
    const standbyUntil = acquireAttemptAt + standbyMs;
    while (!acquired && Date.now() < standbyUntil) {
      await sleep(STANDBY_POLL_MS);
      acquireAttemptAt = Date.now();
      acquired = await acquireLease(redis, keys.lease, owner, { leaseTtlMs });
    }
  }
  if (!acquired) {
    return { reason: 'busy', ticks: 0, uptimeMs: 0 };
  }

  let clock: OwnershipClock = createOwnershipClock(acquireAttemptAt);
  let owns = true;
  let lostLeaseExplicitly = false;

  // --- counters, reset every stats flush (see the stats block) ---
  //
  // Declared this early because `renewFails` is written by the SETUP renew
  // below, which starts the moment the lease is won: a renew that fails while
  // this ticker is still restoring is exactly as much a renew failure as one
  // that fails mid-loop, and hiding it until the loop starts would make the
  // gauge lie about the window an unusually slow `init` sits in.
  let publishes = 0;
  let publishFails = 0;
  let publishSkipped = 0;
  let inFlightPublishes = 0;
  let dropped = 0;
  let starves = 0;
  let renewFails = 0;
  let bytesPublished = 0;
  let bytesDelivered = 0;
  let ticksSinceStats = 0;
  let hostErrors = 0;
  let refusedInputs = 0;
  let rejectsSuppressed = 0;
  let lastHostError = '';
  /** Which hook the last error came out of, so the flush summary says WHERE and not only that something threw. */
  let lastHostErrorHook = '';
  const cadenceHist = new RollingHistogram();
  const publishAwaitHist = new RollingHistogram();
  const serverInternalHist = new RollingHistogram();

  /**
   * A host hook threw, or the promise one of them returned rejected. Counted
   * and summarised once per stats flush, never logged per call: every one of
   * these sits on a path whose rate a CLIENT controls (an input envelope
   * reaches `applyInput` at the client's own send rate), so a line per
   * occurrence is a log amplifier, and on a host billing per log line a cost
   * amplifier. Measured before the fix: 51 warn lines for 51 `{data:null}`
   * inputs, which is a free megaphone for anyone who can open a socket.
   */
  function noteHostError(err: unknown, hook: string): void {
    hostErrors++;
    // Off the wire by way of a host's own error message, so bounded.
    lastHostError = String(err).slice(0, 200);
    lastHostErrorHook = hook;
  }

  /**
   * Calls one host-supplied function so that neither a throw nor a rejected
   * promise can reach the tick loop.
   *
   * BOTH HALVES ARE LOAD-BEARING AND THE SECOND ONE IS THE SUBTLE ONE. Every
   * `RoomRuntime` hook is declared to return `void`, and an `async` function
   * satisfies a `void` return perfectly: a host writing `async applyInput` (or
   * an `onStarve` that awaits a log write) type-checks, runs, and returns a
   * promise this loop drops on the floor. When that promise rejects there is
   * nothing anywhere to catch it, so it becomes an unhandledRejection, which
   * on a modern Node kills the process outright: the room dies without the
   * `finally` ever running, so no final checkpoint and no successor. Attaching
   * a `.catch` to anything thenable costs one type test per call and closes
   * that whole class.
   *
   * The synchronous half is why the loop survives a bad payload at all. A
   * stamped input whose contents make `applyInput` throw used to unwind the
   * entire loop, so ONE malformed record killed the ROOM (measured: exit
   * reason 'error' 82ms in), the successor restored the same state and died
   * the same way, and the pair span. `runtime.tick`, `currentTick`,
   * `playerCount`, `encodeSnapshot`, `serialize`, `create` and `deserialize`
   * are deliberately NOT wrapped: those are not reached through a payload, so
   * a throw in one is a genuine loop failure and must stay one.
   */
  function guardHost<T>(fn: () => T, hook: string, logKind?: string): T | undefined {
    const report = (err: unknown): void => {
      noteHostError(err, hook);
      // LOGGED PER CALL ONLY WHERE THE RATE IS NOT A TICK, which is the whole
      // of the rule and is why most call sites pass no `logKind`. `onStats`
      // fires once per flush and `metaPayload` once per roster change, both
      // cadences nothing on the wire can drive, so a line each is a signal.
      // `onEvents` fires every tick, so its line was 41 lines for 41 ticks,
      // and it is now counted and named in the one summary per flush like
      // every other hook.
      if (logKind !== undefined) log({ lvl: 'error', kind: logKind, room: roomId, meta: { error: String(err) } });
    };
    let out: T;
    try {
      out = fn();
    } catch (err) {
      report(err);
      return undefined;
    }
    if (out !== null && typeof out === 'object' && typeof (out as { then?: unknown }).then === 'function') {
      // `Promise.resolve` on a native promise returns that same promise, so
      // this attaches the handler to the rejection that would otherwise be
      // unhandled rather than to a copy of it; on a foreign thenable it
      // subscribes through `then`, which handles it just as well.
      void Promise.resolve(out).catch(report);
    }
    return out;
  }

  // --- 1a. renew through SETUP, not only through the loop ---
  //
  // NOTHING RENEWED BETWEEN THE ACQUIRE AND THE FIRST ITERATION, and setup is
  // not short: `init` may instantiate wasm or boot a worker, the checkpoint
  // read may retry, and `deserialize` rebuilds a whole world. An `init` plus
  // restore longer than `leaseTtlMs` therefore lost the lease before the loop
  // had run once, and the ticker discovered it on its first publish, exited
  // 'lease-lost', and spawned a successor that paid the identical setup and
  // lost it the identical way. Measured, and it is a loop, not a blip.
  //
  // A plain interval is the right shape here precisely because setup is
  // sequential awaits: there is no tick grid to protect, so this cannot
  // stretch anything, and it stops the moment the loop takes over renewing.
  let setupLostLease = false;
  const setupRenewTimer = setInterval(() => {
    const attemptAt = Date.now();
    clock = renewAttempted(clock, attemptAt);
    renewLease(redis, keys.lease, owner, { leaseTtlMs })
      .then((ok) => {
        if (ok) {
          clock = renewConfirmed(clock, Math.max(clock.lastOwnedAt, attemptAt));
        } else {
          clock = renewFailed(clock);
          renewFails++;
          setupLostLease = true;
          // AND THE LOOP'S OWN FLAG, because this reply can land in the window
          // between the interval being cleared and the loop starting, by which
          // time the `setupLostLease` check has already run. Discarded there,
          // a CONFIRMED loss is thrown away and this ticker publishes into a
          // room somebody else owns until its own renew cadence happens to
          // notice, which with a long `leaseRenewMs` is not soon. Setting both
          // means whichever side of that window the reply lands on, the run
          // ends on the same fact.
          lostLeaseExplicitly = true;
        }
      })
      .catch(() => {
        clock = renewFailed(clock);
        renewFails++;
      });
  }, renewEveryMs);

  /**
   * Abandons the run before the loop: stops the setup renew, detaches the bus
   * listener, closes the subscriber, disposes the room, optionally hands the
   * lease back, and reports.
   *
   * EVERY PRE-LOOP EXIT GOES THROUGH HERE, which is the point. The lease-lost
   * exit used to return on its own and leaked exactly the two things the
   * loop's `finally` exists to release: the input subscriber stayed attached
   * (one live Redis connection per abandoned run, against a plan whose
   * connection ceiling is the first wall this architecture hits) and
   * `runtime.dispose` never ran, so a host holding a wasm instance or a worker
   * leaked one of those per abandoned run too. Measured at one subscriber
   * still attached and zero dispose calls. No successor is spawned from any of
   * these paths, and none of them touches the crash counter.
   */
  async function abandonSetup(reason: TickerResult['reason'], release: boolean): Promise<TickerResult> {
    clearInterval(setupRenewTimer);
    if (onReconnecting !== null) redis.off?.('reconnecting', onReconnecting);
    try {
      sub?.disconnect();
    } catch {
      // best-effort teardown only
    }
    if (stateReady) {
      try {
        runtime.dispose?.(state);
      } catch (err) {
        log({ lvl: 'error', kind: 'ticker.dispose-threw', room: roomId, meta: { error: String(err) } });
      }
    }
    if (release) {
      try {
        await releaseLease(redis, keys.lease, owner);
      } catch {
        // Best effort. The lease's own TTL is the backstop.
      }
    }
    return { reason, ticks: 0, uptimeMs: Date.now() - startedAt };
  }

  // --- THE STATE SETUP BUILDS, DECLARED WHERE THE LOOP CAN SEE IT ---
  //
  // Everything below is assigned inside the guarded setup that follows, and
  // read by the loop and by the closures under it. Declared out here so the
  // guard can be a real block: `runtime.create`, `runtime.deserialize`,
  // `createSubscriber` and the meta read all run inside it, and any one of
  // them throwing used to escape `runTicker` with the lease still held and
  // the setup renew still ticking, which strands the room for the whole TTL
  // and leaks a timer for the lifetime of the process.
  let state: TState;
  let incarnation: string;
  /** The grid time the restored checkpoint's own tick was stamped with, or null when there was nothing to restore or it predates the field. See the `nextTickAt` initialiser. */
  let restoredGridAt: number | null = null;
  /** Set at the end of setup, once the restored or freshly created room can actually be counted. */
  let emptySince: number | null = null;

  // --- 3. metadata authority ---
  //
  // The ticker owns the pid -> meta map. It mirrors changes into the meta
  // hash as they happen (see the 'join'/'leave' handling below) and
  // republishes the WHOLE map on metaout only when something actually
  // changed, which is `metaDirty`.
  //
  // `metaDirty` STARTS TRUE, and that is not an accident of initialization
  // order. A predecessor that died between writing the hash and publishing
  // the metaout announcement for the same join would otherwise strand that
  // announcement forever: this successor restores a map that already
  // matches the hash bit for bit, so nothing about a normal join/leave check
  // would ever mark it dirty, and the roster that announcement was supposed
  // to deliver never reaches anyone who was not already subscribed at the
  // instant it fired. Starting dirty means the very first flush after a
  // restore (or a fresh create) always republishes the full map once, which
  // is a redundant publish in the common case and a correctness fix in the
  // uncommon one.
  const metaMap = new Map<string, Record<string, unknown>>();
  let metaDirty = true;
  const present = new Set<string>();
  /**
   * The RELAY CONNECTION each pid was last seen joining from. A `leave`
   * carrying a different one is a stale relay closing after the player's
   * replacement socket has already joined, which is the ordinary shape of a
   * reconnect and of the relay's own planned lifetime swap, and honouring it
   * removes a player who is still sitting in the room. See `RoomEnvelope`.
   */
  const connOf = new Map<string, string>();
  /**
   * When each pid was last seen JOINING. The relay heartbeats a join every
   * second, so a pid whose entry has gone stale has no relay behind it any
   * more; see `presenceTimeoutMs` for the phantom player that outlives every
   * successor without this.
   *
   * Seeded to now for every pid restored from the meta hash, so a phantom
   * inherited from a predecessor is timed out on the same clock as one this
   * ticker admitted itself rather than being trusted forever.
   */
  const lastJoinAt = new Map<string, number>();
  /** When each refused pid was last sent a `room-reject`, so the answer to a join flood is one frame rather than one per join. */
  const rejectedAt = new Map<string, number>();

  /** Opened inside the guarded setup below, so a `createSubscriber` that throws cannot leave this null AND the lease held. */
  let sub: Subscriber | null = null;
  /** The bus-reconnect listener, held so every exit can detach it from a client that outlives this call. */
  let onReconnecting: (() => void) | null = null;
  /** Set once `state` holds a room, so a teardown before that never hands `dispose` an undefined. */
  let stateReady = false;
  const inbox = new Inbox<RoomEnvelope>(); // core's defaults (cap 4096, perSenderCap 64, maxDrainPerTick 1024) are exactly what this ticker needs
  let badEnvelopes = 0;
  // Kept apart from `badEnvelopes` on purpose: a bad envelope is a broken or
  // hostile sender, an unknown one is almost always a producer deployed ahead
  // of its consumer. Merging them is what made the original failure invisible.
  let unknownEnvelopes = 0;
  let lastUnknownEnvelopeT = '';
  /** Probes issued on `keys.in`, and the highest `n` that came back through the subscriber. See section 10b for the liveness rule they encode. */
  let probesSent = 0;
  let probesAnswered = 0;
  /** When the last probe went out, and when one was last ANSWERED. The deadline is measured from the answer, so a probe cadence and a death deadline stay two separate decisions. */
  let lastProbeAt = 0;
  let lastProbeAnswerAt = 0;

  // The bus telling us it is reconnecting means every command since the drop
  // is queued rather than delivered, INCLUDING the renews that keep `clock`
  // believable. Ownership is then a claim about a connection that was down,
  // so the synchronous guard below runs on every iteration until an awaited
  // renew confirms otherwise, instead of waiting for `mayPublish` to age out.
  let busSuspect = false;

  // --- per-player playout state ---
  const playouts = new Map<string, PlayoutBuffer<ClientInput>>();
  const starve = new StarveTracker();
  /** Each buffer's `lateCount` as of the last stats flush, so the gauge reports the WINDOW's late inputs rather than a lifetime total that only ever climbs. */
  const lateSeen = new Map<string, number>();

  // --- SETUP, GUARDED AS ONE UNIT ---
  //
  // A throw anywhere in here is fatal to this invocation and handled exactly
  // like a failed `init`: the renew stops, the subscriber is closed, the lease
  // goes back so a successor is not locked out for the whole TTL, and nothing
  // is spawned. No crash increment either: this is an invocation that could
  // not start, not a room whose stored state kills whoever restores it, and
  // counting it would eventually make a healthy room start fresh for a reason
  // that had nothing to do with its checkpoint.
  //
  // A `catch` rather than a `finally`, deliberately: the early returns inside
  // (a failed init, a refused subscribe, an unreadable checkpoint) already do
  // their own teardown through `abandonSetup`, so a `finally` would run it a
  // second time on every one of those paths.
  try {
    // --- 1b. one-time async setup, PAID ONLY BY THE WINNER ---
    //
    // This sits between the acquire above and the restore below, and both
    // sides of that placement are load-bearing.
    //
    // It is after the ACQUIRE because losing the acquire is the normal
    // outcome: a lapsed lease makes every connected socket's poll fire a
    // spawn at once and all but one of those must discover they have no work
    // within a single Redis round trip. In front of the acquire, a wasm
    // instantiation or a worker boot is paid by every one of those losers,
    // multiplying a cold start by the room's population on the one path whose
    // whole budget is the handoff gap.
    //
    // It is before the RESTORE because `runtime.deserialize` is itself a
    // consumer of whatever this sets up: a simulation that rebuilds a physics
    // world from a checkpoint cannot do so before the physics engine exists.
    //
    // A throw releases the lease before returning. Holding it would lock the
    // room out for the full TTL on top of an invocation that already failed,
    // and no successor is spawned because a successor would fail identically
    // and the two would spin.
    //
    // A STANDBY has already paid it, in front of the acquire; see `standbyMs`.
    if (standbyMs === 0 && !(await runInit())) {
      return abandonSetup('error', true);
    }

    // --- 1c. the crash counter, read once ---
    //
    // A ticker that exits by THROWING increments this key on the way out (see
    // the `finally`), and the reason that matters is what the successor does
    // next: it restores the SAME checkpoint and, if the state is what made the
    // predecessor throw, dies in exactly the same place. Measured before the
    // guard: 40 spawns in 958ms, a room permanently gone with every metric
    // reporting the successor as a healthy cold start. Past `CRASH_LOOP_LIMIT`
    // the checkpoint is treated as poison and the room starts fresh, which
    // costs it its in-progress state once instead of forever. Same trade, same
    // reasoning, as the geometry digest below.
    let crashLoop = false;
    try {
      const raw = await redis.get(keys.crashes);
      const crashes = raw === null ? 0 : Number.parseInt(raw, 10);
      if (Number.isFinite(crashes) && crashes >= CRASH_LOOP_LIMIT) {
        crashLoop = true;
        log({
          lvl: 'error',
          kind: 'ticker.crash-loop',
          room: roomId,
          msg: 'consecutive ticker invocations have thrown: ignoring the stored checkpoint and starting this room fresh',
          meta: { crashes },
        });
        redis.del(keys.crashes).catch(() => {});
      }
    } catch {
      // A counter that could not be read is not evidence of a loop, and
      // refusing to start a room over an unreadable counter would be a worse
      // failure than the one it guards against. Fall through to the ordinary
      // restore.
    }

    // --- 1d. the timeline high-water mark ---
    //
    // A checkpoint's `gridAt` is the end of the room's timeline only when the
    // ticker that wrote it got to write a FINAL one. A thrown ticker does not
    // (see the exit policy), so the newest checkpoint is a PERIODIC one and
    // the predecessor kept publishing past it: measured 3 times out of 3, the
    // predecessor's last snapshot and the successor's first carried the same
    // `serverTime` on the same tick, because the successor continued from a
    // grid point its predecessor had already stamped. A repeat is worse than a
    // gap on this axis, since the client is being told two different states
    // are the same instant.
    //
    // So an exit that saves no checkpoint leaves this marker instead, and the
    // floor below is the later of the two. Best effort in both directions: an
    // unreadable marker simply reads as absent and the behaviour is exactly
    // what it was before this existed.
    let timelineFloor: number | null = null;
    try {
      const raw = await redis.get(keys.timeline);
      if (raw !== null) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) timelineFloor = parsed;
      }
    } catch {
      // An unreadable marker is an absent marker. It is a monotonicity floor,
      // not state: refusing to start a room over it would trade a repeated
      // stamp for a dead room.
    }

    // --- 2. restore from checkpoint, or create fresh ---
    //
    // THE GEOMETRY DIGEST IS THE SUBTLEST THING IN THIS FUNCTION. A checkpoint
    // carries opaque bytes: this ticker has no way to know, just by looking at
    // them, whether they describe a world that still matches the rules it is
    // about to run. Without a digest check, a deploy that changes the world's
    // colliders, its win conditions, or any other piece of "geometry" leaves
    // every LIVE room quietly restoring and re-saving a simulation of the OLD
    // world FOREVER: each successor faithfully restores its predecessor's
    // bytes, the checkpoint's TTL keeps getting refreshed by that very restore,
    // and nothing about this is visible in any ordinary metric (the room keeps
    // ticking at a healthy rate, snapshots keep flowing, players just play in a
    // world that diverged from the one that was deployed). Comparing the
    // checkpoint's `geom` against the host's current `geomKey()` and refusing a
    // mismatch turns that silent, permanent corruption into an ordinary fresh
    // start, which is a much smaller and much more honest failure.
    {
      let rawBody: string | null = null;
      // A THROWN READ IS NOT AN ABSENT CHECKPOINT, AND TREATING IT AS ONE COSTS
      // THE ROOM EVERYTHING. This used to log a warning and fall straight into
      // the 'absent' path, so a single rejected `GET` produced `runtime.create`,
      // a new incarnation, and a first loop iteration that OVERWROTE the
      // perfectly good checkpoint with the empty room a millisecond later.
      // Measured on one broken read: tick 45 to tick 3, incarnation changed,
      // nothing recoverable afterwards. Retrying costs a few hundred
      // milliseconds of handoff on a transient fault; giving up costs one
      // invocation and lets the relay's poll spawn a replacement that reads a
      // checkpoint which is still there. Neither costs the room its state.
      //
      // A value that WAS read and cannot be decoded keeps the start-fresh
      // handling below: that is `inspectCheckpoint`'s job, it is a fact about
      // the bytes rather than about the connection, and no amount of retrying
      // changes it.
      if (!crashLoop) {
        let readError: unknown = null;
        for (let attempt = 0; attempt < CHECKPOINT_READ_ATTEMPTS; attempt++) {
          try {
            rawBody = await readCheckpoint(redis, keys.state);
            readError = null;
            break;
          } catch (err) {
            readError = err;
            if (attempt < CHECKPOINT_READ_ATTEMPTS - 1) await sleep(CHECKPOINT_READ_RETRY_MS);
          }
        }
        if (readError !== null) {
          log({
            lvl: 'error',
            kind: 'ticker.checkpoint-read-failed',
            room: roomId,
            msg: 'giving up rather than starting fresh over a checkpoint that may well still be there',
            meta: { error: String(readError), attempts: CHECKPOINT_READ_ATTEMPTS },
          });
          return abandonSetup('error', true);
        }
      }
      // `inspectCheckpoint` rather than `unpackCheckpoint`, so a start-fresh
      // can SAY WHY. "There was no checkpoint" and "there was one this build
      // cannot read" produce the identical fresh room and are completely
      // different events: the first is an ordinary cold start, the second is a
      // deploy that just wiped the in-progress state of every live room in the
      // fleet, and an operator has to be able to tell them apart from the log
      // alone. Reported at `warn` for a real checkpoint that was refused and
      // said nothing at all for an absent one, so a cold room stays silent.
      const inspected = inspectCheckpoint(rawBody);
      const envelope = inspected.ok ? inspected.envelope : null;
      if (!inspected.ok && inspected.reason !== 'absent') {
        log({
          lvl: 'warn',
          kind: 'ticker.checkpoint-refused',
          room: roomId,
          msg: 'starting this room fresh: the stored checkpoint could not be used',
          meta: {
            reason: inspected.reason,
            foundVersion: inspected.foundVersion,
            expectedVersion: CHECKPOINT_VERSION,
          },
        });
      }
      const expectedGeom = geomKey?.();
      // OMITTING `geomKey` IS A SILENT FOOTGUN, so say so once, loudly, rather
      // than letting it pass unremarked.
      //
      // Without a digest there is nothing tying a checkpoint to the world it was
      // simulated against, so a deploy that changes your collision geometry or
      // rules leaves every live room restoring its predecessor's bytes, continuing
      // to simulate the OLD world, and re-saving it. Each successor faithfully
      // repeats that, and the checkpoint's TTL is refreshed on every write, so it
      // never ages out. The room simulates a world that no longer exists,
      // indefinitely. Nothing throws, nothing is logged, and no metric moves:
      // players simply walk through new walls and stop at removed ones.
      //
      // It is only warned rather than required because a host with genuinely
      // static rules (a chat room, a cursor layer) is entitled to skip it, and
      // because forcing it would break a caller who has not yet written one. Warn
      // ONLY when a checkpoint actually exists: a cold room has nothing to restore
      // wrongly, so warning there would just be noise on every fresh start.
      if (expectedGeom === undefined && envelope !== null) {
        log({
          lvl: 'warn',
          kind: 'ticker.no-geom-key',
          room: roomId,
          msg:
            'restoring a checkpoint with no geomKey: a deploy that changes this world cannot be ' +
            'detected, and the room will keep simulating the world the checkpoint was written against',
        });
      }
      let restored: { state: TState; incarnation: string } | null = null;
      if (envelope !== null && (expectedGeom === undefined || envelope.geom === expectedGeom)) {
        try {
          restored = { state: runtime.deserialize(envelope.body), incarnation: envelope.incarnation };
          log({ lvl: 'info', kind: 'ticker.restore', room: roomId, meta: { tick: envelope.tick } });
        } catch (err) {
          log({ lvl: 'warn', kind: 'ticker.restore-failed', room: roomId, meta: { error: String(err) } });
        }
      } else if (envelope !== null) {
        log({
          lvl: 'warn',
          kind: 'ticker.geom-mismatch',
          room: roomId,
          meta: { expected: expectedGeom, got: envelope.geom },
        });
        // A full reset is always CORRECT here, and for most hosts it is also
        // the right answer. It is not the only defensible one: a host that
        // can tell which parts of its state a geometry change actually
        // invalidates can keep the rest, which is the difference between "the
        // map reloaded" and "every room in the fleet was wiped mid-session".
        // Only the host knows which of its fields depend on the geometry, so
        // this is a callback rather than a policy flag with cases in it.
        //
        // The INCARNATION IS PRESERVED on this path, deliberately, for the
        // same reason an ordinary restore preserves it: a partial restore
        // continues the same room, so an idempotency key derived from it must
        // not move, or a replayed event pays out twice.
        if (typeof onGeomMismatch === 'function') {
          try {
            const partial = onGeomMismatch(envelope);
            if (partial !== null && partial !== undefined) {
              restored = { state: partial, incarnation: envelope.incarnation };
              log({ lvl: 'info', kind: 'ticker.geom-partial-restore', room: roomId, meta: { tick: envelope.tick } });
            }
          } catch (err) {
            // A partial restore that threw IS a corrupt room, and starting
            // fresh is already this function's correct handling for one, so
            // fall through to it rather than inventing a second path.
            log({
              lvl: 'warn',
              kind: 'ticker.geom-partial-restore-failed',
              room: roomId,
              meta: { error: String(err) },
            });
          }
        }
      }
      if (restored !== null) {
        state = restored.state;
        incarnation = restored.incarnation;
        stateReady = true;
        // Only from a restore. A room built fresh has no predecessor whose
        // grid there would be any sense in continuing; a geometry-mismatch
        // PARTIAL restore is a continuation of the same room, so it keeps this
        // for the same reason it keeps the incarnation.
        const carried = envelope?.gridAt;
        restoredGridAt = typeof carried === 'number' && Number.isFinite(carried) ? carried : null;
      } else {
        state = runtime.create(roomId);
        stateReady = true;
        // Fresh per room CREATION, preserved across every RESTORE (see the
        // `restored` branch above, which keeps the checkpoint's own
        // incarnation rather than minting one here). This is what lets a
        // ledger idempotency key be BOTH stable across a restore (a replayed
        // event dedupes) and unique across a genuine re-creation (a drained
        // and rebuilt room is never mistaken for a replay of the old one).
        incarnation = randomUUID();
      }
    }

    // THE FLOOR IS THE LATER OF THE TWO, and it applies whether or not the
    // checkpoint restored. A room that starts FRESH still has clients holding
    // frames the predecessor published, and the crash-loop path deliberately
    // starts fresh precisely when a predecessor has been publishing and dying,
    // so "no checkpoint to continue" is not the same as "no timeline to stay
    // ahead of". A stale marker costs nothing: it lands outside the adoption
    // window like any other stale grid and the fallback keeps the stamp at
    // `now`, which is still above it.
    if (timelineFloor !== null) {
      restoredGridAt = restoredGridAt === null ? timelineFloor : Math.max(restoredGridAt, timelineFloor);
    }

    // --- 3. metadata authority: seed the roster from the meta hash ---
    try {
      const raw = await redis.hgetall(keys.meta);
      const restoredAt = Date.now();
      let refusedMeta = 0;
      for (const [pid, json] of Object.entries(raw)) {
        // THE HASH IS AS UNTRUSTED AS THE WIRE, and for the same reason: every
        // value in it was written by a predecessor from a client-supplied
        // `meta`, so a build that wrote a shape this one does not expect, or a
        // hostile write to the key, lands here. `JSON.parse` succeeding says
        // the bytes were JSON and nothing about their SHAPE: "1", "null" and
        // "[1,2]" all parse, become roster values of the wrong type, and are
        // republished to every client as if a player carried them. A roster
        // entry is an object of fields or it is not a roster entry.
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          // A corrupt single field must not take down the whole restore.
          refusedMeta++;
          continue;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          refusedMeta++;
          continue;
        }
        metaMap.set(pid, parsed as Record<string, unknown>);
        present.add(pid);
        lastJoinAt.set(pid, restoredAt);
      }
      // ONE LINE PER RESTORE, never one per field: a restore happens once per
      // invocation, so this is a cadence nothing on the wire can drive, and the
      // count is what an operator needs rather than the values themselves.
      if (refusedMeta > 0) {
        log({
          lvl: 'warn',
          kind: 'ticker.meta-restore-refused',
          room: roomId,
          msg: 'roster entries in the meta hash were not objects and were dropped rather than republished',
          meta: { count: refusedMeta },
        });
      }
    } catch (err) {
      log({ lvl: 'warn', kind: 'ticker.meta-read-failed', room: roomId, meta: { error: String(err) } });
    }

    // --- subscriber for keys.in ---
    sub = createSubscriber();

    // ioredis emits one 'error' per retry, and a subscriber is configured to
    // retry forever (see `createSubscriber`), so an unreachable Redis is an
    // unbounded stream of identical lines. Throttled onto the stats cadence,
    // which nothing on the wire can drive, on the same rule every other
    // repeatable log line in this file follows.
    let lastSubErrorAt = 0;
    sub.on('error', (err: unknown) => {
      const at = Date.now();
      if (at - lastSubErrorAt < statsMs) return;
      lastSubErrorAt = at;
      log({ lvl: 'warn', kind: 'ticker.subscriber-error', room: roomId, meta: { error: String(err) } });
    });

    sub.on('message', (channel: unknown, message: unknown) => {
      if (channel !== keys.in || typeof message !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        // Malformed JSON is CLIENT-CONTROLLED input arriving at 20Hz per
        // socket; logging every occurrence would hand an abuser a log
        // amplifier (and, on a host that bills per log line, a cost
        // amplifier) for free. Count it and move on; see `badEnvelopes` on
        // the stats gauge for the aggregate signal.
        badEnvelopes++;
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { t?: unknown }).t !== 'string') {
        badEnvelopes++;
        return;
      }
      const envelope = parsed as RoomEnvelope;
      if (envelope.t === 'probe') {
        // THIS TICKER'S OWN PROBE, COMING BACK. It never reaches the inbox, the
        // runtime, or any counter: it is not traffic, it is the answer to the
        // question "is my subscription still delivering anything at all".
        // Recorded as the newest `n` seen rather than as a count, so a probe
        // lost on the way out and a probe lost on the way back are the same
        // fact and neither can be papered over by a later one arriving.
        // ONLY THIS TICKER'S OWN PROBES COUNT. Two tickers overlap on one room
        // for a moment around a handoff, and each publishes on the same
        // channel; without the owner check a successor's probes would answer
        // for a predecessor whose subscription had already died, and the one
        // signal built to catch that would be the one thing hiding it.
        //
        // AND AN ANSWER IS BOUNDED BY WHAT WAS ASKED. The owner id is the
        // LEASE VALUE, which every relay can read, so `o` proves the probe was
        // addressed to this ticker and not that this ticker sent it. Without
        // an upper bound one forged `n` of 1e15 pins `probesAnswered` above
        // every `n` this ticker will ever reach, `probesSent > probesAnswered`
        // can never be true again, and the watchdog built to notice a dead
        // subscription is dead itself for the rest of the run: measured, the
        // control exits 'input-dead' in 3.0s and the poisoned ticker holds the
        // room to its full lifetime cap with its inputs going nowhere. A reply
        // to a question nobody asked is not an answer.
        const { n, o } = envelope as { n?: unknown; o?: unknown };
        if (o !== owner) return;
        if (typeof n === 'number' && Number.isInteger(n) && n > probesAnswered && n <= probesSent) {
          probesAnswered = n;
          lastProbeAnswerAt = Date.now();
        }
        return;
      }
      if (envelope.t === 'in' && !Array.isArray((envelope as { w?: unknown }).w)) {
        // The one field the drain site iterates without checking. Refused here,
        // where a shape failure is already counted as what it is, rather than
        // left to throw a TypeError per envelope inside the loop.
        badEnvelopes++;
        return;
      }
      // EVERY FIELD THIS TICKER KEYS ON IS VALIDATED HERE, AND `pid` IS THE ONE
      // THAT WAS NOT. It is a Map key, a Set member, a Redis HASH FIELD and a
      // roster entry every client is shown, and the shape check waved through
      // anything at all: measured over 20,000 fuzz envelopes, the roster hash
      // came back with fields named "123", "[object Object]", "__proto__",
      // "constructor", "null", "undefined" and "1.5", each of them broadcast to
      // every socket in the room.
      //
      // THE QUOTA BYPASS IS THE WORSE HALF. `envelopePid` returns null for a
      // non-string pid, and the Inbox reads null as "no sender", so such an
      // envelope skips the per-sender quota entirely: 64 accepted for a real
      // pid against 4096 for a forged non-string one, which is the fairness
      // property the quota exists for handed to whoever declines to send a
      // string. Bounded in length for the same reason the room id is: it is
      // interpolated into a Redis key and shown to every client.
      if (envelope.t === 'join' || envelope.t === 'leave' || envelope.t === 'in') {
        const pid = (envelope as { pid?: unknown }).pid;
        if (typeof pid !== 'string' || pid.length === 0 || pid.length > MAX_PID_LENGTH) {
          badEnvelopes++;
          return;
        }
      }
      inbox.push(envelope, envelopePid(envelope));
    });
    // THE SUBSCRIBE IS BOUNDED, BECAUSE THE FAILURE IT GUARDS AGAINST IS SILENT.
    // A subscriber is built with `maxRetriesPerRequest: null` on purpose (giving
    // up on a subscription fails invisibly), which also means a queued SUBSCRIBE
    // behind a dead connection never rejects and never resolves. The old code
    // awaited it unbounded and, on the rare occasion it DID reject, logged and
    // CARRIED ON: a ticker holding the lease over a room whose inputs it can
    // never receive, with the tick rate, the publish rate and the lease all
    // reading healthy. Racing the lease TTL bounds it against the one clock that
    // already governs how long this ticker may claim the room, and a failure
    // hands the lease straight back so the next spawn gets a clean connection.
    let subscribed = false;
    let subscribeError: unknown = null;
    {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), leaseTtlMs);
      });
      try {
        subscribed = await Promise.race([sub.subscribe(keys.in).then(() => true), timeout]);
      } catch (err) {
        subscribeError = err;
      }
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!subscribed) {
      log({
        lvl: 'error',
        kind: 'ticker.subscribe-failed',
        room: roomId,
        msg: 'refusing to run a ticker that cannot receive input',
        meta: { error: subscribeError === null ? 'timed out' : String(subscribeError), timeoutMs: leaseTtlMs },
      });
      // No successor and no crash increment: this is a connection this
      // invocation could not open, not a room whose state kills whoever
      // restores it, and the relay's own lease poll is what tries again.
      // `abandonSetup` is what closes the subscriber.
      return abandonSetup('error', true);
    }

    // Sets `busSuspect` (declared above with the reasoning) whenever the bus
    // reports it is retrying, which is the one signal that ownership is a
    // claim about a connection that was down.
    //
    // KEPT SO IT CAN BE REMOVED. The shared command client is a process
    // singleton that outlives this call, so a listener left attached retains
    // this run's entire scope (its state, its maps, its buffers) forever and a
    // host running many rooms in one instance accumulates one per run. Every
    // teardown path below detaches it.
    onReconnecting = () => {
      busSuspect = true;
    };
    redis.on?.('reconnecting', onReconnecting);

    // The last thing setup does, because it is the first thing about the room
    // that is only knowable once the room exists.
    emptySince = runtime.playerCount(state) === 0 ? Date.now() : null;
  } catch (err) {
    // Anything the guarded block above could throw and did not handle itself:
    // `runtime.create`, `runtime.deserialize`, `createSubscriber`, the meta
    // read, `playerCount`. All of it is fatal to this invocation and none of
    // it may leave the lease held or the renew running.
    log({ lvl: 'error', kind: 'ticker.setup-threw', room: roomId, meta: { error: String(err) } });
    return abandonSetup('error', true);
  }

  /**
   * Drop a player's buffer AND their starvation streak together, and tell the
   * runtime the depth is now 0.
   *
   * All three parts matter. Dropping the buffer alone leaves the streak
   * standing, so the next time that player genuinely starves, `onStarve` is
   * handed a streak carried over from an unrelated earlier session and the
   * decay backstop fires at full strength on the very first starved tick
   * instead of ramping. Not reporting a final 0 leaves whatever depth was last
   * observed pinned on the wire for a player who no longer has a buffer at all.
   */
  function dropPlayout(pid: string): void {
    if (!playouts.delete(pid)) return;
    starve.forget(pid);
    lateSeen.delete(pid);
    guardHost(() => runtime.onBufferHealth?.(state, pid, 0), 'onBufferHealth');
  }

  let ticks = 0;
  let lastCheckpointAt = 0;
  let lastStatsAt = Date.now();
  let lastLoopAt = Date.now();
  let exitReason: TickerResult['reason'] = 'duration';
  // THE GRID SURVIVES A PLANNED HANDOFF, WHICH IS THE OTHER HALF OF STAMPING
  // SNAPSHOTS WITH IT AT ALL.
  //
  // A successor that restarts the grid at its own `Date.now()` puts a phase
  // jump in the middle of the one axis clients interpolate on: its first
  // snapshot lands 9 to 29ms after the predecessor's last while carrying a
  // whole tick of motion, so the client divides that motion by the short span
  // and renders 165 to 269 u/s for two or three frames. Measured end to end
  // over real sockets and a real Redis, those were the ONLY frames outside
  // +-10% in the entire run. The same jump walks the server timeline 20 to
  // 40ms earlier per handoff, eroding every client's stamping lead by half to
  // eight tenths of a tick each time while staying inside the re-anchor
  // tolerance, so nothing ever corrects it: server buffer depth 5 to 4 to 1 to
  // 0 over three handoffs, and then the room starves.
  //
  // So the predecessor's last grid point rides its checkpoint and this ticker
  // continues from it, sleeping to it while it is still ahead and running
  // immediately once it has just passed.
  //
  // THE WINDOW IS ONE TICK IN EITHER DIRECTION, and it is what separates a
  // planned handoff from everything else. A stale checkpoint (a hard death, a
  // room reclaimed minutes later) or a successor whose clock is skewed against
  // its predecessor's produces a candidate nowhere near now, and adopting one
  // of those would stamp snapshots the client's own plausibility guard
  // refuses. Falling back to `Date.now()` there is exactly today's behaviour.
  let nextTickAt = Date.now();
  /**
   * Added to every snapshot stamp and to the `gridAt` this ticker writes, so
   * the ROOM's timeline survives a successor whose clock disagrees with its
   * predecessor's. Zero whenever the grid was continued outright, which is
   * every ordinary handoff; see the else branch below for the rest.
   */
  let stampOffset = 0;
  if (restoredGridAt !== null) {
    const continued = restoredGridAt + tickMs;
    // `restoredGridAt` IS the predecessor's last stamp whenever the checkpoint
    // was its FINAL one, which is the planned-handoff case this exists for, so
    // `continued` is strictly past it by construction. After a hard death the
    // newest checkpoint is a periodic one and the predecessor kept publishing
    // past it, but then `continued` is far behind now and the window refuses
    // it: the two guards cover the same fact from opposite ends, and
    // `serverTime` stays strictly increasing across the handoff either way.
    //
    // THE WINDOW IS ASYMMETRIC, AND THE TWO SIDES ARE DIFFERENT FACTS. Ahead
    // of now, a grid point is simply not due yet and the loop sleeps to it, so
    // one tick is all the slack that can ever be needed. BEHIND now is where
    // the handoff actually lands: the successor has to acquire, read the
    // checkpoint, deserialize and subscribe before it reaches this line, and
    // on a loaded machine that is routinely more than one tick after the
    // predecessor released. A symmetric one-tick window turns exactly that
    // case, the one this whole mechanism exists for, into the fallback it
    // exists to avoid, and there is no middle value: the grid is either
    // continued or restarted, so a CI runner under load renders the same
    // 165 to 269 u/s spike as a ticker with no `gridAt` at all.
    //
    // A continuation slightly in the past is safe, and it is the existing
    // drift rule that makes it so. The first iteration stamps `continued`,
    // `nextTickAt += tickMs` then leaves the loop one or two ticks behind, and
    // the catch-up iterations sleep zero but stamp `continued + tickMs`,
    // `+ 2 * tickMs` and so on: still exactly on the grid, still strictly
    // increasing. The client plays back on the `serverTime` axis and its jitter
    // buffer already absorbs bunched arrivals, so two frames arriving together
    // is ordinary jitter rather than the phase jump a restart would be.
    //
    // TWO TICKS IS THE BOUND THE DRIFT RULE ITSELF SETS, not a taste. After
    // the first iteration the drift is `(past - 1) * tickMs` plus that
    // iteration's own compute, and the resync fires past one tick of drift, so
    // a three-tick continuation resyncs immediately and the grid is abandoned
    // after a single stamp anyway. At exactly two the iteration's own compute
    // decides it, which is a graceful degradation to the old fallback rather
    // than a regression: the worst case is the behaviour this replaces.
    const lateBy = Date.now() - continued;
    if (continued > restoredGridAt && lateBy >= -tickMs && lateBy <= GRID_CATCHUP_TICKS * tickMs) {
      nextTickAt = continued;
    } else {
      // THE TIMELINE IS CARRIED BY THE CHECKPOINT; A MACHINE'S CLOCK ONLY
      // PACES IT. Outside the window the grid restarts locally, and until now
      // the first stamp was simply `Date.now()` on a clock that has no
      // relationship to the one the predecessor stamped with. A successor
      // whose clock runs BEHIND its predecessor's therefore stamped its first
      // snapshot before the predecessor's last one: measured at 39ms backwards
      // on a 40ms skew and two full seconds backwards on a 2s skew. Every
      // client plays back on this axis, so a backward step is not a stall to
      // ride out, it is a timeline that contradicts the frames already in the
      // buffer.
      //
      // SLEEPING OFF THE SKEW IS NOT THE FIX EITHER: waiting until the local
      // clock reaches the predecessor's next grid point hands the room a gap
      // as long as the skew, which is the very thing the handoff exists to
      // avoid. So the local grid keeps PACING the loop and a constant offset
      // carries the TIMELINE: the first stamp is the later of the two clocks'
      // opinions, and every stamp after it is the local grid plus that same
      // constant, which is continuous and strictly increasing by construction.
      //
      // A successor whose clock is AHEAD gets an offset of zero and a plain
      // forward step, which the client already treats as a stall that resumed.
      // Backward never happens at all.
      const firstStamp = Math.max(nextTickAt, continued);
      stampOffset = firstStamp - nextTickAt;
    }
  }
  /** The grid time of the most recent iteration, so a checkpoint records the tick it actually describes rather than the wall clock it happened to be written at. */
  let lastStampedAt = nextTickAt + stampOffset;
  // Seeded to the start of the loop rather than left at zero: the deadline
  // means "silent for this long", and before the first probe has even gone out
  // there is nothing to have been silent about.
  lastProbeAnswerAt = Date.now();
  /** Set once the crash counter has been cleared, so a room that is plainly healthy stops paying a `DEL` per checkpoint. */
  let crashCounterCleared = false;
  /** Set when Redis itself refused a checkpoint write because the lease has moved on. */
  let refusedNotOwner = false;
  /** Set once the standby request has been ISSUED, so it is not re-fired on every remaining iteration while it is in flight. */
  let standbyRequested = false;
  /** Set while a standby successor is believed to exist: true from the moment the request is issued, cleared again if it is REFUSED. This is the one the exit reads. */
  let standbySpawned = false;

  /**
   * Writes the room's whole state, OWNER-CHECKED.
   *
   * The `owns` flag this write used to be gated on is a local belief that lags
   * reality by up to a renew period: a ticker whose lease was taken while its
   * last renew was in flight still thinks it owns the room, and a plain `SET`
   * then overwrites the SUCCESSOR's fresher checkpoint with state from before
   * the handoff. Measured against a real Redis at three such overwrites inside
   * 1.5 seconds. Redis decides now, atomically, exactly as it already does for
   * the renew and the release; a refusal is reported back so the loop can exit
   * on the lease it has evidently lost rather than carry on writing.
   */
  /**
   * Checkpoint writes are SERIALISED THROUGH ONE CHAIN, and that is not
   * tidiness.
   *
   * `writeCheckpoint` compresses before it issues its `SET`, so two writes
   * started in tick order reach Redis in GZIP-COMPLETION order, and gzip time
   * scales with the body. A periodic write of a large room still deflating
   * when the final write of the same room starts therefore lands AFTER it, and
   * the checkpoint a successor restores is the older one: forced and measured
   * with an 8MB body, where the successor restored tick 1. Chaining costs
   * nothing on the ordinary path (writes are a second apart and the chain is
   * long settled) and makes the order the room's rather than the compressor's.
   */
  let checkpointChain: Promise<unknown> = Promise.resolve();

  function queueCheckpoint(): Promise<void> {
    // Both arms run the write, so one rejected checkpoint does not poison the
    // chain for every later one.
    const next = checkpointChain.then(
      () => writeCheckpointNow(),
      () => writeCheckpointNow()
    );
    checkpointChain = next;
    return next;
  }

  async function writeCheckpointNow(): Promise<void> {
    const envelope: CheckpointEnvelope = {
      v: CHECKPOINT_VERSION,
      tick: runtime.currentTick(state),
      graceUntilTick: runtime.graceUntilTick?.(state) ?? 0,
      geom: geomKey?.(),
      // Written on every checkpoint including the final one, which is the one
      // a planned handoff actually restores from.
      // THE STAMPED VALUE, NOT THE LOCAL GRID POINT, so the chain stays
      // continuous across every further handoff: the next successor continues
      // from the timeline this room published, not from this machine's clock.
      gridAt: lastStampedAt,
      incarnation,
      body: runtime.serialize(state),
    };
    const reply = await writeCheckpoint(redis, keys.state, packCheckpoint(envelope), STATE_TTL_S, {
      leaseKey: keys.lease,
      owner,
    });
    // Fail closed on anything that is not the literal 'OK', for the same
    // reason `acquireLease` does: this is the reply that decides whether this
    // ticker is still the authority.
    if (reply !== 'OK' && !refusedNotOwner) {
      refusedNotOwner = true;
      log({
        lvl: 'error',
        kind: 'ticker.checkpoint-refused-not-owner',
        room: roomId,
        msg: 'the lease has moved on: this checkpoint was refused rather than allowed to overwrite a successor',
      });
    }
  }

  /** Forget one player's metadata locally and in the hash, and mark the roster for republication. Idempotent. */
  function removeMeta(pid: string): void {
    if (!metaMap.delete(pid)) return;
    metaDirty = true;
    redis
      .hdel(keys.meta, pid)
      .catch((err) => log({ lvl: 'error', kind: 'ticker.meta-hdel-failed', room: roomId, meta: { error: String(err) } }));
  }

  /**
   * Reconcile the roster against the simulation's OWN membership: BOTH the
   * metadata map and the `present` set.
   *
   * This is what makes a departure a fact about the room rather than a fact
   * about a socket. A `leave` envelope is produced by a TCP connection ending,
   * and connections end for reasons that have nothing to do with a player
   * quitting: a phone handing off between cells, a lid closing, a background
   * tab throttled to a stop, a routine reconnect after a deploy. A simulation
   * that holds a departed player through a grace period so their reconnect
   * resumes seamlessly still HAS that player, and announcing their removal on
   * the socket's timetable tears their name tag off every other client's screen
   * and puts it back a second later, for a player who never moved.
   *
   * IT PRUNES `present` TOO, AND THAT HALF IS WHY A RECONNECT INTO A FULL ROOM
   * USED TO BE REFUSED. `leave` deleted from `present` unconditionally, even
   * for a runtime holding the player through a grace period, so the reconnect
   * that followed arrived as a NEW player, met `isFull`, and was answered with
   * `room-reject` while the simulation still had them sitting in the room.
   * With the delete gone, `present` is only ever cleared by the simulation
   * saying the player is no longer there, which is the same authority the
   * metadata already followed. The two were always one fact.
   *
   * Runs every tick and is deliberately cheap: nothing is allocated and nothing
   * is even asked of the runtime while the roster is empty or while every
   * mapped pid is still present, which is every tick in normal operation.
   */
  function reconcileMembership(): void {
    if (runtime.presentPids === undefined || (metaMap.size === 0 && present.size === 0)) return;
    const reported = guardHost(() => runtime.presentPids!(state), 'presentPids');
    // A membership the host could not report is not a membership of nobody:
    // pruning on it would drop the whole roster over one throw.
    if (reported === undefined) return;
    const live = new Set(reported);
    let gone: string[] | null = null;
    for (const pid of present) if (!live.has(pid)) (gone ??= []).push(pid);
    for (const pid of metaMap.keys()) if (!live.has(pid) && !present.has(pid)) (gone ??= []).push(pid);
    // Collected first, removed after: `removeMeta` mutates `metaMap`, and
    // deleting from a Map while iterating its own keys is exactly the kind of
    // thing that works until the day it silently skips an entry.
    if (gone !== null) {
      for (const pid of gone) {
        removeMeta(pid);
        present.delete(pid);
        connOf.delete(pid);
        lastJoinAt.delete(pid);
        rejectedAt.delete(pid);
        // AND THE PER-PLAYER PLAYOUT STATE, which this pass used to leave
        // behind entirely. A `leave` drops it (see the leave branch), but a
        // runtime with a disconnect grace never produces one for the player it
        // eventually forgets: it simply stops reporting them from
        // `presentPids`, and their buffer, starvation streak and late-count
        // baseline then sat in these maps for the rest of the ROOM's life.
        // That is the exact shape of a slow leak, because a grace runtime is
        // precisely the kind that cycles many players through one long ticker.
        dropPlayout(pid);
      }
    }
  }

  function publishMeta(): void {
    const map: Record<string, unknown> = Object.fromEntries(metaMap);
    // The host's formatter, if any, decides the client-visible shape; see
    // `metaPayload` for why that seam exists. It is called INSIDE the guard
    // because this is the one meta site that runs from the tick loop: an
    // uncaught throw here would not merely lose a roster frame, it would
    // unwind the loop and take the whole room down, where the relay's
    // equivalent only fails one socket's seed.
    //
    // A throw is reported and NOT retried. `metaDirty` was already cleared by
    // the caller, so a formatter that throws deterministically logs once per
    // roster CHANGE rather than once per tick: leaving the dirty flag set
    // would turn a broken formatter into a 20Hz log amplifier, which is the
    // same rule every client-rate path in this library follows.
    const frame = guardHost(() => {
      const payload = metaPayload ? metaPayload(map) : { t: 'meta', map };
      // `JSON.stringify` returns undefined for `undefined` (and for a bare
      // function or symbol) despite its lying type. Suppressing the frame
      // beats publishing the four characters "undefined" onto a control
      // channel every client parses.
      return JSON.stringify(payload) as string | undefined;
    }, 'metaPayload', 'ticker.meta-payload-threw');
    if (frame === undefined) return;
    redis.publish(keys.metaout, frame).catch((err) => {
      // A FAILED PUBLISH IS RETRIED WHERE A FAILED FORMATTER IS NOT, and the
      // difference is who controls the rate. A broken formatter fails on every
      // attempt forever, so retrying it is a log amplifier; a rejected publish
      // is the bus being unavailable, which nothing on the wire drives and
      // which the snapshot publish is already failing at the same rate anyway.
      // Without this a roster change that landed during a blip is lost for
      // good: nothing marks the map dirty again, so every client keeps the
      // stale roster until some unrelated join or leave happens to redraw it.
      metaDirty = true;
      log({ lvl: 'error', kind: 'ticker.metaout-failed', room: roomId, meta: { error: String(err) } });
    });
  }

  function handleEnvelope(env: RoomEnvelope): void {
    switch (env.t) {
      case 'join': {
        const already = present.has(env.pid);
        // A rejoin (a reconnecting player whose grace period has not
        // expired) is ALWAYS admitted, no matter how full the room reads:
        // `isFull` only ever gets to refuse a genuinely NEW arrival. Without
        // that distinction, a room sitting at capacity would eject its own
        // existing players on every reconnect.
        if (!already && (guardHost(() => runtime.isFull?.(state), 'isFull') ?? false)) {
          // AT MOST ONE REJECT PER PID PER INTERVAL. The reject goes out on the
          // ROSTER channel, which fans out to every socket in the room, so a
          // producer that can pick the join rate picks the reject rate too and
          // one refused pid becomes a Redis and fan-out amplifier: exactly the
          // "counted in process, flushed on a cadence the client cannot drive"
          // rule every other client-rate path in this file follows. The relay's
          // own heartbeat is one join per second per socket, so a well-behaved
          // client is still answered every time; anything faster is answered
          // once and counted. Suppressing one costs nothing on its own, since a
          // lost reject already means the client's own timeout handles it.
          const rejectedLast = rejectedAt.get(env.pid);
          const rejectNow = Date.now();
          if (rejectedLast !== undefined && rejectNow - rejectedLast < REJECT_INTERVAL_MS) {
            rejectsSuppressed++;
            return;
          }
          rejectedAt.set(env.pid, rejectNow);
          // THE REJECT NAMES THE CONNECTION, NOT JUST THE PLAYER. A pid holds
          // two live sockets on purpose for a moment: that overlap is what the
          // per-attach `c` exists for and what the relay's planned lifetime
          // swap creates every time. A frame carrying only the pid is matched
          // by BOTH relays, so a refusal aimed at the arriving socket closes
          // the established one too and the player is dropped from a room they
          // were already in (measured: both sockets closed 4002). Echoing the
          // join's own `c` lets the relay close exactly the socket that was
          // refused. Omitted entirely when the join carried none, since
          // `JSON.stringify` drops an undefined field: an older relay then
          // sees the frame it has always seen and behaves as it always has.
          redis
            .publish(keys.metaout, JSON.stringify({ t: 'room-reject', pid: env.pid, c: env.c }))
            .catch(() => {
              /* best-effort; a lost reject just means the client's own timeout handles it */
            });
          return;
        }
        present.add(env.pid);
        // The relay heartbeats this envelope every second, so this is also the
        // liveness stamp the presence sweep reads; see `presenceTimeoutMs`.
        lastJoinAt.set(env.pid, Date.now());
        // The connection this pid is now reachable on. A `leave` from any
        // OTHER connection is a stale relay closing behind them and must not
        // remove them; see the `leave` branch.
        if (typeof env.c === 'string') connOf.set(env.pid, env.c);
        guardHost(() => runtime.join(state, env.pid, env.meta), 'join');

        const meta = env.meta ?? {};
        const nextJson = JSON.stringify(meta);
        const prevJson = metaMap.has(env.pid) ? JSON.stringify(metaMap.get(env.pid)) : undefined;
        if (prevJson !== nextJson) {
          metaMap.set(env.pid, meta);
          metaDirty = true;
          redis
            .hset(keys.meta, env.pid, nextJson)
            .catch((err) => log({ lvl: 'error', kind: 'ticker.meta-hset-failed', room: roomId, meta: { error: String(err) } }));
        }
        if (emptySince !== null) emptySince = null;
        break;
      }
      case 'leave': {
        // A LEAVE FROM A CONNECTION THIS PLAYER HAS ALREADY REPLACED IS NOT A
        // DEPARTURE. Sockets are swapped routinely (a reconnect, and the
        // relay's own planned swap at its lifetime cap), and the order the two
        // relays reach the bus in is not guaranteed: the replacement's `join`
        // frequently lands before the old relay's `close` handler has fired.
        // Honouring that close removes a player who is sitting in the room on
        // a live socket, and the only thing that brings them back is the next
        // heartbeat. Compared against the newest connection seen for this pid,
        // so the stale one is refused and the current one is not.
        //
        // A leave with no `c` (an older relay, or this ticker's own presence
        // sweep) and a leave for a pid with no recorded `c` are honoured
        // exactly as before: there is nothing to contradict them with.
        const conn = connOf.get(env.pid);
        if (env.c !== undefined && conn !== undefined && env.c !== conn) break;
        connOf.delete(env.pid);
        lastJoinAt.delete(env.pid);
        // MEMBERSHIP REMOVAL FOLLOWS THE SIMULATION'S OWN MEMBERSHIP WHEN THE
        // RUNTIME REPORTS ONE, not this envelope. A `leave` means a socket
        // closed, which is not the same fact as a player having left: a
        // simulation with a disconnect grace deliberately keeps a departed
        // player for several seconds so their reconnect resumes seamlessly,
        // and removing their name here would announce a departure and an
        // arrival to the whole room for a player who never moved. Dropping
        // them from `present` is worse still: the reconnect then arrives as a
        // NEW player and a room at capacity refuses it outright, so the grace
        // period the runtime is keeping for them is exactly what they cannot
        // use. `reconcileMembership` owns both removals in that case, and it
        // makes them when the SIMULATION says the player is gone.
        //
        // With no `presentPids` there is nothing better to go on, so removal
        // stays exactly where it was: this is today's behaviour, unchanged,
        // for every runtime that does not opt in.
        if (runtime.presentPids === undefined) {
          present.delete(env.pid);
          removeMeta(env.pid);
        }
        guardHost(() => runtime.leave(state, env.pid), 'leave');
        dropPlayout(env.pid);
        break;
      }
      case 'in': {
        // THE STAMPED RECORDS ARE BUFFERED NEWEST FIRST, AND THE WINDOW
        // ARRIVES OLDEST FIRST, so they are collected here and pushed in
        // reverse below. Everything else about this window stays in array
        // order, because chronological is right for both the arrival report
        // and the apply-on-arrival path.
        //
        // WHY THE ORDER MATTERS AT ALL. A packet carries the last few stamped
        // inputs as redundancy (`codec/snapshot.ts`, newest last), so on a
        // healthy link most of a window is re-sends of ticks this room has
        // already consumed. `PlayoutBuffer.push` re-stamps such a record onto
        // `lastConsumed + 1` unless that slot already holds something at least
        // as fresh. Pushed oldest first, each re-send in turn is fresher than
        // what it finds there, so every one of them LANDS and every one of
        // them counts as late: a perfectly healthy 6-record window reports
        // three late inputs per packet, which is the exact gauge
        // `RoomStats.lateInputs` exists to make meaningful. Pushed newest
        // first, the freshest re-send takes the slot and each older duplicate
        // is refused by the freshness check without counting, so a healthy
        // link reads zero and a genuinely late input is the only thing left.
        // Carried as (tick, record) pairs rather than as records alone,
        // because the tick has been VALIDATED by the time it goes in here and
        // re-reading it off the record below would need a cast that re-asserts
        // what the check already established.
        let stamped: { tick: number; input: ClientInput }[] | null = null;
        for (const input of env.w) {
          // A RECORD IS VALIDATED BEFORE ANYTHING TOUCHES IT. `w` is an array
          // off the wire, so its ELEMENTS are as untrusted as the envelope
          // itself: a `null` or a bare number reaches `input.targetTick` as a
          // TypeError, and before the per-record guard below that took the
          // whole redundancy window with it.
          if (typeof input !== 'object' || input === null) {
            badEnvelopes++;
            continue;
          }
          // GUARDED PER RECORD, NOT PER ENVELOPE, and that is the difference
          // between one bad input costing one input and costing several ticks
          // of a player's control. An input packet carries the last few inputs
          // as redundancy, so abandoning the window on the first failure
          // silently discards the re-sends that exist precisely to survive a
          // failure.
          try {
            // ARRIVAL, reported before any decision about WHEN this will be
            // applied. This is the round-trip signal; `ackTick` on consume is
            // the timeline signal. See `onInputArrived` in `core/types.ts` for
            // why a client's dilation controller cannot be fed the second one
            // in place of the first.
            guardHost(() => runtime.onInputArrived?.(state, env.pid, input), 'onInputArrived');
            // A `targetTick` OFF THE WIRE IS NOT A TICK UNTIL IT IS CHECKED.
            // `(input.targetTick ?? 0) > 0` is true for the string "5", which
            // then keys the buffer's entries Map by a string no numeric
            // consume can ever match: the record is buffered, starves every
            // tick it should have fed, and is eventually evicted, with no
            // signal anywhere. Nothing is COUNTED for it, because a decoder
            // handing over the wrong type is a bug in the host's own codec
            // rather than an abusive sender, but the buffer must not be
            // poisoned by it either, so the record is treated as unstamped and
            // applied on arrival.
            const targetTick = input.targetTick;
            const isStamped = typeof targetTick === 'number' && Number.isInteger(targetTick) && targetTick > 0;
            if (isStamped && (guardHost(() => runtime.usesPlayout?.(state, env.pid), 'usesPlayout') ?? false)) {
              (stamped ??= []).push({ tick: targetTick, input });
            } else {
              // An UNSTAMPED input for a pid that already has a playout
              // buffer means that player is no longer driving a stamped
              // stream (a car dismount, a mode switch), so the stale buffer
              // is dropped rather than left to starve silently for the rest
              // of the session: without this, the consume-exact pass below
              // would keep reporting starves and calling `onStarve` for a
              // player who is not sending stamped input at all anymore.
              // `clearPlayout` covers the transition this cannot see, where a
              // player stops sending stamped input without sending anything
              // else at all.
              if (!isStamped) {
                dropPlayout(env.pid);
                // AND EVERY STAMPED RECORD EARLIER IN THIS WINDOW GOES WITH
                // IT, which is what keeps the two-pass form faithful to the
                // single pass it replaced. The old code pushed each stamped
                // record as it went and then had `dropPlayout` throw the whole
                // buffer away on reaching an unstamped one, so a window
                // ordered [stamped, unstamped] left nothing buffered.
                // Collecting and pushing at the end without this lets that
                // stamped record survive the dismount it was supposed to be
                // superseded by: only records positioned AFTER the last
                // unstamped one belong to the stream that is still running.
                stamped = null;
              }
              guardHost(() => runtime.applyInput(state, env.pid, input), 'applyInput');
            }
          } catch (err) {
            // Everything above that can reach a host is already guarded, so
            // this is the library's own last line: one record's worth.
            noteHostError(err, 'input');
          }
        }
        // The second pass: newest first, for the reason at the top of this
        // branch. Nothing here can reach a host, so it needs no guard of its
        // own; `dropPlayout` above may have removed the buffer, in which case
        // the next stamped record simply builds a fresh one, exactly as it
        // would have done in the single pass.
        if (stamped !== null) {
          let buf = playouts.get(env.pid);
          if (!buf) {
            buf = new PlayoutBuffer<ClientInput>(playoutMaxAhead ?? defaultPlayoutMaxAhead);
            playouts.set(env.pid, buf);
          }
          // A BUFFER THAT HAS NEVER CONSUMED KEEPS THE ARRAY ORDER, and the
          // two regimes are cleanly separated rather than traded off. The late
          // path is `target <= lastConsumedTick`, which no stamped record can
          // take while that is still -1, so before the first consume the order
          // cannot affect `lateCount` at all. What it CAN affect there is the
          // ahead bound, because the first push into a fresh buffer is what
          // establishes the reference it is measured from: pushed newest
          // first, a runaway far-future stamp would set that reference itself
          // and the legitimate near-term records in the same window would be
          // refused as too far BELOW it, which is precisely the inversion
          // `playoutMaxAhead` exists to prevent. After the first consume the
          // reference is the consumer's own floor and no push can move it, so
          // only the freshness question is live and newest-first is right.
          // A REFUSAL IS THE ONE OUTCOME THAT LOSES A RECORD, so it is the one
          // that is counted. 'stale' is a redundancy window working exactly as
          // designed, and 'late' already has `lateInputs`.
          if (buf.lastConsumedTick < 0) {
            for (const record of stamped) {
              if (buf.push(record.tick, record.input) === 'refused') refusedInputs++;
            }
          } else {
            for (let i = stamped.length - 1; i >= 0; i--) {
              const record = stamped[i] as { tick: number; input: ClientInput };
              if (buf.push(record.tick, record.input) === 'refused') refusedInputs++;
            }
          }
        }
        break;
      }
      case 'custom': {
        // The out-of-band control channel: an admin command, a dev route
        // forcing a phase. Produced server-side with `publishCustom`, never
        // by the relay, so a client can never reach `onCustom`.
        guardHost(() => runtime.onCustom?.(state, env.name, env.data, env.pid), 'onCustom');
        break;
      }
      default: {
        // AN ENVELOPE SHAPE THIS TICKER DOES NOT KNOW MUST NEVER VANISH IN
        // SILENCE. Without this branch the switch simply falls through and
        // the message is gone, which is indistinguishable from a Redis
        // outage, a subscribe that never landed, or a producer that was
        // never deployed. Every one of those was chased in turn before
        // anyone checked whether the message was arriving and being ignored.
        //
        // In practice this fires on a DEPLOY SKEW: a producer rolled out
        // ahead of the consumer that understands its new envelope. That is
        // exactly the window in which an operator most needs to be told.
        //
        // COUNTED, NOT LOGGED PER MESSAGE. `t` comes off a channel a client's
        // traffic reaches, so a log line here would be a log amplifier (and,
        // on a host that bills per line, a cost amplifier). The count rides
        // the stats gauge and one summary line is emitted per stats flush, a
        // cadence nothing on the wire can drive. The observed name is kept
        // for that summary and TRUNCATED, because it is an unbounded string
        // from off the wire.
        unknownEnvelopes++;
        // `t` is already known to be a string here (the subscriber's shape
        // check rejects anything else into `badEnvelopes` before it reaches
        // the inbox); the fallback exists so this cannot throw if that ever
        // changes, not because the branch is reachable today.
        const t = (env as { t?: unknown }).t;
        lastUnknownEnvelopeT = typeof t === 'string' ? t.slice(0, 32) : typeof t;
        break;
      }
    }
  }

  // The setup renew stops here and the loop's own renew (section 11) takes
  // over. Both drive the same clock through the same two functions, so the
  // handover is a change of caller and not a change of rule.
  clearInterval(setupRenewTimer);
  if (setupLostLease) {
    // A renew during setup came back FALSE, which is Redis reporting the key
    // is somebody else's. Nothing is published, nothing is checkpointed and no
    // successor is spawned: whoever took the lease is already running. The
    // lease is NOT released either, for the same reason the loop's own
    // lease-lost exit does not release one it has lost. Everything else is the
    // same teardown every other pre-loop exit runs.
    log({ lvl: 'error', kind: 'ticker.lease-lost', room: roomId, meta: { finder: 'setup' } });
    return abandonSetup('lease-lost', false);
  }

  // A continued grid can sit up to a tick in the FUTURE, and the first
  // iteration has to wait for it exactly as every later one does: running
  // straight into it would stamp a frame ahead of its own grid point.
  if (nextTickAt > Date.now()) await sleep(nextTickAt - Date.now());

  try {
    while (true) {
      // THE GRID TIME THIS ITERATION IS FOR, captured before the bottom of the
      // loop advances it. Everything a CLIENT plays back on is stamped with
      // this rather than with a wall-clock read taken after the sim step; see
      // the publish block.
      const scheduledAt = nextTickAt;
      // `scheduledAt` paces this loop on the local clock; `stampedAt` is the
      // room's timeline and is what every client plays back on.
      const stampedAt = scheduledAt + stampOffset;
      lastStampedAt = stampedAt;
      const iterationStart = Date.now();
      cadenceHist.push(iterationStart - lastLoopAt);
      lastLoopAt = iterationStart;

      // NO AWAITS BELOW THIS LINE UNTIL THE SLEEP AT THE BOTTOM OF THE LOOP.
      // The loop's entire timing guarantee rests on that: every publish,
      // checkpoint, and lease renew inside this iteration is fire-and-forget
      // with a `.catch`, because one awaited Redis round trip inside the hot
      // path stretches every tick in the room by that round trip's latency.

      // 4. drain the inbox
      dropped += inbox.resetDropped();
      const envelopes = inbox.drain(); // uses the Inbox's own configured maxDrainPerTick
      for (const env of envelopes) {
        try {
          handleEnvelope(env);
        } catch (err) {
          // COUNTED, NOT LOGGED. This used to write a warn line per envelope,
          // on a path whose rate a client controls: 51 lines for 51 malformed
          // inputs, measured through this library's own default decoder. The
          // count rides the stats gauge and one summary line is emitted per
          // flush, exactly like `unknownEnvelopes`.
          noteHostError(err, 'envelope');
        }
      }

      // 4b. the roster follows the simulation's membership, not the socket's
      reconcileMembership();

      // 5. playout consume-exact pass, BEFORE the tick and FOR the tick the
      // step below produces.
      //
      // THE STEP THAT PRODUCES TICK T CONSUMES THE INPUTS STAMPED T.
      // `currentTick` is the number of COMPLETED ticks, which is the label on
      // the snapshot that went out last iteration, so the step below produces
      // `tickNow + 1` and that is the stamp this pass consumes and acks. The
      // snapshot labelled T then already carries the input stamped T, which is
      // what lets a client replaying its stored records from a snapshot apply
      // exactly those with `targetTick > snap.tick`. The contract is stated
      // once, on `RoomRuntime.currentTick` in `core/types.ts`.
      //
      // This pass used to consume `tickNow` ITSELF, which applied the record
      // stamped T to the step that produced the snapshot labelled T + 1.
      // Steady motion is identical either way (the record consumed a tick late
      // carries the same value as the one that should have been), which is
      // why no test and no harness saw it; measured on the shipped pong
      // client, every input CHANGE (a paddle starting or stopping) reconciled
      // exactly one tick of travel out, positive on a start and negative on a
      // stop, at every RTT and with the replay window fully covering the lead.
      //
      // Nothing else in this pass reads a tick: the `clearPlayout` drop, the
      // starvation streak and the health readout follow the buffer's own
      // consumed floor, which moves with the consume below. The checkpoint's
      // `tick` and the stats gauge stay the COMPLETED count, so a restore at
      // tick N produces N + 1 next and consumes the stamp N + 1 for it, exactly
      // as the uninterrupted loop would have.
      const tickNow = runtime.currentTick(state);
      const producedTick = tickNow + 1;
      // A buffer the runtime has stood down is dropped BEFORE the consume
      // pass, never after: consuming first would report one more starve and
      // run one more decay step for a player the simulation has already said
      // is not on the stamped path anymore, which is the entire thing
      // `clearPlayout` exists to stop. Collected before removing for the same
      // reason `reconcileMeta` does; `dropPlayout` mutates `playouts`.
      if (runtime.clearPlayout !== undefined && playouts.size > 0) {
        let stale: string[] | null = null;
        for (const pid of playouts.keys()) {
          if (guardHost(() => runtime.clearPlayout!(state, pid), 'clearPlayout') ?? false) (stale ??= []).push(pid);
        }
        if (stale !== null) for (const pid of stale) dropPlayout(pid);
      }
      for (const [pid, buf] of playouts) {
        const { item, starved } = buf.consume(producedTick);
        if (starved) {
          starves++;
          if (buf.health() > 0) {
            // EARLY IS NOT STARVED, AND THE DECAY BACKSTOP MUST NOT TREAT IT
            // AS IF IT WERE. A buffer that still holds entries has this
            // player's inputs, stamped for ticks this room has not reached
            // yet: nothing was lost, the two clocks simply disagree about
            // where "now" is. That is the exact shape every handoff produces,
            // because the client's tick counter kept advancing at wall-clock
            // rate through the gap while the server's stood still. Running the
            // starvation streak there decays a held control toward neutral
            // while the input that should be driving it is sitting in the
            // buffer: measured after a 600ms handoff at 16 starves and half a
            // second of a held stick reading as released.
            //
            // So it is REPORTED as a starve (the tick genuinely had nothing to
            // apply) but always at streak 1, which is repeat-last: right for a
            // gap this short and correct for one this recoverable. A
            // GENUINELY empty buffer keeps the streak and the decay, which is
            // the sawtooth backstop `starvation.ts` exists for.
            guardHost(() => runtime.onStarve?.(state, pid, 1), 'onStarve');
          } else {
            const streak = starve.onStarve(pid);
            guardHost(() => runtime.onStarve?.(state, pid, streak), 'onStarve');
          }
        } else if (item !== undefined) {
          starve.onConsume(pid);
          guardHost(() => (runtime.applyBufferedInput ?? runtime.applyInput)(state, pid, item), 'applyBufferedInput');
          guardHost(() => runtime.ackTick?.(state, pid, producedTick), 'ackTick');
        }
        // REPORTED ON BOTH PATHS, INCLUDING THE STARVE. The buffer lives in
        // this Map, so this is the only route by which its depth can reach the
        // host's state and therefore its snapshot, and a starve is precisely
        // when the depth matters and precisely when `ackTick` does not fire.
        // Hanging the health off `ackTick` instead would report it only on
        // ticks where the buffer was healthy enough to consume, which is the
        // one measurement nobody needs.
        guardHost(() => runtime.onBufferHealth?.(state, pid, buf.health()), 'onBufferHealth');
      }

      // 6. the sim step itself
      const tickStart = Date.now();
      const result = runtime.tick(state, 1 / runtime.tickHz);
      serverInternalHist.push(Date.now() - tickStart);
      ticks++;
      ticksSinceStats++;
      // Read out rather than accessed through `result` inside the closure: a
      // property narrowing does not survive into one, and a cast here would be
      // hiding that rather than answering it.
      const events = result?.events;
      if (events !== undefined && events.length > 0) {
        guardHost(() => onEvents?.(events, { roomId, tick: runtime.currentTick(state), incarnation, redis }), 'onEvents');
      }

      // keep emptySince current before it is read by the exit check further down
      const playersNow = runtime.playerCount(state);
      if (playersNow === 0) {
        if (emptySince === null) emptySince = Date.now();
      } else {
        emptySince = null;
      }

      // 7. THE SPLIT-BRAIN GUARD, run synchronously before every publish.
      //
      // Two independent ways this fires, both real and both observed in
      // production of the system this library was extracted from:
      //   (a) this loop itself stalled past the lease TTL (a GC pause, an
      //       event-loop-blocking bug), so the scheduled async renew below
      //       never got a chance to run at all; or
      //   (b) renews HAVE been firing on schedule but failing or hanging,
      //       so ownership silently expired out from under this ticker
      //       while it kept computing ticks, and a successor may already
      //       hold the lease and be publishing its own, divergent, sim.
      // Either way, publishing now would mean two authoritative writers on
      // one channel: clients receive interleaved snapshots from two
      // different simulations, and both tickers clobber the same
      // checkpoint. `mayPublish` reads ONLY the confirmed-ownership clock
      // (never the merely-attempted one), so this check cannot be fooled by
      // a renew that has been attempting and failing the whole time.
      //
      //   (c) THE BUS TOLD US IT IS RECONNECTING. Everything issued since the
      //       drop is queued rather than delivered, renews included, so the
      //       ownership clock is a statement about a connection that was down.
      //       The guard runs on every iteration until one AWAITED renew
      //       confirms ownership over the restored connection, rather than
      //       waiting for `mayPublish` to age out on its own.
      const now = Date.now();
      if (owns && (busSuspect || !mayPublish(clock, now, leaseTtlMs))) {
        // CONFIRMED AGAINST THE ATTEMPT TIME, NEVER THE REPLY TIME. Redis
        // extended the key when it PROCESSED the command, so crediting
        // ownership from when the reply landed claims one reply delay more
        // life than the key actually has. Measured with a 600ms delayed reply:
        // 27 predecessor snapshots published after a successor legitimately
        // held the lease. The `max` keeps `lastOwnedAt` non-decreasing when
        // overlapping renews resolve out of order, which is the property the
        // two-clock rule depends on.
        clock = renewAttempted(clock, now);
        let renewed = false;
        try {
          renewed = await renewLease(redis, keys.lease, owner, { leaseTtlMs });
        } catch {
          renewed = false;
        }
        if (renewed) {
          clock = renewConfirmed(clock, Math.max(clock.lastOwnedAt, now));
          busSuspect = false;
        } else {
          clock = renewFailed(clock);
          owns = false;
          // THE EXIT REASON IS SET HERE BECAUSE THIS BREAK IS NOT THE ONLY
          // WAY OUT ON A LOST LEASE, AND FOR A LONG TIME IT WAS THE ONE
          // THAT LIED. `exitReason` is initialised to 'duration', and the
          // only other lease-loss path (the `lostLeaseExplicitly` check at
          // the bottom of the loop, fed by the ASYNC renew in section 11)
          // sets it properly. This one broke straight out with the
          // initialiser still standing, so a ticker that exited after 50ms
          // because ownership had lapsed reported `reason: 'duration'`:
          // "I ran to my configured lifetime cap", the one exit that means
          // everything is healthy and a successor should simply take over.
          //
          // WHICH OF THE TWO DETECTORS FIRES IS A SCHEDULING RACE, which is
          // what made it look like flakiness rather than a bug. The async
          // renew normally notices first and reports correctly; a loop
          // stalled past the TTL (a GC pause, a loaded host, exactly the
          // condition this guard exists for) means the synchronous guard
          // gets there first and reported the opposite. So the reason a
          // caller saw depended on machine load, and the case where it was
          // WRONG was the case where the room was in the most trouble.
          //
          // This string is public API. `adapters/node.ts` happens to treat
          // 'duration' and 'lease-lost' identically (both are "go again"),
          // but `adapters/vercel.ts` returns it as the response BODY, so it
          // is what a host branches on and what an operator counts: with
          // this line missing, a fleet losing leases out from under its
          // tickers reads as a fleet of healthy duration-capped handoffs.
          // That is the same shape as every other failure in this library
          // that cost real time, silent and flattering.
          exitReason = 'lease-lost';
          log({ lvl: 'error', kind: 'ticker.lease-lost', room: roomId, meta: { finder: 'guard' } });
          break;
        }
      }

      if (owns) {
        // 8. publish the snapshot
        //
        // THE FRAME IS STAMPED WITH THE SCHEDULED GRID TIME, NOT WITH A CLOCK
        // READ TAKEN AFTER THE SIM STEP, and this is the axis every client
        // interpolates remote entities on. Stamping it after `runtime.tick`
        // writes that tick's COMPUTE TIME into the playback timeline: a
        // simulation whose step alternates 3ms and 28ms emits snapshots the
        // client is told are 3ms and 28ms apart, so it plays a constant
        // velocity back at anywhere from 0.5x to 2.2x. The tick grid is what
        // the room actually simulates on and it is uniform by construction, so
        // it is the honest label for the state this frame carries. The
        // resync below only ever moves the grid FORWARD, so this stays
        // strictly increasing across a stall.
        //
        // `now` stays the wall clock for the lease guard, the checkpoint
        // cadence and the stats window: those measure this process, not the
        // room's timeline.
        //
        // THE PUBLISH IS ALSO BOUNDED, because a snapshot that cannot go out
        // now is worthless later; see `MAX_IN_FLIGHT_PUBLISHES`.
        if (inFlightPublishes >= MAX_IN_FLIGHT_PUBLISHES) {
          publishSkipped++;
        } else {
          const playerCount = playersNow;
          const payload = runtime.encodeSnapshot(state, stampedAt);
          const message: string | Buffer = typeof payload === 'string' ? payload : Buffer.from(payload);
          const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
          const publishStartedAt = Date.now();
          inFlightPublishes++;
          // EVERY ONE OF THESE COUNTERS IS MOVED WHEN THE PUBLISH RESOLVES,
          // NEVER WHEN IT IS ISSUED, and that placement is the difference
          // between this block reporting what the room DID and reporting what
          // it INTENDED. Incrementing outside the promise counted an attempt:
          // a room whose every publish was rejected reported 20 publishes a
          // second and a bytes figure climbing at the healthy rate, while the
          // only signal that actually waited for the bus (`publishAwaitHist`)
          // stayed empty and, back when an empty window read as zeros, then
          // reported the BEST POSSIBLE latency. Three gauges agreeing that a
          // dead room was the healthiest in the fleet.
          //
          // The one honest cost of counting on resolution is that a publish
          // still in flight when a stats window closes lands in the NEXT
          // window, and a publish still in flight when the ticker exits is
          // never counted at all. Both are correct: an unconfirmed publish is
          // not a delivered one, and at 20Hz against a healthy bus the
          // straggler is at most a tick's worth of one window's total.
          //
          // `playerCount` and `bytes` are captured out here on purpose: they
          // describe the frame that was sent, and the room's population may
          // well have changed by the time the reply lands.
          redis
            .publish(keys.out, message)
            .then(() => {
              inFlightPublishes--;
              publishAwaitHist.push(Date.now() - publishStartedAt);
              publishes++;
              bytesPublished += bytes;
              bytesDelivered += bytes * playerCount;
            })
            .catch((err) => {
              inFlightPublishes--;
              publishFails++;
              log({ lvl: 'error', kind: 'ticker.publish-failed', room: roomId, meta: { error: String(err) } });
            });
        }

        // 9. checkpoint, gated on still owning the lease
        if (now - lastCheckpointAt >= checkpointMs) {
          lastCheckpointAt = now;
          // THE CRASH COUNTER IS CLEARED ONLY BY A ROOM THAT HAS OUTLIVED THE
          // COUNTER'S OWN WINDOW, and the window is the honest measure where a
          // checkpoint interval was an arbitrary one. Cleared after a
          // checkpoint interval, ANY poison that kills the loop later than a
          // second in never accumulates: measured at four invocations with the
          // counter stuck at 1, so the limit is unreachable and the crash-loop
          // guard does nothing whatsoever. The key expires `CRASH_KEY_TTL_S`
          // after the first crash of a run of them, so an invocation that has
          // run that long has outlived the evidence against it by definition,
          // and anything shorter clears a count it has not yet earned the
          // right to clear.
          if (!crashCounterCleared && now - startedAt >= CRASH_KEY_TTL_S * 1000) {
            crashCounterCleared = true;
            redis.del(keys.crashes).catch(() => {});
          }
          queueCheckpoint().catch((err) =>
            log({ lvl: 'error', kind: 'ticker.checkpoint-write-failed', room: roomId, meta: { error: String(err) } })
          );
        }

        // meta: publish the roster whenever it changed
        if (metaDirty) {
          metaDirty = false;
          publishMeta();
        }
      }

      // 10. stats, flushed every `statsMs` regardless of ownership (a
      // ticker that just lost the lease still wants its final numbers seen)
      if (now - lastStatsAt >= statsMs) {
        const elapsedS = (now - lastStatsAt) / 1000;
        const measuredHz = elapsedS > 0 ? ticksSinceStats / elapsedS : runtime.tickHz;
        // Late inputs are a DELTA over the window, not the buffers' lifetime
        // totals: `lateCount` only ever climbs, so reporting it raw would make
        // a link that was briefly bad in the first minute look bad forever.
        // A buffer dropped mid-window takes its unreported residual with it,
        // which is at most one window's worth for one player and is the right
        // price for not carrying a map of pids nothing else needs.
        let lateInputs = 0;
        for (const [pid, buf] of playouts) {
          const seen = lateSeen.get(pid) ?? 0;
          if (buf.lateCount > seen) lateInputs += buf.lateCount - seen;
          lateSeen.set(pid, buf.lateCount);
        }
        const stats: RoomStats = {
          tick: runtime.currentTick(state),
          players: runtime.playerCount(state),
          tickHz: measuredHz,
          uptimeS: (now - startedAt) / 1000,
          publishes,
          publishFails,
          publishSkipped,
          dropped,
          starves,
          renewFails,
          badEnvelopes,
          unknownEnvelopes,
          hostErrors,
          refusedInputs,
          rejectsSuppressed,
          lateInputs,
          bytesPublished,
          bytesDelivered,
          cadence: cadenceHist.percentiles(),
          publishAwait: publishAwaitHist.percentiles(),
          serverInternal: serverInternalHist.percentiles(),
          at: now,
          build: buildId,
          labels: statsLabels,
        };
        // Captured before the reset below so the summary can be emitted AFTER
        // it. A host-supplied logger is allowed to throw, and a throw between
        // building `stats` and zeroing the counters it was built from would
        // escape to the loop's catch with the counters still holding a window
        // that has already been reported, double-counting it into the next one.
        const unknownThisWindow = unknownEnvelopes;
        const lastUnknownThisWindow = lastUnknownEnvelopeT;
        const hostErrorsThisWindow = hostErrors;
        const lastHostErrorThisWindow = lastHostError;
        const lastHostErrorHookThisWindow = lastHostErrorHook;
        // Read-and-reset in ONE uninterrupted synchronous block, no `await`
        // between building `stats` and zeroing the counters it was built
        // from: several of these are also written from the subscriber's
        // `on('message')` callback, and inserting an await here would open
        // a window where that callback's own increments land between the
        // snapshot being taken and the reset, silently losing them.
        const json = JSON.stringify(stats);
        publishes = 0;
        publishFails = 0;
        publishSkipped = 0;
        dropped = 0;
        starves = 0;
        renewFails = 0;
        badEnvelopes = 0;
        unknownEnvelopes = 0;
        lastUnknownEnvelopeT = '';
        hostErrors = 0;
        refusedInputs = 0;
        rejectsSuppressed = 0;
        lastHostError = '';
        lastHostErrorHook = '';
        bytesPublished = 0;
        bytesDelivered = 0;
        ticksSinceStats = 0;
        cadenceHist.clear();
        publishAwaitHist.clear();
        serverInternalHist.clear();
        lastStatsAt = now;

        redis
          .set(keys.stats, json, 'PX', STATS_TTL_MS)
          .catch((err) => log({ lvl: 'error', kind: 'ticker.stats-write-failed', room: roomId, meta: { error: String(err) } }));
        // Refresh the meta hash's TTL on this same cadence: it otherwise
        // has no expiry of its own, and a ticker that dies hard (skipping
        // its own cleanup) must not leave a phantom-full roster behind
        // forever. Riding an existing cadence costs nothing extra.
        redis.expire(keys.meta, metaTtlS).catch(() => {});

        // A PLAYER IS PRESENT BECAUSE A RELAY KEEPS SAYING SO, not because one
        // said so once. The relay heartbeats its join every second and the
        // only removal was a single fire-and-forget `leave`, which is lost
        // whenever it lands in a handoff gap: measured as a phantom player
        // that every successor faithfully restored and no room could ever
        // drain. A pid whose heartbeat has stopped for `presenceTimeoutMs`
        // gets the leave the bus dropped, synthesised here, on a cadence
        // nothing on the wire can drive.
        if (lastJoinAt.size > 0) {
          let silent: string[] | null = null;
          for (const [pid, at] of lastJoinAt) {
            if (now - at >= presenceTimeoutMs) (silent ??= []).push(pid);
          }
          if (silent !== null) {
            log({
              lvl: 'warn',
              kind: 'ticker.presence-timeout',
              room: roomId,
              msg: 'no join heartbeat within presenceTimeoutMs: treating these players as departed',
              meta: { count: silent.length },
            });
            for (const pid of silent) {
              // Deleted first: `handleEnvelope` deletes it too on the honoured
              // path, and this is what stops a runtime with a grace period
              // from being handed the same synthesised leave every flush.
              lastJoinAt.delete(pid);
              // No `c`, so it is honoured exactly like a relay's own leave.
              handleEnvelope({ t: 'leave', pid });
            }
          }
        }
        // ONE summary line per stats flush, never one per message. `t` arrives
        // on a channel client traffic reaches, so a line per unknown envelope
        // would be a log amplifier (and on a host that bills per line, a cost
        // amplifier); the flush cadence is one nothing on the wire can drive.
        // Silent when the count is zero, so a healthy room says nothing.
        if (unknownThisWindow > 0) {
          log({
            lvl: 'warn',
            kind: 'ticker.unknown-envelope',
            room: roomId,
            msg: 'envelopes arrived with a type this ticker has no branch for, usually a producer deployed ahead of its consumer',
            meta: { count: unknownThisWindow, lastType: lastUnknownThisWindow },
          });
        }
        // The same rule, for the same reason, on the host's own hooks: every
        // one of them sits on a path whose rate a client or the tick grid
        // drives, so they are counted in process and summarised once here
        // rather than logged per call. `hook` and `last` name WHERE and WHAT,
        // because a count alone tells an operator there is a bug and not
        // which one.
        if (hostErrorsThisWindow > 0) {
          log({
            lvl: 'error',
            kind: 'ticker.host-errors',
            room: roomId,
            msg: 'the host simulation threw out of its own hooks; the room kept running without those calls',
            meta: { count: hostErrorsThisWindow, hook: lastHostErrorHookThisWindow, last: lastHostErrorThisWindow },
          });
        }
        guardHost(() => onStats?.(stats), 'onStats', 'ticker.onStats-threw');

      }

      // 10b. THE INPUT SUBSCRIPTION'S OWN LIVENESS, ON ITS OWN CLOCK.
      //
      // A subscriber whose TCP path is black-holed produces no event at all:
      // no error, no close, nothing to observe. The room keeps ticking,
      // publishing and renewing while every join and every input is silently
      // dropped, and every single metric stays green. Measured over a 4s black
      // hole: zero log lines, healthy stats, one input applied. The only way
      // to learn that a channel still delivers is to send something down it
      // and watch for it coming back, so this publishes its own probe on
      // `keys.in` and reads the answer through its own subscriber.
      //
      // PACED BY ITS OWN CONSTANTS RATHER THAN BY THE STATS FLUSH. Riding the
      // flush made the deadline three stats windows, so `statsMs`, a knob this
      // file documents as a metrics cadence, silently decided when a room was
      // declared dead: at `statsMs: 40` a healthy room with a 150ms bus was
      // torn down. See `PROBE_INTERVAL_MS`.
      //
      // Fire-and-forget with a `.catch` and a purely synchronous check, like
      // everything else in this loop: a probe that could not even be published
      // is an unanswered probe, which is exactly the right reading. A
      // subscription silent for `PROBE_DEAD_MS` is not coming back, and the
      // fix is a fresh process with a fresh connection, so this exits like a
      // duration cap (release, spawn a successor) rather than sitting on a
      // lease it cannot serve.
      if (probesSent > probesAnswered && now - lastProbeAnswerAt >= PROBE_DEAD_MS) {
        exitReason = 'input-dead';
        log({
          lvl: 'error',
          kind: 'ticker.input-dead',
          room: roomId,
          msg: 'the input subscription stopped delivering: handing the room to a successor with a fresh connection',
          meta: { sent: probesSent, answered: probesAnswered, silentMs: now - lastProbeAnswerAt },
        });
        break;
      }
      if (now - lastProbeAt >= PROBE_INTERVAL_MS) {
        lastProbeAt = now;
        probesSent++;
        redis.publish(keys.in, JSON.stringify({ t: 'probe', n: probesSent, o: owner } satisfies RoomEnvelope)).catch(() => {});
      }

      // 11. renew, off the hot path
      if (owns && renewDue(clock, now, leaseRenewMs)) {
        // The attempt time, captured here and confirmed against below: Redis
        // extended the key when it processed the command, so this is the last
        // instant ownership can honestly be dated from. See the synchronous
        // guard above for the measurement.
        const attemptAt = now;
        clock = renewAttempted(clock, attemptAt);
        renewLease(redis, keys.lease, owner, { leaseTtlMs })
          .then((ok) => {
            if (ok) {
              // `busSuspect` is deliberately NOT cleared here. Only the
              // AWAITED renew in the guard above proves ownership at the
              // instant a publish is about to happen; this one reports on a
              // round trip that started an unknown time ago.
              clock = renewConfirmed(clock, Math.max(clock.lastOwnedAt, attemptAt));
            } else {
              // An EXPLICIT loss: Redis told us, via the atomic
              // compare-and-set inside `renewLease`, that this owner no
              // longer holds the key. That is a stronger signal than a
              // thrown error (which could just as easily be a transient
              // network blip) and is acted on immediately rather than
              // waiting for the synchronous `mayPublish` guard to notice on
              // its own schedule.
              clock = renewFailed(clock);
              renewFails++;
              lostLeaseExplicitly = true;
            }
          })
          .catch(() => {
            // A genuine error, not a confirmed loss: leave `lostLeaseExplicitly`
            // untouched so the ticker keeps trying, but still move the clock
            // toward "not recently confirmed" so `mayPublish` starts its
            // countdown to false.
            clock = renewFailed(clock);
            renewFails++;
          });
      }

      // 11b. the STANDBY successor, spawned while this ticker is still
      // running rather than as it exits.
      //
      // The exit spawn lives in `finally`, so the successor only starts once
      // this one has finished: the room pays spawn plus cold start plus
      // acquire plus restore, which the docs put at 0.5 to 1.2s against a
      // client that covers at most 650ms. Firing `standbyLeadMs` early means
      // the successor has already paid all of that and is polling the lease
      // when this ticker releases it. Fire-and-forget, because unlike the exit
      // spawn there is a whole loop still running behind it to keep the
      // process alive; the exit spawn's bounded await exists precisely because
      // there is not.
      //
      // A LEAD LONGER THAN THE LIFETIME DISABLES IT, rather than firing the
      // standby on iteration one: `maxRunMs - standbyLeadMs` goes negative
      // there, which every iteration satisfies. A room whose whole lifetime is
      // shorter than a cold start has no planned handoff to smooth, so the
      // exit spawn is both the right answer and the only sensible one.
      if (
        !standbyRequested &&
        spawnSuccessor !== undefined &&
        standbyLeadMs < maxRunMs &&
        playersNow > 0 &&
        now - startedAt >= maxRunMs - standbyLeadMs
      ) {
        // TWO FLAGS, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS.
        // `standbyRequested` stops this re-firing on every remaining iteration
        // while the request is in flight; `standbySpawned` is what the exit
        // reads, and it means "a successor has been asked for and did not
        // refuse".
        //
        // A REJECTED SPAWN MUST NOT SUPPRESS THE EXIT SPAWN. A refused cold
        // start, a 429, a DNS failure: the standby never started, and with one
        // flag doing both jobs the exit skipped its own spawn on the strength
        // of a request that had already failed, so the room went dark until
        // some relay's jittered poll noticed. A rejection arrives in
        // milliseconds where the handoff lead is seconds, so clearing the flag
        // there is in time by a wide margin.
        //
        // Set on ISSUE and not only in the `.then`, which is the half that is
        // easy to get backwards: a host's spawn is an authenticated request to
        // the ticker endpoint, and that endpoint does not RESPOND until the
        // successor itself exits, minutes later. A flag set only on resolution
        // is therefore never true at exit time and the standby buys nothing.
        standbyRequested = true;
        standbySpawned = true;
        // ISSUED THROUGH A RESOLVED PROMISE, so a host whose `spawnSuccessor`
        // throws SYNCHRONOUSLY is treated exactly like one that returns a
        // rejected promise. The signature says it returns a promise, but a
        // plain function that validates its arguments and throws satisfies
        // that type right up until it runs, and the throw then lands before
        // `.then`/`.catch` are attached: it escapes into the loop body, the
        // loop's own catch reads it as a simulation failure, and a HEALTHY
        // duration exit becomes 'error'. That costs the room its final
        // checkpoint and its successor and increments the crash counter, all
        // for a bug in the host's spawn call rather than in the room.
        Promise.resolve()
          .then(() => spawnSuccessor(roomId, { standby: true }))
          .then(() => {
            standbySpawned = true;
          })
          .catch((err) => {
            standbySpawned = false;
            log({ lvl: 'error', kind: 'ticker.spawn-failed', room: roomId, meta: { error: String(err), standby: true } });
          });
      }

      // 12. exit conditions
      if (lostLeaseExplicitly || refusedNotOwner) {
        owns = false;
        exitReason = 'lease-lost';
        // LOGGED HERE TOO, because for a long time only the synchronous finder
        // said anything: a Redis restart that expired every lease produced a
        // fleet of tickers exiting 'lease-lost' with not one line saying so.
        // `finder` is what separates the two, since they fire under opposite
        // conditions (a confirmed refusal off the hot path, versus ownership
        // having already lapsed when an iteration began).
        log({
          lvl: 'error',
          kind: 'ticker.lease-lost',
          room: roomId,
          meta: { finder: refusedNotOwner ? 'checkpoint' : 'renew' },
        });
        break;
      }
      if (tickerShouldExit({ now: Date.now(), startedAt, emptySince }, { maxTickerMs: maxRunMs, emptyGraceMs })) {
        exitReason = Date.now() - startedAt >= maxRunMs ? 'duration' : 'empty';
        break;
      }

      // fixed-timestep grid: advance by exactly one tick's worth of time,
      // and if a stall (a GC pause, a slow tick) put us more than one tick
      // behind, RESYNC rather than bursting through several catch-up
      // iterations back to back. Bursting would publish several snapshots in
      // a fraction of a second followed by a normal gap, which reads to every
      // client as a stutter-then-rubber-band; resyncing means the room loses
      // the stalled time once and the cadence goes back to metronome-steady.
      //
      // THE RESYNC LANDS A FULL TICK IN THE FUTURE AND IS SLEPT TO, WHICH IT
      // USED NOT TO BE. Setting the grid to `now` and falling through with no
      // sleep ran the next iteration synchronously back to back with this one,
      // so two snapshots left with consecutive ticks and a `serverTime` gap of
      // 0 to 1ms: the client's interpolator divides a tick's worth of movement
      // by that gap and extrapolates at 5000 units a second, which is the
      // rubber-band the resync exists to prevent, produced by the resync
      // itself. Sleeping to `now + tickMs` also hands the event loop the turn
      // it needs to drain the envelopes that piled up during the stall, which
      // is the other half of recovering from one.
      nextTickAt += tickMs;
      if (Date.now() - nextTickAt > tickMs) {
        nextTickAt = Date.now() + tickMs;
      }
      await sleep(nextTickAt - Date.now());
    }
  } catch (err) {
    log({ lvl: 'error', kind: 'ticker.tick-threw', room: roomId, meta: { error: String(err) } });
    exitReason = 'error';
  } finally {
    // 13. final checkpoint + release, ONLY if we still believe we own the
    // lease. A ticker that has already lost ownership must never write a
    // checkpoint or release a key: either action could clobber a
    // successor's already-fresher state or free a lease that successor is
    // actively holding.
    //
    // AND A THROWN TICKER WRITES NO CHECKPOINT AT ALL, which is the one case
    // where "save what we have" is exactly the wrong instinct. The state at
    // the moment of a throw is half-mutated by definition: the sim step got
    // partway through and then unwound. Persisting it and spawning a successor
    // hands the next invocation the very bytes that killed this one, so it
    // restores them, throws in the same place, saves them again, and spawns
    // its own successor. Measured before the fix: 40 spawns in 958ms, a
    // permanent crash loop with no ceiling. The last PERIODIC checkpoint was
    // written by a tick that completed, so the room falls back to a state that
    // demonstrably simulates, at the cost of the seconds since.
    if (exitReason === 'error') {
      if (owns) {
        // THE TIMELINE MARKER GOES DOWN BEFORE THE LEASE COMES UP, because the
        // instant the lease is released a standby polling every 25ms can win
        // it and reach its own grid decision. Written from `lastStampedAt`,
        // which is the stamp of the iteration that threw: at or above anything
        // actually published, which is the safe side to be on for a floor.
        try {
          await redis.set(keys.timeline, String(lastStampedAt), 'EX', STATE_TTL_S);
        } catch (err) {
          log({ lvl: 'error', kind: 'ticker.timeline-write-failed', room: roomId, meta: { error: String(err) } });
        }
        try {
          await releaseLease(redis, keys.lease, owner);
        } catch (err) {
          log({ lvl: 'error', kind: 'ticker.release-failed', room: roomId, meta: { error: String(err) } });
        }
      }
      // Counted so a successor that keeps hitting the same throw eventually
      // starts the room FRESH instead of restoring the poison (see the startup
      // read). Short TTL, because crashes a minute apart are not a loop.
      // A FIXED WINDOW, NOT A SLIDING ONE, which is what the TTL's own comment
      // already claims it is. Re-applying the EXPIRE on every crash pushes the
      // deadline out each time, so three unrelated throws a minute apart trip
      // a limit that is supposed to mean three crashes inside one minute and
      // wipe a healthy room's checkpoint. Applying it only when the INCRBY
      // returns 1 dates the window from the first crash of a run, so unrelated
      // ones age out on their own.
      //
      // AWAITED, AND RACED, BECAUSE THIS IS THE LAST I/O ON THE CRASH PATH.
      // Fire-and-forget, the EXPIRE is not even ISSUED until the INCRBY
      // replies, which is after `runTicker` has already returned: measured in
      // that order. A platform that suspends or freezes the instance the
      // moment the handler resolves therefore loses the increment, or lands
      // the increment and drops the TTL and leaves a counter that never ages
      // out, which is the crash-loop guard failing in both directions at once.
      // Raced against a short timer for the same reason the successor spawn is
      // raced: a slow Redis must not hold the exit open.
      await Promise.race([
        (async () => {
          try {
            const count = await redis.incrby(keys.crashes, 1);
            if (count === 1) await redis.expire(keys.crashes, CRASH_KEY_TTL_S);
          } catch {
            // Best effort: the counter is a heuristic against a crash loop,
            // and an exit that cannot record it is not made better by hanging.
          }
        })(),
        sleep(CRASH_RECORD_TIMEOUT_MS),
      ]);
    } else if (owns) {
      try {
        // Through the chain, so it cannot overtake a periodic write that is
        // still compressing: the final checkpoint is the one a successor
        // restores, and it must be the NEWEST state rather than the fastest to
        // gzip.
        await queueCheckpoint();
        // AND THE MARKER COMES BACK UP, because this checkpoint's own `gridAt`
        // is now the end of the timeline and is a strictly better answer: it
        // is the grid point of the state a successor will actually restore,
        // where the marker is only a floor. Left behind, a marker from some
        // earlier crashed invocation would keep raising the floor of every
        // successor for a full state TTL.
        await redis.del(keys.timeline);
      } catch (err) {
        log({ lvl: 'error', kind: 'ticker.final-checkpoint-failed', room: roomId, meta: { error: String(err) } });
      }
      try {
        await releaseLease(redis, keys.lease, owner);
      } catch (err) {
        log({ lvl: 'error', kind: 'ticker.release-failed', room: roomId, meta: { error: String(err) } });
      }
    }

    // 14. spawn a successor if anyone is still here.
    //
    // Deliberately in `finally`, not at the tail of the `try`: a THROWN
    // tick is exactly the case where a room would otherwise sit dead with
    // players still connected to it, and that is the single worst outcome
    // this whole function can produce.
    //
    // Deliberately NOT gated on `owns`: a lost lease is precisely the
    // situation where nobody else has been told to start a successor, so
    // this must fire even then. It is safe to fire "blind" because a
    // successor that finds the lease already held (by whoever took it from
    // us) simply fails its own acquire and returns immediately as 'busy'.
    //
    // AWAITED but RACED against a short timer, never fire-and-forgotten.
    // Fire-and-forget was tried and was measurably wrong: as the very last
    // thing a handler does, it becomes background I/O the platform is free
    // to suspend the instant the handler returns, and the spawn request
    // intermittently never actually left the process. A bounded wait fixes
    // that without blocking forever, because the successor does not
    // RESPOND to this request until it exits, possibly minutes later.
    //
    // AND THE BOUND IS `EXIT_SPAWN_WAIT_MS`, WHICH DELIBERATELY OUTLASTS A
    // HOST'S DELIVERY RECEIPT. This spawn is not fire-and-forget in the other
    // direction either: a rejection here is the only line that says this room
    // has no ticker on every exit a standby did not precede. A bound shorter
    // than the host's own receipt window (2000 against the Vercel adapter's
    // 3000ms `SPAWN_ACK_MS`) made that unreachable, because the race was
    // decided before the spawn could tell anyone anything. See the constant
    // for the arithmetic against `TICKER_EXIT_MARGIN_MS`.
    //
    // Deliberately NOT `AbortSignal.timeout`: aborting the request could
    // propagate as a cancellation signal that tears down the very ticker
    // that was just started, which is worse than the bug this exists to
    // fix. Racing a plain timer leaves the request alive regardless of
    // which side of the race finishes first.
    //
    // TWO EXITS SKIP IT ENTIRELY. A room whose ticker THREW must not spawn
    // one: the successor restores the same checkpoint and dies the same way,
    // and the pair spins as fast as the platform can start functions. The
    // relay's jittered lease poll is the recovery path there, and its 1 to 2
    // second cadence is what paces the retries. And a PLANNED handoff that
    // already fired a standby has its successor: spawning a second one just
    // buys an invocation that loses the acquire and returns 'busy'.
    let remaining = 0;
    try {
      remaining = runtime.playerCount(state);
    } catch {
      remaining = 0;
    }
    const alreadyHandedOver = standbySpawned && exitReason === 'duration';
    if (remaining > 0 && spawnSuccessor && exitReason !== 'error' && !alreadyHandedOver) {
      // THE SAME WRAPPING, AND HERE IT IS WORSE THAN A WRONG EXIT REASON. A
      // synchronous throw from this call escapes the `finally` block itself,
      // so `runtime.dispose`, `sub.disconnect()` and the `redis.off` below it
      // never run and `runTicker` rejects instead of returning: the exact
      // leaks the teardown exists to prevent, caused by the one line that is
      // supposed to hand the room on.
      await Promise.race([
        Promise.resolve()
          .then(() => spawnSuccessor(roomId, { standby: false }))
          .catch((err) => {
            log({ lvl: 'error', kind: 'ticker.spawn-failed', room: roomId, meta: { error: String(err) } });
          }),
        sleep(EXIT_SPAWN_WAIT_MS),
      ]);
    }

    try {
      runtime.dispose?.(state);
    } catch (err) {
      log({ lvl: 'error', kind: 'ticker.dispose-threw', room: roomId, meta: { error: String(err) } });
    }
    try {
      sub?.disconnect();
    } catch {
      // best-effort teardown only
    }
    // The shared command client outlives this call, so the listener goes with
    // it: see `onReconnecting`.
    if (onReconnecting !== null) redis.off?.('reconnecting', onReconnecting);
  }

  return { reason: exitReason, ticks, uptimeMs: Date.now() - startedAt };
}
