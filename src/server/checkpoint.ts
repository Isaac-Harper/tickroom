// Checkpoint STORAGE: gzip on the way out, magic-byte sniffing on the way
// back, and the Redis read/write pair that carries them.
//
// THIS FILE LIVES IN `server/` BECAUSE IT IMPORTS `node:zlib`, and that is the
// whole reason it is not in `core/`. It used to be `src/core/checkpoint.ts`
// and it was re-exported from the core barrel, which made the barrel's own
// promise ("no IO, no platform, safe in a browser") false: any client module
// that touched the barrel dragged `node:zlib` and `node:util` onto the browser
// module graph, where a bundle does not merely bloat, it FAILS TO BUILD.
// Moving the file rather than merely dropping it from the barrel is deliberate:
// with no Node import left anywhere under `core/`, the layer rule is true of
// the DIRECTORY and not just of one export list, so the only way to reintroduce
// the bug is to write a `../server/...` import inside `core/`, which is an
// obvious layering violation rather than a plausible-looking barrel tidy-up.
//
// The PURE half of the checkpoint (the envelope grammar: `CHECKPOINT_VERSION`,
// `packCheckpoint`, `unpackCheckpoint`, `graceMsFromCheckpoint`) stayed in
// `core/checkpoint.ts`. It has no Node dependency and no reason to force one on
// a caller: `graceMsFromCheckpoint` in particular is read on the relay's
// play-time cutoff path, which wants the number and not the gzip.
import { gzip as gzipCb, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import type { RedisLike } from '../core/index.js';

const gzip = promisify(gzipCb);

/** How long a checkpoint survives with nobody writing it. Rides the same SET that already happens every checkpoint interval, see `writeCheckpoint`. */
export const STATE_TTL_S = 3600;

// gzip's own magic bytes. Sniffing these is what lets a plain-JSON value
// written by an old process (mid rolling-deploy, before this compression
// existed, or after a compression failure) still be read correctly by a new
// one: there is no stored "is this compressed" flag anywhere, the bytes speak
// for themselves.
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/**
 * Compresses a checkpoint body. ASYNC on purpose, never `gzipSync`: the
 * periodic checkpoint write happens from INSIDE the tick loop, whose entire
 * timing guarantee rests on nothing in it ever blocking the event loop for
 * more than a trivial amount of time. A synchronous deflate of a state that
 * has grown to tens or hundreds of KB is real, measurable milliseconds of
 * stolen tick time; the async form hands the work to libuv's threadpool and
 * simply becomes the head of the fire-and-forget promise chain the write
 * already was.
 *
 * FALLS BACK TO PLAIN TEXT ON FAILURE rather than throwing or dropping the
 * write. A checkpoint that was never written at all costs a room its ENTIRE
 * state on the next handoff (a successor finds nothing and starts fresh); a
 * checkpoint written uncompressed costs only some Redis bandwidth. Between
 * "lose everything" and "write it larger", write it larger.
 */
export async function encodeCheckpoint(json: string): Promise<Buffer | string> {
  try {
    return await gzip(json);
  } catch {
    return json;
  }
}

/**
 * Decompresses a checkpoint body, or returns a plain-text one unchanged. A
 * `null`/`undefined` input (nothing was ever written) returns `null`, which
 * callers should treat identically to "start fresh".
 *
 * THROWS on a gzip-magic-tagged payload that fails to actually decompress
 * (truncated write, bit rot, a genuinely corrupt value). This is deliberate,
 * not an oversight: every caller of this function already wraps its read in
 * a try/catch that treats an unreadable checkpoint exactly like a MISSING
 * one (fall through to building a fresh room). Swallowing the error here
 * instead of letting it propagate would mean inventing a SECOND corrupt-data
 * code path that has to independently agree with the first one, for no
 * benefit: a throw already reaches the one path that exists.
 *
 * `raw` is typed `Uint8Array` rather than `Buffer` because it flows straight
 * from `RedisLike.getBuffer`, whose signature had to drop `Buffer` so `core`
 * stays typeable with no `@types/node` (see the comment on `RedisLike` in
 * `core/redisLike.ts`). This file is Node-only regardless (it imports
 * `node:zlib`), and at runtime `raw` really is a `Buffer` every real caller
 * hands it, so nothing about the decoding below changes; only the declared
 * type of the parameter does.
 */
export function decodeCheckpoint(raw: Uint8Array | string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    // A bare string can only ever be plain JSON: it already went through a
    // lossy text decode somewhere upstream, so gzip bytes could not have
    // survived it intact regardless of what wrote them.
    // A zero-length string is the same "nothing here" case the buffer branch
    // below handles explicitly: fall through to the shared empty check
    // rather than returning '' and forcing every caller to treat an empty
    // string as a distinct third case alongside null.
    return raw.length === 0 ? null : raw;
  }
  // A ZERO-LENGTH BUFFER IS NOT A CHECKPOINT, it is the absence of one, and
  // must return null exactly like the null/undefined branch above. Before
  // this fix it fell through to `raw.toString('utf8')`, which for an empty
  // buffer is `''`, not null. Every real caller feeds that string straight
  // into `JSON.parse` (via `unpackCheckpoint` in core/checkpoint.ts) or a
  // truthiness check that treats '' as "no checkpoint" today, so this was
  // latent rather than actively broken, but a `JSON.parse('')` throws, and a
  // host that ever calls `JSON.parse` directly on this return value instead
  // of going through `unpackCheckpoint` would hit that throw on the exact
  // input ("nothing was ever written") that should read as cleanly as
  // `null`.
  if (raw.length === 0) return null;
  if (raw.length >= 2 && raw[0] === GZIP_MAGIC_0 && raw[1] === GZIP_MAGIC_1) {
    return gunzipSync(raw).toString('utf8');
  }
  // `raw` is a `Uint8Array` here, not necessarily a `Buffer` per its declared
  // type, and `Uint8Array.prototype.toString` has no encoding-aware
  // overload (it stringifies as comma-separated numbers, like `Array`).
  // `gunzipSync` above is unaffected: it always returns a real `Buffer`
  // regardless of what it was handed, so `.toString('utf8')` on ITS result
  // needed no change. `Buffer.from(raw)` decodes the SAME UTF-8 bytes the
  // same way regardless of whether `raw` already is a `Buffer` (the real
  // runtime case for every caller today, where this costs one small copy)
  // or a plain `Uint8Array`, so this is byte-for-byte the decode
  // `raw.toString('utf8')` used to do.
  return Buffer.from(raw).toString('utf8');
}

