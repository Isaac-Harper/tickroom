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
} from './quantize.js';

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
});
