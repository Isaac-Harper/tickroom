import { describe, it, expect } from 'vitest';
import { SnapshotInterpolator, type SnapshotFrame } from './interpolation.js';

function frame(receivedAt: number, entities: Record<string, { x: number; y: number; heading?: number }>): SnapshotFrame<string> {
  return {
    receivedAt,
    serverTime: receivedAt,
    entities: new Map(Object.entries(entities)),
  };
}

describe('SnapshotInterpolator', () => {
  it('interpolates a midpoint between two frames', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 100, minDelayMs: 50, maxDelayMs: 200 });
    interp.push(frame(0, { a: { x: 0, y: 0 } }));
    interp.push(frame(200, { a: { x: 10, y: 0 } }));

    // Playback point is localClock - delayMs. Drive the local clock to 200ms
    // via nowMs so the playhead sits at 100ms, exactly between the frames.
    let out = interp.sample(0.05, 100); // seed clock at 100ms, delay still ramping from startDelayMs=100
    out = interp.sample(0.05, 200);
    // At clock=200, delay eased from 100 toward whatever the jitter target
    // is (no jitter samples yet since only 2 pushes with no third to confirm
    // a ring, so target stays at start); playhead ~= 200 - ~100 = ~100.
    const a = out.get('a');
    expect(a).toBeDefined();
    expect(a!.x).toBeGreaterThan(0);
    expect(a!.x).toBeLessThan(10);
    expect(a!.extrapolated).toBe(false);
  });

  it('extrapolates on underrun instead of freezing, and caps the extrapolation horizon', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250, extrapCapMs: 150 });
    interp.push(frame(0, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, { a: { x: 5, y: 0 } })); // velocity: 100 units/sec in x

    // Playhead way past the newest frame: a real gap/drop.
    const out = interp.sample(0.05, 50 + 50 + 1000); // clock way ahead, delay ~50ms
    const a = out.get('a');
    expect(a).toBeDefined();
    expect(a!.extrapolated).toBe(true);
    // Capped at 150ms of extrapolation from the newest frame at 100 units/sec => +15 units past x=5.
    expect(a!.x).toBeCloseTo(5 + 100 * 0.15, 5);
  });

  it('extrapolation never freezes: position keeps advancing (bounded) rather than sticking to the last confirmed pose', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250, extrapCapMs: 150 });
    interp.push(frame(0, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, { a: { x: 5, y: 0 } }));

    const early = interp.sample(0.05, 120); // playhead just past newest frame
    const later = interp.sample(0.05, 160); // playhead further past, still under the cap
    const xEarly = early.get('a')!.x;
    const xLater = later.get('a')!.x;
    expect(xLater).toBeGreaterThan(xEarly);
  });

  it('heading interpolates the shortest arc across the +-pi wrap', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250 });
    const near = Math.PI - 0.1;
    interp.push(frame(0, { a: { x: 0, y: 0, heading: near } }));
    interp.push(frame(100, { a: { x: 0, y: 0, heading: -near } })); // wraps the short way, through pi, not back through 0

    interp.sample(0.05, 0);
    const out = interp.sample(0.05, 50); // halfway
    const heading = out.get('a')!.heading!;
    // The short way from (pi - 0.1) to (-(pi - 0.1)) passes through +-pi, so
    // the midpoint heading's absolute value must stay large (near pi), not
    // collapse toward 0 (which is what a naive linear lerp would produce).
    expect(Math.abs(heading)).toBeGreaterThan(2.5);
  });

  it('the adaptive delay grows under injected jitter and stays clamped to [min,max]', () => {
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 80, maxDelayMs: 250, startDelayMs: 80 });
    let t = 0;
    // Feed a sequence of increasingly jittery gaps (some tight, some wide) so
    // the p95-ish target climbs well above the 80ms floor.
    const gaps = [40, 220, 45, 230, 50, 240, 48, 235, 47, 245];
    for (const g of gaps) {
      t += g;
      interp.push(frame(t, { a: { x: 0, y: 0 } }));
      interp.sample(g / 1000, t);
    }
    expect(interp.delayMs).toBeGreaterThan(80);
    expect(interp.delayMs).toBeLessThanOrEqual(250);
  });

  it('the adaptive delay never exceeds maxDelayMs even under extreme jitter', () => {
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 80, maxDelayMs: 200, startDelayMs: 80 });
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const gap = 900; // huge, consistent gap
      t += gap;
      interp.push(frame(t, { a: { x: 0, y: 0 } }));
      interp.sample(1.0, t);
    }
    expect(interp.delayMs).toBeLessThanOrEqual(200);
  });

  it('an entity unseen past dropAfterMs is forgotten', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250, dropAfterMs: 500 });
    interp.push(frame(0, { a: { x: 0, y: 0 } }));
    interp.sample(0.05, 10);
    let out = interp.sample(0.05, 100);
    expect(out.has('a')).toBe(true);

    out = interp.sample(0.05, 700); // past dropAfterMs since the entity was last seen at t=0
    expect(out.has('a')).toBe(false);
  });

  it('forget() removes an entity immediately', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250 });
    interp.push(frame(0, { a: { x: 0, y: 0 } }));
    interp.sample(0.05, 10);
    interp.forget('a');
    const out = interp.sample(0.05, 20);
    expect(out.has('a')).toBe(false);
  });

  it('measures a low-passed speed from its own rendered motion', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250, speedTau: 0.12 });
    for (let i = 0; i <= 10; i++) {
      interp.push(frame(i * 50, { a: { x: i * 5, y: 0 } })); // 100 units/sec
    }
    let out: ReturnType<typeof interp.sample> | undefined;
    for (let i = 0; i < 10; i++) {
      out = interp.sample(0.05, 100 + i * 50);
    }
    const speed = out!.get('a')!.speed;
    expect(speed).toBeGreaterThan(50); // should be converging toward ~100
  });

  it('clear() resets frames, entities, and the adaptive delay', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 90, minDelayMs: 50, maxDelayMs: 250 });
    interp.push(frame(0, { a: { x: 0, y: 0 } }));
    interp.sample(0.05, 10);
    interp.clear();
    const out = interp.sample(0.05, 10);
    expect(out.size).toBe(0);
  });
});
