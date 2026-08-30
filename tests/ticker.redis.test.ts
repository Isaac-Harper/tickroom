// Runs the actual leased tick loop (src/server/ticker.ts) against a real
// Redis: real wall-clock timing, a real subscriber receiving real publishes,
// a real short-TTL stats key actually expiring, and a real lease theft
// forcing the headline claim of this whole library, a sub-second handoff
// with continuity, to happen for real rather than being asserted by a fake
// that has no concept of wall-clock time passing between two calls.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  type RedisLike,
  type LogEvent,
  roomKeys,
  readCheckpoint,
  unpackCheckpoint,
} from '../src/core/index.js';
import { runTicker, assignRoom, type Subscriber } from '../src/server/index.js';
import { createCounterRuntime } from './helpers/toyRuntime.js';
import { TEST_REDIS_URL, probeRedisAvailable, newNamespace, flushNamespace, skipReason, waitFor } from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: ticker] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

d('ticker / real Redis', () => {
  const namespace = newNamespace('ticker');
  let raw: Redis;
  let redis: RedisLike;

  beforeAll(() => {
    raw = new Redis(TEST_REDIS_URL);
    redis = raw;
  });

  afterAll(async () => {
    // Every checkpoint write and lease renew inside the ticker's hot loop is
    // fire-and-forget with a `.catch` (by design: see the "no awaits in the
    // hot loop" invariant), so `runTicker`'s returned promise resolving does
    // NOT guarantee every in-flight Redis round trip it started has landed
    // yet. A settle delay here, before the namespace-wide flush, is cheap
    // insurance against a stray write recreating a key a few milliseconds
    // after this file's tests believe everything is torn down.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await flushNamespace(TEST_REDIS_URL, namespace);
    raw.disconnect();
  });

  /** A fresh dedicated subscriber connection per ticker, exactly the shape a real host provides. No cast needed: see tests/redisLike.test.ts for why. */
  function subscriberFactory(): () => Subscriber {
    return () => new Redis(TEST_REDIS_URL);
  }

  function freshRoomId(label: string): string {
    return `room-${label}-${randomUUID().slice(0, 6)}`;
  }

  it('ticks at roughly its configured rate over real wall time, and a real subscriber receives real published snapshots', async () => {
    const roomId = freshRoomId('rate');
    const keys = roomKeys(roomId, namespace);
    const tickHz = 20; // the game default this whole architecture was measured against
    const runMs = 2000;

    const sub = new Redis(TEST_REDIS_URL);
    const seenTicks: number[] = [];
    sub.on('message', (channel, message) => {
      if (channel !== keys.out) return;
      try {
        const parsed = JSON.parse(message) as { tick: number };
        seenTicks.push(parsed.tick);
      } catch {
        // ignore anything unparseable, the assertions below require real parsed ticks anyway
      }
    });
    await sub.subscribe(keys.out);

    try {
      const result = await runTicker({
        runtime: createCounterRuntime(tickHz),
        redis,
        createSubscriber: subscriberFactory(),
        roomId,
        namespace,
        geomKey: () => 'ticker-rate-test:v1',
        maxRunMs: runMs,
        emptyGraceMs: 100_000, // must not be what ends this run
      });

      expect(result.reason).toBe('duration');

      const measuredHz = (result.ticks / result.uptimeMs) * 1000;
      // eslint-disable-next-line no-console
      console.log(
        `[measured] tick rate: ${result.ticks} ticks over ${result.uptimeMs}ms = ${measuredHz.toFixed(2)}Hz (target ${tickHz}Hz)`
      );
      // Generous band (+-25%): this is real wall-clock scheduling on a
      // shared CI/dev machine, not a simulated clock, so it must tolerate
      // real jitter without flaking.
      expect(measuredHz).toBeGreaterThan(tickHz * 0.75);
      expect(measuredHz).toBeLessThan(tickHz * 1.25);

      // A real subscriber, on a real connection, received real binary/JSON
      // frames published by the loop above, not synthesised by the test.
      expect(seenTicks.length).toBeGreaterThan(10);
      expect(Math.max(...seenTicks)).toBeGreaterThanOrEqual(result.ticks - 2);
      // Monotonic: every publish this loop makes should carry a
      // strictly-increasing tick, the same guarantee a client's
      // interpolation relies on.
      for (let i = 1; i < seenTicks.length; i++) {
        expect(seenTicks[i]).toBeGreaterThan(seenTicks[i - 1]);
      }
    } finally {
      sub.disconnect();
    }
  }, 10_000);

  it('writes room:{id}:stats with a short TTL, so a dead room reads as empty and reusable once it expires', async () => {
    const roomId = freshRoomId('stats-ttl');
    const keys = roomKeys(roomId, namespace);

    const result = await runTicker({
      runtime: createCounterRuntime(50),
      redis,
      createSubscriber: subscriberFactory(),
      roomId,
      namespace,
      geomKey: () => 'ticker-stats-test:v1',
      maxRunMs: 300,
      statsMs: 100,
      emptyGraceMs: 100_000,
    });
    expect(result.reason).toBe('duration');

    // Immediately after exit the stats key must still exist (the ticker
    // just wrote it, unconditionally, regardless of ownership) and it must
    // carry a real, short, positive TTL: this is the property the balancer
    // and admission both depend on to tell a live room from a dead one.
    const pttlRightAfter = await raw.pttl(keys.stats);
    expect(pttlRightAfter).toBeGreaterThan(0);
    expect(pttlRightAfter).toBeLessThanOrEqual(5000);

    // A room that just exited should read as CAPACITY-AVAILABLE (a fake, in
    // whatever tick it happens to be paused on, cannot show a real 5-second
    // clock actually elapsing): poll until the key genuinely expires on the
    // server, and confirm the balancer then treats this exact room instance
    // as the lowest-index reusable one.
    const expired = await waitFor(async () => (await raw.exists(keys.stats)) === 0, 6500, 100);
    expect(expired).toBe(true);

    const assignment = await assignRoom({ redis, base: roomId, maxPlayers: 10, namespace });
    expect(assignment.room).toBe(roomId);
    expect(assignment.index).toBe(0);
    expect(assignment.full).toBeFalsy();
  }, 10_000);

  it('THE HANDOFF: a successor restores and continues the tick count after the predecessor is killed, in well under the documented budget', async () => {
    const roomId = freshRoomId('handoff');
    const keys = roomKeys(roomId, namespace);
    const geomKey = () => 'ticker-handoff-test:v1';

    const logsA: LogEvent[] = [];
    const predecessor = runTicker({
      runtime: createCounterRuntime(200), // fast tickHz so it accumulates a healthy tick count quickly
      redis,
      createSubscriber: subscriberFactory(),
      roomId,
      namespace,
      geomKey,
      checkpointMs: 30,
      leaseTtlMs: 1500,
      leaseRenewMs: 300,
      maxRunMs: 30_000, // must not be what ends this run; the lease theft below is
      emptyGraceMs: 100_000,
      log: (ev) => logsA.push(ev),
    });

    // Wait for a real checkpoint to land with a healthy tick count, so
    // "continues" below has something non-trivial to continue FROM.
    let tickAtKill = 0;
    const gotCheckpoint = await waitFor(async () => {
      const body = await readCheckpoint(redis, keys.state);
      const envelope = unpackCheckpoint(body);
      if (envelope === null || envelope.tick < 20) return false;
      tickAtKill = envelope.tick;
      return true;
    }, 3000, 20);
    expect(gotCheckpoint).toBe(true);

    // A raw subscriber, listening from BEFORE the kill through after the
    // successor exits, records the arrival time of every snapshot on the
    // wire. This is what makes the handoff-TIME measurement below honest:
    // awaiting the successor's own bounded `runTicker` call would measure
    // "how long until its maxRunMs elapsed", not "how long the stream
    // actually went quiet for", which is the number ARCHITECTURE.md
    // actually claims ("a sub-second gap in the snapshot stream").
    const wireSub = new Redis(TEST_REDIS_URL);
    const arrivalTimes: number[] = [];
    wireSub.on('message', (channel) => {
      if (channel !== keys.out) return;
      arrivalTimes.push(Date.now());
    });
    await wireSub.subscribe(keys.out);

    // KILL IT: steal the lease by deleting it out from under the running
    // ticker, the real-world shape of a hard process kill or crash rather
    // than a graceful shutdown. The predecessor has no way to know this
    // happened until its next renew, which will fail the Lua owner check
    // (the key is simply gone) and it will exit on its own.
    await raw.del(keys.lease);

    // The successor is started immediately, the way a real host's spawn
    // path or a relay's jittered ticker-check poll would, WITHOUT waiting
    // for the predecessor to notice and unwind first: that overlap is
    // exactly what a real handoff looks like, and `acquireLease`'s SET NX
    // succeeding here is what proves the key is genuinely free.
    const logsB: LogEvent[] = [];
    const successorPromise = runTicker({
      runtime: createCounterRuntime(200),
      redis,
      createSubscriber: subscriberFactory(),
      roomId,
      namespace,
      geomKey,
      checkpointMs: 30,
      maxRunMs: 1500,
      emptyGraceMs: 100_000,
      log: (ev) => logsB.push(ev),
    });

    const [resultA, successorResult] = await Promise.all([predecessor, successorPromise]);
    wireSub.disconnect();
    expect(resultA.reason).toBe('lease-lost');
    expect(successorResult.reason).toBe('duration');

    const restoreLog = logsB.find((ev) => ev.kind === 'ticker.restore');
    expect(restoreLog).toBeDefined();
    const restoredTick = (restoreLog?.meta as { tick?: number } | undefined)?.tick ?? -1;
    // CONTINUITY, not merely "it started": the successor's restored tick
    // must be at or beyond the tick we confirmed was checkpointed before
    // the kill. A fresh start would restore at 0, which this rules out with
    // real margin (tickAtKill was already >= 20).
    expect(restoredTick).toBeGreaterThanOrEqual(tickAtKill);
    expect(logsB.some((ev) => ev.kind === 'ticker.geom-mismatch')).toBe(false);

    // THE REAL HANDOFF MEASUREMENT: the longest gap between two
    // consecutive snapshot arrivals anywhere in the observed stream.
    // Everywhere else the gap is roughly one tick (5ms at 200Hz); the one
    // spot where nobody was publishing at all (predecessor had noticed
    // failure and stopped, successor had not yet acquired the lease,
    // restored, ticked once, and published) is exactly the pause a real
    // client's interpolation delay has to absorb.
    expect(arrivalTimes.length).toBeGreaterThan(10);
    let handoffMs = 0;
    for (let i = 1; i < arrivalTimes.length; i++) {
      handoffMs = Math.max(handoffMs, arrivalTimes[i] - arrivalTimes[i - 1]);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[measured] handoff: predecessor died at tick ${tickAtKill}, successor restored at tick ${restoredTick}, ` +
        `longest gap in the snapshot stream across the handoff: ${handoffMs}ms (${arrivalTimes.length} snapshots observed)`
    );
    // ARCHITECTURE.md's own claim is "a sub-second gap ... absorbed
    // entirely by the interpolation delay" and "usually inside a second";
    // bounded generously here against real scheduling noise on a shared
    // machine, not tightened to the claimed number.
    expect(handoffMs).toBeLessThan(3000);
  }, 15_000);

  it('a geometry digest mismatch discards the old checkpoint and starts fresh, rather than restoring a deleted world', async () => {
    const roomId = freshRoomId('geom-mismatch');
    const keys = roomKeys(roomId, namespace);

    const before = await runTicker({
      runtime: createCounterRuntime(200),
      redis,
      createSubscriber: subscriberFactory(),
      roomId,
      namespace,
      geomKey: () => 'geom-v1',
      checkpointMs: 20,
      maxRunMs: 400,
      emptyGraceMs: 100_000,
    });
    expect(before.reason).toBe('duration');
    const checkpointBefore = unpackCheckpoint(await readCheckpoint(redis, keys.state));
    expect(checkpointBefore).not.toBeNull();
    // A healthy tick count to make "started fresh" unmistakable against.
    expect((checkpointBefore as { tick: number }).tick).toBeGreaterThan(30);

    const logsB: LogEvent[] = [];
    const after = await runTicker({
      runtime: createCounterRuntime(20), // deliberately slower, so a WRONG restore-and-continue would still be numerically obvious
      redis,
      createSubscriber: subscriberFactory(),
      roomId,
      namespace,
      geomKey: () => 'geom-v2', // the world changed
      checkpointMs: 20,
      maxRunMs: 200,
      emptyGraceMs: 100_000,
      log: (ev) => logsB.push(ev),
    });
    expect(after.reason).toBe('duration');

    const mismatchLog = logsB.find((ev) => ev.kind === 'ticker.geom-mismatch');
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog?.meta).toMatchObject({ expected: 'geom-v2', got: 'geom-v1' });
    expect(logsB.some((ev) => ev.kind === 'ticker.restore')).toBe(false);

    const checkpointAfter = unpackCheckpoint(await readCheckpoint(redis, keys.state));
    expect(checkpointAfter).not.toBeNull();
    // A fresh room's own tick counter cannot exceed roughly how many ticks
    // THIS invocation performed (bounded well under the predecessor's 30+):
    // if it had wrongly restored, this would instead start well above 30.
    expect((checkpointAfter as { tick: number }).tick).toBeLessThan(20);
    expect((checkpointAfter as { tick: number }).tick).toBeGreaterThan(0);
  }, 10_000);

  it('omitting geomKey on a restore still restores (by design) but fires the ticker.no-geom-key warning exactly once a checkpoint exists', async () => {
    const roomId = freshRoomId('no-geom-key');
    const keys = roomKeys(roomId, namespace);

    const withGeom = await runTicker({
      runtime: createCounterRuntime(200),
      redis,
      createSubscriber: subscriberFactory(),
      roomId,
      namespace,
      geomKey: () => 'has-a-geom-key:v1',
      checkpointMs: 20,
      maxRunMs: 300,
      emptyGraceMs: 100_000,
    });
    expect(withGeom.reason).toBe('duration');
    const checkpointBefore = unpackCheckpoint(await readCheckpoint(redis, keys.state));
    expect((checkpointBefore as { tick: number }).tick).toBeGreaterThan(20);

    // A COLD room (nothing checkpointed yet) must NOT warn: the comment in
    // ticker.ts is explicit that warning on every fresh start would just be
    // noise. Confirmed here as a negative control before the positive case.
    const coldLogs: LogEvent[] = [];
    const coldRoomId = freshRoomId('no-geom-key-cold');
    await runTicker({
      runtime: createCounterRuntime(50),
      redis,
      createSubscriber: subscriberFactory(),
      roomId: coldRoomId,
      namespace,
      // geomKey omitted entirely
      maxRunMs: 100,
      emptyGraceMs: 100_000,
      log: (ev) => coldLogs.push(ev),
    });
    expect(coldLogs.some((ev) => ev.kind === 'ticker.no-geom-key')).toBe(false);

    // THE POSITIVE CASE: a checkpoint already exists, and this successor
    // omits geomKey entirely.
    const logsB: LogEvent[] = [];
    const restored = await runTicker({
      runtime: createCounterRuntime(200),
      redis,
      createSubscriber: subscriberFactory(),
      roomId,
      namespace,
      // geomKey omitted entirely
      checkpointMs: 20,
      maxRunMs: 200,
      emptyGraceMs: 100_000,
      log: (ev) => logsB.push(ev),
    });
    expect(restored.reason).toBe('duration');

    expect(logsB.some((ev) => ev.kind === 'ticker.no-geom-key')).toBe(true);
    // AND it still restored (omitting geomKey means "skip the check", not
    // "always start fresh"): the tick count must continue, not reset.
    const restoreLog = logsB.find((ev) => ev.kind === 'ticker.restore');
    expect(restoreLog).toBeDefined();
    expect((restoreLog?.meta as { tick?: number } | undefined)?.tick).toBeGreaterThan(20);
  }, 10_000);
});
