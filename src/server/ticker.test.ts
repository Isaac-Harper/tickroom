import { describe, it, expect, vi } from 'vitest';
import {
  type RoomRuntime,
  type ClientInput,
  type CheckpointEnvelope,
  type RoomStats,
  type LogEvent,
  roomKeys,
  acquireLease,
  unpackCheckpoint,
  JOIN_HEARTBEAT_MS,
} from '../core/index.js';
import { decodeCheckpoint, readCheckpoint } from './checkpoint.js';
import type { Subscriber } from './redis.js';
import { FakeRedis } from './testFakeRedis.js';
import {
  runTicker,
  publishCustom,
  DEFAULT_PRESENCE_TIMEOUT_MS,
  EXIT_SPAWN_WAIT_MS,
  type HostTickerOptions,
} from './ticker.js';

/**
 * HOW LATE THIS MACHINE ACTUALLY FIRES A TIMER, measured once when the file
 * loads: twelve samples of a 25ms `setTimeout`, reported as a factor (1.0 on
 * a host that fires exactly on time, 2.0 on one taking 50ms). An idle machine
 * measures 1.05 to 1.10 rather than 1.00, because node's own per-timer
 * overhead is a millisecond or two; 25ms rather than 10 is what keeps that
 * overhead down to a rounding error instead of a fifth of the reading.
 *
 * The integration suite has its own copy of this in `tests/helpers/jitter.ts`,
 * where it gates the end-to-end wall-clock files. It is duplicated rather
 * than shared because nothing under `src/` imports from `tests/`.
 *
 * Almost everything in this file is a fixed-timestep loop against an in-memory
 * fake, so almost every case here was made load-independent by ending its run
 * on a SAMPLE COUNT rather than on a wall-clock window (see the comments where
 * that is done). What is left is the one case whose subject IS a wall-clock
 * deadline: a race against a bounded timer inside `runTicker`. That budget
 * cannot be made deterministic without faking the very timer it measures, so
 * it is scaled by this factor instead, CAPPED, so a quiet machine keeps the
 * tight bar and a loaded one loosens by a measured amount rather than by a
 * guess. Never use this to soften a bound that describes the library's
 * behaviour; only one that describes the host's scheduling.
 */
async function measureJitterFactor(samples = 12, delayMs = 25): Promise<number> {
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const at = Date.now();
    await new Promise((r) => setTimeout(r, delayMs));
    total += Date.now() - at;
  }
  return Math.max(1, total / samples / delayMs);
}

const JITTER_FACTOR = await measureJitterFactor();
/** Capped at 3, so a machine too loaded to measure anything cannot quietly turn a bound into no bound. */
const JITTER_SCALE = Math.min(3, JITTER_FACTOR);

/**
 * The toy simulation every test below drives: a per-player counter, plus a
 * room-wide `tick` counter that `currentTick` reports. `applyInput` adds
 * `input.data` (a number) to that player's counter.
 *
 * Tests that need a player present at start use `create` overrides rather
 * than publishing a `join` envelope after the fact: a publish issued before
 * `runTicker` has reached its own `sub.subscribe(...)` call is a message
 * with no subscriber and is correctly DROPPED, exactly like a real Redis
 * PUBLISH with nobody listening yet. Tests that specifically need to
 * exercise envelope delivery (the playout test) instead give the ticker a
 * short, generous head start before publishing.
 */
interface CounterState {
  tick: number;
  players: Map<string, { counter: number; playout: boolean }>;
  full: boolean;
  starves: Record<string, number>;
}
type CounterEvent = { kind: 'tick'; tick: number };

function makeCounterRuntime(overrides?: Partial<RoomRuntime<CounterState, CounterEvent>>): RoomRuntime<CounterState, CounterEvent> {
  return {
    tickHz: 200,
    create: () => ({ tick: 0, players: new Map(), full: false, starves: {} }),
    tick: (state) => {
      state.tick += 1;
      return { events: [{ kind: 'tick', tick: state.tick }] };
    },
    currentTick: (state) => state.tick,
    playerCount: (state) => state.players.size,
    join: (state, pid) => {
      if (!state.players.has(pid)) state.players.set(pid, { counter: 0, playout: false });
    },
    leave: (state, pid) => {
      state.players.delete(pid);
    },
    applyInput: (state, pid, input) => {
      const p = state.players.get(pid);
      if (p) p.counter += input.data as number;
    },
    serialize: (state) =>
      JSON.stringify({ tick: state.tick, players: Array.from(state.players.entries()), full: state.full }),
    deserialize: (json) => {
      const parsed = JSON.parse(json) as {
        tick: number;
        players: [string, { counter: number; playout: boolean }][];
        full: boolean;
      };
      return { tick: parsed.tick, players: new Map(parsed.players), full: parsed.full, starves: {} };
    },
    encodeSnapshot: (state) => JSON.stringify({ tick: state.tick, players: Array.from(state.players.entries()) }),
    isFull: (state) => state.full,
    usesPlayout: (state, pid) => state.players.get(pid)?.playout ?? false,
    onStarve: (state, pid, streak) => {
      state.starves[pid] = streak;
    },
    ...overrides,
  };
}

const NS = 'test';

describe('runTicker', () => {
  it('acquires the lease, ticks, and exits empty after grace', async () => {
    const redis = new FakeRedis();
    const runtime = makeCounterRuntime();
    const result = await runTicker({
      runtime,
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      checkpointMs: 10,
      statsMs: 10,
      emptyGraceMs: 20,
      maxRunMs: 10_000,
    });
    expect(result.reason).toBe('empty');
    expect(result.ticks).toBeGreaterThan(0);
  });

  it('returns busy when the lease is already held', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    const held = await acquireLease(redis, keys.lease, 'someone-else');
    expect(held).toBe(true);

    const runtime = makeCounterRuntime();
    const result = await runTicker({
      runtime,
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      emptyGraceMs: 10,
    });
    expect(result).toEqual({ reason: 'busy', ticks: 0, uptimeMs: 0 });
  });

  it('restores from a checkpoint and continues the tick count rather than restarting at 0', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    const runtime = makeCounterRuntime();
    const seededState: CounterState = {
      tick: 500,
      players: new Map([['alice', { counter: 3, playout: false }]]),
      full: false,
      starves: {},
    };
    await redis.set(
      keys.state,
      JSON.stringify({
        v: 1,
        tick: 500,
        graceUntilTick: 0,
        geom: 'geom-v1',
        incarnation: 'inc-1',
        body: runtime.serialize(seededState),
      })
    );

    let observedFirstTick = -1;
    const result = await runTicker({
      runtime: makeCounterRuntime({
        tick: (state) => {
          if (observedFirstTick === -1) observedFirstTick = state.tick;
          state.tick += 1;
          return {};
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      geomKey: () => 'geom-v1',
      // The restored room has one player, so it is never "empty"; give it a
      // duration ceiling instead so the test exits deterministically.
      maxRunMs: 40,
      emptyGraceMs: 1_000_000,
    });

    expect(observedFirstTick).toBe(500); // continued, not restarted at 0
    expect(result.reason).toBe('duration');

    const persisted = unpackCheckpoint(await readCheckpoint(redis, keys.state));
    expect(persisted?.incarnation).toBe('inc-1'); // incarnation preserved across a restore
  });

  it('starts fresh on a geometry digest mismatch instead of restoring', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    const runtime = makeCounterRuntime();
    await redis.set(
      keys.state,
      JSON.stringify({
        v: 1,
        tick: 999,
        graceUntilTick: 0,
        geom: 'old-geometry',
        incarnation: 'stale-incarnation',
        body: runtime.serialize({ tick: 999, players: new Map(), full: false, starves: {} }),
      })
    );

    let observedFirstTick = -1;
    const result = await runTicker({
      runtime: makeCounterRuntime({
        tick: (state) => {
          if (observedFirstTick === -1) observedFirstTick = state.tick;
          state.tick += 1;
          return {};
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      geomKey: () => 'new-geometry',
      emptyGraceMs: 10,
    });

    expect(observedFirstTick).toBe(0); // fresh room, not the stale 999
    const persisted = unpackCheckpoint(await readCheckpoint(redis, keys.state));
    expect(persisted?.incarnation).not.toBe('stale-incarnation'); // a fresh incarnation was minted
    expect(result.reason).toBe('empty');
  });

  it('stops publishing once the lease is stolen mid-run (split-brain guard)', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    const runtime = makeCounterRuntime();

    // THE SNAPSHOT CHANNEL IS ACTUALLY WATCHED, because "stops publishing" is
    // the claim in the name and this case used to assert only the exit reason,
    // the uptime and the lease value. All three of those are satisfied by the
    // ASYNC detector on its own, so the synchronous guard could be disabled
    // outright (`if (false && owns && !mayPublish(...))`) without a red test:
    // the very guard the case is named for was pinned by nothing.
    const publishedAt: number[] = [];
    const observer = redis.fork();
    observer.on('message', (channel) => {
      if (channel === keys.out) publishedAt.push(Date.now());
    });
    await observer.subscribe(keys.out);

    const resultPromise = runTicker({
      runtime,
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      // Shrunk well below the production defaults so the guard fires inside
      // a test's real-time budget instead of the production 1.5-5s window.
      leaseTtlMs: 50,
      // AND NO RENEW IS EVER DUE, which is what leaves the synchronous guard
      // as the only finder. This is the same argument the `eval`-breaking
      // case below makes, reached by pacing instead of by breakage: with a
      // renew interval this far past the run, section 11 never fires, so
      // `lostLeaseExplicitly` can never be set and nothing but the
      // pre-publish `mayPublish` check can notice the theft. It is also the
      // realistic shape of the condition the guard exists for: ownership
      // lapsing between renews rather than a renew reporting the loss.
      leaseRenewMs: 100_000,
      checkpointMs: 1000,
      statsMs: 1000,
      // Thirty times the lease TTL, so neither of these can plausibly be what
      // ends the run, and short enough that a ticker which never notices the
      // theft returns a wrong answer to assert against instead of running out
      // the suite's own timeout.
      maxRunMs: 1500,
      emptyGraceMs: 1500, // the room has no players, so this must not end it either
    });

    // Let it acquire the lease and take a few ticks.
    await new Promise((r) => setTimeout(r, 15));
    const stolenAt = Date.now();
    // Steal the lease the way an independent competing process would: write
    // a different owner value directly, with no coordination at all.
    await redis.set(keys.lease, 'a-thief', 'PX', 5000);

    const result = await resultPromise;
    observer.disconnect();

    // It was publishing, so the assertion below is about a channel that was
    // genuinely being fed rather than one nothing ever reached.
    expect(publishedAt.length).toBeGreaterThan(0);
    // NOT ONE SNAPSHOT PAST THE GUARD'S DEADLINE. Ownership was last
    // confirmed at the acquire, so it lapses `leaseTtlMs` into the run and
    // the last publish must sit before that; the bound below is measured from
    // the theft (15ms in) with a whole extra TTL of slack, so it rules out a
    // loop that simply kept publishing while a successor owned the room,
    // without turning into a measurement of how fast the guard is.
    expect(publishedAt.filter((t) => t > stolenAt + 100).length).toBe(0);

    expect(result.reason).toBe('lease-lost');
    // AND it exited on the lease rather than on the clock. Both exits used to
    // be reachable from this setup with different reasons, so pin the one
    // fact that separates them independently of which detector won: a
    // duration exit cannot happen before the 1500ms cap, and this is half of
    // it. See the case after next for why the two detectors used to disagree.
    expect(result.uptimeMs).toBeLessThan(750);

    // The thief's write must still be standing: this ticker must not have
    // released (and thereby cleared) a lease it no longer owns.
    expect(await redis.get(keys.lease)).toBe('a-thief');
  });

  it('reports lease-lost when the ASYNC renew is the finder', async () => {
    // The other detector, on the same theft. This is the configuration the
    // case above used to run (a renew interval well inside the TTL), where a
    // renew comes due while the thief holds the key, reports a CONFIRMED
    // loss, and sets `lostLeaseExplicitly` long before ownership has lapsed
    // far enough for the synchronous guard to look. Kept as its own case
    // because the case above no longer reaches this path at all, and section
    // 12's `exitReason = 'lease-lost'` would otherwise have no test: changing
    // it to 'duration' reddens exactly here.
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime(),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      leaseTtlMs: 50,
      leaseRenewMs: 20,
      checkpointMs: 1000,
      statsMs: 1000,
      maxRunMs: 5000,
      emptyGraceMs: 5000,
    });

    await new Promise((r) => setTimeout(r, 15));
    await redis.set(keys.lease, 'a-thief', 'PX', 5000);

    const result = await resultPromise;
    expect(result.reason).toBe('lease-lost');
    expect(result.uptimeMs).toBeLessThan(2500);
    expect(await redis.get(keys.lease)).toBe('a-thief');
  });

  /**
   * THE SAME LOSS, SEEN BY THE OTHER DETECTOR, AND THIS IS THE CASE THAT WAS
   * SILENTLY BROKEN.
   *
   * A lost lease has two independent finders inside `runTicker`, and the one
   * that gets there first is decided by scheduling, not by the test:
   *
   *   (a) the ASYNC renew fired off the hot path (section 11), whose failure
   *       sets `lostLeaseExplicitly` and is picked up by the exit check at
   *       the bottom of the loop; and
   *   (b) the SYNCHRONOUS pre-publish `mayPublish` guard (section 7), which
   *       fires when ownership has already lapsed by the time an iteration
   *       starts, i.e. when the loop itself stalled past the lease TTL.
   *
   * A steal with a renew interval inside the TTL cannot choose between them,
   * so it used to be a coin flip on machine load: (a) reported 'lease-lost'
   * and (b) broke out of the loop leaving `exitReason` on its 'duration'
   * initialiser, so on a loaded host the assertion flipped. That was never a
   * timing problem in the test, it was `ticker.ts` genuinely reporting a
   * healthy duration-capped exit for a ticker that had just had the room
   * taken away from it. The two cases above now drive one detector each: the
   * split-brain case pushes every renew past the end of the run so only (b)
   * is left, and the case after it keeps renews frequent so (a) wins.
   *
   * This case pins (b) on its own, and it does so by ORDERING rather than by
   * timing: breaking `eval` means the atomic renew script can never resolve
   * at all, so path (a) can only ever land in its `.catch` (which
   * deliberately does NOT set `lostLeaseExplicitly`, since a thrown renew is
   * a blip and not a confirmed loss) and the synchronous guard is the ONLY
   * finder left. No amount of scheduling delay can hand the detection back to
   * (a). The lease is stolen as well, so this is a real loss and not just an
   * unreachable Redis.
   */
  it('reports lease-lost when the SYNCHRONOUS guard is the only finder', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    const runtime = makeCounterRuntime();

    const resultPromise = runTicker({
      runtime,
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      leaseTtlMs: 50,
      leaseRenewMs: 20,
      checkpointMs: 1000,
      statsMs: 1000,
      maxRunMs: 5000, // must not be what ends the test
      emptyGraceMs: 5000, // the room has no players, so this must also not be what ends it
      log: () => {},
    });

    // Let it acquire the lease and take a few ticks. The acquire itself is
    // already done before this timer can fire: `runTicker` runs synchronously
    // into its `acquireLease` await, and the fake resolves on a microtask,
    // which drains long before any timer callback.
    await new Promise((r) => setTimeout(r, 15));
    // BROKEN BEFORE STOLEN, AND THAT ORDER IS THE WHOLE DETERMINISM ARGUMENT.
    // Every renew up to this instant ran against an unstolen lease and so
    // could only ever have SUCCEEDED, and from this instant on none of them
    // can resolve at all. There is therefore no scheduling of the two, however
    // delayed, in which a renew reports a confirmed loss, which is the only
    // thing that sets `lostLeaseExplicitly`. Stealing first would leave a
    // window (theft landed, break not yet applied) in which a renew in flight
    // could report the loss and hand detection back to path (a).
    redis.break('eval');
    await redis.set(keys.lease, 'a-thief', 'PX', 5000);

    const result = await resultPromise;
    expect(result.reason).toBe('lease-lost');
    // Well inside the 5000ms duration cap, so 'duration' could not have been
    // the honest answer either: the exit is the lease, not the clock. The
    // bound is deliberately loose (half the cap) because it only has to rule
    // the clock OUT, not measure how fast the guard is.
    expect(result.uptimeMs).toBeLessThan(2500);
    expect(await redis.get(keys.lease)).toBe('a-thief');
  });

  it('calls dispose even when tick() throws', async () => {
    const redis = new FakeRedis();
    const disposed = { value: false };
    const runtime = makeCounterRuntime({
      tick: () => {
        throw new Error('boom');
      },
      dispose: () => {
        disposed.value = true;
      },
    });
    const result = await runTicker({
      runtime,
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      emptyGraceMs: 10,
    });
    expect(result.reason).toBe('error');
    expect(disposed.value).toBe(true);
  });

  it('spawns a successor when players remain, and does not when the room is empty', async () => {
    const redisEmpty = new FakeRedis();
    const spawnEmpty = vi.fn().mockResolvedValue(undefined);
    await runTicker({
      runtime: makeCounterRuntime(),
      redis: redisEmpty,
      createSubscriber: () => redisEmpty.fork(),
      roomId: 'r-empty',
      namespace: NS,
      emptyGraceMs: 10,
      spawnSuccessor: spawnEmpty,
    });
    expect(spawnEmpty).not.toHaveBeenCalled();

    const redisFull = new FakeRedis();
    const spawnFull = vi.fn().mockResolvedValue(undefined);
    await runTicker({
      // A player present from the start (see the file header for why this
      // is simpler and more reliable than publishing a join envelope).
      runtime: makeCounterRuntime({
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: false }]]), full: false, starves: {} }),
      }),
      redis: redisFull,
      createSubscriber: () => redisFull.fork(),
      roomId: 'r-full',
      namespace: NS,
      maxRunMs: 20, // exits on the duration ceiling with the player still present
      emptyGraceMs: 100_000,
      spawnSuccessor: spawnFull,
    });
    // The EXIT spawn, so `standby: false`: this room's lifetime cap is far
    // shorter than `standbyLeadMs`, which disables the standby path entirely.
    expect(spawnFull).toHaveBeenCalledWith('r-full', { standby: false });
  });

  it('races the successor spawn against a timeout rather than hanging forever', async () => {
    const redis = new FakeRedis();
    const neverResolves = () => new Promise<void>(() => {});
    const start = Date.now();
    await runTicker({
      runtime: makeCounterRuntime({
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: false }]]), full: false, starves: {} }),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-hang',
      namespace: NS,
      maxRunMs: 10,
      emptyGraceMs: 100_000,
      spawnSuccessor: neverResolves,
    });
    // The spawn itself never resolves; runTicker must still return promptly
    // because the wait is raced against a bounded timer, not chained onto
    // the spawn promise directly.
    //
    // CALIBRATED, NOT WIDENED, and this is the one case in the file that gets
    // that treatment: the thing under test IS a wall-clock deadline
    // (`EXIT_SPAWN_WAIT_MS` inside `runTicker`), so it cannot be turned into a
    // sample count and it cannot be faked without faking the timer being
    // measured. The bar is derived from the constant rather than typed beside
    // it, so moving the budget moves this with it: 500ms of headroom is less
    // than one scheduling hiccup, and scaling by the file's own measured
    // jitter keeps that bar exactly where it is on a quiet host. The explicit
    // timeout is here because the scaled bound can exceed vitest's 5s default,
    // and a harness timeout would pre-empt the assertion.
    const elapsed = Date.now() - start;
    expect(elapsed, `jitterFactor=${JITTER_FACTOR.toFixed(2)}`).toBeLessThan(
      (EXIT_SPAWN_WAIT_MS + 500) * JITTER_SCALE
    );
  }, 15_000);

  // A HOST'S SPAWN RESOLVES ON A DELIVERY RECEIPT, AND THE EXIT HAS TO OUTLAST
  // ONE. The Vercel adapter calls a spawn delivered after `SPAWN_ACK_MS`
  // (3000) because the route being called does not answer until the successor
  // exits; a 2000ms race here decided the exit before that receipt could land,
  // so no exit spawn on that host could ever report anything.
  //
  // WRITTEN AS A LITERAL, NOT DERIVED FROM `EXIT_SPAWN_WAIT_MS`, which is the
  // whole reason these two cases catch anything: a delay expressed as "the
  // budget minus its margin" moves WITH the budget, so shrinking the budget
  // back to 2000 would shrink this to 1500 and both cases would keep passing
  // against the exact regression they exist for. The literal is the adapter's
  // number, and the other end of the coupling (that the adapter never exceeds
  // it) is pinned in `adapters/vercel.test.ts`, where importing `SPAWN_ACK_MS`
  // is not a layering violation.
  const HOST_RECEIPT_MS = 3000;

  it('waits for the exit spawn long enough to observe a host DELIVERY RECEIPT', async () => {
    const redis = new FakeRedis();
    let receiptSeen = false;
    const spawn = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          setTimeout(() => {
            receiptSeen = true;
            resolve(undefined);
          }, HOST_RECEIPT_MS);
        })
    );
    await runTicker({
      runtime: makeCounterRuntime({
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: false }]]), full: false, starves: {} }),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-receipt',
      namespace: NS,
      maxRunMs: 10,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
    });
    // Not "the spawn eventually resolved" (it would, minutes later, with the
    // handler long gone): the receipt had landed BY THE TIME `runTicker`
    // returned, which is the only moment a serverless host is still running.
    expect(receiptSeen).toBe(true);
  }, 15_000);

  it('reports `ticker.spawn-failed` for an EXIT spawn that fails inside the receipt budget', async () => {
    // The line that means "this room has no ticker", on the exits that never
    // fired a standby and therefore have no other reporter at all. Under the
    // old 2000ms race the rejection arrived after `runTicker` had already
    // returned, which on a serverless host is after the instance is frozen:
    // the log line existed in the code and could not reach a log.
    const redis = new FakeRedis();
    const logs: LogEvent[] = [];
    const spawn = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          setTimeout(() => reject(new Error('getaddrinfo ENOTFOUND ticker.invalid')), HOST_RECEIPT_MS);
        })
    );
    const result = await runTicker({
      runtime: makeCounterRuntime({
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: false }]]), full: false, starves: {} }),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-receipt-failed',
      namespace: NS,
      maxRunMs: 10,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: (ev) => logs.push(ev),
    });
    expect(result.reason).toBe('duration');
    const failed = logs.filter((l) => l.kind === 'ticker.spawn-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.room).toBe('r-receipt-failed');
    expect(String(failed[0]?.meta?.['error'])).toContain('ENOTFOUND');
    // The EXIT spawn's line, not a standby's: this room's cap is far shorter
    // than `standbyLeadMs`, so the standby path never ran.
    expect(failed[0]?.meta?.['standby']).toBeUndefined();
  }, 15_000);

  it('applies a playout input on its exact stamped tick, never before', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);

    const seenAtTick: Record<number, number> = {};
    let starvedCount = 0;
    const runtime = makeCounterRuntime({
      tickHz: 50, // 20ms/tick, generous relative to the publish delay below
      create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
      applyBufferedInput: (state, pid, input) => {
        // KEYED BY THE TICK THE STEP ABOUT TO RUN PRODUCES. `state.tick` is
        // the completed count at consume time, one below the stamp: the step
        // that produces tick T consumes the input stamped T (see
        // `RoomRuntime.currentTick`). This used to key by `state.tick` itself
        // and pass, which pinned the record stamped 5 to the step that
        // produced the snapshot labelled 6.
        seenAtTick[state.tick + 1] = input.data as number;
        const p = state.players.get(pid);
        if (p) p.counter += input.data as number;
      },
      onStarve: (state, pid, streak) => {
        starvedCount++;
        state.starves[pid] = streak;
      },
    });

    const resultPromise = runTicker({
      runtime,
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      maxRunMs: 300, // ~15 ticks at 20ms each
      emptyGraceMs: 100_000,
    });

    // A generous head start: everything before the ticker's first fixed-step
    // sleep (acquiring the lease, restoring, subscribing) is a handful of
    // microtask hops against an in-memory fake with no real I/O latency, so
    // 10ms of real wall-clock time is a large margin, not a tight race.
    await new Promise((r) => setTimeout(r, 10));
    const stampedInput: ClientInput = { seq: 1, targetTick: 5, data: 7 };
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [stampedInput] }));

    const result = await resultPromise;
    expect(result.ticks).toBeGreaterThan(5);
    expect(seenAtTick[5]).toBe(7); // applied on exactly the stamped tick
    expect(seenAtTick[4]).toBeUndefined(); // never early
    expect(starvedCount).toBeGreaterThan(0); // every other tick with nothing buffered starves
  });

  it('drops a stale playout buffer once an unstamped input supersedes it', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    let starves = 0;
    let unstampedApplied = 0;

    const runtime = makeCounterRuntime({
      tickHz: 50,
      create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
      applyInput: (state, pid, input) => {
        unstampedApplied++;
        const p = state.players.get(pid);
        if (p) p.counter += input.data as number;
      },
      onStarve: () => {
        starves++;
      },
    });

    const resultPromise = runTicker({
      runtime,
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    // A far-future stamped input, so it would otherwise sit in the buffer
    // starving every tick for the rest of the run...
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: 1000, data: 1 } satisfies ClientInput] })
    );
    await new Promise((r) => setTimeout(r, 20));
    const starvesBeforeUnstamped = starves;
    // ...until an UNSTAMPED input arrives, which must drop the stale buffer.
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 2, data: 9 } satisfies ClientInput] }));
    // THE DROP IS MEASURED AFTER IT, NOT BEFORE IT. Everything above is true
    // whether or not the buffer is dropped: the unstamped input is applied on
    // that branch either way, and both counts were read before the drop could
    // have had any effect, so deleting `dropPlayout` left this case green.
    // The observable consequence is that the starving STOPS: a buffer holding
    // a stamp 1000 ticks out can never be fed, so with the buffer still in
    // place `onStarve` keeps firing on every tick for the rest of the run.
    await new Promise((r) => setTimeout(r, 40)); // let the drop land
    const starvesAfterDrop = starves;
    await new Promise((r) => setTimeout(r, 120)); // ...and keep the room running, several ticks' worth
    const starvesLater = starves;

    await resultPromise;
    expect(starvesBeforeUnstamped).toBeGreaterThan(0);
    expect(starvesLater).toBe(starvesAfterDrop);
    expect(unstampedApplied).toBe(1);
  });
});

