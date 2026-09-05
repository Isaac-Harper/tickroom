// The PURE half of the checkpoint: the envelope grammar and the one
// derivation read off it. The gzip and Redis half is tested in
// `src/server/checkpoint.test.ts`; this file deliberately imports no Node
// builtin at all, because it covers a module the core barrel exports and the
// core barrel is bundled for the browser (see `src/client/bundling.test.ts`).
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_VERSION, graceMsFromCheckpoint, inspectCheckpoint, packCheckpoint, unpackCheckpoint } from './checkpoint.js';
import type { CheckpointEnvelope } from './types.js';

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

// `gridAt` carries the SCHEDULED GRID TIME of the tick a checkpoint describes,
// so a successor continues its predecessor's timeline instead of restarting it
// at its own clock. See `CheckpointEnvelope.gridAt` for what the restart costs
// a client, and `server/ticker.ts` for the one-tick window that decides
// whether continuing is safe.
describe('gridAt is optional and additive, so it moves no version', () => {
  it('round-trips when present', () => {
    const env = envelope({ gridAt: 1_700_000_000_123 });
    expect(unpackCheckpoint(packCheckpoint(env))?.gridAt).toBe(1_700_000_000_123);
  });

  it('an envelope written before the field existed still restores, with gridAt undefined', () => {
    // THE WHOLE REASON THE FIELD IS OPTIONAL. A build that adds a field and
    // bumps the version wipes every live room in the fleet on deploy; an
    // additive optional field changes the SHAPE and not the MEANING of
    // anything an older reader looks at, so both directions keep working and
    // the bump would be strictly worse than not bumping.
    const older = JSON.stringify({
      v: CHECKPOINT_VERSION,
      tick: 42,
      graceUntilTick: 0,
      incarnation: 'inc',
      body: '{}',
    });
    const restored = unpackCheckpoint(older);
    expect(restored).not.toBeNull();
    expect(restored?.tick).toBe(42);
    expect(restored?.gridAt).toBeUndefined();
  });

  it('a present-but-not-a-number gridAt is malformed, not silently carried', () => {
    // It would otherwise propagate straight into the successor's grid
    // arithmetic, where a NaN makes every comparison false and the window
    // check silently stops meaning anything.
    const bad = JSON.stringify({ ...envelope(), gridAt: 'soon' });
    expect(inspectCheckpoint(bad)).toEqual({ ok: false, reason: 'malformed', foundVersion: CHECKPOINT_VERSION });
  });

  it('adding it did not move CHECKPOINT_VERSION', () => {
    expect(CHECKPOINT_VERSION).toBe(1);
  });
});

describe('the version check, which used to be documented and not performed', () => {
  // THE FAILURE THIS PREVENTS IS THE GEOMETRY-DIGEST ONE, REACHED THROUGH A
  // DIFFERENT DOOR. A checkpoint whose `v` this build does not implement is
  // one it cannot reason about, and restoring it anyway means the room keeps
  // simulating something the deployment no longer defines, every successor
  // faithfully restores the same bytes, and the write that follows refreshes
  // the key's TTL so it never ages out. Silent, permanent, and invisible in
  // every metric, because the room ticks at a healthy rate throughout.

  it('refuses a NEWER version, which this build cannot know the fields of', () => {
    const json = packCheckpoint(envelope({ v: CHECKPOINT_VERSION + 1 }));
    expect(unpackCheckpoint(json)).toBeNull();
    expect(inspectCheckpoint(json)).toEqual({
      ok: false,
      reason: 'version',
      foundVersion: CHECKPOINT_VERSION + 1,
    });
  });

  it('refuses an OLDER version too, which is the dangerous direction because it PARSES', () => {
    // Every field is present and every type checks out, so nothing else in
    // this module would have stopped it: an envelope from a version whose
    // `tick` counted something different, or whose `body` meant something
    // different, is restored in full and simulated happily.
    const json = packCheckpoint(envelope({ v: CHECKPOINT_VERSION - 1 }));
    expect(unpackCheckpoint(json)).toBeNull();
    expect(inspectCheckpoint(json)).toEqual({
      ok: false,
      reason: 'version',
      foundVersion: CHECKPOINT_VERSION - 1,
    });
  });

  it('CONTROL: the current version still round-trips, so the refusal is not blanket', () => {
    const env = envelope({ v: CHECKPOINT_VERSION, geom: 'abc' });
    expect(unpackCheckpoint(packCheckpoint(env))).toEqual(env);
  });

  it('reports the version BEFORE the field types, so a dropped field reads as the version change it is', () => {
    // A version that renamed or removed a field this one requires would
    // otherwise be reported as 'malformed', which sends an operator looking
    // for corruption instead of at the deploy that just went out.
    const json = JSON.stringify({ v: CHECKPOINT_VERSION + 1, tick: 5 });
    expect(inspectCheckpoint(json)).toMatchObject({ reason: 'version', foundVersion: CHECKPOINT_VERSION + 1 });
  });

  it('a version that is not a number at all is malformed, not a version change', () => {
    expect(inspectCheckpoint(JSON.stringify({ ...envelope(), v: 'one' }))).toMatchObject({ reason: 'malformed' });
  });

  it('distinguishes every reason a start-fresh can happen', () => {
    // The whole point of the discriminator: "there was nothing there" and
    // "there was something this build cannot read" produce the identical
    // fresh room and are completely different events.
    expect(inspectCheckpoint(null)).toMatchObject({ reason: 'absent' });
    expect(inspectCheckpoint('not json{{')).toMatchObject({ reason: 'unparseable' });
    expect(inspectCheckpoint('[]')).toMatchObject({ reason: 'malformed' });
    expect(inspectCheckpoint(JSON.stringify({ ...envelope(), tick: 'nope' }))).toMatchObject({ reason: 'malformed' });
    expect(inspectCheckpoint(packCheckpoint(envelope({ v: 99 })))).toMatchObject({ reason: 'version' });
  });

  it('graceMsFromCheckpoint reads 0 through the same refusal, never a grace off a version it cannot parse', () => {
    const json = packCheckpoint(envelope({ v: 99, tick: 100, graceUntilTick: 200 }));
    expect(graceMsFromCheckpoint(json, 50, 500)).toBe(0);
  });
});

describe('graceMsFromCheckpoint', () => {
  const tickMs = 50; // 20Hz
  const slackMs = 500;

  it('returns 0 for a null checkpoint', () => {
    expect(graceMsFromCheckpoint(null, tickMs, slackMs)).toBe(0);
  });

  it('returns 0 when there is no in-progress grace', () => {
    // EXACTLY AT THE CUTOFF, which is the only value that separates
    // `remainingTicks <= 0` from `< 0`. This case used to drive
    // `graceUntilTick: 0` against tick 100, i.e. a grace 100 ticks in the
    // past, which is the already-expired case below and leaves the boundary
    // itself untested: a grace ending on this very tick has nothing left to
    // run, so it must report 0 rather than one slack window of protection
    // nobody's simulation is honouring.
    const json = packCheckpoint(envelope({ tick: 100, graceUntilTick: 100 }));
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

  it('returns 0 for unparseable JSON rather than throwing', () => {
    expect(() => graceMsFromCheckpoint('garbage', tickMs, slackMs)).not.toThrow();
    expect(graceMsFromCheckpoint('garbage', tickMs, slackMs)).toBe(0);
  });
});
