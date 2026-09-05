// The transport-facing client: mints a session, opens a socket, survives
// reconnects, server handoffs and the relay's own lifetime cap invisibly,
// keeps a smoothed clock, measures a real round trip, and exposes a monotonic
// tick timeline for stamping predicted input. Framework free: the only browser
// globals it touches are `WebSocket`, `performance`, and, defensively,
// `sessionStorage`/`location` for the version-skew reload path, every one of
// them guarded so this class does not throw when used outside a browser tab (a
// test runner, a headless worker).

import {
  CLOSE_CODES,
  PING_INTERVAL_MS,
  PLAYOUT_MAX_AHEAD,
  RELAY_EXPIRY_LEAD_MS,
  ROOM_REJECT_FRAME,
  SERVER_FRAMES,
  encodePing,
  isPongFrame,
  isRelayExpiringFrame,
} from '../core/index.js';
import { ClientTick, TICK_STEP_CAP, type ClientTickView } from './clientTick.js';
import type { SnapshotInterpolator, EntitySample, InterpolatedEntity } from './interpolation.js';
import {
  stallDecision,
  shouldReanchor,
  STALL_COLD_MS,
  REANCHOR_MIN_INTERVAL_MS,
  type StallDecision,
  type NetStatus,
} from './netPolicy.js';

export type { NetStatus } from './netPolicy.js';

export interface SessionInfo {
  token: string;
  playerId: string;
  handle: number;
  room: string;
  [k: string]: unknown;
}

/**
 * The FOUR fields this class reads out of a decoded snapshot, and the whole
 * contract a host's own snapshot type has to satisfy. `tick` and `serverTime`
 * run the tick timeline and the smoothed clock; `version` drives the
 * protocol-skew check when the host opts into one; `inputLead` closes the
 * optional server-depth feedback loop. Everything else in a snapshot is the
 * host's and is carried through untouched.
 *
 * THERE IS NO INDEX SIGNATURE HERE, AND REMOVING IT WAS A FIX. It used to
 * carry `[k: string]: unknown`, which bought nothing (nothing in this class
 * reads a fifth field) and cost the library its own composability: an
 * `interface` gets no implicit index signature, so `DefaultSnapshot`, this
 * repo's own shipped decoder output, was not assignable to it and
 * `decodeSnapshot: (buf) => decodeDefaultSnapshot(buf)` failed with TS2322.
 * The index signature also erased the payload type on the way back out, so
 * `onSnapshot` handed back a shape whose own fields were `unknown` and every
 * consumer, including `examples/pong/client.ts`, recovered it with the
 * `as unknown as` double cast TypeScript's own error text calls a mistake.
 * The payload type is now threaded generically from `decodeSnapshot`'s return
 * type to `onSnapshot`'s parameter instead, so neither cast is needed at
 * either end.
 */
export interface DecodedSnapshotLike {
  version?: number | undefined;
  tick: number;
  serverTime: number;
  /**
   * Optional: the server's playout depth for THIS client at its last consume,
   * in ticks. It is the value `RoomRuntime.onBufferHealth` receives, which the
   * host routes through its own snapshot (per player, or just this player's,
   * as its wire allows) and picks out for its own pid inside `decodeSnapshot`.
   * Positive means this client's stamped inputs are arriving EARLY and are
   * sitting in the buffer; 0 means they land just in time, or late.
   *
   * Present, it closes a slow feedback loop that trims the stamping lead
   * toward a two-tick cushion. Absent, the loop is simply inert and the
   * RTT-compensated lead from `inputLeadMs` applies on its own, which is why
   * this is optional rather than required: a host with no room on its wire
   * loses an optimisation, not a working connection.
   */
  inputLead?: number | undefined;
}

/**
 * The roster control frame the relay seeds a joining socket with and the
 * ticker broadcasts on every roster change. Exported because a browser-only
 * consumer has no reason to open the SERVER declarations, which is where this
 * shape was documented and nowhere else: `onText` is `unknown`, so narrowing
 * to the WRONG shape typechecks perfectly and yields an empty roster forever,
 * i.e. no names, no presence count and no join or leave notifications, with
 * nothing anywhere reporting a problem.
 *
 * `map` is keyed by pid. Its values are whatever the host wrote into that
 * player's join metadata, so they stay `unknown`: this library cannot know
 * that shape and must not pretend to.
 */
export interface RosterFrame {
  t: 'meta';
  /** True only on the ONE-SHOT frame a socket is seeded with on join. Absent on the broadcasts that follow. A client that renders both identically can ignore it. */
  seed?: boolean | undefined;
  map: Record<string, unknown>;
}

/** Narrow an `onText` payload to a `RosterFrame`. Returns false for every other control frame the host may send on the same channel, so a caller can `if (!isRosterFrame(msg)) return;` and be sure of the fields it then reads. */
export function isRosterFrame(msg: unknown): msg is RosterFrame {
  if (typeof msg !== 'object' || msg === null) return false;
  const frame = msg as { t?: unknown; map?: unknown };
  return frame.t === 'meta' && typeof frame.map === 'object' && frame.map !== null;
}

/**
 * Why this connection is over and will not recover on its own.
 *
 * `'conn-limit'` used to be called `'rate-limited'`, which named the wrong
 * mechanism: `CLOSE_CODES.connLimit` and the `conn-limit` frame both mean the
 * per-subject SOCKET cap (already playing in another tab), not a message rate
 * limit, and both examples' own banner text already said so.
 */
export type TerminalReason =
  | 'closed-by-server'
  | 'capacity'
  | 'conn-limit'
  | 'version-skew'
  | 'connect-error'
  | 'mint-failed'
  | 'stopped';

/**
 * The structural subset of the DOM `WebSocket` interface tickroom needs. A
 * real `WebSocket` satisfies this with zero adapter code (same reasoning as
 * `RedisLike` in core: narrow the interface to what is actually called, so a
 * fake implementation for tests, or an alternative transport, only has to
 * implement a handful of members instead of the entire real API surface).
 */
export interface WebSocketLike {
  readyState: number;
  binaryType?: string | undefined;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  /**
   * THE EVENT PARAMETERS ARE `any`, DELIBERATELY, AND `unknown` IS THE WRONG
   * ANSWER HERE. Under `strictFunctionTypes` a function-typed PROPERTY is
   * checked contravariantly in its parameters, so a handler slot declared
   * `((ev: unknown) => void) | null` demands that `unknown` be assignable to
   * the real implementation's own event type, which nothing is. That made
   * neither the DOM `WebSocket` nor ws's assignable to
   * `WebSocketConstructor`: measured as `Type '((event: Event) => void) | null'
   * is not assignable to type '((ev: unknown) => void) | null'`. Both of this
   * library's READMEs papered over it by telling hosts to write
   * `WebSocketImpl: WebSocket as unknown as WebSocketConstructor`, which is a
   * cast around a type that was simply wrong, on the one line every consumer
   * copies.
   *
   * There is no sound alternative: the slot's parameter type would have to be
   * a SUBtype of the DOM's `Event`, of ws's `Event`, and of whatever a third
   * implementation invents, which is not a type anyone can write. `any` is the
   * escape hatch for exactly this, and it costs nothing here because the class
   * annotates each handler at its own assignment site (see `attachSocket`), so
   * every event this file actually reads is still fully typed.
   */
  onopen: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
}

/** A `WebSocket` implementation. The DOM global and ws's export both satisfy this WITHOUT a cast; see the note on `WebSocketLike`'s handler slots for why that took `any`. */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

/**
 * The interpolator this connection OWNS, and the one function that says where
 * the entities live in a decoded snapshot. Both halves in one option, so it is
 * not possible to supply either without the other.
 *
 * THE CONNECTION HOLDS THE INTERPOLATOR BECAUSE THE INTERPOLATOR IS
 * EPOCH-SCOPED AND THE CONNECTION IS WHAT OWNS THE EPOCH. Every host used to
 * hand-write the same bridge into `push()`, and the two fields that never vary
 * across any writing of it (`receivedAt`, which must come from the same clock
 * `sample()` reads, and `serverTime`, which must be the authority's stamp and
 * not a second local one) are precisely the two the docs spent fifteen lines of
 * capitalised warning on. Worse, a reconnect has to `clear()` the buffer, and
 * only the caller could: skipping it brackets the first frame of the new epoch
 * against one from seconds ago at `frac ~= 1`, a guaranteed snap on every
 * reconnect, with the previous socket's path delay carried into the new
 * estimate. The connection already does the identical thing for the one other
 * epoch-scoped component it holds, one line away, in `markUnanchored()`.
 */
export interface SnapshotInterpolationOptions<TSnap, K extends string | number> {
  /** The interpolator to push into and to clear on every epoch change. Its key type decides `K`, and `SnapshotInterpolator` has no default key type, so the host states it once here. */
  into: SnapshotInterpolator<K>;
  /** Pull the entities that MOVE out of one decoded snapshot. Everything else in the snapshot (scores, a winner, a serve countdown) is discrete state that has no meaning half way between two values, so it belongs in `onSnapshot` rather than here. */
  entities(snap: TSnap): Map<K, EntitySample>;
}

/**
 * EVERY OPTIONAL FIELD HERE IS WRITTEN `?: T | undefined`, AND THE CALLBACKS
 * AS PROPERTIES RATHER THAN METHOD SHORTHAND. That is not a style choice: a
 * consumer whose `tsconfig.json` came from a stock `tsc --init` has
 * `exactOptionalPropertyTypes` on, where `?: number` means "present with a
 * number, or absent" and REFUSES an explicit `undefined`. This library's own
 * README tells a host to write `return { ...snap, inputLead: mine?.[1] }`,
 * which is exactly that, so the quickstart did not compile under the default
 * tsconfig of the ecosystem it ships into. Same reasoning as the
 * `upgradeWebSocket` signature fix: a type that only compiles under THIS
 * repo's tsconfig is a type that is wrong for the people using it.
 */
