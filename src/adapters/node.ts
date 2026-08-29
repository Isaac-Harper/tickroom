// Plain Node, no serverless platform anywhere in the loop. This file exists
// to prove a specific claim: the lease/checkpoint/relay architecture is not a
// Vercel workaround, it is a general answer to "how do many stateless
// invocations of a function agree on who is authoritative right now", and
// that answer is exactly as correct on a machine that never restarts as it is
// on a platform that kills your process every few minutes.
import type { Logger, RoomRuntime } from '../core/index.js';
import { normalizeRoomId } from '../core/index.js';
import type { RelaySocket, TickerOptions, TokenClaims } from '../server/index.js';
import { attachRelay, checkAdmission, createSubscriber, getRedis, runTicker, verifyToken } from '../server/index.js';
import type { VercelRelayRouteOptions } from './vercel.js';
import { registerConnection } from './vercel.js';

/**
 * Everything `VercelRelayRouteOptions` needs, minus the two fields that are
 * genuinely Vercel-route concepts: `upgradeWebSocket` (there is no upgrade
 * callback here, `ws`'s own `'connection'` event already hands over an open
 * socket) and `tickerUrl` (there is no HTTP hop to a separate route: a
 * long-lived process can just call `spawnTicker` directly, in process, the
 * way `examples/node-server/server.ts` does with its own `ensureTicker`).
 */
export type NodeRelayServerOptions = Omit<VercelRelayRouteOptions, 'upgradeWebSocket' | 'tickerUrl'> & {
  /**
   * Starts a ticker for this room, IN PROCESS. On Vercel this means an
   * authenticated HTTP request to a separate route; here it means running
   * (or ensuring you are already running) `runNodeTicker` for `roomId`. See
   * `examples/node-server/server.ts`'s `ensureTicker`, which guards a
   * `Set` of already-running rooms so a flood of connects cannot start the
   * same room's ticker loop twice.
   */
  spawnTicker(roomId: string): Promise<unknown>;
};

/**
 * Wires plain `ws` connections on an existing `WebSocketServer` (or anything
 * shaped like one: `wss` is taken untyped, by injection, exactly like
 * `upgradeWebSocket` in `vercel.ts`, so this module can be used without `ws`
 * ever being a dependency of this package) through the SAME admission and
 * relay logic the Vercel adapter uses.
 *
 * One genuine simplification versus the Vercel adapter, worth calling out
 * rather than silently duplicating the more defensive code: a Node `ws`
 * server's `'connection'` event fires only once the WebSocket handshake has
 * actually completed, so the socket is already `OPEN` by the time this
 * handler runs. There is no equivalent of `refuseSocket`'s immediate-plus-
 * deferred retry here, because the race it exists for (a callback firing
 * before the socket reaches `OPEN`) does not exist on this transport.
 */
