import { describe, it, expect } from 'vitest';
import { ClientTick } from './clientTick.js';
import { PlayoutBuffer } from '../core/playout.js';
import {
  INPUT_HISTORY,
  INPUT_WINDOW,
  PLAYHEAD_SNAP_TICKS,
  PredictedEntity,
  RENDER_SLEW,
  type Pose,
  type PredictedEntityOptions,
} from './predictedEntity.js';

// A scalar-in-y step like pong's paddle: 90 units a second at 20Hz is 4.5
// units a tick, which keeps every expected number below exact in binary
// floating point (4.5 is 9/2) so the equalities can be exact rather than close.
const TICK_MS = 50;
const DT = TICK_MS / 1000;
const SPEED = 90;
const PER_TICK = SPEED * DT; // 4.5
const FRAME = 1 / 60;
const INITIAL: Pose = { x: 6, y: 60 };

interface Dir {
  dir: number;
}

function stepY(pose: Pose, input: Dir, dt: number): Pose {
  return { x: pose.x, y: pose.y + input.dir * SPEED * dt };
}

/**
 * The REAL counter behind the view, driven by hand: `anchorTo` for the jumps
 * a re-anchor makes and `advance` for time. `RoomConnection.tick` is this
 * same object read-only, which is why the entity takes the view and not the
 * counter, and why there is no fake here: a fake's `tickMs` could disagree
 * with the connection's, which is the one mismatch the entity exists to
 * make impossible.
 */
function fakeConn(tickMs = TICK_MS) {
  const tick = new ClientTick({ tickMs });
  const sent: string[] = [];
  const conn = { tick, send: (payload: string) => void sent.push(payload) };
  return { conn, tick, sent };
}

function make(step: PredictedEntityOptions<Dir>['step'] = stepY, initial: Pose = INITIAL, tickMs = TICK_MS) {
  const { conn, tick, sent } = fakeConn(tickMs);
  const entity = new PredictedEntity<Dir>({ conn, step, maxSpeed: SPEED, initial });
  return { entity, tick, sent };
}

function lastPayload(sent: string[]): { targetTick: number; data: Dir }[] {
  return JSON.parse(sent[sent.length - 1]!) as { targetTick: number; data: Dir }[];
}

/** Anchor the counter at `value` and seat the entity with a first (snapping) reconcile at `value - 1`, the way a real connection's first snapshot does. */
function seated(value = 100) {
  const made = make();
  made.tick.anchorTo(value);
  made.entity.reconcile(INITIAL, value - 1);
  return made;
}

