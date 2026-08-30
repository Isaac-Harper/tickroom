// Round-trip and boundary tests for the pong example runtime.
//
// This is the proof, not the pitch. examples/README.md tells a reader to
// "convert explicitly in both directions, and write the round-trip test" for
// serialize/deserialize; this file is that test. It also exercises the other
// three boundary rules the README lists (idempotent join, clamped input,
// deserialize throws on garbage) so a change that quietly breaks one of them
// fails here instead of only in production, where a checkpoint that silently
// drops half a room looks exactly like a healthy one until the next handoff.

import { describe, it, expect } from 'vitest';
import type { ClientInput } from '../../src/core/index.js';
import { pongRuntime, FIELD_W, FIELD_H, type PongState, type PongEvent } from './sim.js';

const DT = 1 / pongRuntime.tickHz;

/** `tick` is typed `{ events? } | void` because the contract lets a runtime
 *  return nothing at all; pong always returns an event array, but every call
 *  site here still has to go through the optional chain the interface allows. */
function stepTick(s: PongState, dt = DT): PongEvent[] {
  const r = pongRuntime.tick(s, dt);
  return (r && 'events' in r ? r.events : undefined) ?? [];
}

function input(seq: number, data: unknown): ClientInput {
  return { seq, data };
}

function freshTwoPlayerRoom(): PongState {
  const s = pongRuntime.create('test-room');
  pongRuntime.join(s, 'a');
  pongRuntime.join(s, 'b');
  return s;
}

/** A smooth, always-in-range value so a test can drive real movement without
 *  ever depending on the clamp itself (that is a separate, dedicated test). */
function dirForTick(i: number, phase: number): number {
  return Math.sin((i + phase) * 0.3);
}