/**
 * The runtime-contract items: everything a host needs from the ticker that is
 * not "run my tick function". Each of these exists because something failed
 * SILENTLY without it, so the tests below are written to fail loudly when the
 * fix is removed rather than to observe the fix being present.
 */
describe('runTicker: runtime contract', () => {
  // --- TR-7: one-time async setup, paid only by the winner ---

  it('awaits init after winning the lease and before the first tick', async () => {
    const redis = new FakeRedis();
    const order: string[] = [];
    let initDone = false;

    await runTicker({
      runtime: makeCounterRuntime({
        // The restore path runs `deserialize`, and for a physics-backed host
        // that is itself a consumer of whatever `init` sets up, so it must
        // also come after.
        deserialize: (json) => {
          order.push(`deserialize:${initDone}`);
          const parsed = JSON.parse(json) as { tick: number; players: [string, { counter: number; playout: boolean }][]; full: boolean };
          return { tick: parsed.tick, players: new Map(parsed.players), full: parsed.full, starves: {} };
        },
        tick: (state) => {
          if (order[order.length - 1] !== 'tick') order.push('tick');
          state.tick += 1;
          return {};
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-init',
      namespace: NS,
      init: async () => {
        order.push('init');
        await new Promise((r) => setTimeout(r, 5));
        initDone = true;
      },
      emptyGraceMs: 10,
    });

    expect(order[0]).toBe('init');
    expect(order).toContain('tick');
    expect(order.indexOf('init')).toBeLessThan(order.indexOf('tick'));
  });

  it('never pays init on an invocation that loses the acquire race', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-busy', NS);
    await acquireLease(redis, keys.lease, 'someone-else');

    const init = vi.fn().mockResolvedValue(undefined);
    const result = await runTicker({
      runtime: makeCounterRuntime(),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-busy',
      namespace: NS,
      init,
      emptyGraceMs: 10,
    });

    // THE WHOLE POINT OF THE PLACEMENT. A lapsed lease makes every connected
    // socket fire a spawn at once; all but one must return 'busy' having done
    // no work at all, not after each compiling a wasm module first.
    expect(result.reason).toBe('busy');
    expect(init).not.toHaveBeenCalled();
  });

  it('releases the lease and spawns nobody when init throws', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-init-boom', NS);
    const spawn = vi.fn().mockResolvedValue(undefined);

    const result = await runTicker({
      runtime: makeCounterRuntime({
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: false }]]), full: false, starves: {} }),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-init-boom',
      namespace: NS,
      init: async () => {
        throw new Error('wasm refused to load');
      },
      spawnSuccessor: spawn,
      emptyGraceMs: 10,
    });

    expect(result.reason).toBe('error');
    // Holding the lease after a failed init locks the room out for the whole
    // TTL on top of an invocation that already failed.
    expect(await redis.get(keys.lease)).toBeNull();
    // And a successor would fail identically, so the pair would spin.
    expect(spawn).not.toHaveBeenCalled();
  });

  // --- TR-2: arrival is not consume ---

  it('reports an input arriving separately from the tick it is consumed on', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-arrive', NS);
    const arrived: { seq: number; atTick: number }[] = [];
    const acked: { pid: string; tick: number }[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        onInputArrived: (state, _pid, input) => {
          arrived.push({ seq: input.seq, atTick: state.tick });
        },
        ackTick: (_state, pid, tick) => {
          acked.push({ pid, tick });
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-arrive',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 11, targetTick: 6, data: 1 } satisfies ClientInput] })
    );
    await resultPromise;

    expect(arrived).toHaveLength(1);
    expect(arrived[0]?.seq).toBe(11);
    expect(acked).toContainEqual({ pid: 'alice', tick: 6 });
    // The gap between the two is the buffering the playout buffer exists to
    // do. A client that measured its round trip from the ack would be reading
    // that gap as network latency, stamping further ahead to compensate, and
    // widening the gap it was trying to correct.
    expect(arrived[0]?.atTick).toBeLessThan(6);
  });

  it('reports arrival for an unstamped input too, so a host has one ack site', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-arrive2', NS);
    const arrived: number[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: false }]]), full: false, starves: {} }),
        onInputArrived: (_state, _pid, input) => arrived.push(input.seq),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-arrive2',
      namespace: NS,
      maxRunMs: 120,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 4, data: 1 } satisfies ClientInput] }));
    await resultPromise;

    expect(arrived).toEqual([4]);
  });

  // --- TR-16: the playout buffer is observable and controllable ---

  it('gives a runtime that returns true from usesPlayout a real buffer', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-uses', NS);
    const bufferedAt: number[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: false }]]), full: false, starves: {} }),
        // The binding a host should actually write: unconditional. The ticker
        // already gates the buffered branch on the record carrying a
        // targetTick, so `true` reproduces "stamped buffered, unstamped
        // immediate" without the simulation tracking anything. Reading back a
        // buffer handle the simulation never assigns returns false forever and
        // silently reverts every stamped input to apply-on-arrival.
        usesPlayout: () => true,
        // The tick the step about to run produces, one above the completed
        // count `state.tick` reads at consume time; see `RoomRuntime.currentTick`.
        applyBufferedInput: (state) => bufferedAt.push(state.tick + 1),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-uses',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: 6, data: 1 } satisfies ClientInput] })
    );
    await resultPromise;

    // Buffered and applied on exactly its stamped tick. Note the toy runtime's
    // own default `usesPlayout` reads `players.get(pid).playout`, which is
    // false for this player: the override is what puts it on the buffered path.
    expect(bufferedAt).toEqual([6]);
  });

  it('reports buffer health on starved ticks, which is when ackTick does not fire', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-health', NS);
    // Paired deliberately rather than counted separately: the claim is not
    // "health is reported" and "starves happen", it is that health is reported
    // ON a starved tick. Hanging it off `ackTick` instead would satisfy the
    // first two and fail this one.
    const seen: { h: number; starved: boolean }[] = [];
    let starvedThisTick = false;

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        onStarve: () => {
          starvedThisTick = true;
        },
        onBufferHealth: (_state, _pid, h) => {
          seen.push({ h, starved: starvedThisTick });
          starvedThisTick = false;
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-health',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    // Three inputs on consecutive ticks, so the buffer genuinely holds more
    // than one entry at once. Their exact ticks do not matter and nothing
    // below depends on the run reaching them: a wall-clock assertion about how
    // many ticks fit in a fixed budget is a machine-load assertion.
    await redis.publish(
      keys.in,
      JSON.stringify({
        t: 'in',
        pid: 'alice',
        w: [
          { seq: 1, targetTick: 30, data: 1 },
          { seq: 2, targetTick: 31, data: 1 },
          { seq: 3, targetTick: 32, data: 1 },
        ] satisfies ClientInput[],
      })
    );
    await resultPromise;

    // WITHOUT THIS HOOK the buffer's depth never leaves the ticker, and a host
    // that carries a health byte on its wire publishes a constant 0 for every
    // player forever. That is not a missing signal, it is a wrong one: 0 means
    // starving, so every client reads a permanent instruction to tick faster
    // and pins at the fast end of its dilation range for the whole session.
    expect(seen.some((e) => e.h >= 3)).toBe(true);
    // The load-bearing half: a real depth, reported on a tick that starved.
    expect(seen.some((e) => e.starved && e.h >= 3)).toBe(true);
  });

  it('lets the runtime stand the starvation backstop down with clearPlayout', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-clear', NS);
    const CLEAR_AFTER = 3;
    let cleared = false;
    let starveCount = 0;
    const healthAfterClear: number[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        onStarve: () => {
          starveCount++;
          // A player leaving the stamped path without sending anything else at
          // all: they dismount, the match ends, they simply stand still. No
          // envelope reports it, so only the simulation can say so. Driven off
          // the starve count rather than a tick number so the test measures
          // the mechanism and not how many ticks fit in a wall-clock budget.
          if (starveCount >= CLEAR_AFTER) cleared = true;
        },
        clearPlayout: () => cleared,
        onBufferHealth: (_state, _pid, h) => {
          if (cleared) healthAfterClear.push(h);
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-clear',
      namespace: NS,
      maxRunMs: 700,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    // A stamp the run will never reach: without a way to stand it down this
    // buffer starves on every remaining tick of the session and the backstop
    // keeps decaying a held input for a player who is not on the stamped path
    // anymore.
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: 39, data: 1 } satisfies ClientInput] })
    );
    await resultPromise;

    // Non-vacuity first: it really did starve, and really did reach the clear.
    expect(starveCount).toBeGreaterThanOrEqual(CLEAR_AFTER);
    // And then stopped. The run is far longer than the handful of ticks it
    // took to get here, so an unbounded count is what a missing clearPlayout
    // looks like.
    expect(starveCount).toBeLessThanOrEqual(CLEAR_AFTER + 1);
    // The LAST thing reported for this player is a 0, and there is exactly
    // one of them: the drop reports the buffer is gone and nothing reports
    // afterwards, so a stale depth is never left pinned on the wire. (The
    // entry before it is the real depth on the tick the clear was decided,
    // since `clearPlayout` is polled at the start of the FOLLOWING tick.)
    expect(healthAfterClear.length).toBeGreaterThan(0);
    expect(healthAfterClear[healthAfterClear.length - 1]).toBe(0);
    expect(healthAfterClear.filter((h) => h === 0)).toHaveLength(1);
  });

  it('forgets the starvation streak when a buffer is dropped, so a later starve starts from one', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-streak', NS);
    const streaks: number[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        onStarve: (_state, _pid, streak) => streaks.push(streak),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-streak',
      namespace: NS,
      maxRunMs: 800,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    // Build a long streak on a buffer that can never be fed...
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: 900, data: 1 } satisfies ClientInput] })
    );
    await new Promise((r) => setTimeout(r, 200));
    const before = streaks.length;
    expect(before).toBeGreaterThanOrEqual(2);
    // ...then supersede it with an unstamped input, which drops the buffer.
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 2, data: 1 } satisfies ClientInput] }));
    await new Promise((r) => setTimeout(r, 20));
    // ...and start a fresh stamped stream.
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 3, targetTick: 900, data: 1 } satisfies ClientInput] })
    );
    await resultPromise;

    // The first starve of the NEW buffer must be streak 1. Carrying the old
    // streak makes the decay backstop fire at full strength on a fresh
    // player's very first starved tick instead of ramping into it.
    expect(streaks[before]).toBe(1);
  });

  it('honours playoutMaxAhead as a refusal distance, protecting what is already buffered', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-ahead', NS);
    const bufferedAt: number[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        // The produced tick, as in the `usesPlayout` case above.
        applyBufferedInput: (state) => bufferedAt.push(state.tick + 1),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-ahead',
      namespace: NS,
      playoutMaxAhead: 4,
      maxRunMs: 500,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    // The near one is inside the window, the other two are not. A SIZE bound
    // with eviction would have let a far one in and thrown out the near one to
    // make room, starving the player on the input they were about to need. A
    // DISTANCE bound with refusal drops the runaway stamp instead.
    //
    // 10 IS THE STAMP THAT MEASURES THE CONFIGURED VALUE, and 400 is not. The
    // buffer's reference is the first push minus one (tick 2), so 400 is 398
    // ticks out and is refused by `PLAYOUT_MAX_AHEAD` (40) just as flatly as
    // by the 4 configured here: with only 3 and 400 driven, constructing the
    // buffer with no argument at all left this case green and the option it
    // is named for pinned by nothing. 10 sits between the two, so it is
    // refused ONLY while `playoutMaxAhead` is the bound actually in force.
    await redis.publish(
      keys.in,
      JSON.stringify({
        t: 'in',
        pid: 'alice',
        w: [
          { seq: 1, targetTick: 3, data: 1 },
          { seq: 2, targetTick: 10, data: 1 },
          { seq: 3, targetTick: 400, data: 1 },
        ] satisfies ClientInput[],
      })
    );
    await resultPromise;

    expect(bufferedAt).toEqual([3]);
  });

  // --- TR-3: metadata follows membership, not the socket ---

  it('keeps a departed player metadata while the simulation still holds them', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-grace', NS);

    // A simulation with a disconnect grace: `leave` starts a countdown, it
    // does not remove the player. This is what every game with a reconnect
    // does, and it is why a socket close is not a departure.
    const graceState = { released: false };
    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        leave: () => {
          /* grace: the player stays in the room until the sim says otherwise */
        },
        presentPids: (state) => (graceState.released ? [] : state.players.keys()),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-grace',
      namespace: NS,
      maxRunMs: 900,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice', meta: { name: 'Alice' } }));
    await new Promise((r) => setTimeout(r, 80));
    expect(await redis.hgetall(keys.meta)).toHaveProperty('alice');

    // A socket blip: a phone changing cell, a lid closing, a routine
    // reconnect. Under leave-time removal this rips Alice's name tag off
    // every other client's screen and puts it back a second later.
    await redis.publish(keys.in, JSON.stringify({ t: 'leave', pid: 'alice' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(await redis.hgetall(keys.meta)).toHaveProperty('alice');

    // Now the simulation itself says the grace expired.
    graceState.released = true;
    await new Promise((r) => setTimeout(r, 120));
    expect(await redis.hgetall(keys.meta)).not.toHaveProperty('alice');

    await resultPromise;
  });

  it('still removes metadata on leave when the runtime reports no membership', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-nograce', NS);

    const resultPromise = runTicker({
      // No `presentPids`: today's behaviour, unchanged, for every runtime that
      // does not opt in.
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-nograce',
      namespace: NS,
      maxRunMs: 500,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'bob', meta: { name: 'Bob' } }));
    await new Promise((r) => setTimeout(r, 80));
    expect(await redis.hgetall(keys.meta)).toHaveProperty('bob');

    await redis.publish(keys.in, JSON.stringify({ t: 'leave', pid: 'bob' }));
    await new Promise((r) => setTimeout(r, 120));
    expect(await redis.hgetall(keys.meta)).not.toHaveProperty('bob');

    await resultPromise;
  });

  // --- TR-5: no envelope disappears in silence ---

  it('routes a custom envelope from publishCustom through to onCustom', async () => {
    const redis = new FakeRedis();
    const seen: { name: string; data: unknown; pid?: string | undefined }[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        onCustom: (_state, name, data, pid) => seen.push({ name, data, pid }),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-custom',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    await publishCustom(redis, 'r-custom', 'force-phase', { phase: 'active' }, { namespace: NS, pid: 'admin' });
    await resultPromise;

    expect(seen).toEqual([{ name: 'force-phase', data: { phase: 'active' }, pid: 'admin' }]);
  });

  // TR-20: THE PUBLISH GAUGES REPORTED THE REASSURING ANSWER. `publishes`,
  // `bytesPublished` and `bytesDelivered` were all incremented OUTSIDE the
  // publish promise, so they counted attempts; only the latency histogram
  // waited for the bus. A room whose every publish was rejected therefore
  // reported a healthy publish rate, bytes climbing at the healthy rate, and
  // (back when an empty window read as zeros) the BEST POSSIBLE latency.
  describe('publish accounting counts what happened, not what was attempted', () => {
    async function statsFrom(opts: { breakPublish: boolean }): Promise<RoomStats[]> {
      const redis = new FakeRedis();
      if (opts.breakPublish) redis.break('publish');
      const stats: RoomStats[] = [];
      await runTicker({
        runtime: makeCounterRuntime({
          tickHz: 50,
          create: () => ({
            tick: 0,
            players: new Map([['p1', { counter: 0, playout: false }]]),
            full: false,
            starves: {},
          }),
        }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: opts.breakPublish ? 'r-pubfail' : 'r-pubok',
        namespace: NS,
        statsMs: 30,
        maxRunMs: 300,
        emptyGraceMs: 100_000,
        onStats: (st) => stats.push(st),
        log: () => {},
      });
      return stats;
    }

    const total = (stats: RoomStats[], field: 'publishes' | 'publishFails' | 'bytesPublished' | 'bytesDelivered'): number =>
      stats.reduce((n, s) => n + s[field], 0);

    it('CONTROL: a healthy room counts its publishes and its bytes', async () => {
      const stats = await statsFrom({ breakPublish: false });
      expect(total(stats, 'publishes')).toBeGreaterThan(0);
      expect(total(stats, 'publishFails')).toBe(0);
      expect(total(stats, 'bytesPublished')).toBeGreaterThan(0);
      expect(total(stats, 'bytesDelivered')).toBeGreaterThan(0);
      // One player in the room, so delivered equals published exactly.
      expect(total(stats, 'bytesDelivered')).toBe(total(stats, 'bytesPublished'));
    });

    it('a room whose every publish is REJECTED reports zero publishes, zero bytes, and a failure count', async () => {
      const stats = await statsFrom({ breakPublish: true });
      expect(total(stats, 'publishes')).toBe(0);
      expect(total(stats, 'publishFails')).toBeGreaterThan(0);
      // Bytes that never left the process are not bandwidth.
      expect(total(stats, 'bytesPublished')).toBe(0);
      expect(total(stats, 'bytesDelivered')).toBe(0);
    });

    it('publishAwait is null on a dead bus, never the best latency in the fleet', async () => {
      // The histogram is only pushed on a CONFIRMED publish, so a failing
      // room's window is empty. An empty window used to read
      // `{ p50: 0, p95: 0, max: 0 }`, which for a latency distribution is the
      // healthiest possible reading for the sickest possible state.
      const stats = await statsFrom({ breakPublish: true });
      expect(stats.length).toBeGreaterThan(0);
      for (const s of stats) expect(s.publishAwait).toBeNull();

      const healthy = await statsFrom({ breakPublish: false });
      expect(healthy.some((s) => s.publishAwait !== null)).toBe(true);
    });

    it('a failing room and a healthy one are distinguishable from RoomStats alone', async () => {
      // The whole point. Everything else about the two runs reads the same:
      // the tick rate, the player count, the uptime and the starve, drop and
      // renew counters are all identical, because a publish that fails costs
      // no bytes, produces no latency sample and does not disturb the loop.
      const healthy = await statsFrom({ breakPublish: false });
      const failing = await statsFrom({ breakPublish: true });
      const shape = (stats: RoomStats[]): { published: boolean; failed: boolean; await0: boolean } => ({
        published: total(stats, 'publishes') > 0,
        failed: total(stats, 'publishFails') > 0,
        await0: stats.every((s) => s.publishAwait === null),
      });
      expect(shape(healthy)).toEqual({ published: true, failed: false, await0: false });
      expect(shape(failing)).toEqual({ published: false, failed: true, await0: true });
    });
  });

  // TR-21: a checkpoint this build cannot understand must START FRESH, and
  // must SAY SO. "There was nothing there" and "there was something written
  // by a version this build does not implement" produce the identical fresh
  // room and are completely different events.
  describe('a checkpoint from an unknown version starts fresh, audibly', () => {
    async function runOver(stateJson: string | null, room: string): Promise<{ logs: LogEvent[]; tick: number }> {
      const redis = new FakeRedis();
      const keys = roomKeys(room, NS);
      if (stateJson !== null) await redis.set(keys.state, stateJson);
      const logs: LogEvent[] = [];
      let observed = -1;
      await runTicker({
        runtime: makeCounterRuntime({ tickHz: 50 }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: room,
        namespace: NS,
        statsMs: 30,
        maxRunMs: 120,
        emptyGraceMs: 100_000,
        onStats: (s) => {
          if (observed === -1) observed = s.tick;
        },
        log: (ev) => logs.push(ev),
      });
      return { logs, tick: observed };
    }

    const body = JSON.stringify({ tick: 5000, players: [], full: false });

    it('CONTROL: the current version restores, so the refusal below is not a blanket start-fresh', async () => {
      const env: CheckpointEnvelope = { v: 1, tick: 5000, graceUntilTick: 0, incarnation: 'inc', body };
      const { logs, tick } = await runOver(JSON.stringify(env), 'r-cpv-ok');
      expect(tick).toBeGreaterThan(5000);
      expect(logs.filter((l) => l.kind === 'ticker.checkpoint-refused')).toHaveLength(0);
    });

    it('a FUTURE version is refused, the room starts from zero, and the log names the version', async () => {
      const env = { v: 2, tick: 5000, graceUntilTick: 0, incarnation: 'inc', body };
      const { logs, tick } = await runOver(JSON.stringify(env), 'r-cpv-new');
      expect(tick).toBeLessThan(100); // fresh, not continuing from 5000
      const refused = logs.filter((l) => l.kind === 'ticker.checkpoint-refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]?.meta).toMatchObject({ reason: 'version', foundVersion: 2, expectedVersion: 1 });
    });

    it('a PAST version is refused too, which is the direction that would otherwise parse cleanly', async () => {
      const env = { v: 0, tick: 5000, graceUntilTick: 0, incarnation: 'inc', body };
      const { logs, tick } = await runOver(JSON.stringify(env), 'r-cpv-old');
      expect(tick).toBeLessThan(100);
      expect(logs.filter((l) => l.kind === 'ticker.checkpoint-refused')[0]?.meta).toMatchObject({
        reason: 'version',
        foundVersion: 0,
      });
    });

    it('an ordinary cold room says NOTHING, so the refusal above is a signal and not noise', async () => {
      const { logs } = await runOver(null, 'r-cpv-cold');
      expect(logs.filter((l) => l.kind === 'ticker.checkpoint-refused')).toHaveLength(0);
    });
  });

  it('counts and summarises an envelope type it has no branch for', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-unknown', NS);
    const stats: RoomStats[] = [];
    const logs: LogEvent[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-unknown',
      namespace: NS,
      statsMs: 30,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: (ev) => logs.push(ev),
    });

    await new Promise((r) => setTimeout(r, 10));
    // A producer deployed ahead of its consumer, which is what this almost
    // always is in practice. Before the default branch existed this vanished
    // without a trace, and a Redis outage, a subscribe that never landed and a
    // producer that was never deployed all look exactly the same from outside.
    await redis.publish(keys.in, JSON.stringify({ t: 'force-activity', id: 'park-pitch', active: 120 }));
    await redis.publish(keys.in, JSON.stringify({ t: 'force-activity', id: 'park-pitch', active: 60 }));
    await resultPromise;

    const totalUnknown = stats.reduce((n, s) => n + s.unknownEnvelopes, 0);
    expect(totalUnknown).toBe(2);
    // Kept apart from `badEnvelopes`: a bad envelope is a broken sender, an
    // unknown one is a deploy skew, and folding them together is what made the
    // original failure invisible.
    expect(stats.reduce((n, s) => n + s.badEnvelopes, 0)).toBe(0);

    const summaries = logs.filter((l) => l.kind === 'ticker.unknown-envelope');
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0]?.meta?.lastType).toBe('force-activity');
    // COUNTED, NOT LOGGED PER MESSAGE: `t` arrives on a channel client traffic
    // reaches, so one line per message is a log amplifier. One summary per
    // stats flush is a cadence nothing on the wire can drive.
    expect(summaries.length).toBeLessThan(2 + stats.length);
  });

  it('truncates an unrecognised envelope type before it reaches a log line', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-unknown-long', NS);
    const logs: LogEvent[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-unknown-long',
      namespace: NS,
      statsMs: 30,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'x'.repeat(5000) }));
    await resultPromise;

    const summary = logs.find((l) => l.kind === 'ticker.unknown-envelope');
    expect(summary).toBeDefined();
    expect(String(summary?.meta?.lastType).length).toBeLessThanOrEqual(32);
  });

  // --- TR-13: a geometry mismatch need not cost the whole room ---

  it('lets a host partially restore across a geometry change, keeping the incarnation', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-partial', NS);
    const runtime = makeCounterRuntime();
    await redis.set(
      keys.state,
      JSON.stringify({
        v: 1,
        tick: 700,
        graceUntilTick: 0,
        geom: 'old-geometry',
        incarnation: 'inc-partial',
        body: runtime.serialize({
          tick: 700,
          players: new Map([['alice', { counter: 42, playout: false }]]),
          full: false,
          starves: {},
        }),
      })
    );

    let firstTick = -1;
    let firstCounter = -1;
    const result = await runTicker({
      runtime: makeCounterRuntime({
        tick: (state) => {
          if (firstTick === -1) {
            firstTick = state.tick;
            firstCounter = state.players.get('alice')?.counter ?? -1;
          }
          state.tick += 1;
          return {};
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-partial',
      namespace: NS,
      geomKey: () => 'new-geometry',
      // Scores and the tick count survive a map change perfectly well; only
      // what depends on the geometry has to be rebuilt. The difference between
      // "the map reloaded" and "every room in the fleet was wiped".
      onGeomMismatch: (envelope) => {
        const body = JSON.parse(envelope.body) as {
          tick: number;
          players: [string, { counter: number; playout: boolean }][];
        };
        return { tick: body.tick, players: new Map(body.players), full: false, starves: {} };
      },
      maxRunMs: 40,
      emptyGraceMs: 1_000_000,
    });

    expect(firstTick).toBe(700);
    expect(firstCounter).toBe(42);
    expect(result.reason).toBe('duration');
    // A partial restore CONTINUES the same room, so an idempotency key derived
    // from the incarnation must not move or a replayed event pays twice.
    const persisted = unpackCheckpoint(await readCheckpoint(redis, keys.state));
    expect(persisted?.incarnation).toBe('inc-partial');
  });

  it('falls back to a full reset when the mismatch handler declines or throws', async () => {
    async function run(handler: (env: CheckpointEnvelope) => CounterState | null, roomId: string): Promise<number> {
      const redis = new FakeRedis();
      const keys = roomKeys(roomId, NS);
      const runtime = makeCounterRuntime();
      await redis.set(
        keys.state,
        JSON.stringify({
          v: 1,
          tick: 800,
          graceUntilTick: 0,
          geom: 'old-geometry',
          incarnation: 'inc-x',
          body: runtime.serialize({ tick: 800, players: new Map(), full: false, starves: {} }),
        })
      );
      let firstTick = -1;
      await runTicker({
        runtime: makeCounterRuntime({
          tick: (state) => {
            if (firstTick === -1) firstTick = state.tick;
            state.tick += 1;
            return {};
          },
        }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId,
        namespace: NS,
        geomKey: () => 'new-geometry',
        onGeomMismatch: handler,
        emptyGraceMs: 10,
      });
      return firstTick;
    }

    expect(await run(() => null, 'r-decline')).toBe(0);
    // A partial restore that threw IS a corrupt room, and the fresh start is
    // already the correct handling for one, so it falls through to it rather
    // than inventing a second path.
    expect(
      await run(() => {
        throw new Error('cannot rebuild');
      }, 'r-throw')
    ).toBe(0);
  });

  // --- TR-8: host-supplied stats labels ---

  it('carries host labels through to the stats gauge without reading them', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-labels', NS);

    await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-labels',
      namespace: NS,
      statsMs: 20,
      statsLabels: { world: 'park', region: 'iad1' },
      maxRunMs: 120,
      emptyGraceMs: 100_000,
    });

    // Read the gauge the way a scraper would, rather than only through the
    // callback: the labels have to survive the JSON round trip into Redis.
    const raw = await redis.get(keys.stats);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as RoomStats;
    expect(parsed.labels).toEqual({ world: 'park', region: 'iad1' });
  });

  it('omits labels entirely when a host supplies none', async () => {
    const redis = new FakeRedis();
    const stats: RoomStats[] = [];
    await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-nolabels',
      namespace: NS,
      statsMs: 20,
      maxRunMs: 100,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
    });
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0]?.labels).toBeUndefined();
  });
});

