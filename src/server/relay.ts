import { randomUUID } from 'node:crypto';
import {
  type RedisLike,
  roomKeys,
  DEFAULT_NAMESPACE,
  shouldSpawnTicker,
  TokenBucket,
  type RoomEnvelope,
  type ClientInput,
  type Logger,
  CLOSE_CODES,
  SERVER_FRAMES,
  ROOM_REJECT_FRAME,
  PING_FRAME_PREFIX,
  RELAY_EXPIRY_LEAD_MS,
  JOIN_HEARTBEAT_MS,
  encodePong,
} from '../core/index.js';
import type { Subscriber } from './redis.js';

/**
 * The relay: one of these per socket, dumb by design. It knows nothing
 * about the simulation, only how to turn a socket's frames into `RoomEnvelope`s
 * on `keys.in` and turn `keys.out`/`keys.metaout` traffic back into frames.
 * All game logic lives in `RoomRuntime`, run by the ticker; this file exists
 * so a serverless function that can hold ONE socket open can still be part
 * of a room shared by twenty players, without ever becoming the thing that
 * decides what happens in that room.
 *
 * The one exception to "dumb" is the control plane in `core/wire.ts`, which
 * this file both speaks and CONSUMES: a `room-reject` aimed at this socket's
 * own pid ends the socket here rather than being forwarded to a client that
 * would not know what to do with it, and a client `ping` is answered from
 * here without a Redis round trip. Both are frames the LIBRARY owns on both
 * ends, never the host's own traffic.
 */

// The WebSocket standard's `readyState` numbering, which both browsers and
// the `ws` package use verbatim. Named so the state checks below read as
// states rather than as magic numbers.
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/** How many control frames to hold for a socket that is not open yet. One-shot frames, so the NEWEST are the ones worth keeping. */
const CONTROL_QUEUE_MAX = 8;

/** Consecutive throwing sends before the socket is treated as gone. Three is a run rather than a coincidence, and still well inside one heartbeat at any real snapshot rate. */
const SEND_FAILURE_LIMIT = 3;

/**
 * Every `t` this library defines for a server-to-client frame, and the subset
 * of them that is legitimately a BROADCAST.
 *
 * The allowlist is the broadcast one, which is the direction that fails safe:
 * a frame this library does not own is forwarded (the roster channel is a
 * host's own control seam and always has been), and a frame it DOES own that
 * is not on the broadcast list is dropped. So a per-socket frame added to
 * `SERVER_FRAMES` later is refused by default rather than reaching every
 * client in the room, and a new broadcast frame is one line here.
 */
const LIBRARY_FRAMES = new Set<string>(Object.values(SERVER_FRAMES));
const BROADCAST_FRAMES = new Set<string>([SERVER_FRAMES.meta]);

/**
 * How many probes may go unanswered before the subscriber is declared dead.
 * Three, so a single dropped delivery (or a probe published into a
 * momentarily unreachable Redis) is never enough on its own, and paced by the
 * HEARTBEAT rather than by a knob of its own: the heartbeat is already the
 * one cadence in this file the client cannot influence, and giving liveness a
 * second, independent period is how `ticker.ts` ended up with a deadline
 * derived from a metrics setting.
 */
const PROBE_MISS_LIMIT = 3;

/**
 * The bus-arrival gap, and the arrival-to-send lag, that are worth ONE line a
 * window.
 *
 * A relay sees both halves of the one question a client's own gap measurement
 * cannot answer. A client that reports a 300ms hole between snapshots knows
 * only that it appeared somewhere between the ticker and its own `onmessage`;
 * this file is the single point that sees a snapshot ARRIVE on its subscriber
 * and sees its `send` return, so it is the only place that can say whether
 * the snapshot came late (the ticker, the bus, or this function being paused
 * by the platform) or came on time and then took that long to leave (the
 * socket path).
 *
 * 150ms is three missed publishes at the shipped 50ms tick and nine at 60Hz,
 * so it is far past the jitter an ordinary event loop produces and is also
 * about where the client's own playout buffer starts running dry. 50ms for
 * the send side because `socket.send` is supposed to be a memcpy onto the
 * transport's queue: a tick's worth of time inside one is the event loop or
 * the transport, never the wire.
 */
const BUS_GAP_REPORT_MS = 150;
const SEND_LAG_REPORT_MS = 50;

/**
 * The structural minimum a socket needs to expose. Its `readyState` numbers
 * deliberately mirror the WebSocket standard (0 CONNECTING, 1 OPEN, 2
 * CLOSING, 3 CLOSED), the same numbering both browsers and the `ws` package
 * use, so a real adapter needs no translation layer at all.
 */
export interface RelaySocket {
  readonly readyState: number;
  /**
   * Bytes the transport has accepted but not yet written to the wire. Both
   * browsers and `ws` expose it, so no adapter has to grow a field for it,
   * and it is the ONLY signal a relay gets that a socket is falling behind
   * the snapshot stream. See the snapshot forward in `attachRelay` for what
   * an unbounded queue on top of a deliberately lossy bus actually costs.
   * Optional, because a hand-rolled transport need not report it; a socket
   * that does not is forwarded to unconditionally, exactly as before.
   */
  readonly bufferedAmount?: number | undefined;
  send(data: string | Uint8Array | Buffer): void;
  close(code?: number, reason?: string): void;
  /** Force-closes without a handshake. See the liveness section below for why this, not `close`, is what a silent socket gets. */
  terminate?: (() => void) | undefined;
  ping?: (() => void) | undefined;
  /**
   * `'open'` is in the union for the CONNECTING case only. A socket handed
   * to `attachRelay` is usually already OPEN, but an upgrade callback can
   * fire while the handshake is still completing (see the state check at the
   * top of `attachRelay`), and on that transport `'open'` is the event that
   * says the wire is finally usable. A transport whose sockets are always
   * open by the time the callback runs never emits it and never has to.
   */
  on(ev: 'message' | 'close' | 'error' | 'pong' | 'open', cb: (...args: unknown[]) => void): void;
}

