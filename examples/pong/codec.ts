// The binary upgrade path for pong's snapshot, worked all the way through.
//
// sim.ts encodes its snapshot as JSON, deliberately, because it is the thing
// a beginner should read first: every field name is right there in the
// bytes. JSON is not what you ship, though, and the README says so plainly:
// a snapshot is published once per tick and delivered once PER PLAYER
// (RoomStats.bytesDelivered measures exactly that), so it is the single
// largest bandwidth line in the whole system.
//
// DO NOT MAKE THIS SWITCH ON DAY ONE. Measure `bytesDelivered` first. A room
// that never gets past two players sending a few hundred bytes a second has
// nothing to gain here and a hand-rolled binary layout to maintain instead.
// The switch earns its keep once bytesPublished * players starts showing up
// as a real number: a full 20-player room publishing this snapshot at 20Hz
// multiplies whatever encodeSnapshot returns by 20 subscribers, every tick,
// forever, and that is the number a managed Redis plan bills bandwidth on.
//
// Nothing about the runtime changes to adopt this. `RoomRuntime.encodeSnapshot`
// may return a `Uint8Array` exactly as easily as a string; only the function
// wired into the ticker's config changes.

import { ByteWriter, ByteReader, CodecError, quantize, dequantize, I16 } from '../../src/codec/index.js';
import type { PongState } from './sim.js';

/**
 * `PROTOCOL_VERSION` MUST BE COMPARED BEFORE ANY OTHER FIELD IS READ, and
 * that ordering is what makes a rolling deploy safe. A serverless platform
 * splits traffic across old and new code for the length of a deploy: some
 * relays are still running yesterday's ticker, some clients still have
 * yesterday's bundle cached, and for that whole window a mismatched pair can
 * meet on the wire. If the decoder read fields optimistically and only
 * checked the version as an afterthought, a version-10 payload arriving at a
 * version-9 decoder would not fail, it would MISREAD: whatever byte offset
 * used to be `score` might now be the low byte of a wider `tick`, and every
 * field after the first divergence comes out as plausible-looking garbage
 * rather than an error. Checking first turns that into a clean, immediate
 * throw, before a single byte of the mismatched body is touched.
 */
export const PONG_PROTOCOL_VERSION = 1;

export interface DecodedPongPaddle {
  pid: string;
  side: 'left' | 'right';
  y: number;
  score: number;
}

export interface DecodedPongSnapshot {
  version: number;
  tick: number;
  serverTime: number;
  ball: { x: number; y: number };
  serveIn: number;
  winner: string | null;
  paddles: DecodedPongPaddle[];
}

// Ball and paddle y both live in the same coordinate family (pong's field is
// 200x120 arbitrary units, not metres; see sim.ts), so one scale serves both.
//
// PICKED DELIBERATELY, not defaulted. An i16 has 65536 distinct values; the
// question is only where the decimal point goes. At this scale (100 steps
// per unit, i.e. 0.01-unit precision) the full i16 range covers -327.68 to
// +327.67 units. Against a 200-wide, 120-tall field that is more than 60%
// of extra room on every single edge: enough to absorb a ball's one-tick
// overshoot past a wall (the sim reflects it back in bounds on the SAME
// tick, but a snapshot encoded from a half-stepped intermediate state, or a
// future physics tweak that overshoots slightly more, should not need a
// wire change to stay representable) or a paddle graze at y=0.
const POS_SCALE = 100;

function quantizePos(v: number): number {
  return quantize(v, POS_SCALE, I16.min, I16.max);
}

function dequantizePos(q: number): number {
  return dequantize(q, POS_SCALE);
}

// CLAMP, NEVER WRAP. If a future change ever lets the ball's position exceed
// the i16 range above (a field resize, a physics bug that lets it run away),
// `quantize` pins it at the boundary rather than wrapping the sign bit. A
// pinned ball reads as "stuck against a wall", which is a visible but sane
// failure; a wrapped one teleports to the opposite edge of the field, which
// reads as a catastrophic desync and is the kind of bug a player screenshots.
// This is inherited for free from `quantize` in src/codec/quantize.ts: the
// point of naming it here is that it is not optional to remember, it is
// already the only behaviour this function has.

const SIDE_LEFT = 0;
const SIDE_RIGHT = 1;

// The paddle array position a player's pid sits at is not a stable id (two
// players who both leave and a third who joins could shift it), so the
// winner is stored as an index into THIS SNAPSHOT'S OWN paddle list, valid
// only for decoding this one buffer, never as a saved reference. 0xff is the
// sentinel because paddleCount is a u8 and 2 is the realistic count (pong is
// two players, `isFull` says so), so 255 is never a real index.
const NO_WINNER = 0xff;

