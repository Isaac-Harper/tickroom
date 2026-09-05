// The locally predicted entity: the stamped path's client half, in one object.
//
// A player's OWN entity is the one thing the interpolation delay is not
// acceptable for, because they are steering it. So it is predicted: every
// input carries the tick it applies on, the server applies it on exactly that
// tick, and this client applies the same record on the same tick to its own
// copy through the same pure step, so a snapshot is a confirmation rather than
// a correction. Doing that by hand is four coupled rules, and the reference
// example carried two of them wrong until the day before this file existed:
//
//   1. STAMP one record per client tick (never per frame, never per keydown),
//      predict each through `step`, keep the recent ones and re-send the last
//      few whole on every packet so a lost packet is not a starved tick.
//   2. RECONCILE on every snapshot by replaying the stored records with
//      `targetTick > snapTick` from the authoritative pose, adopting the
//      result IN FULL, and handing the difference to an `ErrorOffset` so the
//      rendered pose does not move this frame and the correction glides out.
//   3. SNAP rather than glide on the first confirmation (the prediction was
//      a guess at the spawn) and when the offset would grow past a distance
//      no glide can hide.
//   4. DRAW from a render PLAYHEAD that slews through the pose history at
//      close to real time (speculating past its newest pose with the current
//      input when it has to), plus the offset, and shift the whole history by
//      the same delta on every reconcile so the correction is carried by the
//      offset alone.
//
// The fourth rule used to be "draw between the last two stamped ticks by
// `tick.fraction`", which follows the tick counter directly, and A COUNTER
// JUMP IS NOT TIME PASSING: a forward re-anchor of three ticks stamped three
// records in one frame and moved the drawn pose three ticks of travel in
// 16ms, a backward re-anchor of one (the ordinary epoch anchor on a fast
// link) walked the draw a whole tick backward, and neither was counted as a
// snap. The playhead is what makes the draw a function of wall time instead:
// the counter may jump, the playhead only ever moves forward, at between
// `1 - RENDER_SLEW` and `1 + RENDER_SLEW` of real time, and a jump too large
// to slew across is a counted snap. A backward jump leaves the playhead ahead
// of the history the counter will stamp, and it is the SPECULATION (the
// newest stored pose stepped with the frame's own input, never stored, at
// most `PLAYHEAD_SNAP_TICKS` deep) that lets it keep its pace there rather
// than crawl through what is left of the stored poses.
//
// This class owns all four and exposes no way to do any of them differently.
// Its calls are `advance` once per frame after `conn.frame()`, `reconcile`
// once per snapshot, and `snapTo` for the events a glide is the wrong answer
// to at all (a respawn, a teleport, a round reset); the re-anchor handling the
// example used to do in `onTickReanchor` is inside `advance`, read off the
// counter itself, so there is no hook left for a host to forget. And there is
// ONE per connection: the entity IS the player's input stream (the ticker
// keeps one playout buffer per pid, so two entities on one connection
// overwrite each other's records tick by tick), and a second construction on
// the same `conn` throws.

import type { ClientTickView } from './clientTick.js';
import { ErrorOffset } from './errorOffset.js';

/**
 * A 2D pose with an optional heading in radians: the same fields
 * `EntitySample` interpolates, so an owned entity and a remote one are drawn
 * from one shape. The heading is wrapped to (-pi, pi] by everything here.
 */
export interface Pose {
  x: number;
  y: number;
  heading?: number | undefined;
}

export interface PredictedEntityOptions<TInput> {
  /**
   * The connection this entity stamps against and sends through. Structurally
   * typed, so a test can pass a fake. `RoomConnection` satisfies it as is.
   * The timestep every `step` runs on is `conn.tick.tickMs`, the constant the
   * counter was built with: there is no `tickHz` option here, because it was
   * the one number a consumer could get wrong against the connection.
   */
  conn: { readonly tick: ClientTickView; send(payload: string): void };
  /**
   * THE SAME PURE STEP THE SERVER RUNS FOR THIS ENTITY: the pose after one
   * tick of `dt` seconds under `input`. Share the function with the runtime
   * rather than retyping it; a second copy of the rule is a divergence with
   * no symptom until one of the two is edited. It must not keep state, and it
   * should return a new pose rather than mutate the one it was given (the
   * replay runs it up to `INPUT_HISTORY` times per snapshot from a copy).
   */
  step: (pose: Pose, input: TInput, dt: number) => Pose;
  /**
   * The fastest this entity can move, units per second. It bounds how fast a
   * correction may glide (the glide adds at most this on top of the entity's
   * own motion, so a correction can briefly draw at twice it and never more,
   * which is what keeps a glide reading as the entity and not as a second
   * hand on the controls) and it sets the snap distance, half a second of
   * travel, past which the two ends are desynced rather than a tick apart.
   */
  maxSpeed: number;
  /** Where the entity starts before the first authoritative pose arrives. The first reconcile replaces it outright. */
  initial: Pose;
}

/** One stamped record as it goes on the wire: `{ targetTick, data }`, which is the `ClientInput` shape less the `seq` the library documents it never reads. */
interface StampedRecord<TInput> {
  targetTick: number;
  data: TInput;
}

/** The prediction after one stamped tick, keyed by that tick: what the render playhead interpolates through. */
interface PoseAtTick {
  tick: number;
  pose: Pose;
}

/**
 * Records re-sent on every packet, oldest first. Six is 300ms of redundancy at
 * 20Hz and matches `INPUT_WINDOW_MAX` in the binary codec. A playout push is
 * duplicate-overwriting and out-of-order safe, so a record the server already
 * has costs its bytes and nothing else, and several consecutive lost packets
 * stop being a starved tick at all. This is the cheapest win on the wire.
 */
