/**
 * How far ahead of the last consumed tick a buffered item may sit before it
 * is evicted. Bounds memory against a client that stamps garbage far-future
 * ticks (deliberately or from a broken clock), and bounds how long a genuine
 * burst of out-of-order delivery can be absorbed before the buffer gives up
 * waiting for a gap to fill.
 */
export const PLAYOUT_MAX_AHEAD = 40;

interface Entry<T> {
  item: T;
  /** The tick this entry was ORIGINALLY pushed for, before any re-stamping. See NEVER-DROP-LATE below. */
  orig: number;
}

/**
 * A generic tick-stamped item buffer: push things out of order, tagged with
 * the tick they are meant to apply on, and consume exactly the item stamped
 * for a given tick as the simulation reaches it.
 *
 * This is what makes an input land on the SAME tick at both ends of a
 * connection with real network jitter between them: the sender stamps a
 * `targetTick` computed from its own clock estimate, sends it as soon as
 * possible, and the receiver buffers everything that arrives ahead of when
 * it is due rather than applying it immediately (which would make a fast
 * network apply an input a tick early and a slow one a tick late,
 * scrambling replay).
 *
 * NEVER-DROP-LATE is the property that makes this safe to use with a lossy,
 * reordering transport. The naive design drops a push whose tick is at or
 * before `lastConsumedTick` (the tick has already passed, nothing can act on
 * it now). That is correct for a single missed packet but actively wrong
 * under reordering or a burst of small delays: a run of inputs that all
 * arrive a tick or two late would each be silently discarded, and for
 * something like a car's steering that reads as the input simply not having
 * happened, i.e. the client's prediction and the server's authoritative path
 * diverge and stay diverged until something forces a correction.
 *
 * So a late push is instead RE-STAMPED forward to `lastConsumedTick + 1`,
 * the earliest tick that could still possibly consume it, UNLESS a fresher
 * entry already occupies that slot. "Fresher" is judged by the entry's
 * ORIGINAL tick, not by arrival order: if slot `lastConsumedTick + 1` already
 * holds an entry whose `orig` is >= this push's tick, that entry is the one
 * that was always closer to being on time and it must not be clobbered by a
 * straggler that is arriving even later. `lateCount` tracks how often this
 * path fires, as a health signal: a healthy connection should almost never
 * need it.
 */
export class PlayoutBuffer<T> {
  private readonly entries = new Map<number, Entry<T>>();
  private readonly maxAhead: number;

  /** Starts at -1 (no tick has been asked for yet), never at 0: tick 0 is a real, consumable tick and must not be treated as already-passed. */
  lastConsumedTick = -1;

  /** How many pushes were re-stamped forward because their original tick had already passed. A rising count under a healthy round-trip time is the first sign of a starving or badly jittered link. */
  lateCount = 0;

  constructor(maxAhead: number = PLAYOUT_MAX_AHEAD) {
    this.maxAhead = maxAhead;
  }

  /**
   * Buffers `item` for `tick`, or the earliest still-usable tick if `tick`
   * has already passed. See the class comment for the re-stamping and
   * eviction rules.
   */
  push(tick: number, item: T): void {
    let target = tick;
    if (target <= this.lastConsumedTick) {
      this.lateCount += 1;
      target = this.lastConsumedTick + 1;
      const existing = this.entries.get(target);
      if (existing !== undefined && existing.orig >= tick) {
        // The slot already holds something that was always going to be due
        // no later than this push. Do not let a later straggler overwrite a
        // fresher entry just because it happened to be re-stamped onto the
        // same slot.
        return;
      }
    } else if (target - this.lastConsumedTick > this.maxAhead) {
      // Far enough in the future that buffering it risks unbounded growth
      // from a misbehaving or clock-skewed sender. Drop rather than evict
      // something else to make room: an item this far out is not worth
      // protecting at another's expense.
      return;
    }
    this.entries.set(target, { item, orig: tick });
  }

  /**
   * Consumes the item stamped for exactly `tick`, advancing the consumed
   * floor whether or not one was found. A miss is a STARVE: the caller
   * (typically the host repeating the last applied input, or decaying it,
   * see `starvation.ts`) decides what happens next, this buffer only reports
   * the fact.
   */
  consume(tick: number): { item: T | undefined; starved: boolean } {
    const entry = this.entries.get(tick);
    this.entries.delete(tick);
    // THE FLOOR ONLY EVER RISES. Assigning `tick` unconditionally looks
    // equivalent because a healthy host always consumes an increasing tick, but
    // the host is not always healthy: a client re-anchor, a checkpoint restore
    // that resumes at an earlier tick, or simply a caller bug can hand this an
    // older tick. Letting the floor move BACKWARDS un-does never-drop-late,
    // because entries that were already re-stamped forward past the old floor
    // become eligible for re-stamping again, and an input that was already
    // consumed can be applied a second time. Both present as a player's action
    // repeating itself, which is close to impossible to diagnose from the
    // outside. Guarding the assignment is one comparison and removes the whole
    // class.
    if (tick > this.lastConsumedTick) this.lastConsumedTick = tick;
    this.pruneAtOrBelow(this.lastConsumedTick);
    if (entry === undefined) {
      return { item: undefined, starved: true };
    }
    return { item: entry.item, starved: false };
  }

  /** Saturating 0..255 health gauge: buffered-ahead count clamped for a wire-friendly single byte. Callers wanting a richer signal should read `lateCount` directly instead. */
  health(): number {
    return Math.min(255, this.entries.size);
  }

  clear(): void {
    this.entries.clear();
    this.lastConsumedTick = -1;
    this.lateCount = 0;
  }

  private pruneAtOrBelow(tick: number): void {
    for (const key of this.entries.keys()) {
      if (key <= tick) this.entries.delete(key);
    }
  }
}