/**
 * Encode a pong snapshot as bytes instead of JSON. Called once per tick, same
 * as `encodeSnapshot` in sim.ts; this is a straight swap of the return value,
 * not a different call site.
 *
 * Wire layout, all little-endian (see src/codec/bytes.ts):
 *
 *   header:  u8 version, u32 tick, f64 serverTime, i16 ballX, i16 ballY,
 *            u16 serveIn, u8 winnerIndex, u8 paddleCount
 *   paddle:  str pid (u16 length + utf8), u8 side, i16 y, u8 score
 *            ... repeated paddleCount times
 */
export function encodePongSnapshot(s: PongState, serverTimeMs: number): Uint8Array {
  const paddles = [...s.paddles.values()];
  const winnerIndex = s.winner === null ? NO_WINNER : paddles.findIndex((p) => p.pid === s.winner);

  const w = new ByteWriter();
  w.u8(PONG_PROTOCOL_VERSION);
  w.u32(s.tick);
  w.f64(serverTimeMs);
  w.i16(quantizePos(s.ball.x));
  w.i16(quantizePos(s.ball.y));
  w.u16(s.serveIn);
  // A winner whose pid somehow is not in the paddle list (should not happen;
  // winner is only ever set to a pid that just scored, and leave() does not
  // clear it) still has to produce a valid, bounded byte rather than a
  // negative index landing in the u8 write. NO_WINNER is the correct
  // fallback: a snapshot cannot express "the winner is someone not present".
  w.u8(winnerIndex < 0 ? NO_WINNER : winnerIndex);
  w.u8(paddles.length);
  for (const p of paddles) {
    w.str(p.pid);
    w.u8(p.side === 'left' ? SIDE_LEFT : SIDE_RIGHT);
    w.i16(quantizePos(p.y));
    w.u8(p.score);
  }
  return w.finish();
}

/**
 * The inverse of `encodePongSnapshot`. THE DECODER IS A TRUST BOUNDARY, same
 * as `decodeDefaultSnapshot` and `decodeInputWindow`: every accessor on
 * `ByteReader` bounds-checks and throws `CodecError` before it would read
 * past the end of the buffer, so a truncated or corrupt frame (a network
 * partial read, a client that races a reconnect and hands you half a
 * message) fails loudly and immediately here rather than silently returning
 * a snapshot with some paddles present and the rest read from garbage bytes,
 * which is a worse outcome than an exception a caller can catch and treat as
 * "drop this snapshot and wait for the next one".
 */
export function decodePongSnapshot(buf: ArrayBuffer | Uint8Array): DecodedPongSnapshot {
  const r = new ByteReader(buf);

  // See the comment on PONG_PROTOCOL_VERSION: this has to happen before any
  // other field is read, or a mismatched version does not fail, it misreads.
  const version = r.u8();
  if (version !== PONG_PROTOCOL_VERSION) {
    throw new CodecError(
      `pong snapshot version mismatch: decoder expects ${PONG_PROTOCOL_VERSION}, buffer says ${version}`
    );
  }

  const tick = r.u32();
  const serverTime = r.f64();
  const ballX = dequantizePos(r.i16());
  const ballY = dequantizePos(r.i16());
  const serveIn = r.u16();
  const winnerIndex = r.u8();
  const paddleCount = r.u8();

  const paddles: DecodedPongPaddle[] = [];
  for (let i = 0; i < paddleCount; i++) {
    const pid = r.str();
    const sideByte = r.u8();
    const y = dequantizePos(r.i16());
    const score = r.u8();
    paddles.push({ pid, side: sideByte === SIDE_LEFT ? 'left' : 'right', y, score });
  }

  // winnerIndex came off the wire, so it is exactly as untrusted as anything
  // else here: a corrupt buffer could carry an in-range-for-u8 value that is
  // out of range for the paddle array THIS buffer actually decoded. Read
  // through the array access itself (which is `DecodedPongPaddle | undefined`
  // under `noUncheckedIndexedAccess`, and genuinely can be `undefined`: an
  // out-of-bounds `winnerIndex` is exactly the corrupt-buffer case this guard
  // exists for, not a type-checker formality) rather than asserting the
  // bounds check already proved it defined, so a corrupt buffer resolves to
  // a null winner instead of silently propagating an `undefined` "pid".
  const winnerPaddle = winnerIndex !== NO_WINNER ? paddles[winnerIndex] : undefined;
  const winner = winnerPaddle ? winnerPaddle.pid : null;

  return { version, tick, serverTime, ball: { x: ballX, y: ballY }, serveIn, winner, paddles };
}