export interface RelayOptions {
  socket: RelaySocket;
  /** The shared command client (publishes join/leave/input, reads no state itself). */
  redis: RedisLike;
  /** Builds this socket's own dedicated subscriber for `keys.out`/`keys.metaout`. */
  createSubscriber(): Subscriber;
  roomId: string;
  pid: string;
  namespace?: string | undefined;
  /** Sent once (and re-sent as the join heartbeat) on the `join` envelope. */
  joinMeta?: Record<string, unknown> | undefined;
  /**
   * Formats the roster frame this relay seeds a joining socket with.
   * Defaults to today's `{ t: 'meta', seed: true, map }`.
   *
   * This exists because the seed frame is a CLIENT-VISIBLE WIRE SHAPE, and
   * unlike a snapshot it carries no version byte, so a host adopting this
   * library cannot use a protocol bump to force already-loaded bundles onto
   * the new shape. A client that parses its own established roster format
   * typically early-returns on anything it does not recognise, which is
   * SILENT: no throw, no console error, just an empty roster (no names, no
   * presence count, no join/leave notifications) for every player, and no
   * gate anywhere that fails on it. Letting the host keep its existing
   * shape is what makes adopting the relay a deploy rather than a
   * coordinated client-and-server migration measured in days.
   *
   * Pair it with the ticker's `metaPayload` formatter: this one shapes the
   * SEED a socket gets on connect, that one shapes the BROADCAST every
   * socket gets on a roster change. A host that overrides one and forgets
   * the other ships two different shapes down the same channel.
   *
   * Returning a value that does not serialise (`undefined`) suppresses the
   * seed frame entirely rather than sending the string "undefined".
   */
  metaSeedPayload?: ((map: Record<string, unknown>) => unknown) | undefined;
  /**
   * Turns one inbound frame into zero or more inputs. Throwing or
   * returning `[]` rejects the frame silently (it is still counted toward
   * liveness).
   *
   * The parameter is `unknown`, not `ArrayBuffer`, and that is not a
   * placeholder: what actually arrives here depends entirely on the
   * host's transport, which this library never controls. A browser's own
   * WebSocket hands a plain `addEventListener('message')` handler an
   * `ArrayBuffer` (for a binary frame), but the `ws` package, the actual
   * transport behind both shipped adapters (`adapters/vercel.ts` and
   * `adapters/node.ts`), hands its `'message'` listener a `Buffer`, or an
   * array of `Buffer`s for a fragmented message. Declaring `ArrayBuffer`
   * here would be a lie about what a host actually receives on the one
   * transport this library ships adapters for, so the host is
   * responsible for normalising `data` into whatever shape its own
   * decoder expects before decoding it.
   *
   * A client `ping` (see `CLIENT_FRAMES` in `core/wire.ts`) never reaches
   * this function: the relay answers it directly, before any decode work is
   * paid for. The library owns the `t` key on a text frame, so a host input
   * frame must not begin `{"t":"ping"`.
   */
  decodeInput(data: unknown): ClientInput[];
  /**
   * Starts a ticker for this room. Must carry a spawn token; see `session.ts`.
   *
   * A SPAWN IS A DELIVERY, NOT A CONVERSATION: this must resolve once the
   * request has been DELIVERED, and reject only when it never left. A host
   * whose spawn is an HTTP call to a ticker route must not wait for the
   * response, because that route does not answer until the ticker it started
   * exits, minutes later; see `SPAWN_ACK_MS` in `adapters/vercel.ts`. The
   * rejection this contract buys is the only one worth an error line, which is
   * what `ensureTicker` below logs.
   */
  spawnTicker(roomId: string): Promise<unknown>;
  /** How often the join heartbeat republishes and the liveness/ping check runs. Defaults to `JOIN_HEARTBEAT_MS`, which is also the unit the ticker's `presenceTimeoutMs` is counted in; lowering it here means raising that there. */
  heartbeatMs?: number | undefined;
  /** Base interval between "does this room have a ticker" checks. Default 1000ms. */
  tickerCheckMs?: number | undefined;
  /** Random jitter added to each ticker-check interval. Default 1000ms. See the scheduling comment below for why this matters more than the base interval. */
  tickerCheckJitterMs?: number | undefined;
  /**
   * How long this relay refuses to fire a SECOND spawn after firing one.
   * Default 5000ms.
   *
   * The ticker-check poll below reads the lease and spawns when it is null,
   * and a ticker cold start is longer than the poll period, so without this
   * every poll inside that start window fires another invocation: measured
   * at 41 invocations from 20 sockets during ONE 2.5s cold start, all but
   * the first of which exist only to lose the acquire race. The poll itself
   * keeps running throughout (it is the backstop that recovers a room whose
   * spawn genuinely never landed); what the hold-off bounds is how often a
   * single relay is willing to PAY for one. A poll that reads a live lease
   * clears it early, so a real gap after a healthy period is acted on at
   * once rather than waiting out a window that is no longer about anything.
   */
  spawnHoldoffMs?: number | undefined;
  /**
   * How long with no inbound frame at all before the socket is presumed dead.
   * Defaults to `DEFAULT_LIVENESS_TIMEOUT_MS` (90000ms).
   *
   * IT MUST STAY ABOVE 60 SECONDS FOR ANY BROWSER CLIENT, and the old 45000
   * default was a guaranteed reap rather than a tunable. Chromium throttles
   * `setInterval` in a tab hidden for more than five minutes to ONCE A
   * MINUTE, so a client pinging on `PING_INTERVAL_MS` (2000) sends one frame
   * every 60s, and `requestAnimationFrame` stops entirely, which takes
   * `frame()` and any input with it. At 45000 the deadline lands squarely
   * between two of those throttled pings: every backgrounded tab past five
   * minutes is reaped mid-session, on a socket that is perfectly healthy and
   * whose player is one tab-switch from coming back. 90000 clears one
   * throttled interval with half of another as slack.
   *
   * The WebSocket-level pong is what covers this in principle (a browser's
   * network stack answers below page JavaScript, throttled timers and all),
   * and it is not something this library can rely on: `RelaySocket.ping` is
   * optional, and a transport that lacks it, or a proxy that declines to
   * forward ping frames, silently leaves inbound recency as the only
   * evidence. See `relay.no-ping` and `RelayHandle.transportPings`.
   */
  livenessTimeoutMs?: number | undefined;
  /**
   * How long to wait for the subscriber's SUBSCRIBE to be acknowledged
   * before giving up on this socket. Default 5000ms.
   *
   * A subscribe that never resolves is not a slow socket, it is a DEAF one:
   * the client sits on an open connection receiving no snapshots and no
   * roster, with every other signal (the socket, the join heartbeat, the
   * room's stats key) reading healthy, so nothing on either end has a reason
   * to act. Closing with `CLOSE_CODES.relayUnavailable` instead hands the
   * problem to the client's ordinary reconnect ladder, which lands on a
   * fresh relay with a fresh subscriber.
   */
  subscribeTimeoutMs?: number | undefined;
  /**
   * Drop a snapshot when the socket has more than this many bytes already
   * queued in the transport. Default 32768.
   *
   * THE SNAPSHOT FORWARD IS THE ONE PLACE THIS LIBRARY CAN TURN A LOSSY BUS
   * INTO A RELIABLE UNBOUNDED QUEUE, and doing so is strictly worse than
   * dropping. Redis pub/sub already drops a message with no subscriber, the
   * client's interpolator is built to survive gaps, and the input redundancy
   * window exists because packet loss is ordinary. Forwarding regardless
   * gives a paused or backpressured socket a queue that grows without limit
   * (measured at 7.65MB for one paused socket) and then replays it as a
   * stale burst the moment the socket drains: the client is handed several
   * seconds of the past at once, which is the worst possible thing to do to
   * a jitter buffer. The newest snapshot supersedes every older one, so a
   * dropped frame costs nothing that the next tick does not repair.
   *
   * Control frames on `metaout` are NOT subject to this: they are one-shot
   * (a roster change is announced exactly once) and nothing later repeats
   * them, so dropping one is permanent where dropping a snapshot is not.
   */
  snapshotBacklogBytes?: number | undefined;
  /**
   * When set, this relay closes itself after `lifetimeMs`, announcing it
   * `RELAY_EXPIRY_LEAD_MS` ahead with a `relay-expiring` frame.
   *
   * A serverless host kills the function at its own duration cap with no
   * warning to anyone, which arrives at the client as a socket that simply
   * dies. Announcing the end first lets the client open a replacement socket
   * and swap to it once it delivers, so the platform's cap costs no visible
   * gap; the relay's lifetime is a separate thing from the ticker's, so
   * nothing about the room pauses while it happens. Set it comfortably below
   * the platform's real cap, since the announcement is only useful while the
   * function is still alive to send it.
   */
  lifetimeMs?: number | undefined;
  /**
   * Inbound token-bucket capacity, in frames. Default 100.
   *
   * This is a flood guard, not a pacing device, but it has to clear the
   * pacing the shipped client actually does: one packet per stamped tick, so
   * a room ticking up to 60Hz (the fastest this library documents as
   * reasonable) sends up to 60 packets/s of ordinary traffic. 100 clears
   * that with headroom for a burst; a flood is hundreds to thousands of
   * packets a second and still empties this bucket in well under a second. A
   * host running ticks above 60Hz must raise this alongside
   * `inboundRefillPerSecond` or its own well-behaved clients get throttled.
   */
  inboundCapacity?: number | undefined;
  /**
   * Inbound token-bucket refill rate, in frames/s. Default 70.
   *
   * Set above the fastest tick rate this library documents as reasonable
   * (60Hz, one packet per stamped tick) so a steady sender at that cadence
   * never drains the bucket. A flood, hundreds to thousands of packets a
   * second, is still refused within about two seconds at this rate. A host
   * running ticks above 60Hz must raise this alongside `inboundCapacity`.
   */
  inboundRefillPerSecond?: number | undefined;
  log?: Logger | undefined;
  onClose?: ((code: number) => void) | undefined;

  // --- observability seams ---
  //
  // The four hooks below are the ONLY way a host can see the abuse path
  // the rate limiter and the decoder exist for, plus the one liveness event
  // that shares this same shape. Without them the relay is silent by design
  // on exactly the events worth watching: the bucket rejects a frame BEFORE
  // `decodeInput` ever runs, and a decoder that throws is swallowed by a
  // bare catch, so neither reaches the host's own log (correctly, see
  // below) unless it reads one of these.
  //
  // THEY MUST BE CHEAP AND SYNCHRONOUS, and this is a real constraint, not
  // style advice. Each fires on a path whose rate a client controls, so the
  // library's own invariant applies to whatever the host does inside them:
  // count in process, flush on a cadence the client cannot drive. A hook
  // that writes to Redis, or logs a line, turns a REFUSED frame into
  // something more expensive than an accepted one, which makes the rate
  // limiter an amplifier and hands an abuser the very lever it exists to
  // take away. A throw out of one is caught and ignored here, so a buggy
  // host hook can never take the socket down; it cannot be reported either,
  // for the same per-message reason.

  /** Fires when the inbound token bucket rejects a frame. Count it; never log or persist per call. */
  onRateDrop?: (() => void) | undefined;
  /** Fires when `decodeInput` THROWS. A decoder returning `[]` is a legitimate empty window, not bad input, and does not fire this. Count it; never log or persist per call. */
  onBadInput?: (() => void) | undefined;
  /**
   * Fires alongside the `relay.liveness-drop` log line, every heartbeat
   * that finds the socket still silent past `livenessTimeoutMs` and calls
   * `terminate()` on it. Count it; never log or persist per call. Unlike
   * the two hooks above, a client cannot drive this one's rate, and on a
   * real transport it normally fires exactly once (`terminate()` emits a
   * 'close' event that stops the heartbeat loop before the next tick), but
   * nothing here assumes that: the relay runs its own `cleanup` right after
   * terminating for exactly that reason. It is guarded the same way as the
   * two above for the same reason: a throwing host hook must never be able
   * to stop the termination it is only supposed to be observing.
   */
  onLivenessDrop?: (() => void) | undefined;
  /** Fires when a JOIN or INPUT publish to `keys.in` fails, the latter being the client-rate path. Count it; never log or persist per call. The library itself logs these COALESCED on the heartbeat, see `flushPublishFailures`. The `leave` publish in cleanup is deliberately not included: it is best-effort teardown, fires once, and there is nothing left to observe it by then. */
  onPublishFailed?: ((error: unknown) => void) | undefined;
}

/**
 * Every `RelayOptions` field a HOST supplies, i.e. the whole option set minus
 * the six the transport layer fills in per socket. `admitSocket` takes one of
 * these and forwards it wholesale, so a new relay option (an observability
 * hook, `lifetimeMs`, a bound) is reachable through every adapter the moment
 * it exists here, with no per-field copying to keep in step. Copying was the
 * previous shape and it drifted: three hosts, three subsets of the options.
 */
export type HostRelayOptions = Omit<RelayOptions, 'socket' | 'redis' | 'createSubscriber' | 'roomId' | 'pid' | 'namespace'>;

/**
 * The default liveness deadline, exported because its value is an ARGUMENT
 * rather than a preference: it has to clear one Chromium-throttled client
 * ping interval (60s for a tab hidden past five minutes, whatever
 * `PING_INTERVAL_MS` says) with slack. A host lowering it below that is
 * choosing to reap backgrounded tabs, and a test asserting the relationship
 * should read the real number.
 */
export const DEFAULT_LIVENESS_TIMEOUT_MS = 90_000;

/**
 * What this socket's snapshot timing looked like over the window IN PROGRESS,
 * in milliseconds, plus how long the socket has been attached.
 *
 * `busGapOver150` carries its threshold in its NAME on purpose: it is the
 * field name on the `relay.gaps` line too, and a dashboard reading a count
 * whose meaning moves when `BUS_GAP_REPORT_MS` is retuned is worse than one
 * that visibly stops matching.
 *
 * A gap is the distance between two arrivals on this relay's own subscriber,
 * so a socket's FIRST snapshot has no gap to measure and contributes nothing:
 * counting the socket's age as its first gap would report a hole on every
 * connect.
 */
export interface RelayGapsSample {
  busGapMax: number;
  busGapOver150: number;
  sendLagMax: number;
  socketAgeMs: number;
}

