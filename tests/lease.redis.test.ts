// Proves the lease (src/core/lease.ts) under GENUINE concurrency. The unit
// tests in src/core/lease.test.ts drive the pure clock functions and a fake
// Redis, both single-threaded by construction, so they cannot demonstrate a
// real race: N callers actually contending for one SET NX at the same
// instant, a Lua script's atomicity holding under real network round trips,
// or a TTL actually expiring on the server's own clock rather than a fake's
// simulated one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { RedisLike } from '../src/core/index.js';
import { acquireLease, renewLease, releaseLease } from '../src/core/index.js';
import { TEST_REDIS_URL, probeRedisAvailable, newNamespace, flushNamespace, skipReason, waitFor } from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: lease] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

d('lease / real Redis concurrency', () => {
  const namespace = newNamespace('lease');
  let raw: Redis;
  let redis: RedisLike;

  beforeAll(() => {
    raw = new Redis(TEST_REDIS_URL);
    redis = raw;
  });

  afterAll(async () => {
    await flushNamespace(TEST_REDIS_URL, namespace);
    raw.disconnect();
  });

  it('exactly one of N concurrent acquirers wins the lease', async () => {
    const leaseKey = `${namespace}:contended`;
    const owners = Array.from({ length: 20 }, () => randomUUID());

    // Fired with Promise.all, not sequentially: the whole point is that
    // these SET NX calls are genuinely in flight on the wire at the same
    // time, which only a real network round trip (not a fake's synchronous
    // Map access) can actually produce.
    const results = await Promise.all(owners.map((owner) => acquireLease(redis, leaseKey, owner, { leaseTtlMs: 5000 })));

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);

    const winningOwner = owners[results.indexOf(true)];
    expect(await redis.get(leaseKey)).toBe(winningOwner);
  });

  it('renewLease succeeds for the holder and fails for a non-holder (the Lua owner check)', async () => {
    const leaseKey = `${namespace}:renew`;
    const holder = randomUUID();
    const impostor = randomUUID();

    expect(await acquireLease(redis, leaseKey, holder, { leaseTtlMs: 5000 })).toBe(true);

    const impostorRenew = await renewLease(redis, leaseKey, impostor, { leaseTtlMs: 5000 });
    expect(impostorRenew).toBe(false);
    // A failed renew by an impostor must not have touched the value or its TTL ownership.
    expect(await redis.get(leaseKey)).toBe(holder);

    const holderRenew = await renewLease(redis, leaseKey, holder, { leaseTtlMs: 8000 });
    expect(holderRenew).toBe(true);
    const ttlAfterRenew = await raw.pttl(leaseKey);
    // The renew's ttl argument (8000ms) should now be in force, not the original 5000ms.
    expect(ttlAfterRenew).toBeGreaterThan(5000);
    expect(ttlAfterRenew).toBeLessThanOrEqual(8000);
  });

  it('releaseLease by a non-holder does not delete the key (the other Lua owner check)', async () => {
    const leaseKey = `${namespace}:release`;
    const holder = randomUUID();
    const impostor = randomUUID();
    expect(await acquireLease(redis, leaseKey, holder, { leaseTtlMs: 5000 })).toBe(true);

    await releaseLease(redis, leaseKey, impostor);
    // Still there: an impostor's release must be a no-op, exactly like the
    // real-world case this guards, a ticker that already lost its lease
    // trying to clean up on the way out must never delete a successor's key.
    expect(await redis.get(leaseKey)).toBe(holder);

    await releaseLease(redis, leaseKey, holder);
    expect(await redis.get(leaseKey)).toBeNull();
  });

  it('the lease actually expires on the server clock, and a different owner can then acquire it', async () => {
    const leaseKey = `${namespace}:expiry`;
    const firstOwner = randomUUID();
    const secondOwner = randomUUID();

    // A short real TTL: this test genuinely waits it out rather than faking
    // a clock, which is exactly the thing an in-memory fake cannot prove.
    const ttlMs = 700;
    expect(await acquireLease(redis, leaseKey, firstOwner, { leaseTtlMs: ttlMs })).toBe(true);

    // Immediately after acquiring, a second owner must be refused: the key
    // genuinely exists on the server.
    expect(await acquireLease(redis, leaseKey, secondOwner, { leaseTtlMs: ttlMs })).toBe(false);

    const expired = await waitFor(async () => (await redis.get(leaseKey)) === null, ttlMs + 2000, 50);
    expect(expired).toBe(true);

    expect(await acquireLease(redis, leaseKey, secondOwner, { leaseTtlMs: ttlMs })).toBe(true);
    expect(await redis.get(leaseKey)).toBe(secondOwner);
  }, 10_000);
});
