// THE OWNER'S REQUIREMENT, PINNED. "Clients operate smoothly while the server
// is running; the server is authoritative; clients may be a little out of sync
// but must not stutter." Everything else in this repo is a mechanism in service
// of that sentence, and until this file existed the sentence itself was
// measured once by an audit harness and asserted by nothing.
//
// Every test here runs the REAL chain (a real ws server, `admitSocket`, an
// in-process `runTicker` against a real Redis, the real `RoomConnection` and
// `SnapshotInterpolator` driven at 60Hz through `frame()`, with an emulated
// 40ms one-way delay in both directions) and then asserts on WHAT THE CLIENT
// RENDERED. See `tests/helpers/smoothness.ts` for the harness itself.
//
// THE THRESHOLDS ARE DELIBERATELY LOOSE, and that is not laziness. The
// measured values on an idle machine are far inside them (peak rendered speed
// 106 against a 150 bound, handoff snapshot gaps 9 to 32ms against a 150ms
// bound); a gate tightened onto the measured number is a gate that reddens on a
// loaded CI runner for reasons that have nothing to do with the library. What
// the bounds have to catch is a STUTTER: a backward step, a frozen frame, a
// rubber-band, a handoff the client can see. Those are zero-or-not properties,
// and they are asserted exactly.
import { describe, it, expect } from 'vitest';
import { TEST_REDIS_URL, probeRedisAvailable, newNamespace, flushNamespace, skipReason, waitFor } from './helpers/env.js';
import { TOO_JITTERY, jitterSkipReason } from './helpers/jitter.js';
import { runSmoothness, TICK_MS, type SmoothnessAnalysis } from './helpers/smoothness.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: smoothness] ${skipReason()}`);

// KEPT REAL, AND GATED ON WHETHER REAL MEANS ANYTHING HERE. Every scenario
// below drives a 60Hz render loop over a real socket and then asserts that
// nothing stuttered, and the stutter assertions are exact zeroes: no backward
// step, no motionless frame, no blank frame. A bound of zero cannot be scaled
// by a jitter measurement without being deleted, and a host that cannot
// deliver a 25ms timer inside 37ms cannot run a 60Hz render loop cleanly
// either, so on such a host this file measures the runner and not the
// library. It skips there, loudly, rather than loosening what it exists to
// pin: see `helpers/jitter.ts`. Four to five of these six cases were the
// reddest part of a loaded full-suite run and every one of them was green run
// alone, which is exactly the shape that gate describes.
if (TOO_JITTERY) console.warn(jitterSkipReason('smoothness'));

const d = REDIS_AVAILABLE && !TOO_JITTERY ? describe : describe.skip;

/** One one-way delay for every scenario: enough that interpolation, the lead and the clock offset all matter, small enough that a 10 second run is a long one. */
const OWD_MS = 40;
/** Rendered speed a client may never exceed. The bot travels at 100 u/s, so this is a 50% overshoot: a rubber-band from a resync measured 5000. */
const PEAK_LIMIT = 150;
/** A snapshot gap a player would notice. The client's interpolation delay plus extrapolation covers far more, so this is the bound on the HANDOFF being invisible, not on the buffer surviving it. */
const HANDOFF_GAP_LIMIT_MS = 150;
/**
 * Rendered speed a client may exceed while it is GLIDING OUT OF A RECONNECT,
 * and only then. The resume glide (`beginEpoch` -> `clear()` -> `resumeFrom`)
 * deliberately covers the outage's worth of distance faster than real time, so
 * a bound at `PEAK_LIMIT` would forbid the very mechanism this scenario pins.
 * The audit measured 268 u/s on a 350ms outage against 1500 u/s before the
 * glide existed, and this harness measures 203 on its own ~220ms outage, so
 * this sits between the two: wide enough that a slower runner's longer outage
 * stays green, far below the snap it replaced.
 */
