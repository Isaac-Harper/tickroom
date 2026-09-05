// Next.js App Router + Vercel Functions wiring. Every route factory here is a
// thin translation from a platform `Request`/`Response` pair onto the
// platform-agnostic functions in `src/server/`, which own the actual logic
// (leasing, checkpointing, admission, relaying). Nothing in this file makes a
// decision `src/server` did not already make; it only speaks HTTP.
//
// THE OPTION BAGS ARE SPREAD, NEVER RE-LISTED FIELD BY FIELD. Both route
// option types used to name a hand-picked subset of the server option types,
// and a subset goes stale the moment anything is added one layer down: twenty
// `TickerOptions`/`RelayOptions` fields (`metaPayload`, `init`,
// `onGeomMismatch`, `statsLabels`, `metaSeedPayload`, `connNamespace`, every
// relay observability hook) were unreachable from the very route factories the
// README tells people to use, with no error anywhere, because a field a type
// does not name is simply never passed on. `HostTickerOptions` and
// `HostRelayOptions` are defined as "every option a HOST may set", so
// intersecting with them and spreading the result makes a new server option
// reachable from a route on the day it lands rather than on the day somebody
// remembers to copy the field through. The only fields these types declare
// themselves are the ones a ROUTE genuinely owns: the ones it derives from the
// request (the room id, the claims, the spawn callbacks) or from the platform
// (the duration caps below).
import type { Logger } from '../core/index.js';
import { MAX_TICKER_MS, RELAY_EXPIRY_LEAD_MS, normalizeBase, normalizeRoomId } from '../core/index.js';
import type {
  AdmitSocketOptions,
  HostRelayOptions,
  HostTickerOptions,
  RelaySocket,
  TokenClaims,
} from '../server/index.js';
import {
  admitSocket,
  assignRoom,
  createSubscriber,
  getRedis,
  makeSpawnToken,
  runTicker,
  verifySpawnToken,
  verifyToken,
} from '../server/index.js';

// Both were public under `tickroom/adapters/vercel` before the admission
// protocol moved to `src/server/admission.ts`, so they are re-exported rather
// than removed: a host that imported either one keeps working, and there is
// still exactly one definition of each.
export { registerConnection, refuseSocket } from '../server/index.js';

/** Longest raw `room` value a log line will carry. A refused id is untrusted input; it is evidence, not a payload. */
const RAW_ROOM_LOG_CHARS = 64;

/**
 * Reports a `room` query value that `normalizeRoomId` refused, ONCE per
 * request.
 *
 * `normalizeRoomId` answers a bad id with the FALLBACK rather than an error,
 * which is right (it is a trust boundary on a value interpolated into Redis
 * key names, and a hostile `?room=` must never become a key) and was silent,
 * which is not. The refusal that matters is not the hostile one, it is the
 * WELL-FORMED one: `maxRooms` is three independent options on three route
 * factories, each defaulting to `MAX_ROOMS_PER_BASE`, so a balancer at 50 and
 * a relay at 4 hand a client `lobby~7` and the relay quietly attaches it to
 * `lobby`. The client's session says one room, its snapshots come from
 * another, and every signal on both ends reads healthy: the socket is open,
 * the roster is populated, the tick rate is nominal, and the player is simply
 * in a game nobody else can see them in. Nothing in the system can notice,
 * because from each component's own point of view nothing went wrong.
 *
 * One line per REQUEST, never per message: this is on the join path, not the
 * input path, and both callers place it behind their own authentication so
 * the rate is not a client's to drive. See the invariant in AGENTS.md about
 * anything whose rate a client controls.
 */
function logRoomNormalised(log: Logger | undefined, kind: string, raw: string | null, room: string): void {
  if (!log || !raw || raw === room) return;
  // Guarded, like every other logger call in this library: this one runs
  // OUTSIDE the upgrade handler's own catch, so a host hook that throws would
  // otherwise turn a diagnostic into a failed request.
  try {
    log({
      lvl: 'warn',
      kind,
      room,
      msg: 'the requested room id was refused and replaced by the fallback: check that maxRooms agrees across the balancer, relay and ticker routes',
      meta: { raw: raw.slice(0, RAW_ROOM_LOG_CHARS) },
    });
  } catch {
    // never throw out of a logger
  }
}

