import type { RedisLike } from './redisLike.js';

/**
 * A LEASE is what guarantees exactly one authoritative ticker per room even
 * though many serverless invocations may race to become it. It is a Redis key
 * holding the current owner's id with a short TTL, renewed continuously by
 * whoever holds it and re-acquired by whoever notices it is gone.
 *
 * THE TWO-CLOCK RULE. This is the whole safety property of this module, and
 * it has regressed twice in the codebase this was extracted from, both times
 * the same way: collapsing two clocks that look redundant into one.
 *
 * A ticker keeps TWO separate timestamps, not one:
 *
 *   - `lastRenewAt`: the last time a renew was ATTEMPTED. Moved by
 *     `renewAttempted`, unconditionally, whether or not the renew succeeds.
 *     Its only job is to pace HOW OFTEN a renew is attempted (see `renewDue`).
 *
 *   - `lastOwnedAt`: the last time ownership was CONFIRMED. Moved only by
 *     `renewConfirmed`, i.e. only when Redis actually reported the renew
 *     succeeded. This is the clock every safety check reads.
 *
 * The bug both regressions had in common: using ONE timestamp, refreshed on
 * every renew ATTEMPT regardless of outcome. That means a ticker whose renews
 * are silently failing (network partition, a competitor that stole the lease,
 * a hung Redis connection) keeps its "I own this" clock ticking forward at the
 * exact rate it attempts renews, which is also the rate it is published at.
 * The pre-publish safety guard (`mayPublish`, checked before every tick's
 * publish) can therefore never fire in the one condition it exists for: it
 * always sees a "recently confirmed" timestamp, because attempting is being
 * mistaken for confirming.
 *
 * The consequence is not a slow room, it is TWO DIVERGENT SIMULATIONS
 * INTERLEAVED ON ONE CHANNEL. The de-owned ticker keeps stepping its copy of
 * the room and publishing it; a legitimate successor, having correctly
 * acquired the now-free lease, does the same; both checkpoint over each
 * other. Players see the room jump between two different physics results
 * every publish interval. This is worse than a room that briefly has no
 * ticker at all (which just looks like a short freeze) and it is exactly why
 * `renewFailed` below does NOT touch either clock: a failed renew must leave
 * `mayPublish` on a countdown to false, not reset it.
 *
 * `renewDue` and `mayPublish` read different clocks on purpose:
 * `renewDue(lastRenewAt)` decides when to try again (retrying immediately on
 * every tick would spam Redis); `mayPublish(lastOwnedAt)` decides whether it
 * is still safe to have published anything, and only a CONFIRMED renew may
 * push that decision forward.
 *
 * ONE FUNCTION PER CLOCK, and that separation is enforced by the signatures
 * rather than by care: `renewAttempted` moves `lastRenewAt` and nothing else,
 * `renewConfirmed` moves `lastOwnedAt` and nothing else, `renewFailed` moves
 * neither. Any function that can move both is a step back toward the single
 * collapsed timestamp described above. See `renewConfirmed` for the traced
 * split-brain that having it re-anchor the PACING clock actually produces.
 */

export interface LeaseConfig {
  /** How long a held lease key survives with no renew. */
  leaseTtlMs?: number;
  /** How often a renew is attempted. Must stay well under `leaseTtlMs` so a single missed attempt does not lose the lease. */
  leaseRenewMs?: number;
  /** A ticker exits on its own past this age, ahead of a hard platform kill, so it controls its own handoff instead of being cut off mid-publish. */
  maxTickerMs?: number;
  /** A ticker with nobody in the room exits after this much idle time, rather than paying for a loop nobody is watching. */
  emptyGraceMs?: number;
}

export const LEASE_TTL_MS = 5000;
export const LEASE_RENEW_MS = 1500;
export const MAX_TICKER_MS = 700_000;
export const EMPTY_GRACE_MS = 30_000;

function resolveConfig(cfg?: LeaseConfig): Required<LeaseConfig> {
  return {
    leaseTtlMs: cfg?.leaseTtlMs ?? LEASE_TTL_MS,
    leaseRenewMs: cfg?.leaseRenewMs ?? LEASE_RENEW_MS,
    maxTickerMs: cfg?.maxTickerMs ?? MAX_TICKER_MS,
    emptyGraceMs: cfg?.emptyGraceMs ?? EMPTY_GRACE_MS,
  };
}

/** True when nobody holds the lease (the key read back `null`), i.e. a new ticker should attempt to acquire it. */
export function shouldSpawnTicker(leaseValue: string | null): boolean {
  return leaseValue === null;
}

