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
  url?: string | undefined;
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
   * TWO OPTIONS ARE WORTH CALLING OUT BY NAME, because they guarantee
   * different things and only one of them survives a connection that stops
   * answering without closing.
   *
   * `maxRetriesPerRequest` bounds the retries of a command whose CONNECTION
   * has gone away, and the shared command client and a long-lived subscriber
   * want opposite policies:
   *
   *   - The SHARED COMMAND CLIENT (`getRedis`) defaults to a FINITE retry
   *     count (3), so a command issued against a connection ioredis has
   *     given up on rejects rather than queueing behind a reconnect that may
   *     never come.
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
   * `commandTimeout` bounds the WAIT ITSELF, and it is what covers the case
   * the retry count cannot see. A retry count only ever fires once ioredis
   * has NOTICED the connection is gone, i.e. once the socket actually
   * closed. A black-holed connection (a silently dropped NAT mapping, a
   * firewall that discards packets without a FIN or an RST) is still OPEN as
   * far as both ends are concerned: nothing errors, nothing retries, nothing
   * rejects, and every command sits in the queue forever. Measured on this
   * library: 103 commands unanswered after 11 seconds with ZERO log lines,
   * the lease quietly expiring while the ticker's one awaited renew hung on
   * a promise that would never settle. A timeout turns all of that into an
   * ordinary rejection the fire-and-forget `.catch` handlers already have.
   * IT IS DEFAULTED ON THE SHARED CLIENT ONLY, and `createSubscriber` says
   * at length why setting it on a subscriber crashes the process on a slow
   * reconnect. Read that before adding one.
   *
   * See both functions below for exactly what each one merges against.
   */
  redisOptions?: Record<string, unknown> | undefined;
  /**
   * Called with every `'error'` event either client emits.
   *
   * A listener is attached WHETHER OR NOT this is supplied, and that is the
   * point of the field rather than an afterthought: an `EventEmitter` with
   * no `'error'` listener throws the error as an uncaught exception, and
   * ioredis's own fallback (printing `[ioredis] Unhandled error event` per
   * retry) turns one flapping connection into a log flood. The default here
   * is a `console.error` rate-limited to one line per five seconds per
   * client, which is enough to see an outage and not enough to be the
   * outage; a host with real telemetry passes its own and gets every event.
   * A throw out of this hook is swallowed, since there is nowhere left to
   * report it.
   */
  onError?: ((err: unknown) => void) | undefined;
}

/** The floor between two default error lines from one client. Long enough that a flapping connection cannot turn the log into the incident. */
const ERROR_LOG_INTERVAL_MS = 5000;

/**
 * Attaches the `'error'` listener both factories need. Separate from the
 * construction below only because the two call sites must not share one
 * throttle: the rate limit is per client, so a noisy subscriber cannot
 * silence the command client's own first line.
 */
function attachErrorListener(client: { on(ev: string, cb: (err: unknown) => void): unknown }, role: string, onError?: (err: unknown) => void): void {
  let lastLoggedAt = 0;
  const report =
    onError ??
    ((err: unknown): void => {
      const now = Date.now();
      if (now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) return;
      lastLoggedAt = now;
      console.error(`[tickroom:redis] ${role} connection error`, err);
    });
  client.on('error', (err: unknown) => {
    try {
      report(err);
    } catch {
      // A host's own error hook must never throw out of an event handler:
      // an uncaught throw here is the very crash the listener exists to
      // prevent.
    }
  });
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
  // TWO DEFAULTS for the shared command client, both MERGED with (never
  // replaced by) whatever `redisOptions` the caller passed, so a caller
  // adding an unrelated field (`tls`, `lazyConnect`, ...) does not silently
  // lose either; a caller's own value still wins for both, since theirs is
  // spread last.
  //
  // `maxRetriesPerRequest: 3` bounds the retries of a command whose
  // connection ioredis has already given up on. `commandTimeout: 2000`
  // bounds the WAIT, which is the only one of the two that fires on a
  // connection that stopped answering WITHOUT closing: no FIN, no RST, no
  // error event, so no retry policy is ever consulted and the command hangs
  // forever. Together they are what lets every fire-and-forget
  // publish/checkpoint/renew in this library's hot paths reach its `.catch`
  // handler rather than hang. See the asymmetry with `createSubscriber`
  // below, and `RedisFactoryOptions` for what each option really promises.
  //
  // ONE RESIDUAL HAZARD, AND THE SHARED CLIENT SHOULD BE POINTED AT DB 0 TO
  // AVOID IT. The same uncaught-promise shape that rules `commandTimeout`
  // out for a subscriber (see `createSubscriber`) exists on the command
  // client too, through a narrower door: `readyHandler` also calls
  // `self.select(db)` with no `.catch` when the connection comes back on a
  // db other than the one it was on. A URL carrying a non-zero db index
  // (`redis://host:6379/3`) plus a reconnect whose SELECT is slower than
  // this timeout is therefore the same unhandled rejection and the same
  // process exit. A URL with no db index (or an explicit `/0`) never issues
  // that SELECT at all, so use db 0 for the shared client; if a deployment
  // genuinely needs another db, pass `commandTimeout: 0` in `redisOptions`
  // and bound the waits at the call sites instead.
  const redisOptions = { maxRetriesPerRequest: 3, commandTimeout: 2000, ...opts?.redisOptions };
  const client = new Redis(resolveUrl(opts), redisOptions);
  attachErrorListener(client, 'command client', opts?.onError);
  shared = client as unknown as RedisLike;
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
  //
  // AND NO `commandTimeout` HERE, DELIBERATELY, WHICH IS NOT AN OVERSIGHT
  // AND MUST NOT BE "FIXED". A subscriber's commands are not only the ones
  // this library issues: after every reconnect ioredis's own `readyHandler`
  // re-issues the subscription for you (`self.subscribe(subscribeChannels)`,
  // `node_modules/ioredis/built/redis/event_handler.js`), and it does so
  // with NO `.catch` on the returned promise. A `commandTimeout` applies to
  // that command too, so a resubscribe round trip slower than the timeout
  // becomes an UNHANDLED REJECTION, which on any current Node is a process
  // exit: the whole function, every other socket it holds, gone, because one
  // reconnect was slow. Reproduced with a TCP proxy that swallows the
  // resubscribe reply. The same file catches this hazard for `readonly()`
  // (`.catch(noop)`) and not for the two calls below it, which is what makes
  // it a trap rather than a documented contract.
  //
  // Nothing is lost by leaving it off, because the WAIT is bounded where it
  // is actually issued: the relay races `sub.subscribe(...)` against
  // `subscribeTimeoutMs` and the ticker does the same, so a subscribe that
  // never lands still closes the socket rather than hanging. A bound owned
  // by the caller can be applied to the caller's OWN commands only, which is
  // exactly the distinction a client-wide option cannot make.
  const redisOptions = { maxRetriesPerRequest: null, ...opts?.redisOptions };
  const client = new Redis(resolveUrl(opts), redisOptions);
  attachErrorListener(client, 'subscriber', opts?.onError);
  return client as unknown as Subscriber;
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