export interface RelayHandle {
  close(code?: number): void;
  /**
   * This socket's snapshot timing for the window in progress. The heartbeat's
   * flush RESETS that window (it is the cadence `relay.gaps` is emitted on,
   * and the one cadence the client cannot drive), so a host polling this on
   * its own schedule reads what has accumulated since the last beat rather
   * than the socket's lifetime worst.
   */
  gapsSample(): RelayGapsSample;
  /**
   * Whether the transport exposed a `ping()` for this socket.
   *
   * FALSE MEANS LIVENESS HAS ONE SOURCE OF EVIDENCE INSTEAD OF TWO. The
   * protocol pong is the signal that survives a backgrounded tab, because
   * the peer's network stack answers it below page JavaScript; without a
   * `ping()` to provoke one, a socket is judged purely on what the client
   * itself sends, which a hidden tab throttles to once a minute. The relay
   * logs `relay.no-ping` once at attach and carries the fact here so a host
   * can meter it rather than discover it in a reap.
   */
  readonly transportPings: boolean;
}

const defaultLog: Logger = (ev) => {
  try {
    const fn = ev.lvl === 'error' ? console.error : ev.lvl === 'warn' ? console.warn : console.log;
    fn(`[tickroom:relay] ${ev.kind}`, ev);
  } catch {
    // never throw out of a logger
  }
};

/**
 * Reads a client `ping` out of whatever the transport handed us, or `null`
 * for anything else, WITHOUT decoding the frame.
 *
 * The shape test has to work on both transports this library sees: a browser
 * style transport delivers a text frame as a `string`, and the `ws` package
 * delivers one as a `Buffer` exactly like a binary frame, so a `typeof`
 * check alone would miss every ping from the one transport both shipped
 * adapters use. The binary arm decodes only the PREFIX (and only for a frame
 * small enough to be a ping at all) rather than the whole payload, because
 * this runs on every inbound frame at the client's chosen rate and a full
 * utf8 decode of a snapshot-sized input frame per message is exactly the
 * amplifier this file spends a token bucket avoiding.
 */
function pingFrameText(data: unknown): string | null {
  // THE SAME 128-BYTE CAP ON EVERY ARM, so the boundary is a property of the
  // FRAME and not of the transport that delivered it. Without it a browser
  // style transport could hand over a megabyte of text that merely begins
  // `{"t":"ping"` and have all of it parsed, while the identical bytes over
  // `ws` (a Buffer) were treated as input: one wire, two answers, and the
  // expensive one reachable by anyone who can open a socket.
  if (typeof data === 'string') return data.length < 128 && data.startsWith(PING_FRAME_PREFIX) ? data : null;
  // A FRAGMENTED message arrives as an ARRAY of buffers, which `ws`
  // documents and which nothing about a frame's size prevents: a peer
  // chooses its own fragmentation, so a client library (or a proxy) may
  // split a 30-byte ping across two continuation frames. Missing this arm
  // does not lose the frame, it silently routes a ping into `decodeInput`,
  // where a host decoder throws and the client's round-trip measurement
  // stalls with nothing anywhere saying why.
  if (Array.isArray(data)) {
    let total = 0;
    for (const part of data) {
      if (!Buffer.isBuffer(part) && !(part instanceof Uint8Array)) return null;
      total += part.length;
    }
    if (total >= 128) return null;
    const joined = Buffer.concat(data as Uint8Array[]);
    if (joined.subarray(0, PING_FRAME_PREFIX.length).toString('utf8') !== PING_FRAME_PREFIX) return null;
    return joined.toString('utf8');
  }
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) return null;
  if (data.length >= 128) return null;
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, PING_FRAME_PREFIX.length)).toString('utf8');
  if (head !== PING_FRAME_PREFIX) return null;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
}

/**
 * Attaches the relay behaviour to one socket. Synchronous by design: a
 * socket's upgrade callback is synchronous, and this function's own
 * asynchronous work (subscribing, seeding the roster) is threaded through
 * `.then()` rather than awaited, so the caller never has to choose between
 * "wait for the relay to be ready" and "start forwarding messages
 * immediately".
 *
 * THE SOCKET'S STATE IS CHECKED RATHER THAN ASSUMED, and it used not to be.
 * A host awaits `checkAdmission` before calling this, so the socket may have
 * died during that round trip and its 'close' event may ALREADY have fired,
 * in which case no later event ever arrives to trigger cleanup: measured
 * against real `ws`, `terminate()` on a CLOSED socket returns without
 * emitting anything, so the join heartbeated forever, the subscriber leaked,
 * the per-subject cap slot stayed held, and the liveness check logged an
 * error line every second for the rest of the function's lifetime. The
 * opposite end of the same story is a socket still CONNECTING, which
 * `adapters/vercel.ts` documents its upgrade callback can fire in: sending
 * on one throws, so the first-join work waits for `'open'` instead.
 */
