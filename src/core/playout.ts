/**
 * How far ahead of the consumer a buffered item may sit before it is refused.
 * Bounds memory against a client that stamps garbage far-future ticks
 * (deliberately or from a broken clock), and bounds how long a genuine burst
 * of out-of-order delivery can be absorbed before the buffer gives up waiting
 * for a gap to fill.
 *
 * "The consumer" is the last consumed tick once there is one, and the first
 * tick pushed before that. It is NOT the `-1` a fresh buffer's floor holds:
 * see the reference note on `push`.
 */
export const PLAYOUT_MAX_AHEAD = 40;

/**
 * What `push` did with a record, so a caller can tell the outcomes apart
 * instead of inferring them from a rising starve count.
 *
 * - `'kept'`: buffered for the tick it was stamped for.
 * - `'late'`: its tick had already been consumed, so it was re-stamped forward
 *   and buffered anyway (never-drop-late).
 * - `'stale'`: late, and a fresher record already held the slot it would have
 *   been re-stamped onto. Nothing landed and nothing was lost, which is what a
 *   redundancy window's re-sends do on a HEALTHY link.
 * - `'refused'`: further than `maxAhead` from the consumed floor, so it was
 *   dropped outright. The only one of the four that means a record is gone.
 *
 * `'stale'` IS DELIBERATELY NOT `'refused'`, and the distinction is the whole
 * point of reporting at all: most of a healthy redundancy window lands on the
 * stale path by design, so folding the two together would report a
 * permanently sick sender for a permanently healthy one. That is the same trap
 * `lateCount` was already moved out of.
 */
export type PushResult = 'kept' | 'late' | 'stale' | 'refused';

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
 * straggler that is arriving even later. `lateCount` counts only the
 * re-stamps that actually LAND in that slot, i.e. a record the buffer had
 * never received on time; a re-stamp that loses the freshness check above
 * costs nothing, because an input redundancy window's whole point is to
 * re-send a tick the buffer already has, and those re-sends taking this same
 * late path (their original tick has, by design, already passed) must not
 * read as a health problem. A healthy connection therefore reports zero here
 * even while its redundancy window is constantly re-sending old ticks; a
 * rising count means an on-time copy is genuinely missing and only a stale
 * re-send is filling the gap.
 */
export class PlayoutBuffer<T> {
  private readonly entries = new Map<number, Entry<T>>();
  private readonly maxAhead: number;

  /**
   * What the ahead bound is measured FROM. `null` means "no reference yet",
   * which is a genuinely different fact from `lastConsumedTick`'s -1, and
   * conflating the two is the defect written up on `push`. The first push
   * installs a provisional reference; the first consume replaces it with the
   * consumer's real position and it tracks the floor from then on.
   */
  private aheadBase: number | null = null;

  /** Starts at -1 (no tick has been asked for yet), never at 0: tick 0 is a real, consumable tick and must not be treated as already-passed. */
  lastConsumedTick = -1;

  /**
   * How many re-stamped pushes actually LANDED in their re-stamped slot,
   * carrying information the buffer had never received on time. Counted
   * strictly AFTER the freshness check in `push`, not before: a redundancy
   * window re-sends ticks the buffer already has, those re-sends take the
   * same late path (their original tick has already passed by design) but
   * lose the freshness check to whatever is already sitting in the slot, and
   * a re-send that loses that check must not count here or this stops being
   * a health signal at all on a perfectly healthy, zero-loss link. A rising
   * count under a healthy round-trip time is the first sign of a starving or
   * badly jittered link.
   */
  lateCount = 0;

  /**
   * How many pushes were REFUSED for sitting further than `maxAhead` from the
   * consumed floor. Distinct from `lateCount` in both direction and cause: a
   * late push arrived after its tick and is applied anyway, where a refused
   * one is discarded entirely because the sender's lead is larger than this
   * buffer is configured to hold. A rising count is a CONFIGURATION fault
   * rather than a network one, which is exactly why it needed a name: the only
   * symptom before was starves climbing with nothing anywhere saying why.
   */
  refusedCount = 0;

  constructor(maxAhead: number = PLAYOUT_MAX_AHEAD) {
    this.maxAhead = maxAhead;
  }

