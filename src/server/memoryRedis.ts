// An in-memory Redis stand-in: three plain Maps (strings, hashes, sorted
// sets) plus a pub/sub bus, shared through a `Hub` so that two `MemoryRedis`
// instances created from the same hub behave the way a real command
// connection and a real subscriber connection sharing one logical Redis
// database do. It implements exactly the `RedisLike` surface plus the pub/sub
// extras `Subscriber` adds, and nothing wider.
//
// THIS FILE SHIPS. It used to live in `testFakeRedis.ts`, excluded from
// `tsconfig.build.json`, and the only thing that made it test-only was where
// it lived: every host that runs ONE process and does not want a Redis beside
// it needs precisely this object, and a library that keeps its own working
// implementation out of the package leaves that host to rewrite it. It is
// still the in-memory client every unit test in this package runs against,
// from this one file rather than a copy, so what a consumer gets is what the
// suite exercises thousands of times a run. See `createMemoryRedis` for what
// a single process gives up by using it.

import type { RedisLike } from '../core/index.js';
import type { Subscriber } from './redis.js';

class Hub {
  strings = new Map<string, { value: string | Buffer; expiresAt: number | null }>();
  hashes = new Map<string, Map<string, string>>();
  zsets = new Map<string, Map<string, number>>();
  subscribers = new Set<MemoryRedis>();
}

type Listener = (...args: unknown[]) => void;

export class MemoryRedis implements RedisLike {
  private readonly hub: Hub;
  private readonly channels = new Set<string>();
  private onMessage: Listener | null = null;
  private onMessageBuffer: Listener | null = null;
  private readonly lifecycle = new Map<string, Listener[]>();
  private readonly broken = new Set<string>();

  constructor(hub?: Hub) {
    this.hub = hub ?? new Hub();
  }

  /** A second client sharing this instance's store and pub/sub bus, standing in for a dedicated subscriber connection to the "same" Redis. */
  fork(): MemoryRedis {
    return new MemoryRedis(this.hub);
  }

  /** Makes the named method reject, for exercising a host's fail-open/fail-closed paths without a real Redis to actually break. */
  break(method: string): void {
    this.broken.add(method);
  }

  private guard(method: string): void {
    if (this.broken.has(method)) throw new Error(`fake redis: ${method} broken for this test`);
  }

  private live(key: string): string | Buffer | undefined {
    const entry = this.hub.strings.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.hub.strings.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    this.guard('get');
    const v = this.live(key);
    if (v === undefined) return null;
    return typeof v === 'string' ? v : v.toString('utf8');
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    this.guard('getBuffer');
    const v = this.live(key);
    if (v === undefined) return null;
    return typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async set(key: string, value: string | Buffer, ...args: any[]): Promise<any> {
    this.guard('set');
    let ttlMs: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const flag = String(args[i]).toUpperCase();
      if (flag === 'EX') {
        ttlMs = Number(args[++i]) * 1000;
      } else if (flag === 'PX') {
        ttlMs = Number(args[++i]);
      } else if (flag === 'NX') {
        nx = true;
      }
    }
    if (nx && this.live(key) !== undefined) return null;
    this.hub.strings.set(key, { value, expiresAt: ttlMs !== null ? Date.now() + ttlMs : null });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    this.guard('del');
    let n = 0;
    for (const k of keys) {
      const had = this.hub.strings.delete(k) || this.hub.hashes.delete(k) || this.hub.zsets.delete(k);
      if (had) n++;
    }
    return n;
  }

