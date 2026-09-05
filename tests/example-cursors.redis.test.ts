// THE OTHER SHIPPED EXAMPLE, THROUGH A REAL SOCKET, AND THE OTHER INPUT PATH.
// `tests/example.redis.test.ts` drives `examples/pong` unmodified and pins the
// STAMPED path: every input carries the tick it applies on, the server buffers
// it and applies it there, and the client predicts the same record on the same
// tick. This file is the same rig around `examples/cursors`, which is the
// deliberate UNSTAMPED contrast, so what it pins is the path pong's file
// structurally cannot reach:
//
//   * `cursorsRuntime` from `examples/cursors/sim.ts` IS the ticker's runtime,
//     with nothing replaced. There is no codec to swap here: this example's
//     wire is the JSON `encodeSnapshot` publishes, which is the point of it;
//   * the relay is `attachNodeRelay` from `src/adapters/node.ts` on a real `ws`
//     server, so the token check, `normalizeRoomId`, the whole admission
//     protocol and the relay itself are the adapter's, not the harness's;
//   * the clients are `createCursorsClient` from `examples/cursors/client.ts`,
//     the DOM-free half of the example, driven on a 16ms timer instead of
//     `requestAnimationFrame`. The connection, the decode, the interpolator,
//     the held pointer and the 10Hz send loop are all the example's; this file
//     moves a pointer and reads what came back.
//
// WHAT THIS FILE PINS THAT PONG'S CANNOT. `cursorsRuntime` declares no
// `usesPlayout` at all and the client leaves `targetTick` at 0, so every input
// takes the ticker's ON-ARRIVAL branch: applied the moment the envelope is
// drained, never buffered against a tick it names. That branch is exercised by
// unit tests and by nothing that goes near a socket, and it is the branch the
// documentation recommends FIRST, because a presence layer is the shape most
// consumers arrive with. The measurement it makes possible is the one a
// stamped room cannot state: how long after a client moves its pointer does
// the room's own snapshot show the pointer there. On the stamped path that
// question has no single answer (the record is applied on the tick it asked
// for, which is deliberately in the future); here it is one send period, one
// round trip and at most one tick, and it is measured below rather than
// argued.
//
// AND IT CANNOT PASS VACUOUSLY. Every probe position is a coordinate the
// server has never held (the join seats a cursor at 0.5, 0.5), so an arrival
// is proof the input crossed the wire and mutated the server's state. MEASURED
// with the one `conn.send` inside `createCursorsClient` made a no-op: the same
// run fails on `probes never seen in a snapshot`, 11 of 11 steady-state probes
// unarrived and 0 of 13 probe coordinates ever observed, with the rest of the
// run (the 10Hz rate, the roster, the zeroed counters) still perfectly green,
// which is exactly why the arrival assertion has to be its own line.
//
// The room and the namespace are unique per run and the namespace is flushed
// afterwards, like every other file here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { WebSocketServer, WebSocket } from 'ws';

import type { ClientInput, RoomStats } from '../src/core/index.js';
import { roomKeys } from '../src/core/index.js';
import { createSubscriber, getRedis, makeToken, resetRedisForTests, runTicker } from '../src/server/index.js';
import { attachNodeRelay } from '../src/adapters/node.js';
import { cursorsRuntime, type CursorsEvent, type CursorsState } from '../examples/cursors/sim.js';
import { createCursorsClient, type CursorsSnapshot } from '../examples/cursors/client.js';
import { TEST_REDIS_URL, probeRedisAvailable, newNamespace, flushNamespace, skipReason, waitFor } from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: example-cursors] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

/** The example's own rate, read off the runtime rather than restated, so a change to cursors moves this with it. */
const TICK_HZ = cursorsRuntime.tickHz;
const TICK_MS = 1000 / TICK_HZ;
/** The example's send cadence, which `client.ts` derives the same way: held pointer state re-asserted once per tick. It is the phase this measurement cannot see inside, so it is part of the bound below rather than an error term. */
const SEND_MS = 1000 / TICK_HZ;

/** How many clients connect. More than one, because the roster claim is about EVERY client's cursor and a roster of one is not a roster. */
const CLIENTS = 3;