export const INPUT_WINDOW = 6;

/**
 * Records kept for the replay, deliberately deeper than the re-send window.
 * The replay has to reach from the newest snapshot's tick up to the newest
 * stamped one, and that lead is the measured round trip plus the jitter
 * headroom plus the server-depth feedback: on a slow link it exceeds six
 * ticks, at which point a replay bounded by the re-send window came up a tick
 * or two short on EVERY snapshot, a small steady error the offset then glided
 * away as a wobble. Keeping more than is sent costs one array and makes that
 * trade go away. Thirty-two ticks is 1.6 seconds at 20Hz, past any lead
 * `desiredTick()` produces there (its stamps land within `PLAYOUT_MAX_AHEAD / 2`,
 * 20 ticks, of the consumed floor); at 60Hz on a 300ms round trip it is close,
 * and a replay that does come up short degrades to a steady offset rather
 * than a divergence. The pose history is one deeper: the pose after every
 * held record plus the one they were predicted from.
 */
export const INPUT_HISTORY = 32;

/**
 * How far from real time the render playhead may run, as a share: it moves
 * through the pose history at between `1 - RENDER_SLEW` and `1 + RENDER_SLEW`
 * of wall time, never backward and never stopped. A tenth catches a three
 * tick forward re-anchor up over thirty ticks and lets a one tick backward
 * anchor go by in ten, and at ten percent neither reads as anything but the
 * entity moving.
 */
export const RENDER_SLEW = 0.1;

/**
 * A counter jump the playhead does not slew across, in ticks. Past this the
 * playhead jumps to its target and the jump is counted on `stats.snaps`: a
 * frozen tab coming back or a handoff-sized re-anchor is a snap, and now an
 * accounted one rather than a silent one. Four ticks is 200ms at 20Hz, the
 * largest correction the two-sided re-anchor makes in ordinary operation.
 * It is also the most the playhead may speculate past the newest stored
 * pose: a playhead further ahead than this has a target further away than
 * this and has snapped, so the bound never binds on an anchored counter and
 * is the belt for an unanchored one run ahead by a host's unclamped dt.
 */
export const PLAYHEAD_SNAP_TICKS = 4;

/** Exponential decay time constant for the glide, seconds, both axes and heading. A tenth of a second bleeds an ordinary one-tick error out inside a few frames without reading as a drift. */
const GLIDE_TAU = 0.1;

/** The most heading a single frame may glide, radians. Fixed, because the options carry no turn rate to derive it from, and 0.35 per frame is a full half turn inside ten frames. */
const HEADING_MAX_STEP = 0.35;

/** The snap distance as seconds of travel at `maxSpeed`. Half a second is well past a tick of skew at any tick rate and well short of a checkpoint rewind. */
const SNAP_SECONDS = 0.5;

/** The per-frame position cap the offset is configured with, for the one frame `dt` is 0. Every real frame passes its own cap through `sample`. */
const NOMINAL_FRAME_S = 1 / 60;

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-arc heading lerp, the same rule the interpolator applies to a remote entity: a linear lerp across the +-pi wrap spins the long way round. */
function lerpHeading(a: number, b: number, t: number): number {
  return wrapAngle(a + wrapAngle(b - a) * t);
}

/** Every coordinate finite, the heading included when there is one. A pose that fails this is not a pose and must never reach the draw or the offset. */
function isFinitePose(p: Pose): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && (p.heading === undefined || Number.isFinite(p.heading));
}

/** `a` shifted by `-d` on every axis it has, the heading re-wrapped: the reconcile applies one delta to every stored pose. */
function shifted(a: Pose, dx: number, dy: number, dh: number): Pose {
  return {
    x: a.x - dx,
    y: a.y - dy,
    ...(a.heading === undefined ? {} : { heading: wrapAngle(a.heading - dh) }),
  };
}

/**
 * The one entity each connection may own, keyed by the `conn` object itself.
 * Weak, so a connection that is dropped takes its entry with it; module
 * level, so the rule holds across every construction site in a page.
 */
const owners = new WeakMap<object, PredictedEntity<unknown>>();

/**
 * One locally predicted entity: stamps its inputs, predicts them, sends them,
 * reconciles against every snapshot, and hands back the pose to draw.
 *
 * ONE PER CONNECTION, BY RULE. This object IS the player's input stream: the
 * server keeps ONE playout buffer per pid, and every record this sends is
 * keyed by its tick in that one buffer, so a second entity on the same
 * connection overwrites the first's record for every tick it stamps and the
 * server consumes whichever landed last. A player steering several things
 * carries them all in one input record and one `step`. Constructing a second
 * entity for a `conn` that already owns one throws a `RangeError` naming this
 * rule, at construction, rather than corrupting both streams in silence.
 *
 * `TInput` is the per-tick input as it goes on the wire, so it has to be JSON
 * data (an object of numbers, typically). Each stamped record keeps a JSON
 * copy of it rather than a reference, and predicts through that copy, so the
 * record replayed here is byte for byte the record the server applied even if
 * the caller mutates the object it passed in on the next frame.
 */
export class PredictedEntity<TInput> {
  private readonly conn: PredictedEntityOptions<TInput>['conn'];
  private readonly step: PredictedEntityOptions<TInput>['step'];
  /** One tick, seconds: `conn.tick.tickMs / 1000`, read once at construction. */
  private readonly dt: number;
  private readonly maxSpeed: number;
  private readonly snapDistance: number;
  private readonly err: ErrorOffset;
  private readonly initial: Pose;

