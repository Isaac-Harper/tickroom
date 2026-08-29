// Next.js App Router + Vercel Functions wiring. Every route factory here is a
// thin translation from a platform `Request`/`Response` pair onto the
// platform-agnostic functions in `src/server/`, which own the actual logic
// (leasing, checkpointing, admission, relaying). Nothing in this file makes a
// decision `src/server` did not already make; it only speaks HTTP.
import type { ClientInput, Logger, RedisLike, RoomRuntime } from '../core/index.js';
import { normalizeRoomId } from '../core/index.js';
import type { RelaySocket, TickerOptions, TokenClaims } from '../server/index.js';
import {
  assignRoom,
  attachRelay,
  checkAdmission,
  createSubscriber,
  getRedis,
  makeSpawnToken,
  runTicker,
  verifySpawnToken,
  verifyToken,
} from '../server/index.js';

export interface VercelTickerRouteOptions<TState, TEvent> {
  runtime: RoomRuntime<TState, TEvent>;
  /** Shared with the relay via `makeSpawnToken`/`verifySpawnToken`. Never exposed to a browser. */
  secret: string;
  /** See `normalizeRoomId` in `core`: must recognise only base ids your registry actually serves. */
  isValidBase(base: string): boolean;
  fallbackRoom: string;
  namespace?: string;
  maxRooms?: number;
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
}

/**
 * Handles a GET to your ticker route (`/api/ticker?room=lobby&k=<spawn token>`).
 * The connection function that spawns this route is the only intended caller;
 * an anonymous request must never be able to spin up a 20Hz tick loop, which
 * is exactly what `verifySpawnToken` exists to refuse.
 */
export function createTickerRoute<TState, TEvent>(
  opts: VercelTickerRouteOptions<TState, TEvent>
): (req: Request) => Promise<Response> {
  const {
    runtime,
    secret,
    isValidBase,
    fallbackRoom,
    namespace,
    maxRooms,
    geomKey,
    onEvents,
    onStats,
    log,
    checkpointMs,
    statsMs,
    maxRunMs,
    emptyGraceMs,
    metaTtlS,
    buildId,
  } = opts;

  return async function tickerRoute(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const roomId = normalizeRoomId(url.searchParams.get('room') ?? fallbackRoom, {
      isValidBase,
      fallback: fallbackRoom,
      maxRooms,
    });

    // Checked AFTER normalizing the room id: a spawn token is bound to the
    // CANONICAL room id, so verifying against the raw, unvalidated query
    // param would let a request name an id the token was never issued for
    // and still pass, if the two happened to normalize to the same room.
    //
    // This is deliberately the FIRST thing the route does, before a single
    // Redis command is issued. An anonymous, unauthenticated GET against this
    // route would otherwise buy a multi-minute authoritative sim loop plus
    // every Redis publish it makes for the rest of its run, for any room id
    // that parses: the single most expensive action available to someone who
    // has done nothing but guess a URL.
    const spawnToken = url.searchParams.get('k');
    if (!verifySpawnToken(roomId, spawnToken, secret)) {
      return new Response('forbidden', { status: 403 });
    }

    const redis = getRedis();

    const result = await runTicker<TState, TEvent>({
      runtime,
      redis,
      createSubscriber,
      roomId,
      namespace,
      geomKey,
      onEvents,
      onStats,
      log,
      checkpointMs,
      statsMs,
      maxRunMs,
      emptyGraceMs,
      metaTtlS,
      buildId,
      // Must issue an authenticated request back to THIS SAME ROUTE, carrying
      // a fresh spawn token bound to the successor's room id (never the
      // token this invocation itself was called with: that one authorized
      // exactly one spawn and reusing it would work today only by accident).
      // Cloning `url` and overwriting `room`/`k` keeps every other query
      // param (and the route's own path/origin) intact, so a deployment that
      // adds more query configuration to this route later does not have to
      // remember to thread it through here too.
      spawnSuccessor: async (targetRoomId: string): Promise<unknown> => {
        const spawnUrl = new URL(url);
        spawnUrl.searchParams.set('room', targetRoomId);
        spawnUrl.searchParams.set('k', makeSpawnToken(targetRoomId, secret));
        return fetch(spawnUrl.toString());
      },
    });

    // A lease already held by another instance is not an error, it is the
    // ordinary outcome of two invocations racing to become the ticker: the
    // loser reports 200 so the caller (the relay's ensure-ticker check) does
    // not treat a perfectly healthy room as a failure.
    if (result.reason === 'busy') {
      return new Response('busy', { status: 200 });
    }
    return new Response(result.reason, { status: 200 });
  };
}