  /**
   * Buffers `item` for `tick`, or the earliest still-usable tick if `tick`
   * has already passed. See the class comment for the re-stamping and
   * eviction rules.
   */
  push(tick: number, item: T): PushResult {
    // THE AHEAD BOUND IS RELATIVE, SO IT NEEDS SOMETHING REAL TO BE RELATIVE
    // TO. `lastConsumedTick` starts at -1 meaning "nothing has been asked for
    // yet", NOT "the consumer is sitting at tick -1". Measuring the bound
    // from that sentinel makes the distance to any tick in a room that has
    // been up for a while enormous, so a buffer created FRESH in a room
    // already past `maxAhead` refused every single push until some later
    // consume happened to anchor the floor. Measured by a game integrating
    // this library: at room tick 100 and at room tick 50000 the first push
    // into a new buffer was dropped, while at tick 0 and tick 30 it was kept.
    // A host whose client re-sends its recent inputs (the redundancy window,
    // see `codec/snapshot.ts`) loses only the first copy and the buffer heals
    // on the next packet, which is why this hid for so long; a host that
    // sends each input once loses the first stamped input of every buffer
    // outright, and in a game that creates a buffer when a player takes
    // control of something, that is the first input of the thing they just
    // took control of.
    //
    // A fresh buffer has no consumer position, so it has no meaningful
    // "ahead" yet: the first push establishes the reference instead.
    //
    // DELIBERATELY NOT DONE BY MOVING `lastConsumedTick` ITSELF. That field
    // means "the consumer has already passed this tick" and a producer's
    // stamp is not entitled to assert it. Anchoring the FLOOR to `tick - 1`
    // would make every slightly-older re-send in the same redundancy burst
    // count as late, so the never-drop-late path below would re-stamp them
    // all onto the one slot above the floor and the freshness dedupe would
    // discard all but one: it converts one dropped input into several, which
    // is worse than the defect it fixes.
    if (this.aheadBase === null) this.aheadBase = tick - 1;

    let target = tick;
    if (target <= this.lastConsumedTick) {
      target = this.lastConsumedTick + 1;
      const existing = this.entries.get(target);
      if (existing !== undefined && existing.orig >= tick) {
        // The slot already holds something that was always going to be due
        // no later than this push. Do not let a later straggler overwrite a
        // fresher entry just because it happened to be re-stamped onto the
        // same slot, and do not count it as late either: nothing landed, so
        // nothing changed about what the buffer holds.
        return 'stale';
      }
      // Only counted once the push actually lands. Landing here first and
      // counting after is what keeps a redundancy window's constant re-sends
      // of already-consumed ticks from inflating this on an otherwise
      // healthy link: see the class comment and the field doc above.
      this.lateCount += 1;
      this.entries.set(target, { item, orig: tick });
      return 'late';
    } else if (target - this.aheadBase > this.maxAhead || this.aheadBase - target > this.maxAhead) {
      // Far enough from the reference that buffering it risks unbounded
      // growth from a misbehaving or clock-skewed sender. Drop rather than
      // evict something else to make room: an item this far out is not worth
      // protecting at another's expense.
      //
      // THE BELOW-THE-REFERENCE HALF IS REACHABLE ONLY BEFORE THE FIRST
      // CONSUME, AND IS DEAD CODE AFTER IT. Precisely: it can fire only when a
      // push lands more than `maxAhead` BELOW the provisional reference an
      // earlier push installed, and only while `aheadBase` is still that
      // provisional value. The first `consume` replaces it with
      // `lastConsumedTick`, from which point anything at or below the floor
      // takes the late branch above and can never reach this test at all.
      //
      // IT IS KEPT BECAUSE IT IS THE ONLY MEMORY BOUND IN THAT WINDOW. Without
      // it a sender walking its stamps DOWNWARD before the first consume is
      // admitted without limit, and the stamps come off the wire; with it,
      // "this buffer holds O(maxAhead) slots" is true from construction rather
      // than only from the first consume. So it is a live bound with a narrow
      // reachable window, not an unreachable branch to tidy away: the room in
      // which it fires is a buffer that has been pushed to and not yet
      // consumed from, which is every buffer's first tick.
      //
      // AND THE CALLER IS NOW TOLD, which it was not: this returned void, so a
      // sender whose entire window sat past the bound was refused in complete
      // silence. The only symptom was starves climbing with nothing naming the
      // cause, on the one failure whose fix is a configuration change rather
      // than a network one.
      this.refusedCount += 1;
      return 'refused';
    }
    this.entries.set(target, { item, orig: tick });
    return 'kept';
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
    // The consumer's own position supersedes whatever provisional reference
    // the first push installed. From here it tracks the floor, which is
    // monotonic, so the only step this can ever take BACKWARDS is this first
    // one (from `firstPushedTick - 1` down to where the consumer actually
    // is), and that direction widens the admissible window back toward the
    // truth rather than narrowing it.
    this.aheadBase = this.lastConsumedTick;
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
    // Back to "no reference yet", not to the -1 sentinel: a cleared buffer is
    // in exactly the state a freshly constructed one is, and if this were
    // left pointing at the old floor the next push would be measured against
    // a consumer position that no longer exists.
    this.aheadBase = null;
    this.lateCount = 0;
    this.refusedCount = 0;
  }

  private pruneAtOrBelow(tick: number): void {
    for (const key of this.entries.keys()) {
      if (key <= tick) this.entries.delete(key);
    }
  }
}
