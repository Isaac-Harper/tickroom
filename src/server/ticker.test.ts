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
} from '../core/index.js';
import { readCheckpoint } from './checkpoint.js';
import { FakeRedis } from './testFakeRedis.js';
import { runTicker, publishCustom } from './ticker.js';

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

    const resultPromise = runTicker({
      runtime,
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      // Shrunk well below the production defaults so the guard fires inside
      // a test's real-time budget instead of the production 1.5-5s window.
      leaseTtlMs: 50,
      leaseRenewMs: 20,
      checkpointMs: 1000,
      statsMs: 1000,
      maxRunMs: 5000, // must not be what ends the test
      emptyGraceMs: 5000, // the room has no players, so this must also not be what ends it
    });

    // Let it acquire the lease and take a few ticks.
    await new Promise((r) => setTimeout(r, 15));
    // Steal the lease the way an independent competing process would: write
    // a different owner value directly, with no coordination at all.
    await redis.set(keys.lease, 'a-thief', 'PX', 5000);

    const result = await resultPromise;
    expect(result.reason).toBe('lease-lost');
    // AND it exited on the lease rather than on the clock. Both exits used to
    // be reachable from this setup with different reasons, so pin the one
    // fact that separates them independently of which detector won: a
    // duration exit cannot happen before the 5000ms cap, and this is half of
    // it. See the next case for why the two detectors used to disagree.
    expect(result.uptimeMs).toBeLessThan(2500);

    // The thief's write must still be standing: this ticker must not have
    // released (and thereby cleared) a lease it no longer owns.
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
   * The test above cannot choose between them, so it used to be a coin flip
   * on machine load: (a) reported 'lease-lost' and (b) broke out of the loop
   * leaving `exitReason` on its 'duration' initialiser, so on a loaded host
   * the assertion flipped. That was never a timing problem in the test, it
   * was `ticker.ts` genuinely reporting a healthy duration-capped exit for a
   * ticker that had just had the room taken away from it.
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
    expect(spawnFull).toHaveBeenCalledWith('r-full');
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
    expect(Date.now() - start).toBeLessThan(2500);
  });

  it('applies a playout input on its exact stamped tick, never before', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);

    const seenAtTick: Record<number, number> = {};
    let starvedCount = 0;
    const runtime = makeCounterRuntime({
      tickHz: 50, // 20ms/tick, generous relative to the publish delay below
      create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
      applyBufferedInput: (state, pid, input) => {
        seenAtTick[state.tick] = input.data as number;
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
    let starvedCount = 0;
    let unstampedApplied = 0;

    const runtime = makeCounterRuntime({
      tickHz: 50,
      create: () => ({ tick: 0, players: new Map([['alice', { counter: 0, playout: true }]]), full: false, starves: {} }),
      applyInput: (state, pid, input) => {
        unstampedApplied++;
        const p = state.players.get(pid);
        if (p) p.counter += input.data as number;
      },
      onStarve: (_state, _pid, streak) => {
        starvedCount = streak;
      },
    });

    const resultPromise = runTicker({
      runtime,
      redis,
      createSubscriber: () => redis.fork(),
      roomId: 'r1',
      namespace: NS,
      maxRunMs: 200,
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
    const starvesBeforeUnstamped = starvedCount;
    // ...until an UNSTAMPED input arrives, which must drop the stale buffer.
    await redis.publish(keys.in, JSON.stringify({ t: 'in', pid: 'alice', w: [{ seq: 2, data: 9 } satisfies ClientInput] }));

    await resultPromise;
    expect(starvesBeforeUnstamped).toBeGreaterThan(0);
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
        applyBufferedInput: (state) => bufferedAt.push(state.tick),
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
        applyBufferedInput: (state) => bufferedAt.push(state.tick),
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
    // The near one is inside the window, the far one is not. A SIZE bound with
    // eviction would have let the far one in and thrown out the near one to
    // make room, starving the player on the input they were about to need. A
    // DISTANCE bound with refusal drops the runaway stamp instead.
    await redis.publish(
      keys.in,
      JSON.stringify({
        t: 'in',
        pid: 'alice',
        w: [
          { seq: 1, targetTick: 3, data: 1 },
          { seq: 2, targetTick: 400, data: 1 },
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
    const seen: { name: string; data: unknown; pid?: string }[] = [];

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
