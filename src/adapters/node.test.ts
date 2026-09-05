// The node adapter is the proof that the architecture is not platform
// specific, which means the thing worth testing about it is that it reaches
// for THE SAME functions the Vercel route does rather than a lookalike of its
// own. It used to hand-roll the admission sequence and import
// `registerConnection` FROM `./vercel.js` to do it, so one adapter depended on
// another platform's adapter and the close codes the CLIENT latches a terminal
// reconnect state off were written out twice, free to drift, with no gate able
// to see it.
//
// `getRedis` and `createSubscriber` are stubbed onto a fake Redis (nothing
// here may open a real ioredis connection). `admitSocket` is stubbed only for
// the group that asserts on the OPTIONS BAG; the refusal group runs the real
// one, because "refuses with the shared codes" is a claim about two modules
// agreeing and a stub can only assert about itself.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  createSubscriber: vi.fn(),
  runTicker: vi.fn(),
  admitSocket: vi.fn(),
  real: { admitSocket: null as unknown as typeof import('../server/index.js')['admitSocket'] },
}));

vi.mock('../server/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/index.js')>();
  mocks.real.admitSocket = actual.admitSocket;
  return {
    ...actual,
    getRedis: mocks.getRedis,
    createSubscriber: mocks.createSubscriber,
    runTicker: mocks.runTicker,
    admitSocket: mocks.admitSocket,
  };
});

/* eslint-disable import/first */
import { CLOSE_CODES, SERVER_FRAMES, roomKeys } from '../core/index.js';
import { makeToken, type RelaySocket } from '../server/index.js';
import { FakeRedis } from '../server/testFakeRedis.js';
import { attachNodeRelay, runNodeTicker, type NodeRelayServerOptions } from './node.js';
/* eslint-enable import/first */

const SECRET = 'test-secret';

/** A minimal `RelaySocket` double, the same shape `relay.test.ts` uses. */
class MockSocket implements RelaySocket {
  readyState = 1;
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

/**
 * Stands in for a `ws` `WebSocketServer`. `attachNodeRelay` takes `wss`
 * untyped by injection precisely so `ws` never has to be a dependency of this
 * package, and this is the other end of that seam.
 */
class FakeWss {
  private handlers: Array<(ws: unknown, req: unknown) => unknown> = [];
  on(ev: string, cb: (ws: unknown, req: unknown) => unknown): void {
    if (ev === 'connection') this.handlers.push(cb);
  }
  /** Fires a connection and AWAITS the handler, which is async. */
  async connect(ws: unknown, url: string): Promise<void> {
    for (const cb of this.handlers) await cb(ws, { url });
  }
}

function connectUrl(query: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    room: 'lobby',
    pid: 'p1',
    h: '7',
    token: makeToken({ pid: 'p1', handle: 7, sub: 'd.abc' }, { secret: SECRET }),
    ...query,
  });
  return `/ws?${params.toString()}`;
}

function baseOpts(extra: Partial<NodeRelayServerOptions> = {}): NodeRelayServerOptions {
  const base: NodeRelayServerOptions = {
    secret: SECRET,
    isValidBase: (b) => b === 'lobby',
    fallbackRoom: 'lobby',
    maxPlayers: 20,
    decodeInput: () => [],
    spawnTicker: async () => {},
  };
  return { ...base, ...extra };
}

