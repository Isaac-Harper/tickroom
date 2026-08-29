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
  shared = new Redis(resolveUrl(opts)) as unknown as RedisLike;
  return shared;
}

/**
 * A brand-new connection dedicated to `SUBSCRIBE`. Never memoized: unlike
 * the command client, a subscriber is inherently per-caller (per socket, per
 * ticker run), and its whole purpose ends the moment that caller is done
 * with it (see `disconnect`).
 */
export function createSubscriber(opts?: RedisFactoryOptions): Subscriber {
  return new Redis(resolveUrl(opts)) as unknown as Subscriber;
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
