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
  } = opts;

  const keys = roomKeys(roomId, namespace);
  const bucket = new TokenBucket({ capacity: inboundCapacity, refillPerSecond: inboundRefillPerSecond });

  let closed = false;
  let lastInboundAt = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let tickerCheckTimer: ReturnType<typeof setTimeout> | null = null;

  const sub = createSubscriber();

  function publishJoin(): void {
    const envelope: RoomEnvelope = { t: 'join', pid, meta: joinMeta };
    redis
      .publish(keys.in, JSON.stringify(envelope))
      .catch((err) => log({ lvl: 'error', kind: 'relay.publish-failed', room: roomId, pid, meta: { error: String(err) } }));
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
        socket.send(JSON.stringify({ t: 'meta', seed: true, map }));
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

  // The heartbeat timer does THREE jobs, deliberately sharing one interval
  // rather than three: it re-publishes the join envelope (so a message lost
  // to the subscribe race above is not permanent, since the ticker's join
  // handling is idempotent), it pings the socket, and it checks the
  // liveness deadline. One timer, one Redis command's worth of amortized
  // cost, instead of three independent schedules drifting against each
  // other.
  heartbeatTimer = setInterval(() => {
    if (closed) return;
    publishJoin();
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
      // Dropped, counted nowhere per-message (client-controlled input
      // arriving at up to 20-60Hz; logging every drop would hand an abuser
      // a log/cost amplifier for free). A host that wants an aggregate
      // signal should count this in its own `decodeInput`/`onClose`, or
      // wrap `socket` to observe it.
      return;
    }
    let inputs: ClientInput[];
    try {
      inputs = decodeInput(data);
    } catch {
      return;
    }
    if (inputs.length === 0) return;
    const envelope: RoomEnvelope = { t: 'in', pid, w: inputs, ts: Date.now() };
    redis
      .publish(keys.in, JSON.stringify(envelope))
      .catch((err) => log({ lvl: 'error', kind: 'relay.publish-failed', room: roomId, pid, meta: { error: String(err) } }));
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
  maxPlayers: number;
  maxSocketsPerSubject?: number;
  /** How old a `conns:{subject}` entry may be before it is pruned as abandoned. Default 30s. */
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
    maxPlayers,
    maxSocketsPerSubject = DEFAULT_MAX_SOCKETS_PER_SUBJECT,
    connStaleMs = DEFAULT_CONN_STALE_MS,
  } = opts;

  const keys = roomKeys(roomId, namespace);
  const ns = namespace ?? DEFAULT_NAMESPACE;
  const connKey = `${ns}:conns:${subject}`;
  const connId = randomUUID();

  try {
    const pipe = redis.pipeline();
    pipe.get(keys.stats);
    pipe.hgetall(keys.meta);
    pipe.zremrangebyscore(connKey, '-inf', Date.now() - connStaleMs);
    pipe.zcard(connKey);
    const results: Array<[Error | null, unknown]> = await pipe.exec();

    const statsRaw = results[0]?.[1] as string | null;
    const metaRaw = results[1]?.[1] as Record<string, string> | null;
    const socketCount = results[3]?.[1] as number;

    const alreadyPresent = !!(metaRaw && Object.prototype.hasOwnProperty.call(metaRaw, pid));

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
