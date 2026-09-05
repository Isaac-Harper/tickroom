// The same runtimes, on a plain Node server with `ws`. No serverless anywhere.
//
// This exists to make one claim checkable rather than merely asserted: tickroom
// is not a Vercel library. The server core imports nothing from any platform,
// and the platform adapters take their platform handle by injection. Swapping
// hosts is this file, not a rewrite.
//
// It is also the fastest way to develop against the library. Everything except
// the function lifetime behaves identically to production, so you can drive real
// clients through a real Redis on a laptop.
//
// THE INTERESTING PART IS WHAT DOES NOT CHANGE. On a long-lived host the lease
// and the checkpoint look like belt and braces: nothing is going to kill this
// process every few minutes, so why lease anything? Keep them anyway, and not
// only because the same code has to run on serverless. They are what makes a
// deploy safe (the old process finishes its tick, checkpoints, and releases,
// and the new one picks the room up mid-play), what makes a crash a recoverable
// event rather than a lost room, and what stops a stray second instance from
// corrupting a room's state. The serverless case just makes all three happen
// every few minutes instead of every few weeks, which is a much better way to
// find out whether your handoff actually works.
//
// Run (see README.md beside this file for the environment knobs, the session
// endpoint, the socket URL shape and a headless client to point at it):
//   REDIS_URL=redis://127.0.0.1:6399 SESSION_SECRET=dev PORT=3100 npm run example:node

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import Redis from 'ioredis';

import { MAX_TICKER_MS, roomKeys } from '../../src/core/index.js';
import type { ClientInput, RedisLike, RoomRuntime } from '../../src/core/index.js';
import { admitSocket, runTicker, makeToken, verifyToken } from '../../src/server/index.js';
import { pongRuntime } from '../pong/sim.js';
import { cursorsRuntime } from '../cursors/sim.js';

const PORT = Number(process.env.PORT ?? 3100);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const SECRET = process.env.SESSION_SECRET ?? 'dev-secret-do-not-ship';
const MAX_PLAYERS = 20;

// THE THREE KNOBS THAT MAKE THE TWO HANDOFFS WATCHABLE ON A LAPTOP, and the
// only reason they are environment variables rather than constants: on the
// defaults this example demonstrates neither. The ticker's own lifetime cap is
// 700 seconds and the relay has no cap at all, so an hour of staring at this
// process shows you a room that simply keeps ticking. That is the correct
// PRODUCTION default and a useless development one, which is exactly the shape
// an env knob is for. See README.md beside this file for the two recipes.
//
// All three default to today's behaviour, so an unset environment changes
// nothing.

/** The ticker's own duration cap, i.e. how often the PLANNED handoff runs. Default `MAX_TICKER_MS` (700s), the same number a serverless ticker gets. Set it to 8000 and a handoff happens every eight seconds. */
const TICKER_MAX_RUN_MS = Number(process.env.TICKER_MAX_RUN_MS ?? MAX_TICKER_MS);
/** Passed to the SUCCESSOR's `runTicker` as `standbyMs` when the spawn that asked for it carried `{ standby: true }`. Zero (the default) is `runTicker`'s own historical behaviour: fail the acquire, return 'busy'. Must comfortably exceed `standbyLeadMs` (3000) plus the incumbent's own exit; see `standbyMs`'s doc comment. */
const STANDBY_MS = Number(process.env.STANDBY_MS ?? 0);
/** The relay's own lifetime cap, i.e. how often the WARM SWAP runs. Unset (the default) means no cap, which is right for a process nothing kills on a schedule. Set it to 15000 and every socket announces `relay-expiring` and is swapped every fifteen seconds. There is NO FLOOR here: `MIN_RELAY_LIFETIME_MS` (11000) is checked by the Vercel route on a lifetime it DERIVES from `maxDurationS`, and this file passes an explicit one straight through, so a number under two expiry leads is yours to avoid. */
const RELAY_LIFETIME_MS = process.env.RELAY_LIFETIME_MS ? Number(process.env.RELAY_LIFETIME_MS) : undefined;
/** How often the per-socket abuse counters below are flushed to the log. NEVER per event: see the comment on `onBadInput`. */
const COUNTER_FLUSH_MS = 10_000;