export interface RoomConnectionOptions<TSnap extends DecodedSnapshotLike, K extends string | number> {
  /** Mint or fetch a session. Called on the first connect attempt and again whenever a re-mint is triggered (see the pre-open-failure rule below); an ordinary reconnect reuses the session already on hand. Its result is VALIDATED before use: a `token`, `playerId` and `room` that are strings and a finite `handle`, because a 401 body is JSON too and used to become the session, after which every URL carried a literal `undefined` and the ladder looped forever with nothing latching.
   *
   * SIZE THE TOKEN'S LIFETIME AGAINST THE RELAY LIFETIME CHAIN, NOT AGAINST A
   * SESSION. A warm swap reuses the session already on hand, so once the token
   * is past its `maxAgeS` every swap is refused (401 before the upgrade, 4001
   * after it) and the relay's lifetime cap goes back to costing a visible cold
   * reconnect every ~13 minutes. A replacement that fails to connect therefore
   * drops the cached session, so the ordinary ladder re-mints and the next cap
   * has a token that works; `stats().swapsFailed` is what says this is
   * happening. */
  mint(): Promise<SessionInfo>;
  /** Build the ws URL from a session. Defaults to `${wsProto}//${location.host}${path}?token=..&pid=..&h=..&room=..`, which needs a `location` global; supply this explicitly anywhere that is not a browser tab. */
  socketUrl?: ((session: SessionInfo) => string) | undefined;
  /** Path component of the default socket URL. Ignored if `socketUrl` is supplied. */
  path?: string | undefined;
  /**
   * Fixed simulation rate this room runs at. MUST match the host's
   * `RoomRuntime.tickHz`, and is REQUIRED rather than defaulted for that
   * reason: it used to default to 20, so a 10Hz room whose client simply did
   * not mention it ran every derived quantity at twice the right basis (the
   * tick counter's step, `estimateServerTick`'s slope, and the underrun
   * threshold in `stats()`), silently. The host always knows this number, so
   * asking for it costs one line and a missing one is now a compile error
   * rather than a 2x error nothing reports.
   */
  tickHz: number;
  /** Decode a binary snapshot. Return null to ignore the frame (a malformed or not-yet-understood payload should never throw the connection). THROW an error whose `name` is `'ProtocolVersionError'` on a wire version this bundle does not implement, and the connection takes its skew-recovery path (reload once, then latch `'version-skew'`); this repo's own codecs do exactly that. Its return type is what fixes `TSnap` for `onSnapshot` and for `interpolate.entities`, so no cast is needed at either end. */
  decodeSnapshot(buf: ArrayBuffer): TSnap | null;
  /** Protocol version this bundle speaks. Omit to disable the returned-version skew check entirely (useful before a codec exists yet). A decoder that THROWS `ProtocolVersionError` reaches the same recovery without this option. */
  protocolVersion?: number | undefined;
  /** Drive an interpolator from this connection's own snapshot stream and epoch. See `SnapshotInterpolationOptions`. Omit it to keep a `SnapshotInterpolator` by hand, which is still supported and is what a host with several buffers, or with a render layer that owns its own playback, will want. */
  interpolate?: SnapshotInterpolationOptions<TSnap, K> | undefined;
  /** Every decoded snapshot, in the concrete type `decodeSnapshot` returned. For the discrete state interpolation cannot smooth; the moving entities are `interpolate`'s job. */
  onSnapshot?: ((snap: TSnap) => void) | undefined;
  /** JSON control frames the host relay sends: a roster update, a capacity notice, a quota warning. Parsed for you; handed back as the parsed value, or the raw string if it did not parse as JSON. The library's OWN control frames (`pong`, `relay-expiring`) are consumed here and never reach this callback, because they are transport bookkeeping rather than anything a host has an opinion about. */
  onText?: ((msg: unknown) => void) | undefined;
  onStatus?: ((status: NetStatus) => void) | undefined;
  /** Fires on EDGES only (stalled false -> true, or true -> false), never once per poll. */
  onStallChange?: ((stalled: boolean) => void) | undefined;
  /**
   * The tick counter just jumped, by `deltaTicks`. Fires on every re-anchor
   * EXCEPT the very first of this connection's lifetime, where nothing has
   * been rendered yet and so there is nothing to smooth.
   *
   * This is the number a host folds into its `ErrorOffset` (the local
   * prediction moved, and the render has to absorb it over a few frames
   * rather than teleport) or uses to resync its own speculative simulation.
   * `ClientTick.anchorTo` has always returned it and documented it for exactly
   * this; until now its only caller threw it away, so the one signal that says
   * "your prediction is now wrong by this much" reached nobody.
   *
   * IF YOU DEDUPE YOUR INPUT SENDS BY A LAST-STAMPED-TICK HIGH-WATER MARK,
   * RESYNC IT HERE. A BACKWARD re-anchor (a negative delta) puts `tick.value`
   * below a mark that was set before the correction, so a
   * `if (t <= lastSent) return;` guard stops sending anything at all until the
   * counter climbs back past it. Measured on the end-to-end harness: 5.6
   * seconds of total input silence after one backward re-anchor, and 100
   * self-inflicted starves on the server, from a client that was otherwise
   * perfectly healthy. One line fixes it:
   *
   * ```ts
   * onTickReanchor: (d) => { lastSentTick += d; err.reset(); }
   * ```
   *
   * A HOST ON `PredictedEntity` NEEDS NONE OF THAT: it reads a backward jump
   * off `tick.value` inside `advance` and resets its own mark and window, so
   * for it this callback is telemetry, a count of how often the counter moved.
   */
  onTickReanchor?: ((deltaTicks: number) => void) | undefined;
  /**
   * Fires once per terminal, and a terminal is a connection this class will
   * not recover from on its own. A host can still restart deliberately, which
   * is what makes the bounded re-assign loop the balancer is designed for
   * expressible:
   *
   * ```ts
   * onTerminal: (r) => { if (r === 'capacity' && tries++ < 3) void conn.start({ remint: true }); }
   * ```
   */
  onTerminal?: ((reason: TerminalReason) => void) | undefined;
  /**
   * The rate this room is ACTUALLY ticking at disagrees with the `tickHz` you
   * configured, by more than a fifth, sustained. Fires at most once per
   * connection epoch, and changes nothing: the counter, the stamping lead and
   * the clock all keep running on the rate you configured.
   *
   * It exists because the alternative is silence. `tickHz` is required rather
   * than defaulted because a default was a silent 2x error; a WRONG value is
   * the same error with the same silence, and the server has been telling us
   * its real rate on every pair of snapshots the whole time. `stats().serverTickHz`
   * is the same number, continuously.
   */
  onTickRateMismatch?: ((measuredHz: number) => void) | undefined;
  /** Cap on the exponential reconnect backoff, ms. Default 5000. */
  maxBackoffMs?: number | undefined;
  /**
   * Jitter headroom, in MILLISECONDS, added on top of the measured round trip
   * when deciding which tick to stamp inputs with. Default 150 (see
   * `DEFAULT_INPUT_LEAD_MS` for the measurement behind the number).
   *
   * MILLISECONDS AND NOT TICKS, AND ON TOP OF A MEASURED RTT, BECAUSE THE OLD
   * SCHEME WAS NEITHER. The lead used to be a flat 4 ticks with no round-trip
   * term at all, which is 200ms of total budget at 20Hz and 67ms at 60Hz; a
   * player on a 250ms round trip therefore stamped every input into a tick the
   * server had already simulated, for the whole session, and the only symptom
   * is input that feels heavier than the ping suggests. The lead is now
   * `rttMs + inputLeadMs`, so the round trip is covered by measurement and
   * this number only has to cover the jitter on top of it.
   */
  inputLeadMs?: number | undefined;
  /**
   * Deadline on `mint()` and on the socket handshake, ms. Default 10000.
   *
   * Nothing used to bound either one: a `mint()` whose promise never settles,
   * or an upgrade that is accepted by a load balancer and then never completed,
   * left this class in `'connecting'` with no timer and no terminal. Measured
   * at ten minutes of fake time with the connecting banner up and no attempt
   * in flight. Both deadlines now feed the ORDINARY reconnect ladder rather
   * than a terminal, because a slow path is usually a slow path.
   */
  connectTimeoutMs?: number | undefined;
  /** Inject a fake WebSocket constructor for testing, or point at an alternative implementation. Defaults to the global `WebSocket`. */
  WebSocketImpl?: WebSocketConstructor | undefined;
}

const DEFAULT_PATH = '/api/ws';
const DEFAULT_MAX_BACKOFF_MS = 5000;
/**
 * First reconnect delay, ms, before jitter.
 *
 * IT WAS 250, AND A HEALTHY RECONNECT DOES NOT NEED 250ms. Measured in a real
 * Chromium run, a host opens the replacement socket in 6 to 18ms, so the
 * ladder itself was most of the outage; and the interpolator's cover is its
 * delay (80ms at the floor) plus `EXTRAP_CAP_MS` (150), which 250 exceeds, so
 * every reconnect on a fast link ended in about four motionless frames that
 * nothing but the backoff caused. 100 fits inside that cover with room to
 * spare and still backs off to the same cap within one extra step.
 */
export const RECONNECT_BASE_MS = 100;
/** Growth per attempt. The delay is `RECONNECT_BASE_MS * RECONNECT_FACTOR ** attempt`, capped at `maxBackoffMs`, then jittered. */
export const RECONNECT_FACTOR = 2;
/**
 * The jittered delay is the capped delay times a factor drawn uniformly from
 * `[RECONNECT_JITTER_MIN, RECONNECT_JITTER_MAX)`.
 *
 * A LADDER WITH NO JITTER IS A THUNDERING HERD, and this architecture builds
 * one by construction: a relay function holds many sockets and dies all at
 * once, so every client on that instance starts its ladder in the same
 * millisecond and retries in lockstep for as long as they keep failing.
 * Measured on two clients dropped together: both scheduled at exactly
 * [250, 250]. Spreading each delay over a 3:1 range breaks the convoy on the
 * first retry rather than after it has already hit whatever is still coming
 * back up.
 */
export const RECONNECT_JITTER_MIN = 0.5;
export const RECONNECT_JITTER_MAX = 1.5;
const WS_OPEN = 1;
const PRE_OPEN_FAILURES_BEFORE_REMINT = 3;
/** Consecutive 4001 closes BEFORE this epoch delivered anything, after which the token is assumed stale and a fresh mint is forced. Kept apart from `preOpenFailures` because a 4001 arrives on a socket that DID open (the node adapter verifies after the upgrade), and `onopen` resets that counter, so counting there could never reach the threshold. */
const AUTH_CLOSES_BEFORE_REMINT = 3;
/** Consecutive throws out of the post-mint half of a connect attempt before the ladder gives up and says so. */
const CONNECT_THROWS_BEFORE_TERMINAL = 3;
/** Consecutive structurally invalid sessions from `mint()` before the ladder gives up. A malformed session is deterministic (a 401 body does not become valid by being fetched again), so this is a small number. */
const BAD_MINTS_BEFORE_TERMINAL = 3;
const RELOAD_STORAGE_KEY = 'tickroom.reloadedAt';
const RELOAD_WINDOW_MS = 30_000;
const ARRIVAL_GAP_RING_CAP = 20;
/** A snapshot arriving later than this multiple of one tick interval is counted as an "underrun" for the diagnostic in `stats()`. Not the same measurement as `SnapshotInterpolator.underrunRate` (that one knows about the render playhead; this one only knows arrival timing), documented as a proxy at the field itself. */
const UNDERRUN_GAP_FACTOR = 1.5;
const UNDERRUN_EMA_TAU_MS = 3000;
/** Accepted round-trip samples kept for the sliding-window MINIMUM. Eight of them at `PING_INTERVAL_MS` is sixteen seconds of history: long enough that one contaminated sample cannot define the estimate, short enough that a mobile client walking onto a worse path is followed within a few pings. */
const RTT_WINDOW = 8;
/** Hard ceiling on a single round-trip sample, ms. `c` is echoed back off the wire, so the sample is only ever as trustworthy as the relay and as the local event loop; anything past this is not a measurement of a path a player is going to enjoy either way. */
const RTT_MAX_SAMPLE_MS = 5000;
/**
 * Default jitter headroom on top of the measured round trip, ms. 150 rather than
 * the 100 it was, because the ticker now consumes the input stamped for the
 * tick it PRODUCES (one tick less arrival slack than the old off-by-one gave
 * for free), and on a real deployment at an 80ms round trip that took the
 * starve rate from about 3 to about 10 a minute for a three-player room at
 * 100, and back to under 3 at 150 (8 in three minutes). One more tick
 * of headroom at 20Hz gives the same slack back at the same latency the old
 * timing had, with the input now landing on the tick it names. A host that
 * measures its own link lower can set `inputLeadMs` down; the feedback loop
 * trims toward the target depth on its own where the server echoes it.
 */
const DEFAULT_INPUT_LEAD_MS = 150;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Samples in the server-clock offset window. At 20Hz that is a little over three seconds of history, long enough for one genuinely uncongested packet to land in it. */
/** How far a snapshot's own `serverTime` may sit from the estimated server clock before it is refused as implausible, ms. Generous by a mile: a healthy stamp is within one round trip, and this only has to catch a stamp that is wrong by a different ORDER of magnitude. */
const SNAPSHOT_TIME_PLAUSIBLE_MS = 60_000;
/** ...and how far a snapshot's `tick` may sit from the last accepted one. A 20Hz room takes fourteen hours to travel this far, so this is a corruption bound and not a "did the room restart" bound: an ordinary restart, from tick 5000 back to 0, is a 5000-tick jump that never comes near it. */
const SNAPSHOT_TICK_JUMP_MAX = 1_000_000;
/**
 * Consecutive implausible snapshots after which the run is adopted rather than
 * refused, exactly as the interpolator treats a run of future-stamped frames.
 *
 * THE REASON IS THAT NO REFUSAL MAY BE PERMANENT, whatever produced the run.
 * That is the whole justification and it does not need a story about which
 * legitimate event crosses the bound, which is just as well: the tempting story
 * ("a room that restarted at tick 0") is FALSE at these numbers, since a
 * restart only trips `SNAPSHOT_TICK_JUMP_MAX` in a room that has been up for
 * fourteen hours. Both bounds are judged against a reference this class
 * computes for itself, so a reference that is somehow wrong refuses every frame
 * forever and the connection stalls with every other signal reading healthy,
 * which is a strictly worse failure than adopting whatever is actually
 * arriving. The escape exists for that, and the count is what keeps a single
 * corrupt frame from taking it.
 *
 * Safe as a CONSECUTIVE count, unlike the interpolator's, because a WebSocket
 * delivers snapshots in order.
 */
