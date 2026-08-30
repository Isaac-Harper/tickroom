// Proves the two claims docs/ARCHITECTURE.md section 1 rests the entire cost
// argument on: one PUBLISH reaches every subscriber for one command (fan-out
// is free), and a connection that has entered subscribe mode cannot run
// ordinary commands on that same connection. Neither is checkable against
// the in-memory fake: its pub/sub is a JS event emitter with no notion of
// "subscribe mode" locking out other commands, because there is no real
// connection state machine to violate.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { TEST_REDIS_URL, probeRedisAvailable, newNamespace, flushNamespace, skipReason, waitFor } from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: pubsub] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

d('pub/sub / real Redis fan-out', () => {
  const namespace = newNamespace('pubsub');
  let publisher: Redis;

  beforeAll(() => {
    publisher = new Redis(TEST_REDIS_URL);
  });

  afterAll(async () => {
    await flushNamespace(TEST_REDIS_URL, namespace);
    publisher.disconnect();
  });

  it('one PUBLISH is received by all 3 independent subscriber connections', async () => {
    const channel = `${namespace}:fanout`;
    const subs = [new Redis(TEST_REDIS_URL), new Redis(TEST_REDIS_URL), new Redis(TEST_REDIS_URL)];
    const received: string[][] = [[], [], []];

    try {
      await Promise.all(
        subs.map((sub, i) => {
          sub.on('message', (ch, msg) => {
            if (ch === channel) received[i].push(msg);
          });
          return sub.subscribe(channel);
        })
      );

      const deliveredTo = await publisher.publish(channel, 'snapshot-1');
      // PUBLISH's own return value is the subscriber count it reached; this
      // is the exact number the cost argument in ARCHITECTURE.md section 1
      // depends on staying flat as room population grows, not the command
      // count.
      expect(deliveredTo).toBe(3);

      const allGotIt = await waitFor(() => received.every((r) => r.includes('snapshot-1')), 1000, 10);
      expect(allGotIt).toBe(true);
    } finally {
      subs.forEach((s) => s.disconnect());
    }
  });

  it('fan-out cost stays exactly 1 command per publish regardless of subscriber count', async () => {
    const channel = `${namespace}:cost`;
    const subs = Array.from({ length: 5 }, () => new Redis(TEST_REDIS_URL));
    try {
      await Promise.all(subs.map((s) => s.subscribe(channel)));

      // MEASURE OUR OWN CONNECTION, NOT THE SERVER. An earlier version of
      // this test read `INFO commandstats`, which is a SERVER-GLOBAL
      // counter: it counts every command from every client connected to
      // this Redis, not just this test's. Vitest runs test files in
      // parallel by default, so the other `*.redis.test.ts` files (in
      // particular ticker.redis.test.ts, which publishes continuously at up
      // to 200Hz) are issuing real PUBLISH commands against this same
      // server during this test's measurement window, and those land
      // inside the before/after delta. That made the assertion flake on a
      // number this test never owned and could not control, and no
      // tolerance band fixes that: it would still be gating on the wrong
      // thing, only more quietly. Picking a different logical DB does not
      // help either, since `total_commands_processed` is per-server, not
      // per-db.
      //
      // Instead, hook the ONE ioredis connection this test publishes
      // through. `sendCommand` is where every command that connection
      // issues actually goes out on the wire, so counting calls to it
      // (after 'ready', so the connection handshake's own commands are not
      // counted) gives an exact, deterministic count that cannot be
      // perturbed by any other connection, in this process or any other.
      let publishCommandsSent = 0;
      const originalSendCommand = publisher.sendCommand.bind(publisher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (publisher as any).sendCommand = (command: { name: string }, ...rest: unknown[]) => {
        if (command.name === 'publish') publishCommandsSent++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalSendCommand as any)(command, ...rest);
      };

      const publishCount = 50;
      try {
        for (let i = 0; i < publishCount; i++) {
          await publisher.publish(channel, `msg-${i}`);
        }
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (publisher as any).sendCommand = originalSendCommand;
      }

      // Exactly one PUBLISH command per call on the wire, independent of
      // the 5 subscribers each one fanned out to server-side. This is a
      // fact about the RESP protocol (a PUBLISH frame carries no
      // per-subscriber repetition) corroborated on our own connection, not
      // an inference from a shared counter.
      expect(publishCommandsSent).toBe(publishCount);
      // eslint-disable-next-line no-console
      console.log(`[measured] ${publishCount} publish() calls issued exactly ${publishCommandsSent} PUBLISH commands on this connection, fanned out to 5 subscribers`);
    } finally {
      subs.forEach((s) => s.disconnect());
    }
  });

  it('a connection in SUBSCRIBE mode cannot run an ordinary command on that same connection', async () => {
    const channel = `${namespace}:locked`;
    const sub = new Redis(TEST_REDIS_URL);
    try {
      await sub.subscribe(channel);
      // src/server/redis.ts's module comment states this as a hard fact
      // about ioredis rather than a design choice: "ioredis puts it into
      // subscriber mode and every other command queues forever or errors,
      // depending on the client". Measured directly: THIS client errors,
      // immediately, with ioredis's own message naming the exact reason.
      // Bound the attempt with a race anyway so a client that instead hangs
      // forever fails this test loudly rather than hanging the whole run.
      await expect(Promise.race([sub.get(`${namespace}:whatever`), timeoutAfter(500)])).rejects.toThrow(
        /subscriber mode/i
      );
    } finally {
      sub.disconnect();
    }
  });
});

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms));
}
