import { describe, expect, it } from 'vitest';
import {
  acquireLease,
  createOwnershipClock,
  EMPTY_GRACE_MS,
  LEASE_TTL_MS,
  MAX_TICKER_MS,
  mayPublish,
  releaseLease,
  renewAttempted,
  renewConfirmed,
  renewDue,
  renewFailed,
  renewLease,
  shouldSpawnTicker,
  tickerShouldExit,
} from './lease.js';
import type { RedisLike } from './redisLike.js';

/** Minimal in-memory RedisLike, just enough for the lease scripts. */
class FakeRedis implements Partial<RedisLike> {
  private store = new Map<string, string>();

  async set(key: string, value: string | Buffer, ...args: unknown[]): Promise<unknown> {
    const nx = args.includes('NX');
    if (nx && this.store.has(key)) return null;
    this.store.set(key, String(value));
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return n;
  }

  // Interprets the two Lua scripts this module actually uses, so the fake
  // stays a faithful stand-in for "compare owner, then act" without
  // depending on a real Lua interpreter.
  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const [key, owner, ttl] = args as [string, string, number | undefined];
    const current = this.store.get(key as string);
    if (script.includes('redis.call(\'set\'')) {
      if (current !== owner) return null;
      this.store.set(key as string, owner);
      void ttl;
      return 'OK';
    }
    if (script.includes('redis.call(\'del\'')) {
      if (current !== owner) return 0;
      this.store.delete(key as string);
      return 1;
    }
    throw new Error('unrecognised script in FakeRedis');
  }
}

function fakeRedis(): RedisLike {
  return new FakeRedis() as unknown as RedisLike;
}

describe('shouldSpawnTicker', () => {
  it('spawns only when the lease value is null', () => {
    expect(shouldSpawnTicker(null)).toBe(true);
    expect(shouldSpawnTicker('some-owner')).toBe(false);
  });
});

describe('tickerShouldExit', () => {
  it('exits past maxTickerMs regardless of room population', () => {
    const exited = tickerShouldExit({ now: MAX_TICKER_MS + 1, startedAt: 0, emptySince: null });
    expect(exited).toBe(true);
  });

  it('does not exit before maxTickerMs with players present', () => {
    const exited = tickerShouldExit({ now: MAX_TICKER_MS - 1, startedAt: 0, emptySince: null });
    expect(exited).toBe(false);
  });

  it('exits past emptyGraceMs once the room has been empty that long', () => {
    const exited = tickerShouldExit({ now: EMPTY_GRACE_MS + 1, startedAt: 0, emptySince: 0 });
    expect(exited).toBe(true);
  });

  it('does not exit while emptySince is null (players present), even long after the empty grace window would have elapsed', () => {
    // startedAt tracks `now` here so this case isolates the emptySince axis
    // from the separate maxTickerMs axis covered above.
    const now = EMPTY_GRACE_MS * 10;
    const exited = tickerShouldExit({ now, startedAt: now, emptySince: null });
    expect(exited).toBe(false);
  });

  it('respects overridden config', () => {
    const exited = tickerShouldExit(
      { now: 1000, startedAt: 0, emptySince: null },
      { maxTickerMs: 500 }
    );
    expect(exited).toBe(true);
  });
});