/**
 * How much of the platform's duration cap the ticker route reserves for
 * shutting down cleanly, rather than spending on the tick loop.
 *
 * The loop is stopped by `maxRunMs`, and everything that makes a handoff
 * seamless happens AFTER that: the final checkpoint, the lease release, the
 * successor spawn (awaited but raced against `EXIT_SPAWN_WAIT_MS`, 3.5s, which
 * the ticker sizes to outlast this file's own `SPAWN_ACK_MS`), plus the
 * `standbyLeadMs` head start the standby successor was given. If the platform
 * kills the function before all of that lands, the room loses its last second
 * of state, holds a lease nobody released for the rest of the TTL, and in the
 * worst case has nobody spawned to take over: the exact failure the whole
 * handoff exists to prevent, arriving silently and once per cycle.
 */
export const TICKER_EXIT_MARGIN_MS = 30_000;

/**
 * The shortest tick loop this route will start.
 *
 * THE MARGIN IS A SUBTRACTION AND A SUBTRACTION GOES NEGATIVE. `maxDurationS`
 * is a number a host types, and a small one (a 10s plan limit, a typo, a
 * seconds/milliseconds mixup) derives a `maxRunMs` of -20000, which is not a
 * short ticker: it is a loop whose deadline has already passed, so every
 * invocation acquires the lease, exits `'duration'` immediately, releases, and
 * spawns a successor that does the same. A room that never simulates a tick,
 * at whatever rate a cold start allows, billed per invocation, with every
 * individual run reporting the healthiest possible exit reason. The explicit
 * `maxRunMs` path had a bound and the DERIVED one had none, which is backwards:
 * the derived value is the one no host ever looks at.
 *
 * 10s is not a recommendation, it is a floor. Below it the exit work (a
 * checkpoint, a release, a spawn) is most of the invocation and the handoff
 * happens more often than the checkpoint interval, so nothing about the design
 * holds. A deployment that genuinely wants a short cycle raises `maxDurationS`
 * to something the margin fits inside.
 */
export const MIN_TICKER_RUN_MS = 10_000;

/**
 * How long a STANDBY invocation of the ticker route polls for the lease before
 * giving up, i.e. what this route passes as `standbyMs`.
 *
 * It has to comfortably exceed the predecessor's `standbyLeadMs` (3000 by
 * default) plus the final checkpoint and the release, because the standby is
 * spawned that far ahead of the cap and must still be waiting when the lease
 * is actually let go. Too short and it gives up just before the handoff it
 * exists for; too long and a standby whose predecessor died without releasing
 * sits burning function time. 8s covers the default lead with a wide margin
 * and is still a fraction of a cycle.
 */
export const STANDBY_WAIT_MS = 8000;

/** The query parameter this route uses to tell a successor it is a STANDBY. */
const STANDBY_PARAM = 'standby';

/**
 * How long a spawn waits for an answer before reporting the request DELIVERED.
 *
 * A SPAWN IS A DELIVERY, NOT A CONVERSATION, and reading it as a conversation
 * put an error line in the log on every single room start. Both spawns in this
 * file are a `fetch` at a ticker route, and `createTickerRoute` does not
 * respond until `runTicker` RETURNS, because ending the response ends the
 * function: the answer to a spawn is the successor's WHOLE LIFE, 700s at the
 * default cap. Node's undici gives `fetch` a `headersTimeout` of 300000ms by
 * default, so a spawn that waits for that answer fails at 300s with
 * `TypeError: fetch failed` (cause `HeadersTimeoutError`) on a ticker that
 * started 300s earlier and is running the room perfectly. Measured on the real
 * deployment as a `relay.spawn-failed` on the first socket of every run, next
 * to the `ticker.restore` line from the very spawn it was reporting as failed,
 * and again on every standby handoff.
 *
 * 3000ms is a delivery receipt, not a health check: it only has to outlast
 * DNS, TLS and the platform accepting the request, and everything that means
 * the ticker never started (an unresolvable host, a refused connection, a 403
 * from Deployment Protection) lands well inside it. It is argued from the
 * network, so it is the number the ticker's `EXIT_SPAWN_WAIT_MS` (3500) is
 * sized around rather than the other way about: that budget has to be the
 * longer of the two or an exit spawn's rejection is never observed, and the
 * group in `vercel.test.ts` pins the ordering rather than an import doing it,
 * because the ticker must not depend on an adapter.
 *
 * THE CONNECTION IS LEFT OPEN AND ONLY THE WAIT IS DROPPED, rather than
 * cutting the request with `AbortSignal.timeout`. Vercel documents request
 * cancellation as OPT-IN, per function path, via `"supportsCancellation":
 * true` in `vercel.json`: on a default project a client abort is ignored and
 * aborting would be safe, and on a project that has switched it on the abort
 * would KILL the successor 3s into a cold start measured at 5 to 7 seconds.
 * That is a host config this library cannot read and does not own, and the
 * stake is the room's whole lifetime. Racing a timer instead leaves the
 * platform seeing byte for byte what it sees today (one idle connection per
 * spawn, dropped by undici at 300s) and removes only the false error.
 */
