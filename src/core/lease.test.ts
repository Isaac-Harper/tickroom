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
  type OwnershipClock,
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

  // ONE FUNCTION PER CLOCK, and this case has to confirm at a DIFFERENT time
  // than it attempted or it proves nothing. It used to attempt and confirm at
  // the same `now`, so `lastRenewAt` was already the expected value before
  // `renewConfirmed` was called at all: a version that re-anchored the pacing
  // clock passed it unchanged. That is the exact regression this pins, and it
  // is not hypothetical, it is the hole that let renews overlap until the
  // schedule opened a gap wider than the lease TTL.
  it('renewConfirmed moves ONLY lastOwnedAt, leaving the pacing clock where the attempt put it', () => {
    const clock = createOwnershipClock(0);
    const attempted = renewAttempted(clock, 1000);
    const confirmed = renewConfirmed(attempted, 1500);
    expect(confirmed.lastRenewAt).toBe(1000);
    expect(confirmed.lastOwnedAt).toBe(1500);
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

describe('TR-10b: renewConfirmed paces from the ATTEMPT, never from the confirmation', () => {
  it('moves ONLY lastOwnedAt, leaving the pacing clock exactly where renewAttempted put it', () => {
    let clock = createOwnershipClock(0);
    const attemptAt = 0;
    clock = renewAttempted(clock, attemptAt);
    const confirmedAt = 400; // a 400ms round trip
    clock = renewConfirmed(clock, confirmedAt);
    // The OWNERSHIP clock moves to the real confirmation instant, because
    // that is when Redis actually said yes. The PACING clock does not move
    // at all: one function per clock, see the module comment.
    expect(clock.lastOwnedAt).toBe(confirmedAt);
    expect(clock.lastRenewAt).toBe(attemptAt);
  });

  // THE SPLIT BRAIN THIS PREVENTS, MODELLED END TO END RATHER THAN ASSERTED.
  //
  // The unit case above cannot fail on anything that matters: re-anchoring
  // `lastRenewAt` to the confirmation time looks like an off-by-one-round-trip
  // and reads as harmless. It is not. Once RTT exceeds `renewMs` the attempts
  // overlap, several in-flight renews resolve back to back, and each
  // resolution drags the pacing clock forward again, so the NEXT attempt is
  // due `renewMs` after the LAST of them and nothing reaches Redis for up to
  // `RTT + renewMs`. The key's own TTL lapses inside that hole, a successor
  // legitimately acquires it, and `mayPublish` keeps saying yes because
  // `lastOwnedAt` was confirmed recently: two authoritative tickers on one
  // channel, reached without either clock ever being collapsed.
  //
  // So the simulation below runs the real `server/ticker.ts` renew pattern
  // against a modelled Redis (a renew reaches the server at half RTT and
  // replies at full RTT; an arriving renew extends the key only if the key is
  // still there) and measures what the loop would actually do.
  interface RenewSim {
    /** Every wall-clock instant at which a renew was issued. */
    attempts: number[];
    /** The widest hole between two consecutive attempts. */
    maxAttemptGapMs: number;
    /** When the modelled Redis key expired, or null if it never did. */
    leaseLapsedAtMs: number | null;
    /** How long this ticker would have gone on publishing after that. */
    splitBrainMs: number;
  }

  const GRID_MS = 50; // the 20Hz tick grid runTicker schedules on

  function simulateAsyncRenewLoop(opts: {
    confirm(clock: OwnershipClock, now: number): OwnershipClock;
    rttMs: number;
    renewMs: number;
    ttlMs: number;
    runMs: number;
  }): RenewSim {
    const { confirm, rttMs, renewMs, ttlMs, runMs } = opts;
    let clock = createOwnershipClock(0);
    // The modelled Redis side: when the key would expire if nothing renews it.
    let leaseExpiresAt = ttlMs;
    let leaseLapsedAtMs: number | null = null;
    let splitBrainMs = 0;
    const attempts: number[] = [];
    const inFlight: Array<{ redisAt: number; resolveAt: number; arrived: boolean }> = [];

    for (let now = 0; now <= runMs; now += GRID_MS) {
      // a renew that has reached the server extends the key, but only if the
      // key is still ours to extend: past the TTL a successor holds it and
      // the owner-checked script replies false instead.
      for (const r of inFlight) {
        if (!r.arrived && r.redisAt <= now) {
          r.arrived = true;
          if (r.redisAt < leaseExpiresAt) leaseExpiresAt = r.redisAt + ttlMs;
        }
      }
      // replies land, in issue order, and confirm ownership as of their own
      // arrival instant
      while (inFlight.length > 0 && (inFlight[0] as { resolveAt: number }).resolveAt <= now) {
        const done = inFlight.shift() as { redisAt: number; resolveAt: number };
        if (done.redisAt < leaseExpiresAt || leaseLapsedAtMs === null) {
          clock = confirm(clock, done.resolveAt);
        }
      }
      if (leaseLapsedAtMs === null && now >= leaseExpiresAt) leaseLapsedAtMs = now;
      // publishing past the moment the key lapsed is the split brain
      if (leaseLapsedAtMs !== null && mayPublish(clock, now, ttlMs)) splitBrainMs += GRID_MS;

      if (renewDue(clock, now, renewMs)) {
        clock = renewAttempted(clock, now);
        attempts.push(now);
        inFlight.push({ redisAt: now + rttMs / 2, resolveAt: now + rttMs, arrived: false });
      }
    }

    let maxAttemptGapMs = 0;
    for (let i = 1; i < attempts.length; i++) {
      maxAttemptGapMs = Math.max(maxAttemptGapMs, (attempts[i] as number) - (attempts[i - 1] as number));
    }
    return { attempts, maxAttemptGapMs, leaseLapsedAtMs, splitBrainMs };
  }

  /** The pre-fix body of `renewConfirmed`, kept only so the contrast below is measured rather than described. */
  const reAnchorPacingClock = (clock: OwnershipClock, now: number): OwnershipClock => ({
    lastRenewAt: now,
    lastOwnedAt: now,
  });

  it('THE REGRESSION CASE: re-anchoring the pacing clock opens a hole in the renew schedule that loses the lease while mayPublish still says yes', () => {
    const profile = { rttMs: 4000, renewMs: 1500, ttlMs: 5000, runMs: 20_000 };

    const broken = simulateAsyncRenewLoop({ ...profile, confirm: reAnchorPacingClock });
    // Attempts at 1500, 3000 and 4500, then nothing until 10000: a 5500ms
    // hole, one RTT plus one renew interval.
    expect(broken.attempts.slice(0, 4)).toEqual([1500, 3000, 4500, 10_000]);
    expect(broken.maxAttemptGapMs).toBe(profile.rttMs + profile.renewMs);
    // The key lapses inside that hole and this ticker publishes on past it.
    expect(broken.leaseLapsedAtMs).toBe(11_500);
    expect(broken.splitBrainMs).toBe(2000);

    const fixed = simulateAsyncRenewLoop({ ...profile, confirm: renewConfirmed });
    // Paced from the attempt, a renew leaves every renewMs no matter what the
    // round trip is doing, so Redis keeps extending the key on that cadence.
    expect(fixed.maxAttemptGapMs).toBe(profile.renewMs);
    expect(fixed.leaseLapsedAtMs).toBeNull();
    expect(fixed.splitBrainMs).toBe(0);
  });

  it('the ordinary cost, on an RTT far too small to open a hole: the renew period is stretched by exactly one round trip', () => {
    // The everyday shape of the same defect. It loses no lease at 300ms of
    // RTT, it just quietly spends the margin `leaseRenewMs` was chosen to
    // buy: a period of renewMs + rtt halves how much of `leaseTtlMs` is left
    // to absorb a single missed attempt.
    const profile = { rttMs: 300, renewMs: 1500, ttlMs: 5000, runMs: 20_000 };
    expect(simulateAsyncRenewLoop({ ...profile, confirm: reAnchorPacingClock }).maxAttemptGapMs).toBe(1800);
    expect(simulateAsyncRenewLoop({ ...profile, confirm: renewConfirmed }).maxAttemptGapMs).toBe(1500);
  });

  it('the two-clock rule survives the change: renewFailed still returns the clock unchanged', () => {
    let clock = createOwnershipClock(0);
    clock = renewAttempted(clock, 1000);
    const failed = renewFailed(clock);
    expect(failed).toEqual(clock);
    expect(failed.lastOwnedAt).toBe(0); // still unmoved
  });
});