  /**
   * Distinguishes the three real scripts this library sends, since this fake
   * has no Lua interpreter. Each is matched on a substring of its own text:
   * the owner-checked CHECKPOINT write (`server/checkpoint.ts`) is the only
   * one that reads a SECOND key, and of the two one-key lease scripts only
   * RELEASE calls `redis.call('del', ...)`. A heuristic against the three
   * specific scripts this library is known to send, NOT A GENERAL `eval`, and
   * that is the one line of the `RedisLike` surface this file does not
   * honestly implement: a caller's own script falls through to the one-key
   * lease branch and quietly performs a SET. Nothing in tickroom sends a
   * fourth, and a host reaching for `redis.eval` on this client is outside
   * what `createMemoryRedis` promises.
   *
   * AND THE OWNER CHECK IS THE SCRIPT'S, NOT THIS FAKE'S. It used to be
   * applied unconditionally, whatever the script said, which quietly made
   * every offline case that turns on it vacuous: deleting the
   * `get(KEYS[1]) == ARGV[1]` comparison from `RENEW_SCRIPT` or
   * `RELEASE_SCRIPT` in `core/lease.ts` left the whole suite green, because
   * the fake went on enforcing a rule the shipped Lua no longer contained.
   * Only `tests/lease.redis.test.ts` could see it, and that skips with no
   * Redis. A fake that is stricter than the thing it stands in for reports the
   * behaviour it wishes for rather than the behaviour it was handed, so the
   * clause is DETECTED here and a script without it performs the
   * unconditional write, exactly as a real Redis would run it.
   */
  async eval(script: string, numKeys: number, ...args: (string | number | Buffer)[]): Promise<unknown> {
    this.guard('eval');
    // Matched on the script TEXT, like the two lease scripts below, rather
    // than on `numKeys` alone: a fake that branches on the argument count
    // would run this branch for any future two-key script and silently give it
    // checkpoint semantics.
    if (script.includes('KEYS[2]')) {
      const [valueKey, leaseKey, body, owner, ttlS] = args;
      // The whole point of the script: an ex-owner's write must be refused by
      // the store rather than by the writer's own stale belief about the lease.
      if (script.includes("redis.call('get', KEYS[2]) == ARGV[2]") && this.live(String(leaseKey)) !== String(owner)) {
        return null;
      }
      this.hub.strings.set(String(valueKey), {
        value: Buffer.isBuffer(body) ? body : String(body),
        expiresAt: Date.now() + Number(ttlS) * 1000,
      });
      return 'OK';
    }
    const key = String(args[0]);
    const owner = String(args[numKeys]);
    const isRelease = script.includes("'del'");
    const ownerChecked = script.includes("redis.call('get', KEYS[1]) == ARGV[1]");
    if (ownerChecked && this.live(key) !== owner) return isRelease ? 0 : null;
    if (isRelease) {
      this.hub.strings.delete(key);
      return 1;
    }
    const ttlMs = Number(args[numKeys + 1]);
    this.hub.strings.set(key, { value: owner, expiresAt: Date.now() + ttlMs });
    return 'OK';
  }

  async publish(channel: string, message: string | Buffer): Promise<number> {
    this.guard('publish');
    let n = 0;
    for (const sub of this.hub.subscribers) {
      if (!sub.channels.has(channel)) continue;
      n++;
      sub.onMessage?.(channel, typeof message === 'string' ? message : message.toString('utf8'));
      sub.onMessageBuffer?.(Buffer.from(channel, 'utf8'), typeof message === 'string' ? Buffer.from(message, 'utf8') : message);
    }
    return n;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.guard('expire');
    const e = this.hub.strings.get(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.guard('hgetall');
    const h = this.hub.hashes.get(key);
    return h ? Object.fromEntries(h) : {};
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.guard('hset');
    let h = this.hub.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hub.hashes.set(key, h);
    }
    const isNew = !h.has(field);
    h.set(field, value);
    return isNew ? 1 : 0;
  }

  // Answers 1/0 like the real HEXISTS, not true/false: `checkAdmission`
  // reads the numeric reply, so a boolean fake would let a broken read pass
  // here and fail against a real Redis.
  async hexists(key: string, field: string): Promise<number> {
    this.guard('hexists');
    return this.hub.hashes.get(key)?.has(field) ? 1 : 0;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    this.guard('hdel');
    const h = this.hub.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n++;
    return n;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.guard('mget');
    return Promise.all(keys.map((k) => this.get(k)));
  }

