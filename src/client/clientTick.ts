// The client's own monotonic simulation tick.
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
// moves forward by whole steps. That is what makes a stamped input land on the
// tick the server will actually consume it on without ever producing a visible
// discontinuity in the local prediction that is keyed off the same counter.
//
// THE COUNTER IS DRIVEN BY `RoomConnection.frame()`, NOT BY THE HOST. `advance`
// used to be a public call a host had to remember to make once per rendered
// frame, documented nowhere outside this file, and omitting it froze the
// counter at its one anchor while the server ran away: every input stamped
// further and further into the past, with the room connected, remote entities
// moving perfectly, and only the player's own input wrong in a way that reads
// as latency. Worse, `shouldReanchor` gates on `initialized`, which only
// `advance()` sets, so omitting the call ALSO disabled the recovery that would
// otherwise have masked it. The connection now owns the call and hands the
// host a `ClientTickView` with no `advance` on it at all, so there is nothing
// left to forget and nothing to double-drive.

/** Ticks of lead the counter anchors ahead of the server's own estimated current tick, so a just-stamped input has time to cross the network before the server reaches that tick. */
export const ANCHOR_MARGIN = 4;

/** Maximum whole ticks a single `advance()` call may add. Bounds a long frame (a backgrounded tab regaining focus) from bursting the counter forward by however many ticks of wall-clock time it missed; the excess time is dropped, the same trade a fixed-timestep loop already makes on its own frame dt. */
export const TICK_STEP_CAP = 6;

export interface ClientTickOptions {
  /** Nominal tick duration, ms. Must match the host simulation's fixed timestep. */
  tickMs: number;
  anchorMargin?: number;
}

/**
 * The READ-ONLY half of `ClientTick`, and what `RoomConnection.tick` hands
 * back. The counter's advance is the connection's job, driven from the one
 * per-frame call; a host that could reach `advance()` through this reference
 * could also drive it a second time in the same frame, which double-counts
 * every tick and stamps inputs into a future the server never reaches. Naming
 * only the readable members is what makes that impossible rather than merely
 * discouraged.
 */
export interface ClientTickView {
  /** The tick to stamp an input with right now. */
  readonly value: number;
  /** Has the counter been anchored at least once, ever? `value` is meaningless until it has. */
  readonly initialized: boolean;
  /** Is the counter anchored for the CURRENT connection epoch? False between a fresh connect attempt and its first snapshot. */
  readonly anchored: boolean;
}

export class ClientTick implements ClientTickView {
  private readonly tickMs: number;
  private readonly anchorMargin: number;

  private _value = 0;
  private _initialized = false;
  private _anchored = false;
  private accumulatorMs = 0;

  constructor(opts: ClientTickOptions) {
    this.tickMs = opts.tickMs;
    this.anchorMargin = opts.anchorMargin ?? ANCHOR_MARGIN;
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

  /**
   * Advance by whatever whole ticks `dt` seconds is worth. Called once per
   * rendered frame by `RoomConnection.frame()`, regardless of connection
   * state. Before the first anchor this is a deliberate no-op: ticking a
   * counter with no anchor would be dead reckoning against nothing, and the
   * moment a real anchor arrives it would produce a large, arbitrary jump
   * instead of the clean single anchor a fresh connection is supposed to get.
   */
  advance(dt: number): void {
    if (!this._initialized || dt <= 0) return;

    this.accumulatorMs += dt * 1000;
    let steps = Math.floor(this.accumulatorMs / this.tickMs);
    if (steps <= 0) return;

    if (steps > TICK_STEP_CAP) {
      steps = TICK_STEP_CAP;
      // Drop the excess wall-clock time rather than letting it carry over:
      // carrying it would just burst the NEXT call forward instead, moving
      // the problem one frame down the road rather than removing it.
      this.accumulatorMs = 0;
    } else {
      this.accumulatorMs -= steps * this.tickMs;
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
}