describe('attachNodeRelay', () => {
  beforeEach(() => {
    mocks.admitSocket.mockReset();
    mocks.admitSocket.mockResolvedValue(null);
    mocks.getRedis.mockReset();
    mocks.getRedis.mockReturnValue({});
    mocks.createSubscriber.mockReset();
  });

  it('SPREADS every host relay option through to admitSocket, rather than copying a subset', async () => {
    // The node adapter derives its option type from the Vercel one, which
    // derives from `HostRelayOptions`, so an option added to `RelayOptions`
    // is reachable from both adapters on the day it lands. This is what pins
    // that the derivation is real and not just a type-level claim.
    const metaSeedPayload = (map: Record<string, unknown>): unknown => ({ t: 'roster', players: Object.keys(map) });
    const onRateDrop = vi.fn();
    const spawnTicker = vi.fn().mockResolvedValue(undefined);
    const joinMeta = vi.fn().mockReturnValue({ name: 'Alice' });

    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts({
      metaSeedPayload,
      onRateDrop,
      spawnTicker,
      joinMeta,
      connNamespace: 'legacy',
      maxSocketsPerSubject: 3,
    }));
    await wss.connect(new MockSocket(), connectUrl({ n: 'Alice' }));

    const passed = mocks.admitSocket.mock.calls[0]?.[0];
    expect(passed.relay.metaSeedPayload).toBe(metaSeedPayload);
    expect(passed.relay.onRateDrop).toBe(onRateDrop);
    expect(passed.relay.spawnTicker).toBe(spawnTicker);
    expect(passed.relay.joinMeta).toEqual({ name: 'Alice' });
    expect(passed.connNamespace).toBe('legacy');
    expect(passed.maxSocketsPerSubject).toBe(3);
    expect(passed).toMatchObject({ roomId: 'lobby', pid: 'p1', subject: 'd.abc' });
  });

  it('WARNS ONCE when a well-formed room id was refused and replaced by the fallback', async () => {
    // Same silent mismatch as the Vercel route, same reason it matters: with
    // maxRooms disagreeing between the balancer and the relay, `lobby~7` is a
    // legal id that quietly becomes `lobby`, and the client's session then
    // names a room its snapshots do not come from.
    const log = vi.fn();
    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts({ log, maxRooms: 4 }));
    await wss.connect(new MockSocket(), connectUrl({ room: 'lobby~7' }));

    const warns = log.mock.calls.filter((c) => c[0]?.kind === 'relay.room-normalised');
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ lvl: 'warn', room: 'lobby', meta: { raw: 'lobby~7' } });
    expect(mocks.admitSocket.mock.calls[0]?.[0].roomId).toBe('lobby');
  });

  it('does NOT warn on an accepted id, truncates the raw one, and never warns for a refused token', async () => {
    // Without the first half this would pass against an adapter that warned on
    // every connection. The raw value is untrusted input on a log line, so it
    // is evidence rather than a payload, and the warn sits behind the token
    // check so its rate is not an anonymous caller's to drive.
    const log = vi.fn();
    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts({ log, maxRooms: 50 }));
    await wss.connect(new MockSocket(), connectUrl({ room: 'lobby~7' }));
    expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.room-normalised')).toHaveLength(0);

    const long = 'x'.repeat(200);
    await wss.connect(new MockSocket(), connectUrl({ room: long }));
    const warns = log.mock.calls.filter((c) => c[0]?.kind === 'relay.room-normalised');
    expect(warns).toHaveLength(1);
    expect(String(warns[0][0].meta.raw)).toHaveLength(64);

    const log2 = vi.fn();
    const wss2 = new FakeWss();
    attachNodeRelay(wss2, baseOpts({ log: log2 }));
    await wss2.connect(new MockSocket(), `/ws?room=${long}&pid=p1&h=7&token=nonsense`);
    expect(log2).not.toHaveBeenCalled();
  });

  it('passes NO lifetimeMs by default, because a long-lived process has no duration cap', async () => {
    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts());
    await wss.connect(new MockSocket(), connectUrl());
    expect(mocks.admitSocket.mock.calls[0]?.[0].relay.lifetimeMs).toBeUndefined();
  });

  it('but a host that sets lifetimeMs still gets it, for a scheduled rolling restart', async () => {
    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts({ lifetimeMs: 60_000 }));
    await wss.connect(new MockSocket(), connectUrl());
    expect(mocks.admitSocket.mock.calls[0]?.[0].relay.lifetimeMs).toBe(60_000);
  });

  it('a THROW out of admitSocket never escapes the connection handler', async () => {
    // The counterpart of `createRelayRoute`'s upgrade guard, and the shape
    // that made it worth adding there: this handler is a `ws` event listener,
    // so nothing above it catches, and a rejection is an unhandled one with the
    // socket left open and wired to nothing. Reachable from a missing
    // REDIS_URL, i.e. from a config mistake that hits every socket at once.
    const log = vi.fn();
    const socket = new MockSocket();
    mocks.admitSocket.mockRejectedValue(new Error('createSubscriber: REDIS_URL is not set'));

    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts({ log }));
    await expect(wss.connect(socket, connectUrl())).resolves.toBeUndefined();

    expect(socket.closed).toEqual([1011]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        lvl: 'error',
        kind: 'node-relay.connection',
        msg: 'createSubscriber: REDIS_URL is not set',
      })
    );
  });

  it('and a host logger that throws inside that catch cannot re-raise the rejection', async () => {
    const socket = new MockSocket();
    mocks.admitSocket.mockRejectedValue(new Error('boom'));
    const log = vi.fn(() => {
      throw new Error('the host logger is broken too');
    });

    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts({ log }));
    await expect(wss.connect(socket, connectUrl())).resolves.toBeUndefined();
    expect(socket.closed).toEqual([1011]);
  });

  it('closes an unverifiable token with the shared close code and never reaches admission', async () => {
    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts());
    const socket = new MockSocket();
    await wss.connect(socket, '/ws?room=lobby&pid=p1&h=7&token=nonsense');

    expect(socket.closed).toEqual([CLOSE_CODES.closedByServer]);
    expect(mocks.admitSocket).not.toHaveBeenCalled();
  });
});