const SNAPSHOT_IMPLAUSIBLE_REFUSALS = 3;
const SERVER_CLOCK_WINDOW = 64;
/** Fraction of elapsed wall time the offset estimate may move per sample. Same 5% as the interpolator's own offset ease, and for the same reason: the floor is the least contaminated estimate available, not a correct one, so chasing it instantly would render every route flap as motion. */
const SERVER_CLOCK_SLEW_MAX = 0.05;
/** How long every sample has to disagree with the current offset estimate before the estimate is treated as belonging to a timeline that no longer exists. */
const SERVER_CLOCK_STEP_MS = 600;
/** ...and how many samples have to have arrived while it disagreed. "Still arriving" is the safety of the escape hatch, exactly as it is in the interpolator's re-anchor: an outage produces the same disagreement with nothing to re-seed from. */
const SERVER_CLOCK_STEP_SAMPLES = 5;
const DEPTH_EMA_ALPHA = 0.2;
/** Playout depth the feedback loop aims the server's buffer at, in ticks. One tick of cushion absorbs a single late packet; two absorbs a pair without paying for a third tick of added input latency. */
const TARGET_DEPTH_TICKS = 2;
/** Floor on a warm swap's open-and-deliver deadline, ms. `inMs` is server-controlled, and a relay claiming it will close in 1ms would otherwise make the swap a socket-per-frame amplifier. */
const SWAP_MIN_DEADLINE_MS = 1000;
/** Consecutive accepted snapshots whose measured rate disagrees with the configured `tickHz` before it is called a mismatch rather than noise. Two seconds at 20Hz. */
const TICK_RATE_MISMATCH_RUN = 40;
/** How far the measured rate may sit from the configured one before it counts toward that run. A fifth is far wider than any jitter and far tighter than the 2x a wrong `tickHz` produces. */
const TICK_RATE_TOLERANCE = 0.2;
/** Rate samples kept for the median. Odd, so the median is a sample rather than an average of two. */
const TICK_RATE_WINDOW = 21;
/** Ceiling on the frame delta `frame()` derives from its own clock, seconds. A backgrounded tab returns with a gap of whatever the browser felt like, and every consumer of that delta (the tick counter's step budget, the interpolator's delay ease and speed low-pass) wants a plausible frame rather than a truthful one. The tick counter caps its own step count on top of this. */
const FRAME_DT_CAP_S = 0.25;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * `mint()` crosses a boundary the HOST owns, so its result is untrusted in
 * exactly the sense `ByteReader` and `SnapshotInterpolator.push()` already
 * treat their inputs as untrusted: the type is a compile-time claim about a
 * value that arrived at runtime, usually from `fetch().then(r => r.json())`,
 * where a 401 or a 500 body is valid JSON too. Returns the reason it is
 * unusable, or null.
 */
function invalidSessionReason(session: unknown): string | null {
  if (typeof session !== 'object' || session === null) return 'not an object';
  const s = session as Partial<SessionInfo>;
  if (typeof s.token !== 'string' || s.token.length === 0) return '`token` must be a non-empty string';
  if (typeof s.playerId !== 'string') return '`playerId` must be a string';
  if (typeof s.handle !== 'number' || !Number.isFinite(s.handle)) return '`handle` must be a finite number';
  if (typeof s.room !== 'string') return '`room` must be a string';
  return null;
}

/** What one rendered frame produced: the poses to draw, the stall state, and the delta the connection measured for itself. */
export interface FrameView<K extends string | number> {
  /**
   * The interpolated pose of every tracked entity, ready to draw. EMPTY when
   * no `interpolate` option was given, because there is then no buffer for
   * this connection to sample.
   *
   * Across a COLD reconnect it holds the last poses it drew rather than
   * emptying, each one flagged `extrapolated` with a `speed` of 0: a
   * reconnect used to blank every remote entity from the moment the attempt
   * began until the new epoch's first snapshot, which on Vercel happened at
   * every relay's own lifetime cap. The hold ends on that first snapshot.
   */
  entities: Map<K, InterpolatedEntity>;
  /** Same value `stallView().stalled` reports; `onStallChange` has already fired if this call changed it. */
  stalled: boolean;
  /** Seconds since the previous `frame()` call, clamped to `FRAME_DT_CAP_S`. Zero on the first call. Returned because a host's own per-frame work usually wants the same delta rather than a second, differently clamped one. */
  dt: number;
}

/** Everything `stats()` reports. Counters are lifetime and survive a reconnect; gauges are scoped to the current epoch, because a gauge that carries an outage across an epoch boundary describes a connection that no longer exists. */
export interface ConnectionStats {
  /** Round trip measured by the library's own `ping`/`pong` probe: the MINIMUM over the last `RTT_WINDOW` accepted samples (a pong is matched to a ping this client sent, a sample taken across a frozen render loop or above `RTT_MAX_SAMPLE_MS` is discarded). 0 until the first accepted pong. */
  rttMs: number;
  /** Standard deviation of snapshot arrival gaps this epoch, ms. */
  jitterMs: number;
  snapshotsReceived: number;
  /** Snapshots refused at the trust boundary (a non-finite `tick` or `serverTime`). Lifetime, like the interpolator's `rejectedFrames`. */
  rejectedSnapshots: number;
  underrunRate: number;
  reconnects: number;
  /** Warm swaps completed at a relay's lifetime cap, each one a reconnect the player never saw. */
  relaySwaps: number;
  /** Warm swaps STARTED, lifetime. `swapsAttempted - relaySwaps - swapsFailed` is 0, or 1 while one is in flight. */
  swapsAttempted: number;
  /** Warm swaps that ended without delivering, lifetime. A swap that fails costs nothing directly, but it puts the socket back on the cold ladder, which is the visible drop the swap exists to remove: a `swapsFailed` climbing in step with `swapsAttempted` means every relay lifetime cap is still costing a reconnect, and the usual cause is a session `maxAgeS` shorter than the relay lifetime chain. */
  swapsFailed: number;
  /** The simulation rate MEASURED off the snapshot stream, Hz, as a median over the last few seconds. 0 until two snapshots have been accepted. Compare it with the `tickHz` you configured: they must agree, and `onTickRateMismatch` fires if they do not. */
  serverTickHz: number;
  /** Throws out of the HOST's own callbacks that this class caught and carried on from (`onSnapshot`, `onText`, `onStatus`, `onStallChange`, `onTickReanchor`, `onTerminal`, and `interpolate.entities`). Lifetime. Nonzero means a bug in the host, invisible everywhere else because this class deliberately does not let one stop the connection. */
  hostErrors: number;
}

export class RoomConnection<
  TSnap extends DecodedSnapshotLike = DecodedSnapshotLike,
  K extends string | number = string,