describe('the two-clock rule', () => {
  it('renewAttempted moves only lastRenewAt', () => {
    const clock = createOwnershipClock(0);
    const after = renewAttempted(clock, 1000);
    expect(after.lastRenewAt).toBe(1000);
    expect(after.lastOwnedAt).toBe(0); // unchanged: an attempt is not a confirmation
  });

  it('renewConfirmed moves both clocks to now', () => {
    const clock = createOwnershipClock(0);
    const attempted = renewAttempted(clock, 1000);
    const confirmed = renewConfirmed(attempted, 1000);
    expect(confirmed.lastRenewAt).toBe(1000);
    expect(confirmed.lastOwnedAt).toBe(1000);
  });

  it('renewFailed leaves the clock completely unchanged', () => {
    const clock = createOwnershipClock(0);
    const attempted = renewAttempted(clock, 1000);
    const failed = renewFailed(attempted);
    expect(failed).toEqual(attempted);
    expect(failed.lastOwnedAt).toBe(0);
  });

  it('THE REGRESSION CASE: a string of failed renews must make mayPublish go false within the TTL, even though attempts keep happening on schedule', () => {
    // This is the exact bug that shipped twice in the source project: a
    // single collapsed timestamp refreshed on every ATTEMPT (successful or
    // not) means the "am I still safe to publish" guard can never fire while
    // a ticker is attempting renews on schedule, even if every single one of
    // those renews is actually failing.
    let clock = createOwnershipClock(0);
    let now = 0;
    // Ticker attempts a renew every LEASE_RENEW_MS, and it keeps failing
    // (a competitor already holds the lease, or the network is down), well
    // past LEASE_TTL_MS.
    const renewIntervalMs = 1500;
    const totalMs = LEASE_TTL_MS + 3000;
    for (now = renewIntervalMs; now <= totalMs; now += renewIntervalMs) {
      clock = renewAttempted(clock, now);
      // renew fails:
      clock = renewFailed(clock);
    }
    expect(mayPublish(clock, now)).toBe(false);
  });

  it('control: the same string of ATTEMPTS, but each one CONFIRMED, keeps mayPublish true forever', () => {
    let clock = createOwnershipClock(0);
    let now = 0;
    const renewIntervalMs = 1500;
    const totalMs = LEASE_TTL_MS + 30_000;
    for (now = renewIntervalMs; now <= totalMs; now += renewIntervalMs) {
      clock = renewAttempted(clock, now);
      clock = renewConfirmed(clock, now);
    }
    expect(mayPublish(clock, now)).toBe(true);
  });

  it('a naive single-clock model (for contrast) WOULD incorrectly stay "safe" under the regression case', () => {
    // Demonstrates why the two-clock split matters, rather than just
    // asserting the fixed behaviour in isolation: a single timestamp
    // refreshed on every attempt regardless of outcome never ages past the
    // TTL as long as attempts keep happening on schedule.
    let naiveClock = 0;
    let now = 0;
    const renewIntervalMs = 1500;
    const totalMs = LEASE_TTL_MS + 3000;
    for (now = renewIntervalMs; now <= totalMs; now += renewIntervalMs) {
      naiveClock = now; // the bug: refreshed on attempt, not confirmation
    }
    const naiveMayPublish = now - naiveClock < LEASE_TTL_MS;
    expect(naiveMayPublish).toBe(true); // the defect, reproduced for contrast
  });

  it('renewDue paces off lastRenewAt independent of confirmation', () => {
    const clock = createOwnershipClock(0);
    expect(renewDue(clock, 1000)).toBe(false); // under LEASE_RENEW_MS
    expect(renewDue(clock, 2000)).toBe(true); // past it
  });
});

describe('acquireLease / renewLease / releaseLease against a fake Redis', () => {
  it('acquires only when nobody holds the key (NX)', async () => {
    const redis = fakeRedis();
    expect(await acquireLease(redis, 'lease:x', 'owner-a')).toBe(true);
    expect(await acquireLease(redis, 'lease:x', 'owner-b')).toBe(false);
  });

  it('renews only for the current owner', async () => {
    const redis = fakeRedis();
    await acquireLease(redis, 'lease:x', 'owner-a');
    expect(await renewLease(redis, 'lease:x', 'owner-a')).toBe(true);
    expect(await renewLease(redis, 'lease:x', 'owner-b')).toBe(false);
  });

  it('a renew cannot resurrect a lease a competitor has already taken', async () => {
    const redis = fakeRedis();
    await acquireLease(redis, 'lease:x', 'owner-a');
    await releaseLease(redis, 'lease:x', 'owner-a');
    await acquireLease(redis, 'lease:x', 'owner-b');
    expect(await renewLease(redis, 'lease:x', 'owner-a')).toBe(false);
    // owner-b's lease must be untouched
    expect(await renewLease(redis, 'lease:x', 'owner-b')).toBe(true);
  });

  it('release only for the current owner: a de-owned ticker cannot delete a successor lease', async () => {
    const redis = fakeRedis();
    await acquireLease(redis, 'lease:x', 'owner-a');
    await releaseLease(redis, 'lease:x', 'owner-a');
    await acquireLease(redis, 'lease:x', 'owner-b');
    await releaseLease(redis, 'lease:x', 'owner-a'); // stale owner, must no-op
    expect(await acquireLease(redis, 'lease:x', 'owner-c')).toBe(false); // owner-b still holds it
  });
});