// TR-4, ticker half. The relay's `metaSeedPayload` shapes the roster frame a
// joining socket is SEEDED with; this shapes the roster frame every socket is
// BROADCAST on a change. Both are client-visible wire shapes with no version
// byte, so a host cannot force already-loaded bundles onto a new one, and a
// client that early-returns on a shape it does not recognise loses its whole
// roster SILENTLY: no names, no presence count, no join or leave events, and
// nothing that fails anywhere.
describe('runTicker: metaPayload', () => {
  /**
   * Runs a ticker long enough for one join to be broadcast, and returns every
   * raw metaout message a subscriber saw. Raw, not parsed: `JSON.stringify`
   * can produce `undefined`, and the suppression case below is precisely
   * about that value never reaching `publish`, which a parsed view cannot
   * see.
   */
  async function metaRun(overrides: Record<string, unknown> = {}) {
    const redis = new FakeRedis();
    const keys = roomKeys('r-metafmt', NS);
    const seen: string[] = [];
    const listener = redis.fork();
    listener.on('message', (_ch: unknown, msg: unknown) => {
      if (typeof msg === 'string') seen.push(msg);
    });
    await listener.subscribe(keys.metaout);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-metafmt',
      namespace: NS,
      maxRunMs: 300,
      emptyGraceMs: 100_000,
      ...overrides,
    });
    await new Promise((r) => setTimeout(r, 20));
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice', meta: { name: 'Alice' } }));
    const result = await resultPromise;
    return { raw: seen, result };
  }

  it('defaults to the shipped { t: meta, map } shape', async () => {
    const { raw } = await metaRun();
    const rosters = raw.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f.t === 'meta');
    expect(rosters.length).toBeGreaterThan(0);
    const last = rosters[rosters.length - 1] as { map: Record<string, unknown> };
    expect(last.map).toEqual({ alice: { name: 'Alice' } });
  });

  it('lets a host keep a differently shaped roster frame', async () => {
    // Standing in for a host whose shipped client does
    // `if (m.t !== 'meta' || !Array.isArray(m.players)) return;`, which under
    // the default shape blanks every name tag with nothing to see anywhere.
    const { raw } = await metaRun({
      metaPayload: (map: Record<string, unknown>) => ({
        t: 'meta',
        players: Object.entries(map).map(([pid, v]) => ({ pid, ...(v as Record<string, unknown>) })),
      }),
    });
    const rosters = raw
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((f) => f.t === 'meta' && Array.isArray(f.players));
    expect(rosters.length).toBeGreaterThan(0);
    const last = rosters[rosters.length - 1] as Record<string, unknown>;
    expect(last.players).toEqual([{ pid: 'alice', name: 'Alice' }]);
    expect(last).not.toHaveProperty('map');
  });

  it('a formatter returning undefined suppresses the broadcast instead of publishing "undefined"', async () => {
    const { raw } = await metaRun({ metaPayload: () => undefined });
    // The room-reject frame shares this channel, so assert on the absence of
    // a roster rather than on an empty channel.
    expect(raw).not.toContain('undefined');
    expect(raw).toHaveLength(0);
  });

  it('a formatter that throws is reported and never reaches the channel, and the room survives it', async () => {
    // This is the one meta site that runs inside the tick loop. An uncaught
    // throw here would unwind the loop and take the whole room down, so the
    // surviving `reason` matters as much as the missing frame.
    const log = vi.fn();
    const { raw, result } = await metaRun({
      log,
      metaPayload: () => {
        throw new Error('bad formatter');
      },
    });
    expect(raw).toHaveLength(0);
    expect(log.mock.calls.filter((c) => (c[0] as LogEvent)?.kind === 'ticker.meta-payload-threw').length).toBeGreaterThan(0);
    expect(result.reason).toBe('duration');
    expect(result.ticks).toBeGreaterThan(0);
  });

  it('logs a throwing formatter once per roster change, not once per tick', async () => {
    // `metaDirty` is cleared before the publish is attempted, so a broken
    // formatter must not re-fire on every one of the ~15 ticks this run
    // covers after the join. A retry-until-it-works flag here would be a
    // 20Hz log amplifier.
    const log = vi.fn();
    await metaRun({
      log,
      metaPayload: () => {
        throw new Error('bad formatter');
      },
    });
    const threw = log.mock.calls.filter((c) => (c[0] as LogEvent)?.kind === 'ticker.meta-payload-threw');
    // One for the dirty-on-start flush, one for the join. Never per tick.
    expect(threw.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// The fakes the sections below need, each one standing in for a failure a
// plain in-memory Redis cannot produce: a bus that is slow rather than broken,
// a read that fails once rather than forever, a subscriber whose TCP path is
// black-holed. Every one of these reproduces a measured incident.
// ---------------------------------------------------------------------------

/** Delays one channel's `publish` so several can be in flight at once, which is what the publish bound exists to bound. */
class SlowPublishRedis extends FakeRedis {
  constructor(
    private readonly slowChannel: string,
    private readonly delayMs: number
  ) {
    super();
  }

  override async publish(channel: string, message: string | Buffer): Promise<number> {
    if (channel === this.slowChannel) await new Promise((r) => setTimeout(r, this.delayMs));
    return super.publish(channel, message);
  }
}

/** Rejects the first `failures` publishes on one channel, then behaves. */
class FlakyPublishRedis extends FakeRedis {
  failuresLeft: number;

  constructor(
    private readonly flakyChannel: string,
    failures: number
  ) {
    super();
    this.failuresLeft = failures;
  }

  override async publish(channel: string, message: string | Buffer): Promise<number> {
    if (channel === this.flakyChannel && this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('metaout is down');
    }
    return super.publish(channel, message);
  }
}

/** Throws out of the first `failures` checkpoint reads. */
class FlakyReadRedis extends FakeRedis {
  failuresLeft: number;

  constructor(failures: number) {
    super();
    this.failuresLeft = failures;
  }

  override async getBuffer(key: string): Promise<Buffer | null> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('read is down');
    }
    return super.getBuffer(key);
  }
}

/**
 * Runs every script IMMEDIATELY and holds the reply back, which is the whole
 * point: Redis extended the key when it PROCESSED the command, and the reply
 * arrives a round trip later. A fake that delayed the processing too would
 * model a different machine and could not show the difference between the two
 * times at all.
 */
class SlowReplyRedis extends FakeRedis {
  constructor(private readonly replyDelayMs: number) {
    super();
  }

  override async eval(script: string, numKeys: number, ...args: (string | number | Buffer)[]): Promise<unknown> {
    const reply = await super.eval(script, numKeys, ...args);
    await new Promise((r) => setTimeout(r, this.replyDelayMs));
    return reply;
  }
}

/** Counts every script issued, so a timer nobody holds a handle to any more can be caught still renewing after `runTicker` has returned. */
class CountingEvalRedis extends FakeRedis {
  evals = 0;

  override async eval(script: string, numKeys: number, ...args: (string | number | Buffer)[]): Promise<unknown> {
    this.evals++;
    return super.eval(script, numKeys, ...args);
  }
}

/** Rejects every publish on the input channel, so this ticker's own probes never leave the process while a neighbour's still arrive. */
class NoProbeOutRedis extends FakeRedis {
  constructor(private readonly inChannel: string) {
    super();
  }

  override async publish(channel: string, message: string | Buffer): Promise<number> {
    if (channel === this.inChannel) throw new Error('probe publish is down');
    return super.publish(channel, message);
  }
}

/**
 * A subscriber whose subscribe succeeds and which then delivers NOTHING. The
 * shape of a black-holed TCP path, and the reason it needed its own fake: a
 * broken connection produces an error to observe, and this produces nothing at
 * all, which is exactly what made it invisible.
 */
function blackHoleSubscriber(): Subscriber {
  return {
    on: () => {},
    subscribe: async () => 1,
    disconnect: () => {},
  } as unknown as Subscriber;
}

/** A subscriber whose subscribe hangs forever, which is what ioredis does with `maxRetriesPerRequest: null` behind a dead connection. */
function hangingSubscriber(): Subscriber {
  return {
    on: () => {},
    subscribe: () => new Promise<unknown>(() => {}),
    disconnect: () => {},
  } as unknown as Subscriber;
}

/** A subscriber that emits ioredis-style 'error' events on a timer, so the throttle has something to throttle. */
function noisySubscriber(everyMs: number): { sub: Subscriber; stop: () => void } {
  const listeners: ((err: unknown) => void)[] = [];
  const timer = setInterval(() => {
    for (const cb of listeners) cb(new Error('ECONNRESET'));
  }, everyMs);
  const sub = {
    on: (ev: string, cb: (err: unknown) => void) => {
      if (ev === 'error') listeners.push(cb);
    },
    subscribe: async () => 1,
    disconnect: () => clearInterval(timer),
  } as unknown as Subscriber;
  return { sub, stop: () => clearInterval(timer) };
}

const withAlice = (): CounterState => ({
  tick: 0,
  players: new Map([['alice', { counter: 0, playout: false }]]),
  full: false,
  starves: {},
});

/**
 * TR-A19. `HostTickerOptions` exists so an adapter can spread a host's options
 * into `runTicker` without copying every field by hand, which is the same
 * half-a-paired-seam failure `metaPayload` was: an option that lands in
 * `TickerOptions` and never reaches a route is an option nobody can use. A
 * compile-time assertion, because the failure is a compile-time one.
 */
describe('HostTickerOptions', () => {
  it('carries every host-owned option and none of the four an adapter owns', () => {
    const hostOpts: HostTickerOptions<CounterState, CounterEvent> = {
      runtime: makeCounterRuntime(),
      namespace: NS,
      statsMs: 30,
      presenceTimeoutMs: 4000,
      standbyMs: 500,
      standbyLeadMs: 200,
      leaseTtlMs: 50,
    };
    // @ts-expect-error the adapter owns `roomId`, so it must not be reachable here
    hostOpts.roomId = 'r';
    // @ts-expect-error and `redis` likewise
    hostOpts.redis = null;
    expect(hostOpts.standbyMs).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// TR-A2: NOTHING A HOST HOOK DOES MAY TAKE THE ROOM DOWN.
// ---------------------------------------------------------------------------
describe('runTicker: the host-call guard', () => {
  it('survives an applyInput that throws on a client-supplied payload, and counts it', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-guard', NS);
    const stats: RoomStats[] = [];
    const logs: LogEvent[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        applyInput: (_state, _pid, input) => {
          if (input.data === null) throw new Error('cannot read properties of null');
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-guard',
      namespace: NS,
      statsMs: 40,
      maxRunMs: 300,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: (ev) => logs.push(ev),
    });

    await new Promise((r) => setTimeout(r, 10));
    // The exact payload the README's own decodeInput produces from an empty
    // frame, and the one that used to end the room 82ms in.
    for (let i = 0; i < 5; i++) {
      await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: i, data: null }] }));
    }
    const result = await resultPromise;

    // The room ran to its lifetime cap rather than exiting 'error'.
    expect(result.reason).toBe('duration');
    expect(stats.reduce((n, s) => n + s.hostErrors, 0)).toBe(5);
    // COUNTED, NOT LOGGED PER ENVELOPE: five inputs used to produce five warn
    // lines on a path a client's send rate drives.
    expect(logs.filter((l) => l.kind === 'ticker.envelope-threw')).toHaveLength(0);
    const summaries = logs.filter((l) => l.kind === 'ticker.host-errors');
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.length).toBeLessThanOrEqual(stats.length);
    expect(String(summaries[0]?.meta?.last)).toContain('cannot read properties of null');
  });

  it('catches a REJECTED promise from an async hook, which would otherwise kill the process', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-async-hook', NS);
    const stats: RoomStats[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const resultPromise = runTicker({
        runtime: makeCounterRuntime({
          tickHz: 50,
          create: withAlice,
          // `RoomRuntime` declares this `void`, and an async function
          // satisfies a void return perfectly, so this type-checks, runs, and
          // hands back a promise the loop would otherwise drop on the floor.
          applyInput: (() => Promise.reject(new Error('async hook blew up'))) as unknown as RoomRuntime<
            CounterState,
            CounterEvent
          >['applyInput'],
        }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r-async-hook',
        namespace: NS,
        statsMs: 40,
        maxRunMs: 250,
        emptyGraceMs: 100_000,
        onStats: (s) => stats.push(s),
        log: () => {},
      });

      await new Promise((r) => setTimeout(r, 10));
      await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, data: 1 }] }));
      const result = await resultPromise;
      // Let any rejection that escaped reach the process handler.
      await new Promise((r) => setTimeout(r, 20));

      expect(result.reason).toBe('duration');
      expect(unhandled).toHaveLength(0);
      expect(stats.reduce((n, s) => n + s.hostErrors, 0)).toBeGreaterThan(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a throwing record costs ONE record, not the rest of the redundancy window', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-window', NS);
    const applied: number[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        applyInput: (_state, _pid, input) => {
          if (input.seq === 2) throw new Error('bad record');
          applied.push(input.seq);
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-window',
      namespace: NS,
      maxRunMs: 200,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    // An input packet carries the last few inputs as redundancy. Abandoning
    // the window on the first failure discards exactly the re-sends that exist
    // to survive a failure.
    await redis.publish(
      keys.in,
      JSON.stringify({
        t: 'in',
        pid: 'alice',
        w: [
          { seq: 1, data: 1 },
          { seq: 2, data: 1 },
          { seq: 3, data: 1 },
          { seq: 4, data: 1 },
        ],
      })
    );
    await resultPromise;

    expect(applied).toEqual([1, 3, 4]);
  });

  it('counts a non-object record on badEnvelopes and keeps the rest of the window', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-badrecord', NS);
    const stats: RoomStats[] = [];
    const applied: number[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        applyInput: (_state, _pid, input) => applied.push(input.seq),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-badrecord',
      namespace: NS,
      statsMs: 40,
      maxRunMs: 250,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [null, 7, { seq: 9, data: 1 }] }));
    await resultPromise;

    expect(applied).toEqual([9]);
    expect(stats.reduce((n, s) => n + s.badEnvelopes, 0)).toBe(2);
    // A broken SENDER, not a broken simulation: the two counters stay apart.
    expect(stats.reduce((n, s) => n + s.hostErrors, 0)).toBe(0);
  });

  it('refuses an in envelope whose w is not an array at the subscriber', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-now', NS);
    const stats: RoomStats[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-now',
      namespace: NS,
      statsMs: 40,
      maxRunMs: 250,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: 'not an array' }));
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice' }));
    const result = await resultPromise;

    expect(result.reason).toBe('duration');
    expect(stats.reduce((n, s) => n + s.badEnvelopes, 0)).toBe(2);
    // Dropped at the door, so nothing reached the inbox to be misread as a
    // type this ticker has no branch for.
    expect(stats.reduce((n, s) => n + s.unknownEnvelopes, 0)).toBe(0);
  });

  it('survives a throwing applyBufferedInput on the CONSUME pass, which had no guard at all', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-consume-guard', NS);
    const stats: RoomStats[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        applyBufferedInput: () => {
          throw new Error('bad stamped payload');
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-consume-guard',
      namespace: NS,
      statsMs: 40,
      maxRunMs: 300,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: 4, data: 1 } satisfies ClientInput] })
    );
    const result = await resultPromise;

    // The drain site's catch cannot see this one: it fires a whole phase later,
    // from the playout pass, which used to be entirely unguarded.
    expect(result.reason).toBe('duration');
    expect(stats.reduce((n, s) => n + s.hostErrors, 0)).toBeGreaterThan(0);
  });

  it('a throwing onEvents is counted and NAMED, never logged once per tick', async () => {
    // `onEvents` fires on every tick that emitted one, which for most hosts is
    // every tick, so a per-call log line is the same amplifier the envelope
    // path already had: measured at 41 lines for 41 ticks. The rule is that a
    // per-call line survives only where the rate is not a tick, which leaves
    // `onStats` (once per flush) and `metaPayload` (once per roster change).
    const redis = new FakeRedis();
    const stats: RoomStats[] = [];
    const logs: LogEvent[] = [];

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-onevents',
      namespace: NS,
      statsMs: 100,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      onEvents: () => {
        throw new Error('host event handler blew up');
      },
      onStats: (st) => stats.push(st),
      log: (ev) => logs.push(ev),
    });

    expect(result.reason).toBe('duration');
    // Roughly twenty ticks, every one of them throwing.
    expect(stats.reduce((n, st) => n + st.hostErrors, 0)).toBeGreaterThan(10);
    expect(logs.filter((l) => l.kind === 'ticker.onEvents-threw')).toHaveLength(0);
    const summaries = logs.filter((l) => l.kind === 'ticker.host-errors');
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.length).toBeLessThanOrEqual(stats.length + 1);
    // NAMED, because a count on its own tells an operator there is a bug and
    // not which hook it is in.
    expect(summaries[0]?.meta?.hook).toBe('onEvents');
  });

  it('names the hook that threw, whichever one it was', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-hookname', NS);
    const logs: LogEvent[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        applyInput: () => {
          throw new Error('bad input');
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-hookname',
      namespace: NS,
      statsMs: 60,
      maxRunMs: 300,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, data: 1 }] }));
    await resultPromise;

    expect(logs.find((l) => l.kind === 'ticker.host-errors')?.meta).toMatchObject({ hook: 'applyInput', count: 1 });
  });

  it('a throwing presentPids prunes nobody rather than emptying the whole roster', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-presentpids-throw', NS);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        presentPids: () => {
          throw new Error('membership unavailable');
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-presentpids-throw',
      namespace: NS,
      maxRunMs: 300,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice', meta: { name: 'Alice' } }));
    await new Promise((r) => setTimeout(r, 80));
    // A membership the host could not report is not a membership of nobody.
    expect(await redis.hgetall(keys.meta)).toHaveProperty('alice');
    await resultPromise;
  });
});

// ---------------------------------------------------------------------------
// TR-A3: THE TIMELINE THE CLIENT PLAYS BACK ON.
// ---------------------------------------------------------------------------
describe('runTicker: the snapshot timeline', () => {
  // THE RUN ENDS ON THE SAMPLE COUNT, NOT ON A WALL-CLOCK WINDOW, in this
  // case and the resync below. Both used to run for a fixed `maxRunMs` and
  // then assert a FLOOR on how many snapshots that produced, which is a
  // measurement of how many ticks the host fitted into the window: on a loaded
  // machine the loop paces itself slower (it resyncs the grid rather than
  // bursting), the count falls, and the floor reddens for a reason that has
  // nothing to do with the grid arithmetic under test. Reporting the room
  // empty once enough samples are in hand ends the run at the same SAMPLE
  // COUNT on any machine, quick on a quiet one and longer on a loaded one,
  // and leaves every assertion exactly as tight as it was. `maxRunMs` stays
  // as a ceiling that must not be the exit.
  const GRID_SAMPLES = 8; // what the old 400ms window produced on a quiet machine

  it('stamps the snapshot with the scheduled grid time, not a clock read after the tick', async () => {
    const redis = new FakeRedis();
    const stamps: number[] = [];
    let n = 0;

    await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 20, // 50ms grid, comfortably above the busy-waits below
        create: withAlice,
        playerCount: (state) => (n >= GRID_SAMPLES ? 0 : state.players.size),
        tick: (state) => {
          // A simulation whose step time VARIES, which every real one does.
          // Stamped from a post-tick clock read, this variance is written
          // straight into the playback axis: measured, a 3ms/28ms alternating
          // tick rendered a constant-velocity entity at 0.5x to 2.2x.
          const busyUntil = Date.now() + (state.tick % 2 === 0 ? 2 : 25);
          while (Date.now() < busyUntil) {
            /* deliberate synchronous work */
          }
          state.tick += 1;
          return {};
        },
        encodeSnapshot: (_state, serverTimeMs) => {
          stamps.push(serverTimeMs);
          n++;
          return 'x';
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-grid',
      namespace: NS,
      maxRunMs: 4000, // a ceiling, not the exit: the sample count above ends the run
      emptyGraceMs: 0,
      log: () => {},
    });

    expect(n).toBeGreaterThan(3);
    const gaps = stamps.slice(1).map((t, i) => t - (stamps[i] as number));
    // EXACTLY one tick apart, every time. This is arithmetic on the grid
    // rather than a measurement of the machine, which is the whole point: the
    // axis a client interpolates on must not carry this process's jitter.
    expect(gaps.every((g) => g === 50)).toBe(true);
  });

  it('a stall resyncs to a FULL tick later and sleeps to it, instead of firing two snapshots back to back', async () => {
    const redis = new FakeRedis();
    const seen: { stamp: number; at: number }[] = [];
    let stalled = false;
    const RESYNC_SAMPLES = 10; // what the old 700ms window produced on a quiet machine

    await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 20,
        create: withAlice,
        playerCount: (state) => (seen.length >= RESYNC_SAMPLES ? 0 : state.players.size),
        tick: (state) => {
          state.tick += 1;
          if (state.tick === 4 && !stalled) {
            stalled = true;
            const until = Date.now() + 220; // four ticks' worth of GC pause
            while (Date.now() < until) {
              /* the stall this resync exists for */
            }
          }
          return {};
        },
        encodeSnapshot: (_state, serverTimeMs) => {
          seen.push({ stamp: serverTimeMs, at: Date.now() });
          return 'x';
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-resync',
      namespace: NS,
      maxRunMs: 4000, // a ceiling, not the exit: the sample count above ends the run
      emptyGraceMs: 0,
      log: () => {},
    });

    expect(stalled).toBe(true);
    expect(seen.length).toBeGreaterThan(5);
    for (let i = 1; i < seen.length; i++) {
      const prev = seen[i - 1] as { stamp: number; at: number };
      const cur = seen[i] as { stamp: number; at: number };
      // STRICTLY MONOTONIC ACROSS THE RESYNC. The resync only ever moves the
      // grid forward, so a client's playback axis never steps backwards.
      expect(cur.stamp).toBeGreaterThan(prev.stamp);
      // AND A FULL TICK OF REAL TIME PASSED. The old resync set the grid to
      // `now` and fell through with no sleep, so the next iteration ran back
      // to back with this one: two snapshots with consecutive ticks and a
      // serverTime gap of 0 to 1ms, which the client's interpolator turns
      // into a 5000 unit-per-second extrapolation burst.
      expect(cur.at - prev.at).toBeGreaterThan(25);
    }
  });
});

