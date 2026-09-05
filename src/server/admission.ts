// The admission protocol, in one place: check, refuse, register, attach.
//
// ONE DEFINITION, NOT THREE. This sequence and the close codes it uses lived
// in `adapters/vercel.ts`, were imported from there by `adapters/node.ts`
// (an adapter depending on another platform's adapter for a decision that is
// not platform-specific), and were hand-copied into the node example. The
// client latches a TERMINAL reconnect state off those very codes, so the
// three copies were free to drift into "the same" protocol answering
// differently per host, and nothing in any gate could see it. Everything
// here is platform-agnostic, exactly like the rest of `src/server/`: a host
// supplies a socket and a Redis client, and this file decides what happens
// to them.
//
// `checkAdmission` deliberately stays in `relay.ts` next to the relay it
// gates, because it is a pure QUERY over Redis; what moved here is the part
// that WRITES (the connection registry) and the part that speaks to the
// socket (the refusal frames), plus the one function that puts the whole
// sequence in the right order so a host cannot get it wrong by omission.

import { CLOSE_CODES, SERVER_FRAMES, type Logger, type RedisLike } from '../core/index.js';
import type { Subscriber } from './redis.js';
import {
  attachRelay,
  checkAdmission,
  type AdmissionOptions,
  type HostRelayOptions,
  type RelayHandle,
  type RelaySocket,
} from './relay.js';

const WS_OPEN = 1; // the WebSocket standard's OPEN readyState; both browsers and the `ws` package number it this way.

/**
 * `checkAdmission` (see `server/relay.ts`) is a QUERY, not a registration: it
 * hands back `connId`/`connKey` and performs no write of its own, precisely
 * so a REFUSED connection never has to be unregistered again. Neither it nor
 * `attachRelay` ever touches either value, which means an ADMITTED
 * connection is the caller's job to register, in full:
 *
 *   1. `ZADD` it into the set immediately, so it is counted from the instant
 *      it is let in.
 *   2. `EXPIRE` the whole key, so it cannot outlive every process that could
 *      ever have refreshed it.
 *   3. Re-score it on an interval, so a socket that is still alive never
 *      reads as stale to the pruning `checkAdmission` runs on every new
 *      admission attempt for the same subject.
 *   4. `ZREM` it the instant the socket closes, so a normal disconnect frees
 *      the slot right away instead of waiting out a timeout.
 *
 * Skip any of this and `maxSocketsPerSubject` enforces nothing: `zcard` would
 * forever read zero, because nothing ever put a member in the set it counts.
 * That is worse than a soft cap quietly not working, because every socket
 * the relay holds keeps its OWN Redis subscriber connection open for as long
 * as the socket lives (see the module comment in `server/redis.ts`). One
 * client opening sockets without limit does not just multiply its own
 * rate-limit allowance, it can exhaust a managed Redis plan's concurrent
 * connection ceiling and take the room's own ticker subscriber down with it:
 * a total outage for everyone in the room, not a personal inconvenience for
 * whoever caused it.
 *
 * The touch cadence (10s) is deliberately well under `checkAdmission`'s own
 * staleness window (`connStaleMs`, default 30s): a live socket's score is
 * always fresh enough to survive that pruning pass, and only a connection
 * that stops touching at all (a hard kill, a crash with no close event ever
 * firing) ages out and frees its slot. The key TTL (60s) is six touches'
 * worth of slack, so a couple of missed Redis round trips cannot make the
 * whole registration evaporate while the socket the entries describe is
 * still very much alive.
 */
export const CONN_TOUCH_MS = 10_000;
export const CONN_KEY_TTL_S = 60;

export function registerConnection(redis: RedisLike, connKey: string, connId: string): () => void {
  const touch = (): void => {
    redis.zadd(connKey, Date.now(), connId).catch(() => {});
    redis.expire(connKey, CONN_KEY_TTL_S).catch(() => {});
  };
  touch();
  const timer = setInterval(touch, CONN_TOUCH_MS);
  return () => {
    clearInterval(timer);
    redis.zrem(connKey, connId).catch(() => {});
  };
}

