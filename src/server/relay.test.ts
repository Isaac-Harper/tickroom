import { describe, it, expect, vi } from 'vitest';
import { roomKeys, type ClientInput, type RoomEnvelope } from '../core/index.js';
import { FakeRedis } from './testFakeRedis.js';
import { attachRelay, checkAdmission, type RelaySocket } from './relay.js';

const NS = 'test';

/** A minimal `RelaySocket` double: records every send, and lets a test fire the handlers it registered as if the underlying transport had. */
class MockSocket implements RelaySocket {
  readyState = 1;
  sent: (string | Uint8Array | Buffer)[] = [];
  closed: number[] = [];
  terminated = 0;
  pings = 0;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string | Uint8Array | Buffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed.push(code ?? 0);
  }
  terminate(): void {
    this.terminated++;
  }
  ping(): void {
    this.pings++;
  }
  on(ev: string, cb: (...args: unknown[]) => void): void {
    const list = this.handlers.get(ev) ?? [];
    list.push(cb);
    this.handlers.set(ev, list);
  }
  fire(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(ev) ?? []) cb(...args);
  }
}

function joinEnvelopesOn(redis: FakeRedis, channel: string): RoomEnvelope[] {
  const seen: RoomEnvelope[] = [];
  const listener = redis.fork();
  listener.on('message', (ch: unknown, message: unknown) => {
    if (ch === channel && typeof message === 'string') {
      try {
        seen.push(JSON.parse(message) as RoomEnvelope);
      } catch {
        // ignore
      }
    }
  });
  void listener.subscribe(channel);
  return seen;
}

describe('checkAdmission', () => {
  it('fails open on a Redis error', async () => {
    const redis = new FakeRedis();
    redis.break('pipeline');
    const result = await checkAdmission({ redis, roomId: 'r1', pid: 'p1', subject: 'd.abc', maxPlayers: 20, namespace: NS });
    expect(result.admit).toBe(true);
  });

  it('reads capacity from stats, not from meta, even when they disagree', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);

    // Stats says full; meta hash is completely empty (would read as "0
    // players" if capacity were mistakenly derived from its size).
    await redis.set(keys.stats, JSON.stringify({ players: 20 }));
    const full = await checkAdmission({ redis, roomId: 'r1', pid: 'newcomer', subject: 'd.new', maxPlayers: 20, namespace: NS });
    expect(full).toMatchObject({ admit: false, reason: 'full' });

    // Stats says empty; meta hash has a pile of entries (would read as
    // "full" if capacity were mistakenly derived from its size instead).
    const redis2 = new FakeRedis();
    const keys2 = roomKeys('r2', NS);
    await redis2.set(keys2.stats, JSON.stringify({ players: 0 }));
    for (let i = 0; i < 25; i++) {
      await redis2.hset(keys2.meta, `ghost-${i}`, JSON.stringify({}));
    }
    const empty = await checkAdmission({ redis: redis2, roomId: 'r2', pid: 'newcomer', subject: 'd.new2', maxPlayers: 20, namespace: NS });
    expect(empty.admit).toBe(true);
  });

  it('always admits a rejoin, even at reported capacity', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    await redis.set(keys.stats, JSON.stringify({ players: 20 }));
    await redis.hset(keys.meta, 'existing-pid', JSON.stringify({ name: 'Alice' }));
    const result = await checkAdmission({ redis, roomId: 'r1', pid: 'existing-pid', subject: 'd.abc', maxPlayers: 20, namespace: NS });
    expect(result.admit).toBe(true);
  });

  it('rejects past the per-subject socket cap', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    await redis.set(keys.stats, JSON.stringify({ players: 1 }));
    const connKey = `${NS}:conns:d.abc`;
    for (let i = 0; i < 6; i++) {
      await redis.zadd(connKey, Date.now(), `conn-${i}`);
    }
    const result = await checkAdmission({
      redis,
      roomId: 'r1',
      pid: 'newcomer',
      subject: 'd.abc',
      maxPlayers: 20,
      namespace: NS,
      maxSocketsPerSubject: 6,
    });
    expect(result).toMatchObject({ admit: false, reason: 'conn-limit' });
  });

  it('prunes stale connection entries before counting', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    await redis.set(keys.stats, JSON.stringify({ players: 1 }));
    const connKey = `${NS}:conns:d.abc`;
    for (let i = 0; i < 6; i++) {
      await redis.zadd(connKey, Date.now() - 60_000, `stale-${i}`); // 60s old
    }
    const result = await checkAdmission({
      redis,
      roomId: 'r1',
      pid: 'newcomer',
      subject: 'd.abc',
      maxPlayers: 20,
      namespace: NS,
      maxSocketsPerSubject: 6,
      connStaleMs: 30_000,
    });
    expect(result.admit).toBe(true);
    expect(await redis.zcard(connKey)).toBe(0);
  });
});

