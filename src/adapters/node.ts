// Plain Node, no serverless platform anywhere in the loop. This file exists
// to prove a specific claim: the lease/checkpoint/relay architecture is not a
// Vercel workaround, it is a general answer to "how do many stateless
// invocations of a function agree on who is authoritative right now", and
// that answer is exactly as correct on a machine that never restarts as it is
// on a platform that kills your process every few minutes.
import type { Logger, RedisLike } from '../core/index.js';
import { CLOSE_CODES, normalizeRoomId } from '../core/index.js';
import type { HostTickerOptions, RelaySocket, Subscriber, TokenClaims } from '../server/index.js';
import { admitSocket, createSubscriber, getRedis, runTicker, verifyToken } from '../server/index.js';
import type { VercelRelayRouteOptions } from './vercel.js';

/** Longest raw `room` value a log line will carry. A refused id is untrusted input; it is evidence, not a payload. */
const RAW_ROOM_LOG_CHARS = 64;

/**
 * Reports a `room` query value that `normalizeRoomId` refused, ONCE per
 * connection. The twin of `createRelayRoute`'s own; see the long comment on
 * that one for what a silent refusal actually costs (a client whose session
 * says one room while its snapshots come from another, with every signal on
 * both ends reading healthy).
 *
 * DUPLICATED RATHER THAN IMPORTED FROM `./vercel.js`, on purpose. This adapter
 * used to import a value from that one and the whole point of moving the
 * admission protocol into `server/admission.ts` was that an adapter must not
 * depend on another platform's adapter. Eight lines of formatting is the
 * cheaper of the two mistakes; the moment a THIRD host needs it, it belongs in
 * `core/ids.ts` beside `normalizeRoomId`, not here and not there.
 */
function logRoomNormalised(log: Logger | undefined, raw: string | null, room: string): void {
  if (!log || !raw || raw === room) return;
  // Guarded, like every other logger call in this library: this one runs
  // OUTSIDE the upgrade handler's own catch, so a host hook that throws would
  // otherwise turn a diagnostic into a failed request.
  try {
    log({
      lvl: 'warn',
      kind: 'relay.room-normalised',
      room,
      msg: 'the requested room id was refused and replaced by the fallback: check that maxRooms agrees across the balancer, relay and ticker routes',
      meta: { raw: raw.slice(0, RAW_ROOM_LOG_CHARS) },
    });
  } catch {
    // never throw out of a logger
  }
}

/**
 * Everything `VercelRelayRouteOptions` needs, minus the three fields that are
 * genuinely Vercel-route concepts: `upgradeWebSocket` (there is no upgrade
 * callback here, `ws`'s own `'connection'` event already hands over an open
 * socket), `tickerUrl` (there is no HTTP hop to a separate route: a
 * long-lived process can just call `spawnTicker` directly, in process, the
 * way `examples/node-server/server.ts` does with its own `ensureTicker`) and
 * `maxDurationS` (nothing here has a duration cap, so there is nothing to
 * derive a relay `lifetimeMs` from).
 *
 * `lifetimeMs` itself is still reachable, through `HostRelayOptions`, and is
 * passed through untouched: a process that is never killed has no reason to
 * expire its own sockets, but a host doing a rolling restart on a schedule
 * may well want the warm-swap announcement anyway, and only that host knows.
 *
 * Deriving from the Vercel type rather than restating its fields is the same
 * rule the Vercel type follows towards `HostRelayOptions`: an option added
 * one layer down is reachable from both adapters on the day it lands.
 */
export type NodeRelayServerOptions = Omit<
  VercelRelayRouteOptions,
  'upgradeWebSocket' | 'tickerUrl' | 'maxDurationS'
> & {
  /**
   * Starts a ticker for this room, IN PROCESS. On Vercel this means an
   * authenticated HTTP request to a separate route; here it means running
   * (or ensuring you are already running) `runNodeTicker` for `roomId`. See
   * `examples/node-server/server.ts`'s `ensureTicker`, which guards a
   * `Set` of already-running rooms so a flood of connects cannot start the
   * same room's ticker loop twice.
   */
  spawnTicker(roomId: string): Promise<unknown>;
  /**
   * The two clients, INJECTED. Omitted, this adapter reaches for the
   * library's own `getRedis()` and `createSubscriber` (so `REDIS_URL`, an
   * ioredis connection, the whole default), which is what a host on a real
   * Redis wants and what every existing caller keeps getting.
   *
   * They are here for the one shape a long-lived process can have and a
   * serverless one cannot: ONE PROCESS AND NO REDIS AT ALL. Pass
   * `createMemoryRedis()`'s pair and the relay runs against an in-process
   * store, with no service to stand up and no URL to configure. Read that
   * function's comment for what the trade actually is; it is not free.
   *
   * PASS BOTH OR NEITHER. They default independently, so supplying only one
   * leaves a command client and a subscriber pointed at DIFFERENT stores,
   * which is the failure this library's pub/sub path fails silently on: every
   * command lands, nothing is ever delivered, and the socket, the lease and
   * the room's stats key all keep reading healthy.
   */
  redis?: RedisLike | undefined;
  createSubscriber?: (() => Subscriber) | undefined;
};

