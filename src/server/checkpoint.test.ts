// The STORAGE half of the checkpoint: gzip, the magic-byte sniff that makes a
// rolling deploy safe, and the Redis read/write pair. Moved here verbatim from
// `src/core/checkpoint.test.ts` when the module itself moved out of `core/`,
// because it imports `node:zlib` and `core/` may not.
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeCheckpoint,
  encodeCheckpoint,
  readCheckpoint,
  STATE_TTL_S,
  writeCheckpoint,
} from './checkpoint.js';
import { graceMsFromCheckpoint, packCheckpoint } from '../core/checkpoint.js';
import type { RedisLike } from '../core/redisLike.js';
import type { CheckpointEnvelope } from '../core/types.js';

/** In-memory RedisLike storing raw bytes, faithful enough to exercise get/getBuffer/set with EX. */
class FakeRedis implements Partial<RedisLike> {
  store = new Map<string, Buffer>();
  lastSetArgs: unknown[] | null = null;

  async set(key: string, value: string | Buffer, ...args: unknown[]): Promise<unknown> {
    this.store.set(key, Buffer.isBuffer(value) ? value : Buffer.from(value));
    this.lastSetArgs = args;
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    return v === undefined ? null : v.toString('utf8');
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    return this.store.get(key) ?? null;
  }
}

function fakeRedis(): RedisLike & FakeRedis {
  return new FakeRedis() as unknown as RedisLike & FakeRedis;
}

function envelope(overrides: Partial<CheckpointEnvelope> = {}): CheckpointEnvelope {
  return {
    v: 1,
    tick: 100,
    graceUntilTick: 0,
    incarnation: 'abc123',
    body: '{"players":[]}',
    ...overrides,
  };
}

describe('encodeCheckpoint / decodeCheckpoint round trip', () => {
  it('compresses and decompresses back to the original text', async () => {
    const json = packCheckpoint(envelope());
    const encoded = await encodeCheckpoint(json);
    expect(Buffer.isBuffer(encoded)).toBe(true);
    const decoded = decodeCheckpoint(encoded);
    expect(decoded).toBe(json);
  });

  it('actually compresses a realistically repetitive payload', async () => {
    const json = packCheckpoint(envelope({ body: '{"pad":"' + 'x'.repeat(5000) + '"}' }));
    const encoded = await encodeCheckpoint(json);
    expect((encoded as Buffer).length).toBeLessThan(json.length / 2);
  });
});

describe('decodeCheckpoint handles a rolling deploy: plain JSON from an old writer', () => {
  it('reads an uncompressed buffer unchanged', () => {
    const json = packCheckpoint(envelope());
    const decoded = decodeCheckpoint(Buffer.from(json, 'utf8'));
    expect(decoded).toBe(json);
  });

  it('reads a plain string unchanged', () => {
    const json = packCheckpoint(envelope());
    expect(decodeCheckpoint(json)).toBe(json);
  });

  it('returns null for a missing value', () => {
    expect(decodeCheckpoint(null)).toBeNull();
    expect(decodeCheckpoint(undefined)).toBeNull();
  });
});

describe('decodeCheckpoint throws on corrupt gzip rather than returning garbage', () => {
  it('throws on a truncated gzip payload', () => {
    const json = packCheckpoint(envelope());
    const full = gzipSync(json);
    const truncated = full.subarray(0, Math.floor(full.length / 2));
    expect(() => decodeCheckpoint(truncated)).toThrow();
  });

  it('throws on a body-corrupted gzip payload', () => {
    const full = gzipSync(packCheckpoint(envelope()));
    const corrupted = Buffer.from(full);
    for (let i = 10; i < Math.min(corrupted.length, 20); i++) {
      corrupted[i] = corrupted[i] ^ 0xff;
    }
    expect(() => decodeCheckpoint(corrupted)).toThrow();
  });
});

describe('writeCheckpoint / readCheckpoint through a fake Redis', () => {
  it('round-trips a real checkpoint end to end', async () => {
    const redis = fakeRedis();
    const json = packCheckpoint(envelope({ tick: 42 }));
    await writeCheckpoint(redis, 'room:x:state', json);
    const readBack = await readCheckpoint(redis, 'room:x:state');
    expect(readBack).toBe(json);
  });

  it('applies the TTL on the same SET call, defaulting to STATE_TTL_S', async () => {
    const redis = fakeRedis();
    await writeCheckpoint(redis, 'room:x:state', packCheckpoint(envelope()));
    expect(redis.lastSetArgs).toEqual(['EX', STATE_TTL_S]);
  });

  it('honours an overridden TTL', async () => {
    const redis = fakeRedis();
    await writeCheckpoint(redis, 'room:x:state', packCheckpoint(envelope()), 60);
    expect(redis.lastSetArgs).toEqual(['EX', 60]);
  });

  it('readCheckpoint returns null when nothing was ever written', async () => {
    const redis = fakeRedis();
    expect(await readCheckpoint(redis, 'room:missing:state')).toBeNull();
  });
});

describe('the storage codec is transparent to the pure envelope reader', () => {
  // Crosses the core/server seam on purpose: `graceMsFromCheckpoint` is pure
  // and lives in `core/`, but it is only ever handed text that came back out
  // of THIS file's decoder, so the two halves have to agree.
  it('computes the same grace whether the text came from a gzip or plain-JSON round trip', async () => {
    const tickMs = 50;
    const slackMs = 500;
    const json = packCheckpoint(envelope({ tick: 100, graceUntilTick: 130 }));
    const gz = decodeCheckpoint(await encodeCheckpoint(json));
    const plain = decodeCheckpoint(json);
    expect(graceMsFromCheckpoint(gz, tickMs, slackMs)).toBe(graceMsFromCheckpoint(plain, tickMs, slackMs));
  });
});
