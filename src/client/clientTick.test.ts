import { describe, it, expect } from 'vitest';
import { ClientTick, TICK_STEP_CAP } from './clientTick.js';

describe('ClientTick', () => {
  it('does not advance before the first anchor', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.advance(1);
    expect(t.value).toBe(0);
    expect(t.initialized).toBe(false);
  });

  it('anchorTo sets the counter to round(targetTick), adding no lead of its own, and returns the exact delta', () => {
    // A FRACTIONAL targetTick, because that is the only kind the real caller
    // ever produces: `connection.ts`'s `desiredTick()` divides an
    // elapsed-milliseconds figure and a measured RTT by the tick interval, so
    // an integer is the measure-zero case. Every test here used to pass one,
    // which made `Math.floor` and `Math.round` indistinguishable in the whole
    // file.
    //
    // THE LEAD IS NOT THIS CLASS'S ANY MORE. There used to be an
    // `anchorMargin` of 4 ticks added here, a lead in TICKS with no round-trip
    // term in it, so the value below would have been 105 rather than 101. The
    // connection composes the lead from a measured RTT and a lead in
    // milliseconds and hands the finished number over.
    const t = new ClientTick({ tickMs: 50 });
    const delta = t.anchorTo(100.6); // rounds UP to 101; flooring would give 100
    expect(t.value).toBe(101);
    expect(delta).toBe(101);
    expect(t.initialized).toBe(true);
    expect(t.anchored).toBe(true);

    // ...and DOWN, from the other side of the same boundary, so the assertion
    // above cannot be satisfied by rounding in one direction always.
    const down = new ClientTick({ tickMs: 50 });
    expect(down.anchorTo(100.4)).toBe(100);
    expect(down.value).toBe(100);
  });

  it('a second anchorTo returns the delta from the PREVIOUS value, not from zero', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.anchorTo(100.4); // rounds down to 100
    const delta = t.anchorTo(200.7); // rounds up to 201
    expect(t.value).toBe(201);
    expect(delta).toBe(101);
  });

  it('anchorTo can move the counter BACKWARDS, and says so in its return value', () => {
    // The behind-side re-anchor and the frozen-tab recovery both hand back a
    // target below the current value, and a host folding the delta into an
    // `ErrorOffset` needs the sign. Nothing about the counter is monotonic
    // across an anchor; only `advance()` is.
    const t = new ClientTick({ tickMs: 50 });
    t.anchorTo(300);
    expect(t.anchorTo(288.4)).toBe(-12);
    expect(t.value).toBe(288);
  });

  it('advance() rounds serverTick and never jumps mid-epoch: a run of small frames matches the tick rate exactly', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.anchorTo(0);
    const start = t.value;
    // 100 frames of 10ms = 1000ms = 20 ticks at 50ms/tick, with no dilation applied.
    for (let i = 0; i < 100; i++) t.advance(0.01);
    expect(t.value - start).toBe(20);
  });

  it('advance() never advances by more than TICK_STEP_CAP ticks in one call, even after a huge dt', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.anchorTo(0);
    const start = t.value;
    t.advance(10); // 200 nominal ticks' worth of wall time in one frame
    expect(t.value - start).toBeLessThanOrEqual(TICK_STEP_CAP);
    expect(t.value - start).toBe(TICK_STEP_CAP);
  });

  it('a capped frame does not leave a debt that bursts forward on the next call', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.anchorTo(0);
    t.advance(10); // capped
    const afterCap = t.value;
    t.advance(0.05); // exactly one nominal tick
    expect(t.value - afterCap).toBe(1);
  });

  it('markUnanchored clears the anchored flag but not the counter, and initialized stays true', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.anchorTo(100);
    t.markUnanchored();
    expect(t.anchored).toBe(false);
    expect(t.initialized).toBe(true);
    expect(t.value).toBe(100);
  });

  // `fraction` is what lets a host draw a locally predicted entity at the
  // frame rate rather than at the tick rate: the entity only moves when a tick
  // is stamped, so drawing its raw state at 60fps against a 20Hz counter holds
  // it for three frames and then moves it a whole tick of travel at once. The
  // host interpolates between its previous and current tick state by this
  // number, so it has to be 0 before anything has been anchored, climb with
  // wall time, and wrap on every whole step rather than keep climbing.

  it('fraction is 0 before the first anchor, and advance() does not move it', () => {
    const t = new ClientTick({ tickMs: 50 });
    expect(t.fraction).toBe(0);
    t.advance(0.04);
    expect(t.fraction).toBe(0);
    expect(t.value).toBe(0);
  });

  it('fraction rises with advance() and wraps when a step is taken', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.anchorTo(0);
    t.advance(0.04); // 40ms into a 50ms tick
    expect(t.fraction).toBeCloseTo(0.8, 9);
    expect(t.value).toBe(0);
    t.advance(0.02); // 60ms: one whole step, 10ms left over
    expect(t.fraction).toBeCloseTo(0.2, 9);
    expect(t.value).toBe(1);
  });

  it('fraction wraps by exactly the steps taken when one frame crosses two ticks', () => {
    // A 130ms frame is two whole ticks and 30ms, and a fraction that only ever
    // subtracted ONE tick would read 1.6 here.
    const t = new ClientTick({ tickMs: 50 });
    t.anchorTo(0);
    t.advance(0.13);
    expect(t.value).toBe(2);
    expect(t.fraction).toBeCloseTo(0.6, 9);
  });

  it('fraction is 0 immediately after an anchor, and after a re-anchor taken mid-tick', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.anchorTo(100);
    expect(t.fraction).toBe(0);
    t.advance(0.04);
    expect(t.fraction).toBeCloseTo(0.8, 9);
    // A mid-epoch re-anchor drops the partial tick: the counter has just been
    // set to a whole tick by fiat, so the host's previous state is not one
    // tick behind it any more and the interpolation restarts from there.
    t.anchorTo(200);
    expect(t.fraction).toBe(0);
    // ...and the same through a fresh epoch.
    t.advance(0.03);
    t.markUnanchored();
    t.anchorTo(300);
    expect(t.fraction).toBe(0);
  });

  it('fraction stays below 1 after a long frame that hit TICK_STEP_CAP, and over a run of ordinary frames', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.anchorTo(0);
    t.advance(10); // capped: the excess is dropped rather than left in the accumulator
    expect(t.value).toBe(TICK_STEP_CAP);
    expect(t.fraction).toBeGreaterThanOrEqual(0);
    expect(t.fraction).toBeLessThan(1);
    // 60fps frames against a 50ms tick, none of which divide it evenly, so the
    // remainder is non-zero on almost every frame and has to stay under one.
    for (let i = 0; i < 300; i++) {
      t.advance(1 / 60);
      expect(t.fraction).toBeGreaterThanOrEqual(0);
      expect(t.fraction).toBeLessThan(1);
    }
    // Five seconds is 100 ticks, give or take the last frame's rounding.
    expect(t.value).toBeGreaterThanOrEqual(TICK_STEP_CAP + 99);
    expect(t.value).toBeLessThanOrEqual(TICK_STEP_CAP + 100);
  });
});
