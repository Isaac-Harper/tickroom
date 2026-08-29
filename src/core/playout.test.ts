import { describe, expect, it } from 'vitest';
import { PlayoutBuffer, PLAYOUT_MAX_AHEAD } from './playout.js';

describe('PlayoutBuffer basic push/consume', () => {
  it('consumes exactly the item stamped for a tick', () => {
    const buf = new PlayoutBuffer<string>();
    buf.push(5, 'five');
    const { item, starved } = buf.consume(5);
    expect(item).toBe('five');
    expect(starved).toBe(false);
  });

  it('starves when nothing was pushed for the tick', () => {
    const buf = new PlayoutBuffer<string>();
    const { item, starved } = buf.consume(5);
    expect(item).toBeUndefined();
    expect(starved).toBe(true);
  });

  it('advances lastConsumedTick even on a starve', () => {
    const buf = new PlayoutBuffer<string>();
    buf.consume(5);
    expect(buf.lastConsumedTick).toBe(5);
  });

  it('accepts out-of-order pushes and consumes them in tick order', () => {
    const buf = new PlayoutBuffer<number>();
    buf.push(3, 300);
    buf.push(1, 100);
    buf.push(2, 200);
    expect(buf.consume(1).item).toBe(100);
    expect(buf.consume(2).item).toBe(200);
    expect(buf.consume(3).item).toBe(300);
  });
});

describe('duplicate overwrite', () => {
  it('a second push for the same not-yet-consumed tick overwrites the first', () => {
    const buf = new PlayoutBuffer<string>();
    buf.push(10, 'first');
    buf.push(10, 'second');
    expect(buf.consume(10).item).toBe('second');
  });
});

describe('NEVER-DROP-LATE', () => {
  it('re-stamps a late push forward to lastConsumedTick + 1 instead of dropping it', () => {
    const buf = new PlayoutBuffer<string>();
    buf.consume(10); // lastConsumedTick = 10
    buf.push(8, 'late'); // tick 8 has already passed
    const { item, starved } = buf.consume(11);
    expect(starved).toBe(false);
    expect(item).toBe('late');
  });

  it('re-stamps a push AT the just-consumed tick too (at-or-before, not just before)', () => {
    const buf = new PlayoutBuffer<string>();
    buf.consume(10);
    buf.push(10, 'exactly-late');
    expect(buf.consume(11).item).toBe('exactly-late');
  });

  it('increments lateCount for every re-stamped push', () => {
    const buf = new PlayoutBuffer<string>();
    buf.consume(10);
    buf.push(5, 'a');
    buf.push(6, 'b');
    expect(buf.lateCount).toBe(2);
  });

  it('does not increment lateCount for an on-time or future push', () => {
    const buf = new PlayoutBuffer<string>();
    buf.consume(10);
    buf.push(11, 'ok');
    buf.push(15, 'future');
    expect(buf.lateCount).toBe(0);
  });

  it('a fresher straggler does not clobber an entry already re-stamped into the same slot', () => {
    const buf = new PlayoutBuffer<string>();
    buf.consume(10);
    // "fresher" pushed first: its original tick (9) is closer to on-time.
    buf.push(9, 'fresher');
    // A later straggler, originally meant for an even earlier tick, arrives
    // after and re-stamps onto the same slot (11). It must NOT win.
    buf.push(7, 'staler');
    const { item } = buf.consume(11);
    expect(item).toBe('fresher');
  });

  it('a genuinely fresher push DOES win over an already-re-stamped staler one, regardless of arrival order', () => {
    const buf = new PlayoutBuffer<string>();
    buf.consume(10);
    buf.push(7, 'staler'); // re-stamped to 11 first
    buf.push(9, 'fresher'); // also re-stamps to 11, but orig 9 > orig 7, so it should win
    expect(buf.consume(11).item).toBe('fresher');
  });
});

describe('maxAhead eviction', () => {
  it('drops a push far enough ahead of the current floor to exceed maxAhead', () => {
    const buf = new PlayoutBuffer<string>(10);
    buf.push(50, 'too-far'); // lastConsumedTick starts at -1, so this is 51 ticks ahead
    const { starved } = buf.consume(50);
    expect(starved).toBe(true);
  });

  it('accepts a push exactly at the maxAhead boundary', () => {
    const buf = new PlayoutBuffer<string>(10);
    buf.consume(0); // floor = 0
    buf.push(10, 'boundary'); // exactly maxAhead ahead
    expect(buf.consume(10).item).toBe('boundary');
  });

  it('rejects a push one past the maxAhead boundary', () => {
    const buf = new PlayoutBuffer<string>(10);
    buf.consume(0);
    buf.push(11, 'too-far');
    expect(buf.consume(11).starved).toBe(true);
  });

  it('the default maxAhead is PLAYOUT_MAX_AHEAD', () => {
    const buf = new PlayoutBuffer<string>();
    buf.consume(0);
    buf.push(PLAYOUT_MAX_AHEAD, 'boundary');
    expect(buf.consume(PLAYOUT_MAX_AHEAD).item).toBe('boundary');
    const buf2 = new PlayoutBuffer<string>();
    buf2.consume(0);
    buf2.push(PLAYOUT_MAX_AHEAD + 1, 'too-far');
    expect(buf2.consume(PLAYOUT_MAX_AHEAD + 1).starved).toBe(true);
  });

  it('a stale, skipped-over entry is pruned rather than lingering forever', () => {
    const buf = new PlayoutBuffer<string>();
    buf.push(3, 'skipped');
    buf.consume(10); // jump straight past tick 3 without ever consuming it
    expect(buf.consume(3).starved).toBe(true); // it is gone, not retroactively returned
  });
});

describe('health saturation', () => {
  it('saturates at 255 even with more than 255 buffered entries', () => {
    // A wide maxAhead, and ticks pushed ahead of the natural -1 starting floor.
    // Deliberately NOT reached by consuming a very negative tick to drag the
    // floor backwards: the floor only ever rises (see consume), so a test that
    // relied on it moving back would be asserting through a mechanism that does
    // not exist.
    const buf = new PlayoutBuffer<number>(1000);
    for (let t = 0; t < 400; t++) {
      buf.push(t, t);
    }
    expect(buf.health()).toBe(255);
  });

  it('keeps the consumed floor monotonic when handed an older tick', () => {
    const buf = new PlayoutBuffer<number>();
    buf.consume(10);
    expect(buf.lastConsumedTick).toBe(10);
    buf.consume(4); // a re-anchor, a restore, or a caller bug
    expect(buf.lastConsumedTick).toBe(10);
    // The floor held, so an input for an already-consumed tick is still treated
    // as late and re-stamped forward rather than being silently re-consumable.
    buf.push(6, 6);
    expect(buf.lateCount).toBe(1);
    expect(buf.consume(11).item).toBe(6);
  });

  it('reports the live buffered count under 255', () => {
    const buf = new PlayoutBuffer<number>();
    buf.push(1, 1);
    buf.push(2, 2);
    expect(buf.health()).toBe(2);
  });

  it('drops back down as entries are consumed', () => {
    const buf = new PlayoutBuffer<number>();
    buf.push(1, 1);
    buf.push(2, 2);
    buf.consume(1);
    expect(buf.health()).toBe(1);
  });
});

describe('clear', () => {
  it('resets everything, including lastConsumedTick and lateCount', () => {
    const buf = new PlayoutBuffer<number>();
    buf.push(1, 1);
    buf.consume(0);
    buf.clear();
    expect(buf.lastConsumedTick).toBe(-1);
    expect(buf.lateCount).toBe(0);
    expect(buf.health()).toBe(0);
  });
});
