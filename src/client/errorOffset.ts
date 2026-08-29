// The render-layer error smoother.
//
// THE CENTRAL IDEA, and the reason this file exists apart from whatever calls
// it: A CORRECTION NEVER MOVES THE SIMULATED POSE. When the local prediction
// (an owned entity's client-side simulation, run ahead of the server for zero
// perceived input lag) diverges from the authoritative state past some
// deadband, the caller has two options. It can drag the simulation toward the
// server every tick (the naive approach), which means the simulation the
// player is steering keeps getting nudged by a hand that is not theirs, and
// every nudge is a visible jitter. Or it can adopt the corrected state into the
// simulation IN FULL, right now, and push the equal-and-opposite delta into an
// `ErrorOffset` instead. The RENDERED pose (simulated position plus this
// offset) is then exactly what it was the instant before the jump, so nothing
// pops on screen; the offset then bleeds itself down to zero over a few
// hundred milliseconds, and the render converges onto the (now correct)
// simulation without the player ever seeing the correction happen.
//
// This is what turns a multi-second network dropout, a reconnect, or a
// server-authoritative correction after a collision into an imperceptible
// glide instead of a teleport. It is deliberately entity-agnostic: it knows
// nothing about physics, players, or games, only a position and a heading.

/**
 * A 2D offset. `z` is simply "the second axis": a 3D host maps it to world z,
 * a 2D host maps it to screen y. Nothing in this file cares which.
 */
export interface Offset {
  x: number;
  z: number;
  /** Radians. Wrapped to (-pi, pi] by every operation that touches it, so it never accumulates winding. */
  heading: number;
}

/** Convenience alias for a 2D caller; the shape is identical, only the mental model of the second axis differs. */
export type Offset2D = Offset;

export interface ErrorOffsetConfig {
  /** Exponential decay time constant for position, seconds. Smaller decays faster. */
  posTau: number;
  /** Exponential decay time constant for heading, seconds. */
  headingTau: number;
  /** Hard clamp on the accumulated position magnitude. A correction larger than this (a catastrophic desync, not an ordinary one) should be handled by resetting and snapping instead of absorbing it here; see `reset()`. */
  posCap: number;
  /** Hard clamp on the accumulated heading magnitude, radians. */
  headingCap: number;
  /** Per-frame cap on how far `sample` may move the position offset, in the same units as position. This is what makes a LARGE offset glide in at a bounded, comfortable velocity instead of front-loading the whole exponential step into a single frame (which is indistinguishable from the original snap on a slow frame). */
  posMaxStep: number;
  /** Per-frame cap on how far `sample` may move the heading offset, radians. */
  headingMaxStep: number;
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function clampMagnitude(x: number, z: number, cap: number): { x: number; z: number } {
  const mag = Math.hypot(x, z);
  if (mag <= cap || mag === 0) return { x, z };
  const k = cap / mag;
  return { x: x * k, z: z * k };
}

/**
 * Holds one entity's accumulated render error and decays it over time.
 * Stateful and mutated in place by design: a caller owns one instance per
 * entity it renders (typically just the locally-predicted one; remotes are
 * smoothed by interpolation instead, see `interpolation.ts`) and calls
 * `sample` once per rendered frame.
 */
export class ErrorOffset {
  private offset: Offset = { x: 0, z: 0, heading: 0 };
  private readonly config: ErrorOffsetConfig;

  constructor(config: ErrorOffsetConfig) {
    this.config = config;
  }

  /**
   * Fold a newly discovered error into the accumulated offset. Called the
   * instant the caller adopts a corrected simulation state: `delta` is the
   * OLD simulated pose minus the NEW (corrected) one, i.e. exactly what must
   * be added to the corrected pose to keep the rendered pose unchanged this
   * frame. Clamped to `posCap`/`headingCap` so a single wild correction
   * cannot make the render camera swing wide; a correction that large should
   * be resolved with `reset()` (an instant, deliberate snap) instead of being
   * absorbed and bled out here.
   */
  absorb(delta: Offset): void {
    const nx = this.offset.x + delta.x;
    const nz = this.offset.z + delta.z;
    const clamped = clampMagnitude(nx, nz, this.config.posCap);
    const nh = wrapAngle(this.offset.heading + delta.heading);
    const headingClamped = Math.max(-this.config.headingCap, Math.min(this.config.headingCap, nh));
    this.offset = { x: clamped.x, z: clamped.z, heading: headingClamped };
  }

  /** Drop the accumulated offset instantly with no glide. For the rare correction that is deliberately a snap (a catastrophic desync past every deadband) rather than something to smooth. */
  reset(): void {
    this.offset = { x: 0, z: 0, heading: 0 };
  }

  /** The offset as it stands right now, without advancing time. */
  current(): Offset {
    return { ...this.offset };
  }

  /** `hypot(x, z)`, for a caller that wants a scalar to log or gate diagnostics on rather than the full vector. */
  magnitude(): number {
    return Math.hypot(this.offset.x, this.offset.z);
  }

  /**
   * Advance time by `dt` seconds and return the offset to add to the
   * simulated pose this frame. Exponential decay (`1 - exp(-dt / tau)` of the
   * remaining distance) is the natural shape for "this error should shrink
   * proportionally to how much of it is left", but taken by itself it would
   * apply almost the whole step in one large frame (a tab regaining focus, a
   * GC pause), which reproduces exactly the pop this class exists to hide.
   * The per-frame step is therefore capped at `posMaxStep`/`headingMaxStep`
   * (or the override passed here), so a big offset glides in at a bounded,
   * perceptually smooth rate over however many frames it needs, rather than
   * snapping the moment a slow frame gives the exponential room to.
   */
  sample(dt: number, posMaxStep?: number, headingMaxStep?: number): Offset {
    const { posTau, headingTau } = this.config;
    const posCapStep = posMaxStep ?? this.config.posMaxStep;
    const headCapStep = headingMaxStep ?? this.config.headingMaxStep;

    if (dt > 0) {
      const posDecay = 1 - Math.exp(-dt / posTau);
      let stepX = -this.offset.x * posDecay;
      let stepZ = -this.offset.z * posDecay;
      const stepMag = Math.hypot(stepX, stepZ);
      const maxStep = posCapStep;
      if (stepMag > maxStep && stepMag > 0) {
        const k = maxStep / stepMag;
        stepX *= k;
        stepZ *= k;
      }
      this.offset = {
        x: this.offset.x + stepX,
        z: this.offset.z + stepZ,
        heading: this.offset.heading,
      };

      const headDecay = 1 - Math.exp(-dt / headingTau);
      let stepH = -this.offset.heading * headDecay;
      stepH = Math.max(-headCapStep, Math.min(headCapStep, stepH));
      this.offset = {
        ...this.offset,
        heading: wrapAngle(this.offset.heading + stepH),
      };
    }

    return this.current();
  }
}
