// TR-12: `RedisFactoryOptions.redisOptions` must actually reach the ioredis
// client, and the two factories must default to OPPOSITE retry policies
// (see the module comment in redis.ts for why). Every client built here uses
// `lazyConnect: true` so the test never actually dials a socket: what is
// under test is the OPTIONS OBJECT ioredis was constructed with, read back
// off the live client's own `.options`, not whether a real Redis answers.
import { afterEach, describe, expect, it } from 'vitest';
import { createSubscriber, getRedis, resetRedisForTests } from './redis.js';

const url = 'redis://localhost:1'; // never dialed, thanks to lazyConnect

afterEach(() => {
  resetRedisForTests();
});

describe('TR-12: RedisFactoryOptions passes client options through', () => {
  it('getRedis defaults to maxRetriesPerRequest: 3 for the shared command client', () => {
    const redis = getRedis({ url, redisOptions: { lazyConnect: true } });
    const options = (redis as unknown as { options: Record<string, unknown> }).options;
    expect(options.maxRetriesPerRequest).toBe(3);
  });

  it('createSubscriber defaults to maxRetriesPerRequest: null, the OPPOSITE of getRedis', () => {
    const sub = createSubscriber({ url, redisOptions: { lazyConnect: true } });
    const options = (sub as unknown as { options: Record<string, unknown> }).options;
    expect(options.maxRetriesPerRequest).toBeNull();
    sub.disconnect();
  });

  it('a caller-supplied redisOptions is MERGED on top of the default, not a full replacement: an unrelated field survives alongside the default retry policy', () => {
    const redis = getRedis({ url, redisOptions: { lazyConnect: true, connectionName: 'my-app' } });
    const options = (redis as unknown as { options: Record<string, unknown> }).options;
    expect(options.maxRetriesPerRequest).toBe(3); // default preserved
    expect(options.connectionName).toBe('my-app'); // caller's own field also present
  });

  it('a caller can still override maxRetriesPerRequest explicitly: their value wins over the default', () => {
    const redis = getRedis({ url, redisOptions: { lazyConnect: true, maxRetriesPerRequest: 7 } });
    const options = (redis as unknown as { options: Record<string, unknown> }).options;
    expect(options.maxRetriesPerRequest).toBe(7);
  });

  it('createSubscriber likewise lets a caller override its default', () => {
    const sub = createSubscriber({ url, redisOptions: { lazyConnect: true, maxRetriesPerRequest: 5 } });
    const options = (sub as unknown as { options: Record<string, unknown> }).options;
    expect(options.maxRetriesPerRequest).toBe(5);
    sub.disconnect();
  });

  it('getRedis is still memoized across calls even when redisOptions is passed: the second call returns the SAME client rather than reconstructing with new options', () => {
    const first = getRedis({ url, redisOptions: { lazyConnect: true } });
    const second = getRedis({ url, redisOptions: { lazyConnect: true, maxRetriesPerRequest: 99 } });
    expect(second).toBe(first);
    const options = (first as unknown as { options: Record<string, unknown> }).options;
    expect(options.maxRetriesPerRequest).toBe(3); // the second call's options never applied
  });

  it('createSubscriber never memoizes: two calls build two distinct connections', () => {
    const a = createSubscriber({ url, redisOptions: { lazyConnect: true } });
    const b = createSubscriber({ url, redisOptions: { lazyConnect: true } });
    expect(a).not.toBe(b);
    a.disconnect();
    b.disconnect();
  });
});
