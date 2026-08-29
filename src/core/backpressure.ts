/** Default global capacity: how many undrained envelopes a room's inbox holds before it starts shedding. */
export const INBOX_CAP = 4096;
/** Default per-tick drain limit: caps how much work one tick's drain can do, so an aggregate flood cannot make a single tick's processing unbounded. */
export const MAX_DRAIN_PER_TICK = 1024;
/** Default per-sender quota. See the class comment for why this exists at all. */
export const PER_SENDER_CAP = 64;

export interface InboxOptions {
  cap?: number;
  perSenderCap?: number;
  maxDrainPerTick?: number;
}

/**
 * A bounded queue of inbound envelopes sitting between the relay/transport
 * and the tick loop, with per-sender fairness on top of a global cap.
 *
 * A GLOBAL CAP ALONE IS NOT ENOUGH, and this is the actual design decision in
 * this file, not the bound itself. `INBOX_CAP` protects memory: an aggregate
 * flood across every sender cannot grow the queue past a fixed size. But a
 * shared resource with only a shared limit can be MONOPOLISED: one sender
 * flooding the channel fills the entire cap by itself, and every OTHER
 * player's perfectly normal input gets shed at the door because the queue is
 * full, degrading the room for all twenty players to punish the one abusive
 * connection.
 *
 * The `perSenderCap` quota fixes this by shedding a flood against its OWN
 * backlog rather than the shared one: each sender may have at most
 * `perSenderCap` envelopes sitting undrained at any moment, tracked
 * independently, so a sender that floods only ever crowds out ITS OWN future
 * envelopes. A well-behaved sender queues perhaps one or two envelopes
 * between drains, so 64 is seconds of slack even under a bad frame; and
 * `senderCount * perSenderCap` is meant to stay comfortably under `cap`
 * (twenty senders at 64 each is 1280, well under a 4096 global cap), so in
 * the single-abuser case the PER-SENDER bound is what actually fires first,
 * which is the entire point: the global cap becomes a backstop against a
 * coordinated flood across many senders at once, not the everyday limiter.
 *
 * `senderId` is optional: an envelope with no sender (a system event, a
 * broadcast) is not subject to the per-sender quota, only the global one.
 */
export class Inbox<T> {
  private readonly queue: T[] = [];
  /** Parallel to `queue`: which sender (if any) queued the item at the same index. Kept separate from `queue` rather than wrapping every item in `{item, senderId}` so `drain()` can return `T[]` directly instead of forcing every caller to unwrap. */
  private readonly pending: (string | null)[] = [];
  private readonly senderCounts = new Map<string, number>();
  private readonly cap: number;
  private readonly perSenderCap: number;
  private readonly maxDrainPerTick: number;
  private dropped = 0;

  constructor(opts?: InboxOptions) {
    this.cap = opts?.cap ?? INBOX_CAP;
    this.perSenderCap = opts?.perSenderCap ?? PER_SENDER_CAP;
    this.maxDrainPerTick = opts?.maxDrainPerTick ?? MAX_DRAIN_PER_TICK;
  }

  /** Attaches the item's sender internally via a side table so `drain` can release the right quota without the caller re-supplying `senderId`. Returns false when the item was shed instead of queued. */
  push(item: T, senderId: string | null = null): boolean {
    if (this.queue.length >= this.cap) {
      this.dropped += 1;
      return false;
    }
    if (senderId !== null) {
      const count = this.senderCounts.get(senderId) ?? 0;
      if (count >= this.perSenderCap) {
        this.dropped += 1;
        return false;
      }
      this.senderCounts.set(senderId, count + 1);
    }
    this.queue.push(item);
    this.pending.push(senderId);
    return true;
  }

  /**
   * Removes and returns up to `max` (default `maxDrainPerTick`) items in
   * push order, releasing each drained item's per-sender quota as it goes so
   * a sender that queued up to its cap can immediately queue more the moment
   * this tick's drain makes room.
   */
  drain(max: number = this.maxDrainPerTick): T[] {
    const n = Math.min(max, this.queue.length);
    const items = this.queue.splice(0, n);
    const senders = this.pending.splice(0, n);
    for (const senderId of senders) {
      if (senderId === null) continue;
      const count = this.senderCounts.get(senderId) ?? 0;
      if (count <= 1) {
        this.senderCounts.delete(senderId);
      } else {
        this.senderCounts.set(senderId, count - 1);
      }
    }
    return items;
  }

  /** Cumulative envelopes shed since construction (or the last `resetDropped`), by either the global or a per-sender cap. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Reads and zeroes the drop counter in one step, for a periodic stats flush that wants a per-interval count rather than a running total. */
  resetDropped(): number {
    const n = this.dropped;
    this.dropped = 0;
    return n;
  }

  size(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue.length = 0;
    this.pending.length = 0;
    this.senderCounts.clear();
  }
}
