// Proves the claim in src/core/redisLike.ts's module comment: "ioredis
// itself satisfies RedisLike structurally with zero adapter code ... a
// plain `new Redis(url)` already type-checks against this interface
// wherever tickroom asks for one." That claim has, until now, only ever
// been checked against src/server/testFakeRedis.ts, a hand-written object
// literal shaped to look like ioredis. A fake built to satisfy an interface
// proves nothing about whether the REAL library actually does; it only
// proves the person who wrote the fake read the interface correctly. This
// file drives a real `Redis` instance through every method RedisLike
// declares, against a real server.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import type { RedisLike } from '../src/core/index.js';
import { TEST_REDIS_URL, probeRedisAvailable, newNamespace, flushNamespace, skipReason } from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: redisLike] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

d('RedisLike / a real ioredis client, no adapter', () => {
  const namespace = newNamespace('redislike');
  let raw: Redis;
  let redis: RedisLike;

  beforeAll(() => {
    raw = new Redis(TEST_REDIS_URL);
    // THE ASSIGNMENT ITSELF IS THE FIRST ASSERTION. No `as unknown as
    // RedisLike` anywhere on this line. If ioredis's real type declarations
    // ever stopped satisfying RedisLike structurally (a method signature
    // narrowed, an overload removed), this file would fail to type-check
    // and `npx tsc --noEmit` would catch it, which is a stronger guarantee
    // than any runtime assertion below could give for the STRUCTURAL half
    // of the claim. The runtime calls that follow prove the other half:
    // that the methods do not just type-check, they actually work.
    redis = raw;
  });

  afterAll(async () => {
    await flushNamespace(TEST_REDIS_URL, namespace);
    raw.disconnect();
  });

  it('get/set round-trip a plain string', async () => {
    const key = `${namespace}:plain`;
    expect(await redis.get(key)).toBeNull();
    await redis.set(key, 'hello world');
    expect(await redis.get(key)).toBe('hello world');
  });

  it('set with EX sets a TTL, PX sets one in milliseconds, NX refuses to overwrite', async () => {
    const exKey = `${namespace}:ex`;
    await redis.set(exKey, 'v', 'EX', 30);
    expect(await raw.ttl(exKey)).toBeGreaterThan(0);
    expect(await raw.ttl(exKey)).toBeLessThanOrEqual(30);

    const pxKey = `${namespace}:px`;
    await redis.set(pxKey, 'v', 'PX', 30_000);
    const pttl = await raw.pttl(pxKey);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(30_000);

    const nxKey = `${namespace}:nx`;
    const first = await redis.set(nxKey, 'first', 'NX');
    expect(first).not.toBeNull(); // real ioredis: 'OK' on success
    const second = await redis.set(nxKey, 'second', 'NX');
    expect(second).toBeNull(); // real ioredis: null when NX refuses
    expect(await redis.get(nxKey)).toBe('first');
  });

  it('getBuffer returns raw bytes, not a lossy utf8-decoded string', async () => {
    const key = `${namespace}:bytes`;
    // Bytes that are NOT valid standalone UTF-8 on their own (a lone
    // continuation byte), the exact shape a gzip header can produce. A
    // `get` on this would silently mangle it via the replacement character;
    // `getBuffer` must hand back the identical bytes.
    const original = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x01]);
    await redis.set(key, original);
    const back = await redis.getBuffer(key);
    expect(back).not.toBeNull();
    expect(Buffer.compare(back as Buffer, original)).toBe(0);
  });

  it('del removes one or more keys and reports the count actually removed', async () => {
    await redis.set(`${namespace}:d1`, 'a');
    await redis.set(`${namespace}:d2`, 'b');
    const removed = await redis.del(`${namespace}:d1`, `${namespace}:d2`, `${namespace}:d-missing`);
    expect(removed).toBe(2);
    expect(await redis.get(`${namespace}:d1`)).toBeNull();
  });

  it('eval runs a Lua script with KEYS/ARGV, exactly what lease.ts depends on', async () => {
    const key = `${namespace}:eval`;
    await redis.set(key, 'owner-a');
    // The identical shape as lease.ts's RENEW_SCRIPT: compare-and-set.
    const script =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('set', KEYS[1], ARGV[2]) else return nil end";
    const wrongOwner = await redis.eval(script, 1, key, 'owner-b', 'owner-b-wrote-this');
    expect(wrongOwner).toBeNull();
    expect(await redis.get(key)).toBe('owner-a');
    const rightOwner = await redis.eval(script, 1, key, 'owner-a', 'owner-a-wrote-this');
    expect(rightOwner).not.toBeNull();
    expect(await redis.get(key)).toBe('owner-a-wrote-this');
  });

  it('publish reports the subscriber count it reached', async () => {
    const channel = `${namespace}:chan`;
    const sub = new Redis(TEST_REDIS_URL);
    try {
      await sub.subscribe(channel);
      // Give the subscribe a moment to actually register server-side before
      // publishing; PUBLISH's return value is exactly "how many subscribers
      // existed at this instant", so a race here would flake the assertion.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const delivered = await redis.publish(channel, 'hi');
      expect(delivered).toBe(1);
    } finally {
      sub.disconnect();
    }
  });

  it('expire sets a TTL on an existing key and reports 0 for a missing one', async () => {
    const key = `${namespace}:expire`;
    await redis.set(key, 'v');
    expect(await redis.expire(key, 60)) .toBe(1);
    expect(await raw.ttl(key)).toBeGreaterThan(0);
    expect(await redis.expire(`${namespace}:no-such-key`, 60)).toBe(0);
  });

  it('hset/hgetall/hdel round-trip a hash', async () => {
    const key = `${namespace}:hash`;
    await redis.hset(key, 'a', '1');
    await redis.hset(key, 'b', '2');
    expect(await redis.hgetall(key)).toEqual({ a: '1', b: '2' });
    expect(await redis.hdel(key, 'a')).toBe(1);
    expect(await redis.hgetall(key)).toEqual({ b: '2' });
  });

  it('mget reads several keys in one call, nulling out missing ones', async () => {
    await redis.set(`${namespace}:m1`, 'one');
    await redis.set(`${namespace}:m2`, 'two');
    const values = await redis.mget(`${namespace}:m1`, `${namespace}:m-missing`, `${namespace}:m2`);
    expect(values).toEqual(['one', null, 'two']);
  });

  it('zadd/zrem/zcard/zremrangebyscore manage a sorted set, the shape the connection cap uses', async () => {
    const key = `${namespace}:zset`;
    await redis.zadd(key, 100, 'conn-a');
    await redis.zadd(key, 200, 'conn-b');
    await redis.zadd(key, 300, 'conn-c');
    expect(await redis.zcard(key)).toBe(3);
    // Prunes everything scored below 250, the exact shape checkAdmission
    // uses to age out a stale connection registration.
    const pruned = await redis.zremrangebyscore(key, '-inf', 250);
    expect(pruned).toBe(2);
    expect(await redis.zcard(key)).toBe(1);
    expect(await redis.zrem(key, 'conn-c')).toBe(1);
    expect(await redis.zcard(key)).toBe(0);
  });

  it('incrby and hincrby do real atomic increments', async () => {
    const key = `${namespace}:incr`;
    expect(await redis.incrby(key, 5)).toBe(5);
    expect(await redis.incrby(key, 3)).toBe(8);

    const hkey = `${namespace}:hincr`;
    expect(await redis.hincrby(hkey, 'score', 10)).toBe(10);
    expect(await redis.hincrby(hkey, 'score', -4)).toBe(6);
  });

  it('pipeline batches several commands into one round trip and returns per-command [error, result] pairs', async () => {
    await redis.set(`${namespace}:p1`, 'x');
    const pipe = redis.pipeline();
    pipe.get(`${namespace}:p1`);
    pipe.get(`${namespace}:p-missing`);
    pipe.incrby(`${namespace}:p-counter`, 7);
    // This is exactly the shape src/server/relay.ts's checkAdmission reads:
    // `Array<[Error | null, unknown]>`.
    const results = (await pipe.exec()) as Array<[Error | null, unknown]>;
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual([null, 'x']);
    expect(results[1]).toEqual([null, null]);
    expect(results[2]).toEqual([null, 7]);
  });
});
