// TR-12: `RedisFactoryOptions.redisOptions` must actually reach the ioredis
// client, and the two factories must default to OPPOSITE retry policies
// (see the module comment in redis.ts for why). Every client built here uses
// `lazyConnect: true` so the test never actually dials a socket: what is
// under test is the OPTIONS OBJECT ioredis was constructed with, read back
// off the live client's own `.options`, not whether a real Redis answers.
import { afterEach, describe, expect, it, vi } from 'vitest';
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

// A retry count only ever fires once ioredis has NOTICED the connection is
// gone, which a black-holed connection never lets it do: no FIN, no RST, no
// error event, so nothing rejects and every command queues forever. The
// timeout is the only bound that covers that, so it is defaulted rather than
// left to a host to discover after the incident.
describe('commandTimeout bounds the wait, not just the retries', () => {
  it('getRedis defaults to commandTimeout: 2000 for the shared command client', () => {
    const redis = getRedis({ url, redisOptions: { lazyConnect: true } });
    const options = (redis as unknown as { options: Record<string, unknown> }).options;
    expect(options.commandTimeout).toBe(2000);
  });

  it('createSubscriber sets NO commandTimeout, because one there crashes the process on a slow reconnect', () => {
    // NOT AN OVERSIGHT, AND NOT SYMMETRY FOR ITS OWN SAKE. ioredis's
    // `readyHandler` re-issues the subscription itself after every reconnect
    // (`self.subscribe(subscribeChannels)`) with no `.catch`, so a
    // client-wide `commandTimeout` applies to a command this library never
    // issued and cannot handle: a resubscribe slower than the timeout is an
    // unhandled rejection, which is a process exit that takes every other
    // socket the function holds with it. The WAIT is bounded where it is
    // issued instead (the relay and the ticker each race their own
    // SUBSCRIBE). `tests/subscriber.redis.test.ts` measures both halves
    // against a real Redis behind a TCP proxy.
    const sub = createSubscriber({ url, redisOptions: { lazyConnect: true } });
    const options = (sub as unknown as { options: Record<string, unknown> }).options;
    expect(options.commandTimeout).toBeUndefined();
    expect(options.maxRetriesPerRequest).toBeNull(); // the retry policy is untouched by that decision
    sub.disconnect();
  });

  it('a caller-supplied commandTimeout wins over the shared client default', () => {
    const redis = getRedis({ url, redisOptions: { lazyConnect: true, commandTimeout: 250 } });
    expect((redis as unknown as { options: Record<string, unknown> }).options.commandTimeout).toBe(250);
    resetRedisForTests();

    // A caller can still ask for one on a subscriber, and owns the hazard
    // above when they do; the merge is not what changed, the DEFAULT is.
    const sub = createSubscriber({ url, redisOptions: { lazyConnect: true, commandTimeout: 250 } });
    expect((sub as unknown as { options: Record<string, unknown> }).options.commandTimeout).toBe(250);
    sub.disconnect();
  });
});

// An EventEmitter with no 'error' listener throws the error as an uncaught
// exception, and ioredis's own fallback prints a line per retry, so the
// listener is attached whether or not a host asked for one.
describe('every client carries an error listener', () => {
  type Emitter = { emit(ev: string, ...args: unknown[]): boolean; listenerCount(ev: string): number };

  it('forwards a client error to the caller onError hook', () => {
    const seen: unknown[] = [];
    const redis = getRedis({ url, redisOptions: { lazyConnect: true }, onError: (err) => seen.push(err) });
    const boom = new Error('connection reset');
    (redis as unknown as Emitter).emit('error', boom);
    expect(seen).toEqual([boom]);
  });

  it('a subscriber forwards its own errors too, on its own hook', () => {
    const seen: unknown[] = [];
    const sub = createSubscriber({ url, redisOptions: { lazyConnect: true }, onError: (err) => seen.push(err) });
    (sub as unknown as Emitter).emit('error', new Error('subscriber reset'));
    expect(seen).toHaveLength(1);
    sub.disconnect();
  });

  it('attaches a listener even with no hook supplied, and rate limits its own logging', () => {
    const redis = getRedis({ url, redisOptions: { lazyConnect: true } });
    expect((redis as unknown as Emitter).listenerCount('error')).toBeGreaterThan(0);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A flapping connection emits these as fast as it retries, so the
      // default must not turn one outage into a log flood: five lines'
      // worth of events, one line out.
      for (let i = 0; i < 5; i++) {
        expect(() => (redis as unknown as Emitter).emit('error', new Error('quiet'))).not.toThrow();
      }
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('a throwing host hook cannot escape the event handler', () => {
    const redis = getRedis({
      url,
      redisOptions: { lazyConnect: true },
      onError: () => {
        throw new Error('host telemetry blew up');
      },
    });
    expect(() => (redis as unknown as Emitter).emit('error', new Error('connection reset'))).not.toThrow();
  });
});
