// The client's own monotonic, dilated simulation tick.
//
// A stamped input (`ClientInput.targetTick`) only does its job, landing on the
// identical tick at the server and in this client's own prediction, if the
// client can name a tick that is close to what the server will actually be
// simulating when the packet arrives. The naive approach, estimating the
// server's current tick from the newest snapshot and adding a fixed lead, has
// a defect that only shows up under real jitter: the estimate WOBBLES with
// every packet, and every wobble either double-stamps a tick (two inputs claim
// it, one is dropped) or skips one (nothing claims it, the buffer starves).
//
// This class keeps its OWN counter instead. It advances by exactly one tick
// per fixed step and NEVER jumps mid-epoch, no matter how the server-tick
// estimate jitters between frames; it is anchored ONCE per connection epoch
// (on the first snapshot after `markUnanchored()`) and otherwise only ever
// speeds up or slows down by a small, capped amount. That is what makes a
// stamped input land on the tick the server will actually consume it on
// without ever producing a visible discontinuity in the local prediction that
// is keyed off the same counter.

/** Ticks of lead the counter anchors ahead of the server's own estimated current tick, so a just-stamped input has time to cross the network before the server reaches that tick. */
export const ANCHOR_MARGIN = 4;

/** Maximum whole ticks a single `advance()` call may add. Bounds a long frame (a backgrounded tab regaining focus) from bursting the counter forward by however many ticks of wall-clock time it missed; the excess time is dropped, the same trade a fixed-timestep loop already makes on its own frame dt. */
export const TICK_STEP_CAP = 6;

/** Maximum fractional speed-up or slow-down applied to the tick interval. Kept small (5%) so dilation is never itself perceptible as a change in game speed; it only ever nudges input latency, never rushes or drags visible motion. */
export const STEP_DILATION_MAX = 0.05;

/** The buffered-margin target, in ticks, the dilation control aims to hold the server-side playout buffer at. Below this the counter speeds up (ticks arrive sooner, refilling the buffer); above it, the counter slows down (shedding the latency a deep buffer adds). */
export const MARGIN_TARGET = 3;

/** How many ticks of margin error map to the full dilation range. A margin exactly `MARGIN_TARGET - MARGIN_SPAN` or below saturates at maximum speed-up; `MARGIN_TARGET + MARGIN_SPAN` or above saturates at maximum slow-down. */
export const MARGIN_SPAN = 1.5;

/** Time constant, seconds, for smoothing a raw reported buffer-health measurement before it drives anything. Without this a single noisy sample would yank the dilation target around every report. */
export const HEALTH_EASE_TAU = 0.5;

/** Time constant, seconds, for smoothing the dilation value itself toward its target. A second stage of easing on top of the health smoothing, so the tick RATE changes gradually even if the smoothed margin itself moves in a step. */
export const DILATION_EASE_TAU = 0.5;

export interface ClientTickOptions {
  /** Nominal (undilated) tick duration, ms. Must match the host simulation's fixed timestep. */
  tickMs: number;
  anchorMargin?: number;
  dilationMax?: number;
  marginTarget?: number;
  marginSpan?: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export class ClientTick {
  private readonly tickMs: number;
  private readonly anchorMargin: number;
  private readonly dilationMax: number;
  private readonly marginTarget: number;
  private readonly marginSpan: number;

  private _value = 0;
  private _initialized = false;
  private _anchored = false;
  private accumulatorMs = 0;
  private easedMargin = MARGIN_TARGET;
  private easedDilation = 0;

  constructor(opts: ClientTickOptions) {
    this.tickMs = opts.tickMs;
    this.anchorMargin = opts.anchorMargin ?? ANCHOR_MARGIN;
    this.dilationMax = opts.dilationMax ?? STEP_DILATION_MAX;
    this.marginTarget = opts.marginTarget ?? MARGIN_TARGET;
    this.marginSpan = opts.marginSpan ?? MARGIN_SPAN;
  }

  get value(): number {
    return this._value;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  get anchored(): boolean {
    return this._anchored;
  }

  get dilation(): number {
    return this.easedDilation;
  }

  get bufferedMargin(): number {
    return this.easedMargin;
  }

  /**
   * Call once per rendered frame regardless of connection state. Before the
   * first anchor this is a deliberate no-op: ticking a counter with no
   * anchor would be dead reckoning against nothing, and the moment a real
   * anchor arrives it would produce a large, arbitrary jump instead of the
   * clean single anchor a fresh connection is supposed to get.
   */
  advance(dt: number): void {
    if (!this._initialized || dt <= 0) return;

    this.accumulatorMs += dt * 1000;
    // Positive dilation shortens the step (ticks pass faster, rebuilding a
    // shallow buffer); negative dilation lengthens it (shedding the latency
    // a deep buffer adds). See the module comment on MARGIN_TARGET.
    const stepMs = this.tickMs / (1 + this.easedDilation);
    let steps = Math.floor(this.accumulatorMs / stepMs);
    if (steps <= 0) return;

    if (steps > TICK_STEP_CAP) {
      steps = TICK_STEP_CAP;
      // Drop the excess wall-clock time rather than letting it carry over:
      // carrying it would just burst the NEXT call forward instead, moving
      // the problem one frame down the road rather than removing it.
      this.accumulatorMs = 0;
    } else {
      this.accumulatorMs -= steps * stepMs;
    }
    this._value += steps;
  }

  /**
   * Snap the counter to `round(serverTick) + anchorMargin`. Returns the delta
   * applied (new value minus old), so a caller can fold a genuine mid-epoch
   * re-anchor into an `ErrorOffset` (the local prediction just jumped and the
   * render needs to absorb it) while treating a connection's very first
   * anchor differently (nothing was rendered yet, so there is nothing to
   * smooth: check `initialized` before this call if that distinction
   * matters to the caller).
   */
  anchorTo(serverTick: number): number {
    const next = Math.round(serverTick) + this.anchorMargin;
    const delta = next - this._value;
    this._value = next;
    this._initialized = true;
    this._anchored = true;
    this.accumulatorMs = 0;
    return delta;
  }

  /** Called on every fresh connection attempt so the NEXT snapshot re-anchors from scratch, rather than trusting a counter that was ticking through a gap where no server owned the room at all. */
  markUnanchored(): void {
    this._anchored = false;
  }

  /**
   * Feed a measurement of how many ticks of input are currently buffered
   * ahead of what the server is consuming for this connection. `health` is
   * the raw, possibly noisy measurement; it is smoothed twice (once as a
   * margin, once again as the dilation it produces) before it can move the
   * tick rate, so a single noisy report cannot yank playback speed around.
   */
  reportBufferHealth(health: number, dt: number): void {
    if (dt <= 0) {
      this.easedMargin = health;
    } else {
      const a = 1 - Math.exp(-dt / HEALTH_EASE_TAU);
      this.easedMargin += (health - this.easedMargin) * a;
    }

    const target = clamp((this.marginTarget - this.easedMargin) / this.marginSpan, -1, 1) * this.dilationMax;
    if (dt <= 0) {
      this.easedDilation = target;
    } else {
      const b = 1 - Math.exp(-dt / DILATION_EASE_TAU);
      this.easedDilation += (target - this.easedDilation) * b;
    }
    this.easedDilation = clamp(this.easedDilation, -this.dilationMax, this.dilationMax);
  }
}
