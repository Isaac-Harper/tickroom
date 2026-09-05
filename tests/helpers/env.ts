// Shared plumbing for the integration suite: a fast reachability probe, a
// per-file unique key namespace, and a scoped cleanup that never touches a
// key this suite did not write itself.
//
// WHY THE PROBE HAS TO RUN AT MODULE TOP LEVEL, NOT INSIDE `beforeAll`.
// `describe`/`it` bodies are collected SYNCHRONOUSLY, before any `beforeAll`
// hook has a chance to run, so an `it.skipIf(cond)` whose `cond` is only
// known after an async `beforeAll` would always see the condition's INITIAL
// value, not the probed one. The fix is a top-level `await` (this package is
// ESM, and vitest's transform supports it): each test file awaits the probe
// once, before it decides whether to call `describe` or `describe.skip`, so
// the skip decision is made with the real answer in hand at collection time.
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

export const TEST_REDIS_URL = process.env.TICKROOM_TEST_REDIS_URL ?? 'redis://127.0.0.1:6399';

/**
 * Set in CI, never locally. Turns "no Redis, skip cleanly" into "no Redis,
 * FAIL", because those are the right answer in opposite environments and the
 * skip is otherwise indistinguishable from a pass.
 *
 * Skipping is correct on a laptop: `npx vitest run` has to stay green with no
 * services, which is the whole reason the probe exists. It is exactly wrong in
 * CI, where the job's ENTIRE purpose is to run these twelve files against the
 * Redis service container. A misnamed service, a wrong port, a container that
 * failed its healthcheck, or a typo in `TICKROOM_TEST_REDIS_URL` would all
 * produce a green integration job that asserted nothing at all, and a gate that
 * cannot fail is worse than no gate.
 *
 * The check lives inside `probeRedisAvailable` rather than in each test file on
 * purpose: all twelve files funnel through this one function, so a thirteenth
 * added later inherits the guard instead of having to remember to opt in.
 */
const REQUIRE_REDIS = process.env.TICKROOM_REQUIRE_REDIS === '1';

const PROBE_TIMEOUT_MS = 1000;

/**
 * One-shot "is there a Redis at this URL" check. Must return `false` FAST
 * and never throw or hang, because the whole point of gating on it is that
 * `npx vitest run` (no env var, possibly no Redis anywhere) stays green. A
 * lazy connection with `retryStrategy: () => null` and `maxRetriesPerRequest:
 * 0` means exactly one connection attempt: no reconnect ladder, no retry
 * queue building up behind a command that will never complete.
 */
export async function probeRedisAvailable(url: string = TEST_REDIS_URL): Promise<boolean> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: PROBE_TIMEOUT_MS,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
  });
  // ioredis emits an 'error' event on a failed connect; with nothing
  // listening that is an unhandled error event, which node treats as fatal.
  // A probe whose entire job is to detect "not reachable" must not itself
  // crash the process when the answer is "not reachable".
  client.on('error', () => {});
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch (err) {
    // Thrown, not returned, and thrown from module scope in every caller (the
    // probe is awaited at the top level so the skip decision is made at
    // collection time). Vitest reports a collection-time throw as a failed test
    // file and exits non-zero, which is exactly the outcome wanted: the job
    // cannot report success while having run none of its assertions.
    if (REQUIRE_REDIS) {
      throw new Error(
        `TICKROOM_REQUIRE_REDIS=1 but Redis at ${url} is unreachable ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          `The integration suite must not skip when it is the point of the run.`
      );
    }
    return false;
  } finally {
    client.disconnect();
  }
}

/** A short-lived, effectively-unique prefix so this run's keys can never collide with another run's or another suite's. */
export function newNamespace(label: string): string {
  return `itest-${label}-${randomUUID().slice(0, 8)}`;
}

/**
 * Deletes every key this namespace could have written and nothing else.
 * Every tickroom key (room keys via `roomKeys`, admission's `conns:{subject}`
 * key) is built as `${namespace}:...`, so one prefix scan covers all of
 * them. Never `FLUSHALL`: the Redis behind `TICKROOM_TEST_REDIS_URL` is not
 * guaranteed to be exclusively this suite's, even though the documented
 * setup here is a disposable local instance.
 */
export async function flushNamespace(url: string, namespace: string): Promise<number> {
  const client = new Redis(url);
  try {
    const keys = await client.keys(`${namespace}:*`);
    if (keys.length === 0) return 0;
    await client.del(...keys);
    return keys.length;
  } finally {
    client.disconnect();
  }
}

export function skipReason(): string {
  return (
    `TICKROOM_TEST_REDIS_URL (${TEST_REDIS_URL}) is unreachable; skipping. ` +
    `Start a local Redis (e.g. redis-server --port 6399 --save '' --appendonly no) ` +
    `or point TICKROOM_TEST_REDIS_URL at a reachable instance to run this suite.`
  );
}

/** Polls `check` until it returns true or `deadlineMs` elapses. Used everywhere this suite would otherwise sleep a fixed duration and hope: real timing means a fixed sleep is either wastefully long or a flake waiting to happen. */
export async function waitFor(check: () => boolean | Promise<boolean>, deadlineMs: number, pollMs = 25): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start >= deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