/** How long the clients stay up after the first snapshot. Long enough for the rate window and a dozen arrival probes on top of the cold start; short enough that the whole file stays well inside twenty seconds. */
const RUN_MS = 6000;
/** Ignore everything before `firstSnapshotAt + this`: the first second is a cold start, an unanchored counter and a roster still filling, none of which are steady state. */
const STEADY_LEAD_MS = 1200;
/** The window the snapshot rate is measured over. */
const RATE_WINDOW_MS = 3000;
/** The render cadence, a real display's rather than the sim's, exactly as `startCursors` runs on `requestAnimationFrame`. */
const FRAME_MS = 16;

/** How often the prober moves its pointer to a coordinate the room has never held. Four ticks apart, so each probe is sent several times and observed in several snapshots before the next supersedes it: a probe that is missed is a miss, not a race with the next one. */
const PROBE_MS = 400;
/** Probing stops this long before the end, so the last probe has a full window to arrive in rather than being cut off by the teardown. */
const PROBE_TAIL_MS = 600;

/**
 * The bound on "I moved, the room says I moved", measured from the `setPointer`
 * call to the arrival of the first snapshot carrying that coordinate.
 *
 * DERIVED, NOT PICKED. The path is: up to one send period of waiting for the
 * client's own 10Hz loop (100ms), the trip to the relay and onto the bus, up to
 * one tick of waiting for the ticker to drain and publish (100ms), and the trip
 * back. That is 200ms plus two half round trips on loopback, so this is a
 * little under twice the derived worst case: enough headroom that a busy
 * machine does not turn a green run red, and far too tight for a path that
 * buffered the input against a tick (`inputLeadMs` alone is 150ms on top of a
 * measured RTT) or for one that never applied it at all.
 */
const ARRIVAL_BOUND_MS = 400;

const SECRET = 'example-cursors-test-secret';

interface SnapRec {
  at: number;
  snap: CursorsSnapshot;
}

interface Probe {
  i: number;
  x: number;
  y: number;
  sentAt: number;
  arrivedAt?: number | undefined;
  arrivedTick?: number | undefined;
}

/** Probe coordinates on the thousandths grid `encodeSnapshot` quantises to, so an arrival is an EXACT match rather than a tolerance, and every one of them distinct and far from the 0.5, 0.5 a join seats a cursor at. */
function probePoint(i: number): { x: number; y: number } {
  return { x: (137 + i * 31) / 1000, y: (911 - i * 29) / 1000 };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length === 0) return NaN;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