// ---------------------------------------------------------------------------
// TR-A23: EVERY PRE-LOOP EXIT RUNS THE SAME TEARDOWN AS THE LOOP'S OWN.
// ---------------------------------------------------------------------------
describe('runTicker: teardown on a pre-loop exit', () => {
  it('closes the subscriber, disposes the room and detaches the bus listener when the lease goes during setup', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-setup-teardown', NS);
    let live = 0;
    let disposed = 0;

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        dispose: () => {
          disposed++;
        },
      }),
      redis,
      createSubscriber: () => {
        live++;
        const sub = redis.fork();
        const realDisconnect = sub.disconnect.bind(sub);
        sub.disconnect = (): void => {
          live--;
          realDisconnect();
        };
        return sub;
      },
      roomId: 'r-setup-teardown',
      namespace: NS,
      init: () => new Promise((r) => setTimeout(r, 200)),
      leaseTtlMs: 60,
      leaseRenewMs: 20,
      maxRunMs: 2000,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 40));
    await redis.set(keys.lease, 'a-thief', 'PX', 5000);
    const result = await resultPromise;

    expect(result.reason).toBe('lease-lost');
    // THIS EXIT USED TO RETURN ON ITS OWN, past the loop's `finally`, and
    // leaked exactly what that block exists to release: one live Redis
    // subscriber per abandoned run against a plan whose connection ceiling is
    // the first wall this design hits, and a host's wasm instance or worker
    // never disposed. Measured at one subscriber still attached, dispose 0.
    expect(live).toBe(0);
    expect(disposed).toBe(1);
    // And the listener on the PROCESS-SINGLETON command client goes too.
    expect(redis.listenerCount('reconnecting')).toBe(0);
  });

  it('leaves no bus listener behind on an ordinary run either', async () => {
    const redis = new FakeRedis();
    // Five runs on one shared client is the ordinary shape for a host serving
    // several rooms from one instance. A listener per run retains that run's
    // whole scope (its state, its maps, its buffers) for the life of the
    // process.
    for (let i = 0; i < 5; i++) {
      await runTicker({
        runtime: makeCounterRuntime({ tickHz: 50 }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: `r-listener-${i}`,
        namespace: NS,
        maxRunMs: 200,
        emptyGraceMs: 20,
        log: () => {},
      });
    }
    expect(redis.listenerCount('reconnecting')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TR-A24: CHECKPOINTS REACH REDIS IN TICK ORDER, NOT IN GZIP ORDER.
// ---------------------------------------------------------------------------
describe('runTicker: checkpoint write ordering', () => {
  it('a slow-compressing write cannot land after a newer one', async () => {
    // `writeCheckpoint` compresses BEFORE it issues its SET, and gzip time
    // scales with the body, so two writes started in tick order arrive in
    // COMPRESSION order. Forced with an 8MB body: the older write won and the
    // successor restored tick 1.
    //
    // Two PERIODIC writes, deliberately, rather than a periodic against the
    // final one: the final write is followed immediately by the release, so a
    // straggler arriving after it is refused by the owner check anyway (see
    // `ticker.checkpoint-refused-not-owner`). While the ticker still owns the
    // room nothing refuses anything, and the store simply keeps whichever
    // deflate finished last.
    const keys = roomKeys('r-cp-order', NS);
    const storedTicks: number[] = [];
    class StaggeredSetRedis extends FakeRedis {
      private writes = 0;

      override async eval(script: string, numKeys: number, ...args: (string | number | Buffer)[]): Promise<unknown> {
        if (script.includes('KEYS[2]') && String(args[0]) === keys.state) {
          this.writes++;
          // The first write is a slow deflate; every later one is quick.
          if (this.writes === 1) await new Promise((r) => setTimeout(r, 300));
          const body = args[2];
          const json = decodeCheckpoint(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
          const env = unpackCheckpoint(json);
          if (env !== null) storedTicks.push(env.tick);
        }
        return super.eval(script, numKeys, ...args);
      }
    }
    const redis = new StaggeredSetRedis();

    // ENDS ON THE NUMBER OF WRITES THAT LANDED, not on a wall-clock window:
    // `checkpointMs` against a fixed `maxRunMs` measures how many periodic
    // writes a loaded host fitted into half a second, and the floor below
    // reddens when the answer is "fewer", which says nothing about ordering.
    // Six is what the old 500ms window landed on a quiet machine.
    const CP_WRITES = 6;

    await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        playerCount: (state) => (storedTicks.length >= CP_WRITES ? 0 : state.players.size),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-cp-order',
      namespace: NS,
      checkpointMs: 60, // several periodic writes inside the run
      maxRunMs: 4000, // a ceiling, not the exit
      emptyGraceMs: 0,
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 400)); // let any straggler land

    expect(storedTicks.length).toBeGreaterThan(2);
    // THE ORDER REDIS SEES IS THE ROOM'S ORDER. Unserialised, the held first
    // write lands after several newer ones and the checkpoint a successor
    // would restore goes BACKWARDS.
    // Non-decreasing rather than strictly increasing: the final write can name
    // the same tick as the last periodic one when the loop stopped between
    // them. What must never happen is a step BACKWARDS.
    for (let i = 1; i < storedTicks.length; i++) {
      expect(storedTicks[i] as number).toBeGreaterThanOrEqual(storedTicks[i - 1] as number);
    }
  });
});

// ---------------------------------------------------------------------------
// TR-A22: THE GRID SURVIVES A PLANNED HANDOFF.
//
// Stamping snapshots with the scheduled grid time (TR-A3) removes this
// process's jitter from the client's playback axis, and a successor that
// restarts that grid at its own `Date.now()` puts it straight back as a phase
// jump. Measured end to end over real sockets and a real Redis: the
// successor's first snapshot landed 9 to 29ms after the predecessor's last
// while carrying a whole tick of motion, the client rendered 165 to 269 u/s
// for two or three frames (the ONLY frames outside +-10% in the run), and the
// same jump walked the server timeline 20 to 40ms earlier per handoff, eroding
// the client's stamping lead half a tick at a time without ever tripping the
// re-anchor: buffer depth 5 to 4 to 1 to 0 over three handoffs.
// ---------------------------------------------------------------------------
describe('runTicker: the tick grid across a handoff', () => {
  const HZ = 10; // a 100ms grid, so the window is wide enough that this measures the mechanism and not the machine

  function recordingRuntime(stamps: number[]): Partial<RoomRuntime<CounterState, CounterEvent>> {
    return {
      tickHz: HZ,
      create: withAlice,
      encodeSnapshot: (_state, serverTimeMs) => {
        stamps.push(serverTimeMs);
        return 'x';
      },
    };
  }

  it('a successor continues the predecessor\u0027s grid, one tick on from its last stamp', async () => {
    const redis = new FakeRedis();
    const before: number[] = [];
    const after: number[] = [];

    const first = await runTicker({
      runtime: makeCounterRuntime(recordingRuntime(before)),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-grid-handoff',
      namespace: NS,
      maxRunMs: 350,
      emptyGraceMs: 100_000,
      log: () => {},
    });
    expect(first.reason).toBe('duration');

    // The standby is already booted and polling when the predecessor releases,
    // which is the case this exists for: the room is handed over inside a tick.
    const second = await runTicker({
      runtime: makeCounterRuntime(recordingRuntime(after)),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-grid-handoff',
      namespace: NS,
      standbyMs: 300,
      maxRunMs: 250,
      emptyGraceMs: 100_000,
      log: () => {},
    });
    expect(second.reason).toBe('duration');

    expect(before.length).toBeGreaterThan(2);
    expect(after.length).toBeGreaterThan(1);
    const last = before[before.length - 1] as number;
    const next = after[0] as number;
    // ONE TICK ON, EXACTLY. Not "close to", because the grid is arithmetic:
    // the predecessor's final checkpoint carries the grid point it last
    // stamped, and the successor's first is that plus one interval. Restarted
    // at the successor's own clock this is the handoff GAP instead, a few
    // milliseconds carrying a whole tick of motion.
    expect(next).toBe(last + 1000 / HZ);
    // And the successor keeps running on that grid rather than drifting off it.
    for (let i = 1; i < after.length; i++) {
      expect((after[i] as number) - (after[i - 1] as number)).toBe(1000 / HZ);
    }
  });

  it('continues a grid that is already a tick and a half in the PAST, catching up on the grid', async () => {
    // THE HANDOFF LANDS BEHIND, NOT AHEAD. A successor has to acquire, read
    // the checkpoint, deserialize and subscribe before it reaches the grid
    // decision, and on a loaded runner that is routinely more than one tick
    // after the predecessor released. Under a symmetric one-tick window that
    // case fell back to `Date.now()` and rendered the same 165 to 269 u/s
    // spike as a ticker with no `gridAt` at all, which is the one case the
    // whole mechanism exists for.
    const redis = new FakeRedis();
    const keys = roomKeys('r-grid-late', NS);
    const seen: { stamp: number; at: number }[] = [];
    const tickMs = 1000 / HZ;
    // Two and a half ticks old, so the CONTINUED point (`gridAt + tickMs`) is
    // one and a half ticks in the past: inside the catch-up window, and far
    // enough in that the loop has real catching up to do.
    const gridAt = Date.now() - 2.5 * tickMs;
    await redis.set(
      keys.state,
      JSON.stringify({
        v: 1,
        tick: 400,
        graceUntilTick: 0,
        gridAt,
        incarnation: 'inc-late',
        body: makeCounterRuntime().serialize({
          tick: 400,
          players: new Map([['alice', { counter: 0, playout: false }]]),
          full: false,
          starves: {},
        }),
      })
    );

    await runTicker({
      runtime: makeCounterRuntime({
        tickHz: HZ,
        encodeSnapshot: (_state, serverTimeMs) => {
          seen.push({ stamp: serverTimeMs, at: Date.now() });
          return 'x';
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-grid-late',
      namespace: NS,
      maxRunMs: 500,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    expect(seen.length).toBeGreaterThan(3);
    // ON THE PREDECESSOR'S GRID, EXACTLY, for both catch-up stamps. The loop
    // sleeps zero for these because the grid points have already passed, so
    // the two frames arrive together; the client plays back on the
    // `serverTime` axis, where that is ordinary jitter its buffer absorbs
    // rather than the phase jump a restart would be.
    expect(seen[0]?.stamp).toBe(gridAt + tickMs);
    expect(seen[1]?.stamp).toBe(gridAt + 2 * tickMs);
    expect(seen[2]?.stamp).toBe(gridAt + 3 * tickMs);
    // And by the third iteration the loop is back ON the wall clock rather
    // than racing to catch up: its stamp and the instant it was taken agree.
    // The first is a tick and a half behind, which is what proves the catch-up
    // really happened rather than the grid having been restarted at now.
    expect(seen[0]!.at - seen[0]!.stamp).toBeGreaterThan(tickMs);
    expect(Math.abs(seen[2]!.at - seen[2]!.stamp)).toBeLessThan(tickMs);
    // The drift rule must NOT have fired: a resync would abandon the grid and
    // the stamps would stop being multiples of a tick from `gridAt`.
    for (let i = 1; i < seen.length; i++) {
      expect((seen[i]?.stamp as number) - (seen[i - 1]?.stamp as number)).toBe(tickMs);
    }
  });

  // THE TIMELINE IS THE ROOM'S, AND EACH MACHINE'S CLOCK ONLY PACES IT. A
  // successor's clock has no relationship to its predecessor's, and outside
  // the continuation window the grid used to restart at a bare `Date.now()`:
  // measured at 39ms of BACKWARD serverTime on a 40ms skew and two full
  // seconds on a 2s skew, on the one axis every client interpolates against.
  describe.each([
    ['successor clock 40ms AHEAD of the predecessor', -40],
    ['successor clock 40ms BEHIND the predecessor', 40],
    ['successor clock 2s AHEAD of the predecessor', -2000],
    ['successor clock 2s BEHIND the predecessor', 2000],
  ])('%s', (_label, skewMs) => {
    it('never stamps below the predecessor last stamp plus a tick, and never sleeps off the skew', async () => {
      const redis = new FakeRedis();
      const room = `r-skew-${skewMs}`;
      const keys = roomKeys(room, NS);
      const tickMs = 1000 / HZ;
      const seen: { stamp: number; at: number }[] = [];
      // A positive `skewMs` puts the predecessor's clock AHEAD of this one, so
      // its last stamp is in this machine's future.
      const gridAt = Date.now() + skewMs;
      await redis.set(
        keys.state,
        JSON.stringify({
          v: 1,
          tick: 700,
          graceUntilTick: 0,
          gridAt,
          incarnation: 'inc-skew',
          body: makeCounterRuntime().serialize({
            tick: 700,
            players: new Map([['alice', { counter: 0, playout: false }]]),
            full: false,
            starves: {},
          }),
        })
      );

      const enteredAt = Date.now();
      await runTicker({
        runtime: makeCounterRuntime({
          tickHz: HZ,
          encodeSnapshot: (_state, serverTimeMs) => {
            seen.push({ stamp: serverTimeMs, at: Date.now() });
            return 'x';
          },
        }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: room,
        namespace: NS,
        maxRunMs: 600,
        emptyGraceMs: 100_000,
        log: () => {},
      });

      expect(seen.length).toBeGreaterThan(2);
      const first = seen[0] as { stamp: number; at: number };
      // NEVER BACKWARDS. A forward step is a stall the client already knows how
      // to resume from; a backward one contradicts frames already in its
      // buffer, and it is the same axis its plausibility guard judges.
      expect(first.stamp).toBeGreaterThanOrEqual(gridAt + tickMs);
      // AND THE SKEW IS NOT SLEPT OFF. Waiting for the local clock to reach the
      // predecessor's next grid point would hand the room a gap as long as the
      // skew, which is the gap the handoff exists to remove.
      expect(first.at - enteredAt).toBeLessThan(tickMs);
      // The room's timeline stays a timeline: one tick per tick, forever.
      for (let i = 1; i < seen.length; i++) {
        expect((seen[i]?.stamp as number) - (seen[i - 1]?.stamp as number)).toBe(tickMs);
      }
      // And what THIS room writes back is the stamped value, so the next
      // successor continues the timeline rather than this machine's clock.
      const persisted = unpackCheckpoint(await readCheckpoint(redis, keys.state));
      expect(persisted?.gridAt).toBe(seen[seen.length - 1]?.stamp);
    });
  });

  it('a STALE checkpoint starts a fresh grid at now, rather than stamping the past', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-grid-stale', NS);
    const stamps: number[] = [];
    // A hard death: the room was reclaimed minutes later, so the grid point in
    // the checkpoint is nowhere near this ticker's now. Adopting it would
    // stamp snapshots ten seconds in the past, which is a timeline the
    // client's own plausibility guard refuses outright.
    const staleGrid = Date.now() - 10_000;
    await redis.set(
      keys.state,
      JSON.stringify({
        v: 1,
        tick: 900,
        graceUntilTick: 0,
        gridAt: staleGrid,
        incarnation: 'inc-stale',
        body: makeCounterRuntime().serialize({
          tick: 900,
          players: new Map([['alice', { counter: 0, playout: false }]]),
          full: false,
          starves: {},
        }),
      })
    );

    const startedAt = Date.now();
    await runTicker({
      runtime: makeCounterRuntime(recordingRuntime(stamps)),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-grid-stale',
      namespace: NS,
      maxRunMs: 250,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps[0] as number).toBeGreaterThanOrEqual(startedAt);
    expect(stamps[0] as number).toBeLessThan(startedAt + 1000);
  });

  it('a cold room with no checkpoint starts its grid at now, exactly as before', async () => {
    const redis = new FakeRedis();
    const stamps: number[] = [];
    const startedAt = Date.now();
    await runTicker({
      runtime: makeCounterRuntime(recordingRuntime(stamps)),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-grid-cold',
      namespace: NS,
      maxRunMs: 250,
      emptyGraceMs: 100_000,
      log: () => {},
    });
    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps[0] as number).toBeGreaterThanOrEqual(startedAt);
    expect(stamps[0] as number).toBeLessThan(startedAt + 1000);
  });
});

// ---------------------------------------------------------------------------
// TR-A28: A THROWN EXIT LEAVES A TIMELINE MARKER, BECAUSE IT LEAVES NO
// CHECKPOINT.
// ---------------------------------------------------------------------------
describe('runTicker: the timeline high-water mark', () => {
  const HZ2 = 10;

  it('a standby taking over from a THROWN predecessor never repeats a serverTime it published', async () => {
    // THE MEASURED SEAM, 3 TIMES OUT OF 3. An 'error' exit writes no final
    // checkpoint and releases the lease, so the newest checkpoint is a
    // PERIODIC one the predecessor had already published past, and a standby
    // polling every 25ms reaches its grid decision inside the adoption window
    // and continues from that stale grid point: the predecessor's last
    // snapshot and the successor's first carried the same `serverTime` on the
    // same tick. A repeat is worse than a gap on this axis, because the client
    // is being told two different states are the same instant.
    const redis = new FakeRedis();
    const keys = roomKeys('r-timeline-seam', NS);
    const tickMs = 1000 / HZ2;
    const before: number[] = [];
    const after: number[] = [];

    const first = await runTicker({
      runtime: makeCounterRuntime({
        tickHz: HZ2,
        create: withAlice,
        tick: (state) => {
          state.tick += 1;
          // Throws well past the last checkpoint it managed to write.
          if (state.tick >= 6) throw new Error('poisoned mid-run');
          return {};
        },
        encodeSnapshot: (_state, serverTimeMs) => {
          before.push(serverTimeMs);
          return 'x';
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-timeline-seam',
      namespace: NS,
      // Lagging the publish rate on purpose, so the newest checkpoint is
      // several stamps behind what actually went out.
      checkpointMs: 250,
      maxRunMs: 5000,
      emptyGraceMs: 100_000,
      log: () => {},
    });
    expect(first.reason).toBe('error');
    expect(before.length).toBeGreaterThan(3);
    // The marker is the whole mechanism: written before the lease was handed
    // back, so whoever wins it next can see it.
    expect(await redis.get(keys.timeline)).not.toBeNull();

    const second = await runTicker({
      runtime: makeCounterRuntime({
        tickHz: HZ2,
        encodeSnapshot: (_state, serverTimeMs) => {
          after.push(serverTimeMs);
          return 'x';
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-timeline-seam',
      namespace: NS,
      standbyMs: 300,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    expect(second.ticks).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    const lastA = before[before.length - 1] as number;
    const firstB = after[0] as number;
    // STRICTLY GREATER. Not merely different: the successor picks up above
    // everything the predecessor ever put on the wire.
    expect(firstB).toBeGreaterThan(lastA);
    // And it is still a grid, not a jump to the local clock.
    for (let i = 1; i < after.length; i++) {
      expect((after[i] as number) - (after[i - 1] as number)).toBe(tickMs);
    }
  });

  it('a clean exit deletes the marker, because its own checkpoint is a better answer', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-timeline-clean', NS);
    // A marker left by some earlier crashed invocation. Without the delete it
    // would keep raising every later successor's floor for a whole state TTL.
    await redis.set(keys.timeline, String(Date.now() + 60_000));

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: HZ2, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-timeline-clean',
      namespace: NS,
      maxRunMs: 300,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    expect(result.reason).toBe('duration');
    // The final checkpoint's own `gridAt` is now the end of the timeline.
    expect(await redis.get(keys.timeline)).toBeNull();
    expect(unpackCheckpoint(await readCheckpoint(redis, keys.state))?.gridAt).toBeGreaterThan(0);
  });

  it('a HARD death leaves no marker, so a stale checkpoint still starts at now', async () => {
    // Nothing runs on a hard kill, so there is no marker to find and the
    // stale-grid fallback is exactly what it was before this existed.
    const redis = new FakeRedis();
    const keys = roomKeys('r-timeline-hard', NS);
    const stamps: number[] = [];
    await redis.set(
      keys.state,
      JSON.stringify({
        v: 1,
        tick: 900,
        graceUntilTick: 0,
        gridAt: Date.now() - 30_000,
        incarnation: 'inc-hard',
        body: makeCounterRuntime().serialize({
          tick: 900,
          players: new Map([['alice', { counter: 0, playout: false }]]),
          full: false,
          starves: {},
        }),
      })
    );
    expect(await redis.get(keys.timeline)).toBeNull();

    const startedAt = Date.now();
    await runTicker({
      runtime: makeCounterRuntime({
        tickHz: HZ2,
        encodeSnapshot: (_state, serverTimeMs) => {
          stamps.push(serverTimeMs);
          return 'x';
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-timeline-hard',
      namespace: NS,
      maxRunMs: 300,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps[0] as number).toBeGreaterThanOrEqual(startedAt);
    expect(stamps[0] as number).toBeLessThan(startedAt + 1000);
  });
});

// ---------------------------------------------------------------------------
// TR-A29: THE CRASH RECORD IS THE LAST I/O ON THE CRASH PATH, SO IT IS AWAITED.
// ---------------------------------------------------------------------------
describe('runTicker: recording a crash', () => {
  it('has issued the EXPIRE before runTicker resolves, not after', async () => {
    // Fire-and-forget, the EXPIRE is not even ISSUED until the INCRBY replies,
    // which is after the handler has already returned: measured in exactly
    // that order. A platform that suspends the instance the moment the handler
    // resolves then loses the increment, or lands it and drops the TTL and
    // leaves a counter that never ages out. Both are the crash-loop guard
    // failing, in opposite directions.
    const order: string[] = [];
    class SlowIncrRedis extends FakeRedis {
      override async incrby(key: string, n: number): Promise<number> {
        order.push('incrby-issued');
        await new Promise((r) => setTimeout(r, 100));
        return super.incrby(key, n);
      }

      override async expire(key: string, seconds: number): Promise<number> {
        if (key.endsWith(':crashes')) order.push('expire-issued');
        return super.expire(key, seconds);
      }
    }
    const redis = new SlowIncrRedis();
    const keys = roomKeys('r-crash-await', NS);

    const result = await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        tick: () => {
          throw new Error('boom');
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-crash-await',
      namespace: NS,
      maxRunMs: 5000,
      emptyGraceMs: 100_000,
      log: () => {},
    });
    order.push('returned');

    expect(result.reason).toBe('error');
    // The TTL was applied while the handler was still alive to apply it.
    expect(order).toEqual(['incrby-issued', 'expire-issued', 'returned']);
    expect(await redis.get(keys.crashes)).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// TR-A4: A SNAPSHOT THAT CANNOT GO OUT NOW IS WORTHLESS LATER.
// ---------------------------------------------------------------------------
describe('runTicker: the in-flight publish bound', () => {
  it('skips a snapshot rather than queueing a stale burst behind a slow bus', async () => {
    const keys = roomKeys('r-inflight', NS);
    const redis = new SlowPublishRedis(keys.out, 300);
    const stats: RoomStats[] = [];
    let issued = 0;
    const observer = redis.fork();
    observer.on('message', (channel) => {
      if (channel === keys.out) issued++;
    });
    await observer.subscribe(keys.out);

    await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-inflight',
      namespace: NS,
      statsMs: 50,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: () => {},
    });
    observer.disconnect();

    // Twenty ticks in the run at 50Hz, each 300ms behind the bus: without the
    // bound every one of them is queued and replayed in a burst.
    expect(stats.reduce((n, s) => n + s.publishSkipped, 0)).toBeGreaterThan(5);
    // Never more than the bound in flight, plus whatever landed in the window.
    expect(issued).toBeLessThanOrEqual(8);
  });

  it('CONTROL: a healthy bus skips nothing', async () => {
    const redis = new FakeRedis();
    const stats: RoomStats[] = [];
    await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-inflight-ok',
      namespace: NS,
      statsMs: 40,
      maxRunMs: 250,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
    });
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.reduce((n, s) => n + s.publishSkipped, 0)).toBe(0);
    expect(stats.reduce((n, s) => n + s.publishes, 0)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TR-A5: A THROWN TICKER MUST NOT ARM ITS OWN SUCCESSOR WITH THE SAME POISON.
// ---------------------------------------------------------------------------
describe('runTicker: the error exit', () => {
  async function seedCheckpoint(redis: FakeRedis, room: string, tick: number): Promise<void> {
    const keys = roomKeys(room, NS);
    await redis.set(
      keys.state,
      JSON.stringify({
        v: 1,
        tick,
        graceUntilTick: 0,
        incarnation: 'inc-crash',
        body: makeCounterRuntime().serialize({
          tick,
          players: new Map([['alice', { counter: 0, playout: false }]]),
          full: false,
          starves: {},
        }),
      })
    );
  }

  it('writes NO final checkpoint, so the successor restores state that demonstrably simulates', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-nofinal', NS);
    await seedCheckpoint(redis, 'r-nofinal', 500);

    const result = await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        tick: (state) => {
          state.tick += 1;
          // Half-mutated by definition: the step got this far and then unwound.
          if (state.tick >= 510) throw new Error('poisoned state');
          return {};
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-nofinal',
      namespace: NS,
      // Only ONE periodic write happens in this run, on the first iteration
      // (`lastCheckpointAt` starts at the epoch), which is a state a completed
      // tick produced: tick 501.
      checkpointMs: 100_000,
      maxRunMs: 5000,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    expect(result.reason).toBe('error');
    // The last checkpoint a COMPLETED tick wrote, not the state the throw left
    // behind. Writing a final checkpoint here persists the very bytes that
    // killed this invocation, which the successor then restores and dies on.
    expect(unpackCheckpoint(await readCheckpoint(redis, keys.state))?.tick).toBe(501);
  });

  it('spawns no successor and counts the crash instead', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-crashcount', NS);
    const spawn = vi.fn().mockResolvedValue(undefined);

    const result = await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        tick: () => {
          throw new Error('boom');
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-crashcount',
      namespace: NS,
      maxRunMs: 5000,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: () => {},
    });

    expect(result.reason).toBe('error');
    // A successor would hit the identical failure, and the pair would spin as
    // fast as the platform can start functions: measured at 40 spawns in
    // 958ms. The relay's jittered lease poll paces the retries instead.
    expect(spawn).not.toHaveBeenCalled();
    expect(await redis.get(keys.crashes)).toBe('1');
    // The lease is handed back even though nothing else is.
    expect(await redis.get(keys.lease)).toBeNull();
  });

  it('starts the room FRESH once the crash count says the checkpoint is poison', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-crashloop', NS);
    await seedCheckpoint(redis, 'r-crashloop', 900);
    await redis.set(keys.crashes, '3');
    const logs: LogEvent[] = [];

    let firstTick = -1;
    await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        tick: (state) => {
          if (firstTick === -1) firstTick = state.tick;
          state.tick += 1;
          return {};
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-crashloop',
      namespace: NS,
      maxRunMs: 120,
      emptyGraceMs: 10,
      log: (ev) => logs.push(ev),
    });

    expect(firstTick).toBe(0); // fresh, not the 900 that keeps killing tickers
    expect(logs.filter((l) => l.kind === 'ticker.crash-loop')).toHaveLength(1);
    expect(logs.find((l) => l.kind === 'ticker.crash-loop')?.meta).toMatchObject({ crashes: 3 });
    // Cleared, so the next invocation is judged on its own evidence.
    expect(await redis.get(keys.crashes)).toBeNull();
  });

  it('CONTROL: two crashes are not a loop, so the checkpoint is still restored', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-crash2', NS);
    await seedCheckpoint(redis, 'r-crash2', 900);
    await redis.set(keys.crashes, '2');

    let firstTick = -1;
    await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        tick: (state) => {
          if (firstTick === -1) firstTick = state.tick;
          state.tick += 1;
          return {};
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-crash2',
      namespace: NS,
      maxRunMs: 120,
      emptyGraceMs: 10,
      log: () => {},
    });

    expect(firstTick).toBe(900);
  });

  it('does NOT clear the crash counter just for having reached its first checkpoint', async () => {
    // THE COUNTER'S WINDOW IS THE ONLY HONEST THRESHOLD. Cleared after a
    // checkpoint interval, ANY poison that kills the loop later than a second
    // in resets the count before every crash, so the count never reaches the
    // limit and the crash-loop guard does nothing at all: measured over four
    // invocations with the counter stuck at 1, while the node adapter's own
    // comment names this counter as the thing that breaks the loop. An
    // invocation has to outlive `CRASH_KEY_TTL_S` before it has outlived the
    // evidence against it.
    const redis = new FakeRedis();
    const keys = roomKeys('r-crashclear', NS);
    await redis.set(keys.crashes, '1');

    await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-crashclear',
      namespace: NS,
      checkpointMs: 60, // several checkpoints inside this run
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    expect(await redis.get(keys.crashes)).toBe('1');
  });

  it('dates the crash window from the FIRST crash of a run, so unrelated ones age out', async () => {
    // A SLIDING WINDOW IS NOT THE WINDOW THE CONSTANT'S OWN COMMENT DESCRIBES.
    // Re-applying the EXPIRE on every crash pushes the deadline out each time,
    // so three unrelated throws a minute apart accumulate to a limit that is
    // supposed to mean three crashes inside one minute, and a perfectly
    // healthy room has its checkpoint discarded for it.
    const redis = new FakeRedis();
    const keys = roomKeys('r-crashwindow', NS);
    const ttls: number[] = [];
    const realExpire = redis.expire.bind(redis);
    redis.expire = async (key: string, seconds: number): Promise<number> => {
      if (key === keys.crashes) ttls.push(seconds);
      return realExpire(key, seconds);
    };

    for (let run = 0; run < 3; run++) {
      await runTicker({
        runtime: makeCounterRuntime({
          tickHz: 50,
          create: withAlice,
          tick: () => {
            throw new Error('boom');
          },
        }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r-crashwindow',
        namespace: NS,
        maxRunMs: 5000,
        emptyGraceMs: 100_000,
        log: () => {},
      });
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(await redis.get(keys.crashes)).toBe('3');
    // Exactly ONE expiry, applied by the first crash of the run. Three would
    // mean each crash re-dated the window that is supposed to age them out.
    expect(ttls).toEqual([60]);
  });
});

// ---------------------------------------------------------------------------
// TR-A6: A TICKER THAT CANNOT RECEIVE INPUT MUST NOT HOLD THE ROOM.
// ---------------------------------------------------------------------------
describe('runTicker: the subscribe bound', () => {
  it('gives up rather than running deaf when the subscribe never resolves', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-subhang', NS);
    const spawn = vi.fn().mockResolvedValue(undefined);
    const logs: LogEvent[] = [];
    const started = Date.now();

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: hangingSubscriber,
      roomId: 'r-subhang',
      namespace: NS,
      leaseTtlMs: 60,
      maxRunMs: 5000,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: (ev) => logs.push(ev),
    });

    expect(result.reason).toBe('error');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logs.filter((l) => l.kind === 'ticker.subscribe-failed')).toHaveLength(1);
    // The lease goes straight back so the next spawn gets a clean connection.
    expect(await redis.get(keys.lease)).toBeNull();
    // Not a runtime crash, so nothing is counted against the room's state...
    expect(await redis.get(keys.crashes)).toBeNull();
    // ...and no successor is fired from here: the relay's lease poll owns the
    // retry, which is what keeps a bad connection from spinning.
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does the same on a REJECTED subscribe, which used to log and carry on', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-subreject', NS);
    const logs: LogEvent[] = [];

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () =>
        ({
          on: () => {},
          subscribe: async () => {
            throw new Error('SUBSCRIBE refused');
          },
          disconnect: () => {},
        }) as unknown as Subscriber,
      roomId: 'r-subreject',
      namespace: NS,
      leaseTtlMs: 500,
      maxRunMs: 5000,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });

    expect(result.reason).toBe('error');
    expect(result.ticks).toBe(0);
    expect(String(logs.find((l) => l.kind === 'ticker.subscribe-failed')?.meta?.error)).toContain('SUBSCRIBE refused');
    expect(await redis.get(keys.lease)).toBeNull();
  });

  it('throttles a retrying subscriber error to one line per stats flush', async () => {
    const redis = new FakeRedis();
    const logs: LogEvent[] = [];
    const noisy = noisySubscriber(10); // one 'error' every 10ms, as a retry loop does

    await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => noisy.sub,
      roomId: 'r-suberr',
      namespace: NS,
      statsMs: 100,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });
    noisy.stop();

    const lines = logs.filter((l) => l.kind === 'ticker.subscriber-error');
    // Roughly forty errors were emitted; a line each is a log amplifier.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// TR-A7: A SUBSCRIPTION THAT DELIVERS NOTHING LOOKS EXACTLY LIKE A QUIET ROOM.
// ---------------------------------------------------------------------------
describe('runTicker: the input-subscription liveness probe', () => {
  it('exits input-dead and hands the room over when three probes go unanswered', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-deaf', NS);
    const spawn = vi.fn().mockResolvedValue(undefined);
    const logs: LogEvent[] = [];

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      // Black-holed: the subscribe succeeded, the room ticks, publishes and
      // renews, and not one message ever arrives. Measured over a 4s black
      // hole before this existed: zero log lines and healthy stats.
      createSubscriber: blackHoleSubscriber,
      roomId: 'r-deaf',
      namespace: NS,
      // A FINE METRICS CADENCE MUST NOT SHORTEN THE DEADLINE. This used to be
      // three stats windows, so a host asking for 40ms resolution gave itself
      // a 120ms liveness deadline and lost healthy rooms to a slow bus. The
      // probe now runs on `PROBE_INTERVAL_MS` / `PROBE_DEAD_MS` regardless.
      statsMs: 40,
      maxRunMs: 12_000,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: (ev) => logs.push(ev),
    });

    expect(result.reason).toBe('input-dead');
    // Three unanswered probes at a one-second cadence, and nowhere near the
    // 12s cap: the deadline is the probe's own, not the stats window's.
    expect(result.uptimeMs).toBeGreaterThanOrEqual(2900);
    expect(result.uptimeMs).toBeLessThan(6000);
    expect(logs.filter((l) => l.kind === 'ticker.input-dead')).toHaveLength(1);
    // Handled exactly like a duration cap: the lease goes back and a successor
    // opens a FRESH subscriber, which is the only thing that can fix this.
    expect(await redis.get(keys.lease)).toBeNull();
    expect(spawn).toHaveBeenCalledWith('r-deaf', { standby: false });
    // The state survives, because the simulation was never the problem.
    expect(await readCheckpoint(redis, keys.state)).not.toBeNull();
  });

  it('CONTROL: a live subscription answers every probe and the room runs to its cap', async () => {
    const redis = new FakeRedis();
    const stats: RoomStats[] = [];
    const logs: LogEvent[] = [];

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-live',
      namespace: NS,
      statsMs: 30,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: (ev) => logs.push(ev),
    });

    expect(result.reason).toBe('duration');
    expect(logs.filter((l) => l.kind === 'ticker.input-dead')).toHaveLength(0);
    // THE PROBE IS NOT TRAFFIC. It never reaches the inbox, the runtime or any
    // counter, so a room whose only messages are its own probes reports a
    // completely quiet window.
    expect(stats.reduce((n, s) => n + s.badEnvelopes, 0)).toBe(0);
    expect(stats.reduce((n, s) => n + s.unknownEnvelopes, 0)).toBe(0);
    expect(stats.reduce((n, s) => n + s.dropped, 0)).toBe(0);
  });

  it('a FORGED answer far above what was sent does not disarm the watchdog', async () => {
    // The owner id is the LEASE VALUE, which every relay with a Redis
    // connection can read, so `o` proves a probe was addressed to this ticker
    // and not that this ticker sent it. Unbounded, one forged `n` of 1e15 pins
    // `probesAnswered` above every number this ticker will ever reach and
    // `probesSent > probesAnswered` can never be true again: the watchdog
    // built to notice a dead subscription is itself dead for the rest of the
    // run. Measured: the control exits 'input-dead' in 3.0s, the poisoned one
    // holds the room to its full lifetime cap with its inputs going nowhere.
    const keys = roomKeys('r-probe-forged', NS);
    // This ticker's own probes never leave the process; the forgery arrives.
    const redis = new NoProbeOutRedis(keys.in);
    const injector = redis.fork();
    const logs: LogEvent[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-probe-forged',
      namespace: NS,
      maxRunMs: 12_000,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });

    await new Promise((r) => setTimeout(r, 60));
    // Read the owner straight off the lease, exactly as any relay could.
    const owner = await redis.get(keys.lease);
    expect(owner).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      await injector.publish(keys.in, JSON.stringify({ t: 'probe', n: 1e15, o: owner }));
      await new Promise((r) => setTimeout(r, 500));
    }

    const result = await resultPromise;
    // The watchdog still fires on its own schedule: an answer is bounded by
    // what was asked.
    expect(result.reason).toBe('input-dead');
    expect(result.uptimeMs).toBeLessThan(6000);
    expect(logs.filter((l) => l.kind === 'ticker.input-dead')).toHaveLength(1);
  });

  it('never hands a probe to the runtime, its own or anybody else\u0027s', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-probe-rt', NS);
    const custom: string[] = [];
    const stats: RoomStats[] = [];
    let joined = 0;

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        onCustom: (_state, name) => custom.push(name),
        join: (state, pid) => {
          joined++;
          if (!state.players.has(pid)) state.players.set(pid, { counter: 0, playout: false });
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-probe-rt',
      namespace: NS,
      statsMs: 25,
      maxRunMs: 250,
      emptyGraceMs: 100_000,
      onStats: (st) => stats.push(st),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 20));
    // A probe from a neighbouring ticker, hand-rolled onto the same channel.
    await redis.publish(keys.in, JSON.stringify({ t: 'probe', n: 4, o: 'a-different-ticker' }));
    await resultPromise;

    expect(custom).toEqual([]);
    expect(joined).toBe(0);
    // A hand-rolled probe from somewhere else on the wire is equally inert,
    // and is not counted as a deploy skew either: it has a `t` this ticker
    // knows, it is simply not addressed to it.
    expect(stats.reduce((n, st) => n + st.unknownEnvelopes, 0)).toBe(0);
    expect(stats.reduce((n, st) => n + st.badEnvelopes, 0)).toBe(0);
  });

  it('does not let ANOTHER ticker\u0027s probe answer for its own', async () => {
    const keys = roomKeys('r-foreign-probe', NS);
    // This ticker's own probes never leave the process; a neighbour's arrive
    // normally. That is the shape a handoff produces for a few seconds, with
    // two tickers publishing on one input channel, and it is exactly when the
    // predecessor most needs to find out its subscription is dead.
    const redis = new NoProbeOutRedis(keys.in);
    const injector = redis.fork(); // a second connection, not broken
    const logs: LogEvent[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-foreign-probe',
      namespace: NS,
      statsMs: 40,
      maxRunMs: 12_000,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });

    await new Promise((r) => setTimeout(r, 30));
    // A far higher `n` than this ticker will ever reach, from a different
    // owner. Without the owner comparison it answers every probe this ticker
    // will ever send, and the one signal built to catch a dead subscription
    // is the one thing hiding it.
    for (let i = 0; i < 6; i++) {
      await injector.publish(keys.in, JSON.stringify({ t: 'probe', n: 999 + i, o: 'a-different-ticker' }));
      await new Promise((r) => setTimeout(r, 500));
    }

    const result = await resultPromise;
    expect(result.reason).toBe('input-dead');
    expect(result.uptimeMs).toBeLessThan(6000);
    expect(logs.filter((l) => l.kind === 'ticker.input-dead')).toHaveLength(1);
    // And the foreign probes were inert on the way past: not traffic, not a
    // deploy skew, not an answer.
    expect(logs.filter((l) => l.kind === 'ticker.unknown-envelope')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TR-A21: A THROW ANYWHERE IN SETUP GIVES THE LEASE BACK AND STOPS THE RENEW.
// ---------------------------------------------------------------------------
describe('runTicker: a throw during setup', () => {
  /**
   * `runtime.create` on a cold room, which is the one restore path with no
   * try of its own: `deserialize` is already caught and treated as a corrupt
   * checkpoint, but a simulation that cannot build a FRESH room has nothing
   * to fall back to. Before the guard this escaped `runTicker` with the lease
   * still held (so no successor could acquire it for the whole TTL) and the
   * setup renew interval still running, which keeps renewing that lease for
   * the lifetime of the process: a room locked out by a timer nobody holds a
   * handle to any more.
   */
  it('releases the lease, stops the renew, and spawns nobody when runtime.create throws', async () => {
    const redis = new CountingEvalRedis();
    const keys = roomKeys('r-setup-threw', NS);
    const spawn = vi.fn().mockResolvedValue(undefined);
    const logs: LogEvent[] = [];

    const result = await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => {
          throw new Error('the world definition is unbuildable');
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-setup-threw',
      namespace: NS,
      // Short enough that a renew interval left running would fire many times
      // over the checks below.
      leaseTtlMs: 60,
      leaseRenewMs: 20,
      maxRunMs: 5000,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: (ev) => logs.push(ev),
    });

    expect(result.reason).toBe('error');
    expect(result.ticks).toBe(0);
    expect(logs.filter((l) => l.kind === 'ticker.setup-threw')).toHaveLength(1);
    expect(String(logs.find((l) => l.kind === 'ticker.setup-threw')?.meta?.error)).toContain('unbuildable');
    // The lease went back rather than locking the room out for a whole TTL on
    // top of an invocation that had already failed.
    expect(await redis.get(keys.lease)).toBeNull();
    // A successor would hit the identical failure, and this is not a crash of
    // the room's stored state either, so nothing is counted against it.
    expect(spawn).not.toHaveBeenCalled();
    expect(await redis.get(keys.crashes)).toBeNull();

    // AND THE RENEW INTERVAL IS GONE, WHICH THE LEASE KEY CANNOT SHOW ON ITS
    // OWN. A leaked renew cannot resurrect a released lease (the script is
    // owner-checked, and the key it would extend has been deleted), so every
    // assertion above passes with the timer still running. What a leaked timer
    // DOES do is issue an EVAL every renew period, forever, holding the event
    // loop open for the life of the process: that traffic is the only honest
    // tell, so count it.
    const evalsAtExit = redis.evals;
    await new Promise((r) => setTimeout(r, 140)); // seven renew periods
    expect(redis.evals).toBe(evalsAtExit);
    // And with nothing renewing it, the room is immediately re-acquirable.
    expect(await acquireLease(redis, keys.lease, 'a-new-owner', { leaseTtlMs: 5000 })).toBe(true);
  });

  it('does the same when createSubscriber throws', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-setup-sub', NS);
    const spawn = vi.fn().mockResolvedValue(undefined);
    const logs: LogEvent[] = [];

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => {
        throw new Error('no connection available');
      },
      roomId: 'r-setup-sub',
      namespace: NS,
      leaseTtlMs: 60,
      leaseRenewMs: 20,
      maxRunMs: 5000,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: (ev) => logs.push(ev),
    });

    expect(result.reason).toBe('error');
    expect(logs.filter((l) => l.kind === 'ticker.setup-threw')).toHaveLength(1);
    expect(await redis.get(keys.lease)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    // Nothing was written on the way out either: a room that never started
    // has no state worth persisting over whatever is already there.
    expect(await readCheckpoint(redis, keys.state)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TR-A8: A THROWN READ IS NOT AN ABSENT CHECKPOINT.
// ---------------------------------------------------------------------------
describe('runTicker: a checkpoint read that throws', () => {
  it('gives up rather than overwriting a checkpoint that is probably still there', async () => {
    const redis = new FlakyReadRedis(99); // every read throws
    const keys = roomKeys('r-readfail', NS);
    const seeded = JSON.stringify({
      v: 1,
      tick: 45,
      graceUntilTick: 0,
      incarnation: 'inc-live',
      body: makeCounterRuntime().serialize({ tick: 45, players: new Map(), full: false, starves: {} }),
    });
    await redis.set(keys.state, seeded);
    const spawn = vi.fn().mockResolvedValue(undefined);
    const logs: LogEvent[] = [];

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-readfail',
      namespace: NS,
      maxRunMs: 5000,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: (ev) => logs.push(ev),
    });

    expect(result.reason).toBe('error');
    expect(result.ticks).toBe(0);
    // THE POINT. This used to fall into the start-fresh path, so one rejected
    // GET produced a new incarnation and a first tick that overwrote a
    // perfectly good checkpoint: measured at tick 45 down to tick 3.
    expect(await redis.get(keys.state)).toBe(seeded);
    expect(logs.filter((l) => l.kind === 'ticker.checkpoint-read-failed')).toHaveLength(1);
    expect(logs.find((l) => l.kind === 'ticker.checkpoint-read-failed')?.lvl).toBe('error');
    expect(await redis.get(keys.lease)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    // Not a crash of the room's own state, so nothing is counted against it.
    expect(await redis.get(keys.crashes)).toBeNull();
  });

  it('retries, so a single transient fault still restores the room', async () => {
    const redis = new FlakyReadRedis(2); // the third attempt succeeds
    const keys = roomKeys('r-readretry', NS);
    await redis.set(
      keys.state,
      JSON.stringify({
        v: 1,
        tick: 300,
        graceUntilTick: 0,
        incarnation: 'inc-retry',
        body: makeCounterRuntime().serialize({ tick: 300, players: new Map(), full: false, starves: {} }),
      })
    );

    let firstTick = -1;
    const result = await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        tick: (state) => {
          if (firstTick === -1) firstTick = state.tick;
          state.tick += 1;
          return {};
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-readretry',
      namespace: NS,
      maxRunMs: 200,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    expect(firstTick).toBe(300);
    expect(result.reason).toBe('duration');
  });
});

// ---------------------------------------------------------------------------
// TR-A9 / TR-A10: OWNERSHIP THROUGH SETUP, AND DATED FROM THE ATTEMPT.
// ---------------------------------------------------------------------------
describe('runTicker: the lease through setup', () => {
  /**
   * Resolves once the room has published a few snapshots and then stopped,
   * which from outside is what "the loop is blocked on a held Redis reply"
   * looks like. The quiet threshold is four times the run's OWN median gap
   * between publishes (floored at 60ms), so it scales with whatever cadence
   * this host actually managed rather than assuming the one a quiet machine
   * produces. Returns false if the deadline passes without the room ever
   * going quiet, so the caller asserts on the precondition instead of
   * silently measuring a scenario that never set itself up.
   */
  async function waitUntilPublishingStops(at: number[], deadlineMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      await new Promise((r) => setTimeout(r, 10));
      if (at.length < 4) continue;
      const gaps = at.slice(1).map((t, i) => t - (at[i] as number)).sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)] as number;
      if (Date.now() - (at[at.length - 1] as number) >= Math.max(60, 4 * median)) return true;
    }
    return false;
  }

  it('renews during a long init, so a slow start does not lose the room', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-slowinit', NS);

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-slowinit',
      namespace: NS,
      // A wasm instantiation or a worker boot, against a lease shrunk to test
      // speed. Nothing renewed between the acquire and the first iteration, so
      // this exact shape lost the lease before the loop had run once and the
      // successor repeated it.
      init: () => new Promise((r) => setTimeout(r, 160)),
      leaseTtlMs: 60,
      leaseRenewMs: 20,
      maxRunMs: 260,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    expect(result.reason).toBe('duration');
    expect(result.ticks).toBeGreaterThan(0);
    expect(await redis.get(keys.lease)).toBeNull(); // released cleanly on the way out
  });

  it('reports lease-lost with no checkpoint and no successor when the lease goes during setup', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-setuploss', NS);
    const spawn = vi.fn().mockResolvedValue(undefined);
    const logs: LogEvent[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-setuploss',
      namespace: NS,
      init: () => new Promise((r) => setTimeout(r, 200)),
      leaseTtlMs: 60,
      leaseRenewMs: 20,
      maxRunMs: 2000,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: (ev) => logs.push(ev),
    });

    await new Promise((r) => setTimeout(r, 40));
    await redis.set(keys.lease, 'a-thief', 'PX', 5000);

    const result = await resultPromise;
    expect(result.reason).toBe('lease-lost');
    expect(result.ticks).toBe(0);
    expect(logs.find((l) => l.kind === 'ticker.lease-lost')?.meta).toMatchObject({ finder: 'setup' });
    // The thief is the authority now: nothing here may write over it.
    expect(await redis.get(keys.lease)).toBe('a-thief');
    expect(await readCheckpoint(redis, keys.state)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a setup renew whose refusal lands after setup ends is still acted on, not discarded', async () => {
    // A setup renew is issued while `init` runs and its reply can land any
    // time after the `setupLostLease` check has already been made. Reaching
    // only that check, a CONFIRMED refusal from Redis is thrown away: the
    // ticker publishes into a room somebody else already owns until its own
    // renew cadence comes round again and rediscovers the same fact, which at
    // production pacing is one and a half seconds of split brain.
    const keys = roomKeys('r-setup-late-loss', NS);
    const logs: LogEvent[] = [];
    // Held replies, so the refusal cannot possibly land before setup finishes,
    // and a stolen lease so the reply is a real refusal rather than an error.
    const slow = new SlowReplyRedis(200);
    const publishedAt: number[] = [];
    const observer = slow.fork();
    observer.on('message', (channel) => {
      if (channel === keys.out) publishedAt.push(Date.now());
    });
    await observer.subscribe(keys.out);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        // SELECTED BY ORDERING, LIKE THE OTHER LEASE CASES. The owner-checked
        // checkpoint is a THIRD finder of the same loss and reports it inside
        // one round trip, which masks this one entirely; a `serialize` that
        // throws means no checkpoint is ever issued, so the only finders left
        // are the setup renew's own reply and the loop's next renew, and the
        // two are far enough apart to tell apart.
        serialize: () => {
          throw new Error('no checkpoint from this room');
        },
      }),
      redis: slow,
      createSubscriber: () => slow.fork(),
      roomId: 'r-setup-late-loss',
      namespace: NS,
      // The renew is attempted 280ms in and its refusal lands at 480ms, well
      // after setup finishes at about 305ms. The loop's OWN renew is not due
      // until 560ms and its reply would not land until 760ms, so the window
      // between the two is what this measures.
      init: () => new Promise((r) => setTimeout(r, 300)),
      leaseTtlMs: 100_000, // the synchronous guard can never be the finder
      leaseRenewMs: 280,
      maxRunMs: 4000,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });

    await new Promise((r) => setTimeout(r, 10));
    await slow.set(keys.lease, 'a-thief', 'PX', 5000);

    const result = await resultPromise;
    expect(result.reason).toBe('lease-lost');
    expect(logs.some((l) => l.kind === 'ticker.lease-lost')).toBe(true);
    expect(await slow.get(keys.lease)).toBe('a-thief');
    // THE MEASURE IS SNAPSHOTS, NOT THE EXIT REASON. Discarded, the loss is
    // rediscovered by the loop's own renew a whole reply delay later and the
    // room publishes into somebody else's timeline the entire time; the exit
    // reason is the same either way, which is what would make a
    // reason-only assertion vacuous here.
    // About nine snapshots between the loop starting (305ms) and the refusal
    // landing (480ms). Discarded, the loss is not rediscovered until the
    // loop's own renew reply at about 760ms, which is another fourteen
    // snapshots into a room somebody else is already simulating.
    expect(publishedAt.length).toBeLessThanOrEqual(14);
  });

  it('stops publishing on a lease it cannot vouch for, because ownership is dated from the ATTEMPT', async () => {
    // Redis extended the key when it PROCESSED the renew, so the attempt time
    // is the last instant this ticker can prove anything about. Dating
    // ownership from when the REPLY landed credits it a whole round trip of
    // life the key never had, and the room keeps publishing straight through
    // the window a successor has already taken over in: measured with a 600ms
    // delayed reply, 27 predecessor snapshots after the handoff.
    //
    // The reply delay here is longer than the lease TTL, which is the only
    // condition under which the two rules differ at all: below it, a
    // confirmation is always inside the window either way, which is why this
    // was invisible for so long.
    const redis = new SlowReplyRedis(400);
    const keys = roomKeys('r-attempttime', NS);
    const publishedAt: number[] = [];
    const observer = redis.fork();
    observer.on('message', (channel) => {
      if (channel === keys.out) publishedAt.push(Date.now());
    });
    await observer.subscribe(keys.out);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-attempttime',
      namespace: NS,
      leaseTtlMs: 300,
      leaseRenewMs: 25,
      checkpointMs: 100_000,
      maxRunMs: 4000,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    // The guard's own renew is issued at t=300 and its reply is held until
    // t=700, so the loop is blocked across this whole window and the key,
    // last extended at t=300, lapses at t=600. A successor legitimately takes
    // it while the predecessor is still waiting to hear about its own renew.
    //
    // WAITED FOR, NOT SLEPT TO. A fixed sleep to 380ms only lands inside that
    // window while the host fires its timers roughly on time; a loaded one
    // moves the window out from under it, the theft lands after the loop had
    // already resumed, and the publish counts below are then measuring a
    // different scenario. The loop going quiet IS the loop being blocked, and
    // the quiet threshold is taken from this run's OWN publish cadence, so a
    // host pacing the loop at 20ms and one pacing it at 60ms both read as
    // blocked at the same point in the scenario rather than the slower one
    // reading as blocked while it is merely slow.
    const blocked = await waitUntilPublishingStops(publishedAt, 3000);
    expect(blocked).toBe(true);
    const stolenAt = Date.now();
    await redis.set(keys.lease, 'the-successor', 'PX', 5000);

    const result = await resultPromise;
    observer.disconnect();

    expect(publishedAt.length).toBeGreaterThan(3); // it really was publishing
    expect(result.reason).toBe('lease-lost');
    // AT MOST the one frame the resumed iteration issues before the next guard
    // looks again. Dated from the reply, this ticker believes it owns the room
    // for a further TTL and publishes about fifteen more snapshots into a room
    // somebody else is already simulating.
    expect(publishedAt.filter((t) => t > stolenAt).length).toBeLessThanOrEqual(3);
    expect(await redis.get(keys.lease)).toBe('the-successor');
  });
});

// ---------------------------------------------------------------------------
// TR-A11 / TR-A12: THE LEASE IS THE STORE'S ANSWER, NOT A LOCAL FLAG.
// ---------------------------------------------------------------------------
describe('runTicker: ownership the store decides', () => {
  it('exits lease-lost when Redis refuses the checkpoint, and never overwrites the successor', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-refused', NS);
    const logs: LogEvent[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-refused',
      namespace: NS,
      // Long enough that neither the synchronous guard nor a periodic renew
      // can be the finder: the checkpoint's own refusal is the ONLY detector
      // left, which is the lag this owner check exists to close.
      leaseTtlMs: 100_000,
      leaseRenewMs: 100_000,
      checkpointMs: 30,
      maxRunMs: 1500,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });

    await new Promise((r) => setTimeout(r, 20));
    await redis.set(keys.lease, 'the-successor', 'PX', 5000);
    const successorState = 'the successor room';
    await redis.set(keys.state, successorState);

    const result = await resultPromise;
    expect(result.reason).toBe('lease-lost');
    expect(result.uptimeMs).toBeLessThan(1000);
    expect(logs.filter((l) => l.kind === 'ticker.checkpoint-refused-not-owner')).toHaveLength(1);
    expect(logs.find((l) => l.kind === 'ticker.lease-lost')?.meta).toMatchObject({ finder: 'checkpoint' });
    // The load-bearing half: the ex-owner's state never landed.
    expect(await redis.get(keys.state)).toBe(successorState);
    expect(await redis.get(keys.lease)).toBe('the-successor');
  });

  it('a reconnecting bus makes the next publish confirm ownership first', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-reconnect', NS);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-reconnect',
      namespace: NS,
      // Five seconds of believed ownership and no renew ever due, so without
      // the bus signal nothing looks at the lease again for the whole run.
      leaseTtlMs: 5000,
      leaseRenewMs: 100_000,
      checkpointMs: 100_000,
      maxRunMs: 800,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 30));
    // The bus dropped and is retrying, so every renew since is queued rather
    // than delivered and ownership is a claim about a connection that was down.
    await redis.set(keys.lease, 'a-thief', 'PX', 5000);
    redis.emit('reconnecting');

    const result = await resultPromise;
    expect(result.reason).toBe('lease-lost');
    // Promptly, rather than after the full TTL this ticker still believed in.
    expect(result.uptimeMs).toBeLessThan(400);
    expect(await redis.get(keys.lease)).toBe('a-thief');
  });

  it('the ASYNC renew logs its own lease loss, which for a long time only the synchronous finder did', async () => {
    // WHICH DETECTOR FINDS THE LOSS IS DECIDED BY HOW LONG SETUP TAKES, and
    // this case names one of the three, so it may not be paced by real
    // milliseconds. On the real clock the theft was published 15ms in and
    // setup was assumed to have finished by then: a loaded machine that takes
    // longer than the 20ms setup renew period instead has the SETUP renew find
    // it (`finder: 'setup'`, reported before the loop starts), and a first
    // checkpoint issued after the theft has the owner-checked write find it
    // (`finder: 'checkpoint'`). Both are correct behaviour and neither is what
    // this case is about, which is what made it fail once under a mutation
    // that changed nothing here.
    //
    // Setup costs no VIRTUAL time at all, so the theft now lands strictly
    // inside the loop: past the pre-loop `setupLostLease` check, one renew
    // period ahead of the async renew, and a whole lease TTL ahead of the
    // synchronous guard. The checkpoint is stood down the way the other lease
    // cases stand it down, by a `serialize` that throws, so the third finder
    // never issues a write to be refused rather than merely losing a race.
    await onVirtualTime(async (advance) => {
      const redis = new FakeRedis();
      const keys = roomKeys('r-asynclog', NS);
      const logs: LogEvent[] = [];

      const resultPromise = runTicker({
        runtime: makeCounterRuntime({
          tickHz: 50,
          serialize: () => {
            throw new Error('no checkpoint from this room');
          },
        }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r-asynclog',
        namespace: NS,
        leaseTtlMs: 200,
        leaseRenewMs: 20,
        maxRunMs: 2000,
        emptyGraceMs: 2000,
        log: (ev) => logs.push(ev),
      });

      await advance(5);
      await redis.set(keys.lease, 'a-thief', 'PX', 5000);
      await advance(500);

      const result = await resultPromise;
      expect(result.reason).toBe('lease-lost');
      const lines = logs.filter((l) => l.kind === 'ticker.lease-lost');
      expect(lines).toHaveLength(1);
      // A Redis restart that expires every lease in the fleet used to produce
      // this exit with not one line saying so.
      expect(lines[0]?.meta).toMatchObject({ finder: 'renew' });
      // And it really was the ASYNC renew: one renew period in, not the lease
      // TTL the synchronous guard would have waited out.
      expect(result.uptimeMs).toBeLessThan(200);
    });
  });
});

