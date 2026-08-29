import { gzip as gzipCb, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import type { RedisLike } from './redisLike.js';
import type { CheckpointEnvelope } from './types.js';

const gzip = promisify(gzipCb);

/** How long a checkpoint survives with nobody writing it. Rides the same SET that already happens every checkpoint interval, see `writeCheckpoint`. */
export const STATE_TTL_S = 3600;

/** Wire version of the envelope tickroom wraps your `serialize()` output in. Bump only if this shape itself changes; your own state schema versioning is a separate concern (see `CheckpointEnvelope.geom`). */
export const CHECKPOINT_VERSION = 1;

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
 */
export function decodeCheckpoint(raw: Buffer | string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    // A bare string can only ever be plain JSON: it already went through a
    // lossy text decode somewhere upstream, so gzip bytes could not have
    // survived it intact regardless of what wrote them.
    return raw;
  }
  if (raw.length >= 2 && raw[0] === GZIP_MAGIC_0 && raw[1] === GZIP_MAGIC_1) {
    return gunzipSync(raw).toString('utf8');
  }
  return raw.toString('utf8');
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

/**
 * How much longer (in ms) a socket should be graced past a play-time cutoff,
 * derived from a checkpoint's hoisted `graceUntilTick` without deserializing
 * the body. `tickMs` is `1000 / tickHz`; `slackMs` covers publish/network
 * jitter so the grace does not expire a fraction of a tick early. Returns 0
 * for a missing, unparseable, or already-expired checkpoint: fail toward
 * "no grace" rather than inventing one, since granting a grace nobody's
 * simulation is actually honouring would let a host believe a session is
 * still protected when it is not.
 */
export function graceMsFromCheckpoint(json: string | null, tickMs: number, slackMs: number): number {
  const envelope = unpackCheckpoint(json);
  if (envelope === null) return 0;
  const remainingTicks = envelope.graceUntilTick - envelope.tick;
  if (remainingTicks <= 0) return 0;
  return remainingTicks * tickMs + slackMs;
}

/** `JSON.stringify`, named so a call site reads as "pack the envelope" rather than an unqualified stringify of who-knows-what. */
export function packCheckpoint(env: CheckpointEnvelope): string {
  return JSON.stringify(env);
}

/**
 * Parses and shape-validates a checkpoint envelope. Returns `null` (never
 * throws) for anything that is not valid JSON or does not look like an
 * envelope this version understands: a corrupt value, a value from an
 * incompatible future version, or a pre-tickroom value with none of these
 * fields at all. Every field this function reads is checked for its
 * expected primitive type, not just presence, because a checkpoint's bytes
 * ultimately trace back to something that was written by a PAST version of
 * this same library and a malformed field should degrade to "no checkpoint"
 * rather than propagate a `NaN` or `undefined` into arithmetic that assumes
 * a number.
 */
export function unpackCheckpoint(json: string | null): CheckpointEnvelope | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<CheckpointEnvelope>;
  if (
    typeof candidate.v !== 'number' ||
    typeof candidate.tick !== 'number' ||
    typeof candidate.graceUntilTick !== 'number' ||
    typeof candidate.incarnation !== 'string' ||
    typeof candidate.body !== 'string'
  ) {
    return null;
  }
  if (candidate.geom !== undefined && typeof candidate.geom !== 'string') return null;
  return {
    v: candidate.v,
    tick: candidate.tick,
    graceUntilTick: candidate.graceUntilTick,
    geom: candidate.geom,
    incarnation: candidate.incarnation,
    body: candidate.body,
  };
}
