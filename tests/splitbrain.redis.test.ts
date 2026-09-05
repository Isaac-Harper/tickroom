// THE SPLIT-BRAIN MEASUREMENT: how long a predecessor ticker keeps PUBLISHING
// after a successor has legitimately acquired its lease, as a function of the
// renew round trips the predecessor was seeing, against a real Redis with the
// predecessor's command connection shaped by the TCP proxy. It exists because
// the unplanned-death item in AGENTS.md owed exactly this: shortening
// `leaseTtlMs` spends the split-brain margin, and the margin had been argued
// about rather than measured.
//
// THE BOUND, DERIVED FROM THE CODE RATHER THAN FROM THE DESIGN NOTE, because
// the two differ and the code wins. Let A be the ATTEMPT time, on the
// predecessor's own clock, of the last renew Redis processed while the key
// was still the predecessor's.
//
//   1. Redis extends the key to `leaseTtlMs` from the moment it PROCESSES the
//      renew (`RENEW_SCRIPT` in src/core/lease.ts, `'PX', ARGV[2]`), which is
//      after the attempt, so the key expires no earlier than A + leaseTtlMs.
//   2. The predecessor's `lastOwnedAt` never exceeds A. Every confirmation is
//      `renewConfirmed(clock, Math.max(clock.lastOwnedAt, attemptAt))`, at
//      the setup renew, the guard's awaited renew and the loop renew in
//      src/server/ticker.ts, and never the reply time.
//   3. A snapshot is published only in an iteration whose guard passed, and
//      the guard is `mayPublish`: `now - lastOwnedAt < leaseTtlMs`
//      (src/core/lease.ts). Its issue time is therefore below A + leaseTtlMs.
//      The one exception is the guard itself: when `mayPublish` is false it
//      AWAITS a renew and, if that confirms, publishes once at attempt + RTT.
//      That frame is past the key's expiry only if the awaited round trip
//      exceeded `leaseTtlMs`, and the shipped command client bounds every
//      round trip at `commandTimeout` 2000 (src/server/redis.ts), under
//      `LEASE_TTL_MS` 5000.
//   4. A successor's `SET NX` (`acquireLease`) succeeds only once the key has
//      expired, so its acquire is at or after A + leaseTtlMs.
//
// Hence, with the shipped constants: EVERY PREDECESSOR SNAPSHOT IS ISSUED
// BEFORE THE SUCCESSOR CAN ACQUIRE, and the renew round trip does not appear
// in that statement at all. The overlap, from the successor's first publish to
// the predecessor's last, is negative by at least the successor's own acquire-
// to-first-publish time. A host that takes `leaseTtlMs` below its
// `commandTimeout` gives up point 3 and buys back at most ONE frame, issued up
// to `commandTimeout - leaseTtlMs` past expiry.
//
// WHAT THAT LEAVES, which is what the cases below measure:
//
//   - A LAPSE needs the renews to stop reaching Redis, and a steady round trip
//     of any length does not do that: renews are paced from the attempt
//     (`renewDue` reads `lastRenewAt`), so Redis sees one every `leaseRenewMs`
//     whatever the reply takes. A lapse is a dead path, and a dead path carries
//     no publishes either: the in-flight cap (`MAX_IN_FLIGHT_PUBLISHES`, 4)
//     stops the predecessor ISSUING within four ticks of the death, a whole
//     TTL before the guard would have. So the four distributions the design
//     note asked about run as "shaped, then dead", and the shaping is what the
//     predecessor's clock last saw when the path went.
//   - A path that HEALS after the TTL delivers what it was holding: at most
//     those four frames, each issued before expiry, landing after the
//     successor's first. That is the whole stale backlog the design admits,
//     and it is measured here rather than reasoned about.
//   - A THEFT (the key vanishes under a live predecessor: a Redis restart
//     without persistence, the documented open case) is not a lapse and the
//     lease clocks do not bound it. The predecessor publishes until Redis
//     refuses its next owner-checked write, the loop renew (`leaseRenewMs`)
//     or the checkpoint (`checkpointMs`), and learns of the refusal one reply
//     later: overlap <= min(leaseRenewMs, checkpointMs) + RTT + two ticks.
//     THIS is where the round trip shows, so the distributions run against it
//     as well.
//
// The duplicate-tick question has the same shape. An unplanned death restores
// the last checkpoint that landed, so the successor re-publishes every tick
// number the predecessor issued after it: the `checkpointMs` regression
// AGENTS.md documents, at most `checkpointMs / tickMs` ticks plus one, all of
// them delivered before the successor's first frame. The cases pin that bound
// rather than the zero the design never promised.
//
// EVERY OBSERVER CONNECTS DIRECTLY TO REDIS, AND SO DOES THE SUCCESSOR. The
// only thing on the shaped path is the predecessor's command client, built by
// the library's own factory so the `commandTimeout` under point 3 is the
// shipped one. The predecessor's subscriber is direct too, so the input-dead
// probe (3s) cannot end a run the lease guard is supposed to end.
//
// `TICKROOM_SPLITBRAIN_REPS` repeats every case: 1 is the CI form, 10 the long
// form for a quiet machine. The lease is the same short 1500/400 the fault
// file runs on, which is a shortened TTL, i.e. exactly the trade the
// measurement is for; the bound above has no TTL term in it.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { type LogEvent, type RoomRuntime, roomKeys } from '../src/core/index.js';
import { runTicker, getRedis, createSubscriber, resetRedisForTests } from '../src/server/index.js';
import { createCounterRuntime, type CounterEvent, type CounterState } from './helpers/toyRuntime.js';
import { startProxy, proxyTargetFrom, type FaultProxy, type ReplyShape } from './helpers/proxy.js';
import {
  TEST_REDIS_URL,
  probeRedisAvailable,
  newNamespace,
  flushNamespace,
  skipReason,
  waitFor,
} from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: splitbrain] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

