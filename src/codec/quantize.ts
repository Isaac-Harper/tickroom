// Fixed-point quantization: packing a float into a small integer field for
// the wire, and back. Every entity in a snapshot pays this cost once per
// tick per player, so the field width is not a taste choice, it is a
// bandwidth budget: pick the smallest integer type that covers your world's
// real range plus a little headroom, not the widest one "to be safe".

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
 */
export function quantize(v: number, scale: number, min: number, max: number): number {
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

// One metre = 100 centimetres. A signed i16 at this scale spans -327.67m to
// +327.67m, which covers essentially any game world's play area at a
// precision (1cm) far finer than a player can perceive as jitter, for 2 bytes
// per axis instead of 4 or 8 for a raw float.
const CM_SCALE = 100;

/** Metres to centimetre-precision `i16`. Range is +-327.67m; values further out clamp to that boundary rather than wrapping (see `quantize`). */
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
 */
export function quantizeAngle(rad: number): number {
  let normalized = rad % TWO_PI;
  if (normalized < 0) normalized += TWO_PI;
  return quantize(normalized, TURN_SCALE, U16.min, U16.max);
}

/** Inverse of `quantizeAngle`. Always returns a value in `[0, 2*PI)`; a caller wanting a signed `(-PI, PI]` range subtracts `2*PI` when the result exceeds `PI`. */
export function dequantizeAngle(q: number): number {
  return dequantize(q, TURN_SCALE);
}