  /** The newest prediction: the pose after the last stamped tick. */
  private curr: Pose;
  /**
   * The prediction after every recent stamped tick, oldest first, and ahead
   * of the oldest the pose they were predicted from: the newest
   * `INPUT_HISTORY + 1` poses. The render playhead interpolates through this,
   * so the pose at any stamped tick in the last `INPUT_HISTORY` is known and
   * the draw is a function of where the playhead is rather than of what the
   * counter did this frame. Ticks are strictly ascending by construction and
   * are NEVER RELABELLED: a stamp for a tick already held overwrites that
   * entry in place, which is how the SPECULATIVE TAIL a backward re-anchor
   * leaves behind (the poses beyond the rewound mark) is redrawn as the
   * counter climbs back through it, and a forward stamp appends.
   */
  private readonly poses: PoseAtTick[] = [];
  /**
   * THE SPECULATION: the poses the playhead needs beyond the newest stored
   * one, each the previous stepped by the input the last `advance` was given,
   * continuing `poses` tick by tick. NOT HISTORY: nothing here is replayed
   * or sent, it is rebuilt from the newest stored pose whenever the playhead
   * is past it (a backward re-anchor leaves it there, and it slews back at
   * `1 - RENDER_SLEW` while the counter climbs, so the pose the stamp will
   * produce a few ticks on is what the draw wants now), and it is empty on
   * every frame of a steady counter. At most `PLAYHEAD_SNAP_TICKS` deep.
   * Shifted with the history on a reconcile, so the draw reads one
   * trajectory, and measured before it is rebuilt so an input that changed
   * since it was built is a glide, not a step.
   */
  private readonly spec: PoseAtTick[] = [];
  /**
   * THE RENDER PLAYHEAD, in the counter's tick units, a float. Its target is
   * `tick.value - 1 + tick.fraction`, one tick behind the newest stamp so
   * that on a steady counter the segment it sits on is two stamped poses,
   * and it moves toward that target by `dt / tickMs` per frame scaled into
   * `1 +- RENDER_SLEW`: never backward, never stopped, never faster than a
   * tenth over real time, never slower than a tenth under it. Ahead of the
   * target (after a backward re-anchor) it runs past the newest stored pose
   * on the speculation rather than being held to the history's end. A
   * target further than `PLAYHEAD_SNAP_TICKS` away in either direction is
   * jumped to and counted as a snap. `null` until the first frame on an
   * initialized counter, which seeds it on the target.
   */
  private renderTick: number | null = null;
  /** High-water mark of the ticks stamped, so a frame that crossed no tick boundary stamps nothing and a frame that crossed two stamps two. -1 until the first `advance` on an initialized counter. */
  private lastStamped = -1;
  /** The last `INPUT_HISTORY` records, oldest first. The re-send window is its tail. */
  private readonly records: StampedRecord<TInput>[] = [];
  /** Has any authoritative pose arrived? The first one is adopted with a snap, because until then `curr` is a guess at the spawn and gliding that difference away would walk the entity in from wherever the guess happened to be. */
  private confirmed = false;
  /** `tick.anchored` as of the last `advance` or `reconcile`. A false-to-true edge is a new connection epoch: see `observeEpoch`. */
  private wasAnchored = false;
  /** The newest finite authoritative pose, where the prediction is put back when a step or a replay produces something that is not a pose. `null` until the first confirmation; `initial` stands in before that. */
  private lastAuthoritative: Pose | null = null;
  private readonly _stats = { lastError: 0, snaps: 0, stamped: 0, invalid: 0 };

  constructor(opts: PredictedEntityOptions<TInput>) {
    const tickMs = opts.conn.tick.tickMs;
    if (!Number.isFinite(tickMs) || tickMs <= 0) {
      throw new RangeError(`PredictedEntity: conn.tick.tickMs must be a positive number, got ${tickMs}`);
    }
    if (!Number.isFinite(opts.maxSpeed) || opts.maxSpeed <= 0) {
      throw new RangeError(`PredictedEntity: maxSpeed must be a positive number, got ${opts.maxSpeed}`);
    }
    if (!isFinitePose(opts.initial)) {
      throw new RangeError('PredictedEntity: initial must be a finite pose');
    }
    // AFTER the option checks, so a construction refused above claims nothing.
    if (owners.has(opts.conn)) {
      throw new RangeError(
        'PredictedEntity: one PredictedEntity per connection. The entity is the player input stream (the server keeps one playout buffer per pid), so a player steering several things carries them in one input record; this conn already owns one.',
      );
    }
    owners.set(opts.conn, this as PredictedEntity<unknown>);
    this.conn = opts.conn;
    this.step = opts.step;
    this.dt = tickMs / 1000;
    this.maxSpeed = opts.maxSpeed;
    this.snapDistance = opts.maxSpeed * SNAP_SECONDS;
    this.initial = { ...opts.initial };
    this.curr = { ...opts.initial };
    this.err = new ErrorOffset({
      posTau: GLIDE_TAU,
      headingTau: GLIDE_TAU,
      // The cap and the snap distance are the same number on purpose, and
      // `reconcile` gates on the offset the absorb WOULD PRODUCE rather than
      // on the size of the one correction: a correction that would carry the
      // accumulated offset past this is resolved with `reset()` instead of
      // absorbed, so the clamp here is never the thing that trims one.
      posCap: this.snapDistance,
      headingCap: Math.PI,
      // PER FRAME, and the real cap is passed through `sample` from each
      // frame's own dt, so a slow frame may glide further and a fast one
      // less: at most the entity's own top speed on top of its motion.
      posMaxStep: opts.maxSpeed * NOMINAL_FRAME_S,
      headingMaxStep: HEADING_MAX_STEP,
    });
  }

