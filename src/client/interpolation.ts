// The generic remote-entity smoother: this is the piece that makes OTHER
// players (or cursors, or anything you did not locally predict) look smooth
// despite network jitter, packet loss, and variable frame rate.
//
// The approach is buffered, delayed playback, not "snap to the newest
// packet". Every incoming snapshot is timestamped and buffered; playback runs
// a short distance BEHIND the most recent arrival, and each rendered frame
// interpolates between the two buffered snapshots that bracket the playback
// point. That short delay is what turns "a new position arrives every 50ms,
// jittering by +-30ms" into motion that reads as perfectly smooth: the
// interpolation always has two real, confirmed data points to blend between,
// rather than needing to guess where an entity is right now.
//
// THE ONE RULE THAT MATTERS MOST, and the one most likely to be "simplified"
// away by someone who has not watched the alternative: on an underrun (the
// playback point runs past the newest buffered snapshot, because a packet was
// late or lost), THE ENTITY MUST EXTRAPOLATE, NEVER FREEZE. A frozen entity
// that then teleports the instant new data arrives reads as far worse than one
// that drifts slightly off true for a moment and is gently corrected when the
// next snapshot lands. This module extrapolates by last-known velocity, capped
// at `EXTRAP_CAP_MS`, and that cap is what stops a long outage from sliding an
// entity arbitrarily far off the truth: past the cap it simply stops advancing
// rather than continuing to guess.

export const INTERP_START_MS = 100;
export const INTERP_MIN_MS = 80;
export const INTERP_MAX_MS = 250;

/** Per-second ease rate the adaptive delay approaches its jitter-derived target at. Not snapped, because a sudden delay change is itself a visible discontinuity: everything rendered through this interpolator would jump forward or back in time by the delta. */
export const INTERP_ADAPT_LAMBDA = 0.7;

/** How far past the newest confirmed snapshot an entity may extrapolate before it stops advancing and simply holds its last extrapolated pose. */
export const EXTRAP_CAP_MS = 150;

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * One entity's pose as carried in a snapshot. Free-form beyond position: a game
 * can attach anything (an anim state enum, a colour, a score) and it rides along
 * unmodified in the output; only x/y/heading are actually interpolated.
 *
 * DIMENSIONALITY, stated explicitly because readers arrive from both directions.
 * This interpolates a 2D position plus an optional heading, which is what a 2D
 * game, a cursor layer, or a map overlay wants directly. A 3D consumer maps its
 * GROUND PLANE onto x/y (the plane things move around on) and handles height
 * separately: either interpolate it itself, or carry it as one of the passthrough
 * fields above, which survives untouched. Height is usually the wrong thing to
 * blend anyway, since it is typically derived from the ground under an entity
 * rather than transmitted.
 */
export interface EntitySample {
  x: number;
  y: number;
  heading?: number;
  [k: string]: unknown;
}

export interface InterpolatedEntity extends EntitySample {
  /** Low-passed magnitude of this entity's own rendered motion, units/second. Measured from the interpolator's OWN output, not carried on the wire, because a coarse wire enum (walk/run/idle) cannot describe an entity mid-acceleration; this can. */
  speed: number;
  /** True this frame only if the playback point ran past the newest confirmed snapshot and this pose is a velocity-based guess rather than an interpolation between two confirmed points. */
  extrapolated: boolean;
}

export interface SnapshotFrame<K extends string | number = number> {
  /** Local clock (matching whatever clock `sample()`'s `nowMs` uses) at the moment this frame was received. This, not `serverTime`, is what playback is timed against: the local arrival clock is what the buffer and its delay actually operate on. */
  receivedAt: number;
  /** The server clock stamp carried in the snapshot. Not used for playback timing here; kept on the frame for a caller that wants to correlate entities against a server-clock event elsewhere. */
  serverTime: number;
  entities: Map<K, EntitySample>;
}

export interface InterpolatorOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  startDelayMs?: number;
  extrapCapMs?: number;
  /** Frames retained in the playback buffer. Must comfortably exceed `maxDelayMs` worth of frames at the expected snapshot rate, or the playback point falls off the buffer's old end on every snapshot; see the module-level warning in tickroom's docs about sizing this against the delay. */
  bufferCap?: number;
  /** An entity unseen in any pushed frame for this long is dropped from the output entirely. */
  dropAfterMs?: number;
  /** Time constant, seconds, for the per-entity speed low-pass. Short against a real acceleration, long against one frame of interpolation noise. */
  speedTau?: number;
}

