// Proves the gzip checkpoint path (src/server/checkpoint.ts) against a real
// server, and in particular the trap its own comments warn about: reading a
// possibly-gzipped value with `get` instead of `getBuffer` silently destroys
// it via a lossy UTF-8 decode. The in-memory fake in src/server/testFakeRedis.ts
// cannot demonstrate this at all, because a fake built on JS strings/Buffers in
// one process has no "wire" to be lossy across.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { gzipSync } from 'node:zlib';
import type { RedisLike } from '../src/core/index.js';
import { writeCheckpoint, readCheckpoint, STATE_TTL_S } from '../src/server/index.js';
import { TEST_REDIS_URL, probeRedisAvailable, newNamespace, flushNamespace, skipReason } from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: checkpoint] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

/** A few KB of repetitive JSON, the shape a real room checkpoint actually is: many similar records, which is exactly what gzip is good at and JSON text is bad at. */
function realisticPayload(): string {
  const players = Array.from({ length: 40 }, (_, i) => ({
    pid: `player-${i}`,
    x: 100 + i * 3.25,
    y: 200 - i * 1.5,
    heading: (i * 17) % 360,
    hp: 100,
    inventory: ['sword', 'shield', 'potion', 'potion', 'key'],
    name: `Player Number ${i}`,
  }));
  return JSON.stringify({ tick: 123456, players, mapId: 'overworld-04', version: 3 });
}