// A host that serves several different simulations does not, and cannot, know
// which state type it is holding at the dispatch point: the room name only
// becomes a concrete type after the lookup. That is fine, and it is worth
// noticing rather than fighting, because the host NEVER TOUCHES THE STATE. It
// creates it, hands it to `tick`, serialises it, and forwards the bytes. All the
// type safety that matters lives inside each runtime, where the state is
// concrete; erasing it at the boundary loses nothing real.
const RUNTIMES: Record<string, RoomRuntime<never, never>> = {
  pong: pongRuntime as unknown as RoomRuntime<never, never>,
  cursors: cursorsRuntime as unknown as RoomRuntime<never, never>,
};
type RoomName = 'pong' | 'cursors';

// hasOwnProperty, not `in`. A bare `raw in RUNTIMES` on an object literal matches
// INHERITED properties, so 'constructor', '__proto__' and 'toString' all pass,
// and the value goes on to be interpolated into a Redis key name, which has no
// escaping. This is a trust boundary even on a toy server.
const isRoomName = (b: string): b is RoomName => Object.prototype.hasOwnProperty.call(RUNTIMES, b);

const redis = new Redis(REDIS_URL) as unknown as RedisLike;
// A connection in SUBSCRIBE mode cannot run ordinary commands, so every
// subscriber gets its own. That is why the publisher above is shared and this is
// a factory. It is also why concurrent connections, not command count, is the
// first ceiling this architecture hits on a managed Redis.
const newSubscriber = () => new Redis(REDIS_URL) as never;

// ---------------------------------------------------------------------------
// Tickers. On serverless these are separate function invocations spawned on
// demand; here they are in-process loops, restarted when they exit with players
// still in the room. That restart loop is this file's stand-in for the platform
// re-invoking a function, and running it is what proves the handoff path works.
// ---------------------------------------------------------------------------

async function keepTicking(room: RoomName): Promise<void> {
  // What the NEXT iteration runs as. `runTicker` calls `spawnSuccessor` twice
  // over a healthy lifetime, and the flag it carries is the whole difference:
  // `{ standby: true }` fires `standbyLeadMs` (3000) BEFORE the duration cap and
  // names the designated successor, `{ standby: false }` fires from the exit
  // `finally`. On serverless the first one is a second invocation that boots,
  // pays its `init` and sits on the lease poll while the incumbent is still
  // ticking. In THIS process the loop below is the successor and it cannot start
  // early, so what the flag buys here is the POLL rather than the head start:
  // the next run waits `STANDBY_MS` for the lease instead of returning 'busy'
  // the moment it finds the predecessor still unwinding, and it pays its `init`
  // in front of the acquire the way a real standby does. That is the same code
  // path a serverless standby takes, which is the point of running it at all.
  let standbyMs = 0;

  for (;;) {
    let standbyAsked = false;
    const result = await runTicker({
      runtime: RUNTIMES[room],
      redis,
      createSubscriber: newSubscriber,
      roomId: room,
      // In production this is a digest of the world's geometry and rules. Any
      // stable string works as long as it CHANGES when the simulation's world
      // changes, because that is what stops a room restoring and re-saving a
      // simulation of a world the current build no longer has. See
      // docs/ARCHITECTURE.md section 3.
      geomKey: () => `${room}:v1`,
      // Unset, this is `MAX_TICKER_MS` and the planned handoff happens once
      // every 700 seconds, which is a correct production number and a useless
      // one to watch. See `TICKER_MAX_RUN_MS`.
      maxRunMs: TICKER_MAX_RUN_MS,
      standbyMs,
      spawnSuccessor: async (_id, opts) => {
        // On serverless this is an authenticated HTTP request to the ticker
        // route, carrying `standby=1` when `opts.standby` is set. In-process,
        // the loop above IS the successor, so there is nothing to spawn: all
        // this does is remember WHICH spawn it was, so the next iteration knows
        // whether it is the designated standby.
        if (opts.standby) standbyAsked = true;
      },
      onEvents: (events) => {
        for (const ev of events) console.log(`[${room}] event`, ev);
      },
      log: (e) => console.log(`[${room}] ${e.lvl} ${e.kind} ${e.msg ?? ''}`),
    });

    console.log(`[${room}] ticker exited: ${result.reason} after ${result.ticks} ticks`);

    // The successor runs as a STANDBY only when the run that just ended asked
    // for one, and only for that one run: an unasked-for poll would turn every
    // ordinary 'busy' into a `STANDBY_MS` wait.
    standbyMs = standbyAsked ? STANDBY_MS : 0;

    // 'busy' means another owner holds the lease, which in-process means a
    // previous loop has not finished unwinding. Back off rather than spinning.
    if (result.reason === 'busy') {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    // 'empty' means the room drained. Stop; the next joiner starts it again.
    if (result.reason === 'empty') return;
    // 'duration', 'input-dead' and 'lease-lost' all mean go again immediately.
    // This is the handoff, and running it in a tight loop on a long-lived host
    // is a cheap way to keep exercising the path serverless takes every few
    // minutes. 'input-dead' belongs here rather than with an error backoff for
    // one specific reason: the ticker's inbound subscriber is opened once per
    // run, so a subscription that stopped delivering is repaired only by a
    // fresh run opening a fresh one.
  }
}

const running = new Set<RoomName>();
function ensureTicker(room: RoomName): void {
  if (running.has(room)) return;
  running.add(room);
  void keepTicking(room).finally(() => running.delete(room));
}

// ---------------------------------------------------------------------------
// HTTP: session mint and the room balancer.
// ---------------------------------------------------------------------------

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname === '/api/session' && req.method === 'POST') {
    const pid = randomUUID();
    const handle = Math.floor(Math.random() * 65535);
    // The token carries the claims the relay will trust for the whole socket's
    // life, and it EXPIRES. Claims are baked in at mint and no auth provider is
    // consulted again on the socket path (that is the point: it keeps an auth
    // outage off the hot path), so without an expiry a token kept from a paid
    // tier stays redeemable forever after the subscription lapsed.
    const token = makeToken({ pid, handle, sub: `d.${pid}` }, { secret: SECRET });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token, playerId: pid, handle, room: url.searchParams.get('room') ?? 'pong' }));
    return;
  }

  res.writeHead(404).end('not found');
});