/** Repetitions of every case. One is the CI form; the long form is for a quiet machine that can afford the sweep. */
const REPS = Math.max(1, Math.floor(Number(process.env.TICKROOM_SPLITBRAIN_REPS ?? '1')) || 1);

/** The same lease budget `tests/faults.redis.test.ts` runs on, for the same reason, and it is a SHORTENED TTL, which is what this measurement is for. */
const SHORT_LEASE_MS = 1500;
const SHORT_RENEW_MS = 400;

const TICK_HZ = 50;
const TICK_MS = 1000 / TICK_HZ;

/** Ten ticks, so the regression a restore carries is small and exactly countable. */
const CHECKPOINT_MS = 200;

/** How long the successor runs once it owns the room. It has no players, so `emptyGraceMs` is what ends it, and ends it cleanly. */
const SUCCESSOR_RUN_MS = 800;

/**
 * MIRRORS OF `src/server/ticker.ts`'s AND `src/server/redis.ts`'s PRIVATE
 * CONSTANTS, copied for the same reason the fault file copies its own: they
 * appear here only to bound an assertion, so a drift makes a bound loose
 * rather than wrong. `MAX_IN_FLIGHT_PUBLISHES` bounds the stale backlog a
 * healed path can deliver; `STANDBY_POLL_MS` is how long a lapsed key sits
 * free; `COMMAND_TIMEOUT_MS` is the ceiling on the guard's awaited renew.
 */
const MAX_IN_FLIGHT_PUBLISHES = 4;
const STANDBY_POLL_MS = 25;
const COMMAND_TIMEOUT_MS = 2000;

/**
 * Timer and loop jitter on a shared machine. Added only to bounds whose terms
 * are themselves `setTimeout` durations (a checkpoint cadence, a reply delay),
 * and it is not a loosening: it is the granularity those terms have. The lapse
 * bound carries none, because nothing in it is a timer.
 */
const SCHEDULING_SLACK_MS = 100;