describe('attachNodeRelay, against the REAL admission protocol', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
    mocks.admitSocket.mockReset();
    mocks.admitSocket.mockImplementation(mocks.real.admitSocket);
    mocks.getRedis.mockReset();
    mocks.getRedis.mockReturnValue(redis);
    mocks.createSubscriber.mockReset();
    mocks.createSubscriber.mockImplementation(() => redis.fork() as never);
  });

  it('refuses a full room with the SAME frame and close code the Vercel route sends', async () => {
    await redis.set(roomKeys('lobby').stats, JSON.stringify({ players: 20 }));
    const zadd = vi.spyOn(redis, 'zadd');
    const socket = new MockSocket();

    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts());
    await wss.connect(socket, connectUrl());

    expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.roomFull })]);
    expect(socket.closed).toEqual([CLOSE_CODES.capacity]);
    // `checkAdmission` writes nothing on purpose, so a refused socket never
    // has to be un-registered; registering one would hold a slot against a
    // cap the socket it names is not using.
    expect(zadd).not.toHaveBeenCalled();
  });

  it('refuses past the per-subject socket cap with the conn-limit pair', async () => {
    await redis.set(roomKeys('lobby').stats, JSON.stringify({ players: 1 }));
    for (let i = 0; i < 3; i++) await redis.zadd('room:conns:d.abc', Date.now(), `conn-${i}`);
    const socket = new MockSocket();

    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts({ maxSocketsPerSubject: 3 }));
    await wss.connect(socket, connectUrl());

    expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.connLimit })]);
    expect(socket.closed).toEqual([CLOSE_CODES.connLimit]);
  });

  it('CONTROL: an admitted socket IS registered, and unregistered on close', async () => {
    // Without this the two cases above would pass equally well against an
    // adapter that refused everything, and the registration half is the one
    // that used to be missing entirely: `checkAdmission` writes nothing, so a
    // host that skips it counts an always-empty set and `maxSocketsPerSubject`
    // enforces nothing while looking like it does.
    await redis.set(roomKeys('lobby').stats, JSON.stringify({ players: 0 }));
    const zadd = vi.spyOn(redis, 'zadd');
    const zrem = vi.spyOn(redis, 'zrem');
    const socket = new MockSocket();

    const wss = new FakeWss();
    attachNodeRelay(wss, baseOpts());
    await wss.connect(socket, connectUrl());

    expect(socket.closed).toEqual([]);
    expect(zadd).toHaveBeenCalledTimes(1);
    expect(String(zadd.mock.calls[0]?.[0])).toBe('room:conns:d.abc');

    socket.fire('close', 1000);
    expect(zrem).toHaveBeenCalledWith('room:conns:d.abc', expect.any(String));
  });
});

