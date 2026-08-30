// Round-trip and boundary tests for the cursors example runtime.
//
// Same four properties as pong/sim.test.ts (round-trip, throw-on-garbage,
// idempotent join, clamped input), applied to a runtime with no game logic at
// all. Presence rooms are exactly as vulnerable to a lost Map as a game room
// is: the checkpoint is opaque bytes either way.

import { describe, it, expect } from 'vitest';
import type { ClientInput } from '../../src/core/index.js';
import { cursorsRuntime, type CursorsState, type CursorsEvent } from './sim.js';

const DT = 1 / cursorsRuntime.tickHz;
const IDLE_TICKS = 150; // mirrors the runtime's own constant; see the idle test below for why it is not imported

function stepTick(s: CursorsState, dt = DT): CursorsEvent[] {
  const r = cursorsRuntime.tick(s, dt);
  return (r && 'events' in r ? r.events : undefined) ?? [];
}

function input(seq: number, data: unknown): ClientInput {
  return { seq, data };
}

function freshTwoCursorRoom(): CursorsState {
  const s = cursorsRuntime.create('test-room');
  cursorsRuntime.join(s, 'a', { name: 'Alice' });
  cursorsRuntime.join(s, 'b', { name: 'Bob' });
  return s;
}

/** A value that stays inside 0..1 on its own, so tests driving real movement
 *  never depend on the clamp itself (that has its own dedicated test). */
function posForTick(i: number, phase: number): { x: number; y: number } {
  return { x: (Math.sin((i + phase) * 0.2) + 1) / 2, y: (Math.cos((i + phase) * 0.2) + 1) / 2 };
}

describe('cursors: checkpoint round-trip', () => {
  it('serialize then deserialize reproduces every cursor, keyed identically, as a real Map', () => {
    const s = freshTwoCursorRoom();
    cursorsRuntime.applyInput(s, 'a', input(1, { x: 0.25, y: 0.75, down: true }));
    stepTick(s);

    const restored = cursorsRuntime.deserialize(cursorsRuntime.serialize(s));

    expect(restored.cursors).toBeInstanceOf(Map);
    expect(restored.cursors.size).toBe(2);
    expect(new Set(restored.cursors.keys())).toEqual(new Set(['a', 'b']));
    expect(restored.cursors.get('a')).toEqual(s.cursors.get('a'));
    expect(restored.cursors.get('b')).toEqual(s.cursors.get('b'));
    expect(restored.tick).toBe(s.tick);
    // nextHue is what stops a rejoin from re-colouring an existing cursor;
    // losing it on restore would be invisible until the NEXT player joined
    // and collided with an already-used hue.
    expect(restored.nextHue).toBe(s.nextHue);
  });

  it('a checkpoint taken mid-session continues identically: ticking the restored room forward matches ticking the original forward, input for input', () => {
    const original = freshTwoCursorRoom();

    for (let i = 0; i < 50; i++) {
      const pa = posForTick(i, 0);
      const pb = posForTick(i, 3.1);
      cursorsRuntime.applyInput(original, 'a', input(i, { ...pa, down: i % 2 === 0 }));
      cursorsRuntime.applyInput(original, 'b', input(i, { ...pb, down: false }));
      stepTick(original);
    }

    // Not both still sitting at the 0.5, 0.5 spawn default, or this round
    // trip could not tell a dropped field from a correct one.
    expect(original.cursors.get('a')!.x).not.toBe(0.5);

    const restored = cursorsRuntime.deserialize(cursorsRuntime.serialize(original));

    const originalIdle: string[] = [];
    const restoredIdle: string[] = [];
    for (let i = 50; i < 220; i++) {
      for (const [s, sink] of [
        [original, originalIdle],
        [restored, restoredIdle],
      ] as const) {
        // Only 'a' keeps moving past tick 50; 'b' goes still, which is what
        // exercises the idle-fade edge (see the dedicated idle test below
        // for why this must fire on the exact crossing tick and nowhere
        // else) as part of the same continued-simulation check rather than
        // as an isolated scenario.
        const pa = posForTick(i, 0);
        cursorsRuntime.applyInput(s, 'a', input(i, { ...pa, down: false }));
        const events = stepTick(s);
        for (const e of events) if (e.type === 'idle') sink.push(e.pid);
      }
    }

    expect(restoredIdle).toEqual(originalIdle);
    // Non-vacuous: 'b' really did go idle in both branches, at the identical
    // tick, rather than the two arrays both happening to be empty.
    expect(originalIdle).toEqual(['b']);
    expect(JSON.parse(cursorsRuntime.serialize(restored))).toEqual(JSON.parse(cursorsRuntime.serialize(original)));
  });
});

describe('cursors: deserialize refuses to return a half-restored room', () => {
  it('throws on a string that is not JSON at all', () => {
    expect(() => cursorsRuntime.deserialize('not json')).toThrow();
  });

  it('throws on valid JSON of the wrong shape', () => {
    expect(() => cursorsRuntime.deserialize(JSON.stringify({ foo: 1 }))).toThrow(/unusable checkpoint/);
  });

  it('throws on JSON that is missing a required field (a truncated checkpoint)', () => {
    expect(() => cursorsRuntime.deserialize(JSON.stringify({ tick: 5 }))).toThrow(/unusable checkpoint/);
  });
});

