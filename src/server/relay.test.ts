import { describe, it, expect, vi } from 'vitest';
import {
  roomKeys,
  PING_INTERVAL_MS,
  encodePing,
  encodePong,
  CLOSE_CODES,
  SERVER_FRAMES,
  ROOM_REJECT_FRAME,
  RELAY_EXPIRY_LEAD_MS,
  JOIN_HEARTBEAT_MS,
  type ClientInput,
  type RoomEnvelope,
} from '../core/index.js';
import { FakeRedis } from './testFakeRedis.js';
import { attachRelay, checkAdmission, DEFAULT_LIVENESS_TIMEOUT_MS, type RelaySocket } from './relay.js';

const NS = 'test';

/** A minimal `RelaySocket` double: records every send, and lets a test fire the handlers it registered as if the underlying transport had. */
class MockSocket implements RelaySocket {
  readyState = 1;
  /** Whatever a test wants the transport to claim is queued but unwritten; a real ws/browser socket reports it for free. */
  bufferedAmount = 0;
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

  // TR-17. The socket cap is keyed on a durable subject, so it is the one
  // key in this library an adopting host most likely already writes AND
  // enumerates elsewhere (a data-deletion path naming every key that holds
  // a subject's data). Aiming the cap at the wrong key fails silently in
  // both directions, so both directions are asserted here rather than only
  // the happy one.
  describe('connNamespace', () => {
    it('defaults to the room namespace, byte for byte', async () => {
      const redis = new FakeRedis();
      const withNs = await checkAdmission({ redis, roomId: 'r1', pid: 'p1', subject: 'd.abc', maxPlayers: 20, namespace: NS });
      expect(withNs.connKey).toBe(`${NS}:conns:d.abc`);

      const noNs = await checkAdmission({ redis, roomId: 'r1', pid: 'p1', subject: 'd.abc', maxPlayers: 20 });
      expect(noNs.connKey).toBe('room:conns:d.abc'); // DEFAULT_NAMESPACE
    });

    it('counts the key it is aimed at, and NOT the room-namespaced one', async () => {
      const redis = new FakeRedis();
      const keys = roomKeys('r1', NS);
      await redis.set(keys.stats, JSON.stringify({ players: 1 }));

      // Six live sockets recorded under a DIFFERENT prefix, standing in for
      // a registry the host already had before adopting this library.
      for (let i = 0; i < 6; i++) {
        await redis.zadd('legacy:conns:d.abc', Date.now(), `conn-${i}`);
      }
      const base = { redis, roomId: 'r1', pid: 'newcomer', subject: 'd.abc', maxPlayers: 20, namespace: NS, maxSocketsPerSubject: 6 };

      // Aimed at the host's key: the cap sees all six and refuses.
      const aimed = await checkAdmission({ ...base, connNamespace: 'legacy' });
      expect(aimed).toMatchObject({ admit: false, reason: 'conn-limit', connKey: 'legacy:conns:d.abc' });

      // Not aimed at it: the room-namespaced key is empty, so the cap counts
      // nothing and admits. This is the SILENT failure the option exists to
      // prevent, and asserting it is what proves the case above is really
      // reading the aimed key rather than passing for some other reason.
      const unaimed = await checkAdmission(base);
      expect(unaimed).toMatchObject({ admit: true, connKey: `${NS}:conns:d.abc` });
    });

    it('ignores the room-namespaced key entirely once aimed elsewhere', async () => {
      // The mirror of the case above: the entries live under the room
      // namespace and the cap is pointed away from them, so it must admit.
      // Together the two rule out a `connNamespace` that is read but then
      // ORed with the old key, which would look correct in one direction.
      const redis = new FakeRedis();
      const keys = roomKeys('r1', NS);
      await redis.set(keys.stats, JSON.stringify({ players: 1 }));
      for (let i = 0; i < 6; i++) {
        await redis.zadd(`${NS}:conns:d.abc`, Date.now(), `conn-${i}`);
      }
      const result = await checkAdmission({
        redis,
        roomId: 'r1',
        pid: 'newcomer',
        subject: 'd.abc',
        maxPlayers: 20,
        namespace: NS,
        connNamespace: 'legacy',
        maxSocketsPerSubject: 6,
      });
      expect(result.admit).toBe(true);
    });

    it('an empty connNamespace produces a BARE conns:{subject} with no separator', async () => {
      // The shape a pre-existing deployment is most likely to have, and the
      // reason `''` is meaningful rather than merely falsy: `${''}:conns:x`
      // would be `:conns:x`, a third key belonging to nobody.
      const redis = new FakeRedis();
      const keys = roomKeys('r1', NS);
      await redis.set(keys.stats, JSON.stringify({ players: 1 }));
      for (let i = 0; i < 6; i++) {
        await redis.zadd('conns:d.abc', Date.now(), `conn-${i}`);
      }
      const result = await checkAdmission({
        redis,
        roomId: 'r1',
        pid: 'newcomer',
        subject: 'd.abc',
        maxPlayers: 20,
        namespace: NS,
        connNamespace: '',
        maxSocketsPerSubject: 6,
      });
      expect(result).toMatchObject({ admit: false, reason: 'conn-limit', connKey: 'conns:d.abc' });
    });

    it('prunes on the aimed key, not on the room-namespaced one', async () => {
      // The stale-entry sweep is a WRITE, so a misaimed key does not merely
      // miscount, it lets the real registry grow unbounded while trimming a
      // key nobody uses.
      const redis = new FakeRedis();
      const keys = roomKeys('r1', NS);
      await redis.set(keys.stats, JSON.stringify({ players: 1 }));
      await redis.zadd('conns:d.abc', Date.now() - 60_000, 'stale');
      await redis.zadd(`${NS}:conns:d.abc`, Date.now() - 60_000, 'stale');
      await checkAdmission({
        redis,
        roomId: 'r1',
        pid: 'p1',
        subject: 'd.abc',
        maxPlayers: 20,
        namespace: NS,
        connNamespace: '',
        connStaleMs: 30_000,
      });
      expect(await redis.zcard('conns:d.abc')).toBe(0);
      expect(await redis.zcard(`${NS}:conns:d.abc`)).toBe(1); // untouched
    });
  });

  // THE PER-COMMAND ERRORS, WHICH USED TO BE DISCARDED. A pipeline resolves
  // with a [error, reply] pair per command and does NOT reject when one of
  // them fails, so a broken ZCARD arrived as `undefined`, slid past the
  // `typeof === 'number'` check, and turned the per-user socket cap off for
  // that admission with nothing said anywhere. The posture stays fail-OPEN
  // (refusing during a Redis blip locks users out of a healthy deployment);
  // what changed is that the caller is now told.
  describe('the socket cap fails open OBSERVABLY, never silently', () => {
    async function overSubscribedRedis(): Promise<FakeRedis> {
      const redis = new FakeRedis();
      const keys = roomKeys('r1', NS);
      await redis.set(keys.stats, JSON.stringify({ players: 1 }));
      for (let i = 0; i < 6; i++) {
        await redis.zadd(`${NS}:conns:d.abc`, Date.now(), `conn-${i}`);
      }
      return redis;
    }

    const admissionFor = (redis: FakeRedis) =>
      checkAdmission({
        redis,
        roomId: 'r1',
        pid: 'newcomer',
        subject: 'd.abc',
        maxPlayers: 20,
        namespace: NS,
        maxSocketsPerSubject: 6,
      });

    it('CONTROL: with the pipeline healthy the cap refuses and reports itself evaluated', async () => {
      // Without this the two cases below would pass just as well against a
      // function that never enforces the cap at all.
      const result = await admissionFor(await overSubscribedRedis());
      expect(result).toMatchObject({ admit: false, reason: 'conn-limit', socketCapEvaluated: true });
    });

    it('a broken ZCARD admits (never a lockout) and says the cap was NOT evaluated', async () => {
      const redis = await overSubscribedRedis();
      redis.break('zcard');
      const result = await admissionFor(redis);
      expect(result.admit).toBe(true);
      expect(result.socketCapEvaluated).toBe(false);
    });

    it('a broken stale-entry prune counts too, because the count it leaves behind reads HIGH', async () => {
      // The prune is what removes members belonging to sockets that are long
      // gone. Skip it and the count over-reports, which errs toward refusing
      // a legitimate reconnect: a decision made on data known to be stale in
      // the refusing direction is not one this function will make.
      const redis = await overSubscribedRedis();
      redis.break('zremrangebyscore');
      const result = await admissionFor(redis);
      expect(result.admit).toBe(true);
      expect(result.socketCapEvaluated).toBe(false);
    });

    it('a whole-pipeline failure reports it too, not only a single broken command', async () => {
      const redis = await overSubscribedRedis();
      redis.break('pipeline');
      const result = await admissionFor(redis);
      expect(result).toMatchObject({ admit: true, socketCapEvaluated: false });
    });

    it('a room-full refusal still carries an honest cap reading', async () => {
      // `full` is decided before the cap is consulted, so the field has to
      // describe what the pipeline actually managed rather than defaulting.
      const redis = new FakeRedis();
      await redis.set(roomKeys('r1', NS).stats, JSON.stringify({ players: 20 }));
      const result = await checkAdmission({
        redis,
        roomId: 'r1',
        pid: 'newcomer',
        subject: 'd.abc',
        maxPlayers: 20,
        namespace: NS,
      });
      expect(result).toMatchObject({ admit: false, reason: 'full', socketCapEvaluated: true });
    });
  });

  // TR-17, the other half: the rejoin probe is `hexists`, not `hgetall`.
  it('a pid naming an inherited object property is not mistaken for a rejoin', async () => {
    // The `hgetall` version answered this from a plain JS object, where a
    // bare `pid in map` matches `constructor`, `__proto__` and `toString`,
    // and a crafted pid would have been admitted past a full room. Asking
    // Redis removes the prototype chain from the question entirely; this
    // pins that it stayed removed.
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    await redis.set(keys.stats, JSON.stringify({ players: 20 }));
    for (const pid of ['constructor', '__proto__', 'toString']) {
      const result = await checkAdmission({ redis, roomId: 'r1', pid, subject: 'd.abc', maxPlayers: 20, namespace: NS });
      expect(result).toMatchObject({ admit: false, reason: 'full' });
    }
  });