describe('runNodeTicker', () => {
  beforeEach(() => {
    mocks.runTicker.mockReset();
    mocks.getRedis.mockReset();
    mocks.getRedis.mockReturnValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('SPREADS every host ticker option through to runTicker', async () => {
    const metaPayload = (map: Record<string, unknown>): unknown => ({ t: 'roster', players: Object.keys(map) });
    mocks.runTicker.mockResolvedValue({ reason: 'empty', ticks: 0, uptimeMs: 0 });

    await runNodeTicker({ runtime: {} as never, roomId: 'lobby', metaPayload, statsLabels: { region: 'lan' } });

    const passed = mocks.runTicker.mock.calls[0]?.[0];
    expect(passed.roomId).toBe('lobby');
    expect(passed.metaPayload).toBe(metaPayload);
    expect(passed.statsLabels).toEqual({ region: 'lan' });
    // The no-op successor still has to be a valid `spawnSuccessor`, which is
    // now a TWO argument function: a host stub written against the old
    // signature compiles and then quietly ignores the standby flag.
    expect(passed.spawnSuccessor.length).toBe(2);
    await expect(passed.spawnSuccessor('lobby', { standby: true })).resolves.toBeUndefined();
  });

  it("goes again IMMEDIATELY on 'input-dead', exactly like 'duration'", async () => {
    // The discriminator is the frozen clock: a backoff would leave this
    // awaiting a timer nothing advances, so a pass proves there was none. A
    // fresh run is the only repair for a dead inbound subscriber, because the
    // subscriber is opened once per run.
    vi.useFakeTimers();
    mocks.runTicker
      .mockResolvedValueOnce({ reason: 'input-dead', ticks: 5, uptimeMs: 5 })
      .mockResolvedValueOnce({ reason: 'empty', ticks: 0, uptimeMs: 0 });

    await runNodeTicker({ runtime: {} as never, roomId: 'lobby' });
    expect(mocks.runTicker).toHaveBeenCalledTimes(2);
  });

  it("CONTRAST: an 'error' exit DOES back off, so a deterministic crash is not a hot loop", async () => {
    // `runTicker` no longer spawns a successor on an error exit, so on this
    // host the loop below is the ONLY retry and the 1s wait is the only thing
    // pacing it. Redis's own crash counter is what eventually breaks the loop.
    vi.useFakeTimers();
    mocks.runTicker
      .mockResolvedValueOnce({ reason: 'error', ticks: 0, uptimeMs: 0 })
      .mockResolvedValueOnce({ reason: 'empty', ticks: 0, uptimeMs: 0 });

    const done = runNodeTicker({ runtime: {} as never, roomId: 'lobby' });
    await vi.advanceTimersByTimeAsync(900);
    expect(mocks.runTicker).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(mocks.runTicker).toHaveBeenCalledTimes(2);
  });

  it('restartOnExit false runs exactly once, whatever the reason', async () => {
    mocks.runTicker.mockResolvedValue({ reason: 'duration', ticks: 1, uptimeMs: 1 });
    await runNodeTicker({ runtime: {} as never, roomId: 'lobby', restartOnExit: false });
    expect(mocks.runTicker).toHaveBeenCalledTimes(1);
  });
});
