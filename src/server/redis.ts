import Redis from 'ioredis';
import type { RedisLike } from '../core/index.js';

/**
 * Connection helpers for the two roles every host needs: a shared command
 * client (the ticker's publisher, the relay's publisher/admission reads) and
 * one-off subscriber connections (one per socket the relay holds, one per
 * ticker run).
 *
 * TWO HARD CONSTRAINTS THAT SHAPE THIS FILE, both non-negotiable properties
 * of how Redis pub/sub actually works, not a design preference:
 *
 * 1. A connection that has issued `SUBSCRIBE` cannot run ordinary commands
 *    on the same connection: ioredis puts it into "subscriber mode" and
 *    every other command queues forever or errors, depending on the client.
 *    That is why the module keeps exactly ONE shared client for ordinary
 *    commands (`getRedis`) and hands out a BRAND NEW connection every time
 *    `createSubscriber` is called. Sharing a subscriber connection across
 *    two purposes, or trying to run a `GET` on one, is a bug this split
 *    exists to make structurally impossible.
 *
 * 2. A REST-style Redis client (the kind that exposes commands as ordinary
 *    HTTP calls) cannot subscribe to anything: there is no long-lived
 *    connection for the server to push messages down. This whole
 *    architecture is built on a real, long-lived TCP connection
 *    (`rediss://...`) precisely because the ticker-to-socket fan-out is
 *    pub/sub, not polling. That rules out several managed "Redis-compatible"
 *    HTTP APIs as the transport bus, even ones that are otherwise excellent
 *    for ordinary command traffic; they can still be used for anything that
 *    only ever calls `getRedis()`, just not for `createSubscriber()`.
 *
 * THE WALL THIS ARCHITECTURE HITS FIRST. Every player socket the relay holds
 * keeps its own subscriber connection open for the lifetime of that socket,
 * so N concurrently connected players is N concurrent TCP connections to
 * Redis, not one. A managed Redis plan's CONCURRENT CONNECTION ceiling, not
 * its command-per-second quota, is therefore usually the first limit this
 * design runs into. It is also why a per-subject socket cap matters beyond
 * fairness: without one, a single client opening many sockets (deliberately
 * or from a reconnect bug) can burn through the connection ceiling and take
 * down every OTHER subscriber sharing it, including the room's own ticker,
 * which turns one misbehaving client into a total outage for the room rather
 * than a personal inconvenience.
 */
export interface RedisFactoryOptions {
  /** Defaults to `process.env.REDIS_URL`. */
  url?: string;
  /**
   * MERGED ON TOP of this factory's own default options and passed to
   * `new Redis(url, options)` (ioredis's own `RedisOptions`). Typed
   * `Record<string, unknown>` rather than importing ioredis's own options
   * type here: this module already imports `Redis` itself, so there is no
   * barrier to importing its types too, but keeping the surface
   * untyped-but-passed-through means a caller can hand in whatever their
   * installed ioredis version accepts without this file having to track
   * that type across ioredis major versions.
   *
   * MERGED, NOT REPLACED, and that is a deliberate choice rather than the
   * simpler "caller's object wins outright" you might reach for first: a
   * caller who only wants to add, say, `tls` or `lazyConnect` should not
   * have to also re-state the retry policy just to avoid silently losing
   * it. A caller who genuinely wants a DIFFERENT retry policy still gets
   * it, because their own `maxRetriesPerRequest` (if present) is spread
   * last and wins over the default. `getRedis` and `createSubscriber` each
   * merge against their OWN default object, never a shared one, which is
   * what makes the asymmetry below actually asymmetric.
   *
   * `maxRetriesPerRequest` IS THE ONE OPTION WORTH CALLING OUT BY NAME,
   * because the shared command client and a long-lived subscriber want
   * OPPOSITE defaults and neither was configurable at all before this:
   *
   *   - The SHARED COMMAND CLIENT (`getRedis`) defaults to a FINITE retry
   *     count (3). A command that keeps queueing forever behind a dead
   *     connection is a command that never resolves and never rejects,
   *     which is a silent hang rather than a caught, logged failure this
   *     library's fire-and-forget `.catch` handlers can act on.
   *   - A SUBSCRIBER (`createSubscriber`) defaults to
   *     `maxRetriesPerRequest: null` (ioredis's documented way to mean
   *     "retry the underlying connection forever, never surface a give-up
   *     error"), because giving up on a subscriber does not fail loudly,
   *     it fails INVISIBLY: the connection stops delivering pub/sub
   *     messages while every other signal (the socket, the room's stats
   *     key, the lease) keeps reading healthy. In this architecture that is
   *     a room that LOOKS alive and receives nothing, which is strictly
   *     worse than an error a caller can catch, because there is nothing
   *     to catch.
   *
   * See both functions below for exactly what each one merges against.
   */
  redisOptions?: Record<string, unknown>;
}

