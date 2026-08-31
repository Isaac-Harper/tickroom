// A small in-memory Redis stand-in shared by this directory's test files.
// Not a `*.test.ts` file itself (vitest's include glob only picks up
// `src/**/*.test.ts`), so it never runs as a suite of its own; it exists
// purely so `ticker.test.ts`, `relay.test.ts`, and `balancer.test.ts` are
// not each carrying their own copy of the same ~150 lines.
//
// It implements exactly the `RedisLike` surface plus the pub/sub extras
// `Subscriber` adds, against three plain Maps (strings, hashes, sorted
// sets) shared through a `Hub` so that two `FakeRedis` instances created
// from the same hub behave the way a real command connection and a real
// subscriber connection sharing one logical Redis database do.

import type { RedisLike } from '../core/index.js';

class Hub {
  strings = new Map<string, { value: string | Buffer; expiresAt: number | null }>();
  hashes = new Map<string, Map<string, string>>();
  zsets = new Map<string, Map<string, number>>();
  subscribers = new Set<FakeRedis>();
}

type Listener = (...args: unknown[]) => void;

export class FakeRedis implements RedisLike {
  private readonly hub: Hub;
  private readonly channels = new Set<string>();
  private onMessage: Listener | null = null;
  private onMessageBuffer: Listener | null = null;
  private readonly broken = new Set<string>();

  constructor(hub?: Hub) {
    this.hub = hub ?? new Hub();
  }

  /** A second client sharing this instance's store and pub/sub bus, standing in for a dedicated subscriber connection to the "same" Redis. */
  fork(): FakeRedis {
    return new FakeRedis(this.hub);
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
   * Distinguishes the two real scripts `core/lease.ts` uses by a substring
   * of the script text (the RELEASE script calls `redis.call('del', ...)`,
   * the RENEW script never does), since this fake has no real Lua
   * interpreter. This is a test-only heuristic against the two specific
   * scripts `lease.ts` is known to send, not a general `eval` implementation.
   */
  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.guard('eval');
    const key = String(args[0]);
    const owner = String(args[numKeys]);
    const isRelease = script.includes("'del'");
    if (this.live(key) !== owner) return isRelease ? 0 : null;
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
    // other events ('error', 'connect', ...) are not exercised by this fake
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
