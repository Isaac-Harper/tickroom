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
// Run:
//   REDIS_URL=redis://localhost:6379 SESSION_SECRET=dev npx tsx examples/node-server/server.ts

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import Redis from 'ioredis';

import { roomKeys } from '../../src/core/index.js';
import type { ClientInput, RedisLike, RoomRuntime } from '../../src/core/index.js';
import { attachRelay, checkAdmission, runTicker, makeToken, verifyToken } from '../../src/server/index.js';
import { pongRuntime } from '../pong/sim.js';
import { cursorsRuntime } from '../cursors/sim.js';

const PORT = Number(process.env.PORT ?? 3100);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const SECRET = process.env.SESSION_SECRET ?? 'dev-secret-do-not-ship';
const MAX_PLAYERS = 20;

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
  for (;;) {
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
      spawnSuccessor: async () => {
        // On serverless this is an authenticated HTTP request to the ticker
        // route. In-process, the loop below IS the successor, so there is
        // nothing to spawn.
      },
      onEvents: (events) => {
        for (const ev of events) console.log(`[${room}] event`, ev);
      },
      log: (e) => console.log(`[${room}] ${e.lvl} ${e.kind} ${e.msg ?? ''}`),
    });

    console.log(`[${room}] ticker exited: ${result.reason} after ${result.ticks} ticks`);

    // 'busy' means another owner holds the lease, which in-process means a
    // previous loop has not finished unwinding. Back off rather than spinning.
    if (result.reason === 'busy') {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    // 'empty' means the room drained. Stop; the next joiner starts it again.
    if (result.reason === 'empty') return;
    // 'duration' and 'lease-lost' both mean go again immediately. This is the
    // handoff, and running it in a tight loop on a long-lived host is a cheap
    // way to keep exercising the path serverless takes every few minutes.
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
    void (async () => {
      const admission = await checkAdmission({
        redis,
        roomId: room,
        pid,
        subject: String(claims.sub),
        maxPlayers: MAX_PLAYERS,
      });

      if (!admission.admit) {
        ws.send(JSON.stringify({ t: admission.reason === 'full' ? 'room-full' : 'conn-limit' }));
        ws.close(admission.reason === 'full' ? 4002 : 4003);
        return;
      }

      // The per-user socket cap fails OPEN on a Redis fault, which is right
      // (refusing during a blip would lock users out of a healthy deployment)
      // but it must never do so quietly: a degraded Redis disables the cap in
      // exactly the conditions the cap is load-bearing, since every socket
      // holds its own subscriber connection. See
      // `AdmissionResult.socketCapEvaluated`.
      if (!admission.socketCapEvaluated) {
        console.log(
          `[relay ${room}] warn relay.socket-cap-unevaluated admitted without applying maxSocketsPerSubject: the connection set could not be read`,
        );
      }

      // CLAIM THE SLOT. `checkAdmission` is a QUERY and deliberately writes
      // nothing, so that a REFUSED connection never has to be un-registered.
      // That means registration is the caller's job, and skipping it does not
      // fail loudly: the cap keeps passing because the set it counts is always
      // empty, so `maxSocketsPerSubject` silently enforces nothing at all.
      //
      // The periodic re-score is what makes it self-healing. A process killed
      // without running cleanup leaves its member behind, and only a score that
      // stops being refreshed lets the pruning pass age it out; without the
      // touch, one hard kill costs that subject a slot permanently. Touch well
      // inside `connStaleMs` (30s by default) so a live socket is never mistaken
      // for an abandoned one.
      const CONN_TOUCH_MS = 10_000;
      const CONN_TTL_S = 60;
      const touch = () => {
        redis.zadd(admission.connKey, Date.now(), admission.connId).catch(() => {});
        redis.expire(admission.connKey, CONN_TTL_S).catch(() => {});
      };
      touch();
      const touchTimer = setInterval(touch, CONN_TOUCH_MS);

      attachRelay({
        socket: ws as never,
        redis,
        createSubscriber: newSubscriber,
        roomId: room,
        pid,
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
        // Free the slot immediately on a normal disconnect, so a player who
        // closes one tab can open another at once instead of waiting out the
        // staleness horizon. The periodic touch above is what covers the case
        // where this never runs at all.
        onClose: () => {
          clearInterval(touchTimer);
          redis.zrem(admission.connKey, admission.connId).catch(() => {});
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
});
