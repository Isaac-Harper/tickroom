import { describe, expect, it } from 'vitest';
import { decayOnStarve, StarveTracker, STARVE_DECAY_AFTER, STARVE_DECAY_EPS } from './starvation.js';

describe('decayOnStarve', () => {
  it('matches the documented full-lock decay table exactly', () => {
    // Full-lock value of 1, decayAfter=2 (default), factor=0.5 (default),
    // epsilon=0.05 (default): 1 -> 1 -> 0.5 -> 0.25 -> 0.125 -> 0.0625 -> 0
    let streak = 0;
    let value = 1;
    const trace: number[] = [value];
    for (let i = 0; i < 6; i++) {
      // Mirrors the real seam: whatever hands this function a streak (a
      // host's own StarveTracker, or the ticker's onStarve handoff) has
      // already incremented it BEFORE calling. decayOnStarve itself does not.
      streak += 1;
      const result = decayOnStarve(streak, value);
      value = result.value;
      trace.push(value);
    }
    expect(trace).toEqual([1, 1, 0.5, 0.25, 0.125, 0.0625, 0]);
  });

  it('echoes the streak back unchanged: incrementing it is the caller\'s job now, not this function\'s', () => {
    // This is the shape of the bug F1 fixed: decayOnStarve used to bump the
    // streak itself, which silently added a phantom starve on top of
    // whatever a host's own counter already reported. Pinning the echo
    // directly is what would catch a regression back to that behaviour.
    const r1 = decayOnStarve(1, 1);
    expect(r1.streak).toBe(1);
    const r2 = decayOnStarve(2, r1.value);
    expect(r2.streak).toBe(2);
  });

  it('does not decay before decayAfter consecutive starves', () => {
    // streak=1 is the FIRST starve, delivered exactly as onStarve reports it.
    const r = decayOnStarve(1, 42);
    expect(r.value).toBe(42);
  });

  it('snaps to exactly 0 once decayed value falls under epsilon', () => {
    const r = decayOnStarve(STARVE_DECAY_AFTER + 10, 0.06, { epsilon: 0.05, factor: 0.5 });
    // 0.06 * 0.5 = 0.03, under 0.05
    expect(r.value).toBe(0);
  });

  it('does not snap a value that decays to exactly or above epsilon', () => {
    // ABOVE epsilon.
    const above = decayOnStarve(STARVE_DECAY_AFTER + 10, 0.2, { epsilon: 0.05, factor: 0.5 });
    expect(above.value).toBe(0.1);
    // AND EXACTLY AT IT, which is the half this case was named for and did
    // not drive: the snap is `Math.abs(decayed) < epsilon`, so a value
    // landing precisely on epsilon must survive, and only a decay that takes
    // it strictly below snaps to 0. 0.1 * 0.5 is exactly representable as
    // the same double the 0.05 literal parses to, so this is a true equality
    // rather than a float that happens to land close.
    const exactly = decayOnStarve(STARVE_DECAY_AFTER + 10, 0.1, { epsilon: 0.05, factor: 0.5 });
    expect(exactly.value).toBe(0.05);
  });

  it('honours a custom decayAfter', () => {
    // decayAfter=1 means decay begins on the very first starve, streak=1.
    const r = decayOnStarve(1, 1, { decayAfter: 1 });
    expect(r.value).toBe(0.5);
  });

  it('honours a custom factor', () => {
    const r = decayOnStarve(STARVE_DECAY_AFTER, 1, { factor: 0.9 });
    expect(r.value).toBeCloseTo(0.9);
  });

  it('decays a negative value correctly, snapping by magnitude not sign', () => {
    const r = decayOnStarve(STARVE_DECAY_AFTER + 10, -0.06, { epsilon: 0.05, factor: 0.5 });
    expect(r.value).toBe(0);
  });

  it('exposes the shipped defaults', () => {
    expect(STARVE_DECAY_AFTER).toBe(2);
    expect(STARVE_DECAY_EPS).toBe(0.05);
  });
});

describe('StarveTracker', () => {
  it('starts every pid at streak 0', () => {
    const t = new StarveTracker();
    expect(t.streakOf('a')).toBe(0);
  });

  it('onStarve increments and returns the new streak', () => {
    const t = new StarveTracker();
    expect(t.onStarve('a')).toBe(1);
    expect(t.onStarve('a')).toBe(2);
    expect(t.streakOf('a')).toBe(2);
  });

  it('onConsume resets the streak to 0', () => {
    const t = new StarveTracker();
    t.onStarve('a');
    t.onStarve('a');
    t.onConsume('a');
    expect(t.streakOf('a')).toBe(0);
  });

  it('tracks each pid independently', () => {
    const t = new StarveTracker();
    t.onStarve('a');
    t.onStarve('a');
    t.onStarve('b');
    expect(t.streakOf('a')).toBe(2);
    expect(t.streakOf('b')).toBe(1);
  });

  it('forget removes a pid entirely (reads back as 0, indistinguishable from never-seen)', () => {
    const t = new StarveTracker();
    t.onStarve('a');
    t.forget('a');
    expect(t.streakOf('a')).toBe(0);
  });

  it('clear resets every pid', () => {
    const t = new StarveTracker();
    t.onStarve('a');
    t.onStarve('b');
    t.clear();
    expect(t.streakOf('a')).toBe(0);
    expect(t.streakOf('b')).toBe(0);
  });

  it('a decayOnStarve loop driven by StarveTracker reproduces the same full-lock table', () => {
    // The value straight through: StarveTracker.onStarve already returns the
    // count AFTER this starve (1 on the first), which is exactly what
    // decayOnStarve now wants, no `streak - 1` translation needed.
    const t = new StarveTracker();
    let value = 1;
    const trace: number[] = [value];
    for (let i = 0; i < 6; i++) {
      const streak = t.onStarve('car-1');
      const result = decayOnStarve(streak, value);
      value = result.value;
      trace.push(value);
    }
    expect(trace).toEqual([1, 1, 0.5, 0.25, 0.125, 0.0625, 0]);
  });
});
