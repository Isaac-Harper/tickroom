// THE NODE-SERVER EXAMPLE'S WIRING, WITH NO REDIS ANYWHERE. Every other file
// in this directory needs a real server and skips without one; this one needs
// nothing at all, which is the whole claim it exists to check, and that is why
// it is `memory.test.ts` rather than `memory.redis.test.ts`.
//
// It is `example.redis.test.ts`'s shape with the bus swapped and the netcode
// assertions trimmed to the two that matter here:
//
//   * `createMemoryRedis()` supplies the command client and the subscriber
//     factory, and BOTH halves of the host get the same pair;
//   * the ticker is `runNodeTicker` from `src/adapters/node.ts` and the relay
//     is `attachNodeRelay` on a real `ws` server, so the token check,
//     `normalizeRoomId`, the whole admission protocol and the relay itself are
//     the adapter's;
//   * the runtime is `pongRuntime` unmodified, JSON snapshots and all, exactly
//     as `examples/node-server/server.ts` wires it;
//   * the client is `createPongClient` on `ws`'s `WebSocket`, driven on a 16ms
//     timer instead of `requestAnimationFrame`.
//
// THE TWO THINGS IT PINS. That snapshots FLOW (the publish reaches a
// subscriber that is a fork of the same store, which is the one thing a
// memory bus can get silently wrong) and that STAMPED INPUTS LAND (the server
// moved our paddle at `PADDLE_SPEED`, one tick per record, and the client's
// own prediction of the same records agrees with what came back). A room whose
// pub/sub is broken reads healthy on every other signal, so "it did not throw"
// proves nothing here.
//
// AND `REDIS_URL` IS UNSET FOR THE WHOLE RUN, DELIBERATELY. `resolveUrl` in
// `server/redis.ts` throws without it, so any path still reaching for
// `getRedis()` or `createSubscriber()` fails loudly rather than quietly
// opening a connection to whatever is on 6379. That is the assertion that this
// shape is actually complete rather than merely untested.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

import type { ClientInput, RoomStats } from '../src/core/index.js';
import { roomKeys } from '../src/core/index.js';
import { createMemoryRedis, makeToken } from '../src/server/index.js';
import { attachNodeRelay, runNodeTicker } from '../src/adapters/node.js';
import { PADDLE_SPEED, pongRuntime, type PongEvent, type PongState } from '../examples/pong/sim.js';
import { createPongClient, type PongSnapshot } from '../examples/pong/client.js';
import { waitFor } from './helpers/env.js';

/** The example's own rate, read off the runtime rather than restated. */
const TICK_HZ = pongRuntime.tickHz;

/** How long the client plays for. Short: nothing here is measuring steady-state timing, only that the two ends agree. */
const RUN_MS = 4000;
/** Ignore everything before the first snapshot plus this: the cold start, the unanchored counter and the prediction's first snap are not steady state. */
const STEADY_LEAD_MS = 1000;
/** The render cadence, a real display's rather than the sim's. */
const FRAME_MS = 16;
/**
 * How often the held direction flips.
 *
 * PICKED SO THE PADDLE IS MOSTLY TRAVELLING RATHER THAN CLAMPED. 700ms at
 * 90 u/s is 63 units against a 96-unit range, so a sweep mostly does not
 * saturate and the run yields plenty of steps whose size is the rule's own
 * `PADDLE_SPEED / TICK_HZ` rather than zero.
 */
const SWEEP_MS = 700;

const SECRET = 'memory-test-secret';

interface SnapRec {
  at: number;
  snap: PongSnapshot;
}

