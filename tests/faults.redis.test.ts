// THE FAULT-INJECTION FILE: the ticker's failure paths, run against a real
// Redis with the connection actually broken underneath it, rather than against
// a fake asked politely to return an error.
//
// WHY IT CANNOT BE A UNIT TEST, WHICH IS THE WHOLE JUSTIFICATION FOR THE COST
// OF THIS FILE. `src/server/testFakeRedis.ts` can make a command fail
// (`.break(method)`), and `src/server/ticker.test.ts` uses that to pin what the
// ticker DOES with a failure. It cannot produce the failures below, because
// every one of them is a property of the SOCKET rather than of the Redis
// protocol:
//
//   - A BLACK HOLE is bytes ceasing to move with nobody closing anything. No
//     error, no `'close'`, no `'reconnecting'`, no reply: the exact shape in
//     which a room stays green on every metric while receiving nothing. A fake
//     cannot decline to answer without also being the thing that says so.
//   - A SEVER is an RST, an `'error'`, and ioredis's own reconnect ladder,
//     which is a code path inside the driver that no fake ever enters.
//   - A LEASE THEFT with the predecessor STILL RUNNING needs two live tickers
//     racing one Redis over real wall time, and the refusal has to come from
//     Redis's own Lua rather than from a fake matching on the script's text.
//   - A CRASH LOOP needs the crash counter to survive between invocations with
//     a real TTL on it.
//
// So this file is the measurement half of four of the audit's findings, made
// permanent. Everything it asserts was observed first by hand; the numbers in
// the comments are what was measured, and the bounds in the assertions are
// deliberately looser than those numbers because this runs on a loaded shared
// machine and a flaky gate is worse than a slack one.
//
// EVERY OBSERVER IN THIS FILE CONNECTS DIRECTLY TO REDIS, NEVER THROUGH THE
// PROXY. The measurement has to survive the fault it is measuring: an observer
// on the broken path goes quiet exactly when the interesting thing happens, and
// silence would then read as the fault rather than as the loss of the
// instrument.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  type RedisLike,
  type LogEvent,
  type RoomEnvelope,
  type RoomRuntime,
  type RoomStats,
  roomKeys,
  unpackCheckpoint,
} from '../src/core/index.js';
import {
  runTicker,
  readCheckpoint,
  getRedis,
  createSubscriber,
  resetRedisForTests,
} from '../src/server/index.js';
import { createCounterRuntime, type CounterEvent, type CounterState } from './helpers/toyRuntime.js';
import { startProxy, proxyTargetFrom, type FaultProxy } from './helpers/proxy.js';
import {
  TEST_REDIS_URL,
  probeRedisAvailable,
  newNamespace,
  flushNamespace,
  skipReason,
  waitFor,
} from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: faults] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

/**
 * MIRRORS OF `src/server/ticker.ts`'s OWN MODULE-PRIVATE CONSTANTS, copied
 * rather than exported, because they are an internal pacing decision and this
 * file is the only thing outside that module with any business knowing them.
 * They appear here only to BOUND an assertion (the input-dead deadline is
 * `PROBE_DEAD_MS` plus at most one interval), so a drift makes this file's
 * bound loose rather than wrong.
 */
const PROBE_INTERVAL_MS = 1000;
const PROBE_DEAD_MS = 3000;

/**
 * The lease budget every case here runs on. Short, so a fault resolves in
 * seconds rather than in the production TTL, and NOT so short that ordinary
 * scheduling jitter on a loaded machine looks like a lost lease: 1500/400 is
 * nearly four renews inside one TTL.
 */
const SHORT_LEASE_MS = 1500;
const SHORT_RENEW_MS = 400;

/** Fine enough that several stats windows land inside a fault that only lasts a second or two. */
const STATS_MS = 200;

/**
 * NOTHING IN THIS FILE HEARTBEATS A JOIN, because there is no relay in it: the
 * `join` is published once, by hand, onto `keys.in`. The presence sweep would
 * therefore declare the player gone `presenceTimeoutMs` later (5s by default),
 * and in two of these cases that would land mid-fault and quietly take the
 * successor spawn with it, since the exit only spawns one when somebody is
 * still in the room. Raising it out of the way is the honest fix: the sweep is
 * not what these cases are measuring, and `tests/e2e.redis.test.ts` is where
 * the real relay's heartbeat is exercised.
 */