d('examples/cursors through a real socket', () => {
  const namespace = newNamespace('example-cursors');
  // Unique per run, like the namespace: two runs of this file against one
  // Redis must not share a room, and `isValidBase` below is what makes the
  // relay accept it (a room the adapter refuses is silently replaced by the
  // fallback, which is the failure `relay.room-normalised` exists to report).
  const roomId = `cursors-${randomUUID().slice(0, 8)}`;
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
    'the cursors runtime, the node relay and the cursors client agree end to end on the on-arrival path',
    async () => {
      const events: string[] = [];
      const t0 = performance.now();
      const log = (line: string) => events.push(`${((performance.now() - t0) / 1000).toFixed(3)} ${line}`);

      // ---- server ---------------------------------------------------------
      //
      // THE RUNTIME IS THE EXAMPLE'S, UNTOUCHED. Pong's file spreads
      // `pongRuntime` to swap one field; there is nothing to swap here, and
      // that includes the absence worth naming: `cursorsRuntime` declares no
      // `usesPlayout`, so the ticker's stamped branch is unreachable for this
      // room no matter what a client sends.
      const runtime = cursorsRuntime;

      const redis = getRedis({ url: TEST_REDIS_URL, onError: () => {} });
      const raw = new Redis(TEST_REDIS_URL);
      const keys = roomKeys(roomId, namespace);

      const statsRecs: RoomStats[] = [];
      const roomEvents: CursorsEvent[] = [];
      const tickers: Array<Promise<unknown>> = [];
      let tearingDown = false;
      let tickerRunning = false;

      function startTicker(): void {
        if (tearingDown || tickerRunning) return;
        tickerRunning = true;
        const p = runTicker<CursorsState, CursorsEvent>({
          runtime,
          redis,
          createSubscriber: () => createSubscriber({ url: TEST_REDIS_URL }),
          roomId,
          namespace,
          geomKey: () => 'cursors-example:v1',
          // Well past `RUN_MS`: a planned handoff is `smoothness.redis.test.ts`'s
          // subject, and one inside this run would only add a re-anchor to
          // every measurement below.
          maxRunMs: 60_000,
          checkpointMs: 1000,
          // Long enough that the clients' joins beat the empty check at
          // startup, short enough that the teardown's wait is a couple of
          // seconds.
          emptyGraceMs: 2500,
          spawnSuccessor: async () => {
            // One run, and it outlives the clients. Nothing to hand over to.
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

      // EVERY INPUT THE RELAY PARSED, counted by whether it named a tick. This
      // is the unstamped claim observed ON THE WIRE rather than read off the
      // example's source: `decodeInput` is the last place a record is a record
      // before the ticker decides which branch applies it.
      let inputsSeen = 0;
      let stampedInputs = 0;

      const httpServer: Server = createServer();
      const wss = new WebSocketServer({ server: httpServer });
      attachNodeRelay(wss, {
        secret: SECRET,
        isValidBase: (base) => base === roomId,
        fallbackRoom: roomId,
        namespace,
        maxPlayers: 8,
        joinMeta: (claims) => ({ name: claims.pid }),
        // The node example's own line, normalising `ws`'s Buffer (or an array
        // of them for a fragmented message) before parsing the JSON the
        // cursors client sends.
        decodeInput: (buf): ClientInput[] => {
          const bytes = Array.isArray(buf) ? Buffer.concat(buf as Buffer[]) : (buf as Buffer);
          const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ClientInput | ClientInput[];
          const records = Array.isArray(parsed) ? parsed : [parsed];
          for (const r of records) {
            inputsSeen++;
            if ((r.targetTick ?? 0) > 0) stampedInputs++;
          }
          return records;
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

      // ---- clients --------------------------------------------------------
      //
      // Three of them, all the example's own wiring. Client 0 is the PROBER:
      // it is the one whose pointer moves and whose snapshots are recorded.
      // The other two hold a fixed pointer and exist so the roster claim has
      // something to be about.
      const pids = Array.from({ length: CLIENTS }, () => `p-${randomUUID().slice(0, 8)}`);
      const snaps: SnapRec[] = [];
      const probes: Probe[] = [];

      const clients = pids.map((pid, idx) => {
        // Minted once, not once per `mint()` call: a re-mint that changed the
        // pid would change who the player IS halfway through the run.
        const token = makeToken({ pid, handle: idx + 1, sub: `d.${pid}` }, { secret: SECRET });
        return createCursorsClient({
          mint: async () => ({ token, playerId: pid, handle: idx + 1, room: roomId }),
          // No `location` outside a browser; the shape is the node example's.
          socketUrl: (s) =>
            `ws://127.0.0.1:${port}/?token=${encodeURIComponent(s.token)}` +
            `&pid=${encodeURIComponent(s.playerId)}&h=${s.handle}&room=${encodeURIComponent(s.room)}`,
          WebSocketImpl: WebSocket,
          // THE EXAMPLE'S OWN DECODER by default; the prober's wraps it so the
          // recording rides on the frame the client itself decoded, at the
          // moment it decoded it, which is precisely the sample the rate and
          // the arrival measurements need.
          decode:
            idx === 0
              ? (buf) => {
                  const snap = JSON.parse(new TextDecoder().decode(buf)) as CursorsSnapshot;
                  const at = performance.now();
                  snaps.push({ at, snap });
                  const mine = snap.cursors.find((c) => c.pid === pid);
                  if (mine) {
                    // THE ARRIVAL. Any probe still outstanding whose exact
                    // coordinate this snapshot carries has landed. Checked
                    // across all outstanding probes rather than only the
                    // oldest, so a skipped one shows up as a skipped one
                    // rather than stalling every probe behind it.
                    for (const p of probes) {
                      if (p.arrivedAt !== undefined) continue;
                      if (mine.x === p.x && mine.y === p.y) {
                        p.arrivedAt = at;
                        p.arrivedTick = snap.tick;
                      }
                    }
                  }
                  return snap;
                }
              : undefined,
          onStallChange: (stalled) => log(`[client ${idx}] stalled=${stalled}`),
          onTerminal: (reason) => log(`[client ${idx}] TERMINAL ${reason}`),
        });
      });

      const prober = clients[0]!;

      // Every client renders, because `frame()` is what advances the tick
      // counter and samples the interpolator, and a client that never calls it
      // is not the client the example ships.
      const rosterSeen = clients.map(() => new Set<string>());
      const frameTimer = setInterval(() => {
        const at = performance.now();
        for (let i = 0; i < clients.length; i++) {
          const view = clients[i]!.frame(at);
          for (const pid of view.roster) rosterSeen[i]!.add(pid);
        }
      }, FRAME_MS);

      await Promise.all(clients.map((c) => c.start()));
      expect(await waitFor(() => snaps.length > 0, 8000, 25)).toBe(true);

      // The two non-probers point somewhere fixed, so their cursors are in the
      // roster for a reason rather than by the join's default.
      clients[1]!.setPointer(0.25, 0.25);
      clients[2]!.setPointer(0.75, 0.75);
      clients[2]!.setDown(true);

      // ---- the probes -----------------------------------------------------
      //
      // One `setPointer` per probe and nothing else: the send is the example's
      // own loop re-asserting held state at the room's rate, which is exactly
      // what a real pointer produces. The clock starts at the `setPointer`,
      // because that is the moment the player moved.
      let nextProbe = 0;
      const probeTimer = setInterval(() => {
        const { x, y } = probePoint(nextProbe);
        probes.push({ i: nextProbe, x, y, sentAt: performance.now() });
        prober.setPointer(x, y);
        nextProbe++;
      }, PROBE_MS);

      await new Promise((resolve) => setTimeout(resolve, RUN_MS - PROBE_TAIL_MS));
      clearInterval(probeTimer);
      await new Promise((resolve) => setTimeout(resolve, PROBE_TAIL_MS));

      const endStats = clients.map((c) => c.conn.stats());
      log(`[clients] final ${JSON.stringify(endStats)}`);

      // ---- teardown -------------------------------------------------------
      clearInterval(frameTimer);
      for (const c of clients) c.stop();
      tearingDown = true;
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await Promise.allSettled(tickers);
      raw.disconnect();

      // ---- analysis -------------------------------------------------------
      const firstSnapAt = snaps[0]!.at;
      const steadyFrom = firstSnapAt + STEADY_LEAD_MS;
      const steadySnaps = snaps.filter((s) => s.at >= steadyFrom);

      // 1. THE SNAPSHOT RATE IS THE SIM'S, measured over three seconds of
      //    steady state at the prober's own arrival times.
      const rateWindow = snaps.filter((s) => s.at >= steadyFrom && s.at < steadyFrom + RATE_WINDOW_MS);
      const measuredHz = rateWindow.length / (RATE_WINDOW_MS / 1000);

      // 2. EVERY CLIENT'S CURSOR IS IN THE ROSTER: in the room's own snapshot,
      //    and in the relay's meta frame as each client parsed it.
      const rosterMisses = steadySnaps.filter((s) => !pids.every((pid) => s.snap.cursors.some((c) => c.pid === pid))).length;
      const rosterFrameMisses = rosterSeen.filter((seen) => !pids.every((pid) => seen.has(pid))).length;

      // 3. THE ON-ARRIVAL PATH, MEASURED. Only probes issued in steady state
      //    count toward the bound; the earlier ones are reported and not
      //    asserted, because a cold start is not what this measures.
      const steadyProbes = probes.filter((p) => p.sentAt >= steadyFrom);
      const unarrived = steadyProbes.filter((p) => p.arrivedAt === undefined);
      const latencies = steadyProbes
        .filter((p) => p.arrivedAt !== undefined)
        .map((p) => p.arrivedAt! - p.sentAt);
      const maxLatency = latencies.length > 0 ? Math.max(...latencies) : NaN;
      const minLatency = latencies.length > 0 ? Math.min(...latencies) : NaN;

      // 4. AND THE MOVE IS A MOVE, not a coincidence. Every probe coordinate is
      //    one the room has never held, so the count of DISTINCT probe
      //    coordinates observed on the server's own cursor is the count of
      //    inputs that crossed the wire and mutated state.
      const observed = new Set<string>();
      for (const s of snaps) {
        const mine = s.snap.cursors.find((c) => c.pid === pids[0]);
        if (mine) observed.add(`${mine.x},${mine.y}`);
      }
      const distinctProbePositions = probes.filter((p) => observed.has(`${p.x},${p.y}`)).length;

      // 5. AND THE ROOM NEVER FAULTED. `starves` is the one this file can
      //    assert a zero on that pong's cannot: a playout consume miss is only
      //    possible where a buffer exists, and on the on-arrival path none is
      //    ever created.
      const hostErrors = statsRecs.reduce((n, s) => n + s.hostErrors, 0);
      const badEnvelopes = statsRecs.reduce((n, s) => n + s.badEnvelopes, 0);
      const starves = statsRecs.reduce((n, s) => n + s.starves, 0);

      const summary = {
        snapshots: snaps.length,
        measuredHz: +measuredHz.toFixed(2),
        rosterMisses,
        rosterFrameMisses,
        arrival: {
          probes: probes.length,
          steadyProbes: steadyProbes.length,
          arrived: latencies.length,
          minMs: +minLatency.toFixed(1),
          medianMs: +median(latencies).toFixed(1),
          maxMs: +maxLatency.toFixed(1),
          boundMs: ARRIVAL_BOUND_MS,
          derivedWorstMs: +(SEND_MS + TICK_MS + median(endStats.map((s) => s.rttMs))).toFixed(1),
        },
        distinctProbePositions,
        inputs: { seen: inputsSeen, stamped: stampedInputs },
        idleEvents: roomEvents.length,
        server: { hostErrors, badEnvelopes, starves },
        clients: endStats.map((s) => ({ rttMs: +s.rttMs.toFixed(1), snapshotsReceived: s.snapshotsReceived, reconnects: s.reconnects })),
      };
      // Printed only when something below fails, exactly as pong's file prints
      // its own events: a green run says nothing.
      const report = () => `${JSON.stringify(summary, null, 2)}\n${events.join('\n')}`;

      try {
        expect(measuredHz, 'snapshot rate').toBeGreaterThanOrEqual(TICK_HZ * 0.9);
        expect(measuredHz, 'snapshot rate').toBeLessThanOrEqual(TICK_HZ * 1.1);

        expect(rosterMisses, 'snapshots missing a client cursor').toBe(0);
        expect(rosterFrameMisses, 'clients whose roster frame missed a pid').toBe(0);

        // Enough probes that the maximum is a measurement rather than an
        // accident, and every one of them landed.
        expect(steadyProbes.length, 'steady-state probes').toBeGreaterThanOrEqual(8);
        expect(unarrived.length, 'probes never seen in a snapshot').toBe(0);
        expect(maxLatency, 'move-to-snapshot latency').toBeLessThanOrEqual(ARRIVAL_BOUND_MS);

        // THE NON-VACUITY LINE. Every probe coordinate is one the server had
        // never held, so this counts inputs that actually moved the room's
        // cursor. With the client's `conn.send` made a no-op the server's
        // cursor sits at 0.5, 0.5 for the whole run and this reads 0.
        expect(distinctProbePositions, 'probe coordinates observed on the server cursor').toBe(probes.length);

        // THE PATH ITSELF, OBSERVED ON THE WIRE. The example sends unstamped,
        // so the ticker's stamped branch is never taken and no playout buffer
        // is ever created for it.
        expect(inputsSeen, 'inputs the relay decoded').toBeGreaterThan((RUN_MS / SEND_MS) * CLIENTS * 0.8);
        expect(stampedInputs, 'inputs carrying a targetTick').toBe(0);
        expect(starves, 'RoomStats.starves').toBe(0);

        expect(hostErrors, 'RoomStats.hostErrors').toBe(0);
        expect(badEnvelopes, 'RoomStats.badEnvelopes').toBe(0);
      } catch (err) {
        console.error(report());
        throw err;
      }
      // One line on success too, because the numbers are the point of the
      // file and re-deriving them means re-running it.
      console.log(`[example-cursors.redis] ${JSON.stringify(summary)}`);
    },
    RUN_MS + 20_000
  );
});
