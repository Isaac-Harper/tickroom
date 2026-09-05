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

/** Maximum whole ticks a single `advance()` call may add. Bounds a long frame (a backgrounded tab regaining focus) from bursting the counter forward by however many ticks of wall-clock time it missed; the excess time is dropped, the same trade a fixed-timestep loop already makes on its own frame dt. */
export const TICK_STEP_CAP = 6;

export interface ClientTickOptions {
  /** Nominal tick duration, ms. Must match the host simulation's fixed timestep. */
  tickMs: number;
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
  /**
   * How far the counter is into the NEXT tick, 0 (inclusive) to 1 (exclusive):
   * the wall time accumulated since the last whole step, as a share of one
   * tick. 0 before the first anchor and immediately after any anchor.
   *
   * THIS EXISTS FOR THE ONE ENTITY THE INTERPOLATOR DOES NOT SMOOTH. A locally
   * predicted entity advances only when a tick is stamped, once per `tickMs`,
   * while the page renders at the frame rate; drawing its raw predicted state
   * therefore holds it still for several frames and then moves it a whole tick
   * of travel at once, which at 20Hz is a visible step three times a second
   * on the very entity the player is steering. Remote entities never show this
   * because `SnapshotInterpolator` renders them between snapshots.
   * `value - 1 + fraction` is the point one tick behind the newest stamp on
   * this counter's timeline, and `PredictedEntity` aims a render playhead at
   * it, one that moves by each frame's own dt within a tenth of real time
   * rather than following the counter directly: a re-anchor moves `value` in
   * one frame, and A COUNTER JUMP IS NOT TIME PASSING. The cost is one tick
   * of visual delay on that entity (at most 50ms at 20Hz) on top of a
   * prediction that has no round trip in it, in exchange for motion at the
   * frame rate. `examples/pong/client.ts` draws through it.
   */
  readonly fraction: number;
  /**
   * The tick interval the counter was built with, ms: the constant
   * `ClientTickOptions.tickMs` and nothing else. Exposed beside `fraction`
   * for the same consumer, so a predicted entity derives its timestep from
   * the counter it stamps against rather than taking a second `tickHz` it
   * could get wrong against the connection.
   */
  readonly tickMs: number;
}

export class ClientTick implements ClientTickView {
  readonly tickMs: number;

  private _value = 0;
  private _initialized = false;
  private _anchored = false;
  private accumulatorMs = 0;

  constructor(opts: ClientTickOptions) {
    this.tickMs = opts.tickMs;
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
   * Read straight off the accumulator `advance()` keeps, so it is 0 before the
   * first anchor (`advance` is a no-op until then, so nothing has accumulated),
   * 0 after every `anchorTo` (which resets the accumulator), 0 after a capped
   * frame (which drops the excess outright), and otherwise the remainder a
   * whole step left behind, which is below one tick by construction.
   */
  get fraction(): number {
    return this.accumulatorMs / this.tickMs;
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
   * Snap the counter to `round(targetTick)`. Returns the delta applied (new
   * value minus old), so a caller can fold a genuine mid-epoch re-anchor into
   * an `ErrorOffset` (the local prediction just jumped and the render needs to
   * absorb it) while treating a connection's very first anchor differently
   * (nothing was rendered yet, so there is nothing to smooth: check
   * `initialized` before this call if that distinction matters to the caller).
   *
   * THE LEAD IS THE CALLER'S, AND IT USED TO BE THIS CLASS'S. An `ANCHOR_MARGIN`
   * of 4 ticks was added here, which is a lead expressed in TICKS with no
   * round-trip term in it at all: at 20Hz that is 200ms of budget for a whole
   * round trip plus jitter, and at 60Hz it is 67ms, so every player above
   * roughly 200ms of RTT stamped every input into a tick the server had
   * already simulated, for the whole session. A lead that has to cover a
   * MEASURED round trip cannot be a constant this class owns, because this
   * class measures nothing. `RoomConnection.desiredTick()` composes it from
   * the server-tick estimate, the measured RTT, a configured jitter lead in
   * MILLISECONDS and the optional server-depth feedback, and hands the
   * finished number here.
   */
  anchorTo(targetTick: number): number {
    const next = Math.round(targetTick);
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
