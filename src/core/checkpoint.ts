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

/** Why `inspectCheckpoint` refused. Carried into the ticker's start-fresh log line so an operator can tell a version change from an empty key. */
export type CheckpointRejection =
  /** There was no checkpoint at all: a cold room, or one whose key aged out. The ordinary case, and not a fault. */
  | 'absent'
  /** The bytes were not JSON. A truncated or corrupt value. */
  | 'unparseable'
  /** Valid JSON, but not an envelope: a field missing or carrying the wrong primitive type. */
  | 'malformed'
  /** A well-formed envelope stamped with a `v` this build does not implement. See `inspectCheckpoint`. */
  | 'version';

export type CheckpointInspection =
  | { ok: true; envelope: CheckpointEnvelope }
  | { ok: false; reason: CheckpointRejection; foundVersion: number | null };

/**
 * Parses, shape-validates and VERSION-CHECKS a checkpoint envelope, and says
 * which of those it refused on. Never throws.
 *
 * Every field is checked for its expected primitive type, not just presence,
 * because a checkpoint's bytes ultimately trace back to something written by
 * a PAST version of this same library and a malformed field should degrade
 * to "no checkpoint" rather than propagate a `NaN` or `undefined` into
 * arithmetic that assumes a number.
 *
 * THE VERSION IS REFUSED IN BOTH DIRECTIONS, `!== CHECKPOINT_VERSION` rather
 * than `> CHECKPOINT_VERSION`, and the asymmetry people expect here is the
 * trap. A NEWER envelope is the obvious one: this build cannot know what
 * fields were added or what an existing one now means. An OLDER envelope is
 * the dangerous one, because it PARSES: every field is present and every type
 * checks out, so a `v: 1` body handed to a build whose version 2 changed what
 * `tick` counts or what `body` contains is restored in full and simulated
 * happily. That is the geometry-digest failure exactly, arriving through the
 * other door: the room keeps simulating something the deployment no longer
 * defines, each successor faithfully restores the same bytes, and the write
 * that follows refreshes the key's TTL so it never ages out. Silent,
 * permanent, and invisible in every metric, because the room ticks at a
 * healthy rate the whole time. A version this build does not implement is a
 * checkpoint it cannot reason about in either direction, so it starts fresh,
 * which costs one room its in-progress state exactly once.
 *
 * The version is checked BEFORE the field types, so an envelope from a
 * version that dropped or renamed a field this one requires is reported as
 * the version change it is rather than as a malformed value.
 */
export function inspectCheckpoint(json: string | null): CheckpointInspection {
  if (json === null) return { ok: false, reason: 'absent', foundVersion: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'unparseable', foundVersion: null };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'malformed', foundVersion: null };
  }
  const candidate = parsed as Partial<CheckpointEnvelope>;
  if (typeof candidate.v !== 'number') {
    return { ok: false, reason: 'malformed', foundVersion: null };
  }
  if (candidate.v !== CHECKPOINT_VERSION) {
    return { ok: false, reason: 'version', foundVersion: candidate.v };
  }
  if (
    typeof candidate.tick !== 'number' ||
    typeof candidate.graceUntilTick !== 'number' ||
    typeof candidate.incarnation !== 'string' ||
    typeof candidate.body !== 'string'
  ) {
    return { ok: false, reason: 'malformed', foundVersion: candidate.v };
  }
  if (candidate.geom !== undefined && typeof candidate.geom !== 'string') {
    return { ok: false, reason: 'malformed', foundVersion: candidate.v };
  }
  // `gridAt` IS OPTIONAL AND ITS ABSENCE MOVES NO VERSION. The rule this file
  // states elsewhere is that a wire change bumps the version when it changes
  // MEANING, not merely SHAPE, and an ADDITIVE OPTIONAL field changes neither
  // for a reader that does not know about it: every field an older build reads
  // still means exactly what it meant, and a newer build reading an older
  // envelope simply finds the field absent and falls back to the behaviour it
  // already had. Bumping here would be strictly worse than not bumping, since
  // the bump itself is what wipes every live room in the fleet. The type check
  // is still exact, because a `gridAt` that is present and not a number would
  // propagate into grid arithmetic.
  if (candidate.gridAt !== undefined && typeof candidate.gridAt !== 'number') {
    return { ok: false, reason: 'malformed', foundVersion: candidate.v };
  }
  return {
    ok: true,
    envelope: {
      v: candidate.v,
      tick: candidate.tick,
      graceUntilTick: candidate.graceUntilTick,
      geom: candidate.geom,
      gridAt: candidate.gridAt,
      incarnation: candidate.incarnation,
      body: candidate.body,
    },
  };
}

/**
 * `inspectCheckpoint` for a caller with nothing useful to say about WHY:
 * the envelope, or `null` for a corrupt, malformed, absent, or
 * wrong-version value. Never throws.
 *
 * Prefer `inspectCheckpoint` anywhere the answer is going to be logged. A
 * start-fresh with no reason attached is the one thing an operator cannot
 * distinguish from an ordinary cold room, and a version change quietly
 * wiping every live room in the fleet is exactly the event that must not
 * look like one.
 */
export function unpackCheckpoint(json: string | null): CheckpointEnvelope | null {
  const inspected = inspectCheckpoint(json);
  return inspected.ok ? inspected.envelope : null;
}