/**
 * Sends the refusal frame and closes with the matching code, on whichever of
 * THREE occasions comes first: now, the socket's own `'open'` event, or a
 * 250ms timer.
 *
 * This is not belt-and-braces caution, it covers the two real states a socket
 * can be in when this runs. On some runtimes the upgrade callback fires while
 * the handshake is still completing, i.e. before the socket reaches `OPEN`,
 * where a `send` either no-ops or throws depending on the transport. The
 * immediate attempt is what makes an already-open socket get the frame and
 * close without waiting for anything.
 *
 * THE `'open'` LISTENER IS THE HALF THAT WAS MISSING, and without it a slow
 * handshake was never refused at all: both remaining attempts were gated on
 * `OPEN`, and there were exactly two of them, so a socket that opened at
 * 300ms sat admitted-looking, unrefused and connected until the platform's
 * duration cap, in the ONE state the retry was written for. Opening is the
 * event that says the wire is usable, so it is the right thing to wait on;
 * the timer stays as the backstop for a transport that emits no such event.
 *
 * AND THE LAST ATTEMPT CLOSES WHETHER OR NOT THE SOCKET EVER OPENED. `ws`
 * accepts `close()` from CONNECTING (it aborts the handshake), and a socket
 * still connecting a quarter of a second later is exactly the one that would
 * otherwise be left. That path loses the CODE (an aborted handshake carries
 * no close status), which is a real cost and still strictly better than
 * losing the refusal: a client that reconnects is bounded by its own ladder,
 * a socket nobody ever closed is bounded by nothing.
 *
 * The frame and the code are a matched pair from `core/wire.ts`, which the
 * client reads from the same file: the frame is what a client can show a
 * player, and the code is what latches its reconnect ladder off as terminal.
 */
export function refuseSocket(socket: RelaySocket, reason: 'full' | 'conn-limit'): void {
  const code = reason === 'conn-limit' ? CLOSE_CODES.connLimit : CLOSE_CODES.capacity;
  const frame = JSON.stringify({ t: reason === 'conn-limit' ? SERVER_FRAMES.connLimit : SERVER_FRAMES.roomFull });
  // TWO LATCHES, NOT ONE, AND THAT IS THE WHOLE POINT OF THIS SHAPE. A
  // single "already refused" flag set before the send (or set by the catch)
  // makes a THROWING send look like a completed refusal: measured on a
  // socket whose `send` throws, the close codes after 320ms were `[]`, so
  // the connection stayed open, unrefused and with no relay attached to it,
  // through both the immediate attempt and the 'open' listener. The frame is
  // best effort; the CLOSE is the refusal, and nothing a send does may be
  // allowed to cancel it.
  let frameSent = false;
  let socketClosed = false;
  const attempt = (): void => {
    if (socketClosed) return;
    if (socket.readyState !== WS_OPEN) return;
    if (!frameSent) {
      try {
        socket.send(frame);
        frameSent = true;
      } catch {
        // The client loses the human-readable half and still gets the code,
        // which is the half its reconnect ladder actually reads.
      }
    }
    try {
      socket.close(code);
      socketClosed = true;
    } catch {
      // Left unlatched on purpose: the backstop below tries again.
    }
  };

  attempt();
  if (typeof socket.on === 'function') {
    try {
      socket.on('open', attempt);
    } catch {
      // A transport with no 'open' event is the ordinary case, not a fault:
      // the timer below covers it.
    }
  }
  setTimeout(() => {
    attempt();
    if (socketClosed) return;
    socketClosed = true;
    try {
      socket.close(code);
    } catch {
      // nothing left to try, and nothing useful to do with the error
    }
  }, 250);
}

