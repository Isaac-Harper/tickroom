// THE SHIPPED EXAMPLE, THROUGH A REAL SOCKET. Every other file under `tests/`
// drives a runtime written for the test that drives it; this one drives
// `examples/pong`, unmodified, end to end:
//
//   * `pongRuntime` from `examples/pong/sim.ts` IS the ticker's runtime, with
//     `encodeSnapshot` swapped for `encodePongSnapshot` from
//     `examples/pong/codec.ts`, which is the entire binary upgrade that file's
//     own header promises ("only the function wired into the ticker's config
//     changes"), so the codec is on the wire rather than merely unit-tested;
//   * the relay is `attachNodeRelay` from `src/adapters/node.ts` on a real `ws`
//     server, so the token check, `normalizeRoomId`, the whole admission
//     protocol and the relay itself are the adapter's, not the harness's;
//   * the client is `createPongClient` from `examples/pong/client.ts`, the
//     DOM-free half of the example, driven on a 16ms timer instead of
//     `requestAnimationFrame`. Nothing about the netcode is retyped here: the
//     decode, the interpolator wiring, the `PredictedEntity`, the
//     `frame()`-then-`advance()` ordering and `readDir` are all the example's.
//
// WHY THIS FILE EXISTS. AGENTS.md carried "the examples are still not run by
// CI" as an open item for exactly this reason: the example's own tests are
// strong and they are UNIT tests, so the one thing nothing checked was whether
// the two ends of the shipped stamped path actually agree across a wire. The
// assertion that pins it is the reconcile error: the client predicts its own
// paddle with `stepPaddleY`, the server applies the same record on the same
// tick with the same function, and if the input timeline is off by so much as
// a tick the two disagree by `PADDLE_SPEED / tickHz` (4.5 units) rather than by
// the codec's own quantisation.
//
// The room and the namespace are unique per run and the namespace is flushed
// afterwards, like every other file here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { WebSocketServer, WebSocket } from 'ws';

import type { ClientInput, RoomRuntime, RoomStats } from '../src/core/index.js';
import { roomKeys } from '../src/core/index.js';
import { createSubscriber, getRedis, makeToken, resetRedisForTests, runTicker } from '../src/server/index.js';
import { attachNodeRelay } from '../src/adapters/node.js';
import { PADDLE_SPEED, pongRuntime, type PongEvent, type PongState } from '../examples/pong/sim.js';
import { decodePongSnapshot, encodePongSnapshot, type DecodedPongSnapshot } from '../examples/pong/codec.js';
import { createPongClient } from '../examples/pong/client.js';
import { TEST_REDIS_URL, probeRedisAvailable, newNamespace, flushNamespace, skipReason, waitFor } from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: example] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

/** The example's own rate, read off the runtime rather than restated, so a change to pong moves this with it. */
const TICK_HZ = pongRuntime.tickHz;

/** How long the client plays for. Long enough for the rate window, several sweeps of the paddle and at least one goal; short enough that the whole file stays well inside twenty-five seconds. */
const RUN_MS = 10_000;
/** Ignore everything before `firstSnapshotAt + this`: the first seconds are a cold start, an unanchored counter and the prediction's first snap, none of which are steady state. */
const STEADY_LEAD_MS = 2000;
/** The window the snapshot rate is measured over. */
const RATE_WINDOW_MS = 3000;
/** The render cadence, a real display's rather than the sim's, exactly as `startPong` runs on `requestAnimationFrame`. */
const FRAME_MS = 16;
/**
 * How often the held direction flips.
 *
 * PICKED SO THE PADDLE VISITS BOTH CLAMPS. `PADDLE_H` is private to `sim.ts`,
 * so the field's own limits are not importable; instead the sweep is made long
 * enough (1400ms at 90 u/s is 126 units against a 96-unit range) that the
 * paddle saturates at the top and at the bottom, which makes the OBSERVED
 * extremes the clamps and lets the speed measurement below exclude the
 * saturated steps without hardcoding a number this file does not own.
 */
const SWEEP_MS = 1400;

const SECRET = 'example-test-secret';

/** How close to an observed extreme counts as saturated: a y within this of one is the clamp, not travel. */
const CLAMP_EPSILON = 0.05;

interface SnapRec {
  at: number;
  snap: DecodedPongSnapshot;
}

interface FrameRec {
  at: number;
  ids: string[];
  /** `PredictedEntity.stats.lastError`: how far the prediction sat from the replayed authoritative pose at the last reconcile. */
  lastError: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length === 0) return NaN;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

