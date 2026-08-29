import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeCheckpoint,
  encodeCheckpoint,
  graceMsFromCheckpoint,
  packCheckpoint,
  readCheckpoint,
  STATE_TTL_S,
  unpackCheckpoint,
  writeCheckpoint,
} from './checkpoint.js';
import type { RedisLike } from './redisLike.js';
import type { CheckpointEnvelope } from './types.js';

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

  it('a compressed payload really is smaller than the source for a repetitive body', async () => {
    const json = packCheckpoint(envelope({ body: '{"pad":"' + 'x'.repeat(5000) + '"}' }));
    const encoded = await encodeCheckpoint(json);
    expect((encoded as Buffer).length).toBeLessThan(json.length);
  });
});

describe('decodeCheckpoint handles a rolling deploy: plain JSON from an old writer', () => {
  it('reads a plain-text JSON buffer with no gzip magic bytes as-is', () => {
    const json = packCheckpoint(envelope());
    const decoded = decodeCheckpoint(Buffer.from(json, 'utf8'));
    expect(decoded).toBe(json);
  });

  it('reads a plain string the same way', () => {
    const json = packCheckpoint(envelope());
    expect(decodeCheckpoint(json)).toBe(json);
  });

  it('returns null for a missing value', () => {
    expect(decodeCheckpoint(null)).toBeNull();
    expect(decodeCheckpoint(undefined)).toBeNull();
  });
});

describe('decodeCheckpoint throws on corrupt gzip rather than returning garbage', () => {
  it('throws on a truncated gzip payload', async () => {
    const json = packCheckpoint(envelope());
    const full = gzipSync(json);
    const truncated = full.subarray(0, full.length - 5);
    expect(() => decodeCheckpoint(truncated)).toThrow();
  });

  it('throws on a gzip-magic-tagged payload with corrupted body bytes', () => {
    const full = gzipSync(packCheckpoint(envelope()));
    const corrupted = Buffer.from(full);
    // Flip bytes well past the header so the magic sniff still says "gzip"
    // but the deflate stream itself is invalid.
    for (let i = 10; i < Math.min(corrupted.length, 30); i++) {
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

describe('packCheckpoint / unpackCheckpoint', () => {
  it('round-trips a well-formed envelope', () => {
    const env = envelope({ geom: 'abc' });
    expect(unpackCheckpoint(packCheckpoint(env))).toEqual(env);
  });

  it('round-trips with geom omitted', () => {
    const env = envelope();
    expect(unpackCheckpoint(packCheckpoint(env))).toEqual(env);
  });

  it('returns null for invalid JSON', () => {
    expect(unpackCheckpoint('not json{{')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(unpackCheckpoint(null)).toBeNull();
  });

  it('returns null for a JSON value missing required fields', () => {
    expect(unpackCheckpoint(JSON.stringify({ v: 1, tick: 1 }))).toBeNull();
  });

  it('returns null when a field has the wrong type', () => {
    expect(unpackCheckpoint(JSON.stringify({ ...envelope(), tick: 'not-a-number' }))).toBeNull();
  });

  it('returns null for a bare array or primitive', () => {
    expect(unpackCheckpoint('[]')).toBeNull();
    expect(unpackCheckpoint('42')).toBeNull();
    expect(unpackCheckpoint('"hello"')).toBeNull();
  });
});

describe('graceMsFromCheckpoint', () => {
  const tickMs = 50; // 20Hz
  const slackMs = 500;

  it('returns 0 for a null checkpoint', () => {
    expect(graceMsFromCheckpoint(null, tickMs, slackMs)).toBe(0);
  });

  it('returns 0 when there is no in-progress grace', () => {
    const json = packCheckpoint(envelope({ tick: 100, graceUntilTick: 0 }));
    expect(graceMsFromCheckpoint(json, tickMs, slackMs)).toBe(0);
  });

  it('returns 0 when the grace has already expired', () => {
    const json = packCheckpoint(envelope({ tick: 100, graceUntilTick: 50 }));
    expect(graceMsFromCheckpoint(json, tickMs, slackMs)).toBe(0);
  });

  it('computes remaining ticks times tickMs plus slack', () => {
    const json = packCheckpoint(envelope({ tick: 100, graceUntilTick: 120 }));
    // 20 remaining ticks * 50ms + 500ms slack
    expect(graceMsFromCheckpoint(json, tickMs, slackMs)).toBe(20 * 50 + 500);
  });

  it('computes identically whether the checkpoint text came from a gzip or plain-JSON round trip', async () => {
    const json = packCheckpoint(envelope({ tick: 100, graceUntilTick: 130 }));
    const gz = decodeCheckpoint(await encodeCheckpoint(json));
    const plain = decodeCheckpoint(json);
    expect(graceMsFromCheckpoint(gz, tickMs, slackMs)).toBe(graceMsFromCheckpoint(plain, tickMs, slackMs));
  });

  it('returns 0 for unparseable JSON rather than throwing', () => {
    expect(() => graceMsFromCheckpoint('garbage', tickMs, slackMs)).not.toThrow();
    expect(graceMsFromCheckpoint('garbage', tickMs, slackMs)).toBe(0);
  });
});