d('checkpoint / real Redis', () => {
  const namespace = newNamespace('checkpoint');
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

  it('round-trips a realistic payload exactly through writeCheckpoint/readCheckpoint', async () => {
    const key = `${namespace}:state`;
    const body = realisticPayload();
    await writeCheckpoint(redis, key, body);
    const back = await readCheckpoint(redis, key);
    expect(back).toBe(body);
  });

  it('THE TRAP: reading the same gzip-backed key with plain get, not getBuffer, corrupts it', async () => {
    const key = `${namespace}:trap`;
    const body = realisticPayload();
    await writeCheckpoint(redis, key, body);

    // decodeCheckpoint(readCheckpoint's callee) correctly reads it via getBuffer.
    const viaBuffer = await readCheckpoint(redis, key);
    expect(viaBuffer).toBe(body);

    // The trap itself: ask ioredis to decode the SAME bytes as a utf8 string
    // the way a `get` call would. gzip's own magic byte 0x8b sits outside the
    // ASCII range and is not valid on its own as a UTF-8 continuation byte in
    // most positions, so this decode is lossy: the replacement character
    // (U+FFFD) appears where real bytes were lost, and re-encoding that string
    // back to bytes and gunzipping it does not reproduce the original body.
    const viaPlainGet = await redis.get(key);
    expect(viaPlainGet).not.toBeNull();
    // The corrupted string must not equal the correct decode.
    expect(viaPlainGet).not.toBe(body);
    // And it must not even round-trip byte-for-byte back through utf8: the
    // decode has already thrown information away, which is the whole point.
    const reEncoded = Buffer.from(viaPlainGet as string, 'utf8');
    const originalGzipBytes = await redis.getBuffer(key);
    expect(Buffer.compare(reEncoded, originalGzipBytes as Buffer)).not.toBe(0);
    // Trying to gunzip the corrupted bytes either throws or (extremely
    // rarely, if the corruption happened to preserve a valid gzip stream by
    // sheer luck) produces garbage that is not the original body. Either
    // outcome demonstrates the same thing: the plain-get path destroyed the
    // payload before decodeCheckpoint's magic-byte sniff ever got a chance.
    let gunzipSucceededWithCorrectBody = false;
    try {
      const { gunzipSync } = await import('node:zlib');
      gunzipSucceededWithCorrectBody = gunzipSync(reEncoded).toString('utf8') === body;
    } catch {
      gunzipSucceededWithCorrectBody = false;
    }
    expect(gunzipSucceededWithCorrectBody).toBe(false);
  });

  it('the TTL rides the same SET, landing near STATE_TTL_S', async () => {
    const key = `${namespace}:ttl`;
    await writeCheckpoint(redis, key, realisticPayload());
    const ttl = await raw.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(STATE_TTL_S);
    expect(ttl).toBeGreaterThan(STATE_TTL_S - 30); // freshly written, so it should be within a few seconds of the full TTL
  });

  it('a custom TTL is honoured too', async () => {
    const key = `${namespace}:ttl-custom`;
    await writeCheckpoint(redis, key, realisticPayload(), 120);
    const ttl = await raw.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('rolling-deploy case: a PLAIN JSON string written directly (as an old, pre-compression writer would) is read back correctly', async () => {
    const key = `${namespace}:plain-json`;
    const body = realisticPayload();
    // Simulates an older process that never learned to gzip: it just SETs
    // the string body with the TTL, no compression at all.
    await raw.set(key, body, 'EX', STATE_TTL_S);
    const back = await readCheckpoint(redis, key);
    expect(back).toBe(body);
  });

  it('a corrupt/truncated gzip payload makes readCheckpoint throw, reaching the documented fresh-start path', async () => {
    const key = `${namespace}:corrupt`;
    const real = gzipSync(realisticPayload());
    // Truncate mid-stream: the gzip magic bytes are intact (so decodeCheckpoint
    // will attempt to gunzip it) but the deflate stream itself is incomplete.
    const truncated = real.subarray(0, Math.floor(real.length / 2));
    await raw.set(key, truncated, 'EX', STATE_TTL_S);
    await expect(readCheckpoint(redis, key)).rejects.toThrow();
  });

  it('a missing key reads back as null, the same "start fresh" signal as a corrupt one after its own catch', async () => {
    const back = await readCheckpoint(redis, `${namespace}:never-written`);
    expect(back).toBeNull();
  });

  // THE OWNER-CHECKED WRITE IS A LUA SCRIPT, AND A FAKE CANNOT PROVE A SCRIPT
  // RUNS. `testFakeRedis` recognises this one by a substring of its text and
  // then re-implements its semantics in TypeScript, so every unit test of it
  // is really a test of that re-implementation: whether the script itself
  // parses, whether `KEYS[2]` is the key it thinks it is, and whether a Buffer
  // argument survives Lua intact are questions only a real server answers.
  it('the owner-checked write lands, byte for byte, while this writer holds the lease', async () => {
    const key = `${namespace}:oc-state`;
    const leaseKey = `${namespace}:oc-lease`;
    await raw.set(leaseKey, 'me', 'PX', 30_000);
    const body = realisticPayload();

    const reply = await writeCheckpoint(redis, key, body, STATE_TTL_S, { leaseKey, owner: 'me' });
    expect(reply).toBe('OK');
    // Through the SCRIPT rather than through `SET`, so the gzip bytes cross a
    // different boundary: a Lua argument that was not binary-safe would
    // destroy them exactly the way a plain `get` destroys a read.
    expect(await readCheckpoint(redis, key)).toBe(body);
    // And the TTL rides it, as it does on the unconditional form.
    const ttl = await raw.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(STATE_TTL_S);
  });

  it('THE SPLIT-BRAIN CASE: an ex-owner\u0027s write is refused and the successor\u0027s state is untouched', async () => {
    const key = `${namespace}:oc-moved`;
    const leaseKey = `${namespace}:oc-moved-lease`;
    await raw.set(leaseKey, 'the-successor', 'PX', 30_000);

    const successorState = realisticPayload();
    expect(await writeCheckpoint(redis, key, successorState, STATE_TTL_S, { leaseKey, owner: 'the-successor' })).toBe(
      'OK'
    );

    // The predecessor, whose lease was taken while its last renew was in
    // flight, still believes it owns the room. Measured against a real Redis
    // before the check existed: three such overwrites inside 1.5 seconds.
    const stale = JSON.stringify({ tick: 1, players: [] });
    const reply = await writeCheckpoint(redis, key, stale, STATE_TTL_S, { leaseKey, owner: 'the-predecessor' });

    expect(reply).toBeNull();
    expect(await readCheckpoint(redis, key)).toBe(successorState);
  });

  it('is refused when nobody holds the lease at all', async () => {
    const key = `${namespace}:oc-absent`;
    const leaseKey = `${namespace}:oc-absent-lease`;
    const reply = await writeCheckpoint(redis, key, realisticPayload(), STATE_TTL_S, { leaseKey, owner: 'me' });
    expect(reply).toBeNull();
    expect(await readCheckpoint(redis, key)).toBeNull();
  });

  it('MEASURED: compression ratio on a realistic payload', async () => {
    const body = realisticPayload();
    const raw_bytes = Buffer.byteLength(body, 'utf8');
    const compressed = gzipSync(body);
    const ratio = raw_bytes / compressed.length;
    // Not a hard bound, just a sanity floor: ARCHITECTURE.md claims 3.9x to
    // 7.0x on real (glade) payloads, so this repetitive synthetic payload
    // should land comfortably above 2x or something is wrong with the
    // measurement itself, not with gzip.
    expect(ratio).toBeGreaterThan(2);
    // eslint-disable-next-line no-console
    console.log(
      `[measured] checkpoint compression: ${raw_bytes}B -> ${compressed.length}B (${ratio.toFixed(2)}x)`
    );
  });
});
