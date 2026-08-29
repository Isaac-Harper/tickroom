import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rateLimit.js';

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('TokenBucket', () => {
  it('starts full at capacity', () => {
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 5 });
    expect(bucket.tokens).toBe(10);
  });

  it('take() spends tokens and returns true while enough are available', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 0 });
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.tokens).toBe(0);
  });

  it('take() returns false and spends nothing once exhausted', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0 });
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    expect(bucket.tokens).toBe(0);
  });

  it('take(n) spends n at once, atomically (all or nothing)', () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 0 });
    expect(bucket.take(6)).toBe(false);
    expect(bucket.tokens).toBe(5); // nothing spent on failure
    expect(bucket.take(5)).toBe(true);
    expect(bucket.tokens).toBe(0);
  });

  it('refills over time at refillPerSecond, capped at capacity', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 5, now: clock.now });
    bucket.take(10);
    expect(bucket.tokens).toBe(0);
    clock.advance(1000); // 1s at 5/s -> +5
    expect(bucket.tokens).toBe(5);
    clock.advance(2000); // another 2s at 5/s -> +10, capped at 10
    expect(bucket.tokens).toBe(10);
  });

  it('supports fractional-second refills', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 100, refillPerSecond: 25, now: clock.now });
    bucket.take(100);
    clock.advance(500); // 0.5s at 25/s -> +12.5
    expect(bucket.tokens).toBeCloseTo(12.5);
  });

  it('models the shipped socket default: burst tolerance with a sustained cap', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 40, refillPerSecond: 25, now: clock.now });
    // A legitimate 20Hz sender spends 1 token per 50ms; it should never run dry.
    for (let i = 0; i < 200; i++) {
      expect(bucket.take()).toBe(true);
      clock.advance(50);
    }
  });

  it('a burst well past the sustained rate is throttled down once the initial capacity is spent', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 40, refillPerSecond: 25, now: clock.now });
    let admitted = 0;
    // 500 messages in the same instant: only the initial burst capacity gets through.
    for (let i = 0; i < 500; i++) {
      if (bucket.take()) admitted += 1;
    }
    expect(admitted).toBe(40);
  });
});
