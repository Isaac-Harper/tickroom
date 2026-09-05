// The generic remote-entity smoother: this is the piece that makes OTHER
// players (or cursors, or anything you did not locally predict) look smooth
// despite network jitter, packet loss, and variable frame rate.
//
// The approach is buffered, delayed playback, not "snap to the newest
// packet". Every incoming snapshot is timestamped and buffered; playback runs
// a short distance BEHIND the most recent snapshot, and each rendered frame
// interpolates between the two buffered snapshots that bracket the playback
// point. That short delay is what turns "a new position arrives every 50ms,
// jittering by +-30ms" into motion that reads as perfectly smooth: the
// interpolation always has two real, confirmed data points to blend between,
// rather than needing to guess where an entity is right now.
//
// THE PLAYHEAD RUNS ON SERVER TIME, NOT ON ARRIVAL TIME, and that is the
// single most load-bearing decision in this file. The server emits snapshots
// on a uniform grid (`serverTime` advances by exactly one tick per frame);
// the network then smears their ARRIVAL times around, bunching several into a
// few milliseconds after a head-of-line stall clears and stretching the gap
// between others. Timing playback against arrival stamps replays that smear
// as MOTION: a burst of five snapshots delivered 3ms apart plays a quarter of
// a second of world time in 3ms, which is a visible snap, and a stretched gap
// plays the same motion in slow motion. Measured on a constant-velocity
// entity (true speed 100 u/s) under a bursty profile, arrival-clock playback
// rendered a peak speed of 1568 u/s, a standard deviation of 144, 18 frames
// above 300 u/s and 9 BACKWARD steps (the entity visibly rewinding up to 14
// units), where server-clock playback of the identical frames rendered a peak
// of 261, a deviation of 20.7, and zero of either. Interpolating on
// `serverTime` reproduces the server's own uniform timeline regardless of
// when the bytes happened to land.
//
// `receivedAt` is still REQUIRED, for exactly one job: estimating the offset
// between the local clock and the server's, so a local `nowMs` can be turned
// into a server-clock playhead at all. See `estimateOffset` below.
//
// THAT OFFSET ESTIMATE IS SLOW ON PURPOSE AND THEREFORE NEEDS AN ESCAPE HATCH.
// It is a sliding-window minimum eased under a slew cap, which is right for
// noise and wrong for a genuine step: a route change, a network switch, or a
// ticker handoff onto a machine with its own clock skew moves the true offset
// in one jump, and easing toward a floor the window has not turned over yet
// leaves the playhead stranded off the buffer for tens of seconds. So a
// playhead that stays in a position no buffered frame brackets, WHILE FRAMES
// ARE STILL ARRIVING, re-anchors the offset outright. See `trackPlayheadError`
// for the mechanism and for why "frames are still arriving" is the gate that
// separates a wrong clock estimate from a real outage.
//
// THE OTHER RULE THAT MATTERS MOST, and the one most likely to be
// "simplified" away by someone who has not watched the alternative: on an
// underrun (the playback point runs past the newest buffered snapshot,
// because a packet was late or lost), THE ENTITY MUST EXTRAPOLATE, NEVER
// FREEZE. A frozen entity that then teleports the instant new data arrives
// reads as far worse than one that drifts slightly off true for a moment and
// is gently corrected when the next snapshot lands. This module extrapolates
// by last-known velocity, capped at `EXTRAP_CAP_MS`, and that cap is what
// stops a long outage from sliding an entity arbitrarily far off the truth:
// past the cap it simply stops advancing rather than continuing to guess.
//
// AND THE GUESS IS UNWOUND AS A GLIDE, WHICH IS THE OTHER HALF OF THAT RULE.
// "Gently corrected when the next snapshot lands" is a promise the class did
// not keep: the confirmed pose simply replaced the extrapolated one in a single
// frame, which on a ticker handoff is a 10 unit REWIND at -625 u/s on an entity
// moving at 100. The difference is now an additive offset on the rendered pose
// that decays over `EXTRAP_CAP_MS`, clamped to the displacement the
// extrapolation itself applied, so this smooths only what this module made up
// and a real teleport still arrives as a teleport. See `finishEntity`.
//
// EVERY RATE THIS CLASS MEASURES OR MOVES IS CAPPED AGAINST WALL TIME, and that
// is one idea rather than three. `OFFSET_SLEW_MAX` and `DELAY_SLEW_MAX` bound
// the two terms of the playhead because moving either one IS moving playback in
// time; `FRAME_GAP_SLACK_MS` decides when the caller's `dt` has stopped
// describing real elapsed time, because a rate measured against a clamped `dt`
// is not a rate.

export const INTERP_START_MS = 100;
export const INTERP_MIN_MS = 80;

/**
 * Ceiling on the adaptive delay. THIS IS A CEILING, NOT A COST: the delay is
 * measured from real jitter, so a clean connection settles near
 * `INTERP_MIN_MS` and never approaches this number. Only a connection whose
 * jitter genuinely demands the buffer pays for it, and those are exactly the
 * connections that snap without it.
 *
 * WHY IT IS NOT LOWER. A stall longer than the ceiling cannot be covered by
 * definition, so it snaps EVERY time it occurs, not once: the delay saturates
 * here and stops growing no matter how many times the stall repeats. Measured
 * on a repeating 450ms stall against the old 250ms ceiling: 10 frames above
 * 300 units/second and a peak of 1667 on an entity whose true speed was 100,
 * still spiking 24 seconds into the run with the delay pinned at its maximum.
 * The same profile under a 500ms ceiling is absorbed. A ceiling is worth
 * having only if it sits above the stalls the network actually produces.
 *
 * WHY IT IS NOT HIGHER. This is remote-entity lag: every other player is
 * rendered this far in the past. Covering the 0.5 to 1.2s ticker handoff gap
 * outright would need roughly a second, which is a lot to charge a twitch
 * game for an event that happens on a function duration cap. The handoff is
 * therefore deliberately NOT fully covered here; see `docs/ARCHITECTURE.md`
 * section 1 for the honest arithmetic, and note that a handoff also has the
 * re-anchor as a backstop where an ordinary stall does not.
 */
export const INTERP_MAX_MS = 500;

/** Per-second ease rate the adaptive delay approaches its jitter-derived target at. Not snapped, because a sudden delay change is itself a visible discontinuity: everything rendered through this interpolator would jump forward or back in time by the delta. */
export const INTERP_ADAPT_LAMBDA = 0.7;

/**
 * Maximum fraction of real elapsed time the adaptive delay may slew by. THE
 * SAME QUANTITY `OFFSET_SLEW_MAX` CAPS, ON THE OTHER TERM OF THE SAME SUM.
 *
 * The playhead is `now - offset - delay`, so moving the DELAY moves playback in
 * time exactly the way moving the offset does, and this file already puts the
 * perceptibility limit for that at a few percent of wall time (see
 * `OFFSET_SLEW_MAX`, 5%). The delay had no cap at all: `INTERP_ADAPT_LAMBDA`
 * eases 0.7 of the remaining DIFFERENCE per second, which on a 320ms correction
 * is 224ms of playback time moved in the first second, forty-five times the
 * rate the offset next to it is allowed to move at. Uncapped, one 450ms hold on
 * an otherwise calm link cost 126 rendered frames outside +-10% of true speed:
 * 48 of them as slow as 0.83x while the delay grew, then, seconds later when
 * the burst aged out of the offset window, 78 as fast as 1.21x while it came
 * back down. The repeating-stall profile is why that was never noticed; its
 * delay saturates at the ceiling and never comes down at all.
 *
 * 0.08 IS MEASURED AND IT IS THE ONLY SWEPT VALUE THAT SATISFIES BOTH ENDS. The
 * two profiles pull in opposite directions: a ONE-OFF hold wants the smallest
 * cap it can get, because everything the delay does afterwards is a correction
 * nobody asked for, while a REPEATING stall wants the largest, because the
 * buffer has to reach its depth before the stall comes round again (which is
 * the whole argument for `INTERP_MAX_MS` being 500). Rendered frames outside
 * +-10% of a 100 u/s entity's true speed, and the repeating profile's peak:
 *
 *   cap     one-off hold        repeating 450ms stall
 *   none    126 (0.83x/1.21x)   0, peak 100
 *   0.12    178 (0.88x/1.12x)   0, peak 100
 *   0.10    106 (0.90x/1.10x)   0, peak 100
 *   0.08    0   (0.92x/1.08x)   0, peak 100
 *   0.06    0   (0.94x/1.06x)   12, peak 117
 *   0.04    0   (0.96x/1.04x)   29, peak 173
 *   0.02    0   (0.98x/1.02x)   83, peak 275
 *
 * Both tests are in `interpolation.test.ts` and both bind, so this cannot be
 * moved in either direction without one of them going red.
 *
 * THE TRADE IS DELIBERATE AND IT IS THE OFFSET'S TRADE. A 320ms increase now
 * takes four seconds at a rate nobody can see instead of one and a half at a
 * rate everybody can. What arriving late at the right buffer depth costs is a
 * few more extrapolated frames in the meantime, which is a mechanism this file
 * already has and already bounds; what arriving fast costs is a speed error on
 * every remote entity on screen, which nothing bounds and everybody sees. The
 * same reasoning charges the widest correction the delay can make (420ms, floor
 * to ceiling) 5.25 seconds, and the latency-step test measures what that looks
 * like: 400ms of extra staleness for two seconds after a re-anchor, rather than
 * every entity running 20% fast for one.
 *
 * THE SNAP IN `reanchor()` IS DELIBERATELY NOT SUBJECT TO THIS. That is the
 * one-frame correction the class has already decided to spend, in the case
 * where the clock estimate is not noisy but wrong; a slew there would leave the
 * ease still in flight, which is the exact half-correction that test names.
 */
export const DELAY_SLEW_MAX = 0.08;

/** How far past the newest confirmed snapshot an entity may extrapolate before it stops advancing and simply holds its last extrapolated pose. Also the length of the glide that unwinds that extrapolation when the stream comes back: see `finishEntity`. */
export const EXTRAP_CAP_MS = 150;

/**
 * Ceiling on the resume glide taken by `resumeFrom`, expressed as how many
 * milliseconds of the entity's own measured speed the glide may cover.
 *
 * THE UNWIND GLIDE'S CLAMP CANNOT BE THE ONE USED HERE, and the reason is the
 * whole difference between the two events. `finishEntity`'s clamp is "this
 * module may only hide what this module made up", measured against the
 * extrapolation's own displacement, and across a reconnect that displacement is
 * ZERO: nothing was extrapolated, the connection was down and the poses were
 * simply held. The world genuinely moved in the meantime, so every unit of the
 * difference is real, and the honest alternatives are a snap or a glide. This
 * file already answers that question everywhere else it comes up, and so does
 * `ErrorOffset` for the local player: glide it, because a correction the player
 * can watch beats a correction that happens between two frames.
 *
 * A second of the entity's own speed is a bound rather than a policy. It exists
 * so a pose held across a genuinely long outage, or a key reused by a different
 * entity, cannot buy an arbitrarily long lie; at any ordinary reconnect the
 * outage is a fraction of that and the clamp never binds. With no measured
 * speed to scale (the common case, since `clear()` has just dropped the motion
 * state the speed lived in) there is nothing to bound it with and the glide is
 * unclamped, which is the same trade made deliberately rather than by accident.
 */