// ---------------------------------------------------------------------------
// TR-A13 / A14 / A15: PRESENCE IS A FACT ABOUT THE ROOM, NOT ABOUT A SOCKET.
// ---------------------------------------------------------------------------
describe('runTicker: presence', () => {
  it('ignores a leave from a relay connection the player has already replaced', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-staleconn', NS);
    const left: string[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        leave: (state, pid) => {
          left.push(pid);
          state.players.delete(pid);
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-staleconn',
      namespace: NS,
      presenceTimeoutMs: 100_000,
      maxRunMs: 500,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice', c: 'conn-1', meta: { name: 'Alice' } }));
    await new Promise((r) => setTimeout(r, 30));
    // The reconnect: a second relay, a second connection id, the same player.
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice', c: 'conn-2', meta: { name: 'Alice' } }));
    await new Promise((r) => setTimeout(r, 30));
    // ...and only NOW does the old relay's close handler fire. Honouring it
    // removes a player sitting in the room on a live socket.
    await redis.publish(keys.in, JSON.stringify({ t: 'leave', pid: 'alice', c: 'conn-1' }));
    await new Promise((r) => setTimeout(r, 60));
    expect(left).toEqual([]);
    expect(await redis.hgetall(keys.meta)).toHaveProperty('alice');

    // The CURRENT connection closing is honoured exactly as before.
    await redis.publish(keys.in, JSON.stringify({ t: 'leave', pid: 'alice', c: 'conn-2' }));
    await new Promise((r) => setTimeout(r, 60));
    expect(left).toEqual(['alice']);
    expect(await redis.hgetall(keys.meta)).not.toHaveProperty('alice');

    await resultPromise;
  });

  it('honours a leave carrying no connection id, as an older relay sends', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-noconn', NS);
    const left: string[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        leave: (state, pid) => {
          left.push(pid);
          state.players.delete(pid);
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-noconn',
      namespace: NS,
      presenceTimeoutMs: 100_000,
      maxRunMs: 300,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'bob', c: 'conn-1' }));
    await new Promise((r) => setTimeout(r, 30));
    await redis.publish(keys.in, JSON.stringify({ t: 'leave', pid: 'bob' }));
    await new Promise((r) => setTimeout(r, 60));

    expect(left).toEqual(['bob']);
    await resultPromise;
  });

  it('admits a reconnect into a FULL room while the simulation still holds the player', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-rejoinfull', NS);
    const rejects: unknown[] = [];
    const observer = redis.fork();
    observer.on('message', (_ch: unknown, msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('room-reject')) rejects.push(msg);
    });
    await observer.subscribe(keys.metaout);

    const grace = { released: false };
    const joins: string[] = [];
    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        // The room is at capacity for anyone NEW from the moment it has a
        // player in it, which is the ordinary state of a 1v1 or a small lobby.
        isFull: (state) => state.players.size > 0,
        join: (state, pid) => {
          joins.push(pid);
          if (!state.players.has(pid)) state.players.set(pid, { counter: 0, playout: false });
        },
        // A disconnect grace: leave starts a countdown, it does not remove.
        leave: () => {},
        presentPids: (state) => (grace.released ? [] : state.players.keys()),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-rejoinfull',
      namespace: NS,
      presenceTimeoutMs: 100_000,
      maxRunMs: 700,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice', c: 'conn-1', meta: { name: 'Alice' } }));
    await new Promise((r) => setTimeout(r, 40));
    // The socket blips. The simulation keeps her; `present` used to not.
    await redis.publish(keys.in, JSON.stringify({ t: 'leave', pid: 'alice', c: 'conn-1' }));
    await new Promise((r) => setTimeout(r, 40));
    // The reconnect. Dropped from `present`, this arrives as a NEW player,
    // meets `isFull`, and is answered with `room-reject`: the grace period the
    // runtime is holding for her is exactly what she cannot use.
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice', c: 'conn-2', meta: { name: 'Alice' } }));
    await new Promise((r) => setTimeout(r, 60));

    expect(rejects).toEqual([]);
    expect(joins).toEqual(['alice', 'alice']);

    // And the roster still follows the SIMULATION: once it lets her go, both
    // the metadata and the presence entry go with her.
    grace.released = true;
    await new Promise((r) => setTimeout(r, 80));
    expect(await redis.hgetall(keys.meta)).not.toHaveProperty('alice');

    await resultPromise;
    observer.disconnect();
  });

  it('names the CONNECTION on a room-reject, so a refusal cannot close the socket it was not aimed at', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-reject-conn', NS);
    const frames: Record<string, unknown>[] = [];
    const observer = redis.fork();
    observer.on('message', (_ch: unknown, msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('room-reject')) frames.push(JSON.parse(msg) as Record<string, unknown>);
    });
    await observer.subscribe(keys.metaout);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice, isFull: () => true }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-reject-conn',
      namespace: NS,
      presenceTimeoutMs: 100_000,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    // A NEW player, refused. A pid holds two live sockets on purpose for a
    // moment (the relay's planned lifetime swap, and every reconnect), and a
    // frame carrying only the pid is matched by BOTH of that player's relays:
    // measured, a refusal aimed at the arriving socket closed the established
    // one too, with both sockets seeing 4002.
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'bob', c: 'conn-new', meta: { name: 'Bob' } }));
    await new Promise((r) => setTimeout(r, 60));
    // ...and one from a relay that predates the connection id at all.
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'carol', meta: { name: 'Carol' } }));
    await new Promise((r) => setTimeout(r, 60));
    await resultPromise;
    observer.disconnect();

    const forBob = frames.find((f) => f.pid === 'bob');
    expect(forBob).toEqual({ t: 'room-reject', pid: 'bob', c: 'conn-new' });

    // A join with no `c` produces the frame this library has always sent, with
    // the key ABSENT rather than present and undefined: an older relay sees
    // exactly what it has always seen and closes on the pid as before.
    const forCarol = frames.find((f) => f.pid === 'carol');
    expect(forCarol).toBeDefined();
    expect('c' in (forCarol as Record<string, unknown>)).toBe(false);
  });

  it('times out a player whose join heartbeat stopped, which no leave envelope ever reported', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-phantom', NS);
    const left: string[] = [];
    const logs: LogEvent[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        leave: (state, pid) => {
          left.push(pid);
          state.players.delete(pid);
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-phantom',
      namespace: NS,
      presenceTimeoutMs: 80,
      statsMs: 25,
      maxRunMs: 500,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });

    await new Promise((r) => setTimeout(r, 10));
    // One join and then silence: the relay died, or its leave landed in a
    // handoff gap. Nothing else in the system ever reports this player gone,
    // so every successor restored them from the meta hash forever.
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'ghost', meta: { name: 'Ghost' } }));
    await new Promise((r) => setTimeout(r, 200));

    expect(left).toEqual(['ghost']);
    expect(await redis.hgetall(keys.meta)).not.toHaveProperty('ghost');
    expect(logs.filter((l) => l.kind === 'ticker.presence-timeout')).toHaveLength(1);
    await resultPromise;
  });

  it('a heartbeating player is never timed out', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-heartbeat', NS);
    const left: string[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        leave: (state, pid) => {
          left.push(pid);
          state.players.delete(pid);
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-heartbeat',
      namespace: NS,
      presenceTimeoutMs: 80,
      statsMs: 25,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 12; i++) {
      await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'steady', meta: { name: 'Steady' } }));
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(left).toEqual([]);
    expect(await redis.hgetall(keys.meta)).toHaveProperty('steady');
    await resultPromise;
  });

  // The coupling this default rests on used to be prose on `presenceTimeoutMs`
  // and two literals in two files: nothing failed if one of them moved. Both
  // sides are written against `JOIN_HEARTBEAT_MS` now, and this is the check
  // that the derived default still leaves room for a lost beat.
  it('the default presence timeout is at least three relay join heartbeats', () => {
    expect(DEFAULT_PRESENCE_TIMEOUT_MS).toBeGreaterThanOrEqual(3 * JOIN_HEARTBEAT_MS);
  });
});