describe('pong: checkpoint round-trip', () => {
  it('serialize then deserialize reproduces every paddle, keyed identically, as a real Map', () => {
    const s = freshTwoPlayerRoom();
    for (let i = 0; i < 5; i++) {
      pongRuntime.applyInput(s, 'a', input(i, { dir: 1 }));
      pongRuntime.applyInput(s, 'b', input(i, { dir: -1 }));
      stepTick(s);
    }

    const restored = pongRuntime.deserialize(pongRuntime.serialize(s));

    // Assert on the reconstructed Map, not on the JSON string: a Map does not
    // survive JSON.stringify on its own, so this is the actual claim under
    // test, not an implementation detail of how the assertion is written.
    expect(restored.paddles).toBeInstanceOf(Map);
    expect(restored.paddles.size).toBe(2);
    expect(new Set(restored.paddles.keys())).toEqual(new Set(['a', 'b']));
    expect(restored.paddles.get('a')).toEqual(s.paddles.get('a'));
    expect(restored.paddles.get('b')).toEqual(s.paddles.get('b'));
    expect(restored.ball).toEqual(s.ball);
    expect(restored.tick).toBe(s.tick);
    expect(restored.seed).toBe(s.seed);
    expect(restored.serveIn).toBe(s.serveIn);
    expect(restored.winner).toBe(s.winner);
  });

  it('a checkpoint taken mid-game continues identically: ticking the restored room forward matches ticking the original forward, input for input', () => {
    const original = freshTwoPlayerRoom();
    const ballXHistory: number[] = [];

    for (let i = 0; i < 50; i++) {
      pongRuntime.applyInput(original, 'a', input(i, { dir: dirForTick(i, 0) }));
      pongRuntime.applyInput(original, 'b', input(i, { dir: dirForTick(i, 1.7) }));
      stepTick(original);
      ballXHistory.push(original.ball.x);
    }

    // Sanity check that this is actually exercising movement, not comparing
    // two rooms that both sat at their spawn defaults the whole time: a
    // round-trip test that never moves anything cannot catch a forgotten
    // field, because the forgotten field's default happens to be correct.
    // Checked over the whole run rather than the single value at tick 50,
    // because a goal re-serves the ball to the exact field centre, so a
    // one-shot check at an arbitrary tick can land on that reset by
    // coincidence and read as "never moved" when it plainly did.
    expect(new Set(ballXHistory).size).toBeGreaterThan(1);
    expect(original.paddles.get('a')!.y).not.toBe(FIELD_H / 2);

    const restored = pongRuntime.deserialize(pongRuntime.serialize(original));

    // Continue BOTH rooms with the identical remaining input, so the
    // assertion is "a restored room keeps simulating correctly", not merely
    // "a restored room parses". A shallow round-trip (encode, decode, compare)
    // would pass even if a field were dropped and its default happened to
    // match the value at the moment of the snapshot; ticking both forward
    // exposes a dropped field the instant it starts to diverge.
    for (let i = 50; i < 100; i++) {
      for (const s of [original, restored]) {
        pongRuntime.applyInput(s, 'a', input(i, { dir: dirForTick(i, 0) }));
        pongRuntime.applyInput(s, 'b', input(i, { dir: dirForTick(i, 1.7) }));
        stepTick(s);
      }
    }

    expect(JSON.parse(pongRuntime.serialize(restored))).toEqual(JSON.parse(pongRuntime.serialize(original)));
  });

  it('the seeded PRNG resumes the identical sequence after a restore, so the ball takes the identical trajectory whether or not a handoff happened', () => {
    const original = freshTwoPlayerRoom();

    // Idle paddles at the field's own tick rate genuinely miss often enough
    // that a goal (and therefore a re-serve, which is the only place this
    // runtime calls nextRandom) is not a contrived setup: it is what an
    // unattended room does. Loop rather than hardcode a tick count, so this
    // does not depend on the exact physics constants staying at today's
    // values; the non-vacuous assertion below is what actually protects it.
    let goalTick = -1;
    for (let i = 0; i < 2000 && goalTick < 0; i++) {
      const events = stepTick(original);
      if (events.some((e) => e.type === 'goal')) goalTick = i;
    }
    expect(goalTick).toBeGreaterThanOrEqual(0);

    // The checkpoint is taken right after a goal, i.e. right after the seed
    // has already advanced and served a new, randomly angled ball. If the
    // seed were NOT carried across the restore (or were re-derived from a
    // clock instead), the two branches below would serve different angles the
    // very next time either of them scores, and the trajectories would part
    // ways at that tick rather than staying bit-identical.
    const restored = pongRuntime.deserialize(pongRuntime.serialize(original));

    const originalTrace: { x: number; y: number; vx: number; vy: number }[] = [];
    const restoredTrace: typeof originalTrace = [];
    const originalGoalTicks: number[] = [];
    const restoredGoalTicks: number[] = [];

    for (let i = 0; i < 300; i++) {
      const evsOriginal = stepTick(original);
      originalTrace.push({ ...original.ball });
      if (evsOriginal.some((e) => e.type === 'goal')) originalGoalTicks.push(i);

      const evsRestored = stepTick(restored);
      restoredTrace.push({ ...restored.ball });
      if (evsRestored.some((e) => e.type === 'goal')) restoredGoalTicks.push(i);
    }

    expect(restoredTrace).toEqual(originalTrace);
    expect(restoredGoalTicks).toEqual(originalGoalTicks);
    // Non-vacuous: proves the PRNG was actually exercised again after the
    // restore, not just that two idle balls happened to coast in parallel.
    expect(originalGoalTicks.length).toBeGreaterThan(0);
  });
});

describe('pong: deserialize refuses to return a half-restored room', () => {
  it('throws on a string that is not JSON at all', () => {
    expect(() => pongRuntime.deserialize('not json')).toThrow();
  });

  it('throws on valid JSON of the wrong shape', () => {
    expect(() => pongRuntime.deserialize(JSON.stringify({ foo: 1 }))).toThrow(/unusable checkpoint/);
  });

  it('throws on JSON that is missing a required field (a truncated checkpoint)', () => {
    expect(() => pongRuntime.deserialize(JSON.stringify({ tick: 5, paddles: [] }))).toThrow(/unusable checkpoint/);
  });
});

