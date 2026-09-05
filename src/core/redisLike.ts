// The structural minimum tickroom needs from a Redis client.
//
// `core` never imports `ioredis` directly. Two reasons, and both matter:
//
// 1. TESTABILITY. Every test in this package can hand `RedisLike` a tiny
//    in-memory fake instead of standing up a real Redis, so the lease and
//    checkpoint logic (the parts where a bug is expensive) get exercised
//    thousands of times a second in CI with no network at all.
// 2. SWAPPABILITY. A host that already runs Redis Cloud, a self-hosted
//    instance, or a differently-shaped client library only needs to satisfy
//    this interface, not depend on ioredis at all. `ioredis` itself satisfies
//    `RedisLike` structurally with zero adapter code: every method below is a
//    direct copy of an `ioredis` method signature (narrowed to what tickroom
//    actually calls), so `new Redis(url) as unknown as RedisLike` is never
//    needed and a plain `new Redis(url)` already type-checks against this
//    interface wherever tickroom asks for one.
//
// Deliberately NOT exhaustive. This is not "the Redis command set", it is
// "the commands tickroom's core, server, and client layers actually call".
// Add a method here only when a real call site needs it; a wider surface
// just makes the fake in tests (and any alternative implementation) do more
// work for no benefit.
//
// `Uint8Array`, NEVER `Buffer`, in every binary-carrying signature below.
// `core` (and therefore `codec`, which type-only imports from it) ships to a
// browser bundle, and `Buffer` is a Node global: a consumer with no
// `@types/node` gets "Cannot find name 'Buffer'" the moment their compiler
// resolves this file's declarations, even though nothing here actually runs
// in the browser. `Uint8Array` is the DOM/ES-standard type both environments
// already have. This costs nothing at the real call site: `Buffer` is a
// subclass of `Uint8Array`, so `new Redis(url)` (whose `getBuffer` really
// does return a `Buffer` at runtime) still satisfies this interface
// structurally with zero adapter code, exactly as the paragraph above
// promises.
export interface RedisLike {
  get(key: string): Promise<string | null>;

  /**
   * Returns the raw bytes rather than a decoded string. Load-bearing for the
   * checkpoint path: a checkpoint may be gzip-compressed, and a UTF-8 decode
   * of gzip bytes is lossy and destroys the payload before anything can even
   * sniff the magic bytes to tell it was compressed. Any reader of a value
   * that might be binary must use this, never `get`.
   */
  getBuffer(key: string): Promise<Uint8Array | null>;

  // `number` is here for the same reason `Uint8Array` is: ioredis's own
  // `set` overloads type their `value` parameter as `string | Buffer |
  // number` (a plain `SET key 42` is a legal command), and TypeScript's
  // method-parameter bivariance only accepts the assignment of a real
  // `Redis` to `RedisLike` if EVERY type ioredis's `set` might be handed
  // is assignable into this union. Dropping `number` here would make
  // `redis = new Redis(url)` fail to type-check again, for a reason with
  // nothing to do with `Buffer`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set(key: string, value: string | number | Uint8Array, ...args: any[]): Promise<any>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  publish(channel: string, message: string | Uint8Array): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zcard(key: string): Promise<number>;
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number>;
  incrby(key: string, n: number): Promise<number>;
  hincrby(key: string, field: string, n: number): Promise<number>;

  /**
   * Optional connection-lifecycle events (`'reconnecting'`, `'ready'`,
   * `'error'`), which ioredis exposes and a fake need not. The ticker uses it,
   * when present, to treat the bus as suspect after a reconnect and confirm
   * ownership with an awaited renew before publishing again; without it that
   * confirmation waits for the ordinary renew cadence.
   */
  on?: ((event: string, cb: (...args: unknown[]) => void) => unknown) | undefined;

  /**
   * Removes a listener `on` added. Optional for the same reason `on` is, and
   * load-bearing for the same reason every other teardown in this library is:
   * the shared command client is a PROCESS SINGLETON that outlives any one
   * `runTicker`, so a listener left behind retains that run's entire closure
   * scope (its state, its buffers, its maps) for the lifetime of the process,
   * and a host running many rooms in one instance accumulates one per run.
   */
  off?: ((event: string, cb: (...args: unknown[]) => void) => unknown) | undefined;

  /**
   * Batches several commands into one round trip. Typed `any` deliberately:
   * ioredis's own pipeline typing is a chained builder whose return type
   * depends on which methods were called on it in what order, which is not
   * something a structural interface can describe without dragging in
   * ioredis's own types (which would defeat the point of this file). Callers
   * that need real type safety on a pipeline chain should narrow locally.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipeline(): any;
}
