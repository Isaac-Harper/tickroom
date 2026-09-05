// Measures the whole point of codec.ts: this is not a worked example unless
// the numbers it promises are checked, not just asserted in a comment.

import { describe, it, expect } from 'vitest';
import { pongRuntime, type PongState } from './sim.js';
import { PONG_PROTOCOL_VERSION, encodePongSnapshot, decodePongSnapshot } from './codec.js';
import { CodecError } from '../../src/codec/index.js';

const DT = 1 / pongRuntime.tickHz;
const SERVER_TIME = 1_700_000_000_123.456;

/** The playout depth the ticker would have reported for each player on the
 *  tick this snapshot is taken. Nonzero on purpose: a state where
 *  `onBufferHealth` never fired encodes an `inputLead` of 0 for everyone,
 *  which round-trips perfectly whether the field is carried or dropped. */
const DEPTHS: Record<string, number> = { playerOne: 3, playerTwo: 2 };

/** Two players, mid-game: nonzero ball velocity, paddles off their spawn
 *  y, at least one plausible score, and a live playout depth per player. A
 *  snapshot of two rooms sitting at their spawn defaults would round-trip
 *  fine and still tell you nothing about whether the codec handles a real,
 *  moving game. */
function realisticTwoPlayerState(): PongState {
  const s = pongRuntime.create('bench-room');
  pongRuntime.join(s, 'playerOne');
  pongRuntime.join(s, 'playerTwo');
  for (let i = 0; i < 80; i++) {
    pongRuntime.applyInput(s, 'playerOne', { seq: i, data: { dir: Math.sin(i * 0.3) } });
    pongRuntime.applyInput(s, 'playerTwo', { seq: i, data: { dir: Math.cos(i * 0.4) } });
    pongRuntime.tick(s, DT);
  }
  // The ticker reports this every tick, including starved ones; what a
  // snapshot carries is whatever the most recent report left in state.
  for (const [pid, depth] of Object.entries(DEPTHS)) {
    pongRuntime.onBufferHealth!(s, pid, depth);
  }
  return s;
}

// Computed once, at module load, so the measured byte counts can be quoted
// directly in a test title below. The whole point of this file is to make
// the size difference something a reader of the test output SEES, not
// something they have to take on faith from a comment in codec.ts.
const BENCH_STATE = realisticTwoPlayerState();
const JSON_BYTES = Buffer.byteLength(pongRuntime.encodeSnapshot(BENCH_STATE, SERVER_TIME) as string);
const BINARY_BYTES = encodePongSnapshot(BENCH_STATE, SERVER_TIME).byteLength;

describe('pong: binary codec', () => {
  it('round-trips a realistic two-player game state within quantisation tolerance', () => {
    const s = realisticTwoPlayerState();
    const buf = encodePongSnapshot(s, SERVER_TIME);
    const decoded = decodePongSnapshot(buf);

    expect(decoded.version).toBe(PONG_PROTOCOL_VERSION);
    expect(decoded.tick).toBe(s.tick);
    expect(decoded.serverTime).toBe(SERVER_TIME);
    // Within one quantisation step (1/100 of a unit), not bit-exact: that
    // precision-for-size trade is the entire reason this file exists.
    expect(decoded.ball.x).toBeCloseTo(s.ball.x, 1);
    expect(decoded.ball.y).toBeCloseTo(s.ball.y, 1);
    expect(decoded.serveIn).toBe(s.serveIn);
    expect(decoded.winner).toBe(s.winner);
    expect(decoded.paddles).toHaveLength(2);
    for (const original of s.paddles.values()) {
      const found = decoded.paddles.find((p) => p.pid === original.pid);
      expect(found).toBeDefined();
      expect(found!.side).toBe(original.side);
      expect(found!.score).toBe(original.score);
      expect(found!.y).toBeCloseTo(original.y, 1);
      // Exact, not close: the depth is a whole number of ticks and rides an
      // untouched u8, so a quantisation tolerance here would hide a dropped
      // or mis-offset byte rather than measure a trade.
      expect(found!.inputLead).toBe(s.depth.get(original.pid));
    }
  });

  it('rejects a mismatched protocol version before reading a single field of the body', () => {
    const buf = encodePongSnapshot(realisticTwoPlayerState(), SERVER_TIME);
    const mismatched = new Uint8Array(buf);
    mismatched[0] = PONG_PROTOCOL_VERSION + 1;

    // If the version check ran after the body instead of before, this would
    // either succeed with garbage fields or throw a bounds error from
    // stumbling onto a field boundary at the wrong offset instead of the
    // deliberate, immediate, explicitly-worded throw this asserts.
    expect(() => decodePongSnapshot(mismatched)).toThrow(CodecError);
    expect(() => decodePongSnapshot(mismatched)).toThrow(/version mismatch/);
  });

  it('throws CodecError on a truncated buffer rather than returning a half-decoded snapshot', () => {
    const buf = encodePongSnapshot(realisticTwoPlayerState(), SERVER_TIME);
    // Cut it off mid-header, well before any paddle data, so a decoder that
    // did not bounds-check would read whatever bytes happen to follow the
    // buffer as if they were serverTime or a ball coordinate.
    const truncated = buf.slice(0, 5);
    expect(() => decodePongSnapshot(truncated)).toThrow(CodecError);
  });

  it(`the binary snapshot is materially smaller than the JSON one (json=${JSON_BYTES}B, binary=${BINARY_BYTES}B, ${(JSON_BYTES / BINARY_BYTES).toFixed(2)}x smaller)`, () => {
    expect(BINARY_BYTES).toBeLessThanOrEqual(JSON_BYTES / 2);
  });
});
