import { describe, expect, it } from 'vitest';
import { Inbox, INBOX_CAP, MAX_DRAIN_PER_TICK, PER_SENDER_CAP } from './backpressure.js';

describe('Inbox basic push/drain', () => {
  it('drains items in push order', () => {
    const inbox = new Inbox<number>();
    inbox.push(1);
    inbox.push(2);
    inbox.push(3);
    expect(inbox.drain()).toEqual([1, 2, 3]);
  });

  it('reports its size', () => {
    const inbox = new Inbox<number>();
    inbox.push(1);
    inbox.push(2);
    expect(inbox.size()).toBe(2);
    inbox.drain();
    expect(inbox.size()).toBe(0);
  });

  it('drain respects maxDrainPerTick, leaving the rest queued', () => {
    const inbox = new Inbox<number>({ maxDrainPerTick: 2 });
    inbox.push(1);
    inbox.push(2);
    inbox.push(3);
    expect(inbox.drain()).toEqual([1, 2]);
    expect(inbox.size()).toBe(1);
    expect(inbox.drain()).toEqual([3]);
  });

  it('drain accepts an explicit max overriding the configured default', () => {
    const inbox = new Inbox<number>({ maxDrainPerTick: 100 });
    inbox.push(1);
    inbox.push(2);
    inbox.push(3);
    expect(inbox.drain(1)).toEqual([1]);
  });

  it('the shipped default constants are exported', () => {
    expect(INBOX_CAP).toBe(4096);
    expect(MAX_DRAIN_PER_TICK).toBe(1024);
    expect(PER_SENDER_CAP).toBe(64);
  });
});

describe('the global cap', () => {
  it('sheds once the queue reaches cap, returning false from push', () => {
    const inbox = new Inbox<number>({ cap: 3 });
    expect(inbox.push(1)).toBe(true);
    expect(inbox.push(2)).toBe(true);
    expect(inbox.push(3)).toBe(true);
    expect(inbox.push(4)).toBe(false);
    expect(inbox.size()).toBe(3);
  });

  it('counts every shed item in droppedCount', () => {
    const inbox = new Inbox<number>({ cap: 1 });
    inbox.push(1);
    inbox.push(2);
    inbox.push(3);
    expect(inbox.droppedCount).toBe(2);
  });
});

describe('the fairness property: a per-sender cap protects OTHER senders from one flooder', () => {
  it('a flooding sender is shed against its own quota while it is still under the global cap', () => {
    const inbox = new Inbox<number>({ cap: 1000, perSenderCap: 5 });
    let admitted = 0;
    for (let i = 0; i < 50; i++) {
      if (inbox.push(i, 'flooder')) admitted += 1;
    }
    expect(admitted).toBe(5);
    expect(inbox.size()).toBe(5);
  });

  it('THE ACTUAL FAIRNESS CLAIM: a quiet sender still gets through while another sender is actively flooding', () => {
    // THE GLOBAL CAP HAS TO BE SMALL ENOUGH FOR THE FLOODER TO EXHAUST IT,
    // or this test claims nothing. With a cap of 1000 the flooder never gets
    // near it, so the quiet sender is admitted whether the per-sender quota
    // exists or not, and deleting the quota outright left this case green:
    // the very case named THE ACTUAL FAIRNESS CLAIM. A cap of 8 against a
    // per-sender cap of 5 is the configuration where the two answers differ.
    // Without the quota the flooder's 50 pushes fill all 8 slots and the
    // quiet sender is shed at the door; with it the flooder is held to 5 and
    // the other 3 slots are still there for everyone else.
    const inbox = new Inbox<number>({ cap: 8, perSenderCap: 5 });
    for (let i = 0; i < 50; i++) inbox.push(i, 'flooder');
    // The flooder has exhausted its own quota, but a well-behaved sender
    // sending one item must not be shed by the flooder's behaviour: the
    // whole point of the per-sender cap is that they are independent.
    expect(inbox.push(999, 'quiet-player')).toBe(true);
    expect(inbox.size()).toBe(6); // the flooder's 5 plus the quiet one, still under the global cap
    const drained = inbox.drain(1000);
    expect(drained).toContain(999);
  });

  it('the same flood against a per-sender quota too large to ever bind reproduces the global-only design, and starves the quiet sender', () => {
    // THE CONTRAST, DRIVEN THROUGH THE REAL CLASS. This used to be a few
    // lines of arithmetic over a local array, which demonstrated the naive
    // design without touching the module under test at all: no possible
    // change to `backpressure.ts` could fail it, so it read as coverage of
    // the fairness property while pinning nothing. Configuring the real
    // `Inbox` with a per-sender cap it can never reach IS the naive design
    // (a shared limit and nothing else), so the contrast is now measured
    // against the same code path as the case above, with only the quota
    // sizing differing between them.
    const inbox = new Inbox<number>({ cap: 8, perSenderCap: 1000 });
    for (let i = 0; i < 50; i++) inbox.push(i, 'flooder');
    expect(inbox.size()).toBe(8); // one sender, holding the entire shared capacity
    expect(inbox.push(999, 'quiet-player')).toBe(false); // the defect this module exists to avoid
  });

  it('items with no senderId are exempt from the per-sender quota', () => {
    const inbox = new Inbox<number>({ cap: 1000, perSenderCap: 2 });
    for (let i = 0; i < 10; i++) inbox.push(i, null);
    expect(inbox.size()).toBe(10);
  });

  it('the global cap still binds across many distinct senders even though each is within its own per-sender quota', () => {
    const inbox = new Inbox<number>({ cap: 10, perSenderCap: 64 });
    let admitted = 0;
    for (let i = 0; i < 20; i++) {
      if (inbox.push(i, `sender-${i}`)) admitted += 1;
    }
    expect(admitted).toBe(10);
  });
});

describe('drain releases per-sender quota', () => {
  it('a sender at its cap can push again immediately after a drain frees room', () => {
    const inbox = new Inbox<number>({ cap: 1000, perSenderCap: 2 });
    expect(inbox.push(1, 'a')).toBe(true);
    expect(inbox.push(2, 'a')).toBe(true);
    expect(inbox.push(3, 'a')).toBe(false); // at cap

    inbox.drain(); // releases both of sender a's items

    expect(inbox.push(4, 'a')).toBe(true);
  });

  it('draining only some of a sender items releases only that much quota', () => {
    const inbox = new Inbox<number>({ cap: 1000, perSenderCap: 2, maxDrainPerTick: 1 });
    inbox.push(1, 'a');
    inbox.push(2, 'a');
    expect(inbox.push(3, 'a')).toBe(false); // at cap (2/2)

    inbox.drain(1); // releases only the first item

    expect(inbox.push(3, 'a')).toBe(true); // 1 slot freed
    expect(inbox.push(4, 'a')).toBe(false); // back at cap (2/2)
  });
});

describe('resetDropped', () => {
  it('reads and zeroes in one step', () => {
    const inbox = new Inbox<number>({ cap: 1 });
    inbox.push(1);
    inbox.push(2);
    expect(inbox.resetDropped()).toBe(1);
    expect(inbox.droppedCount).toBe(0);
  });
});

describe('clear', () => {
  it('empties the queue and forgets every sender quota', () => {
    const inbox = new Inbox<number>({ cap: 1000, perSenderCap: 1 });
    inbox.push(1, 'a');
    inbox.clear();
    expect(inbox.size()).toBe(0);
    expect(inbox.push(2, 'a')).toBe(true); // quota was forgotten, not just the queue emptied
  });
});