function resolveUrl(opts?: RedisFactoryOptions): string {
  const url = opts?.url ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      'REDIS_URL is not set (and no url was passed). tickroom needs a real TCP Redis ' +
        'connection for pub/sub, not a REST endpoint: see the module comment in server/redis.ts.'
    );
  }
  return url;
}

/** A subscriber connection: every `RedisLike` command plus the pub/sub surface a raw ioredis client exposes once `subscribe` has been called on it. */
export type Subscriber = RedisLike & {
  on(ev: string, cb: (...args: unknown[]) => void): void;
  subscribe(...channels: string[]): Promise<unknown>;
  disconnect(): void;
};

// Module-scoped, not per-call: a serverless function instance that handles
// many sockets over its lifetime must reuse ONE command connection across
// all of them, not open a fresh one per request. Opening one per request is
// the single most common way a Redis-backed serverless deployment silently
// exhausts its own connection ceiling under load.
let shared: RedisLike | null = null;

/**
 * The shared command client: `GET`/`SET`/`PUBLISH`/pipelines, everything
 * that is not `SUBSCRIBE`. Memoized per module instance so every caller in
 * this process reuses the same connection rather than opening a new one.
 */
export function getRedis(opts?: RedisFactoryOptions): RedisLike {
  if (shared) return shared;
  // ioredis satisfies `RedisLike` structurally (see redisLike.ts), but its
  // own method signatures are a heavily overloaded superset (`set` alone has
  // a dozen call shapes for every TTL/flag combination) that TypeScript
  // cannot always prove is a subtype of the simplified structural interface
  // tickroom asks for. The cast is a deliberate, narrow escape hatch, not a
  // sign the two are actually incompatible at runtime: every method this
  // file's callers use is a direct call-through to the real ioredis client.
  //
  // DEFAULT `maxRetriesPerRequest: 3` for the shared command client,
  // MERGED with (never replaced by) whatever `redisOptions` the caller
  // passed, so a caller adding an unrelated field (`tls`, `lazyConnect`,
  // ...) does not silently lose this default; a caller's own
  // `maxRetriesPerRequest` still wins, since it is spread last. A finite
  // retry count means a command against a dead connection eventually
  // REJECTS instead of queueing forever, which is what lets every
  // fire-and-forget publish/checkpoint/renew in this library's hot paths
  // reach their `.catch` handler rather than hang. See the asymmetry with
  // `createSubscriber` below, and `RedisFactoryOptions` for why the two
  // roles want opposite policies.
  const redisOptions = { maxRetriesPerRequest: 3, ...opts?.redisOptions };
  shared = new Redis(resolveUrl(opts), redisOptions) as unknown as RedisLike;
  return shared;
}

/**
 * A brand-new connection dedicated to `SUBSCRIBE`. Never memoized: unlike
 * the command client, a subscriber is inherently per-caller (per socket, per
 * ticker run), and its whole purpose ends the moment that caller is done
 * with it (see `disconnect`).
 */
export function createSubscriber(opts?: RedisFactoryOptions): Subscriber {
  // DEFAULT `maxRetriesPerRequest: null`, MERGED with (never replaced by)
  // the caller's own `redisOptions`, the same merge discipline `getRedis`
  // uses above but against the OPPOSITE default: ioredis's documented
  // meaning of `null` is "keep retrying the underlying connection forever,
  // never surface a give-up error on a queued command". A subscriber that
  // gave up on retries would not fail loudly, it would fail INVISIBLY,
  // silently ceasing to deliver pub/sub messages while the socket, the
  // lease, and the room's stats key all keep reading healthy: a room that
  // looks alive and receives nothing. That failure mode is exactly the
  // opposite of what `getRedis`'s finite default protects against, which is
  // why the two factories default differently rather than sharing one
  // policy; see `RedisFactoryOptions`.
  const redisOptions = { maxRetriesPerRequest: null, ...opts?.redisOptions };
  return new Redis(resolveUrl(opts), redisOptions) as unknown as Subscriber;
}

/**
 * Drops the memoized shared client so the next `getRedis()` call builds a
 * fresh one. Exists for tests that construct their own fake client per test
 * case and need to be sure a previous test's connection is not still
 * memoized underneath them; a real host never needs to call this.
 */
export function resetRedisForTests(): void {
  if (shared) {
    try {
      (shared as unknown as { disconnect?: () => void }).disconnect?.();
    } catch {
      // best-effort teardown only; a stuck disconnect must not fail a test.
    }
  }
  shared = null;
}
