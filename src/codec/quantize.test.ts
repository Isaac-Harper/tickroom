import { describe, it, expect } from 'vitest';
import {
  quantize,
  dequantize,
  I16,
  U16,
  quantizeCm,
  dequantizeCm,
  quantizeAngle,
  dequantizeAngle,
  representableRange,
  CM_SCALE,
} from './quantize.js';
import { CodecError } from './bytes.js';

describe('quantize / dequantize round trip within tolerance', () => {
  it('a plain value round-trips within the scale\'s resolution', () => {
    const q = quantize(3.14159, 1000, -1e9, 1e9);
    expect(dequantize(q, 1000)).toBeCloseTo(3.14159, 3);
  });

  it('quantizeCm / dequantizeCm round-trip to centimetre precision', () => {
    for (const metres of [0, 1.234, -1.234, 100, -100, -327.67, 327.67]) {
      const q = quantizeCm(metres);
      expect(dequantizeCm(q)).toBeCloseTo(metres, 2);
    }
  });

  it('quantizeCm rounds to the nearest centimetre', () => {
    expect(quantizeCm(1.006)).toBe(101); // 100.6cm rounds up to 101cm
    expect(quantizeCm(1.004)).toBe(100); // 100.4cm rounds down to 100cm
  });
});

describe('out-of-range values CLAMP rather than WRAP', () => {
  it('an absurdly large value pins at the max of the field, not a wrapped negative', () => {
    // This is the important case in this file. A wrapping implementation
    // would take a value far past I16.max and land it back near I16.min,
    // which is the exact "teleports to the opposite side of the world"
    // failure the module comment describes.
    const q = quantize(1_000_000, 1, I16.min, I16.max);
    expect(q).toBe(I16.max);
    expect(q).not.toBeLessThan(0);
  });

  it('an absurdly negative value pins at the min of the field, not a wrapped positive', () => {
    const q = quantize(-1_000_000, 1, I16.min, I16.max);
    expect(q).toBe(I16.min);
    expect(q).not.toBeGreaterThan(0);
  });

  it('quantizeCm clamps a position far outside the +-327.67m range', () => {
    expect(quantizeCm(10_000)).toBe(I16.max);
    expect(quantizeCm(-10_000)).toBe(I16.min);
    // The clamped value decodes back to the boundary, not to something
    // wildly different from the true (out-of-range) input.
    expect(dequantizeCm(quantizeCm(10_000))).toBeCloseTo(327.67, 2);
  });

  it('u16-scaled clamp never produces a negative output', () => {
    const q = quantize(-5, 1, U16.min, U16.max);
    expect(q).toBe(U16.min);
  });

  it('clamping is idempotent: clamping an already-clamped value changes nothing', () => {
    const once = quantize(1_000_000, 1, I16.min, I16.max);
    const twice = quantize(once, 1, I16.min, I16.max);
    expect(twice).toBe(once);
  });
});

describe('quantize refuses NaN rather than silently writing it to the wire', () => {
  it('throws CodecError on a NaN input', () => {
    // Before this guard, both clamp comparisons (`NaN < min`, `NaN > max`)
    // are false, so `quantize` fell through and returned NaN itself, and
    // `DataView.setInt16(NaN)` then stores 0: a NaN coordinate teleported its
    // entity to the world origin with no error anywhere.
    expect(() => quantize(NaN, CM_SCALE, I16.min, I16.max)).toThrow(CodecError);
  });

  it('still clamps +Infinity and -Infinity to the field boundary, same as any other out-of-range value', () => {
    // NaN and Infinity are not the same failure: Infinity has a direction to
    // clamp toward and this must not start throwing on it just because it
    // now throws on NaN.
    expect(quantize(Infinity, 1, I16.min, I16.max)).toBe(I16.max);
    expect(quantize(-Infinity, 1, I16.min, I16.max)).toBe(I16.min);
  });
});