// ---------------------------------------------------------------------------
// TR-A25: THE INPUT WINDOW'S OWN EDGES.
// ---------------------------------------------------------------------------
describe('runTicker: what a window of records means', () => {
  it('an unstamped record supersedes the stamped ones EARLIER in its own window', async () => {
    // The single pass this replaced pushed each stamped record as it went and
    // then had `dropPlayout` throw the whole buffer away on reaching the
    // unstamped one, so a window ordered [stamped, unstamped] left nothing
    // buffered: the player dismounted and their pre-dismount input went with
    // them. Collecting and pushing at the end without honouring that ordering
    // lets the stamped record survive the very thing that supersedes it.
    const redis = new FakeRedis();
    const keys = roomKeys('r-window-edges', NS);
    const buffered: number[] = [];
    const immediate: number[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        applyBufferedInput: (_state, _pid, input) => buffered.push(input.seq),
        applyInput: (_state, _pid, input) => immediate.push(input.seq),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-window-edges',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(
      keys.in,
      JSON.stringify({
        t: 'in',
        pid: 'alice',
        w: [
          { seq: 1, targetTick: 8, data: 1 }, // pre-dismount, superseded below
          { seq: 2, data: 1 }, // the dismount
          { seq: 3, targetTick: 9, data: 1 }, // the stream that is still running
        ],
      })
    );
    await resultPromise;

    expect(immediate).toEqual([2]);
    // Only what came AFTER the dismount is buffered.
    expect(buffered).toEqual([3]);
  });

  it('a targetTick that is not a finite integer is treated as unstamped, never buffered', async () => {
    // `(input.targetTick ?? 0) > 0` is true for the string "5", which then
    // keys the buffer's entries Map by a string no numeric consume can ever
    // match: buffered, starving every tick it should have fed, evicted in
    // silence. A host decoder bug rather than an abusive sender, so nothing is
    // counted for it, but the buffer must not be poisoned by it either.
    const redis = new FakeRedis();
    const keys = roomKeys('r-badtick', NS);
    const buffered: number[] = [];
    const immediate: number[] = [];
    const stats: RoomStats[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        applyBufferedInput: (_state, _pid, input) => buffered.push(input.seq),
        applyInput: (_state, _pid, input) => immediate.push(input.seq),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-badtick',
      namespace: NS,
      statsMs: 50,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      onStats: (st) => stats.push(st),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(
      keys.in,
      JSON.stringify({
        t: 'in',
        pid: 'alice',
        w: [
          { seq: 1, targetTick: '9', data: 1 },
          { seq: 2, targetTick: 9.5, data: 1 },
          { seq: 3, targetTick: Number.NaN, data: 1 },
        ],
      })
    );
    await resultPromise;

    expect(buffered).toEqual([]);
    expect(immediate).toEqual([1, 2, 3]);
    // A host's own codec handing over the wrong type is not a broken sender
    // and not a throwing simulation, so neither counter moves.
    expect(stats.reduce((n, st) => n + st.badEnvelopes, 0)).toBe(0);
    expect(stats.reduce((n, st) => n + st.hostErrors, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TR-A26: `pid` IS A KEY, AND A KEY OFF THE WIRE IS VALIDATED AT THE DOOR.
// ---------------------------------------------------------------------------
describe('runTicker: the pid a client claims', () => {
  const HOSTILE = [
    { t: 'join' }, // absent
    { t: 'join', pid: 123 },
    { t: 'join', pid: 1.5 },
    { t: 'join', pid: null },
    { t: 'join', pid: { a: 1 } },
    { t: 'join', pid: ['x'] },
    { t: 'join', pid: true },
    { t: 'join', pid: '' },
    { t: 'join', pid: 'x'.repeat(129) },
  ];

  it('keeps a pid that is not a non-empty bounded string out of the roster entirely', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-pid-shape', NS);
    const stats: RoomStats[] = [];
    const rosters: Record<string, unknown>[] = [];
    const observer = redis.fork();
    observer.on('message', (_ch: unknown, msg: unknown) => {
      if (typeof msg !== 'string') return;
      const f = JSON.parse(msg) as { t?: string; map?: Record<string, unknown> };
      if (f.t === 'meta' && f.map !== undefined) rosters.push(f.map);
    });
    await observer.subscribe(keys.metaout);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-pid-shape',
      namespace: NS,
      statsMs: 50,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      onStats: (st) => stats.push(st),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    for (const env of HOSTILE) await redis.publish(keys.in, JSON.stringify(env));
    // One legitimate join, so the assertions below are about a channel that
    // was genuinely working rather than one nothing reached.
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice', meta: { name: 'Alice' } }));
    await resultPromise;
    observer.disconnect();

    // A pid is a Map key, a Redis hash FIELD and a roster entry every client
    // renders. Measured over 20,000 fuzz envelopes before this check, the hash
    // came back with fields named "123", "[object Object]", "__proto__",
    // "constructor", "null", "undefined" and "1.5".
    expect(Object.keys(await redis.hgetall(keys.meta))).toEqual(['alice']);
    expect(rosters.length).toBeGreaterThan(0);
    expect(rosters[rosters.length - 1]).toEqual({ alice: { name: 'Alice' } });
    // Counted as what they are: a broken or hostile SENDER.
    expect(stats.reduce((n, st) => n + st.badEnvelopes, 0)).toBe(HOSTILE.length);
    expect(stats.reduce((n, st) => n + st.unknownEnvelopes, 0)).toBe(0);
  });

  it('a non-string pid cannot skip the per-sender quota and crowd out a real player', async () => {
    // `envelopePid` returns null for a non-string pid and the Inbox reads null
    // as "no sender", so such an envelope bypassed the per-sender quota
    // entirely: 64 accepted for a real pid against 4096 for a forged one,
    // which hands the flooder exactly the advantage the quota exists to deny.
    const redis = new FakeRedis();
    const keys = roomKeys('r-pid-quota', NS);
    const applied: number[] = [];
    const stats: RoomStats[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        applyInput: (_state, _pid, input) => applied.push(input.seq),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-pid-quota',
      namespace: NS,
      statsMs: 50,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      onStats: (st) => stats.push(st),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    // A flood far past the per-sender quota, all of it senderless as far as
    // the Inbox is concerned.
    for (let i = 0; i < 400; i++) {
      await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 12345, w: [{ seq: 9000 + i, data: 1 }] }));
    }
    // ...and one real player's inputs, which must all survive it.
    for (let i = 0; i < 10; i++) {
      await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: i, data: 1 }] }));
    }
    await resultPromise;

    expect(applied.filter((seq) => seq >= 9000)).toEqual([]); // none of the flood was applied
    expect(applied.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(stats.reduce((n, st) => n + st.badEnvelopes, 0)).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// TR-A27: THE META HASH IS UNTRUSTED INPUT TOO.
// ---------------------------------------------------------------------------
describe('runTicker: restoring a hostile roster hash', () => {
  it('republishes only the entries that are actually objects, and says how many it dropped', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-meta-hostile', NS);
    // Every one of these is valid JSON, which is the whole trap: `JSON.parse`
    // succeeding says the bytes were JSON and nothing about their SHAPE.
    await redis.hset(keys.meta, 'alice', JSON.stringify({ name: 'Alice' }));
    await redis.hset(keys.meta, 'bob', '1');
    await redis.hset(keys.meta, 'carol', 'null');
    await redis.hset(keys.meta, 'dave', '[1,2]');
    await redis.hset(keys.meta, 'erin', '"just a string"');
    await redis.hset(keys.meta, 'frank', 'not json at all{{');

    const rosters: Record<string, unknown>[] = [];
    const logs: LogEvent[] = [];
    const observer = redis.fork();
    observer.on('message', (_ch: unknown, msg: unknown) => {
      if (typeof msg !== 'string') return;
      const f = JSON.parse(msg) as { t?: string; map?: Record<string, unknown> };
      if (f.t === 'meta' && f.map !== undefined) rosters.push(f.map);
    });
    await observer.subscribe(keys.metaout);

    await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-meta-hostile',
      namespace: NS,
      maxRunMs: 300,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });
    observer.disconnect();

    expect(rosters.length).toBeGreaterThan(0);
    // Only the entry that is genuinely a bag of fields survives; the rest were
    // being republished to every client as if a player carried them.
    expect(rosters[0]).toEqual({ alice: { name: 'Alice' } });
    // ONE line per restore, carrying the count rather than the values.
    const refused = logs.filter((l) => l.kind === 'ticker.meta-restore-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.meta).toMatchObject({ count: 5 });
  });
});

// ---------------------------------------------------------------------------
// TR-A30: THE AHEAD BOUND IS A DURATION, NOT A TICK COUNT.
// ---------------------------------------------------------------------------
describe('runTicker: the playout ahead bound scales with the tick rate', () => {
  /**
   * Runs a room at `hz`, lets the buffer ANCHOR ON THE CONSUMER first, then
   * publishes a redundancy window from a WORST-CASE FOREIGN SENDER: one that
   * stamps a full `leadMs` ahead of the server's CURRENT tick and delivers with
   * zero transit. That is a legal client of the documented wire and it is the
   * sender the duration sizing exists for.
   *
   * IT IS NOT `RoomConnection`, and the difference is the whole point. This
   * library's own client stamps `desiredTick()`, which adds a round trip on top
   * of a server-tick estimate that LAGS by the downstream one-way, and the
   * stamp then spends the upstream one-way in flight, so the round trip cancels
   * and its records arrive `leadTicks + feedbackTicks` from the floor whatever
   * the RTT, capped at `PLAYOUT_MAX_AHEAD / 2` (20 ticks) by `connection.ts`.
   * It cannot reach this bound at any tick rate.
   *
   * The anchoring step is load-bearing and not scaffolding: a FRESH buffer
   * measures its ahead bound from its own first push (see `aheadBase`), so any
   * self-consistent window is admissible at any rate and the bound cannot bite
   * at all. It only becomes a bound once a consume has happened and the
   * reference is the consumer's real position, which is the steady state every
   * real room is in.
   */
  async function refusedFor(hz: number, leadMs: number, room: string): Promise<{ refused: number; anchored: boolean }> {
    const redis = new FakeRedis();
    const keys = roomKeys(room, NS);
    const stats: RoomStats[] = [];
    const tickMs = 1000 / hz;
    const applied: number[] = [];
    let roomTick = 0;

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: hz,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        tick: (state) => {
          state.tick += 1;
          roomTick = state.tick;
          return {};
        },
        applyBufferedInput: (_state, _pid, input) => applied.push(input.seq),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: room,
      namespace: NS,
      statsMs: 60,
      maxRunMs: 700,
      emptyGraceMs: 100_000,
      onStats: (st) => stats.push(st),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 30));
    // Anchor: one record just ahead of the consumer, which lands and is then
    // consumed, so the floor tracks the room from here on.
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: roomTick + 2, data: 1 }] })
    );
    await new Promise((r) => setTimeout(r, Math.max(60, tickMs * 5)));

    // Now the real window, stamped for a client whose lead is a round trip.
    const lead = Math.round(leadMs / tickMs);
    const base = roomTick + lead;
    const w: ClientInput[] = [];
    for (let k = 5; k >= 0; k--) w.push({ seq: 100 - k, targetTick: base + (5 - k), data: 1 });
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w }));
    await resultPromise;

    return { refused: stats.reduce((n, st) => n + st.refusedInputs, 0), anchored: applied.includes(1) };
  }

  it('a foreign sender stamping 700ms ahead is tolerated the same at 60Hz as at 20Hz', async () => {
    // A FIXED TICK COUNT MEANS DIFFERENT AMOUNTS OF TIME AT DIFFERENT RATES.
    // 40 ticks is two seconds at 20Hz and 667ms at 60Hz, so this sender is
    // refused at 60Hz and admitted at 20Hz for no reason to do with the sender:
    // the constant simply stopped being the two seconds it was chosen as.
    // Sized as a duration it means the same thing everywhere.
    //
    // `RoomConnection` is not this sender and never hits the bound at all (see
    // the helper above); what is being pinned here is that the tolerance a
    // third-party client of the documented wire receives does not shrink just
    // because the host raised `tickHz`.
    const { refused, anchored } = await refusedFor(60, 700, 'r-ahead-60');
    expect(anchored).toBe(true); // the buffer really was tracking the consumer
    expect(refused).toBe(0);
  });

  it('CONTROL: 20Hz is byte-identical, because two seconds of ticks there IS the old literal', async () => {
    const { refused, anchored } = await refusedFor(20, 700, 'r-ahead-20');
    expect(anchored).toBe(true);
    expect(refused).toBe(0);
  });

  it('counts a stamp that really is past the bound, so the cause finally has a name', async () => {
    // Without a counter the only symptom was starves climbing, which is
    // indistinguishable from packet loss and points at the network rather than
    // at the one setting that would fix it.
    const redis = new FakeRedis();
    const keys = roomKeys('r-ahead-refused', NS);
    const stats: RoomStats[] = [];
    const applied: number[] = [];
    let roomTick = 0;

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        tick: (state) => {
          state.tick += 1;
          roomTick = state.tick;
          return {};
        },
        applyBufferedInput: (_state, _pid, input) => applied.push(input.seq),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-ahead-refused',
      namespace: NS,
      playoutMaxAhead: 4, // an explicit host bound, which the default never overrides
      statsMs: 60,
      maxRunMs: 600,
      emptyGraceMs: 100_000,
      onStats: (st) => stats.push(st),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 30));
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: roomTick + 2, data: 1 }] })
    );
    await new Promise((r) => setTimeout(r, 100));
    // Two stamps far past the configured bound, one inside it.
    await redis.publish(
      keys.in,
      JSON.stringify({
        t: 'in',
        pid: 'alice',
        w: [
          { seq: 2, targetTick: roomTick + 2, data: 1 },
          { seq: 3, targetTick: roomTick + 400, data: 1 },
          { seq: 4, targetTick: roomTick + 500, data: 1 },
        ],
      })
    );
    await resultPromise;

    expect(applied).toContain(1);
    expect(stats.reduce((n, st) => n + st.refusedInputs, 0)).toBe(2);
  });

  it('a healthy redundancy window counts NO refusals, however many re-sends it carries', async () => {
    // The stale path is a redundancy window working exactly as designed, and
    // folding it into this counter would report a permanently sick sender for
    // a permanently healthy one: the same trap `lateInputs` was moved out of.
    const redis = new FakeRedis();
    const keys = roomKeys('r-ahead-healthy', NS);
    const stats: RoomStats[] = [];
    let roomTick = 0;

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        tick: (state) => {
          state.tick += 1;
          roomTick = state.tick;
          return {};
        },
        applyBufferedInput: () => {},
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-ahead-healthy',
      namespace: NS,
      statsMs: 60,
      maxRunMs: 600,
      emptyGraceMs: 100_000,
      onStats: (st) => stats.push(st),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 30));
    for (let packet = 0; packet < 15; packet++) {
      const base = roomTick;
      if (base >= 4) {
        const w: ClientInput[] = [];
        for (let k = -3; k <= 2; k++) w.push({ seq: base + k, targetTick: base + k, data: 1 });
        await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w }));
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await resultPromise;

    expect(roomTick).toBeGreaterThan(15);
    expect(stats.reduce((n, st) => n + st.refusedInputs, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TR-A31: THE ROSTER PRUNE TAKES THE PLAYOUT STATE WITH IT.
// ---------------------------------------------------------------------------
describe('runTicker: pruning a player the simulation forgot', () => {
  it('drops the playout buffer, the starvation streak and the late baseline, not just the roster', async () => {
    // A `leave` drops all of it, but a runtime with a disconnect grace never
    // produces one for the player it eventually forgets: it just stops
    // reporting them from `presentPids`. Their buffer, streak and late-count
    // baseline then sat in these maps for the rest of the ROOM's life, and a
    // grace runtime is exactly the kind that cycles many players through one
    // long-lived ticker.
    const redis = new FakeRedis();
    const keys = roomKeys('r-prune-playout', NS);
    const grace = { released: false };
    const health: { pid: string; h: number }[] = [];
    let starves = 0;

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        usesPlayout: () => true,
        leave: () => {
          /* a grace: the sim keeps them until it says otherwise */
        },
        presentPids: (state) => (grace.released ? [] : state.players.keys()),
        onStarve: () => {
          starves++;
        },
        onBufferHealth: (_state, pid, h) => health.push({ pid, h }),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-prune-playout',
      namespace: NS,
      presenceTimeoutMs: 100_000,
      maxRunMs: 800,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice', meta: { name: 'Alice' } }));
    // A stamp this run will never reach, so the buffer starves every tick and
    // is unmistakably still there.
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: 9000, data: 1 } satisfies ClientInput] })
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(starves).toBeGreaterThan(0);

    // Now the simulation forgets her. No `leave` is ever produced.
    grace.released = true;
    await new Promise((r) => setTimeout(r, 80));
    const starvesAtPrune = starves;
    await new Promise((r) => setTimeout(r, 200));

    // The buffer is gone, so nothing starves for her any more.
    expect(starves).toBe(starvesAtPrune);
    // And it went through the same teardown a leave uses: a final health of 0,
    // so no stale depth is left pinned on the wire for a player who has none.
    expect(health[health.length - 1]).toEqual({ pid: 'alice', h: 0 });
    await resultPromise;
  });
});

