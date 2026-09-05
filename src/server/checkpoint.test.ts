// The STORAGE half of the checkpoint: gzip, the magic-byte sniff that makes a
// rolling deploy safe, and the Redis read/write pair. Moved here verbatim from
// `src/core/checkpoint.test.ts` when the module itself moved out of `core/`,
// because it imports `node:zlib` and `core/` may not.
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeCheckpoint,
  encodeCheckpoint,
  readCheckpoint,
  STATE_TTL_S,
  writeCheckpoint,
} from './checkpoint.js';
import { graceMsFromCheckpoint, packCheckpoint, unpackCheckpoint } from '../core/checkpoint.js';
// The owner-checked write needs a fake that actually runs the script, which is
// the directory's shared one rather than the two-method stub below.
import { FakeRedis as HubFakeRedis } from './testFakeRedis.js';
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

describe('a compressor that fails is not a checkpoint that fails', () => {
  it('a gzip that throws still writes the plain JSON body', async () => {
    // A checkpoint that was never written costs a room its ENTIRE state on the
    // next handoff: a successor finds nothing and starts fresh. One written
    // uncompressed costs some Redis bandwidth. Between "lose everything" and
    // "write it larger", write it larger, so the deflate failure has to be
    // swallowed rather than propagated to the caller that would drop the write.
    vi.resetModules();
    vi.doMock('node:zlib', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:zlib')>();
      return {
        ...actual,
        gzip: (_buf: unknown, cb: (err: Error | null, out?: Buffer) => void): void => {
          cb(new Error('deflate is down'));
        },
      };
    });
    try {
      const mod = await import('./checkpoint.js');
      const json = packCheckpoint(envelope({ tick: 77 }));

      // Plain text, not bytes, and not a rejection.
      expect(await mod.encodeCheckpoint(json)).toBe(json);

      // And the whole write/read pair still round-trips, which is what the
      // successor actually depends on: the magic-byte sniff on the way back
      // reads an uncompressed body exactly as it reads one an old writer left.
      const redis = fakeRedis();
      await mod.writeCheckpoint(redis, 'room:x:state', json);
      expect(await mod.readCheckpoint(redis, 'room:x:state')).toBe(json);
    } finally {
      vi.doUnmock('node:zlib');
      vi.resetModules();
    }
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

  it('a plain Uint8Array (not a Buffer) decodes as UTF-8, not as comma-separated bytes', () => {
    // `RedisLike.getBuffer` is DECLARED to return a `Uint8Array`, because
    // `core/` has to stay typeable with no `@types/node`, and
    // `Uint8Array.prototype.toString` has no encoding-aware overload: it
    // stringifies like an Array, so `raw.toString('utf8')` on a plain
    // Uint8Array yields "123,34,118,..." and every caller's `JSON.parse`
    // throws on a checkpoint that was perfectly intact. Every real caller
    // hands over a Buffer today, which is exactly what would have kept this
    // latent until the first client that did not.
    const json = packCheckpoint(envelope());
    const bytes = new Uint8Array(Buffer.from(json, 'utf8'));
    expect(Buffer.isBuffer(bytes)).toBe(false);
    expect(decodeCheckpoint(bytes)).toBe(json);
  });

  it('returns null for a missing value', () => {
    expect(decodeCheckpoint(null)).toBeNull();
    expect(decodeCheckpoint(undefined)).toBeNull();
  });
});

describe('TR-11: decodeCheckpoint treats an empty value as no checkpoint, not an empty checkpoint', () => {
  it('returns null for a zero-length buffer, not an empty string', () => {
    // Before the fix this fell through to `Buffer.alloc(0).toString('utf8')`,
    // which is '' rather than null. '' is not the same thing as "nothing was
    // ever written": unpackCheckpoint in core/checkpoint.ts feeds this
    // straight into JSON.parse, and JSON.parse('') throws, so the empty
    // buffer has to read exactly like the null/undefined case above rather
    // than as a distinct empty-string case.
    const decoded = decodeCheckpoint(Buffer.alloc(0));
    expect(decoded).toBeNull();
    expect(decoded).not.toBe('');
  });

  it('returns null for an empty string too, for the same reason', () => {
    expect(decodeCheckpoint('')).toBeNull();
  });

  it('an empty buffer round-trips through unpackCheckpoint as "no checkpoint" rather than throwing', () => {
    const decoded = decodeCheckpoint(Buffer.alloc(0));
    // unpackCheckpoint must be able to accept whatever decodeCheckpoint
    // hands it without throwing: this is the actual downstream consumer
    // graceMsFromCheckpoint relies on, so pin the seam rather than only the
    // isolated return value above.
    expect(unpackCheckpoint(decoded)).toBeNull();
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

// The owner check exists because the `owns` flag a ticker gates its writes on
// is a LOCAL BELIEF that lags reality by up to a renew period. An ex-owner
// whose lease was taken while its last renew was in flight still thinks it is
// the authority, and a plain SET then overwrites the successor's fresher room
// with state from before the handoff. Measured against a real Redis at three
// such overwrites inside 1.5 seconds.
describe('an owner-checked write is refused once the lease has moved on', () => {
  const KEY = 'room:oc:state';
  const LEASE = 'room:oc:lease';

  it('lands while this writer still holds the lease', async () => {
    const redis = new HubFakeRedis();
    await redis.set(LEASE, 'me', 'PX', 5000);
    const json = packCheckpoint(envelope({ tick: 7 }));
    const reply = await writeCheckpoint(redis, KEY, json, STATE_TTL_S, { leaseKey: LEASE, owner: 'me' });
    expect(reply).toBe('OK');
    expect(await readCheckpoint(redis, KEY)).toBe(json);
  });

  it('is refused, and changes nothing, once another owner holds the lease', async () => {
    const redis = new HubFakeRedis();
    await redis.set(LEASE, 'the-successor', 'PX', 5000);
    const successorState = packCheckpoint(envelope({ tick: 900 }));
    await writeCheckpoint(redis, KEY, successorState, STATE_TTL_S, { leaseKey: LEASE, owner: 'the-successor' });

    // The predecessor, still believing it owns the room, tries to save the
    // state it had when it stopped being the authority.
    const stale = packCheckpoint(envelope({ tick: 12 }));
    const reply = await writeCheckpoint(redis, KEY, stale, STATE_TTL_S, { leaseKey: LEASE, owner: 'the-predecessor' });

    expect(reply).toBeNull();
    // The load-bearing half: the successor's room is untouched.
    expect(await readCheckpoint(redis, KEY)).toBe(successorState);
  });

  it('is refused when nobody holds the lease at all', async () => {
    const redis = new HubFakeRedis();
    const reply = await writeCheckpoint(redis, KEY, packCheckpoint(envelope()), STATE_TTL_S, {
      leaseKey: LEASE,
      owner: 'me',
    });
    expect(reply).toBeNull();
    expect(await readCheckpoint(redis, KEY)).toBeNull();
  });

  it('with no owner option it is the unconditional SET it always was', async () => {
    const redis = new HubFakeRedis();
    await redis.set(LEASE, 'somebody-else', 'PX', 5000);
    const json = packCheckpoint(envelope({ tick: 3 }));
    // No `ownerCheck`, so the lease is not consulted: this is the form a host
    // calling `writeCheckpoint` directly, outside a ticker, still gets.
    expect(await writeCheckpoint(redis, KEY, json)).toBe('OK');
    expect(await readCheckpoint(redis, KEY)).toBe(json);
  });

  it('the compressed body survives the round trip through the script', async () => {
    // The write goes through `eval` rather than `set` on this path, so the
    // gzip bytes cross a different boundary and a text-mangling one would
    // destroy them exactly the way a plain `get` destroys a read.
    const redis = new HubFakeRedis();
    await redis.set(LEASE, 'me', 'PX', 5000);
    const json = packCheckpoint(envelope({ body: '{"pad":"' + 'x'.repeat(5000) + '"}' }));
    await writeCheckpoint(redis, KEY, json, STATE_TTL_S, { leaseKey: LEASE, owner: 'me' });
    expect(await readCheckpoint(redis, KEY)).toBe(json);
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