/**
 * `next.config`/route-file `runtime`+`maxDuration` for the ticker route.
 * MUST be re-exported from the caller's actual route file (e.g.
 * `export const runtime = tickerRouteConfig.runtime`), not merely imported
 * and used: Next reads `runtime`/`maxDuration` as STATIC exports of the route
 * MODULE ITSELF at build time, and cannot see them through a value that was
 * merely assigned from a helper function's return, however identical the
 * value would be at runtime.
 */
export const tickerRouteConfig = { runtime: 'nodejs', maxDuration: 800 } as const;

export interface VercelRelayRouteOptions {
  secret: string;
  isValidBase(base: string): boolean;
  fallbackRoom: string;
  namespace?: string;
  maxRooms?: number;
  maxPlayers: number;
  maxSocketsPerSubject?: number;
  /**
   * URL of the ticker route created by `createTickerRoute`. A relative value
   * (the common case: both routes live in the same deployment) resolves
   * against this request's own origin, so `/api/ticker` is normally enough.
   * The relay only ever fetches this when it sees no live lease for the
   * room, carrying a freshly minted spawn token; see `RelayOptions.spawnTicker`.
   */
  tickerUrl: string;
  /** Turns one inbound frame into zero or more inputs. Throwing or returning `[]` rejects the frame silently (it is still counted toward liveness). */
  decodeInput(data: ArrayBuffer): ClientInput[];
  /** Called with the verified claims; return extra join metadata (a display name, a colour). */
  joinMeta?(claims: TokenClaims, url: URL): Record<string, unknown>;
  log?: Logger;
  /** Injected so this module never imports `@vercel/functions` directly. See the module comment for why. */
  upgradeWebSocket: (cb: (ws: any) => void) => Response; // eslint-disable-line @typescript-eslint/no-explicit-any
}

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
const CONN_TOUCH_MS = 10_000;
const CONN_KEY_TTL_S = 60;

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
 * Handles the WebSocket upgrade for `/api/ws?room=lobby&token=<session token>&pid=<pid>&h=<handle>`.
 *
 * `pid`/`h` ride the query string alongside the opaque token because
 * `verifyToken` needs the identity the caller ALREADY believes it is talking
 * to (see `session.ts`): checking the token's own signed claims against the
 * query string's pid/handle is what stops a token minted for one player
 * being replayed to authenticate as a different one just by forging the
 * query string.
 *
 * `upgradeWebSocket` is taken BY INJECTION rather than imported from
 * `@vercel/functions` directly. A hard import of a platform package here
 * would make the whole library refuse to even INSTALL on any host that is
 * not Vercel, which is backwards: nothing about the lease/checkpoint/relay
 * architecture is actually Vercel-specific, it merely happens to be where it
 * was first extracted from. `src/adapters/node.ts` is the proof: the exact
 * same admission and relay logic runs there over a plain `ws` server with no
 * serverless platform involved at all.
 */