export function attachRelay(opts: RelayOptions): RelayHandle {
  const {
    socket,
    redis,
    createSubscriber,
    roomId,
    pid,
    namespace,
    joinMeta,
    metaSeedPayload,
    decodeInput,
    spawnTicker,
    heartbeatMs = JOIN_HEARTBEAT_MS,
    tickerCheckMs = 1000,
    tickerCheckJitterMs = 1000,
    spawnHoldoffMs = 5000,
    livenessTimeoutMs = DEFAULT_LIVENESS_TIMEOUT_MS,
    subscribeTimeoutMs = 5000,
    snapshotBacklogBytes = 32_768,
    lifetimeMs,
    inboundCapacity = 100,
    inboundRefillPerSecond = 70,
    log = defaultLog,
    onClose,
    onRateDrop,
    onBadInput,
    onLivenessDrop,
    onPublishFailed,
  } = opts;

  const keys = roomKeys(roomId, namespace);
  const bucket = new TokenBucket({ capacity: inboundCapacity, refillPerSecond: inboundRefillPerSecond });

  // THIS RELAY'S OWN IDENTITY, carried on the join and leave envelopes as
  // `c`. A pid is not enough to say which SOCKET an envelope came from, and
  // the two overlap by design: a reconnecting player's replacement socket
  // joins while the old relay is still tearing down (and the planned swap at
  // `lifetimeMs` guarantees exactly that overlap). Without this, the old
  // relay's `leave` removes a player who is sitting in the room on their new
  // socket. The ticker remembers the newest `c` per pid and ignores a leave
  // from any other, so a stale relay's teardown cannot touch a live player.
  const conn = randomUUID();

  let closed = false;
  let started = false;
  let joinPublished = false;
  let lastInboundAt = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let tickerCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let subscribeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let expiringTimer: ReturnType<typeof setTimeout> | null = null;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  let openDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let spawnHoldoffUntil = 0;
  let sub: Subscriber | null = null;

  // THE SELF-PROBE. See the heartbeat for the failure it exists for and
  // `probeChannel` for why it gets a channel of its own. Counted as the
  // NEWEST `n` seen rather than as a tally, so a probe lost on the way out
  // and a probe lost on the way back are the same fact, exactly as in
  // `ticker.ts`.
  let probesSent = 0;
  let probesAnswered = 0;

  /**
   * This relay's own probe channel, one per CONNECTION rather than per room.
   *
   * Per connection is what makes the cost bounded and the answer meaningful.
   * A shared channel would fan every socket's probe out to every other socket
   * in the room (N publishes delivered N times each, quadratic in the room
   * size, on the axis managed Redis actually bills), and worse, one healthy
   * subscriber would answer for all of them: the signal that exists to catch
   * a single dead subscription would be the one thing hiding it. Keyed like
   * every other room key so a namespace sweep still finds it, with `conn` as
   * the last segment because that is the identity being tested.
   */
  const probeChannel = `${namespace ?? DEFAULT_NAMESPACE}:${roomId}:relay:${conn}`;

  // A publish to `keys.in` is COUNTED here and logged coalesced on the
  // heartbeat, never logged once per failure, and that is an invariant
  // rather than a preference. The inbound-frame publish below sits on a
  // path whose rate the CLIENT controls (a socket may legitimately send at
  // 20-60Hz, and an abusive one much faster), so a log line per failure
  // means a client that can make Redis publishes fail (or simply outrun
  // them) writes to the platform log at its own chosen rate: a log-volume
  // and cost amplifier handed to exactly the caller this file spends a
  // token bucket defending against. The same rule already covers the rate
  // limiter's own drops, which is why those were never logged.
  //
  // The heartbeat is the right flush cadence because it is a `setInterval`
  // the client cannot influence, so during a genuine Redis outage an
  // operator still sees one line per second per socket carrying an
  // accurate count, which is strictly MORE useful than a flood: a count of
  // 1200 says something a thousand identical lines do not.
  //
  // The join publish is routed through the same counter even though its own
  // rate is already heartbeat-bounded. Two reasons: one kind of log line
  // for one kind of failure reads better during an outage than two
  // interleaved, and it leaves no second, uncoalesced publish path for a
  // later refactor to accidentally move onto a client-driven cadence.
  //
  // The snapshot backlog drops and the subscriber's own error events are
  // flushed the same way and for the same reason: both are driven by
  // traffic the client can shape (a socket that stops reading backs up at
  // the tick rate), so both are counted and reported once a beat.
  let publishFailures = 0;
  let lastPublishError: string | null = null;
  let backlogDrops = 0;
  let subscriberErrors = 0;
  let lastSubscriberError: string | null = null;
  let misaddressedDrops = 0;
  let sendFailures = 0;
  let lastSendError: string | null = null;
  // CONSECUTIVE, not total: one throw is a transient (a frame racing a close
  // the relay has not been told about yet) and a run of them is a socket that
  // is simply gone. See `noteSendFailure`.
  let consecutiveSendFailures = 0;
  // Control frames produced while the socket is not yet OPEN. See
  // `sendControl` for why they are queued rather than attempted or dropped.
  const pendingControl: string[] = [];

  // THE ONE MEASUREMENT NOTHING ELSE IN THE SYSTEM CAN TAKE. See
  // `BUS_GAP_REPORT_MS` for what the two numbers separate and why only a
  // relay can separate them. Both are per WINDOW (the heartbeat's flush
  // resets them) and both obey this file's standing rule: counted in process
  // on the message path, reported on a cadence the client cannot drive, never
  // a line per snapshot. A snapshot stream is the highest-rate thing this
  // relay touches, so a line per gap would be the same log amplifier the
  // publish counter and the rate limiter's drops already exist to avoid.
  // `lastSnapshotAt` is null until the first arrival, because a gap needs two.
  const attachedAt = Date.now();
  let lastSnapshotAt: number | null = null;
  let busGapMax = 0;
  let busGapOver150 = 0;
  let sendLagMax = 0;

  function notePublishFailure(err: unknown): void {
    publishFailures++;
    lastPublishError = String(err);
    try {
      onPublishFailed?.(err);
    } catch {
      // A host hook must never be able to take the socket down, and this
      // path is client-rate, so the failure cannot be reported either.
    }
  }

  function flushCounters(): void {
    if (publishFailures > 0) {
      const count = publishFailures;
      const error = lastPublishError;
      publishFailures = 0;
      lastPublishError = null;
      log({ lvl: 'error', kind: 'relay.publish-failed', room: roomId, pid, meta: { count, error } });
    }
    if (backlogDrops > 0) {
      const count = backlogDrops;
      backlogDrops = 0;
      log({ lvl: 'warn', kind: 'relay.backlog-drop', room: roomId, pid, meta: { count, capBytes: snapshotBacklogBytes } });
    }
    if (subscriberErrors > 0) {
      const count = subscriberErrors;
      const error = lastSubscriberError;
      subscriberErrors = 0;
      lastSubscriberError = null;
      log({ lvl: 'warn', kind: 'relay.subscriber-error', room: roomId, pid, meta: { count, error } });
    }
    if (misaddressedDrops > 0) {
      const count = misaddressedDrops;
      misaddressedDrops = 0;
      log({ lvl: 'warn', kind: 'relay.misaddressed-frame', room: roomId, pid, meta: { count } });
    }
    if (sendFailures > 0) {
      const count = sendFailures;
      const error = lastSendError;
      sendFailures = 0;
      lastSendError = null;
      log({ lvl: 'error', kind: 'relay.send-failed', room: roomId, pid, meta: { count, error } });
    }
    // AND THE TIMING WINDOW, which resets whether or not it was worth a line.
    // SILENCE IS THE HEALTHY READING: a relay that saw no hole and no slow
    // send says nothing at all, so a `relay.gaps` line in the platform log is
    // itself the signal rather than something to be filtered out of a stream
    // of them. That is what a per-window max buys over a per-event line.
    const gapMax = busGapMax;
    const gapOver = busGapOver150;
    const lagMax = sendLagMax;
    busGapMax = 0;
    busGapOver150 = 0;
    sendLagMax = 0;
    if (gapMax > BUS_GAP_REPORT_MS || lagMax > SEND_LAG_REPORT_MS) {
      log({
        lvl: 'info',
        kind: 'relay.gaps',
        room: roomId,
        pid,
        meta: { busGapMax: gapMax, busGapOver150: gapOver, sendLagMax: lagMax, socketAgeMs: Date.now() - attachedAt },
      });
    }
  }

  function publishJoin(): void {
    joinPublished = true;
    const envelope: RoomEnvelope = { t: 'join', pid, meta: joinMeta, c: conn };
    redis.publish(keys.in, JSON.stringify(envelope)).catch(notePublishFailure);
  }

  /**
   * THE ONE SEND PATH, so that a failing socket is counted once rather than
   * logged once per frame. A `socket.send` that throws used to log
   * `relay.send-failed` at error level per call, on a path the TRAFFIC
   * drives: measured at 20 lines a second for one broken socket, which is
   * the same log amplifier the publish counter and the rate limiter's own
   * drops already exist to avoid. Counted here, flushed on the heartbeat.
   */
  function rawSend(payload: string | Uint8Array | Buffer): void {
    try {
      socket.send(payload);
      consecutiveSendFailures = 0;
    } catch (err) {
      noteSendFailure(err);
    }
  }

  function noteSendFailure(err: unknown): void {
    sendFailures++;
    lastSendError = String(err);
    consecutiveSendFailures++;
    // AND A RUN OF THEM ENDS THE SOCKET. A transport that refuses three
    // sends in a row is not a socket having a bad moment, it is one whose
    // peer is gone in a way that produced no 'close' and no 'error' event
    // (the same silence the liveness check exists for), and the relay would
    // otherwise keep publishing this player's join, holding a subscriber and
    // a cap slot, and counting failures until the function's duration cap.
    // The liveness deadline would eventually catch it, tens of seconds
    // later; this is the same conclusion reached from evidence already in
    // hand.
    if (consecutiveSendFailures >= SEND_FAILURE_LIMIT && !closed) {
      try {
        if (socket.terminate) socket.terminate();
        else socket.close(1006);
      } catch {
        // the socket is already gone, which is exactly what was concluded
      }
      cleanup(1006);
    }
  }

  /**
   * One-shot control traffic (the roster seed, a room-full refusal, the
   * expiry announcement). Unlike a snapshot these are never repeated, so a
   * dropped one is permanent, which is why they are QUEUED while the socket
   * is not yet OPEN rather than attempted or discarded. `ws` THROWS on a
   * send in CONNECTING, so attempting them was worth one `relay.send-failed`
   * line per frame for a socket that had done nothing wrong. The queue keeps
   * the NEWEST few and is bounded, because an unbounded one is the very
   * backpressure trap the snapshot forward refuses to build.
   *
   * WHAT THE QUEUE IS FOR, AND WHAT IT IS NOT FOR. It exists for a frame
   * that must survive a slow handshake and still be there when the wire comes
   * up: the roster seed, an expiry announcement. It is NOT a delivery
   * guarantee for a frame that ACCOMPANIES A CLOSE, and one case really does
   * hit that: a `room-reject` for a socket still CONNECTING queues its
   * `room-full` and then closes, so `cleanup` sets `closed` and the flush
   * never runs. That is deliberate and costs nothing, because the CLOSE CODE
   * carries the same meaning as the frame (`CLOSE_CODES.capacity` is what the
   * client latches its terminal state off; the frame is the human-readable
   * half). Flushing on the way out would mean sending on a socket the
   * transport has just been told to close, which `ws` answers with a throw.
   * If a future frame ever carries meaning its close code does not, it needs
   * its own delivery path, not a wider queue.
   */
  function sendControl(frame: string): void {
    if (socket.readyState !== WS_OPEN) {
      pendingControl.push(frame);
      while (pendingControl.length > CONTROL_QUEUE_MAX) pendingControl.shift();
      return;
    }
    rawSend(frame);
  }

  function flushControlQueue(): void {
    if (pendingControl.length === 0) return;
    const queued = pendingControl.splice(0, pendingControl.length);
    for (const frame of queued) {
      if (closed) return;
      rawSend(frame);
    }
  }

  function seedRoster(): void {
    redis
      .hgetall(keys.meta)
      .then((raw) => {
        if (closed) return;
        // `Object.create(null)`, NOT `{}`, AND THE REASON IS A HASH FIELD NAME.
        // The keys here are pids, which come from a host's own identity
        // system, and `map[k] = ...` on an object literal with `k` of
        // `__proto__` REPARENTS the object instead of adding a property: the
        // entry then vanishes from `JSON.stringify`, so that player is
        // missing from the seed while the ticker's own broadcast (built with
        // `Object.fromEntries`, which has no such rule) does include them.
        // The two halves of one roster disagreeing is precisely the failure
        // `metaSeedPayload` exists to keep hosts out of. A null-prototype
        // object has no `__proto__` setter, so the assignment is an ordinary
        // own property and serialises. `JSON.stringify` handles one fine.
        const map: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [k, v] of Object.entries(raw)) {
          try {
            const parsed: unknown = JSON.parse(v);
            // The ticker writes `env.meta ?? {}`, so every legitimate entry is
            // a plain object. Anything else in this hash was not written by
            // the roster path, and a scalar or an array reaching a host
            // formatter that expects a record is a crash in the host's code
            // rather than a seed.
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
            map[k] = parsed;
          } catch {
            // a corrupt single field must not blank the whole seed
          }
        }
        // The host's formatter, if any, decides the client-visible shape;
        // see `metaSeedPayload` for why that seam exists. A formatter that
        // THROWS lands in the `.catch` below and is reported as a seed
        // failure, which is correct: this path runs at most twice per
        // socket, so it is not client-rate and a real log line is affordable.
        const payload = metaSeedPayload ? metaSeedPayload(map) : { t: SERVER_FRAMES.meta, seed: true, map };
        // `JSON.stringify` returns undefined for `undefined` (and for a bare
        // function or symbol) despite its lying type. Suppressing the frame
        // beats sending the four characters "undefined" down a control
        // channel, and it gives a host a deliberate way to opt out of the
        // seed entirely when it seeds the roster by some other route.
        const frame = JSON.stringify(payload) as string | undefined;
        if (frame === undefined) return;
        sendControl(frame);
      })
      .catch((err) => log({ lvl: 'warn', kind: 'relay.meta-seed-failed', room: roomId, pid, meta: { error: String(err) } }));
  }

  function ensureTicker(): void {
    redis
      .get(keys.lease)
      .then((leaseValue) => {
        if (closed) return;
        if (!shouldSpawnTicker(leaseValue)) {
          // A live lease answers the question the hold-off exists to stop
          // this relay asking twenty times: the room has a ticker. Clearing
          // it here is what keeps a hold-off from a spawn minutes ago
          // delaying the response to a real gap now.
          spawnHoldoffUntil = 0;
          return;
        }
        const now = Date.now();
        if (now < spawnHoldoffUntil) return;
        spawnHoldoffUntil = now + spawnHoldoffMs;
        // NAMED, BECAUSE THIS LINE USED TO REPORT A NON-EVENT. A spawn that
        // waited for its response failed at undici's 300s headers timeout on a
        // ticker that had started 300s earlier and was running the room, so
        // `relay.spawn-failed` fired once per room start with
        // `TypeError: fetch failed` and meant nothing. Under the delivery
        // contract on `spawnTicker` above, the only rejection that can reach
        // here is one from before the request landed, i.e. a room with no
        // ticker: the outcome says so rather than leaving the reader to guess
        // which of the two this was.
        spawnTicker(roomId).catch((err) =>
          log({
            lvl: 'error',
            kind: 'relay.spawn-failed',
            room: roomId,
            pid,
            meta: { error: String(err), outcome: 'rejected-before-ack' },
          })
        );
      })
      .catch((err) => log({ lvl: 'warn', kind: 'relay.lease-check-failed', room: roomId, pid, meta: { error: String(err) } }));
  }

  function scheduleTickerCheck(): void {
    if (closed) return;
    // A JITTERED interval, not merely a periodic one, and the jitter is the
    // load-bearing part, not the base period. Every socket in a room runs
    // this same check independently; on a real lease gap (the ticker died
    // and nobody has spawned a successor yet), every one of them would fire
    // a spawn attempt in the same instant with a fixed interval, and all but
    // one exist only to lose the acquire race pointlessly. Jitter spreads
    // those attempts out. The PERIOD itself has to stay well under a few
    // seconds regardless, because this poll is the fallback recovery path
    // whenever a dying ticker's own successor-spawn (see ticker.ts) does not
    // land, and handoff budgets are measured in seconds, not tens of them.
    const delay = tickerCheckMs + Math.floor(Math.random() * tickerCheckJitterMs);
    tickerCheckTimer = setTimeout(() => {
      if (closed) return;
      ensureTicker();
      scheduleTickerCheck();
    }, delay);
  }

  function cleanup(code: number): void {
    if (closed) return;
    closed = true;
    // TAIL FLUSH, before the timers that would otherwise have carried it are
    // cleared. Without this a socket that dies mid-outage loses every
    // publish failure and backlog drop it accumulated since the last beat,
    // which is exactly the window an operator most wants to see, and it
    // silently under-reports the failure right at the moment the room is
    // losing a player's input.
    flushCounters();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (tickerCheckTimer) clearTimeout(tickerCheckTimer);
    if (subscribeTimeoutTimer) clearTimeout(subscribeTimeoutTimer);
    if (expiringTimer) clearTimeout(expiringTimer);
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    if (openDeadlineTimer) clearTimeout(openDeadlineTimer);
    // A relay that never announced a join has nothing to retract, and the
    // one case that reaches here (a socket already dead on arrival, see the
    // state check below) must not publish anything at all. The `c` makes
    // the leave safe even when it races a replacement socket's join.
    if (joinPublished) {
      redis.publish(keys.in, JSON.stringify({ t: 'leave', pid, c: conn } satisfies RoomEnvelope)).catch(() => {});
    }
    if (sub) {
      try {
        sub.disconnect();
      } catch {
        // best-effort teardown only
      }
    }
    try {
      onClose?.(code);
    } catch (err) {
      log({ lvl: 'error', kind: 'relay.onClose-threw', room: roomId, pid, meta: { error: String(err) } });
    }
  }

  // A TRANSPORT WITHOUT `ping()` IS NOT AN EDGE CASE, IT IS AN UNCHECKED
  // CAST. Both shipped adapters hand `attachRelay` a socket the platform
  // gave them (`ws as RelaySocket`), with no shape check anywhere, and
  // `socket.ping?.()` no-ops in silence when the method is absent: liveness
  // then rests entirely on what the CLIENT sends, which a hidden tab
  // throttles to once a minute. Recorded on the handle for a host to meter,
  // and logged once here, because "once per socket at attach" is a rate
  // admission already bounds and the alternative is finding out from a reap.
  const transportPings = typeof socket.ping === 'function';

  const handle: RelayHandle = {
    transportPings,
    gapsSample(): RelayGapsSample {
      return { busGapMax, busGapOver150, sendLagMax, socketAgeMs: Date.now() - attachedAt };
    },
    close(code?: number): void {
      // ONE resolved code for both halves. `cleanup(code ?? 1000)` with a
      // bare `socket.close(code)` beside it told the HOST (through
      // `onClose`) that the socket closed with 1000 while handing the
      // TRANSPORT an `undefined` that `ws` turns into a 1005 "no status
      // received" on the wire, so the server-side record and the client's
      // own close event disagreed on every plain `handle.close()`.
      const resolved = code ?? 1000;
      cleanup(resolved);
      try {
        socket.close(resolved);
      } catch {
        // the socket may already be gone; cleanup already ran regardless
      }
    },
  };

  // DEAD ON ARRIVAL. The caller awaited `checkAdmission` before getting
  // here, so the socket may have closed during that round trip with its
  // 'close' event already fired and gone. Nothing is subscribed and nothing
  // is published for such a socket; `cleanup` runs immediately so whatever
  // the host registered on `onClose` (the per-subject cap slot, in both
  // shipped adapters) is released now rather than at the function's own
  // duration cap.
  if (socket.readyState === WS_CLOSING || socket.readyState === WS_CLOSED) {
    cleanup(1006);
    return handle;
  }

  if (!transportPings) {
    log({
      lvl: 'warn',
      kind: 'relay.no-ping',
      room: roomId,
      pid,
      msg: 'the transport exposes no ping(): liveness rests on client traffic alone, so a tab backgrounded past five minutes (timers throttled to one frame a minute) will be reaped',
      meta: { livenessTimeoutMs },
    });
  }

  sub = createSubscriber();

  // --- pub/sub forwarding ---
  //
  // ONE listener, on the buffer-preserving event, for BOTH channels.
  // Snapshots (keys.out) must never be decoded to a JS string: a binary
  // codec run through ioredis's string-decoding `message` event is
  // corrupted by the lossy round trip. Roster and control traffic
  // (keys.metaout) is always JSON text this library itself publishes, so it
  // is decoded here, and forwarding it as a string is what makes the client
  // receive it as a TEXT frame rather than a binary one, matching the
  // "binary snapshots, text control messages" convention.
  //
  // The two used to be two listeners, one per event, and that was measurably
  // expensive: ioredis emits BOTH events for every delivery as soon as any
  // 'message' listener exists, so every binary snapshot was utf8-decoded
  // once per socket per tick purely to be thrown away by a channel check.
  // Branching on the channel buffer pays the decode only for the channel
  // that is actually text.
  sub.on('messageBuffer', (channelBuf: unknown, messageBuf: unknown) => {
    if (closed) return;
    if (!Buffer.isBuffer(messageBuf)) return;
    const channel = Buffer.isBuffer(channelBuf) ? channelBuf.toString('utf8') : String(channelBuf);
    if (channel === keys.out) {
      forwardSnapshot(messageBuf);
      return;
    }
    if (channel === probeChannel) {
      // THIS RELAY'S OWN PROBE, COMING BACK. It is never forwarded to the
      // socket and never counted as traffic: it is not a frame, it is the
      // answer to "does my subscription still deliver anything at all".
      // Recorded as the newest `n` rather than as a count, so one lost probe
      // cannot be papered over by the next one arriving.
      try {
        const answer = JSON.parse(messageBuf.toString('utf8')) as { n?: unknown };
        // BOUNDED BY WHAT WAS ACTUALLY SENT, not merely monotonic. The
        // channel name contains `conn`, which this relay publishes in the
        // clear on every join envelope, so anyone who can write to the bus
        // can address this socket's probe channel: a single forged
        // `{ t: 'probe', n: 1e15 }` against an unbounded `n > probesAnswered`
        // check disables the watchdog for the rest of the socket's life
        // (measured: the control terminated with one dead line, the poisoned
        // one never terminated across ten seconds of heartbeats). An answer
        // for a probe that was never sent is not an answer, and `<=
        // probesSent` caps the damage of a forgery at the current beat.
        // `isInteger` refuses the `1e999`/`NaN` shapes a hand-built frame can
        // carry, exactly like the pong echo's own validation.
        const n = answer.n;
        if (typeof n === 'number' && Number.isInteger(n) && n > probesAnswered && n <= probesSent) {
          probesAnswered = n;
        }
      } catch {
        // Nothing else publishes here, so a frame that does not parse is not
        // an answer; the deadline treats it as the silence it is.
      }
      return;
    }
    if (channel !== keys.metaout) return;

    const text = messageBuf.toString('utf8');
    // THE ROSTER CHANNEL IS A BROADCAST, SO WHAT MAY LEAVE IT FOR A SOCKET IS
    // AN ALLOWLIST. Every frame published here reaches every relay in the
    // room, while four of the five frames in `SERVER_FRAMES` are PER SOCKET
    // by construction: only this relay may tell its own client that the room
    // is full, that its subject is at the connection limit, that this relay
    // is expiring, or what its own ping measured. Forwarding them verbatim
    // meant one `{ t: 'room-full' }` on the roster channel latched every
    // client in the room into a terminal capacity state, closed their
    // sockets, and stopped their reconnect ladders: measured on an innocent
    // client from a single frame. A host's OWN control traffic (any `t` this
    // library does not define, and anything that is not JSON at all) is
    // forwarded untouched, because the roster channel is the seam this
    // library gives a host for exactly that.
    let frame: { t?: unknown; pid?: unknown; c?: unknown } | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) frame = parsed as { t?: unknown; pid?: unknown; c?: unknown };
    } catch {
      // Not JSON at all, so it is not a frame this library owns; forwarded
      // verbatim below, exactly as before.
    }
    const frameType = frame?.t;
    // ROOM-REJECT IS CONSUMED HERE, NOT FORWARDED. The ticker publishes it
    // when the simulation's own `isFull` refuses a new player. Forwarding it
    // sent a rejection for ONE pid to every socket in the room (a frame the
    // client ignores) while the player it was actually meant for sat
    // connected forever, receiving snapshots with no entity in them and no
    // idea why. The relay is the only place that knows which socket carries
    // which pid, so it is the only place the frame can be aimed.
    if (frameType === ROOM_REJECT_FRAME) {
      const reject = frame as { pid?: unknown; c?: unknown };
      if (reject.pid !== pid) return; // somebody else's rejection: dropped, never forwarded
      // AND A PID IS NOT A SOCKET, which is the same lesson the `c` on the
      // join and leave envelopes exists for. A player reconnecting, or
      // swapping at a relay's `lifetimeMs`, holds TWO live sockets for the
      // same pid on purpose, and a rejection is about the join ONE of them
      // published: matching on pid alone closes the innocent one too, which
      // in the swap case is the socket that was about to take over. The
      // ticker copies the offending join's `c` onto the reject, so requiring
      // it to match makes the frame aimed at a socket rather than a person.
      // A reject WITHOUT a `c` comes from a ticker that predates this and is
      // still honoured on pid alone, exactly as before. ABSENT is the only
      // thing that means "no connection named": a `typeof === 'string'` guard
      // read a wrong-typed `c` (a number, an object) as absent and fell back
      // to matching on the pid, which closes both of a swapping player's
      // sockets, the exact regression this field exists to prevent. A `c`
      // that is present and does not match this connection is not ours,
      // whatever shape it arrived in.
      if (reject.c !== undefined && reject.c !== conn) return;
      sendControl(JSON.stringify({ t: SERVER_FRAMES.roomFull }));
      cleanup(CLOSE_CODES.capacity);
      try {
        socket.close(CLOSE_CODES.capacity);
      } catch {
        // cleanup already ran; a socket that cannot be closed is gone anyway
      }
      return;
    }
    // The other four library frames are per-socket and this relay is the only
    // thing that may originate one, so an instance arriving on the roster
    // channel is misaddressed by construction: dropped, and COUNTED on the
    // heartbeat rather than logged per frame, because the publisher chooses
    // the rate.
    if (typeof frameType === 'string' && LIBRARY_FRAMES.has(frameType) && !BROADCAST_FRAMES.has(frameType)) {
      misaddressedDrops++;
      return;
    }
    sendControl(text);
  });

  // A SUBSCRIBER THAT DIES IS NOT A SUBSCRIBER THAT ERRORS LOUDLY. Both
  // events below arrive on a connection the client can never see, and a
  // relay that ignores them keeps an open socket that will never receive
  // another snapshot: the client's own stall detector eventually shows the
  // player a banner, which is a far worse answer than closing and letting
  // the reconnect ladder land on a fresh relay. The 'error' events are
  // COUNTED rather than logged per event, because a flapping connection
  // emits them at whatever rate it likes.
  sub.on('error', (err: unknown) => {
    subscriberErrors++;
    lastSubscriberError = String(err);
  });
  sub.on('end', () => {
    if (closed) return;
    log({ lvl: 'error', kind: 'relay.subscriber-dead', room: roomId, pid });
    cleanup(CLOSE_CODES.relayUnavailable);
    try {
      socket.close(CLOSE_CODES.relayUnavailable);
    } catch {
      // cleanup already ran; a socket that cannot be closed is gone anyway
    }
  });

  /**
   * THE SNAPSHOT FORWARD, AND THE ONLY PLACE THIS RELAY DROPS ON PURPOSE.
   * See `snapshotBacklogBytes` for why a reliable queue on top of a lossy
   * bus is the wrong thing to build. A socket that is not OPEN is the same
   * case with a different cause (still connecting, already closing), and
   * sending to one throws on `ws`, which used to log `relay.send-failed` at
   * the tick rate.
   */
  function forwardSnapshot(payload: Buffer): void {
    // THE ARRIVAL IS STAMPED BEFORE ANY DECISION ABOUT IT, and it closes the
    // gap even for a snapshot this function is about to drop. The bus gap is
    // a property of what this subscriber DELIVERED, not of what the socket
    // then did with it: a relay whose event loop stalled and a socket that is
    // merely backed up are different faults, and folding a backlog drop into
    // the gap would report the second as the first.
    const arrivedAt = Date.now();
    if (lastSnapshotAt !== null) {
      const gap = arrivedAt - lastSnapshotAt;
      if (gap > busGapMax) busGapMax = gap;
      if (gap > BUS_GAP_REPORT_MS) busGapOver150++;
    }
    lastSnapshotAt = arrivedAt;
    if (socket.readyState !== WS_OPEN) {
      backlogDrops++;
      return;
    }
    const buffered = socket.bufferedAmount;
    if (typeof buffered === 'number' && buffered > snapshotBacklogBytes) {
      backlogDrops++;
      return;
    }
    rawSend(payload);
    // MEASURED ACROSS THE SEND, and only for a snapshot that was actually
    // sent. This is the half of a client's reported gap that lives on this
    // side of the wire, and it is the half the bus probe cannot see.
    const lag = Date.now() - arrivedAt;
    if (lag > sendLagMax) sendLagMax = lag;
  }

  /**
   * Everything that must not happen until the socket can actually carry it:
   * the first join publish, the roster seed, the ticker check, the
   * heartbeat, and the lifetime timers. Runs inline for a socket that is
   * already OPEN (the ordinary case) and off the `'open'` event for one
   * still CONNECTING, which is why it is idempotent.
   */
  function startSession(): void {
    if (closed || started) return;
    started = true;

    // FIRST publish, immediate and unconditional. Gating this on the
    // subscribe ack below (as the SECOND one has to be) would put a fresh
    // subscriber's TCP connect + TLS handshake + AUTH + SUBSCRIBE round trip
    // in front of the join the ticker needs to un-freeze this player:
    // measured over a second on a cold connection, during which a
    // RECONNECTING player would sit admitted-but-frozen server-side while
    // their own client predicts motion nobody is simulating.
    publishJoin();
    seedRoster();

    ensureTicker();
    scheduleTickerCheck();

    // The heartbeat timer does FOUR jobs, deliberately sharing one interval
    // rather than four: it re-publishes the join envelope (so a message lost
    // to the subscribe race above is not permanent, since the ticker's join
    // handling is idempotent), it flushes the coalesced counters, it pings
    // the socket, and it checks the liveness deadline. One timer, one Redis
    // command's worth of amortized cost, instead of four independent
    // schedules drifting against each other.
    heartbeatTimer = setInterval(() => {
      if (closed) return;
      publishJoin();
      // Second job: emit one line for however many publishes failed, frames
      // were dropped for backlog, and subscriber errors fired since the last
      // beat. This is the cadence the client cannot drive, which is the whole
      // point of putting the flush here rather than at each failure site.
      flushCounters();
      try {
        socket.ping?.();
      } catch {
        // a ping that cannot even be sent means the socket is already gone;
        // the liveness check below will notice on its own schedule.
      }
      // LIVENESS. A half-open socket is indistinguishable, from the relay's
      // point of view, from a perfectly healthy but quiet one: nothing
      // arrives and nothing errors either way. Left unchecked, the relay
      // keeps publishing this player's join heartbeat and holding every
      // resource for the socket's entire duration cap. `terminate`, not
      // `close`, is what fires here: a peer that is already gone will never
      // answer a graceful closing handshake, so `close()` would leave
      // everything running until the platform's own close timeout finally
      // expires, whereas `terminate()` emits a 'close' event at once and runs
      // the ordinary cleanup path immediately.
      //
      // AND THEN CLEANUP RUNS ANYWAY, rather than waiting for that event.
      // `terminate()` on a socket that has ALREADY closed returns without
      // emitting anything at all, so the transport's own event is not
      // something this loop may depend on; `cleanup` is idempotent, so a
      // transport that does emit 'close' costs nothing for the belt.
      if (Date.now() - lastInboundAt > livenessTimeoutMs) {
        log({ lvl: 'warn', kind: 'relay.liveness-drop', room: roomId, pid });
        try {
          onLivenessDrop?.();
        } catch {
          // see the observability-seam note on RelayOptions
        }
        if (socket.terminate) socket.terminate();
        else socket.close(1006);
        cleanup(1006);
        return;
      }
      // THE SUBSCRIPTION PROBES ITSELF, because nothing else in this file can
      // see it die. A subscriber connection that is BLACK-HOLED (a dropped
      // NAT mapping, a firewall that discards packets with no FIN and no RST)
      // stays OPEN as far as both ends are concerned: ioredis never
      // reconnects, so `'end'` never fires and the resubscribe never happens,
      // and the liveness check above measures only what the CLIENT sends, so
      // a perfectly healthy, chatty player keeps the socket alive forever
      // while receiving nothing. Measured against real ioredis behind a
      // black-holing proxy: zero frames after two seconds, no log line, no
      // close, bounded only by `lifetimeMs` where a host sets one and by
      // nothing at all on the node adapter. The only way to learn that a
      // channel still delivers is to send something down it and watch for it
      // coming back, which is exactly what `ticker.ts` does for its own input
      // subscription; this is the same mechanism on the other side of the bus.
      //
      // Checked BEFORE the next probe is published, so the deadline is three
      // unanswered probes plus the beat that notices. Fire-and-forget with a
      // bare `.catch`, because a probe that could not even be PUBLISHED is an
      // unanswered probe, which is the correct reading rather than a special
      // case: the relay cannot serve this socket either way.
      if (probesSent - probesAnswered >= PROBE_MISS_LIMIT) {
        log({
          lvl: 'error',
          kind: 'relay.subscriber-dead',
          room: roomId,
          pid,
          msg: 'the snapshot subscription stopped delivering: closing so the client reconnects onto a fresh relay',
          meta: { sent: probesSent, answered: probesAnswered },
        });
        // `terminate`, not a graceful close, for the same reason the liveness
        // path uses it: the client's reconnect ladder treats every
        // non-terminal close alike, so waiting on a closing handshake buys
        // nothing here and delays the reconnect that is the whole point.
        try {
          if (socket.terminate) socket.terminate();
          else socket.close(CLOSE_CODES.relayUnavailable);
        } catch {
          // a socket that cannot be closed is gone, which is the conclusion
        }
        cleanup(CLOSE_CODES.relayUnavailable);
        return;
      }
      probesSent++;
      redis.publish(probeChannel, JSON.stringify({ t: 'probe', n: probesSent })).catch(() => {});
    }, heartbeatMs);

    startLifetimeTimers();
  }

  /**
   * The planned end of this relay, announced before it happens. See
   * `lifetimeMs`. Both timers are cleared by `cleanup`, so a socket that
   * closes early never fires either.
   */
  function startLifetimeTimers(): void {
    if (lifetimeMs === undefined) return;
    // A lifetime shorter than the lead time cannot give the client the full
    // warning, so it gets the announcement at once rather than a negative
    // delay (which fires immediately anyway, but by accident rather than on
    // purpose) or none at all.
    const leadDelay = Math.max(0, lifetimeMs - RELAY_EXPIRY_LEAD_MS);
    expiringTimer = setTimeout(() => {
      if (closed) return;
      sendControl(JSON.stringify({ t: SERVER_FRAMES.relayExpiring, inMs: RELAY_EXPIRY_LEAD_MS }));
    }, leadDelay);
    lifetimeTimer = setTimeout(() => {
      if (closed) return;
      log({ lvl: 'info', kind: 'relay.lifetime-reached', room: roomId, pid, meta: { lifetimeMs } });
      cleanup(CLOSE_CODES.relayUnavailable);
      try {
        socket.close(CLOSE_CODES.relayUnavailable);
      } catch {
        // cleanup already ran; a socket that cannot be closed is gone anyway
      }
    }, lifetimeMs);
  }

  if (socket.readyState === WS_CONNECTING) {
    // Deferred, not skipped. `adapters/vercel.ts` documents an upgrade
    // callback that can fire before the handshake completes, and `ws` throws
    // on a send in this state, so seeding the roster here would fail and the
    // join heartbeat would start counting liveness against a socket that
    // cannot yet answer. The subscribe below still goes out immediately: it
    // costs a round trip this socket may as well spend now, and any snapshot
    // that arrives before OPEN is dropped by `forwardSnapshot` (counted, like
    // every other backlog drop) rather than sent.
    socket.on('open', () => {
      if (closed) return;
      if (openDeadlineTimer) clearTimeout(openDeadlineTimer);
      openDeadlineTimer = null;
      lastInboundAt = Date.now();
      // The queued control frames first: they were produced before the wire
      // was usable and they are all one-shot, so they are older than
      // anything `startSession` is about to send and there is nothing that
      // will ever repeat them.
      flushControlQueue();
      startSession();
    });
    // AND A DEADLINE ON THAT EVENT, because a socket that never opens and
    // never closes is a permanent leak with nothing to notice it: the
    // heartbeat, which is what would eventually terminate a silent socket,
    // is itself created by `startSession` and therefore never starts. Left
    // unarmed, the subscriber connection, the per-subject cap slot and the
    // registration touch timer all live to the function's duration cap for a
    // handshake that failed. `subscribeTimeoutMs` is reused rather than
    // adding a fourth timeout knob: it is already "how long this relay is
    // willing to wait for the plumbing to come up", and a handshake that has
    // not completed in that long is not going to.
    openDeadlineTimer = setTimeout(() => {
      if (closed || started) return;
      log({ lvl: 'warn', kind: 'relay.open-timeout', room: roomId, pid, meta: { waitedMs: subscribeTimeoutMs } });
      cleanup(1006);
      try {
        socket.close(1006);
      } catch {
        // cleanup already ran; a socket that cannot be closed is gone anyway
      }
    }, subscribeTimeoutMs);
  } else {
    startSession();
  }

  // THE SUBSCRIBE IS BOUNDED. A subscribe that never resolves leaves this
  // socket permanently deaf: open, heartbeating, admitted, and receiving
  // nothing, with every other signal reading healthy on both ends. Racing a
  // plain timer against it turns that into an ordinary close the client's
  // reconnect ladder already knows how to answer.
  const subscribeTimeout = new Promise<never>((_, reject) => {
    subscribeTimeoutTimer = setTimeout(
      () => reject(new Error(`subscribe did not complete within ${subscribeTimeoutMs}ms`)),
      subscribeTimeoutMs
    );
  });
  void Promise.race([sub.subscribe(keys.out, keys.metaout, probeChannel), subscribeTimeout])
    .then(() => {
      if (subscribeTimeoutTimer) clearTimeout(subscribeTimeoutTimer);
      subscribeTimeoutTimer = null;
      if (closed) return;
      // SECOND publish and seed, gated on the subscribe ack. Redis drops a
      // pub/sub message with no subscriber, and the ticker announces a
      // roster change on `metaout` exactly ONCE (it only re-dirties its map
      // when a join genuinely changes it, so a later heartbeat announces
      // nothing new). A socket whose SUBSCRIBE has not yet been
      // acknowledged when the ticker processes and announces this very join
      // would therefore miss its own announcement PERMANENTLY: nothing ever
      // repeats it.
      //
      // Re-seeding here rather than trusting the first seed to have caught
      // everything is what closes the matching race on the READ side. Redis
      // is single-threaded and the ticker HSETs the meta hash strictly
      // BEFORE it PUBLISHes on `metaout` (same connection, so program order
      // is Redis's execution order): an HGETALL issued only after this
      // SUBSCRIBE was acknowledged therefore cannot miss an announcement.
      // Either the publish happened after our subscription (we receive it
      // directly) or it happened before (the HSET necessarily preceded it,
      // and this later read observes it). There is no third case.
      //
      // A socket still CONNECTING at this point has not published its first
      // join yet, so there is nothing to re-publish and nothing to re-seed:
      // `startSession` runs AFTER this ack in that ordering, and its own
      // seed already has the property this pair exists to give.
      if (!started) return;
      publishJoin();
      seedRoster();
    })
    .catch((err) => {
      if (subscribeTimeoutTimer) clearTimeout(subscribeTimeoutTimer);
      subscribeTimeoutTimer = null;
      // A socket that closed inside one Redis round trip takes its
      // subscriber down with it, so the rejection here is the ORDINARY
      // teardown of a short-lived connection rather than a fault: measured
      // as one `relay.subscribe-failed: Connection is closed.` at error
      // level per such socket, which is noise in exactly the log an
      // operator reads to find real subscribe failures.
      if (closed) return;
      log({ lvl: 'error', kind: 'relay.subscribe-failed', room: roomId, pid, meta: { error: String(err) } });
      // NOT report-and-proceed any more. The first publish and seed did run,
      // so the room knows this player exists, but the socket will never
      // receive a snapshot or a roster change: it is admitted and deaf, and
      // the client cannot tell that apart from a hung room. Closing with
      // `relayUnavailable` (not a terminal code) puts it through the
      // reconnect ladder onto a fresh relay with a fresh subscriber.
      cleanup(CLOSE_CODES.relayUnavailable);
      try {
        socket.close(CLOSE_CODES.relayUnavailable);
      } catch {
        // cleanup already ran; a socket that cannot be closed is gone anyway
      }
    });

  socket.on('message', (...args: unknown[]) => {
    if (closed) return;
    // `args[0]` is already `unknown` here (the socket's `on()` signature
    // takes `...args: unknown[]`), matching `decodeInput`'s own parameter:
    // this relay never assumes a transport, so it never casts one in either.
    const data = args[0];
    // ANY inbound frame refreshes liveness, INCLUDING one about to be
    // dropped by the rate limiter below (it still proves the peer is there)
    // and including a frame this handler cannot even decode. Liveness is
    // about whether the SOCKET is alive, not whether its traffic is well
    // formed.
    lastInboundAt = Date.now();
    if (!bucket.take()) {
      // Dropped, and still never logged per message: client-controlled
      // input arrives at up to 20-60Hz and an abusive socket much faster,
      // so a line per drop is a log/cost amplifier handed to the caller
      // this bucket exists to throttle. `onRateDrop` is the seam instead:
      // an in-process synchronous callback the host aggregates itself and
      // flushes on its own cadence. It is deliberately unreachable through
      // `decodeInput`, because the whole point of the bucket is to reject
      // the frame BEFORE any decode work is paid for.
      try {
        onRateDrop?.();
      } catch {
        // see the observability-seam note on RelayOptions
      }
      return;
    }
    // THE PING IS ANSWERED HERE, BEFORE THE DECODER, AND WITHOUT REDIS.
    // The whole point of the frame is to measure a true client round trip,
    // so anything this relay does on the way (a publish, a decode, a wait
    // for the ticker) is measurement error added to the number. It sits
    // AFTER the bucket deliberately: a ping is a frame like any other and
    // pays a token, so an abuser cannot buy extra allowance by relabelling
    // its flood.
    const ping = pingFrameText(data);
    if (ping !== null) {
      try {
        const parsed = JSON.parse(ping) as { n?: unknown; c?: unknown };
        // Both fields are echoed straight back to the client, so both are
        // checked here rather than trusted: `Number.isFinite` refuses the
        // `NaN`/`Infinity` a hand-crafted frame can carry, which would come
        // back through `JSON.stringify` as a literal `null` and poison the
        // client's own arithmetic.
        // THROUGH `rawSend`, LIKE EVERY OTHER SEND, and this is not tidiness.
        // A pong is the most frequent frame the relay originates (one per
        // client ping, every `PING_INTERVAL_MS`), so a bare try/catch here
        // meant a socket whose sends all throw produced no count, no line and
        // no termination through the ONE path it was still being written to.
        // The reverse mattered just as much: a pong that SUCCEEDS is
        // evidence the transport works, and outside `rawSend` it never
        // cleared the consecutive-failure run, so two failed snapshots, one
        // delivered pong and one more failed snapshot killed a socket that
        // had just proved itself.
        if (Number.isFinite(parsed.n) && Number.isFinite(parsed.c)) {
          rawSend(encodePong(parsed.n as number, parsed.c as number));
        }
      } catch {
        // A malformed ping is dropped in silence. It has already paid a
        // token, and this path is client-rate, so it is counted on nothing
        // and logged nowhere.
      }
      return;
    }
    let inputs: ClientInput[];
    try {
      inputs = decodeInput(data);
    } catch {
      // A decoder throw is the signature of a malformed or hostile frame
      // (a truncated packet, a wrong protocol version, a crafted length),
      // and it is the one abuse signal the rate limiter cannot see, since
      // a well-paced stream of garbage never trips the bucket at all.
      // Counted through the hook, never logged, for the same client-rate
      // reason as the drop above.
      try {
        onBadInput?.();
      } catch {
        // see the observability-seam note on RelayOptions
      }
      return;
    }
    // An empty window is NOT bad input. A decoder legitimately returns
    // nothing for a frame that carried no applicable records, so counting
    // it as malformed would bury the real signal under ordinary traffic.
    if (inputs.length === 0) return;
    const envelope: RoomEnvelope = { t: 'in', pid, w: inputs };
    redis.publish(keys.in, JSON.stringify(envelope)).catch(notePublishFailure);
  });

  socket.on('pong', () => {
    // A protocol pong is answered by the peer's network stack below its own
    // JavaScript, which is exactly what makes it useful: it is the one
    // liveness signal that still arrives from a BACKGROUNDED browser tab,
    // whose timers (and therefore its own `message` sends) the browser may
    // have throttled or paused entirely.
    lastInboundAt = Date.now();
  });

  socket.on('close', (...args: unknown[]) => {
    const code = typeof args[0] === 'number' ? (args[0] as number) : 1006;
    cleanup(code);
  });
  socket.on('error', (...args: unknown[]) => {
    log({ lvl: 'error', kind: 'relay.socket-error', room: roomId, pid, meta: { error: String(args[0]) } });
    cleanup(1006);
  });

  return handle;
}

