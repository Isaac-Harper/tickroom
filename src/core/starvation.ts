/**
 * What a host does when a player's `PlayoutBuffer` has nothing stamped for
 * the tick being computed right now.
 *
 * Repeating the last applied input is the right answer for exactly ONE
 * starved tick: a single dropped or late packet on an otherwise healthy
 * connection should be invisible, and holding the last known input for one
 * tick is a good guess at what the player is still doing.
 *
 * It is the WRONG answer held forever. Consider a player who was steering
 * hard left and then straightens out, but the packet carrying "straighten
 * out" is late or lost. Bare repeat-last holds the stale LEFT TURN input on
 * the server while the client, which already knows it released the turn,
 * predicts driving straight. The two diverge every tick the starvation
 * continues, and because the render-side correction pulls the client's view
 * toward the server's (wrong, still-turning) state and then the next real
 * input corrects it back, the player sees their car nudged sideways in
 * steps, over and over: a directional sawtooth. That failure mode is what
 * this module exists to remove, and the fix is not "buffer harder", it is to
 * decay the held input toward neutral the longer the starvation continues,
 * so a bad guess fades instead of ossifying.
 *
 * `decayOnStarve` is POLICY ONLY, not a place to encode a specific
 * simulation's steering law. It knows nothing about cars, pixels, or units:
 * it takes one held numeric input value and returns a smaller one. The
 * DECAY LIVES IN THE TRANSPORT LAYER (the host applying repeated inputs from
 * a starving buffer), never inside the pure simulation step: the client's
 * own rollback replay reconstructs the authoritative timeline by replaying
 * its OWN STORED inputs, not by re-deriving what the server's decay would
 * have done, so a decayed tick on the server is a genuine, real divergence
 * from what the client predicted. That is fine and expected: it is rare
 * (only happens under starvation, which the input redundancy window is
 * designed to make rare in the first place) and small (bounded by how far a
 * value can decay before the next real input arrives), and it is exactly the
 * kind of small divergence the render-layer error-offset smoothing exists to
 * absorb without a visible snap. Trying to make the client predict the
 * decay too would mean shipping the decay policy to the client and coupling
 * client and host versions to it; simpler to let it be a divergence and let
 * the existing smoothing machinery do its job.
 */

export const STARVE_DECAY_AFTER = 2;
export const STARVE_DECAY_EPS = 0.05;
const STARVE_DECAY_FACTOR = 0.5;

export interface StarveDecayOptions {
  /** Consecutive starves before decay begins. The first starve or two are assumed to be ordinary jitter, not a real gap. */
  decayAfter?: number;
  /** Multiplier applied per starved tick once decay has begun. */
  factor?: number;
  /** Below this magnitude the value snaps straight to 0 rather than asymptotically approaching it forever. */
  epsilon?: number;
}

export interface StarveResult {
  streak: number;
  value: number;
}

/**
 * `streak` is the CONSECUTIVE starve count including this one (call with the
 * count BEFORE this starve; it returns the count and value AFTER). From the
 * `decayAfter`-th consecutive starve, `value` is multiplied by `factor` each
 * additional tick and snapped to exactly 0 once it falls under `epsilon`,
 * because an exponential decay never truly reaches zero and a held input
 * that asymptotically approaches neutral forever never actually lets the
 * simulation settle into an idle state.
 */
export function decayOnStarve(streak: number, value: number, opts?: StarveDecayOptions): StarveResult {
  const decayAfter = opts?.decayAfter ?? STARVE_DECAY_AFTER;
  const factor = opts?.factor ?? STARVE_DECAY_FACTOR;
  const epsilon = opts?.epsilon ?? STARVE_DECAY_EPS;

  const nextStreak = streak + 1;
  if (nextStreak < decayAfter) {
    return { streak: nextStreak, value };
  }
  const decayed = value * factor;
  const snapped = Math.abs(decayed) < epsilon ? 0 : decayed;
  return { streak: nextStreak, value: snapped };
}

/**
 * Owns the per-player consecutive-starve streak so every host does not
 * reinvent the same `Map<pid, number>` bookkeeping. Deliberately does NOT
 * own the held input value itself: what "the input" even is (a steering
 * angle, a cursor delta, a full object) is host-specific, so a host reads
 * `streakOf`/`onStarve`'s return and applies `decayOnStarve` to its own
 * stored value.
 */
export class StarveTracker {
  private readonly streaks = new Map<string, number>();

  /** A real input was consumed for this pid: the streak resets, since decay should only accumulate across UNBROKEN runs of starvation. */
  onConsume(pid: string): void {
    this.streaks.delete(pid);
  }

  /** This pid starved this tick. Returns the new consecutive-starve count. */
  onStarve(pid: string): number {
    const next = (this.streaks.get(pid) ?? 0) + 1;
    this.streaks.set(pid, next);
    return next;
  }

  forget(pid: string): void {
    this.streaks.delete(pid);
  }

  streakOf(pid: string): number {
    return this.streaks.get(pid) ?? 0;
  }

  clear(): void {
    this.streaks.clear();
  }
}
