import { describe, it, expect, vi } from 'vitest';
import {
  SnapshotInterpolator,
  OFFSET_SLEW_MAX,
  OFFSET_FLOOR_SLACK_MS,
  TIMELINE_STEP_FRAMES,
  RESUME_GLIDE_MAX_MS,
  type InterpolatedEntity,
  type SnapshotFrame,
} from './interpolation.js';

type Pose = { x: number; y: number; heading?: number };

/**
 * `serverTime` and `receivedAt` are SEPARATE PARAMETERS here, and that is the
 * whole point of this helper.
 *
 * The version this replaced took one timestamp and assigned it to both, so
 * every test in this file ran a network where the local clock and the server
 * clock were identical by construction, with zero one-way delay and zero
 * jitter. On such a network arrival-clock playback and server-clock playback
 * are indistinguishable, which is exactly why a fully green suite of twelve
 * tests never noticed that this module timed playback against the arrival
 * clock. The one axis that decides whether remote motion is smooth was the one
 * axis no test ever varied.
 */
function frame(serverTime: number, receivedAt: number, entities: Record<string, Pose>): SnapshotFrame<string> {
  return {
    serverTime,
    receivedAt,
    entities: new Map(Object.entries(entities)),
  };
}

/** Deterministic jitter source, so a "jittery network" test is reproducible rather than flaky. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

interface Arrival {
  serverTime: number;
  receivedAt: number;
  entities: Record<string, Pose>;
}

/**
 * Push arrivals and sample on a render clock, interleaved the way a real host
 * does it (a socket callback pushing, a rAF loop sampling, both on one clock),
 * and return the per-step rendered motion after `warmupMs`.
 */
function drive(
  interp: SnapshotInterpolator<string>,
  arrivals: Arrival[],
  opts: { untilMs: number; warmupMs: number; hz?: number; key?: string },
): {
  speeds: number[];
  xs: number[];
  lastX: number;
  lastNow: number;
  /** Every rendered frame of the whole run, warmup included, so a test can measure how long a disturbance took to clear rather than only the steady state after it. `delay` rides along because the adaptive delay is subtracted from the playhead: a profile's rendered speed and the delay's movement are the same measurement seen twice. */
  track: { now: number; x: number; extrapolated: boolean; delay: number }[];
  frameMs: number;
} {
  const hz = opts.hz ?? 60;
  const frameMs = 1000 / hz;
  const dt = 1 / hz;
  const key = opts.key ?? 'a';
  const speeds: number[] = [];
  const xs: number[] = [];
  const track: { now: number; x: number; extrapolated: boolean; delay: number }[] = [];
  let next = 0;
  let prev: { x: number; y: number } | null = null;
  let lastX = NaN;
  let lastNow = 0;

  for (let now = 0; now <= opts.untilMs; now += frameMs) {
    while (next < arrivals.length && arrivals[next]!.receivedAt <= now) {
      const a = arrivals[next]!;
      interp.push(frame(a.serverTime, a.receivedAt, a.entities));
      next++;
    }
    const e = interp.sample(dt, now).get(key);
    lastNow = now;
    if (!e) {
      prev = null;
      continue;
    }
    lastX = e.x;
    track.push({ now, x: e.x, extrapolated: e.extrapolated, delay: interp.delayMs });
    if (now >= opts.warmupMs && prev) {
      speeds.push(Math.hypot(e.x - prev.x, e.y - prev.y) / dt);
      xs.push(e.x);
    }
    prev = { x: e.x, y: e.y };
  }

  return { speeds, xs, lastX, lastNow, track, frameMs };
}

/** Longest unbroken run of extrapolated frames after `fromMs`, in ms. The measure of how long playback went without confirmed data on both sides of the playhead, which is what a stranded playhead reads as. */
function longestExtrapolationMs(
  track: { now: number; extrapolated: boolean }[],
  fromMs: number,
  frameMs: number,
): number {
  let worst = 0;
  let run = 0;
  for (const t of track) {
    if (t.now < fromMs) continue;
    run = t.extrapolated ? run + 1 : 0;
    if (run > worst) worst = run;
  }
  return worst * frameMs;
}

/**
 * Longest stretch after `fromMs` in which the entity was absent from the
 * rendered output entirely, in ms. `drive` records only the frames it actually
 * rendered, so a hole in `track`'s timeline IS a dropout: the entity popped out
 * of existence for that long, which no other measure here notices because they
 * all skip a frame with nothing in it.
 */
function longestDropoutMs(track: { now: number }[], fromMs: number, frameMs: number): number {
  let worst = 0;
  for (let i = 1; i < track.length; i++) {
    if (track[i]!.now < fromMs) continue;
    // Counted in whole render frames rather than differenced directly, because
    // the render clock accumulates 1000/60 and a float residue is not a dropout.
    const gap = (Math.round((track[i]!.now - track[i - 1]!.now) / frameMs) - 1) * frameMs;
    if (gap > worst) worst = gap;
  }
  return worst;
}

/** Per-frame rendered position steps after `fromMs`, in units. The rendered motion itself, which is where a speed spike or a backward rewind shows up. */
function stepsAfter(track: { now: number; x: number }[], fromMs: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < track.length; i++) {
    if (track[i]!.now < fromMs) continue;
    out.push(track[i]!.x - track[i - 1]!.x);
  }
  return out;
}

/**
 * A stream on a uniform arrival cadence whose `serverTime` STEPS at one tick,
 * while the entity keeps moving at a constant speed in real time.
 *
 * That is a ticker handoff: `src/server/ticker.ts` stamps `serverTime` from the
 * running instance's own `Date.now()`, so a successor on a different machine
 * carries that machine's clock skew, in either direction. Positions are keyed
 * to the TICK INDEX rather than to `serverTime`, because the entity's real
 * motion is unaffected by which clock the authority happens to stamp with.
 */
function serverTimeStep(opts: {
  ticks: number;
  tickMs: number;
  speed: number;
  latencyMs: number;
  stepAtTick: number;
  stepMs: number;
}): Arrival[] {
  const out: Arrival[] = [];
  let serverTime = 0;
  for (let i = 0; i < opts.ticks; i++) {
    if (i === opts.stepAtTick) serverTime += opts.stepMs;
    out.push({
      serverTime,
      receivedAt: i * opts.tickMs + opts.latencyMs,
      entities: { a: { x: (opts.speed * i * opts.tickMs) / 1000, y: 0 } },
    });
    serverTime += opts.tickMs;
  }
  return out;
}

/**
 * A CLEAN TICKER HANDOFF, which is the profile the extrapolation unwind is
 * measured against and is not the same thing as a network gap.
 *
 * The predecessor dies and the successor takes the lease a moment later, so
 * nothing simulates the room for the length of the gap: the WORLD PAUSES. The
 * successor then stamps `serverTime` from its own `Date.now()`, which has kept
 * running the whole time, so the axis playback runs on advances across a gap
 * the entity did not move through. A client that extrapolated forward into the
 * gap therefore finds, when the stream comes back, that the truth is where the
 * entity already was rather than ahead of it.
 */
function tickerHandoff(opts: {
  ticks: number;
  tickMs: number;
  speed: number;
  latencyMs: number;
  gapStartTick: number;
  gapTicks: number;
}): Arrival[] {
  const out: Arrival[] = [];
  let worldMs = 0;
  for (let i = 0; i < opts.ticks; i++) {
    if (i >= opts.gapStartTick && i < opts.gapStartTick + opts.gapTicks) continue;
    out.push({
      serverTime: i * opts.tickMs,
      receivedAt: i * opts.tickMs + opts.latencyMs,
      entities: { a: { x: (opts.speed * worldMs) / 1000, y: 0 } },
    });
    worldMs += opts.tickMs;
  }
  return out;
}

/**
 * A 450ms head-of-line hold covering nine ticks of a 20Hz stream, all nine
 * delivered as a burst the moment it clears, on a link that is otherwise calm
 * at 40ms. Once at tick `at`, and again every `repeatEvery` ticks if given.
 *
 * The one-off is a single hiccup, the ordinary shape of a bad moment on a good
 * connection; the repeating one is what `INTERP_MAX_MS`'s ceiling is sized
 * against. The delay has to cover the second and unwind after the first, which
 * is why one constant is measured against both.
 */
function holdProfile(opts: { ticks: number; at: number; repeatEvery?: number }): Arrival[] {
  return straightLine({
    ticks: opts.ticks,
    tickMs: 50,
    speed: 100,
    latency: (i) => {
      if (i < opts.at) return 40;
      const n = opts.repeatEvery ? (i - opts.at) % opts.repeatEvery : i - opts.at;
      if (n < 9) return 40 + 450 - n * 50 + n * 0.75;
      return 40;
    },
  });
}

/**
 * A RECONNECT THE WAY `RoomConnection` PERFORMS ONE. The socket drops and its
 * snapshots are lost rather than delayed; the host keeps drawing the poses it
 * last had; the epoch turns over at reopen (`clear()`, plus `resumeFrom` when
 * `seed` is set); the stream comes back on the same timeline, having carried on
 * without the client the whole time.
 *
 * The track is the HOST's rendered pose, which is deliberately NOT the same as
 * the interpolator's output: while the new epoch has no snapshot yet `sample()`
 * returns nothing at all and the host is still drawing the held pose. Measuring
 * the interpolator's own output would skip exactly the frames where the snap
 * and the freeze live.
 */
function reconnectRun(
  interp: SnapshotInterpolator<string>,
  opts: { arrivals: Arrival[]; dropAtMs: number; outageMs: number; untilMs: number; seed: boolean },
): { track: { now: number; x: number }[]; frameMs: number; reopenAt: number; firstLiveAt: number } {
  const frameMs = 1000 / 60;
  const reopenAt = opts.dropAtMs + opts.outageMs;
  // A dropped socket loses its snapshots; it does not queue them.
  const arrivals = opts.arrivals.filter((a) => a.receivedAt < opts.dropAtMs || a.receivedAt >= reopenAt);
  const track: { now: number; x: number }[] = [];
  let next = 0;
  let reconnected = false;
  let firstLiveAt = Infinity;
  // What the host is still drawing: the MAP `sample()` last returned, kept whole
  // the way `RoomConnection` keeps it, so the seed carries the measured speed
  // and not just a position. Handing a bare `{x, y}` here is what hid the fact
  // that the clamp had nothing to clamp against.
  let held = new Map<string, InterpolatedEntity>();

  for (let now = 0; now <= opts.untilMs; now += frameMs) {
    while (next < arrivals.length && arrivals[next]!.receivedAt <= now) {
      const a = arrivals[next]!;
      interp.push(frame(a.serverTime, a.receivedAt, a.entities));
      next++;
    }
    if (!reconnected && now >= reopenAt) {
      // EXACTLY `RoomConnection.beginEpoch()`'s ORDER, which is the whole point
      // of driving it this way: clear, then hand back what is still on screen.
      reconnected = true;
      interp.clear();
      if (opts.seed) interp.resumeFrom(held);
    }
    const out = interp.sample(1 / 60, now);
    if (out.size > 0) {
      held = out;
      // The first frame the NEW epoch actually rendered. Before it there is
      // nothing buffered at all and holding is the only option there is; after
      // it, holding is a choice.
      if (reconnected && firstLiveAt === Infinity) firstLiveAt = now;
    }
    track.push({ now, x: held.get('a')?.x ?? 0 });
  }

  return { track, frameMs, reopenAt, firstLiveAt };
}

/** Per-frame rendered SPEED after `fromMs`, signed, so a rewind reads as a negative rather than as a magnitude. */
function speedsAfter(track: { now: number; x: number }[], fromMs: number, frameMs: number): number[] {
  return stepsAfter(track, fromMs).map((d) => d / (frameMs / 1000));
}