/** Between a renew leaving for Redis and the death, so Redis has demonstrably processed it and its reply is the one in flight when the path goes. */
const RENEW_SETTLE_MS = 30;

/** How long a healed path is left dark past the successor's first frame, so the backlog demonstrably lands AFTER it. */
const HEAL_AFTER_SUCCESSOR_MS = 300;

/** Generous on purpose: the black-hole cases wait out a TTL and then the shared client's own command timeout, on a machine that is not this file's. */
const CASE_TIMEOUT_MS = 30_000;

type Owner = 'pred' | 'succ';

/** What the tagged runtime below puts on the wire: the toy's tick plus WHO issued it and WHEN, which is the whole instrument. */
interface TaggedSnapshot {
  tick: number;
  who: Owner;
  issuedAt: number;
  t: number;
}

interface Frame {
  at: number;
  snap: TaggedSnapshot;
}

/**
 * The loop's renew, by the one substring of `RENEW_SCRIPT` (src/core/lease.ts)
 * no other script in the library shares: the checkpoint's owner-checked SET
 * ends in `'EX', ARGV[3]`. ioredis sends `eval` as EVAL with the script text
 * every time, so the text is on the wire. A case that never sees one fails
 * loudly rather than waiting forever, see `runScenario`.
 */
function isRenewCommand(command: Buffer): boolean {
  return command.toString('latin1').includes("'PX', ARGV[2]) else return nil end");
}

/** A renew round-trip distribution, as the reply-side latency the predecessor's command client sees. */
interface Distribution {
  label: string;
  /** The largest reply delay the shape imposes: the RTT term of the theft bound. */
  maxDelayMs: number;
  /** How many loop renews the predecessor sends under the shape before the death, chosen so the last one is the interesting one. */
  deathAfterRenews: number;
  /** Builds the shape; `onRenew` fires as each loop renew is forwarded to Redis. */
  shape(onRenew: () => void): ReplyShape;
}

/**
 * ON THE REPLY SIDE ONLY, WHICH IS THE PESSIMISTIC HALF. The command still
 * reaches Redis at once, so the key is extended from the attempt and the
 * whole round trip lands between Redis's clock and the predecessor's: a rule
 * that dated ownership from the reply would be wrong by the full RTT here,
 * where a symmetric delay would hide half of it.
 */
function steady(delayMs: number, deathAfterRenews = 3): Distribution {
  return {
    label: delayMs === 0 ? 'unshaped' : `steady ${delayMs}ms`,
    maxDelayMs: delayMs,
    deathAfterRenews,
    shape: (onRenew) => ({
      delayMs: () => delayMs,
      onCommand: (command) => {
        if (isRenewCommand(command)) onRenew();
      },
    }),
  };
}

/**
 * A 1s spike on every third renew over a 50ms floor. The spike is applied to
 * the renew's own reply and, because the proxy keeps order, to everything
 * queued behind it, which is what a latency spike does to one connection.
 * The death lands right after the second spiked renew, so the spike is the
 * round trip the predecessor's clock last saw, and the first spike has been
 * confirmed in full before it.
 */
function spiky(): Distribution {
  return {
    label: '50ms with a 1s spike every 3rd renew',
    maxDelayMs: 1000,
    deathAfterRenews: 6,
    shape: (onRenew) => {
      let renews = 0;
      let spikeNext = false;
      return {
        onCommand: (command) => {
          if (!isRenewCommand(command)) return;
          renews++;
          if (renews % 3 === 0) spikeNext = true;
          onRenew();
        },
        delayMs: () => {
          if (spikeNext) {
            spikeNext = false;
            return 1000;
          }
          return 50;
        },
      };
    },
  };
}

/**
 * How the predecessor loses the room. `blackhole` is the fault file's death
 * case (bytes stop moving, nothing closes, the key lapses on Redis's clock);
 * `heal` is the same with the path restored after the successor's first frame,
 * so whatever the hole was holding is delivered; `theft` is the key deleted
 * under a live predecessor, the shape of a Redis restart without persistence.
 */