> {
  private readonly opts: RoomConnectionOptions<TSnap, K>;
  private readonly tickMs: number;
  private readonly leadTicks: number;
  /** A frame gap past this is not a slow frame, it is a stopped render loop. Used both to unanchor the counter and to refuse a round-trip sample the freeze contaminated. */
  private readonly frozenFrameGapMs: number;
  private readonly clock: ClientTick;

  /**
   * This client's own stamping tick counter, read-only. Stamp an input's
   * `targetTick` with `tick.value`, and check `tick.initialized` before
   * trusting it. Advancing it is `frame()`'s job: see `ClientTickView`.
   */
  readonly tick: ClientTickView;

  private ws: WebSocketLike | null = null;
  private lastFrameAt: number | null = null;
  /** Has `frame()` run since `beginEpoch()`? Until it has, `lastFrameAt` belongs to the previous epoch and says nothing about how far this counter is owed. */
  private frameThisEpoch = false;
  private _status: NetStatus = 'idle';
  private stopped = true;
  private terminalReason: TerminalReason | null = null;
  private versionSkewStopped = false;

  /**
   * WHICH ATTEMPT IS THE LIVE ONE. Every re-entrancy check used to be
   * `if (this.stopped)`, which answers "is the connection stopped right now"
   * and not the question that actually matters, "was the attempt I am part of
   * abandoned". Measured, two ways: a `stop()` called from inside
   * `onStatus('connecting')` still created a socket AFTER the stop, which then
   * opened and delivered snapshots into a connection nothing could stop again;
   * and a `stop()` plus `start()` during a slow `mint()` let the abandoned
   * attempt open its own socket, whose eventual failure tore down the healthy
   * one through `scheduleReconnect`. Bumped by both `start()` and `stop()`,
   * captured on entry to an attempt, and re-checked after every await and
   * every callback into host code.
   */
  private generation = 0;

  private attempt = 0;
  private preOpenFailures = 0;
  private authCloses = 0;
  private connectThrows = 0;
  private badMints = 0;
  private freshTokenAttempt = false;
  /**
   * A warm-swap replacement failed to CONNECT, so the cached session is
   * suspect and the next connect attempt should mint a fresh one.
   *
   * A FLAG RATHER THAN NULLING `this.session` ON THE SPOT, and the difference
   * is not cosmetic: the swap fails while the OLD socket is still open and
   * serving, and two things read `this.session` in that window. `frame()`
   * stamps `heldRoom` from it, so a null made the next `beginEpoch()` compare
   * `null` against the room it had just re-minted into and throw away the held
   * poses on the single most common path there is (a relay lifetime cap with a
   * stale token), silently defeating the hold. And the own-pid `room-reject`
   * guard reads it, so a null made this client ignore a rejection addressed to
   * it and sit there `'open'`. The session must stay valid until the ladder is
   * actually choosing what to dial next, which is where this is consumed.
   */
  private remintOnNextConnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSeq = 0;
  /** `n` to the `c` we actually stamped it with, for the last few pings. A pong is checked against this and never trusted from the wire. */
  private outstandingPings = new Map<number, number>();
  private session: SessionInfo | null = null;

  private connectStartedAt = 0;
  private lastSnapAt = 0;
  private epochDelivered = false;
  private stallActive = false;
  private lastStallDecision: StallDecision | null = null;

  /** `rttMs()` as it stood when the current anchor was computed, so a round trip that turns out to be very different from the one the anchor assumed can invalidate it. */
  private anchorRttMs = 0;
  private serverClockOffset = 0;
  private serverClockSeeded = false;
  private clockOffsets: number[] = [];
  private lastClockSampleAt = 0;
  private clockStepSince = 0;
  private clockStepSamples: number[] = [];
  private lastSnapTick = 0;
  private lastSnapServerTime = 0;
  private lastReanchorAt = Number.NEGATIVE_INFINITY;

  private depthEma = 0;
  private depthSeeded = false;
  private feedbackTicks = 0;
  private lastFeedbackAt = 0;

  private pendingSwap: WebSocketLike | null = null;
  private pendingSwapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Never 0 for "no swap yet": `now()` is a `performance.now()` reading and 0 is a real one, on a page that opens its socket immediately. Same trap as `lastReanchorAt` and as `PlayoutBuffer.aheadBase`. */
  private lastSwapStartedAt = Number.NEGATIVE_INFINITY;

  private lastEntities: Map<K, InterpolatedEntity> | null = null;
  private heldEntities: Map<K, InterpolatedEntity> | null = null;
  private heldRoom: string | null = null;

  private snapshotsReceived = 0;
  private rejectedSnapshots = 0;
  private hostErrors = 0;
  private reconnects = 0;
  private relaySwaps = 0;
  private swapsAttempted = 0;
  private swapsFailed = 0;
  private lastArrivalAt: number | null = null;
  private arrivalGaps: number[] = [];
  private underrunEma = 0;
  private rttSamples: number[] = [];
  private implausibleRun = 0;
  private tickRateSamples: number[] = [];
  private tickRateMismatchRun = 0;
  private tickRateReported = false;

  constructor(opts: RoomConnectionOptions<TSnap, K>) {
    this.opts = opts;
    this.tickMs = 1000 / opts.tickHz;
    this.leadTicks = Math.ceil((opts.inputLeadMs ?? DEFAULT_INPUT_LEAD_MS) / this.tickMs);
    this.frozenFrameGapMs = FRAME_DT_CAP_S * 1000 + this.tickMs;
    this.clock = new ClientTick({ tickMs: this.tickMs });
    this.tick = this.clock;
  }

  get status(): NetStatus {
    return this._status;
  }

  /**
   * Start, restart after a `stop()`, or restart after a TERMINAL. Resolves
   * once the first connect attempt has been dispatched, not once a socket is
   * open: use `onStatus`/`onSnapshot` to observe readiness. Rejects only if
   * the very first `mint()` returns a session this class cannot use.
   *
   * A TERMINAL USED TO BE A ONE-WAY DOOR AND THE DOCS DESCRIBED A LOOP THROUGH
   * IT. `start()` returned early unless `stopped`, so calling it from
   * `onTerminal` did nothing at all, and a `stop()` first still reused the
   * private session, so the bounded re-assign loop the balancer exists for
   * ("this room is full, ask for another and reconnect") could not be written
   * against this class. Pass `remint: true` to drop the session so `mint()`
   * runs again, which is where a host consults its balancer with the room to
   * exclude:
   *
   * ```ts
   * onTerminal: (r) => { if (r === 'capacity' && tries++ < 3) void conn.start({ remint: true }); }
   * ```
   */
  async start(opts?: { remint?: boolean | undefined }): Promise<void> {
    if (!this.stopped && this.terminalReason === null) return;
    // A RESTART OUT OF A TERMINAL IS NOT ALLOWED TO REJECT, because the shape
    // the docs recommend for it is `void conn.start({ remint: true })` inside
    // `onTerminal`, and a rejected promise nobody holds is an unhandled
    // rejection plus a connection that latched nothing. On that path an
    // unusable session counts toward `badMints` and reaches `'mint-failed'`
    // like any other bad re-mint; only a first, awaited `start()` throws,
    // where the caller is holding the promise and wants the stack trace.
    const fromTerminal = this.terminalReason !== null;
    this.generation++;
    const gen = this.generation;
    this.teardownSocket();
    this.stopped = false;
    this.terminalReason = null;
    this.versionSkewStopped = false;
    this.attempt = 0;
    this.preOpenFailures = 0;
    this.authCloses = 0;
    this.connectThrows = 0;
    this.badMints = 0;
    // An explicit restart takes the HOST's instruction about the session and
    // not a flag left over from a swap that failed under the previous socket:
    // `start({ remint: true })` is how a caller asks for a fresh one.
    this.remintOnNextConnect = false;
    if (opts?.remint) this.session = null;
    this.connectStartedAt = now();
    this.lastSnapAt = 0;
    this.beginEpoch();
    await this.connectOnce(false, gen, !fromTerminal);
  }

  /** Tear the connection down deliberately. Fires `onTerminal('stopped')` once, so `pollStall()` never shows a stall banner for a connection the caller closed on purpose. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.enterTerminal('stopped', 'idle');
  }

  send(payload: ArrayBuffer | Uint8Array | string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(payload);
    } catch {
      // A socket that throws on send is already dying; its close event is
      // where recovery is driven from.
    }
  }

  /**
   * The server's clock reading right now, in the authority's own wall-clock
   * domain. Meaningless until the first snapshot of the current epoch has
   * landed, exactly like `estimateServerTick()`.
   *
   * ONE MONOTONIC DOMAIN, AND IT USED TO BE TWO. The offset was differenced
   * against `Date.now()` while every other timestamp in this class (`frame()`,
   * the interpolator's `receivedAt`) runs on `performance.now()`. A wall-clock
   * step, which is an ORDINARY event (an NTP correction on wake, a phone
   * picking up carrier time), therefore moved the tick estimate by the whole
   * step: measured, the counter snapped back about 20 ticks while remote
   * rendering, on the monotonic clock, carried on untouched. The offset is now
   * `performance.now() - serverTime` end to end, so a wall-clock step moves
   * nothing here at all.
   */
  serverNow(): number {
    return now() - this.serverClockOffset;
  }

  /**
   * A continuous estimate of the tick the server is on RIGHT NOW, extrapolated
   * from the newest snapshot's own tick and server-time stamp against the
   * smoothed clock. Distinct from `tick.value`, which is this CLIENT's own
   * stamping counter, deliberately led by `desiredTick()` so a stamped input
   * has time to arrive before the server reaches that tick.
   *
   * It LAGS the true server tick by the downstream one-way delay, because the
   * offset floor absorbs that delay by construction. That is not a defect to
   * fix here; it is why `desiredTick()` adds a measured round trip on top.
   */
  estimateServerTick(): number {
    if (!this.serverClockSeeded) return 0;
    const elapsedMs = this.serverNow() - this.lastSnapServerTime;
    return this.lastSnapTick + elapsedMs / this.tickMs;
  }

  /**
   * The tick this client WANTS to be stamping right now, and the value every
   * anchor uses: the estimated server tick, plus the measured round trip, plus
   * the configured jitter lead, plus whatever the optional server-depth
   * feedback loop has trimmed off.
   */
  desiredTick(): number {
    return this.estimateServerTick() + this.rttMs() / this.tickMs + this.leadTicks + this.feedbackTicks;
  }

  /**
   * The counter as the NEXT `frame()` will leave it: `tick.value` plus the
   * ticks the time since the last frame is worth, capped at `TICK_STEP_CAP`
   * because that is all `ClientTick.advance` will add. This is what the
   * re-anchor decision compares against `desiredTick()`, and ONLY that
   * decision: `tick.value` itself is what an input is stamped with, and it
   * moves in whole steps on frames, never here. Before the epoch's first
   * frame there is nothing to project from (the last frame belongs to the
   * previous epoch) and the counter is taken as it is.
   */
  private projectedTick(nowMs: number): number {
    if (!this.frameThisEpoch || this.lastFrameAt === null) return this.clock.value;
    const owed = Math.min(TICK_STEP_CAP, Math.max(0, (nowMs - this.lastFrameAt) / this.tickMs));
    return this.clock.value + owed;
  }

  /**
   * THE ONE PER-FRAME CALL. Drive it from `requestAnimationFrame` and draw
   * what it returns.
   *
   * It advances the tick counter, polls the stall detector (firing
   * `onStallChange` on edges) and samples the interpolator, from ONE delta
   * this class measures itself.
   *
   * IT IS ONE CALL BECAUSE IT USED TO BE THREE, AND THE MOST IMPORTANT OF THE
   * THREE WAS DOCUMENTED NOWHERE. A host had to call `pollStall()`,
   * `tick.advance(dt)` and `interp.sample(dt, now)` every frame; the middle one
   * appeared in no README, no architecture doc and not even in this repo's own
   * shipped client example, and omitting it is silent and expensive. Measured:
   * `tick.value` pinned at 4 while the server reached 20.2, so every input was
   * stamped 1.6 seconds in the past and drifting without bound, and because
   * `shouldReanchor` gates on `initialized` (which only `advance()` sets) the
   * omission ALSO permanently disabled the recovery that would have masked it.
   * The room connects, remote entities move beautifully, and only the player's
   * own input is wrong, in a way that reads as latency rather than a bug.
   * Folding all three into the call that returns the poses to draw is what
   * makes forgetting one of them impossible: a host that does not call this
   * renders nothing at all, which is loud.
   *
   * `nowMs` defaults to the same clock this class stamps `receivedAt` with, so
   * playback and the arrival stamps agree by construction. Pass the
   * `requestAnimationFrame` timestamp if you would rather name it: that is the
   * same `performance.now()` domain. DO NOT pass a `Date.now()` reading, which
   * is a different domain by about 1.7e12, and differencing the two is what
   * puts the playhead somewhere no frame will ever bracket.
   */
  frame(nowMs: number = now()): FrameView<K> {
    const rawGapMs = this.lastFrameAt === null ? 0 : nowMs - this.lastFrameAt;
    const dt = this.lastFrameAt === null ? 0 : Math.max(0, Math.min(FRAME_DT_CAP_S, rawGapMs / 1000));
    this.lastFrameAt = nowMs;
    this.frameThisEpoch = true;

    // A FROZEN RENDER LOOP IS AN EPOCH BOUNDARY FOR THE COUNTER. The dt above
    // is clamped and `ClientTick.advance` caps its own step count on top of
    // that, so every millisecond of a long gap past the cap is DROPPED and the
    // counter comes back that far behind the server, permanently: measured at
    // 591 ticks behind fifteen seconds after a 30 second background, with every
    // stamped input re-stamped on arrival while the host's prediction ran on a
    // different timeline. Nothing was rendered during the gap, so there is no
    // continuity to protect, which makes this exactly a reconnect as far as the
    // counter is concerned: unanchor and let the next snapshot re-anchor, with
    // `onTickReanchor` telling the host what moved. `shouldReanchor`'s
    // behind-side rule is the defence in depth for every other way the counter
    // can fall behind.
    if (rawGapMs > this.frozenFrameGapMs) this.clock.markUnanchored();

    this.clock.advance(dt);
    const stalled = this.pollStall(nowMs);
    let entities = this.opts.interpolate
      ? this.opts.interpolate.into.sample(dt, nowMs)
      : new Map<K, InterpolatedEntity>();

    // HOLD THE LAST POSES ACROSS A COLD RECONNECT. From `connectOnce` until the
    // new epoch's first snapshot the buffer is deliberately empty, and an empty
    // map draws as every remote entity vanishing: measured as entities 0 for
    // the whole reconnect, which on Vercel happens at every relay's own ~13
    // minute lifetime cap. A stale pose is a better answer than no pose, and it
    // is flagged as a guess so a host that wants to fade or ghost them can.
    if (entities.size > 0) {
      this.lastEntities = entities;
      this.heldEntities = null;
      this.heldRoom = this.session?.room ?? null;
    } else if (!this.epochDelivered && this.lastEntities !== null) {
      if (this.heldEntities === null) {
        this.heldEntities = new Map<K, InterpolatedEntity>();
        for (const [key, pose] of this.lastEntities) {
          this.heldEntities.set(key, { ...pose, speed: 0, extrapolated: true });
        }
      }
      entities = this.heldEntities;
    }

    return { entities, stalled, dt };
  }

  /**
   * Reset everything scoped to one CONNECTION EPOCH, at the moment a fresh
   * attempt begins.
   *
   * The tick counter must re-anchor from the next snapshot rather than trust a
   * value it kept advancing through a gap where no server owned the room, and
   * the interpolator must drop a buffer whose frames and whose measured clock
   * offset both belong to the previous socket's path. Those two facts have
   * always been the same fact; only the first of them used to live here, and
   * the second was left to every caller to remember from `onStatus`.
   *
   * EVERY GAUGE BELONGS HERE TOO, AND NONE OF THEM USED TO. A gauge describes
   * the connection you have; carried across an epoch it describes one that no
   * longer exists. Measured: the first snapshot of a new epoch reported a
   * jitter of 435ms and an underrun rate of 0.49, both of them the shape of the
   * outage rather than of the fresh socket, which is the worst possible moment
   * to be reporting a sick connection. COUNTERS (`snapshotsReceived`,
   * `reconnects`, `rejectedSnapshots`, `relaySwaps`) are lifetime and
   * deliberately survive, the same split the interpolator's `clear()` makes.
   */
  private beginEpoch(): void {
    this.clock.markUnanchored();
    this.frameThisEpoch = false;

    // A ROOM CHANGE INVALIDATES THE HELD POSES OUTRIGHT, and it has to be
    // settled BEFORE they are offered to the interpolator below. They are the
    // previous epoch's last drawn frame, which is the right thing to keep
    // across a reconnect INTO THE SAME ROOM and is somebody else's world
    // otherwise: a forced re-mint that lands in room B would go on drawing
    // room A's players over it until B's first snapshot.
    if (this.heldRoom !== (this.session?.room ?? null)) this.dropHeldPoses();

    this.opts.interpolate?.into.clear();
    // ...and hand the poses the host is currently looking at to the fresh
    // buffer, IMMEDIATELY AFTER the clear, so the new epoch's first snapshot
    // glides out of them instead of snapping. The ordering is the whole thing:
    // `clear()` drops the seed along with everything else, so seeding first
    // seeds nothing. Measured on the reconnect profile: a 25-unit step at
    // 1500 u/s and five motionless frames become a 4.47-unit worst step and no
    // motionless frames.
    //
    // WHY THE CONNECTION IS THE ONE THAT KNOWS. The poses being held on screen
    // are `frame()`'s own output, which only this class has, and the moment
    // they stop being valid is the epoch boundary, which only this class owns.
    // An interpolator cannot seed itself and a host would have to hand-write
    // the same two lines against a lifecycle it does not see.
    const held = this.lastEntities;
    if (held !== null) this.opts.interpolate?.into.resumeFrom(held);

    this.epochDelivered = false;
    this.resetArrivalGauges();
    // THE ROUND TRIP IS A GAUGE TOO, AND IT FEEDS THE STAMPING LEAD. Carrying
    // the dead socket's measurement into a fresh epoch leads the counter by a
    // path that no longer exists: measured, a 400ms reading taken off a socket
    // that had just died led the new epoch by 10 ticks until the first pongs
    // replaced it.
    this.rttSamples.length = 0;
    this.outstandingPings.clear();
    this.anchorRttMs = 0;
    this.implausibleRun = 0;
    this.tickRateSamples.length = 0;
    this.tickRateMismatchRun = 0;
    this.tickRateReported = false;
    this.lastSwapStartedAt = Number.NEGATIVE_INFINITY;

    this.serverClockOffset = 0;
    this.serverClockSeeded = false;
    this.clockOffsets.length = 0;
    this.lastClockSampleAt = 0;
    this.clockStepSince = 0;
    this.clockStepSamples.length = 0;
    this.lastReanchorAt = Number.NEGATIVE_INFINITY;

    this.depthEma = 0;
    this.depthSeeded = false;
    this.feedbackTicks = 0;
    this.lastFeedbackAt = 0;
  }

  /** The stall half of `frame()`, kept separate so the decision is made from one place and so a host driving its own clock can still reach it. */
  private pollStall(nowMs: number): boolean {
    const decision = stallDecision({
      now: nowMs,
      lastSnapAt: this.lastSnapAt,
      connectStartedAt: this.connectStartedAt,
      status: this._status,
      epochDelivered: this.epochDelivered,
      stallActive: this.stallActive,
      terminal: this.terminalReason !== null,
    });
    this.lastStallDecision = decision;
    if (decision.stalled !== this.stallActive) {
      this.stallActive = decision.stalled;
      const stalled = this.stallActive;
      this.emit(() => this.opts.onStallChange?.(stalled));
    }
    return this.stallActive;
  }

  stallView(): StallDecision {
    return this.lastStallDecision ?? { stalled: false, silentMs: 0, thresholdMs: STALL_COLD_MS };
  }

  /** Arrival-shaped gauges, reset wherever the path they describe is replaced: a new epoch, and a warm swap onto a different relay. */
  private resetArrivalGauges(): void {
    this.arrivalGaps.length = 0;
    this.lastArrivalAt = null;
    this.underrunEma = 0;
  }

  /** Stop drawing the previous epoch's last frame. A terminal and a room change both mean the poses describe a world this connection is no longer looking at. */
  private dropHeldPoses(): void {
    this.lastEntities = null;
    this.heldEntities = null;
    this.heldRoom = null;
  }

  /**
   * EVERY CALL OUT TO HOST CODE GOES THROUGH HERE, and that is a liveness
   * property rather than politeness. These callbacks are invoked from inside a
   * WebSocket event handler and from inside the reconnect ladder, so a throw in
   * one of them unwinds through this class and takes the recovery with it:
   * measured on a throwing `onStatus`, which is called from the close handler
   * one line before `scheduleReconnect()`, and which therefore turned a routine
   * drop into a connection that never tried again. A host callback that throws
   * is the host's bug and must cost the host's callback, nothing more.
   *
   * Swallowed rather than logged because this class has no logger and inventing
   * one here would be a bigger change than the fix.
   */
  private emit(fn: () => void): void {
    try {
      fn();
    } catch {
      // See above: a throwing host callback must never stop the ladder. It is
      // COUNTED rather than merely swallowed, because a silently swallowed
      // exception is a bug the host can neither see nor be told about, and
      // `stats().hostErrors` climbing is the one signal that says so.
      this.hostErrors++;
    }
  }

  stats(): ConnectionStats {
    return {
      rttMs: this.rttMs(),
      jitterMs: stddev(this.arrivalGaps),
      snapshotsReceived: this.snapshotsReceived,
      rejectedSnapshots: this.rejectedSnapshots,
      underrunRate: this.underrunEma,
      reconnects: this.reconnects,
      relaySwaps: this.relaySwaps,
      swapsAttempted: this.swapsAttempted,
      swapsFailed: this.swapsFailed,
      serverTickHz: this.serverTickHz(),
      hostErrors: this.hostErrors,
    };
  }

  /**
   * A sliding-window MINIMUM, not an average, and the same reasoning this
   * class already writes for the server clock: every sample is the true path
   * time plus whatever queueing happened on the way, queueing is
   * non-negative, so the smallest sample in the window is the least
   * contaminated estimate available. A rise that is real shows up in every
   * sample and moves the minimum within a window; a rise that is one bad
   * moment does not move it at all.
   *
   * AN EMA WAS MEASURABLY THE WRONG SHAPE HERE, because this number is no
   * longer a diagnostic: `desiredTick()` leans on it, so anything that
   * inflates it stamps inputs into the future. A three second render freeze on
   * a 20ms link put `rttMs` at 935 (the sample includes our OWN queueing, not
   * the network's), which snapped the counter 18 ticks forward and then spent
   * about twenty seconds unwinding it in corrections; a hostile relay echoing
   * a doctored `c` put it at 60000 and `desiredTick()` at 1703 against an
   * estimate of 501.
   */
  /**
   * The rate the SERVER is actually ticking at, read off consecutive
   * snapshots: each pair carries both a tick delta and a `serverTime` delta,
   * which is a rate. Median over the window rather than a mean, so one
   * handoff-sized gap in the stream cannot move it.
   */
  private serverTickHz(): number {
    if (this.tickRateSamples.length === 0) return 0;
    const sorted = [...this.tickRateSamples].sort((a, b) => a - b);
    return sorted[sorted.length >> 1] ?? 0;
  }

  private rttMs(): number {
    return this.rttSamples.length === 0 ? 0 : Math.min(...this.rttSamples);
  }

  private connectTimeoutMs(): number {
    return this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  // ---- connection lifecycle ----------------------------------------------

  private async connectOnce(forceMint: boolean, gen: number, awaited: boolean): Promise<void> {
    if (this.stopped || gen !== this.generation) return;
    this.setStatus('connecting');
    // `setStatus` calls host code SYNCHRONOUSLY, and a `stop()` or `start()`
    // made from inside `onStatus('connecting')` has to cancel this attempt.
    if (gen !== this.generation) return;

    // THE ONE PLACE THE LADDER DECIDES WHAT TO DIAL NEXT, and therefore the
    // only safe place to invalidate a session that a still-open socket may
    // still be relying on. A failed warm swap sets the flag; it is consumed
    // here, immediately before the mint decision reads `this.session`.
    if (this.remintOnNextConnect) {
      this.remintOnNextConnect = false;
      this.session = null;
    }

    if (!this.session || forceMint) {
      let minted: SessionInfo;
      try {
        minted = await this.withDeadline(this.opts.mint(), 'mint()');
      } catch {
        // A stop(), a start(), or a stale attempt landing in this await must
        // not be followed by a socket opening anyway: async callers cross an
        // await between their own check and the call, so the check has to live
        // HERE, not only at the call site that invoked connectOnce.
        if (gen !== this.generation) return;
        this.scheduleReconnect();
        return;
      }
      // Same re-check, for the success path: a stop() during a slow mint must
      // not open a socket just because the mint eventually resolved.
      if (gen !== this.generation) return;

      const badReason = invalidSessionReason(minted);
      if (badReason !== null) {
        const message = `tickroom: mint() returned an unusable session (${badReason}).`;
        if (awaited) {
          // The caller is holding this promise, so the loudest possible answer
          // is the right one: a host whose mint endpoint answered 401 wants a
          // stack trace, not a silent ladder. Left restartable rather than
          // latched, because fixing the mint and calling `start()` again is
          // exactly what a caller does next.
          this.stopped = true;
          this.setStatus('idle');
          throw new Error(message);
        }
        this.session = null;
        this.badMints++;
        if (this.badMints >= BAD_MINTS_BEFORE_TERMINAL) {
          this.enterTerminal('mint-failed', 'closed');
          return;
        }
        this.scheduleReconnect();
        return;
      }

      this.session = minted;
      this.badMints = 0;
    }

    if (!this.session) return; // unreachable: the branch above always assigns it or returns first
    const session = this.session;

    // EVERYTHING PAST THE MINT IS INSIDE THE TRY, BECAUSE THE LADDER IS DRIVEN
    // BY A `void`ED PROMISE. `scheduleReconnect` runs `void this.connectOnce(...)`,
    // so a throw here (a host `socketUrl` dereferencing a field its session
    // does not carry, a `WebSocket` constructor refusing a URL) used to be an
    // unhandled rejection and the ladder simply stopped: no timer, no terminal,
    // status stuck on 'connecting' forever. Measured.
    try {
      const url = this.opts.socketUrl ? this.opts.socketUrl(session) : this.defaultSocketUrl(session);
      if (gen !== this.generation) return;

      const Impl = this.opts.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
      if (!Impl) {
        throw new Error('tickroom: no WebSocket implementation available; pass `WebSocketImpl`.');
      }

      this.teardownSocket();
      this.beginEpoch();
      this.freshTokenAttempt = forceMint;

      const socket = new Impl(url);
      if (typeof socket.binaryType !== 'undefined') socket.binaryType = 'arraybuffer';
      this.ws = socket;
      this.attachSocket(socket, false);
      this.armConnectDeadline(socket, gen);
    } catch {
      if (gen !== this.generation) return;
      this.connectThrows++;
      if (this.connectThrows >= CONNECT_THROWS_BEFORE_TERMINAL) {
        this.enterTerminal('connect-error', 'closed');
        return;
      }
      this.scheduleReconnect();
    }
  }

  /** The normal, live handlers. Shared with the warm-swap path, which installs them on a replacement socket that is already open and has already delivered. */
  private attachSocket(socket: WebSocketLike, openedAlready: boolean): void {
    let openedThisSocket = openedAlready;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      openedThisSocket = true;
      this.clearConnectDeadline();
      this.attempt = 0;
      this.preOpenFailures = 0;
      this.connectThrows = 0;
      this.setStatus('open');
      this.startPinging();
    };

    socket.onmessage = (ev: { data: unknown }) => {
      if (this.ws !== socket) return;
      this.handleMessage(ev.data);
    };

    socket.onerror = () => {
      // Swallowed deliberately: a `close` event follows an `error` per the
      // WebSocket spec, and that is the single place reconnection is driven
      // from. Reacting here too would double-schedule a reconnect.
      if (this.ws !== socket) return;
    };

    socket.onclose = (ev: { code: number }) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.handleClose(ev.code, openedThisSocket);
    };
  }

  private handleClose(code: number, openedThisSocket: boolean): void {
    this.stopPinging();
    this.clearConnectDeadline();
    this.discardSwap();

    if (code === CLOSE_CODES.closedByServer) {
      // AN EXPIRED TOKEN ON RECONNECT IS NOT A KICK, AND THEY ARRIVE ON THE
      // SAME CODE. The node adapter verifies the token AFTER the upgrade and
      // closes 4001, so a session older than the host's `maxAgeS` (12 hours by
      // default) ends the game on the next network blip: measured as a terminal
      // that never re-mints. A 4001 BEFORE this epoch delivered anything is
      // therefore read as the token being stale rather than as a decision about
      // the player, and three of them force a fresh mint. Once the epoch has
      // delivered, the server had already accepted this token, so a 4001 can
      // only be a deliberate kick; and a 4001 on the first attempt after a
      // forced re-mint means the FRESH token was refused too, which is the same
      // answer arriving faster.
      if (this.epochDelivered || this.freshTokenAttempt) {
        this.enterTerminal('closed-by-server', 'closed');
        return;
      }
      this.authCloses++;
      // SCHEDULE FIRST, ANNOUNCE SECOND, here and below. `setStatus` calls host
      // code, and a host that throws in `onStatus` used to take the ladder with
      // it because the schedule was still queued behind the announcement.
      // `emit()` now stops the throw either way; this ordering means the two
      // defences are independent rather than one behind the other.
      this.scheduleReconnect();
      this.setStatus('closed');
      return;
    }
    if (code === CLOSE_CODES.capacity) {
      this.enterTerminal('capacity', 'closed');
      return;
    }
    if (code === CLOSE_CODES.connLimit) {
      this.enterTerminal('conn-limit', 'closed');
      return;
    }
    if (this.terminalReason !== null) {
      // Already latched terminal by some other path (version skew, an
      // already-processed capacity frame that arrived before this close).
      this.setStatus('closed');
      return;
    }
    if (this.stopped) {
      this.setStatus('idle');
      return;
    }

    if (openedThisSocket) {
      this.preOpenFailures = 0;
    } else {
      this.preOpenFailures++;
    }
    this.scheduleReconnect();
    this.setStatus('closed');
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    // The CAP applies to the exponential term and the jitter rides on top, so
    // a fully backed-off client retries somewhere in [0.5x, 1.5x) of the cap
    // rather than all of them landing on the cap together.
    const capped = Math.min(
      this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      RECONNECT_BASE_MS * RECONNECT_FACTOR ** this.attempt,
    );
    const jitter = RECONNECT_JITTER_MIN + Math.random() * (RECONNECT_JITTER_MAX - RECONNECT_JITTER_MIN);
    const delay = capped * jitter;
    // ATTEMPTS, NOT ELAPSED TIME, still drive the re-mint decision below: the
    // delays are now random, so anything keyed on how long the ladder has been
    // running would fire at a different point on every client.
    this.attempt++;
    this.reconnects++;

    // A socket that keeps dying BEFORE it ever opens is a different failure
    // mode from an ordinary drop: it means the token itself may be bad (a
    // deploy changed its format, it expired, the room stopped existing), and
    // retrying the identical session forever would strand the client in an
    // unauthorized loop with no way out. Three strikes forces a fresh mint
    // on the NEXT attempt; the counters reset here rather than staying
    // permanently tripped, so they can fire again if the fresh session also
    // turns out to be bad. A run of 4001 closes counts on its own tally: those
    // sockets DID open, and `onopen` clears `preOpenFailures`, so counting them
    // there could never reach a threshold.
    const forceMint =
      this.preOpenFailures >= PRE_OPEN_FAILURES_BEFORE_REMINT || this.authCloses >= AUTH_CLOSES_BEFORE_REMINT;
    if (forceMint) {
      this.preOpenFailures = 0;
      this.authCloses = 0;
    }

    const gen = this.generation;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || gen !== this.generation) return;
      void this.connectOnce(forceMint, gen, false);
    }, delay);
  }

  /**
   * Race a promise against `connectTimeoutMs`. A rejection here is
   * indistinguishable from the promise rejecting, deliberately: both mean this
   * attempt produced no session, and both belong on the ordinary ladder.
   */
  private withDeadline<T>(p: Promise<T>, what: string): Promise<T> {
    const ms = this.connectTimeoutMs();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`tickroom: ${what} exceeded connectTimeoutMs (${ms}ms).`)), ms);
      p.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** A socket that is accepted by a load balancer and never completed is silent forever otherwise; the deadline turns it into an ordinary pre-open failure. */
  private armConnectDeadline(socket: WebSocketLike, gen: number): void {
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (gen !== this.generation || this.ws !== socket) return;
      this.ws = null;
      try {
        socket.close();
      } catch {
        // ignore
      }
      this.handleClose(1006, false);
    }, this.connectTimeoutMs());
  }

  private clearConnectDeadline(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  // ---- round trip ---------------------------------------------------------

  /**
   * Ping on open and every `PING_INTERVAL_MS` after it. The relay answers a
   * `ping` frame itself, without touching Redis, so this is a true application
   * round trip and costs the room nothing.
   *
   * IT REPLACES A NUMBER THAT DID NOT MEASURE LATENCY AT ALL. `stats().rttMs`
   * used to pair the oldest outstanding `send()` with the next SNAPSHOT to
   * arrive, and a host that sends input at the tick rate into a room that
   * publishes at the tick rate is then measuring roughly U(0, tickMs): the
   * number moved with the tick rate and not with the network. A player on
   * satellite and a player on fibre reported the same "RTT", and `desiredTick`
   * now leans on this value for the stamping lead, which makes a fake one
   * actively harmful rather than merely useless.
   */
  private startPinging(): void {
    this.stopPinging();
    this.sendPing();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private sendPing(): void {
    const socket = this.ws;
    if (!socket || socket.readyState !== WS_OPEN) return;
    this.pingSeq++;
    const stamp = now();
    this.outstandingPings.set(this.pingSeq, stamp);
    // Bounded, and the oldest goes first: a pong that never came back is a
    // pong that is never coming back.
    while (this.outstandingPings.size > RTT_WINDOW) {
      const oldest = this.outstandingPings.keys().next().value;
      if (oldest === undefined) break;
      this.outstandingPings.delete(oldest);
    }
    try {
      socket.send(encodePing(this.pingSeq, stamp));
    } catch {
      // A dying socket's close event drives recovery; a failed probe is not
      // itself an event.
    }
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Latch a terminal, do EVERY teardown it implies, settle the status, and
   * only then tell the host. One function because the ORDER is the whole
   * point.
   *
   * `onTerminal` USED TO FIRE FIRST, AND THAT MADE THE DOCUMENTED RESTART
   * RECIPE A DEAD CONNECTION. This class's own comment recommends
   * `onTerminal: (r) => { if (r === 'capacity') void conn.start({ remint: true }) }`,
   * and `start()` reaches `new Impl(url)` SYNCHRONOUSLY whenever a session is
   * already on hand, so the host's restart installed its socket on `this.ws`
   * and then the teardown that was still queued behind the callback closed
   * that brand new socket and nulled the field. Its own `onclose` then hit the
   * `this.ws !== socket` guard, so nothing scheduled a reconnect either.
   * Measured: a `room-full` frame followed by 4002 produced two sockets, the
   * restart's `readyState` 3, `reconnects` 0, and a connection that was dead
   * for good, while the identical restart driven by the bare 4002 close code
   * survived, which is what made it look like a capacity bug rather than an
   * ordering one. It also left `status` reading `'closed'` after a successful
   * restart, because the status change was queued behind the callback too.
   *
   * So: the callback is the LAST statement, and everything this class needs to
   * be true about itself is already true when it runs.
   */
  private enterTerminal(reason: TerminalReason, status: NetStatus): void {
    // A second terminal for one logical event (a `room-full` frame and the
    // 4002 close behind it) still tears down and still settles the status; it
    // just does not tell the host twice.
    const fresh = this.terminalReason === null;
    if (fresh) this.terminalReason = reason;
    this.teardownSocket();
    this.dropHeldPoses();
    this.setStatus(status);
    if (fresh) this.emit(() => this.opts.onTerminal?.(reason));
  }

  private setStatus(s: NetStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.emit(() => this.opts.onStatus?.(s));
  }

  /**
   * DETACH-BEFORE-CLOSE. `this.ws` stops naming the socket before it is asked
   * to close, so its handlers' own `this.ws !== socket` guards see the mismatch
   * the instant we act, however that close event ends up being delivered.
   * Without this an orphaned socket keeps decoding messages into this
   * connection's state from a room it is no longer part of, runs its own
   * reconnect ladder in parallel with the replacement's, and can hold a slot
   * against a per-user connection cap until the host times it out.
   */
  private teardownSocket(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnectDeadline();
    this.stopPinging();
    this.discardSwap();
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close(1000, 'stopped');
      } catch {
        // A fake or already-broken socket throwing on close must not stop teardown.
      }
    }
  }

  private defaultSocketUrl(session: SessionInfo): string {
    if (typeof location === 'undefined') {
      throw new Error('tickroom: no `location` global available; pass `socketUrl` explicitly.');
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = this.opts.path ?? DEFAULT_PATH;
    const params = new URLSearchParams({
      token: session.token,
      pid: session.playerId,
      h: String(session.handle),
      room: session.room,
    });
    return `${proto}//${location.host}${path}?${params.toString()}`;
  }

  // ---- warm swap at the relay's lifetime cap -------------------------------

  /**
   * The relay function holding this socket dies at its own platform duration
   * cap (800s on Vercel), so EVERY socket in EVERY room reconnects roughly
   * every thirteen minutes whether anything is wrong or not. A reconnect blanks
   * every remote entity from `connectOnce` until the new epoch's first snapshot
   * and makes the interpolator re-seed its delay from nothing, all for an event
   * that is scheduled and announced in advance.
   *
   * So the relay announces it (`relay-expiring`, `RELAY_EXPIRY_LEAD_MS` ahead)
   * and this opens a replacement for the SAME session alongside the live one.
   * The replacement is only adopted once it proves it can deliver, which is the
   * whole point: a replacement that cannot subscribe, or lands on a relay that
   * is itself dying, must cost nothing, and the old socket's own 4004 close is
   * still there as the fallback.
   *
   * IT DELIBERATELY DOES NOT `beginEpoch()`. Same room, same server timeline,
   * same tick anchor, same clock offset, same buffered frames: an epoch change
   * would throw all of that away and produce exactly the gap this exists to
   * remove.
   */
  private beginWarmSwap(inMs: number): void {
    if (this.pendingSwap !== null || this.stopped || this.terminalReason !== null) return;
    const session = this.session;
    const old = this.ws;
    if (!session || !old) return;

    // `relay-expiring` IS A SERVER-CONTROLLED SOCKET-OPEN PRIMITIVE, so it is
    // rate limited like one. The frame is meant to arrive ONCE per relay
    // lifetime, `RELAY_EXPIRY_LEAD_MS` before the close; a relay (or anything
    // that can put a frame on this socket) repeating it at the snapshot rate
    // otherwise opens a socket per frame. Measured at 201 sockets in ten
    // seconds from `{ t: 'relay-expiring', inMs: 1 }` at 20Hz. The window is
    // consumed here rather than on success, so a swap that cannot even be
    // constructed cannot be retried at the same rate either.
    const startedAt = now();
    if (startedAt - this.lastSwapStartedAt < RELAY_EXPIRY_LEAD_MS) return;
    this.lastSwapStartedAt = startedAt;

    let replacement: WebSocketLike;
    try {
      const url = this.opts.socketUrl ? this.opts.socketUrl(session) : this.defaultSocketUrl(session);
      const Impl = this.opts.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
      if (!Impl) return;
      replacement = new Impl(url);
      if (typeof replacement.binaryType !== 'undefined') replacement.binaryType = 'arraybuffer';
    } catch {
      // A swap is an optimisation. Failing to even build one leaves the live
      // socket exactly as it was, and its eventual 4004 takes the ordinary path.
      return;
    }

    this.pendingSwap = replacement;
    this.swapsAttempted++;
    replacement.onopen = () => {
      // Open is not enough to swap on: a relay that accepted the upgrade and
      // then failed its own bus subscription is open and useless.
    };
    // A REPLACEMENT THAT CANNOT CONNECT IS EVIDENCE ABOUT THE SESSION, not
    // about the relay, and it is the one failure mode this whole mechanism
    // makes MORE likely rather than less. The swap reuses the cached session
    // verbatim, and a relay lifetime chain outlives a session whose `maxAgeS`
    // is shorter than it, so from the moment the token expires every swap is
    // refused (401 before the upgrade on Vercel, 4001 after it on node) and
    // silently discarded, and every relay cap goes back to costing a visible
    // cold reconnect with nothing anywhere saying why. Dropping the session
    // here makes the ordinary ladder re-mint when the old socket finally
    // closes, so the NEXT lifetime cap has a token that works.
    //
    // A TIMEOUT IS NOT TREATED THE SAME WAY, deliberately: a replacement that
    // never answered is far more likely to be a cold relay start than a bad
    // token, and throwing away a working session for that would re-mint on
    // every slow start.
    replacement.onerror = () => this.failSwap(replacement);
    replacement.onclose = () => this.failSwap(replacement);
    replacement.onmessage = (ev: { data: unknown }) => {
      if (this.pendingSwap !== replacement) return;
      // Text frames on a socket that is not live yet are dropped: the roster
      // seed it gets is a duplicate of one the live socket already delivered,
      // and the broadcasts that matter arrive after the swap.
      if (typeof ev.data === 'string') return;
      this.completeWarmSwap(replacement, ev.data);
    };
    // THE DEADLINE IS THE SOONER OF THE TWO, AND THE ANNOUNCED CLOSE IS
    // USUALLY IT. `connectTimeoutMs` defaults to 10s while `relay-expiring`
    // leads the close by `RELAY_EXPIRY_LEAD_MS` (5s), so a replacement given
    // the full connect deadline OUTLIVES the socket it exists to replace: the
    // old socket's 4004 lands first, `handleClose` discards the swap, and the
    // ordinary cold reconnect runs anyway, which is the exact gap this
    // mechanism exists to remove. Waiting past the announced close can only
    // ever waste the swap.
    // ...and floored, because `inMs` is the relay's number: a claimed 1ms
    // close would otherwise discard every replacement before it could open.
    const announced = Number.isFinite(inMs) && inMs > 0 ? inMs : this.connectTimeoutMs();
    const deadline = Math.max(SWAP_MIN_DEADLINE_MS, Math.min(this.connectTimeoutMs(), announced));
    this.pendingSwapTimer = setTimeout(() => {
      this.pendingSwapTimer = null;
      this.discardSwap(replacement);
    }, deadline);
  }

  private completeWarmSwap(replacement: WebSocketLike, first: unknown): void {
    const old = this.ws;
    this.pendingSwap = null;
    if (this.pendingSwapTimer !== null) {
      clearTimeout(this.pendingSwapTimer);
      this.pendingSwapTimer = null;
    }

    this.attachSocket(replacement, true);
    this.ws = replacement;
    this.relaySwaps++;
    // A DIFFERENT RELAY IS A DIFFERENT PATH, so the arrival-shaped gauges go
    // with it even though the epoch does not. The swap deliberately keeps the
    // anchor, the clock and the buffer, and it used to keep the arrival ring
    // too: measured, a replacement that took two seconds to subscribe left the
    // fresh socket reporting a jitter of 458ms and an underrun rate of 0.51,
    // which is the shape of the handover rather than of anything the player is
    // now experiencing. Counters are lifetime and stay.
    this.resetArrivalGauges();
    this.attempt = 0;
    this.preOpenFailures = 0;
    this.authCloses = 0;
    this.connectThrows = 0;

    // DETACH-BEFORE-CLOSE, from the other direction: `this.ws` already names
    // the replacement, so every remaining event on the old socket (including
    // the 4004 it is about to send) hits a `this.ws !== socket` guard and is
    // inert.
    if (old) {
      try {
        old.close();
      } catch {
        // ignore
      }
    }

    this.handleMessage(first);
  }

  /** The replacement failed to connect at all, which says the session may be the problem. Distinct from the deadline, which says nothing about it. */
  private failSwap(replacement: WebSocketLike): void {
    if (this.pendingSwap !== replacement) return;
    // NOT `this.session = null` here: the old socket is still open and still
    // serving, and both `frame()`'s `heldRoom` stamp and the own-pid
    // `room-reject` guard read the session in this window. See the flag.
    this.remintOnNextConnect = true;
    this.discardSwap(replacement);
  }

  private discardSwap(only?: WebSocketLike): void {
    const replacement = this.pendingSwap;
    if (replacement === null) return;
    if (only !== undefined && only !== replacement) return;
    this.pendingSwap = null;
    this.swapsFailed++;
    if (this.pendingSwapTimer !== null) {
      clearTimeout(this.pendingSwapTimer);
      this.pendingSwapTimer = null;
    }
    replacement.onopen = null;
    replacement.onclose = null;
    replacement.onmessage = null;
    replacement.onerror = null;
    try {
      replacement.close();
    } catch {
      // ignore
    }
  }

  // ---- message handling ---------------------------------------------------

  private handleMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.handleTextFrame(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.processSnapshot(data);
      return;
    }
    // An ArrayBufferView (a Node `Buffer` is one, and so is whatever a fake in
    // a test hands over): read the VIEW's own window rather than its backing
    // buffer. Node pools small allocations behind one 8KB `ArrayBuffer`, so
    // passing `data.buffer` whole handed the decoder 8192 bytes that are mostly
    // somebody else's, measured as a snapshot of zeros.
    if (data && typeof data === 'object' && 'buffer' in data) {
      const view = data as { buffer: unknown; byteOffset?: unknown; byteLength?: unknown };
      const buf = view.buffer;
      if (!(buf instanceof ArrayBuffer)) return;
      const offset = typeof view.byteOffset === 'number' ? view.byteOffset : 0;
      const length = typeof view.byteLength === 'number' ? view.byteLength : buf.byteLength - offset;
      this.processSnapshot(buf.slice(offset, offset + length));
    }
  }

  private handleTextFrame(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.emit(() => this.opts.onText?.(raw));
      return;
    }

    // The library's own transport frames, consumed here and never handed to
    // `onText`: a host has no opinion about its own round-trip probe, and a
    // relay lifetime cap is this class's business by construction.
    if (isPongFrame(msg)) {
      // A PONG IS MATCHED TO A PING THIS CLIENT SENT, NEVER TRUSTED FROM THE
      // WIRE. `n` and `c` are both attacker-chosen on a socket the client does
      // not control, and `desiredTick()` leans on the result: measured, eight
      // forged pongs stamped with the current clock took an honest 400ms
      // reading to 0, which strips the whole round-trip term out of the
      // stamping lead and puts every input a round trip into the past. The
      // sample is computed from the RECORDED stamp rather than the echoed one,
      // so even a matching `n` cannot smuggle a chosen value in.
      const sentAt = this.outstandingPings.get(msg.n);
      if (sentAt === undefined || sentAt !== msg.c) return;
      this.outstandingPings.delete(msg.n);
      this.observeRtt(now() - sentAt);
      return;
    }
    if (isRelayExpiringFrame(msg)) {
      this.beginWarmSwap(msg.inMs);
      return;
    }

    this.emit(() => this.opts.onText?.(msg));

    if (msg === null || typeof msg !== 'object' || !('t' in msg)) return;
    const t = (msg as { t: unknown }).t;

    if (t === SERVER_FRAMES.roomFull) {
      // AND CLOSE THE SOCKET. The terminal used to latch while the socket
      // stayed live, so a client that had been told the room was full went on
      // receiving and rendering that room's snapshots, with the banner up, for
      // as long as the relay felt like keeping it: measured.
      this.enterTerminal('capacity', 'closed');
      return;
    }
    if (t === SERVER_FRAMES.connLimit) {
      // The same rule as `room-full`, and the two must not diverge: both are a
      // refusal the relay sends just before closing, so both latch and both
      // close. Redundant with `CLOSE_CODES.connLimit` on a relay that sends
      // the pair, and the only cover on one that sends the frame alone.
      this.enterTerminal('conn-limit', 'closed');
      return;
    }
    if (t === ROOM_REJECT_FRAME) {
      // Defence in depth for an older relay that forwards the ticker's raw
      // rejection instead of converting it. A rejection names its subject, and
      // one meant for another player says nothing about this socket.
      const pid = (msg as { pid?: unknown }).pid;
      if (this.session && pid === this.session.playerId) {
        this.enterTerminal('capacity', 'closed');
      }
    }
  }

  private observeRtt(sample: number): void {
    if (!Number.isFinite(sample) || sample < 0) return;
    // `c` came back off the wire, so the ceiling is a trust boundary and not
    // just a sanity check. Nothing above it is a measurement of a path anyone
    // is playing on anyway.
    if (sample > RTT_MAX_SAMPLE_MS) return;
    // A SAMPLE THE LOCAL RENDER LOOP FROZE ACROSS MEASURES US, NOT THE
    // NETWORK. The pong sat in the event loop behind whatever stopped the
    // frames, so the delay it reports is our own queueing; the same gap that
    // unanchors the tick counter disqualifies the sample.
    if (this.lastFrameAt !== null && now() - this.lastFrameAt > this.frozenFrameGapMs) return;
    this.rttSamples.push(sample);
    if (this.rttSamples.length > RTT_WINDOW) this.rttSamples.shift();

    // THE FIRST ANCHOR OF AN EPOCH IS TAKEN BEFORE THE FIRST PONG EXISTS, so
    // it is computed with `rttMs()` reading 0 and is therefore short by the
    // whole round trip; and because anchoring sets `lastReanchorAt`, the
    // tolerance path then refuses to correct it for `REANCHOR_MIN_INTERVAL_MS`.
    // Measured end to end at 250ms RTT: `tick.value - desiredTick()` sat
    // between -5.2 and -5.8 for 2.2 seconds, the server counted 40 late inputs
    // in the first three seconds, and the correction that eventually came
    // overshot (+6, +3, then -3 at 8.65s). It reproduced in the FIRST EPOCH OF
    // EVERY RUN, which is every reconnect of every session.
    //
    // So an anchor is provisional with respect to the round trip it assumed:
    // once a sample arrives that disagrees with that assumption by a whole
    // tick, the rate limit is dropped and the very next snapshot re-anchors
    // through the ordinary tolerance path, with an ordinary `onTickReanchor`.
    if (Math.abs(this.rttMs() - this.anchorRttMs) >= this.tickMs) {
      this.lastReanchorAt = Number.NEGATIVE_INFINITY;
    }
  }

  private processSnapshot(buf: ArrayBuffer): void {
    if (this.versionSkewStopped) return;

    let decoded: TSnap | null;
    try {
      decoded = this.opts.decodeSnapshot(buf);
    } catch (err) {
      // SKEW RECOVERY OFF A THROW, NOT ONLY OFF A RETURNED VERSION. The check
      // below needs a decoder that DECODES a frame it does not understand and
      // reports the version in the result; this repo's own codecs throw
      // instead, which this catch used to swallow. A deploy that bumped the
      // wire therefore left every old client silently dropping every frame with
      // nothing reloading and nothing latching. Duck-typed on the name so a
      // host's own codec can participate without importing anything.
      if (err instanceof Error && err.name === 'ProtocolVersionError') {
        this.handleVersionSkew();
        return;
      }
      decoded = null;
    }
    if (!decoded) return;

    if (
      this.opts.protocolVersion !== undefined &&
      decoded.version !== undefined &&
      decoded.version !== this.opts.protocolVersion
    ) {
      this.handleVersionSkew();
      return;
    }

    // THE SAME TRUST BOUNDARY `SnapshotInterpolator.push()` APPLIES, AND FOR
    // THE SAME REASON: these fields are typed `number` and they arrive out of a
    // decoder the HOST owns, so the type is a compile-time claim about a
    // runtime value. ONE frame with an undefined `serverTime` used to poison
    // the clock permanently, because an EMA can never leave NaN: measured, the
    // offset went NaN, `estimateServerTick()` went NaN with it for the rest of
    // the connection, `shouldReanchor` could never fire again (every comparison
    // against NaN is false), and after the next reconnect `tick.value` was NaN
    // with `initialized` true, so every stamped input carried NaN. Refused
    // before ANY accumulator sees it.
    if (!Number.isFinite(decoded.serverTime) || !Number.isFinite(decoded.tick)) {
      this.rejectedSnapshots++;
      return;
    }

    // FINITE IS NOT THE SAME AS PLAUSIBLE, the lesson `SnapshotInterpolator`
    // learned one door along. A frame stamped a year in the past is a perfectly
    // finite number: measured, one of them put `estimateServerTick()` at 6.3e8,
    // and arriving as the first frame after a frozen-render unanchor it
    // ANCHORED the counter to 1e12 and handed the host an `onTickReanchor`
    // delta of 1e12 to fold into its prediction. Both bounds are only ever
    // checked once the clock is seeded, because the first frame of an epoch is
    // what everything else is judged against.
    //
    // AND NEITHER REFUSAL MAY BE PERMANENT, which is the other half of that
    // lesson: the reference both bounds are judged against is one this class
    // computed for itself, so a reference that is wrong refuses every frame
    // forever. A run past `SNAPSHOT_IMPLAUSIBLE_REFUSALS` is therefore adopted.
    //
    // THE ESCAPE RE-ARMS AT THE ADOPTION POINT, and leaving it latched was a
    // hole big enough to drive the whole trust boundary through. The counter
    // was cleared only by a PLAUSIBLE frame, so once a run had opened the gate
    // it stayed open: measured on 100 frames each stamped a random +-2e8ms
    // away, 3 were refused and 97 were ADOPTED, which put
    // `estimateServerTick()` at 5.6e6, `tick.value` at -542716 and handed the
    // host an `onTickReanchor` delta of 3,432,713 (and a negative stamp is an
    // input the server can never place). Re-armed, a genuine sustained step
    // costs three refusals and one adoption per run of four until the clock
    // re-seeds, about a second, while noise never gets through for free. Same
    // shape as `refuseSteppedFrame`'s own re-arm in the interpolator.
    if (this.serverClockSeeded) {
      const timeOff = Math.abs(decoded.serverTime - this.serverNow()) > SNAPSHOT_TIME_PLAUSIBLE_MS;
      const tickOff = Math.abs(decoded.tick - this.lastSnapTick) > SNAPSHOT_TICK_JUMP_MAX;
      if (timeOff || tickOff) {
        this.implausibleRun++;
        if (this.implausibleRun <= SNAPSHOT_IMPLAUSIBLE_REFUSALS) {
          this.rejectedSnapshots++;
          return;
        }
      }
      this.implausibleRun = 0;
    }

    const t = now();
    this.snapshotsReceived++;

    if (this.lastArrivalAt !== null) {
      const gap = t - this.lastArrivalAt;
      this.arrivalGaps.push(gap);
      if (this.arrivalGaps.length > ARRIVAL_GAP_RING_CAP) this.arrivalGaps.shift();

      const missed = gap > this.tickMs * UNDERRUN_GAP_FACTOR ? 1 : 0;
      const ease = 1 - Math.exp(-gap / UNDERRUN_EMA_TAU_MS);
      this.underrunEma += (missed - this.underrunEma) * ease;
    }
    this.lastArrivalAt = t;
    this.lastSnapAt = t;
    this.epochDelivered = true;
    this.authCloses = 0;

    this.observeTickRate(decoded.tick, decoded.serverTime);
    this.observeServerClock(t, decoded.serverTime);
    this.lastSnapTick = decoded.tick;
    this.lastSnapServerTime = decoded.serverTime;

    const desired = this.desiredTick();
    const shouldAnchor =
      !this.clock.anchored ||
      shouldReanchor({
        anchored: this.clock.anchored,
        initialized: this.clock.initialized,
        // A STALL IS NOT DRIFT. The counter only moves in `frame()`, so a
        // main-thread hitch of 100 to 300ms (a GC pause, one heavy frame,
        // anything under the frozen threshold) leaves it sitting where the
        // last frame put it while `desired` keeps running on the server
        // clock. Compared raw, that read as a +2 to +5 drift, re-anchored
        // spuriously, and re-anchored BACK about two seconds later once
        // the resume frame had stamped the stall's ticks, and every
        // consumer's prediction ate both. The decision is made against the
        // counter PROJECTED by the time since the last frame instead, which
        // is exactly what the resume frame will add.
        clientTick: this.projectedTick(t),
        desiredTick: desired,
        now: t,
        lastReanchorAt: this.lastReanchorAt,
        // While the step escape is deciding whether the offset belongs to a
        // timeline that still exists, `desired` is built on the estimate this
        // class has already stopped believing. See the gate in `netPolicy.ts`.
        clockStepping: this.clockStepSince !== 0,
      });
    if (shouldAnchor) {
      // The very first anchor of this connection's LIFETIME is not a
      // correction: nothing has been rendered against the counter yet, so
      // there is nothing for a host to smooth and firing the callback would
      // hand it a delta measured from a counter that meant nothing.
      const wasInitialized = this.clock.initialized;
      const delta = this.clock.anchorTo(desired);
      this.lastReanchorAt = t;
      this.anchorRttMs = this.rttMs();
      if (wasInitialized) this.emit(() => this.opts.onTickReanchor?.(delta));
    }

    this.observeInputLead(t, decoded.inputLead);

    // BEFORE `onSnapshot`, deliberately, and the ordering is kept even now
    // that the callback is wrapped. `emit()` stops a throw from unwinding this
    // class, and pushing first means the frame is already in the buffer when
    // the host runs, so a host callback that throws costs one callback rather
    // than also starving playback of every frame after it. Two independent
    // defences rather than one standing behind the other.
    //
    // `receivedAt` is `t`, the same reading `frame()` measures its own delta
    // from and passes to `sample()`, so the two clocks the offset estimate
    // differences are one clock by construction rather than by a caller
    // remembering to use `performance.now()` in both places.
    // `entities()` IS A HOST CALLBACK TOO, and it was the one call out of this
    // class that ran bare. A throw in it escaped `onmessage`, which cost the
    // push AND `onSnapshot` (the frame was already counted on
    // `snapshotsReceived`, so the loss did not even show up as a dropped
    // frame). It is guarded separately rather than through `emit()` because
    // this one has a RETURN VALUE: a throw has to skip the push specifically,
    // and everything after it still has to happen.
    const interpolate = this.opts.interpolate;
    if (interpolate) {
      let entities: Map<K, EntitySample> | null = null;
      try {
        entities = interpolate.entities(decoded);
      } catch {
        this.hostErrors++;
      }
      if (entities !== null) {
        interpolate.into.push({ receivedAt: t, serverTime: decoded.serverTime, entities });
      }
    }

    const snap = decoded;
    this.emit(() => this.opts.onSnapshot?.(snap));
  }

  /**
   * A MISMATCHED `tickHz` IS OTHERWISE COMPLETELY SILENT, which is what this
   * exists for. `tickHz` is REQUIRED precisely because a default was a silent
   * 2x error, and requiring it only moved the failure: a host that writes 10
   * for a room running at 20 gets no error, no stall, and clean stats, while
   * every derived quantity in the class runs at half basis. The only tells
   * were `onTickReanchor` firing a same-signed delta every couple of seconds
   * and the server's playout depth pinned at 0, neither of which reads as
   * "your tickHz is wrong" to anybody.
   *
   * The server tells us its rate on every pair of snapshots, so this measures
   * it and says so. It changes NOTHING else: the counter, the lead and the
   * clock all still run on the configured rate, because a class that quietly
   * adopted a measured rate would be back to guessing a number the host is
   * supposed to know, and the fix for a wrong constant is telling the host,
   * not working around them.
   */
  private observeTickRate(tick: number, serverTime: number): void {
    const dTick = tick - this.lastSnapTick;
    const dMs = serverTime - this.lastSnapServerTime;
    // Only forward, in-order pairs measure anything: a duplicate, a reorder or
    // an adopted timeline restart is not a rate.
    if (!this.serverClockSeeded || dTick <= 0 || dMs <= 0) return;

    this.tickRateSamples.push((1000 * dTick) / dMs);
    if (this.tickRateSamples.length > TICK_RATE_WINDOW) this.tickRateSamples.shift();
    if (this.tickRateSamples.length < 3) return;

    const measured = this.serverTickHz();
    const configured = 1000 / this.tickMs;
    if (Math.abs(measured - configured) / configured > TICK_RATE_TOLERANCE) {
      this.tickRateMismatchRun++;
    } else {
      this.tickRateMismatchRun = 0;
      return;
    }

    if (this.tickRateMismatchRun < TICK_RATE_MISMATCH_RUN || this.tickRateReported) return;
    this.tickRateReported = true;
    this.emit(() => this.opts.onTickRateMismatch?.(measured));
  }

  /**
   * Track `localNow - serverTime` as a slew-capped sliding-window MINIMUM, the
   * same estimator and the same reasoning as `SnapshotInterpolator`'s own
   * offset floor: every sample is the true offset plus that packet's one-way
   * delay, delay is non-negative, so the smallest sample in the window is the
   * least contaminated estimate available and the mean is guaranteed to be
   * wrong by the average congestion.
   *
   * The EMA it replaces was wrong twice over. It averaged in the delay, and it
   * differenced against `Date.now()` while everything else here runs on
   * `performance.now()`.
   */
  private observeServerClock(localNow: number, serverTime: number): void {
    const sample = localNow - serverTime;

    if (!this.serverClockSeeded) {
      this.clockOffsets = [sample];
      this.serverClockOffset = sample;
      this.serverClockSeeded = true;
      this.lastClockSampleAt = localNow;
      return;
    }

    // A SLOW ESTIMATE NEEDS AN ESCAPE HATCH, and this is the third place in
    // this library that has needed the same one. A sliding minimum under a 5%
    // slew is right for noise and wrong for a STEP: a route change adds a fixed
    // one-way delay, and a ticker handoff lands on a machine whose `Date.now()`
    // is its own, either of which moves the true offset in one jump that the
    // window cannot turn over for seconds and the slew cannot cross for tens of
    // seconds. So a run of samples that ALL disagree with the estimate by more
    // than a tick, for longer than `SERVER_CLOCK_STEP_MS`, with at least
    // `SERVER_CLOCK_STEP_SAMPLES` of them, is treated as a new timeline and
    // becomes the window outright. The sample count is the safety: an outage
    // produces the same disagreement with nothing to re-seed from.
    if (Math.abs(sample - this.serverClockOffset) > this.tickMs) {
      if (this.clockStepSince === 0) this.clockStepSince = localNow;
      this.clockStepSamples.push(sample);
      if (this.clockStepSamples.length > SERVER_CLOCK_WINDOW) this.clockStepSamples.shift();
      if (
        localNow - this.clockStepSince > SERVER_CLOCK_STEP_MS &&
        this.clockStepSamples.length >= SERVER_CLOCK_STEP_SAMPLES
      ) {
        this.clockOffsets = this.clockStepSamples.slice();
        this.serverClockOffset = Math.min(...this.clockOffsets);
        this.clockStepSince = 0;
        this.clockStepSamples = [];
        this.lastClockSampleAt = localNow;
        return;
      }
    } else {
      this.clockStepSince = 0;
      this.clockStepSamples.length = 0;
    }

    this.clockOffsets.push(sample);
    if (this.clockOffsets.length > SERVER_CLOCK_WINDOW) this.clockOffsets.shift();

    const floor = Math.min(...this.clockOffsets);
    const elapsed = Math.max(0, localNow - this.lastClockSampleAt);
    this.lastClockSampleAt = localNow;
    const maxSlew = elapsed * SERVER_CLOCK_SLEW_MAX;
    const delta = floor - this.serverClockOffset;
    this.serverClockOffset += Math.max(-maxSlew, Math.min(maxSlew, delta));
  }

  /**
   * The optional feedback half of the stamping lead. `rttMs + inputLeadMs` is
   * an OPEN loop: it is a good guess at how much lead an input needs, made
   * entirely from measurements taken on this side of the wire. When the host
   * echoes back what the server's playout buffer actually saw, the loop closes
   * and the lead converges on the smallest one that keeps the buffer fed, which
   * is the smallest input latency this player can have.
   *
   * Deliberately slow and deliberately coarse: at most two ticks of correction
   * per `REANCHOR_MIN_INTERVAL_MS`, and only when the depth is at least two
   * ticks off target, because the thing being controlled is the input latency
   * every action in the game passes through and a twitchy controller is worse
   * than a slightly wrong constant.
   *
   * THE DEADBAND EQUALS THE TARGET, AND A ONE-TICK BAND WAS TRIED AND MEASURED.
   * With the band at one tick a buffer one tick deep is lifted, which sounds
   * right (one tick of cushion is one late packet from a starve), and on a real
   * deployment it made things worse: re-anchors went from 1 per client per
   * three minutes to 4, 6 and 8, and starves went UP from 31 to 44, because
   * every correction clears the client's stamped window and the loop then hunts
   * between depths of one and three. The cushion a host wants by default is
   * set with `inputLeadMs`, not by making this loop nervous.
   */
  private observeInputLead(nowMs: number, inputLead: number | undefined): void {
    if (typeof inputLead !== 'number' || !Number.isFinite(inputLead)) return;

    if (!this.depthSeeded) {
      this.depthEma = inputLead;
      this.depthSeeded = true;
      // Start the clock here rather than at the epoch, so the first correction
      // is made from an EMA with some history in it instead of from one sample.
      this.lastFeedbackAt = nowMs;
      return;
    }
    this.depthEma += (inputLead - this.depthEma) * DEPTH_EMA_ALPHA;

    if (nowMs - this.lastFeedbackAt < REANCHOR_MIN_INTERVAL_MS) return;
    this.lastFeedbackAt = nowMs;

    const error = TARGET_DEPTH_TICKS - this.depthEma;
    if (Math.abs(error) < TARGET_DEPTH_TICKS) return;
    const step = Math.max(-2, Math.min(2, Math.round(error)));
    const lowest = -this.leadTicks;
    const highest = PLAYOUT_MAX_AHEAD / 2 - this.leadTicks;
    this.feedbackTicks = Math.max(lowest, Math.min(highest, this.feedbackTicks + step));
    // `shouldReanchor`'s tolerance path applies the change on the next
    // snapshot, so the correction arrives as one ordinary re-anchor with an
    // `onTickReanchor` delta rather than as a silent drift.
  }

  private handleVersionSkew(): void {
    let recentlyReloaded = false;
    const hasStorage = typeof sessionStorage !== 'undefined';
    if (hasStorage) {
      try {
        const raw = sessionStorage.getItem(RELOAD_STORAGE_KEY);
        const last = raw ? Number(raw) : 0;
        recentlyReloaded = last > 0 && Date.now() - last < RELOAD_WINDOW_MS;
      } catch {
        recentlyReloaded = false;
      }
    }

    if (!recentlyReloaded) {
      if (hasStorage) {
        try {
          sessionStorage.setItem(RELOAD_STORAGE_KEY, String(Date.now()));
        } catch {
          // Storage denied (private browsing, quota): fall through to the
          // terminal path below rather than looping reload attempts.
        }
      }
      if (typeof location !== 'undefined' && typeof location.reload === 'function') {
        try {
          location.reload();
          return; // navigating away; nothing past this point matters
        } catch {
          // fall through
        }
      }
    }

    // Either we already reloaded once this window (a server that keeps
    // outrunning the client must not loop reloads forever), or there is no
    // `location` to reload at all (this class running outside a browser tab).
    this.versionSkewStopped = true;
    this.enterTerminal('version-skew', 'closed');
  }
}