/**
 * Wires plain `ws` connections on an existing `WebSocketServer` (or anything
 * shaped like one: `wss` is taken untyped, by injection, exactly like
 * `upgradeWebSocket` in `vercel.ts`, so this module can be used without `ws`
 * ever being a dependency of this package) through the SAME admission and
 * relay logic the Vercel adapter uses.
 *
 * "The same logic" is now literally the same CODE, which it was not before:
 * this file used to run its own copy of the check-warn-refuse-register-attach
 * sequence and imported `registerConnection` FROM `./vercel.js` to do it, so
 * one adapter depended on another platform's adapter for a decision that is
 * not platform-specific, and the refusal codes the client latches a terminal
 * reconnect state off were written out twice. Both halves now come from
 * `server/admission.ts`, which is the layer that has no platform in it at all.
 */
export function attachNodeRelay(wss: any, opts: NodeRelayServerOptions): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  const {
    secret,
    isValidBase,
    fallbackRoom,
    namespace,
    maxRooms,
    connNamespace,
    connStaleMs,
    maxPlayers,
    maxSocketsPerSubject,
    joinMeta,
    spawnTicker,
    // Destructured out rather than left in `relay`, because `admitSocket`
    // spreads that bag over its own `redis`/`createSubscriber` and a stray
    // copy in there would win by position rather than by intent.
    redis: hostRedis,
    createSubscriber: hostCreateSubscriber,
    ...relay
  } = opts;

  wss.on('connection', async (ws: any, req: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      // `req.url` on a Node HTTP request is a path-and-query string with no
      // scheme or host; the base passed to `URL` here is never dereferenced,
      // it only satisfies the constructor's requirement for an absolute URL.
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token');
      const pid = url.searchParams.get('pid');
      const handle = Number(url.searchParams.get('h'));
      // Same identity check as `createRelayRoute` in vercel.ts, and for the
      // same reason: `verifyToken` needs the pid/handle the caller already
      // believes it is talking to, so a token minted for one player cannot
      // be replayed to authenticate as a different one by forging the query
      // string alone.
      const claims: TokenClaims | null =
        pid && Number.isFinite(handle) ? verifyToken(token, { pid, handle }, { secret }) : null;
      if (!claims) {
        ws.close(CLOSE_CODES.closedByServer);
        return;
      }

      const rawRoom = url.searchParams.get('room');
      const roomId = normalizeRoomId(rawRoom ?? fallbackRoom, {
        isValidBase,
        fallback: fallbackRoom,
        maxRooms,
      });

      // Behind the token check, exactly like the Vercel route's: a log line
      // per connection is only safe when the connections are authenticated.
      logRoomNormalised(relay.log, rawRoom, roomId);

      // ONE CALL, and the whole admission protocol is inside it: the capacity
      // and per-subject checks, the warning when the socket cap could not be
      // evaluated, the refusal frame and matching close code, the connection
      // registration, and the unregister paired with the relay's own close.
      // Every one of those was hand-written here before, and the registration
      // half was the one both adapters and the example got wrong in the same
      // way (see `admitSocket`'s doc comment).
      //
      // A `null` return means refused; there is nothing further for this host
      // to do about it, so it is not branched on.
      await admitSocket({
        socket: ws as RelaySocket,
        // `getRedis()` stays LAZY here, inside the connection handler, not
        // resolved once at attach time: it throws when `REDIS_URL` is unset,
        // and a host that injected its own pair must never pay for a default
        // it did not ask for.
        redis: hostRedis ?? getRedis(),
        createSubscriber: hostCreateSubscriber ?? createSubscriber,
        roomId,
        pid: claims.pid,
        subject: claims.sub,
        namespace,
        log: relay.log,
        connNamespace,
        connStaleMs,
        maxPlayers,
        maxSocketsPerSubject,
        relay: {
          ...relay,
          joinMeta: joinMeta ? joinMeta(claims, url) : undefined,
          spawnTicker,
        },
      });
    } catch (err) {
      // This block is the last thing standing between a throw and an unhandled
      // rejection (the handler is a `ws` event listener, so nothing above it
      // catches), which is why BOTH statements in it are themselves guarded: a
      // host logger that throws, or a socket already torn down by whatever
      // failed, would otherwise re-raise the very rejection being swallowed.
      // `createRelayRoute` runs the identical shape inside its upgrade
      // callback; see the comment there for what is actually reachable.
      try {
        relay.log?.({
          lvl: 'error',
          kind: 'node-relay.connection',
          msg: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // never throw out of a logger
      }
      try {
        ws.close(1011); // the WebSocket standard's own internal-error code, not one of this library's.
      } catch {
        // the socket may already be gone
      }
    }
  });
}