type Death = 'blackhole' | 'heal' | 'theft';

const DEATH_LABELS: Record<Death, string> = {
  blackhole: 'black hole',
  heal: 'black hole, healed after the TTL',
  theft: 'theft',
};

interface Scenario {
  death: Death;
  dist: Distribution;
}

const SCENARIOS: Scenario[] = [
  { death: 'blackhole', dist: steady(50) },
  { death: 'blackhole', dist: steady(400) },
  { death: 'blackhole', dist: spiky() },
  { death: 'blackhole', dist: steady(0, 2) },
  { death: 'heal', dist: steady(0, 2) },
  { death: 'theft', dist: steady(50) },
  { death: 'theft', dist: steady(400) },
  { death: 'theft', dist: spiky() },
];

/** One case's numbers, all in ms from the death unless the name says otherwise. Negative overlaps mean the predecessor stopped first. */
interface Measurement {
  label: string;
  predExit: string;
  succExit: string;
  lapse: number | null;
  acquire: number | null;
  succFirst: number;
  predLastIssue: number;
  /** How many snapshots the predecessor issued after the death at all. */
  issuedAfterDeath: number;
  /** Predecessor's last ISSUED snapshot relative to the successor's first frame on the bus. The guard's bound is on this. */
  issueOverlap: number;
  /** Predecessor's last snapshot ON THE BUS relative to the successor's first. What a client would see. */
  busOverlap: number;
  predAfterSucc: number;
  restoredTick: number;
  dupTicks: number;
  bound: string;
}

