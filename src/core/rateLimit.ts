export interface TokenBucketOptions {
  /** Maximum burst size: how many tokens can be spent at once with no wait. */
  capacity: number;
  /** Sustained rate the bucket refills at. */
  refillPerSecond: number;
  /** Injectable clock, defaulting to `Date.now`, so a test can drive time deterministically instead of sleeping. */
  now?: (() => number) | undefined;
}

/**
 * A classic token bucket, used as the per-socket inbound guard between an
 * untrusted client and the room's input channel: capacity gives a client
 * some burst tolerance (a frame that briefly sends two packets' worth of
 * input is not an attack), while `refillPerSecond` caps the SUSTAINED rate,
 * which is what actually protects the shared channel and the tick loop
 * behind it.
 *
 * The shipped default (capacity 40, refill 25/s) is sized against a 20Hz
 * legitimate sender: a client sending its real input stream never comes
 * close to exhausting the bucket, but a client hammering the socket at,
 * say, 500 messages a second gets throttled down to the sustained rate
 * almost immediately.
 *
 * Excess frames are simply dropped by the caller when `take()` returns
 * false, exactly as a lossy network would drop them. This is intentional
 * rather than a shortcut: the transport's own input-redundancy window
 * (a client re-sends its last several stamped inputs every packet) is
 * already designed to tolerate lost packets, so a throttled frame costs
 * nothing beyond what ordinary packet loss already costs.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private tokensInternal: number;
  private lastRefillAt: number;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refillPerSecond = opts.refillPerSecond;
    this.now = opts.now ?? Date.now;
    this.tokensInternal = opts.capacity;
    this.lastRefillAt = this.now();
  }

  /** Attempts to spend `n` tokens (default 1). Returns whether it succeeded; on failure no tokens are spent. */
  take(n: number = 1): boolean {
    this.refill();
    if (this.tokensInternal < n) return false;
    this.tokensInternal -= n;
    return true;
  }

  /** Current token count, refilled up to now. Exposed mainly for diagnostics and tests; callers should use `take()` rather than reading this and deciding for themselves, to avoid a check-then-spend race in code that is not actually racy (this class has no concurrency) but would otherwise invite one on the day it is copied somewhere that is. */
  get tokens(): number {
    this.refill();
    return this.tokensInternal;
  }

  private refill(): void {
    const now = this.now();
    const elapsedS = (now - this.lastRefillAt) / 1000;
    if (elapsedS <= 0) return;
    this.tokensInternal = Math.min(this.capacity, this.tokensInternal + elapsedS * this.refillPerSecond);
    this.lastRefillAt = now;
  }
}