export const RESUME_GLIDE_MAX_MS = 1000;

/**
 * How far `sample()`'s own elapsed local time may exceed the `dt` it was handed
 * before the frame is treated as DISCONTINUOUS rather than as an ordinary
 * render step.
 *
 * The two are the same number on every healthy frame, and they are not the same
 * number after a render gap, because a caller is right to clamp `dt`:
 * `RoomConnection.frame()` clamps it to 0.25s so one stalled frame cannot
 * advance a whole simulation at once, and then passes the REAL `nowMs`
 * alongside it. The playhead moves with `nowMs`, so a 30 second gap moves
 * playback 30 seconds while `dt` still says a quarter of one, and
 * `finishEntity` divided the resulting 30 seconds of displacement by 0.25 and
 * reported 10,000+ u/s on an entity moving at 100. `InterpolatedEntity.speed`
 * is documented as the animation driver, so that is a run sprint no entity
 * performed, for a dozen frames, on a tab that was simply in the background.
 *
 * 100ms of slack is far more than the float residue of an accumulated render
 * clock or one late frame, and far less than any gap worth calling one.
 */
export const FRAME_GAP_SLACK_MS = 100;

/**
 * How long the playhead may sit in a position no buffered frame brackets
 * before the clock offset is RE-ANCHORED outright instead of being eased.
 *
 * The offset is a sliding-window minimum approached under a slew cap, and both
 * of those are deliberately slow. That is right for noise and wrong for a
 * genuine STEP: a route change that adds a second of one-way delay, a ticker
 * handoff whose successor stamps `serverTime` from a differently skewed
 * `Date.now()`, a mobile client moving between networks. In every one of those
 * the offset estimate is not noisy, it is WRONG, and easing toward a floor the
 * window has not turned over yet costs roughly twenty times the step in
 * degraded playback: a +1000ms latency step measured 22.5 SECONDS of continuous
 * extrapolation, rendering a 20Hz stop-go staircase, before the old floor aged
 * out of the window.
 *
 * 600ms sits between the two thresholds that bracket it. It is comfortably
 * above `EXTRAP_CAP_MS` (150) plus a wide margin, so ordinary jitter, a dropped
 * packet, or one head-of-line stall never reaches it. It is comfortably below
 * `STALL_MS` (4000, in `netPolicy.ts`), so a client whose clock estimate went
 * wrong self-heals well before the stall banner would tell the player the world
 * might be frozen.
 */
export const REANCHOR_AFTER_MS = 600;

/**
 * Minimum frames that must have LANDED since the error window opened before
 * the offset is re-anchored on them.
 *
 * The gate this strengthens used to be "at least one", which is enough to tell
 * a wrong clock estimate from an outage but not enough to tell it from a single
 * unlucky packet. One straggler carrying a huge one-way delay is one sample,
 * and the re-anchor adopted its raw offset outright, with no slew to soften it:
 * measured on a repeating stall that dribbles one queued packet through
 * mid-stall, it adopted `offset = 640` against a true offset of 40 and then
 * held that 600ms error for about twelve seconds while the 5% slew walked it
 * back, for a mean position error of 16 to 55 units over the rest of the run.
 * The same single-sample anchor fires once per straggler during a congested
 * order-preserving dribble, which measured SEVEN re-anchors in five seconds,
 * each one a 17 unit backward step, in exactly the mechanism whose own
 * observability doc says a climbing count means the estimate is not converging.
 *
 * FIVE IS MEASURED, not chosen. Swept over 3, 4, 5, 6 and 8 against the
 * profiles above plus clean ticker handoffs, dying tickers whose publish rate
 * collapses, flapping links and gaps with stragglers: 5 is the smallest value
 * at which EVERY one of those benign profiles produces zero re-anchors, and it
 * takes the congested dribble from seven re-anchors in five seconds down to
 * two, with the backward step at each one gone. Going higher (6, 8) bought
 * nothing on the benign profiles and only trades more delay for one
 * pathological one.
 *
 * It costs nothing on a real step, because the count has a whole
 * `REANCHOR_AFTER_MS` window to fill and any ordinary snapshot rate fills it
 * far sooner: 5 frames is 250ms at 20Hz and 500ms at 10Hz, both inside the
 * 600ms window. Below the threshold the class simply keeps waiting, and
 * extrapolate-then-hold is already the correct behaviour while the evidence is
 * thin.
 */
export const REANCHOR_MIN_SAMPLES = 5;

/**
 * How far BELOW the current offset floor a frame's implied one-way delay may
 * sit before the frame is refused at the door as corrupt.
 *
 * `receivedAt - serverTime` is the clock difference plus that packet's one-way
 * delay, and delay is never negative, so the sliding-window MINIMUM is the
 * floor. A frame can legitimately sit anywhere ABOVE that floor (that is just
 * jitter), and it can legitimately pull the floor DOWN only by as much
 * one-way delay as was really in the previous best sample: tens of
 * milliseconds, low hundreds on a bad path. It cannot pull it down by seconds,
 * because that would mean the previous best packet had spent seconds in flight
 * while every other packet in the window did not.
 *
 * A frame stamped far in the FUTURE is exactly that impossible sample, and it
 * used to be accepted, because the only check was `Number.isFinite`. One such
 * frame is permanent: it is always the buffer's newest end, so
 * `i === this.frames.length - 1` can never be true again, which switches OFF
 * the underrun branch, the `extrapolated` flag, `underrunRate` AND the
 * re-anchor's own past-the-newest detection for as long as it leads the
 * playhead. Measured with one frame stamped 30 seconds ahead and the stream
 * then stopping for five seconds: the entity drifted 333 units BACKWARD while
 * reporting `extrapolatedFrames = 0/300` and `underrunRate = 0.000`, i.e. it
 * broke the never-freeze rule and lied about its own health at the same time.
 * `observeInterval` was poisoned with it too, freezing `intervalWindow` for the
 * rest of the connection because no later frame could beat that `serverTime`.
 *
 * A full second of slack is far more than any real improvement in one-way
 * delay and far less than the timeline steps this is meant to catch.
 */
export const OFFSET_FLOOR_SLACK_MS = 1000;

/**
 * Floor-refused frames WITHIN `TIMELINE_STEP_WINDOW` after which the refusal
 * STOPS and the new timeline is adopted instead.
 *
 * Refusing forever would be worse than the bug it prevents. A server clock
 * that genuinely steps forward (a handoff onto a machine whose clock runs
 * ahead) trips the same test as a corrupt frame does, and every subsequent
 * frame trips it too, so a permanent refusal is a permanent stall: no frame
 * ever reaches the buffer again. A corrupt frame is a ONE-OFF by nature (the
 * next frame from the same stream is normal again); a clock step is SUSTAINED.
 * Counting refusals is what tells them apart.
 *
 * Three is one and a half snapshot intervals at 20Hz, so believing the step
 * costs about 150ms of refused frames rather than the 600ms
 * `REANCHOR_AFTER_MS` would have cost, and a single bad frame still never
 * moves the anchor.
 */
export const TIMELINE_STEP_FRAMES = 3;

/**
 * How many judged frames the `TIMELINE_STEP_FRAMES` count is taken over. THE
 * COUNT IS WINDOWED, NOT CONSECUTIVE, AND THAT DISTINCTION IS A FIX RATHER
 * THAN A REFINEMENT.
 *
 * It used to be a run of CONSECUTIVE refusals, reset by the first frame that
 * landed back near the floor. That is not invariant to arrival ORDER, and
 * `push()` documents out-of-order arrivals as ordinary. The event that most
 * needs the escape hatch reorders the stream BY DEFINITION: a latency DROP
 * larger than the slack leaves packets already in flight arriving on the old
 * schedule, so old and new interleave, and every old one reset the counter.
 * Measured on a 3000ms base one-way delay dropping by 1001ms: 23 legitimate
 * frames refused across the overlap with `reanchors` still 0, then a 6106 u/s
 * spike once the overlap finally cleared, where the same drop one millisecond
 * smaller refused nothing at all and peaked at 133.
 *
 * A window keeps both properties the consecutive count had. A one-off corrupt
 * stamp is one refusal in twelve frames and never approaches the threshold
 * however many times it recurs, as long as it recurs sparsely; a genuine step
 * refuses every frame and reaches the threshold in four. Twelve frames is
 * 600ms at 20Hz, comfortably longer than the reorder overlap a slack-sized
 * latency drop can produce and comfortably shorter than the interval at which
 * an isolated bad stamp would have to arrive to accumulate.
 */
export const TIMELINE_STEP_WINDOW = 12;

/** Raw clock-offset samples retained for the local-to-server clock estimate. Sized so the tail of a jitter distribution is actually representable (a one-in-fifty spike exists in the window rather than being averaged out of it) and so that at a 20Hz snapshot rate the window spans a few seconds, which is short enough for the estimate to track genuine clock drift. */
export const OFFSET_WINDOW = 128;

/** Maximum fraction of real elapsed time the clock offset may slew by. The offset is subtracted from the playhead, so moving it IS moving playback in time, and moving it faster than a few percent of wall time is perceptible as remote entities briefly running fast or slow. 5% is below that threshold and still closes a 100ms clock correction in two seconds. */
export const OFFSET_SLEW_MAX = 0.05;

/** Quantile of the measured jitter-above-the-floor that the adaptive delay covers. Chosen by measurement, not by taste: see the note on `recomputeTargetDelay`. */
export const DELAY_JITTER_QUANTILE = 0.99;

/**
 * Fixed headroom added on top of the jitter quantile and one snapshot
 * interval. ZERO by measurement rather than by taste: the `interval` term
 * already puts the playhead a full snapshot period behind the newest frame,
 * which is the headroom a fixed margin would otherwise be buying, and adding
 * 16ms on top (one 60Hz render frame) changed no quality metric at all on
 * three network profiles at 60, 30 and 24Hz render rates while costing 16ms
 * of standing latency. It stays as a knob for a host whose local clock is
 * coarse enough that the offset estimate carries real bias, which is the one
 * case this cannot be measured against here.
 */
export const DELAY_MARGIN_MS = 0;

/** How many frames outward the bracket search may scan for an entity that a bracketing frame happens to omit. A few frames covers a transient omission (an entity culled from one snapshot, an entity that joined mid-bracket) without letting a long-gone entity be interpolated against ancient data. */
export const PARTIAL_SCAN_FRAMES = 4;

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
  heading?: number | undefined;
  [k: string]: unknown;
}

export interface InterpolatedEntity extends EntitySample {
  /** Low-passed magnitude of this entity's own rendered motion, units/second. Measured from the interpolator's OWN output, not carried on the wire, because a coarse wire enum (walk/run/idle) cannot describe an entity mid-acceleration; this can. */
  speed: number;
  /** True this frame only if the playback point ran past the newest confirmed snapshot and this pose is a velocity-based guess rather than an interpolation between two confirmed points. */
  extrapolated: boolean;
}