describe('PredictedEntity', () => {
  it('stamps nothing and returns initial before the counter is initialized', () => {
    const { entity, tick, sent } = make();
    expect(tick.initialized).toBe(false); // a value with no anchor behind it is not a tick
    for (let i = 0; i < 3; i++) {
      expect(entity.advance({ dir: 1 }, FRAME)).toEqual(INITIAL);
    }
    expect(sent).toHaveLength(0);
    expect(entity.stats.stamped).toBe(0);
    expect(entity.pose).toEqual(INITIAL);
  });

  it('stamps exactly one record per tick the counter crossed, and sends nothing on a frame that crossed none', () => {
    const { entity, tick, sent } = make();
    tick.anchorTo(1000);
    entity.advance({ dir: 1 }, FRAME);
    // THE FIRST STAMP HAS NOTHING TO CATCH UP FROM: one record, for the tick
    // the counter is on, not one per tick since the room booted.
    expect(sent).toHaveLength(1);
    expect(lastPayload(sent).map((r) => r.targetTick)).toEqual([1000]);
    expect(entity.stats.stamped).toBe(1);

    // 60fps against 20Hz: most frames cross no boundary and owe nothing.
    entity.advance({ dir: 1 }, FRAME);
    entity.advance({ dir: 1 }, FRAME);
    expect(sent).toHaveLength(1);
    expect(entity.stats.stamped).toBe(1);

    tick.anchorTo(1001);
    entity.advance({ dir: 1 }, FRAME);
    expect(sent).toHaveLength(2);
    expect(lastPayload(sent).map((r) => r.targetTick)).toEqual([1000, 1001]);

    // A frame that crossed two ticks owes two records, or the second starves.
    tick.anchorTo(1003);
    entity.advance({ dir: 1 }, FRAME);
    expect(sent).toHaveLength(3);
    expect(lastPayload(sent).map((r) => r.targetTick)).toEqual([1000, 1001, 1002, 1003]);
    expect(entity.stats.stamped).toBe(4);
  });

  it('the payload is the last INPUT_WINDOW records, ascending, as a JSON array of exactly { targetTick, data }', () => {
    const { entity, tick, sent } = make();
    for (let t = 1000; t < 1010; t++) {
      tick.anchorTo(t);
      entity.advance({ dir: t % 2 }, FRAME);
    }
    const raw = sent[sent.length - 1]!;
    expect(typeof raw).toBe('string');
    const parsed: unknown = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    const window = parsed as { targetTick: number; data: Dir }[];
    expect(window).toHaveLength(INPUT_WINDOW);
    expect(window.map((r) => r.targetTick)).toEqual([1004, 1005, 1006, 1007, 1008, 1009]);
    for (const rec of window) {
      // No `seq`, no extras: the library documents `seq` as never read, so
      // the shape is the two fields the relay's `decodeInput` needs.
      expect(Object.keys(rec).sort()).toEqual(['data', 'targetTick']);
      expect(rec.data).toEqual({ dir: rec.targetTick % 2 });
    }
  });

  it('the prediction after N stamps is N applications of step, and `pose` is a copy', () => {
    const { entity, tick } = make();
    let expected: Pose = INITIAL;
    for (let t = 200; t < 207; t++) {
      tick.anchorTo(t);
      entity.advance({ dir: 1 }, FRAME);
      expected = stepY(expected, { dir: 1 }, DT);
    }
    expect(entity.pose).toEqual(expected);
    expect(entity.pose.y).toBe(60 + 7 * PER_TICK);

    const leaked = entity.pose;
    leaked.y = -1;
    expect(entity.pose.y).toBe(60 + 7 * PER_TICK);
  });

  it("the timestep is the view's tickMs and nothing of its own: on a 100ms counter one stamp is 9 units", () => {
    // There is no `tickHz` option to disagree with the connection. A counter
    // built at 100ms is a 10Hz simulation, and every step runs on that.
    const { entity, tick } = make(stepY, INITIAL, 100);
    tick.anchorTo(50);
    entity.reconcile(INITIAL, 49);
    const drawn = entity.advance({ dir: 1 }, FRAME);
    expect(entity.pose.y).toBe(60 + SPEED * 0.1);
    // And the draw moves at real time on that basis: a 60fps frame is a
    // sixth of a 100ms tick, so 1.5 units of the 9.
    tick.advance(FRAME);
    const next = entity.advance({ dir: 1 }, FRAME);
    expect(next.y - drawn.y).toBeCloseTo(SPEED * FRAME, 9);
  });

  it('between ticks the draw moves at real time every frame while the raw pose moves once per tick', () => {
    const { entity, tick } = seated(10);
    let drawn = entity.advance({ dir: 1 }, FRAME);
    // Stamped tick 10: the raw pose is a tick ahead, the playhead is seeded
    // one tick behind the newest stamp, on the pose it was predicted from.
    expect(entity.pose.y).toBe(60 + PER_TICK);
    expect(drawn.y).toBe(60);
    expect(drawn.x).toBe(6);

    // Three 60fps frames are one 20Hz tick: the draw moves a third of a tick
    // of travel on each, while the raw pose does not move until the third
    // crosses the boundary and stamps tick 11.
    for (let i = 1; i <= 3; i++) {
      tick.advance(FRAME);
      const next = entity.advance({ dir: 1 }, FRAME);
      expect(next.y - drawn.y).toBeCloseTo(SPEED * FRAME, 9);
      expect(next.y).toBeCloseTo(60 + PER_TICK * (i / 3), 9);
      drawn = next;
    }
    expect(tick.value).toBe(11);
    expect(entity.pose.y).toBe(60 + 2 * PER_TICK);
    expect(drawn.y).toBeCloseTo(60 + PER_TICK, 9);
  });

  it('a counter jump of two ticks inside one 16ms frame is not time passing: the draw moves at most a tenth over real time', () => {
    // The draw used to follow the counter (`prev + (curr - prev) * fraction`),
    // so a re-anchor that stamped two ticks in one frame moved the drawn pose
    // two ticks of travel in 16ms. The playhead moves by the frame's dt
    // within the slew and catches the counter up over the next second.
    const { entity, tick } = seated(10);
    entity.advance({ dir: 1 }, FRAME);
    tick.anchorTo(12);
    const drawn = entity.advance({ dir: 1 }, FRAME);
    expect(entity.pose.y).toBe(60 + 3 * PER_TICK);
    expect(drawn.y - 60).toBeGreaterThan(0);
    expect(drawn.y - 60).toBeLessThanOrEqual((1 + RENDER_SLEW) * SPEED * FRAME + 1e-9);
  });

  it('a reconcile that agrees changes nothing', () => {
    const { entity, tick } = seated(100);
    for (let t = 100; t <= 104; t++) {
      tick.anchorTo(t);
      entity.advance({ dir: 1 }, FRAME);
    }
    tick.advance(DT / 2);
    const before = entity.advance({ dir: 1 }, FRAME);
    const poseBefore = entity.pose;
    const snapsBefore = entity.stats.snaps;

    // The server at tick 102 has applied records 100, 101 and 102.
    entity.reconcile({ x: 6, y: 60 + 3 * PER_TICK }, 102);

    expect(entity.stats.lastError).toBe(0);
    expect(entity.stats.snaps).toBe(snapsBefore);
    expect(entity.pose).toEqual(poseBefore);
    // dt 0 so neither the playhead nor the offset advances: the same frame,
    // drawn again.
    expect(entity.advance({ dir: 1 }, 0)).toEqual(before);
  });

  it('a small disagreement is continuous (the next draw is within one frame of glide of the last) and converges inside a second', () => {
    const { entity, tick } = seated(100);
    const before = entity.advance({ dir: 0 }, FRAME);
    expect(before.y).toBe(60);

    // Three units off, well inside the 45-unit snap distance. Nothing is
    // moving, so every change in the draw from here is the glide alone.
    entity.reconcile({ x: 6, y: 63 }, 100);
    expect(entity.pose.y).toBe(63); // adopted in full, at once
    expect(entity.stats.lastError).toBe(3);

    const next = entity.advance({ dir: 0 }, FRAME);
    const glide = SPEED * FRAME; // 1.5: one frame of travel at maxSpeed
    expect(Math.abs(next.y - before.y)).toBeLessThanOrEqual(glide + 1e-9);
    expect(next.y).toBeGreaterThan(before.y); // and moving the right way

    let drawn = next;
    for (let i = 0; i < 59; i++) {
      const d = entity.advance({ dir: 0 }, FRAME);
      expect(Math.abs(d.y - drawn.y)).toBeLessThanOrEqual(glide + 1e-9);
      drawn = d;
    }
    expect(Math.abs(drawn.y - 63)).toBeLessThan(0.01);

    // THE SAME WITH THE PLAYHEAD MID-SEGMENT, so the whole history is
    // provably shifted: with the older poses left behind, the interpolation
    // would carry a share of the correction on top of the offset.
    const other = seated(100);
    other.tick.advance(DT / 2);
    const b = other.entity.advance({ dir: 0 }, DT / 2);
    other.entity.reconcile({ x: 6, y: 57 }, 100);
    const n = other.entity.advance({ dir: 0 }, FRAME);
    expect(Math.abs(n.y - b.y)).toBeLessThanOrEqual(glide + 1e-9);
  });

  it("the glide cap is this frame's travel at maxSpeed, from the dt passed in, not a 60fps constant", () => {
    // Forty units off, inside the snap distance, so the exponential wants
    // 1.57 units out of a 4ms frame and the cap has to bind: at 60fps the
    // cap would be 1.5, at 240fps it is 0.375, and a 100ms frame allows 9.
    const fast = seated(100);
    fast.entity.advance({ dir: 0 }, FRAME);
    fast.entity.reconcile({ x: 6, y: 100 }, 100);
    const a = fast.entity.advance({ dir: 0 }, 1 / 240);
    expect(a.y - 60).toBeGreaterThan(0);
    expect(a.y - 60).toBeLessThanOrEqual(SPEED / 240 + 1e-9);

    const slow = seated(100);
    slow.entity.advance({ dir: 0 }, FRAME);
    slow.entity.reconcile({ x: 6, y: 100 }, 100);
    const b = slow.entity.advance({ dir: 0 }, 0.1);
    expect(b.y - 60).toBeGreaterThan(SPEED / 60); // more than one 60fps frame's worth
    expect(b.y - 60).toBeLessThanOrEqual(SPEED * 0.1 + 1e-9);
  });

  it('the first reconcile snaps: the draw jumps to the authoritative pose with no glide', () => {
    const { entity, tick } = make();
    tick.anchorTo(100);
    expect(entity.advance({ dir: 0 }, FRAME).y).toBe(60);
    entity.reconcile({ x: 6, y: 80 }, 100);
    expect(entity.advance({ dir: 0 }, FRAME).y).toBe(80);
    expect(entity.stats.snaps).toBe(1);
    expect(entity.stats.lastError).toBe(20);
  });

  it('a disagreement past maxSpeed * 0.5 snaps rather than glides, and one inside it glides', () => {
    const snapDistance = SPEED * 0.5; // 45

    const far = seated(100);
    far.entity.advance({ dir: 0 }, FRAME);
    far.entity.reconcile({ x: 6, y: 60 + snapDistance + 1 }, 100);
    expect(far.entity.advance({ dir: 0 }, FRAME).y).toBe(60 + snapDistance + 1);
    expect(far.entity.stats.snaps).toBe(2); // the seat, then this one

    const near = seated(100);
    near.entity.advance({ dir: 0 }, FRAME);
    near.entity.reconcile({ x: 6, y: 60 + snapDistance - 1 }, 100);
    const drawn = near.entity.advance({ dir: 0 }, FRAME);
    expect(drawn.y).toBeLessThan(60 + SPEED * FRAME + 1e-9);
    expect(near.entity.stats.snaps).toBe(1);
    // The raw pose adopted the server's answer either way.
    expect(near.entity.pose.y).toBe(60 + snapDistance - 1);
  });

  it('corrections that ADD UP past the snap distance snap rather than trim: to 90 and then to 120 from a pose at 60', () => {
    // Each correction alone is 30, inside the 45-unit snap distance, and the
    // two together are 60. `ErrorOffset.absorb` clamps at 45, so gated per
    // reconcile the second was absorbed, trimmed to 45 in silence, and the
    // draw jumped the 15 that was trimmed inside a reconcile nothing counted.
    // The gate is on the offset the absorb WOULD PRODUCE: the second
    // correction resets the offset, counts a snap, and the draw is on the
    // truth at once.
    const { entity } = seated(100);
    expect(entity.advance({ dir: 0 }, FRAME).y).toBe(60);
    entity.reconcile({ x: 6, y: 90 }, 100);
    expect(entity.stats.snaps).toBe(1);
    expect(entity.advance({ dir: 0 }, 0).y).toBe(60); // the first is a glide: nothing moved this frame
    entity.reconcile({ x: 6, y: 120 }, 100);
    expect(entity.stats.snaps).toBe(2);
    expect(entity.advance({ dir: 0 }, 0).y).toBe(120);
    expect(entity.pose.y).toBe(120);
  });

  it('a replay from a snapshot older than the re-send window but inside the history is still exact', () => {
    const { entity, tick } = seated(100);
    for (let t = 100; t < 120; t++) {
      tick.anchorTo(t);
      entity.advance({ dir: 1 }, FRAME);
    }
    expect(entity.pose.y).toBe(60 + 20 * PER_TICK);

    // The server at tick 104 has applied five records (100 to 104). The
    // fifteen records after it are more than twice the six re-sent per
    // packet, so a replay bounded by the re-send window would come up nine
    // ticks short here, a 40.5-unit error every snapshot on a slow link.
    entity.reconcile({ x: 6, y: 60 + 5 * PER_TICK }, 104);
    expect(entity.stats.lastError).toBe(0);
    expect(entity.pose.y).toBe(60 + 20 * PER_TICK);
  });

  it('a snapshot older than INPUT_HISTORY comes up short by exactly the records that fell off, which is the documented bound', () => {
    const { entity, tick } = seated(100);
    const stamped = INPUT_HISTORY + 8;
    for (let t = 100; t < 100 + stamped; t++) {
      tick.anchorTo(t);
      entity.advance({ dir: 1 }, FRAME);
    }
    // The server at tick 100 has applied one record. Only the newest
    // INPUT_HISTORY records are held, so the seven between record 101 and
    // the oldest held one are not replayed.
    entity.reconcile({ x: 6, y: 60 + PER_TICK }, 100);
    const missing = stamped - 1 - INPUT_HISTORY;
    expect(entity.stats.lastError).toBeCloseTo(missing * PER_TICK, 9);
  });

  it('a backward counter jump past the one-tick slack clears the window and re-stamps from the new value with no send gap', () => {
    const { entity, tick, sent } = seated(100);
    for (let t = 100; t <= 110; t++) {
      tick.anchorTo(t);
      entity.advance({ dir: 1 }, FRAME);
    }
    expect(sent).toHaveLength(11);

    // A backward re-anchor of ten ticks. A high-water mark left where it was
    // would silence every send until the counter climbed back past 110:
    // measured at 5.6 seconds of input silence on a real socket.
    tick.anchorTo(100);
    entity.advance({ dir: 1 }, FRAME);
    expect(sent).toHaveLength(12);
    // The window went with the mark: this packet carries the new timeline
    // only, not six records from the one that no longer exists.
    expect(lastPayload(sent).map((r) => r.targetTick)).toEqual([100]);
    tick.anchorTo(101);
    entity.advance({ dir: 1 }, FRAME);
    expect(lastPayload(sent).map((r) => r.targetTick)).toEqual([100, 101]);
  });

  it('a backward jump of one tick is inside the slack: nothing is cleared and stamping resumes a tick later', () => {
    const { entity, tick, sent } = seated(100);
    for (let t = 100; t <= 110; t++) {
      tick.anchorTo(t);
      entity.advance({ dir: 1 }, FRAME);
    }
    tick.anchorTo(109);
    entity.advance({ dir: 1 }, FRAME);
    tick.anchorTo(110);
    entity.advance({ dir: 1 }, FRAME);
    expect(sent).toHaveLength(11); // 110 is already stamped; nothing owed
    tick.anchorTo(111);
    entity.advance({ dir: 1 }, FRAME);
    expect(sent).toHaveLength(12);
    expect(lastPayload(sent).map((r) => r.targetTick)).toEqual([106, 107, 108, 109, 110, 111]);
  });

  it('THE DOUBLE-STEP REPRO: a -3 rewinds the prediction to the pose after value - 1, keeps the older records, and reconciles to exactly zero once re-stamped', () => {
    // The counter driven by wall time (one tick per advance), so the
    // playhead keeps step with it and the snap count below is the jump's.
    const { entity, tick, sent } = seated(100);
    entity.advance({ dir: 1 }, DT);
    for (let t = 101; t <= 110; t++) {
      tick.advance(DT);
      entity.advance({ dir: 1 }, DT);
    }
    expect(tick.value).toBe(110);
    expect(entity.pose.y).toBe(60 + 11 * PER_TICK); // 109.5, the pose after 110

    // The ticks beyond 106 have not happened yet on the server's timeline.
    // The first shape of this left `curr` at the pose after 110 and stamped
    // 107 from it: 114 where the pose after 107 is 96, and the reconcile
    // reported 22.5 until the records aged out.
    tick.anchorTo(107);
    entity.advance({ dir: 1 }, FRAME);
    expect(entity.pose.y).toBe(60 + 8 * PER_TICK); // 96: the pose after 106, stepped once
    // The records the server still holds at or below the mark stay in the
    // window; only the ones beyond it were dropped, to be re-sent fresh.
    expect(lastPayload(sent).map((r) => r.targetTick)).toEqual([102, 103, 104, 105, 106, 107]);

    // The server at 105 has applied 100 to 105; the replay of 106 and 107
    // lands exactly on the prediction.
    entity.reconcile({ x: 6, y: 60 + 6 * PER_TICK }, 105);
    expect(entity.stats.lastError).toBe(0);
    for (let t = 108; t <= 112; t++) {
      tick.advance(DT);
      entity.advance({ dir: 1 }, DT);
    }
    entity.reconcile({ x: 6, y: 60 + 11 * PER_TICK }, 110);
    expect(entity.stats.lastError).toBe(0);
    expect(entity.stats.snaps).toBe(1); // the seat, and nothing else: a -3 is slewed
  });

  it('a backward jump past PLAYHEAD_SNAP_TICKS snaps the draw (counted) rather than gliding, and still reconciles exactly', () => {
    const { entity, tick } = seated(100);
    entity.advance({ dir: 1 }, DT);
    for (let t = 101; t <= 130; t++) {
      tick.advance(DT);
      entity.advance({ dir: 1 }, DT);
    }
    expect(entity.stats.snaps).toBe(1);
    tick.anchorTo(110);
    const drawn = entity.advance({ dir: 1 }, FRAME);
    expect(entity.stats.snaps).toBe(2);
    // The playhead jumped to one tick behind the new mark, onto real
    // history: the pose after 109, with the tick beyond it re-stamped.
    expect(drawn.y).toBe(60 + 10 * PER_TICK);
    expect(entity.pose.y).toBe(60 + 11 * PER_TICK);
    entity.reconcile({ x: 6, y: 60 + 6 * PER_TICK }, 105);
    expect(entity.stats.lastError).toBe(0);
  });

  it('the speculation is at most PLAYHEAD_SNAP_TICKS deep: an unanchored playhead run past the newest pose draws no further than that, and with the key released it draws the newest pose', () => {
    // An unanchored counter is provisional, so the playhead runs at real
    // time and neither chases nor snaps. `RoomConnection.frame()` advances
    // the counter by a CLAMPED dt, and a host that hands `advance` the
    // unclamped one after a frozen tab runs the playhead two seconds past
    // every stored pose. Speculating across that with the held key would
    // draw forty ticks of travel the server never saw, and then the
    // re-anchor would snap it back; the speculation stops at the snap
    // threshold and the draw clamps on its last pose.
    const { entity, tick } = seated(100);
    entity.advance({ dir: 1 }, FRAME);
    expect(entity.pose.y).toBe(60 + PER_TICK); // the newest stored pose, after tick 100
    tick.markUnanchored();
    const held = entity.advance({ dir: 1 }, 2);
    expect(held.y).toBe(60 + (1 + PLAYHEAD_SNAP_TICKS) * PER_TICK);
    expect(entity.stats.snaps).toBe(1); // the seat: an unanchored counter is not snapped to
    expect(entity.pose.y).toBe(60 + PER_TICK); // nothing speculated is history
    // And it is the CURRENT input that is speculated with: released, the
    // newest pose stands, and the change is carried by the offset (the
    // draw glides back from where the held speculation had it).
    const released = entity.advance({ dir: 0 }, 0);
    expect(released.y).toBe(held.y);
    let drawn = released;
    for (let i = 0; i < 60; i++) {
      const d = entity.advance({ dir: 0 }, FRAME);
      expect(drawn.y - d.y).toBeGreaterThanOrEqual(0);
      expect(drawn.y - d.y).toBeLessThanOrEqual(SPEED * FRAME + 1e-9);
      drawn = d;
    }
    expect(drawn.y).toBeCloseTo(60 + PER_TICK, 2);
  });

  it('a dt that is not a duration (NaN, Infinity, negative) is no time at all: the draw stands, stays finite, and nothing is counted', () => {
    const { entity, tick } = seated(100);
    const drawn = entity.advance({ dir: 1 }, FRAME);
    tick.advance(FRAME);
    const next = entity.advance({ dir: 1 }, FRAME);
    const stats = entity.stats;
    // `Math.max(0, NaN)` is NaN, and a NaN playhead compared false against
    // every gate for the rest of the entity's life.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      const d = entity.advance({ dir: 1 }, bad);
      expect(Number.isFinite(d.y)).toBe(true);
      expect(d).toEqual(next); // the same frame, drawn again
    }
    expect(entity.stats).toEqual(stats); // no snap, no invalid
    // And time still passes normally afterwards.
    tick.advance(FRAME);
    const after = entity.advance({ dir: 1 }, FRAME);
    expect(after.y - next.y).toBeCloseTo(SPEED * FRAME, 9);
    expect(next.y - drawn.y).toBeCloseTo(SPEED * FRAME, 9);
  });

  it('ONE PER CONNECTION: a second entity on the same conn throws a RangeError naming the rule; a different conn is fine', () => {
    const { conn } = fakeConn();
    const opts = { conn, step: stepY, maxSpeed: SPEED, initial: INITIAL };
    expect(() => new PredictedEntity<Dir>(opts)).not.toThrow();
    // The entity IS the player's input stream: the ticker keeps one playout
    // buffer per pid, so a second would overwrite the first's record for
    // every tick it stamps and the server would consume whichever landed
    // last.
    expect(() => new PredictedEntity<Dir>(opts)).toThrow(RangeError);
    expect(() => new PredictedEntity<Dir>(opts)).toThrow(/one PredictedEntity per connection/);
    expect(() => new PredictedEntity<Dir>({ ...opts, conn: fakeConn().conn })).not.toThrow();
  });

  describe('a new connection epoch (anchored false, then true) starts the entity over', () => {
    /** Seat, stamp `ticks` records with the key held, then drop the anchor and observe it dropped, the way a frame between the reconnect attempt and its first snapshot does. */
    function stampedThenUnanchored(ticks: number, from = 100) {
      const made = seated(from);
      for (let t = from; t < from + ticks; t++) {
        made.tick.anchorTo(t);
        made.entity.advance({ dir: 1 }, FRAME);
      }
      made.tick.markUnanchored();
      made.entity.advance({ dir: 1 }, FRAME);
      return made;
    }

    it('into the same room, the first reconcile is one counted snap onto the pose, even a glide-sized distance away, and the window starts over', () => {
      const { entity, tick, sent } = stampedThenUnanchored(6);
      expect(entity.pose.y).toBe(60 + 6 * PER_TICK); // 87
      const snapsBefore = entity.stats.snaps;

      // The connection anchors and hands the host the same snapshot, so the
      // epoch's first reconcile lands BEFORE its first advance. Three units
      // off would glide inside an epoch; across one it is a snap, because
      // the offset would otherwise carry the old epoch's pose in.
      tick.anchorTo(140);
      entity.reconcile({ x: 6, y: 90 }, 136);
      expect(entity.stats.snaps).toBe(snapsBefore + 1);
      expect(entity.pose).toEqual({ x: 6, y: 90 });
      expect(entity.advance({ dir: 0 }, FRAME)).toEqual({ x: 6, y: 90 }); // no offset, no glide
      // And the re-send window is this epoch's only: not six stale records
      // against a count they were never stamped for.
      expect(lastPayload(sent).map((r) => r.targetTick)).toEqual([140]);
    });

    it('into a different room, the first reconcile snaps to the far pose with no glide from the old room', () => {
      const { entity, tick } = stampedThenUnanchored(6);
      tick.anchorTo(5000);
      entity.reconcile({ x: 300, y: 500 }, 4996);
      expect(entity.advance({ dir: 0 }, FRAME)).toEqual({ x: 300, y: 500 });
      expect(entity.advance({ dir: 0 }, FRAME)).toEqual({ x: 300, y: 500 });
    });

    it('the records of the old epoch are never replayed against the new count', () => {
      // Five records held (22.5 units of travel, inside the snap distance,
      // so a stale replay would have glided rather than snapped): the new
      // epoch anchors on a room whose count restarted, and the snapshot at
      // 6 must adopt the pose as is, not the pose plus five stale steps.
      const { entity, tick } = stampedThenUnanchored(5, 5000);
      tick.anchorTo(10);
      entity.reconcile({ x: 6, y: 60 }, 6);
      expect(entity.pose).toEqual({ x: 6, y: 60 });
      expect(entity.stats.lastError).toBe(60 + 5 * PER_TICK - 60);
    });

    it('a snapshot from a restarted count INSIDE an epoch (no re-anchor yet) is a counted snap, not a replay of stale records', () => {
      // The connection rate-limits its tolerance re-anchor, so a room that
      // restarts its count can deliver up to two seconds of snapshots on
      // the new count before the counter follows. Each is more than
      // INPUT_HISTORY below every record held, which no lead produces.
      const { entity, tick } = seated(5000);
      entity.advance({ dir: 1 }, DT);
      for (let t = 5001; t <= 5010; t++) {
        tick.advance(DT);
        entity.advance({ dir: 1 }, DT);
      }
      entity.reconcile({ x: 6, y: 60 }, 3);
      expect(entity.pose).toEqual({ x: 6, y: 60 });
      expect(entity.stats.snaps).toBe(2);
      // The nearest miss: an early snapshot of a fresh seat sits below
      // every record by the lead, and that one replays.
      const fresh = seated(100);
      fresh.tick.anchorTo(100);
      fresh.entity.advance({ dir: 1 }, FRAME);
      fresh.entity.reconcile({ x: 6, y: 60 }, 96);
      expect(fresh.entity.pose.y).toBe(60 + PER_TICK);
      expect(fresh.entity.stats.snaps).toBe(1);
    });
  });

  it('a forward jump larger than the history stamps only the last INPUT_HISTORY ticks', () => {
    const { entity, tick, sent } = seated(100);
    entity.advance({ dir: 1 }, FRAME);
    tick.anchorTo(300);
    entity.advance({ dir: 1 }, FRAME);
    expect(entity.stats.stamped).toBe(1 + INPUT_HISTORY);
    expect(lastPayload(sent).map((r) => r.targetTick)).toEqual([295, 296, 297, 298, 299, 300]);
    // And the replay reaches every held record: against a server that
    // applied record 100 and then stood still through the unstamped gap, a
    // snapshot at 268 reconciles exactly, because 269 to 300 are all held.
    entity.reconcile({ x: 6, y: 60 + PER_TICK }, 268);
    expect(entity.stats.lastError).toBe(0);
  });

  it('heading wraps: a reconcile across the pi boundary is a small correction, not a 2 pi one, and the draw takes the shortest arc', () => {
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    interface Turn {
      turn: number;
    }
    const stepHeading = (pose: Pose, input: Turn, dt: number): Pose => ({
      x: pose.x,
      y: pose.y,
      heading: wrap((pose.heading ?? 0) + input.turn * dt),
    });
    const { conn, tick } = fakeConn();
    const entity = new PredictedEntity<Turn>({
      conn,
      step: stepHeading,
      maxSpeed: SPEED,
      initial: { x: 0, y: 0, heading: Math.PI - 0.05 },
    });
    tick.anchorTo(100);
    entity.reconcile({ x: 0, y: 0, heading: Math.PI - 0.05 }, 99);
    const before = entity.advance({ turn: 0 }, FRAME);
    expect(before.heading).toBeCloseTo(Math.PI - 0.05, 12);

    // Just across the boundary: a tenth of a radian away by the short way,
    // 6.18 by the long way. An unwrapped difference would clamp to pi and
    // swing the drawn heading half a turn.
    entity.reconcile({ x: 0, y: 0, heading: -Math.PI + 0.05 }, 100);
    const next = entity.advance({ turn: 0 }, FRAME);
    expect(Math.abs(wrap(next.heading! - before.heading!))).toBeLessThanOrEqual(0.35 + 1e-9);
    expect(Math.abs(wrap(next.heading! - before.heading!))).toBeLessThan(0.1);
    let drawn = next;
    for (let i = 0; i < 59; i++) drawn = entity.advance({ turn: 0 }, FRAME);
    expect(Math.abs(wrap(drawn.heading! - (-Math.PI + 0.05)))).toBeLessThan(0.01);

    // The between-tick interpolation crosses the wrap the short way too: a
    // tick that turns from pi - 0.1 to -pi + 0.1 draws pi at half a tick,
    // where a linear lerp would draw 0. On its own connection: one entity
    // per connection is the rule.
    const second = fakeConn();
    const arc = new PredictedEntity<Turn>({
      conn: second.conn,
      step: stepHeading,
      maxSpeed: SPEED,
      initial: { x: 0, y: 0, heading: Math.PI - 0.1 },
    });
    arc.reconcile({ x: 0, y: 0, heading: Math.PI - 0.1 }, 99);
    second.tick.anchorTo(101);
    arc.advance({ turn: 0.2 / DT }, FRAME);
    expect(arc.pose.heading).toBeCloseTo(-Math.PI + 0.1, 9);
    second.tick.advance(DT / 2);
    const mid = arc.advance({ turn: 0.2 / DT }, DT / 2);
    expect(Math.abs(Math.abs(mid.heading!) - Math.PI)).toBeLessThan(1e-9);
  });

  it('a record keeps a copy of the input, so mutating the object passed in does not rewrite the replay', () => {
    const { entity, tick } = seated(100);
    const held: Dir = { dir: 1 };
    for (let t = 100; t <= 102; t++) {
      tick.anchorTo(t);
      entity.advance(held, FRAME);
    }
    held.dir = 0;
    for (let t = 103; t <= 105; t++) {
      tick.anchorTo(t);
      entity.advance(held, FRAME);
    }
    // The server applied dir 1 on 100 to 102 and dir 0 after: at tick 101 it
    // is two ticks along. The replay of 102 to 105 must use what was
    // stamped, not what `held` says now.
    entity.reconcile({ x: 6, y: 60 + 2 * PER_TICK }, 101);
    expect(entity.stats.lastError).toBe(0);
  });

  it('refuses a view whose tickMs is not a positive number, a maxSpeed that is not, and an initial that is not finite', () => {
    const { conn } = fakeConn();
    const base = { conn, step: stepY, initial: INITIAL };
    expect(() => new PredictedEntity<Dir>({ ...fakeConn(0), step: stepY, initial: INITIAL, maxSpeed: SPEED })).toThrow(RangeError);
    expect(() => new PredictedEntity<Dir>({ ...fakeConn(Number.NaN), step: stepY, initial: INITIAL, maxSpeed: SPEED })).toThrow(
      RangeError,
    );
    expect(() => new PredictedEntity<Dir>({ ...base, maxSpeed: -1 })).toThrow(RangeError);
    expect(() => new PredictedEntity<Dir>({ ...base, initial: { x: Number.NaN, y: 0 }, maxSpeed: SPEED })).toThrow(RangeError);
    expect(() => new PredictedEntity<Dir>({ ...base, maxSpeed: SPEED })).not.toThrow();
  });

  it('advance(undefined) throws a TypeError naming the problem, before any state changes', () => {
    const { entity, tick, sent } = seated(100);
    entity.advance({ dir: 1 }, FRAME);
    const before = { pose: entity.pose, stats: entity.stats, sent: sent.length };
    tick.anchorTo(101);
    // `JSON.stringify` returns undefined for these rather than throwing, and
    // the copy then failed inside `JSON.parse` as a bare SyntaxError in the
    // middle of a rAF loop.
    for (const bad of [undefined, () => 1, Symbol('x')]) {
      expect(() => entity.advance(bad as unknown as Dir, FRAME)).toThrow(TypeError);
      expect(() => entity.advance(bad as unknown as Dir, FRAME)).toThrow(/JSON/);
    }
    expect(entity.pose).toEqual(before.pose);
    expect(entity.stats).toEqual(before.stats);
    expect(sent).toHaveLength(before.sent);
    // And the entity is intact: the next good input stamps the owed tick.
    entity.advance({ dir: 1 }, FRAME);
    expect(entity.stats.stamped).toBe(before.stats.stamped + 1);
  });

  it('a step that returns NaN is refused as a counted snap to the last authoritative pose, and the entity recovers', () => {
    // One record whose input has an undefined field: the JSON copy drops the
    // key, the step adds `undefined * 90 * dt`, and the result is NaN. Gated
    // by `NaN > snapDistance` (false) and absorbed, it poisoned every draw
    // from then on with no exit.
    const { entity, tick } = seated(100);
    entity.advance({ dir: 1 }, FRAME);
    tick.anchorTo(101);
    const drawn = entity.advance({ dir: undefined as unknown as number }, FRAME);
    expect(Number.isFinite(drawn.y)).toBe(true);
    expect(drawn).toEqual(INITIAL); // the last finite authoritative pose, the seat
    expect(entity.pose).toEqual(INITIAL);
    expect(entity.stats.invalid).toBe(1);
    expect(entity.stats.snaps).toBe(2); // the seat, then this
    expect(entity.stats.stamped).toBe(2); // the record still went out; the server's own clamp decides

    // From here everything is finite and the reconcile closes to zero: the
    // server (with the pong sim's own `readDir` reading the missing field as
    // 0) applied 4.5 on tick 100 and 0 on 101.
    for (let t = 102; t <= 105; t++) {
      tick.anchorTo(t);
      const d = entity.advance({ dir: 1 }, FRAME);
      expect(Number.isFinite(d.y)).toBe(true);
    }
    entity.reconcile({ x: 6, y: 60 + PER_TICK }, 101);
    expect(entity.stats.lastError).toBe(PER_TICK);
    expect(entity.stats.snaps).toBe(2);
    entity.reconcile({ x: 6, y: 60 + 5 * PER_TICK }, 105);
    expect(entity.stats.lastError).toBe(0);
    for (let i = 0; i < 30; i++) expect(Number.isFinite(entity.advance({ dir: 1 }, FRAME).y)).toBe(true);
  });

  it('an authoritative pose that is not finite is refused as a counted snap and never reaches the offset', () => {
    const { entity, tick } = seated(100);
    entity.advance({ dir: 1 }, FRAME);
    entity.reconcile({ x: 6, y: 63 }, 100); // a real correction, gliding
    const gliding = entity.advance({ dir: 1 }, 0);
    expect(gliding.y).toBe(60); // the correction is carried by the offset: nothing moved this frame
    entity.reconcile({ x: Number.NaN, y: 63 }, 100);
    expect(entity.stats.invalid).toBe(1);
    expect(entity.stats.snaps).toBe(2);
    expect(entity.stats.lastError).toBe(0); // a refusal reports no error, not the previous reconcile's 3
    expect(entity.pose).toEqual({ x: 6, y: 63 }); // the prediction stands
    const after = entity.advance({ dir: 1 }, 0);
    expect(Number.isFinite(after.y)).toBe(true);
    expect(after.y).toBe(63 - PER_TICK); // the offset was dropped: the draw is on the shifted base alone
    entity.reconcile({ x: 6, y: 63 }, 100);
    expect(entity.stats.lastError).toBe(0);
    expect(entity.stats.snaps).toBe(2);
    tick.anchorTo(101);
    expect(Number.isFinite(entity.advance({ dir: 1 }, FRAME).y)).toBe(true);
  });

  describe('snapTo: the game forcing the jump a glide would soften', () => {
    it('a glide-sized disagreement is drawn at once, where the same distance through reconcile would glide', () => {
      const { entity } = seated(100);
      expect(entity.advance({ dir: 0 }, FRAME).y).toBe(60);
      const snapsBefore = entity.stats.snaps;

      // Thirty units, well inside the 45-unit snap distance: exactly the
      // respawn a reconcile glides to over half a second, which is what this
      // call exists to refuse.
      entity.snapTo({ x: 6, y: 90 });
      expect(entity.stats.snaps).toBe(snapsBefore + 1);
      expect(entity.pose).toEqual({ x: 6, y: 90 });
      expect(entity.advance({ dir: 0 }, 0)).toEqual({ x: 6, y: 90 });
      // And it stays there: there is no offset left to bleed out.
      let drawn = entity.advance({ dir: 0 }, FRAME);
      for (let i = 0; i < 10; i++) drawn = entity.advance({ dir: 0 }, FRAME);
      expect(drawn).toEqual({ x: 6, y: 90 });
    });

    it("the next reconcile is a fresh confirmation: the server's own answer for the event snaps too", () => {
      const { entity } = seated(100);
      entity.advance({ dir: 0 }, FRAME);
      entity.snapTo({ x: 6, y: 90 });
      const snapsBefore = entity.stats.snaps;

      // The server's answer for the same respawn, ten units from where the
      // game put it. Inside an epoch that distance is a glide; here it is the
      // first confirmation of a pose that was a guess, so it is adopted with
      // a snap and leaves no offset behind.
      entity.reconcile({ x: 6, y: 100 }, 100);
      expect(entity.stats.lastError).toBe(10);
      expect(entity.stats.snaps).toBe(snapsBefore + 1);
      expect(entity.pose).toEqual({ x: 6, y: 100 });
      expect(entity.advance({ dir: 0 }, 0)).toEqual({ x: 6, y: 100 });
      // And the one after it is an ordinary confirmation again.
      entity.reconcile({ x: 6, y: 100 }, 100);
      expect(entity.stats.snaps).toBe(snapsBefore + 1);
    });

    it('a pose that is not finite is refused with a RangeError and changes nothing', () => {
      const { entity } = seated(100);
      entity.advance({ dir: 1 }, FRAME);
      const before = { pose: entity.pose, stats: entity.stats, drawn: entity.advance({ dir: 1 }, 0) };
      for (const bad of [{ x: Number.NaN, y: 0 }, { x: 0, y: Number.POSITIVE_INFINITY }, { x: 0, y: 0, heading: Number.NaN }]) {
        expect(() => entity.snapTo(bad)).toThrow(RangeError);
        expect(() => entity.snapTo(bad)).toThrow(/finite pose/);
      }
      expect(entity.pose).toEqual(before.pose);
      expect(entity.stats).toEqual(before.stats); // no snap, no invalid
      expect(entity.advance({ dir: 1 }, 0)).toEqual(before.drawn);
    });

    it('the draw then moves at the entity own speed from the new pose, never as a jump', () => {
      const { entity, tick } = seated(100);
      entity.advance({ dir: 1 }, FRAME);
      entity.snapTo({ x: 6, y: 200 });
      let drawn = entity.advance({ dir: 1 }, 0);
      expect(drawn.y).toBe(200);

      const deltas: number[] = [];
      for (let i = 0; i < 60; i++) {
        tick.advance(FRAME);
        const d = entity.advance({ dir: 1 }, FRAME);
        deltas.push(d.y - drawn.y);
        drawn = d;
      }
      // The playhead is a tick behind the mark and the reseeded history is one
      // entry, so the draw holds on the new pose until the next stamp gives it
      // a segment: at most one tick, and then exactly one frame of travel at
      // the paddle's speed, every frame, with nothing jumped in between.
      const moving = deltas.findIndex((d) => d > 1e-9);
      expect(moving).toBeGreaterThan(0);
      expect(moving).toBeLessThanOrEqual(Math.ceil(DT / FRAME));
      for (const d of deltas.slice(0, moving)) expect(d).toBe(0);
      for (const d of deltas.slice(moving)) expect(d).toBeCloseTo(SPEED * FRAME, 9);
      expect(drawn.y).toBeCloseTo(200 + (60 - moving) * SPEED * FRAME, 6);
    });
  });

  describe('the input change contract, end to end against a server model', () => {
    /**
     * A client leading the server by `lead` ticks, a playout buffer fed from
     * the payloads the entity sends, and a server that steps one tick per
     * iteration consuming the record for the tick it PRODUCES (the real
     * ticker's rule: the snapshot labelled T already reflects the record
     * stamped T). `completed` is the historical off-by-one, consuming the
     * record stamped with the completed count, kept as the control: steady
     * motion cannot tell the two apart, only an input change can, and this
     * run changes direction twice.
     */
    function run(consume: 'produced' | 'completed'): { snapTick: number; error: number }[] {
      const lead = 5;
      let serverTick = 100;
      let serverPose: Pose = INITIAL;
      const buffer = new Map<number, Dir>();
      let held: Dir = { dir: 0 };

      const { entity, tick, sent } = make();
      tick.anchorTo(serverTick + lead);
      entity.reconcile(serverPose, serverTick);

      const out: { snapTick: number; error: number }[] = [];
      for (let i = 0; i < 60; i++) {
        const dir = i < 20 ? 1 : i < 40 ? 0 : -1;
        tick.anchorTo(tick.value + 1);
        entity.advance({ dir }, FRAME);
        // Deliver the packet: a playout push is duplicate-overwriting.
        for (const rec of lastPayload(sent)) buffer.set(rec.targetTick, rec.data);

        const produced = serverTick + 1;
        const rec = buffer.get(consume === 'produced' ? produced : serverTick);
        if (rec) held = rec; // a starve repeats the last input, as the backstop does
        serverPose = stepY(serverPose, held, DT);
        serverTick = produced;

        const before = entity.pose.y;
        entity.reconcile(serverPose, serverTick);
        // Signed, from the prediction the reconcile replaced: positive means
        // the client was ahead of the server.
        out.push({ snapTick: serverTick, error: before - entity.pose.y });
        expect(entity.stats.lastError).toBe(Math.abs(before - entity.pose.y));
      }
      return out;
    }

    it('the real rule reconciles to exactly zero at every snapshot, across both direction changes', () => {
      const errors = run('produced');
      expect(errors).toHaveLength(60);
      for (const e of errors) expect(e.error).toBe(0);
    });

    it('THE CONTROL: the historical off-by-one reconciles one tick of travel out at each change and nowhere else', () => {
      const errors = run('completed');
      const nonzero = errors.filter((e) => e.error !== 0);
      // The start (tick 106, from a held 0 into dir 1), the stop (126) and
      // the reverse (146): exactly one tick of travel each, positive on the
      // start and negative on the stop, and nothing between them.
      expect(nonzero.map((e) => e.snapTick)).toEqual([106, 126, 146]);
      expect(nonzero.map((e) => e.error)).toEqual([PER_TICK, -PER_TICK, -PER_TICK]);
    });
  });

  describe('the render contract, against the real counter, the real playout buffer and a server model on wall time', () => {
    /** One-way delays, ms, both directions. Well inside the lead, so a healthy run has no late input. */
    const UPLINK_MS = 30;
    const DOWNLINK_MS = 30;
    /** The stamping lead the model connection anchors to, ticks above the server tick it estimates. */
    const LEAD = 4;
    /** `RoomConnection.frame()`'s dt clamp and its frozen-frame threshold (`FRAME_DT_CAP_S * 1000 + tickMs`), mirrored so the counter sees what it would see behind the real connection. */
    const FRAME_DT_CAP_S = 0.25;
    const FROZEN_GAP_MS = FRAME_DT_CAP_S * 1000 + TICK_MS;
    /** `REANCHOR_TOLERANCE_TICKS` and `REANCHOR_MIN_INTERVAL_MS`, the tolerance path of the two-sided re-anchor, mirrored. */
    const REANCHOR_TOLERANCE = 2;
    const REANCHOR_INTERVAL_MS = 2000;

    interface Frame {
      /** Wall time at this frame, ms. */
      t: number;
      dt: number;
      y: number;
      snaps: number;
      dir: number;
    }

    interface Ctx {
      /**
       * A connection re-anchor, as `onTickReanchor` would report it: the lead
       * the connection wants moved by `delta` (a feedback correction, an RTT
       * sample the epoch anchor lacked) and the counter followed it. Returns
       * the jump the playhead's target saw, which is `delta` less the
       * fraction `anchorTo` dropped.
       */
      reanchor(delta: number): number;
      readonly now: number;
    }

    interface Scenario {
      frames: number;
      fps?: number;
      dirAt: (frame: number) => number;
      /** The wall gap before this frame, seconds; the frame rate when absent. */
      gapAt?: (frame: number) => number | undefined;
      /** The one-way delay for the records sent on this frame, ms; `Infinity` drops the packet. */
      uplinkAt?: (frame: number, sent: number) => number;
      /** Runs before this frame's `conn.frame()`: the place a scenario re-anchors. */
      before?: (frame: number, ctx: Ctx) => void;
      /** The stamping lead the model connection anchors to, ticks; `LEAD` when absent. A scenario whose re-anchor moves the lead by more than `LEAD` starts higher, or every record after it lands late. */
      lead?: number;
    }

    interface Result {
      frames: Frame[];
      /** The frame the first snapshot landed before: the seat, and the first frame drawn from an anchored counter. */
      seatFrame: number;
      /** Every reconcile after the seat: the frame it landed before, and the error. */
      reconciles: { frame: number; error: number }[];
      snaps: number;
      lateInputs: number;
    }

    /**
     * The whole path on one wall clock. The server steps every `TICK_MS`,
     * delivering the records that have arrived by then into a REAL
     * `PlayoutBuffer` and consuming the one stamped for the tick it produces,
     * holding the last input on a starve. Every snapshot travels `DOWNLINK_MS`
     * and is processed at the first frame after it lands, where the model
     * connection anchors the counter (the first of the epoch, a frozen frame's
     * re-seat, or the two-tick tolerance path at most every two seconds) and
     * then reconciles. Then the frame itself: the counter advances by the
     * clamped dt, and the entity advances, sends, and draws.
     */
    function run(sc: Scenario): Result {
      const fps = sc.fps ?? 60;
      const clock = new ClientTick({ tickMs: TICK_MS });
      let now = 0;
      let frame = 0;
      const uplink: { at: number; records: { targetTick: number; data: Dir }[] }[] = [];
      let sentCount = 0;
      const conn = {
        tick: clock,
        send: (payload: string) => {
          const delay = sc.uplinkAt?.(frame, sentCount++) ?? UPLINK_MS;
          if (Number.isFinite(delay)) {
            uplink.push({ at: now + delay, records: JSON.parse(payload) as { targetTick: number; data: Dir }[] });
          }
        },
      };
      const entity = new PredictedEntity<Dir>({ conn, step: stepY, maxSpeed: SPEED, initial: INITIAL });

      let serverTick = 100;
      let serverPose: Pose = INITIAL;
      let held: Dir = { dir: 0 };
      const buffer = new PlayoutBuffer<Dir>();
      let nextTickAt = TICK_MS;
      const downlink: { at: number; producedAt: number; tick: number; pose: Pose }[] = [];

      let lead = sc.lead ?? LEAD;
      let lastFrameAt = 0;
      let lastReanchorAt = Number.NEGATIVE_INFINITY;
      let seated = false;
      let seatFrame = -1;
      const frames: Frame[] = [];
      const reconciles: { frame: number; error: number }[] = [];
      const ctx: Ctx = {
        reanchor: (delta) => {
          const jump = delta - clock.fraction;
          lead += delta;
          clock.anchorTo(clock.value + delta);
          lastReanchorAt = now;
          return jump;
        },
        get now() {
          return now;
        },
      };

      for (frame = 0; frame < sc.frames; frame++) {
        const gap = sc.gapAt?.(frame) ?? 1 / fps;
        now += gap * 1000;

        // The server, up to now.
        while (nextTickAt <= now) {
          for (const pkt of uplink.filter((p) => p.at <= nextTickAt)) {
            for (const rec of pkt.records) buffer.push(rec.targetTick, rec.data);
          }
          uplink.splice(0, uplink.length, ...uplink.filter((p) => p.at > nextTickAt));
          const produced = serverTick + 1;
          const { item } = buffer.consume(produced);
          if (item) held = item;
          serverPose = stepY(serverPose, held, DT);
          serverTick = produced;
          downlink.push({ at: nextTickAt + DOWNLINK_MS, producedAt: nextTickAt, tick: serverTick, pose: serverPose });
          nextTickAt += TICK_MS;
        }

        // The snapshots that landed since the last frame, in order, each
        // processed at ITS arrival time: the socket handler runs whether or
        // not the render loop does, so across a frozen frame the backlog is
        // a sequence of ordinary snapshot handlings, not one at the resume.
        for (const snap of downlink.filter((s) => s.at <= now)) {
          const t = snap.at;
          const desired = snap.tick + (t - snap.producedAt) / TICK_MS + lead;
          const error = Math.abs(clock.value - desired);
          if (
            !clock.anchored ||
            (error >= REANCHOR_TOLERANCE && t - lastReanchorAt >= REANCHOR_INTERVAL_MS)
          ) {
            clock.anchorTo(desired);
            lastReanchorAt = t;
          }
          entity.reconcile(snap.pose, snap.tick);
          if (seated) reconciles.push({ frame, error: entity.stats.lastError });
          else seatFrame = frame;
          seated = true;
        }
        downlink.splice(0, downlink.length, ...downlink.filter((s) => s.at > now));

        sc.before?.(frame, ctx);

        // `conn.frame()`: a frozen render loop unanchors the counter, and the
        // advance is clamped.
        const rawGap = now - lastFrameAt;
        lastFrameAt = now;
        const dt = Math.min(FRAME_DT_CAP_S, gap);
        if (rawGap > FROZEN_GAP_MS) clock.markUnanchored();
        clock.advance(dt);

        const dir = sc.dirAt(frame);
        const drawn = entity.advance({ dir }, dt);
        frames.push({ t: now, dt, y: drawn.y, snaps: entity.stats.snaps, dir });
      }
      return { frames, seatFrame, reconciles, snaps: entity.stats.snaps, lateInputs: buffer.lateCount };
    }

    /**
     * The invariants, over every frame after the seat: the drawn pose is
     * finite; it never steps backward while the input has only ever been
     * forward or still (or, with reversals in the input, reverses exactly as
     * often as the input does); and outside a counted snap no frame moves it
     * further than the slew allows, plus one frame of glide when the scenario
     * has corrections to glide.
     */
    function check(res: Result, opts: { corrections: boolean; reversals?: boolean; backward?: boolean }) {
      const { frames } = res;
      const glide = opts.corrections ? 1 : 0;
      let drawnFlips = 0;
      let inputFlips = 0;
      let lastDrawnSign = 0;
      let lastInputSign = 0;
      for (let i = 1; i < frames.length; i++) {
        const prev = frames[i - 1]!;
        const cur = frames[i]!;
        expect(Number.isFinite(cur.y)).toBe(true);
        const delta = cur.y - prev.y;
        if (cur.snaps > prev.snaps) continue; // a counted snap, the one jump allowed
        expect(Math.abs(delta)).toBeLessThanOrEqual((1 + RENDER_SLEW + glide) * SPEED * cur.dt + 1e-9);
        if (opts.reversals) {
          const s = Math.abs(delta) < 1e-9 ? 0 : Math.sign(delta);
          if (s !== 0) {
            if (lastDrawnSign !== 0 && s !== lastDrawnSign) drawnFlips++;
            lastDrawnSign = s;
          }
          const d = Math.sign(cur.dir);
          if (d !== 0) {
            if (lastInputSign !== 0 && d !== lastInputSign) inputFlips++;
            lastInputSign = d;
          }
        } else if (!opts.backward) {
          expect(delta).toBeGreaterThanOrEqual(-1e-9);
        }
      }
      if (opts.reversals) expect(drawnFlips).toBe(inputFlips);
    }

    /** Every reconcile from `fromFrame` on is exact. */
    function settled(res: Result, fromFrame: number) {
      const tail = res.reconciles.filter((r) => r.frame >= fromFrame);
      expect(tail.length).toBeGreaterThan(10);
      for (const r of tail) expect(r.error).toBe(0);
    }

    it('constant motion with starts and stops: exact at every reconcile, never backward, never over real time', () => {
      const res = run({ frames: 600, dirAt: (f) => (f < 150 ? 1 : f < 300 ? 0 : f < 450 ? 1 : 0) });
      check(res, { corrections: false });
      settled(res, 0);
      expect(res.snaps).toBe(1); // the seat
      expect(res.lateInputs).toBe(0);
      // And the motion is the entity's own: every moving frame is exactly one
      // frame of travel at the paddle's speed.
      const moving = res.frames.slice(10).filter((f, i, a) => i > 0 && f.y !== a[i - 1]!.y);
      expect(moving.length).toBeGreaterThan(200);
    });

    it('reversals: the draw reverses exactly as often as the input and never inside a steady run', () => {
      const res = run({ frames: 600, dirAt: (f) => (f < 150 ? 1 : f < 300 ? -1 : f < 450 ? 1 : -1) });
      check(res, { corrections: false, reversals: true });
      settled(res, 0);
      expect(res.snaps).toBe(1);
    });

    for (const delta of [3, 2]) {
      it(`a +${delta} re-anchor is caught up at a tenth over real time, over about ${delta * 10} ticks, with no frame faster than that`, () => {
        const at = 120;
        let jump = 0;
        const res = run({
          frames: 420,
          dirAt: () => 1,
          before: (f, ctx) => {
            if (f === at) jump = ctx.reanchor(delta);
          },
        });
        check(res, { corrections: false });
        settled(res, 0);
        expect(res.snaps).toBe(1); // the seat: a jump this size is slewed, not snapped
        expect(jump).toBeGreaterThan(delta - 1);
        const per = SPEED * FRAME;
        // The catch-up: the frames after the jump move faster than real time,
        // never more than a tenth faster, for ten ticks per tick of jump
        // (thirty frames per tick), and then real time again. Nothing moved
        // `delta` ticks of travel in one frame.
        const deltas = res.frames.map((f, i, a) => (i === 0 ? 0 : f.y - a[i - 1]!.y));
        const fast = deltas.slice(at).filter((d) => d > per + 1e-9);
        expect(fast.length).toBeGreaterThan(jump * 30 - 3);
        expect(fast.length).toBeLessThan(jump * 30 + 3);
        for (const d of fast) expect(d).toBeLessThanOrEqual((1 + RENDER_SLEW) * per + 1e-9);
        for (const d of deltas.slice(at + delta * 30 + 10)) expect(d).toBeCloseTo(per, 9);
        // And the total is right: by the end the draw is exactly where a
        // draw that had followed the counter would be.
        const last = res.frames.length - 1;
        const followed = res.frames[last]!.y - res.frames[at - 1]!.y;
        expect(followed).toBeCloseTo((last - at + 1) * per + jump * PER_TICK, 6);
      });
    }

    it('a -1 anchor (the ordinary epoch anchor on a fast link) loses its tick of wall time gradually, never as a backward step or a hold', () => {
      // The counter says the tick it was on is a tick further away than it
      // thought, and the next stamp with it: the playhead is a tick ahead
      // of its target and lets the target catch up at nine tenths, running
      // past the newest stored pose on the speculation where it has to, and
      // never moves backward, never jumps a tick when the next pose arrives,
      // and never sits still.
      const at = 120;
      let jump = 0;
      const res = run({
        frames: 420,
        dirAt: () => 1,
        before: (f, ctx) => {
          if (f === at) jump = ctx.reanchor(-1);
        },
      });
      check(res, { corrections: false });
      settled(res, 0);
      expect(res.snaps).toBe(1);
      expect(jump).toBeLessThan(-1 + 1e-9);
      const per = SPEED * FRAME;
      const deltas = res.frames.map((f, i, a) => (i === 0 ? 0 : f.y - a[i - 1]!.y));
      const during = deltas.slice(at, at + 60);
      const slow = during.filter((d) => d < per - 1e-9);
      expect(slow.length).toBeGreaterThan(5);
      for (const d of during) {
        expect(d).toBeGreaterThan(0);
        expect(d).toBeLessThanOrEqual(per + 1e-9);
      }
      for (const d of deltas.slice(at + 60)) expect(d).toBeCloseTo(per, 9);
      // The tick is lost exactly once: by the end the draw is where a draw
      // that had followed the counter would be.
      const last = res.frames.length - 1;
      const followed = res.frames[last]!.y - res.frames[at - 1]!.y;
      expect(followed).toBeCloseTo((last - at + 1) * per + jump * PER_TICK, 6);
    });

    /** The per-frame deltas of the drawn y, and the first frame from `at` after which every frame is exactly one frame of travel at `speed`: where the playhead is back on target. */
    function catchUp(res: Result, at: number, per: number): { deltas: number[]; onTarget: number } {
      const deltas = res.frames.map((f, i, a) => (i === 0 ? 0 : f.y - a[i - 1]!.y));
      let onTarget = deltas.length;
      while (onTarget > at && Math.abs(deltas[onTarget - 1]! - per) < 1e-9) onTarget--;
      return { deltas, onTarget };
    }

    for (const delta of [-2, -3]) {
      it(`a ${delta} re-anchor with the key held: exact at every snapshot, the lost ticks paid at nine tenths of real time over about ${-delta * 10} ticks, never a crawl`, () => {
        // The ordinary two-sided tolerance correction. The counter says the
        // ticks it had stamped beyond `value - 1` have not happened yet, so
        // the prediction rewinds to the pose after `value - 1` and re-stamps
        // them as it climbs back, and for a held key each re-stamp is the
        // pose already held: the reconcile is exact at EVERY snapshot,
        // including the ones inside the jump (the first shape of this
        // double-stepped the prediction and reconciled 22.5 units out). The
        // draw pays the lost ticks the way it pays a forward jump: the
        // playhead slews at nine tenths of real time until the target has
        // caught it up, and where that takes it past the newest stored pose
        // it draws the speculation, the newest pose stepped with the held
        // input, which is exactly what the re-stamps then produce. Before
        // the speculation the playhead was held to the history's end and
        // spread what was left of it over the wait for the next new pose:
        // 0.11x for 8 frames after a -2 and 0.08x for 11 after a -3, a near
        // pause on the one entity the player steers, on every correction.
        const at = 120;
        let jump = 0;
        const res = run({
          frames: 480,
          dirAt: () => 1,
          before: (f, ctx) => {
            if (f === at) jump = ctx.reanchor(delta);
          },
        });
        check(res, { corrections: false });
        settled(res, 0);
        expect(res.snaps).toBe(1);
        expect(jump).toBeLessThan(delta + 1e-9);
        const per = SPEED * FRAME;
        const { deltas, onTarget } = catchUp(res, at, per);
        // From the jump until the playhead is back on target every frame
        // is inside the slew: nine tenths of the entity's speed and never
        // less (no crawl: nothing under 0.85x), never over a tenth more.
        const paying = deltas.slice(at, onTarget);
        expect(paying.length).toBeGreaterThan((-jump - 1) * 30);
        expect(paying.length).toBeLessThan(-jump * 30 + 3);
        for (const d of paying) {
          expect(d).toBeGreaterThanOrEqual(0.85 * per);
          expect(d).toBeGreaterThanOrEqual((1 - RENDER_SLEW) * per - 1e-9);
          expect(d).toBeLessThanOrEqual((1 + RENDER_SLEW) * per + 1e-9);
        }
        expect(paying.filter((d) => Math.abs(d - (1 - RENDER_SLEW) * per) < 1e-9).length).toBeGreaterThan(paying.length - 3);
        for (const d of deltas.slice(onTarget)) expect(d).toBeCloseTo(per, 9);
        // The ticks are lost exactly once: by the end the draw is where a
        // draw that had followed the counter would be, the raw travel less
        // the ticks the jump took.
        const last = res.frames.length - 1;
        const followed = res.frames[last]!.y - res.frames[at - 1]!.y;
        expect(followed).toBeCloseTo((last - at + 1) * per + jump * PER_TICK, 6);
      });
    }

    it('a -3 re-anchor with the key RELEASED on the jump: the speculative tail is redrawn as a glide, continuous within the glide bound, exact once re-stamped', () => {
      // The poses beyond the mark were predicted with the key held, and the
      // re-stamps that overwrite them carry the release: the segment under
      // the playhead changes shape, and the difference measured at the
      // playhead goes to the offset, so the draw comes back onto the truth
      // as a glide (backward, since the tail overshot) and never as a step.
      const at = 120;
      const res = run({
        frames: 480,
        dirAt: (f) => (f < at ? 1 : 0),
        before: (f, ctx) => f === at && ctx.reanchor(-3),
      });
      check(res, { corrections: true, backward: true });
      settled(res, at + 60);
      expect(res.snaps).toBe(1);
      // No backward step is more than one frame of glide: the entity has
      // stopped, so every backward frame is the offset alone.
      const glide = SPEED * FRAME;
      const deltas = res.frames.map((f, i, a) => (i === 0 ? 0 : f.y - a[i - 1]!.y));
      for (const d of deltas.slice(at)) expect(d).toBeGreaterThanOrEqual(-glide - 1e-9);
      // And it is a real redraw: the draw ends on the stop, not on the tail
      // (an exponential glide, so within a thousandth from a second and a
      // half on).
      const stopped = res.frames[res.frames.length - 1]!.y;
      for (const f of res.frames.slice(at + 90)) expect(f.y).toBeCloseTo(stopped, 3);
    });

    it('an input change while the playhead is on the speculation (the key released eight frames after a -3) is absorbed by the offset: continuous within the glide bound at the frame it lands', () => {
      // Eight frames after the jump the counter is still a tick short of the
      // old newest pose and the playhead is about two ticks past it, drawing
      // the speculation stepped with the held key. The release rebuilds the
      // speculation flat, and the draw at the playhead changes by two ticks
      // of travel that the re-stamps will confirm: measured against the
      // speculation the previous frame DREW and carried by the offset, the
      // draw glides back. Measured against the stored history clamped at
      // its end it would see no change, and the draw would step the two
      // ticks in one frame.
      const at = 120;
      const release = at + 8;
      const res = run({
        frames: 480,
        lead: 10,
        dirAt: (f) => (f < release ? 1 : 0),
        before: (f, ctx) => f === at && ctx.reanchor(-3),
      });
      check(res, { corrections: true, backward: true });
      settled(res, at + 60);
      expect(res.snaps).toBe(1);
      expect(res.lateInputs).toBe(0); // the lead absorbs the jump, so every correction here is the draw's own
      const glide = SPEED * FRAME;
      const deltas = res.frames.map((f, i, a) => (i === 0 ? 0 : f.y - a[i - 1]!.y));
      // The frame of the release and every frame after it: the entity has
      // stopped, so the draw moves by the glide alone, at most one frame of
      // it, and by more than a frame of the entity's own travel nowhere.
      expect(Math.abs(deltas[release]!)).toBeLessThanOrEqual(glide + 1e-9);
      for (const d of deltas.slice(release)) expect(Math.abs(d)).toBeLessThanOrEqual(glide + 1e-9);
      // The glide is real: the speculation the release threw away was two
      // ticks of travel, and the draw gives it back over several frames
      // rather than none.
      const backward = deltas.slice(release, release + 30).filter((d) => d < -1e-9);
      expect(backward.length).toBeGreaterThan(3);
      const stopped = res.frames[res.frames.length - 1]!.y;
      for (const f of res.frames.slice(at + 120)) expect(f.y).toBeCloseTo(stopped, 3);
    });

    it('a -5 re-anchor with the key held is past PLAYHEAD_SNAP_TICKS: one counted snap onto real history, not five ticks of speculation', () => {
      // The speculation is bounded by the same number the playhead snaps
      // at, and a jump this size never reaches it: the target is more than
      // four ticks behind the playhead, so the playhead jumps to it, counted,
      // and draws stored poses from the next frame on at real time.
      const at = 120;
      let jump = 0;
      const res = run({
        frames: 400,
        lead: 10,
        dirAt: () => 1,
        before: (f, ctx) => {
          if (f === at) jump = ctx.reanchor(-5);
        },
      });
      check(res, { corrections: false });
      settled(res, 0);
      expect(res.snaps).toBe(2);
      expect(res.frames[at]!.snaps).toBe(2);
      const per = SPEED * FRAME;
      // The whole jump in the one counted frame, and exactly real time after.
      expect(res.frames[at]!.y - res.frames[at - 1]!.y).toBeCloseTo(jump * PER_TICK + per, 6);
      const { deltas, onTarget } = catchUp(res, at + 1, per);
      expect(onTarget).toBe(at + 1);
      expect(deltas.slice(at + 1).every((d) => Math.abs(d - per) < 1e-9)).toBe(true);
    });

    it('a 70ms frame is ordinary motion: two ticks of travel in a frame that took two ticks', () => {
      const at = 120;
      const res = run({ frames: 300, dirAt: () => 1, gapAt: (f) => (f === at ? 0.07 : undefined) });
      check(res, { corrections: false });
      settled(res, 0);
      expect(res.snaps).toBe(1);
      const long = res.frames[at]!.y - res.frames[at - 1]!.y;
      expect(long).toBeCloseTo(SPEED * 0.07, 9);
    });

    it('a late burst (records landing after their tick was produced, across a stop) glides its corrections and returns to exact', () => {
      // Every packet sent in a 400ms window arrives 400ms late: the server
      // runs the buffer dry, starves the ticks the window stamped, holds the
      // last input through the player's stop, and the late records are
      // re-stamped forward by the buffer's never-drop-late rule. The client
      // predicted the stop on time, so each snapshot through the starve
      // corrects by one tick of travel, and every one of those corrections
      // has to glide.
      const from = 120;
      const res = run({
        frames: 600,
        dirAt: (f) => (f < from + 2 ? 1 : 0),
        uplinkAt: (f) => (f >= from && f < from + 24 ? 400 : UPLINK_MS),
      });
      check(res, { corrections: true });
      settled(res, from + 150);
      expect(res.snaps).toBe(1);
      expect(res.lateInputs).toBeGreaterThan(0);
      expect(res.reconciles.filter((r) => r.frame > from && r.error > 0).length).toBeGreaterThan(0);
    });

    it('a 450ms starve across a stop glides the held-input divergence away and returns to exact', () => {
      // Nine ticks of dropped packets: the server holds dir 1 through the
      // stop at frame 130 and runs 40 units past where the client stopped,
      // inside the snap distance, then the window resumes and the replay is
      // exact again once the snapshot tick passes the starved ticks.
      const from = 120;
      const res = run({
        frames: 600,
        dirAt: (f) => (f < 130 ? 1 : 0),
        uplinkAt: (f) => (f >= from && f < from + 27 ? Number.POSITIVE_INFINITY : UPLINK_MS),
      });
      check(res, { corrections: true });
      settled(res, from + 150);
      expect(res.snaps).toBe(1);
      expect(res.reconciles.filter((r) => r.frame > from && r.error > 0).length).toBeGreaterThan(0);
    });

    it('a 2s frozen tab counts exactly one snap and is continuous on either side of it', () => {
      // The key released before the tab switch, held again after it. No
      // frames for two seconds, forty server ticks standing still. The
      // resume frame is clamped and unanchors the counter (as
      // `RoomConnection.frame()` does), the next snapshot re-seats it forty
      // ticks on, and the entity sees that as ONE jump: the playhead does not
      // chase an unanchored counter, so the clamped advance on the resume
      // frame and the re-anchor a frame later are one accounted snap.
      const at = 180;
      const res = run({
        frames: 600,
        dirAt: (f) => (f < at - 12 || f >= at + 12 ? 1 : 0),
        gapAt: (f) => (f === at ? 2 : undefined),
      });
      check(res, { corrections: false });
      settled(res, 0);
      expect(res.snaps).toBe(2); // the seat, then the freeze
      const snapAt = res.frames.findIndex((f, i, a) => i > res.seatFrame && f.snaps > a[i - 1]!.snaps);
      expect(snapAt).toBeGreaterThanOrEqual(at);
      expect(snapAt).toBeLessThanOrEqual(at + 2);
    });

    it('a 2s frozen tab with the key held is a real desync of two seconds of travel: every jump is a counted snap and the draw lands on the truth', () => {
      // The server keeps applying the held input for forty ticks the client
      // never predicted, and the backlog of snapshots, reconciled together
      // at the resume, moves the prediction 180 units. No glide can carry
      // that, and none tries: each time the offset would pass the snap
      // distance it is dropped and counted, and outside those frames the
      // draw is continuous.
      const at = 180;
      const res = run({ frames: 600, dirAt: () => 1, gapAt: (f) => (f === at ? 2 : undefined) });
      check(res, { corrections: true });
      settled(res, at + 150);
      expect(res.snaps).toBeGreaterThan(2);
      // Every snap is at the resume or inside the second the re-seat takes
      // (the backlog's corrections, the playhead's jump, the corrections
      // that follow the counter's own re-anchor), and none before or after.
      const snapFrames = res.frames
        .map((f, i, a) => (i > res.seatFrame && f.snaps > a[i - 1]!.snaps ? i : -1))
        .filter((i) => i >= 0);
      expect(snapFrames.length).toBeGreaterThan(0);
      for (const f of snapFrames) expect(f).toBeGreaterThanOrEqual(at);
      for (const f of snapFrames) expect(f).toBeLessThanOrEqual(at + 60);
    });

    for (const fps of [144, 30]) {
      it(`constant motion at ${fps}fps moves exactly speed * dt every frame once the playhead is on target`, () => {
        const res = run({ frames: fps * 5, fps, dirAt: () => 1 });
        check(res, { corrections: false });
        settled(res, 0);
        expect(res.snaps).toBe(1);
        const per = SPEED / fps;
        // From the frame after the seat: before it the counter has no anchor
        // and the draw is `initial`, standing still.
        for (let i = res.seatFrame + 2; i < res.frames.length; i++) {
          expect(res.frames[i]!.y - res.frames[i - 1]!.y).toBeCloseTo(per, 9);
        }
      });
    }

    it('the playhead snap threshold is what makes a handoff-sized jump one counted snap rather than a long catch-up', () => {
      const at = 120;
      let jump = 0;
      const res = run({
        frames: 400,
        dirAt: () => 1,
        before: (f, ctx) => {
          if (f === at) jump = ctx.reanchor(PLAYHEAD_SNAP_TICKS + 2);
        },
      });
      check(res, { corrections: false });
      expect(res.snaps).toBe(2);
      expect(res.frames[at]!.y - res.frames[at - 1]!.y).toBeCloseTo(jump * PER_TICK + SPEED * FRAME, 6);
    });
  });
});