  it('recognises a real rejoin through the hexists probe without reading the roster', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    await redis.set(keys.stats, JSON.stringify({ players: 20 }));
    await redis.hset(keys.meta, 'existing-pid', JSON.stringify({ name: 'Alice' }));
    // `hgetall` is BROKEN for this test, so the probe cannot silently fall
    // back to pulling the whole roster: the cheap path is the only path.
    redis.break('hgetall');
    const result = await checkAdmission({ redis, roomId: 'r1', pid: 'existing-pid', subject: 'd.abc', maxPlayers: 20, namespace: NS });
    expect(result.admit).toBe(true);

    // ...and a stranger at the same capacity is still refused, so the case
    // above is not passing merely because the whole check fell open.
    const stranger = await checkAdmission({ redis, roomId: 'r1', pid: 'stranger', subject: 'd.xyz', maxPlayers: 20, namespace: NS });
    expect(stranger).toMatchObject({ admit: false, reason: 'full' });
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

  // The relay's join cadence and the ticker's `presenceTimeoutMs` are one
  // constant seen from two sides, and this is the side that ships a default.
  // Pinned on the ARMED INTERVAL rather than on an exported number, because
  // what the ticker's sweep is sized against is the cadence a relay with no
  // `heartbeatMs` actually runs at.
  it('heartbeats at JOIN_HEARTBEAT_MS when the host names no cadence', async () => {
    const { heartbeatMs: _shipped, ...defaulted } = baseOptions().opts;
    const armed = vi.spyOn(globalThis, 'setInterval');
    const handle = attachRelay(defaulted);
    await new Promise((r) => setTimeout(r, 10));
    const delays = armed.mock.calls.map((call) => call[1]);
    armed.mockRestore();
    handle.close();
    expect(delays).toContain(JOIN_HEARTBEAT_MS);
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

  it('onLivenessDrop fires alongside every termination, and not before the deadline', async () => {
    const onLivenessDrop = vi.fn();
    const { socket, opts } = baseOptions({ onLivenessDrop });
    const handle = attachRelay(opts);
    await new Promise((r) => setTimeout(r, 80)); // several heartbeats past livenessTimeoutMs (40ms)
    // The MockSocket's terminate() does not fire a 'close' event, and a
    // real ws socket that has already closed does not either, which is why
    // the relay now runs its own cleanup right after terminating. The two
    // counters must still move together, whether that is once or many times.
    expect(socket.terminated).toBeGreaterThan(0);
    expect(onLivenessDrop.mock.calls.length).toBe(socket.terminated);
    handle.close();
  });

  it('does NOT fire onLivenessDrop for a socket that stays live', async () => {
    const onLivenessDrop = vi.fn();
    const { socket, opts } = baseOptions({ onLivenessDrop });
    const handle = attachRelay(opts);
    const pongInterval = setInterval(() => socket.fire('pong'), 10);
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(pongInterval);
    expect(socket.terminated).toBe(0);
    expect(onLivenessDrop).not.toHaveBeenCalled();
    handle.close();
  });

  it('a throwing onLivenessDrop hook cannot stop the socket from being terminated', async () => {
    const onLivenessDrop = vi.fn(() => {
      throw new Error('host counter blew up');
    });
    const { socket, opts } = baseOptions({ onLivenessDrop });
    const handle = attachRelay(opts);
    await new Promise((r) => setTimeout(r, 80));
    expect(socket.terminated).toBeGreaterThan(0);
    expect(onLivenessDrop.mock.calls.length).toBeGreaterThan(0);
    expect(() => handle.close()).not.toThrow();
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

  // TR-6. Both events happen on paths the host cannot otherwise observe:
  // the bucket rejects BEFORE `decodeInput` runs, and a decoder throw is
  // swallowed by a bare catch. Neither may be logged per message, so a
  // synchronous hook is the only seam that respects the invariant.
  describe('observability hooks', () => {
    it('onRateDrop fires exactly for the frames the bucket rejects', async () => {
      const onRateDrop = vi.fn();
      const { socket, decodeInput, opts } = baseOptions({ onRateDrop }); // capacity 3, no refill
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 5));

      for (let i = 0; i < 10; i++) socket.fire('message', new ArrayBuffer(0), false);

      expect(onRateDrop).toHaveBeenCalledTimes(7); // 10 sent, 3 admitted
      expect(decodeInput).toHaveBeenCalledTimes(3); // the drop really does precede any decode work
      handle.close();
    });

    it('onBadInput fires when the decoder throws', async () => {
      const onBadInput = vi.fn();
      const decodeInput = vi.fn((): ClientInput[] => {
        throw new Error('truncated frame');
      });
      const { redis, socket, opts } = baseOptions({ onBadInput, decodeInput, inboundCapacity: 100 });
      const keys = roomKeys('r1', NS);
      const ins: RoomEnvelope[] = [];
      const listener = redis.fork();
      listener.on('message', (ch: unknown, m: unknown) => {
        if (ch === keys.in && typeof m === 'string') {
          const env = JSON.parse(m) as RoomEnvelope;
          if (env.t === 'in') ins.push(env);
        }
      });
      await listener.subscribe(keys.in);

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 4; i++) socket.fire('message', new ArrayBuffer(0), false);

      expect(onBadInput).toHaveBeenCalledTimes(4);
      expect(ins.length).toBe(0); // a throwing decode still publishes nothing
      handle.close();
    });

    it('onBadInput does NOT fire for a decoder that legitimately returns an empty window', async () => {
      // The distinction matters: a decoder returning `[]` for a frame with
      // no applicable records is ordinary traffic, and counting it as
      // malformed would bury the real abuse signal under it.
      const onBadInput = vi.fn();
      const decodeInput = vi.fn((): ClientInput[] => []);
      const { socket, opts } = baseOptions({ onBadInput, decodeInput, inboundCapacity: 100 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 4; i++) socket.fire('message', new ArrayBuffer(0), false);

      expect(decodeInput).toHaveBeenCalledTimes(4);
      expect(onBadInput).not.toHaveBeenCalled();
      handle.close();
    });

    it('a hook that throws cannot take the socket down', async () => {
      // These run on a client-driven path, so a host bug inside one must
      // never become the client's problem, and it cannot be reported either.
      const onRateDrop = vi.fn(() => {
        throw new Error('host counter blew up');
      });
      const { redis, socket, opts } = baseOptions({ onRateDrop, inboundCapacity: 1 });
      const keys = roomKeys('r1', NS);
      const ins: RoomEnvelope[] = [];
      const listener = redis.fork();
      listener.on('message', (ch: unknown, m: unknown) => {
        if (ch === keys.in && typeof m === 'string') {
          const env = JSON.parse(m) as RoomEnvelope;
          if (env.t === 'in') ins.push(env);
        }
      });
      await listener.subscribe(keys.in);

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 5; i++) {
        expect(() => socket.fire('message', new ArrayBuffer(0), false)).not.toThrow();
      }
      expect(ins.length).toBe(1); // the one frame the bucket admitted still went through
      expect(onRateDrop).toHaveBeenCalledTimes(4);
      expect(() => handle.close()).not.toThrow();
    });
  });

  // The bucket's defaults are sized against the client's real pacing, not
  // just against a flood: the shipped stamped client (`PredictedEntity`, and
  // the pong example before it) sends ONE packet per stamped tick, so a room
  // ticking up to 60Hz (the fastest rate this library documents as
  // reasonable) sends up to 60 packets/s of ordinary traffic, and that has
  // to fit with headroom. These exercise `attachRelay`'s OWN defaults, so
  // `inboundCapacity`/`inboundRefillPerSecond` are explicitly undefined
  // rather than left to `baseOptions`' test-friendly (capacity 3, no refill)
  // ones.
  describe('the inbound rate limit fits the client\'s real cadence under the defaults', () => {
    /** Fires a `message` at a steady rate on the virtual clock, for a test running under `vi.useFakeTimers()`. */
    async function sendAtRate(socket: MockSocket, ratePerSecond: number, durationMs: number): Promise<void> {
      const stepMs = 1000 / ratePerSecond;
      const ticks = Math.round(durationMs / stepMs);
      for (let i = 0; i < ticks; i++) {
        await vi.advanceTimersByTimeAsync(stepMs);
        socket.fire('message', new ArrayBuffer(0), false);
      }
    }

    it('a steady 60 packets/s sender (the fastest documented tick rate) is never rate-dropped over 5 seconds', async () => {
      vi.useFakeTimers();
      try {
        const onRateDrop = vi.fn();
        const { socket, opts } = baseOptions({
          onRateDrop,
          livenessTimeoutMs: 10_000,
          inboundCapacity: undefined,
          inboundRefillPerSecond: undefined,
        });
        const handle = attachRelay(opts);
        await vi.advanceTimersByTimeAsync(5);

        await sendAtRate(socket, 60, 5000);

        expect(onRateDrop).not.toHaveBeenCalled();
        handle.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a steady 20 packets/s sender is never rate-dropped over 5 seconds', async () => {
      vi.useFakeTimers();
      try {
        const onRateDrop = vi.fn();
        const { socket, opts } = baseOptions({
          onRateDrop,
          livenessTimeoutMs: 10_000,
          inboundCapacity: undefined,
          inboundRefillPerSecond: undefined,
        });
        const handle = attachRelay(opts);
        await vi.advanceTimersByTimeAsync(5);

        await sendAtRate(socket, 20, 5000);

        expect(onRateDrop).not.toHaveBeenCalled();
        handle.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a 500 packets/s flood is dropped within 2 seconds, and onRateDrop counts it', async () => {
      vi.useFakeTimers();
      try {
        const onRateDrop = vi.fn();
        const { socket, opts } = baseOptions({
          onRateDrop,
          livenessTimeoutMs: 10_000,
          inboundCapacity: undefined,
          inboundRefillPerSecond: undefined,
        });
        const handle = attachRelay(opts);
        await vi.advanceTimersByTimeAsync(5);

        await sendAtRate(socket, 500, 2000);

        expect(onRateDrop.mock.calls.length).toBeGreaterThan(0);
        handle.close();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // TR-6, second half. The old code logged `relay.publish-failed` once per
  // FRAME, on a path whose rate the client chooses, which is the exact
  // amplifier the library's own invariant forbids.
  describe('publish failures are counted and coalesced, never logged per frame', () => {
    // Fails ONLY the input publish, not the join heartbeat. `break('publish')`
    // would fail both, and since the join republishes every beat it would
    // keep refilling the counter, so "the next beat is silent" could never be
    // asserted and the line count would scale with however many beats a
    // loaded machine fitted into the wait. That made an earlier version of
    // the second test below flake on exactly the thing it was measuring.
    function failInputPublishes(redis: FakeRedis): void {
      const original = redis.publish.bind(redis);
      redis.publish = async (channel: string, message: string | Buffer): Promise<number> => {
        if (typeof message === 'string' && message.includes('"t":"in"')) throw new Error('publish refused');
        return original(channel, message);
      };
    }

    it('a burst of failing publishes logs nothing until a cadence the client cannot drive', async () => {
      const log = vi.fn();
      const onPublishFailed = vi.fn();
      // A heartbeat far longer than the test, so the only flush that can
      // happen is the deliberate one on close.
      const { redis, socket, opts } = baseOptions({
        log,
        onPublishFailed,
        heartbeatMs: 10_000,
        livenessTimeoutMs: 10_000,
        inboundCapacity: 100,
        inboundRefillPerSecond: 100,
      });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 5));

      failInputPublishes(redis);
      for (let i = 0; i < 20; i++) socket.fire('message', new ArrayBuffer(0), false);
      await new Promise((r) => setTimeout(r, 5)); // let the rejections settle

      expect(onPublishFailed).toHaveBeenCalledTimes(20); // every one seen by the host
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.publish-failed')).toHaveLength(0);

      // The tail flush on close is what stops a socket that dies mid-outage
      // from losing the window an operator most wants.
      handle.close();
      const lines = log.mock.calls.filter((c) => c[0]?.kind === 'relay.publish-failed');
      expect(lines).toHaveLength(1);
      expect(lines[0][0].meta.count).toBe(20);
      expect(String(lines[0][0].meta.error)).toContain('publish refused');
    });

    it('the heartbeat flushes the count once, and resets it so every later beat is silent', async () => {
      const log = vi.fn();
      const { redis, socket, opts } = baseOptions({
        log,
        heartbeatMs: 20,
        livenessTimeoutMs: 10_000,
        inboundCapacity: 100,
        inboundRefillPerSecond: 100,
      });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 5));

      failInputPublishes(redis);
      for (let i = 0; i < 30; i++) socket.fire('message', new ArrayBuffer(0), false);

      // Long enough for several beats. Only the first can have anything to
      // say, so the assertion does not depend on how many actually fired,
      // which is what makes it robust on a loaded machine.
      await new Promise((r) => setTimeout(r, 120));

      const lines = log.mock.calls.filter((c) => c[0]?.kind === 'relay.publish-failed');
      expect(lines).toHaveLength(1);
      expect(lines[0][0].meta.count).toBe(30);
      handle.close();
      // The tail flush had nothing left to report either.
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.publish-failed')).toHaveLength(1);
    });
  });

  // TR-4. The seed frame is a client-visible wire shape with no version
  // byte, so a host adopting this library cannot force already-loaded
  // bundles onto a new one.
  describe('metaSeedPayload', () => {
    // Returns BOTH the parsed frames and the raw `send` arguments. Reading
    // only the parsed side made an earlier version of the suppression test
    // vacuous: `socket.send(undefined)` filters out of a string-only view,
    // so removing the guard looked identical to honouring it.
    async function seedRun(overrides: Partial<Parameters<typeof attachRelay>[0]> = {}) {
      const { redis, socket, opts } = baseOptions(overrides);
      const keys = roomKeys('r1', NS);
      await redis.hset(keys.meta, 'p2', JSON.stringify({ name: 'Alice' }));
      const handle = attachRelay({ ...opts, redis, socket });
      await new Promise((r) => setTimeout(r, 10));
      handle.close();
      // Nothing publishes on `keys.out`/`keys.metaout` in these runs, so
      // every send the socket saw is a roster seed.
      const raw = socket.sent;
      const frames = raw.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s) as Record<string, unknown>);
      return { raw, frames };
    }

    it('defaults to the shipped { t: meta, seed: true, map } shape', async () => {
      const { frames } = await seedRun();
      const metas = frames.filter((f) => f.t === 'meta');
      expect(metas.length).toBeGreaterThan(0);
      for (const m of metas) {
        expect(m.seed).toBe(true);
        expect(m.map).toEqual({ p2: { name: 'Alice' } });
      }
    });

    it('lets a host keep a differently shaped roster frame', async () => {
      // Standing in for a host whose shipped client parses
      // `{ t:'meta', players:[...] }` and SILENTLY early-returns on
      // anything else, blanking every name with no error to see.
      const { frames } = await seedRun({
        metaSeedPayload: (map) => ({
          t: 'meta',
          players: Object.entries(map).map(([pid, v]) => ({ pid, ...(v as Record<string, unknown>) })),
        }),
      });
      const metas = frames.filter((f) => f.t === 'meta');
      expect(metas.length).toBeGreaterThan(0);
      for (const m of metas) {
        expect(m.players).toEqual([{ pid: 'p2', name: 'Alice' }]);
        expect(m).not.toHaveProperty('map');
        expect(m).not.toHaveProperty('seed');
      }
    });

    it('a formatter returning undefined suppresses the frame instead of sending "undefined"', async () => {
      // Asserted on the RAW sends, not on parsed frames: `JSON.stringify`
      // returns undefined here despite its declared `string` type, and the
      // failure this pins is `socket.send(undefined)` reaching the
      // transport, which a string-only view cannot see.
      const { raw } = await seedRun({ metaSeedPayload: () => undefined });
      expect(raw).toHaveLength(0);
    });

    it('a formatter that throws is reported as a seed failure and never reaches the socket', async () => {
      // This path runs at most twice per socket, so unlike the inbound
      // publish it is NOT client-rate and a real log line is affordable.
      const log = vi.fn();
      const { raw } = await seedRun({
        log,
        metaSeedPayload: () => {
          throw new Error('bad formatter');
        },
      });
      expect(raw).toHaveLength(0);
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.meta-seed-failed').length).toBeGreaterThan(0);
    });
  });

  // B1. A pid names a PLAYER, not a socket, and the two overlap by design:
  // a reconnect (and the planned swap at `lifetimeMs`) puts a new socket in
  // the room while the old relay is still tearing down. The `c` is what lets
  // the ticker tell the two apart.
  describe('the connection id on the join and leave envelopes', () => {
    async function envelopesFrom(overrides: Partial<Parameters<typeof attachRelay>[0]> = {}) {
      const { redis, socket, opts } = baseOptions({ inboundCapacity: 100, ...overrides });
      const seen = joinEnvelopesOn(redis, roomKeys('r1', NS).in);
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.fire('message', new ArrayBuffer(0), false);
      await new Promise((r) => setTimeout(r, 5));
      handle.close();
      await new Promise((r) => setTimeout(r, 5));
      return seen;
    }

    it('stamps the same connection id on the join and on the leave', async () => {
      const seen = await envelopesFrom();
      const join = seen.find((e) => e.t === 'join') as { c?: string } | undefined;
      const leave = seen.find((e) => e.t === 'leave') as { c?: string } | undefined;
      expect(typeof join?.c).toBe('string');
      expect(join?.c).not.toBe('');
      expect(leave?.c).toBe(join?.c);
    });

    it('gives two relays for the SAME pid different connection ids', async () => {
      // The whole point: without this the ticker cannot tell a stale relay's
      // leave from the live one's, and the stale one wins by arriving last.
      const first = await envelopesFrom();
      const second = await envelopesFrom();
      const c1 = (first.find((e) => e.t === 'join') as { c?: string } | undefined)?.c;
      const c2 = (second.find((e) => e.t === 'join') as { c?: string } | undefined)?.c;
      expect(c1).toBeTruthy();
      expect(c2).toBeTruthy();
      expect(c1).not.toBe(c2);
    });

    it('no longer stamps a wall-clock timestamp on an input envelope', async () => {
      // The field was read by nothing and is not on `RoomEnvelope` any more.
      const seen = await envelopesFrom();
      const input = seen.find((e) => e.t === 'in');
      expect(input).toBeDefined();
      expect(input).not.toHaveProperty('ts');
    });
  });

  // B2. `attachRelay` used to assume the socket handed to it was OPEN. It is
  // reached through an AWAITED admission check, so both of the other live
  // states are ordinary rather than exotic.
  describe('the socket state at attach', () => {
    it('a socket already CLOSED runs cleanup at once, subscribes nothing and publishes nothing', async () => {
      // Measured against real ws: the 'close' event of a socket that died
      // during the admission round trip has already fired and gone, and
      // `terminate()` on a CLOSED socket emits nothing, so there is no later
      // event to clean up on. The join heartbeated forever, the subscriber
      // leaked, the per-subject cap slot stayed held, and the liveness check
      // logged an error line per second for the rest of the invocation.
      const { redis, socket, spawnTicker, opts } = baseOptions();
      const seen = joinEnvelopesOn(redis, roomKeys('r1', NS).in);
      const onClose = vi.fn();
      let subscribers = 0;
      socket.readyState = 3;

      const handle = attachRelay({
        ...opts,
        onClose,
        createSubscriber: () => {
          subscribers++;
          return redis.fork();
        },
      });
      await new Promise((r) => setTimeout(r, 60)); // several heartbeats' worth, had one been running

      expect(subscribers).toBe(0);
      expect(seen).toHaveLength(0); // no join, and no leave for a join that never happened
      expect(spawnTicker).not.toHaveBeenCalled();
      expect(socket.pings).toBe(0);
      expect(socket.sent).toHaveLength(0);
      expect(onClose).toHaveBeenCalledWith(1006);
      expect(() => handle.close()).not.toThrow();
    });

    it('a socket still CLOSING is treated the same way', async () => {
      const { redis, socket, opts } = baseOptions();
      const seen = joinEnvelopesOn(redis, roomKeys('r1', NS).in);
      const onClose = vi.fn();
      socket.readyState = 2;
      attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 30));
      expect(seen).toHaveLength(0);
      expect(onClose).toHaveBeenCalledWith(1006);
    });

    it('a socket still CONNECTING defers the join, the seed and the ticker check until it opens', async () => {
      const { redis, socket, spawnTicker, opts } = baseOptions({ livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      await redis.hset(keys.meta, 'p2', JSON.stringify({ name: 'Alice' }));
      const seen = joinEnvelopesOn(redis, keys.in);
      socket.readyState = 0;

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.filter((e) => e.t === 'join')).toHaveLength(0);
      expect(socket.sent).toHaveLength(0); // `ws` THROWS on a send in this state
      expect(spawnTicker).not.toHaveBeenCalled();

      socket.readyState = 1;
      socket.fire('open');
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.filter((e) => e.t === 'join').length).toBeGreaterThan(0);
      expect(socket.sent.length).toBeGreaterThan(0);
      expect(spawnTicker).toHaveBeenCalled();
      handle.close();
    });

    it('a snapshot arriving before OPEN is dropped and counted, never sent', async () => {
      const log = vi.fn();
      const { redis, socket, opts } = baseOptions({ log, livenessTimeoutMs: 10_000, heartbeatMs: 20 });
      const keys = roomKeys('r1', NS);
      socket.readyState = 0;

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10)); // the subscribe still goes out immediately
      await redis.publish(keys.out, Buffer.from([1, 2, 3]));
      expect(socket.sent).toHaveLength(0);

      socket.readyState = 1;
      socket.fire('open');
      // Long enough for several beats. Only the first can have anything to
      // say, so the assertion does not depend on how many actually fired.
      await new Promise((r) => setTimeout(r, 120));
      const drops = log.mock.calls.filter((c) => c[0]?.kind === 'relay.backlog-drop');
      expect(drops).toHaveLength(1);
      expect(drops[0][0].meta.count).toBe(1);
      handle.close();
    });
  });

  // B3. `terminate()` on a socket that has ALREADY closed returns without
  // emitting anything, so the transport's own 'close' event is not something
  // the liveness path may depend on.
  it('a liveness termination runs cleanup itself rather than waiting for a close event', async () => {
    const { redis, socket, opts } = baseOptions(); // liveness 40ms, heartbeat 20ms
    const keys = roomKeys('r1', NS);
    const seen = joinEnvelopesOn(redis, keys.in);
    const onClose = vi.fn();

    attachRelay({ ...opts, onClose });
    await new Promise((r) => setTimeout(r, 90)); // several beats past the deadline

    expect(socket.terminated).toBe(1); // once, not once per beat
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(1006);
    expect(seen.filter((e) => e.t === 'leave')).toHaveLength(1);
  });

  // B4. The ticker publishes `room-reject` on the ROSTER channel, which is a
  // broadcast, so the relay is the only place that knows which socket the
  // rejection is actually about.
  describe('room-reject is consumed by the relay, never forwarded blindly', () => {
    async function attachedRelay(overrides: Partial<Parameters<typeof attachRelay>[0]> = {}) {
      const { redis, socket, opts } = baseOptions({ livenessTimeoutMs: 10_000, ...overrides });
      const onClose = vi.fn();
      const handle = attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0; // drop the roster seeds; every later send is forwarded traffic
      return { redis, socket, handle, onClose, keys: roomKeys('r1', NS) };
    }

    it('sends room-full and closes with the capacity code when the reject names its own pid', async () => {
      const { redis, socket, onClose, keys } = await attachedRelay();
      await redis.publish(keys.metaout, JSON.stringify({ t: ROOM_REJECT_FRAME, pid: 'p1' }));

      expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.roomFull })]);
      expect(socket.closed).toContain(CLOSE_CODES.capacity);
      expect(onClose).toHaveBeenCalledWith(CLOSE_CODES.capacity);
    });

    it('drops a reject aimed at another pid instead of forwarding it to everyone', async () => {
      // The measured failure: every OTHER player in the room received a
      // reject frame per heartbeat while the player it named sat connected
      // forever, receiving snapshots with no entity in them.
      const { redis, socket, onClose, keys } = await attachedRelay();
      await redis.publish(keys.metaout, JSON.stringify({ t: ROOM_REJECT_FRAME, pid: 'someone-else' }));

      expect(socket.sent).toHaveLength(0);
      expect(socket.closed).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('still forwards every other metaout frame unchanged', async () => {
      // Without this the two cases above would pass just as well against a
      // relay that had stopped forwarding the roster altogether.
      const { redis, socket, keys } = await attachedRelay();
      const roster = JSON.stringify({ t: SERVER_FRAMES.meta, map: { p1: { name: 'Alice' } } });
      await redis.publish(keys.metaout, roster);
      await redis.publish(keys.metaout, 'not json at all');

      expect(socket.sent).toEqual([roster, 'not json at all']);
      expect(socket.closed).toHaveLength(0);
    });

    it('forwards a binary snapshot as bytes, never as a decoded string', async () => {
      const { redis, socket, keys } = await attachedRelay();
      const snapshot = Buffer.from([0xff, 0x00, 0xfe, 0x01]);
      await redis.publish(keys.out, snapshot);
      expect(socket.sent).toHaveLength(1);
      expect(Buffer.isBuffer(socket.sent[0])).toBe(true);
      expect(Buffer.from(socket.sent[0] as Buffer).equals(snapshot)).toBe(true);
    });
  });

  // B5. The client measures a true round trip with this, so anything the
  // relay does on the way (a publish, a decode, a wait for the ticker) is
  // measurement error added to the number.
  describe('the ping/pong echo', () => {
    it('answers a ping delivered as a string, without ever calling decodeInput', async () => {
      const { socket, decodeInput, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      socket.fire('message', encodePing(7, 1234.5));

      expect(socket.sent).toEqual([encodePong(7, 1234.5)]);
      expect(decodeInput).not.toHaveBeenCalled();
      handle.close();
    });

    it('answers a ping delivered as a Buffer, which is how the ws package hands over a TEXT frame', async () => {
      // The arm that matters for both shipped adapters: `ws` delivers text
      // as a Buffer exactly like binary, so a `typeof data === 'string'`
      // test alone would miss every real ping.
      const { socket, decodeInput, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      socket.fire('message', Buffer.from(encodePing(3, 99), 'utf8'));

      expect(socket.sent).toEqual([encodePong(3, 99)]);
      expect(decodeInput).not.toHaveBeenCalled();
      handle.close();
    });

    it('publishes nothing to Redis for a ping', async () => {
      const { redis, socket, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      const seen = joinEnvelopesOn(redis, keys.in);

      socket.fire('message', encodePing(1, 2));
      await new Promise((r) => setTimeout(r, 5));

      expect(seen.filter((e) => e.t === 'in')).toHaveLength(0);
      handle.close();
    });

    it('drops a malformed ping in silence rather than answering it', async () => {
      const log = vi.fn();
      const { socket, decodeInput, opts } = baseOptions({ log, inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      socket.fire('message', '{"t":"ping", truncated'); // parses as a ping, is not JSON
      socket.fire('message', JSON.stringify({ t: 'ping', n: 'one', c: 2 })); // fields of the wrong type
      socket.fire('message', '{"t":"ping","n":null,"c":null}');

      expect(socket.sent).toHaveLength(0);
      expect(decodeInput).not.toHaveBeenCalled(); // a ping-shaped frame never reaches the decoder
      expect(log).not.toHaveBeenCalled();
      handle.close();
    });

    it('a ping still pays a token, so relabelling a flood buys no extra allowance', async () => {
      const onRateDrop = vi.fn();
      const { socket, opts } = baseOptions({ onRateDrop }); // capacity 3, no refill
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      for (let i = 0; i < 10; i++) socket.fire('message', encodePing(i, 0));

      expect(socket.sent).toHaveLength(3);
      expect(onRateDrop).toHaveBeenCalledTimes(7);
      handle.close();
    });

    it('an ordinary input frame still reaches the decoder', async () => {
      // The control for the whole group: the prefix test must not swallow
      // traffic that merely happens to be text.
      const { socket, decodeInput, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));

      socket.fire('message', Buffer.from(JSON.stringify({ t: 'move', x: 1 }), 'utf8'));

      expect(decodeInput).toHaveBeenCalledTimes(1);
      handle.close();
    });
  });

  // B6. The forward used to be a reliable unbounded queue on top of a bus
  // this library praises for being lossy: measured at 7.65MB queued for one
  // paused socket, then replayed as a stale burst the moment it drained.
  describe('backpressure on the snapshot forward', () => {
    async function relayWithCap(cap: number, log: ReturnType<typeof vi.fn>) {
      const { redis, socket, opts } = baseOptions({
        log,
        snapshotBacklogBytes: cap,
        heartbeatMs: 20,
        livenessTimeoutMs: 10_000,
      });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;
      return { redis, socket, handle, keys: roomKeys('r1', NS) };
    }

    it('drops a snapshot once the socket has more queued than the cap, and forwards again when it drains', async () => {
      const log = vi.fn();
      const { redis, socket, handle, keys } = await relayWithCap(100, log);
      const snapshot = Buffer.from([1, 2, 3]);

      await redis.publish(keys.out, snapshot);
      expect(socket.sent).toHaveLength(1); // an idle socket takes it

      socket.bufferedAmount = 101;
      await redis.publish(keys.out, snapshot);
      await redis.publish(keys.out, snapshot);
      expect(socket.sent).toHaveLength(1); // both dropped

      socket.bufferedAmount = 0;
      await redis.publish(keys.out, snapshot);
      expect(socket.sent).toHaveLength(2); // the newest snapshot supersedes the dropped ones
      handle.close();
    });

    it('logs the drops ONCE per heartbeat carrying the count, never once per frame', async () => {
      const log = vi.fn();
      const { redis, socket, handle, keys } = await relayWithCap(100, log);
      socket.bufferedAmount = 5000;

      for (let i = 0; i < 12; i++) await redis.publish(keys.out, Buffer.from([1]));
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.backlog-drop')).toHaveLength(0);

      // Several beats' worth of waiting, but only the first beat has a count
      // to report, so this cannot pass or fail on how many actually fired.
      await new Promise((r) => setTimeout(r, 120));
      const lines = log.mock.calls.filter((c) => c[0]?.kind === 'relay.backlog-drop');
      expect(lines).toHaveLength(1);
      expect(lines[0][0].meta.count).toBe(12);
      handle.close();
    });

    it('leaves a control frame on metaout unconditional, because nothing repeats a one-shot', async () => {
      const log = vi.fn();
      const { redis, socket, handle, keys } = await relayWithCap(100, log);
      socket.bufferedAmount = 999_999;

      const roster = JSON.stringify({ t: SERVER_FRAMES.meta, map: {} });
      await redis.publish(keys.metaout, roster);
      expect(socket.sent).toEqual([roster]);
      handle.close();
    });

    it('exactly at the backlog cap still forwards, and one byte past it drops', async () => {
      // The cap is `buffered > cap`, and a `>=` looks exactly as right. The
      // case above moves from 0 to 101, so it cannot tell the two apart. A
      // socket holding exactly the cap has not exceeded anything, and this is
      // the ONE snapshot that decides whether a room at a steady cap-sized
      // backlog forwards every frame or none of them.
      const log = vi.fn();
      const { redis, socket, handle, keys } = await relayWithCap(100, log);
      const snapshot = Buffer.from([1, 2, 3]);

      socket.bufferedAmount = 100;
      await redis.publish(keys.out, snapshot);
      expect(socket.sent).toHaveLength(1);

      socket.bufferedAmount = 101;
      await redis.publish(keys.out, snapshot);
      expect(socket.sent).toHaveLength(1); // CONTROL: one byte past the cap really does drop
      handle.close();
    });

    it('a socket that reports no bufferedAmount at all is forwarded to unconditionally', async () => {
      // A hand-rolled transport need not have the field, and a missing
      // reading must not read as an infinite backlog.
      const log = vi.fn();
      const { redis, socket, handle, keys } = await relayWithCap(100, log);
      (socket as { bufferedAmount?: number | undefined }).bufferedAmount = undefined;
      await redis.publish(keys.out, Buffer.from([1]));
      expect(socket.sent).toHaveLength(1);
      handle.close();
    });
  });

  // A HOLE IN SNAPSHOT ARRIVAL HAS TWO CAUSES AND THE CLIENT CANNOT TELL THEM
  // APART. Measured on a real deployment: arrival gaps of 250 to 433ms a few
  // times an hour per client, against a ticker publishing every 50ms, with an
  // in-function probe putting the Redis path at p99 2.4ms and max 22ms over
  // 4800 samples. So the bus is not it, and what is left is this relay's own
  // event loop (or the function being paused by the platform) versus the
  // socket path out to the browser. The relay sees the ARRIVAL and it sees
  // the SEND return, so it is the only place in the system that can separate
  // those two, and the separation is worth nothing unless it survives the
  // rule the rest of this file lives by: never a line per message.
  describe('the relay measures its own bus gaps and send lag', () => {
    function gapsLines(log: ReturnType<typeof vi.fn>) {
      return log.mock.calls.filter((c) => c[0]?.kind === 'relay.gaps').map((c) => c[0]);
    }

    it('says nothing at all while snapshots arrive on the ticker\'s own cadence', async () => {
      // THE HEALTHY CASE IS SILENCE, which is what makes a `relay.gaps` line
      // in the platform log a signal rather than something to filter out of a
      // stream of them. Five whole windows of a 50ms ticker, not one line.
      vi.useFakeTimers();
      try {
        const log = vi.fn();
        const { redis, opts } = baseOptions({ log, heartbeatMs: 1000, livenessTimeoutMs: 1_000_000 });
        const keys = roomKeys('r1', NS);
        const handle = attachRelay(opts);
        await vi.advanceTimersByTimeAsync(5);

        for (let i = 0; i < 100; i++) {
          await vi.advanceTimersByTimeAsync(50);
          await redis.publish(keys.out, Buffer.from([1, 2, 3]));
        }
        await vi.advanceTimersByTimeAsync(1000);

        expect(gapsLines(log)).toHaveLength(0);
        handle.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a 300ms hole in bus delivery is ONE line in the next window, never one per gap', async () => {
      vi.useFakeTimers();
      try {
        const log = vi.fn();
        const { redis, opts } = baseOptions({ log, heartbeatMs: 1000, livenessTimeoutMs: 1_000_000 });
        const keys = roomKeys('r1', NS);
        const handle = attachRelay(opts);
        await vi.advanceTimersByTimeAsync(5);

        for (let i = 0; i < 4; i++) {
          await vi.advanceTimersByTimeAsync(50);
          await redis.publish(keys.out, Buffer.from([1]));
        }
        await vi.advanceTimersByTimeAsync(300); // the hole the client actually reported
        await redis.publish(keys.out, Buffer.from([1]));
        for (let i = 0; i < 4; i++) {
          await vi.advanceTimersByTimeAsync(50);
          await redis.publish(keys.out, Buffer.from([1]));
        }

        // NOTHING YET. A line here would mean the gap was reported from the
        // message path, which is the client-rate amplifier this whole design
        // exists to avoid; the flush is a `setInterval` nothing on the wire
        // can drive.
        expect(gapsLines(log)).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(2500); // the flush, plus two quiet windows after it

        const lines = gapsLines(log);
        expect(lines).toHaveLength(1);
        expect(lines[0].lvl).toBe('info');
        expect(lines[0].meta.busGapMax).toBe(300);
        expect(lines[0].meta.busGapOver150).toBe(1); // the eight 50ms gaps are not holes
        expect(lines[0].meta.sendLagMax).toBe(0); // and none of it was the socket
        expect(lines[0].meta.socketAgeMs).toBeGreaterThan(0);
        handle.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a send that blocks for 80ms is reported as send lag, with no bus gap at all', async () => {
      // The other half of the same hole, and the half a bus-side probe cannot
      // see. An operator chasing the wrong one of these two is the entire
      // reason both numbers are on one line.
      const log = vi.fn();
      const { redis, socket, opts } = baseOptions({ log, heartbeatMs: 40, livenessTimeoutMs: 100_000 });
      const keys = roomKeys('r1', NS);
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));

      socket.send = (data: string | Uint8Array | Buffer): void => {
        const until = Date.now() + 80;
        while (Date.now() < until) {
          // a transport that blocks the loop, which is exactly what the
          // send-side number exists to name
        }
        socket.sent.push(data);
      };
      await redis.publish(keys.out, Buffer.from([1]));

      const sample = handle.gapsSample();
      expect(sample.sendLagMax).toBeGreaterThanOrEqual(80);
      expect(sample.busGapMax).toBe(0); // one arrival, so there is no gap to measure
      expect(sample.busGapOver150).toBe(0);

      await new Promise((r) => setTimeout(r, 140)); // a beat, and then a quiet one
      const lines = gapsLines(log);
      expect(lines).toHaveLength(1);
      expect(lines[0].meta.sendLagMax).toBeGreaterThanOrEqual(80);
      expect(lines[0].meta.busGapMax).toBe(0);
      expect(lines[0].meta.busGapOver150).toBe(0);
      handle.close();
    });

    it('the FIRST snapshot on a socket is not a gap, however long the socket waited for it', async () => {
      // A relay attaches and then waits for whatever the ticker's next
      // publish happens to be. Counting the socket's own age as its first
      // inter-arrival gap reports a hole on every single connect, which is
      // the one thing that would bury the real ones.
      vi.useFakeTimers();
      try {
        const log = vi.fn();
        const { redis, opts } = baseOptions({ log, heartbeatMs: 1000, livenessTimeoutMs: 1_000_000 });
        const keys = roomKeys('r1', NS);
        const handle = attachRelay(opts);
        await vi.advanceTimersByTimeAsync(5);

        await vi.advanceTimersByTimeAsync(2000); // two whole windows with no snapshot at all
        await redis.publish(keys.out, Buffer.from([1]));

        const sample = handle.gapsSample();
        expect(sample.busGapMax).toBe(0);
        expect(sample.busGapOver150).toBe(0);
        expect(sample.socketAgeMs).toBeGreaterThanOrEqual(2000);

        await vi.advanceTimersByTimeAsync(1500); // let that window flush
        expect(gapsLines(log)).toHaveLength(0);
        handle.close();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // B7. A subscribe that never lands leaves a socket OPEN, admitted,
  // heartbeating and deaf, with every other signal on both ends healthy.
  describe('the subscribe is bounded, and a dead subscriber ends the socket', () => {
    /** A fork whose event callbacks the test can fire, standing in for the connection events ioredis emits. */
    function hookedSubscriber(redis: FakeRedis) {
      const sub = redis.fork();
      const hooks = new Map<string, (...args: unknown[]) => void>();
      const original = sub.on.bind(sub);
      (sub as unknown as { on: (ev: string, cb: (...args: unknown[]) => void) => void }).on = (ev, cb) => {
        hooks.set(ev, cb);
        original(ev, cb);
      };
      return { sub, hooks };
    }

    it('closes with relayUnavailable when the subscribe does not complete in time', async () => {
      const log = vi.fn();
      const { redis, socket, opts } = baseOptions({ log, subscribeTimeoutMs: 20, livenessTimeoutMs: 10_000 });
      const sub = redis.fork();
      (sub as unknown as { subscribe: () => Promise<unknown> }).subscribe = () => new Promise(() => {});
      const onClose = vi.fn();

      attachRelay({ ...opts, onClose, createSubscriber: () => sub });
      await new Promise((r) => setTimeout(r, 60));

      expect(socket.closed).toContain(CLOSE_CODES.relayUnavailable);
      expect(onClose).toHaveBeenCalledWith(CLOSE_CODES.relayUnavailable);
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.subscribe-failed')).toHaveLength(1);
    });

    it('does NOT log a subscribe failure for a socket that already closed inside the round trip', async () => {
      // Measured as one `relay.subscribe-failed: Connection is closed.` at
      // ERROR level per short-lived socket, which is noise in exactly the
      // log an operator reads to find real subscribe failures.
      const log = vi.fn();
      const { redis, opts } = baseOptions({ log, livenessTimeoutMs: 10_000 });
      const sub = redis.fork();
      (sub as unknown as { subscribe: () => Promise<unknown> }).subscribe = () =>
        Promise.reject(new Error('Connection is closed.'));

      const handle = attachRelay({ ...opts, createSubscriber: () => sub });
      handle.close(); // before the rejection's own microtask runs
      await new Promise((r) => setTimeout(r, 20));

      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.subscribe-failed')).toHaveLength(0);
    });

    it('coalesces subscriber error events onto the heartbeat rather than logging each one', async () => {
      const log = vi.fn();
      const { redis, opts } = baseOptions({ log, heartbeatMs: 20, livenessTimeoutMs: 10_000 });
      const { sub, hooks } = hookedSubscriber(redis);
      const handle = attachRelay({ ...opts, createSubscriber: () => sub });
      await new Promise((r) => setTimeout(r, 5));

      for (let i = 0; i < 8; i++) hooks.get('error')?.(new Error('ECONNRESET'));
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.subscriber-error')).toHaveLength(0);

      await new Promise((r) => setTimeout(r, 120));
      const lines = log.mock.calls.filter((c) => c[0]?.kind === 'relay.subscriber-error');
      expect(lines).toHaveLength(1);
      expect(lines[0][0].meta.count).toBe(8);
      expect(String(lines[0][0].meta.error)).toContain('ECONNRESET');
      handle.close();
    });

    it('closes the socket when the subscriber connection ends', async () => {
      const log = vi.fn();
      const { redis, socket, opts } = baseOptions({ log, livenessTimeoutMs: 10_000 });
      const { sub, hooks } = hookedSubscriber(redis);
      const onClose = vi.fn();
      attachRelay({ ...opts, onClose, createSubscriber: () => sub });
      await new Promise((r) => setTimeout(r, 10));

      hooks.get('end')?.();

      expect(socket.closed).toContain(CLOSE_CODES.relayUnavailable);
      expect(onClose).toHaveBeenCalledWith(CLOSE_CODES.relayUnavailable);
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.subscriber-dead')).toHaveLength(1);
    });
  });

  // B8. A ticker cold start is longer than the poll period, so every poll
  // inside that window used to fire another invocation: measured at 41 from
  // 20 sockets during one 2.5s start.
  describe('the spawn hold-off', () => {
    function twentySockets(spawnHoldoffMs: number) {
      const redis = new FakeRedis();
      const spawnTicker = vi.fn().mockResolvedValue(undefined);
      const handles: ReturnType<typeof attachRelay>[] = [];
      for (let i = 0; i < 20; i++) {
        handles.push(
          attachRelay({
            socket: new MockSocket(),
            redis,
            createSubscriber: () => redis.fork(),
            roomId: 'r1',
            pid: `p${i}`,
            namespace: NS,
            decodeInput: () => [],
            spawnTicker,
            heartbeatMs: 10_000,
            tickerCheckMs: 5,
            tickerCheckJitterMs: 0,
            livenessTimeoutMs: 10_000,
            spawnHoldoffMs,
          })
        );
      }
      return { spawnTicker, handles };
    }

    it('fires at most one spawn per socket per hold-off window, however often the poll runs', async () => {
      const { spawnTicker, handles } = twentySockets(500);
      await new Promise((r) => setTimeout(r, 80)); // a dozen polls per socket
      expect(spawnTicker).toHaveBeenCalledTimes(20);
      for (const h of handles) h.close();
    });

    it('CONTROL: with the hold-off disabled every poll spawns again', async () => {
      // Without this the case above would pass just as well against a relay
      // that had stopped polling altogether.
      const { spawnTicker, handles } = twentySockets(0);
      await new Promise((r) => setTimeout(r, 80));
      expect(spawnTicker.mock.calls.length).toBeGreaterThan(60);
      for (const h of handles) h.close();
    });

    it('a poll that finds a LIVE lease clears the hold-off, so a gap appearing later spawns at once', async () => {
      // The hold-off exists to stop ONE relay asking for the same spawn twenty
      // times while the answer is still in flight. It is not evidence about a
      // gap that opens later: a lease that came up ANSWERS the question the
      // hold-off was waiting on, and carrying the old window past that point
      // means a room whose ticker dies at second one sits unsimulated for the
      // rest of it.
      const redis = new FakeRedis();
      const keys = roomKeys('r1', NS);
      const spawnTicker = vi.fn().mockResolvedValue(undefined);
      const handle = attachRelay({
        socket: new MockSocket(),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r1',
        pid: 'p1',
        namespace: NS,
        decodeInput: () => [],
        spawnTicker,
        heartbeatMs: 10_000,
        tickerCheckMs: 5,
        tickerCheckJitterMs: 0,
        livenessTimeoutMs: 10_000,
        // Far longer than this case runs, so a hold-off that survives the live
        // lease can only end the run at one spawn.
        spawnHoldoffMs: 10_000,
      });

      await new Promise((r) => setTimeout(r, 30));
      expect(spawnTicker).toHaveBeenCalledTimes(1); // the gap at attach

      // The spawn landed: a dozen polls now find a live lease and ask for
      // nothing, which is the hold-off's own job being done for it.
      await redis.set(keys.lease, 'the-ticker', 'PX', 5000);
      await new Promise((r) => setTimeout(r, 30));
      expect(spawnTicker).toHaveBeenCalledTimes(1);

      // ...and then that ticker dies. This is a NEW gap, and it must not be
      // answered with silence left over from a spawn that already succeeded.
      await redis.del(keys.lease);
      await new Promise((r) => setTimeout(r, 30));
      expect(spawnTicker).toHaveBeenCalledTimes(2);
      handle.close();
    });

    it('keeps polling throughout, so a spawn that never lands is still recovered', async () => {
      // The poll is the backstop for a room whose successor spawn failed;
      // the hold-off bounds how often ONE relay pays for a spawn, not
      // whether the room is checked at all.
      const redis = new FakeRedis();
      const spawnTicker = vi.fn().mockResolvedValue(undefined);
      const handle = attachRelay({
        socket: new MockSocket(),
        redis,
        createSubscriber: () => redis.fork(),
        roomId: 'r1',
        pid: 'p1',
        namespace: NS,
        decodeInput: () => [],
        spawnTicker,
        heartbeatMs: 10_000,
        tickerCheckMs: 5,
        tickerCheckJitterMs: 0,
        livenessTimeoutMs: 10_000,
        spawnHoldoffMs: 30,
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(spawnTicker.mock.calls.length).toBeGreaterThan(1); // the window expired and it tried again
      expect(spawnTicker.mock.calls.length).toBeLessThan(10); // but not once per poll
      handle.close();
    });

    // A SPAWN IS A DELIVERY, NOT A CONVERSATION, and this line is where the
    // difference was visible. A host that waited for the spawn's RESPONSE was
    // waiting for the ticker's whole life, so undici gave up at its 300s
    // headers timeout and the relay reported `TypeError: fetch failed` on a
    // room that had been ticking for five minutes: measured on the real
    // deployment, once per room start. See `SPAWN_ACK_MS` in
    // `adapters/vercel.ts` for the delivery contract that fixed it.
    it('logs relay.spawn-failed, NAMING the outcome, only for a spawn that never left', async () => {
      const log = vi.fn();
      const { opts } = baseOptions({
        log,
        spawnTicker: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443')),
        livenessTimeoutMs: 10_000,
      });

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 20));

      const failed = log.mock.calls.filter((c) => c[0]?.kind === 'relay.spawn-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0][0]).toMatchObject({
        lvl: 'error',
        room: 'r1',
        pid: 'p1',
        meta: { outcome: 'rejected-before-ack' },
      });
      expect(String(failed[0][0].meta.error)).toContain('ECONNREFUSED');
      handle.close();
    });

    it('CONTROL: a spawn that RESOLVES says nothing at all, whatever it resolves with', async () => {
      // Without this the case above would pass equally well against a relay
      // that logged a failure for every spawn, which is precisely the state
      // this pair was written for: an error line per room start, on the spawn
      // that had worked.
      const log = vi.fn();
      const { opts } = baseOptions({
        log,
        spawnTicker: vi.fn().mockResolvedValue('delivered'),
        livenessTimeoutMs: 10_000,
      });

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 20));

      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.spawn-failed')).toHaveLength(0);
      handle.close();
    });
  });

  // B9. A serverless host kills the function at its own duration cap with no
  // warning to anyone, which reaches the client as a socket that simply dies.
  describe('the relay lifetime', () => {
    it('announces relay-expiring one lead time before the cap, and has not closed yet', async () => {
      const { socket, opts } = baseOptions({
        lifetimeMs: RELAY_EXPIRY_LEAD_MS + 40,
        livenessTimeoutMs: 10_000,
      });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 20));
      socket.sent.length = 0;

      await new Promise((r) => setTimeout(r, 60)); // past the lead, nowhere near the cap
      const frames = socket.sent
        .filter((s): s is string => typeof s === 'string')
        .map((s) => JSON.parse(s) as Record<string, unknown>)
        .filter((f) => f.t === SERVER_FRAMES.relayExpiring);
      expect(frames).toEqual([{ t: SERVER_FRAMES.relayExpiring, inMs: RELAY_EXPIRY_LEAD_MS }]);
      expect(socket.closed).toHaveLength(0);
      handle.close();
    });

    it('closes with relayUnavailable at the cap, having announced immediately when the lifetime is shorter than the lead', async () => {
      const { redis, socket, opts } = baseOptions({ lifetimeMs: 40, livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      const seen = joinEnvelopesOn(redis, keys.in);
      const onClose = vi.fn();

      attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 15));
      const announced = socket.sent
        .filter((s): s is string => typeof s === 'string')
        .some((s) => s.includes(SERVER_FRAMES.relayExpiring));
      expect(announced).toBe(true); // no useful lead left, so it is sent at once

      await new Promise((r) => setTimeout(r, 60));
      expect(socket.closed).toContain(CLOSE_CODES.relayUnavailable);
      expect(onClose).toHaveBeenCalledWith(CLOSE_CODES.relayUnavailable);
      expect(seen.filter((e) => e.t === 'leave')).toHaveLength(1);
    });

    it('a socket that closes early fires neither timer', async () => {
      const { socket, opts } = baseOptions({ lifetimeMs: 40, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      handle.close();
      socket.sent.length = 0;
      await new Promise((r) => setTimeout(r, 60));
      expect(socket.sent).toHaveLength(0);
      // The handle's own close and nothing after it, carrying the SAME code
      // `onClose` was told about rather than an `undefined` the transport
      // turns into a 1005 on the wire.
      expect(socket.closed).toEqual([1000]);
    });

    it('no lifetime option means no expiry at all', async () => {
      const { socket, opts } = baseOptions({ livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 60));
      const announced = socket.sent
        .filter((s): s is string => typeof s === 'string')
        .some((s) => s.includes(SERVER_FRAMES.relayExpiring));
      expect(announced).toBe(false);
      expect(socket.closed).toHaveLength(0);
      handle.close();
    });
  });

  // The adversarial pass over this fix set found four more, all of them
  // states a socket reaches on a real transport and none of them reachable
  // through the ordinary open-socket path the earlier cases exercise.
  describe('the states a socket reaches that nothing else covers', () => {
    it('a socket that never opens is cleaned up at the open deadline instead of leaking forever', async () => {
      // THE LEAK IS TOTAL AND SILENT: the heartbeat is created by
      // `startSession`, which only the 'open' event reaches, so the one
      // mechanism that would eventually terminate a silent socket never
      // starts. The subscriber connection, the per-subject cap slot and the
      // host's registration touch timer all live to the function's duration
      // cap for a handshake that failed.
      const log = vi.fn();
      const { redis, socket, opts } = baseOptions({ log, subscribeTimeoutMs: 30, livenessTimeoutMs: 10_000 });
      const seen = joinEnvelopesOn(redis, roomKeys('r1', NS).in);
      const onClose = vi.fn();
      socket.readyState = 0;

      attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 80));

      expect(onClose).toHaveBeenCalledWith(1006);
      expect(socket.closed).toContain(1006);
      expect(seen).toHaveLength(0); // it never joined, so it has nothing to retract either
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.open-timeout')).toHaveLength(1);
    });

    it('opening inside the deadline disarms it', async () => {
      // The control: without this the case above would pass just as well
      // against a relay that closed every CONNECTING socket on a timer
      // regardless of whether it opened.
      const { socket, opts } = baseOptions({ subscribeTimeoutMs: 40, livenessTimeoutMs: 10_000 });
      const onClose = vi.fn();
      socket.readyState = 0;

      const handle = attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));
      socket.readyState = 1;
      socket.fire('open');
      await new Promise((r) => setTimeout(r, 80)); // well past the deadline

      expect(onClose).not.toHaveBeenCalled();
      expect(socket.closed).toHaveLength(0);
      handle.close();
    });

    it('queues the control frames produced before OPEN and flushes them on open, logging nothing', async () => {
      // `ws` THROWS on a send in CONNECTING, so attempting these was worth
      // one `relay.send-failed` line per frame for a socket that had done
      // nothing wrong. They are one-shot frames, so dropping them is
      // permanent and queueing is the only answer that keeps them.
      const log = vi.fn();
      const { redis, socket, opts } = baseOptions({ log, subscribeTimeoutMs: 10_000, livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      socket.readyState = 0;

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10)); // the subscribe still goes out immediately
      const roster = JSON.stringify({ t: SERVER_FRAMES.meta, map: { p2: {} } });
      await redis.publish(keys.metaout, roster);
      expect(socket.sent).toHaveLength(0);
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.send-failed')).toHaveLength(0);

      socket.readyState = 1;
      socket.fire('open');
      expect(socket.sent).toContain(roster); // flushed synchronously, ahead of anything the session sends
      handle.close();
    });

    it('keeps only the newest few queued control frames, never an unbounded backlog', async () => {
      // The same reasoning as the snapshot cap: an unbounded queue for a
      // socket that may never open is a memory leak with a stale burst at
      // the end of it.
      const { redis, socket, opts } = baseOptions({ subscribeTimeoutMs: 10_000, livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      socket.readyState = 0;

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      for (let i = 0; i < 12; i++) await redis.publish(keys.metaout, JSON.stringify({ t: SERVER_FRAMES.meta, n: i }));

      socket.readyState = 1;
      socket.fire('open');
      const flushed = socket.sent.filter((f): f is string => typeof f === 'string').map((f) => JSON.parse(f) as { n?: number });
      expect(flushed).toHaveLength(8);
      expect(flushed.map((f) => f.n)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]); // the NEWEST eight
      handle.close();
    });

    it('coalesces send failures onto the heartbeat rather than logging one per frame', async () => {
      // The one traffic-driven path that was still logging per event:
      // measured at 20 error lines a second for a single broken socket.
      const log = vi.fn();
      const { redis, socket, opts } = baseOptions({ log, heartbeatMs: 20, livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));

      socket.send = () => {
        throw new Error('EPIPE');
      };
      await redis.publish(keys.out, Buffer.from([1]));
      await redis.publish(keys.out, Buffer.from([2]));
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.send-failed')).toHaveLength(0);

      await new Promise((r) => setTimeout(r, 120));
      const lines = log.mock.calls.filter((c) => c[0]?.kind === 'relay.send-failed');
      expect(lines).toHaveLength(1);
      expect(lines[0][0].meta.count).toBe(2);
      expect(String(lines[0][0].meta.error)).toContain('EPIPE');
      handle.close();
    });

    it('treats three consecutive throwing sends as a dead socket', async () => {
      // A transport refusing three sends in a row produced no 'close' and no
      // 'error' event, which is the same silence the liveness deadline
      // exists for, reached tens of seconds sooner from evidence already in
      // hand.
      const { redis, socket, opts } = baseOptions({ heartbeatMs: 10_000, livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      const onClose = vi.fn();
      attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));

      socket.send = () => {
        throw new Error('EPIPE');
      };
      for (let i = 0; i < 3; i++) await redis.publish(keys.out, Buffer.from([i]));

      expect(socket.terminated).toBe(1);
      expect(onClose).toHaveBeenCalledWith(1006);
    });

    it('a successful send resets the run, so an occasional throw is not a death sentence', async () => {
      const { redis, socket, opts } = baseOptions({ heartbeatMs: 10_000, livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      const onClose = vi.fn();
      const handle = attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));

      const realSend = socket.send.bind(socket);
      let n = 0;
      socket.send = (data) => {
        n++;
        if (n % 2 === 1) throw new Error('EPIPE'); // every other frame fails
        realSend(data);
      };
      for (let i = 0; i < 8; i++) await redis.publish(keys.out, Buffer.from([i]));

      expect(socket.terminated).toBe(0);
      expect(onClose).not.toHaveBeenCalled();
      handle.close();
    });

    it('answers a ping delivered as an ARRAY of buffers, which is how ws hands over a fragmented frame', async () => {
      // A peer chooses its own fragmentation, so nothing about a ping's size
      // stops it arriving in two pieces. Missing this arm does not lose the
      // frame, it routes a ping into the host's decoder.
      const { socket, decodeInput, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      const whole = encodePing(11, 22);
      const cut = 5;
      socket.fire('message', [Buffer.from(whole.slice(0, cut), 'utf8'), Buffer.from(whole.slice(cut), 'utf8')]);

      expect(socket.sent).toEqual([encodePong(11, 22)]);
      expect(decodeInput).not.toHaveBeenCalled();
      handle.close();
    });

    it('leaves a fragmented NON-ping frame to the decoder', async () => {
      const { socket, decodeInput, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));

      socket.fire('message', [Buffer.from('{"t":"mo', 'utf8'), Buffer.from('ve"}', 'utf8')]);

      expect(decodeInput).toHaveBeenCalledTimes(1);
      handle.close();
    });

    it('handle.close() gives the transport the same code it gives onClose', async () => {
      const { socket, opts } = baseOptions({ livenessTimeoutMs: 10_000 });
      const onClose = vi.fn();
      const handle = attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));

      handle.close();

      expect(onClose).toHaveBeenCalledWith(1000);
      expect(socket.closed).toEqual([1000]);
    });
  });

  // B4, second half. A pid names a player and a reject is about ONE socket's
  // join, and a reconnect or a `lifetimeMs` swap deliberately holds two live
  // sockets for the same pid at once.
  describe('a room-reject is aimed at a connection, not only a pid', () => {
    async function relayAndConn(overrides: Partial<Parameters<typeof attachRelay>[0]> = {}) {
      const { redis, socket, opts } = baseOptions({ livenessTimeoutMs: 10_000, ...overrides });
      const seen = joinEnvelopesOn(redis, roomKeys('r1', NS).in);
      const onClose = vi.fn();
      const handle = attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));
      const conn = (seen.find((e) => e.t === 'join') as { c?: string } | undefined)?.c;
      socket.sent.length = 0;
      return { redis, socket, handle, onClose, conn, keys: roomKeys('r1', NS) };
    }

    it('closes the socket whose own connection id the reject names', async () => {
      const { redis, socket, onClose, conn, keys } = await relayAndConn();
      await redis.publish(keys.metaout, JSON.stringify({ t: ROOM_REJECT_FRAME, pid: 'p1', c: conn }));

      expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.roomFull })]);
      expect(onClose).toHaveBeenCalledWith(CLOSE_CODES.capacity);
    });

    it('ignores a reject for its own pid that names a DIFFERENT connection', async () => {
      // The replacement socket in a reconnect or a lifetime swap: same pid,
      // different relay, and the rejection is about the other one's join.
      // Matching on pid alone closes the socket that was about to take over.
      const { redis, socket, onClose, keys } = await relayAndConn();
      await redis.publish(keys.metaout, JSON.stringify({ t: ROOM_REJECT_FRAME, pid: 'p1', c: 'some-other-relay' }));

      expect(socket.sent).toHaveLength(0);
      expect(socket.closed).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('still honours a reject with no connection id at all, from a ticker that predates it', async () => {
      const { redis, socket, onClose, keys } = await relayAndConn();
      await redis.publish(keys.metaout, JSON.stringify({ t: ROOM_REJECT_FRAME, pid: 'p1' }));

      expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.roomFull })]);
      expect(onClose).toHaveBeenCalledWith(CLOSE_CODES.capacity);
    });
  });

  // A second adversarial pass found three more, all of them about a path
  // being written to OUTSIDE the one place that counts what it does.
  describe('every send the relay originates goes through the one counted path', () => {
    it('counts a failing PONG like any other send, and terminates on a run of them', async () => {
      // The pong is the most frequent frame the relay originates, and it was
      // the one still calling `socket.send` inside a bare try/catch:
      // measured at six pongs into a throwing socket for zero send-failed
      // lines, zero terminates, and a socket left holding every resource.
      const log = vi.fn();
      const { socket, opts } = baseOptions({ log, heartbeatMs: 20, livenessTimeoutMs: 10_000, inboundCapacity: 100 });
      const onClose = vi.fn();
      attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));

      socket.send = () => {
        throw new Error('EPIPE');
      };
      for (let i = 0; i < 6; i++) socket.fire('message', encodePing(i, 0));

      expect(socket.terminated).toBe(1); // the run ended the socket at three
      expect(onClose).toHaveBeenCalledWith(1006);
      await new Promise((r) => setTimeout(r, 60));
      const lines = log.mock.calls.filter((c) => c[0]?.kind === 'relay.send-failed');
      expect(lines).toHaveLength(1);
      expect(lines[0][0].meta.count).toBe(3); // counted, and stopped counting once it was closed
    });

    it('a DELIVERED pong resets the failure run, because it is evidence the transport works', async () => {
      // The reverse of the case above and the reason the pong could not just
      // grow its own counter: two failed snapshots, one delivered pong and
      // one more failed snapshot used to kill a socket that had just proved
      // itself mid-run.
      const { redis, socket, opts } = baseOptions({ heartbeatMs: 10_000, livenessTimeoutMs: 10_000, inboundCapacity: 100 });
      const keys = roomKeys('r1', NS);
      const onClose = vi.fn();
      const handle = attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));

      const realSend = socket.send.bind(socket);
      let allowPong = false;
      socket.send = (data) => {
        if (!allowPong) throw new Error('EPIPE');
        realSend(data);
      };
      await redis.publish(keys.out, Buffer.from([1]));
      await redis.publish(keys.out, Buffer.from([2]));
      allowPong = true;
      socket.fire('message', encodePing(1, 2)); // delivered
      allowPong = false;
      await redis.publish(keys.out, Buffer.from([3]));

      expect(socket.terminated).toBe(0);
      expect(onClose).not.toHaveBeenCalled();
      handle.close();
    });

    it('a control frame queued before OPEN and then closed is dropped, and the close code still carries the meaning', async () => {
      // The queue is for frames that must survive a slow HANDSHAKE, not for
      // frames that accompany a close: a room-reject on a socket that is
      // still connecting queues its `room-full` and then closes, so the
      // flush never runs. Nothing is lost, because the code is the half the
      // client latches its terminal state off. Pinned so the tradeoff is a
      // decision rather than an accident.
      const { redis, socket, opts } = baseOptions({ subscribeTimeoutMs: 10_000, livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      const onClose = vi.fn();
      socket.readyState = 0;

      attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));
      await redis.publish(keys.metaout, JSON.stringify({ t: ROOM_REJECT_FRAME, pid: 'p1' }));

      expect(socket.sent).toHaveLength(0); // queued, and never flushed
      expect(socket.closed).toContain(CLOSE_CODES.capacity);
      expect(onClose).toHaveBeenCalledWith(CLOSE_CODES.capacity);
    });
  });

  // THE RESIDUAL GAP THE SUBSCRIBE BOUND AND THE 'end' LISTENER BOTH MISS.
  // Once a subscribe has succeeded, a black-holed connection is invisible:
  // ioredis never reconnects, so 'end' never fires, and the liveness check
  // measures only what the CLIENT sends, so a chatty player keeps a deaf
  // socket alive forever. Same mechanism as the ticker's input probe, on the
  // other side of the bus.
  describe('the relay probes its own subscription', () => {
    /** A fork whose deliveries can be black-holed while the connection keeps reading as healthy: no error, no 'end', no reconnect. */
    function blackholeableSubscriber(redis: FakeRedis) {
      const sub = redis.fork();
      let deliver = true;
      const original = sub.on.bind(sub);
      (sub as unknown as { on: (ev: string, cb: (...args: unknown[]) => void) => void }).on = (ev, cb) => {
        if (ev === 'messageBuffer') original(ev, (...args: unknown[]) => (deliver ? cb(...args) : undefined));
        else original(ev, cb);
      };
      return {
        sub,
        blackhole: (): void => {
          deliver = false;
        },
      };
    }

    it('terminates a subscriber that stops delivering, within three unanswered probes plus the beat that notices', async () => {
      const log = vi.fn();
      const { redis, socket, opts } = baseOptions({ log, heartbeatMs: 20, livenessTimeoutMs: 10_000 });
      const { sub, blackhole } = blackholeableSubscriber(redis);
      const onClose = vi.fn();
      attachRelay({ ...opts, onClose, createSubscriber: () => sub });
      await new Promise((r) => setTimeout(r, 10));
      blackhole();

      // Two beats in, the deadline must NOT have fired: three misses is a
      // dead subscription, one is a dropped delivery.
      await new Promise((r) => setTimeout(r, 50));
      expect(socket.terminated).toBe(0);

      await new Promise((r) => setTimeout(r, 250));
      expect(socket.terminated).toBe(1);
      expect(onClose).toHaveBeenCalledWith(CLOSE_CODES.relayUnavailable);
      const lines = log.mock.calls.filter((c) => c[0]?.kind === 'relay.subscriber-dead');
      expect(lines).toHaveLength(1); // once, not once per beat
      expect(lines[0][0].meta.sent).toBeGreaterThanOrEqual(3);
      expect(lines[0][0].meta.answered).toBe(0);
    });

    it('CONTROL: a subscriber that keeps delivering is never terminated, however long it runs', async () => {
      const log = vi.fn();
      const { socket, opts } = baseOptions({ log, heartbeatMs: 20, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 300)); // a dozen beats
      expect(socket.terminated).toBe(0);
      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.subscriber-dead')).toHaveLength(0);
      handle.close();
    });

    it('never forwards its own probes to the socket', async () => {
      // They are not traffic, they are the answer to a question this relay
      // asked itself, and a client has no idea what to do with one.
      const { socket, opts } = baseOptions({ heartbeatMs: 20, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 120));
      const probes = socket.sent.filter((f) => typeof f === 'string' && f.includes('"t":"probe"'));
      expect(probes).toHaveLength(0);
      handle.close();
    });

    it('keeps each socket probe on its own channel, so one healthy subscriber cannot answer for a dead one', async () => {
      // A shared channel would fan every socket's probe out to every other
      // socket in the room (quadratic in the room size, on the axis managed
      // Redis bills) AND let any one healthy subscriber answer for all of
      // them, which is the signal hiding the very failure it exists to
      // catch. The channel name is derived from the connection id the join
      // envelope already carries, which is what makes it addressable at all.
      const redis = new FakeRedis();
      const joins = joinEnvelopesOn(redis, roomKeys('r1', NS).in);
      const handles = ['pA', 'pB'].map((pid) =>
        attachRelay({
          socket: new MockSocket(),
          redis,
          createSubscriber: () => redis.fork(),
          roomId: 'r1',
          pid,
          namespace: NS,
          decodeInput: () => [],
          spawnTicker: vi.fn().mockResolvedValue(undefined),
          heartbeatMs: 20,
          tickerCheckMs: 10_000,
          tickerCheckJitterMs: 0,
          livenessTimeoutMs: 10_000,
        })
      );
      await new Promise((r) => setTimeout(r, 15));

      const conns = joins.filter((e) => e.t === 'join').map((e) => (e as { c?: string }).c);
      expect(new Set(conns).size).toBe(2); // two sockets, two identities

      const channels = [...new Set(conns)].map((c) => `${NS}:r1:relay:${c}`);
      const hits: string[] = [];
      const watcher = redis.fork();
      watcher.on('message', (ch: unknown) => {
        if (typeof ch === 'string') hits.push(ch);
      });
      await watcher.subscribe(...channels);
      await new Promise((r) => setTimeout(r, 80)); // a few beats
      for (const h of handles) h.close();

      // Each relay published on ITS OWN channel; a shared one would show a
      // single name here however many sockets were attached.
      expect(new Set(hits)).toEqual(new Set(channels));
    });
  });

  // A fuzz pass over the control paths. Every one of these is a frame or a
  // field arriving with a value nothing in the room is supposed to produce,
  // reaching a socket that then acts on it.
  describe('the control paths under hostile input', () => {
    /** The relay's own probe channel for a given connection id; the shape `attachRelay` builds internally. */
    const probeChannelFor = (conn: string): string => `${NS}:r1:relay:${conn}`;

    function blackholeable(redis: FakeRedis) {
      const sub = redis.fork();
      let deliver = true;
      const original = sub.on.bind(sub);
      (sub as unknown as { on: (ev: string, cb: (...args: unknown[]) => void) => void }).on = (ev, cb) => {
        if (ev === 'messageBuffer') original(ev, (...args: unknown[]) => (deliver ? cb(...args) : undefined));
        else original(ev, cb);
      };
      return {
        sub,
        blackhole: (): void => {
          deliver = false;
        },
      };
    }

    it('refuses a probe answer for a probe it never sent, so a forged n cannot disable the watchdog', async () => {
      // The channel name carries `conn`, which this relay publishes in the
      // clear on every join envelope, so anyone who can write to the bus can
      // address it. Against an unbounded `n > probesAnswered` check, ONE
      // `{ t: 'probe', n: 1e15 }` bought the socket permanent immunity:
      // measured as the control terminating with one dead line and the
      // poisoned one never terminating at all.
      const { redis, socket, opts } = baseOptions({ heartbeatMs: 20, livenessTimeoutMs: 10_000 });
      const seen = joinEnvelopesOn(redis, roomKeys('r1', NS).in);
      const { sub, blackhole } = blackholeable(redis);
      attachRelay({ ...opts, createSubscriber: () => sub });
      await new Promise((r) => setTimeout(r, 30));

      const conn = (seen.find((e) => e.t === 'join') as { c?: string } | undefined)?.c ?? '';
      expect(conn).not.toBe('');
      await redis.publish(probeChannelFor(conn), JSON.stringify({ t: 'probe', n: 1e15 }));
      blackhole();

      await new Promise((r) => setTimeout(r, 250));
      expect(socket.terminated).toBe(1);
    });

    it('refuses a non-integer probe answer too', async () => {
      const { redis, socket, opts } = baseOptions({ heartbeatMs: 20, livenessTimeoutMs: 10_000 });
      const seen = joinEnvelopesOn(redis, roomKeys('r1', NS).in);
      const { sub, blackhole } = blackholeable(redis);
      attachRelay({ ...opts, createSubscriber: () => sub });
      await new Promise((r) => setTimeout(r, 30));

      const conn = (seen.find((e) => e.t === 'join') as { c?: string } | undefined)?.c ?? '';
      for (const n of [Infinity, NaN, 2.5, '9999']) {
        await redis.publish(probeChannelFor(conn), JSON.stringify({ t: 'probe', n }));
      }
      blackhole();

      await new Promise((r) => setTimeout(r, 250));
      expect(socket.terminated).toBe(1);
    });

    it('drops a per-socket server frame published on the ROSTER channel, and counts it on the heartbeat', async () => {
      // Measured: one `{ t: 'room-full' }` on the roster channel latched
      // every client in the room into a terminal capacity state, closed
      // their sockets and stopped their reconnect ladders. Four of the five
      // frames this library defines are per-socket and only the relay
      // holding that socket may originate one.
      const log = vi.fn();
      const { redis, socket, opts } = baseOptions({ log, heartbeatMs: 20, livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      const onClose = vi.fn();
      const handle = attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      await redis.publish(keys.metaout, JSON.stringify({ t: SERVER_FRAMES.roomFull }));
      await redis.publish(keys.metaout, JSON.stringify({ t: SERVER_FRAMES.connLimit }));
      await redis.publish(keys.metaout, JSON.stringify({ t: SERVER_FRAMES.relayExpiring, inMs: 5000 }));
      await redis.publish(keys.metaout, JSON.stringify({ t: SERVER_FRAMES.pong, n: 1, c: 2 }));

      expect(socket.sent).toHaveLength(0);
      expect(socket.closed).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();

      await new Promise((r) => setTimeout(r, 120));
      const lines = log.mock.calls.filter((c) => c[0]?.kind === 'relay.misaddressed-frame');
      expect(lines).toHaveLength(1); // once a beat, never once a frame
      expect(lines[0][0].meta.count).toBe(4);
      handle.close();
    });

    it('still forwards the roster frame and a HOST frame this library does not define', async () => {
      // The allowlist is the broadcast one, and the roster channel is the
      // seam a host uses for its own control traffic: refusing everything
      // unknown would break that, forwarding everything known breaks the
      // room.
      const { redis, socket, opts } = baseOptions({ livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      const roster = JSON.stringify({ t: SERVER_FRAMES.meta, map: {} });
      const hostFrame = JSON.stringify({ t: 'scoreboard', rows: [] });
      await redis.publish(keys.metaout, roster);
      await redis.publish(keys.metaout, hostFrame);
      await redis.publish(keys.metaout, 'not json at all');

      expect(socket.sent).toEqual([roster, hostFrame, 'not json at all']);
      handle.close();
    });

    it('does NOT honour a room-reject whose connection id is the wrong type', async () => {
      // `typeof c === 'string'` read a numeric `c` as absent and fell back to
      // matching on the pid alone, which closes both of a swapping player's
      // sockets: the exact regression the field was added to prevent, reached
      // through a value the ticker never produces.
      const { redis, socket, opts } = baseOptions({ livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      const onClose = vi.fn();
      const handle = attachRelay({ ...opts, onClose });
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      await redis.publish(keys.metaout, JSON.stringify({ t: ROOM_REJECT_FRAME, pid: 'p1', c: 12345 }));
      await redis.publish(keys.metaout, JSON.stringify({ t: ROOM_REJECT_FRAME, pid: 'p1', c: { nested: true } }));

      expect(socket.sent).toHaveLength(0);
      expect(socket.closed).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();
      handle.close();
    });

    it('caps the ping prefix test at the same size on a string as on a buffer', async () => {
      // One wire, one answer: the same 128 bytes must mean the same thing
      // whether the transport hands over a string or a Buffer, and a
      // megabyte that merely BEGINS like a ping must not be parsed at all.
      const { socket, decodeInput, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      const huge = `{"t":"ping","n":1,"c":2,"pad":"${'x'.repeat(1_000_000)}"}`;
      socket.fire('message', huge);

      expect(socket.sent).toHaveLength(0); // never answered
      expect(decodeInput).toHaveBeenCalledTimes(1); // handed to the host, like any other oversized frame
      handle.close();
    });

    it('seeds a roster entry whose pid is __proto__ instead of silently losing it', async () => {
      // `map[k] = v` on an object literal with k of `__proto__` REPARENTS the
      // object rather than adding a property, so that player vanished from
      // the seed while the ticker's own broadcast (built with
      // `Object.fromEntries`) still carried them: two halves of one roster
      // disagreeing, which is the failure `metaSeedPayload` exists to
      // prevent.
      const { redis, socket, opts } = baseOptions({ livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      await redis.hset(keys.meta, 'p2', JSON.stringify({ name: 'Alice' }));
      await redis.hset(keys.meta, '__proto__', JSON.stringify({ name: 'Mallory' }));

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 15));
      handle.close();

      const seeds = socket.sent
        .filter((f): f is string => typeof f === 'string')
        .map((f) => JSON.parse(f) as { t?: string; map?: Record<string, unknown> })
        .filter((f) => f.t === SERVER_FRAMES.meta);
      expect(seeds.length).toBeGreaterThan(0);
      for (const seed of seeds) {
        expect(Object.keys(seed.map ?? {}).sort()).toEqual(['__proto__', 'p2']);
      }
    });

    it('skips a roster value that is not a plain object rather than handing it to a host formatter', async () => {
      const { redis, socket, opts } = baseOptions({ livenessTimeoutMs: 10_000 });
      const keys = roomKeys('r1', NS);
      await redis.hset(keys.meta, 'p2', JSON.stringify({ name: 'Alice' }));
      await redis.hset(keys.meta, 'scalar', JSON.stringify('just a string'));
      await redis.hset(keys.meta, 'arr', JSON.stringify([1, 2]));
      await redis.hset(keys.meta, 'nul', JSON.stringify(null));

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 15));
      handle.close();

      const seeds = socket.sent
        .filter((f): f is string => typeof f === 'string')
        .map((f) => JSON.parse(f) as { t?: string; map?: Record<string, unknown> })
        .filter((f) => f.t === SERVER_FRAMES.meta);
      expect(seeds.length).toBeGreaterThan(0);
      for (const seed of seeds) {
        expect(Object.keys(seed.map ?? {})).toEqual(['p2']);
      }
    });
  });

  // -------------------------------------------------------------------------
  // THE GUARDS A MUTATION SWEEP FOUND UNPINNED. Each case below was written
  // against a named mutation of the guard it covers and watched to redden
  // with that mutation applied.
  // -------------------------------------------------------------------------
  describe('the ping prefix test is bounded on every arm', () => {
    // Valid JSON, really beginning with the ping prefix, and 200 bytes long,
    // so the ONLY thing between it and `JSON.parse` plus a pong is the size
    // bound. The length is asserted rather than assumed: a frame that drifted
    // under 128 bytes would make this case pass for the wrong reason.
    const oversizedPing = `{"t":"ping","n":1,"c":2,"pad":"${'x'.repeat(167)}"}`;

    it('a 200-byte frame beginning with the ping prefix is NOT intercepted and reaches decodeInput', async () => {
      expect(oversizedPing.length).toBe(200);
      const { socket, decodeInput, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      // ONE WIRE, ONE ANSWER. A browser-style transport hands text over as a
      // string and `ws` hands the identical bytes over as a Buffer, so the
      // same 200 bytes must mean the same thing on both arms: an oversized
      // frame is the host's to decode, not this file's to parse.
      socket.fire('message', oversizedPing);
      socket.fire('message', Buffer.from(oversizedPing, 'utf8'));

      expect(socket.sent).toHaveLength(0); // never answered on either arm
      expect(decodeInput).toHaveBeenCalledTimes(2);
      handle.close();
    });

    it('CONTROL: the same frame inside the bound is still answered on both arms', async () => {
      const { socket, decodeInput, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      socket.fire('message', encodePing(1, 2));
      socket.fire('message', Buffer.from(encodePing(3, 4), 'utf8'));

      expect(socket.sent).toEqual([encodePong(1, 2), encodePong(3, 4)]);
      expect(decodeInput).not.toHaveBeenCalled();
      handle.close();
    });

    it('a fragmented frame containing a non-buffer part is not treated as a ping', async () => {
      // `ws` delivers a fragmented message as an array of Buffers. A part that
      // is not one came from a transport this file has never seen, and
      // `Buffer.concat` THROWS on it, inside a `message` handler with no
      // caller left to catch: the socket's whole event dispatch unwinds. The
      // part check is what makes an unrecognised shape fall through to the
      // host's decoder like any other frame.
      const { socket, decodeInput, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;

      socket.fire('message', [Buffer.from('{"t":"ping","n":1,'), '"c":2}']);

      expect(socket.sent).toHaveLength(0);
      expect(decodeInput).toHaveBeenCalledTimes(1);
      handle.close();
    });
  });

  describe('the session starts once, however many times the socket says it opened', () => {
    it('a socket that fires open twice publishes one join and starts one heartbeat', async () => {
      const { redis, socket, opts } = baseOptions({ livenessTimeoutMs: 10_000 });
      const joins = joinEnvelopesOn(redis, roomKeys('r1', NS).in);
      socket.readyState = 0; // CONNECTING: everything waits on the event
      const armed = vi.spyOn(globalThis, 'setInterval');
      const handle = attachRelay(opts);

      socket.readyState = 1;
      socket.fire('open');
      socket.fire('open'); // a transport that repeats it, or a reconnect that re-emits
      const heartbeats = armed.mock.calls.length;
      armed.mockRestore();

      // Both halves matter and they fail differently. A second join is a
      // duplicate the ticker absorbs; a second heartbeat is a timer nobody
      // holds a handle to, so it survives `cleanup`, keeps republishing this
      // player's join, and keeps a departed player in the room for good.
      expect(joins.filter((e) => e.t === 'join')).toHaveLength(1);
      expect(heartbeats).toBe(1);
      handle.close();
    });
  });

  describe('an empty decode is not traffic', () => {
    it('a frame decoding to zero records publishes nothing to keys.in', async () => {
      let records: ClientInput[] = [];
      const { redis, socket, opts } = baseOptions({
        decodeInput: () => records,
        inboundCapacity: 100,
        livenessTimeoutMs: 10_000,
      });
      const keys = roomKeys('r1', NS);
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      const seen = joinEnvelopesOn(redis, keys.in);
      const frame = Buffer.from(JSON.stringify({ t: 'move' }), 'utf8');

      // A decoder legitimately returns nothing for a frame that carried no
      // applicable records. Publishing `w: []` for it costs a Redis round trip
      // and a wakeup per socket per frame, at the client's own rate, for an
      // envelope the ticker iterates zero times.
      socket.fire('message', frame);
      await new Promise((r) => setTimeout(r, 5));
      expect(seen.filter((e) => e.t === 'in')).toHaveLength(0);

      // CONTROL: the same frame with one record in it does publish, so the
      // case above is not passing on a relay that had stopped forwarding.
      records = [{ seq: 1, data: 1 }];
      socket.fire('message', frame);
      await new Promise((r) => setTimeout(r, 5));
      expect(seen.filter((e) => e.t === 'in')).toHaveLength(1);
      handle.close();
    });
  });

  describe('the send-failure run ends the socket exactly once', () => {
    it('a send failure after cleanup does not terminate twice', async () => {
      const { socket, opts } = baseOptions({ inboundCapacity: 100, livenessTimeoutMs: 10_000 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 10));
      socket.sent.length = 0;
      socket.send = (): void => {
        throw new Error('the peer is gone');
      };

      // SEND_FAILURE_LIMIT refused sends in a row is the run that ends the
      // socket: a transport refusing three in a row is not one having a bad
      // moment.
      for (let i = 0; i < 3; i++) socket.fire('message', encodePing(i, 0));
      expect(socket.terminated).toBe(1);

      // Everything the peer had already queued still arrives afterwards, and
      // the run is already past the limit, so each of these would terminate
      // again on a conclusion that has already been reached and acted on.
      for (let i = 0; i < 5; i++) socket.fire('message', encodePing(10 + i, 0));
      expect(socket.terminated).toBe(1);
      handle.close();
    });

    it('exactly at the liveness deadline is still alive', async () => {
      // The deadline is `> livenessTimeoutMs`, and a `>=` looks exactly as
      // right. On the real clock the two differ by one millisecond of jitter
      // between a heartbeat and the timeout it is measured against, which is
      // not a difference a test can hold; on the virtual clock the beat lands
      // on the deadline exactly. A socket silent for precisely the timeout has
      // not yet exceeded it, and terminating it is a live player dropped for
      // arriving on time.
      vi.useFakeTimers();
      try {
        const { socket, opts } = baseOptions({ heartbeatMs: 50, livenessTimeoutMs: 50 });
        const handle = attachRelay(opts);

        await vi.advanceTimersByTimeAsync(50);
        expect(socket.terminated).toBe(0);

        // CONTROL: one beat further on it really is past the deadline.
        await vi.advanceTimersByTimeAsync(50);
        expect(socket.terminated).toBe(1);
        handle.close();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // The arithmetic nobody had done: Chromium throttles `setInterval` in a tab
  // hidden past five minutes to ONCE A MINUTE, so a client pinging on
  // `PING_INTERVAL_MS` (2000) sends one frame every 60s and `frame()` stops
  // with rAF. Against the old 45000 default that is a guaranteed reap of a
  // perfectly healthy socket, and the only thing covering it was an OPTIONAL
  // `ping()` that no-ops in silence when a transport lacks it.
  describe('a backgrounded tab is not a dead socket', () => {
    it('the default deadline clears one throttled client ping interval with slack', async () => {
      // 60000 is the throttled cadence, whatever `PING_INTERVAL_MS` is set
      // to: the browser, not the client, chooses it once the tab is hidden.
      const throttledPingIntervalMs = 60_000;
      expect(PING_INTERVAL_MS).toBeLessThan(throttledPingIntervalMs);
      expect(DEFAULT_LIVENESS_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
      expect(DEFAULT_LIVENESS_TIMEOUT_MS).toBeGreaterThan(throttledPingIntervalMs * 1.25);
    });

    // FAKE TIMERS FOR THE PAIR, and the conversion loses nothing: the whole
    // claim is a RATIO (the deadline against the client's frame gap), and the
    // relay reads its deadline off `Date.now()`, which vitest fakes with the
    // timers. On real timers the 60ms sender only clears the 90ms deadline
    // while the host delivers its intervals roughly on time; a loaded machine
    // slips that interval past 90ms and reaps a socket the test asserts is
    // healthy, so the real-timer spelling measured the machine rather than
    // the default. The virtual clock fires both intervals exactly.
    it('never reaps a socket sending one frame per throttled interval', async () => {
      // The same ratio as the real thing (deadline 1.5x the client's frame
      // gap), scaled by a thousand so it runs in a test rather than in two
      // minutes.
      vi.useFakeTimers();
      try {
        const { socket, opts } = baseOptions({ heartbeatMs: 10, livenessTimeoutMs: 90 });
        const handle = attachRelay(opts);
        await vi.advanceTimersByTimeAsync(5); // let the join settle first
        const throttled = setInterval(() => socket.fire('message', new ArrayBuffer(0), false), 60);
        await vi.advanceTimersByTimeAsync(300);
        clearInterval(throttled);

        expect(socket.terminated).toBe(0);
        handle.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('CONTRAST: the same client at the old 45s default is reaped mid-session', async () => {
      // Without this the case above would pass just as well against a relay
      // that had stopped checking liveness at all, and it is the measurement
      // that makes the default a decision rather than a number.
      vi.useFakeTimers();
      try {
        const { socket, opts } = baseOptions({ heartbeatMs: 10, livenessTimeoutMs: 45 });
        const handle = attachRelay(opts);
        await vi.advanceTimersByTimeAsync(5);
        const throttled = setInterval(() => socket.fire('message', new ArrayBuffer(0), false), 60);
        await vi.advanceTimersByTimeAsync(300);
        clearInterval(throttled);

        expect(socket.terminated).toBeGreaterThan(0);
        handle.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('warns once, and says what it costs, when the transport exposes no ping()', async () => {
      // Both shipped adapters cast whatever the platform handed them
      // (`ws as RelaySocket`) with no shape check, and `socket.ping?.()`
      // no-ops in silence, so this was invisible until a reap.
      const log = vi.fn();
      const { socket, opts } = baseOptions({ log, livenessTimeoutMs: 10_000, heartbeatMs: 20 });
      (socket as { ping?: unknown }).ping = undefined;

      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 120)); // several heartbeats

      const lines = log.mock.calls.filter((c) => c[0]?.kind === 'relay.no-ping');
      expect(lines).toHaveLength(1); // once at attach, not once a beat
      expect(lines[0][0].lvl).toBe('warn');
      expect(String(lines[0][0].msg)).toContain('backgrounded');
      expect(handle.transportPings).toBe(false);
      handle.close();
    });

    it('says nothing, and reports true, for a transport that does ping', async () => {
      const log = vi.fn();
      const { opts } = baseOptions({ log, livenessTimeoutMs: 10_000, heartbeatMs: 20 });
      const handle = attachRelay(opts);
      await new Promise((r) => setTimeout(r, 120));

      expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.no-ping')).toHaveLength(0);
      expect(handle.transportPings).toBe(true);
      handle.close();
    });
  });
});

// ---------------------------------------------------------------------------
// checkAdmission READS THE REPLY REDIS ACTUALLY SENDS, and both cases below
// are about what it does with an answer it did not expect: the wrong TYPE for
// a reply it understands, and a value it cannot parse at all. Both fail toward
// admitting, because refusing a legitimate player is the worse error in a
// protocol whose whole job is to let people into a room.
// ---------------------------------------------------------------------------
describe('checkAdmission against replies it did not expect', () => {
  /** Answers HEXISTS with the STRING '1'/'0', which is what a raw-protocol client hands back where ioredis hands back a number. */
  class StringHexistsRedis extends FakeRedis {
    override async hexists(key: string, field: string): Promise<number> {
      const present = await super.hexists(key, field);
      return (present === 1 ? '1' : '0') as unknown as number;
    }
  }

  it('a HEXISTS reply of the string 1 is recognised as a rejoin', async () => {
    const redis = new StringHexistsRedis();
    const keys = roomKeys('r1', NS);
    await redis.set(keys.stats, JSON.stringify({ players: 20 }));
    await redis.hset(keys.meta, 'existing-pid', JSON.stringify({ name: 'Alice' }));

    // Read as "not present", a rejoin is refused at capacity, which is the one
    // case a rejoin must always win: the player is ALREADY in the simulation
    // and their socket died, so refusing them locks them out of a room they
    // are still occupying a slot in.
    const rejoin = await checkAdmission({
      redis,
      roomId: 'r1',
      pid: 'existing-pid',
      subject: 'd.abc',
      maxPlayers: 20,
      namespace: NS,
    });
    expect(rejoin.admit).toBe(true);

    // CONTROL: a pid that genuinely is not in the roster is still refused, so
    // the case above is not simply a fake that admits everybody.
    const stranger = await checkAdmission({
      redis,
      roomId: 'r1',
      pid: 'newcomer',
      subject: 'd.new',
      maxPlayers: 20,
      namespace: NS,
    });
    expect(stranger).toMatchObject({ admit: false, reason: 'full' });
  });

  it('corrupt stats JSON admits, reading as an empty room rather than refusing', async () => {
    const redis = new FakeRedis();
    const keys = roomKeys('r1', NS);
    // A truncated write, a key reused by something else, a half-finished
    // rolling deploy. The stats key is a CACHE of a number the ticker
    // republishes every window, so an unreadable one is a momentary gap in
    // telemetry; refusing on it turns that gap into a room nobody can enter.
    await redis.set(keys.stats, '{"players": 3');

    const result = await checkAdmission({
      redis,
      roomId: 'r1',
      pid: 'newcomer',
      subject: 'd.abc',
      maxPlayers: 20,
      namespace: NS,
    });

    expect(result.admit).toBe(true);
    // ...through the ORDINARY path, not the pipeline's own fail-open catch. A
    // corrupt value is a read that SUCCEEDED, so the per-subject socket cap
    // was really applied to this admission rather than skipped.
    expect(result.socketCapEvaluated).toBe(true);
  });
});