// ---------------------------------------------------------------------------
// WebSocket: one relay per socket.
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const raw = url.searchParams.get('room') ?? 'pong';
  const room: RoomName = isRoomName(raw) ? raw : 'pong';
  const pid = url.searchParams.get('pid') ?? '';
  const handle = Number(url.searchParams.get('h'));
  const token = url.searchParams.get('token');

  const claims = pid && Number.isFinite(handle) ? verifyToken(token, { pid, handle }, { secret: SECRET }) : null;
  if (!claims) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    // THE TWO ABUSE SIGNALS, COUNTED IN PROCESS AND FLUSHED ON A CADENCE THE
    // CLIENT CANNOT DRIVE. Both hooks fire on a path whose rate a client owns
    // (`onRateDrop` once per frame the token bucket rejects, `onBadInput` once
    // per frame `decodeInput` throws on), so a `console.log` inside either one
    // hands an abuser a log amplifier: the refused frame becomes more expensive
    // than the accepted one, which is precisely the lever the rate limiter
    // exists to take away. Counting is free; the flush below is once per socket
    // per ten seconds no matter what arrives.
    //
    // WITHOUT THIS THE RELAY IS SILENT ON BOTH, BY DESIGN. The bucket drops the
    // frame before `decodeInput` runs and a decoder that throws is swallowed, so
    // the only symptom of a broken decoder is ONE PLAYER whose inputs stop while
    // the room, the roster, the snapshots and every other player stay perfectly
    // healthy. Nothing in a log, nothing in `RoomStats`, and the socket does not
    // even close. Wire these two and it is one line every ten seconds instead.
    const abuse = { bad: 0, dropped: 0 };
    const flush = setInterval(() => {
      if (abuse.bad === 0 && abuse.dropped === 0) return;
      console.log(`[relay ${room}] warn relay.input-refused pid=${pid} badInput=${abuse.bad} rateDropped=${abuse.dropped}`);
      abuse.bad = 0;
      abuse.dropped = 0;
    }, COUNTER_FLUSH_MS);
    // `unref` so a socket's counter cannot hold the process open, and the close
    // listener so a long-lived server does not accumulate one timer per socket
    // it has ever served.
    flush.unref();
    ws.on('close', () => clearInterval(flush));

    void (async () => {
      // ONE CALL FOR THE WHOLE ADMISSION PROTOCOL, and that is the part of this
      // file worth copying. It used to be forty lines written out right here:
      // check capacity, warn when the per-subject socket cap could not be
      // evaluated, send the matching refusal frame, close with the matching
      // code, ZADD the connection into the registry, re-score it on a timer so
      // a live socket never prunes as stale, and ZREM it on close. Every one of
      // those lines also existed in both adapters, including the close codes
      // the CLIENT latches a terminal reconnect state off, so "the same
      // protocol" was three copies free to drift with nothing in any gate able
      // to see it. Worse, the registration half is the half that fails
      // SILENTLY when it is left out: `checkAdmission` deliberately writes
      // nothing, so a host that forgets to register counts an always-empty set
      // and `maxSocketsPerSubject` enforces nothing at all while looking like
      // it does. An example that hand-rolls this is an example teaching that
      // mistake.
      //
      // `admitSocket` returns null for a refused socket, already refused and
      // closed; there is nothing further for a host to do about it.
      await admitSocket({
        socket: ws as never,
        redis,
        createSubscriber: newSubscriber,
        roomId: room,
        pid,
        subject: claims.sub,
        maxPlayers: MAX_PLAYERS,
        // The cap-unevaluated warning goes here. It fails OPEN on a Redis
        // fault, which is right (refusing during a blip would lock users out of
        // a healthy deployment) but it must never do so quietly: a degraded
        // Redis disables the cap in exactly the conditions the cap is
        // load-bearing, since every socket holds its own subscriber connection.
        log: (e) => console.log(`[relay ${room}] ${e.lvl} ${e.kind} ${e.msg ?? ''}`),
        // Everything a HOST owns about the relay itself rides this one bag, so
        // an option added to `RelayOptions` later is reachable from here
        // without this file changing.
        relay: {
          joinMeta: { name: url.searchParams.get('n') ?? `player-${handle}` },
          // JSON on the wire here for readability. Production uses the binary
          // codec: this runs at the sim rate and is delivered once PER PLAYER, so
          // it is the largest bandwidth line in the system. See src/codec/.
          //
          // `decodeInput`'s parameter is `unknown` (see its doc comment in
          // `server/relay.ts`) because what actually arrives depends on the
          // transport: this server runs on plain `ws`, which hands its
          // `'message'` listener a `Buffer`, or an array of them for a
          // fragmented message, never a browser-style `ArrayBuffer`. Normalise
          // before decoding, exactly as any other host must.
          decodeInput: (buf): ClientInput[] => {
            const bytes = Array.isArray(buf) ? Buffer.concat(buf) : (buf as Buffer);
            const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ClientInput | ClientInput[];
            return Array.isArray(parsed) ? parsed : [parsed];
          },
          spawnTicker: async (id) => {
            if (isRoomName(id)) ensureTicker(id);
          },
          log: (e) => console.log(`[relay ${room}] ${e.lvl} ${e.kind} ${e.msg ?? ''}`),
          // COUNT, NEVER LOG. See the counters and their flush above the
          // `admitSocket` call; these two lines are the entire wiring.
          onBadInput: () => void (abuse.bad += 1),
          onRateDrop: () => void (abuse.dropped += 1),
          // NO `lifetimeMs` BY DEFAULT. On Vercel the relay route derives one
          // from the function's own `maxDuration`, so a socket about to be
          // killed by the platform announces `relay-expiring` first and the
          // client swaps to a replacement with no visible gap. Nothing kills
          // this process on a schedule, so there is no cap to announce and a
          // socket lives as long as the client wants it to. `RELAY_LIFETIME_MS`
          // is how you watch the swap happen anyway: it is passed straight
          // through, with none of the route's `MIN_RELAY_LIFETIME_MS` floor,
          // because that floor guards a lifetime the ROUTE derives by
          // subtraction and this one is stated outright.
          ...(RELAY_LIFETIME_MS === undefined ? {} : { lifetimeMs: RELAY_LIFETIME_MS }),
        },
      });

      ensureTicker(room);
    })();
  });
});

http.listen(PORT, () => {
  console.log(`tickroom node example on http://localhost:${PORT}`);
  console.log(`rooms: ${Object.keys(RUNTIMES).join(', ')}`);
  console.log(`redis: ${REDIS_URL}`);
  console.log(`keys:  ${Object.values(roomKeys('pong')).join(' ')}`);
  // Echo the three lifetimes back, because "nothing happened" and "the knob did
  // not take" look identical from outside and the whole point of these is that
  // you are waiting to watch something.
  console.log(
    `ticker maxRunMs=${TICKER_MAX_RUN_MS} standbyMs=${STANDBY_MS} | relay lifetimeMs=${RELAY_LIFETIME_MS ?? 'none'}`,
  );
});