  /** The raw prediction, the pose after the last stamped tick: no interpolation, no offset. For game logic (a collision check, a camera), not for drawing. A copy. */
  get pose(): Pose {
    return { ...this.curr };
  }

  /**
   * Diagnostics: the last reconcile's position error before it was absorbed,
   * and 0 after a reconcile that was REFUSED (an authoritative pose or a
   * replay that was not finite), so a refusal never reports the error of the
   * reconcile before it; how many times the draw jumped rather than glided (a
   * first confirmation, an offset that would have grown past the snap
   * distance, a counter jump too large for the playhead to slew across, a new
   * epoch's first confirmation, a snapshot from a restarted tick count, a
   * `snapTo`, or an invalid pose); how many records have been stamped; and
   * how many times a `step` result or an authoritative pose was not a finite
   * pose and was refused.
   */
  get stats(): { lastError: number; snaps: number; stamped: number; invalid: number } {
    return { ...this._stats };
  }

  /**
   * THE ONE PER-FRAME CALL, after `conn.frame()` and never before it: the
   * counter this stamps against is advanced by that call, so calling this
   * first stamps every record one frame into the past.
   *
   * Stamps one record per tick the counter crossed since the last call, each
   * carrying `input` and each predicted through `step`; sends the last
   * `INPUT_WINDOW` records as one JSON array of `{ targetTick, data }` when
   * anything was stamped and nothing otherwise; and returns the pose to draw
   * this frame: the pose history read at the render playhead, which has
   * moved `dt` of real time (within `RENDER_SLEW`) toward one tick behind
   * the newest stamp, with what is left of the last correction added. Before
   * the counter is initialized it stamps nothing and returns `initial` (or
   * the last authoritative pose, if a snapshot arrived first).
   *
   * `input` is what the server will apply on those ticks, so run it through
   * the simulation's own clamp before passing it: the record predicted with
   * must be byte for byte the record the server applies. It has to be JSON
   * data; `undefined`, a function or a symbol has no JSON form and is refused
   * with a `TypeError` here, before anything is stamped, rather than stamped
   * as a record whose input the server cannot read.
   *
   * `dt` is this frame's wall time in seconds. A value that is not a finite
   * non-negative number is NO TIME AT ALL: the playhead and the glide stand
   * still for the frame and the stamps are whatever the counter shows, where
   * a NaN or an Infinity reaching the playhead arithmetic used to poison the
   * draw for the rest of the entity's life.
   */
  advance(input: TInput, dt: number): Pose {
    // FIRST, BEFORE ANY STATE MOVES. `JSON.stringify` returns `undefined`
    // rather than throwing for the values that have no JSON form, and a
    // `JSON.parse(undefined)` inside a rAF loop is a bare SyntaxError naming
    // nothing. The string is taken once here and reused for the copy below.
    const json = JSON.stringify(input);
    if (json === undefined) {
      throw new TypeError(
        `PredictedEntity.advance: input must be JSON data, got ${input === undefined ? 'undefined' : typeof input}`,
      );
    }

    // A DURATION THAT IS NOT ONE IS ZERO. `Math.max(0, NaN)` is NaN, and a
    // NaN added to the playhead once compares false against every gate from
    // then on; an Infinity is the same poison with a different sign. Neither
    // reaches the arithmetic below.
    const elapsed = Number.isFinite(dt) && dt > 0 ? dt : 0;

    const tick = this.conn.tick;
    // The counter is meaningless until a snapshot has anchored it, and a
    // record stamped from a meaningless counter is worse than none: it names
    // a tick the server may never reach and starves every tick it should
    // have fed.
    if (!tick.initialized) return { ...this.curr };
    this.observeEpoch(tick.anchored);

    const value = tick.value;
    if (this.lastStamped < 0) {
      // THE FIRST STAMP HAS NOTHING TO CATCH UP FROM. The counter is
      // already thousands of ticks into the room's life, so a mark of -1
      // would owe a record for every tick since the room booted. The pose
      // the first record is predicted from is the history's first entry,
      // keyed by the tick before it, so the playhead has a segment to sit on
      // from the first frame.
      this.lastStamped = value - 1;
      this.poses.push({ tick: value - 1, pose: { ...this.curr } });
    } else if (value + 1 < this.lastStamped) {
      // THE COUNTER JUMPED BACKWARD, past the one tick of slack a re-anchor
      // of -1 is allowed (that one costs nothing: the tick it lands on is
      // already stamped, stamping resumes a tick later, and the playhead
      // lets the target go by at `1 - RENDER_SLEW` for a few ticks). A
      // handoff, a backgrounded tab or a clock step re-anchors the counter
      // below a mark set before the correction, and without this the stamp
      // loop below goes silent until the counter climbs back past the old
      // mark: measured on a real socket at 5.6 seconds of total input
      // silence and 100 self-inflicted starves at the server, on an
      // otherwise healthy connection. The hand-written shape needed the
      // host's `onTickReanchor` to move its mark; here the jump is read off
      // the counter itself, so there is no callback to forget.
      //
      // A BACKWARD JUMP OF k MEANS THE TICKS BEYOND `value - 1` HAVE NOT
      // HAPPENED YET on the server's timeline: the counter was that far
      // ahead of where its stamps needed to land. So the prediction is
      // REWOUND to the stored pose after `value - 1`, the mark goes there,
      // and the records beyond it are dropped, because they are re-sent
      // fresh as the counter climbs back through those ticks and a playout
      // push for a future tick the server already holds OVERWRITES it. The
      // first shape of this relabelled the pose history by the jump and left
      // `curr` where it was, so the next stamp stepped from the pose after
      // the OLD newest tick and the prediction double-stepped: a -3 with a
      // held key reconciled 22.5 units out and stayed out until the records
      // the server still held aged out of the window. Nothing is relabelled
      // now: a tick keeps its name.
      //
      // THE POSES BEYOND THE MARK STAY, AS A SPECULATIVE TAIL. The playhead
      // is sitting on them, and for a held key they are exactly what the
      // re-stamping reproduces, so the draw runs on through them rather than
      // stepping back to the rewound pose. Where a re-stamp overwrites one
      // of them with a DIFFERENT pose (the input changed across the jump),
      // the stamp loop below measures the draw at the playhead before and
      // after and hands the difference to the offset, the same rule
      // `reconcile` applies, so the change glides instead of stepping.
      this.rewindTo(value - 1);
    }

    // WHAT IS DRAWN PAST THE MARK IS MEASURED BEFORE IT CAN CHANGE. Two
    // things are drawn beyond the stamped history: a SPECULATIVE TAIL (the
    // poses a backward re-anchor left beyond the mark, overwritten in place
    // as they are re-stamped) and the SPECULATION (the poses stepped past
    // the newest stored one with the previous frame's input). Either can
    // change shape under the playhead this frame: a re-stamp that differs
    // from the tail, a stamp landing where a speculated pose was, or an
    // input that changed since the speculation was built. The draw is
    // measured at the playhead before and after, and the difference goes to
    // the offset exactly as `reconcile` does, so a changed input glides. The
    // `before` is the speculation the previous frame DREW, never the stored
    // history clamped at its end, or the offset would absorb a jump that was
    // never on screen. On a steady counter the playhead is a tick behind the
    // newest pose, nothing is drawn past the mark, and nothing is measured.
    const newest = this.poses[this.poses.length - 1];
    const exposed =
      newest !== undefined && (newest.tick > this.lastStamped || (this.renderTick !== null && this.renderTick > newest.tick));
    const before = exposed ? this.drawBase() : null;
    const invalidBefore = this._stats.invalid;

    // ONE RECORD PER TICK, not one per frame. The server consumes exactly
    // the record stamped for a tick, never whatever arrived most recently,
    // so a frame that crossed two ticks owes two records or the second
    // starves. `frame()` caps its own advance at `TICK_STEP_CAP`, so this
    // loop is bounded by construction; the `max` is the belt for a forward
    // re-anchor larger than that, which simply stamps the last
    // `INPUT_HISTORY` ticks, since an older record cannot be replayed from
    // here anyway.
    const from = Math.max(this.lastStamped + 1, value - INPUT_HISTORY + 1);
    // A JSON copy, taken once per call, and the prediction runs on the copy:
    // the record replayed later is then the record the server applied,
    // whatever the caller does to `input` afterwards. The speculation steps
    // the same copy, so it guesses byte for byte what the stamp will do.
    let data: TInput | undefined;
    if (from <= value) {
      data = JSON.parse(json) as TInput;
      for (let t = from; t <= value; t++) {
        this.records.push({ targetTick: t, data });
        const next = this.step(this.curr, data, this.dt);
        if (isFinitePose(next)) {
          this.curr = next;
        } else {
          // A STEP THAT DID NOT PRODUCE A POSE. One record whose input has
          // an undefined field is enough for a pong-like step to return
          // NaN, and NaN compares false against every gate, so absorbed it
          // poisoned the draw with no exit. It is refused here instead: the
          // prediction is put back on the last finite authoritative pose,
          // the history with it, and the draw snaps there, counted.
          this.invalidate();
        }
        this.setPose(t, { ...this.curr });
        this._stats.stamped += 1;
      }
      if (this.records.length > INPUT_HISTORY) this.records.splice(0, this.records.length - INPUT_HISTORY);
      if (this.poses.length > INPUT_HISTORY + 1) this.poses.splice(0, this.poses.length - (INPUT_HISTORY + 1));
      this.lastStamped = value;
      // THE WHOLE WINDOW ON EVERY PACKET, oldest first, as one JSON array
      // of `{ targetTick, data }`: what a relay's `decodeInput` parses in
      // one line.
      this.conn.send(JSON.stringify(this.records.slice(-INPUT_WINDOW)));
    }

    // THE PLAYHEAD. Its target is one tick behind the newest stamp, by how
    // far the counter is into the next one; it moves toward that by this
    // frame's real time, within the slew, and jumps only past the snap
    // distance. A COUNTER JUMP IS NOT TIME PASSING: a forward re-anchor
    // moves the target three ticks in one frame and the playhead catches it
    // up over thirty, a backward one leaves the target behind and the
    // playhead lets it catch up at nine tenths (on the speculation once it
    // is past the stored poses, which is what keeps it at nine tenths rather
    // than crawling through what is left of them), and in neither case does
    // the drawn pose move faster than the entity or backward along its path.
    const target = value - 1 + tick.fraction;
    const ticks = elapsed / this.dt;
    const was = this.renderTick;
    if (this.renderTick === null) {
      this.renderTick = target;
    } else if (Math.abs(target - this.renderTick) > PLAYHEAD_SNAP_TICKS && tick.anchored) {
      this.renderTick = target;
      this._stats.snaps += 1;
    } else {
      // AN UNANCHORED COUNTER IS PROVISIONAL, so the playhead neither chases
      // it nor snaps to it: it runs at real time through the poses it has
      // until the next snapshot anchors the counter for the epoch, and only
      // then decides between a slew and a snap. `RoomConnection.frame()`
      // unanchors on a frozen render loop and then advances the counter by
      // its capped dt in the same call, before the next snapshot re-anchors
      // it; chasing that capped advance would count the resume as one snap
      // and the re-anchor a frame later as a second, for one tab switch.
      const lo = this.renderTick + ticks * (1 - RENDER_SLEW);
      const hi = this.renderTick + ticks * (1 + RENDER_SLEW);
      this.renderTick = tick.anchored ? Math.min(hi, Math.max(lo, target)) : this.renderTick + ticks;
    }

    // THE SPECULATION, rebuilt for where the playhead is now with this
    // frame's input, whenever it is (or was, a frame ago) past the newest
    // stored pose. The stamps this frame may have landed on top of the old
    // one, so it is never read again once they have: it is rebuilt before
    // anything below draws. On a steady counter this is one length check.
    const last = this.poses[this.poses.length - 1];
    if (last !== undefined && (this.spec.length > 0 || this.renderTick > last.tick)) {
      this.speculate(data ?? (JSON.parse(json) as TInput), this.renderTick);
    }
    // Then the carry, at the playhead the `before` was measured at, which
    // the slew has since moved on from. An invalid step already snapped the
    // whole history onto the fallback and counted it; there is nothing left
    // to glide.
    if (before !== null && this._stats.invalid === invalidBefore) this.carry(before, this.drawBase(was), false);

    // THE DRAW. The history at the playhead, plus the offset, whose
    // per-frame cap is this frame's worth of travel at `maxSpeed`: the glide
    // adds at most the entity's own top speed on top of its motion.
    const base = this.drawBase();
    const off = this.err.sample(elapsed, this.maxSpeed * elapsed, HEADING_MAX_STEP);
    const x = base.x + off.x;
    const y = base.y + off.z;
    if (base.heading === undefined) return { x, y };
    return { x, y, heading: wrapAngle(base.heading + off.heading) };
  }