/** Newest pose DELIVERED by local time `now`, for the streams above: every tick lands exactly `latencyMs` after it was emitted. */
function newestDeliveredX(now: number, tickMs: number, speed: number, latencyMs: number): number {
  const i = Math.floor((now - latencyMs) / tickMs);
  return (speed * i * tickMs) / 1000;
}

/** A constant-velocity entity on a uniform server grid: the simplest world in which any rendered speed other than `speed` is an artifact of this module. */
function straightLine(opts: {
  ticks: number;
  tickMs: number;
  speed: number;
  latency: (i: number, serverTime: number) => number;
}): Arrival[] {
  const out: Arrival[] = [];
  let prev = -Infinity;
  for (let i = 0; i < opts.ticks; i++) {
    const serverTime = i * opts.tickMs;
    // Arrival order is physical: nothing can land before what came before it.
    const receivedAt = Math.max(prev, serverTime + opts.latency(i, serverTime));
    prev = receivedAt;
    out.push({ serverTime, receivedAt, entities: { a: { x: (opts.speed * serverTime) / 1000, y: 0 } } });
  }
  return out;
}

describe('SnapshotInterpolator', () => {
  it('interpolates a midpoint between two frames', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 100, minDelayMs: 50, maxDelayMs: 200 });
    // 30ms of one-way delay, so the two clocks genuinely differ and the
    // playhead has to be corrected onto the server's timeline to land anywhere
    // near the middle of the bracket.
    interp.push(frame(0, 30, { a: { x: 0, y: 0 } }));
    interp.push(frame(200, 230, { a: { x: 10, y: 0 } }));

    // Playback point is (localClock - clockOffset) - delayMs. The offset is
    // seeded from the first push at exactly 30ms, and with only two samples
    // the delay target has not moved off startDelayMs, so a local clock of
    // 230 puts the playhead at server time 100: exactly between the frames.
    let out = interp.sample(0.05, 130);
    out = interp.sample(0.05, 230);
    const a = out.get('a');
    expect(a).toBeDefined();
    expect(a!.x).toBeCloseTo(5, 6);
    expect(a!.extrapolated).toBe(false);
  });

  it('extrapolates on underrun instead of freezing, and caps the extrapolation horizon', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250, extrapCapMs: 150 });
    interp.push(frame(0, 40, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, 90, { a: { x: 5, y: 0 } })); // velocity: 100 units/sec in x

    // Playhead way past the newest frame: a real gap/drop.
    const out = interp.sample(0.05, 40 + 50 + 50 + 1000);
    const a = out.get('a');
    expect(a).toBeDefined();
    expect(a!.extrapolated).toBe(true);
    // Capped at 150ms of extrapolation from the newest frame at 100 units/sec => +15 units past x=5.
    expect(a!.x).toBeCloseTo(5 + 100 * 0.15, 5);
  });

  it('extrapolation never freezes: position keeps advancing (bounded) rather than sticking to the last confirmed pose', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250, extrapCapMs: 150 });
    interp.push(frame(0, 40, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, 90, { a: { x: 5, y: 0 } }));

    const early = interp.sample(0.05, 160); // playhead just past newest frame
    const later = interp.sample(0.05, 200); // playhead further past, still under the cap
    const xEarly = early.get('a')!.x;
    const xLater = later.get('a')!.x;
    expect(xLater).toBeGreaterThan(xEarly);
  });

  it('derives the extrapolation velocity from the SERVER-time span, not the arrival gap', () => {
    // Two frames one server tick (50ms) apart that a burst delivered 5ms
    // apart. They describe 5 units of motion over 50ms of world time, i.e.
    // 100 u/s. Dividing by the 5ms arrival gap instead reads 1000 u/s, and a
    // capped 150ms extrapolation at that speed overshoots by 150 units rather
    // than 15. Measured on a bursty profile, that single error accounted for a
    // 26-unit one-frame jump on an entity moving 5 units per tick.
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250, extrapCapMs: 150 });
    interp.push(frame(0, 0, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, 5, { a: { x: 5, y: 0 } }));

    const a = interp.sample(0.05, 1000).get('a')!;
    expect(a.extrapolated).toBe(true);
    expect(a.x).toBeCloseTo(5 + 100 * 0.15, 3);
    expect(a.x).toBeLessThan(25); // the arrival-gap velocity would put this at ~155
  });

  it('heading interpolates the shortest arc across the +-pi wrap', () => {
    // THIS TEST HAS TO LAND ON THE INTERPOLATE BRANCH, and the version it
    // replaced did not. With only two frames buffered, a playhead at the newer
    // one's `serverTime` is an UNDERRUN (`i === frames.length - 1`), which
    // extrapolates position and copies the newest frame's heading through
    // untouched: `lerpHeading` was never called, and replacing its body with a
    // plain linear lerp (the exact bug this test names) left the whole suite
    // green. A THIRD frame is what makes the midpoint a real bracket.
    //
    // The delay is pinned (min === max === start) so the adaptive target
    // cannot ease it off 50 the moment three offset samples exist and slide
    // the playhead off the midpoint.
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 50 });
    const near = Math.PI - 0.1;
    interp.push(frame(0, 20, { a: { x: 0, y: 0, heading: near } }));
    interp.push(frame(100, 120, { a: { x: 0, y: 0, heading: -near } })); // wraps the short way, through pi, not back through 0
    interp.push(frame(200, 220, { a: { x: 0, y: 0, heading: -near } }));

    // Offset seeded at 20, delay pinned at 50, so a local clock of 120 puts the
    // playhead at server time 50: the true midpoint of the bracket [0, 100],
    // with a third frame beyond it so this is an interpolation and not an
    // extrapolation.
    const out = interp.sample(0.05, 120);
    const a = out.get('a')!;
    expect(a.extrapolated).toBe(false);
    const heading = a.heading!;
    // The short way from (pi - 0.1) to (-(pi - 0.1)) passes through +-pi, so
    // the midpoint heading's absolute value must stay large (near pi), not
    // collapse toward 0 (which is what a naive linear lerp would produce).
    expect(Math.abs(heading)).toBeGreaterThan(2.5);

    // AND THE OUTER WRAP, WHICH FRAC 0.5 ALONE CANNOT SEE. The midpoint is the
    // one fraction where the wrapped and unwrapped results agree: the sum
    // lands exactly on +-pi. So `lerpHeading` stripped of its outer
    // `wrapAngle`, keeping only the shortest-arc delta, passes everything
    // above while returning headings outside the (-pi, pi] range every
    // consumer of one assumes. Probe a fraction where the two differ: a local
    // clock of 145 puts the playhead at server time 75, three quarters through
    // the same bracket, where the unwrapped sum is 3.1916 rather than -3.0916.
    const late = interp.sample(0.05, 145).get('a')!;
    expect(late.extrapolated).toBe(false);
    expect(late.heading!).toBeGreaterThan(-Math.PI);
    expect(late.heading!).toBeLessThanOrEqual(Math.PI);
    expect(late.heading!).toBeCloseTo(-3.0916, 3);
  });

  it('the adaptive delay grows under injected jitter and stays clamped to [min,max]', () => {
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 80, maxDelayMs: 250, startDelayMs: 80 });
    // A uniform 50ms server grid whose ARRIVALS jitter by up to 200ms above a
    // 40ms floor. The quantity the delay is sized from is that excess above
    // the floor, so the target climbs well past the 80ms minimum.
    const rnd = prng(0xbeef);
    const arrivals = straightLine({ ticks: 200, tickMs: 50, speed: 100, latency: () => 40 + rnd() * 200 });
    drive(interp, arrivals, { untilMs: 10_000, warmupMs: 10_000 });

    expect(interp.delayMs).toBeGreaterThan(80);
    expect(interp.delayMs).toBeLessThanOrEqual(250);
  });

  it('the adaptive delay never exceeds maxDelayMs even under extreme jitter', () => {
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 80, maxDelayMs: 200, startDelayMs: 80 });
    const rnd = prng(0xf00d);
    const arrivals = straightLine({ ticks: 200, tickMs: 50, speed: 100, latency: () => 40 + rnd() * 900 });
    drive(interp, arrivals, { untilMs: 20_000, warmupMs: 20_000 });

    expect(interp.delayMs).toBeLessThanOrEqual(200);
  });

  it('the adaptive delay GROWS under a delivery burst rather than shrinking', () => {
    // The estimator this replaced took a p95 of recent INTER-ARRIVAL GAPS. A
    // burst is a run of near-zero gaps, so it flooded that ring with tiny
    // samples and pulled the delay DOWN at exactly the moment more buffer was
    // needed: measured at 87.95ms under ordinary jitter versus 80.45ms under
    // bursts, the wrong way round. Excess above the clock-offset floor moves
    // the right way, because a burst is a set of packets that were all held.
    const grid = { ticks: 400, tickMs: 50, speed: 100 };

    const steady = new SnapshotInterpolator<string>();
    drive(steady, straightLine({ ...grid, latency: () => 40 }), { untilMs: 20_000, warmupMs: 20_000 });

    // Every 40th tick opens a 250ms head-of-line stall covering five ticks,
    // all five then delivered inside a 3ms window once it clears.
    const bursty = new SnapshotInterpolator<string>();
    drive(
      bursty,
      straightLine({
        ...grid,
        latency: (i) => {
          const held = i - (i % 40);
          if (held >= 40 && i - held < 5) return 40 + 250 + (held - i) * 50 + (i - held) * 0.75;
          return 40;
        },
      }),
      { untilMs: 20_000, warmupMs: 20_000 },
    );

    expect(bursty.delayMs).toBeGreaterThan(steady.delayMs);
    expect(bursty.delayMs).toBeGreaterThan(150);
  });

  it('renders constant-velocity motion at a constant speed despite jittered arrivals', () => {
    // THE HEADLINE PROPERTY. The server emits on a uniform grid; the network
    // smears the arrivals. Playing back against the arrival clock replays that
    // smear AS MOTION, so a constant 100 u/s reads as anything from 1 to 393
    // u/s. Playing back against the server clock reproduces the grid.
    const interp = new SnapshotInterpolator<string>();
    const rnd = prng(0x51ee);
    const arrivals = straightLine({ ticks: 400, tickMs: 50, speed: 100, latency: () => 40 + rnd() * 60 });
    const { speeds } = drive(interp, arrivals, { untilMs: 20_000, warmupMs: 3000 });

    expect(speeds.length).toBeGreaterThan(500);
    const max = Math.max(...speeds);
    const min = Math.min(...speeds);
    const mean = speeds.reduce((s, v) => s + v, 0) / speeds.length;
    const sd = Math.sqrt(speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / speeds.length);

    expect(mean).toBeCloseTo(100, 0);
    expect(max).toBeLessThan(115);
    expect(min).toBeGreaterThan(85);
    expect(sd).toBeLessThan(3);
  });

  it('a delivery burst does not replay as a speed spike', () => {
    // Five ticks held for 250ms and then delivered 0.75ms apart. On the
    // arrival clock those five frames are a quarter of a second of world
    // motion crammed into 3ms; on the server clock they are five ordinary
    // ticks that happened to land together. The delay here is fixed above the
    // stall length so the buffer covers it and the ONLY variable left is which
    // clock the playhead runs on.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 350, maxDelayMs: 350, startDelayMs: 350 });
    const arrivals = straightLine({
      ticks: 200,
      tickMs: 50,
      speed: 100,
      latency: (i) => {
        const held = i - (i % 40);
        if (held >= 40 && i - held < 5) return 40 + 250 + (held - i) * 50 + (i - held) * 0.75;
        return 40;
      },
    });
    const { speeds, xs } = drive(interp, arrivals, { untilMs: 10_000, warmupMs: 1500 });

    // COUNT THE SAMPLES BEFORE BOUNDING THEM. `Math.max(...[])` is -Infinity
    // and `Math.min(...[])` is Infinity, so every bound in this file is
    // satisfied by a run that rendered NOTHING AT ALL: an entity that never
    // appeared, or a playhead stranded so badly that `drive` recorded no
    // frames, would read as a perfectly smooth profile. The assertion that
    // there was something to measure is part of the measurement.
    expect(speeds.length).toBeGreaterThan(400);
    expect(Math.max(...speeds)).toBeLessThan(130);
    // A REWIND is the failure this profile actually produces, and the previous
    // assertion here (`speeds.every(s => s >= 0)`) could not see it or anything
    // else: `speeds` are magnitudes from `Math.hypot(...) / dt` with dt > 0, so
    // the claim was true by construction. The entity only ever moves in +x, so
    // any decrease in the RENDERED x is the interpolator replaying the burst
    // backwards, which is what the arrival clock did nine times on this profile.
    const rewinds = xs.filter((x, i) => i > 0 && x < xs[i - 1]! - 1e-9).length;
    expect(rewinds).toBe(0);
  });

  it('the clock offset slews at a capped rate, so a latency step never teleports the playhead', () => {
    // The offset is subtracted from the playhead, so moving it IS moving
    // playback in time. Drop the one-way delay by 200ms mid-stream: the offset
    // floor drops instantly, and without a cap the playhead would jump 200ms
    // forward in one frame (20 units at 100 u/s). Capped at OFFSET_SLEW_MAX it
    // can only run 5% fast, so rendered speed stays under 105 u/s and the 200ms
    // is absorbed over four seconds instead.
    // The delay is pinned (min === max) so the only thing that can move the
    // playhead relative to real time is the offset.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 100, maxDelayMs: 100, startDelayMs: 100 });
    const arrivals = straightLine({
      ticks: 400,
      tickMs: 50,
      speed: 100,
      latency: (i) => (i < 40 ? 240 : 40),
    });
    const { speeds, xs, lastX, lastNow } = drive(interp, arrivals, { untilMs: 20_000, warmupMs: 2100 });

    // The cap is a RATE, so measure it as one: average speed over 200ms
    // windows. The offset itself only moves on a push, so the render frame
    // right after each push carries that push's whole allowance at once (2.5ms
    // of playhead at a 50ms snapshot cadence, i.e. a quarter of a unit here);
    // that is why the instantaneous per-frame bound below is looser than the
    // rate bound, and it is still two orders of magnitude short of the ~1300
    // u/s single frame an uncapped offset would produce.
    const cap = 100 * (1 + OFFSET_SLEW_MAX);
    const win = 12; // 200ms at 60Hz
    let worstRate = 0;
    for (let i = 0; i + win < xs.length; i++) {
      worstRate = Math.max(worstRate, ((xs[i + win]! - xs[i]!) / win) * 60);
    }
    expect(worstRate).toBeLessThanOrEqual(cap + 0.5);
    expect(speeds.length).toBeGreaterThan(900); // an empty run satisfies every bound here
    expect(Math.max(...speeds)).toBeLessThan(130);
    // ...and it does converge rather than merely being slow: well after the
    // 4 seconds the 200ms correction needs, the entity tracks the new offset.
    expect(lastX).toBeCloseTo((100 * (lastNow - 40 - 100)) / 1000, 0);
  });

  it('an entity missing from one bracketing frame stays on its path instead of snapping to that frame', () => {
    // `b` is omitted from the snapshot at server time 50. Rendering it at the
    // pose of whichever bracketing frame does carry it snaps it by up to a
    // full interval, forward or back, and unwinds again next frame: one
    // transiently culled entity reads as visible jitter. Scanning outward for
    // the nearest frames that do carry it keeps it on the same path, so it
    // tracks `a`, which moves identically and is never omitted.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 100, maxDelayMs: 100, startDelayMs: 100 });
    const pose = (t: number) => ({ x: t / 10, y: 0 });
    interp.push(frame(0, 100, { a: pose(0), b: pose(0) }));
    interp.push(frame(50, 150, { a: pose(50) }));
    interp.push(frame(100, 200, { a: pose(100), b: pose(100) }));
    interp.push(frame(150, 250, { a: pose(150), b: pose(150) }));

    // Offset is seeded at 100, delay is pinned at 100, so nowMs 225 puts the
    // playhead at server time 25: inside the bracket [0, 50] that omits `b`.
    interp.sample(0.05, 220);
    const mid = interp.sample(0.05, 225);
    expect(mid.get('b')!.x).toBeCloseTo(mid.get('a')!.x, 6);
    expect(mid.get('b')!.x).toBeCloseTo(2.5, 6);

    // And in the next bracket [50, 100], where the OLDER frame is the one
    // missing `b`. The old code snapped forward here and backward above.
    const later = interp.sample(0.05, 275);
    expect(later.get('b')!.x).toBeCloseTo(later.get('a')!.x, 6);
    expect(later.get('b')!.x).toBeCloseTo(7.5, 6);
  });

  it('an entity that has JUST APPEARED renders at its one known pose rather than being dropped', () => {
    // The third arm of `posePartial`: a future frame carries the key and no
    // frame behind the playhead does. That is a brand new entity, and there is
    // no continuity to preserve, so holding the single known pose is right.
    // No other test reached this arm at all: every partial-entity case here
    // has history on at least one side, so the arm could be deleted (making
    // `posePartial` return null, which drops the entity from the rendered map
    // entirely) with the whole file still green. A newly spawned entity
    // flickering for one bracket is not a defect anyone would look for here.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 100, maxDelayMs: 100, startDelayMs: 100 });
    interp.push(frame(0, 40, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, 90, { a: { x: 5, y: 0 } }));
    interp.push(frame(100, 140, { a: { x: 10, y: 0 }, b: { x: 100, y: 7, heading: 0.5 } }));

    // Offset seeded at 40, delay pinned at 100, so nowMs 215 puts the playhead
    // at server time 75: the bracket [50, 100], whose OLDER frame is the last
    // one that predates `b` existing at all.
    const out = interp.sample(0.05, 215);
    expect(out.get('a')!.x).toBeCloseTo(7.5, 6);

    const b = out.get('b');
    expect(b).toBeDefined();
    expect(b!.x).toBe(100);
    expect(b!.y).toBe(7);
    expect(b!.heading).toBe(0.5);
    // Held, not invented: there is no velocity to extrapolate along yet.
    expect(b!.extrapolated).toBe(false);
  });

  it('a playhead exactly on the newest frame is an UNDERRUN, not a zero-width bracket', () => {
    // `bracketIndex` takes the last frame at or before the playhead, and the
    // `<=` is what makes "exactly on the newest frame" the underrun it is:
    // there is nothing beyond the playback point, which is the entire
    // definition. Weakened to `<`, that instant is instead reported as an
    // ordinary interpolation at frac 1, which renders the SAME position, so
    // position alone cannot see it. What it costs is the `extrapolated` flag
    // and `underrunRate`, i.e. exactly the two signals a host watches to know
    // its buffer has run dry.
    //
    // The clocks are pinned so the equality is exact rather than approximate:
    // the offset seeds at 40 and never moves (every frame carries the same
    // one-way delay), and the delay cannot ease off 100 with min === max.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 100, maxDelayMs: 100, startDelayMs: 100 });
    interp.push(frame(0, 40, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, 90, { a: { x: 5, y: 0 } }));
    interp.push(frame(100, 140, { a: { x: 10, y: 0 } }));

    // Playhead at 240 - 40 - 100 = server time 100 exactly, the newest stamp.
    const out = interp.sample(1 / 60, 240);
    const a = out.get('a')!;
    expect(a.x).toBeCloseTo(10, 6);
    expect(a.extrapolated).toBe(true);
    expect(interp.underrunRate).toBeGreaterThan(0);
  });

  it('a reordered arrival contributes no emission interval, so it cannot shrink the delay', () => {
    // `observeInterval` counts FORWARD deltas only. `push()` documents
    // out-of-order arrivals as ordinary rather than anomalous, and a backward
    // delta is not an interval the server emitted: it is the same interval
    // seen from the wrong end. Admitting one puts a NEGATIVE number in the
    // window the median interval is taken from, and that median is a term in
    // the delay target, so a reordering link would talk the buffer DOWN at
    // precisely the moment it needs to be deeper. That is the same shape of
    // mistake as the inter-arrival-gap estimator this module already replaced
    // once.
    //
    // A uniform 50ms grid delivered with every adjacent pair swapped (the odd
    // tick overtakes the even one by 10ms). Measured on this profile: 160.0ms
    // of delay counting forward deltas only, 85.0ms if backward deltas are
    // admitted, on a stream whose real emission interval never changed.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 10, maxDelayMs: 500, startDelayMs: 10 });
    const arrivals: Arrival[] = [];
    for (let i = 0; i < 400; i++) {
      const serverTime = i * 50;
      const latency = i % 2 === 0 ? 100 : 40;
      arrivals.push({ serverTime, receivedAt: serverTime + latency, entities: { a: { x: serverTime / 10, y: 0 } } });
    }
    arrivals.sort((a, b) => a.receivedAt - b.receivedAt);
    drive(interp, arrivals, { untilMs: 20_000, warmupMs: 20_000 });

    expect(interp.rejectedFrames).toBe(0); // the reordering itself is ordinary, not refused
    expect(interp.delayMs).toBeGreaterThan(140);
    expect(interp.delayMs).toBeLessThan(180);
  });

  it('the time prune always leaves two frames, since one frame carries no velocity to extrapolate along', () => {
    // The retention floor in `pruneFrames` is documented ("two frames are
    // always retained, since one frame cannot form a bracket") and pinned by
    // nothing: relaxing it to `Math.min(drop, this.frames.length)` left the
    // whole file green. The damage is not the missing bracket, it is the
    // missing VELOCITY. The underrun branch derives its extrapolation speed
    // from the two newest frames, so a buffer pruned down to one frame
    // extrapolates at zero and the entity FREEZES, which is the one thing this
    // module promises never to do.
    //
    // The setup is the shape that triggers it: a long silence, then one frame
    // from far ahead on the server clock, so every older frame sits below a
    // prune horizon computed from a playhead that has moved on. The delay is
    // pinned and the one-way delay is uniform at 40ms, so the playhead is
    // exactly `now - 140` throughout and the arithmetic below is not
    // approximate.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 100, maxDelayMs: 100, startDelayMs: 100 });
    interp.push(frame(0, 40, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, 90, { a: { x: 5, y: 0 } }));
    interp.push(frame(100, 140, { a: { x: 10, y: 0 } }));

    // Sampled while the playhead is INSIDE the buffer, so no error window is
    // ever opened and the time prune is not suspended when it next runs.
    expect(interp.sample(1 / 60, 200).get('a')!.x).toBeCloseTo(6, 6);

    // 900ms of silence, then the stream resumes. The prune on this push sees a
    // playhead at server time 900 and a horizon 350ms behind it, so all three
    // older frames are past it and only the retention floor keeps the second
    // one alive.
    interp.push(frame(1000, 1040, { a: { x: 100, y: 0 } }));

    // Playhead at 1060, past the newest frame: an underrun, which extrapolates
    // rather than freezing. The velocity comes from the retained pair (server
    // times 100 and 1000, 90 units apart), i.e. the true 100 units/sec, held
    // for the 60ms the playhead leads by.
    const out = interp.sample(1 / 60, 1200).get('a')!;
    expect(out.extrapolated).toBe(true);
    expect(out.x).toBeCloseTo(106, 6);
    // Pruned to a single frame there is no earlier pose to difference against,
    // the derived velocity is zero, and this reads exactly 100: frozen.
    expect(out.x).toBeGreaterThan(103);
  });

  it('an entity unseen past dropAfterMs is forgotten', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250, dropAfterMs: 500 });
    interp.push(frame(0, 40, { a: { x: 0, y: 0 } }));
    interp.sample(0.05, 50);
    let out = interp.sample(0.05, 140);
    expect(out.has('a')).toBe(true);

    out = interp.sample(0.05, 740); // past dropAfterMs since the entity was last seen at receivedAt 40
    expect(out.has('a')).toBe(false);
  });

  it('forget() removes an entity immediately', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250 });
    interp.push(frame(0, 40, { a: { x: 0, y: 0 } }));
    interp.sample(0.05, 50);
    interp.forget('a');
    const out = interp.sample(0.05, 60);
    expect(out.has('a')).toBe(false);
  });

  it('measures a low-passed speed from its own rendered motion', () => {
    // A LOW PASS IS ONLY OBSERVABLE ACROSS A CHANGE. The version this replaced
    // drove a clean constant-velocity stream, where the filtered value and the
    // instantaneous value coincide from the first frame onwards: dropping the
    // filter entirely (`speed = inst`) landed inside the same 90..110 bound.
    // So step the speed and watch the reported value LAG the rendered one,
    // which is the only thing the filter actually does.
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 100, minDelayMs: 100, maxDelayMs: 100, speedTau: 0.12 });

    // 100 u/s up to server time 1000, then 400 u/s. Position stays continuous
    // across the change, so the only discontinuity in the stream is the slope.
    const arrivals: Arrival[] = [];
    for (let i = 0; i < 40; i++) {
      const serverTime = i * 50;
      const x = serverTime <= 1000 ? (100 * serverTime) / 1000 : 100 + (400 * (serverTime - 1000)) / 1000;
      arrivals.push({ serverTime, receivedAt: serverTime + 40, entities: { a: { x, y: 0 } } });
    }

    const hz = 60;
    const rendered: { now: number; x: number; speed: number }[] = [];
    let next = 0;
    for (let now = 0; now <= 1500; now += 1000 / hz) {
      while (next < arrivals.length && arrivals[next]!.receivedAt <= now) {
        const arr = arrivals[next]!;
        interp.push(frame(arr.serverTime, arr.receivedAt, arr.entities));
        next++;
      }
      const e = interp.sample(1 / hz, now).get('a');
      if (e) rendered.push({ now, x: e.x, speed: e.speed });
    }

    // Well before the step, the filter has had many time constants to converge
    // onto the true 100 units/sec.
    const settled = rendered.filter((r) => r.now > 600 && r.now < 1100);
    expect(settled.length).toBeGreaterThan(20);
    for (const r of settled) {
      expect(r.speed).toBeGreaterThan(90);
      expect(r.speed).toBeLessThan(110);
    }

    // The first rendered frame whose own motion is fully on the new slope.
    const jump = rendered.findIndex((r, i) => i > 0 && (r.x - rendered[i - 1]!.x) * hz > 350);
    expect(jump).toBeGreaterThan(0);
    // The rendered motion is already at 400 u/s here and the reported speed is
    // nowhere near it yet, because a 0.12s time constant moves about 13% of
    // the way per 60Hz frame. Unfiltered this frame reports the full 400.
    expect(rendered[jump]!.speed).toBeLessThan(250);

    // And it does get there, a few time constants later.
    const last = rendered[rendered.length - 1]!;
    expect(last.now).toBeGreaterThan(1400);
    expect(last.speed).toBeGreaterThan(350);
    expect(last.speed).toBeLessThan(410);
  });

  it('clear() resets frames, entities, and the adaptive delay to its starting value', () => {
    // The docstring always claimed this; the implementation only re-CLAMPED
    // whatever the delay had drifted to, because the start value was never
    // stored, and the only assertion here was `out.size === 0`, which cannot
    // tell the two apart. A reconnect therefore inherited the dead
    // connection's jitter estimate.
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 90, minDelayMs: 50, maxDelayMs: 250 });
    const rnd = prng(0xc1ea4);
    drive(interp, straightLine({ ticks: 200, tickMs: 50, speed: 100, latency: () => 40 + rnd() * 200 }), {
      untilMs: 10_000,
      warmupMs: 10_000,
    });
    expect(interp.delayMs).toBeGreaterThan(120); // it genuinely moved off the start value

    interp.clear();
    expect(interp.delayMs).toBe(90);

    const out = interp.sample(0.05, 10_000);
    expect(out.size).toBe(0);
  });

  it('clear() resets the clock offset, so a reconnect on a different path does not inherit the old one', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 100, minDelayMs: 100, maxDelayMs: 100 });
    interp.push(frame(0, 500, { a: { x: 0, y: 0 } })); // epoch 1: 500ms of one-way delay
    interp.push(frame(50, 550, { a: { x: 5, y: 0 } }));
    interp.sample(0.05, 600);

    interp.clear();

    // Epoch 2 on a much faster path. With the offset reset, the playhead lands
    // inside the new frames immediately; carrying the old 500ms offset over
    // would put it 500ms in the future and extrapolate off the end.
    interp.push(frame(1000, 1020, { a: { x: 100, y: 0 } }));
    interp.push(frame(1050, 1070, { a: { x: 105, y: 0 } }));
    interp.push(frame(1100, 1120, { a: { x: 110, y: 0 } }));
    const a = interp.sample(0.05, 1145).get('a')!;
    expect(a.x).toBeCloseTo(102.5, 6);
    expect(a.extrapolated).toBe(false);
  });

  it('clear() resets the GAUGES but deliberately not the lifetime COUNTERS', () => {
    // `clear()` is called on every reconnect, so what it does and does not
    // reset is a decision rather than a detail, and the omission of the two
    // counters previously read as an oversight because nothing recorded it.
    // The split is gauges versus counters: `delayMs` and `underrunRate`
    // describe the CURRENT epoch and are meaningless carried across a
    // reconnect, while `rejectedFrames` and `reanchors` answer a question
    // about the HOST ("is something above this producing timestamps it should
    // not", "is the offset estimate failing to converge") that a reconnect
    // does not refute. Resetting them would mean the more often a client
    // reconnects the less evidence survives, which is exactly backwards.
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 90 });

    // A forward serverTime step produces both: refused frames, then a re-anchor.
    drive(
      interp,
      serverTimeStep({ ticks: 200, tickMs: 50, speed: 100, latencyMs: 40, stepAtTick: 60, stepMs: 5000 }),
      { untilMs: 8000, warmupMs: 0 },
    );
    expect(interp.rejectedFrames).toBeGreaterThan(0);
    expect(interp.reanchors).toBeGreaterThan(0);

    const rejected = interp.rejectedFrames;
    const reanchors = interp.reanchors;

    interp.clear();

    expect(interp.delayMs).toBe(90); // a gauge: reset
    expect(interp.underrunRate).toBe(0); // a gauge: reset
    expect(interp.rejectedFrames).toBe(rejected); // a counter: carried
    expect(interp.reanchors).toBe(reanchors); // a counter: carried
  });

  // Regression for the bug examples/pong/client.ts shipped with: calling
  // sample(dt) with no nowMs used to accumulate a SEPARATE clock starting at
  // zero, disconnected from the absolute performance.now() timestamps every
  // real push() carries as receivedAt. That self-accumulated clock could
  // never catch up (dt-accumulation cannot advance faster than wall time),
  // so a caller that omits nowMs, exactly like the shipped example did, would
  // render frames[0] forever: seconds-stale state that looks like normal,
  // smooth motion and reports nothing wrong. Simulate a page that has
  // already been running a while (5s) before its first render, which is
  // exactly the gap that pinned the bug in place, and confirm the entity
  // tracks the newest data rather than freezing at the first frame ever
  // pushed.
  it('omitting nowMs reads the real wall clock instead of a self-accumulated one, and does not render a stale frame', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    let clock = 5000; // page already 5s into its life before the loop starts
    nowSpy.mockImplementation(() => clock);

    try {
      const interp = new SnapshotInterpolator<string>({ startDelayMs: 50, minDelayMs: 50, maxDelayMs: 250 });

      // The server's clock is its own domain, 3s behind the local one here, so
      // this also exercises the offset estimate rather than assuming the two
      // clocks agree.
      interp.push(frame(clock - 3000, clock, { a: { x: 0, y: 0 } }));
      clock += 50;
      interp.push(frame(clock - 3000, clock, { a: { x: 10, y: 0 } }));

      // A rendered frame some time later, calling sample() exactly the way
      // examples/pong/client.ts used to: dt only, no nowMs.
      clock += 50;
      const out = interp.sample(0.05);

      // The fixed default reads performance.now() itself, which is the same
      // clock push() stamped receivedAt with, so the playback point lands at
      // (or just past) the newest pushed frame. The old self-accumulated
      // clock started at zero while receivedAt sat at 5000+, so the playback
      // point never reached past the buffer's oldest frame and this would
      // read x === 0 (frames[0], the very first frame ever pushed) forever.
      expect(out.get('a')?.x).toBeGreaterThan(5);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('ONE frame with a non-finite serverTime is refused at the door and does not poison playback', () => {
    // The types promise `number`; the value crosses a decode boundary owned by
    // the host, and the README quickstart hands `snap.serverTime` straight
    // through from a host-defined codec. A codec that omits the field yields
    // `undefined`, whose arithmetic is NaN.
    //
    // Before the guard, one such frame was PERMANENT. NaN reached the offset
    // window, the jitter quantile and finally `currentDelayMs`, where
    // `x += (NaN - x) * ease` can never leave NaN again even after the bad
    // sample slid out of the 128-entry window. The playhead was NaN, every
    // bracket comparison was false, and playback pinned to `frames[0]` for the
    // rest of the connection: measured at a rendered x of 1200 against newest
    // data of 1495, with the socket, the snapshot rate and `underrunRate` all
    // reading perfectly healthy. Only `clear()` escaped it.
    const interp = new SnapshotInterpolator<string>();
    for (let i = 0; i < 300; i++) {
      const serverTime = i === 100 ? Number.NaN : i * 50;
      interp.push(frame(serverTime, i * 50 + 40, { a: { x: i * 5, y: 0 } }));
      interp.sample(1 / 60, i * 50 + 45);
    }

    expect(interp.rejectedFrames).toBe(1);
    expect(Number.isFinite(interp.delayMs)).toBe(true);

    // 199 clean frames after the bad one, and the render tracks the newest
    // data (x = 1495 at tick 299) rather than the first frame ever pushed.
    const a = interp.sample(1 / 60, 300 * 50 + 45).get('a')!;
    expect(a.x).toBeGreaterThan(1400);
  });

  it('a non-finite receivedAt is refused too, and a non-finite nowMs never reaches stored state', () => {
    const interp = new SnapshotInterpolator<string>({ startDelayMs: 100, minDelayMs: 100, maxDelayMs: 100 });
    interp.push(frame(0, 40, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, 90, { a: { x: 5, y: 0 } }));
    interp.push(frame(100, 140, { a: { x: 10, y: 0 } }));

    interp.push(frame(150, Number.NaN, { a: { x: 15, y: 0 } }));
    expect(interp.rejectedFrames).toBe(1);

    interp.sample(Number.NaN, Number.NaN);
    expect(Number.isFinite(interp.delayMs)).toBe(true);

    // AND THE HALF `delayMs` CANNOT SEE. A non-finite `dt` is not merely
    // ignored downstream: `decayUnderrun` guards on `dt <= 0`, which is FALSE
    // for NaN, so a NaN `dt` walks straight past it into
    // `underrunEma += (target - underrunEma) * ease` and an exponential ease
    // can never leave NaN again. That is the same permanent-poisoning shape as
    // the non-finite `serverTime` defect, arriving through a third door, and
    // `underrunRate` is exactly the gauge a host polls to decide whether
    // playback is healthy.
    expect(Number.isFinite(interp.underrunRate)).toBe(true);

    // The bad call left nothing behind: the next honest one still brackets.
    const a = interp.sample(1 / 60, 165).get('a')!;
    expect(a.x).toBeCloseTo(2.5, 6);
    expect(Number.isFinite(a.x)).toBe(true);

    // And it is still gone twenty clean frames later, which is the assertion
    // that separates "recovered" from "the bad value simply has not been read
    // back yet": a poisoned EMA stays poisoned for the rest of the connection.
    for (let i = 4; i < 24; i++) {
      interp.push(frame(i * 50, i * 50 + 40, { a: { x: i * 5, y: 0 } }));
      interp.sample(1 / 60, i * 50 + 45);
    }
    expect(Number.isFinite(interp.underrunRate)).toBe(true);
    expect(interp.underrunRate).toBeLessThan(0.5);
  });

  it('a sustained one-way latency step re-anchors instead of degrading for tens of seconds', () => {
    // A route change, a network switch, a congested path that stays congested:
    // the true clock offset moves in one step. The offset estimate is a sliding
    // window MINIMUM eased under a 5% slew cap, and neither mechanism can move
    // until the stale floor ages out of the window, so the playhead sits past
    // the newest frame for the whole turnover. Measured on this exact profile
    // before the re-anchor: 22,517ms of continuous extrapolation, rendering a
    // 20Hz stop-go staircase.
    const interp = new SnapshotInterpolator<string>();
    const arrivals = straightLine({
      ticks: 1200,
      tickMs: 50,
      speed: 100,
      latency: (i) => (i < 200 ? 40 : 1040), // +1000ms, permanently, at local t = 10s
    });
    const { track, frameMs } = drive(interp, arrivals, { untilMs: 40_000, warmupMs: 40_000 });

    expect(interp.reanchors).toBe(1);

    // The stream itself is silent for the 1000ms the step costs, and
    // extrapolate-then-hold is the CORRECT behaviour with no data. What must
    // not happen is that it carries on for another twenty seconds afterwards.
    expect(longestExtrapolationMs(track, 10_000, frameMs)).toBeLessThan(1500);

    // Two seconds after the step, playback tracks the newest delivered pose
    // again, no more than a delay or so behind it.
    //
    // A DELAY OR SO IS NOW A LONGER TAIL THAN IT WAS, DELIBERATELY. The
    // re-anchor snaps the delay to a target the step's own jitter has pushed to
    // the 500ms ceiling, and it then unwinds under `DELAY_SLEW_MAX` at 8% of
    // wall time rather than at the ease's uncapped 224ms per second. So the
    // staleness sits at 43 units for a moment where it used to be under 40, and
    // the entities are 400ms behind for two seconds instead of running 20% fast
    // for one, which is the trade that constant exists to make. What the bound
    // is here for is unchanged: playback must be BEHIND by a bounded amount and
    // converging, not stranded.
    for (const t of track) {
      if (t.now < 12_000) continue;
      const stale = newestDeliveredX(t.now, 50, 100, 1040) - t.x;
      expect(stale).toBeLessThan(45); // 45 units = 450ms of world time, under the 500ms ceiling
      expect(stale).toBeGreaterThan(-5);
    }

    // And it does converge rather than merely being bounded: the delay is back
    // near its floor a few seconds later and playback is right behind the
    // newest pose. Measured at 11.6 units at 16s, 7.4 at 20s.
    for (const t of track) {
      if (t.now < 16_000) continue;
      expect(newestDeliveredX(t.now, 50, 100, 1040) - t.x).toBeLessThan(20);
    }
  });

  it('the floor-refusal escape hatch counts over a WINDOW, so a reordering latency drop cannot stall it', () => {
    // THE ONE PROFILE A CONSECUTIVE COUNT CANNOT ESCAPE, and it is the profile
    // that most needs the escape hatch. A latency DROP larger than
    // `OFFSET_FLOOR_SLACK_MS` reorders the stream BY DEFINITION: packets
    // already in flight keep arriving on the old schedule while packets sent
    // after the drop overtake them, so old and new interleave one for one
    // across the whole overlap. Every old one sits at the established floor and
    // is accepted; every new one sits a full second below it and is refused.
    //
    // A run of CONSECUTIVE refusals is therefore reset by every second frame
    // and can never reach `TIMELINE_STEP_FRAMES` while the overlap lasts, even
    // though the evidence for the new timeline is overwhelming and arriving
    // twice a tick. Measured on this exact profile with the consecutive count:
    // 23 legitimate frames refused across the overlap with `reanchors` still 0,
    // then a 6106 u/s spike once the old stream finally ran out. `push()`
    // documents out-of-order arrivals as ORDINARY, so a discriminator built on
    // arrival order was contradicting the class's own contract; it is the same
    // lesson the dead-epoch cut learned when it keyed on the LAST arrival
    // rather than the newest.
    //
    // Windowed, the count survives the interleave: three refusals inside
    // `TIMELINE_STEP_WINDOW` judged frames, then the fourth adopts the new
    // timeline, which is the same cost a non-reordering step already pays.
    const interp = new SnapshotInterpolator<string>();
    const tickMs = 50;
    const oldDelay = 3000;
    const newDelay = oldDelay - (OFFSET_FLOOR_SLACK_MS + 1);
    const dropAtTick = 100;

    const arrivals: Arrival[] = [];
    for (let i = 0; i < 300; i++) {
      const serverTime = i * tickMs;
      arrivals.push({
        serverTime,
        receivedAt: serverTime + (i < dropAtTick ? oldDelay : newDelay),
        entities: { a: { x: i * 5, y: 0 } },
      });
    }
    // Delivery order is ARRIVAL order, which is what the drop scrambles.
    arrivals.sort((p, q) => p.receivedAt - q.receivedAt);

    let renderAt = 0;
    for (const a of arrivals) {
      interp.push(frame(a.serverTime, a.receivedAt, a.entities));
      while (renderAt < a.receivedAt) {
        interp.sample(1 / 60, renderAt);
        renderAt += 1000 / 60;
      }
    }

    // Exactly the persistence the mechanism is specified to demand, and no
    // more: the consecutive count paid 23 here for the same event.
    expect(interp.rejectedFrames).toBe(TIMELINE_STEP_FRAMES);
    expect(interp.reanchors).toBeGreaterThanOrEqual(1);
  });

  it('a large FORWARD serverTime step is adopted as a new timeline instead of stalling forever', () => {
    // A handoff onto a machine whose clock runs 5 seconds ahead, and the case
    // that makes the future-stamp refusal above dangerous if it has no way out.
    // Every frame after the step carries an implied one-way delay 5 seconds
    // below the floor, so every frame trips the same test a corrupt stamp does.
    // Refusing them all would be a permanent stall with nothing ever reaching
    // the buffer again, which is strictly worse than the poisoning the refusal
    // exists to prevent. What separates the two is PERSISTENCE, and this asserts
    // the count that measures it: exactly `TIMELINE_STEP_FRAMES` frames are
    // refused across a forty-second run, not a number that keeps climbing.
    //
    // THIS TEST USED TO CLAIM IT PINNED `pruneFrames`'s front-splice fix, and it
    // did not: reintroducing that exact bug left the whole suite green, because
    // the step is now believed and corrected in about 150ms and the buffer never
    // gets a chance to overfill behind a stranded playhead. The front-splice
    // fix is pinned by its own test below, on a profile where the count cap
    // actually binds.
    const interp = new SnapshotInterpolator<string>();
    const arrivals = serverTimeStep({
      ticks: 1400,
      tickMs: 50,
      speed: 100,
      latencyMs: 40,
      stepAtTick: 200,
      stepMs: 5000,
    });
    const { track } = drive(interp, arrivals, { untilMs: 40_000, warmupMs: 40_000 });

    expect(interp.rejectedFrames).toBe(TIMELINE_STEP_FRAMES);
    expect(interp.reanchors).toBe(1);
    for (const t of track) {
      if (t.now < 12_000) continue;
      const stale = newestDeliveredX(t.now, 50, 100, 40) - t.x;
      expect(stale).toBeLessThan(40);
      expect(stale).toBeGreaterThan(-5);
    }
  });

  it('a BACKWARD serverTime step recovers, and never renders a pose from the timeline the authority left', () => {
    // The other direction of the same handoff. `src/server/ticker.ts` stamps
    // `serverTime` from the running instance's own `Date.now()`, so a successor
    // whose clock sits behind its predecessor's rewinds the axis playback runs
    // on. The frames already buffered are then the buffer's NEWEST end forever,
    // and the playhead eventually walks back into them and renders a pose from
    // the dead epoch: measured as a single 285-unit jump five seconds after the
    // handoff, far enough after it to read as an unrelated glitch.
    const interp = new SnapshotInterpolator<string>();
    const arrivals = serverTimeStep({
      ticks: 1400,
      tickMs: 50,
      speed: 100,
      latencyMs: 40,
      stepAtTick: 200,
      stepMs: -5000,
    });
    const { track } = drive(interp, arrivals, { untilMs: 40_000, warmupMs: 40_000 });

    expect(interp.reanchors).toBe(1);
    for (const t of track) {
      if (t.now < 12_000) continue;
      const stale = newestDeliveredX(t.now, 50, 100, 40) - t.x;
      expect(stale).toBeLessThan(40);
      expect(stale).toBeGreaterThan(-5);
    }
  });

  it('does NOT re-anchor when the stream simply stops, because there is nothing to anchor to', () => {
    // THE GATE. A dead ticker, or the gap between a predecessor's death and a
    // successor's first tick, parks the playhead past the newest buffered frame
    // exactly the way a wrong clock offset does, and looks identical from
    // inside this class. The difference is that no new data is arriving, so
    // re-anchoring would move the playhead onto the same stale frames and
    // accomplish nothing; extrapolate-then-hold is correct there. Requiring at
    // least one push() since the error window opened is what tells them apart.
    const interp = new SnapshotInterpolator<string>();
    const arrivals = straightLine({ ticks: 200, tickMs: 50, speed: 100, latency: () => 40 });
    drive(interp, arrivals, { untilMs: 30_000, warmupMs: 30_000 }); // stream ends at t = 10s, 20s of silence

    expect(interp.reanchors).toBe(0);
    expect(interp.underrunRate).toBeGreaterThan(0.9);
  });

  it('ONE frame stamped in the FUTURE is refused, so it cannot switch the underrun branch off', () => {
    // FINITE IS NOT THE SAME AS PLAUSIBLE, and the finiteness guard alone let
    // this through. A frame stamped far ahead of the authority's real clock is
    // always the buffer's NEWEST end, so `i === frames.length - 1` can never be
    // true again while it leads the playhead. That single condition is the
    // underrun branch, the `extrapolated` flag, `underrunRate` AND the
    // re-anchor's own past-the-newest detection, all of which switch off
    // together. Measured with one frame stamped 30 seconds ahead and the stream
    // then stopping dead for five seconds: the entity drifted 333 units
    // BACKWARD while reporting 0 of 300 frames extrapolated and an underrun
    // rate of 0.000, i.e. it broke the never-freeze rule and lied about its own
    // health in the same breath.
    const interp = new SnapshotInterpolator<string>();
    for (let i = 0; i < 400; i++) {
      const local = i * 50;
      if (i === 150) interp.push(frame(local + 30_000, local + 40, { a: { x: i * 5, y: 0 } }));
      interp.push(frame(local, local + 40, { a: { x: i * 5, y: 0 } }));
      for (let k = 0; k < 3; k++) interp.sample(1 / 60, local + k * (1000 / 60));
    }

    expect(interp.rejectedFrames).toBe(1);

    // The stream now stops dead. Five seconds of silence must read as an
    // underrun, and must move the entity FORWARD along its last known velocity.
    const stopAt = 399 * 50;
    const xAtStop = interp.sample(1 / 60, stopAt).get('a')!.x;
    let extrapolated = 0;
    let rendered = 0;
    let x = xAtStop;
    for (let now = stopAt; now < stopAt + 5000; now += 1000 / 60) {
      const e = interp.sample(1 / 60, now).get('a')!;
      rendered++;
      if (e.extrapolated) extrapolated++;
      x = e.x;
    }

    expect(extrapolated / rendered).toBeGreaterThan(0.9);
    expect(interp.underrunRate).toBeGreaterThan(0.5);
    expect(x).toBeGreaterThan(xAtStop);
  });

  it('the FIRST frame of a connection is PROVISIONAL, so a future stamp there cannot poison the offset floor', () => {
    // The refusal above is measured against a sliding-window MINIMUM, which
    // means the first frame of an epoch does not merely escape the test, it
    // DEFINES the value every later frame is tested against. A minimum can only
    // be dragged further down, so a future-stamped seed sets a floor no honest
    // frame can ever correct: every real frame afterwards sits ABOVE it, which
    // is indistinguishable from jitter, and they are all waved through.
    //
    // The same stamp is free mid-run and expensive on frame one, which is the
    // whole finding. Measured on this profile at +1500ms: mid-run it costs one
    // refused frame, a peak rendered speed of 101 u/s on a 100 u/s entity and
    // zero rewinds; on frame one it cost 767ms of wrong playback peaking at
    // 4548 u/s with 21 backward rewinds and the pose 881ms stale, and
    // `rejectedFrames` stayed at ZERO the whole time, so the metric that exists
    // to surface exactly this reported nothing. The size of the error barely
    // matters (+30000ms measured 767ms and 3782 u/s), because what is really
    // being measured is how long the stranded-playhead re-anchor takes to
    // notice a floor that was wrong from the first packet.
    const arrivals = straightLine({ ticks: 300, tickMs: 50, speed: 100, latency: () => 40 });
    arrivals[0]!.serverTime += 1500; // the one frame the whole floor is built from

    const interp = new SnapshotInterpolator<string>();
    const { track, frameMs } = drive(interp, arrivals, { untilMs: 5000, warmupMs: 0 });

    // The seed is refused retroactively, and counted, rather than standing.
    expect(interp.rejectedFrames).toBe(1);

    // TIMELINE_STEP_FRAMES contradicting frames settle it, so the disturbance
    // is a few snapshot intervals rather than the REANCHOR_AFTER_MS (600ms)
    // wait the stranded playhead would otherwise have to sit through.
    expect(longestExtrapolationMs(track, 0, frameMs)).toBeLessThan(300);

    const steps = stepsAfter(track, 0);
    expect(steps.length).toBeGreaterThan(200); // an empty run satisfies every bound here
    const peakSpeed = Math.max(...steps.map((s) => Math.abs(s))) / (frameMs / 1000);
    expect(peakSpeed).toBeLessThan(1200);

    // ...and playback is on the real timeline afterwards, not 1500ms ahead of it.
    const lastNow = track[track.length - 1]!.now;
    expect(track[track.length - 1]!.x).toBeCloseTo(newestDeliveredX(lastNow, 50, 100, 40), -1);
  });

  it('ONE straggler is not enough evidence to re-anchor on', () => {
    // The re-anchor adopts the MINIMUM of the samples that landed during the
    // error window, with no slew. With a gate of "at least one push" that is a
    // single packet's raw offset, whatever it happens to be, and a straggler
    // dribbling through a congested link is exactly such a packet.
    //
    // Profile: a healthy 20Hz stream, then a repeating 800ms stall with ONE
    // queued packet delivered three quarters of the way through it and the rest
    // flushed when the stall clears. Measured on the single-sample gate: it
    // adopted offset = 640 against a true offset of 40 and then held that 600ms
    // error for about twelve seconds while the 5% slew walked it back, for a
    // mean rendered position error of 16 units and a 38 unit backward step.
    const arrivals: Arrival[] = [];
    const pose = (serverTime: number) => ({ a: { x: (100 * serverTime) / 1000, y: 0 } });
    let serverTime = 0;
    for (; serverTime < 3000; serverTime += 50) arrivals.push({ serverTime, receivedAt: serverTime + 40, entities: pose(serverTime) });
    for (let cycle = 0; cycle < 10; cycle++) {
      const stallStart = serverTime;
      const held: number[] = [];
      for (; serverTime < stallStart + 800; serverTime += 50) held.push(serverTime);
      // The one packet that dribbles through mid-stall: an ordinary serverTime
      // carrying an enormous one-way delay.
      arrivals.push({ serverTime: held[0]!, receivedAt: stallStart + 40 + 600, entities: pose(held[0]!) });
      held.slice(1).forEach((s, k) => arrivals.push({ serverTime: s, receivedAt: stallStart + 800 + 40 + k, entities: pose(s) }));
      const upEnd = serverTime + 1700;
      for (; serverTime < upEnd; serverTime += 50) arrivals.push({ serverTime, receivedAt: serverTime + 40, entities: pose(serverTime) });
    }
    arrivals.sort((a, b) => a.receivedAt - b.receivedAt);

    const interp = new SnapshotInterpolator<string>();
    const { track } = drive(interp, arrivals, { untilMs: 28_000, warmupMs: 28_000 });

    // Thin evidence is not evidence. Keep waiting: extrapolate-then-hold is
    // already correct while the error window holds fewer than the threshold.
    expect(interp.reanchors).toBe(0);
    const steps = stepsAfter(track, 3000);
    expect(steps.length).toBeGreaterThan(1000); // an empty run satisfies every bound here
    expect(Math.min(...steps)).toBeGreaterThan(-1);
  });

  it('an out-of-order arrival on the re-anchor own render frame does not destroy a newer buffered frame', () => {
    // `push()` documents out-of-order arrivals as ordinary rather than
    // anomalous, and the re-anchor's dead-epoch cut has to agree with it. The
    // cut used to key on the LAST arrival, so a delayed packet landing in the
    // very render frame the re-anchor fires on made the last arrival an older
    // stamp than a frame already buffered, and the newer frame was destroyed as
    // if it came from a timeline the authority had left.
    //
    // Made visible by giving the reordered newer frame an entity that appears
    // in NO other frame: if the cut takes the frame, the entity is never
    // rendered at all.
    const arrivals: Arrival[] = [];
    for (let i = 0; i < 80; i++) arrivals.push({ serverTime: i * 50, receivedAt: i * 50 + 40, entities: { a: { x: i * 5, y: 0 } } });
    // A permanent +1000ms one-way latency step, which strands the playhead and
    // opens the error window.
    for (let i = 80; i < 200; i++) arrivals.push({ serverTime: i * 50, receivedAt: i * 50 + 1040, entities: { a: { x: i * 5, y: 0 } } });
    // The pair that straddles the re-anchor arrives newest-first, and only the
    // newer of the two carries `b`.
    const older = arrivals.find((x) => x.serverTime === 4150)!;
    const newer = arrivals.find((x) => x.serverTime === 4200)!;
    const swap = older.receivedAt;
    older.receivedAt = newer.receivedAt + 0.5;
    newer.receivedAt = swap;
    newer.entities['b'] = { x: 999, y: 0 };
    arrivals.sort((p, q) => p.receivedAt - q.receivedAt);

    const interp = new SnapshotInterpolator<string>();
    let next = 0;
    let reanchoredAt = -1;
    let sawBAfterReanchor = 0;
    for (let now = 0; now <= 14_000; now += 1000 / 60) {
      while (next < arrivals.length && arrivals[next]!.receivedAt <= now) {
        const a = arrivals[next]!;
        interp.push(frame(a.serverTime, a.receivedAt, a.entities));
        next++;
      }
      const out = interp.sample(1 / 60, now);
      if (reanchoredAt < 0 && interp.reanchors > 0) reanchoredAt = now;
      if (reanchoredAt >= 0 && now > reanchoredAt && out.has('b')) sawBAfterReanchor++;
    }

    expect(interp.reanchors).toBe(1);
    expect(sawBAfterReanchor).toBeGreaterThan(0);
  });

  it('the count cap never evicts the frame the playhead is bracketing against', () => {
    // A hard count cap with a delay that holds the playhead well behind the
    // newest frame, which is the shape a delivery burst produces against the
    // default cap: the buffer wants to be longer than the cap allows while the
    // playhead sits deep inside it. A front-splice keyed only on length takes
    // the bracket's left edge, playback falls off the front of the buffer and
    // pins to `frames[0]`.
    //
    // Measured on this profile with the naive splice: two thirds of rendered
    // frames completely motionless, and THIRTY-ONE re-anchors, which is the
    // symptom the `reanchors` getter's own documentation names ("a number that
    // keeps climbing means the offset estimate is not converging"). The
    // re-anchor eventually rescues playback, so this is not a hang, but paying
    // for a silent eviction with a correction every half second is not the
    // trade it looks like from inside `pruneFrames`.
    const interp = new SnapshotInterpolator<string>({
      bufferCap: 6,
      minDelayMs: 300,
      maxDelayMs: 300,
      startDelayMs: 300,
    });
    const arrivals = straightLine({ ticks: 400, tickMs: 50, speed: 100, latency: () => 40 });
    const { track } = drive(interp, arrivals, { untilMs: 20_000, warmupMs: 20_000 });

    expect(interp.reanchors).toBe(0);
    const steps = stepsAfter(track, 3000);
    expect(steps.length).toBeGreaterThan(800); // zero steps are all non-motionless, vacuously
    expect(steps.filter((d) => Math.abs(d) < 1e-9).length).toBe(0);
  });

  it('the time prune is suspended while the playhead is under suspicion, so a re-anchor never lands on an empty buffer', () => {
    // The prune horizon is derived from the playhead, and once the error window
    // is open this class has already stopped believing where the playhead is.
    // On a BACKWARD serverTime step every frame from the new timeline sits below
    // a horizon computed from the old one, so pruning against it throws each one
    // away as it arrives and the re-anchor lands on an empty stretch.
    //
    // The cost is not a jump, which is why the speed and staleness measures
    // above cannot see it: the buffer empties, `sample()` returns nothing at
    // all, and every remote entity POPS OUT OF EXISTENCE. Measured at 50ms of
    // total dropout on a backward step of 5000, 2000 or 1000ms, with the buffer
    // bottoming out at a single frame against eight with the suspension.
    const interp = new SnapshotInterpolator<string>();
    const arrivals = serverTimeStep({ ticks: 1400, tickMs: 50, speed: 100, latencyMs: 40, stepAtTick: 200, stepMs: -5000 });
    const { track, frameMs } = drive(interp, arrivals, { untilMs: 40_000, warmupMs: 40_000 });

    expect(interp.reanchors).toBe(1);
    expect(longestDropoutMs(track, 9000, frameMs)).toBe(0);
  });

  it('the re-anchor snaps the delay to its target rather than leaving an ease in flight', () => {
    // The offset and the delay are both subtracted from the playhead, so a
    // re-anchor that moves only the offset lands half a correction: the ease
    // still in flight keeps moving the playhead for the next second, which is
    // the discontinuity the re-anchor exists to spend ONCE. The delay estimate
    // was never the thing that was wrong, and it rebuilds from the fresh window
    // within a few frames anyway.
    //
    // Measured on a -5000ms backward step with the snap removed: a peak rendered
    // speed of 1996 units/second on an entity whose true speed is 100, against
    // 360 with it.
    const interp = new SnapshotInterpolator<string>();
    const arrivals = serverTimeStep({ ticks: 1400, tickMs: 50, speed: 100, latencyMs: 40, stepAtTick: 200, stepMs: -5000 });
    const { track } = drive(interp, arrivals, { untilMs: 40_000, warmupMs: 40_000 });

    const steps = stepsAfter(track, 9000);
    expect(steps.length).toBeGreaterThan(1000); // an empty run satisfies every bound here
    const peak = Math.max(...steps.map((d) => Math.abs(d) * 60));
    expect(peak).toBeLessThan(800);
  });

  it('a NaN nowMs cannot smuggle a re-anchor past the REANCHOR_AFTER_MS wait', () => {
    // The guard in `sample()` is a trust boundary from the caller's side, and
    // the failure it prevents is not the obvious one. A NaN `nowMs` stored in
    // `localClockMs` reaches `playheadErrorSinceMs`, and every comparison
    // against NaN is FALSE, so `localClockMs - playheadErrorSinceMs <
    // REANCHOR_AFTER_MS` stops being a wait and becomes a pass: the 600ms of
    // persistence that separates a wrong clock estimate from ordinary jitter is
    // skipped, and the only remaining gate is the sample count.
    //
    // The profile is a +80ms one-way delay bump, which strands the playhead for
    // about 480ms and is then absorbed by the adaptive delay with no correction
    // needed. More than `REANCHOR_MIN_SAMPLES` frames land inside that stretch,
    // so the timer is the only thing holding the re-anchor off. One NaN
    // `nowMs` 300ms in (a timestamp arithmetic slip in a rAF loop) is enough
    // to fire it without the guard.
    const interp = new SnapshotInterpolator<string>();
    const arrivals = straightLine({ ticks: 400, tickMs: 50, speed: 100, latency: (i) => (i < 200 ? 40 : 120) });

    let next = 0;
    let injected = false;
    for (let now = 0; now <= 20_000; now += 1000 / 60) {
      while (next < arrivals.length && arrivals[next]!.receivedAt <= now) {
        const a = arrivals[next]!;
        interp.push(frame(a.serverTime, a.receivedAt, a.entities));
        next++;
      }
      const bad = !injected && now >= 10_400;
      if (bad) injected = true;
      interp.sample(1 / 60, bad ? Number.NaN : now);
    }

    expect(injected).toBe(true);
    expect(interp.reanchors).toBe(0);
  });

  it('ONE 450ms hold does not leave every entity running fast and then slow for seconds afterwards', () => {
    // THE DELAY IS THE OTHER TERM OF THE PLAYHEAD. `now - offset - delay`, so
    // moving the delay moves playback in time exactly the way moving the offset
    // does, and the offset has been capped at 5% of wall time since the day it
    // was written because more than a few percent is visible. The delay had no
    // cap at all: `INTERP_ADAPT_LAMBDA` eases 0.7 of the DIFFERENCE per second,
    // which on this profile is 224ms of playback time per second.
    //
    // One hold, on a link that is otherwise calm, is enough to pay for it
    // twice. Measured uncapped on exactly this profile: 48 frames as slow as
    // 0.83x true speed while the delay grew 80 -> 432, then, seconds later when
    // the burst's samples aged out of the offset window, 78 frames as fast as
    // 1.21x while it came back down. 126 rendered frames outside +-10% of true
    // speed, bought by a single hiccup. The repeating-stall test below is the
    // reason this was never noticed: its delay saturates at the ceiling and
    // never comes back down, so the whole second half of the cost is invisible
    // there.
    //
    // THIS TEST BINDS THE CAP FROM ABOVE and its sibling binds it from below.
    // 0.10 leaves 106 frames outside the band and 0.12 leaves 178; the sibling
    // goes red at 0.06. See `DELAY_SLEW_MAX` for the whole sweep.
    const interp = new SnapshotInterpolator<string>();
    const { track, frameMs } = drive(interp, holdProfile({ ticks: 1200, at: 200 }), {
      untilMs: 40_000,
      warmupMs: 40_000,
    });

    // The delay still does its job: it grew to cover the hold. Without this the
    // whole test passes on an interpolator that simply never adapts.
    expect(Math.max(...track.map((t) => t.delay))).toBeGreaterThan(380);

    // From well after the burst has been delivered, playback is bracketing
    // again and the delay's own movement is the only thing left that can put
    // the rendered speed anywhere other than 100.
    const speeds = speedsAfter(track, 11_000, frameMs);
    expect(speeds.length).toBeGreaterThan(1500); // an empty run satisfies every bound here
    expect(speeds.filter((s) => s < 90 || s > 110).length).toBe(0);
    expect(Math.max(...speeds)).toBeLessThan(109); // the cap IS the bound: 100 * (1 + DELAY_SLEW_MAX)
    expect(Math.min(...speeds)).toBeGreaterThan(91);
  });

  it('a REPEATING 450ms stall is still absorbed at the capped slew rate', () => {
    // THE OTHER HALF OF THE SAME CONSTANT, and the half that stops it being
    // free. A stall that recurs has to be covered before it comes round again,
    // which is the whole argument for `INTERP_MAX_MS` being 500 rather than
    // 250, and a delay that cannot climb fast enough to reach that depth
    // between stalls is a delay that snaps on every one of them.
    //
    // Swept on this profile: at `DELAY_SLEW_MAX` 0.08 the stall is absorbed
    // completely, peak 100.0 u/s on a 100 u/s entity with nothing outside
    // +-10%; at 0.06 the buffer no longer quite gets there between stalls and
    // 12 frames land outside, peaking at 117; at 0.04, 29 frames and 173; at
    // 0.02, 83 frames and 275. That is the floor under the constant, and the
    // one-off hold above is the ceiling over it.
    const interp = new SnapshotInterpolator<string>();
    const { track, frameMs } = drive(interp, holdProfile({ ticks: 1200, at: 40, repeatEvery: 40 }), {
      untilMs: 40_000,
      warmupMs: 40_000,
    });

    const speeds = speedsAfter(track, 5000, frameMs);
    expect(speeds.length).toBeGreaterThan(1500); // an empty run satisfies every bound here
    expect(speeds.filter((s) => s < 90 || s > 110).length).toBe(0);
    expect(Math.max(...speeds)).toBeLessThan(110);
    expect(Math.min(...speeds)).toBeGreaterThan(-1); // and no rewind while it absorbs them
  });

  it('a clean ticker handoff unwinds the extrapolation as a glide, not as a 10 unit rewind', () => {
    // THE PRICE OF NEVER FREEZING, PAID BACK. Extrapolation is a guess, and
    // when the stream resumes the guess has to be reconciled with the truth:
    // the entity was rendered at `pose + v * t` and the confirmed pose is
    // somewhere else. Spending that whole difference in one frame is a step,
    // and on a ticker handoff it is a BACKWARD one, because the world paused
    // while `serverTime` kept running: the truth is where the entity already
    // was, not ahead of it.
    //
    // Measured on this profile before the glide: ONE backward step of 10.41
    // units at -625 u/s, on an entity whose true speed is 100. After: four
    // backward frames of at most 1.16 units, worst -69 u/s, peak rendered speed
    // 625 -> 100. The same total correction, spread across the `EXTRAP_CAP_MS`
    // the guess itself was allowed to run for. The bound is structural rather than tuned: the offset can
    // never exceed the extrapolation's own displacement (v times at most the
    // cap) and is spent over exactly that cap, so the glide can never move an
    // entity faster than it was already moving.
    const interp = new SnapshotInterpolator<string>();
    const arrivals = tickerHandoff({
      ticks: 800,
      tickMs: 50,
      speed: 100,
      latencyMs: 40,
      gapStartTick: 200,
      gapTicks: 16, // 800ms, the middle of the documented handoff range
    });
    const { track, frameMs } = drive(interp, arrivals, { untilMs: 40_000, warmupMs: 40_000 });

    // A handoff is an ordinary event, not a broken clock: nothing here should
    // reach for the re-anchor.
    expect(interp.reanchors).toBe(0);

    const steps = stepsAfter(track, 9000);
    expect(steps.length).toBeGreaterThan(1500); // an empty run satisfies every bound here
    expect(Math.min(...steps)).toBeGreaterThan(-3);
    const speeds = steps.map((d) => Math.abs(d) / (frameMs / 1000));
    expect(Math.max(...speeds)).toBeLessThan(200);
  });

  it('a real teleport still snaps, because the glide may only hide the extrapolation it made itself', () => {
    // THE CLAMP IS WHAT SEPARATES A SMOOTHER FROM A LIE. The offset that
    // absorbs the step out of extrapolation is capped at the displacement THIS
    // MODULE applied, so an entity that genuinely moved somewhere else while
    // the stream was down arrives there immediately, exactly as it does today.
    // Without the clamp the glide would happily spend a second pretending a
    // respawn was a walk.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 100, maxDelayMs: 100, startDelayMs: 100 });
    interp.push(frame(0, 40, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, 90, { a: { x: 5, y: 0 } })); // 100 u/s, so the guess is worth 15 units at the cap

    // Well past the newest frame: extrapolating, and held at the cap.
    const guessed = interp.sample(1 / 60, 400).get('a')!;
    expect(guessed.extrapolated).toBe(true);
    expect(guessed.x).toBeCloseTo(20, 6); // 5 + 100 * 0.15

    // The stream comes back with the entity 1000 units away: a teleport, not a
    // walk. It brackets between the two new frames at server time 950.
    interp.push(frame(900, 940, { a: { x: 1000, y: 0 } }));
    interp.push(frame(1000, 1040, { a: { x: 1000, y: 0 } }));
    const landed = interp.sample(1 / 60, 1090).get('a')!;
    expect(landed.extrapolated).toBe(false);
    // Only the 15 units the extrapolator itself added may be glided, and it
    // glides them the way it applied them, from behind; the other 965 arrive at
    // once, which is a teleport rendered as a teleport.
    expect(landed.x).toBeCloseTo(1000 - 15, 6);
    expect(landed.x).toBeGreaterThan(980);
  });

  it('a discontinuous render frame reports a real speed rather than a 10,000 u/s spike', () => {
    // `dt` AND `nowMs` DISAGREE AFTER A RENDER GAP, AND BOTH CALLERS ARE RIGHT.
    // `RoomConnection.frame()` clamps `dt` to 0.25s, which is correct (one
    // stalled frame must not advance a whole simulation at once), and passes
    // the REAL `nowMs`, which is also correct (the playhead runs on the wall
    // clock, and a `dt`-accumulated one is the defect this file already carries
    // a test for). The playhead therefore moves 30 seconds while `dt` says a
    // quarter of one.
    //
    // Dividing that displacement by `dt` is how `speed`, documented right here
    // as the animation driver, came to read four figures on an entity moving at
    // 100: a backgrounded tab regaining focus, rendered as every remote player
    // sprinting. Measured on this profile: a peak of 10,524 u/s with 18 frames
    // still above 1000 and 34 above 200 while the low-pass walked it back,
    // against a flat 100.0 once the elapsed local time is believed.
    const interp = new SnapshotInterpolator<string>();
    const arrivals = straightLine({ ticks: 800, tickMs: 50, speed: 100, latency: () => 40 });
    let next = 0;
    const deliver = (until: number) => {
      while (next < arrivals.length && arrivals[next]!.receivedAt <= until) {
        const a = arrivals[next]!;
        interp.push(frame(a.serverTime, a.receivedAt, a.entities));
        next++;
      }
    };

    const frameMs = 1000 / 60;
    let now = 0;
    for (; now <= 5000; now += frameMs) {
      deliver(now);
      interp.sample(1 / 60, now);
    }

    // Thirty seconds in the background. The socket kept delivering; nothing
    // rendered.
    now = 35_000;
    deliver(now);
    const speeds: number[] = [];
    for (let k = 0; k < 60; k++) {
      // Exactly what `RoomConnection.frame()` passes: a clamped dt beside the
      // true clock.
      const dt = Math.min(0.25, k === 0 ? 30 : 1 / 60);
      const e = interp.sample(dt, now).get('a')!;
      speeds.push(e.speed);
      now += frameMs;
      deliver(now);
    }

    expect(Math.max(...speeds)).toBeLessThan(200);
    // ...and it is a real reading rather than a suppressed one: the entity is
    // moving at 100 and the filter says so within a few frames.
    expect(speeds[speeds.length - 1]).toBeGreaterThan(80);
  });

  it('sampling twice at the same nowMs leaves the measured speed alone instead of zeroing it', () => {
    // A host that renders two views of one room, or samples once for physics
    // and once for drawing, calls this twice on the same clock reading. The
    // second call moves no time, so it can measure no motion, and the old code
    // stored that as a speed of ZERO: the animation driver reporting a standing
    // entity for every entity on screen, for whichever of the two calls the
    // renderer happened to read.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 100, maxDelayMs: 100, startDelayMs: 100 });
    const arrivals = straightLine({ ticks: 40, tickMs: 50, speed: 100, latency: () => 40 });
    let next = 0;
    let now = 0;
    for (; now <= 800; now += 1000 / 60) {
      while (next < arrivals.length && arrivals[next]!.receivedAt <= now) {
        const a = arrivals[next]!;
        interp.push(frame(a.serverTime, a.receivedAt, a.entities));
        next++;
      }
      interp.sample(1 / 60, now);
    }

    const moved = interp.sample(1 / 60, now).get('a')!;
    expect(moved.speed).toBeGreaterThan(90);

    const again = interp.sample(0, now).get('a')!;
    expect(again.speed).toBe(moved.speed);
    expect(again.x).toBe(moved.x);
  });

  it('a reconnect resumes from the held poses as a glide, instead of a snap and then a freeze', () => {
    // THE EPOCH BOUNDARY IS NOT A REASON TO TELEPORT. `clear()` is right to drop
    // every estimate (a new socket may take a new route, and the buffered
    // frames belong to a connection that no longer exists), but the one thing
    // worth carrying across it is where the player last SAW each entity, which
    // is the only continuity that exists from their side. `resumeFrom` is how
    // the host hands that back.
    //
    // What it replaces was measured end to end through a real socket and is
    // reproduced by this profile: the new epoch's first rendered frame steps
    // the entity forward by the whole outage's motion at once, and then
    // playback sits completely STILL for five frames, because a freshly cleared
    // playhead starts `INTERP_START_MS` behind the first buffered frame and the
    // hold branch renders that frame's pose exactly. Snap, then freeze, from
    // one event. Measured over the three seconds after reopen on this 350ms
    // outage, without the seed and with it:
    //
    //   worst single-frame step   25.00 units   ->  4.47 units
    //   peak rendered speed       1500 u/s      ->  268 u/s
    //   motionless frames         5             ->  0
    //
    // The peak that remains IS the outage's motion, spread over
    // `EXTRAP_CAP_MS`: the world really did move while the socket was down, and
    // a glide the player can watch beats a jump between two frames, which is
    // the same trade `ErrorOffset` makes for the local player.
    const arrivals = straightLine({ ticks: 400, tickMs: 50, speed: 100, latency: () => 40 });
    const interp = new SnapshotInterpolator<string>();
    const { track, frameMs, reopenAt, firstLiveAt } = reconnectRun(interp, {
      arrivals,
      dropAtMs: 5000,
      outageMs: 350,
      untilMs: 12_000,
      seed: true,
    });

    const steps = stepsAfter(track, reopenAt);
    expect(steps.length).toBeGreaterThan(300); // an empty run satisfies every bound here
    expect(Math.max(...steps)).toBeLessThan(6);
    expect(Math.max(...steps.map((d) => Math.abs(d))) / (frameMs / 1000)).toBeLessThan(400);

    // NOT FROZEN, which is the half a speed bound structurally cannot see: a
    // snap and a stall are both "one odd frame" to a peak, and the stall is the
    // one a player reads as the connection still being broken. Counted from the
    // first frame the new epoch actually rendered, because before that there is
    // nothing buffered at all and holding is the only thing anyone could do.
    const settling = stepsAfter(track, firstLiveAt + 1);
    expect(settling.length).toBeGreaterThan(300);
    expect(settling.filter((d) => Math.abs(d) < 1e-9).length).toBe(0);

    // ...and it lands back on the live timeline rather than trailing it, one
    // delay behind the newest delivered pose and no further.
    for (const t of track) {
      if (t.now < reopenAt + 2000) continue;
      const stale = newestDeliveredX(t.now, 50, 100, 40) - t.x;
      expect(stale).toBeLessThan(15); // 15 units = 150ms, an INTERP_MIN_MS delay plus an interval
      expect(stale).toBeGreaterThan(-5);
    }
  });

  it('a respawn across a reconnect is clamped to RESUME_GLIDE_MAX_MS of the held speed, not swept in from where it was', () => {
    // THE CLAMP HAS TO BE FED BY THE CALLER, AND THAT IS THE FINDING RATHER
    // THAN A DETAIL. `resumeFrom` bounds its glide by the entity's measured
    // speed, and the first version read that speed from `this.motion`, the map
    // `clear()` empties one line earlier in the connection's own epoch
    // turnover. So the bound was `Infinity` on the only path anything uses and
    // the clamp was structurally dead: a value read from state the caller was
    // just told to destroy is not a default, it is a guarantee the branch never
    // runs. `InterpolatedEntity` carries `speed`, so the map `frame()` returned
    // is a valid seed with the measurement already in it.
    //
    // The case that exposes it: an entity that RESPAWNED while the socket was
    // down, 5000 units from where the player last saw it. Nothing was
    // extrapolated, so the unwind clamp cannot bound this (it would be zero);
    // what bounds it is a second of the entity's own speed. Measured on this
    // profile, on an entity whose true speed is 100: with the pose's speed
    // ignored the render starts at the held pose and sweeps 4823.17 units at
    // 32,254 u/s; with it, it starts 100.00 units back from the confirmed pose
    // (exactly `RESUME_GLIDE_MAX_MS` of that speed) and peaks at 767 u/s.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 100, maxDelayMs: 100, startDelayMs: 100 });
    const arrivals = straightLine({ ticks: 60, tickMs: 50, speed: 100, latency: () => 40 });

    let next = 0;
    let held = new Map<string, InterpolatedEntity>();
    for (let now = 0; now <= 2000; now += 1000 / 60) {
      while (next < arrivals.length && arrivals[next]!.receivedAt <= now) {
        const a = arrivals[next]!;
        interp.push(frame(a.serverTime, a.receivedAt, a.entities));
        next++;
      }
      const out = interp.sample(1 / 60, now);
      if (out.size > 0) held = out;
    }
    const heldPose = held.get('a')!;
    expect(heldPose.speed).toBeGreaterThan(90); // the seed genuinely carries a measurement
    expect(heldPose.x).toBeLessThan(300);

    // The connection's exact sequence.
    interp.clear();
    interp.resumeFrom(held);

    // The new epoch: same entity, 5000 units away.
    interp.push(frame(10_000, 10_040, { a: { x: 5000, y: 0 } }));
    interp.push(frame(10_050, 10_090, { a: { x: 5005, y: 0 } }));
    interp.push(frame(10_100, 10_140, { a: { x: 5010, y: 0 } }));

    // Offset seeds at 40 and the delay is pinned at 100, so the playhead is the
    // midpoint of the bracket [10_050, 10_100]: an interpolated pose of 5007.5.
    const allowed = (heldPose.speed * RESUME_GLIDE_MAX_MS) / 1000;
    const first = interp.sample(1 / 60, 10_215).get('a')!;
    expect(first.x).toBeLessThanOrEqual(5007.5);
    expect(first.x).toBeGreaterThanOrEqual(5007.5 - allowed - 1e-6);
    // ...which is emphatically not "start from where the player last saw it".
    expect(first.x).toBeGreaterThan(4000);

    // And the glide that follows is bounded by that clamp rather than by the
    // distance the entity teleported.
    const xs = [first.x];
    for (let k = 1; k <= 20; k++) xs.push(interp.sample(1 / 60, 10_215 + k * (1000 / 60)).get('a')!.x);
    const peak = Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i]!))) * 60;
    expect(peak).toBeLessThan(1000);
  });

  it('a held pose that never reappears is dropped at the next clear(), not carried into a later epoch', () => {
    // `resumeFrom` seeds a pose per entity and consumes it on that entity's
    // first render, so an entity that never comes back (it left the room while
    // the socket was down) leaves its seed sitting there. `clear()` is what
    // retires it: the seed describes a specific epoch's held frame, and two
    // epochs later it is a pose from a connection nobody remembers, which would
    // glide a returning entity in from wherever it used to be.
    const interp = new SnapshotInterpolator<string>({ minDelayMs: 100, maxDelayMs: 100, startDelayMs: 100 });
    interp.resumeFrom(new Map([['a', { x: -500, y: 0 }]]));
    interp.clear(); // a second epoch turnover, this one with nothing to seed from

    interp.push(frame(0, 40, { a: { x: 0, y: 0 } }));
    interp.push(frame(50, 90, { a: { x: 5, y: 0 } }));
    interp.push(frame(100, 140, { a: { x: 10, y: 0 } }));

    // Offset seeds at 40 and the delay is pinned at 100, so this is the exact
    // midpoint of the bracket [50, 100]: the interpolated pose, with no glide
    // in from a pose that belongs to a dead epoch.
    const out = interp.sample(1 / 60, 215).get('a')!;
    expect(out.x).toBeCloseTo(7.5, 6);
  });

  it('the re-anchor re-derives the playhead in the same call, so the correction is ONE step', () => {
    // Both the offset and the delay just moved, so the playhead computed before
    // the re-anchor describes a clock the class no longer believes. Rendering
    // from it anyway spends the correction over two frames instead of one, and
    // the intermediate one is a pose from neither clock.
    //
    // Measured on a -5000ms backward step with the recompute removed: a single
    // 62 unit BACKWARD step, on a profile that otherwise never rewinds at all.
    const interp = new SnapshotInterpolator<string>();
    const arrivals = serverTimeStep({ ticks: 1400, tickMs: 50, speed: 100, latencyMs: 40, stepAtTick: 200, stepMs: -5000 });
    const { track } = drive(interp, arrivals, { untilMs: 40_000, warmupMs: 40_000 });

    const steps = stepsAfter(track, 9000);
    expect(steps.length).toBeGreaterThan(1000); // an empty run satisfies every bound here
    expect(Math.min(...steps)).toBeGreaterThan(-10);
  });
});
