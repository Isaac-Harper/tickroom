import { describe, it, expect } from 'vitest';
import {
  stallDecision,
  shouldReanchor,
  STALL_MS,
  STALL_COLD_MS,
  REANCHOR_TOLERANCE_TICKS,
  REANCHOR_MIN_INTERVAL_MS,
  type StallInputs,
  type ReanchorInputs,
} from './netPolicy.js';
import { PLAYOUT_MAX_AHEAD } from '../core/index.js';

// A connection attempt is considered "in progress" only once connectStartedAt
// is positive; 0 means idle and can never stall (see the dedicated test
// below). Every other test needs a real attempt in progress, so they anchor
// on this arbitrary non-zero baseline and express `now` as an offset from it.
const STARTED = 1_000_000;

function baseInputs(overrides: Partial<StallInputs> = {}): StallInputs {
  return {
    now: STARTED,
    lastSnapAt: 0,
    connectStartedAt: STARTED,
    status: 'idle',
    epochDelivered: false,
    stallActive: false,
    terminal: false,
    ...overrides,
  };
}

describe('stallDecision', () => {
  it('never stalls before a connection attempt has started (connectStartedAt 0)', () => {
    const d = stallDecision(baseInputs({ connectStartedAt: 0, now: 100_000_000 }));
    expect(d.stalled).toBe(false);
    expect(d.silentMs).toBe(0);
  });

  it('warm epoch (open + delivered): stays unstalled right up to STALL_MS, flips at it', () => {
    const inputs = baseInputs({ status: 'open', epochDelivered: true, lastSnapAt: STARTED });
    const justUnder = stallDecision({ ...inputs, now: STARTED + STALL_MS - 1 });
    expect(justUnder.stalled).toBe(false);
    expect(justUnder.thresholdMs).toBe(STALL_MS);

    const atThreshold = stallDecision({ ...inputs, now: STARTED + STALL_MS });
    expect(atThreshold.stalled).toBe(true);
  });

  it('cold epoch (nothing delivered yet): stays unstalled right up to STALL_COLD_MS, flips at it', () => {
    const inputs = baseInputs({ status: 'connecting', epochDelivered: false });
    const justUnder = stallDecision({ ...inputs, now: STARTED + STALL_COLD_MS - 1 });
    expect(justUnder.stalled).toBe(false);
    expect(justUnder.thresholdMs).toBe(STALL_COLD_MS);

    const atThreshold = stallDecision({ ...inputs, now: STARTED + STALL_COLD_MS });
    expect(atThreshold.stalled).toBe(true);
  });

  it('a closed socket that has never delivered anything (in backoff) still uses the cold threshold, not the warm one', () => {
    const d = stallDecision(
      baseInputs({ status: 'closed', epochDelivered: false, now: STARTED + STALL_MS + 1 }),
    );
    // Past STALL_MS but well under STALL_COLD_MS, so this must NOT be stalled yet under the cold regime.
    expect(d.stalled).toBe(false);
    expect(d.thresholdMs).toBe(STALL_COLD_MS);
  });

  it('hysteresis: once stalled, a widening regime (status drops to closed) does not clear it, only fresh evidence does', () => {
    // Silence sits between STALL_MS and STALL_COLD_MS. Under a fresh (non-stalled) read this
    // would use the wide cold threshold and read as NOT stalled, but with stallActive already
    // true the tight threshold stays in force.
    const now = STARTED + STALL_MS + 500;
    const stillStalled = stallDecision(
      baseInputs({ status: 'closed', epochDelivered: false, stallActive: true, now }),
    );
    expect(stillStalled.stalled).toBe(true);
    expect(stillStalled.thresholdMs).toBe(STALL_MS);

    // Confirm the asymmetry: the SAME silence, without the active latch, would not be stalled.
    const freshRead = stallDecision(
      baseInputs({ status: 'closed', epochDelivered: false, stallActive: false, now }),
    );
    expect(freshRead.stalled).toBe(false);
  });

  it('a fresh snapshot clears the hysteresis by collapsing silentMs, not by the threshold changing', () => {
    const d = stallDecision(
      baseInputs({
        status: 'open',
        epochDelivered: true,
        stallActive: true,
        lastSnapAt: STARTED + 100_000,
        now: STARTED + 100_010,
      }),
    );
    expect(d.silentMs).toBe(10);
    expect(d.stalled).toBe(false);
  });

  it('a terminal latch suppresses the stall regardless of how long the silence has run', () => {
    const d = stallDecision(
      baseInputs({ now: STARTED + STALL_COLD_MS * 10, terminal: true, stallActive: true }),
    );
    expect(d.stalled).toBe(false);
  });

  it('the SAME silence, without the terminal latch, is stalled: the latch is what suppresses it, not the silence length', () => {
    const withoutTerminal = stallDecision(
      baseInputs({ now: STARTED + STALL_COLD_MS * 10, terminal: false, stallActive: true }),
    );
    const withTerminal = stallDecision(
      baseInputs({ now: STARTED + STALL_COLD_MS * 10, terminal: true, stallActive: true }),
    );
    expect(withoutTerminal.stalled).toBe(true);
    expect(withTerminal.stalled).toBe(false);
  });
});

