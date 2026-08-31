import { describe, it, expect, vi } from 'vitest';
import {
  type RoomRuntime,
  type ClientInput,
  roomKeys,
  acquireLease,
  unpackCheckpoint,
} from '../core/index.js';
import { readCheckpoint } from './checkpoint.js';
import { FakeRedis } from './testFakeRedis.js';
import { runTicker } from './ticker.js';

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
      maxRunMs: 5000, // must not be what ends the test; 'lease-lost' should win the race
      emptyGraceMs: 5000, // the room has no players, so this must also not be what ends it
    });

    // Let it acquire the lease and take a few ticks.
    await new Promise((r) => setTimeout(r, 15));
    // Steal the lease the way an independent competing process would: write
    // a different owner value directly, with no coordination at all.
    await redis.set(keys.lease, 'a-thief', 'PX', 5000);

    const result = await resultPromise;
    expect(result.reason).toBe('lease-lost');

    // The thief's write must still be standing: this ticker must not have
    // released (and thereby cleared) a lease it no longer owns.
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