const RESUME_PEAK_LIMIT = 400;
/**
 * Motionless frames a reconnect may cost. This one is deliberately TIGHT
 * rather than loose, which is the exception the file's header describes: the
 * measured value with the resume glide is 0, and the shape it exists to catch
 * (the glide gone, so the first snapshot of the new epoch snaps and the entity
 * waits while the timeline catches up) measured 4 to 6. A bound with enough
 * headroom to swallow that would not be a gate at all. The frames the OUTAGE
 * itself covers are hold frames and are excluded from the count by the
 * harness, so this counts only frames the client had data for and did not move.
 */
const ZERO_MOTION_LIMIT = 3;
/**
 * Units a client's own entity must travel across the steady window of scenario
 * M. It moves one unit per tick per applied input, so a steady window of six
 * seconds and more is worth 120 and up: measured 137.8 to 138.9 across the
 * three clients. The floor is well under that because the window's exact
 * length depends on when the first snapshot landed, and what it has to catch
 * is a sender whose inputs stopped being applied, which reads as near zero.
 */
const OWN_ADVANCE_FLOOR = 60;
/** How far the least-served sender may fall behind the best-served one. Measured 0.99; a starved sender reads far below this. */
const FAIRNESS_RATIO = 0.6;

const TEST_TIMEOUT_MS = 60_000;

/** Compact context for a failure message: the numbers, not the 600 frames behind them. Takes anything carrying an analysis, so one client of a multi-client run reads the same way a whole run does. */
function summary(res: { analysis: SmoothnessAnalysis }): string {
  const a = res.analysis;
  return JSON.stringify({
    rendered: a.rendered,
    entities: a.entities,
    snapshotGap: { maxMs: a.snapshotGap.maxMs, over150: a.snapshotGap.over150.slice(0, 5), handoffs: a.snapshotGap.handoffs },
    tick: a.tick,
    server: a.server,
    client: a.client,
  });
}

