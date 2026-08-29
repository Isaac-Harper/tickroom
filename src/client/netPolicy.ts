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

export interface ReanchorInputs {
  /** Has the client tick ever been anchored to a server tick estimate this epoch? */
  anchored: boolean;
  /** Has the client tick counter been initialised at all (has advance() ever run)? */
  initialized: boolean;
  clientTick: number;
  serverTick: number;
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
 * DIRECTIONAL ON PURPOSE: this only fires when the client is AHEAD. Running
 * BEHIND is an ordinary latency spike or a still-converging clock estimate,
 * and the playout buffer already absorbs that without a jump (a late input
 * is re-stamped forward onto the first free tick rather than dropped, see
 * `PlayoutBuffer`'s never-drop-late rule). Re-anchoring on a behind-schedule
 * client would trade a harmless, invisible re-stamp for a visible corrective
 * snap, which is strictly worse.
 */
export function shouldReanchor(s: ReanchorInputs): boolean {
  if (!s.anchored || !s.initialized) return false;
  return s.clientTick - s.serverTick > PLAYOUT_MAX_AHEAD / 2;
}