export const SPAWN_ACK_MS = 3000;

/** What a spawn resolves with once it is delivered and its answer left unread. See `SPAWN_ACK_MS`. */
export const SPAWN_DELIVERED = 'delivered';

/**
 * Issues a spawn request and resolves as soon as it has been DELIVERED.
 *
 * Resolves with the `Response` when one arrives inside `SPAWN_ACK_MS` (a 403
 * from Deployment Protection, a 200 from a route that lost the lease race:
 * both are the route's own answer, and handing them back unread is what this
 * spawn has always done with a non-2xx), with `SPAWN_DELIVERED` when none
 * does, and REJECTS only for a failure that lands before the receipt, which is
 * the only kind that means no ticker was started.
 */
function deliverSpawn(spawnUrl: string): Promise<unknown> {
  const attempt = fetch(spawnUrl);
  return new Promise<unknown>((resolve, reject) => {
    const receipt = setTimeout(() => resolve(SPAWN_DELIVERED), SPAWN_ACK_MS);
    // THE REJECTION HANDLER STAYS ATTACHED FOR THE REQUEST'S WHOLE LIFE, which
    // is the half that is easy to drop once nobody is waiting: the headers
    // timeout arrives 300s after this promise has already settled, and a
    // rejection with no handler on it is an unhandled rejection, which on Node
    // is a process-level event. Settling a promise twice is a no-op, so the
    // late arrival is simply swallowed here.
    attempt.then(
      (res) => {
        clearTimeout(receipt);
        resolve(res);
      },
      (err: unknown) => {
        clearTimeout(receipt);
        reject(err);
      }
    );
  });
}

