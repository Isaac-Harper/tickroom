// Fixed-point quantization: packing a float into a small integer field for
// the wire, and back. Every entity in a snapshot pays this cost once per
// tick per player, so the field width is not a taste choice, it is a
// bandwidth budget: pick the smallest integer type that covers your world's
// real range plus a little headroom, not the widest one "to be safe".

import { CodecError } from './bytes.js';

/**
 * Scales `v` by `scale`, rounds to the nearest integer, then CLAMPS into
 * `[min, max]`.
 *
 * CLAMPING RATHER THAN WRAPPING IS THE WHOLE POINT of this function and must
 * never be "simplified" into a bare cast or a modulo. An `i16` field that
 * WRAPS on overflow takes a position 0.01 past its positive limit and turns
 * it into the most negative value the field can hold: an entity standing at
 * the edge of the world teleports to the opposite edge, which reads as a
 * catastrophic desync and is exactly the kind of bug a player screenshots and
 * posts. The same out-of-range value CLAMPED merely pins the entity at the
 * boundary it already nearly reached, which reads as "pressed up against a
 * wall", i.e. correct-looking behaviour even when the encoder was handed a
 * value slightly outside what the field was sized for (a physics glitch, a
 * moment of numerical overshoot, a value from before a world resize). One of
 * these is a bug report; the other is a non-event.
 *
 * NaN IS REFUSED RATHER THAN CLAMPED. `NaN < min` and `NaN > max` are both
 * `false` (every comparison against NaN is), so the clamp above would fall
 * straight through to `return scaled` and hand a NaN to whatever writes it
 * onto the wire; `DataView.setInt16(NaN)` then stores 0, and a NaN position
 * teleports its entity to the world origin with no error anywhere. A NaN
 * cannot mean "far out of range" the way `Infinity` does (which this still
 * clamps to `max`, and `-Infinity` to `min`, exactly as before): there is no
 * direction to clamp NaN toward, so unlike an out-of-range but finite value,
 * letting it through is not a non-event, it is a simulation bug (a `0/0`, an
 * uninitialized field, a physics step that diverged) that has to be loud, the
 * same call this codec already makes for an out-of-range `CodecEntity.id`.
 */
export function quantize(v: number, scale: number, min: number, max: number): number {
  if (Number.isNaN(v)) {
    throw new CodecError('quantize: cannot encode NaN, which has no clamped or wrapped representation on the wire');
  }
  const scaled = Math.round(v * scale);
  if (scaled < min) return min;
  if (scaled > max) return max;
  return scaled;
}

/** The exact inverse of the scale (not the clamp, which is lossy by construction): `q / scale`. */
export function dequantize(q: number, scale: number): number {
  return q / scale;
}

export const I16 = { min: -32768, max: 32767 } as const;
export const U16 = { min: 0, max: 65535 } as const;

/**
 * The world-unit range a given `scale` can represent in a given integer
 * field, i.e. the exact interval outside which `quantize` starts CLAMPING.
 *
 * THIS EXISTS SO THE CLAMP CAN BE LOUD. Clamping is the right behaviour (see
 * `quantize`) but it is silent by construction: an encoder handed a value
 * past the boundary emits a perfectly well-formed snapshot with the wrong
 * number in it, and the only symptom is entities piling up against a wall
 * that is nowhere in the host's world definition. That reads as a snapping or
 * teleporting bug in the client, which is an expensive thing to chase. Call
 * this ONCE at startup with the scale you are encoding at and assert your
 * world's real bounds fit inside it, so a host whose coordinates are not
 * metres finds out at boot rather than in production:
 *
 * ```ts
 * const range = representableRange(1); // { min: -32768, max: 32767 }
 * if (worldWidth > range.max) throw new Error('world does not fit the wire');
 * ```
 *
 * Deliberately NOT a hook on the encode path. A per-value callback or counter
 * there runs once per entity per tick per player, which is a bandwidth and
 * CPU budget rather than a convenience; the question "does my world fit"
 * only has one answer per deploy, so it is asked once.
 */
export function representableRange(
  scale: number,
  field: { min: number; max: number } = I16
): { min: number; max: number } {
  return { min: dequantize(field.min, scale), max: dequantize(field.max, scale) };
}