// ---------------------------------------------------------------------------
// TR-A32: A REFUSAL IS ANSWERED ONCE, NOT ONCE PER JOIN.
// ---------------------------------------------------------------------------
describe('runTicker: rejecting a join into a full room', () => {
  it('answers a burst of joins for one refused pid with a single reject', async () => {
    // The reject goes out on the ROSTER channel, which fans out to every socket
    // in the room, so a producer that can pick the join rate picks the reject
    // rate too: one refused pid becomes a Redis and fan-out amplifier against
    // the rule every other client-rate path here follows.
    const redis = new FakeRedis();
    const keys = roomKeys('r-reject-flood', NS);
    const rejects: string[] = [];
    const stats: RoomStats[] = [];
    const observer = redis.fork();
    observer.on('message', (_ch: unknown, msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('room-reject')) rejects.push(msg);
    });
    await observer.subscribe(keys.metaout);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice, isFull: () => true }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-reject-flood',
      namespace: NS,
      statsMs: 60,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      onStats: (st) => stats.push(st),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 50; i++) {
      await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'bob', c: `conn-${i}` }));
    }
    await new Promise((r) => setTimeout(r, 60));
    await resultPromise;
    observer.disconnect();

    expect(rejects).toHaveLength(1);
    // The other 49 are counted rather than silently dropped, so the flood is
    // visible without being amplified.
    expect(stats.reduce((n, st) => n + st.rejectsSuppressed, 0)).toBe(49);
  });

  it('a DIFFERENT refused pid is still answered, so the limit is per player', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-reject-perpid', NS);
    const rejected: string[] = [];
    const observer = redis.fork();
    observer.on('message', (_ch: unknown, msg: unknown) => {
      if (typeof msg !== 'string') return;
      const f = JSON.parse(msg) as { t?: string; pid?: string };
      if (f.t === 'room-reject' && f.pid !== undefined) rejected.push(f.pid);
    });
    await observer.subscribe(keys.metaout);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice, isFull: () => true }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-reject-perpid',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    for (const pid of ['bob', 'bob', 'carol', 'carol', 'dave']) {
      await redis.publish(keys.in, JSON.stringify({ t: 'join', pid }));
    }
    await new Promise((r) => setTimeout(r, 60));
    await resultPromise;
    observer.disconnect();

    // One each: a shared budget would refuse to tell carol and dave anything.
    expect(rejected.sort()).toEqual(['bob', 'carol', 'dave']);
  });
});

// ---------------------------------------------------------------------------
// TR-A16: EARLY IS NOT STARVED.
// ---------------------------------------------------------------------------
describe('runTicker: a buffer holding later inputs is not a starving one', () => {
  it('holds the last input instead of decaying it while the buffer still has entries', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-early', NS);
    const streaks: number[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        onStarve: (_state, _pid, streak) => streaks.push(streak),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-early',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    // The shape EVERY handoff produces: the client's tick counter kept
    // advancing at wall-clock rate through the gap while the server's stood
    // still, so its inputs are stamped for ticks this room has not reached.
    // Nothing is lost; the two clocks simply disagree about "now".
    await redis.publish(
      keys.in,
      JSON.stringify({
        t: 'in',
        pid: 'alice',
        w: [
          { seq: 1, targetTick: 14, data: 1 },
          { seq: 2, targetTick: 15, data: 1 },
          { seq: 3, targetTick: 16, data: 1 },
        ] satisfies ClientInput[],
      })
    );
    await resultPromise;

    expect(streaks.length).toBeGreaterThan(3);
    // Reported as a starve (the tick genuinely had nothing to apply) but at
    // streak 1, which is repeat-last. Running the streak here decays a held
    // control toward neutral while the input that should drive it sits in the
    // buffer: measured after a 600ms handoff at 16 starves and half a second
    // of a held stick reading as released.
    const beforeFirstApply = streaks.slice(0, 8);
    expect(beforeFirstApply.every((s) => s === 1)).toBe(true);
  });

  it('CONTROL: a genuinely EMPTY buffer still ramps the streak, which is the sawtooth backstop', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-empty-buf', NS);
    const streaks: number[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        onStarve: (_state, _pid, streak) => streaks.push(streak),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-empty-buf',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    // One input, consumed on tick 3, after which the buffer is genuinely empty
    // and this player's packets have simply stopped arriving.
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: 3, data: 1 } satisfies ClientInput] })
    );
    await resultPromise;

    expect(streaks.length).toBeGreaterThan(3);
    expect(Math.max(...streaks)).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// TR-A17: A TRANSIENTLY FAILED ROSTER BROADCAST IS RETRIED.
// ---------------------------------------------------------------------------
describe('runTicker: the roster broadcast', () => {
  it('retries a roster the bus rejected, where a broken formatter is still never retried', async () => {
    const keys = roomKeys('r-metaretry', NS);
    // Two failures: the dirty-on-start flush, then the join's own broadcast.
    // Without the retry there is no third publish at all, because nothing
    // marks the map dirty again and every client keeps a stale roster.
    const redis = new FlakyPublishRedis(keys.metaout, 2);
    const seen: string[] = [];
    const observer = redis.fork();
    observer.on('message', (_ch: unknown, msg: unknown) => {
      if (typeof msg === 'string') seen.push(msg);
    });
    await observer.subscribe(keys.metaout);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-metaretry',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 20));
    await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice', meta: { name: 'Alice' } }));
    await resultPromise;
    observer.disconnect();

    const rosters = seen.map((s) => JSON.parse(s) as { t?: string; map?: Record<string, unknown> }).filter((f) => f.t === 'meta');
    expect(rosters.length).toBeGreaterThan(0);
    expect(rosters[rosters.length - 1]?.map).toEqual({ alice: { name: 'Alice' } });
  });
});

