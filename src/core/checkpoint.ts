// The checkpoint ENVELOPE grammar: the version, the pack/unpack pair, and the
// one derivation (`graceMsFromCheckpoint`) a host reads off a checkpoint
// without deserializing its body.
//
// PURE, AND IT HAS TO STAY THAT WAY. Everything here is JSON and arithmetic:
// no `node:zlib`, no `node:util`, no Redis, no Buffer. The gzip and the Redis
// read/write pair that used to sit in this file now live in
// `src/server/checkpoint.ts`, because they import `node:zlib` at module scope
// and this file is re-exported from the core barrel, which client code imports
// and bundlers compile for the browser. A single Node builtin reachable from
// here is a HARD BUILD FAILURE downstream (`Could not resolve "node:zlib"`),
// not a warning and not merely wasted bytes, and tree shaking does not save
// you: the old module ran `promisify(gzipCb)` at module scope, so it was never
// side-effect-free to begin with. `src/client/bundling.test.ts` bundles this
// barrel for the browser on every run, so reintroducing a Node import here
// reddens rather than landing on whoever integrates the library next.
import type { CheckpointEnvelope } from './types.js';

/** Wire version of the envelope tickroom wraps your `serialize()` output in. Bump only if this shape itself changes; your own state schema versioning is a separate concern (see `CheckpointEnvelope.geom`). */
export const CHECKPOINT_VERSION = 1;

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