describe('shouldReanchor', () => {
  const half = PLAYOUT_MAX_AHEAD / 2;

  // Every case anchors on a non-zero clock, because `lastReanchorAt` of 0 is
  // "never anchored" and would make the rate limit vacuously satisfied in the
  // one direction the tests most need to control.
  const NOW = 1_000_000;
  function inputs(over: Partial<ReanchorInputs> = {}): ReanchorInputs {
    return {
      anchored: true,
      initialized: true,
      clientTick: 0,
      desiredTick: 0,
      now: NOW,
      lastReanchorAt: NOW - REANCHOR_MIN_INTERVAL_MS,
      clockStepping: false,
      ...over,
    };
  }

  it('does nothing before the first anchor', () => {
    expect(shouldReanchor(inputs({ anchored: false, clientTick: 1000 }))).toBe(false);
  });

  it('does nothing before the counter is initialized', () => {
    expect(shouldReanchor(inputs({ initialized: false, clientTick: 1000 }))).toBe(false);
  });

  it('running far AHEAD fires immediately, without waiting out the rate limit', () => {
    // The unbounded direction. Every input stamped while the counter runs this
    // far ahead targets a tick the server will not reach in time, so waiting
    // two seconds to correct it is two seconds of wasted input.
    const justAnchored = inputs({ clientTick: half + 1, lastReanchorAt: NOW });
    expect(shouldReanchor(justAnchored)).toBe(true);
  });

  it('does not fire at exactly half PLAYOUT_MAX_AHEAD ahead on the IMMEDIATE path, fires just past it', () => {
    const atThreshold = inputs({ clientTick: half, lastReanchorAt: NOW });
    expect(shouldReanchor(atThreshold)).toBe(false);

    const pastThreshold = inputs({ clientTick: half + 1, lastReanchorAt: NOW });
    expect(shouldReanchor(pastThreshold)).toBe(true);
  });

  it('running BEHIND re-anchors, once per interval', () => {
    // THIS CASE USED TO PIN THE OPPOSITE, and the opposite was measured wrong.
    // The predicate fired on the ahead side only, on the reasoning that a
    // behind-schedule client is an ordinary latency spike the playout buffer
    // re-stamps away. That holds for a spike and for nothing else: a routine
    // 300 to 600ms handoff leaves the lead inflated by 6 to 12 ticks with
    // nothing to correct it, and a backgrounded tab comes back hundreds of
    // ticks behind, both for the rest of the epoch.
    const behind = inputs({ clientTick: 0, desiredTick: 1000 });
    expect(shouldReanchor(behind)).toBe(true);

    // ...and the rate limit is what makes the two-sided rule safe: the same
    // error, a moment after a correction, waits.
    const tooSoon = inputs({ clientTick: 0, desiredTick: 1000, lastReanchorAt: NOW - REANCHOR_MIN_INTERVAL_MS + 1 });
    expect(shouldReanchor(tooSoon)).toBe(false);
  });

  it('a one-tick wobble never re-anchors, however long it has been since the last one', () => {
    // The tolerance is what stops the two-sided rule from snapping on ordinary
    // clock noise. One tick of error is under it in both directions, at any age.
    const ahead = inputs({ clientTick: 1, lastReanchorAt: 0 });
    const behind = inputs({ clientTick: 0, desiredTick: 1, lastReanchorAt: 0 });
    expect(shouldReanchor(ahead)).toBe(false);
    expect(shouldReanchor(behind)).toBe(false);
  });

  it('the tolerance path fires at exactly REANCHOR_TOLERANCE_TICKS, in both directions', () => {
    const aheadJustUnder = inputs({ clientTick: REANCHOR_TOLERANCE_TICKS - 1 });
    const aheadAt = inputs({ clientTick: REANCHOR_TOLERANCE_TICKS });
    expect(shouldReanchor(aheadJustUnder)).toBe(false);
    expect(shouldReanchor(aheadAt)).toBe(true);

    const behindJustUnder = inputs({ desiredTick: REANCHOR_TOLERANCE_TICKS - 1 });
    const behindAt = inputs({ desiredTick: REANCHOR_TOLERANCE_TICKS });
    expect(shouldReanchor(behindJustUnder)).toBe(false);
    expect(shouldReanchor(behindAt)).toBe(true);
  });

  it('a clock step in flight suppresses the tolerance path, and only the tolerance path', () => {
    // `desiredTick` is computed from a server-clock estimate, and while the
    // caller's step escape is deciding whether that estimate belongs to a
    // timeline that still exists, the estimate is exactly what the caller has
    // stopped believing. Measured on a handoff onto a successor 600ms ahead:
    // acting on it snapped the counter 12 ticks one way and the re-seed
    // snapped it 12 ticks back, for an error that was never real.
    const stepping = inputs({ clientTick: 0, desiredTick: 12, clockStepping: true });
    expect(shouldReanchor(stepping)).toBe(false);
    expect(shouldReanchor({ ...stepping, clockStepping: false })).toBe(true);

    // The unbounded-ahead rule is NOT gated: it is a fact about the counter
    // rather than about the clock, it gets worse while it waits, and a clock
    // step cannot manufacture half of PLAYOUT_MAX_AHEAD on its own.
    expect(shouldReanchor(inputs({ clientTick: half + 1, clockStepping: true }))).toBe(true);
  });

  it('"no anchor yet" is NEGATIVE_INFINITY and not 0, because 0 is a real clock reading', () => {
    // Same sentinel-as-a-coordinate trap as `PlayoutBuffer.aheadBase`. `now` is
    // a `performance.now()` reading, so a client that connects inside the first
    // REANCHOR_MIN_INTERVAL_MS of a page's life reads a 0 sentinel as "anchored
    // two seconds ago" and refuses to correct for the whole of its first epoch.
    const early = 300; // 300ms into the page's life
    expect(shouldReanchor(inputs({ clientTick: 10, now: early, lastReanchorAt: Number.NEGATIVE_INFINITY }))).toBe(true);
    expect(shouldReanchor(inputs({ clientTick: 10, now: early, lastReanchorAt: 0 }))).toBe(false);
  });

  it('the rate limit is measured from the LAST anchor, and clears at exactly REANCHOR_MIN_INTERVAL_MS', () => {
    const justUnder = inputs({ clientTick: 10, lastReanchorAt: NOW - REANCHOR_MIN_INTERVAL_MS + 1 });
    const at = inputs({ clientTick: 10, lastReanchorAt: NOW - REANCHOR_MIN_INTERVAL_MS });
    expect(shouldReanchor(justUnder)).toBe(false);
    expect(shouldReanchor(at)).toBe(true);
  });
});