interface EntityMotionState {
  x: number;
  y: number;
  speed: number;
  hasPrev: boolean;
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Shortest-arc heading lerp: a linear lerp across the +-pi wrap spins the long way round, which reads as an entity doing a full pirouette every time its heading crosses behind it. */
function lerpHeading(a: number, b: number, t: number): number {
  const delta = wrapAngle(b - a);
  return wrapAngle(a + delta * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class SnapshotInterpolator<K extends string | number = number> {
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly extrapCapMs: number;
  private readonly bufferCap: number;
  private readonly dropAfterMs: number;
  private readonly speedTau: number;

  private frames: SnapshotFrame<K>[] = [];
  private lastSeenAt = new Map<K, number>();
  private motion = new Map<K, EntityMotionState>();

  private localClockMs = 0;
  private clockInitialized = false;
  private lastPushReceivedAt: number | null = null;
  private jitterRing: number[] = [];
  private readonly jitterRingCap = 20;

  private currentDelayMs: number;
  private targetDelayMs: number;

  private underrunEma = 0;

  constructor(opts: InterpolatorOptions = {}) {
    this.minDelayMs = opts.minDelayMs ?? INTERP_MIN_MS;
    this.maxDelayMs = opts.maxDelayMs ?? INTERP_MAX_MS;
    this.extrapCapMs = opts.extrapCapMs ?? EXTRAP_CAP_MS;
    this.bufferCap = opts.bufferCap ?? 60;
    this.dropAfterMs = opts.dropAfterMs ?? 6000;
    this.speedTau = opts.speedTau ?? 0.12;

    const start = clamp(opts.startDelayMs ?? INTERP_START_MS, this.minDelayMs, this.maxDelayMs);
    this.currentDelayMs = start;
    this.targetDelayMs = start;
  }

  get delayMs(): number {
    return this.currentDelayMs;
  }

  get underrunRate(): number {
    return this.underrunEma;
  }

  /** Buffer one snapshot. Frames are kept sorted by `receivedAt`; a rare out-of-order arrival is inserted in place rather than assumed to be latest, since the playback bracket search depends on the ordering. */
  push(frame: SnapshotFrame<K>): void {
    if (this.lastPushReceivedAt !== null) {
      const gap = frame.receivedAt - this.lastPushReceivedAt;
      if (gap >= 0) {
        this.jitterRing.push(gap);
        if (this.jitterRing.length > this.jitterRingCap) this.jitterRing.shift();
        this.recomputeTargetDelay();
      }
    }
    this.lastPushReceivedAt = frame.receivedAt;

    let i = this.frames.length;
    while (i > 0 && this.frames[i - 1]!.receivedAt > frame.receivedAt) i--;
    this.frames.splice(i, 0, frame);
    if (this.frames.length > this.bufferCap) {
      this.frames.splice(0, this.frames.length - this.bufferCap);
    }

    for (const key of frame.entities.keys()) {
      this.lastSeenAt.set(key, frame.receivedAt);
    }
  }

  private recomputeTargetDelay(): void {
    if (this.jitterRing.length < 3) return;
    const sorted = [...this.jitterRing].sort((a, b) => a - b);
    // Roughly p95 of recent inter-arrival gaps: sized to cover almost every
    // gap between snapshots, so the playback point rarely has to run past
    // the newest buffered frame in ordinary jitter, only in a genuine drop.
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    this.targetDelayMs = clamp(sorted[idx]!, this.minDelayMs, this.maxDelayMs);
  }

  /** Stop tracking one entity immediately, without waiting out `dropAfterMs`. */
  forget(key: K): void {
    this.lastSeenAt.delete(key);
    this.motion.delete(key);
  }

  /** Drop all buffered frames and per-entity state, and reset the adaptive delay to its starting value. */
  clear(): void {
    this.frames = [];
    this.lastSeenAt.clear();
    this.motion.clear();
    this.localClockMs = 0;
    this.clockInitialized = false;
    this.lastPushReceivedAt = null;
    this.jitterRing = [];
    this.currentDelayMs = clamp(this.currentDelayMs, this.minDelayMs, this.maxDelayMs);
    this.targetDelayMs = this.currentDelayMs;
    this.underrunEma = 0;
  }

  /**
   * Advance the playback point and read every tracked entity's smoothed
   * pose. Call once per rendered frame. `nowMs`, if given, is the
   * authoritative local clock reading (matching whatever clock `push()`'s
   * `receivedAt` values use); omit it to let the interpolator accumulate its
   * own clock from `dt`, which is convenient for a caller that has no
   * particular clock of its own to hand in, and is exactly what the unit
   * tests do to stay deterministic.
   */
  sample(dt: number, nowMs?: number): Map<K, InterpolatedEntity> {
    if (nowMs !== undefined) {
      this.localClockMs = nowMs;
      this.clockInitialized = true;
    } else if (dt > 0) {
      this.localClockMs += dt * 1000;
      this.clockInitialized = true;
    }

    if (dt > 0) {
      const ease = 1 - Math.exp(-INTERP_ADAPT_LAMBDA * dt);
      this.currentDelayMs += (this.targetDelayMs - this.currentDelayMs) * ease;
    }

    const out = new Map<K, InterpolatedEntity>();
    if (!this.clockInitialized || this.frames.length === 0) {
      this.decayUnderrun(false, dt);
      return out;
    }

    // Forget anything that has not appeared in a pushed frame recently,
    // regardless of whether it is about to be rendered this call.
    for (const [key, seenAt] of this.lastSeenAt) {
      if (this.localClockMs - seenAt > this.dropAfterMs) {
        this.lastSeenAt.delete(key);
        this.motion.delete(key);
      }
    }

    const targetMs = this.localClockMs - this.currentDelayMs;

    // Find the last frame at or before the playback point.
    let i = -1;
    for (let k = 0; k < this.frames.length; k++) {
      if (this.frames[k]!.receivedAt <= targetMs) i = k;
      else break;
    }

    let underranThisCall = false;

    if (i === -1) {
      // Playback has not caught up to the oldest buffered frame yet (this is
      // normal for the first moment after a fresh connection or `clear()`):
      // hold at the earliest known pose rather than inventing one further back.
      const frame = this.frames[0]!;
      for (const [key, sample] of frame.entities) {
        if (!this.lastSeenAt.has(key)) continue;
        out.set(key, this.finishEntity(key, sample.x, sample.y, sample.heading ?? 0, sample, false, dt));
      }
    } else if (i === this.frames.length - 1) {
      // UNDERRUN: nothing buffered beyond the playback point. Extrapolate by
      // last-known velocity (zero if there is no prior frame to derive one
      // from) rather than freezing.
      underranThisCall = true;
      const curr = this.frames[i]!;
      const prev = i > 0 ? this.frames[i - 1]! : null;
      const elapsedMs = Math.min(targetMs - curr.receivedAt, this.extrapCapMs);
      const elapsedS = Math.max(0, elapsedMs) / 1000;
      const prevDtS = prev ? (curr.receivedAt - prev.receivedAt) / 1000 : 0;

      for (const [key, sample] of curr.entities) {
        if (!this.lastSeenAt.has(key)) continue;
        let vx = 0;
        let vy = 0;
        const before = prev?.entities.get(key);
        if (before && prevDtS > 0) {
          vx = (sample.x - before.x) / prevDtS;
          vy = (sample.y - before.y) / prevDtS;
        }
        const x = sample.x + vx * elapsedS;
        const y = sample.y + vy * elapsedS;
        out.set(key, this.finishEntity(key, x, y, sample.heading ?? 0, sample, true, dt));
      }
    } else {
      const a = this.frames[i]!;
      const b = this.frames[i + 1]!;
      const span = b.receivedAt - a.receivedAt;
      const frac = span > 0 ? clamp((targetMs - a.receivedAt) / span, 0, 1) : 1;

      const keys = new Set<K>([...a.entities.keys(), ...b.entities.keys()]);
      for (const key of keys) {
        if (!this.lastSeenAt.has(key)) continue;
        const sa = a.entities.get(key);
        const sb = b.entities.get(key);
        let x: number;
        let y: number;
        let heading: number;
        let base: EntitySample;
        if (sa && sb) {
          x = lerp(sa.x, sb.x, frac);
          y = lerp(sa.y, sb.y, frac);
          heading = lerpHeading(sa.heading ?? 0, sb.heading ?? 0, frac);
          base = sb;
        } else if (sb) {
          x = sb.x;
          y = sb.y;
          heading = sb.heading ?? 0;
          base = sb;
        } else {
          x = sa!.x;
          y = sa!.y;
          heading = sa!.heading ?? 0;
          base = sa!;
        }
        out.set(key, this.finishEntity(key, x, y, heading, base, false, dt));
      }
    }

    this.decayUnderrun(underranThisCall, dt);
    return out;
  }

  private finishEntity(
    key: K,
    x: number,
    y: number,
    heading: number,
    base: EntitySample,
    extrapolated: boolean,
    dt: number,
  ): InterpolatedEntity {
    let state = this.motion.get(key);
    let speed = 0;
    if (state && dt > 0) {
      const dx = x - state.x;
      const dy = y - state.y;
      const inst = Math.hypot(dx, dy) / dt;
      const ease = 1 - Math.exp(-dt / this.speedTau);
      speed = state.hasPrev ? state.speed + (inst - state.speed) * ease : inst;
    }
    state = { x, y, speed, hasPrev: true };
    this.motion.set(key, state);

    return { ...base, x, y, heading, speed, extrapolated };
  }

  private decayUnderrun(underran: boolean, dt: number): void {
    if (dt <= 0) {
      this.underrunEma = underran ? 1 : this.underrunEma;
      return;
    }
    // A few-second exponential window: long enough that a single dropped
    // packet does not read as a persistent problem, short enough that a
    // caller polling this can act on it within a couple of seconds.
    const tau = 3;
    const ease = 1 - Math.exp(-dt / tau);
    this.underrunEma += ((underran ? 1 : 0) - this.underrunEma) * ease;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