export type AdmitSocketOptions = {
  socket: RelaySocket;
  /** The shared command client. */
  redis: RedisLike;
  /** Builds this socket's own dedicated subscriber; forwarded straight to `attachRelay`. */
  createSubscriber(): Subscriber;
  roomId: string;
  pid: string;
  /** The durable identity behind this pid (a device id, an account id): what the per-subject socket cap is keyed on. */
  subject: string;
  namespace?: string | undefined;
  log?: Logger | undefined;
  /**
   * Every relay option a HOST owns, forwarded wholesale. Taking the bag
   * rather than re-declaring its fields here is what stops this file
   * becoming the fourth place a relay option has to be remembered: the
   * observability hooks, `metaSeedPayload`, `lifetimeMs` and every bound
   * added to `RelayOptions` later are reachable through it on the day they
   * land. `onClose` is honoured and wrapped, never replaced.
   */
  relay: HostRelayOptions;
} & Pick<AdmissionOptions, 'connNamespace' | 'connStaleMs' | 'maxPlayers' | 'maxSocketsPerSubject'>;

/**
 * The whole admission sequence, in the one order that is correct: check,
 * report an unevaluated cap, refuse or register, attach.
 *
 * REGISTRATION IS PAIRED WITH THE RELAY HERE RATHER THAN LEFT TO THE HOST,
 * because it was left to the host and both shipped adapters plus the node
 * example got it wrong in the same way: they called `checkAdmission` and
 * never registered anything, so `zcard` counted an empty set forever and the
 * per-subject cap enforced nothing while looking like it did. Wrapping
 * `onClose` here is the other half of that pair: an admitted socket's
 * registration is stopped by the same event that ends the relay, so there is
 * no path where one outlives the other.
 *
 * Returns `null` when the socket was refused (the refusal frame and close
 * have already been sent), so a caller's own "did we admit" branch is a
 * null check rather than a second copy of the admission rules.
 */
export async function admitSocket(opts: AdmitSocketOptions): Promise<RelayHandle | null> {
  const {
    socket,
    redis,
    createSubscriber,
    roomId,
    pid,
    subject,
    namespace,
    log,
    relay,
    connNamespace,
    connStaleMs,
    maxPlayers,
    maxSocketsPerSubject,
  } = opts;

  const admission = await checkAdmission({
    redis,
    roomId,
    pid,
    subject,
    namespace,
    connNamespace,
    connStaleMs,
    maxPlayers,
    maxSocketsPerSubject,
  });

  // The per-user socket cap failing open is correct and must stay that way
  // (refusing during a Redis blip locks users out of a healthy deployment),
  // but it must never do so quietly: see `AdmissionResult.socketCapEvaluated`.
  // One line per admission is fine here because it only ever fires while
  // Redis is degraded, and a run of them is the only warning an operator
  // gets that the cap protecting the ticker's own subscriber connection is
  // not currently enforcing anything.
  if (!admission.socketCapEvaluated) {
    log?.({
      lvl: 'warn',
      kind: 'relay.socket-cap-unevaluated',
      room: roomId,
      pid,
      msg: 'admitted without applying maxSocketsPerSubject: the connection set could not be read',
    });
  }

  if (!admission.admit) {
    // `admission.reason` is only ever undefined when `admit` is true; the
    // fallback here is defensive, never actually reached.
    refuseSocket(socket, admission.reason ?? 'full');
    return null;
  }

  const stopRegistration = registerConnection(redis, admission.connKey, admission.connId);

  // THE REGISTRATION IS ALREADY WRITTEN BY THE TIME THE RELAY IS BUILT, so a
  // throw out of `attachRelay` leaves a ZADD nobody will ever ZREM: the
  // member ages out only after `connStaleMs`, and until it does it counts
  // against `maxSocketsPerSubject` for a socket that never existed. It is
  // not a theoretical throw either, it is the first-deploy one:
  // `createSubscriber` throws synchronously when `REDIS_URL` is unset, so a
  // misconfigured deployment burns a cap slot per attempt while every
  // attempt also fails.
  try {
    return attachRelay({
      socket,
      redis,
      createSubscriber,
      roomId,
      pid,
      namespace,
      ...relay,
      onClose: (code: number) => {
        stopRegistration();
        relay.onClose?.(code);
      },
    });
  } catch (err) {
    stopRegistration();
    throw err;
  }
}