d('client smoothness over the real chain', () => {
  // -------------------------------------------------------------------------
  // A: steady state. Nothing happens. This is the baseline every other
  // scenario is a perturbation of, and the one a regression in the
  // interpolator, the playout buffer or the tick counter shows up in first.
  // -------------------------------------------------------------------------
  it('renders a constant-velocity entity smoothly in steady state, with a clean server', async () => {
    const namespace = newNamespace('smooth-steady');
    try {
      const res = await runSmoothness({
        namespace,
        owdMs: OWD_MS,
        runMs: 9000,
        // Comfortably past the run: scenario A must contain no handoff.
        maxRunMs: 30_000,
      });
      const a = res.analysis;
      const ctx = summary(res);

      // A run that connected to nothing would satisfy every "zero" below, so
      // the measurement itself is asserted before anything is asserted about it.
      expect(a.snapshots, ctx).toBeGreaterThan(100);
      expect(a.rendered.measured, ctx).toBeGreaterThan(200);

      // THE REQUIREMENT ITSELF. A backward step and a frozen frame are the two
      // shapes a stutter takes, and neither is a matter of degree.
      expect(a.rendered.backward, ctx).toBe(0);
      expect(a.rendered.zeroMotion, ctx).toBe(0);
      expect(a.rendered.peak, ctx).toBeLessThan(PEAK_LIMIT);

      // The server side of "smooth": once the room is warm, this client's
      // stamped inputs land in their own tick and the buffer is never empty.
      // The first seconds are excluded because a cold start genuinely starves
      // (the client has not begun stamping yet), which is not a defect.
      expect(a.server.lateAfterSteady, ctx).toBe(0);
      // Starves are allowed a tiny tail rather than pinned at zero: a loaded
      // runner can delay one packet past its tick without anything being wrong
      // (measured on a shared box with twenty concurrent clients: 0 to 2 per
      // client, never more), and a real starvation problem reads as dozens.
      expect(a.server.starvesAfterSteady, ctx).toBeLessThanOrEqual(2);

      // And nothing in the room was quietly failing while it looked healthy.
      expect(a.server.totals.publishFails, ctx).toBe(0);
      expect(a.server.totals.renewFails, ctx).toBe(0);
      expect(a.server.totals.hostErrors, ctx).toBe(0);
    } finally {
      await flushNamespace(TEST_REDIS_URL, namespace);
    }
  }, TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // B: the planned standby handoff, which is what every ticker in production
  // does at its duration cap. `maxRunMs` of 4s puts two of them inside the run.
  // The claim under test is that a handoff is INVISIBLE: the tick grid
  // continues, the client's snapshot stream does not gap, and nothing it
  // renders stutters.
  // -------------------------------------------------------------------------
  it('hands off between ticker lifetimes without a visible seam', async () => {
    const namespace = newNamespace('smooth-handoff');
    try {
      const res = await runSmoothness({
        namespace,
        owdMs: OWD_MS,
        runMs: 10_000,
        // Below `runMs`, and above the 3s `standbyLeadMs`, so each ticker
        // spawns its standby one second in and releases three seconds later.
        maxRunMs: 4000,
        standbyMs: 8000,
      });
      const a = res.analysis;
      const ctx = summary(res);

      expect(a.server.handoffs.length, ctx).toBeGreaterThanOrEqual(1);

      for (const h of a.server.handoffs) {
        // THE TICK COUNT IS CONTINUOUS. The successor restores the predecessor's
        // final checkpoint, so its first tick is the next one: not a repeat (the
        // room would rewind) and not a skip (it would jump).
        expect(h.tickTo, ctx).toBe(h.tickFrom + 1);
        // THE GRID CONTINUES. `serverTime` is the axis every client interpolates
        // remote motion on, so a successor that re-based it would move every
        // entity in the room by the difference.
        expect(Math.abs(h.gridGapMs), ctx).toBeLessThanOrEqual(TICK_MS);
      }

      // The client saw the change of publisher and saw no interruption in it.
      expect(a.snapshotGap.handoffs.length, ctx).toBeGreaterThanOrEqual(1);
      for (const h of a.snapshotGap.handoffs) {
        expect(h.gapMs, ctx).toBeLessThan(HANDOFF_GAP_LIMIT_MS);
      }

      expect(a.rendered.backward, ctx).toBe(0);
      expect(a.rendered.zeroMotion, ctx).toBe(0);
    } finally {
      await flushNamespace(TEST_REDIS_URL, namespace);
    }
  }, TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // C: the client's own socket dies mid-run, which is the routine event on
  // every platform this library targets (Vercel's relay drops every socket in
  // the fleet at its 800s cap) and the one the four cases above never
  // contained. The ladder reconnects on its own (`RECONNECT_BASE_MS` 100,
  // jittered, so the outage is a few hundred ms), and what is under test is
  // the EPOCH BOUNDARY: `beginEpoch` clears the interpolator and hands it back
  // the poses the player is looking at, so the new epoch's first snapshot
  // glides out of them instead of snapping. Before that mechanism a comparable
  // outage rendered a 25-unit step at 1500 u/s and five motionless frames.
  // -------------------------------------------------------------------------
  it('glides through an ordinary reconnect without a blank frame or a backward step', async () => {
    const namespace = newNamespace('smooth-reconnect');
    let dropped = false;
    let reopened = false;
    let droppedAt = 0;
    let reopenedAt = 0;
    try {
      const res = await runSmoothness({
        namespace,
        owdMs: OWD_MS,
        // The scenario's own actions run longer than this; `runMs` is only the
        // floor.
        runMs: 1000,
        maxRunMs: 30_000,
        during: async (ctl) => {
          // Past the steady lead, so the outage lands in the measured window
          // rather than in the cold start that is excluded from it.
          await new Promise((r) => setTimeout(r, 4000));
          dropped = ctl.dropFromClient();
          droppedAt = ctl.now();
          // `reconnects` moves when the ladder SCHEDULES, so pairing it with a
          // status of 'open' is what makes this the reopen and not the drop.
          reopened = await waitFor(() => ctl.conn.status === 'open' && ctl.conn.stats().reconnects === 1, 10_000, 10);
          reopenedAt = ctl.now();
          // Long enough for several clean stats flushes after the new epoch.
          await new Promise((r) => setTimeout(r, 4500));
        },
      });
      const a = res.analysis;
      // The outage rides along in the context: every bound below is a function
      // of how long the client was away, so a red run is unreadable without it
      // (measured 224ms: the ladder's first delay plus a mint, a connect and a
      // one-way delay).
      const ctx = `outageMs=${(reopenedAt - droppedAt).toFixed(0)} ${summary(res)}`;

      expect(dropped, ctx).toBe(true);
      expect(reopened, ctx).toBe(true);
      expect(a.snapshots, ctx).toBeGreaterThan(100);
      expect(a.rendered.measured, ctx).toBeGreaterThan(200);

      // ONE OUTAGE, ONE RECONNECT. More than one means the ladder tripped over
      // itself or the room refused the returning player and it came back round.
      expect(a.client.reconnects, ctx).toBe(1);

      // THE REQUIREMENT, ACROSS AN EPOCH BOUNDARY. Nothing may step backward,
      // and nothing may VANISH: the held poses cover the outage, so a frame
      // with no bot in it is the reconnect blanking the world.
      expect(a.rendered.backward, ctx).toBe(0);
      expect(a.rendered.blankFrames, ctx).toBe(0);
      expect(a.rendered.missingBot, ctx).toBe(0);

      // The frames the client had data for and could not move anything on.
      // Measured 0 here, and bounded just above rather than at zero because a
      // loaded runner's longer outage can leave the buffer with one sample for
      // a frame or two after the epoch turns over. It stays well under the 4
      // to 6 the pre-glide snap produced: see ZERO_MOTION_LIMIT.
      expect(a.rendered.zeroMotion, ctx).toBeLessThanOrEqual(ZERO_MOTION_LIMIT);

      // AND THE GLIDE ITSELF IS NOT A RUBBER-BAND. Both the frame-to-frame
      // peak and the one step across the boundary (which the frame-to-frame
      // pass skips, because one side of it is a held frame) stay far below the
      // snap they replaced.
      expect(a.rendered.peak, ctx).toBeLessThan(RESUME_PEAK_LIMIT);
      expect(a.rendered.resumeSteps.length, ctx).toBeGreaterThanOrEqual(1);
      for (const s of a.rendered.resumeSteps) {
        expect(s.dx, ctx).toBeGreaterThanOrEqual(0);
        expect(s.speed, ctx).toBeLessThan(RESUME_PEAK_LIMIT);
      }

      // THE SERVER FORGETS THE OUTAGE TOO. The new epoch re-anchors the tick
      // counter and the sender resyncs onto it, so the room stops seeing this
      // player's inputs arrive for ticks it has already simulated. Two stats
      // windows is the grace; everything after that has to be clean.
      const tail = res.statsRecs.filter((r) => r.at >= reopenedAt + 2000 && r.at <= res.endedAt);
      expect(tail.length, ctx).toBeGreaterThanOrEqual(1);
      for (const r of tail) {
        expect(r.s.lateInputs, ctx).toBe(0);
      }
      expect(a.server.totals.hostErrors, ctx).toBe(0);
    } finally {
      await flushNamespace(TEST_REDIS_URL, namespace);
    }
  }, TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // D: the relay's OWN lifetime cap, which is a separate lifetime from the
  // ticker's and is answered by a WARM SWAP rather than a reconnect. The
  // client adopts a replacement socket once that socket proves it can deliver,
  // so a swap must cost neither a reconnect nor a status change nor a frame.
  // -------------------------------------------------------------------------
  it('swaps relays at their lifetime cap without a reconnect or a dropped frame', async () => {
    const namespace = newNamespace('smooth-relayswap');
    try {
      const res = await runSmoothness({
        namespace,
        owdMs: OWD_MS,
        runMs: 11_000,
        maxRunMs: 30_000,
        // A RELAY LIFETIME BELOW `2 * RELAY_EXPIRY_LEAD_MS` CANNOT BE WARM
        // SWAPPED, and this number is where that is pinned. The relay announces
        // `relay-expiring` RELAY_EXPIRY_LEAD_MS (5s) ahead of its own cap, and
        // `beginWarmSwap` refuses a second swap started less than
        // RELAY_EXPIRY_LEAD_MS after the last one. So a lifetime of 6s
        // announces one second after each attach, the limiter declines, the
        // socket reaches its cap and closes 4004, and the client falls back to
        // the COLD reconnect this test exists to prove does not happen
        // (measured: reconnects 1, a 350ms snapshot gap, two zero-motion
        // frames). At 10s the announcements are exactly 5s apart and the chain
        // is sustainable, which is also what the shipped Vercel adapter
        // produces from a platform cap (`maxDurationS * 1000 - 10s`).
        relayLifetimeMs: 10_000,
      });
      const a = res.analysis;
      const ctx = summary(res);

      expect(a.client.relaySwaps, ctx).toBeGreaterThanOrEqual(1);
      // A SWAP IS NOT A RECONNECT. Same room, same server timeline, same tick
      // anchor, same buffered frames: if this counter moves, the swap fell back
      // to the cold path and the player saw the banner.
      expect(a.client.reconnects, ctx).toBe(0);

      // And it is not an epoch change either, so the status never leaves 'open'.
      const opened = res.statuses.indexOf('open');
      expect(opened, ctx).toBeGreaterThanOrEqual(0);
      expect(res.statuses.slice(opened), ctx).toEqual(res.statuses.slice(opened).map(() => 'open'));

      expect(a.rendered.backward, ctx).toBe(0);
      expect(a.rendered.peak, ctx).toBeLessThan(PEAK_LIMIT);
    } finally {
      await flushNamespace(TEST_REDIS_URL, namespace);
    }
  }, TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // F: the render loop stops for two seconds with the socket wide open, which
  // is a backgrounded tab and nothing more exotic. The counter is deliberately
  // re-anchored across a frozen render loop rather than caught up, so what is
  // measured here is the RECOVERY: the client's stamping converges back onto
  // the tick it wants, and the server stops seeing late inputs.
  // -------------------------------------------------------------------------
  it('recovers its stamping and stops arriving late after a frozen render loop', async () => {
    const namespace = newNamespace('smooth-freeze');
    let recovered = false;
    let recoveredAt = 0;
    try {
      const res = await runSmoothness({
        namespace,
        owdMs: OWD_MS,
        // The scenario's own actions run longer than this; `runMs` is only the
        // floor.
        runMs: 1000,
        maxRunMs: 30_000,
        during: async (ctl) => {
          await new Promise((r) => setTimeout(r, 3500));
          ctl.freezeRender();
          await new Promise((r) => setTimeout(r, 2000));
          ctl.resumeRender();
          // The counter is unanchored by the first frame after the gap and
          // re-anchored off the next snapshot, so this converges through
          // `desiredTick()` rather than by counting up to it.
          recovered = await waitFor(() => Math.abs(ctl.conn.tick.value - ctl.conn.desiredTick()) <= 2, 3000, 25);
          recoveredAt = ctl.now();
          // Long enough for at least two clean stats flushes after recovery.
          await new Promise((r) => setTimeout(r, 2500));
        },
      });
      const ctx = summary(res);

      expect(recovered, ctx).toBe(true);

      // THE SERVER STOPS SEEING LATE INPUTS. A window is a full second wide and
      // the recovery lands inside one of them, so the first window that can be
      // asked about cleanly is the one after that: everything from there on has
      // to be clean, not merely trending clean.
      const tail = res.statsRecs.filter((r) => r.at >= recoveredAt + 1500);
      expect(tail.length, ctx).toBeGreaterThanOrEqual(1);
      for (const r of tail) {
        expect(r.s.lateInputs, ctx).toBe(0);
      }
    } finally {
      await flushNamespace(TEST_REDIS_URL, namespace);
    }
  }, TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // M: three honest clients in ONE room, which is the first thing in this file
  // that is a ROOM rather than a client. Everything above drives a single
  // socket, so every multi-client property the library has (the roster
  // reaching every socket, three stamped senders sharing one playout pass, one
  // room's `players` count) was pinned by nothing end to end. Each client runs
  // the identical wiring to scenario A, so a regression that only shows up
  // with company shows up here as A's own assertions failing on client two or
  // three.
  // -------------------------------------------------------------------------
  it('serves three clients in one room, each rendering the whole roster smoothly', async () => {
    const namespace = newNamespace('smooth-three');
    const CLIENTS = 3;
    try {
      const res = await runSmoothness({
        namespace,
        owdMs: OWD_MS,
        runMs: 10_000,
        // Comfortably past the run: this scenario must contain no handoff.
        maxRunMs: 30_000,
        clients: CLIENTS,
      });
      const pids = res.clients.map((c) => c.pid);
      expect(res.clients.length).toBe(CLIENTS);

      for (const c of res.clients) {
        const a = c.analysis;
        const ctx = `${c.pid} ${summary(c)}`;

        // Scenario A's own liveness and stutter assertions, per client.
        expect(a.snapshots, ctx).toBeGreaterThan(100);
        expect(a.rendered.measured, ctx).toBeGreaterThan(200);
        expect(a.rendered.backward, ctx).toBe(0);
        expect(a.rendered.peak, ctx).toBeLessThan(PEAK_LIMIT);

        // ROSTER FAN-OUT. The runtime publishes a position per player, so
        // every client has to be drawing all three of them plus the bot: a
        // fan-out that reached one socket and not another (a per-connection
        // allowlist gone wrong, a roster keyed by the wrong id) reads here.
        expect(a.entities.alwaysPresent, ctx).toEqual(['bot', ...pids].sort());

        // PER-SENDER FAIRNESS. Only this client's own stamped inputs move its
        // own entity, one unit per tick, so a sender the room starved out in
        // favour of a noisier one has an entity that barely moved. The floor
        // is a fraction of the ideal (20 u/s across a steady window of six
        // seconds and more) rather than the ideal itself, because the window's
        // exact length is a property of when the first snapshot landed.
        expect(a.entities.ownAdvance, ctx).toBeGreaterThan(OWN_ADVANCE_FLOOR);
      }

      // ...and the same again as a RATIO, which is the half an absolute floor
      // cannot express: three senders sharing one playout pass have to be
      // served alike, not merely all served.
      const advances = res.clients.map((c) => c.analysis.entities.ownAdvance);
      const ctxAdvances = JSON.stringify(advances);
      expect(Math.min(...advances), ctxAdvances).toBeGreaterThan(FAIRNESS_RATIO * Math.max(...advances));

      // The room's own view. `starves` is per-tick and shared, so the budget
      // scales with the number of senders rather than staying at scenario A's
      // two; `hostErrors` is zero-or-not at any population.
      const a0 = res.clients[0]!.analysis;
      const ctx0 = summary(res.clients[0]!);
      expect(a0.server.starvesAfterSteady, ctx0).toBeLessThanOrEqual(2 * CLIENTS);
      expect(a0.server.totals.hostErrors, ctx0).toBe(0);
      expect(a0.server.totals.publishFails, ctx0).toBe(0);
      expect(a0.server.totals.renewFails, ctx0).toBe(0);

      // AND THE ROOM COUNTED THEM. `players` drives the capacity gauges and the
      // empty-room drain, so a room serving three sockets while reporting one
      // is a room that would drain itself out from under two of them. The
      // flushes are cut at the end of the run: the teardown's own flushes see
      // the players leaving.
      const flushes = res.statsRecs.filter((r) => r.at <= res.endedAt);
      expect(flushes.length, ctx0).toBeGreaterThanOrEqual(1);
      expect(flushes[flushes.length - 1]!.s.players, ctx0).toBe(CLIENTS);
    } finally {
      await flushNamespace(TEST_REDIS_URL, namespace);
    }
  }, TEST_TIMEOUT_MS);
});