export interface AdmissionOptions {
  redis: RedisLike;
  roomId: string;
  pid: string;
  /** The durable identity behind this pid (a device id, an account id): what the per-subject socket cap is keyed on. */
  subject: string;
  namespace?: string | undefined;
  /**
   * Namespace for the per-subject connection registry key, which is
   * `{connNamespace}:conns:{subject}`. Defaults to `namespace`, i.e. today's
   * behaviour byte for byte. AN EMPTY STRING MEANS NO PREFIX AND NO
   * SEPARATOR AT ALL, producing a bare `conns:{subject}`.
   *
   * This is separate from `namespace` because the two are not the same kind
   * of thing. Room keys are per-room and per-deployment, so namespacing them
   * is free. The connection registry is keyed on a DURABLE SUBJECT (a device
   * id, an account id) and is therefore very likely to be a key an adopting
   * host already writes, reads, and, critically, ENUMERATES ELSEWHERE.
   *
   * The elsewhere is the part that is not obvious and is why this option
   * exists at all. A host with a data-deletion path typically enumerates
   * every key holding a subject's data by name in order to erase it, and
   * that enumeration is usually backing a PUBLISHED PRIVACY COMMITMENT.
   * Silently moving the socket-cap key under this library's room namespace
   * breaks that in one of two ways, and neither announces itself:
   *
   *   - the deletion path keeps deleting the OLD key, which nothing writes
   *     any more, so the new key survives erasure and a published promise
   *     to delete a user's data is now false; or
   *   - the deletion path is updated and the CAP moves instead, counting a
   *     namespaced key nothing else has ever written, so it reads zero
   *     forever and `maxSocketsPerSubject` silently enforces nothing.
   *
   * There is a third cost even when both are handled: during a rollout both
   * key shapes are live at once, a subject's sockets are split across them,
   * and the effective cap is DOUBLED for the duration.
   *
   * So: point this at the key shape you already have. The `conns` middle
   * segment is fixed; only the prefix is configurable, which is enough to
   * reproduce both a namespaced and a bare pre-existing key.
   */
  connNamespace?: string | undefined;
  maxPlayers: number;
  maxSocketsPerSubject?: number | undefined;
  /** How old an entry in the connection registry (see `connNamespace` for the key) may be before it is pruned as abandoned. Default 30s. */
  connStaleMs?: number | undefined;
}