  async zadd(key: string, score: number, member: string): Promise<unknown> {
    this.guard('zadd');
    let z = this.hub.zsets.get(key);
    if (!z) {
      z = new Map();
      this.hub.zsets.set(key, z);
    }
    z.set(member, score);
    return 1;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    this.guard('zrem');
    const z = this.hub.zsets.get(key);
    if (!z) return 0;
    let n = 0;
    for (const m of members) if (z.delete(m)) n++;
    return n;
  }

  async zcard(key: string): Promise<number> {
    this.guard('zcard');
    return this.hub.zsets.get(key)?.size ?? 0;
  }

  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    this.guard('zremrangebyscore');
    const z = this.hub.zsets.get(key);
    if (!z) return 0;
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    let n = 0;
    for (const [m, s] of z) {
      if (s >= lo && s <= hi) {
        z.delete(m);
        n++;
      }
    }
    return n;
  }

  async incrby(key: string, n: number): Promise<number> {
    this.guard('incrby');
    const cur = Number((await this.get(key)) ?? '0');
    const next = cur + n;
    const existing = this.hub.strings.get(key);
    this.hub.strings.set(key, { value: String(next), expiresAt: existing?.expiresAt ?? null });
    return next;
  }

  async hincrby(key: string, field: string, n: number): Promise<number> {
    this.guard('hincrby');
    let h = this.hub.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hub.hashes.set(key, h);
    }
    const next = Number(h.get(field) ?? '0') + n;
    h.set(field, String(next));
    return next;
  }

  // Only the sub-commands `checkAdmission` actually issues, in the
  // exact order it issues them: this is a fake built to serve tickroom's
  // own call sites, not a general pipeline emulator.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipeline(): any {
    this.guard('pipeline');
    const ops: Array<() => Promise<unknown>> = [];
    const builder = {
      get: (k: string) => {
        ops.push(() => this.get(k));
        return builder;
      },
      hgetall: (k: string) => {
        ops.push(() => this.hgetall(k));
        return builder;
      },
      hexists: (k: string, f: string) => {
        ops.push(() => this.hexists(k, f));
        return builder;
      },
      zremrangebyscore: (k: string, min: string | number, max: string | number) => {
        ops.push(() => this.zremrangebyscore(k, min, max));
        return builder;
      },
      zcard: (k: string) => {
        ops.push(() => this.zcard(k));
        return builder;
      },
      exec: async () => {
        const results: Array<[Error | null, unknown]> = [];
        for (const op of ops) {
          try {
            results.push([null, await op()]);
          } catch (err) {
            results.push([err as Error, null]);
          }
        }
        return results;
      },
    };
    return builder;
  }

  // --- subscriber surface ---

  on(ev: string, cb: Listener): void {
    if (ev === 'message') this.onMessage = cb;
    else if (ev === 'messageBuffer') this.onMessageBuffer = cb;
    // Everything else ('reconnecting', 'error', 'connect', ...) is kept but
    // never fired on its own: this fake has no connection to lose. A test
    // drives one with `emit`, which is what a real ioredis client would do
    // from inside its own retry loop.
    const existing = this.lifecycle.get(ev);
    if (existing) existing.push(cb);
    else this.lifecycle.set(ev, [cb]);
  }

  off(ev: string, cb: Listener): void {
    const existing = this.lifecycle.get(ev);
    if (!existing) return;
    const at = existing.indexOf(cb);
    if (at !== -1) existing.splice(at, 1);
  }

  /** Test hook: fire a connection-lifecycle event the way ioredis would. */
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of [...(this.lifecycle.get(ev) ?? [])]) cb(...args);
  }

  /** Test hook: how many listeners are attached for an event, so a leaked one can be caught rather than argued about. */
  listenerCount(ev: string): number {
    return this.lifecycle.get(ev)?.length ?? 0;
  }

  async subscribe(...channels: string[]): Promise<unknown> {
    for (const c of channels) this.channels.add(c);
    this.hub.subscribers.add(this);
    return channels.length;
  }

  disconnect(): void {
    this.hub.subscribers.delete(this);
  }
}