export function attachNodeRelay(wss: any, opts: NodeRelayServerOptions): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  const {
    secret,
    isValidBase,
    fallbackRoom,
    namespace,
    maxRooms,
    maxPlayers,
    maxSocketsPerSubject,
    decodeInput,
    joinMeta,
    spawnTicker,
    log,
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
        ws.close(4001);
        return;
      }

      const roomId = normalizeRoomId(url.searchParams.get('room') ?? fallbackRoom, {
        isValidBase,
        fallback: fallbackRoom,
        maxRooms,
      });

      const redis = getRedis();
      const admission = await checkAdmission({
        redis,
        roomId,
        pid: claims.pid,
        subject: claims.sub,
        namespace,
        maxPlayers,
        maxSocketsPerSubject,
      });

      const socket = ws as RelaySocket;

      if (!admission.admit) {
        const reason = admission.reason ?? 'full'; // defensive; reason is always set when admit is false
        const code = reason === 'conn-limit' ? 4003 : 4002;
        try {
          socket.send(JSON.stringify({ t: reason === 'conn-limit' ? 'conn-limit' : 'room-full' }));
        } catch {
          // best effort, matching refuseSocket's own catch in vercel.ts
        }
        socket.close(code);
        return;
      }

      // Same registration discipline as the Vercel adapter, and for the same
      // reason: `checkAdmission` never writes, so an admitted connection has
      // to be ZADDed in, re-scored, and ZREMed on close by whoever admitted
      // it, or `maxSocketsPerSubject` never actually enforces anything. See
      // `registerConnection`'s own doc comment in vercel.ts.
      const stopRegistration = registerConnection(redis, admission.connKey, admission.connId);
      const meta = joinMeta ? joinMeta(claims, url) : undefined;

      attachRelay({
        socket,
        redis,
        createSubscriber,
        roomId,
        pid: claims.pid,
        namespace,
        joinMeta: meta,
        decodeInput,
        spawnTicker,
        log,
        onClose: () => {
          stopRegistration();
        },
      });
    } catch (err) {
      log?.({
        lvl: 'error',
        kind: 'node-relay.connection',
        msg: err instanceof Error ? err.message : String(err),
      });
      try {
        ws.close(1011);
      } catch {
        // the socket may already be gone
      }
    }
  });
}

export interface NodeTickerLoopOptions<TState, TEvent> {
  runtime: RoomRuntime<TState, TEvent>;
  roomId: string;
  namespace?: string;
  geomKey?(): string;
  onEvents?: TickerOptions<TState, TEvent>['onEvents'];
  onStats?: TickerOptions<TState, TEvent>['onStats'];
  log?: Logger;
  checkpointMs?: number;
  statsMs?: number;
  maxRunMs?: number;
  emptyGraceMs?: number;
  metaTtlS?: number;
  buildId?: string;
  /**
   * Keep re-running the ticker in this process across a `'duration'` or
   * `'lease-lost'` exit. Defaults to true. A caller wanting exactly one run
   * (a script, a test harness) sets this false and handles restart itself,
   * or does not restart at all.
   */
  restartOnExit?: boolean;
}

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
 * the "kill" is simulated by choice (an exit result of `'duration'` or
 * `'lease-lost'`) rather than forced by a platform, and this loop's only job
 * is to immediately hand the room back to a fresh run instead of leaving it
 * ticker-less.
 */
export async function runNodeTicker<TState, TEvent>(opts: NodeTickerLoopOptions<TState, TEvent>): Promise<void> {
  const restart = opts.restartOnExit ?? true;
  const redis = getRedis();

  for (;;) {
    const result = await runTicker<TState, TEvent>({
      runtime: opts.runtime,
      redis,
      createSubscriber,
      roomId: opts.roomId,
      namespace: opts.namespace,
      geomKey: opts.geomKey,
      onEvents: opts.onEvents,
      onStats: opts.onStats,
      log: opts.log,
      checkpointMs: opts.checkpointMs,
      statsMs: opts.statsMs,
      maxRunMs: opts.maxRunMs,
      emptyGraceMs: opts.emptyGraceMs,
      metaTtlS: opts.metaTtlS,
      buildId: opts.buildId,
      spawnSuccessor: async () => {
        // On a long-lived host the loop below IS the successor: looping back
        // to the top of `for (;;)` is the handoff, so there is nothing
        // separate to spawn. This still has to be provided (`runTicker`'s
        // own successor spawn is unconditional whenever players remain), it
        // just has nothing to do.
      },
    });

    if (!restart) return;

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
      case 'lease-lost':
        // Both mean go again immediately: this IS the handoff, the same one
        // a serverless host performs by re-invoking the ticker route. See
        // the function comment above for why running it in a tight loop
        // here is worth doing even on a host that was never about to be
        // killed.
        continue;
      default:
        // 'error': a genuine throw inside the loop, already logged by
        // `runTicker` itself via `log`. Back off briefly rather than
        // spinning straight back into whatever just failed.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
    }
  }
}
