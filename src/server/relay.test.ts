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
});
