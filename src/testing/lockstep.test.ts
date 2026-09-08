// The harness, run against the shipped example, both ways round.
//
// A test harness that only ever passes is worth nothing, so this file proves
// BOTH halves of the claim: pong's real runtime, real binary codec and real
// client step agree exactly at every lead and delay in a sweep, and a step
// deliberately carrying the defect `lockstep.ts` exists to catch is reported
// as pinned and wrong by the same harness on the same scenario.

import { describe, expect, it } from 'vitest';

import { decodePongSnapshot, encodePongSnapshot, type DecodedPongSnapshot } from '../../examples/pong/codec.js';
import { FIELD_H, PADDLE_SPEED, pongRuntime, stepPaddleY, type PongState } from '../../examples/pong/sim.js';
import type { Pose } from '../client/predictedEntity.js';
import { runLockstep, sweepLockstep, type LockstepOptions } from './lockstep.js';

const ME = 'p1';
const TICK_MS = 1000 / pongRuntime.tickHz;
const DT = 1 / pongRuntime.tickHz;
/** One tick of travel: 90 units a second at 20Hz. 4.5 is 9/2, so every number below is exact in binary floating point. */
const STEP = PADDLE_SPEED * DT;
/** The paddle's own bounds, from `stepPaddleY`: half a paddle in from each edge. */
const TOP = 12;
const BOTTOM = FIELD_H - 12;

/** The sweep. Three leads and two delays: a healthy link, a poor one and a bad one. */
const LEADS = [3, 6, 10];
const DELAYS = [2, 5];

interface PongInput {
  dir: number;
}

/**
 * The step `examples/pong/client.ts` hands `predict`, character for
 * character: `stepPaddleY` is shared with the runtime rather than retyped, so
 * this is the whole of the client's half of the rule.
 */
function goodStep(pose: Pose, input: PongInput, dt: number): Pose {
  return { x: pose.x, y: stepPaddleY(pose.y, input.dir, dt) };
}

/**
 * THE DEFECT, IN THE SHAPE THE REAL ONE HAD. The wall test is computed from
 * the pose this step just PRODUCED, which for the live prediction is the
 * client's raw pose, and it is then read by every replay, which starts from
 * the server's pose a whole round trip behind it. Once the raw prediction has
 * crossed the wall the latch is set, the replay from the authoritative pose
 * refuses to move, and the prediction is dragged back onto the server on every
 * snapshot: the step is pure arithmetic, the replay runs, and the two ends
 * disagree anyway.
 */
function pinningBase(): Omit<LockstepOptions<PongState, DecodedPongSnapshot, PongInput>, 'lead' | 'delay'> {
  const WALL = TOP + 4 * STEP;
  const latch = { on: false };
  const opts = base((pose, input, dt) => {
    if (latch.on) return { x: pose.x, y: pose.y };
    const next = goodStep(pose, input, dt);
    latch.on = next.y >= WALL;
    return next;
  });
  // The latch is the scenario's own state and `setup` is where a sweep resets
  // one, because `sweepLockstep` runs this bag once per combination.
  return {
    ...opts,
    setup: (s) => {
      latch.on = false;
      opts.setup(s);
    },
  };
}

/** The paddle at the top of the field, holding down: `BOTTOM - TOP` is 96 units, which is 21 and a third ticks of travel before it clamps. */
function base(
  step: (pose: Pose, input: PongInput, dt: number) => Pose,
): Omit<LockstepOptions<PongState, DecodedPongSnapshot, PongInput>, 'lead' | 'delay'> {
  return {
    runtime: pongRuntime,
    pid: ME,
    setup: (s) => {
      pongRuntime.join(s, ME);
      s.paddles.get(ME)!.y = TOP;
    },
    encode: (s) => encodePongSnapshot(s, s.tick * TICK_MS),
    decode: (bytes) => decodePongSnapshot(bytes as Uint8Array),
    ownPose: (snap) => {
      const mine = snap.paddles.find((p) => p.pid === ME);
      return mine === undefined ? null : { x: 0, y: mine.y };
    },
    step,
    maxSpeed: PADDLE_SPEED,
    // `{ dir }` is not the default binary shape, so pong is on the JSON wire
    // here exactly as it is on the page.
    wire: 'json',
    input: () => ({ dir: 1 }),
    initial: { x: 0, y: TOP },
    // SHORT OF THE CLAMP ON PURPOSE. The paddle runs out of field after 21 and
    // a third ticks, and a client already sitting on the bottom bound while
    // the server is still `lead` ticks short of it reads exactly like a pinned
    // one: the server moves, the raw prediction does not. That is the wall
    // rather than the step, so the scenarios that judge `pinned` stop before
    // it and the one that wants the clamp asks for the ticks itself.
    ticks: 20,
  };
}

