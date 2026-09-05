// B11. The admission-register-refuse sequence used to live in
// `adapters/vercel.ts`, be imported from there by the node adapter, and be
// hand-copied into the example: three copies of a protocol whose close codes
// the CLIENT latches its terminal reconnect states off. These cases pin the
// one implementation, and in particular the two failures the copies were
// free to make independently: refusing without the frame the client reads,
// and admitting without ever registering the connection the per-subject cap
// counts.
import { describe, it, expect, vi } from 'vitest';
import { CLOSE_CODES, SERVER_FRAMES, roomKeys, type RoomEnvelope } from '../core/index.js';
import { FakeRedis } from './testFakeRedis.js';
import { admitSocket, refuseSocket, registerConnection, CONN_KEY_TTL_S, CONN_TOUCH_MS } from './admission.js';
import { DEFAULT_CONN_STALE_MS, type RelaySocket } from './relay.js';

const NS = 'test';
const CONN_KEY = `${NS}:conns:d.abc`;

/** The same minimal `RelaySocket` double `relay.test.ts` uses, kept local so neither file's assertions can drift the other's. */
class MockSocket implements RelaySocket {
  readyState = 1;
  sent: (string | Uint8Array | Buffer)[] = [];
  closed: number[] = [];
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string | Uint8Array | Buffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed.push(code ?? 0);
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

function baseOptions(redis: FakeRedis, socket: MockSocket, overrides: Record<string, unknown> = {}) {
  return {
    socket,
    redis,
    createSubscriber: () => redis.fork(),
    roomId: 'r1',
    pid: 'p1',
    subject: 'd.abc',
    namespace: NS,
    maxPlayers: 20,
    relay: {
      decodeInput: () => [],
      spawnTicker: vi.fn().mockResolvedValue(undefined),
      heartbeatMs: 10_000,
      tickerCheckMs: 10_000,
      tickerCheckJitterMs: 0,
      livenessTimeoutMs: 10_000,
    },
    ...overrides,
  };
}

function envelopesOn(redis: FakeRedis, channel: string): RoomEnvelope[] {
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

describe('admitSocket', () => {
  it('admits: registers the connection and attaches the relay', async () => {
    const redis = new FakeRedis();
    const socket = new MockSocket();
    const keys = roomKeys('r1', NS);
    const seen = envelopesOn(redis, keys.in);

    const handle = await admitSocket(baseOptions(redis, socket));
    await new Promise((r) => setTimeout(r, 10));

    expect(handle).not.toBeNull();
    expect(await redis.zcard(CONN_KEY)).toBe(1); // the cap counts what it was told about
    expect(seen.filter((e) => e.t === 'join').length).toBeGreaterThan(0);
    handle?.close();
  });

  it('refuses a full room with the room-full frame and the capacity code, and registers nothing', async () => {
    // THE FAILURE THIS PINS IS SILENT IN BOTH DIRECTIONS: a registration on
    // a refused socket is a slot nobody ever frees, and `checkAdmission` is
    // deliberately a query so that it never has to be undone.
    const redis = new FakeRedis();
    const socket = new MockSocket();
    await redis.set(roomKeys('r1', NS).stats, JSON.stringify({ players: 20 }));

    const handle = await admitSocket(baseOptions(redis, socket));

    expect(handle).toBeNull();
    expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.roomFull })]);
    expect(socket.closed).toEqual([CLOSE_CODES.capacity]);
    expect(await redis.zcard(CONN_KEY)).toBe(0);
  });

  it('refuses past the per-subject socket cap with its own frame and code', async () => {
    const redis = new FakeRedis();
    const socket = new MockSocket();
    await redis.set(roomKeys('r1', NS).stats, JSON.stringify({ players: 1 }));
    for (let i = 0; i < 6; i++) await redis.zadd(CONN_KEY, Date.now(), `conn-${i}`);

    const handle = await admitSocket(baseOptions(redis, socket, { maxSocketsPerSubject: 6 }));

    expect(handle).toBeNull();
    expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.connLimit })]);
    expect(socket.closed).toEqual([CLOSE_CODES.connLimit]);
    expect(await redis.zcard(CONN_KEY)).toBe(6); // the refused socket added nothing of its own
  });

  it('publishes no join for a refused socket', async () => {
    // The other half of "registers nothing": a refusal must not put the
    // player in the room the check just said they could not enter.
    const redis = new FakeRedis();
    const socket = new MockSocket();
    await redis.set(roomKeys('r1', NS).stats, JSON.stringify({ players: 20 }));
    const seen = envelopesOn(redis, roomKeys('r1', NS).in);

    await admitSocket(baseOptions(redis, socket));
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toHaveLength(0);
  });

  it('warns when the socket cap could not be evaluated, and still admits', async () => {
    // Fail OPEN, never silently: refusing during a Redis blip locks users
    // out of a healthy deployment, so the run of warnings is the only signal
    // an operator gets that the cap is not enforcing anything.
    const redis = new FakeRedis();
    const socket = new MockSocket();
    redis.break('zcard');
    const log = vi.fn();

    const handle = await admitSocket(baseOptions(redis, socket, { log }));
    await new Promise((r) => setTimeout(r, 10));

    expect(handle).not.toBeNull();
    const lines = log.mock.calls.filter((c) => c[0]?.kind === 'relay.socket-cap-unevaluated');
    expect(lines).toHaveLength(1);
    expect(lines[0][0].lvl).toBe('warn');
    handle?.close();
  });

  it('stops the registration when the relay closes, and still calls the host onClose', async () => {
    // The pair that used to be the caller's to remember: an admitted
    // socket's slot is freed by the same event that ends the relay.
    const redis = new FakeRedis();
    const socket = new MockSocket();
    const onClose = vi.fn();

    const handle = await admitSocket(
      baseOptions(redis, socket, { relay: { ...baseOptions(redis, socket).relay, onClose } })
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(await redis.zcard(CONN_KEY)).toBe(1);

    handle?.close();
    await new Promise((r) => setTimeout(r, 10));

    expect(await redis.zcard(CONN_KEY)).toBe(0);
    expect(onClose).toHaveBeenCalledWith(1000);
  });

  it('forwards the whole relay option bag rather than a hand-copied subset', async () => {
    // The reason `relay` is one field: every option added to `RelayOptions`
    // is reachable through every host the day it lands, with nothing to
    // remember to thread through.
    const redis = new FakeRedis();
    const socket = new MockSocket();
    await redis.hset(roomKeys('r1', NS).meta, 'p2', JSON.stringify({ name: 'Alice' }));
    const metaSeedPayload = vi.fn(() => ({ t: 'roster', players: ['Alice'] }));

    const handle = await admitSocket(
      baseOptions(redis, socket, { relay: { ...baseOptions(redis, socket).relay, metaSeedPayload } })
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(metaSeedPayload).toHaveBeenCalled();
    expect(socket.sent).toContain(JSON.stringify({ t: 'roster', players: ['Alice'] }));
    handle?.close();
  });
});