describe('attachRelay', () => {
  function baseOptions(overrides: Partial<Parameters<typeof attachRelay>[0]> = {}) {
    const redis = new FakeRedis();
    const socket = new MockSocket();
    const decodeInput = vi.fn((): ClientInput[] => [{ seq: 1, data: 1 }]);
    const spawnTicker = vi.fn().mockResolvedValue(undefined);
    return {
      redis,
      socket,
      decodeInput,
      spawnTicker,
      opts: {
        socket,
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r1',
        pid: 'p1',
        namespace: NS,
        decodeInput,
        spawnTicker,
        heartbeatMs: 20,
        tickerCheckMs: 500,
        tickerCheckJitterMs: 10,
        livenessTimeoutMs: 40,
        inboundCapacity: 3,
        inboundRefillPerSecond: 0.0001, // effectively no refill within a test's lifetime
        ...overrides,
      },
    };
  }

  it('publishes the join envelope both immediately and after the subscribe ack', async () => {
    const { redis, opts } = baseOptions();
    const joins = joinEnvelopesOn(redis, roomKeys('r1', NS).in);
    const handle = attachRelay(opts);
    await new Promise((r) => setTimeout(r, 10));
    const joinCount = joins.filter((e) => e.t === 'join').length;
    expect(joinCount).toBeGreaterThanOrEqual(2);
    handle.close();
  });

  it('rate limits inbound messages past the sustained cap', async () => {
    const { redis, socket, decodeInput, opts } = baseOptions();
    const inEnvelopes: RoomEnvelope[] = [];
    const listener = redis.fork();
    const keys = roomKeys('r1', NS);
    listener.on('message', (ch: unknown, message: unknown) => {
      if (ch === keys.in && typeof message === 'string') {
        const env = JSON.parse(message) as RoomEnvelope;
        if (env.t === 'in') inEnvelopes.push(env);
      }
    });
    await listener.subscribe(keys.in);

    const handle = attachRelay(opts);
    await new Promise((r) => setTimeout(r, 5)); // let the initial join settle first

    for (let i = 0; i < 10; i++) {
      socket.fire('message', new ArrayBuffer(0), false);
    }

    // capacity 3, effectively no refill: exactly 3 of the 10 bursts get through
    expect(inEnvelopes.length).toBe(3);
    expect(decodeInput).toHaveBeenCalledTimes(3);
    handle.close();
  });

  it('terminates a socket that goes completely silent past the liveness deadline', async () => {
    const { socket, opts } = baseOptions();
    const handle = attachRelay(opts);
    await new Promise((r) => setTimeout(r, 80)); // several heartbeats past livenessTimeoutMs (40ms)
    expect(socket.terminated).toBeGreaterThan(0);
    handle.close();
  });

  it('does NOT terminate a socket that only ever sends pongs', async () => {
    const { socket, opts } = baseOptions();
    const handle = attachRelay(opts);
    // Answer every heartbeat's ping with a pong, exactly like a healthy
    // (possibly backgrounded) client's network stack would.
    const pongInterval = setInterval(() => socket.fire('pong'), 10);
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(pongInterval);
    expect(socket.terminated).toBe(0);
    handle.close();
  });

  it('an inbound frame refreshes liveness even when the rate limiter drops it', async () => {
    const { socket, opts } = baseOptions({ inboundCapacity: 0, inboundRefillPerSecond: 0 });
    const handle = attachRelay(opts);
    const pump = setInterval(() => socket.fire('message', new ArrayBuffer(0), false), 10);
    await new Promise((r) => setTimeout(r, 80)); // past livenessTimeoutMs, but traffic never stopped
    clearInterval(pump);
    expect(socket.terminated).toBe(0);
    handle.close();
  });

  it('cleanup is idempotent: closing twice publishes leave once and never throws', async () => {
    const { redis, opts } = baseOptions();
    const keys = roomKeys('r1', NS);
    const leaves: RoomEnvelope[] = [];
    const listener = redis.fork();
    listener.on('message', (ch: unknown, message: unknown) => {
      if (ch === keys.in && typeof message === 'string') {
        const env = JSON.parse(message) as RoomEnvelope;
        if (env.t === 'leave') leaves.push(env);
      }
    });
    await listener.subscribe(keys.in);

    const handle = attachRelay(opts);
    await new Promise((r) => setTimeout(r, 5));
    expect(() => handle.close()).not.toThrow();
    expect(() => handle.close()).not.toThrow();
    expect(leaves.length).toBe(1);
  });

  it('cleanup also runs when the socket itself fires close', async () => {
    const { redis, socket, opts } = baseOptions();
    const keys = roomKeys('r1', NS);
    const leaves: RoomEnvelope[] = [];
    const listener = redis.fork();
    listener.on('message', (ch: unknown, message: unknown) => {
      if (ch === keys.in && typeof message === 'string') {
        const env = JSON.parse(message) as RoomEnvelope;
        if (env.t === 'leave') leaves.push(env);
      }
    });
    await listener.subscribe(keys.in);

    const onClose = vi.fn();
    attachRelay({ ...opts, onClose });
    await new Promise((r) => setTimeout(r, 5));
    socket.fire('close', 1001);
    expect(leaves.length).toBe(1);
    expect(onClose).toHaveBeenCalledWith(1001);
  });
});