describe('representableRange makes the silent clamp checkable at startup', () => {
  it('reports the centimetre default as the +-327 metre span quantizeCm documents', () => {
    const range = representableRange(CM_SCALE);
    expect(range.min).toBeCloseTo(-327.68, 6);
    expect(range.max).toBeCloseTo(327.67, 6);
  });

  it('reports a pixel host at scale 1 as +-32767 whole units', () => {
    const range = representableRange(1);
    expect(range.min).toBe(I16.min);
    expect(range.max).toBe(I16.max);
  });

  it('the reported bounds are exactly where quantize starts clamping', () => {
    // The bound is only useful if it is the true edge. Just inside it must
    // survive; just outside it must pin.
    const range = representableRange(CM_SCALE);
    expect(quantize(range.max, CM_SCALE, I16.min, I16.max)).toBe(I16.max);
    expect(quantize(range.max + 1, CM_SCALE, I16.min, I16.max)).toBe(I16.max);
    expect(quantize(range.min, CM_SCALE, I16.min, I16.max)).toBe(I16.min);
    expect(quantize(range.min - 1, CM_SCALE, I16.min, I16.max)).toBe(I16.min);
    expect(dequantize(quantize(range.max, CM_SCALE, I16.min, I16.max), CM_SCALE)).toBeCloseTo(
      range.max,
      6
    );
  });

  it('accepts a field other than the i16 default', () => {
    const range = representableRange(1, U16);
    expect(range.min).toBe(U16.min);
    expect(range.max).toBe(U16.max);
  });
});

describe('quantizeAngle wraps rather than clamps, correctly across +-pi', () => {
  it('-pi and +pi are the same heading and quantize identically', () => {
    expect(quantizeAngle(-Math.PI)).toBe(quantizeAngle(Math.PI));
  });

  it('a small negative angle wraps to just under a full turn, not to 0', () => {
    const q = quantizeAngle(-0.01);
    expect(q).toBeGreaterThan(60000); // near the top of the u16 range
  });

  it('an angle more than one full turn past zero wraps back onto the circle', () => {
    const base = quantizeAngle(0.5);
    const wrapped = quantizeAngle(0.5 + 2 * Math.PI);
    expect(wrapped).toBe(base);
  });

  it('an angle several full turns negative still wraps correctly', () => {
    const base = quantizeAngle(1.2);
    const wrapped = quantizeAngle(1.2 - 4 * Math.PI);
    expect(wrapped).toBe(base);
  });

  it('round-trips to within the documented ~0.0001 rad precision', () => {
    for (const rad of [0, 0.5, 1.5707963267948966, Math.PI - 0.001, 3, 6]) {
      const q = quantizeAngle(rad);
      const back = dequantizeAngle(q);
      // Compare on the circle: the decoded value is always in [0, 2*PI).
      const expected = ((rad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(Math.abs(back - expected)).toBeLessThan(0.0002);
    }
  });

  it('dequantizeAngle always returns a value in [0, 2*PI)', () => {
    expect(dequantizeAngle(0)).toBeGreaterThanOrEqual(0);
    expect(dequantizeAngle(U16.max)).toBeLessThan(2 * Math.PI);
  });

  it('throws CodecError on a NaN heading rather than silently landing on heading 0', () => {
    expect(() => quantizeAngle(NaN)).toThrow(CodecError);
  });

  it('clamps +Infinity to the top of the u16 range instead of misreading it as heading 0', () => {
    // `Infinity % TWO_PI` is NaN in JavaScript (measured), which used to
    // reach `quantize`'s fall-through and decode as heading 0: an entity
    // whose yaw integrator ran away to infinity read as "facing exactly
    // east" with no error. Infinity is handled before the modulo now, so it
    // clamps like any other out-of-range value instead of masquerading as a
    // NaN.
    expect(quantizeAngle(Infinity)).toBe(U16.max);
  });

  it('clamps -Infinity to the bottom of the u16 range', () => {
    expect(quantizeAngle(-Infinity)).toBe(U16.min);
  });
});
