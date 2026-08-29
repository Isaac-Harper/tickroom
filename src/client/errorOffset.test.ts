import { describe, it, expect } from 'vitest';
import { ErrorOffset, type ErrorOffsetConfig } from './errorOffset.js';

const CONFIG: ErrorOffsetConfig = {
  posTau: 0.3,
  headingTau: 0.3,
  posCap: 40,
  headingCap: Math.PI,
  posMaxStep: 0.15,
  headingMaxStep: 0.2,
};

describe('ErrorOffset', () => {
  it('absorb then repeated sample converges toward zero', () => {
    const eo = new ErrorOffset(CONFIG);
    eo.absorb({ x: 3, z: -2, heading: 0.5 });
    let last = eo.magnitude();
    for (let i = 0; i < 400; i++) {
      eo.sample(0.05);
      const mag = eo.magnitude();
      expect(mag).toBeLessThanOrEqual(last + 1e-9);
      last = mag;
    }
    expect(last).toBeLessThan(0.01);
    expect(Math.abs(eo.current().heading)).toBeLessThan(0.01);
  });

  it('never moves more than posMaxStep in a single sample, even on a huge offset and a long frame', () => {
    const eo = new ErrorOffset(CONFIG);
    eo.absorb({ x: 35, z: 0, heading: 0 });
    for (let i = 0; i < 50; i++) {
      const before = eo.current();
      eo.sample(1.0); // a full second in one frame: deliberately large
      const after = eo.current();
      const moved = Math.hypot(after.x - before.x, after.z - before.z);
      expect(moved).toBeLessThanOrEqual(CONFIG.posMaxStep + 1e-9);
      if (Math.hypot(after.x, after.z) < 1e-6) break;
    }
  });

  it('never moves more than headingMaxStep in a single sample', () => {
    const eo = new ErrorOffset(CONFIG);
    eo.absorb({ x: 0, z: 0, heading: 3 });
    for (let i = 0; i < 50; i++) {
      const before = eo.current().heading;
      eo.sample(1.0);
      const after = eo.current().heading;
      const moved = Math.abs(after - before);
      expect(moved).toBeLessThanOrEqual(CONFIG.headingMaxStep + 1e-9);
    }
  });

  it('heading takes the shortest arc across the +-pi wrap', () => {
    const eo = new ErrorOffset({ ...CONFIG, headingCap: 10 });
    // absorbing a delta near +pi then another near +pi should wrap toward a
    // small combined value (close to 0), not toward a large 2*pi-ish one.
    eo.absorb({ x: 0, z: 0, heading: Math.PI - 0.1 });
    eo.absorb({ x: 0, z: 0, heading: Math.PI - 0.1 });
    const h = eo.current().heading;
    expect(Math.abs(h)).toBeLessThan(0.5);
  });

  it('posCap clamps the accumulated magnitude', () => {
    const eo = new ErrorOffset(CONFIG);
    eo.absorb({ x: 1000, z: 0, heading: 0 });
    expect(eo.magnitude()).toBeCloseTo(CONFIG.posCap, 6);
  });

  it('headingCap clamps the accumulated heading magnitude', () => {
    const eo = new ErrorOffset({ ...CONFIG, headingCap: 0.4 });
    eo.absorb({ x: 0, z: 0, heading: 10 });
    expect(Math.abs(eo.current().heading)).toBeLessThanOrEqual(0.4 + 1e-9);
  });

  it('reset drops the offset instantly with no glide', () => {
    const eo = new ErrorOffset(CONFIG);
    eo.absorb({ x: 5, z: 5, heading: 1 });
    eo.reset();
    expect(eo.current()).toEqual({ x: 0, z: 0, heading: 0 });
  });

  it('sample with dt=0 is a no-op', () => {
    const eo = new ErrorOffset(CONFIG);
    eo.absorb({ x: 5, z: 0, heading: 0 });
    const before = eo.current();
    const out = eo.sample(0);
    expect(out).toEqual(before);
  });

  it('a large absorb composes correctly under the cap rather than silently discarding', () => {
    const eo = new ErrorOffset(CONFIG);
    eo.absorb({ x: 10, z: 0, heading: 0 });
    eo.absorb({ x: 5, z: 0, heading: 0 });
    expect(eo.magnitude()).toBeCloseTo(15, 6);
  });
});