/**
 * Writes a checkpoint with its TTL riding the SAME `SET` call. This is not an
 * optimisation, it is the only place the TTL is allowed to live: the TTL
 * rides a write that already happens every checkpoint interval, so it costs
 * no extra Redis command, a room with active players can never expire (each
 * checkpoint refreshes it), and there is no separate `EXPIRE` call anywhere
 * that a future edit could forget to keep in sync with this one. Do not add
 * one beside it.
 */
export async function writeCheckpoint(
  redis: RedisLike,
  key: string,
  json: string,
  ttlS: number = STATE_TTL_S
): Promise<unknown> {
  const body = await encodeCheckpoint(json);
  return redis.set(key, body, 'EX', ttlS);
}

/**
 * Reads a checkpoint back. MUST use `getBuffer`, never `get`: a checkpoint
 * may be gzip bytes, and asking ioredis for a decoded string first would run
 * those bytes through a lossy UTF-8 decode before `decodeCheckpoint` ever
 * gets a chance to sniff the magic header, silently destroying the payload.
 * This single-line difference is exactly the class of mistake that turns a
 * "read the checkpoint" bug into "every room permanently forgets its state
 * the moment compression is turned on".
 */
export async function readCheckpoint(redis: RedisLike, key: string): Promise<string | null> {
  const raw = await redis.getBuffer(key);
  return decodeCheckpoint(raw);
}