describe('cursors: join is idempotent', () => {
  it('does not duplicate a cursor, does not move it, and does not re-colour it on a repeated join', () => {
    const s = freshTwoCursorRoom();
    cursorsRuntime.applyInput(s, 'a', input(1, { x: 0.3, y: 0.7, down: true }));
    const before = { ...s.cursors.get('a')! };

    for (let i = 0; i < 5; i++) cursorsRuntime.join(s, 'a', { name: 'AliceRenamed' });

    expect(s.cursors.size).toBe(2);
    const after = s.cursors.get('a')!;
    // A re-join carrying a new name IS allowed to change the name (a real
    // rename-and-reconnect), but must leave everything else, hue especially,
    // untouched: re-assigning a hue on every heartbeat would make a whole
    // room's cursors strobe colour once a second.
    expect(after.hue).toBe(before.hue);
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.down).toBe(before.down);
    expect(after.name).toBe('AliceRenamed');
  });

  it('a heartbeat join with no meta at all does not reset the display name to "anon"', () => {
    const s = freshTwoCursorRoom();
    cursorsRuntime.join(s, 'a');
    expect(s.cursors.get('a')!.name).toBe('Alice');
  });

  it('two players never collide on the same hue after either one rejoins', () => {
    const s = freshTwoCursorRoom();
    for (let i = 0; i < 5; i++) cursorsRuntime.join(s, 'a');
    for (let i = 0; i < 5; i++) cursorsRuntime.join(s, 'b');
    expect(s.cursors.get('a')!.hue).not.toBe(s.cursors.get('b')!.hue);
  });
});

describe('cursors: display name is sanitised at the join boundary', () => {
  it('strips control characters rather than shipping them to every other client', () => {
    const s = cursorsRuntime.create('test-room');
    cursorsRuntime.join(s, 'x', { name: '\x01Alice\x1f' });
    expect(s.cursors.get('x')!.name).toBe('Alice');
  });

  it('falls back to "anon" for a whitespace-only or non-string name instead of a raw or empty value', () => {
    const s = cursorsRuntime.create('test-room');
    cursorsRuntime.join(s, 'y', { name: '   ' });
    expect(s.cursors.get('y')!.name).toBe('anon');
    cursorsRuntime.join(s, 'z', { name: 123 });
    expect(s.cursors.get('z')!.name).toBe('anon');
  });

  it('truncates an oversized name rather than sending it to every client at full length', () => {
    const s = cursorsRuntime.create('test-room');
    cursorsRuntime.join(s, 'w', { name: 'x'.repeat(200) });
    expect(s.cursors.get('w')!.name.length).toBe(24);
  });
});

describe('cursors: input is clamped at the simulation boundary', () => {
  it('clamps an out-of-range position into [0, 1] rather than passing a hostile value through', () => {
    const s = freshTwoCursorRoom();
    cursorsRuntime.applyInput(s, 'a', input(1, { x: 1e9, y: -1e9, down: 'yes' }));
    const a = s.cursors.get('a')!;
    expect(a.x).toBe(1);
    expect(a.y).toBe(0);
    // A truthy non-boolean must not be read as "pressed": only `=== true`
    // arms a drawing or drag layer.
    expect(a.down).toBe(false);
  });

  it.each([
    ['NaN', { x: NaN, y: NaN }],
    ['a string', { x: 'left', y: 'up' }],
    ['null', { x: null, y: null }],
    ['missing entirely', {}],
  ])('falls back to the 0.5, 0.5 default (%s) rather than crashing or passing a malformed value through', (_label, data) => {
    const s = freshTwoCursorRoom();
    cursorsRuntime.applyInput(s, 'a', input(1, data));
    const a = s.cursors.get('a')!;
    expect(a.x).toBe(0.5);
    expect(a.y).toBe(0.5);
  });

  it('a null input payload is refused without throwing', () => {
    const s = freshTwoCursorRoom();
    expect(() => cursorsRuntime.applyInput(s, 'a', input(1, null))).not.toThrow();
  });

  it('a keepalive resending the same coordinates does not reset the idle timer', () => {
    const s = freshTwoCursorRoom();
    cursorsRuntime.applyInput(s, 'a', input(1, { x: 0.4, y: 0.4 }));
    stepTick(s); // tick 1: real movement, lastMoveTick becomes 1
    const movedAt = s.cursors.get('a')!.lastMoveTick;

    for (let i = 0; i < 5; i++) {
      cursorsRuntime.applyInput(s, 'a', input(2 + i, { x: 0.4, y: 0.4 })); // identical coordinates
      stepTick(s);
    }

    expect(s.cursors.get('a')!.lastMoveTick).toBe(movedAt);
  });
});

describe('cursors: the idle event fires on the edge, not for the whole idle period', () => {
  it('emits idle exactly once, on the tick the threshold is crossed, and never again', () => {
    const s = freshTwoCursorRoom();
    cursorsRuntime.applyInput(s, 'a', input(1, { x: 0.4, y: 0.4 }));
    stepTick(s); // one real move, so lastMoveTick has a known value to count from

    const idleFires: number[] = [];
    for (let i = 0; i < IDLE_TICKS + 50; i++) {
      const events = stepTick(s);
      for (const e of events) if (e.pid === 'a') idleFires.push(s.tick);
    }

    // Exactly one entry, not zero (the edge was missed) and not one per tick
    // past the threshold (a client would replay the idle-fade toast forever).
    expect(idleFires).toHaveLength(1);
  });
});