  /**
   * Per snapshot: the server's pose for this entity at `snapTick`. That pose
   * is authoritative for a tick this entity has already predicted past, so it
   * is not directly comparable to `pose`; the stored records with
   * `targetTick > snapTick` are replayed from it through `step` (the snapshot
   * labelled T already reflects the record stamped T, see the input timeline
   * rule in `RoomRuntime.currentTick`) and the two are on the same tick
   * again. The result is adopted in full, the whole pose history moves by
   * the same delta, and the difference MEASURED AT THE PLAYHEAD goes to the
   * glide, or the offset is dropped outright (a snap) on the first
   * confirmation and when the offset would otherwise grow past the snap
   * distance. On a healthy link the difference is the snapshot's own
   * quantisation and nothing else.
   *
   * An `authoritative` that is not a finite pose is refused: the offset is
   * reset, the refusal counted on `stats.invalid` and `stats.snaps`,
   * `stats.lastError` set to 0, and the prediction stands. A replay that
   * produces one is refused the same way, with the prediction put back on
   * `authoritative` itself.
   *
   * A snapshot from a RESTARTED TICK COUNT is a snap, not a replay. A
   * `snapTick` more than `INPUT_HISTORY` below the oldest record held is on
   * a count this entity never stamped against (a room that restarted while
   * the connection's rate-limited re-anchor had not yet caught up), and
   * replaying thirty-two records that describe another timeline from it
   * would be a glide to nowhere; the authoritative pose is adopted outright
   * and counted. Anything nearer is an ordinary early snapshot (the first
   * few of a fresh seat sit below every record by the lead) and replays.
   */
  reconcile(authoritative: Pose, snapTick: number): void {
    this.observeEpoch(this.conn.tick.anchored);
    if (!isFinitePose(authoritative)) {
      // NEVER ABSORB NaN. The offset would carry it into every draw from
      // here on, and no gate below would ever fire again because NaN
      // compares false against all of them.
      this.err.reset();
      this._stats.snaps += 1;
      this._stats.invalid += 1;
      this._stats.lastError = 0;
      return;
    }
    const oldest = this.records[0];
    const restarted = oldest !== undefined && snapTick < oldest.targetTick - INPUT_HISTORY;
    // A copy, so a `step` that mutates in place cannot reach back into the
    // caller's snapshot.
    let replayed: Pose = { ...authoritative };
    if (!restarted) {
      for (const rec of this.records) {
        if (rec.targetTick > snapTick) replayed = this.step(replayed, rec.data, this.dt);
      }
    }
    this.lastAuthoritative = { ...authoritative };
    const first = !this.confirmed;
    this.confirmed = true;
    if (!isFinitePose(replayed)) {
      // The step poisoned the replay: the newest finite pose anyone holds is
      // the authoritative one, so the prediction goes there, as a snap.
      this.invalidate();
      return;
    }

    const dx = this.curr.x - replayed.x;
    const dy = this.curr.y - replayed.y;
    const dh =
      this.curr.heading === undefined || replayed.heading === undefined
        ? 0
        : wrapAngle(this.curr.heading - replayed.heading);
    this._stats.lastError = Math.hypot(dx, dy);

    // MOVE EVERY STORED POSE BY THE SAME DELTA. The offset carries the whole
    // correction, so the trajectory the playhead reads has to keep exactly
    // the shape it had; shifting only the newest pose would put the
    // correction into the last segment as well, and the draw would glide it
    // a second time, over one tick, on top of the offset's own decay. The
    // correction the offset absorbs is measured at the playhead, before and
    // after the shift, because that is the point the player is looking at.
    const before = this.drawBase();
    for (const p of this.poses) p.pose = shifted(p.pose, dx, dy, dh);
    // The speculation is the history's continuation under the playhead, so
    // it moves with it; the next `advance` rebuilds it from the shifted
    // newest pose and carries whatever a non-linear step makes of the
    // difference.
    for (const p of this.spec) p.pose = shifted(p.pose, dx, dy, dh);
    this.curr = replayed;
    // SNAP, DELIBERATELY, IN THE CASES A GLIDE IS THE WRONG ANSWER: the
    // first confirmation, where `curr` was a guess at the spawn (and the
    // first of a new epoch, where it is the old epoch's guess), and a count
    // that restarted, where the records describe another timeline. The
    // third case, an offset that would grow past the snap distance, is
    // `carry`'s own.
    this.carry(before, this.drawBase(), first || restarted);
  }

