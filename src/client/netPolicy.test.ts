import { describe, it, expect } from 'vitest';
import { stallDecision, shouldReanchor, STALL_MS, STALL_COLD_MS, type StallInputs } from './netPolicy.js';
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

  it('does nothing before the first anchor', () => {
    expect(shouldReanchor({ anchored: false, initialized: true, clientTick: 1000, serverTick: 0 })).toBe(false);
  });

  it('does nothing before the counter is initialized', () => {
    expect(shouldReanchor({ anchored: true, initialized: false, clientTick: 1000, serverTick: 0 })).toBe(false);
  });

  it('fires only on the AHEAD side: running behind by a large margin never re-anchors', () => {
    const behind = shouldReanchor({ anchored: true, initialized: true, clientTick: 0, serverTick: 1000 });
    expect(behind).toBe(false);
  });

  it('does not fire at exactly half PLAYOUT_MAX_AHEAD ahead, fires just past it', () => {
    const atThreshold = shouldReanchor({ anchored: true, initialized: true, clientTick: half, serverTick: 0 });
    expect(atThreshold).toBe(false);

    const pastThreshold = shouldReanchor({
      anchored: true,
      initialized: true,
      clientTick: half + 1,
      serverTick: 0,
    });
    expect(pastThreshold).toBe(true);
  });

  it('does not fire for a small, ordinary lead', () => {
    expect(shouldReanchor({ anchored: true, initialized: true, clientTick: 4, serverTick: 0 })).toBe(false);
  });
});