/** The two clients every host needs, both backed by one in-process store. The same pair `getRedis`/`createSubscriber` hand out, with no connection under either. */
export interface MemoryRedisHandle {
  /** The shared command client, exactly where `getRedis()` goes. */
  redis: RedisLike;
  /** A fresh subscriber on the same store, exactly where `createSubscriber` goes. Cheap: it is an object, not a socket, so the concurrent-connection ceiling that shapes `server/redis.ts` does not exist here. */
  createSubscriber(): Subscriber;
}

/**
 * ONE PROCESS, NO REDIS. Returns the command client and the subscriber
 * factory `runTicker`, `attachRelay` and `admitSocket` ask for, both backed by
 * one in-process store, so a host can stand a room up with nothing beside it:
 *
 * ```ts
 * const { redis, createSubscriber } = createMemoryRedis();
 * attachNodeRelay(wss, { redis, createSubscriber, ...opts });
 * runNodeTicker({ redis, createSubscriber, roomId, runtime });
 * ```
 *
 * WHAT IS GIVEN UP, AND IT IS EVERYTHING REDIS WAS THERE FOR. The store lives
 * in this process's heap, so:
 *
 *   - NO HORIZONTAL SCALE. A second instance of your server shares nothing
 *     with the first: two processes are two disjoint sets of rooms with the
 *     same names, publishing to buses neither can hear. There is no load
 *     balancer configuration that makes this work, because the bus is the
 *     thing that is missing.
 *   - NO SURVIVAL OF THE PROCESS. The checkpoint is written to the same heap
 *     it is protecting, so a crash, a deploy or a platform kill takes the room
 *     and its checkpoint together. On serverless that is fatal by definition:
 *     the successor invocation is a different process and would restore
 *     nothing. Do not use this on a platform that kills your function.
 *   - NO LEASE ACROSS INSTANCES. `acquireLease` still runs, still does the
 *     `SET NX PX`, and still returns the right answer, but the only competitor
 *     it can ever see is another `runTicker` in THIS process. It is a
 *     re-entrancy guard here, not a split-brain guard.
 *
 * WHICH IS EXACTLY RIGHT FOR TWO SHAPES, and wrong for every other one. A
 * SINGLE VM (or container, or Pi) running one long-lived Node process: the
 * lease and the checkpoint were already formalities there, because nothing
 * was going to kill it every few minutes, and a Redis beside it buys
 * durability the deployment does not otherwise have. And a LOCAL DEV LOOP:
 * `npm run dev` with no service to start, no port to remember and no state
 * carried between runs. The moment you want two instances, a rolling deploy
 * that keeps rooms alive, or survival of a crash, swap this line for
 * `getRedis()`/`createSubscriber` and change nothing else. That swap is the
 * whole reason `RedisLike` exists.
 *
 * NOT SHARED BETWEEN CALLS. Each call builds its own store, so two calls are
 * two disjoint Redises; a host wanting one bus for its whole process calls
 * this once, at module scope, exactly as `getRedis()` memoizes for the same
 * reason.
 */
export function createMemoryRedis(): MemoryRedisHandle {
  const redis = new MemoryRedis();
  return {
    redis,
    // `fork()`, so every subscriber shares this store and this bus. A fresh
    // `new MemoryRedis()` would be a second, empty Redis that no publish ever
    // reaches, which is the same silent failure as pointing a subscriber at
    // the wrong URL.
    createSubscriber: () => redis.fork(),
  };
}