export interface SnapshotFrame<K extends string | number> {
  /**
   * Local clock (matching whatever clock `sample()`'s `nowMs` uses) at the
   * moment this frame was received. REQUIRED, and it is the sole input to the
   * local-to-server clock offset estimate: without it there is no way to turn
   * a local `nowMs` into a position on the server's timeline at all. It is NOT
   * the playback axis (`serverTime` is); an arrival stamp records when the
   * network chose to deliver a byte, which is precisely the noise this module
   * exists to remove rather than replay.
   */
  receivedAt: number;
  /**
   * The server clock stamp carried in the snapshot. THE PLAYBACK AXIS: frames
   * are ordered by it, brackets are found on it, interpolation fractions and
   * extrapolation velocities are computed against it. It only has to be a
   * monotonic millisecond stamp from the authority's own clock; it does not
   * have to agree with the local clock, since the offset between the two is
   * measured and removed.
   */
  serverTime: number;
  entities: Map<K, EntitySample>;
}

export interface InterpolatorOptions {
  minDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  startDelayMs?: number | undefined;
  extrapCapMs?: number | undefined;
  /** Frames retained in the playback buffer. A hard upper bound only: frames the playhead has moved safely past are pruned by TIME before this ever binds, so a delivery burst cannot evict a frame the playhead still needs just by filling the buffer. */
  bufferCap?: number | undefined;
  /** An entity unseen in any pushed frame for this long is dropped from the output entirely. */
  dropAfterMs?: number | undefined;
  /** Time constant, seconds, for the per-entity speed low-pass. Short against a real acceleration, long against one frame of interpolation noise. */
  speedTau?: number | undefined;
  /** Raw clock-offset samples kept for the offset floor and the jitter estimate. Defaults to `OFFSET_WINDOW`. */
  offsetWindow?: number | undefined;
  /** Maximum fraction of real elapsed time the clock offset may slew by. Defaults to `OFFSET_SLEW_MAX`. */
  offsetSlewMax?: number | undefined;
  /** Quantile of measured jitter the adaptive delay covers. Defaults to `DELAY_JITTER_QUANTILE`; 1 makes it the window maximum. */
  delayQuantile?: number | undefined;
  /** Fixed headroom added to the adaptive delay target. Defaults to `DELAY_MARGIN_MS`. */
  delayMarginMs?: number | undefined;
}

/** What an extrapolated frame guessed with: the velocity it used and how much of `extrapCapMs` it had left to run. `finishEntity` needs both to unwind the guess when confirmed data comes back. */
interface ExtrapGuess {
  vx: number;
  vy: number;
  leftMs: number;
}

/**
 * Per-entity render state, all of it about CONTINUITY between one rendered
 * frame and the next, and all of it dropped by `clear()` and `forget()` along
 * with the rest of the per-entity state (a new epoch has nothing to be
 * continuous with).
 */
interface EntityMotionState {
  /** The last pose this entity was RENDERED at, unwind offset included, because that is the pose the host actually drew and therefore the only one the next frame can be continuous with. */
  x: number;
  y: number;
  heading: number;
  speed: number;
  hasPrev: boolean;
  /** True if the pose above was extrapolated (or held past the cap) rather than bracketed between two confirmed frames. The unwind glide fires on the edge from this to bracketed. */
  wasExtrapolated: boolean;
  /** The guess that produced it: the velocity the extrapolation used and how much of `extrapCapMs` it had NOT yet spent. Enough to ask what the guess would have said on the transition frame, and (with the spent half) how far the guess had moved the entity, which is the ceiling on the glide. */
  extrapVX: number;
  extrapVY: number;
  extrapLeftMs: number;
  /** Additive offset on the rendered pose that absorbs the step out of extrapolation, and the local milliseconds left to glide it to zero. */
  offX: number;
  offY: number;
  offHeading: number;
  offMsLeft: number;
}

/**
 * Real wall clock, matching what a browser caller almost always uses for
 * `push()`'s `receivedAt` (`performance.now()`, falling back to `Date.now()`
 * in an environment without it, e.g. a test or a non-browser host). This is
 * `sample()`'s default when `nowMs` is omitted: see the note on `sample()`
 * for why a self-accumulated fallback clock used to live here instead, and
 * why that was wrong.
 */
function wallClockMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
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

/**
 * Linear-interpolated quantile of an already-ascending array.
 *
 * The index math is deliberate. The previous estimator used
 * `ceil(n * q) - 1`, which at n = 20 and q = 0.95 is `ceil(19) - 1 = 18`, one
 * short of the last index: the single largest sample in the window could
 * never be selected no matter what it was, so exactly one big spike per
 * window (the case a jitter buffer exists for) was structurally discarded.
 * Positioning at `(n - 1) * q` cannot do that: q = 1 selects the maximum,
 * which is also what makes "cover the worst gap in the window" expressible as
 * a plain quantile rather than a special case.
 */