export type VercelTickerRouteOptions<TState, TEvent> = HostTickerOptions<TState, TEvent> & {
  /** Shared with the relay via `makeSpawnToken`/`verifySpawnToken`. Never exposed to a browser. */
  secret: string;
  /** See `normalizeRoomId` in `core`: must recognise only base ids your registry actually serves. */
  isValidBase(base: string): boolean;
  fallbackRoom: string;
  maxRooms?: number | undefined;
  /**
   * The `maxDuration` this route file actually exports, in seconds. Defaults
   * to `tickerRouteConfig.maxDuration`.
   *
   * THIS IS THE ONE NUMBER THAT COUPLES THE LIBRARY TO THE PLATFORM, and it
   * used to be coupled by nothing at all: `tickerRouteConfig.maxDuration` was
   * 800 and `MAX_TICKER_MS` was 700s, two constants in two files that agreed
   * only by luck. A host on a plan capped below 700s, or one who simply
   * lowered `maxDuration` to control cost, got a platform kill every single
   * cycle with no final checkpoint, no lease release, no successor spawn and
   * no error: every room in the fleet losing a second of state and stalling
   * for the rest of the lease TTL, forever, with nothing anywhere reporting it.
   *
   * So `maxRunMs` is DERIVED from this by default (`maxDurationS * 1000 -
   * TICKER_EXIT_MARGIN_MS`), and a host that sets `maxRunMs` explicitly has
   * the fit checked at route creation instead of discovering it in production.
   */
  maxDurationS?: number | undefined;
};

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
    secret,
    isValidBase,
    fallbackRoom,
    maxRooms,
    maxDurationS = tickerRouteConfig.maxDuration,
    ...ticker
  } = opts;

  const platformCapMs = maxDurationS * 1000;

  // CHECKED AT ROUTE CREATION, WHICH IS MODULE EVALUATION, so a deployment
  // whose numbers do not fit fails on the first request rather than on every
  // handoff for the rest of its life. A ticker that outlives its margin does
  // not report an error, it reports nothing at all: the process is gone
  // mid-checkpoint and the only symptom is a room that stutters once a cycle.
  if (ticker.maxRunMs !== undefined && ticker.maxRunMs + TICKER_EXIT_MARGIN_MS > platformCapMs) {
    throw new Error(
      `createTickerRoute: maxRunMs (${ticker.maxRunMs}ms) leaves less than TICKER_EXIT_MARGIN_MS (${TICKER_EXIT_MARGIN_MS}ms) before this function's own maxDuration (${maxDurationS}s = ${platformCapMs}ms). ` +
        `The final checkpoint, the lease release and the successor spawn all happen after maxRunMs, so the platform would kill them. ` +
        `Lower maxRunMs to at most ${platformCapMs - TICKER_EXIT_MARGIN_MS}ms, or raise maxDurationS to match the maxDuration your route file exports.`
    );
  }

  // Derived as the SMALLER of the library's own measured default and what the
  // platform cap leaves after the exit margin. The cap only ever LOWERS the
  // lifetime: `MAX_TICKER_MS` (700s) is the value this architecture was
  // measured against, and a host raising `maxDuration` should not silently
  // get longer tickers out of it. A host that wants that passes `maxRunMs`.
  const maxRunMs = ticker.maxRunMs ?? Math.min(MAX_TICKER_MS, platformCapMs - TICKER_EXIT_MARGIN_MS);

  // CHECKED ON THE RESOLVED VALUE, NOT ON THE HOST'S INPUT, which is what
  // makes one check cover both doors. The fit check above only bounds
  // `maxRunMs` from ABOVE, so it waves through both a `maxDurationS` too small
  // for the margin to leave anything (the derived value goes negative) and an
  // explicit `maxRunMs` that is itself negative (subtracting a positive margin
  // from it can never exceed the cap, so it fits by arithmetic). Neither is a
  // short ticker; both are a ticker whose deadline has already passed.
  if (!(maxRunMs >= MIN_TICKER_RUN_MS)) {
    throw new Error(
      `createTickerRoute: maxRunMs resolves to ${maxRunMs}ms, below MIN_TICKER_RUN_MS (${MIN_TICKER_RUN_MS}ms). ` +
        `maxDurationS is ${maxDurationS}s (${platformCapMs}ms) and TICKER_EXIT_MARGIN_MS is ${TICKER_EXIT_MARGIN_MS}ms, which leaves ${platformCapMs - TICKER_EXIT_MARGIN_MS}ms for the loop itself. ` +
        `A ticker at or below zero exits 'duration' the instant it acquires the lease and spawns a successor that does the same, forever. ` +
        `Raise maxDurationS to at least ${(TICKER_EXIT_MARGIN_MS + MIN_TICKER_RUN_MS) / 1000}s.`
    );
  }

  return async function tickerRoute(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const rawRoom = url.searchParams.get('room');
    const roomId = normalizeRoomId(rawRoom ?? fallbackRoom, {
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

    // Reported only AFTER the token check, deliberately. It is one log line
    // per request, and emitting it in front of the 403 would let anyone who
    // can reach the URL drive the log volume by guessing room ids, which is
    // the same amplifier this route already refuses to pay a tick loop for.
    logRoomNormalised(ticker.log, 'ticker.room-normalised', rawRoom, roomId);

    // A STANDBY was spawned by the incumbent ticker `standbyLeadMs` before its
    // own cap, so it is EXPECTED to lose the acquire: the lease is still held
    // by the ticker that asked for it. Waiting is the entire point (it pays
    // its cold start and its `init` while it waits, so the handoff collapses
    // to one acquire), which is why the flag rides the spawn URL rather than
    // being a property of the route: the same route serves both kinds of
    // invocation and only the caller knows which one this is. Every OTHER
    // spawn, including every relay poll, wants today's fail-fast behaviour,
    // because those races have many losers and each loser waiting 8s is 8s of
    // paid-for nothing.
    const standby = url.searchParams.get(STANDBY_PARAM) === '1';

    const redis = getRedis();

    const result = await runTicker<TState, TEvent>({
      ...ticker,
      redis,
      createSubscriber,
      roomId,
      maxRunMs,
      // The route owns this one because only the URL knows which kind of
      // invocation this is. A host-supplied `standbyMs` still tunes how long a
      // standby waits; it is ignored on the ordinary path, where waiting at
      // all would be wrong.
      standbyMs: standby ? ticker.standbyMs ?? STANDBY_WAIT_MS : 0,
      // Must issue an authenticated request back to THIS SAME ROUTE, carrying
      // a fresh spawn token bound to the successor's room id (never the
      // token this invocation itself was called with: that one authorized
      // exactly one spawn and reusing it would work today only by accident).
      // Cloning `url` and overwriting `room`/`k` keeps every other query
      // param (and the route's own path/origin) intact, so a deployment that
      // adds more query configuration to this route later does not have to
      // remember to thread it through here too.
      //
      // The standby flag is SET AND DELETED rather than only set, because the
      // clone inherits it: a standby ticker spawning its own ordinary exit
      // successor would otherwise hand down a `standby=1` it was never asked
      // for, and that successor would poll for a lease its predecessor had
      // already released.
      spawnSuccessor: async (targetRoomId: string, spawnOpts: { standby: boolean }): Promise<unknown> => {
        const spawnUrl = new URL(url);
        spawnUrl.searchParams.set('room', targetRoomId);
        spawnUrl.searchParams.set('k', makeSpawnToken(targetRoomId, secret));
        if (spawnOpts.standby) {
          spawnUrl.searchParams.set(STANDBY_PARAM, '1');
        } else {
          spawnUrl.searchParams.delete(STANDBY_PARAM);
        }
        // Delivered, not awaited: this route is the thing being called, and it
        // does not answer until the successor exits. See `SPAWN_ACK_MS`.
        return deliverSpawn(spawnUrl.toString());
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
 * The `runtime`+`maxDuration` a ticker route file is expected to export, in
 * ONE readable place. IT IS DOCUMENTATION, NOT SOMETHING TO RE-EXPORT. Write
 * the literals in the route file itself:
 *
 * ```ts
 * export const runtime = 'nodejs';
 * export const maxDuration = 800;
 * ```
 *
 * `export const runtime = tickerRouteConfig.runtime` FAILS THE BUILD, on both
 * Turbopack and webpack: Next's route-segment-config parser reads those two
 * exports out of the SOURCE TEXT at build time, so a value assigned from
 * anything but a literal is rejected with "Next.js can't recognize the
 * exported `runtime` field in route. It needs to be a static string", however
 * identical the value would be at runtime.
 *
 * `maxDuration` IS COUPLED TO THE TICK LOOP'S OWN LIFETIME, and that coupling
 * is the reason `VercelTickerRouteOptions.maxDurationS` exists. Whatever the
 * route file exports as `maxDuration` is the moment the platform kills the
 * function outright, and the loop has to be finished, checkpointed, released
 * and succeeded by then: `createTickerRoute` derives `maxRunMs` as
 * `maxDurationS * 1000 - TICKER_EXIT_MARGIN_MS` for exactly that reason.
 * SO THE LITERAL AND `maxDurationS` MUST BE THE SAME NUMBER, and changing one
 * (a lower plan limit, a cost decision) means changing both. Nothing at
 * runtime can read a route module's static exports back.
 */
export const tickerRouteConfig = { runtime: 'nodejs', maxDuration: 800 } as const;

/**
 * How much of the platform's duration cap the relay route reserves for
 * announcing its own end and letting the client swap sockets.
 *
 * The relay closes at `lifetimeMs` and announces `relay-expiring`
 * `RELAY_EXPIRY_LEAD_MS` (5s) before that, so the margin has to cover the
 * announcement lead plus the client's replacement socket completing its own
 * handshake, subscribe and first snapshot. Anything left over is spent doing
 * nothing, which is the correct thing to be spending it on: the alternative is
 * the platform killing the function mid-swap.
 */
export const RELAY_EXIT_MARGIN_MS = 10_000;

/**
 * The shortest relay lifetime this route will start, and the same subtraction
 * trap as `MIN_TICKER_RUN_MS` with a nastier symptom.
 *
 * The warm swap is "announce `relay-expiring`, then close
 * `RELAY_EXPIRY_LEAD_MS` later", so a lifetime at or below the lead collapses
 * the two into one instant: an admitted socket is told it is expiring and
 * closed with `CLOSE_CODES.relayUnavailable` before it has received a single
 * snapshot, the client's ladder reconnects (correctly: that code is not
 * terminal), and the replacement socket does exactly the same. An infinite
 * reconnect loop on a completely healthy deployment, driven by nothing but a
 * `maxDurationS` too small for the margin. `maxDurationS: 10` derived a
 * lifetime of 0, which is measurably that.
 *
 * TWO LEADS, NOT ONE, AND THE SECOND LEAD IS THE HALF THAT IS EASY TO MISS.
 * This floor was `RELAY_EXPIRY_LEAD_MS + 1000` on the reasoning that the
 * announcement and the close only have to be distinct events. That bounds ONE
 * relay's lifetime and says nothing about the CHAIN of them, which is what a
 * host actually runs: `relay-expiring` is a server-controlled socket-open
 * primitive, so the client rate limits it and declines any swap starting less
 * than `RELAY_EXPIRY_LEAD_MS` after the previous one (see `connection.ts`,
 * `lastSwapStartedAt`). At a 6000ms lifetime the announcements arrive 6000ms
 * apart but the SWAPS would start 1000ms apart, so every swap after the first
 * is declined, the socket runs to its cap, closes 4004, and the client falls
 * back to the cold reconnect the whole mechanism exists to avoid. Measured on
 * `tests/smoothness.redis.test.ts` at lifetimeMs 6000: 1 reconnect, a 349ms
 * snapshot gap, 3 zero-motion frames and a 234 u/s peak, i.e. exactly the
 * stutter, from a value the old floor admitted. So the lifetime has to cover
 * one lead for the swap plus one lead of clearance before the next
 * announcement, and the trailing 1000ms keeps the boundary itself out.
 *
 * The rate limit is not a bug to work around: it is what stops a compromised
 * relay opening a socket per frame (measured at 201 sockets in ten seconds).
 * The adapter is the layer that has to respect it, because the adapter is
 * where the lifetime is chosen.
 */
export const MIN_RELAY_LIFETIME_MS = 2 * RELAY_EXPIRY_LEAD_MS + 1000;

export type VercelRelayRouteOptions = Omit<HostRelayOptions, 'joinMeta' | 'spawnTicker'> &
  Pick<AdmitSocketOptions, 'connNamespace' | 'connStaleMs' | 'maxPlayers' | 'maxSocketsPerSubject'> & {
    secret: string;
    isValidBase(base: string): boolean;
    fallbackRoom: string;
    maxRooms?: number | undefined;
    namespace?: string | undefined;
    /**
     * URL of the ticker route created by `createTickerRoute`. A relative value
     * (the common case: both routes live in the same deployment) resolves
     * against this request's own origin, so `/api/ticker` is normally enough.
     * The relay only ever fetches this when it sees no live lease for the
     * room, carrying a freshly minted spawn token; see `RelayOptions.spawnTicker`.
     */
    tickerUrl: string;
    /**
     * Called with the verified claims; return extra join metadata (a display
     * name, a colour). This stands in for `RelayOptions.joinMeta`, which is a
     * fixed value: one route serves every socket, so the value has to be
     * computed per request from that request's own claims and URL.
     */
    joinMeta?: ((claims: TokenClaims, url: URL) => Record<string, unknown>) | undefined;
    /**
     * The `maxDuration` this route file actually exports, in seconds. Defaults
     * to `relayRouteConfig.maxDuration`.
     *
     * THE RELAY'S OWN CAP IS A WARM SWAP, NOT A DROP. The function holding a
     * socket dies at this cap exactly like the ticker's does, so without a
     * lifetime every socket in the fleet was simply dropped every ~13 minutes
     * and reconnected through the client's error ladder: a visible gap, a
     * re-mint, a fresh subscribe and a re-seeded roster, for every player,
     * forever, on a completely healthy deployment. Deriving `lifetimeMs` from
     * this makes the relay announce `relay-expiring` `RELAY_EXPIRY_LEAD_MS`
     * ahead instead, and the client opens a replacement socket and swaps to it
     * once it delivers, so the cap costs no visible gap at all.
     *
     * A host that sets `lifetimeMs` explicitly wins: that is the escape hatch
     * for a platform whose real cap this library has no way to read.
     *
     * There is a MINIMUM, checked at route creation: the resolved lifetime has
     * to hold two expiry leads (see `MIN_RELAY_LIFETIME_MS`), so the smallest
     * usable `maxDurationS` is 21s. Below that a warm swap is not merely short,
     * it does not happen.
     */
    maxDurationS?: number | undefined;
    /**
     * Injected so this module never imports `@vercel/functions` directly. See
     * the module comment for why.
     *
     * Typed to match the SHAPE of `@vercel/functions`'s real
     * `experimental_upgradeWebSocket` export (a handler taking the raw
     * socket, an optional options bag, and a `Promise<Response>` return)
     * without importing that package at all: `ws` here stays `any` rather
     * than `import type { WebSocket } from 'ws'`, since pulling in `ws`'s
     * types for this one field would trade one platform dependency for a
     * package dependency, when a structural placeholder costs nothing and
     * the cast to `RelaySocket` at the call site below is where the real
     * shape is actually enforced. This previously declared a SYNCHRONOUS
     * `(cb) => Response`, which the real export (`(handler, options?) =>
     * Promise<Response>`) does not satisfy: `Promise<Response>` is not
     * assignable to `Response`, so the README's own quickstart
     * (`upgradeWebSocket: experimental_upgradeWebSocket`) failed to
     * typecheck for anyone who copied it verbatim.
     */
    upgradeWebSocket: (
      handler: (ws: any) => void | Promise<void>, // eslint-disable-line @typescript-eslint/no-explicit-any
      options?: { maxPayload?: number },
    ) => Promise<Response>;
  };

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
 *
 * THE ADMISSION SEQUENCE IS `admitSocket`'S, NOT THIS ROUTE'S. Checking,
 * warning on an unevaluated cap, refusing with the right frame and close code,
 * registering the connection and unregistering it on close used to be written
 * out here, imported from here by `node.ts`, and hand-copied into the node
 * example. Three copies of a protocol whose close codes the CLIENT latches a
 * terminal reconnect state off is three chances to drift, and nothing in any
 * gate could have seen it. See `server/admission.ts`.
 */
export function createRelayRoute(opts: VercelRelayRouteOptions): (req: Request) => Promise<Response> {
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
    tickerUrl,
    joinMeta,
    upgradeWebSocket,
    maxDurationS = relayRouteConfig.maxDuration,
    ...relay
  } = opts;

  const lifetimeMs = relay.lifetimeMs ?? maxDurationS * 1000 - RELAY_EXIT_MARGIN_MS;

  // Checked on the RESOLVED value, so it bounds the derived lifetime and an
  // explicit one alike; see `MIN_RELAY_LIFETIME_MS` for the two failures this
  // exists to refuse. A host that wants no lifetime at all does not pass zero,
  // it uses `adapters/node.ts`, where there is no platform cap to announce.
  if (!(lifetimeMs >= MIN_RELAY_LIFETIME_MS)) {
    throw new Error(
      `createRelayRoute: lifetimeMs resolves to ${lifetimeMs}ms, below MIN_RELAY_LIFETIME_MS (${MIN_RELAY_LIFETIME_MS}ms = 2 * RELAY_EXPIRY_LEAD_MS ${RELAY_EXPIRY_LEAD_MS}ms + 1000ms). ` +
        `maxDurationS is ${maxDurationS}s and RELAY_EXIT_MARGIN_MS is ${RELAY_EXIT_MARGIN_MS}ms. ` +
        `A relay lifetime must hold TWO expiry leads: one for the swap itself, and one of clearance before the next relay announces, because the client rate limits relay-expiring and declines any swap starting less than RELAY_EXPIRY_LEAD_MS after the previous one. ` +
        `Below that, every swap after the first is declined and the socket falls back to a cold reconnect (measured at lifetimeMs 6000: a 349ms snapshot gap and 3 zero-motion frames); at or below one lead the announcement and the close are the same event and the socket reconnects forever. ` +
        `Raise maxDurationS to at least ${(RELAY_EXIT_MARGIN_MS + MIN_RELAY_LIFETIME_MS) / 1000}s.`
    );
  }

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

    const rawRoom = url.searchParams.get('room');
    const roomId = normalizeRoomId(rawRoom ?? fallbackRoom, {
      isValidBase,
      fallback: fallbackRoom,
      maxRooms,
    });

    // Behind the token check for the same reason the ticker's is behind the
    // spawn token: a log line per request is only safe when the requests are
    // authenticated.
    logRoomNormalised(relay.log, 'relay.room-normalised', rawRoom, roomId);

    const redis = getRedis();

    return upgradeWebSocket(async (ws: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      // The one sanctioned cast: `ws` arrives untyped from the injected
      // `upgradeWebSocket`, and this is the single seam where it is adapted
      // to the shape the relay actually needs, rather than casting the whole
      // options bag handed to `admitSocket` below.
      const socket = ws as RelaySocket;

      // NOTHING MAY ESCAPE THIS HANDLER, and this route had no guard where
      // `adapters/node.ts` always did. The handler is a callback the platform
      // invoked, so a rejection out of it is an unhandled rejection with no
      // caller to catch it: on Node that is a process-level event, and either
      // way the socket the platform has already upgraded is left OPEN, wired to
      // nothing, until the function's own duration cap kills it minutes later.
      // The client sees a live connection delivering no snapshots and has no
      // reason to reconnect, which is the deaf-socket state
      // `subscribeTimeoutMs` exists to prevent from the inside.
      //
      // It is reachable, and not only by a library bug: `createSubscriber`
      // throws on a missing or malformed `REDIS_URL` (measured), and that is a
      // deployment-config mistake, i.e. exactly the condition under which every
      // socket in the fleet takes this path at once.
      try {
        await admitSocket({
          socket,
          redis,
          createSubscriber,
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
            lifetimeMs,
            joinMeta: joinMeta ? joinMeta(claims, url) : undefined,
            spawnTicker: async (targetRoomId: string): Promise<unknown> => {
              const spawnUrl = new URL(tickerUrl, url);
              spawnUrl.searchParams.set('room', targetRoomId);
              spawnUrl.searchParams.set('k', makeSpawnToken(targetRoomId, secret));
              // The ticker route holds its response open for the whole run, so
              // waiting for it reported a 300s headers timeout as a failed
              // spawn on the first socket of every room. See `SPAWN_ACK_MS`.
              return deliverSpawn(spawnUrl.toString());
            },
          },
        });
      } catch (err) {
        // Both of these are themselves guarded, because this block is the last
        // thing standing between a throw and an unhandled rejection: a host
        // logger that throws, or a socket already torn down by whatever failed,
        // would otherwise re-raise the very rejection being swallowed.
        try {
          relay.log?.({
            lvl: 'error',
            kind: 'relay.upgrade-threw',
            room: roomId,
            pid: claims.pid,
            msg: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // never throw out of a logger
        }
        try {
          socket.close(1011); // the WebSocket standard's own internal-error code, not one of this library's.
        } catch {
          // the socket may already be gone
        }
      }
    });
  };
}

/**
 * Same reasoning as `tickerRouteConfig`, and the same warning: this is where a
 * host READS the two numbers, not something to re-export. The relay route file
 * writes them as literals of its own (`export const runtime = 'nodejs';
 * export const maxDuration = 800;`), because Next will not recognise either
 * field otherwise.
 *
 * `maxDuration` is coupled to the relay's `lifetimeMs` exactly as the ticker's
 * is coupled to `maxRunMs`, and for the same reason: this is when the platform
 * kills the function holding the socket. The literal and
 * `VercelRelayRouteOptions.maxDurationS` must be the same number, or the relay
 * announces an expiry that lands after it is already dead.
 */
export const relayRouteConfig = { runtime: 'nodejs', maxDuration: 800 } as const;

/**
 * How many `not=` entries one request may name.
 *
 * The list is a query parameter, so its length is the caller's choice, and
 * every entry costs a `parseRoomId` on the JOIN PATH. There is nothing useful
 * past the size of the pool (`MAX_ROOMS_PER_BASE` is 50, and a base cannot
 * hold more instances than that), so a bound here costs a legitimate client
 * nothing and takes away a free multiplier. Excess entries are DROPPED rather
 * than refused: this parameter is advisory, and answering 400 would turn a
 * client's own bookkeeping bug into an unjoinable game.
 */
const MAX_EXCLUDE_IDS = 64;

/**
 * `?not=a,b,c` into the list `assignRoom` validates. Whitespace around an
 * entry is trimmed and empty entries are dropped, so `not=a,%20b` and a
 * trailing comma both behave; nothing here VALIDATES anything, which is
 * deliberate, because `assignRoom` already refuses every entry that does not
 * name an instance of this base and refuses them individually.
 *
 * A single id is the same call with one entry, byte for byte.
 */
function parseExcludeList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .slice(0, MAX_EXCLUDE_IDS);
}

export interface VercelBalancerRouteOptions {
  isValidBase(base: string): boolean;
  fallbackBase: string;
  maxPlayers: number;
  maxRooms?: number | undefined;
  namespace?: string | undefined;
}

/**
 * Handles `/api/room?base=lobby[&not=lobby~2,lobby~5]`, returning which room
 * instance a new joiner should connect to. `not` is a comma-separated list of
 * the room instances that have already rejected this client (full-room
 * bounces): each entry is honoured only when it genuinely parses as an
 * instance of `base`, so a re-assign never lands back on a room that refused
 * it but an untrusted value cannot exclude a key it has no business naming,
 * and one bad entry does not discard the good ones (see `assignRoom`'s own
 * handling of `exclude`).
 *
 * PASS EVERY ROOM YOU WERE REFUSED FROM, not just the last one. The balancer
 * reads a stats key with a 5s TTL and the ticker enforces capacity
 * authoritatively, so the two disagree for up to a window: with one id the
 * client ping-pongs between two rooms and burns its whole bounded re-assign
 * budget, and the player is told the game is full while seats are free.
 */
export function createBalancerRoute(
  opts: VercelBalancerRouteOptions
): (req: Request) => Promise<Response> {
  const { isValidBase, fallbackBase, maxPlayers, maxRooms, namespace } = opts;

  return async function balancerRoute(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // THE SAME TRUST BOUNDARY THE OTHER TWO ROUTES ALREADY APPLY, and this
    // was the one route of three that skipped it. `isValidBase` alone is not
    // the boundary: it is HOST-SUPPLIED, the `ids.ts` module comment already
    // treats it as something that gets written wrong (a bare `raw in WORLDS`
    // matches inherited properties, so `constructor` and `__proto__` pass),
    // and it says nothing at all about the character filter or the length
    // cap. This value is interpolated into Redis key names, which have no
    // escaping, once per instance in the pool, so a ':' would smuggle extra
    // key segments and a '*' would build a glob pattern out of a query
    // parameter. `normalizeBase` runs those checks and `isValidBase` too.
    const base = normalizeBase(url.searchParams.get('base') ?? fallbackBase, { isValidBase });
    if (base === null) {
      return jsonResponse({ error: 'unknown room base' }, 400);
    }

    const result = await assignRoom({
      redis: getRedis(),
      base,
      maxPlayers,
      maxRooms,
      namespace,
      exclude: parseExcludeList(url.searchParams.get('not')),
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
