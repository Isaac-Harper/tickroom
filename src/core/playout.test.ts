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

  it('a 6-record redundancy window delivered every tick on a healthy link keeps lateCount at 0', () => {
    // The whole point of the redundancy window (see codec/snapshot.ts) is
    // that every packet re-sends the last few stamped ticks alongside the
    // newest one, so a single lost packet is invisible. On a healthy,
    // zero-loss link, applying the newest record of each window first (the
    // one on-time push that fills a slot for real) means every older,
    // already-delivered record in the same window loses the freshness check
    // and is rejected without ever landing, so lateCount must read 0 however
    // many redundant re-sends actually happened.
    const buf = new PlayoutBuffer<number>();
    const WINDOW = 6;
    for (let tick = 0; tick < 30; tick++) {
      for (let back = 0; back < WINDOW; back++) {
        const t = tick - back;
        if (t < 0) continue;
        buf.push(t, t);
      }
      buf.consume(tick); // the tick just sent arrives before it is due
    }
    expect(buf.lateCount).toBe(0);
  });

  it('a redundancy window arriving one tick late every time climbs lateCount by exactly one per packet', () => {
    // Same window, but the whole packet is a tick behind schedule: its
    // newest record is for the tick the consumer has ALREADY passed. That
    // one record genuinely carries information the buffer never saw on
    // time, so it lands and counts; the rest of the window is now stale
    // relative to it and loses the freshness check exactly as in the
    // healthy case above, so the count climbs by exactly one per packet
    // rather than by the whole window size.
    const buf = new PlayoutBuffer<number>();
    const WINDOW = 6;
    for (let tick = 0; tick < 30; tick++) {
      for (let back = 0; back < WINDOW; back++) {
        const t = tick - 1 - back; // one tick behind the consumer's schedule
        if (t < 0) continue;
        buf.push(t, t);
      }
      buf.consume(tick);
    }
    // Tick 0 has nothing to push in this shifted scheme (every t < 0), so the
    // one-genuine-landing-per-packet climb runs from tick 1 through tick 29:
    // 29 packets, 29 landings.
    expect(buf.lateCount).toBe(29);
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

    // AND THE TIE, which is the case the `>=` exists for and a strict `>`
    // would lose. Two pushes originally stamped for the SAME tick re-stamp
    // onto the same slot and neither is fresher than the other, so the one
    // already sitting there stays: that is a redundancy window re-sending a
    // record the buffer has already taken, and the later copy must not
    // displace it. Without this the comparison could be `>` and every case
    // above would still pass.
    const tie = new PlayoutBuffer<string>();
    tie.consume(10);
    tie.push(9, 'first-copy');
    tie.push(9, 'second-copy');
    expect(tie.consume(11).item).toBe('first-copy');
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
    // Anchored first, so the distance being measured is a real one: the
    // consumer is at 0 and this stamp is 50 ticks past it. This case used to
    // push into a FRESH buffer and rely on the distance from the `-1`
    // sentinel, which is the defect the group below covers: it passed for a
    // reason that had nothing to do with the bound doing its job, and it
    // would have passed identically for a stamp of 5.
    buf.consume(0);
    buf.push(50, 'too-far');
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

/**
 * A BUFFER CREATED IN A ROOM THAT IS ALREADY RUNNING.
 *
 * `lastConsumedTick` starts at -1 to mean "nothing asked for yet". Measuring
 * the ahead bound as a distance from that sentinel made every push into a
 * fresh buffer refused in any room past `maxAhead` ticks, which is every room
 * that has been up for more than two seconds. Measured by a game integrating
 * this library: dropped at room tick 100 and at 50000, kept at tick 0 and 30.
 *
 * A client sending an input redundancy window loses only the first copy, so
 * the symptom there was one starved tick per buffer creation. A client that
 * sends each input once loses the input outright.
 */
describe('a fresh buffer in a room that is already running', () => {
  it('accepts its first push at a high tick instead of refusing everything until a consume', () => {
    // The exact reported case: a player takes control of something on tick
    // 50000, the host makes them a buffer, their client stamps a few ticks
    // ahead of the room.
    const buf = new PlayoutBuffer<string>();
    buf.push(50_004, 'first');
    expect(buf.consume(50_004).item).toBe('first');
  });

  it('does the same at every room tick, not only at the small ones', () => {
    for (const roomTick of [0, 30, 39, 40, 41, 100, 50_000]) {
      const buf = new PlayoutBuffer<string>();
      buf.push(roomTick + 4, 'first');
      expect(buf.consume(roomTick + 4).item, `room tick ${roomTick}`).toBe('first');
    }
  });

  it('keeps the ahead bound live from the very first push, measured against that push', () => {
    // The bound must not simply be disabled while unanchored: a runaway
    // stamp arriving after a sane one is still refused, and the sane one it
    // would have displaced under a size-bound-with-eviction policy survives.
    const buf = new PlayoutBuffer<string>(10);
    buf.push(50_004, 'sane');
    buf.push(90_000, 'runaway');
    expect(buf.consume(50_004).item).toBe('sane');
    expect(buf.consume(90_000).starved).toBe(true);

    // AND THE EXACT WIDTH OF THE WINDOW, which the pair above cannot see:
    // 90000 is 40000 ticks out, so it is refused under any reference point
    // and any bound, and moving the reference by one tick would not have
    // changed a single answer here. The reference is `tick - 1`, so the
    // first push sits INSIDE its own window rather than on the edge of it,
    // and with maxAhead 10 the admissible band around a first push of 50004
    // is 49993..50013. Each end is pinned with its own fresh buffer, since
    // the first consume replaces the reference with the consumer position.
    const atTop = new PlayoutBuffer<string>(10);
    atTop.push(50_004, 'first');
    atTop.push(50_013, 'top of the window');
    expect(atTop.consume(50_013).item).toBe('top of the window');

    const pastTop = new PlayoutBuffer<string>(10);
    pastTop.push(50_004, 'first');
    pastTop.push(50_014, 'one past the top');
    expect(pastTop.consume(50_014).starved).toBe(true);

    const atBottom = new PlayoutBuffer<string>(10);
    atBottom.push(50_004, 'first');
    atBottom.push(49_993, 'bottom of the window');
    expect(atBottom.consume(49_993).item).toBe('bottom of the window');

    const pastBottom = new PlayoutBuffer<string>(10);
    pastBottom.push(50_004, 'first');
    pastBottom.push(49_992, 'one past the bottom');
    expect(pastBottom.consume(49_992).starved).toBe(true);
  });

  it('bounds the window below the reference too, while there is no consumer position', () => {
    // The only direction an unanchored buffer could otherwise grow without
    // limit, since a tick below the floor normally takes the never-drop-late
    // path and dedupes onto one slot.
    const buf = new PlayoutBuffer<string>(10);
    buf.push(50_004, 'sane');
    buf.push(10, 'ancient');
    expect(buf.consume(10).starved).toBe(true);
    expect(buf.consume(50_004).item).toBe('sane');
  });

  it('does not treat older re-sends in the same burst as late', () => {
    // Why the fix does not simply move `lastConsumedTick` to `tick - 1` on
    // the first push. A redundancy window can arrive newest-first after a
    // reorder; anchoring the FLOOR would make every older member of it late,
    // re-stamp them all onto the one slot above the floor, and dedupe all but
    // one away. Each of these must still land on its own tick.
    const buf = new PlayoutBuffer<string>();
    buf.push(50_004, 'd');
    buf.push(50_001, 'a');
    buf.push(50_002, 'b');
    buf.push(50_003, 'c');
    expect(buf.lateCount).toBe(0);
    expect(buf.consume(50_001).item).toBe('a');
    expect(buf.consume(50_002).item).toBe('b');
    expect(buf.consume(50_003).item).toBe('c');
    expect(buf.consume(50_004).item).toBe('d');
  });

  it('hands the reference over to the consumer once there is one', () => {
    // After the first consume the bound is measured from the floor, not from
    // whatever the first push happened to be, so a buffer that was pushed
    // far ahead does not stay permanently strict.
    const buf = new PlayoutBuffer<string>(10);
    buf.push(1000, 'far');
    buf.consume(500); // the consumer is actually way behind that first stamp
    expect(buf.lastConsumedTick).toBe(500);
    buf.push(510, 'in-window'); // 10 past the real floor: admissible
    expect(buf.consume(510).item).toBe('in-window');
    buf.push(600, 'out-of-window');
    expect(buf.consume(600).starved).toBe(true);
  });

  it('re-arms on clear, so a reused buffer is not measured against a dead floor', () => {
    const buf = new PlayoutBuffer<string>();
    buf.consume(10);
    buf.clear();
    buf.push(50_004, 'after-clear');
    expect(buf.consume(50_004).item).toBe('after-clear');
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
