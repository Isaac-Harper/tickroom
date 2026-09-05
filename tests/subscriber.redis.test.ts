// WHY THIS FILE EXISTS, AND WHY IT CANNOT BE A UNIT TEST.
//
// `createSubscriber` deliberately sets NO `commandTimeout`, and the reason is
// a property of ioredis's own reconnect path rather than of anything this
// library calls: `readyHandler` re-issues the subscription for you after
// every reconnect (`self.subscribe(subscribeChannels)` in
// `node_modules/ioredis/built/redis/event_handler.js`) with no `.catch` on
// the promise it returns. A client-wide `commandTimeout` applies to that
// command too, so a resubscribe round trip slower than the timeout is an
// UNHANDLED REJECTION, which on any current Node terminates the process: the
// whole serverless function, every other socket it was holding, gone,
// because one reconnect was slow.
//
// `src/server/redis.test.ts` pins the OPTIONS the factory passes. This file
// pins what those options DO, which needs three things a unit test cannot
// have: a real ioredis reconnect, a real Redis to reconnect to, and a real
// process to survive or not. The delay is produced by a tiny TCP proxy in
// front of Redis that swallows the reply to the resubscribe for longer than
// the timeout.
//
// The two children below are the measurement and its control. The control
// (`commandTimeout` set, i.e. the shape this fix set briefly shipped) must
// DIE; the fixed one must survive and keep delivering. A test that only ran
// the second would pass just as well against a proxy that never delayed
// anything.
import { describe, it, expect, afterEach } from 'vitest';
import Redis from 'ioredis';
import { spawn } from 'node:child_process';
import { TEST_REDIS_URL, probeRedisAvailable, skipReason } from './helpers/env.js';
import { startProxy, proxyTargetFrom, isSubscribeCommand, type FaultProxy } from './helpers/proxy.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: subscriber] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

const CHANNEL = 'itest-subscriber-reconnect';
const CHILD_TIMEOUT_MS = 250; // the control child's commandTimeout
const REPLY_DELAY_MS = 1200; // comfortably past it, and past a couple of reconnect attempts

/**
 * THE PROXY LIVES IN `tests/helpers/proxy.ts` and is shared with
 * `tests/faults.redis.test.ts`. Two knobs are used here: `cut()`, which kills
 * the live pair and is what makes ioredis reconnect, and
 * `holdRepliesMatching`, which holds the reply to the SUBSCRIBE on the
 * connections that follow.
 *
 * IT HAS TO BE THE SUBSCRIBE REPLY SPECIFICALLY, not every reply on the new
 * connection, and getting that wrong is why the first version of this file
 * measured nothing. ioredis runs a READY CHECK (`INFO`) before `readyHandler`
 * ever fires, and a client-wide `commandTimeout` covers that command too, so
 * delaying everything makes the ready check time out first: the connection
 * never becomes ready, the resubscribe is never issued, and the very command
 * under test never happens. Watching the client side for the word `subscribe`
 * (`isSubscribeCommand`) and holding only what comes back after it lets the
 * handshake complete at full speed and delays exactly one command.
 */

/**
 * The child: a subscriber through the proxy, in a process of its own so that
 * an unhandled rejection is measurable as what it really is (an exit) rather
 * than as something vitest catches on the suite's behalf. `withTimeout`
 * selects the two option sets; everything else about the two runs is
 * identical.
 */
const CHILD_SOURCE = `
import Redis from 'ioredis';
// \`node -e\` puts the arguments after \`--\` straight after execPath, with no
// script path in between, so this is slice(1) and not the usual slice(2).
const [url, mode, timeoutMs, channel] = process.argv.slice(1);
const options = { maxRetriesPerRequest: null };
if (mode === 'timeout') options.commandTimeout = Number(timeoutMs);
const sub = new Redis(url, options);
sub.on('error', () => {});
sub.on('message', () => {
  console.log('GOT');
  sub.disconnect();
  process.exit(0);
});
await sub.subscribe(channel);
console.log('READY');
setTimeout(() => {
  console.log('NEVER');
  process.exit(3);
}, 15000);
`;

function runChild(url: string, mode: 'timeout' | 'default'): {
  ready: Promise<void>;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  kill(): void;
} {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', CHILD_SOURCE, '--', url, mode, String(CHILD_TIMEOUT_MS), CHANNEL],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout.on('data', (b: Buffer) => {
    stdout += b.toString('utf8');
    if (stdout.includes('READY')) markReady();
  });
  child.stderr.on('data', (b: Buffer) => {
    stderr += b.toString('utf8');
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { ready, done, kill: () => child.kill('SIGKILL') };
}

d('createSubscriber survives a slow resubscribe / real Redis', () => {
  const target = proxyTargetFrom(TEST_REDIS_URL);
  let proxy: FaultProxy | null = null;
  let publisher: Redis | null = null;

  afterEach(async () => {
    publisher?.disconnect();
    publisher = null;
    await proxy?.close();
    proxy = null;
  });

  /**
   * Brings a child up through the proxy, forces a reconnect whose resubscribe
   * reply is held past the control's timeout, then publishes. The child
   * either survives to receive it or does not.
   */
  async function reconnectUnderDelay(mode: 'timeout' | 'default') {
    proxy = await startProxy(target);
    const child = runChild(proxy.url, mode);
    await child.ready;

    // Every connection from here on has its subscribe reply held, which is
    // what the resubscribe ioredis issues on its own behalf runs into.
    proxy.holdRepliesMatching(isSubscribeCommand, REPLY_DELAY_MS);
    proxy.cut();

    // Long enough for the reconnect, the resubscribe, and the control's
    // timeout to have fired, before anything is published.
    await new Promise((r) => setTimeout(r, CHILD_TIMEOUT_MS + REPLY_DELAY_MS + 1500));

    publisher = new Redis(TEST_REDIS_URL);
    for (let i = 0; i < 8; i++) {
      await publisher.publish(CHANNEL, 'hello');
      await new Promise((r) => setTimeout(r, 250));
    }

    const result = await Promise.race([
      child.done,
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    child.kill();
    return result;
  }

  it('THE CONTROL: a commandTimeout on a subscriber kills the process when the resubscribe is slow', async () => {
    // This is the shape `createSubscriber` briefly shipped. The rejection
    // comes from a command ioredis issued for itself, so no `.catch` this
    // library could write would ever see it.
    const result = await reconnectUnderDelay('timeout');
    expect(result).not.toBeNull();
    expect(result?.code).not.toBe(0);
    expect(`${result?.stderr}`).toMatch(/unhandled|timed out/i);
    expect(result?.stdout).not.toContain('GOT');
  }, 30_000);

  it('with the shipped defaults the subscriber survives the same reconnect and messages resume', async () => {
    const result = await reconnectUnderDelay('default');
    expect(result).not.toBeNull();
    expect(result?.stdout).toContain('GOT'); // delivery resumed on the reconnected subscription
    expect(result?.code).toBe(0);
  }, 30_000);
});