describe('admitSocket failure paths', () => {
  it('unregisters the connection when attachRelay throws, rather than leaking a cap slot', async () => {
    // Measured with the first-deploy misconfiguration: `createSubscriber`
    // throws synchronously when REDIS_URL is unset, so every attempt burned
    // a slot that only ages out after `connStaleMs` while every attempt also
    // failed. The registration is written BEFORE the relay is built, so
    // nothing else can free it.
    const redis = new FakeRedis();
    const socket = new MockSocket();
    const boom = new Error('REDIS_URL is not set (and no url was passed)');

    await expect(
      admitSocket(
        baseOptions(redis, socket, {
          createSubscriber: () => {
            throw boom;
          },
        })
      )
    ).rejects.toThrow('REDIS_URL is not set');

    await new Promise((r) => setTimeout(r, 10));
    expect(await redis.zcard(CONN_KEY)).toBe(0);
  });
});

describe('registerConnection', () => {
  /** Records the registry writes as they are ISSUED, so a case can assert on the commands and not only on what the store happens to hold afterwards. */
  class RecordingRedis extends FakeRedis {
    zadds: string[] = [];
    expires: Array<[string, number]> = [];

    override async zadd(key: string, score: number, member: string): Promise<unknown> {
      this.zadds.push(member);
      return super.zadd(key, score, member);
    }

    override async expire(key: string, seconds: number): Promise<number> {
      this.expires.push([key, seconds]);
      return super.expire(key, seconds);
    }
  }

  it('scores the member and expires the key immediately, then removes it on stop', async () => {
    // ON THE VIRTUAL CLOCK, because half of what this pins is what happens
    // over the twenty seconds AFTER `stop`, and that is not twenty seconds a
    // test may spend. `zcard` alone could see neither half: the EXPIRE leaves
    // no trace in a member count, and a leaked touch interval re-adds the
    // member so quietly that the ZREM still looks like it worked.
    vi.useFakeTimers();
    try {
      const redis = new RecordingRedis();
      const stop = registerConnection(redis, CONN_KEY, 'conn-1');
      await vi.advanceTimersByTimeAsync(5);
      expect(await redis.zcard(CONN_KEY)).toBe(1);
      // Without the EXPIRE the connection set has no expiry of its own, so a
      // process that dies without ever reaching `stop` leaves its members
      // counting against `maxSocketsPerSubject` for as long as Redis keeps the
      // key, which is forever.
      expect(redis.expires).toEqual([[CONN_KEY, CONN_KEY_TTL_S]]);

      // Re-scored on the touch cadence, which is what keeps a live socket from
      // reading as stale to `checkAdmission`'s own pruning pass.
      await vi.advanceTimersByTimeAsync(CONN_TOUCH_MS);
      expect(redis.zadds).toEqual(['conn-1', 'conn-1']);

      stop();
      await vi.advanceTimersByTimeAsync(5);
      expect(await redis.zcard(CONN_KEY)).toBe(0);

      // AND THE INTERVAL IS GONE, over two whole touch periods. A `stop` that
      // only ZREMs leaves a timer nobody holds a handle to re-adding the
      // member every ten seconds, so a socket that closed cleanly goes on
      // costing its subject a cap slot for the life of the process and the
      // ZREM above still reads as if it had worked.
      await vi.advanceTimersByTimeAsync(2 * CONN_TOUCH_MS);
      expect(redis.zadds).toEqual(['conn-1', 'conn-1']);
      expect(await redis.zcard(CONN_KEY)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps its constants well inside the staleness window they have to survive', async () => {
    // BOTH HALVES OF THE ARGUMENT THE DOC COMMENT MAKES, read from the real
    // constants rather than from copies of them. The touch cadence has to
    // re-score a live socket several times over inside `connStaleMs`, or
    // `checkAdmission`'s prune reaps a connection that is still up and the
    // cap starts refusing legitimate reconnects; the key TTL has to outlast
    // several missed touches, or the whole registration evaporates under a
    // couple of dropped round trips. Asserting only the TTL left the cadence,
    // which is the half a tuning change would actually touch, pinned by
    // nothing.
    expect(CONN_TOUCH_MS).toBeLessThan(DEFAULT_CONN_STALE_MS / 2);
    expect(CONN_KEY_TTL_S * 1000).toBeGreaterThan(DEFAULT_CONN_STALE_MS);
    expect(CONN_KEY_TTL_S * 1000).toBeGreaterThan(CONN_TOUCH_MS * 5);
  });
});

describe('refuseSocket', () => {
  it('refuses on the socket own open event, without waiting out the retry timer', async () => {
    // THE HALF THAT WAS MISSING. Both attempts were gated on OPEN and there
    // were exactly two of them, so a handshake that completed at 300ms was
    // never refused at all: the socket sat connected and unrefused until the
    // platform's duration cap, in the one state the retry was written for.
    const socket = new MockSocket();
    socket.readyState = 0;

    refuseSocket(socket, 'full');
    expect(socket.sent).toHaveLength(0);
    expect(socket.closed).toHaveLength(0);

    socket.readyState = 1;
    socket.fire('open');

    // Immediately, on the event itself, not 250ms later.
    expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.roomFull })]);
    expect(socket.closed).toEqual([CLOSE_CODES.capacity]);

    // ...and the timer that follows must not send a second frame down a
    // socket that already has one.
    await new Promise((r) => setTimeout(r, 300));
    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toHaveLength(1);
  });

  it('retries on the timer for a transport that emits no open event', async () => {
    // The backstop, still load bearing: nothing in `RelaySocket` promises an
    // 'open' event, and a socket that reaches OPEN without announcing it
    // must still be refused.
    const socket = new MockSocket();
    socket.readyState = 0;

    refuseSocket(socket, 'full');
    socket.readyState = 1; // opened quietly, no event
    await new Promise((r) => setTimeout(r, 300));

    expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.roomFull })]);
    expect(socket.closed).toEqual([CLOSE_CODES.capacity]);
  });

  it('closes a socket that never opens at all, even though the frame cannot be sent', async () => {
    // `ws` accepts close() from CONNECTING (it aborts the handshake). The
    // client loses the CODE on this path, which is a real cost and still
    // strictly better than losing the refusal: a client that reconnects is
    // bounded by its own ladder, a socket nobody ever closed is bounded by
    // nothing.
    const socket = new MockSocket();
    socket.readyState = 0;

    refuseSocket(socket, 'conn-limit');
    await new Promise((r) => setTimeout(r, 300));

    expect(socket.sent).toHaveLength(0);
    expect(socket.closed).toEqual([CLOSE_CODES.connLimit]);
  });

  it('a socket with no on() at all is still refused', async () => {
    // `RelaySocket.on` is on the interface, but this runs against whatever a
    // host actually handed the adapter, and a refusal must never turn into a
    // TypeError that takes the route down.
    const socket = new MockSocket();
    (socket as { on?: unknown }).on = undefined;
    refuseSocket(socket, 'full');
    expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.roomFull })]);
    expect(socket.closed).toEqual([CLOSE_CODES.capacity]);
  });

  it('CLOSES a socket whose send throws, rather than treating the failed frame as a completed refusal', () => {
    // THE FRAME IS BEST EFFORT, THE CLOSE IS THE REFUSAL. A single latch set
    // before the send (or by the catch around it) made a throwing send look
    // like a finished refusal, so the socket stayed OPEN, unrefused and with
    // no relay attached to it: measured as close codes `[]` after 320ms,
    // through the immediate attempt and the 'open' listener alike. Asserting
    // only that the call does not throw, which is what this case used to do,
    // cannot see any of that.
    const socket = new MockSocket();
    socket.send = () => {
      throw new Error('socket already gone');
    };
    expect(() => refuseSocket(socket, 'conn-limit')).not.toThrow();
    expect(socket.closed).toEqual([CLOSE_CODES.connLimit]);
  });

  it('closes a late-opening socket whose send throws, on the open event', async () => {
    // The same split, reached through the other door: the frame is lost and
    // the code still lands, without waiting out the backstop.
    const socket = new MockSocket();
    socket.readyState = 0;
    socket.send = () => {
      throw new Error('socket already gone');
    };

    refuseSocket(socket, 'full');
    expect(socket.closed).toHaveLength(0);

    socket.readyState = 1;
    socket.fire('open');
    expect(socket.closed).toEqual([CLOSE_CODES.capacity]);

    await new Promise((r) => setTimeout(r, 300));
    expect(socket.closed).toHaveLength(1); // and the backstop adds no second close
  });
});
