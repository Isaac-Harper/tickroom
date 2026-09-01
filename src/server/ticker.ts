import { randomUUID } from 'node:crypto';
import {
  type RedisLike,
  roomKeys,
  LEASE_TTL_MS,
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
  packCheckpoint,
  unpackCheckpoint,
  PlayoutBuffer,
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
import { writeCheckpoint, readCheckpoint } from './checkpoint.js';
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
  namespace?: string;
  /**
   * Spawns a successor for this exact room. Given the room id, must issue
   * an authenticated request back to whatever endpoint runs `runTicker`
   * (see `session.ts`'s spawn token). Called from `finally`, not gated on
   * still holding the lease: see the long comment at the call site for why
   * both of those are load-bearing.
   */
  spawnSuccessor?(roomId: string): Promise<unknown>;
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
  init?(): Promise<void>;
  /**
   * A digest of the world geometry / rules this room's state must have been
   * simulated against. THE SINGLE MOST IMPORTANT OPTIONAL FIELD HERE: see
   * the restore block below for what silently breaks without it.
   */
  geomKey?(): string;
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
  onGeomMismatch?: 'reset' | ((envelope: CheckpointEnvelope) => TState | null);
  /** Events this tick emitted, handed to the host OFF the hot path (no await happens before or after this call inside the loop). */
  onEvents?(events: TEvent[], ctx: { roomId: string; tick: number; incarnation: string; redis: RedisLike }): void;
  onStats?(stats: RoomStats): void;
  log?: Logger;
  /** How often the state is checkpointed to Redis. Default 1000ms. */
  checkpointMs?: number;
  /** How often the stats gauge is flushed. Default 1000ms. */
  statsMs?: number;
  /** Hard ceiling on this ticker's own lifetime, ahead of the platform's kill. Default `MAX_TICKER_MS`. */
  maxRunMs?: number;
  /** How long an empty room is kept alive before exiting. Default `EMPTY_GRACE_MS`. */
  emptyGraceMs?: number;
  /** TTL refreshed on the meta hash every stats flush, so a hard-killed ticker cannot strand a phantom roster forever. Default 120s. */
  metaTtlS?: number;
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
  metaPayload?(map: Record<string, unknown>): unknown;
  /** Stamped into `RoomStats.build` for whoever reads the stats gauge. */
  buildId?: string;
  /**
   * Copied verbatim into `RoomStats.labels` on every flush, so a scraper can
   * dimension this room's gauges by something the library has no concept of
   * (which world it is, which region, which shard). Fixed for the lifetime
   * of the ticker on purpose: these become metric label values, and one whose
   * value varies with room state is unbounded cardinality in the backend.
   */
  statsLabels?: Record<string, string | number>;
  /**
   * How far past the tick being consumed a stamped input may be buffered.
   * Defaults to `PLAYOUT_MAX_AHEAD` (40 ticks, 2s at 20Hz).
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
   */
  playoutMaxAhead?: number;
  /**
   * Overrides `LEASE_TTL_MS`/`LEASE_RENEW_MS` from `core/lease.ts`. A host
   * has no reason to touch these in production (the defaults are the ones
   * this whole architecture was measured against), but a test that wants to
   * exercise the split-brain guard or a handoff without waiting out a real
   * multi-second lease window needs to shrink them, so they ride the same
   * options object rather than a separate test-only entry point.
   */
  leaseTtlMs?: number;
  leaseRenewMs?: number;
}