export interface AdmissionResult {
  admit: boolean;
  reason?: 'full' | 'conn-limit' | undefined;
  /**
   * A caller that admits this connection should `ZADD` this member into
   * `connKey` scored by `Date.now()`, re-score it on its own heartbeat
   * cadence to keep it alive, and `ZREM` it on close. `checkAdmission`
   * itself never performs that write: it is a QUERY, not a registration, so
   * a rejected connection never has to be unregistered again.
   */
  connId: string;
  connKey: string;
  /**
   * False when the per-user socket cap could NOT be evaluated on this
   * attempt, i.e. the connection was let through WITHOUT that cap having
   * been applied. `admit: true` on its own does not say which of those two
   * things happened, and the difference matters.
   *
   * THE CAP DEGRADES SILENTLY OTHERWISE, DURING A REDIS FAULT, WHICH IS
   * EXACTLY WHEN IT IS LOAD BEARING. A `pipeline().exec()` resolves with a
   * `[error, reply]` pair PER COMMAND and does not reject when one of them
   * fails, so a `ZCARD` that errored used to arrive here as `undefined`,
   * slide past a `typeof === 'number'` check, and disable the cap for that
   * admission with nothing said anywhere. That cap is not a nuisance
   * control: every socket holds its own Redis subscriber connection, so one
   * client opening sockets without limit can exhaust a managed plan's
   * concurrent connection ceiling and take the ROOM TICKER's subscriber
   * down with it, which is a total outage rather than a personal one.
   *
   * FAILING OPEN IS STILL THE RIGHT ANSWER and this field is not a step
   * toward changing it. Failing closed would lock every user out of a
   * healthy deployment over a Redis blip, which is worse than the thing
   * being prevented. What was wrong was failing open INVISIBLY. Log it,
   * meter it, or shed load on it; a run of these is the signal that the
   * cap is not currently enforcing anything.
   *
   * The stale-entry prune counts too, not only the count itself. Without
   * it the set still holds members for sockets that are long gone, so the
   * count reads high and would refuse a legitimate reconnect: a decision
   * made on data known to be stale in the REFUSING direction is not one
   * this function is willing to make.
   */
  socketCapEvaluated: boolean;
}

