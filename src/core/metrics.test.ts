import { describe, expect, it } from 'vitest';
import { Counters, METRIC_CAP, percentiles, RollingHistogram } from './metrics.js';

describe('percentiles', () => {
  it('returns all zeros for an empty input', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, max: 0 });
  });

  it('computes max correctly', () => {
    expect(percentiles([3, 1, 4, 1, 5, 9, 2, 6]).max).toBe(9);
  });

  it('computes p50 for an odd-length sorted set', () => {
    // sorted: 1,2,3,4,5 -> floor(0.5*5)=2 -> index 2 -> value 3
    expect(percentiles([5, 3, 1, 4, 2]).p50).toBe(3);
  });

  it('rounds to integers', () => {
    const result = percentiles([1, 2]);
    expect(Number.isInteger(result.p50)).toBe(true);
    expect(Number.isInteger(result.p95)).toBe(true);
    expect(Number.isInteger(result.max)).toBe(true);
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
    expect(result.p95).toBeGreaterThanOrEqual(95);
    expect(result.max).toBe(100);
  });
});

describe('RollingHistogram', () => {
  it('reports percentiles over pushed values', () => {
    const hist = new RollingHistogram();
    for (const v of [1, 2, 3, 4, 5]) hist.push(v);
    expect(hist.percentiles().max).toBe(5);
    expect(hist.length).toBe(5);
  });

  it('evicts the OLDEST sample once past capacity', () => {
    const hist = new RollingHistogram(3);
    hist.push(1);
    hist.push(2);
    hist.push(3);
    hist.push(4); // evicts the 1
    expect(hist.length).toBe(3);
    expect(hist.percentiles().max).toBe(4);
    // The oldest sample (1) should no longer be able to depress the minimum
    // end of the distribution: with capacity 3 holding [2,3,4], p50 sits at 3.
    expect(hist.percentiles().p50).toBe(3);
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
    expect(hist.percentiles()).toEqual({ p50: 0, p95: 0, max: 0 });
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