describe('runLockstep against the pong example', () => {
  it('agrees exactly with the server at every lead and delay in a sweep', () => {
    const results = sweepLockstep(base(goodStep), LEADS, DELAYS);
    expect(results).toHaveLength(LEADS.length * DELAYS.length);

    for (const { lead, delay, report } of results) {
      const label = `lead ${lead}, delay ${delay}`;
      // EXACT, not close. Pong quantises a pose to a hundredth of a unit and
      // the paddle travels 4.5 units a tick from 12, so every value on the
      // wire round-trips without loss and an honest reconcile is zero. A host
      // whose numbers do not land on its own quantisation grid should judge
      // this against that grid instead.
      expect(report.maxError, `${label}: reconcile error`).toBe(0);
      expect(report.reconciles, `${label}: reconciles above the threshold`).toEqual([]);
      expect(report.pinned, `${label}: pinned ticks`).toEqual([]);
      expect(report.snaps, `${label}: snaps after the first confirmation`).toBe(0);
      expect(report.stamped, `${label}: records stamped`).toBe(20);
    }
  });

  it('agrees through a paddle that starts and stops, which is where a timeline off by one tick shows', () => {
    // A HELD INPUT HIDES THE THING THIS HARNESS IS FOR. Steady motion reads
    // the same whether the record stamped T is applied on the step that
    // produces T or on the one after it, because the record a tick late
    // carries the same value as the one that should have been there; only an
    // input CHANGE separates them, at exactly one tick of travel. So the
    // scenario flips direction every four ticks, mid-field so no wall is ever
    // involved, and the run has to stay exact through every flip.
    const middle = FIELD_H / 2;
    const results = sweepLockstep(
      {
        ...base(goodStep),
        setup: (s) => {
          pongRuntime.join(s, ME);
          s.paddles.get(ME)!.y = middle;
        },
        initial: { x: 0, y: middle },
        input: (t) => ({ dir: t % 8 < 4 ? 1 : -1 }),
      },
      LEADS,
      DELAYS,
    );
    for (const { lead, delay, report } of results) {
      const label = `lead ${lead}, delay ${delay}`;
      expect(report.maxError, `${label}: reconcile error`).toBe(0);
      expect(report.pinned, `${label}: pinned ticks`).toEqual([]);
    }
  });

  it('runs the paddle the whole length of the field with the prediction ahead of the server', () => {
    const report = runLockstep({ ...base(goodStep), lead: 6, delay: 2, ticks: 40 });
    const last = report.trace[report.trace.length - 1]!;
    expect(last.server.y, 'the paddle never walked').toBe(BOTTOM);
    // And it was genuinely a lead rather than the two ends sitting still
    // together: at the moment the server first moves, the client is already
    // `lead - 1` ticks of travel down the field.
    const firstMove = report.trace.findIndex((f, i) => i > 0 && f.server.y !== report.trace[i - 1]!.server.y);
    expect(firstMove, 'the server never moved').toBeGreaterThan(0);
    expect(report.trace[firstMove]!.client.y - report.trace[firstMove]!.server.y).toBeCloseTo(5 * STEP, 9);
  });

  it('reports the ticks the trace covers, one per server tick, in order', () => {
    const report = runLockstep({ ...base(goodStep), lead: 3, delay: 2, ticks: 12 });
    expect(report.trace).toHaveLength(12);
    expect(report.trace.map((f) => f.tick)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('hands the host every snapshot before it reconciles against it', () => {
    const seen: { tick: number; snapTick: number }[] = [];
    const report = runLockstep({
      ...base(goodStep),
      lead: 4,
      delay: 3,
      ticks: 20,
      onSnapshot: (snap, tick) => void seen.push({ tick, snapTick: snap.tick }),
    });
    // Everything the server produced except the last `delay` ticks, which were
    // still on the wire when the run ended.
    expect(seen.map((s) => s.snapTick)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    // And the tick handed alongside it is the one that frame will stamp for,
    // which is what a host builds its client-side context at.
    for (const s of seen) expect(s.tick).toBe(s.snapTick + 3 + 4 - 1);
    expect(report.maxError).toBe(0);
  });

  it('reconciles nothing while ownPose returns null, and the trace holds the last pose that was there', () => {
    let visible = true;
    const report = runLockstep({
      ...base(goodStep),
      lead: 3,
      delay: 2,
      ticks: 12,
      ownPose: (snap) => {
        if (!visible) return null;
        const mine = snap.paddles.find((p) => p.pid === ME);
        return mine === undefined ? null : { x: 0, y: mine.y };
      },
      onSnapshot: (snap) => {
        if (snap.tick >= 4) visible = false;
      },
    });
    expect(report.maxError).toBe(0);
    // The paddle kept moving on the server; the trace repeats the pose it last
    // had a reading for rather than inventing one.
    const tail = report.trace.slice(-4).map((f) => f.server.y);
    expect(new Set(tail).size).toBe(1);
  });
});

describe('the harness proving it can fail', () => {
  it('reports pinning and error for a step whose latch is computed from the raw prediction', () => {
    const report = runLockstep({ ...pinningBase(), lead: 6, delay: 2, ticks: 40 });
    // THE SIGNATURE. The server walks the whole field and the client's raw
    // pose refuses to move for almost all of it.
    expect(report.pinned.length).toBeGreaterThan(15);
    // And the reconcile says so too. The replay is a no-op, so the first
    // snapshot after the latch collapses the whole lead at once and every one
    // after it drags the prediction another tick of travel back.
    expect(report.maxError).toBeGreaterThan(STEP);
    expect(report.reconciles.length).toBeGreaterThan(15);
    // The server is unharmed by any of it, which is the whole point: nothing
    // on the authoritative side can see this.
    expect(report.trace[report.trace.length - 1]!.server.y).toBe(BOTTOM);
  });

  it('reports it at every lead and delay, not just the one it was found at', () => {
    for (const { lead, delay, report } of sweepLockstep({ ...pinningBase(), ticks: 40 }, LEADS, DELAYS)) {
      const label = `lead ${lead}, delay ${delay}`;
      expect(report.pinned.length, `${label}: pinned ticks`).toBeGreaterThan(10);
      expect(report.maxError, `${label}: reconcile error`).toBeGreaterThan(0);
    }
  });
});