// ---------------------------------------------------------------------------
// TR-A18: THE PLANNED HANDOFF, WITHOUT THE GAP.
// ---------------------------------------------------------------------------
describe('runTicker: the standby successor', () => {
  it('polls for the lease instead of returning busy, and takes over the moment it is free', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-standby', NS);
    await acquireLease(redis, keys.lease, 'the-incumbent', { leaseTtlMs: 5000 });

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-standby',
      namespace: NS,
      standbyMs: 600,
      maxRunMs: 120,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 120));
    // The incumbent reaches its own duration cap and releases.
    await redis.del(keys.lease);

    const result = await resultPromise;
    expect(result.reason).toBe('duration');
    expect(result.ticks).toBeGreaterThan(0);
  });

  it('gives up as busy once standbyMs is spent', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-standby-busy', NS);
    await acquireLease(redis, keys.lease, 'the-incumbent', { leaseTtlMs: 5000 });
    const init = vi.fn().mockResolvedValue(undefined);

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50 }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-standby-busy',
      namespace: NS,
      standbyMs: 120,
      init,
      emptyGraceMs: 10,
      log: () => {},
    });

    expect(result.reason).toBe('busy');
    // AND IT PAID `init` FIRST, which is the whole point of a standby: it is
    // the designated successor, so there are no acquire-race losers to protect
    // and the wait is exactly when the cold start should be paid. The
    // non-standby path still runs `init` behind the acquire; see the case
    // named for it above.
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('spends its standby poll out of maxRunMs, because the platform is timing the INVOCATION', async () => {
    // `maxRunMs` exists to get this ticker out of the way before the platform
    // kills it, and the platform starts its clock when the function is CALLED.
    // Measured from the acquire instead, a standby that polls for four seconds
    // outlives its own budget by four seconds, which is time the host's fit
    // check never accounted for and the platform will not grant.
    const redis = new FakeRedis();
    const keys = roomKeys('r-standby-clock', NS);
    await acquireLease(redis, keys.lease, 'the-incumbent', { leaseTtlMs: 5000 });
    const entered = Date.now();

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-standby-clock',
      namespace: NS,
      standbyMs: 900,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    // The incumbent holds the lease for 150ms of that 400ms budget.
    await new Promise((r) => setTimeout(r, 150));
    await redis.del(keys.lease);
    const result = await resultPromise;
    const elapsed = Date.now() - entered;

    expect(result.reason).toBe('duration');
    expect(result.ticks).toBeGreaterThan(0); // it really did own and tick the room
    // THE MEASURE IS WALL TIME AND WHETHER `uptimeMs` ACCOUNTS FOR IT, not
    // `uptimeMs` alone: dated from the acquire, `uptimeMs` still reads about
    // `maxRunMs` and looks perfectly healthy while the invocation has actually
    // been alive for the poll on top of it. The two only disagree here.
    expect(result.uptimeMs).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(520);
    expect(result.uptimeMs).toBeGreaterThanOrEqual(elapsed - 50);
  });

  it('spawns the standby before the cap and does NOT spawn again on the way out', async () => {
    const redis = new FakeRedis();
    const spawn = vi.fn().mockResolvedValue(undefined);

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-lead',
      namespace: NS,
      maxRunMs: 300,
      standbyLeadMs: 120,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: () => {},
    });

    expect(result.reason).toBe('duration');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('r-lead', { standby: true });
  });

  it('still spawns on the way out when the exit was NOT the planned one, EVEN THOUGH a standby was already sent', async () => {
    // THE CASE THIS PINS ONLY EXISTS ONCE THE STANDBY HAS ACTUALLY FIRED. The
    // earlier version of this test set a lead of 100ms against a 2000ms cap
    // and stole the lease at 15ms, so the standby threshold was never reached
    // and `standbySpawned` was false the whole time: the exit spawn happened
    // because nothing had suppressed it, not because the suppression is
    // correctly scoped to a PLANNED exit. Deleting `exitReason === 'duration'`
    // from that condition left it green.
    const redis = new FakeRedis();
    const keys = roomKeys('r-lead-lost', NS);
    const spawn = vi.fn().mockResolvedValue(undefined);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-lead-lost',
      namespace: NS,
      leaseTtlMs: 3000,
      leaseRenewMs: 40,
      // The standby is due 100ms in, so it is long gone before the theft.
      maxRunMs: 2000,
      standbyLeadMs: 1900,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(spawn).toHaveBeenCalledWith('r-lead-lost', { standby: true });
    await redis.set(keys.lease, 'a-thief', 'PX', 5000);
    const result = await resultPromise;

    // A lost lease is not the handoff this ticker arranged: the standby it
    // sent is going to lose its acquire to the thief, so the exit spawn is
    // still owed and nobody else has been told to start.
    expect(result.reason).toBe('lease-lost');
    expect(spawn).toHaveBeenCalledWith('r-lead-lost', { standby: false });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('a REFUSED standby does not suppress the exit spawn, so the room does not go dark', async () => {
    // A cold start refused, a 429, a DNS failure. The standby never started,
    // and a flag set on ISSUE and never cleared told the exit that a successor
    // existed: the room then sat with no ticker at all until some relay's
    // jittered poll noticed, which is the gap the whole standby mechanism
    // exists to remove.
    const redis = new FakeRedis();
    const calls: { standby: boolean }[] = [];
    const spawn = vi.fn(async (_room: string, opts: { standby: boolean }) => {
      calls.push(opts);
      if (opts.standby) throw new Error('429 Too Many Requests');
      return undefined;
    });

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-standby-refused',
      namespace: NS,
      maxRunMs: 400,
      standbyLeadMs: 300,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: () => {},
    });

    expect(result.reason).toBe('duration');
    expect(calls).toEqual([{ standby: true }, { standby: false }]);
  });

  it('a standby that is still in flight DOES suppress it, because that is the ordinary case', async () => {
    // A host's spawn is an authenticated request to the ticker endpoint, and
    // that endpoint does not RESPOND until the successor itself exits, minutes
    // later. A flag set only when the promise resolves is therefore never true
    // at exit time, and the standby buys nothing at all.
    const redis = new FakeRedis();
    const spawn = vi.fn(
      async (_room: string, opts: { standby: boolean }) =>
        opts.standby ? new Promise<unknown>(() => {}) : undefined
    );

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-standby-inflight',
      namespace: NS,
      maxRunMs: 400,
      standbyLeadMs: 300,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: () => {},
    });

    expect(result.reason).toBe('duration');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('r-standby-inflight', { standby: true });
  });

  it('a spawnSuccessor that throws SYNCHRONOUSLY does not turn a healthy duration exit into an error', async () => {
    // The signature says it returns a promise, and a plain function that
    // validates its arguments and throws satisfies that type right up until it
    // runs. Called bare, that throw lands before `.then`/`.catch` are
    // attached: it escapes into the loop body, the loop's catch reads it as a
    // simulation failure, and the room loses its final checkpoint AND its
    // successor and gains a crash count, all for a bug in the spawn call.
    const redis = new FakeRedis();
    const keys = roomKeys('r-spawn-sync-standby', NS);
    const calls: { standby: boolean }[] = [];
    const spawn = ((_room: string, opts: { standby: boolean }) => {
      calls.push(opts);
      if (opts.standby) throw new Error('spawn threw synchronously');
      return Promise.resolve(undefined);
    }) as unknown as (roomId: string, opts: { standby: boolean }) => Promise<unknown>;

    const result = await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-spawn-sync-standby',
      namespace: NS,
      maxRunMs: 400,
      standbyLeadMs: 300,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: () => {},
    });

    expect(result.reason).toBe('duration');
    // A synchronous throw is a REFUSED standby, exactly like a rejection, so
    // the exit spawn is still owed and the room does not go dark.
    expect(calls).toEqual([{ standby: true }, { standby: false }]);
    // The room exited healthily: its state was saved and nothing was counted
    // against it.
    expect(await readCheckpoint(redis, keys.state)).not.toBeNull();
    expect(await redis.get(keys.crashes)).toBeNull();
  });

  it('a synchronously throwing EXIT spawn still runs dispose, the subscriber close and the listener detach', async () => {
    // Worse than a wrong exit reason: a synchronous throw from the exit spawn
    // escapes the `finally` block itself, so every teardown line BELOW it is
    // skipped and `runTicker` rejects instead of returning. The leaks are
    // exactly the ones that teardown exists to prevent.
    const redis = new FakeRedis();
    let live = 0;
    let disposed = 0;
    const spawn = (() => {
      throw new Error('spawn threw synchronously');
    }) as unknown as (roomId: string, opts: { standby: boolean }) => Promise<unknown>;

    const result = await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        dispose: () => {
          disposed++;
        },
      }),
      redis,
      createSubscriber: () => {
        live++;
        const sub = redis.fork();
        const realDisconnect = sub.disconnect.bind(sub);
        sub.disconnect = (): void => {
          live--;
          realDisconnect();
        };
        return sub;
      },
      roomId: 'r-spawn-sync-exit',
      namespace: NS,
      maxRunMs: 200,
      standbyLeadMs: 100_000, // no standby: the EXIT spawn is the one that throws
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: () => {},
    });

    // It RETURNED rather than rejecting...
    expect(result.reason).toBe('duration');
    // ...and everything after the spawn in `finally` ran.
    expect(disposed).toBe(1);
    expect(live).toBe(0);
    expect(redis.listenerCount('reconnecting')).toBe(0);
  });

  it('fires the standby ONCE, not on every remaining iteration', async () => {
    const redis = new FakeRedis();
    const spawn = vi.fn().mockRejectedValue(new Error('refused'));
    await runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-standby-once',
      namespace: NS,
      maxRunMs: 400,
      standbyLeadMs: 300,
      emptyGraceMs: 100_000,
      spawnSuccessor: spawn,
      log: () => {},
    });
    // Fifteen iterations pass the threshold; a rejection must not turn the
    // retry the exit owes into a spawn storm while the room is still running.
    const standbyCalls = spawn.mock.calls.filter((c) => (c[1] as { standby: boolean }).standby);
    expect(standbyCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TR-A1: THE NEW GAUGES, AND THE WINDOW THEY MEASURE.
// ---------------------------------------------------------------------------
describe('runTicker: the new stats fields are per-window, like every other counter', () => {
  it('reports late inputs as a window DELTA, not a lifetime total', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-late', NS);
    const stats: RoomStats[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        applyBufferedInput: () => {},
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-late',
      namespace: NS,
      statsMs: 40,
      maxRunMs: 500,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    // Establish the buffer, let the consumer walk past that tick...
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: 2, data: 1 } satisfies ClientInput] })
    );
    await new Promise((r) => setTimeout(r, 120));
    // ...then send a stamp that has already passed, which is the never-drop-late
    // re-stamp this counter exists to surface.
    await redis.publish(
      keys.in,
      JSON.stringify({
        t: 'in',
        pid: 'alice',
        w: [
          { seq: 2, targetTick: 3, data: 1 },
          { seq: 3, targetTick: 4, data: 1 },
        ] satisfies ClientInput[],
      })
    );
    await resultPromise;

    const total = stats.reduce((n, s) => n + s.lateInputs, 0);
    expect(total).toBeGreaterThan(0);
    // A LIFETIME total re-reported every window would keep climbing long after
    // the link recovered; the last windows of this run saw no late pushes at
    // all and must say so.
    expect(stats[stats.length - 1]?.lateInputs).toBe(0);
    // And a window's own count never exceeds what was actually re-stamped.
    expect(total).toBeLessThanOrEqual(2);
  });

  it('resets hostErrors every flush like every other counter here', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-hosterr-reset', NS);
    const stats: RoomStats[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: withAlice,
        applyInput: () => {
          throw new Error('nope');
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-hosterr-reset',
      namespace: NS,
      statsMs: 40,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, data: 1 }] }));
    await new Promise((r) => setTimeout(r, 150));
    await resultPromise;

    expect(stats.some((s) => s.hostErrors > 0)).toBe(true);
    // A counter that never reset would make one bad input look like a room
    // still throwing every second.
    expect(stats[stats.length - 1]?.hostErrors).toBe(0);
    expect(stats.reduce((n, s) => n + s.hostErrors, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TR-A20: THE REDUNDANCY WINDOW IS BUFFERED NEWEST FIRST.
//
// `PlayoutBuffer.push` re-stamps an already-consumed record onto
// `lastConsumed + 1` unless that slot already holds something at least as
// fresh, and counts a late input only when the push actually LANDS. The window
// arrives oldest first (`codec/snapshot.ts` sends newest last), so pushed in
// array order every record in a behind-schedule window is fresher than the one
// before it: each in turn lands on that one slot and each is counted, so ONE
// late packet reports as six late inputs. Pushed newest first the freshest
// record takes the slot and every older duplicate behind it is refused without
// counting, which is the honest reading: one packet arrived late.
// ---------------------------------------------------------------------------
describe('runTicker: the input window goes into the buffer newest first', () => {
  it('counts a behind-schedule window as ONE late input, not one per record in it', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-window-late', NS);
    const stats: RoomStats[] = [];
    let roomTick = 0;

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        tick: (state) => {
          state.tick += 1;
          roomTick = state.tick;
          return {};
        },
        applyBufferedInput: () => {},
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-window-late',
      namespace: NS,
      statsMs: 60,
      maxRunMs: 700,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 40));
    // A client whose stamping lead has collapsed: every record in every packet
    // names a tick this room has already consumed. That is exactly the state
    // this gauge exists to surface, and exactly the state in which the order
    // decides whether it reports the truth or six times it.
    let packets = 0;
    for (let i = 0; i < 10; i++) {
      const base = roomTick;
      if (base >= 10) {
        const w: ClientInput[] = [];
        for (let k = 8; k >= 3; k--) w.push({ seq: base - k, targetTick: base - k, data: 1 });
        await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w }));
        packets++;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    await resultPromise;

    const late = stats.reduce((n, s) => n + s.lateInputs, 0);
    expect(packets).toBeGreaterThan(5); // non-vacuity: windows really were sent
    expect(late).toBeGreaterThan(0); // and really were late
    // One landing per packet, not one per record. Pushed oldest first this is
    // the window size times the packet count, which is a client six times
    // sicker than it is.
    expect(late).toBeLessThanOrEqual(packets + 1);
  });

  it('CONTROL: a healthy lead reports no late inputs at all', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-window-ok', NS);
    const stats: RoomStats[] = [];
    let roomTick = 0;

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        tick: (state) => {
          state.tick += 1;
          roomTick = state.tick;
          return {};
        },
        applyBufferedInput: () => {},
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-window-ok',
      namespace: NS,
      statsMs: 60,
      maxRunMs: 700,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 30));
    // The same six-record window at a steady two-tick lead, which is what a
    // healthy client sends: half of it re-sends ticks already consumed, and
    // none of that is lateness. A gauge that counted those would read
    // permanently sick on a permanently healthy link.
    for (let i = 0; i < 20; i++) {
      const base = roomTick;
      if (base >= 4) {
        const w: ClientInput[] = [];
        for (let k = -3; k <= 2; k++) w.push({ seq: base + k, targetTick: base + k, data: 1 });
        await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w }));
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await resultPromise;

    expect(roomTick).toBeGreaterThan(20);
    expect(stats.reduce((n, s) => n + s.lateInputs, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE GUARDS A MUTATION SWEEP FOUND UNPINNED. Every case below was written
// against a NAMED mutation of the guard it covers, and every one of them was
// watched to redden with that mutation applied and to go green again with it
// restored. A guard whose test stays green when the guard is deleted is worse
// than no test, because the green reads as coverage.
//
// SEVERAL OF THEM RUN ON A VIRTUAL CLOCK, which is not a convenience. Three of
// these guards are `>=` where a `>` would also look right, so the difference
// between the guard and its mutation is exactly one millisecond of wall clock:
// on real timers that is a coin toss, and a coin toss is not a test.
// ---------------------------------------------------------------------------

/**
 * Runs `body` with vitest's fake timers installed, restoring the real ones
 * whatever happens. Every `Date.now()` the ticker reads and every timer it
 * arms then come from the same virtual clock, so the tick grid lands on exact
 * multiples of `tickMs` and a case can name the instant it expects rather than
 * bracket it.
 */
async function onVirtualTime<T>(body: (advance: (ms: number) => Promise<void>) => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    return await body(async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  } finally {
    vi.useRealTimers();
  }
}

/** The REAL `setTimeout`, captured at module load and therefore before any virtual clock is installed over the global one. */
const realSetTimeout = globalThis.setTimeout;

/**
 * One turn of the REAL event loop, taken while a virtual clock is installed.
 *
 * A virtual clock only ever fires what was armed against IT, and work that is
 * genuinely asynchronous finishes on real turns or not at all: the case that
 * needs this is the checkpoint-bound one below, whose write deflates on
 * libuv's threadpool. Advancing virtual time does not wait for that, so a case
 * that observes anything downstream of it has to.
 */
const realTurn = (): Promise<void> => new Promise<void>((resolve) => realSetTimeout(resolve));

describe('runTicker: overlapping renews resolve in whatever order they like', () => {
  /**
   * Holds each RENEW reply for its own delay, taken in the order the renews
   * were ISSUED, so two can be in flight at once and resolve in the opposite
   * order to the one they were attempted in. A renew past the end of the list
   * throws, which is a transient fault rather than a confirmed loss: nothing
   * after the pair moves the ownership clock at all, so the exit is paced
   * purely by what the pair left behind. The release script and the
   * owner-checked checkpoint write pass straight through.
   */
  class ReorderedRenewRedis extends FakeRedis {
    renews = 0;

    constructor(private readonly replyDelaysMs: number[]) {
      super();
    }

    override async eval(script: string, numKeys: number, ...args: (string | number | Buffer)[]): Promise<unknown> {
      if (script.includes('KEYS[2]') || script.includes("'del'")) return super.eval(script, numKeys, ...args);
      const delayMs = this.replyDelaysMs[this.renews++];
      if (delayMs === undefined) throw new Error('renew reply is down');
      const reply = await super.eval(script, numKeys, ...args);
      await new Promise((r) => setTimeout(r, delayMs));
      return reply;
    }
  }

  it('two overlapping renews resolving OUT OF ORDER never move lastOwnedAt backwards', async () => {
    await onVirtualTime(async (advance) => {
      // The renew attempted at 100 replies at 350; the one attempted at 200
      // replies at 250, a hundred milliseconds AHEAD of it. Overlapping renews
      // are the accepted price of pacing from the attempt (see `renewConfirmed`
      // in core/lease.ts), and they are only safe while every resolution leaves
      // `lastOwnedAt` non-decreasing.
      const redis = new ReorderedRenewRedis([250, 50]);
      let lostAt = -1;
      const startedAt = Date.now();

      const resultPromise = runTicker({
        runtime: makeCounterRuntime({ tickHz: 100, create: withAlice }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r-reorder',
        namespace: NS,
        leaseTtlMs: 1000,
        leaseRenewMs: 100,
        // No second detector. The owner-checked checkpoint never runs again
        // after the first iteration, and no renew is ever REFUSED, so the
        // synchronous guard's own deadline is the only thing that can end this
        // run and the exit time is a direct read of the ownership clock.
        checkpointMs: 100_000,
        maxRunMs: 5000,
        emptyGraceMs: 100_000,
        log: (ev) => {
          if (ev.kind === 'ticker.lease-lost') lostAt = Date.now();
        },
      });

      await advance(2000);
      const result = await resultPromise;

      expect(result.reason).toBe('lease-lost');
      expect(redis.renews).toBeGreaterThanOrEqual(2); // both halves of the pair really were issued
      // `lastOwnedAt` is 200 at t=250 either way, and the whole question is what
      // the OLDER reply does to it at t=350. Held at the later attempt, the TTL
      // runs out at 1200. Allowed to move backwards it is 100 again, and this
      // room stops publishing a tenth of a second early, handing its players a
      // gap it had every right to keep simulating through.
      expect(lostAt - startedAt).toBe(1200);
    });
  });
});

describe('runTicker: what arrives on keys.in is not an envelope until it is checked', () => {
  it('a non-object JSON payload on keys.in is counted on badEnvelopes and never throws in the subscriber', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-nonobject', NS);
    const stats: RoomStats[] = [];

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({ tickHz: 50, create: withAlice }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-nonobject',
      namespace: NS,
      statsMs: 40,
      maxRunMs: 250,
      emptyGraceMs: 100_000,
      onStats: (s) => stats.push(s),
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    // All three PARSE. `JSON.parse` succeeding says the bytes were JSON and
    // nothing whatsoever about their shape, and `null` in particular is the one
    // that turns a missing shape check into a TypeError inside a subscriber
    // callback, where there is no caller left to catch it. The fake delivers
    // synchronously, so a throw in the handler comes back out of the publish
    // and these three assertions are the "never throws" half.
    await expect(redis.publish(keys.in, '42')).resolves.toBeGreaterThan(0);
    await expect(redis.publish(keys.in, 'null')).resolves.toBeGreaterThan(0);
    await expect(redis.publish(keys.in, '[]')).resolves.toBeGreaterThan(0);
    const result = await resultPromise;

    expect(result.reason).toBe('duration');
    expect(stats.reduce((n, s) => n + s.badEnvelopes, 0)).toBe(3);
    // Refused at the door as a SHAPE failure, so none of them reaches the
    // switch to be summarised as an envelope type this ticker has no branch for.
    expect(stats.reduce((n, s) => n + s.unknownEnvelopes, 0)).toBe(0);
  });
});

describe('runTicker: the input-subscription probe answers only what it asked', () => {
  it('a replayed probe reply with an older n does not move probesAnswered or refresh the deadline', async () => {
    await onVirtualTime(async (advance) => {
      const keys = roomKeys('r-probe-replay', NS);
      // This ticker's own probes never leave the process, exactly as they
      // would not through a black-holed subscriber connection, so every answer
      // it sees is one this test injected and the timing of each is exact.
      const redis = new NoProbeOutRedis(keys.in);
      const injector = redis.fork();
      const startedAt = Date.now();
      let deadAt = -1;

      const resultPromise = runTicker({
        runtime: makeCounterRuntime({ tickHz: 100, create: withAlice }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r-probe-replay',
        namespace: NS,
        checkpointMs: 100_000,
        maxRunMs: 12_000,
        emptyGraceMs: 100_000,
        log: (ev) => {
          if (ev.kind === 'ticker.input-dead') deadAt = Date.now();
        },
      });

      // Probes are numbered at 0, 1000, 2000, ... so two have been asked by
      // the time this lands, and answering the newest of them is what a live
      // subscription looks like.
      await advance(1200);
      const owner = await redis.get(keys.lease);
      expect(owner).not.toBeNull();
      await injector.publish(keys.in, JSON.stringify({ t: 'probe', n: 2, o: owner }));

      // A REPLAY: the bus redelivered an old answer, or a proxy held one and
      // let it go late. It is correctly addressed, it carries a number this
      // ticker really did send, and it is still not evidence that anything is
      // being delivered NOW.
      await advance(1300);
      await injector.publish(keys.in, JSON.stringify({ t: 'probe', n: 1, o: owner }));
      await advance(4000);
      const result = await resultPromise;

      expect(result.reason).toBe('input-dead');
      // PROBE_DEAD_MS after the newest answer (1200), not after the replay
      // (2500). Letting an older `n` back in resets the watchdog on evidence
      // from more than a second ago and holds a deaf room open that much
      // longer, which is the one thing this watchdog exists not to do.
      expect(deadAt - startedAt).toBe(4200);
    });
  });
});

describe('runTicker: a continued grid point that has not arrived yet', () => {
  it('a restore whose gridAt + tickMs is in the future does not publish its first snapshot before that grid point', async () => {
    await onVirtualTime(async (advance) => {
      const redis = new FakeRedis();
      const keys = roomKeys('r-gridwait', NS);
      const runtime = makeCounterRuntime({ tickHz: 100 });
      const startedAt = Date.now();
      const seeded: CounterState = {
        tick: 500,
        players: new Map([['alice', { counter: 0, playout: false }]]),
        full: false,
        starves: {},
      };
      // The predecessor's last stamp is NOW, so the grid point this successor
      // continues onto is one whole tick in the future: inside the adoption
      // window (`lateBy` is exactly `-tickMs`) and not yet due.
      await redis.set(
        keys.state,
        JSON.stringify({
          v: 1,
          tick: 500,
          graceUntilTick: 0,
          incarnation: 'inc-1',
          gridAt: startedAt,
          body: runtime.serialize(seeded),
        })
      );

      const outAt: number[] = [];
      const observer = redis.fork();
      observer.on('message', (channel: unknown) => {
        if (channel === keys.out) outAt.push(Date.now());
      });
      await observer.subscribe(keys.out);

      const resultPromise = runTicker({
        runtime,
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r-gridwait',
        namespace: NS,
        checkpointMs: 100_000,
        maxRunMs: 100,
        emptyGraceMs: 100_000,
        log: () => {},
      });

      await advance(300);
      const result = await resultPromise;
      observer.disconnect();

      expect(result.reason).toBe('duration');
      expect(outAt.length).toBeGreaterThan(0); // it really did publish
      // Ten milliseconds, one whole tick, spent waiting for a grid point that
      // had not arrived. Running straight into it stamps a frame with a
      // `serverTime` ahead of the wall clock that produced it, which is the
      // one direction the client's plausibility bound refuses outright.
      expect(outAt[0]! - startedAt).toBe(10);
    });
  });
});

describe('runTicker: a crash counter that is not a number', () => {
  it('a non-numeric room:{id}:crashes value does not trip the crash-loop limit', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-crashes-garbage', NS);
    const runtime = makeCounterRuntime({ tickHz: 50 });
    const logs: LogEvent[] = [];
    const seeded: CounterState = {
      tick: 500,
      players: new Map([['alice', { counter: 3, playout: false }]]),
      full: false,
      starves: {},
    };
    // Whatever wrote this was not the crash path: a truncated value, a key
    // reused by something else, a hand-edited one. The crash-loop limit
    // discards a room's whole checkpoint when it fires, so it may only ever
    // fire on evidence it can actually read.
    await redis.set(keys.crashes, 'not-a-number');
    await redis.set(
      keys.state,
      JSON.stringify({
        v: 1,
        tick: 500,
        graceUntilTick: 0,
        incarnation: 'inc-1',
        body: runtime.serialize(seeded),
      })
    );

    let observedFirstTick = -1;
    const result = await runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        tick: (state) => {
          state.tick += 1;
          if (observedFirstTick === -1) observedFirstTick = state.tick;
          return { events: [{ kind: 'tick', tick: state.tick }] };
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-crashes-garbage',
      namespace: NS,
      maxRunMs: 120,
      emptyGraceMs: 100_000,
      log: (ev) => logs.push(ev),
    });

    expect(result.reason).toBe('duration');
    // The room came back rather than starting over at 0, which is the whole
    // cost of reading an unparseable counter as a loop.
    expect(observedFirstTick).toBe(501);
    expect(logs.some((l) => l.kind === 'ticker.crash-loop')).toBe(false);
  });
});

describe('runTicker: exactly at the bound is inside it', () => {
  /** Accepts every snapshot publish and never resolves one, so the in-flight count only ever climbs. */
  class NeverResolvingPublishRedis extends FakeRedis {
    outbound = 0;

    constructor(private readonly channel: string) {
      super();
    }

    override async publish(channel: string, message: string | Buffer): Promise<number> {
      if (channel !== this.channel) return super.publish(channel, message);
      this.outbound++;
      return new Promise<number>(() => {});
    }
  }

  /** Counts the checkpoint writes that have actually REACHED Redis, so a case can tell an outstanding write from a finished one. */
  class CheckpointWriteCountingRedis extends FakeRedis {
    checkpointWrites = 0;

    constructor(private readonly stateKey: string) {
      super();
    }

    override async eval(script: string, numKeys: number, ...args: (string | number | Buffer)[]): Promise<unknown> {
      // The owner-checked SET in `writeCheckpoint` is the only script this
      // ticker evals whose FIRST key is the state key: the renew and the
      // release each take the lease key and nothing else.
      if (args[0] === this.stateKey) this.checkpointWrites++;
      return super.eval(script, numKeys, ...args);
    }
  }

  it('inFlightPublishes exactly at MAX_IN_FLIGHT_PUBLISHES skips the frame rather than issuing one more', async () => {
    await onVirtualTime(async (advance) => {
      const keys = roomKeys('r-inflight-bound', NS);
      const redis = new NeverResolvingPublishRedis(keys.out);
      const stats: RoomStats[] = [];

      const resultPromise = runTicker({
        runtime: makeCounterRuntime({ tickHz: 100, create: withAlice }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r-inflight-bound',
        namespace: NS,
        statsMs: 100,
        checkpointMs: 100_000,
        maxRunMs: 500,
        emptyGraceMs: 100_000,
        onStats: (s) => stats.push(s),
        log: () => {},
      });

      await advance(800);
      await resultPromise;

      // `MAX_IN_FLIGHT_PUBLISHES` is 4 and the bound is `>=`, so the FOURTH
      // publish is the last one that goes out: at four in flight the room is
      // already as far behind the bus as it is allowed to get. A `>` here lets
      // a fifth through, which is one whole stale frame queued behind a bus
      // that has answered nothing.
      expect(redis.outbound).toBe(4);
      expect(stats.reduce((n, s) => n + s.publishSkipped, 0)).toBeGreaterThan(0); // it kept ticking
    });
  });

  it('a checkpoint exactly checkpointMs after the last one is written, not held to the next tick', async () => {
    await onVirtualTime(async (advance) => {
      const keys = roomKeys('r-checkpoint-bound', NS);
      const redis = new CheckpointWriteCountingRedis(keys.state);
      const serializedAt: number[] = [];
      let writesStarted = 0;

      const resultPromise = runTicker({
        runtime: makeCounterRuntime({
          tickHz: 100,
          create: withAlice,
          serialize: (state) => {
            writesStarted++;
            serializedAt.push(Date.now());
            return JSON.stringify({ tick: state.tick, players: Array.from(state.players.entries()), full: state.full });
          },
        }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r-checkpoint-bound',
        namespace: NS,
        // Three ticks exactly, so the cadence lands ON the bound rather than
        // stepping over it: `now - lastCheckpointAt` is 30 at the third tick
        // after a write and never 29 or 31.
        checkpointMs: 30,
        maxRunMs: 200,
        emptyGraceMs: 100_000,
        log: () => {},
      });

      // THE VIRTUAL CLOCK IS HELD STILL WHILE A CHECKPOINT WRITE IS
      // OUTSTANDING, and that is what makes this case load-independent rather
      // than merely virtual.
      //
      // A checkpoint is the one thing this loop starts that is REALLY
      // asynchronous: `writeCheckpoint` deflates on libuv's threadpool, which
      // finishes in real milliseconds that no amount of advancing a virtual
      // clock brings forward, and the writes are chained (see
      // `checkpointChain`) so the NEXT `serialize` runs when the PREVIOUS
      // deflate lands rather than when its own checkpoint fell due. Advancing
      // the whole run in one call lets the virtual clock race that deflate by
      // however many turns the host happens to spare, and the stamp
      // `serialize` reads is then a fact about the compressor: measured on a
      // 16-way parallel run as gaps of 40, 60, 60 for a cadence of 30, and
      // forced to 130 then 500 here by padding the body to 400KB. Stepping one
      // tick (10ms at 100Hz) at a time and draining REAL turns between the
      // steps puts every `serialize` back on the instant its checkpoint was
      // DUE, which is the only instant this case is about, whatever else the
      // host is running.
      for (let elapsed = 0; elapsed < 500; elapsed += 10) {
        await advance(10);
        while (writesStarted > redis.checkpointWrites) await realTurn();
      }
      await resultPromise;

      expect(serializedAt.length).toBeGreaterThan(3);
      // Every gap is one checkpoint interval. Under a `>` the write waits for
      // the NEXT tick, so a room checkpoints at 4/3 of the interval it was
      // configured with and every handoff restores a state a third older than
      // the operator asked for: watched at [40, 40, 40] with that mutation
      // applied and back at [30, 30, 30] with it restored.
      const gaps = serializedAt.slice(1, 4).map((at, i) => at - serializedAt[i]!);
      expect(gaps).toEqual([30, 30, 30]);
    });
  });

  it('a join heartbeat exactly presenceTimeoutMs old times the player out', async () => {
    await onVirtualTime(async (advance) => {
      const redis = new FakeRedis();
      const keys = roomKeys('r-presence-bound', NS);
      let joinedAt = -1;
      let leftAt = -1;

      const resultPromise = runTicker({
        runtime: makeCounterRuntime({
          tickHz: 100,
          join: (state, pid) => {
            joinedAt = Date.now();
            if (!state.players.has(pid)) state.players.set(pid, { counter: 0, playout: false });
          },
          leave: (state, pid) => {
            leftAt = Date.now();
            state.players.delete(pid);
          },
        }),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r-presence-bound',
        namespace: NS,
        // The sweep rides the stats flush, so one flush per tick means the
        // first instant the bound can be observed is the instant it is reached.
        statsMs: 10,
        presenceTimeoutMs: 50,
        checkpointMs: 100_000,
        maxRunMs: 300,
        emptyGraceMs: 100_000,
        log: () => {},
      });

      await advance(20);
      await redis.publish(keys.in, JSON.stringify({ t: 'join', pid: 'alice' }));
      await advance(400);
      await resultPromise;

      expect(joinedAt).toBeGreaterThan(0);
      // A heartbeat exactly `presenceTimeoutMs` old is a heartbeat that has
      // already missed its window: the relay republishes every
      // `JOIN_HEARTBEAT_MS`, so at the bound five of them in a row are
      // accounted for. Under a `>` the synthesised leave waits a further tick,
      // which on the shipped defaults is a phantom player held for another
      // whole heartbeat.
      expect(leftAt - joinedAt).toBe(50);
    });
  });
});

// ---------------------------------------------------------------------------
// THE INPUT TIMELINE: THE STEP THAT PRODUCES TICK T CONSUMES THE INPUTS STAMPED T.
//
// Pinned against the SNAPSHOT LABEL rather than against a hook's view of
// `state.tick`, because the label is what a client reconciles from. Both cases
// below were watched to redden with the consume pass restored to
// `consume(tickNow)` (the completed count) and to go green again with it
// consuming `tickNow + 1`.
// ---------------------------------------------------------------------------
describe('runTicker: the step that produces tick T consumes the inputs stamped T', () => {
  /** Parses every snapshot the ticker publishes, keyed by its own label. */
  async function watchSnapshots(redis: FakeRedis, out: string): Promise<Map<number, number>> {
    const valueAt = new Map<number, number>();
    const observer = redis.fork();
    observer.on('message', (channel: unknown, msg: unknown) => {
      if (channel !== out || typeof msg !== 'string') return;
      const snap = JSON.parse(msg) as { tick: number; players: [string, { counter: number }][] };
      const alice = snap.players.find(([pid]) => pid === 'alice');
      if (alice) valueAt.set(snap.tick, alice[1].counter);
    });
    await observer.subscribe(out);
    return valueAt;
  }

  it('the snapshot labelled T already carries the input stamped T, and the one labelled T-1 does not', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-label', NS);
    const counterAt = await watchSnapshots(redis, keys.out);

    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-label',
      namespace: NS,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    const T = 8;
    await redis.publish(
      keys.in,
      JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 1, targetTick: T, data: 7 } satisfies ClientInput] })
    );
    await resultPromise;

    expect(counterAt.get(T - 1)).toBe(0);
    // Consuming the completed count instead lands this on the label T + 1,
    // which is the one-tick disagreement the client sees at every input change.
    expect(counterAt.get(T)).toBe(7);
  });

  it('a change of input lands on the label it names, so a replay of targetTick > snap.tick from any snapshot reaches one pose', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r-label-change', NS);
    const yAt = await watchSnapshots(redis, keys.out);

    // A held control, the shape pong's paddle has: the buffered record sets
    // the direction, the step moves by it, and it persists until the next
    // record supersedes it. Steady motion cannot tell the timelines apart
    // (a record consumed a tick late carries the same value as the one that
    // should have been), so the input has to CHANGE mid-run for this to pin
    // anything: dir 1 up to tick T, dir 0 from T + 1.
    let dir = 0;
    const resultPromise = runTicker({
      runtime: makeCounterRuntime({
        tickHz: 50,
        create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
        applyBufferedInput: (_state, _pid, input) => {
          dir = input.data as number;
        },
        tick: (state) => {
          state.tick += 1;
          const p = state.players.get('alice');
          if (p) p.counter += dir;
          return {};
        },
      }),
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r-label-change',
      namespace: NS,
      maxRunMs: 500,
      emptyGraceMs: 100_000,
      log: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    const FROM = 10;
    const T = 14;
    const records: { seq: number; targetTick: number; data: number }[] = [];
    for (let t = FROM; t <= T + 4; t++) records.push({ seq: t, targetTick: t, data: t <= T ? 1 : 0 });
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: records }));
    await resultPromise;

    // The label T includes the last moving step, and the label T + 1 did not move.
    const travelled = T - FROM + 1;
    expect(yAt.get(T)).toBe(travelled);
    expect(yAt.get(T + 1)).toBe(travelled);
    // What the client does with it: its own prediction applied every record
    // from the spawn pose, and on each snapshot it replays the records stamped
    // AFTER the label from the authoritative pose. The two must meet from
    // every snapshot, not only from the ones taken during steady motion.
    const predicted = records.reduce((y, rec) => y + rec.data, 0);
    const replayFrom = (label: number): number =>
      records.reduce((y, rec) => (rec.targetTick > label ? y + rec.data : y), yAt.get(label) as number);
    expect(replayFrom(T - 1)).toBe(predicted);
    expect(replayFrom(T)).toBe(predicted);
    expect(replayFrom(T + 1)).toBe(predicted);
  });
});
