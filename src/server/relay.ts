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
 */

/**
 * The structural minimum a socket needs to expose. Its `readyState` numbers
 * deliberately mirror the WebSocket standard (0 CONNECTING, 1 OPEN, 2
 * CLOSING, 3 CLOSED), the same numbering both browsers and the `ws` package
 * use, so a real adapter needs no translation layer at all.
 */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string | Uint8Array | Buffer): void;
  close(code?: number, reason?: string): void;
  /** Force-closes without a handshake. See the liveness section below for why this, not `close`, is what a silent socket gets. */
  terminate?(): void;
  ping?(): void;
  on(ev: 'message' | 'close' | 'error' | 'pong', cb: (...args: unknown[]) => void): void;
}

export interface RelayOptions {
  socket: RelaySocket;
  /** The shared command client (publishes join/leave/input, reads no state itself). */
  redis: RedisLike;
  /** Builds this socket's own dedicated subscriber for `keys.out`/`keys.metaout`. */
  createSubscriber(): Subscriber;
  roomId: string;
  pid: string;
  namespace?: string;
  /** Sent once (and re-sent as the join heartbeat) on the `join` envelope. */
  joinMeta?: Record<string, unknown>;
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
  metaSeedPayload?(map: Record<string, unknown>): unknown;
  /** Turns one inbound frame into zero or more inputs. Throwing or returning `[]` rejects the frame silently (it is still counted toward liveness). */
  decodeInput(data: ArrayBuffer): ClientInput[];
  /** Starts a ticker for this room. Must carry a spawn token; see `session.ts`. */
  spawnTicker(roomId: string): Promise<unknown>;
  /** How often the join heartbeat republishes and the liveness/ping check runs. Default 1000ms. */
  heartbeatMs?: number;
  /** Base interval between "does this room have a ticker" checks. Default 1000ms. */
  tickerCheckMs?: number;
  /** Random jitter added to each ticker-check interval. Default 1000ms. See the scheduling comment below for why this matters more than the base interval. */
  tickerCheckJitterMs?: number;
  /** How long with no inbound frame at all before the socket is presumed dead. Default 45000ms. */
  livenessTimeoutMs?: number;
  /** Inbound token-bucket capacity. Default 40. */
  inboundCapacity?: number;
  /** Inbound token-bucket refill rate. Default 25/s. */
  inboundRefillPerSecond?: number;
  log?: Logger;
  onClose?(code: number): void;

  // --- observability seams ---
  //
  // The three hooks below are the ONLY way a host can see the abuse path
  // the rate limiter and the decoder exist for. Without them the relay is
  // silent by design on exactly the events worth watching: the bucket
  // rejects a frame BEFORE `decodeInput` ever runs, and a decoder that
  // throws is swallowed by a bare catch, so neither reaches the host's own
  // `decodeInput` and neither reaches the log (correctly, see below).
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
  onRateDrop?(): void;
  /** Fires when `decodeInput` THROWS. A decoder returning `[]` is a legitimate empty window, not bad input, and does not fire this. Count it; never log or persist per call. */
  onBadInput?(): void;
  /** Fires when a JOIN or INPUT publish to `keys.in` fails, the latter being the client-rate path. Count it; never log or persist per call. The library itself logs these COALESCED on the heartbeat, see `flushPublishFailures`. The `leave` publish in cleanup is deliberately not included: it is best-effort teardown, fires once, and there is nothing left to observe it by then. */
  onPublishFailed?(error: unknown): void;
}