/**
 * Should THIS ticker stop its own loop and exit cleanly. Two independent
 * reasons, checked every tick rather than on a separate timer, so neither can
 * be missed by a timer that itself stalled:
 *
 *   - `maxTickerMs`: exit before the platform's own hard timeout does it for
 *     you. A self-chosen exit can finish its current tick, write a final
 *     checkpoint, and release the lease cleanly; a platform kill mid-publish
 *     cannot do any of that, so the next room state a successor sees is
 *     whatever the last periodic checkpoint happened to catch.
 *   - `emptyGraceMs`: an empty room still costs a live function invocation
 *     and a lease renew every `leaseRenewMs`, for nobody. Exit after a grace
 *     period (not immediately on the last player leaving) so a player who
 *     disconnects and reconnects within a few seconds resumes the same
 *     ticker instead of paying a cold-start.
 */
export function tickerShouldExit(
  opts: { now: number; startedAt: number; emptySince: number | null },
  cfg?: LeaseConfig
): boolean {
  const { maxTickerMs, emptyGraceMs } = resolveConfig(cfg);
  if (opts.now - opts.startedAt >= maxTickerMs) return true;
  if (opts.emptySince !== null && opts.now - opts.emptySince >= emptyGraceMs) return true;
  return false;
}

/** See the module comment: THE TWO-CLOCK RULE. */
export interface OwnershipClock {
  lastRenewAt: number;
  lastOwnedAt: number;
}

/** Both clocks start at the moment the lease was first acquired: an acquire is itself a confirmed ownership event. */
export function createOwnershipClock(acquiredAt: number): OwnershipClock {
  return { lastRenewAt: acquiredAt, lastOwnedAt: acquiredAt };
}

/** A renew was attempted at `now`. Moves ONLY `lastRenewAt`, regardless of whether the renew will succeed: pacing must advance even while ownership is in doubt, or a ticker whose renew is about to fail would retry every tick instead of on the configured cadence. */
export function renewAttempted(clock: OwnershipClock, now: number): OwnershipClock {
  return { lastRenewAt: now, lastOwnedAt: clock.lastOwnedAt };
}

/**
 * A renew SUCCEEDED at `now`. Moves ONLY `lastOwnedAt`, the mirror image of
 * `renewAttempted` moving only `lastRenewAt`: one function per clock, so the
 * two-clock rule is a property of the SHAPE of this module rather than of a
 * convention somebody has to remember. A function that moves both clocks is
 * one tidy-up away from being the single collapsed timestamp the module
 * comment above exists to prevent, which is why this deliberately cannot
 * pace: a caller that uses `renewDue` MUST call `renewAttempted`.
 *
 * IT DOES NOT RE-ANCHOR `lastRenewAt` TO THE CONFIRMATION TIME, AND THAT IS
 * A SAFETY PROPERTY, NOT A TIDINESS ONE. A host issues `renewAttempted` at
 * the moment it STARTS the network call and only reaches here once that
 * call's promise resolves (`server/ticker.ts` section 11: `renewAttempted`,
 * then `renewLease(...).then(() => renewConfirmed(clock, Date.now()))`), so
 * `now` is the attempt time plus one round trip. Re-anchoring `lastRenewAt`
 * onto it makes `renewDue`, which paces strictly off `lastRenewAt`, wait
 * `leaseRenewMs` from the CONFIRMATION rather than from the attempt.
 *
 * The ordinary cost of that is a renew period of `leaseRenewMs + RTT`
 * instead of `leaseRenewMs`, which quietly halves the margin
 * `leaseRenewMs` was chosen to buy ("well under `leaseTtlMs`, so a single
 * missed attempt does not lose the lease"): at `LEASE_RENEW_MS` 1500 and
 * `LEASE_TTL_MS` 5000 that promise holds up to an RTT of 2000ms paced from
 * the attempt, and only to 1000ms paced from the confirmation.
 *
 * THE REAL COST IS A HOLE IN THE RENEW SCHEDULE, and it can lose the lease
 * outright while `mayPublish` still says yes. Once RTT exceeds
 * `leaseRenewMs` the attempts overlap, so several in-flight renews resolve
 * in a row and each one drags `lastRenewAt` forward again; the next attempt
 * is then due `leaseRenewMs` after the LAST of those resolutions, and
 * nothing reaches Redis for up to `RTT + leaseRenewMs`. Traced at
 * RTT 4000 / renew 1500 / TTL 5000: attempts leave at 1500, 3000 and 4500
 * and then not again until 10000, the key's own TTL lapses at about 11500,
 * a successor legitimately acquires it, and this ticker's `lastOwnedAt`
 * (8500, the last confirmation) keeps `mayPublish` true until 13500. Two
 * seconds of exactly the split-brain the two-clock rule exists to prevent,
 * reached without either clock ever being collapsed. Paced from the attempt
 * the same profile issues a renew every 1500ms regardless of RTT, Redis
 * extends the key on that cadence, and the lease never lapses at all.
 *
 * OVERLAPPING RENEWS ARE THE ACCEPTED PRICE AND ARE NOT NEW. They already
 * happen whenever RTT exceeds `leaseRenewMs` (the trace above overlaps three
 * deep before the hole opens); pacing from the attempt makes them regular
 * rather than bursty, with the same bound of `ceil(RTT / leaseRenewMs)` in
 * flight. They are safe by construction: `renewLease` is an owner-checked
 * compare-and-extend, so two concurrent renews both simply extend; every
 * resolution sets `lastOwnedAt` to its own wall clock, which is
 * non-decreasing across resolutions; and a `false` reply means Redis
 * evaluated the key and it was no longer ours, which no later reply can
 * take back.
 */