  /**
   * PUT THE ENTITY ON `pose` NOW, for the case a glide is the wrong answer and
   * the GAME is the one that knows it: a respawn, a teleport, a round reset.
   * `reconcile` cannot tell those from an ordinary disagreement, so a respawn
   * closer than `maxSpeed * 0.5` is glided like any other correction and the
   * entity slides to its spawn over half a second. This is the way to say it
   * did not slide.
   *
   * The prediction, the pose history and the speculation are all replaced by
   * `pose` at the current stamping mark, the offset is dropped, and the jump
   * is counted on `stats.snaps`. THE RECORDS ARE KEPT: they name ticks the
   * server has still to apply and the next reconcile still has to replay them;
   * only the poses they produced are gone. The playhead stays where it is,
   * one tick behind the mark, which is where the reseeded pose is, so the draw
   * is `pose` from this frame until the next stamp gives it a segment to move
   * along and then it moves at the entity's own speed.
   *
   * WHEN TO CALL IT: from the game's own event, off the snapshot that carries
   * it (a `respawn` in the event list, say), and BEFORE `reconcile` for that
   * snapshot. The reconcile is then a fresh confirmation, so the server's own
   * answer for the same event snaps onto the truth exactly as a spawn's first
   * snapshot does, rather than gliding in from the pose the entity had before
   * the event.
   *
   * WHEN NOT TO: never as a per-frame correction. A snapshot that disagrees
   * with the prediction is what `reconcile` is for, and the glide is what
   * makes an ordinary disagreement invisible; calling this on every snapshot
   * throws that away and draws the raw error as a jump each time.
   *
   * A `pose` that is not finite is refused with a `RangeError` and nothing
   * changes. Unlike a snapshot, which arrives off a wire and is counted rather
   * than thrown for, this one is the host's own call with the host's own
   * number in it.
   */
  snapTo(pose: Pose): void {
    if (!isFinitePose(pose)) {
      throw new RangeError('PredictedEntity.snapTo: pose must be a finite pose');
    }
    this.curr = { ...pose };
    this.poses.length = 0;
    this.spec.length = 0;
    // The mark is the tick `curr` is the pose after, so that is where the one
    // seeded entry belongs. Before the first stamp there is no mark and the
    // next `advance` seeds the history from `curr` exactly as it always does.
    if (this.lastStamped >= 0) this.poses.push({ tick: this.lastStamped, pose: { ...pose } });
    this.err.reset();
    // THE NEXT SNAPSHOT IS A FIRST CONFIRMATION AGAIN. `pose` is the game's
    // guess at where the event put the entity, which is the standing the
    // spawn guess has, so the server's answer for the same event is adopted
    // with a snap rather than glided in from it.
    this.confirmed = false;
    this._stats.snaps += 1;
  }