const measurements: Measurement[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

d('split brain / how long a predecessor publishes past a legitimate successor', () => {
  const namespace = newNamespace('splitbrain');
  const target = proxyTargetFrom(TEST_REDIS_URL);
  let raw: Redis;

  /** Every proxy any case started, closed centrally so a failed assertion cannot leave a listening socket behind. */
  const proxies: FaultProxy[] = [];
  /** Every direct connection a case opened: observers, and the successor's own client. */
  const observers: Redis[] = [];

  beforeAll(() => {
    raw = new Redis(TEST_REDIS_URL);
  });

  afterEach(async () => {
    for (const observer of observers.splice(0, observers.length)) observer.disconnect();
    // Closed, never restored: a black hole is holding the predecessor's
    // stalled bytes, and a restore here would deliver them into the next
    // case's Redis. `close()` drops them, which is the death staying dead.
    for (const proxy of proxies.splice(0, proxies.length)) await proxy.close();
    // `getRedis` memoizes one shared client, which each case points through
    // its own proxy. See the fault file.
    resetRedisForTests();
  });

  afterAll(async () => {
    await sleep(300);
    await flushNamespace(TEST_REDIS_URL, namespace);
    raw.disconnect();
    if (measurements.length === 0) return;
    const num = (n: number | null): string => (n === null ? '-' : String(Math.round(n))).padStart(6);
    const rows = measurements.map(
      (m) =>
        `${m.label.padEnd(58)} ${m.predExit.padEnd(21)} ${num(m.lapse)} ${num(m.acquire)} ${num(m.succFirst)} ` +
        `${String(m.issuedAfterDeath).padStart(5)} ${num(m.predLastIssue)} ${num(m.issueOverlap)} ${num(m.busOverlap)} ` +
        `${String(m.predAfterSucc).padStart(5)} ${String(m.restoredTick).padStart(5)} ${String(m.dupTicks).padStart(4)}  ${m.bound}`
    );
    // eslint-disable-next-line no-console
    console.log(
      [
        `[measured] split brain, ${REPS} rep(s) per case, lease ${SHORT_LEASE_MS}/${SHORT_RENEW_MS}, tick ${TICK_MS}ms, ` +
          `checkpoint ${CHECKPOINT_MS}ms. Columns are ms from the death: lapse (key left the predecessor), acquire ` +
          `(successor held it), succ1st (successor's first frame on the bus), issued (snapshots the predecessor ` +
          `issued after the death), predLast (the last of them); then the overlap of the predecessor's last snapshot ` +
          `past the successor's first, as issued and as seen on the bus (negative: the predecessor stopped first); ` +
          `predecessor frames landing after the successor's first; the tick the successor restored; tick numbers ` +
          `both owners published; the bound asserted.`,
        `${'case'.padEnd(58)} ${'pred exit'.padEnd(21)}  lapse acquir succ1s issud predLa ovIssu  ovBus after  rest dups  bound`,
        ...rows,
      ].join('\n')
    );
  });

  /** A direct subscriber on the room's snapshot channel, timestamping every frame and keeping the owner tag it carries. */
  async function watchSnapshots(channel: string): Promise<Frame[]> {
    const sub = new Redis(TEST_REDIS_URL);
    observers.push(sub);
    const frames: Frame[] = [];
    sub.on('message', (ch: string, message: string) => {
      if (ch !== channel) return;
      try {
        frames.push({ at: Date.now(), snap: JSON.parse(message) as TaggedSnapshot });
      } catch {
        // Only the tagged runtime publishes here, and it publishes JSON.
      }
    });
    await sub.subscribe(channel);
    return frames;
  }

  /** The toy runtime with an `encodeSnapshot` that signs each frame with its owner and its issue time. Both tickers share the toy's `serialize`, so the successor restores the predecessor's checkpoint. */
  function taggedRuntime(who: Owner, issued: number[]): RoomRuntime<CounterState, CounterEvent> {
    return {
      ...createCounterRuntime(TICK_HZ),
      encodeSnapshot: (state, serverTimeMs) => {
        const issuedAt = Date.now();
        issued.push(issuedAt);
        return JSON.stringify({ tick: state.tick, who, issuedAt, t: serverTimeMs } satisfies TaggedSnapshot);
      },
    };
  }

  function firstFrame(frames: Frame[], who: Owner): Frame | null {
    return frames.find((f) => f.snap.who === who) ?? null;
  }

  function lastFrame(frames: Frame[], who: Owner): Frame | null {
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if (frame.snap.who === who) return frame;
    }
    return null;
  }

  interface LeaseWatch {
    /** First time the key read as anything but the predecessor's owner id (null or a successor). */
    lapsedAt: number | null;
    /** First time it read as somebody else's. */
    acquiredAt: number | null;
    stop(): void;
  }

  /** Polls the lease key from outside every 10ms. Lags the truth by at most one poll plus a direct round trip, and only ever late, never early. */
  function watchLease(key: string, predOwner: string): LeaseWatch {
    let stopped = false;
    const watch: LeaseWatch = {
      lapsedAt: null,
      acquiredAt: null,
      stop: () => {
        stopped = true;
      },
    };
    void (async () => {
      while (!stopped) {
        const value = await raw.get(key);
        const at = Date.now();
        if (value !== predOwner) {
          if (watch.lapsedAt === null) watch.lapsedAt = at;
          if (value !== null) {
            watch.acquiredAt = at;
            return;
          }
        }
        await sleep(10);
      }
    })().catch(() => {});
    return watch;
  }

  function finderOf(logs: LogEvent[]): string {
    return (logs.find((ev) => ev.kind === 'ticker.lease-lost')?.meta as { finder?: string } | undefined)?.finder ?? 'none';
  }

  async function runScenario({ death, dist }: Scenario, label: string): Promise<Measurement> {
    const roomId = `room-${death}-${randomUUID().slice(0, 6)}`;
    const keys = roomKeys(roomId, namespace);
    const geomKey = (): string => 'splitbrain:v1';
    const proxy = await startProxy(target);
    proxies.push(proxy);
    const frames = await watchSnapshots(keys.out);

    // THE PREDECESSOR: the shipped command client, through the proxy. Its
    // subscriber is direct, see the header.
    const predLogs: LogEvent[] = [];
    const predIssued: number[] = [];
    const shared = getRedis({ url: proxy.url, onError: () => {} });
    const predecessor = runTicker({
      runtime: taggedRuntime('pred', predIssued),
      redis: shared,
      createSubscriber: () => createSubscriber({ url: TEST_REDIS_URL, onError: () => {} }),
      roomId,
      namespace,
      geomKey,
      checkpointMs: CHECKPOINT_MS,
      leaseTtlMs: SHORT_LEASE_MS,
      leaseRenewMs: SHORT_RENEW_MS,
      maxRunMs: 25_000,
      emptyGraceMs: 100_000,
      log: (ev) => predLogs.push(ev),
    });

    // Let it own the room properly first: two checkpoints down, so the
    // successor has a real restore to do and the regression is measured
    // against something.
    const settled = await waitFor(
      () => (lastFrame(frames, 'pred')?.snap.tick ?? 0) >= 2 * (CHECKPOINT_MS / TICK_MS),
      6000
    );
    expect(settled).toBe(true);
    const predOwner = await raw.get(keys.lease);
    expect(predOwner).not.toBeNull();

    // Shape the path, put the successor on the poll, and watch the key from
    // outside. The successor is a STANDBY, i.e. the real successor path: it
    // polls `SET NX` every 25ms and wins the instant the key is free.
    let renews = 0;
    proxy.delayReplies(
      dist.shape(() => {
        renews++;
      })
    );
    const lease = watchLease(keys.lease, predOwner as string);
    const succLogs: LogEvent[] = [];
    const succIssued: number[] = [];
    // Hand-rolled rather than `getRedis`, which is memoized and is already
    // the predecessor's. This path is not under measurement.
    const direct = new Redis(TEST_REDIS_URL);
    observers.push(direct);
    const successor = runTicker({
      runtime: taggedRuntime('succ', succIssued),
      redis: direct,
      createSubscriber: () => createSubscriber({ url: TEST_REDIS_URL, onError: () => {} }),
      roomId,
      namespace,
      geomKey,
      checkpointMs: CHECKPOINT_MS,
      leaseTtlMs: SHORT_LEASE_MS,
      leaseRenewMs: SHORT_RENEW_MS,
      standbyMs: 20_000,
      maxRunMs: 30_000,
      emptyGraceMs: SUCCESSOR_RUN_MS,
      log: (ev) => succLogs.push(ev),
    });

    // THE SHAPED PHASE: the predecessor renews under the distribution until
    // the death is due, with the successor already polling.
    const sawRenews = await waitFor(() => renews >= dist.deathAfterRenews, 8000, 5);
    expect(sawRenews, 'no renew command matched on the wire: has RENEW_SCRIPT changed?').toBe(true);
    await sleep(RENEW_SETTLE_MS);
    // THE DISTRIBUTION ALONE DID NOT LAPSE THE LEASE. Renews are paced from
    // the attempt, so Redis saw one every `leaseRenewMs` however late the
    // replies ran, and the polling successor never got in. This is the half
    // of the two-clock rule the fault file cannot see.
    expect(lease.lapsedAt).toBeNull();

    const deathAt = Date.now();
    if (death === 'theft') await raw.del(keys.lease);
    else proxy.blackhole();

    const tookOver = await waitFor(() => firstFrame(frames, 'succ') !== null, SHORT_LEASE_MS + 4000, 5);
    expect(tookOver).toBe(true);
    const succFirstFrameAt = (firstFrame(frames, 'succ') as Frame).at;

    let healedAt: number | null = null;
    if (death === 'heal') {
      await sleep(HEAL_AFTER_SUCCESSOR_MS);
      healedAt = Date.now();
      proxy.restore();
    }

    const [resultP, resultS] = await Promise.all([predecessor, successor]);
    lease.stop();
    // Publishes are fire-and-forget, and a frame still in flight when either
    // run resolved is exactly what this file is looking for.
    await sleep(300);

    const pred = frames.filter((f) => f.snap.who === 'pred');
    const succ = frames.filter((f) => f.snap.who === 'succ');
    const predLastFrameAt = pred[pred.length - 1].at;
    const predLastIssuedAt = predIssued[predIssued.length - 1];
    const predIssuedAfterDeath = predIssued.filter((t) => t > deathAt);
    const predAfterSucc = pred.filter((f) => f.at > succFirstFrameAt);
    const restoredTick =
      (succLogs.find((ev) => ev.kind === 'ticker.restore')?.meta as { tick?: number } | undefined)?.tick ?? -1;
    const predTicks = new Set(pred.map((f) => f.snap.tick));
    const dupTicks = [...new Set(succ.map((f) => f.snap.tick))].filter((t) => predTicks.has(t)).sort((a, b) => a - b);
    const finder = finderOf(predLogs);
    const issueOverlap = predLastIssuedAt - succFirstFrameAt;
    const busOverlap = predLastFrameAt - succFirstFrameAt;
    // The theft bound: nothing in the lease clocks ends a theft, the next
    // owner-checked write does, one reply after it is issued. The lapse bound
    // is strict zero and carries no slack, see the assertions.
    const theftBoundMs = Math.min(SHORT_RENEW_MS, CHECKPOINT_MS) + dist.maxDelayMs + 2 * TICK_MS + SCHEDULING_SLACK_MS;
    const bound = death === 'theft' ? `<= ${theftBoundMs}` : '< 0';

    // RECORDED BEFORE ANYTHING IS ASSERTED, because a case that fails its
    // bound is the one whose numbers matter most.
    const measurement: Measurement = {
      label,
      predExit: `${resultP.reason}/${finder}`,
      succExit: resultS.reason,
      lapse: lease.lapsedAt === null ? null : lease.lapsedAt - deathAt,
      acquire: lease.acquiredAt === null ? null : lease.acquiredAt - deathAt,
      succFirst: succFirstFrameAt - deathAt,
      predLastIssue: predLastIssuedAt - deathAt,
      issuedAfterDeath: predIssuedAfterDeath.length,
      issueOverlap,
      busOverlap,
      predAfterSucc: predAfterSucc.length,
      restoredTick,
      dupTicks: dupTicks.length,
      bound,
    };
    measurements.push(measurement);
    // eslint-disable-next-line no-console
    console.log(
      `[measured] ${label}: predecessor exited '${resultP.reason}' (finder '${finder}'), successor '${resultS.reason}'; ` +
        `key left the predecessor ${measurement.lapse ?? '-'}ms after the death and was the successor's at ` +
        `${measurement.acquire ?? '-'}ms; successor's first frame at ${measurement.succFirst}ms; predecessor issued ` +
        `${predIssuedAfterDeath.length} more snapshots after the death, the last at ${measurement.predLastIssue}ms, ` +
        `i.e. ${issueOverlap}ms past the successor's first frame (on the bus ${busOverlap}ms); ` +
        `${predAfterSucc.length} predecessor frames landed after it` +
        (healedAt === null ? '' : ` (path healed at ${healedAt - deathAt}ms)`) +
        `; successor restored tick ${restoredTick}; ${dupTicks.length} tick numbers published by both` +
        (dupTicks.length === 0 ? '' : ` (${dupTicks[0]} to ${dupTicks[dupTicks.length - 1]})`) +
        `; bound ${bound}`
    );

    expect(resultP.reason).toBe('lease-lost');
    expect(resultS.reason).toBe('empty');
    expect(restoredTick).toBeGreaterThan(0);
    // The regression is contiguous from the restored tick: the successor's
    // first frame is that tick plus one, and it was the predecessor's too.
    expect(succ[0].snap.tick).toBe(restoredTick + 1);

    if (death === 'theft') {
      expect(['checkpoint', 'renew']).toContain(finder);
      expect(issueOverlap).toBeLessThanOrEqual(theftBoundMs);
      expect(busOverlap).toBeLessThanOrEqual(theftBoundMs);
      // The successor was sitting on the poll, which is what makes the theft
      // the worst case: it is publishing within a poll and a restore.
      expect(succFirstFrameAt - deathAt).toBeLessThan(STANDBY_POLL_MS + SCHEDULING_SLACK_MS + 4 * TICK_MS);
    } else {
      // THE LAPSE BOUND, points 1 to 4 in the header: the predecessor's last
      // snapshot was ISSUED before the successor could acquire, so before the
      // successor's first frame by construction, and by a margin the renew
      // round trip has no part in. Strict, with no slack term, because nothing
      // in it is a timer: it is a comparison of one clock against a key that
      // same clock's owner extended.
      expect(issueOverlap).toBeLessThan(0);
      // The same fact from the death's side: every snapshot was issued before
      // the key, last extended `RENEW_SETTLE_MS` or more before the death,
      // could have expired.
      expect(predLastIssuedAt - deathAt).toBeLessThan(SHORT_LEASE_MS - RENEW_SETTLE_MS);
      expect(finder).toBe('guard');
      // The lapse came from the death and not before it, a full TTL after the
      // last renew Redis processed, and the successor was in within a poll.
      expect(lease.lapsedAt).not.toBeNull();
      expect((lease.lapsedAt as number) - deathAt).toBeGreaterThanOrEqual(SHORT_LEASE_MS - SCHEDULING_SLACK_MS);
      expect(succFirstFrameAt - deathAt).toBeLessThan(SHORT_LEASE_MS + COMMAND_TIMEOUT_MS);
      // WHAT A DEAD PATH LETS THE PREDECESSOR ISSUE: one snapshot per reply
      // that was still in flight when the path went (each frees a slot as it
      // drains, up to the shape's delay later), never more than the cap, and
      // none once the cap is full of publishes that will never resolve.
      expect(predIssuedAfterDeath.length).toBeLessThanOrEqual(MAX_IN_FLIGHT_PUBLISHES);
      expect(predLastIssuedAt - deathAt).toBeLessThan(dist.maxDelayMs + 2 * TICK_MS + SCHEDULING_SLACK_MS);
      if (death === 'blackhole') {
        // A dead path delivers nothing, so the bus agrees with the issue
        // order: not one predecessor frame after the successor's first, and
        // the duplicated tick numbers are the checkpoint regression exactly.
        expect(predAfterSucc).toHaveLength(0);
        expect(busOverlap).toBeLessThan(0);
        expect(dupTicks.length).toBeLessThanOrEqual(CHECKPOINT_MS / TICK_MS + 1);
      } else {
        // THE STALE BACKLOG: what a healed path delivers is bounded by the
        // in-flight cap, every frame of it was issued before the successor
        // existed, and none of it landed before the heal.
        expect(predAfterSucc.length).toBeGreaterThanOrEqual(1);
        expect(predAfterSucc.length).toBeLessThanOrEqual(MAX_IN_FLIGHT_PUBLISHES);
        for (const frame of predAfterSucc) {
          expect(frame.snap.issuedAt).toBeLessThan(succFirstFrameAt);
          expect(frame.at).toBeGreaterThanOrEqual(healedAt as number);
        }
        expect(dupTicks.length).toBeLessThanOrEqual(CHECKPOINT_MS / TICK_MS + 1 + MAX_IN_FLIGHT_PUBLISHES);
      }
    }
    return measurement;
  }

  for (const scenario of SCENARIOS) {
    const label = `${DEATH_LABELS[scenario.death]} / ${scenario.dist.label}`;
    for (let rep = 1; rep <= REPS; rep++) {
      it(
        REPS === 1 ? label : `${label} (rep ${rep} of ${REPS})`,
        async () => {
          await runScenario(scenario, label);
        },
        CASE_TIMEOUT_MS
      );
    }
  }
});