d('examples/pong through a real socket', () => {
  const namespace = newNamespace('example');
  // Unique per run, like the namespace: two runs of this file against one
  // Redis must not share a room, and `isValidBase` below is what makes the
  // relay accept it (a room the adapter refuses is silently replaced by the
  // fallback, which is the failure `relay.room-normalised` exists to report).
  const roomId = `pong-${randomUUID().slice(0, 8)}`;
  const previousRedisUrl = process.env.REDIS_URL;

  beforeAll(() => {
    // `attachNodeRelay` reaches for the library's own `getRedis()` and
    // `createSubscriber()` with no options, exactly as a host does, and both
    // resolve their URL from `REDIS_URL`. Pointing it at the test instance is
    // therefore part of standing the adapter up, not a shortcut around it.
    process.env.REDIS_URL = TEST_REDIS_URL;
  });

  afterAll(async () => {
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    // The shared command client is memoized at module scope; a test that
    // leaves it connected leaves a connection behind for whatever runs next.
    resetRedisForTests();
    if (REDIS_AVAILABLE) await flushNamespace(TEST_REDIS_URL, namespace);
  });

  it(
    'the pong runtime, the pong codec, the node relay and the pong client agree end to end',
    async () => {
      const events: string[] = [];
      const t0 = performance.now();
      const log = (line: string) => events.push(`${((performance.now() - t0) / 1000).toFixed(3)} ${line}`);

      // ---- server ---------------------------------------------------------
      //
      // THE RUNTIME IS THE EXAMPLE'S, with one field replaced. `codec.ts` says
      // the binary upgrade is a straight swap of `encodeSnapshot`'s return
      // value and nothing else; this is that swap, and every other method
      // (`tick`, `applyInput`, `join`, `usesPlayout`, `onBufferHealth`,
      // `serialize`) is `pongRuntime`'s own.
      const runtime: RoomRuntime<PongState, PongEvent> = {
        ...pongRuntime,
        encodeSnapshot: encodePongSnapshot,
      };

      const redis = getRedis({ url: TEST_REDIS_URL, onError: () => {} });
      const raw = new Redis(TEST_REDIS_URL);
      const keys = roomKeys(roomId, namespace);

      const statsRecs: RoomStats[] = [];
      const roomEvents: PongEvent[] = [];
      const tickers: Array<Promise<unknown>> = [];
      let tearingDown = false;
      let tickerRunning = false;

      function startTicker(): void {
        if (tearingDown || tickerRunning) return;
        tickerRunning = true;
        const p = runTicker<PongState, PongEvent>({
          runtime,
          redis,
          createSubscriber: () => createSubscriber({ url: TEST_REDIS_URL }),
          roomId,
          namespace,
          geomKey: () => 'pong-example:v1',
          // Well past `RUN_MS`: a planned handoff is `smoothness.redis.test.ts`'s
          // subject, and one inside this run would only add a re-anchor to
          // every measurement below.
          maxRunMs: 60_000,
          checkpointMs: 1000,
          // Long enough that the client's join beats the empty check at
          // startup, short enough that the teardown's wait is a couple of
          // seconds.
          emptyGraceMs: 2500,
          spawnSuccessor: async () => {
            // One run, and it outlives the client. Nothing to hand over to.
          },
          onEvents: (evs) => {
            for (const ev of evs) roomEvents.push(ev);
          },
          onStats: (s) => statsRecs.push(s),
          log: (e) => log(`[ticker] ${e.lvl} ${e.kind} ${JSON.stringify(e.meta ?? {})}`),
        }).then((r) => {
          tickerRunning = false;
          log(`[ticker] exit ${JSON.stringify(r)}`);
        });
        tickers.push(p);
      }

      startTicker();
      // Open the door only once the lease exists, so the relay's own spawn
      // poll cannot race the ticker that is already starting.
      expect(await waitFor(async () => (await raw.get(keys.lease)) !== null, 5000, 25)).toBe(true);

      const httpServer: Server = createServer();
      const wss = new WebSocketServer({ server: httpServer });
      attachNodeRelay(wss, {
        secret: SECRET,
        isValidBase: (base) => base === roomId,
        fallbackRoom: roomId,
        namespace,
        maxPlayers: 4,
        joinMeta: (claims) => ({ name: claims.pid }),
        // The node example's own line, normalising `ws`'s Buffer (or an array
        // of them for a fragmented message) before parsing the JSON array
        // `PredictedEntity` sends.
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

      // ---- client ---------------------------------------------------------
      const pid = `p-${randomUUID().slice(0, 8)}`;
      const handle = 7;
      // Minted once, not once per `mint()` call: a re-mint that changed the pid
      // would change who the player IS halfway through the run.
      const token = makeToken({ pid, handle, sub: `d.${pid}` }, { secret: SECRET });

      const snaps: SnapRec[] = [];
      const frames: FrameRec[] = [];

      const client = createPongClient({
        mint: async () => ({ token, playerId: pid, handle, room: roomId }),
        // No `location` outside a browser; the shape is the node example's.
        socketUrl: (s) =>
          `ws://127.0.0.1:${port}/?token=${encodeURIComponent(s.token)}` +
          `&pid=${encodeURIComponent(s.playerId)}&h=${s.handle}&room=${encodeURIComponent(s.room)}`,
        WebSocketImpl: WebSocket,
        // THE EXAMPLE'S OWN DECODER, and the recording rides on it rather than
        // on a hook added for the test: `decode` is called exactly once per
        // snapshot frame, at arrival, which is precisely the sample the rate
        // and the roster assertions need.
        decode: (buf) => {
          const snap = decodePongSnapshot(buf);
          snaps.push({ at: performance.now(), snap });
          return snap;
        },
        onStallChange: (stalled) => log(`[client] stalled=${stalled}`),
        onTerminal: (reason) => log(`[client] TERMINAL ${reason}`),
      });

      // A HELD DIRECTION, flipped on a timer. `dir` is state the player holds,
      // so this is one `setDir` per flip and nothing else: every stamped record
      // between two flips carries the same value, exactly as a key held down
      // produces.
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
      log(`[client] final ${JSON.stringify(endStats)} predicted=${JSON.stringify(client.paddle.stats)}`);

      // ---- teardown -------------------------------------------------------
      clearInterval(sweep);
      clearInterval(frameTimer);
      client.stop();
      tearingDown = true;
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await Promise.allSettled(tickers);
      raw.disconnect();

      // ---- analysis -------------------------------------------------------
      const firstSnapAt = snaps[0]!.at;
      const steadyFrom = firstSnapAt + STEADY_LEAD_MS;
      const steadySnaps = snaps.filter((s) => s.at >= steadyFrom);
      const steadyFrames = frames.filter((f) => f.at >= steadyFrom);

      // 1. THE SNAPSHOT RATE IS THE SIM'S, measured over three seconds of
      //    steady state at the client's own arrival times.
      const rateWindow = snaps.filter((s) => s.at >= steadyFrom && s.at < steadyFrom + RATE_WINDOW_MS);
      const measuredHz = rateWindow.length / (RATE_WINDOW_MS / 1000);

      // 2. OUR OWN PADDLE IS IN THE ROSTER, in the decoded snapshot and in
      //    what the client drew from it.
      const rosterMisses = steadySnaps.filter((s) => !s.snap.paddles.some((p) => p.pid === pid)).length;
      const drawMisses = steadyFrames.filter((f) => !f.ids.includes(pid)).length;

      // 3. THE HELD DIRECTION MOVES THE SERVER'S PADDLE AT `PADDLE_SPEED`.
      //    Measured on the SERVER's own y, snapshot to snapshot, one tick
      //    apart, excluding every step touching a clamp (the observed extremes
      //    are the clamps; see `SWEEP_MS`).
      const ownY = (s: SnapRec): number | undefined => s.snap.paddles.find((p) => p.pid === pid)?.y;
      const ys = steadySnaps.map(ownY).filter((y): y is number => y !== undefined);
      const loY = Math.min(...ys);
      const hiY = Math.max(...ys);
      const clamped = (y: number) => y <= loY + CLAMP_EPSILON || y >= hiY - CLAMP_EPSILON;
      const speeds: number[] = [];
      for (let i = 1; i < steadySnaps.length; i++) {
        const a = steadySnaps[i - 1]!;
        const b = steadySnaps[i]!;
        if (b.snap.tick - a.snap.tick !== 1) continue;
        const ya = ownY(a);
        const yb = ownY(b);
        if (ya === undefined || yb === undefined) continue;
        if (clamped(ya) || clamped(yb)) continue;
        speeds.push(Math.abs(yb - ya) * TICK_HZ);
      }
      const medianSpeed = median(speeds);
      const offSpeed = speeds.filter((v) => Math.abs(v - PADDLE_SPEED) > PADDLE_SPEED * 0.01).length;

      // 4. AND THE CLIENT PREDICTED THE SAME PADDLE. `lastError` is the
      //    distance between the prediction and the server's y replayed forward
      //    through this client's own stored records: a timeline off by one
      //    tick reads `PADDLE_SPEED / TICK_HZ` here.
      const errors = steadyFrames.map((f) => f.lastError);
      const maxError = Math.max(...errors);
      const medianError = median(errors);

      // 5. A GOAL, AS THE SIMULATION EMITTED IT AND AS THE CLIENT SAW IT.
      const goals = roomEvents.filter((e) => e.type === 'goal');
      const ownGoals = goals.filter((e) => e.type === 'goal' && e.scorer === pid);
      const bestScore = snaps.reduce((n, s) => Math.max(n, s.snap.paddles.find((p) => p.pid === pid)?.score ?? 0), 0);

      // 6. AND THE ROOM NEVER FAULTED.
      const hostErrors = statsRecs.reduce((n, s) => n + s.hostErrors, 0);
      const badEnvelopes = statsRecs.reduce((n, s) => n + s.badEnvelopes, 0);

      const summary = {
        snapshots: snaps.length,
        frames: frames.length,
        measuredHz: +measuredHz.toFixed(2),
        rosterMisses,
        drawMisses,
        paddle: {
          samples: speeds.length,
          medianSpeed: +medianSpeed.toFixed(3),
          maxSpeed: +Math.max(...speeds).toFixed(3),
          offSpeed,
          loY,
          hiY,
        },
        reconcile: { maxError: +maxError.toFixed(4), medianError: +medianError.toFixed(4) },
        predicted: client.paddle.stats,
        goals: goals.length,
        ownGoals: ownGoals.length,
        bestScore,
        server: { hostErrors, badEnvelopes },
        client: endStats,
      };
      // Printed only when something below fails, exactly as the smoothness
      // file prints its own events: a green run says nothing.
      const report = () => `${JSON.stringify(summary, null, 2)}\n${events.join('\n')}`;

      try {
        expect(measuredHz, 'snapshot rate').toBeGreaterThanOrEqual(TICK_HZ * 0.9);
        expect(measuredHz, 'snapshot rate').toBeLessThanOrEqual(TICK_HZ * 1.1);

        expect(rosterMisses, 'snapshots without our paddle').toBe(0);
        expect(drawMisses, 'frames that did not draw our paddle').toBe(0);

        // Enough samples that the median is a measurement rather than an
        // accident: three sweeps' worth of unsaturated travel is far more.
        expect(speeds.length, 'unsaturated paddle steps').toBeGreaterThan(40);
        expect(medianSpeed, 'server paddle speed').toBeGreaterThan(PADDLE_SPEED * 0.99);
        expect(medianSpeed, 'server paddle speed').toBeLessThan(PADDLE_SPEED * 1.01);
        // A paddle can never move faster than its own rule allows, and the
        // step is exact rather than statistical: one tick of `stepPaddleY` at
        // a held dir is `PADDLE_SPEED / TICK_HZ` and the codec quantises it to
        // a hundredth. Anything else is a tick applied twice or skipped.
        expect(offSpeed, 'steps away from PADDLE_SPEED').toBe(0);

        // THE INPUT TIMELINE, PINNED. One tick of disagreement is
        // `PADDLE_SPEED / TICK_HZ` = 4.5 units, so 0.25 is well inside a tick
        // and well outside the codec's own 0.01 quantisation.
        //
        // AND THE BOUND CANNOT PASS VACUOUSLY. On a healthy loopback run the
        // measured error is EXACTLY zero (both ends run `stepPaddleY` on the
        // same record on the same tick, and the codec's 0.01 grid represents
        // every y that rule produces), which is indistinguishable from a
        // prediction that never ran unless the stamping is checked separately:
        // one record per advanced tick over the run, no invalid replay, and
        // the only hard snap is the first confirmation. Measured with
        // `usesPlayout: () => false` on the server (inputs applied on arrival
        // rather than on the tick they name) the same run reports a maxError
        // of 9 units, two whole ticks of paddle, so the bound is live.
        expect(maxError, 'reconcile error').toBeLessThan(0.25);
        // The three lines that make the zero a MEASUREMENT: one stamped record
        // per advanced tick across the run (about 200), and a prediction that
        // is being confirmed rather than re-seated. The first confirmation is a
        // snap by design and it is the only one measured (snaps 1, invalid 0 on
        // all three reference runs); the allowance of one more of each is for a
        // counter re-anchor, which is a healthy event that invalidates the
        // stored history and must not be ROUTINE, since a prediction snapping
        // repeatedly is what a broken timeline looks like from this side.
        expect(client.paddle.stats.stamped, 'stamped records').toBeGreaterThan((RUN_MS / 1000) * TICK_HZ * 0.8);
        expect(client.paddle.stats.snaps, 'hard snaps').toBeLessThanOrEqual(2);
        expect(client.paddle.stats.invalid, 'invalid replays').toBeLessThanOrEqual(1);

        expect(ownGoals.length, 'goal events for our pid').toBeGreaterThanOrEqual(1);
        expect(bestScore, 'our score, as the client decoded it').toBeGreaterThanOrEqual(1);

        expect(hostErrors, 'RoomStats.hostErrors').toBe(0);
        expect(badEnvelopes, 'RoomStats.badEnvelopes').toBe(0);
      } catch (err) {
        console.error(report());
        throw err;
      }
      // One line on success too, because the numbers are the point of the
      // file and re-deriving them means re-running it.
      console.log(`[example.redis] ${JSON.stringify(summary)}`);
    },
    RUN_MS + 20_000
  );
});
