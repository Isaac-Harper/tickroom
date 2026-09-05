// The core barrel is browser-safe by construction (no file under `core/`
// imports a platform module), so client code reaches it directly.
import { PLAYOUT_MAX_AHEAD } from '../core/index.js';

// Pure netcode decisions, extracted so they can be pinned by direct unit
// tests instead of only being reachable through a live socket and a real
// browser clock. `RoomConnection` SAMPLES state and calls these; it never
// re-derives their logic inline. That split is what let the thresholds below
// be measured against production once (a falsification pass that timed every
// edge of a stall banner and a reconnect re-anchor) and then pinned forever,
// rather than re-guessed every time someone touches the connection class.

/** Where the socket currently sits. Not the same question as "is the world alive": a closed socket in backoff is exactly as silent to the player as an open one behind a hung server. */
export type NetStatus = 'idle' | 'connecting' | 'open' | 'closed';

/**
 * A connection that has delivered at least one snapshot this epoch and then
 * goes silent must say so within 4 seconds. This sits ABOVE the tick-loop
 * handoff budget (a successor must take over within 3 seconds of a
 * predecessor's death, and typically does it in 0.5 to 1.2s), so a routine,
 * healthy handoff never raises the banner, and it sits well above any
 * interpolation delay too, so ordinary jitter never trips it either.
 */
export const STALL_MS = 4000;

/**
 * A connection that has delivered NOTHING yet gets a longer grace, because
 * there is a legitimate multi-second path to a first snapshot: a cold relay
 * invocation, a tick loop spinning up from nothing, and whatever the
 * simulation itself needs to initialise, all before the first packet can
 * exist. Using the tight limit here would flash the banner on every ordinary
 * cold join.
 */
export const STALL_COLD_MS = 8000;

export interface StallInputs {
  /** The clock this decision is being made against. Passed in, never read internally, so the function stays pure and testable with a fake clock. */
  now: number;
  /** Local-clock timestamp of the most recent snapshot, or 0 if none has ever arrived. */
  lastSnapAt: number;
  /** Local-clock timestamp this connection attempt started, or 0 if none is in flight. */
  connectStartedAt: number;
  status: NetStatus;
  /** Has at least one snapshot been decoded since the current connection epoch began? */
  epochDelivered: boolean;
  /** Was the connection already flagged stalled as of the last poll? Drives the hysteresis below. */
  stallActive: boolean;
  /** Any terminal latch: the host closed us deliberately, we hit a capacity or rate limit, or a protocol version mismatch gave up. A terminal state is not silence, it is an answer, so it must never show a stall banner. */
  terminal: boolean;
}

export interface StallDecision {
  stalled: boolean;
  /** How long since the last evidence the world is alive, ms. Exposed so a caller can log or display it, not just gate on the boolean. */
  silentMs: number;
  /** Which threshold is in force, so a caller can tell a cold join from a stream that stopped. */
  thresholdMs: number;
}

/**
 * `stalled` decides whether to show "the world might be frozen" to the
 * player. It is not "is the socket connected": a closed socket working
 * through backoff is exactly as silent to a player as an open one sitting
 * behind a hung server, and hiding the message the instant the socket drops
 * would remove it precisely when things got worse. Socket readiness is
 * therefore deliberately absent from this predicate.
 */
export function stallDecision(s: StallInputs): StallDecision {
  // Silence is measured from THE LAST EVIDENCE THE WORLD IS ALIVE, which is
  // either the newest snapshot or, before any has ever arrived, the moment
  // this client first tried to connect. One expression therefore covers all
  // three ways a player ends up staring at a frozen world: an established
  // stream that stops (a tick loop died or hung under a socket that stays
  // open), a joiner landing in a room that is ALREADY hung (every new joiner,
  // once a room hangs), and a reconnect loop that never resumes (the "started
  // trying" timestamp keeps advancing silentMs the whole time it fails).
  const evidenceAt = Math.max(s.lastSnapAt, s.connectStartedAt);
  const silentMs = s.connectStartedAt > 0 ? s.now - evidenceAt : 0;

  // HYSTERESIS, and it is load-bearing rather than a nicety: once the banner
  // is up, the TIGHT limit stays in force regardless of which regime a naive
  // read of `status`/`epochDelivered` would suggest. Only a genuine snapshot
  // clears the state (silentMs collapses back to ~0 the instant one lands).
  // Without this, a hung room whose socket then drops would widen the
  // threshold from 4000 to 8000ms, which UNSETS `stalled` for the seconds
  // between those two numbers even though nothing about the world got
  // better, and the banner would flicker off and back on for no reason a
  // player could make sense of.
  const thresholdMs = s.stallActive
    ? STALL_MS
    : s.status === 'open' && s.epochDelivered
      ? STALL_MS
      : STALL_COLD_MS;

  const stalled = !s.terminal && s.connectStartedAt > 0 && silentMs >= thresholdMs;

  return { stalled, silentMs, thresholdMs };
}

/** How far the client's own counter may sit from where it wants to be before a re-anchor is worth the visible correction. Two ticks: below that the playout buffer's own never-drop-late re-stamp already absorbs the difference invisibly, so correcting it would trade nothing for a snap. */
export const REANCHOR_TOLERANCE_TICKS = 2;