export interface TickerResult {
  reason: 'duration' | 'empty' | 'lease-lost' | 'busy' | 'error';
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
  } = opts;

  const keys = roomKeys(roomId, namespace);
  const tickMs = 1000 / runtime.tickHz;
  const owner = `${roomId}:${randomUUID()}`;
  const startedAt = Date.now();

  // --- 1. acquire the lease or bail immediately ---
  //
  // Exactly one ticker may own a room at a time; this is the primitive that
  // makes that true. Losing the acquire race is not an error, it is the
  // expected outcome for every invocation except the one that wins, so
  // callers should treat 'busy' as a normal, silent return rather than a
  // failure to log.
  const acquired = await acquireLease(redis, keys.lease, owner, { leaseTtlMs });
  if (!acquired) {
    return { reason: 'busy', ticks: 0, uptimeMs: 0 };
  }

  let clock: OwnershipClock = createOwnershipClock(startedAt);
  let owns = true;
  let lostLeaseExplicitly = false;

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
  if (init) {
    try {
      await init();
    } catch (err) {
      log({ lvl: 'error', kind: 'ticker.init-failed', room: roomId, meta: { error: String(err) } });
      try {
        await releaseLease(redis, keys.lease, owner);
      } catch {
        // Best effort. The lease's own TTL is the backstop.
      }
      return { reason: 'error', ticks: 0, uptimeMs: Date.now() - startedAt };
    }
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
  let state: TState;
  let incarnation: string;
  {
    let rawBody: string | null = null;
    try {
      rawBody = await readCheckpoint(redis, keys.state);
    } catch (err) {
      log({ lvl: 'warn', kind: 'ticker.checkpoint-read-failed', room: roomId, meta: { error: String(err) } });
    }
    const envelope = unpackCheckpoint(rawBody);
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
    } else {
      state = runtime.create(roomId);
      // Fresh per room CREATION, preserved across every RESTORE (see the
      // `restored` branch above, which keeps the checkpoint's own
      // incarnation rather than minting one here). This is what lets a
      // ledger idempotency key be BOTH stable across a restore (a replayed
      // event dedupes) and unique across a genuine re-creation (a drained
      // and rebuilt room is never mistaken for a replay of the old one).
      incarnation = randomUUID();
    }
  }

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
  try {
    const raw = await redis.hgetall(keys.meta);
    for (const [pid, json] of Object.entries(raw)) {
      try {
        metaMap.set(pid, JSON.parse(json) as Record<string, unknown>);
        present.add(pid);
      } catch {
        // A corrupt single field must not take down the whole restore.
      }
    }
  } catch (err) {
    log({ lvl: 'warn', kind: 'ticker.meta-read-failed', room: roomId, meta: { error: String(err) } });
  }

  // --- subscriber for keys.in ---
  const sub = createSubscriber();
  const inbox = new Inbox<RoomEnvelope>(); // core's defaults (cap 4096, perSenderCap 64, maxDrainPerTick 1024) are exactly what this ticker needs
  let badEnvelopes = 0;
  // Kept apart from `badEnvelopes` on purpose: a bad envelope is a broken or
  // hostile sender, an unknown one is almost always a producer deployed ahead
  // of its consumer. Merging them is what made the original failure invisible.
  let unknownEnvelopes = 0;
  let lastUnknownEnvelopeT = '';

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
    inbox.push(envelope, envelopePid(envelope));
  });
  try {
    await sub.subscribe(keys.in);
  } catch (err) {
    log({ lvl: 'error', kind: 'ticker.subscribe-failed', room: roomId, meta: { error: String(err) } });
  }

  // --- per-player playout state ---
  const playouts = new Map<string, PlayoutBuffer<ClientInput>>();
  const starve = new StarveTracker();

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
    runtime.onBufferHealth?.(state, pid, 0);
  }

  // --- counters, reset every stats flush (see the stats block) ---
  let publishes = 0;
  let dropped = 0;
  let starves = 0;
  let renewFails = 0;
  let bytesPublished = 0;
  let bytesDelivered = 0;
  let ticksSinceStats = 0;
  const cadenceHist = new RollingHistogram();
  const publishAwaitHist = new RollingHistogram();
  const serverInternalHist = new RollingHistogram();

  let ticks = 0;
  let emptySince: number | null = runtime.playerCount(state) === 0 ? Date.now() : null;
  let lastCheckpointAt = 0;
  let lastStatsAt = Date.now();
  let lastLoopAt = Date.now();
  let exitReason: TickerResult['reason'] = 'duration';
  let nextTickAt = Date.now();

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

  async function writeCheckpointNow(): Promise<void> {
    const envelope: CheckpointEnvelope = {
      v: CHECKPOINT_VERSION,
      tick: runtime.currentTick(state),
      graceUntilTick: runtime.graceUntilTick?.(state) ?? 0,
      geom: geomKey?.(),
      incarnation,
      body: runtime.serialize(state),
    };
    await writeCheckpoint(redis, keys.state, packCheckpoint(envelope));
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
   * Reconcile the metadata map against the simulation's OWN membership.
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
   * Runs every tick and is deliberately cheap: nothing is allocated and nothing
   * is even asked of the runtime while the roster is empty or while every
   * mapped pid is still present, which is every tick in normal operation.
   */
  function reconcileMeta(): void {
    if (runtime.presentPids === undefined || metaMap.size === 0) return;
    let live: Set<string> | null = null;
    let gone: string[] | null = null;
    for (const pid of metaMap.keys()) {
      if (live === null) live = new Set(runtime.presentPids(state));
      if (!live.has(pid)) (gone ??= []).push(pid);
    }
    // Collected first, removed after: `removeMeta` mutates `metaMap`, and
    // deleting from a Map while iterating its own keys is exactly the kind of
    // thing that works until the day it silently skips an entry.
    if (gone !== null) for (const pid of gone) removeMeta(pid);
  }

  function publishMeta(): void {
    const map: Record<string, unknown> = Object.fromEntries(metaMap);
    let frame: string | undefined;
    try {
      // The host's formatter, if any, decides the client-visible shape; see
      // `metaPayload` for why that seam exists. It is called INSIDE a try
      // because this is the one meta site that runs from the tick loop: an
      // uncaught throw here would not merely lose a roster frame, it would
      // unwind the loop and take the whole room down, where the relay's
      // equivalent only fails one socket's seed.
      const payload = metaPayload ? metaPayload(map) : { t: 'meta', map };
      // `JSON.stringify` returns undefined for `undefined` (and for a bare
      // function or symbol) despite its lying type. Suppressing the frame
      // beats publishing the four characters "undefined" onto a control
      // channel every client parses.
      frame = JSON.stringify(payload) as string | undefined;
    } catch (err) {
      // Reported, not retried. `metaDirty` was already cleared by the caller,
      // so a formatter that throws deterministically logs once per roster
      // CHANGE rather than once per tick: leaving the dirty flag set would
      // turn a broken formatter into a 20Hz log amplifier, which is the same
      // rule every client-rate path in this library follows.
      log({ lvl: 'error', kind: 'ticker.meta-payload-threw', room: roomId, meta: { error: String(err) } });
      return;
    }
    if (frame === undefined) return;
    redis
      .publish(keys.metaout, frame)
      .catch((err) => log({ lvl: 'error', kind: 'ticker.metaout-failed', room: roomId, meta: { error: String(err) } }));
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
        if (!already && runtime.isFull?.(state)) {
          redis
            .publish(keys.metaout, JSON.stringify({ t: 'room-reject', pid: env.pid }))
            .catch(() => {
              /* best-effort; a lost reject just means the client's own timeout handles it */
            });
          return;
        }
        present.add(env.pid);
        runtime.join(state, env.pid, env.meta);

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
        present.delete(env.pid);
        runtime.leave(state, env.pid);
        // METADATA REMOVAL FOLLOWS THE SIMULATION'S OWN MEMBERSHIP WHEN THE
        // RUNTIME REPORTS ONE, not this envelope. A `leave` means a socket
        // closed, which is not the same fact as a player having left: a
        // simulation with a disconnect grace deliberately keeps a departed
        // player for several seconds so their reconnect resumes seamlessly,
        // and removing their name here would announce a departure and an
        // arrival to the whole room for a player who never moved. The
        // reconcile pass in the loop owns removal in that case, and it
        // removes them when the SIMULATION says they are gone.
        //
        // With no `presentPids` there is nothing better to go on, so removal
        // stays exactly where it was: this is today's behaviour, unchanged,
        // for every runtime that does not opt in.
        if (runtime.presentPids === undefined) {
          removeMeta(env.pid);
        }
        dropPlayout(env.pid);
        break;
      }
      case 'in': {
        for (const input of env.w) {
          // ARRIVAL, reported before any decision about WHEN this will be
          // applied. This is the round-trip signal; `ackTick` on consume is
          // the timeline signal. See `onInputArrived` in `core/types.ts` for
          // why a client's dilation controller cannot be fed the second one
          // in place of the first.
          // Caught HERE rather than left to the drain site's own catch,
          // which would abandon the rest of this window: an input packet
          // carries the last few inputs as redundancy, so one throwing hook
          // call would silently discard several ticks' worth of a player's
          // input instead of one record's worth of an optional callback.
          try {
            runtime.onInputArrived?.(state, env.pid, input);
          } catch (err) {
            log({ lvl: 'warn', kind: 'ticker.onInputArrived-threw', room: roomId, meta: { error: String(err) } });
          }
          const stamped = (input.targetTick ?? 0) > 0;
          if (stamped && (runtime.usesPlayout?.(state, env.pid) ?? false)) {
            let buf = playouts.get(env.pid);
            if (!buf) {
              buf = new PlayoutBuffer<ClientInput>(playoutMaxAhead);
              playouts.set(env.pid, buf);
            }
            buf.push(input.targetTick as number, input);
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
            if (!stamped) dropPlayout(env.pid);
            runtime.applyInput(state, env.pid, input);
          }
        }
        break;
      }
      case 'custom': {
        // The out-of-band control channel: an admin command, a dev route
        // forcing a phase. Produced server-side with `publishCustom`, never
        // by the relay, so a client can never reach `onCustom`.
        runtime.onCustom?.(state, env.name, env.data, env.pid);
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

  try {
    while (true) {
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
          badEnvelopes++;
          log({ lvl: 'warn', kind: 'ticker.envelope-threw', room: roomId, meta: { error: String(err) } });
        }
      }

      // 4b. metadata follows the simulation's membership, not the socket's
      reconcileMeta();

      // 5. playout consume-exact pass, BEFORE the tick
      const tickNow = runtime.currentTick(state);
      // A buffer the runtime has stood down is dropped BEFORE the consume
      // pass, never after: consuming first would report one more starve and
      // run one more decay step for a player the simulation has already said
      // is not on the stamped path anymore, which is the entire thing
      // `clearPlayout` exists to stop. Collected before removing for the same
      // reason `reconcileMeta` does; `dropPlayout` mutates `playouts`.
      if (runtime.clearPlayout !== undefined && playouts.size > 0) {
        let stale: string[] | null = null;
        for (const pid of playouts.keys()) {
          if (runtime.clearPlayout(state, pid)) (stale ??= []).push(pid);
        }
        if (stale !== null) for (const pid of stale) dropPlayout(pid);
      }
      for (const [pid, buf] of playouts) {
        const { item, starved } = buf.consume(tickNow);
        if (starved) {
          starves++;
          const streak = starve.onStarve(pid);
          runtime.onStarve?.(state, pid, streak);
        } else if (item !== undefined) {
          starve.onConsume(pid);
          (runtime.applyBufferedInput ?? runtime.applyInput)(state, pid, item);
          runtime.ackTick?.(state, pid, tickNow);
        }
        // REPORTED ON BOTH PATHS, INCLUDING THE STARVE. The buffer lives in
        // this Map, so this is the only route by which its depth can reach the
        // host's state and therefore its snapshot, and a starve is precisely
        // when the depth matters and precisely when `ackTick` does not fire.
        // Hanging the health off `ackTick` instead would report it only on
        // ticks where the buffer was healthy enough to consume, which is the
        // one measurement nobody needs.
        runtime.onBufferHealth?.(state, pid, buf.health());
      }

      // 6. the sim step itself
      const tickStart = Date.now();
      const result = runtime.tick(state, 1 / runtime.tickHz);
      serverInternalHist.push(Date.now() - tickStart);
      ticks++;
      ticksSinceStats++;
      if (result && result.events && result.events.length > 0) {
        try {
          onEvents?.(result.events, { roomId, tick: runtime.currentTick(state), incarnation, redis });
        } catch (err) {
          log({ lvl: 'error', kind: 'ticker.onEvents-threw', room: roomId, meta: { error: String(err) } });
        }
      }

      // keep emptySince current before it is read by the exit check further down
      if (runtime.playerCount(state) === 0) {
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
      const now = Date.now();
      if (owns && !mayPublish(clock, now, leaseTtlMs)) {
        clock = renewAttempted(clock, now);
        let renewed = false;
        try {
          renewed = await renewLease(redis, keys.lease, owner, { leaseTtlMs });
        } catch {
          renewed = false;
        }
        if (renewed) {
          clock = renewConfirmed(clock, Date.now());
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
          log({ lvl: 'error', kind: 'ticker.lease-lost', room: roomId });
          break;
        }
      }

      if (owns) {
        // 8. publish the snapshot
        const playerCount = runtime.playerCount(state);
        const payload = runtime.encodeSnapshot(state, now);
        const message: string | Buffer = typeof payload === 'string' ? payload : Buffer.from(payload);
        const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
        const publishStartedAt = Date.now();
        redis
          .publish(keys.out, message)
          .then(() => {
            publishAwaitHist.push(Date.now() - publishStartedAt);
          })
          .catch((err) => {
            log({ lvl: 'error', kind: 'ticker.publish-failed', room: roomId, meta: { error: String(err) } });
          });
        publishes++;
        bytesPublished += bytes;
        bytesDelivered += bytes * playerCount;

        // 9. checkpoint, gated on still owning the lease
        if (now - lastCheckpointAt >= checkpointMs) {
          lastCheckpointAt = now;
          writeCheckpointNow().catch((err) =>
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
        const stats: RoomStats = {
          tick: runtime.currentTick(state),
          players: runtime.playerCount(state),
          tickHz: measuredHz,
          uptimeS: (now - startedAt) / 1000,
          publishes,
          dropped,
          starves,
          renewFails,
          badEnvelopes,
          unknownEnvelopes,
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
        // Read-and-reset in ONE uninterrupted synchronous block, no `await`
        // between building `stats` and zeroing the counters it was built
        // from: several of these are also written from the subscriber's
        // `on('message')` callback, and inserting an await here would open
        // a window where that callback's own increments land between the
        // snapshot being taken and the reset, silently losing them.
        const json = JSON.stringify(stats);
        publishes = 0;
        dropped = 0;
        starves = 0;
        renewFails = 0;
        badEnvelopes = 0;
        unknownEnvelopes = 0;
        lastUnknownEnvelopeT = '';
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
        try {
          onStats?.(stats);
        } catch (err) {
          log({ lvl: 'error', kind: 'ticker.onStats-threw', room: roomId, meta: { error: String(err) } });
        }
      }

      // 11. renew, off the hot path
      if (owns && renewDue(clock, now, leaseRenewMs)) {
        clock = renewAttempted(clock, now);
        renewLease(redis, keys.lease, owner, { leaseTtlMs })
          .then((ok) => {
            if (ok) {
              clock = renewConfirmed(clock, Date.now());
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

      // 12. exit conditions
      if (lostLeaseExplicitly) {
        owns = false;
        exitReason = 'lease-lost';
        break;
      }
      if (tickerShouldExit({ now: Date.now(), startedAt, emptySince }, { maxTickerMs: maxRunMs, emptyGraceMs })) {
        exitReason = Date.now() - startedAt >= maxRunMs ? 'duration' : 'empty';
        break;
      }

      // fixed-timestep grid: advance by exactly one tick's worth of time,
      // and if a stall (a GC pause, a slow tick) put us more than one tick
      // behind, RESYNC to now rather than bursting through several
      // catch-up iterations back to back. Bursting would publish several
      // snapshots in a fraction of a second followed by a normal gap, which
      // reads to every client as a stutter-then-rubber-band; resyncing
      // instead means the room simply loses the stalled time once, and the
      // cadence goes right back to metronome-steady.
      nextTickAt += tickMs;
      const drift = Date.now() - nextTickAt;
      if (drift > tickMs) {
        nextTickAt = Date.now();
      } else {
        await sleep(nextTickAt - Date.now());
      }
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
    if (owns) {
      try {
        await writeCheckpointNow();
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
    // Deliberately NOT `AbortSignal.timeout`: aborting the request could
    // propagate as a cancellation signal that tears down the very ticker
    // that was just started, which is worse than the bug this exists to
    // fix. Racing a plain timer leaves the request alive regardless of
    // which side of the race finishes first.
    let remaining = 0;
    try {
      remaining = runtime.playerCount(state);
    } catch {
      remaining = 0;
    }
    if (remaining > 0 && spawnSuccessor) {
      await Promise.race([
        spawnSuccessor(roomId).catch((err) => {
          log({ lvl: 'error', kind: 'ticker.spawn-failed', room: roomId, meta: { error: String(err) } });
        }),
        sleep(2000),
      ]);
    }

    try {
      runtime.dispose?.(state);
    } catch (err) {
      log({ lvl: 'error', kind: 'ticker.dispose-threw', room: roomId, meta: { error: String(err) } });
    }
    try {
      sub.disconnect();
    } catch {
      // best-effort teardown only
    }
  }

  return { reason: exitReason, ticks, uptimeMs: Date.now() - startedAt };
}