export function renewConfirmed(clock: OwnershipClock, now: number): OwnershipClock {
  return { lastRenewAt: clock.lastRenewAt, lastOwnedAt: now };
}

/**
 * A renew FAILED (Redis said no, timed out, or threw). Returns the clock
 * UNCHANGED, deliberately: this is the one branch that must not touch
 * `lastOwnedAt`. Confirming a renew failure this same tick already called
 * `renewAttempted` for pacing; a caller must not additionally call this and
 * expect it to move anything. Its entire purpose is to be a no-op that is
 * safe (and cheap) to call from every failure path without having to reason
 * about what state the clock is already in.
 */
export function renewFailed(clock: OwnershipClock): OwnershipClock {
  return clock;
}

/** Is it still safe to publish as the authoritative owner. False once `leaseTtlMs` has passed since the last CONFIRMED renew, never mind how recently one was merely attempted. */
export function mayPublish(clock: OwnershipClock, now: number, leaseTtlMs: number = LEASE_TTL_MS): boolean {
  return now - clock.lastOwnedAt < leaseTtlMs;
}

/** Is a renew attempt due. Paced off `lastRenewAt`, independent of whether the last attempt succeeded. */
export function renewDue(clock: OwnershipClock, now: number, renewMs: number = LEASE_RENEW_MS): boolean {
  return now - clock.lastRenewAt >= renewMs;
}

const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) else return nil end";

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Attempts to become the lease holder. `SET key owner PX ttl NX`: the `NX`
 * (only set if absent) is what makes this an atomic compare-and-set rather
 * than a read-then-write race between two invocations that both saw the key
 * missing.
 *
 * REQUIRES THE LITERAL `'OK'`, not merely "not null/undefined". This is a
 * SPLIT-BRAIN GUARD, the one place in the whole library where a false
 * positive means two authoritative tickers publishing interleaved snapshots
 * and clobbering one checkpoint (see the module comment). `redis.set(...)`
 * is typed `Promise<any>` because ioredis's own overloads cannot be narrowed
 * structurally, so a permissive check here (`!== null && !== undefined`)
 * would accept `0`, `''`, or any other Redis reply that happens not to be
 * nullish as proof of ownership. A real `SET ... NX` only ever replies `'OK'`
 * (acquired) or `null` (someone else already holds it), so requiring the
 * exact string costs nothing against a correct client and closes the gap
 * against a mock, a proxy, or a future Redis-compatible backend that returns
 * something else truthy. A guard whose failure mode is silent and
 * catastrophic must fail CLOSED on anything it does not recognise.
 */
export async function acquireLease(
  redis: RedisLike,
  leaseKey: string,
  owner: string,
  cfg?: LeaseConfig
): Promise<boolean> {
  const { leaseTtlMs } = resolveConfig(cfg);
  const result = await redis.set(leaseKey, owner, 'PX', leaseTtlMs, 'NX');
  return result === 'OK';
}

/**
 * Extends the lease, but ONLY if this caller still holds it. Plain
 * GET-then-SET from application code would race against a competitor that
 * acquired the lease in between (this ticker's lease expired and a successor
 * already took over): the Lua script makes the check-and-extend atomic inside
 * Redis, so a renew can never resurrect a lease that has already moved on.
 */
export async function renewLease(
  redis: RedisLike,
  leaseKey: string,
  owner: string,
  cfg?: LeaseConfig
): Promise<boolean> {
  const { leaseTtlMs } = resolveConfig(cfg);
  const result = await redis.eval(RENEW_SCRIPT, 1, leaseKey, owner, leaseTtlMs);
  // Same fail-closed reasoning as acquireLease above: RENEW_SCRIPT's own
  // branches only ever return the result of a `SET` ('OK') or Lua `nil`
  // (surfaced to JS as `null`), so `'OK'` is the only reply that means
  // "still holds the lease, renewed". Anything else, including a reply
  // shape this module has never seen, must be treated as renewal failure
  // rather than success.
  return result === 'OK';
}

/**
 * Releases the lease, but again ONLY if this caller still holds it: a ticker
 * that has already lost its lease (and is now exiting because it noticed)
 * must never delete a successor's freshly acquired one out from under it.
 */
export async function releaseLease(redis: RedisLike, leaseKey: string, owner: string): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, leaseKey, owner);
}