  /**
   * Put the prediction and its whole history back on the newest finite
   * authoritative pose (or `initial` before any), drop the offset, and count
   * it as both a snap and an invalid. The one exit from a step or a snapshot
   * that produced something that is not a pose.
   */
  private invalidate(): void {
    const fallback = this.lastAuthoritative ?? this.initial;
    this.curr = { ...fallback };
    for (const p of this.poses) p.pose = { ...fallback };
    this.spec.length = 0;
    this.err.reset();
    this._stats.snaps += 1;
    this._stats.invalid += 1;
    this._stats.lastError = 0;
  }

  /**
   * The offset's share of a correction, measured as the drawn base BEFORE
   * minus AFTER at the playhead: exactly what must be added to the corrected
   * base to leave the rendered pose unchanged this frame, paid for when it
   * happens rather than continuously. Used by `reconcile` for the history
   * shift and by `advance` for a speculative tail redrawn by re-stamping.
   *
   * THE SNAP GATE IS ON THE OFFSET THE ABSORB WOULD PRODUCE, not on the size
   * of this one correction. `absorb` clamps at the snap distance, so a run of
   * corrections each inside it and together past it used to be trimmed there
   * in silence, and the render jumped by the remainder inside a reconcile
   * nothing counted. Gating on the sum means nothing ever reaches `absorb`
   * that the cap would trim: past the distance (or on `snap`, the caller's
   * own reasons) the offset is dropped outright, counted, and the draw jumps
   * to the truth. Both are what `ErrorOffset.reset` exists for.
   */
  private carry(before: Pose, after: Pose, snap: boolean): void {
    const delta = {
      x: before.x - after.x,
      z: before.y - after.y,
      heading: before.heading === undefined || after.heading === undefined ? 0 : wrapAngle(before.heading - after.heading),
    };
    const off = this.err.current();
    const total = Math.hypot(off.x + delta.x, off.z + delta.z);
    if (!Number.isFinite(total)) {
      // Unreachable while both poses are finite, kept as the belt: an offset
      // that is not a number is a draw that never recovers.
      this.err.reset();
      this._stats.snaps += 1;
      this._stats.invalid += 1;
      this._stats.lastError = 0;
      return;
    }
    if (snap || total > this.snapDistance) {
      this.err.reset();
      this._stats.snaps += 1;
      return;
    }
    if (delta.x === 0 && delta.z === 0 && delta.heading === 0) return;
    this.err.absorb(delta);
  }