const DEFAULT_MAX_SOCKETS_PER_SUBJECT = 6;
/**
 * How old an entry in the connection registry may be before this function
 * prunes it as abandoned. Exported because `admission.ts`'s touch cadence is
 * chosen AGAINST it (a live socket must re-score itself several times over
 * inside this window), and a test asserting that relationship should read the
 * real number rather than a copy of it that cannot go stale in step.
 */
export const DEFAULT_CONN_STALE_MS = 30_000;

/**
 * Should a new socket be admitted to a room. Two independent checks, run in
 * ONE pipeline round trip:
 *
 * CAPACITY COMES FROM THE STATS KEY, NEVER FROM THE META HASH, and this is
 * the single most important thing in this function. `keys.stats` is written
 * by a LIVE ticker on a short TTL, so a room with no running ticker reads as
 * empty automatically; `keys.meta` has no such TTL of its own and persists
 * across a ticker dying. If admission read capacity from meta, a ticker that
 * died hard while players were present would leave a PERMANENTLY phantom-full
 * room: nobody could ever join it again, because the meta hash never clears
 * itself. Worse, a room-assignment balancer (see `balancer.ts`) already
 * reads the stats key for the same purpose, so reading meta HERE would let
 * the two permanently disagree: the balancer keeps handing out a room this
 * function keeps rejecting, and a client's bounded re-assign loop strands
 * every new joiner on "full" with no way to heal. The meta hash is consulted
 * ONLY to recognise a REJOIN (a reconnecting player who is already present),
 * which it can still do correctly even while stale, because a rejoin must
 * always be admitted regardless of how full the room reads.
 *
 * FAILS OPEN on any Redis error: a monitoring failure (the capacity check
 * itself) must never become an outage (nobody can join at all).
 */
