// The PURE half of the checkpoint: the envelope grammar and the one
// derivation read off it. The gzip and Redis half is tested in
// `src/server/checkpoint.test.ts`; this file deliberately imports no Node
// builtin at all, because it covers a module the core barrel exports and the
// core barrel is bundled for the browser (see `src/client/bundling.test.ts`).
import { describe, expect, it } from 'vitest';
import { graceMsFromCheckpoint, packCheckpoint, unpackCheckpoint } from './checkpoint.js';
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

  it('returns 0 for unparseable JSON rather than throwing', () => {
    expect(() => graceMsFromCheckpoint('garbage', tickMs, slackMs)).not.toThrow();
    expect(graceMsFromCheckpoint('garbage', tickMs, slackMs)).toBe(0);
  });
});