describe('one process, no Redis: createMemoryRedis behind the node adapter', () => {
  const previousRedisUrl = process.env.REDIS_URL;

  beforeAll(() => {
    delete process.env.REDIS_URL;
  });

  afterAll(() => {
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  });

  it(
    'the pong runtime, the node relay and the pong client agree end to end on an in-memory bus',
    async () => {
      const roomId = `pong-${randomUUID().slice(0, 8)}`;
      const events: string[] = [];
      const t0 = performance.now();
      const log = (line: string) => events.push(`${((performance.now() - t0) / 1000).toFixed(3)} ${line}`);

      // ---- the bus -------------------------------------------------------
      //
      // ONE CALL, ONE STORE, and both halves of the host get the same pair:
      // two calls would be two disjoint Redises and the relay would subscribe
      // to a channel the ticker never publishes on.
      const { redis, createSubscriber } = createMemoryRedis();

      // ---- server --------------------------------------------------------
      const statsRecs: RoomStats[] = [];
      const roomEvents: PongEvent[] = [];
      const tickers: Array<Promise<unknown>> = [];
      let tearingDown = false;
      let tickerRunning = false;

      function startTicker(): void {
        if (tearingDown || tickerRunning) return;
        tickerRunning = true;
        const p = runNodeTicker<PongState, PongEvent>({
          runtime: pongRuntime,
          redis,
          createSubscriber,
          roomId,
          geomKey: () => 'pong-memory:v1',
          // Well past `RUN_MS`: a planned handoff is not this file's subject.
          maxRunMs: 60_000,
          checkpointMs: 1000,
          // Long enough that the client's join beats the empty check at
          // startup, short enough that the teardown's wait is a couple of
          // seconds.
          emptyGraceMs: 2500,
          // One run. The loop's restart is `node.test.ts`'s subject; here it
          // would only outlive the test.
          restartOnExit: false,
          onEvents: (evs) => {
            for (const ev of evs) roomEvents.push(ev);
          },
          onStats: (s) => statsRecs.push(s),
          log: (e) => log(`[ticker] ${e.lvl} ${e.kind} ${JSON.stringify(e.meta ?? {})}`),
        }).then(() => {
          tickerRunning = false;
          log('[ticker] exit');
        });
        tickers.push(p);
      }

      startTicker();
      // Open the door only once the lease exists, so the relay's own spawn
      // poll cannot race the ticker that is already starting.
      const keys = roomKeys(roomId);
      expect(await waitFor(async () => (await redis.get(keys.lease)) !== null, 5000, 25)).toBe(true);

      const httpServer: Server = createServer();
      const wss = new WebSocketServer({ server: httpServer });
      attachNodeRelay(wss, {
        redis,
        createSubscriber,
        secret: SECRET,
        isValidBase: (base) => base === roomId,
        fallbackRoom: roomId,
        maxPlayers: 4,
        joinMeta: (claims) => ({ name: claims.pid }),
        // The node example's own line, normalising `ws`'s Buffer (or an array
        // of them for a fragmented message) before parsing.
        decodeInput: (buf): ClientInput[] => {
          const bytes = Array.isArray(buf) ? Buffer.concat(buf as Buffer[]) : (buf as Buffer);
          const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ClientInput | ClientInput[];
          return Array.isArray(parsed) ? parsed : [parsed];
        },
        spawnTicker: async () => {
          log('[relay] spawnTicker requested');
          startTicker();
        },
        log: (e) => {
          if (e.lvl !== 'info') log(`[relay] ${e.lvl} ${e.kind} ${JSON.stringify(e.meta ?? {})}`);
        },
        onBadInput: () => log('[relay] bad input'),
        onRateDrop: () => log('[relay] rate drop'),
      });
      await new Promise<void>((resolve) => httpServer.listen(0, resolve));
      const port = (httpServer.address() as { port: number }).port;

      // ---- client --------------------------------------------------------
      const pid = `p-${randomUUID().slice(0, 8)}`;
      const handle = 7;
      const token = makeToken({ pid, handle, sub: `d.${pid}` }, { secret: SECRET });

      const snaps: SnapRec[] = [];
      const frames: Array<{ at: number; ids: string[]; lastError: number }> = [];

      const client = createPongClient({
        mint: async () => ({ token, playerId: pid, handle, room: roomId }),
        socketUrl: (s) =>
          `ws://127.0.0.1:${port}/?token=${encodeURIComponent(s.token)}` +
          `&pid=${encodeURIComponent(s.playerId)}&h=${s.handle}&room=${encodeURIComponent(s.room)}`,
        WebSocketImpl: WebSocket,
        // The example's DEFAULT decoder (JSON, `pongRuntime.encodeSnapshot`'s
        // own output), with the recording riding on it: `decode` is called
        // exactly once per snapshot frame, at arrival.
        decode: (buf) => {
          const snap = JSON.parse(new TextDecoder().decode(buf)) as PongSnapshot;
          snaps.push({ at: performance.now(), snap });
          return snap;
        },
        onStallChange: (stalled) => log(`[client] stalled=${stalled}`),
        onTerminal: (reason) => log(`[client] TERMINAL ${reason}`),
      });

      // A HELD DIRECTION, flipped on a timer: one `setDir` per flip, so every
      // stamped record between two flips carries the same value.
      let dir = 1;
      client.setDir(dir);
      const sweep = setInterval(() => {
        dir = -dir;
        client.setDir(dir);
      }, SWEEP_MS);

      const frameTimer = setInterval(() => {
        const at = performance.now();
        const view = client.frame(at);
        frames.push({ at, ids: [...view.entities.keys()], lastError: client.paddle.stats.lastError });
      }, FRAME_MS);

      await client.start();
      expect(await waitFor(() => snaps.length > 0, 8000, 25)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, RUN_MS));

      const endStats = client.conn.stats();

      // ---- teardown ------------------------------------------------------
      clearInterval(sweep);
      clearInterval(frameTimer);
      client.stop();
      tearingDown = true;
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await Promise.allSettled(tickers);

      // ---- analysis ------------------------------------------------------
      const steadyFrom = snaps[0]!.at + STEADY_LEAD_MS;
      const steadySnaps = snaps.filter((s) => s.at >= steadyFrom);
      const steadyFrames = frames.filter((f) => f.at >= steadyFrom);

      // 1. SNAPSHOTS FLOW, and ours is in every one of them.
      const rosterMisses = steadySnaps.filter((s) => !s.snap.paddles.some((p) => p.pid === pid)).length;
      const drawMisses = steadyFrames.filter((f) => !f.ids.includes(pid)).length;

      // 2. STAMPED INPUTS LAND. On the SERVER's own y, snapshot to snapshot,
      //    one tick apart: a step the size of `PADDLE_SPEED / TICK_HZ` is one
      //    of our records applied on the tick it named. Steps of zero are the
      //    paddle at a clamp and are simply not counted.
      const ownY = (s: SnapRec): number | undefined => s.snap.paddles.find((p) => p.pid === pid)?.y;
      const step = PADDLE_SPEED / TICK_HZ;
      let movingSteps = 0;
      let offSpeedSteps = 0;
      for (let i = 1; i < steadySnaps.length; i++) {
        const a = steadySnaps[i - 1]!;
        const b = steadySnaps[i]!;
        if (b.snap.tick - a.snap.tick !== 1) continue;
        const ya = ownY(a);
        const yb = ownY(b);
        if (ya === undefined || yb === undefined) continue;
        const moved = Math.abs(yb - ya);
        // `encodeSnapshot` rounds y to a tenth, so a full step reads 4.5
        // exactly and a partial one (the tick that reaches the clamp) does
        // not. Only the two are possible; anything between is a tick applied
        // twice or skipped.
        if (moved < 0.05) continue;
        movingSteps++;
        if (Math.abs(moved - step) > 0.06 && moved > step) offSpeedSteps++;
      }

      // 3. AND THE CLIENT PREDICTED THE SAME RECORDS. `lastError` is the
      //    distance between the prediction and the server's y replayed
      //    forward through this client's own stored history: a timeline off
      //    by one tick reads `PADDLE_SPEED / TICK_HZ` here.
      const maxError = Math.max(...steadyFrames.map((f) => f.lastError));

      // 4. AND THE ROOM NEVER FAULTED.
      const hostErrors = statsRecs.reduce((n, s) => n + s.hostErrors, 0);
      const badEnvelopes = statsRecs.reduce((n, s) => n + s.badEnvelopes, 0);

      const summary = {
        snapshots: snaps.length,
        frames: frames.length,
        rosterMisses,
        drawMisses,
        paddle: { movingSteps, offSpeedSteps, step },
        reconcile: { maxError: +maxError.toFixed(4) },
        predicted: client.paddle.stats,
        roomEvents: roomEvents.length,
        server: { hostErrors, badEnvelopes },
        client: endStats,
      };
      // Printed only when something below fails, exactly as the other files
      // here print their own events: a green run says nothing.
      const report = () => `${JSON.stringify(summary, null, 2)}\n${events.join('\n')}`;

      try {
        // SNAPSHOTS FLOWED. At 20Hz over four seconds this is about eighty;
        // the bound is loose because the number being non-zero is the claim.
        expect(snaps.length, 'snapshots received').toBeGreaterThan((RUN_MS / 1000) * TICK_HZ * 0.5);
        expect(rosterMisses, 'snapshots without our paddle').toBe(0);
        expect(drawMisses, 'frames that did not draw our paddle').toBe(0);

        // STAMPED INPUTS LANDED, on the server's own numbers.
        expect(movingSteps, 'server ticks that moved our paddle').toBeGreaterThan(20);
        expect(offSpeedSteps, 'steps larger than one tick of PADDLE_SPEED').toBe(0);

        // AND THE TIMELINE AGREES ACROSS THE WIRE. One tick of disagreement
        // is 4.5 units, so 0.25 is well inside a tick. The three lines under
        // it are what stop the bound passing vacuously: a prediction that
        // never ran also reports zero.
        expect(maxError, 'reconcile error').toBeLessThan(0.25);
        expect(client.paddle.stats.stamped, 'stamped records').toBeGreaterThan((RUN_MS / 1000) * TICK_HZ * 0.5);
        expect(client.paddle.stats.snaps, 'hard snaps').toBeLessThanOrEqual(2);
        expect(client.paddle.stats.invalid, 'invalid replays').toBeLessThanOrEqual(1);

        expect(hostErrors, 'RoomStats.hostErrors').toBe(0);
        expect(badEnvelopes, 'RoomStats.badEnvelopes').toBe(0);
        expect(endStats.reconnects, 'reconnects').toBe(0);
      } catch (err) {
        console.error(report());
        throw err;
      }
      console.log(`[memory] ${JSON.stringify(summary)}`);
    },
    RUN_MS + 20_000
  );
});
