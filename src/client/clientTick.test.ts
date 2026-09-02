import { describe, it, expect } from 'vitest';
import { ClientTick, TICK_STEP_CAP, STEP_DILATION_MAX } from './clientTick.js';

describe('ClientTick', () => {
  it('does not advance before the first anchor', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.advance(1);
    expect(t.value).toBe(0);
    expect(t.initialized).toBe(false);
  });

  it('anchorTo sets the counter to round(serverTick) + anchorMargin and returns the exact delta', () => {
    // A FRACTIONAL serverTick, because that is the only kind the real caller
    // ever produces: `connection.ts`'s `estimateServerTick()` divides an
    // elapsed-milliseconds figure by the tick interval, so an integer is the
    // measure-zero case. Every test here used to pass one, which made
    // `Math.floor` and `Math.round` indistinguishable in the whole file.
    const t = new ClientTick({ tickMs: 50, anchorMargin: 4 });
    const delta = t.anchorTo(100.6); // rounds UP to 101; flooring would give 100
    expect(t.value).toBe(105);
    expect(delta).toBe(105);
    expect(t.initialized).toBe(true);
    expect(t.anchored).toBe(true);

    // ...and DOWN, from the other side of the same boundary, so the assertion
    // above cannot be satisfied by rounding in one direction always.
    const down = new ClientTick({ tickMs: 50, anchorMargin: 4 });
    expect(down.anchorTo(100.4)).toBe(104);
    expect(down.value).toBe(104);
  });

  it('a second anchorTo returns the delta from the PREVIOUS value, not from zero', () => {
    const t = new ClientTick({ tickMs: 50, anchorMargin: 4 });
    t.anchorTo(100.4); // rounds down to 100 -> 104
    const delta = t.anchorTo(200.7); // rounds up to 201 -> 205
    expect(t.value).toBe(205);
    expect(delta).toBe(101);
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
    expect(t.value).toBe(104);
  });

  it('reportBufferHealth keeps dilation within +-dilationMax regardless of how extreme the reported margin is', () => {
    const t = new ClientTick({ tickMs: 50, dilationMax: 0.05 });
    for (let i = 0; i < 200; i++) t.reportBufferHealth(0, 0.05); // starving: push toward max speed-up
    expect(t.dilation).toBeLessThanOrEqual(STEP_DILATION_MAX);
    expect(t.dilation).toBeGreaterThan(0); // starving should speed the tick up, not slow it

    const t2 = new ClientTick({ tickMs: 50, dilationMax: 0.05 });
    for (let i = 0; i < 200; i++) t2.reportBufferHealth(20, 0.05); // deep buffer: push toward max slow-down
    expect(t2.dilation).toBeGreaterThanOrEqual(-STEP_DILATION_MAX);
    expect(t2.dilation).toBeLessThan(0);
  });

  it('dilation eases rather than snapping to its target on a single report', () => {
    const t = new ClientTick({ tickMs: 50 });
    t.reportBufferHealth(0, 0.05);
    const afterOne = t.dilation;
    expect(Math.abs(afterOne)).toBeLessThan(STEP_DILATION_MAX);
    expect(afterOne).toBeGreaterThan(0);
  });

  it('a healthy margin at the target produces roughly zero dilation', () => {
    // REACHING THE TARGET HAS TO BE SOMETHING THIS CLASS DID. `easedMargin`
    // starts at MARGIN_TARGET and `easedDilation` starts at zero, so feeding
    // the target value and asserting the target state asserts the constructor,
    // not the ease: emptying the whole body of `reportBufferHealth` passes it.
    // Come at the target from somewhere else, and pin the departure too.
    const t = new ClientTick({ tickMs: 50, marginTarget: 3, dilationMax: 0.05, marginSpan: 1.5 });

    // A buffer three ticks deeper than it should be: the tick must slow down.
    for (let i = 0; i < 300; i++) t.reportBufferHealth(8, 0.1);
    expect(t.bufferedMargin).toBeCloseTo(8, 6);
    expect(t.dilation).toBeCloseTo(-0.05, 6);

    // Now the buffer is healthy again, and both stages ease back to rest.
    for (let i = 0; i < 300; i++) t.reportBufferHealth(3, 0.1);
    expect(Math.abs(t.dilation)).toBeLessThan(0.001);
    expect(t.bufferedMargin).toBeCloseTo(3, 6);
  });

  it('positive dilation (speeding up) makes advance() consume ticks faster than nominal', () => {
    const t = new ClientTick({ tickMs: 50, dilationMax: 0.05, marginTarget: 3, marginSpan: 1.5 });
    t.anchorTo(0);
    // Saturate the two-stage ease well past its asymptote before measuring,
    // so a boundary rounding difference of one tick cannot make this flaky.
    for (let i = 0; i < 400; i++) t.reportBufferHealth(0, 0.05);
    const start = t.value;
    // 3000ms of wall time at nominal 50ms/tick would be exactly 60 ticks;
    // sped up it must be measurably more, spread over many small frames so
    // no single call hits TICK_STEP_CAP.
    for (let i = 0; i < 300; i++) t.advance(0.01);
    expect(t.value - start).toBeGreaterThan(61);
  });
});
