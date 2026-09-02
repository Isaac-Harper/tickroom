import { describe, expect, it } from 'vitest';
import { Counters, METRIC_CAP, percentiles, RollingHistogram } from './metrics.js';

describe('percentiles', () => {
  it('returns null for an empty input, because an unmeasured window is not a perfect one', () => {
    // NOT `{ p50: 0, p95: 0, max: 0 }`, which is what this used to answer and
    // is the reason a room whose every publish was failing reported the best
    // latency figures in the fleet: zero is the BEST value a latency
    // distribution can take, so "no samples" and "every sample instant" were
    // indistinguishable in the gauge that exists to tell them apart.
    expect(percentiles([])).toBeNull();
  });

  it('computes max correctly', () => {
    expect(percentiles([3, 1, 4, 1, 5, 9, 2, 6])?.max).toBe(9);
  });

  it('computes p50 for an odd-length sorted set', () => {
    // sorted: 1,2,3,4,5 -> floor(0.5*5)=2 -> index 2 -> value 3
    expect(percentiles([5, 3, 1, 4, 2])?.p50).toBe(3);
    // THE INDEX RULE IS `floor(fraction * length)`, NOT
    // `floor(fraction * (length - 1))`, and on an odd length the p50 above
    // cannot tell those two apart: for any odd n both land on (n-1)/2. p95
    // over the same five samples does separate them (floor(0.95*5)=4, the 5,
    // against floor(0.95*4)=3, the 4), and it is the same off-by-one that
    // cost the interpolator's delay quantile the largest sample in its
    // window, so it is pinned here rather than left to the reader.
    expect(percentiles([5, 3, 1, 4, 2])?.p95).toBe(5);
  });

  it('rounds to integers', () => {
    // NON-INTEGER SAMPLES ON PURPOSE. Every other case in this file feeds
    // whole numbers, which round to themselves, so the three `Math.round`
    // calls could all be deleted without a single assertion turning red.
    // sorted: 1.4, 2.6, 3.5 -> p50 index 1 (2.6 -> 3), p95 index 2 (3.5 -> 4,
    // half away from zero), max 3.5 -> 4.
    const result = percentiles([2.6, 1.4, 3.5]);
    expect(Number.isInteger(result?.p50)).toBe(true);
    expect(Number.isInteger(result?.p95)).toBe(true);
    expect(Number.isInteger(result?.max)).toBe(true);
    expect(result).toEqual({ p50: 3, p95: 4, max: 4 });
  });

  it('does not mutate the input array', () => {
    const input = [5, 3, 1, 4, 2];
    const copy = [...input];
    percentiles(input);
    expect(input).toEqual(copy);
  });

  it('a single value reports that value for every percentile', () => {
    expect(percentiles([42])).toEqual({ p50: 42, p95: 42, max: 42 });
  });

  it('p95 sits near the top of a large uniform run', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const result = percentiles(values);
    // Exact, not a bound: `>= 95` is satisfied by every plausible index rule
    // over this input, including the off-by-one one. floor(0.95*100)=95, so
    // the 96th sample; an index taken over `length - 1` would give 95.
    expect(result?.p95).toBe(96);
    expect(result?.max).toBe(100);
  });
});

describe('RollingHistogram', () => {
  it('reports percentiles over pushed values', () => {
    const hist = new RollingHistogram();
    for (const v of [1, 2, 3, 4, 5]) hist.push(v);
    expect(hist.percentiles()?.max).toBe(5);
    expect(hist.length).toBe(5);
  });

  it('evicts the OLDEST sample once past capacity', () => {
    const hist = new RollingHistogram(3);
    hist.push(1);
    hist.push(2);
    hist.push(3);
    hist.push(4); // evicts the 1
    expect(hist.length).toBe(3);
    expect(hist.percentiles()?.max).toBe(4);
    // The oldest sample (1) should no longer be able to depress the minimum
    // end of the distribution: with capacity 3 holding [2,3,4], p50 sits at 3.
    expect(hist.percentiles()?.p50).toBe(3);
  });

  it('defaults to METRIC_CAP', () => {
    const hist = new RollingHistogram();
    for (let i = 0; i < METRIC_CAP + 50; i++) hist.push(i);
    expect(hist.length).toBe(METRIC_CAP);
  });

  it('clear empties it', () => {
    const hist = new RollingHistogram();
    hist.push(1);
    hist.clear();
    expect(hist.length).toBe(0);
    // A cleared histogram has no data, which is not the same as data that
    // happened to be all zeros: see the empty-input case above.
    expect(hist.percentiles()).toBeNull();
  });
});

describe('Counters', () => {
  it('bump defaults to +1', () => {
    const c = new Counters();
    c.bump('drop');
    c.bump('drop');
    expect(c.get('drop')).toBe(2);
  });

  it('bump accepts an explicit amount', () => {
    const c = new Counters();
    c.bump('bytes', 512);
    expect(c.get('bytes')).toBe(512);
  });

  it('get returns 0 for a field never bumped', () => {
    const c = new Counters();
    expect(c.get('never-touched')).toBe(0);
  });

  it('flush returns current values and zeroes them (read-and-zero)', () => {
    const c = new Counters();
    c.bump('a', 3);
    c.bump('b', 7);
    expect(c.flush()).toEqual({ a: 3, b: 7 });
    expect(c.get('a')).toBe(0);
    expect(c.get('b')).toBe(0);
  });

  it('a field never bumped since the last flush does not appear in the next flush', () => {
    const c = new Counters();
    c.bump('a', 1);
    c.flush();
    c.bump('b', 1);
    expect(c.flush()).toEqual({ b: 1 });
  });

  it('an empty flush with nothing bumped returns an empty object', () => {
    const c = new Counters();
    expect(c.flush()).toEqual({});
  });
});