// One metre = 100 centimetres. A signed i16 at this scale spans -327.68m to
// +327.67m at a precision (1cm) far finer than a player can perceive as
// jitter, for 2 bytes per axis instead of 4 or 8 for a raw float.
//
// THAT RANGE IS A CLAIM ABOUT METRES AND NOTHING ELSE. It covers essentially
// any game world's play area measured in metres, and it is far too small for
// a host whose coordinates are PIXELS or screen units, where 327 is a corner
// of the first screen rather than the far edge of the map. Such a host must
// not reach for `quantizeCm` at all: pass `positionScale` to
// `encodeDefaultSnapshot`/`decodeDefaultSnapshot` (a pixel host wants 1, for
// -32768 to +32767 pixels at 1px resolution), or call `quantize` directly
// with its own scale, and check the result of `representableRange` against
// its world bounds at startup.
export const CM_SCALE = 100;

/** Metres to centimetre-precision `i16`. Range is -327.68m to +327.67m (an `i16` is not symmetric); values further out clamp to that boundary rather than wrapping (see `quantize`). NOTE THE UNIT: a pixel-coordinate host wants `positionScale` on the default codec, not this. */
export function quantizeCm(metres: number): number {
  return quantize(metres, CM_SCALE, I16.min, I16.max);
}

export function dequantizeCm(q: number): number {
  return dequantize(q, CM_SCALE);
}

// A "binary angle": one full turn (2*PI radians) mapped onto the full range
// of a u16, i.e. 65536 equally spaced steps around the circle. That gives a
// resolution of 2*PI/65536 ~= 0.0000959 rad, comfortably finer than anything
// a rendered heading needs, in 2 bytes rather than 4 for a raw float radian.
const TURN_STEPS = 65536;
const TWO_PI = 2 * Math.PI;
const TURN_SCALE = TURN_STEPS / TWO_PI;

/**
 * An angle in radians to a `u16` turn value, PRECISION ~0.0001 rad.
 *
 * Normalizes into `[0, 2*PI)` before scaling, rather than clamping the raw
 * radian value the way `quantizeCm` clamps metres. An angle is inherently
 * circular: -0.01 rad and 2*PI - 0.01 rad are the SAME heading, and a caller
 * that has been accumulating a heading without ever wrapping it (a spinning
 * turntable, an unbounded yaw integrator) will hand this function values well
 * outside a single turn as a matter of course, not as an error case. Clamping
 * those to the nearest boundary would freeze every heading past one full
 * rotation at whatever the boundary angle is; wrapping (via `%`, with the
 * standard fix-up for JavaScript's sign-following `%` on negative operands)
 * instead maps every physically equivalent angle onto the same wire value,
 * which is the only definition of "correct" a circular quantity has.
 *
 * `+-Infinity` IS HANDLED EXPLICITLY, BEFORE THE MODULO, rather than being
 * let fall into `%` the way every finite value is. JavaScript defines
 * `Infinity % anything` (and `-Infinity % anything`) as `NaN`, so an
 * unbounded heading integrator (a yaw nobody ever wraps, run long enough to
 * overflow to infinity) would reach the modulo below, silently become NaN,
 * and land on `quantize`'s NaN guard, which is the wrong outcome here: an
 * infinite heading is the ordinary consequence of an integrator that was
 * never wrapped, not a `0/0`-shaped bug, so it gets the same non-throwing
 * clamp `quantize` already gives an out-of-range position, not a thrown
 * error. `+Infinity` clamps to the top of the u16 range and `-Infinity` to
 * the bottom, the same direction `quantize`'s own min/max clamp would pick if
 * it ever saw a value that large without the modulo turning it into NaN
 * first. An actual NaN heading (not an infinity in disguise) still reaches
 * `quantize` below and still throws, exactly as it should: see `quantize`'s
 * own NaN guard for why.
 */
export function quantizeAngle(rad: number): number {
  if (rad === Infinity) return U16.max;
  if (rad === -Infinity) return U16.min;
  let normalized = rad % TWO_PI;
  if (normalized < 0) normalized += TWO_PI;
  return quantize(normalized, TURN_SCALE, U16.min, U16.max);
}

/** Inverse of `quantizeAngle`. Always returns a value in `[0, 2*PI)`; a caller wanting a signed `(-PI, PI]` range subtracts `2*PI` when the result exceeds `PI`. */
export function dequantizeAngle(q: number): number {
  return dequantize(q, TURN_SCALE);
}