export interface RelayHandle {
  close(code?: number): void;
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
 * Attaches the relay behaviour to one already-open socket. Synchronous by
 * design: a socket's upgrade callback is synchronous, and this function's
 * own asynchronous work (subscribing, seeding the roster) is threaded
 * through `.then()` rather than awaited, so the caller never has to choose
 * between "wait for the relay to be ready" and "start forwarding messages
 * immediately".
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
    heartbeatMs = 1000,
    tickerCheckMs = 1000,
    tickerCheckJitterMs = 1000,
    livenessTimeoutMs = 45_000,
    inboundCapacity = 40,
    inboundRefillPerSecond = 25,
    log = defaultLog,
    onClose,
    onRateDrop,
    onBadInput,
    onPublishFailed,
  } = opts;

  const keys = roomKeys(roomId, namespace);
  const bucket = new TokenBucket({ capacity: inboundCapacity, refillPerSecond: inboundRefillPerSecond });

  let closed = false;
  let lastInboundAt = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let tickerCheckTimer: ReturnType<typeof setTimeout> | null = null;

  const sub = createSubscriber();

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
  let publishFailures = 0;
  let lastPublishError: string | null = null;

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

  function flushPublishFailures(): void {
    if (publishFailures === 0) return;
    const count = publishFailures;
    const error = lastPublishError;
    publishFailures = 0;
    lastPublishError = null;
    log({ lvl: 'error', kind: 'relay.publish-failed', room: roomId, pid, meta: { count, error } });
  }

  function publishJoin(): void {
    const envelope: RoomEnvelope = { t: 'join', pid, meta: joinMeta };
    redis.publish(keys.in, JSON.stringify(envelope)).catch(notePublishFailure);
  }

  function seedRoster(): void {
    redis
      .hgetall(keys.meta)
      .then((raw) => {
        if (closed) return;
        const map: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw)) {
          try {
            map[k] = JSON.parse(v);
          } catch {
            // a corrupt single field must not blank the whole seed
          }
        }
        // The host's formatter, if any, decides the client-visible shape;
        // see `metaSeedPayload` for why that seam exists. A formatter that
        // THROWS lands in the `.catch` below and is reported as a seed
        // failure, which is correct: this path runs at most twice per
        // socket, so it is not client-rate and a real log line is affordable.
        const payload = metaSeedPayload ? metaSeedPayload(map) : { t: 'meta', seed: true, map };
        // `JSON.stringify` returns undefined for `undefined` (and for a bare
        // function or symbol) despite its lying type. Suppressing the frame
        // beats sending the four characters "undefined" down a control
        // channel, and it gives a host a deliberate way to opt out of the
        // seed entirely when it seeds the roster by some other route.
        const frame = JSON.stringify(payload) as string | undefined;
        if (frame === undefined) return;
        socket.send(frame);
      })
      .catch((err) => log({ lvl: 'warn', kind: 'relay.meta-seed-failed', room: roomId, pid, meta: { error: String(err) } }));
  }

  function ensureTicker(): void {
    redis
      .get(keys.lease)
      .then((leaseValue) => {
        if (closed) return;
        if (shouldSpawnTicker(leaseValue)) {
          spawnTicker(roomId).catch((err) =>
            log({ lvl: 'error', kind: 'relay.spawn-failed', room: roomId, pid, meta: { error: String(err) } })
          );
        }
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

  // --- pub/sub forwarding ---
  //
  // Snapshots (keys.out) are forwarded as raw bytes via the buffer-preserving
  // event, never decoded to a JS string first: a binary snapshot codec run
  // through ioredis's normal string-decoding `message` event would be
  // corrupted by the lossy encode/decode round trip. Roster/control traffic
  // (keys.metaout) is always JSON text this library itself publishes, so the
  // plain string event is the right one for it, and forwarding it with
  // `socket.send(string)` is what makes the client receive it as a TEXT
  // frame rather than a binary one, matching the "binary snapshots, text
  // control messages" convention control channels use throughout.
  sub.on('messageBuffer', (channelBuf: unknown, messageBuf: unknown) => {
    if (closed) return;
    const channel = Buffer.isBuffer(channelBuf) ? channelBuf.toString('utf8') : String(channelBuf);
    if (channel !== keys.out || !Buffer.isBuffer(messageBuf)) return;
    try {
      socket.send(messageBuf);
    } catch (err) {
      log({ lvl: 'error', kind: 'relay.send-failed', room: roomId, pid, meta: { error: String(err) } });
    }
  });
  sub.on('message', (channel: unknown, message: unknown) => {
    if (closed) return;
    if (channel !== keys.metaout || typeof message !== 'string') return;
    try {
      socket.send(message);
    } catch (err) {
      log({ lvl: 'error', kind: 'relay.send-failed', room: roomId, pid, meta: { error: String(err) } });
    }
  });

  // FIRST publish, immediate and unconditional. Gating this on the subscribe
  // ack below (as the SECOND one has to be) would put a fresh subscriber's
  // TCP connect + TLS handshake + AUTH + SUBSCRIBE round trip in front of
  // the join the ticker needs to un-freeze this player: measured over a
  // second on a cold connection, during which a RECONNECTING player would
  // sit admitted-but-frozen server-side while their own client predicts
  // motion nobody is simulating.
  publishJoin();
  seedRoster();

  const subscribed = sub
    .subscribe(keys.out, keys.metaout)
    .then(() => {
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
      publishJoin();
      seedRoster();
    })
    .catch((err) => {
      log({ lvl: 'error', kind: 'relay.subscribe-failed', room: roomId, pid, meta: { error: String(err) } });
      // Report-and-proceed: the first, unconditional publish/seed already
      // ran, so this socket is not completely stranded even though the
      // gated pair above never fires.
    });
  void subscribed;

  ensureTicker();
  scheduleTickerCheck();

  // The heartbeat timer does FOUR jobs, deliberately sharing one interval
  // rather than four: it re-publishes the join envelope (so a message lost
  // to the subscribe race above is not permanent, since the ticker's join
  // handling is idempotent), it flushes the coalesced publish-failure
  // count, it pings the socket, and it checks the liveness deadline. One
  // timer, one Redis command's worth of amortized cost, instead of four
  // independent schedules drifting against each other.
  heartbeatTimer = setInterval(() => {
    if (closed) return;
    publishJoin();
    // Fourth job, added with the coalesced publish counter: emit one line
    // for however many publishes failed since the last beat. This is the
    // cadence the client cannot drive, which is the whole point of putting
    // the flush here rather than at the failure site.
    flushPublishFailures();
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
    if (Date.now() - lastInboundAt > livenessTimeoutMs) {
      log({ lvl: 'warn', kind: 'relay.liveness-drop', room: roomId, pid });
      if (socket.terminate) socket.terminate();
      else socket.close(1006);
    }
  }, heartbeatMs);

  socket.on('message', (...args: unknown[]) => {
    if (closed) return;
    const data = args[0] as ArrayBuffer;
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
    const envelope: RoomEnvelope = { t: 'in', pid, w: inputs, ts: Date.now() };
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

  function cleanup(code: number): void {
    if (closed) return;
    closed = true;
    // TAIL FLUSH, before the timer that would otherwise have carried it is
    // cleared. Without this a socket that dies mid-outage loses every
    // publish failure it accumulated since the last beat, which is exactly
    // the window an operator most wants to see, and it silently
    // under-reports the failure right at the moment the room is losing a
    // player's input.
    flushPublishFailures();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (tickerCheckTimer) clearTimeout(tickerCheckTimer);
    redis.publish(keys.in, JSON.stringify({ t: 'leave', pid } satisfies RoomEnvelope)).catch(() => {});
    try {
      sub.disconnect();
    } catch {
      // best-effort teardown only
    }
    try {
      onClose?.(code);
    } catch (err) {
      log({ lvl: 'error', kind: 'relay.onClose-threw', room: roomId, pid, meta: { error: String(err) } });
    }
  }

  socket.on('close', (...args: unknown[]) => {
    const code = typeof args[0] === 'number' ? (args[0] as number) : 1006;
    cleanup(code);
  });
  socket.on('error', (...args: unknown[]) => {
    log({ lvl: 'error', kind: 'relay.socket-error', room: roomId, pid, meta: { error: String(args[0]) } });
    cleanup(1006);
  });

  return {
    close(code?: number): void {
      cleanup(code ?? 1000);
      try {
        socket.close(code);
      } catch {
        // the socket may already be gone; cleanup already ran regardless
      }
    },
  };
}

export interface AdmissionOptions {
  redis: RedisLike;
  roomId: string;
  pid: string;
  /** The durable identity behind this pid (a device id, an account id): what the per-subject socket cap is keyed on. */
  subject: string;
  namespace?: string;
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
  connNamespace?: string;
  maxPlayers: number;
  maxSocketsPerSubject?: number;
  /** How old an entry in the connection registry (see `connNamespace` for the key) may be before it is pruned as abandoned. Default 30s. */
  connStaleMs?: number;
}

export interface AdmissionResult {
  admit: boolean;
  reason?: 'full' | 'conn-limit';
  /**
   * A caller that admits this connection should `ZADD` this member into
   * `connKey` scored by `Date.now()`, re-score it on its own heartbeat
   * cadence to keep it alive, and `ZREM` it on close. `checkAdmission`
   * itself never performs that write: it is a QUERY, not a registration, so
   * a rejected connection never has to be unregistered again.
   */
  connId: string;
  connKey: string;
}

const DEFAULT_MAX_SOCKETS_PER_SUBJECT = 6;
const DEFAULT_CONN_STALE_MS = 30_000;

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
        return { admit: false, reason: 'full', connId, connKey };
      }
    }

    if (typeof socketCount === 'number' && socketCount >= maxSocketsPerSubject) {
      return { admit: false, reason: 'conn-limit', connId, connKey };
    }

    return { admit: true, connId, connKey };
  } catch {
    return { admit: true, connId, connKey };
  }
}