export async function checkAdmission(opts: AdmissionOptions): Promise<AdmissionResult> {
  const {
    redis,
    roomId,
    pid,
    subject,
    namespace,
    connNamespace,
    maxPlayers,
    maxSocketsPerSubject = DEFAULT_MAX_SOCKETS_PER_SUBJECT,
    connStaleMs = DEFAULT_CONN_STALE_MS,
  } = opts;

  const keys = roomKeys(roomId, namespace);
  // `?? namespace ?? DEFAULT_NAMESPACE` rather than `?? ns`, so that an
  // explicitly empty `connNamespace` survives: `''` is not nullish, so it
  // wins the coalesce and the ternary below then drops the separator too.
  // Written this way deliberately, because the obvious `connNamespace || ns`
  // would treat the empty string as "unset" and quietly hand back the
  // namespaced key the option exists to avoid.
  const connNs = connNamespace ?? namespace ?? DEFAULT_NAMESPACE;
  const connKey = connNs === '' ? `conns:${subject}` : `${connNs}:conns:${subject}`;
  const connId = randomUUID();

  try {
    const pipe = redis.pipeline();
    pipe.get(keys.stats);
    // HEXISTS, not HGETALL, and the difference is not cosmetic: this runs on
    // the JOIN PATH OF EVERY SOCKET, and the only thing the result is used
    // for is the boolean below. HGETALL pulls the entire roster to answer
    // it, so on a full room this trades one integer for up to `maxPlayers`
    // JSON blobs of name and appearance metadata, per join, on the network
    // egress axis that managed Redis plans actually bill. It is also the
    // cheaper answer under the pathological case, a room whose roster is
    // large precisely because it is being hammered with joins.
    //
    // It removes a trust-boundary footgun as a side effect. The HGETALL
    // version had to reach for `hasOwnProperty.call`, because a bare
    // `pid in metaRaw` on a plain object matches INHERITED keys and a pid of
    // `constructor` or `__proto__` would have read as present and been
    // admitted past a full room. HEXISTS asks Redis, which has no prototype
    // chain, so the class of bug cannot be reintroduced here by a tidy-up.
    pipe.hexists(keys.meta, pid);
    pipe.zremrangebyscore(connKey, '-inf', Date.now() - connStaleMs);
    pipe.zcard(connKey);
    const results: Array<[Error | null, unknown]> = await pipe.exec();

    const statsRaw = results[0]?.[1] as string | null;
    const rejoinRaw = results[1]?.[1];
    const socketCount = results[3]?.[1] as number;

    // THE PER-COMMAND ERRORS, READ RATHER THAN DISCARDED. `exec()` resolves
    // with a `[error, reply]` pair per command and does NOT reject when one
    // of them fails, so everything above is a reply that may never have
    // happened. See `AdmissionResult.socketCapEvaluated` for what that cost
    // and why the answer is to report it rather than to start refusing.
    const pruneErr = results[2]?.[0] ?? null;
    const countErr = results[3]?.[0] ?? null;
    const socketCapEvaluated = pruneErr === null && countErr === null && typeof socketCount === 'number';

    // ioredis answers HEXISTS with a number; accept the string form too, so
    // an alternative `RedisLike` that returns raw protocol replies is not
    // silently read as "not present" (which would refuse every rejoin into
    // a full room, the one case a rejoin must always win).
    const alreadyPresent = rejoinRaw === 1 || rejoinRaw === '1';

    if (!alreadyPresent) {
      let players = 0;
      if (typeof statsRaw === 'string') {
        try {
          const parsed = JSON.parse(statsRaw) as { players?: unknown };
          if (typeof parsed.players === 'number') players = parsed.players;
        } catch {
          players = 0; // corrupt stats reads as empty, matching the balancer's own posture
        }
      }
      if (players >= maxPlayers) {
        return { admit: false, reason: 'full', connId, connKey, socketCapEvaluated };
      }
    }

    if (socketCapEvaluated && socketCount >= maxSocketsPerSubject) {
      return { admit: false, reason: 'conn-limit', connId, connKey, socketCapEvaluated };
    }

    return { admit: true, connId, connKey, socketCapEvaluated };
  } catch {
    // The whole pipeline failed rather than one command in it, so nothing was
    // evaluated at all. Same posture, same field.
    return { admit: true, connId, connKey, socketCapEvaluated: false };
  }
}
