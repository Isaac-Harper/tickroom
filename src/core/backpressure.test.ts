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
    const inbox = new Inbox<number>({ cap: 1000, perSenderCap: 5 });
    for (let i = 0; i < 50; i++) inbox.push(i, 'flooder');
    // The flooder has exhausted its own quota, but a well-behaved sender
    // sending one item must not be shed by the flooder's behaviour: the
    // whole point of the per-sender cap is that they are independent.
    expect(inbox.push(999, 'quiet-player')).toBe(true);
    const drained = inbox.drain(1000);
    expect(drained).toContain(999);
  });

  it('demonstrates the failure a per-sender cap fixes: WITHOUT one, a global-only cap lets a flooder starve everyone else', () => {
    // A minimal reproduction of the naive design, inline, to show what this
    // class is actually buying: a flooder alone can exhaust the entire
    // global capacity, at which point a quiet sender's single item is shed
    // too, indiscriminately.
    const globalOnlyCap = 5;
    const queue: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (queue.length < globalOnlyCap) queue.push('flooder');
    }
    const quietAdmitted = queue.length < globalOnlyCap;
    expect(quietAdmitted).toBe(false); // the defect this module exists to avoid
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