  /**
   * A false-to-true edge on `tick.anchored` is a NEW CONNECTION EPOCH: the
   * connection unanchored on a reconnect attempt (or a frozen render loop)
   * and the new epoch's first snapshot has just anchored it again, possibly
   * into another room, certainly onto a lead this entity's records were not
   * stamped for. Everything keyed by tick is dropped (the records, the
   * poses, the mark and the playhead, which the next `advance` re-seeds
   * exactly as the first one did) and the entity is unconfirmed again, so
   * the epoch's first reconcile is a counted snap onto its truth rather than
   * a glide from the old room's pose or a replay of thirty-two stale records
   * against a count that restarted. Watched from BOTH calls, because the
   * connection anchors and then hands the host the same snapshot, so the
   * epoch's first `reconcile` lands before its first `advance`.
   */
  private observeEpoch(anchored: boolean): void {
    if (anchored && !this.wasAnchored && this.lastStamped >= 0) {
      this.records.length = 0;
      this.poses.length = 0;
      this.spec.length = 0;
      this.lastStamped = -1;
      this.renderTick = null;
      this.confirmed = false;
      this.err.reset();
    }
    this.wasAnchored = anchored;
  }

  /**
   * The backward re-anchor: put the prediction back on the stored pose
   * after `mark` (the newest at or below it, which is exact on a contiguous
   * history and the nearest guess across a gap a larger forward jump left),
   * move the stamping mark there, and drop the records beyond it. The poses
   * beyond it stay as the speculative tail. A mark below the whole history
   * has no pose to rewind to; the history starts over at the mark from the
   * prediction as it stands, and the next reconcile re-seats it.
   */
  private rewindTo(mark: number): void {
    let i = this.poses.length - 1;
    while (i >= 0 && this.poses[i]!.tick > mark) i--;
    if (i < 0) {
      this.poses.length = 0;
      this.spec.length = 0;
      this.poses.push({ tick: mark, pose: { ...this.curr } });
    } else {
      this.curr = { ...this.poses[i]!.pose };
    }
    this.lastStamped = mark;
    let n = this.records.length;
    while (n > 0 && this.records[n - 1]!.targetTick > mark) n--;
    this.records.length = n;
  }

  /** Record the pose after tick `t`: in place when the tick is already held (a speculative tail being re-stamped), inserted in tick order otherwise. The scan starts at the newest entry, which is where a stamp lands on a steady counter. */
  private setPose(t: number, pose: Pose): void {
    let i = this.poses.length;
    while (i > 0 && this.poses[i - 1]!.tick > t) i--;
    const held = i > 0 ? this.poses[i - 1]! : undefined;
    if (held !== undefined && held.tick === t) held.pose = pose;
    else this.poses.splice(i, 0, { tick: t, pose });
  }

  /**
   * Rebuild the speculation for a playhead at `at`: the newest stored pose
   * stepped by `data` one tick at a time, as many ticks as `at` needs and
   * never more than `PLAYHEAD_SNAP_TICKS` (past that the draw clamps on the
   * last of them). Empty when the playhead is not past the newest stored
   * pose. A step that does not produce a pose ends it early, uncounted:
   * nothing here is history, and the stamp that will apply this input is
   * where an invalid step is refused.
   */
  private speculate(data: TInput, at: number): void {
    this.spec.length = 0;
    const newest = this.poses[this.poses.length - 1];
    if (newest === undefined) return;
    const limit = Math.min(at, newest.tick + PLAYHEAD_SNAP_TICKS);
    let pose: Pose = { ...newest.pose };
    for (let t = newest.tick + 1; t - 1 < limit; t++) {
      const next = this.step(pose, data, this.dt);
      if (!isFinitePose(next)) return;
      pose = next;
      this.spec.push({ tick: t, pose });
    }
  }

  /** The stored poses followed by the speculation, read as one ascending sequence of `poses.length + spec.length` entries. */
  private entry(i: number): PoseAtTick {
    const n = this.poses.length;
    return i < n ? this.poses[i]! : this.spec[i - n]!;
  }

  /**
   * The pose history and its speculation read at `at` (the playhead unless
   * a caller measures where it was): linear on x and y, shortest arc on the
   * heading, clamped to the oldest stored pose behind the history and to
   * the last speculated (or, with none, the newest stored) pose beyond it,
   * and `curr` when there is no history yet. Never includes the offset.
   */
  private drawBase(at: number | null = this.renderTick): Pose {
    const n = this.poses.length + this.spec.length;
    if (this.poses.length === 0 || at === null) return { ...this.curr };
    const newest = this.entry(n - 1);
    if (at >= newest.tick) return { ...newest.pose };
    const oldest = this.poses[0]!;
    if (at <= oldest.tick) return { ...oldest.pose };
    // The playhead sits near the newest entry, so the scan starts there.
    let i = n - 1;
    while (i > 0 && this.entry(i - 1).tick > at) i--;
    const b = this.entry(i);
    const a = this.entry(i - 1);
    const t = (at - a.tick) / (b.tick - a.tick);
    const x = lerp(a.pose.x, b.pose.x, t);
    const y = lerp(a.pose.y, b.pose.y, t);
    if (a.pose.heading === undefined || b.pose.heading === undefined) return { x, y };
    return { x, y, heading: lerpHeading(a.pose.heading, b.pose.heading, t) };
  }
}