const PRESENCE_TIMEOUT_MS = 100_000;

/** Generous on purpose: several of these deliberately wait out a multi-second deadline, and this suite has to survive a loaded CI runner. */
const CASE_TIMEOUT_MS = 30_000;

const PID = 'faults-p1';

/** What the toy runtime's `encodeSnapshot` puts on the wire. Parsed rather than trusted: it is the only live view of the room these tests get. */
interface ToySnapshot {
  tick: number;
  players: string[];
  counters: Record<string, number>;
  t: number;
}

d('fault injection / real Redis behind a TCP proxy', () => {
  const namespace = newNamespace('faults');
  const target = proxyTargetFrom(TEST_REDIS_URL);
  let raw: Redis;

  /** Every proxy any case started, closed centrally so a failed assertion cannot leave a listening socket behind. */
  const proxies: FaultProxy[] = [];
  /** The same, for the direct observer connections. */
  const observers: Redis[] = [];

  beforeAll(() => {
    raw = new Redis(TEST_REDIS_URL);
  });

  afterEach(async () => {
    for (const observer of observers.splice(0, observers.length)) observer.disconnect();
    for (const proxy of proxies.splice(0, proxies.length)) await proxy.close();
    // `getRedis` memoizes ONE shared client per module instance, which is
    // exactly right for a host and exactly wrong for a file where each case
    // points the shared client at a different (and often deliberately broken)
    // endpoint. This is what that export exists for.
    resetRedisForTests();
  });

  afterAll(async () => {
    // The same settle delay `tests/ticker.redis.test.ts` takes, and for the
    // same reason: the loop's checkpoint and renew writes are fire-and-forget,
    // so a run resolving does not mean every round trip it started has landed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushNamespace(TEST_REDIS_URL, namespace);
    raw.disconnect();
  });

  function freshRoomId(label: string): string {
    return `room-${label}-${randomUUID().slice(0, 6)}`;
  }

  /** A direct subscriber on a room's snapshot channel, timestamping every frame it sees. The live view of what the room believes. */
  async function watchSnapshots(channel: string): Promise<{ at: number; snap: ToySnapshot }[]> {
    const sub = new Redis(TEST_REDIS_URL);
    observers.push(sub);
    const frames: { at: number; snap: ToySnapshot }[] = [];
    sub.on('message', (ch: string, message: string) => {
      if (ch !== channel) return;
      try {
        frames.push({ at: Date.now(), snap: JSON.parse(message) as ToySnapshot });
      } catch {
        // The toy runtime only ever publishes JSON; anything else is not a
        // frame this file has an opinion about.
      }
    });
    await sub.subscribe(channel);
    return frames;
  }

  /** Puts an envelope on a room's input channel the way a relay would, on a connection no fault in this file touches. */
  async function send(channel: string, envelope: RoomEnvelope): Promise<void> {
    await raw.publish(channel, JSON.stringify(envelope));
  }

  function latest(frames: { snap: ToySnapshot }[]): ToySnapshot | null {
    return frames.length === 0 ? null : frames[frames.length - 1].snap;
  }

  /**
   * Publishes a `join` until the room acknowledges it in a snapshot, which is
   * exactly what a relay's join heartbeat does and is not optional here.
   * ONE PUBLISH IS A RACE THIS FILE WOULD LOSE: `runTicker` acquires the
   * lease, runs `init`, reads the checkpoint and only THEN subscribes, and
   * pub/sub has no replay, so a join sent while the ticker was still starting
   * up is simply gone and the room stays empty forever.
   *
   * Once this returns true the subscription is a fact rather than a hope, so
   * every later publish in a case can be a single shot: that is what keeps the
   * applied-input counts below exact.
   */
  async function joinUntilPresent(inKey: string, frames: { snap: ToySnapshot }[]): Promise<boolean> {
    return waitFor(async () => {
      if (latest(frames)?.players.includes(PID) ?? false) return true;
      await send(inKey, { t: 'join', pid: PID });
      return false;
    }, 8000, 100);
  }

  /** The toy runtime plus a `dispose` counter, because "the `finally` ran" is a claim about a hook the toy has no other reason to carry. */
  function disposableRuntime(tickHz: number): {
    runtime: RoomRuntime<CounterState, CounterEvent>;
    disposals: number[];
  } {
    const disposals: number[] = [];
    const base = createCounterRuntime(tickHz);
    return {
      disposals,
      runtime: { ...base, dispose: (state) => disposals.push(state.tick) },
    };
  }

  /** The stored checkpoint's tick, or -1 if there is not one. */
  async function storedTick(redis: RedisLike, stateKey: string): Promise<number> {
    const envelope = unpackCheckpoint(await readCheckpoint(redis, stateKey));
    return envelope === null ? -1 : envelope.tick;
  }

  it('A BLACK-HOLED INPUT SUBSCRIBER while the shared client stays healthy: exits input-dead, releases the lease, hands over, and applies none of what it could not see', async () => {
    const roomId = freshRoomId('input-dead');
    const keys = roomKeys(roomId, namespace);

    // ONLY THE SUBSCRIBER GOES THROUGH THE PROXY. That asymmetry is the whole
    // case: the shared command client keeps publishing snapshots, renewing the
    // lease and writing checkpoints perfectly, so every signal the room emits
    // stays green while every join and every input is dropped. Nothing but the
    // ticker's own probe can tell the difference.
    const proxy = await startProxy(target);
    proxies.push(proxy);

    const frames = await watchSnapshots(keys.out);
    const logs: LogEvent[] = [];
    const spawns: { standby: boolean }[] = [];
    const shared = getRedis({ url: TEST_REDIS_URL, onError: () => {} });

    const run = runTicker({
      runtime: createCounterRuntime(50),
      redis: shared,
      createSubscriber: () => createSubscriber({ url: proxy.url, onError: () => {} }),
      roomId,
      namespace,
      geomKey: () => 'faults-input-dead:v1',
      checkpointMs: 100,
      statsMs: STATS_MS,
      leaseTtlMs: SHORT_LEASE_MS,
      leaseRenewMs: SHORT_RENEW_MS,
      presenceTimeoutMs: PRESENCE_TIMEOUT_MS,
      maxRunMs: 25_000, // must not be what ends this run; the black hole is
      emptyGraceMs: 100_000,
      spawnSuccessor: async (_room, opts) => {
        spawns.push(opts);
      },
      log: (ev) => logs.push(ev),
    });

    // A player, because the exit spawn is gated on somebody still being in the
    // room, and one input BEFORE the fault, which is the control that makes
    // "not applied" below mean something: the same publish on the same channel
    // demonstrably lands while the path is intact.
    expect(await joinUntilPresent(keys.in, frames)).toBe(true);
    await send(keys.in, { t: 'in', pid: PID, w: [{ seq: 1, data: 1 }] });
    expect(await waitFor(() => (latest(frames)?.counters[PID] ?? 0) === 1, 6000)).toBe(true);

    const blackholedAt = Date.now();
    proxy.blackhole();

    // Five inputs into the void, spread over half a second so no single
    // scheduling accident accounts for all of them.
    for (let i = 0; i < 5; i++) {
      await send(keys.in, { t: 'in', pid: PID, w: [{ seq: 2 + i, data: 1 }] });
      await new Promise((r) => setTimeout(r, 100));
    }

    const result = await run;
    const noticedMs = Date.now() - blackholedAt;

    expect(result.reason).toBe('input-dead');
    expect(logs.some((ev) => ev.kind === 'ticker.input-dead')).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `[measured] black-holed input subscriber: exited '${result.reason}' ${noticedMs}ms after the fault ` +
        `(deadline is PROBE_DEAD_MS ${PROBE_DEAD_MS}ms counted from the last ANSWERED probe, which is up to ` +
        `PROBE_INTERVAL_MS ${PROBE_INTERVAL_MS}ms before the fault)`
    );
    expect(noticedMs).toBeGreaterThan(1000);
    expect(noticedMs).toBeLessThan(PROBE_DEAD_MS + PROBE_INTERVAL_MS + 2500);

    // IT LET GO. An `input-dead` exit is handled exactly like a duration cap,
    // and the half of that which matters is the release: a ticker that sat on
    // a lease it could not serve would lock the room out for the whole TTL on
    // top of a room that already receives nothing.
    const leaseOwner = await raw.get(keys.lease);
    expect(leaseOwner).toBeNull();
    // AND IT HANDED OVER, which is the other half: the repair for a dead
    // subscription is a fresh process with a fresh connection, so the exit is
    // worthless without the spawn.
    expect(spawns).toEqual([{ standby: false }]);

    // The five inputs published into the black hole were never applied,
    // neither in the room the wire saw nor in the checkpoint a successor will
    // restore. This is the loss the exit exists to bound.
    expect(latest(frames)?.counters[PID]).toBe(1);
    const envelope = unpackCheckpoint(await readCheckpoint(shared, keys.state));
    expect(envelope).not.toBeNull();
    const stored = JSON.parse((envelope as { body: string }).body) as { players: string[]; counters: Record<string, number> };
    expect(stored.counters[PID]).toBe(1);
    expect(stored.players).toContain(PID);
  }, CASE_TIMEOUT_MS);

  it('A BLACK-HOLED SHARED CLIENT while the subscriber stays healthy: publishes stop being confirmed, the awaited guard renew times out, and the finally still runs', async () => {
    const roomId = freshRoomId('bus-dead');
    const keys = roomKeys(roomId, namespace);

    // THE MIRROR IMAGE OF THE CASE ABOVE, and it exits by a completely
    // different route. Here the room can still HEAR (the subscriber is direct,
    // so joins and inputs keep arriving) and cannot SPEAK: every publish,
    // checkpoint and renew goes into the hole. Nothing closes, so ioredis
    // never learns anything is wrong, and the only bound on the wait is the
    // `commandTimeout: 2000` the shipped `getRedis` merges in. That is why the
    // shared client here is built by the LIBRARY'S OWN FACTORY rather than by
    // `new Redis(...)`: the timeout under test is one of its defaults, and a
    // hand-rolled client would be testing this file's options instead.
    const proxy = await startProxy(target);
    proxies.push(proxy);

    const frames = await watchSnapshots(keys.out);
    const logs: LogEvent[] = [];
    const stats: RoomStats[] = [];
    const spawns: { standby: boolean }[] = [];
    const { runtime, disposals } = disposableRuntime(50);
    const shared = getRedis({ url: proxy.url, onError: () => {} });

    const run = runTicker({
      runtime,
      redis: shared,
      createSubscriber: () => createSubscriber({ url: TEST_REDIS_URL, onError: () => {} }),
      roomId,
      namespace,
      geomKey: () => 'faults-bus-dead:v1',
      checkpointMs: 100,
      statsMs: STATS_MS,
      leaseTtlMs: SHORT_LEASE_MS,
      leaseRenewMs: SHORT_RENEW_MS,
      presenceTimeoutMs: PRESENCE_TIMEOUT_MS,
      maxRunMs: 25_000,
      emptyGraceMs: 100_000,
      spawnSuccessor: async (_room, opts) => {
        spawns.push(opts);
      },
      onStats: (s) => stats.push(s),
      log: (ev) => logs.push(ev),
    });

    expect(await joinUntilPresent(keys.in, frames)).toBe(true);

    const blackholedAt = Date.now();
    proxy.blackhole();

    const result = await run;
    const exitedMs = Date.now() - blackholedAt;

    expect(result.reason).toBe('lease-lost');
    const leaseLost = logs.find((ev) => ev.kind === 'ticker.lease-lost');
    expect(leaseLost).toBeDefined();
    const finder = (leaseLost?.meta as { finder?: string } | undefined)?.finder;
    expect(['guard', 'renew']).toContain(finder);
    // eslint-disable-next-line no-console
    console.log(
      `[measured] black-holed shared client: exited '${result.reason}' (finder '${finder}') ${exitedMs}ms after ` +
        `the fault, which is the lease TTL (${SHORT_LEASE_MS}ms) aging out plus the shared client's own ` +
        `commandTimeout (2000ms) bounding the awaited renew`
    );
    // The floor is the honest half of this measurement: an exit sooner than
    // the TTL would mean something OTHER than ownership aging out ended the
    // run, and a black hole gives nothing else to go on.
    expect(exitedMs).toBeGreaterThan(SHORT_LEASE_MS);
    expect(exitedMs).toBeLessThan(10_000);

    // WHAT THE GAUGES SAID WHILE IT WAS HAPPENING. Windows that began after
    // the fault confirm nothing: `publishes` counts on RESOLUTION, so a room
    // whose bus is gone reports zero rather than the healthy rate it would
    // report if the counter moved on issue. The skips are the in-flight cap
    // doing its job (a snapshot that cannot go out now is worthless later).
    const during = stats.filter((s) => s.at > blackholedAt + STATS_MS * 2);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((s) => s.publishes === 0)).toBe(true);
    expect(during.reduce((n, s) => n + s.publishFails + s.publishSkipped, 0)).toBeGreaterThan(0);

    // THE FINALLY RAN, which is the point of bounding the wait at all. With no
    // `commandTimeout` on the shared client every one of those promises hangs
    // forever, the awaited renew never settles, and the loop never reaches its
    // own teardown: no successor, no dispose, a room dark until some relay's
    // jittered poll notices.
    expect(spawns).toEqual([{ standby: false }]);
    expect(disposals.length).toBe(1);
  }, CASE_TIMEOUT_MS);

  it('LEASE THEFT WITH THE PREDECESSOR STILL RUNNING: its next owner-checked checkpoint is refused by Redis, it exits lease-lost, and the stored state belongs to the successor', async () => {
    const roomId = freshRoomId('theft');
    const keys = roomKeys(roomId, namespace);
    const geomKey = (): string => 'faults-theft:v1';
    const shared = getRedis({ url: TEST_REDIS_URL, onError: () => {} });

    // NO PROXY HERE, and that is not an omission: the fault is a second writer
    // rather than a broken connection. What it needs from a real Redis is the
    // owner check running as Redis's OWN Lua, over a lease key two live
    // tickers are racing for. The fake matches that script on a substring of
    // its text, so it cannot tell a future two-key script apart from this one.
    const logsA: LogEvent[] = [];
    const predecessor = runTicker({
      runtime: createCounterRuntime(200),
      redis: shared,
      createSubscriber: () => createSubscriber({ url: TEST_REDIS_URL, onError: () => {} }),
      roomId,
      namespace,
      geomKey,
      // Short enough that the refused checkpoint is what finds the theft,
      // rather than the renew getting there first: with `leaseRenewMs` at
      // 400 this gives the checkpoint eight chances inside one renew window.
      checkpointMs: 50,
      statsMs: STATS_MS,
      leaseTtlMs: SHORT_LEASE_MS,
      leaseRenewMs: SHORT_RENEW_MS,
      maxRunMs: 25_000,
      emptyGraceMs: 100_000,
      log: (ev) => logsA.push(ev),
    });

    // Wait for a checkpoint with a healthy tick count, so "the successor's
    // state, not the predecessor's" has something non-trivial to be measured
    // against.
    let tickAtTheft = 0;
    const gotCheckpoint = await waitFor(async () => {
      const tick = await storedTick(shared, keys.state);
      if (tick < 20) return false;
      tickAtTheft = tick;
      return true;
    }, 6000, 20);
    expect(gotCheckpoint).toBe(true);

    // THE THEFT: delete the lease and let a second ticker acquire it while the
    // first is still mid-tick. That overlap is the whole case. A predecessor
    // that noticed on its own schedule and unwound before the successor
    // started would never exercise the refusal.
    await raw.del(keys.lease);

    const logsB: LogEvent[] = [];
    const successor = runTicker({
      runtime: createCounterRuntime(200),
      redis: shared,
      createSubscriber: () => createSubscriber({ url: TEST_REDIS_URL, onError: () => {} }),
      roomId,
      namespace,
      geomKey,
      checkpointMs: 50,
      statsMs: STATS_MS,
      leaseTtlMs: SHORT_LEASE_MS,
      leaseRenewMs: SHORT_RENEW_MS,
      maxRunMs: 1500,
      emptyGraceMs: 100_000,
      log: (ev) => logsB.push(ev),
    });

    const [resultA, resultB] = await Promise.all([predecessor, successor]);

    // THE REFUSAL CAME FROM REDIS, not from the predecessor noticing first.
    // Without the owner check the predecessor's next write would have
    // clobbered the successor's fresher state with its own, and both would
    // have kept going.
    expect(logsA.some((ev) => ev.kind === 'ticker.checkpoint-refused-not-owner')).toBe(true);
    expect(resultA.reason).toBe('lease-lost');
    const finder = (logsA.find((ev) => ev.kind === 'ticker.lease-lost')?.meta as { finder?: string } | undefined)
      ?.finder;
    expect(['checkpoint', 'renew']).toContain(finder);
    expect(resultB.reason).toBe('duration');

    // CONTINUITY: the successor picked the room up where the predecessor left
    // it rather than starting one of its own.
    const restoredTick = ((logsB.find((ev) => ev.kind === 'ticker.restore')?.meta as { tick?: number } | undefined)
      ?.tick) ?? -1;
    expect(restoredTick).toBeGreaterThanOrEqual(tickAtTheft);

    // AND THE STORED STATE IS THE SUCCESSOR'S. The predecessor started this
    // room from nothing, so `resultA.ticks` is the highest tick it could
    // possibly have written; the checkpoint left behind is past that, and lands
    // on the successor's own final tick.
    const finalTick = await storedTick(shared, keys.state);
    // eslint-disable-next-line no-console
    console.log(
      `[measured] lease theft: predecessor exited '${resultA.reason}' (finder '${finder}') at tick ` +
        `${resultA.ticks}, successor restored at ${restoredTick} and ran ${resultB.ticks} more; stored ` +
        `checkpoint is tick ${finalTick}`
    );
    expect(finalTick).toBeGreaterThan(resultA.ticks);
    expect(Math.abs(finalTick - (restoredTick + resultB.ticks))).toBeLessThanOrEqual(2);
  }, CASE_TIMEOUT_MS);

  it('A REDIS RESTART: both connections severed and restored 300ms later, the ticker rides it out, the subscription comes back, and nothing rejects unhandled', async () => {
    const roomId = freshRoomId('restart');
    const keys = roomKeys(roomId, namespace);
    const runMs = 6000;

    // ONE PROXY FOR BOTH CONNECTIONS, which is what makes this a RESTART
    // rather than a dropped socket: the shared client and the subscriber go
    // down together, and neither can reconnect until the far side is back.
    const proxy = await startProxy(target);
    proxies.push(proxy);

    // AN UNHANDLED REJECTION IS THE FAILURE THIS CASE IS REALLY WATCHING FOR.
    // It is not an assertion the ticker makes about itself: on current Node it
    // is a process exit, so in production the symptom is the whole function
    // disappearing, every other socket it held going with it, and nothing in
    // any log explaining why. The reconnect path is where the library came
    // closest to shipping one (see `createSubscriber`), so a reconnect test
    // that did not watch for it would be checking the easy half.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    const frames = await watchSnapshots(keys.out);
    const logs: LogEvent[] = [];

    try {
      const run = runTicker({
        runtime: createCounterRuntime(50),
        redis: getRedis({ url: proxy.url, onError: () => {} }),
        createSubscriber: () => createSubscriber({ url: proxy.url, onError: () => {} }),
        roomId,
        namespace,
        geomKey: () => 'faults-restart:v1',
        checkpointMs: 100,
        statsMs: STATS_MS,
        leaseTtlMs: SHORT_LEASE_MS,
        leaseRenewMs: SHORT_RENEW_MS,
        presenceTimeoutMs: PRESENCE_TIMEOUT_MS,
        maxRunMs: runMs,
        emptyGraceMs: 100_000,
        log: (ev) => logs.push(ev),
      });

      expect(await joinUntilPresent(keys.in, frames)).toBe(true);
      await send(keys.in, { t: 'in', pid: PID, w: [{ seq: 1, data: 1 }] });
      expect(await waitFor(() => (latest(frames)?.counters[PID] ?? 0) === 1, 5000)).toBe(true);

      const framesBefore = frames.length;
      const severedAt = Date.now();
      proxy.sever();
      await new Promise((r) => setTimeout(r, 300));
      proxy.restore();

      // IT RESUMED PUBLISHING, which is the claim about the shared client: the
      // lease survived the outage, so the split-brain guard let publishes
      // through again instead of the room exiting under a lease it could not
      // renew.
      const publishingAgain = await waitFor(() => frames.length > framesBefore + 5, 6000);
      expect(publishingAgain).toBe(true);
      // The FIRST frame after the sever, not the sixth: the run of five is what
      // rules out a single straggler that was already in flight, but the gap
      // the room actually went dark for ends at the first one back.
      const resumedMs = frames[framesBefore].at - severedAt;

      // AND THE SUBSCRIPTION CAME BACK, which is the claim about the
      // subscriber and is a different mechanism entirely: ioredis re-issues
      // the SUBSCRIBE itself out of its ready handler, and an input applied
      // after the restore is the only proof from outside that it landed.
      //
      // PUBLISHED REPEATEDLY, the way a relay heartbeats a join, because
      // pub/sub has no replay: an input issued a moment before the resubscribe
      // lands is simply gone, so a single shot would be measuring that race
      // rather than the repair.
      const resubscribed = await waitFor(async () => {
        if ((latest(frames)?.counters[PID] ?? 0) >= 2) return true;
        await send(keys.in, { t: 'in', pid: PID, w: [{ seq: 2, data: 1 }] });
        return false;
      }, 6000, 150);
      expect(resubscribed).toBe(true);

      const result = await run;
      // eslint-disable-next-line no-console
      console.log(
        `[measured] 300ms Redis outage: ticker exited '${result.reason}' after ${result.uptimeMs}ms of a ` +
          `${runMs}ms budget; snapshots resumed ~${resumedMs}ms after the sever; ${rejections.length} unhandled rejections`
      );
      // NO EXIT: the ticker ran to its configured cap, not out from under a
      // lease it lost. `duration` is the one reason that means nothing went
      // wrong.
      expect(result.reason).toBe('duration');
      expect(result.uptimeMs).toBeGreaterThanOrEqual(runMs - 100);
      expect(logs.some((ev) => ev.kind === 'ticker.lease-lost')).toBe(false);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  }, CASE_TIMEOUT_MS);

  it('A DETERMINISTIC CRASH LOOP: three thrown runs raise the crash counter, and the fourth ignores the poisoned checkpoint instead of restoring it again', async () => {
    const roomId = freshRoomId('crash-loop');
    const keys = roomKeys(roomId, namespace);
    const shared = getRedis({ url: TEST_REDIS_URL, onError: () => {} });

    /**
     * POISON IN THE STATE, NOT IN THE CLOCK. The throw is a pure function of
     * the restored tick count, which is what makes this a LOOP rather than a
     * run of unlucky invocations: every successor restores the very bytes that
     * killed its predecessor and dies in the same place. Measured before the
     * guard existed: 40 spawns in 958ms.
     */
    const POISON_TICK = 25;
    const poisoned: RoomRuntime<CounterState, CounterEvent> = {
      ...createCounterRuntime(100),
      tick: (state) => {
        state.tick += 1;
        if (state.tick >= POISON_TICK) throw new Error(`poisoned state: tick ${state.tick} cannot be simulated`);
        return { events: [{ kind: 'tick', tick: state.tick }] };
      },
    };

    const runs: { reason: string; ticks: number; logs: LogEvent[]; crashesAfter: number }[] = [];
    const spawns: { standby: boolean }[] = [];

    // The shape `examples/node-server` runs on a long-lived host, and the
    // shape a platform re-invoking a function produces on a serverless one:
    // exit, go again, on the same room.
    for (let attempt = 0; attempt < 4; attempt++) {
      const logs: LogEvent[] = [];
      const result = await runTicker({
        runtime: poisoned,
        redis: shared,
        createSubscriber: () => createSubscriber({ url: TEST_REDIS_URL, onError: () => {} }),
        roomId,
        namespace,
        geomKey: () => 'faults-crash-loop:v1',
        // Fast enough that a run reaches the poison in a quarter of a second,
        // and slow enough relative to `checkpointMs` that the FIRST run
        // genuinely stores a checkpoint for the later ones to choke on.
        checkpointMs: 100,
        statsMs: STATS_MS,
        leaseTtlMs: SHORT_LEASE_MS,
        leaseRenewMs: SHORT_RENEW_MS,
        maxRunMs: 25_000,
        emptyGraceMs: 100_000,
        spawnSuccessor: async (_room, opts) => {
          spawns.push(opts);
        },
        log: (ev) => logs.push(ev),
      });

      // The counter is bumped from the `finally` WITHOUT being awaited, so the
      // run resolving does not mean it has landed yet. Waiting for it here is
      // also the assertion that it climbs at all.
      const expected = attempt < 3 ? attempt + 1 : 1; // the fourth run clears it before crashing again
      await waitFor(async () => Number(await raw.get(keys.crashes)) === expected, 3000, 20);
      runs.push({
        reason: result.reason,
        ticks: result.ticks,
        logs,
        crashesAfter: Number(await raw.get(keys.crashes)),
      });
    }

    // eslint-disable-next-line no-console
    console.log(
      `[measured] crash loop: ${runs
        .map((r, i) => `run ${i + 1} '${r.reason}' after ${r.ticks} ticks (crashes=${r.crashesAfter})`)
        .join(', ')}`
    );

    // Every run died the same way, which is what makes the counter meaningful.
    expect(runs.map((r) => r.reason)).toEqual(['error', 'error', 'error', 'error']);
    // AND NONE OF THEM SPAWNED A SUCCESSOR, because a successor would restore
    // the same bytes and die identically: the pair would spin as fast as the
    // platform can start functions. The relay's jittered poll is the recovery
    // path for a thrown ticker, and its cadence is what paces the retries.
    expect(spawns).toEqual([]);
    expect(runs.slice(0, 3).map((r) => r.crashesAfter)).toEqual([1, 2, 3]);

    // Runs two and three restored the poison, which is the behaviour the guard
    // exists to interrupt rather than a bug: without the middle two proving
    // the checkpoint really was being restored, the fourth run's fresh start
    // would be indistinguishable from a room that never had a checkpoint.
    for (const run of runs.slice(1, 3)) {
      const restoredTick = (run.logs.find((ev) => ev.kind === 'ticker.restore')?.meta as { tick?: number } | undefined)
        ?.tick;
      expect(restoredTick).toBeGreaterThan(0);
      expect(run.logs.some((ev) => ev.kind === 'ticker.crash-loop')).toBe(false);
    }

    // THE FOURTH RUN STARTED FRESH. Past the limit the checkpoint is treated
    // as poison, which costs the room its in-progress state ONCE instead of
    // forever.
    const fourth = runs[3];
    const crashLoopLog = fourth.logs.find((ev) => ev.kind === 'ticker.crash-loop');
    expect(crashLoopLog).toBeDefined();
    expect(crashLoopLog?.meta).toMatchObject({ crashes: 3 });
    expect(fourth.logs.some((ev) => ev.kind === 'ticker.restore')).toBe(false);
    // A fresh room reaches the poison from tick 0, so it survives the full
    // count of ticks the first run did; a restored one dies within a handful.
    expect(fourth.ticks).toBeGreaterThan(runs[1].ticks);
    // `ticks` is incremented AFTER the sim step, so the tick that threw is
    // never counted: a fresh room reaches the poison on its (POISON_TICK)th
    // call and reports one fewer.
    expect(fourth.ticks).toBe(POISON_TICK - 1);
  }, CASE_TIMEOUT_MS);
});
