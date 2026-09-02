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

  it('THE CONTRAST: the same failing renews against a COLLAPSED clock keep mayPublish true', () => {
    // Why the two-clock split matters, rather than just asserting the fixed
    // behaviour in isolation. This used to be four lines of `naiveClock = now`
    // and a hand-written `now - naiveClock < LEASE_TTL_MS`, which touched
    // nothing from `lease.ts` at all: no possible change to the module could
    // have failed it, so it read as coverage of the most safety-critical rule
    // in the library while pinning nothing. It is now driven through the real
    // functions, because the naive model IS reachable through them: the
    // historical bug was one timestamp refreshed on every ATTEMPT, which is
    // exactly what recording a renew that actually failed as `renewConfirmed`
    // does to this clock.
    //
    // Both clocks below see the identical schedule of attempts and the
    // identical string of failures. The only difference is whether a failure
    // is allowed to refresh confirmed ownership.
    let correct = createOwnershipClock(0);
    let collapsed = createOwnershipClock(0);
    let now = 0;
    const renewIntervalMs = 1500;
    const totalMs = LEASE_TTL_MS + 3000;
    for (now = renewIntervalMs; now <= totalMs; now += renewIntervalMs) {
      correct = renewFailed(renewAttempted(correct, now));
      collapsed = renewConfirmed(renewAttempted(collapsed, now), now); // the bug
    }
    expect(mayPublish(collapsed, now)).toBe(true); // the defect, reproduced for contrast
    expect(mayPublish(correct, now)).toBe(false); // and what the split buys
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

describe('TR-10: acquire/renew require the literal OK reply, a split-brain guard must fail closed', () => {
  // A permissive check (`!== null && !== undefined`) would treat any of these
  // as "we hold the lease". A real ioredis `SET ... NX` and the renew Lua
  // never actually produce them, but a mock, a proxy, or a future
  // Redis-compatible backend might, and the failure direction matters here
  // more than anywhere else in the library: a false positive means two
  // authoritative tickers publishing interleaved snapshots onto one channel.
  class PermissiveReplyRedis implements Partial<RedisLike> {
    constructor(private reply: unknown) {}
    async set(): Promise<unknown> {
      return this.reply;
    }
    async eval(): Promise<unknown> {
      return this.reply;
    }
    async get(): Promise<string | null> {
      return null;
    }
    async del(): Promise<number> {
      return 0;
    }
  }

  function fakeWithReply(reply: unknown): RedisLike {
    return new PermissiveReplyRedis(reply) as unknown as RedisLike;
  }

  it.each([0, '', false, 'ok', 'Ok'])(
    'acquireLease rejects a non-OK truthy-ish reply: %j',
    async (reply) => {
      const redis = fakeWithReply(reply);
      expect(await acquireLease(redis, 'lease:x', 'owner-a')).toBe(false);
    }
  );

  it.each([0, '', false, 'ok', 'Ok'])(
    'renewLease rejects a non-OK truthy-ish reply: %j',
    async (reply) => {
      const redis = fakeWithReply(reply);
      expect(await renewLease(redis, 'lease:x', 'owner-a')).toBe(false);
    }
  );

  it('acquireLease and renewLease still accept the real reply, OK', async () => {
    const redis = fakeWithReply('OK');
    expect(await acquireLease(redis, 'lease:x', 'owner-a')).toBe(true);
    expect(await renewLease(redis, 'lease:x', 'owner-a')).toBe(true);
  });
});

describe('TR-10b: renewConfirmed must not stretch the renew period for an asynchronous renew', () => {
  it('default (no opts): re-anchors lastRenewAt to the confirmation time, unchanged from before this fix', () => {
    // This is deliberately the OLD behaviour, pinned so a future edit cannot
    // silently flip the default: a caller that does not opt in must see
    // exactly what it saw before TR-10b landed.
    let clock = createOwnershipClock(0);
    clock = renewAttempted(clock, 0);
    const confirmedAt = 400; // simulates a 400ms round trip
    clock = renewConfirmed(clock, confirmedAt);
    expect(clock.lastRenewAt).toBe(confirmedAt);
    expect(clock.lastOwnedAt).toBe(confirmedAt);
  });

  it('preserveAttemptTime: true keeps lastRenewAt at the attempt time, not the later confirmation time', () => {
    let clock = createOwnershipClock(0);
    const attemptAt = 0;
    clock = renewAttempted(clock, attemptAt);
    const confirmedAt = 400; // the same 400ms round trip as above
    clock = renewConfirmed(clock, confirmedAt, { preserveAttemptTime: true });
    // lastOwnedAt still moves to the real confirmation instant: only the
    // PACING clock is preserved, never the ownership clock.
    expect(clock.lastOwnedAt).toBe(confirmedAt);
    expect(clock.lastRenewAt).toBe(attemptAt);
  });

  it('MUTATION CHECK, THE REGRESSION THIS FIX EXISTS FOR: an asynchronous renew loop under repeated RTT delay drifts the next-attempt schedule by one RTT per cycle with the default, and stays paced from the attempt with preserveAttemptTime', () => {
    // Models the exact pattern server/ticker.ts uses: renewAttempted() is
    // called synchronously at the moment the network call STARTS; the
    // matching renewConfirmed() only runs once that call's promise resolves,
    // one RTT later. Sweep several renew cycles and read where the NEXT
    // attempt becomes due under each policy.
    const renewIntervalMs = 1500;
    const rttMs = 300;
    const cycles = 5;

    // DEFAULT policy (today's unchanged behaviour): each cycle's attempt
    // fires renewIntervalMs after the PREVIOUS cycle's CONFIRMATION, so the
    // gap between successive attempt starts is renewIntervalMs + rttMs.
    {
      let clock = createOwnershipClock(0);
      let attemptAt = 0;
      const attemptTimestamps: number[] = [attemptAt];
      for (let i = 0; i < cycles; i++) {
        clock = renewAttempted(clock, attemptAt);
        const confirmedAt = attemptAt + rttMs;
        clock = renewConfirmed(clock, confirmedAt); // no opts: the default
        // advance a probing clock until renewDue fires again
        let probe = confirmedAt;
        while (!renewDue(clock, probe, renewIntervalMs)) probe += 1;
        attemptAt = probe;
        attemptTimestamps.push(attemptAt);
      }
      for (let i = 1; i < attemptTimestamps.length; i++) {
        const gap = attemptTimestamps[i] - attemptTimestamps[i - 1];
        // The defect: every cycle's attempt-to-attempt gap is stretched by
        // one full RTT beyond the configured interval.
        expect(gap).toBe(renewIntervalMs + rttMs);
      }
    }

    // preserveAttemptTime policy: the gap between successive attempt starts
    // stays exactly renewIntervalMs, regardless of RTT, because lastRenewAt
    // never moves off the attempt instant.
    {
      let clock = createOwnershipClock(0);
      let attemptAt = 0;
      const attemptTimestamps: number[] = [attemptAt];
      for (let i = 0; i < cycles; i++) {
        clock = renewAttempted(clock, attemptAt);
        const confirmedAt = attemptAt + rttMs;
        clock = renewConfirmed(clock, confirmedAt, { preserveAttemptTime: true });
        let probe = confirmedAt;
        while (!renewDue(clock, probe, renewIntervalMs)) probe += 1;
        attemptAt = probe;
        attemptTimestamps.push(attemptAt);
      }
      for (let i = 1; i < attemptTimestamps.length; i++) {
        const gap = attemptTimestamps[i] - attemptTimestamps[i - 1];
        expect(gap).toBe(renewIntervalMs);
      }
    }
  });

  it('the two-clock rule survives the option: renewFailed still returns the clock unchanged either way', () => {
    let clock = createOwnershipClock(0);
    clock = renewAttempted(clock, 1000);
    const failed = renewFailed(clock);
    expect(failed).toEqual(clock);
    expect(failed.lastOwnedAt).toBe(0); // still unmoved
  });
});