describe('pong: join is idempotent', () => {
  it('does not duplicate a player, does not move their paddle, and does not reset their score on a repeated join', () => {
    const s = freshTwoPlayerRoom();
    // Force a goal the deterministic way (see the scoring tests below for why
    // this is the correct way to reach this state) rather than ticking for a
    // while and hoping one lands, so this test's premise cannot go flaky.
    s.serveIn = 0;
    s.ball = { x: -5, y: 60, vx: -10, vy: 0 };
    stepTick(s);
    expect(s.paddles.get('b')!.score).toBe(1);

    const beforeY = s.paddles.get('a')!.y;
    for (let i = 0; i < 5; i++) pongRuntime.join(s, 'a');

    expect(s.paddles.size).toBe(2);
    const a = s.paddles.get('a')!;
    expect(a.side).toBe('left');
    expect(a.y).toBe(beforeY);
    expect(a.score).toBe(0);
    // The re-join heartbeat is for player 'a'; player 'b's score, which the
    // goal actually landed on, must be equally untouched by it.
    expect(s.paddles.get('b')!.score).toBe(1);
  });

  it('a heartbeat join for the second-joined player still assigns "right", not a second "left"', () => {
    const s = pongRuntime.create('test-room');
    pongRuntime.join(s, 'a');
    pongRuntime.join(s, 'b');
    for (let i = 0; i < 3; i++) pongRuntime.join(s, 'b');
    expect(s.paddles.get('a')!.side).toBe('left');
    expect(s.paddles.get('b')!.side).toBe('right');
  });
});

describe('pong: input is clamped at the simulation boundary', () => {
  it('clamps an out-of-range dir into [-1, 1] rather than passing a hostile value through', () => {
    const s = freshTwoPlayerRoom();
    pongRuntime.applyInput(s, 'a', input(1, { dir: 1e9 }));
    expect(s.paddles.get('a')!.dir).toBe(1);
    pongRuntime.applyInput(s, 'a', input(2, { dir: -1e9 }));
    expect(s.paddles.get('a')!.dir).toBe(-1);
  });

  it('a clamped dir cannot move the paddle faster than the legal speed in one tick', () => {
    const s = freshTwoPlayerRoom();
    pongRuntime.applyInput(s, 'a', input(1, { dir: 1e9 }));
    const before = s.paddles.get('a')!.y;
    stepTick(s);
    const moved = s.paddles.get('a')!.y - before;
    // PADDLE_SPEED * dt is the legal per-tick displacement; an unclamped
    // 1e9 would have carried the paddle across the whole field in one tick.
    expect(moved).toBeLessThanOrEqual(90 * DT + 1e-9);
  });

  it.each([
    ['NaN', NaN],
    ['-Infinity', -Infinity],
    ['Infinity', Infinity],
    ['a string', 'fast'],
    ['missing entirely', undefined],
  ])('defaults a non-finite or malformed dir (%s) to 0 rather than crashing or passing it through', (_label, value) => {
    const s = freshTwoPlayerRoom();
    pongRuntime.applyInput(s, 'a', input(1, value === undefined ? {} : { dir: value }));
    expect(s.paddles.get('a')!.dir).toBe(0);
  });

  it('a null input payload is refused without throwing', () => {
    const s = freshTwoPlayerRoom();
    expect(() => pongRuntime.applyInput(s, 'a', input(1, null))).not.toThrow();
    expect(s.paddles.get('a')!.dir).toBe(0);
  });
});

describe('pong: scoring', () => {
  it('a goal increments exactly one score and emits exactly one goal event', () => {
    const s = freshTwoPlayerRoom();
    // Ball already past the left edge: the right-side paddle ('b') gets the
    // point. Driving this directly rather than ticking until it happens
    // naturally is what makes the assertion below exact instead of "at
    // least one goal happened somewhere in this run".
    s.serveIn = 0;
    s.ball = { x: -5, y: 60, vx: -10, vy: 0 };

    const events = stepTick(s);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'goal', scorer: 'b', score: 1 });
    expect(s.paddles.get('b')!.score).toBe(1);
    expect(s.paddles.get('a')!.score).toBe(0);
  });

  it('reaching the win score emits exactly one win event alongside the goal, and play freezes afterward', () => {
    const s = freshTwoPlayerRoom();
    s.paddles.get('b')!.score = 6; // one short of WIN_SCORE
    s.serveIn = 0;
    s.ball = { x: -5, y: 60, vx: -10, vy: 0 };

    const events = stepTick(s);

    expect(events).toEqual([
      { type: 'goal', scorer: 'b', score: 7 },
      { type: 'win', pid: 'b' },
    ]);
    expect(s.winner).toBe('b');

    // Frozen, not merely quiet: the ball must not still be live and the win
    // event must not repeat on the next tick, or a client watching the
    // snapshot stream would see the win toast fire once per tick forever.
    const ballBefore = { ...s.ball };
    const nextEvents = stepTick(s);
    expect(nextEvents).toEqual([]);
    expect(s.ball).toEqual(ballBefore);
  });
});