export function createRelayRoute(opts: VercelRelayRouteOptions): (req: Request) => Promise<Response> {
  const {
    secret,
    isValidBase,
    fallbackRoom,
    namespace,
    maxRooms,
    maxPlayers,
    maxSocketsPerSubject,
    tickerUrl,
    decodeInput,
    joinMeta,
    log,
    upgradeWebSocket,
  } = opts;

  return async function relayRoute(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');
    const pid = url.searchParams.get('pid');
    const handle = Number(url.searchParams.get('h'));
    const claims: TokenClaims | null =
      pid && Number.isFinite(handle) ? verifyToken(token, { pid, handle }, { secret }) : null;
    if (!claims) {
      return new Response('unauthorized', { status: 401 });
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

    return upgradeWebSocket((ws: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      // The one sanctioned cast: `ws` arrives untyped from the injected
      // `upgradeWebSocket`, and this is the single seam where it is adapted
      // to the shape the relay actually needs, rather than casting the whole
      // options bag handed to `attachRelay` below.
      const socket = ws as RelaySocket;

      if (!admission.admit) {
        // `admission.reason` is only ever undefined when `admit` is true;
        // the fallback here is defensive, never actually reached.
        refuseSocket(socket, admission.reason ?? 'full');
        return;
      }

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
        spawnTicker: async (targetRoomId: string): Promise<unknown> => {
          const spawnUrl = new URL(tickerUrl, url);
          spawnUrl.searchParams.set('room', targetRoomId);
          spawnUrl.searchParams.set('k', makeSpawnToken(targetRoomId, secret));
          return fetch(spawnUrl.toString());
        },
        log,
        onClose: () => {
          stopRegistration();
        },
      });
    });
  };
}

/**
 * Sends the refusal frame and closes with the matching code, TWICE: once
 * immediately, and once more on a short timer.
 *
 * This is not belt-and-braces caution, it covers two real states a socket
 * can be in when this callback runs. On some runtimes the callback fires
 * while the handshake is still completing, i.e. before the socket reaches
 * `OPEN`, in which case an immediate `send`/`close` silently no-ops (nothing
 * is listening on the wire yet) and the connection would otherwise sit open,
 * unrefused, until the platform's duration cap finally kills it. The
 * deferred retry is the backstop for exactly that socket: by the time the
 * timer fires it has almost always reached `OPEN`, and the close actually
 * lands. The immediate attempt is not redundant either: it is what makes a
 * socket that WAS already open get the frame and close without waiting out
 * the timer for no reason.
 */
function refuseSocket(socket: RelaySocket, reason: 'full' | 'conn-limit'): void {
  const code = reason === 'conn-limit' ? 4003 : 4002;
  const frame = JSON.stringify({ t: reason === 'conn-limit' ? 'conn-limit' : 'room-full' });
  const attempt = (): void => {
    try {
      if (socket.readyState === WS_OPEN) {
        socket.send(frame);
        socket.close(code);
      }
    } catch {
      // Best effort: a socket that throws here is not one this route can do
      // anything further for, and the caller has nothing useful to do with
      // the error either.
    }
  };
  attempt();
  setTimeout(attempt, 250);
}

/** Same reasoning as `tickerRouteConfig`: re-export these as literal static exports of the relay route file. */
export const relayRouteConfig = { runtime: 'nodejs', maxDuration: 800 } as const;

export interface VercelBalancerRouteOptions {
  isValidBase(base: string): boolean;
  fallbackBase: string;
  maxPlayers: number;
  maxRooms?: number;
  namespace?: string;
}

/**
 * Handles `/api/room?base=lobby[&not=lobby~2]`, returning which room instance
 * a new joiner should connect to. `not` names the room instance that just
 * rejected this client (a full-room bounce): honoured only when it genuinely
 * parses as an instance of `base`, so a re-assign never lands back on the
 * same room but an untrusted value cannot exclude a key it has no business
 * naming (see `assignRoom`'s own handling of `exclude`).
 */
export function createBalancerRoute(
  opts: VercelBalancerRouteOptions
): (req: Request) => Promise<Response> {
  const { isValidBase, fallbackBase, maxPlayers, maxRooms, namespace } = opts;

  return async function balancerRoute(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const base = url.searchParams.get('base') ?? fallbackBase;
    if (!isValidBase(base)) {
      return jsonResponse({ error: 'unknown room base' }, 400);
    }

    const result = await assignRoom({
      redis: getRedis(),
      base,
      maxPlayers,
      maxRooms,
      namespace,
      exclude: url.searchParams.get('not'),
    });

    return jsonResponse(result, 200);
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