export type NodeTickerLoopOptions<TState, TEvent> = HostTickerOptions<TState, TEvent> & {
  roomId: string;
  /**
   * Keep re-running the ticker in this process across a `'duration'`,
   * `'input-dead'` or `'lease-lost'` exit. Defaults to true. A caller wanting
   * exactly one run (a script, a test harness) sets this false and handles
   * restart itself, or does not restart at all.
   */
  restartOnExit?: boolean | undefined;
  /**
   * The two clients, injected, on exactly the terms
   * `NodeRelayServerOptions` states: omitted they are `getRedis()` and
   * `createSubscriber`, and a host running one process with no Redis passes
   * `createMemoryRedis()`'s pair here and the SAME pair to
   * `attachNodeRelay`. Two calls to `createMemoryRedis` are two disjoint
   * stores, so a ticker on one and a relay on the other is a room whose
   * snapshots nobody receives.
   */
  redis?: RedisLike | undefined;
  createSubscriber?: (() => Subscriber) | undefined;
};

/**
 * Runs the ticker in a loop, in this process, for as long as it keeps being
 * told to go again.
 *
 * THE CONTRAST WITH SERVERLESS IS WHAT MAKES THIS WORTH READING CAREFULLY. On
 * a long-lived host, the lease and the checkpoint look like belt and braces:
 * this process is not about to be killed, so what is the lease even for?
 * On serverless, the exact same two mechanisms are the ONLY reason a room
 * survives its host being killed every few minutes by the platform's own
 * duration cap: the lease is what lets a successor invocation know it is
 * safe to take over, and the checkpoint is what it takes over WITH. Nothing
 * in `runTicker` or `RoomRuntime` knows or cares which of these two hosts it
 * is running on, which is exactly the point: the same tick loop, unmodified,
 * is either a formality or the entire reliability story depending only on
 * who is calling it and how often that caller expects to be killed. Here,
 * the "kill" is simulated by choice (an exit result of `'duration'`,
 * `'input-dead'` or `'lease-lost'`) rather than forced by a platform, and
 * this loop's only job is to immediately hand the room back to a fresh run
 * instead of leaving it ticker-less.
 */
export async function runNodeTicker<TState, TEvent>(opts: NodeTickerLoopOptions<TState, TEvent>): Promise<void> {
  const {
    roomId,
    restartOnExit = true,
    redis: hostRedis,
    createSubscriber: hostCreateSubscriber,
    ...ticker
  } = opts;
  // `getRedis()` only when nothing was injected: it throws with no
  // `REDIS_URL`, and a no-Redis host has none to set.
  const redis = hostRedis ?? getRedis();
  const subscriberFactory = hostCreateSubscriber ?? createSubscriber;

  for (;;) {
    const result = await runTicker<TState, TEvent>({
      ...ticker,
      redis,
      createSubscriber: subscriberFactory,
      roomId,
      spawnSuccessor: async (_targetRoomId: string, _spawnOpts: { standby: boolean }) => {
        // On a long-lived host the loop below IS the successor: looping back
        // to the top of `for (;;)` is the handoff, so there is nothing
        // separate to spawn, and that is true of the STANDBY spawn as well as
        // the exit one. A standby exists to pay a cold start and an `init`
        // before the lease is free; this process has already paid both and
        // never gave them up, so `_spawnOpts.standby` has nothing to change.
        // The two-argument signature is kept so this stays a valid
        // `spawnSuccessor` rather than one that happens to compile.
      },
    });

    if (!restartOnExit) return;

    switch (result.reason) {
      case 'empty':
        // The room drained. Stop; the next connection's `spawnTicker` starts
        // a fresh loop.
        return;
      case 'busy':
        // Another owner holds the lease. In this process that means a
        // previous loop has not finished unwinding yet; back off rather than
        // spinning a tight loop against Redis while it does.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      case 'duration':
      case 'input-dead':
      case 'lease-lost':
        // All three mean go again immediately: this IS the handoff, the same
        // one a serverless host performs by re-invoking the ticker route. See
        // the function comment above for why running it in a tight loop here
        // is worth doing even on a host that was never about to be killed.
        //
        // `'input-dead'` belongs with `'duration'` rather than with the error
        // backoff below, and the reason is the one thing a fresh run does that
        // no retry-in-place could: the ticker's inbound subscriber is opened
        // once per run, so a subscription that stopped delivering is only
        // repaired by opening a new one. A room whose inputs are dead is a
        // room nobody can play, so it is repaired at once rather than after a
        // wait.
        continue;
      default:
        // 'error': a genuine throw inside the loop, already logged by
        // `runTicker` itself via `log`. Back off briefly rather than
        // spinning straight back into whatever just failed.
        //
        // THIS LOOP IS THE ONLY RETRY ON THIS HOST. `runTicker` deliberately
        // does NOT spawn a successor on an `'error'` exit, because on
        // serverless a successor would hit the identical failure and the pair
        // would spin at whatever rate a cold start allows. Here the same
        // reasoning applies to us: the 1s backoff is what keeps a
        // deterministic crash from becoming a hot loop, and the crash counter
        // `runTicker` keeps in Redis is what actually stops it, by refusing to
        // restore a checkpoint that has already crashed three runs in a row
        // and starting the room fresh instead.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
    }
  }
}