function quantileAsc(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const pos = clamp(q, 0, 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  if (hi === lo) return a;
  return a + (sorted[hi]! - a) * (pos - lo);
}

function medianAsc(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * `K` HAS NO DEFAULT, DELIBERATELY, and it used to default to `number`.
 *
 * The key is whatever the host's snapshot identifies an entity by, and this
 * library ships two paths that disagree about what that is: every pid it hands
 * a simulation is a `string` (join, leave, applyInput, RoomStats), while the
 * default codec's `CodecEntity.id` is a `number`. So there is no answer that is
 * right by default, only an answer that is silently wrong for one of the two.
 * A default of `number` also meant a JSON host keyed by pid got a `Map<number,
 * ...>` it then failed to look anything up in, and the fix shipped for it was
 * fifteen lines of README telling the reader off for a mistake the compiler was
 * already able to catch, plus advice that is actively wrong on the codec path.
 * Naming the key type at every call site costs eight characters and turns the
 * whole class of mistake into one compile error.
 */
export class SnapshotInterpolator<K extends string | number> {
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly startDelayMs: number;
  private readonly extrapCapMs: number;
  private readonly bufferCap: number;
  private readonly dropAfterMs: number;
  private readonly speedTau: number;
  private readonly offsetWindowCap: number;
  private readonly offsetSlewMax: number;
  private readonly delayQuantile: number;
  private readonly delayMarginMs: number;

  private frames: SnapshotFrame<K>[] = [];
  private lastSeenAt = new Map<K, number>();
  private motion = new Map<K, EntityMotionState>();
  /** Poses a reconnecting host was holding on screen, waiting for their entity's first render of the new epoch. Empty except in the moments after `resumeFrom`. See that method. */
  private resumeSeed = new Map<K, { x: number; y: number; heading?: number | undefined; speed: number }>();

  private localClockMs = 0;
  /** How far the playhead moved on THIS `sample()` call, in server-clock ms. Read by `finishEntity` to project a guess forward one frame; it is the same number for every entity, so it is computed once rather than passed nine arguments deep. */
  private playheadStepMs = 0;
  /** Playhead of the previous `sample()` call, or null before the first one. */
  private lastPlayServerTime: number | null = null;
  /** Local clock at the previous `sample()`, or null before the first one. The reference the caller's `dt` is checked against: see `FRAME_GAP_SLACK_MS`. */
  private lastSampleLocalMs: number | null = null;

  /** Sliding window of `receivedAt - serverTime`. Its MINIMUM is the clock offset estimate; the spread above that minimum is the jitter the delay has to cover. */
  private offsetWindow: number[] = [];
  /** Sliding window of positive `serverTime` deltas, i.e. the server's own emission interval as observed. */
  private intervalWindow: number[] = [];
  private offsetMs = 0;
  private offsetSeeded = false;
  private lastArrivalAt: number | null = null;
  private lastServerTime: number | null = null;
  /** Highest `serverTime` among the frames that have landed SINCE the error window opened, or null while none has. Not the same as `lastServerTime` (the highest ever seen): the two differ exactly when the authority's clock steps backwards, which is the case the re-anchor's dead-epoch cut has to tell apart. */
  private errorWindowNewestServerTime: number | null = null;
  /** Raw offsets of the frames refused for sitting below the offset floor, within the current window. See `refuseSteppedFrame`. */
  private steppedOffsets: number[] = [];
  /** Frames judged since the FIRST refusal in `steppedOffsets` landed, so the count above can be aged out as a window rather than reset by one in-floor arrival. See `TIMELINE_STEP_WINDOW`. */
  private steppedWindowFrames = 0;
  /** Raw offset of the frame that SEEDED the estimate, while that seed is still provisional, or null once it has been corroborated or discarded. See `refuteSeedFrame`. */
  private seedOffsetMs: number | null = null;
  /** Raw offsets of the run of consecutive frames that have CONTRADICTED the provisional seed, and the newest `serverTime` among them. */
  private seedRefutations: number[] = [];
  private seedRefutationNewest = -Infinity;
  /** Median of `intervalWindow`, cached because both the delay target and the buffer prune horizon need it. */
  private intervalMs = 0;

  private currentDelayMs: number;
  private targetDelayMs: number;

  private underrunEma = 0;

  /** Frames refused at the door for carrying a non-finite timestamp. Counted rather than thrown or logged, for the same reason `underrunRate` is: a host can poll it, and a decoder that starts omitting a field shows up as a number climbing rather than as silence. */
  private rejectedFrameCount = 0;
  /** Local-clock time the playhead first landed somewhere no buffered frame brackets, or null while it is bracketed normally. */
  private playheadErrorSinceMs: number | null = null;
  /** Frames that have landed since `playheadErrorSinceMs` was set. THE GATE on re-anchoring: see `trackPlayheadError`. */
  private pushesSinceErrorStart = 0;
  private reanchorCount = 0;

  constructor(opts: InterpolatorOptions = {}) {
    this.minDelayMs = opts.minDelayMs ?? INTERP_MIN_MS;
    this.maxDelayMs = opts.maxDelayMs ?? INTERP_MAX_MS;
    this.extrapCapMs = opts.extrapCapMs ?? EXTRAP_CAP_MS;
    this.bufferCap = opts.bufferCap ?? 60;
    this.dropAfterMs = opts.dropAfterMs ?? 6000;
    this.speedTau = opts.speedTau ?? 0.12;
    this.offsetWindowCap = Math.max(2, opts.offsetWindow ?? OFFSET_WINDOW);
    this.offsetSlewMax = opts.offsetSlewMax ?? OFFSET_SLEW_MAX;
    this.delayQuantile = opts.delayQuantile ?? DELAY_JITTER_QUANTILE;
    this.delayMarginMs = opts.delayMarginMs ?? DELAY_MARGIN_MS;

    this.startDelayMs = clamp(opts.startDelayMs ?? INTERP_START_MS, this.minDelayMs, this.maxDelayMs);
    this.currentDelayMs = this.startDelayMs;
    this.targetDelayMs = this.startDelayMs;
  }

  get delayMs(): number {
    return this.currentDelayMs;
  }

  get underrunRate(): number {
    return this.underrunEma;
  }

  /** How many pushed frames have been refused at the door: a non-finite `serverTime` or `receivedAt`, or a `serverTime` so far in the future that the frame's implied one-way delay is impossible. Non-zero means the decoder or the authority above this is producing timestamps it should not, which is a host bug worth surfacing rather than absorbing silently. */
  get rejectedFrames(): number {
    return this.rejectedFrameCount;
  }

  /** How many times the clock offset has been re-anchored outright rather than eased. Non-zero is not an error (a route change or a ticker handoff legitimately causes one), but a number that keeps climbing means the offset estimate is not converging. */
  get reanchors(): number {
    return this.reanchorCount;
  }

  /**
   * Buffer one snapshot.
   *
   * Frames are kept sorted by `serverTime`, not by arrival: the bracket search
   * runs on the server timeline, so an out-of-order arrival is simply a frame
   * that belongs earlier in the buffer, not an anomaly to be papered over. That
   * also means a late packet slots into the past where it belongs and is
   * available to the playhead if the playhead has not reached it yet, instead
   * of being appended after newer data and corrupting the bracket ordering.
   *
   * THIS IS A TRUST BOUNDARY, exactly like `ByteReader` in `src/codec/bytes.ts`.
   * The types say `number`, but that is a compile-time claim about a value that
   * crossed a decode boundary written by the host: the README quickstart passes
   * `serverTime: snap.serverTime` straight out of a host-defined codec, and a
   * codec that simply omits the field hands over `undefined`, whose arithmetic
   * is NaN. ONE such frame used to poison the interpolator permanently. The NaN
   * reached the offset window, the delay quantile and then `currentDelayMs`,
   * where an exponential ease can never leave NaN again; the playhead was NaN
   * forever, every bracket comparison was false, and playback pinned to
   * `frames[0]` for the rest of the connection with the socket, the snapshot
   * rate and `underrunRate` all reading healthy. Only `clear()` escaped it.
   * A rejected frame is therefore refused BEFORE it touches any accumulator: it
   * is not buffered, and it perturbs neither the offset, the interval estimate,
   * nor the delay.
   *
   * FINITE IS NOT THE SAME AS PLAUSIBLE, which is the second half of the same
   * boundary and cost a second permanent poisoning. A frame stamped far in the
   * FUTURE passes every finiteness check and is then the buffer's newest end
   * forever. See `refuseSteppedFrame` for what that switches off and for how a
   * corrupt stamp is told apart from an authority whose clock really stepped.
   */
  push(frame: SnapshotFrame<K>): void {
    if (!Number.isFinite(frame.serverTime) || !Number.isFinite(frame.receivedAt)) {
      this.rejectedFrameCount++;
      return;
    }
    if (this.refuseSteppedFrame(frame)) return;
    this.refuteSeedFrame(frame);

    // Evidence that data is still flowing, which is what separates "the clock
    // estimate is wrong" from "the world went quiet". See `trackPlayheadError`.
    // The newest stamp among those arrivals is also what the re-anchor cuts the
    // dead epoch against, so it is tracked here rather than derived later.
    if (this.playheadErrorSinceMs !== null) {
      this.pushesSinceErrorStart++;
      if (this.errorWindowNewestServerTime === null || frame.serverTime > this.errorWindowNewestServerTime) {
        this.errorWindowNewestServerTime = frame.serverTime;
      }
    }

    this.estimateOffset(frame);
    this.observeInterval(frame);
    this.recomputeTargetDelay();

    let i = this.frames.length;
    while (i > 0 && this.frames[i - 1]!.serverTime > frame.serverTime) i--;
    this.frames.splice(i, 0, frame);
    this.pruneFrames(frame.receivedAt);

    for (const key of frame.entities.keys()) {
      this.lastSeenAt.set(key, frame.receivedAt);
    }
  }

  /**
   * Refuse a frame whose `serverTime` is impossibly far in the FUTURE, and
   * stop refusing once it is clear the authority's clock really moved. Returns
   * true when the frame must not be buffered.
   *
   * The test is on the frame's implied one-way delay, `receivedAt -
   * serverTime`, against the sliding-window floor that `estimateOffset`
   * already maintains. Above the floor is ordinary jitter. Below it by more
   * than `OFFSET_FLOOR_SLACK_MS` is not a network condition at all: it would
   * mean the best packet in the window had spent a full second longer in
   * flight than this one, which no real path does. A future-stamped frame is
   * exactly that sample, and it is not merely one bad pose. Being the newest
   * end of the buffer permanently, it makes `i === this.frames.length - 1`
   * unreachable, which switches off the underrun branch, the `extrapolated`
   * flag, `underrunRate` and the re-anchor's past-the-newest detection all at
   * once, and it freezes `observeInterval` because nothing can beat its stamp.
   * Refusing it here keeps all of that local to the one frame.
   *
   * REFUSING FOREVER WOULD BE WORSE THAN THE BUG. A genuine forward clock step
   * (a handoff onto a machine running ahead) looks identical on the first
   * frame, and on every frame after it, so a refusal with no way out is a
   * total stall. What separates them is persistence: a corrupt stamp is a
   * one-off, while a stepped clock keeps arriving. Past `TIMELINE_STEP_FRAMES`
   * refusals WITHIN `TIMELINE_STEP_WINDOW` judged frames the evidence is a
   * timeline, not a glitch, so the collected offsets become the new anchor
   * through the same escape hatch a stranded playhead uses, and the frame that
   * proved it is accepted normally.
   *
   * THE COUNT IS OVER A WINDOW RATHER THAN OVER A CONSECUTIVE RUN, because a
   * run is not invariant to arrival order and `push()` documents out-of-order
   * arrivals as ordinary. See `TIMELINE_STEP_WINDOW` for the latency-drop
   * profile that reorders the stream by construction and for what a
   * consecutive count measured on it.
   */
  private refuseSteppedFrame(frame: SnapshotFrame<K>): boolean {
    // Nothing to be implausible against until the estimate has been seeded:
    // the first frame of a connection defines the floor rather than being
    // measured against it. Both timestamps are already known finite, because
    // the finiteness guard in `push()` runs first, so `rawOffset` below cannot
    // be NaN and no NaN can reach `steppedOffsets`. That ordering is load
    // bearing: the two guards are independent, and each on its own also
    // happens to refuse a non-finite frame, which is why deleting either one
    // alone leaves the non-finite tests green and deleting both reddens them.
    if (!this.offsetSeeded) return false;

    // Age the window BEFORE judging this frame, so the count always describes
    // the last `TIMELINE_STEP_WINDOW` frames judged. An in-floor frame no
    // longer clears the count on its own: under a slack-sized latency drop the
    // stream reorders and old, still-below-floor frames interleave with new
    // in-floor ones, so a clear-on-first-good rule can never accumulate the
    // evidence the escape hatch needs, and it is exactly the profile that
    // needs it most.
    if (this.steppedOffsets.length > 0 && ++this.steppedWindowFrames > TIMELINE_STEP_WINDOW) {
      this.steppedOffsets.length = 0;
      this.steppedWindowFrames = 0;
    }

    const rawOffset = frame.receivedAt - frame.serverTime;
    if (rawOffset >= this.offsetFloor() - OFFSET_FLOOR_SLACK_MS) return false;

    if (this.steppedOffsets.length === 0) this.steppedWindowFrames = 1;
    this.steppedOffsets.push(rawOffset);
    if (this.steppedOffsets.length <= TIMELINE_STEP_FRAMES) {
      this.rejectedFrameCount++;
      return true;
    }

    // The refused run IS the evidence about the new timeline, and it is the
    // only evidence there is: every one of those frames was kept out of the
    // offset window on purpose. Hand it to `reanchor` the way a stranded
    // playhead hands it the frames that landed during its error window.
    this.offsetWindow = this.steppedOffsets.slice();
    this.pushesSinceErrorStart = this.steppedOffsets.length;
    this.reanchor();
    this.steppedOffsets.length = 0;
    this.steppedWindowFrames = 0;
    return false;
  }

  /**
   * Judge the frame that SEEDED the offset estimate, which is the one frame
   * `refuseSteppedFrame` structurally cannot judge.
   *
   * The floor is a sliding-window MINIMUM, so the first frame of a connection
   * does not merely escape the plausibility test, it DEFINES the value every
   * later frame is tested against, and a minimum can only be dragged further
   * down. A future-stamped seed therefore sets a floor no honest frame can ever
   * correct: every real frame afterwards sits ABOVE it, which is indistinguish-
   * able from ordinary jitter, so they are all waved through and the poisoned
   * floor stands until it slides out of a 128-sample window.
   *
   * The damage is not hypothetical, and it is exactly the damage the guard was
   * built to prevent, arriving through the one door the guard does not cover.
   * Measured on a 20Hz stream of an entity moving at a constant 100 u/s: the
   * SAME +1500ms stamp costs nothing at all mid-run (one frame refused, peak
   * rendered speed 101 u/s, zero rewinds, playback never leaves its band) and
   * costs 767ms of wrong playback on frame one, peaking at 4548 u/s with 21
   * backward rewinds and the rendered pose 881ms stale, before the stranded-
   * playhead re-anchor eventually cleans it up. `rejectedFrames` stays at ZERO
   * throughout, so the metric that exists to surface exactly this reports
   * nothing. At +30000ms it is 767ms and 3782 u/s; the shape does not depend on
   * the size of the error, because what is being measured is how long the
   * re-anchor takes to notice.
   *
   * So the seed is PROVISIONAL rather than exempt. The discriminator is the one
   * `refuseSteppedFrame` already uses, run in the opposite direction: a frame
   * whose implied one-way delay sits more than `OFFSET_FLOOR_SLACK_MS` ABOVE
   * the seed contradicts it, because that would mean the seed packet had spent
   * a full second LESS in flight than this one. One such frame is jitter and
   * proves nothing. `TIMELINE_STEP_FRAMES` consecutive ones are a timeline, and
   * the seed is the outlier: it is discarded, the contradicting run becomes the
   * anchor through the same escape hatch a stranded playhead uses, and the
   * dead-epoch cut in `reanchor` lifts the seed's frame out of the buffer so it
   * cannot go on being an interpolation endpoint.
   *
   * THE CORROBORATION PATH IS THE COMMON ONE AND COSTS NOTHING. A healthy
   * connection's second frame lands within the slack of its first, which
   * retires the seed permanently on the very next push; this can only ever fire
   * in the first few frames of an epoch. It is deliberately NOT a general
   * "the floor holder is an outlier" rule, which would be free to fire at any
   * time and would churn against exactly the congestion excursions the
   * minimum-floor exists to be robust to.
   *
   * A server whose clock is genuinely offset from the client's is untouched by
   * this: every frame carries the same large offset, so the second frame
   * corroborates the first and the estimate is simply correct.
   */
  private refuteSeedFrame(frame: SnapshotFrame<K>): void {
    if (this.seedOffsetMs === null) return;

    const rawOffset = frame.receivedAt - frame.serverTime;
    if (rawOffset <= this.seedOffsetMs + OFFSET_FLOOR_SLACK_MS) {
      this.seedOffsetMs = null;
      this.seedRefutations.length = 0;
      return;
    }

    this.seedRefutations.push(rawOffset);
    if (frame.serverTime > this.seedRefutationNewest) this.seedRefutationNewest = frame.serverTime;
    if (this.seedRefutations.length < TIMELINE_STEP_FRAMES) return;

    // The contradicting run is the only evidence about the real timeline that
    // the poisoned floor has not touched, so it is handed in as the error
    // window exactly the way `refuseSteppedFrame` hands in its refused run.
    // Counted on `rejectedFrames` because the seed frame IS being refused, just
    // retroactively: a host whose decoder mis-stamps the first frame of every
    // epoch should see a number climbing rather than silence.
    this.rejectedFrameCount++;
    this.offsetWindow = this.seedRefutations.slice();
    this.pushesSinceErrorStart = this.seedRefutations.length;
    this.errorWindowNewestServerTime = this.seedRefutationNewest;
    this.reanchor();
  }

  /** Minimum of the offset window: the least contaminated estimate of the local-to-server clock difference, since one-way delay is never negative. */
  private offsetFloor(): number {
    let floor = Infinity;
    for (const o of this.offsetWindow) if (o < floor) floor = o;
    return floor;
  }

  /**
   * Track the offset between the local clock and the server's.
   *
   * `receivedAt - serverTime` is the true clock difference PLUS the one-way
   * network delay of that particular packet, and the network delay is never
   * negative, so the MINIMUM observed over a window is the least contaminated
   * estimate of the difference alone: it is the sample that happened to queue
   * behind nothing. Averaging instead would bake the mean latency into the
   * playhead and, worse, would move with every congestion excursion.
   *
   * The window SLIDES rather than being an all-time minimum, and that is the
   * whole reason this self-corrects. `performance.now()` and the server's
   * clock drift against each other by tens of parts per million; an all-time
   * minimum can only ever ratchet one way, so it would accumulate that drift
   * forever and slowly push the playhead off the buffer. A stale sample
   * falling out of the window lets the floor rise again.
   *
   * The offset then EASES toward that floor under a slew cap rather than
   * snapping to it, for the same reason `clientTick` dilates its step instead
   * of correcting its counter: the offset is subtracted from the playhead, so
   * a step change in it is a step change in what time playback thinks it is,
   * which every rendered entity would jump through. The first sample is seeded
   * exactly, with no easing, because there is nothing to be continuous with
   * yet and gliding in from zero would mean an entire connection's worth of
   * clock difference crossed at 5% of wall time.
   */
  private estimateOffset(frame: SnapshotFrame<K>): void {
    const rawOffset = frame.receivedAt - frame.serverTime;
    this.offsetWindow.push(rawOffset);
    if (this.offsetWindow.length > this.offsetWindowCap) this.offsetWindow.shift();

    if (!this.offsetSeeded) {
      this.offsetMs = rawOffset;
      this.offsetSeeded = true;
      this.lastArrivalAt = frame.receivedAt;
      // The seed defines the floor every later frame is judged against, so it
      // is held PROVISIONAL until a later frame corroborates it. See
      // `refuteSeedFrame`.
      this.seedOffsetMs = rawOffset;
      this.seedRefutations.length = 0;
      this.seedRefutationNewest = -Infinity;
      return;
    }

    const floor = this.offsetFloor();

    // Real elapsed time since the last arrival, so the cap is a RATE and not a
    // per-packet allowance: a burst of ten packets in 3ms may move the offset
    // by 0.15ms in total, not by ten packets' worth.
    const elapsed = Math.max(0, frame.receivedAt - this.lastArrivalAt!);
    const maxStep = elapsed * this.offsetSlewMax;
    this.offsetMs += clamp(floor - this.offsetMs, -maxStep, maxStep);
    if (frame.receivedAt > this.lastArrivalAt!) this.lastArrivalAt = frame.receivedAt;
  }

  /** Observe the server's own emission interval. Only forward deltas count, and `lastServerTime` never moves backwards, so a reordered packet contributes nothing rather than a negative or double-counted interval. It is reached only by frames `push()` accepted, which matters: a single future-stamped frame that got this far would set `lastServerTime` beyond anything the authority will emit for the rest of the connection, after which no delta is ever observed again and the interval estimate freezes where it stands. */
  private observeInterval(frame: SnapshotFrame<K>): void {
    if (this.lastServerTime !== null) {
      const delta = frame.serverTime - this.lastServerTime;
      if (delta > 0) {
        this.intervalWindow.push(delta);
        if (this.intervalWindow.length > this.offsetWindowCap) this.intervalWindow.shift();
      }
    }
    if (this.lastServerTime === null || frame.serverTime > this.lastServerTime) {
      this.lastServerTime = frame.serverTime;
    }
  }

  /**
   * Size the delay to the jitter it actually has to absorb.
   *
   * The quantity is EXCESS: how far each packet's raw offset sat above the
   * offset floor, i.e. how much one-way delay that packet carried beyond the
   * best case. That is exactly what a jitter buffer covers, and it is measured
   * per packet against a stable reference rather than differenced between
   * neighbours.
   *
   * This replaced a p95 over recent INTER-ARRIVAL GAPS, which was wrong in
   * three separate ways. It measured the wrong quantity (the gap between two
   * arrivals says nothing about how far either one lagged the server's grid).
   * Its index math could not select the largest sample in the window, so one
   * spike per second was always thrown away. And worst, a delivery burst
   * floods a gap-based ring with near-zero gaps and pulls the delay DOWN at
   * precisely the moment more buffer is needed: measured at 87.95ms under
   * ordinary jitter versus 80.45ms under bursts, exactly backwards. Excess
   * against the floor moves the right way, because a burst is a set of packets
   * that were all held, and being held is what excess measures.
   *
   * The interval term is a MEDIAN of the server's observed emission deltas,
   * not a mean: a ticker handoff leaves one sub-second gap in the stream and a
   * mean would carry that into the delay for the whole window afterwards.
   */
  private recomputeTargetDelay(): void {
    if (this.offsetWindow.length < 3 || this.intervalWindow.length === 0) return;

    const excess = this.offsetWindow.map((o) => Math.max(0, o - this.offsetMs));
    excess.sort((a, b) => a - b);
    const jitter = quantileAsc(excess, this.delayQuantile);

    const intervals = [...this.intervalWindow].sort((a, b) => a - b);
    this.intervalMs = medianAsc(intervals);

    // Belt and braces on top of `push()`'s guard: the delay is the one piece of
    // state an exponential ease can never recover from, since `x += (NaN - x) *
    // ease` is NaN for the rest of the connection. Anything non-finite reaching
    // here is a bug further up, and refusing to STORE it keeps that bug local
    // to the frame that caused it instead of ending playback.
    const target = jitter + this.intervalMs + this.delayMarginMs;
    if (!Number.isFinite(target)) return;

    this.targetDelayMs = clamp(target, this.minDelayMs, this.maxDelayMs);
  }

  /**
   * Drop frames the playhead can no longer need.
   *
   * The count cap alone is not enough now that frames are keyed by server
   * time: a delivery burst pushes several frames in a few milliseconds while
   * the playhead has barely moved, so a count-only prune evicts from the OLD
   * end exactly the frames the playhead is still bracketing against, and the
   * bracket search falls off the front of the buffer. Pruning by time instead
   * makes the retained window a property of where the playhead is, and the
   * count cap goes back to being what it was always described as: a hard upper
   * bound on memory.
   *
   * The horizon is deliberately generous (a full delay, the extrapolation cap
   * and two intervals behind the playhead) because retaining a frame too long
   * costs one array slot and dropping one too early costs a visible snap. Two
   * frames are always retained, since one frame cannot form a bracket.
   *
   * THE COUNT CAP MUST RESPECT THE PLAYHEAD TOO, and it did not. A large
   * FORWARD `serverTime` step (a ticker handoff onto a machine whose clock runs
   * ahead) leaves the playhead far behind a buffer that fills with frames from
   * the new timeline, and a front-splice keyed only on length then evicts the
   * one frame the playhead was bracketing against. Playback fell off the front
   * of the buffer and pinned to `frames[0]`, measured at 56% of rendered frames
   * completely motionless for about 50 seconds on a +5000ms step. Front-pruning
   * stops at the bracket's left edge instead; when the deficit is genuinely
   * unrecoverable it is the RE-ANCHOR that resolves it, which is a correction
   * with new data behind it rather than a silent eviction.
   */
  private pruneFrames(nowLocalMs: number): void {
    const playServerTime = nowLocalMs - this.offsetMs - this.currentDelayMs;

    // THE TIME PRUNE IS SUSPENDED WHILE THE PLAYHEAD IS UNDER SUSPICION. Its
    // horizon is derived from the playhead, and once `trackPlayheadError` has
    // opened an error window this class has already stopped believing where
    // the playhead is: pruning against it then discards precisely the frames a
    // re-anchor is about to need. On a backward `serverTime` step that is not
    // hypothetical, it is the whole failure: every frame from the new timeline
    // sits below a horizon computed from the old one, so all of them were
    // thrown away as they arrived and the re-anchor landed on an empty
    // stretch. The count cap and the hard ceiling below still bound memory.
    if (this.playheadErrorSinceMs === null) {
      const horizon = playServerTime - (this.currentDelayMs + this.extrapCapMs + 2 * this.intervalMs);
      let drop = 0;
      while (drop < this.frames.length && this.frames[drop]!.serverTime < horizon) drop++;
      drop = Math.min(drop, this.frames.length - 2);
      if (drop > 0) this.frames.splice(0, drop);
    }

    if (this.frames.length > this.bufferCap) {
      // Index of the first frame strictly AFTER the playhead, so `bracket - 1`
      // is the left edge of the bracket currently being rendered and is the
      // oldest frame that must survive.
      let bracket = 0;
      while (bracket < this.frames.length && this.frames[bracket]!.serverTime <= playServerTime) bracket++;
      const evictable = Math.max(0, Math.min(bracket - 1, this.frames.length - 2));
      const drop = Math.min(this.frames.length - this.bufferCap, evictable);
      if (drop > 0) this.frames.splice(0, drop);

      // ...and a hard ceiling well above the cap so the concession above cannot
      // grow the buffer without bound in a host that pushes without ever
      // sampling, where nothing would ever move the playhead or re-anchor.
      const hardCap = this.bufferCap * 4;
      if (this.frames.length > hardCap) this.frames.splice(0, this.frames.length - hardCap);
    }
  }

  /** Stop tracking one entity immediately, without waiting out `dropAfterMs`. */
  forget(key: K): void {
    this.lastSeenAt.delete(key);
    this.motion.delete(key);
  }

  /**
   * Drop all buffered frames and per-entity state, and reset the adaptive
   * delay to its starting value.
   *
   * THIS IS THE RECONNECT CALL. A `RoomConnection` that drops and comes back
   * holds no reference to its interpolator, so nothing else can do it: without
   * this call the first frame of the new epoch is bracketed against a frame
   * from seconds ago, which is a guaranteed snap on every reconnect. Clear
   * from `onStatus` the moment the connection leaves `'open'`.
   *
   * The clock offset is reset too, not merely the frames. It is an estimate of
   * a specific socket's path delay; a new connection may take a different
   * route, and carrying the old floor over would bias the new epoch's playhead
   * until the whole window had turned over.
   *
   * `rejectedFrames` AND `reanchors` ARE DELIBERATELY NOT RESET, and the
   * omission is a decision rather than an oversight, which is why it is written
   * down here and pinned by a test. They are lifetime COUNTERS and the rest of
   * this method resets GAUGES; that split is the whole distinction. Both
   * counters answer a question about the HOST, not about the current epoch:
   * "is something above this producing timestamps it should not" and "is the
   * offset estimate failing to converge". Those are diagnoses that a reconnect
   * does not refute, and since this method is called on EVERY reconnect,
   * resetting them would mean a client that reconnects every few seconds could
   * never accumulate enough evidence to show either problem at all: the more
   * broken the connection, the more thoroughly the evidence would be erased.
   * A consumer wanting a per-epoch figure differences the counter across the
   * epoch, which is possible; recovering a lifetime total from a counter that
   * has already been reset is not.
   */
  clear(): void {
    this.frames = [];
    this.lastSeenAt.clear();
    this.motion.clear();
    this.localClockMs = 0;
    this.playheadStepMs = 0;
    this.lastPlayServerTime = null;
    this.lastSampleLocalMs = null;
    this.offsetWindow = [];
    this.intervalWindow = [];
    this.offsetMs = 0;
    this.offsetSeeded = false;
    this.lastArrivalAt = null;
    this.lastServerTime = null;
    this.errorWindowNewestServerTime = null;
    this.steppedOffsets = [];
    this.steppedWindowFrames = 0;
    this.seedOffsetMs = null;
    this.seedRefutations = [];
    this.seedRefutationNewest = -Infinity;
    this.intervalMs = 0;
    this.currentDelayMs = this.startDelayMs;
    this.targetDelayMs = this.startDelayMs;
    this.underrunEma = 0;
    this.playheadErrorSinceMs = null;
    this.pushesSinceErrorStart = 0;
    // Any seed from a PREVIOUS resume goes with it, which is what retires a
    // held entity that never came back: it is dropped at the next epoch rather
    // than waiting indefinitely for a first render that will not happen.
    this.resumeSeed.clear();
  }

  /**
   * Start the new epoch from the poses the host is still showing, rather than
   * from wherever the first snapshot lands.
   *
   * CALL IT IMMEDIATELY AFTER `clear()`, with the poses the connection is
   * holding on screen. `clear()` is the epoch boundary and empties everything,
   * this hands back the one thing worth carrying across it: where the player
   * last SAW each entity. Called before `clear()` it would simply be erased.
   *
   * WHAT IT FIXES IS A SNAP FOLLOWED BY A FREEZE, measured end to end through a
   * real socket. A reconnect holds the last rendered poses, and then the new
   * epoch's first frame steps every entity forward by the whole outage's motion
   * at once (measured at +20 units in one frame, 1182 u/s, on a 40ms link, and
   * +30 at 1765 u/s on a 250ms one), after which playback sits COMPLETELY STILL
   * for about six frames, because a freshly cleared playhead starts
   * `INTERP_START_MS` behind the first buffered frame and the hold branch
   * renders that frame's pose exactly. Snap, freeze, then a stretch of running
   * fast while the delay eases: three artifacts from one event.
   *
   * The seed turns all three into one glide. The first time each held entity is
   * rendered in the new epoch, whichever branch renders it, the difference
   * between the held pose and the interpolated one becomes a render offset
   * decayed over `EXTRAP_CAP_MS` by the same machinery that unwinds an
   * extrapolation. That also takes the freeze out on its own: the hold branch
   * renders `frames[0]`'s pose plus a decaying offset, which is motion.
   *
   * THE CLAMP IS THE ONE PLACE THIS DIFFERS FROM THE EXTRAPOLATION UNWIND, for
   * a reason rather than by omission: see `RESUME_GLIDE_MAX_MS`. Nothing was
   * extrapolated here, so "only hide this module's own overshoot" would clamp
   * to zero and refuse the glide outright.
   *
   * Entities absent from `held` are untouched, so a host may seed a subset
   * (the ones it actually kept drawing) without affecting anything else.
   *
   * THE SPEED COMES IN ON THE POSE, AND IT HAS TO, WHICH IS A LESSON ABOUT
   * WHERE STATE LIVES RATHER THAN A PARAMETER DETAIL. The clamp is scaled by
   * the entity's measured speed, and the first version of this method read that
   * from `this.motion`, which is precisely the map `clear()` empties one line
   * earlier in the caller's epoch turnover. Since the documented call order is
   * `clear()` then `resumeFrom`, every lookup returned `undefined`, every bound
   * was `Infinity`, and the clamp was STRUCTURALLY DEAD on the only path anyone
   * uses: an entity that RESPAWNED 5000 units away while the socket was down
   * rendered as a 4823 unit sweep at 32,690 u/s, which is the unbounded lie the
   * clamp exists to refuse, in the method whose own docstring promised a bound.
   * A value read from state the caller was just told to destroy is not a
   * default, it is a guarantee that the branch never runs.
   *
   * The fix needs nothing from the host: `InterpolatedEntity` already carries
   * `speed`, so the map `frame()` handed back IS a valid `held` argument with
   * the measurement already in it. `this.motion` remains as a FALLBACK, for a
   * host that seeds without clearing first, and is now genuinely a fallback
   * rather than the only source.
   */
  resumeFrom(held: ReadonlyMap<K, { x: number; y: number; heading?: number | undefined; speed?: number | undefined }>): void {
    this.resumeSeed.clear();
    for (const [key, pose] of held) {
      if (!Number.isFinite(pose.x) || !Number.isFinite(pose.y)) continue;
      // A speed arriving on a host-supplied pose crosses the same boundary
      // `push()` guards: non-finite or negative is no measurement at all, and
      // has to read as "unknown" (unclamped) rather than as a bound of NaN,
      // which every comparison downstream would silently pass.
      const measured = pose.speed ?? this.motion.get(key)?.speed ?? 0;
      const speed = Number.isFinite(measured) && measured > 0 ? measured : 0;
      this.resumeSeed.set(key, { x: pose.x, y: pose.y, heading: pose.heading, speed });
    }
  }

  /**
   * Advance the playback point and read every tracked entity's smoothed
   * pose. Call once per rendered frame.
   *
   * `nowMs`, if given, is the authoritative local clock reading and MUST use
   * the same clock as `push()`'s `receivedAt` values, since the offset between
   * that clock and the server's is measured by differencing the two. A unit
   * test supplies its own synthetic clock this way to stay deterministic.
   *
   * Omit it and the interpolator reads the real wall clock itself
   * (`performance.now()`, or `Date.now()` where `performance` does not
   * exist), which is what almost every real caller wants: browsers stamp
   * `receivedAt` with `performance.now()` too, so the two clocks agree by
   * construction and playback tracks the buffer correctly from the first
   * frame. THIS IS NOT WHAT THIS METHOD USED TO DO: it used to accumulate its
   * own clock from `dt` starting at zero, which is a SEPARATE clock domain
   * from `receivedAt`'s absolute timestamps and can never durably reconcile
   * with it. Any single frame slower than the delay (a GC pause, a
   * backgrounded tab regaining focus, a busy dev machine) permanently
   * widened the gap, because a `dt`-accumulated clock can never advance
   * faster than wall time to make up the difference. Once that gap exceeded
   * `bufferCap` worth of buffered history the playback point fell before the
   * oldest frame and rendering pinned to `frames[0]` forever: several
   * seconds of stale state with nothing to show for it, since every other
   * signal (the socket, the snapshot rate, `underrunRate`) stayed healthy.
   * `examples/pong/client.ts` shipped exactly this bug by calling
   * `interp.sample(dt)` with no second argument; see its own comment at the
   * call site.
   */
  sample(dt: number, nowMs: number = wallClockMs()): Map<K, InterpolatedEntity> {
    // The same trust boundary `push()` applies, from the other side. A caller
    // that computes `nowMs` from something that went NaN (a timestamp
    // arithmetic slip in a rAF loop) would otherwise write NaN into
    // `localClockMs`, from which the entity-drop sweep and the playhead both
    // read: a stored non-finite clock is the one poisoning that outlives the
    // frame that caused it. Fall back to the last good reading instead.
    //
    // THE FAILURE IT ACTUALLY PRODUCES IS NOT THE OBVIOUS ONE. NaN reaches
    // `playheadErrorSinceMs`, and every comparison against NaN is FALSE, so
    // `localClockMs - playheadErrorSinceMs < REANCHOR_AFTER_MS` stops being a
    // wait and becomes a pass: the 600ms of persistence that separates a wrong
    // clock estimate from ordinary jitter is skipped and the re-anchor fires on
    // the sample count alone. Measured on an +80ms delay bump that the adaptive
    // delay absorbs on its own with no correction needed: one NaN `nowMs`
    // 300ms into the stretch turns zero re-anchors into one.
    if (!Number.isFinite(nowMs)) nowMs = this.localClockMs;
    if (!Number.isFinite(dt)) dt = 0;
    this.localClockMs = nowMs;

    // `dt` AND `nowMs` CAN DISAGREE, AND EVERY PER-ENTITY SMOOTHER HERE HAS TO
    // BELIEVE THE CLOCK RATHER THAN THE STEP. They are the same number on a
    // healthy frame; they part company after a render gap, because clamping
    // `dt` is the right thing for a caller to do (`RoomConnection.frame()`
    // clamps at 0.25s so one stalled frame cannot advance a whole simulation)
    // and the playhead moves with `nowMs` regardless. Dividing a 30 second
    // displacement by a quarter of a second is how `speed`, the documented
    // animation driver, came to report 10,000+ u/s for a backgrounded tab.
    // Anything measuring a RATE from rendered motion therefore uses the elapsed
    // local time on such a frame; `dt` is still what the delay ease and the
    // underrun EMA run on, since those are the caller's own frame budget.
    const localElapsedMs = this.lastSampleLocalMs === null ? dt * 1000 : nowMs - this.lastSampleLocalMs;
    this.lastSampleLocalMs = nowMs;
    const smoothS = localElapsedMs > dt * 1000 + FRAME_GAP_SLACK_MS ? localElapsedMs / 1000 : dt;

    // The ease sets the SHAPE of the approach and `DELAY_SLEW_MAX` sets its
    // RATE CEILING, for the same reason `estimateOffset` caps the offset: both
    // terms are subtracted from the playhead, so easing either one quickly is
    // rendering every remote entity fast or slow for as long as the ease lasts.
    if (dt > 0) {
      const ease = 1 - Math.exp(-INTERP_ADAPT_LAMBDA * dt);
      const maxStep = dt * 1000 * DELAY_SLEW_MAX;
      this.currentDelayMs += clamp((this.targetDelayMs - this.currentDelayMs) * ease, -maxStep, maxStep);
      if (!Number.isFinite(this.currentDelayMs)) this.currentDelayMs = this.startDelayMs;
    }

    const out = new Map<K, InterpolatedEntity>();
    if (this.frames.length === 0) {
      this.decayUnderrun(false, dt);
      return out;
    }

    // Forget anything that has not appeared in a pushed frame recently,
    // regardless of whether it is about to be rendered this call. Measured on
    // the LOCAL clock, because "how long since we last heard about this
    // entity" is a question about our own connection, not about world time.
    for (const [key, seenAt] of this.lastSeenAt) {
      if (this.localClockMs - seenAt > this.dropAfterMs) {
        this.lastSeenAt.delete(key);
        this.motion.delete(key);
      }
    }

    // The playhead, on the SERVER's timeline: local now, corrected onto the
    // server clock, then held back by the buffered delay.
    let playServerTime = this.localClockMs - this.offsetMs - this.currentDelayMs;
    let i = this.bracketIndex(playServerTime);

    if (this.trackPlayheadError(i)) {
      // Re-anchored on this call: both the offset and the delay moved, so the
      // playhead has to be re-derived before anything renders from it. Doing it
      // here rather than next frame is what makes the correction ONE step.
      playServerTime = this.localClockMs - this.offsetMs - this.currentDelayMs;
      // The re-anchor may have cut the whole buffer away, if everything in it
      // came from a timeline the authority has left.
      if (this.frames.length === 0) {
        this.decayUnderrun(false, dt);
        return out;
      }
      i = this.bracketIndex(playServerTime);
    }

    // How far playback itself moved this call, which is what the transition
    // out of extrapolation projects the abandoned guess forward by. Taken after
    // any re-anchor, so it describes the playhead that actually rendered.
    this.playheadStepMs = this.lastPlayServerTime === null ? 0 : playServerTime - this.lastPlayServerTime;
    this.lastPlayServerTime = playServerTime;

    let underranThisCall = false;

    if (i === -1) {
      // Playback has not caught up to the oldest buffered frame yet (this is
      // normal for the first moment after a fresh connection or `clear()`):
      // hold at the earliest known pose rather than inventing one further back.
      const frame = this.frames[0]!;
      for (const [key, sample] of frame.entities) {
        if (!this.lastSeenAt.has(key)) continue;
        out.set(key, this.finishEntity(key, sample.x, sample.y, sample.heading ?? 0, sample, false, smoothS));
      }
    } else if (i === this.frames.length - 1) {
      // UNDERRUN: nothing buffered beyond the playback point. Extrapolate by
      // last-known velocity (zero if there is no prior frame to derive one
      // from) rather than freezing.
      underranThisCall = true;
      const curr = this.frames[i]!;
      const prev = i > 0 ? this.frames[i - 1]! : null;
      const elapsedMs = Math.min(playServerTime - curr.serverTime, this.extrapCapMs);
      const elapsedS = Math.max(0, elapsedMs) / 1000;
      // The velocity denominator is the SERVER-time span between the two
      // frames, never the gap between their arrivals. Two frames one tick
      // apart that landed 3ms apart after a stall describe 50ms of motion, not
      // 3ms of it; dividing by the arrival gap inflates the derived velocity by
      // the burst factor and then extrapolates at that speed, which measured as
      // a 26-unit jump on an entity moving 5 units per tick.
      const prevDtS = prev ? (curr.serverTime - prev.serverTime) / 1000 : 0;

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
        out.set(key, this.finishEntity(key, x, y, sample.heading ?? 0, sample, true, smoothS, {
          vx,
          vy,
          leftMs: this.extrapCapMs - elapsedS * 1000,
        }));
      }
    } else {
      const a = this.frames[i]!;
      const b = this.frames[i + 1]!;
      const span = b.serverTime - a.serverTime;
      const frac = span > 0 ? clamp((playServerTime - a.serverTime) / span, 0, 1) : 1;

      const keys = new Set<K>([...a.entities.keys(), ...b.entities.keys()]);
      for (const key of keys) {
        if (!this.lastSeenAt.has(key)) continue;
        const sa = a.entities.get(key);
        const sb = b.entities.get(key);
        if (sa && sb) {
          const x = lerp(sa.x, sb.x, frac);
          const y = lerp(sa.y, sb.y, frac);
          const heading = lerpHeading(sa.heading ?? 0, sb.heading ?? 0, frac);
          out.set(key, this.finishEntity(key, x, y, heading, sb, false, smoothS));
          continue;
        }
        const partial = this.posePartial(key, i, playServerTime);
        if (partial) {
          out.set(
            key,
            this.finishEntity(key, partial.x, partial.y, partial.heading, partial.base, partial.extrapolated, smoothS, partial.guess),
          );
        }
      }
    }

    this.decayUnderrun(underranThisCall, dt);
    return out;
  }

  /** Index of the last buffered frame at or before the playback point, or -1 if the playhead sits before every buffered frame. */
  private bracketIndex(playServerTime: number): number {
    let i = -1;
    for (let k = 0; k < this.frames.length; k++) {
      if (this.frames[k]!.serverTime <= playServerTime) i = k;
      else break;
    }
    return i;
  }

  /**
   * Watch for a playhead that is not merely jittery but PERSISTENTLY in the
   * wrong place, and re-anchor the clock offset outright when it is. Returns
   * true on the call that re-anchors.
   *
   * The two directions are the two ways a step change in the clock estimate
   * shows up. PAST THE NEWEST buffered frame is a one-way delay that grew (a
   * route change, a network switch) or a `serverTime` that stepped BACKWARDS (a
   * ticker handoff moves authority to a different machine, and
   * `src/server/ticker.ts` stamps `serverTime` from that instance's own
   * `Date.now()`, so a handoff carries that machine's clock skew with it).
   * BEFORE THE OLDEST buffered frame, with more than one frame buffered, is a
   * `serverTime` that stepped FORWARDS by more than the buffer spans.
   *
   * THE GATE, and it is the whole reason this is safe: re-anchor only if frames
   * are STILL ARRIVING. A genuine outage (a dead ticker, the gap in the stream
   * between a predecessor's death and a successor's first tick) parks the
   * playhead past the newest frame too, and looks identical from here. But
   * there is no new data to anchor TO in that case, so re-anchoring would move
   * the playhead onto the same stale frames and accomplish nothing; the correct
   * behaviour is the extrapolate-then-hold that already exists. Requiring
   * `push()` calls since the error window opened is exactly the distinction
   * between "data is flowing but my clock estimate is wrong" and "no data".
   *
   * THE GATE COUNTS TO `REANCHOR_MIN_SAMPLES`, NOT TO ONE, and the difference
   * is not cosmetic. One arrival is enough to prove data is flowing and not
   * nearly enough to define an anchor: `reanchor` adopts the minimum of the
   * error window's samples with no slew, so with a single sample it adopts
   * that packet's raw offset whatever it happens to be. A straggler dribbling
   * through a congested link is precisely such a packet, and it measured as a
   * 600ms offset error held for twelve seconds, or as one re-anchor per
   * straggler when several dribble through. See the constant for the numbers.
   *
   * Trading ONE visible correction for tens of seconds of degraded playback is
   * the house position, not a new one: `shouldReanchor` in `netPolicy.ts` snaps
   * the client tick rather than let every stamped input target a tick the
   * server will never reach, and `ErrorOffset.reset()` drops its correction
   * outright rather than smoothing across a discontinuity that has no
   * continuity to preserve. Same shape of judgement here.
   */
  private trackPlayheadError(i: number): boolean {
    const stranded = i === this.frames.length - 1 || (i === -1 && this.frames.length > 1);

    if (!stranded) {
      this.playheadErrorSinceMs = null;
      this.pushesSinceErrorStart = 0;
      this.errorWindowNewestServerTime = null;
      return false;
    }
    if (this.playheadErrorSinceMs === null) {
      this.playheadErrorSinceMs = this.localClockMs;
      this.pushesSinceErrorStart = 0;
      this.errorWindowNewestServerTime = null;
      return false;
    }
    if (this.localClockMs - this.playheadErrorSinceMs < REANCHOR_AFTER_MS) return false;
    if (this.pushesSinceErrorStart < REANCHOR_MIN_SAMPLES) return false;

    return this.reanchor();
  }

  /**
   * Adopt the clock offset the frames that arrived DURING the error window
   * imply, with no slew.
   *
   * Only those samples are used. The wider `offsetWindow` spans several seconds
   * and on a step change most of it describes a path, or a timeline, that no
   * longer exists: easing toward that floor is precisely what stranded the
   * playhead, so anchoring to it would be a no-op. Their MINIMUM is still the
   * right statistic for the same reason it is everywhere else in this file (the
   * least contaminated sample is the one that queued behind nothing), and the
   * callers guarantee there are at least `REANCHOR_MIN_SAMPLES` of them, which
   * is what stops one outlier from becoming the anchor on its own.
   *
   * BOTH CALLERS ARE STEP DETECTORS, and they differ only in which symptom
   * they saw first. `trackPlayheadError` sees a playhead that no buffered frame
   * brackets while frames keep landing; `refuseSteppedFrame` sees a run of
   * frames whose implied one-way delay is impossible and hands its own refused
   * samples in as the error window, since they were deliberately kept out of
   * the offset window and are the only evidence about the new timeline there
   * is.
   *
   * The window is then reset to that floor alone, so the stale samples cannot
   * drag the eased offset straight back where it came from over the next
   * frames. `currentDelayMs` snaps to its target rather than continuing to ease
   * toward it, so the whole correction lands in one frame instead of being half
   * undone by an ease still in flight; the delay ESTIMATE was never the thing
   * that was wrong, and it rebuilds from the fresh window within a few frames.
   */
  private reanchor(): boolean {
    const recent = Math.max(1, Math.min(this.pushesSinceErrorStart, this.offsetWindow.length));
    let floor = Infinity;
    for (let k = this.offsetWindow.length - recent; k < this.offsetWindow.length; k++) {
      const o = this.offsetWindow[k]!;
      if (o < floor) floor = o;
    }
    if (!Number.isFinite(floor)) return false;

    this.offsetMs = floor;
    this.offsetWindow = [floor];
    this.currentDelayMs = this.targetDelayMs;

    // Frames stamped AHEAD of everything that arrived during the error window
    // are from a timeline the authority has left: only a backward `serverTime`
    // step can produce them, and left in place they are the buffer's newest
    // end, so the playhead eventually walks into them and renders a pose from
    // the dead epoch. That measured as a single 285-unit jump five seconds
    // after a handoff, long enough after the event to look like an unrelated
    // glitch. Cutting them here is the same judgement as `clear()` dropping the
    // old clock offset: state from an epoch that has ended is not evidence
    // about this one.
    //
    // THE CUT IS AGAINST THE NEWEST OF THOSE ARRIVALS, NOT THE LAST ONE. Every
    // frame that landed during the error window is from the live timeline by
    // construction, so their maximum is the live timeline's newest stamp. The
    // LAST arrival is not: `push()` documents out-of-order arrivals as
    // ordinary, and one landing on the very render frame the re-anchor fires on
    // makes the last arrival an older stamp than a legitimate frame already
    // buffered, which the cut then destroyed. Reproduced at one lost frame.
    if (this.errorWindowNewestServerTime !== null) {
      let keep = this.frames.length;
      while (keep > 0 && this.frames[keep - 1]!.serverTime > this.errorWindowNewestServerTime) keep--;
      if (keep < this.frames.length) this.frames.length = keep;
      // ...and the interval estimator has to come back to the live timeline
      // too, or it observes no emission delta at all until the new clock
      // climbs past the old one's last stamp.
      this.lastServerTime = this.errorWindowNewestServerTime;
    }

    this.playheadErrorSinceMs = null;
    this.pushesSinceErrorStart = 0;
    this.errorWindowNewestServerTime = null;
    // Any anchor supersedes the provisional seed, whichever detector produced
    // it: the offset no longer rests on that first frame at all.
    this.seedOffsetMs = null;
    this.seedRefutations.length = 0;
    this.seedRefutationNewest = -Infinity;
    this.reanchorCount++;
    return true;
  }

  /**
   * Pose an entity that only ONE of the two bracketing frames carries.
   *
   * Rendering it at that frame's exact pose (which is what this used to do) is
   * a snap of up to a full snapshot interval, forward if the newer frame has
   * it and backward if the older one does, and it unwinds again the moment the
   * bracket moves on. One entity transiently omitted from one snapshot was
   * therefore enough to make it visibly jitter, twice.
   *
   * Instead, scan OUTWARD for the nearest frames on either side that do carry
   * the key and interpolate on THAT pair. The pose stays on the same
   * continuous path it was already on; the omission costs a little precision
   * over a longer span rather than a discontinuity. With history but no future
   * (an entity that has stopped being sent) it extrapolates under the usual
   * cap; with a future but no history (an entity that just appeared) there is
   * no continuity to preserve, so holding the one known pose is correct.
   */
  private posePartial(
    key: K,
    i: number,
    playServerTime: number,
  ): { x: number; y: number; heading: number; base: EntitySample; extrapolated: boolean; guess?: ExtrapGuess } | null {
    const ia = this.scanFor(key, i, -1);
    const ib = this.scanFor(key, i + 1, 1);

    if (ia >= 0 && ib >= 0) {
      const fa = this.frames[ia]!;
      const fb = this.frames[ib]!;
      const sa = fa.entities.get(key)!;
      const sb = fb.entities.get(key)!;
      const span = fb.serverTime - fa.serverTime;
      const t = span > 0 ? clamp((playServerTime - fa.serverTime) / span, 0, 1) : 1;
      return {
        x: lerp(sa.x, sb.x, t),
        y: lerp(sa.y, sb.y, t),
        heading: lerpHeading(sa.heading ?? 0, sb.heading ?? 0, t),
        base: sb,
        extrapolated: false,
      };
    }

    if (ia >= 0) {
      const fa = this.frames[ia]!;
      const sa = fa.entities.get(key)!;
      const ip = this.scanFor(key, ia - 1, -1);
      const elapsedS = Math.max(0, Math.min(playServerTime - fa.serverTime, this.extrapCapMs)) / 1000;
      let vx = 0;
      let vy = 0;
      if (ip >= 0) {
        const fp = this.frames[ip]!;
        const sp = fp.entities.get(key)!;
        const spanS = (fa.serverTime - fp.serverTime) / 1000;
        if (spanS > 0) {
          vx = (sa.x - sp.x) / spanS;
          vy = (sa.y - sp.y) / spanS;
        }
      }
      return {
        x: sa.x + vx * elapsedS,
        y: sa.y + vy * elapsedS,
        heading: sa.heading ?? 0,
        base: sa,
        extrapolated: elapsedS > 0,
        guess: { vx, vy, leftMs: this.extrapCapMs - elapsedS * 1000 },
      };
    }

    if (ib >= 0) {
      const sb = this.frames[ib]!.entities.get(key)!;
      return { x: sb.x, y: sb.y, heading: sb.heading ?? 0, base: sb, extrapolated: false };
    }

    return null;
  }

  /** Index of the nearest frame from `from`, stepping by `step`, that carries `key`, or -1 within `PARTIAL_SCAN_FRAMES` steps. */
  private scanFor(key: K, from: number, step: number): number {
    for (let n = 0, k = from; n < PARTIAL_SCAN_FRAMES && k >= 0 && k < this.frames.length; n++, k += step) {
      if (this.frames[k]!.entities.has(key)) return k;
    }
    return -1;
  }

  /**
   * Apply the unwind glide, measure the rendered speed, and hand the pose out.
   *
   * THE GLIDE IS THE OTHER HALF OF "NEVER FREEZE ON UNDERRUN". Extrapolating
   * past the newest snapshot is a GUESS, and every guess has to be paid back
   * the moment real data lands: the entity was rendered at `pose + v * t` and
   * the truth turns out to be somewhere else, so without this the whole
   * discrepancy is spent in ONE frame.
   *
   * Both directions of that were measured on this module and neither is
   * acceptable. On a clean ticker handoff (the world pauses while `serverTime`
   * keeps running on the successor's clock) the entity had been guessed FORWARD
   * and the truth is where it already was, so it steps BACKWARD by
   * `(EXTRAP_CAP_MS - tickMs) * v`: one 10.41 unit rewind at -625 u/s on an
   * entity whose true speed is 100. With the glide that becomes four backward
   * frames of at most 1.16 units, -69 u/s, and a peak rendered speed of 100
   * rather than 625. On a network gap with the world still MOVING it is the
   * forward snap this repo already documents, and the same clamp caps what can
   * be hidden at what the guess itself added: 3780 u/s down to 2880, the rest
   * being real world motion nobody has any business smoothing away.
   *
   * So the difference becomes an additive offset on the RENDERED pose instead
   * of a step, and the offset glides to zero over `EXTRAP_CAP_MS` of local
   * time. The rendered pose is continuous through the transition by
   * construction, and the pose the host is given converges onto the confirmed
   * one over the same horizon the extrapolation was allowed to run for.
   *
   * THE CLAMP IS WHAT KEEPS THIS HONEST, and it is the whole difference between
   * a smoother and a lie. The offset may not exceed the displacement the
   * EXTRAPOLATOR ITSELF APPLIED to this entity (its derived velocity times the
   * time it ran, which `extrapCapMs` already bounds). So the glide can only
   * ever hide this module's own overshoot; a real teleport, a respawn, a
   * correction from the authority, all arrive as a difference far larger than
   * anything this module guessed and all still snap exactly as they do today.
   * That bound also makes the glide's own rate safe without tuning: an offset
   * of at most `v * cap`, spent over exactly `cap`, can never move an entity
   * faster than it was already moving.
   *
   * THE DIFFERENCE IS TAKEN AGAINST THE GUESS PROJECTED ONE FRAME, NOT AGAINST
   * LAST FRAME'S POSE, and that is a correction rather than a nicety. The
   * playhead moves between the two frames, so an entity moving normally is
   * SUPPOSED to be somewhere else this frame: differencing against where it was
   * counts one ordinary frame of motion as overshoot, and the transition frame
   * then renders the previous pose exactly, i.e. a dead stop, followed by the
   * bogus offset unwinding as extra speed. Measured on the repeating-stall
   * profile: one frame at 0.0 u/s and nine at 109 on an entity moving at a
   * constant 100, on a transition that was already smooth. Asking what the
   * GUESS would have said at this playhead (its velocity, for as much of the
   * cap as it had left) isolates the guess's error and leaves a benign
   * transition alone, because there the guess and the truth agree.
   *
   * The unwind rate is proportional to what is LEFT over the time that is
   * left, which is what makes it terminate on a deadline instead of trailing an
   * asymptote.
   */
  private finishEntity(
    key: K,
    x: number,
    y: number,
    heading: number,
    base: EntitySample,
    extrapolated: boolean,
    elapsedS: number,
    guess?: ExtrapGuess,
  ): InterpolatedEntity {
    const state = this.motion.get(key);
    let offX = state?.offX ?? 0;
    let offY = state?.offY ?? 0;
    let offHeading = state?.offHeading ?? 0;
    let offMsLeft = state?.offMsLeft ?? 0;

    const seed = this.resumeSeed.size > 0 ? this.resumeSeed.get(key) : undefined;

    if (seed) {
      // FIRST RENDER OF THE NEW EPOCH for an entity the host was still drawing.
      // Consumed here rather than in `resumeFrom` because "first rendered" is
      // the moment that matters: a seeded entity whose snapshots have not
      // arrived yet has not been drawn from this epoch at all.
      this.resumeSeed.delete(key);
      const dx = seed.x - x;
      const dy = seed.y - y;
      const mag = Math.hypot(dx, dy);
      const allowed = seed.speed > 0 ? (seed.speed * RESUME_GLIDE_MAX_MS) / 1000 : Infinity;
      const scale = mag > allowed ? allowed / mag : 1;
      offX = dx * scale;
      offY = dy * scale;
      offHeading = wrapAngle((seed.heading ?? heading) - heading) * scale;
      offMsLeft = this.extrapCapMs;
    } else if (state && state.wasExtrapolated && !extrapolated) {
      // The edge out of extrapolation, which is the only place an offset is
      // ever taken. Where the abandoned guess would have put the entity at this
      // playhead, minus where the confirmed frames say it is, clamped to how
      // far that guess had moved it in the first place.
      const advanceS = Math.min(Math.max(0, this.playheadStepMs), Math.max(0, state.extrapLeftMs)) / 1000;
      const guessSpeed = Math.hypot(state.extrapVX, state.extrapVY);
      const allowed = (guessSpeed * (this.extrapCapMs - state.extrapLeftMs)) / 1000;
      const dx = state.x + state.extrapVX * advanceS - x;
      const dy = state.y + state.extrapVY * advanceS - y;
      const mag = Math.hypot(dx, dy);
      const scale = mag > allowed ? allowed / mag : 1;
      offX = dx * scale;
      offY = dy * scale;
      // Heading rides the same scale rather than a cap of its own: the pose
      // glides as one thing, and a difference the clamp calls a teleport
      // teleports its facing with it instead of pirouetting after the fact.
      offHeading = wrapAngle(state.heading - heading) * scale;
      offMsLeft = this.extrapCapMs;
    } else if (offMsLeft > 0 && elapsedS > 0) {
      const stepMs = elapsedS * 1000;
      const f = stepMs >= offMsLeft ? 1 : stepMs / offMsLeft;
      offX -= offX * f;
      offY -= offY * f;
      offHeading -= offHeading * f;
      offMsLeft -= stepMs;
      if (offMsLeft <= 0) {
        offX = 0;
        offY = 0;
        offHeading = 0;
        offMsLeft = 0;
      }
    }

    const rx = x + offX;
    const ry = y + offY;
    const rHeading = offHeading === 0 ? heading : wrapAngle(heading + offHeading);

    // Measured from what was actually RENDERED, offset included, because that
    // is the motion the animation this drives has to match. `elapsedS <= 0`
    // leaves the previous reading alone rather than overwriting it with zero: a
    // second `sample()` at the same `nowMs` renders the same instant twice, and
    // an instant is not evidence that the entity stopped.
    let speed = state?.speed ?? 0;
    if (state && elapsedS > 0) {
      const inst = Math.hypot(rx - state.x, ry - state.y) / elapsedS;
      const ease = 1 - Math.exp(-elapsedS / this.speedTau);
      speed = state.hasPrev ? state.speed + (inst - state.speed) * ease : inst;
    }

    this.motion.set(key, {
      x: rx,
      y: ry,
      heading: rHeading,
      speed,
      hasPrev: true,
      wasExtrapolated: extrapolated,
      extrapVX: guess?.vx ?? 0,
      extrapVY: guess?.vy ?? 0,
      extrapLeftMs: guess ? clamp(guess.leftMs, 0, this.extrapCapMs) : 0,
      offX,
      offY,
      offHeading,
      offMsLeft,
    });

    return { ...base, x: rx, y: ry, heading: rHeading, speed, extrapolated };
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