/** Minimum wall time between two rate-limited re-anchors, ms. The tolerance path fires on an error of two ticks, which ordinary clock noise reaches often; without a floor on the interval a client sitting near the boundary would snap several times a second. The runaway-ahead path is deliberately NOT rate limited, because that one is unbounded and gets worse while it waits. */
export const REANCHOR_MIN_INTERVAL_MS = 2000;

export interface ReanchorInputs {
  /** Has the client tick ever been anchored to a server tick estimate this epoch? */
  anchored: boolean;
  /** Has the client tick counter been initialised at all (has advance() ever run)? */
  initialized: boolean;
  clientTick: number;
  /** Where the counter WANTS to be: the estimated server tick plus the connection's measured round trip, its configured input lead and any server-depth feedback. Not the raw server tick estimate, which the counter is supposed to lead. */
  desiredTick: number;
  /** The clock this decision is being made against. Passed in, never read internally, so the function stays pure. */
  now: number;
  /**
   * Local-clock timestamp of the previous anchor, or `Number.NEGATIVE_INFINITY`
   * when there has been none this epoch (or when the caller has deliberately
   * dropped the rate limit). Paces the tolerance path only.
   *
   * NOT 0 FOR "NONE YET", which is the same sentinel-as-a-coordinate trap
   * `PlayoutBuffer.aheadBase` exists for. `now` is a `performance.now()`
   * reading, so 0 is a REAL timestamp roughly two seconds before the earliest
   * moment a connection can have anchored at all: a client that connects
   * inside the first `REANCHOR_MIN_INTERVAL_MS` of a page's life would read
   * "never anchored" as "anchored two seconds ago" and refuse to correct.
   */
  lastReanchorAt: number;
  /** Is the caller's server-clock estimate currently mid-STEP, i.e. running the escape hatch that decides whether its offset belongs to a timeline that no longer exists? Suppresses the tolerance path only. */
  clockStepping: boolean;
}

/**
 * The client's own tick counter advances at wall-clock rate every rendered
 * frame, but the SERVER's tick is a pure counter that PAUSES for however
 * long no authoritative tick loop owns the room (a lease gap between a
 * predecessor's death and a successor's first tick). So a client can drift
 * ahead of the server it is talking to, and once it does, every stamped
 * input it sends targets a tick the server has not reached yet and never
 * will in time, which starves the server-side playout buffer forever.
 *
 * IT USED TO FIRE ON THE AHEAD SIDE ONLY, AND THAT WAS MEASURED WRONG IN BOTH
 * DIRECTIONS. The reasoning was that running behind is an ordinary latency
 * spike the playout buffer absorbs with a never-drop-late re-stamp, so
 * correcting it would trade an invisible re-stamp for a visible snap. True of
 * a spike; false of everything that leaves the counter behind PERMANENTLY. A
 * routine 300 to 600ms handoff gap leaves the lead inflated by 6 to 12 ticks
 * with nothing to correct it, so every input applies hundreds of milliseconds
 * later than it needed to for the rest of the epoch; and a frame longer than
 * the render loop's own dt cap (a backgrounded tab) drops the missing time
 * outright, measured at 591 ticks behind fifteen seconds after a 30 second
 * background. So the predicate is now two-sided:
 *
 * - MORE THAN half `PLAYOUT_MAX_AHEAD` AHEAD fires immediately, unchanged.
 *   That error is unbounded and every input sent while it stands is wasted.
 * - `REANCHOR_TOLERANCE_TICKS` or more of error in EITHER direction fires at
 *   most once per `REANCHOR_MIN_INTERVAL_MS`, and NOT AT ALL while
 *   `clockStepping`. The rate limit is what keeps the two-sided rule from
 *   turning ordinary clock noise into a stream of corrections, and it is why
 *   the tolerance can be as tight as two ticks.
 *
 * THE `clockStepping` GATE IS THE SAME LESSON AS THE INTERPOLATOR'S
 * SUSPENDED TIME PRUNE. `desiredTick` is computed from a server-clock
 * estimate, and while the caller's step escape is deciding whether that
 * estimate belongs to a timeline that still exists, the estimate is precisely
 * what the caller has stopped believing: acting on it corrects the counter by
 * the size of the clock step, and then the re-seed corrects it straight back.
 * Measured on a handoff onto a successor whose clock ran 600ms ahead: two
 * opposite 12-tick snaps roughly two seconds apart, where suppressing the
 * tolerance path for the ~650ms the escape needs produces none at all,
 * because no real error ever accumulated. The unbounded-ahead rule is
 * deliberately NOT gated: that one is a fact about the counter rather than
 * about the clock, it gets worse while it waits, and a clock step cannot
 * manufacture half of `PLAYOUT_MAX_AHEAD` on its own.
 */
export function shouldReanchor(s: ReanchorInputs): boolean {
  if (!s.anchored || !s.initialized) return false;
  const error = s.clientTick - s.desiredTick;
  if (error > PLAYOUT_MAX_AHEAD / 2) return true;
  if (s.clockStepping) return false;
  return Math.abs(error) >= REANCHOR_TOLERANCE_TICKS && s.now - s.lastReanchorAt >= REANCHOR_MIN_INTERVAL_MS;
}
