// The adapters are thin HTTP translation and are mostly tested through the
// `src/server/` functions they call. THE ONE THING THAT CANNOT BE TESTED
// THERE IS WHETHER A ROUTE ACTUALLY CALLS THEM, AND WITH WHAT, and that is
// precisely how the balancer route came to be the one route of three with no
// `normalizeRoomId` equivalent on it at all: every check it was missing was
// present, correct and well tested one layer down, in a function this route
// never reached for. It is also how twenty server options came to be
// unreachable from these route factories: `runTicker` and `attachRelay` were
// perfectly happy to accept `metaPayload` or `onRateDrop`, and the routes
// simply never passed them on, which no test one layer down can observe.
//
// So the group below asserts on the OPTIONS BAG each route hands over, not
// only on the status code it returns. `runTicker` and `admitSocket` are
// stubbed to capture it (and because a route that got past the trust boundary
// would otherwise open a real ioredis connection and start a 20Hz sim loop);
// `normalizeBase`, `normalizeRoomId`, the session tokens and the route bodies
// are the real ones. One group deliberately restores the REAL `admitSocket`
// against a fake Redis, because "a refused socket is never registered" is a
// claim about two functions agreeing, which a stub can only assert about
// itself.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assignRoom: vi.fn(),
  getRedis: vi.fn(),
  runTicker: vi.fn(),
  admitSocket: vi.fn(),
  createSubscriber: vi.fn(),
  // The genuine `admitSocket`, kept aside so the refusal group can put it
  // back. It reaches `checkAdmission` and `attachRelay` through `./relay.js`
  // directly rather than through this barrel, so mocking the barrel does not
  // hollow it out.
  real: { admitSocket: null as unknown as typeof import('../server/index.js')['admitSocket'] },
}));

vi.mock('../server/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/index.js')>();
  mocks.real.admitSocket = actual.admitSocket;
  return {
    ...actual,
    assignRoom: mocks.assignRoom,
    getRedis: mocks.getRedis,
    runTicker: mocks.runTicker,
    admitSocket: mocks.admitSocket,
    createSubscriber: mocks.createSubscriber,
  };
});

/* eslint-disable import/first */
import { CLOSE_CODES, MAX_TICKER_MS, RELAY_EXPIRY_LEAD_MS, SERVER_FRAMES, roomKeys } from '../core/index.js';
import { makeSpawnToken, makeToken, verifySpawnToken, type RelaySocket } from '../server/index.js';
// Straight from the module rather than the barrel, which does not re-export it
// and should not: it is a coupling between two files, not part of the hosting
// API. See the case that pins it against `SPAWN_ACK_MS`.
import { EXIT_SPAWN_WAIT_MS } from '../server/ticker.js';
import { FakeRedis } from '../server/testFakeRedis.js';
import {
  MIN_RELAY_LIFETIME_MS,
  MIN_TICKER_RUN_MS,
  RELAY_EXIT_MARGIN_MS,
  SPAWN_ACK_MS,
  SPAWN_DELIVERED,
  STANDBY_WAIT_MS,
  TICKER_EXIT_MARGIN_MS,
  createBalancerRoute,
  createRelayRoute,
  createTickerRoute,
  relayRouteConfig,
  tickerRouteConfig,
  type VercelRelayRouteOptions,
  type VercelTickerRouteOptions,
} from './vercel.js';
/* eslint-enable import/first */

const SECRET = 'test-secret';

describe('createBalancerRoute: the base is a trust boundary, not merely a registry lookup', () => {
  // A REGISTRY THAT RECOGNISES EVERYTHING, deliberately. `isValidBase` is
  // host-supplied and `ids.ts` already documents it as something that gets
  // written wrong (a bare `raw in WORLDS` matches inherited properties, so
  // `constructor` and `__proto__` sail through), and it says nothing at all
  // about the character filter or the length cap. If these cases leaned on
  // the registry to do the refusing they would say nothing about the
  // sanitiser, which is the exact mistake `ids.test.ts` had to be rewritten
  // to stop making.
  function routeWith(): (req: Request) => Promise<Response> {
    return createBalancerRoute({
      isValidBase: () => true,
      fallbackBase: 'lobby',
      maxPlayers: 20,
    });
  }

  async function call(base: string): Promise<Response> {
    mocks.assignRoom.mockReset();
    mocks.assignRoom.mockResolvedValue({ room: 'lobby', base: 'lobby', index: 0 });
    mocks.getRedis.mockReturnValue({});
    return routeWith()(new Request(`https://example.test/api/room?base=${encodeURIComponent(base)}`));
  }

  it.each([
    ['a:b', 'a colon, which would smuggle an extra segment into every room key built from this base'],
    ['a*b', 'a Redis glob wildcard, so a KEYS/SCAN pattern is never constructible from a query param'],
    ['a b', 'an ASCII space'],
    ['a\nb', 'a newline, which is log injection'],
    ['a\x00b', 'a NUL byte'],
    ['constructor', 'a prototype-chain property name a bare `in` registry would wave through'],
    ['__proto__', 'a prototype-chain property name'],
    ['a~1', 'a tilde, which composes into an instance id nothing can parse back'],
    ['a'.repeat(65), 'one byte past the length cap'],
  ])('refuses %j (%s) with 400 and never reaches Redis', async (base) => {
    const res = await call(base);
    expect(res.status).toBe(400);
    // The refusal has to happen BEFORE any Redis command is issued: a value
    // this route rejects must never become a key name, not even one that is
    // only read.
    expect(mocks.assignRoom).not.toHaveBeenCalled();
    expect(mocks.getRedis).not.toHaveBeenCalled();
  });

  it('CONTROL: a clean base is passed through to assignRoom unchanged', async () => {
    // Without this the group above would pass equally well against a route
    // that answered 400 for everything.
    const res = await call('arena');
    expect(res.status).toBe(200);
    expect(mocks.assignRoom).toHaveBeenCalledTimes(1);
    expect(mocks.assignRoom.mock.calls[0]?.[0]).toMatchObject({ base: 'arena' });
  });

  it('parses ?not= as a LIST and passes every entry through to assignRoom', async () => {
    // One id was not enough for the case `exclude` exists for: the balancer
    // reads a 5s-TTL stats key while the ticker enforces capacity for real, so
    // a client bounced from lobby then lobby~1 was sent straight back to lobby
    // and ping-ponged until its bounded re-assign budget was gone.
    mocks.assignRoom.mockReset();
    mocks.assignRoom.mockResolvedValue({ room: 'lobby~2', base: 'lobby', index: 2 });
    mocks.getRedis.mockReturnValue({});
    await routeWith()(new Request('https://example.test/api/room?base=lobby&not=lobby,lobby~1'));
    expect(mocks.assignRoom.mock.calls[0]?.[0].exclude).toEqual(['lobby', 'lobby~1']);
  });

  it('trims whitespace and drops empty entries, and a single id is unchanged', async () => {
    mocks.assignRoom.mockReset();
    mocks.assignRoom.mockResolvedValue({ room: 'lobby', base: 'lobby', index: 0 });
    mocks.getRedis.mockReturnValue({});

    await routeWith()(new Request('https://example.test/api/room?base=lobby&not=lobby,%20lobby~1,'));
    expect(mocks.assignRoom.mock.calls[0]?.[0].exclude).toEqual(['lobby', 'lobby~1']);

    // The single-id form, which every existing caller uses, is the same call
    // with one entry.
    await routeWith()(new Request('https://example.test/api/room?base=lobby&not=lobby~2'));
    expect(mocks.assignRoom.mock.calls[1]?.[0].exclude).toEqual(['lobby~2']);

    // And no `not` at all is an empty list, never a bare null the balancer has
    // to special-case.
    await routeWith()(new Request('https://example.test/api/room?base=lobby'));
    expect(mocks.assignRoom.mock.calls[2]?.[0].exclude).toEqual([]);
  });

  it('BOUNDS the list, because its length is the caller\'s choice on the join path', () => {
    // Every entry costs a parseRoomId per request and nothing past the pool
    // size can be useful, so an unbounded list is a free multiplier.
    mocks.assignRoom.mockReset();
    mocks.assignRoom.mockResolvedValue({ room: 'lobby', base: 'lobby', index: 0 });
    mocks.getRedis.mockReturnValue({});
    const huge = Array.from({ length: 5000 }, (_, i) => `lobby~${i}`).join(',');
    return routeWith()(new Request(`https://example.test/api/room?base=lobby&not=${huge}`)).then(() => {
      expect(mocks.assignRoom.mock.calls[0]?.[0].exclude).toHaveLength(64);
    });
  });

  it('still refuses a base the host registry does not recognise', async () => {
    const route = createBalancerRoute({
      isValidBase: (b) => b === 'lobby',
      fallbackBase: 'lobby',
      maxPlayers: 20,
    });
    const res = await route(new Request('https://example.test/api/room?base=arena'));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The ticker route.
// ---------------------------------------------------------------------------

type TickerOpts = VercelTickerRouteOptions<unknown, unknown>;

const baseTickerOpts: TickerOpts = {
  runtime: {} as TickerOpts['runtime'],
  secret: SECRET,
  isValidBase: (b) => b === 'lobby',
  fallbackRoom: 'lobby',
};

function tickerRouteWith(extra: Partial<TickerOpts> = {}): (req: Request) => Promise<Response> {
  return createTickerRoute<unknown, unknown>({ ...baseTickerOpts, ...extra });
}

async function callTicker(
  route: (req: Request) => Promise<Response>,
  query: Record<string, string> = {}
): Promise<Response> {
  const params = new URLSearchParams({ room: 'lobby', k: makeSpawnToken('lobby', SECRET), ...query });
  return route(new Request(`https://example.test/api/ticker?${params.toString()}`));
}

/** The single options bag the route handed `runTicker`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tickerOptionsPassed(): any {
  expect(mocks.runTicker).toHaveBeenCalledTimes(1);
  return mocks.runTicker.mock.calls[0]?.[0];
}

describe('createTickerRoute', () => {
  beforeEach(() => {
    mocks.runTicker.mockReset();
    mocks.runTicker.mockResolvedValue({ reason: 'duration', ticks: 0, uptimeMs: 0 });
    mocks.getRedis.mockReset();
    mocks.getRedis.mockReturnValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('still refuses a request with no valid spawn token, before any Redis command', async () => {
    const res = await tickerRouteWith()(new Request('https://example.test/api/ticker?room=lobby'));
    expect(res.status).toBe(403);
    expect(mocks.getRedis).not.toHaveBeenCalled();
    expect(mocks.runTicker).not.toHaveBeenCalled();
  });

  it('WARNS ONCE when a well-formed room id was refused and replaced by the fallback', async () => {
    // THE DANGEROUS INPUT HERE IS THE WELL-FORMED ONE. `maxRooms` is three
    // independent options on three route factories, all defaulting to the same
    // number, so a balancer at 50 and a ticker at 4 make `lobby~7` a perfectly
    // legal id that this route silently turns into `lobby`. Every signal on
    // both ends then reads healthy while the client is in a room nobody else
    // can see it in, and nothing in the system can notice.
    const log = vi.fn();
    await callTicker(tickerRouteWith({ log, maxRooms: 4 }), { room: 'lobby~7', k: makeSpawnToken('lobby', SECRET) });

    const warns = log.mock.calls.filter((c) => c[0]?.kind === 'ticker.room-normalised');
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ lvl: 'warn', room: 'lobby', meta: { raw: 'lobby~7' } });
  });

  it('does NOT warn when the id was accepted verbatim, nor when no room was named at all', async () => {
    // Without this the case above would pass equally well against a route that
    // warned on every request, which is a log line per join forever.
    const log = vi.fn();
    await callTicker(tickerRouteWith({ log }));
    expect(log.mock.calls.filter((c) => c[0]?.kind === 'ticker.room-normalised')).toHaveLength(0);

    // No `room` at all is the ordinary default-to-fallback path, not a refusal.
    const log2 = vi.fn();
    await tickerRouteWith({ log: log2 })(
      new Request(`https://example.test/api/ticker?k=${encodeURIComponent(makeSpawnToken('lobby', SECRET))}`)
    );
    expect(log2.mock.calls.filter((c) => c[0]?.kind === 'ticker.room-normalised')).toHaveLength(0);
  });

  it('truncates the raw id it logs, and never warns for a request it refuses', async () => {
    // The raw value is untrusted input reaching a log line, so it is evidence,
    // not a payload. And the warn sits BEHIND the spawn-token check: in front
    // of the 403 it would be a log line anyone who can reach the URL can drive
    // by guessing room ids.
    const log = vi.fn();
    const long = 'x'.repeat(200);
    await callTicker(tickerRouteWith({ log }), { room: long });
    const warns = log.mock.calls.filter((c) => c[0]?.kind === 'ticker.room-normalised');
    expect(warns).toHaveLength(1);
    expect(String(warns[0][0].meta.raw)).toHaveLength(64);

    const log2 = vi.fn();
    const res = await tickerRouteWith({ log: log2 })(
      new Request(`https://example.test/api/ticker?room=${long}`) // no spawn token
    );
    expect(res.status).toBe(403);
    expect(log2).not.toHaveBeenCalled();
  });

  it('a host logger that throws on that warn cannot fail the request', async () => {
    // The warn runs outside the relay route's upgrade guard, so it needs its
    // own: a diagnostic must never be able to turn a joinable room into a 500.
    const log = vi.fn(() => {
      throw new Error('the host logger is broken');
    });
    const res = await callTicker(tickerRouteWith({ log, maxRooms: 4 }), {
      room: 'lobby~7',
      k: makeSpawnToken('lobby', SECRET),
    });
    expect(res.status).toBe(200);
    expect(tickerOptionsPassed().roomId).toBe('lobby');
  });

  it('SPREADS every host ticker option through, rather than copying a chosen subset', async () => {
    // `metaPayload` is the one to pin: it is the landed fix for a real game
    // whose entire roster (name tags, presence count, join and leave
    // notifications) went silent when the broadcast shape changed, and it was
    // unreachable from this route while the option type listed its fields by
    // hand. `init` and `onGeomMismatch` are here for the same reason and
    // because they are the two whose absence is silent rather than loud.
    const metaPayload = (map: Record<string, unknown>): unknown => ({ t: 'roster', players: Object.keys(map) });
    const init = async (): Promise<void> => {};
    const onGeomMismatch = (): null => null;
    const statsLabels = { region: 'iad1' };

    await callTicker(tickerRouteWith({ metaPayload, init, onGeomMismatch, statsLabels, presenceTimeoutMs: 9000 }));

    const passed = tickerOptionsPassed();
    expect(passed.metaPayload).toBe(metaPayload);
    expect(passed.init).toBe(init);
    expect(passed.onGeomMismatch).toBe(onGeomMismatch);
    expect(passed.statsLabels).toBe(statsLabels);
    expect(passed.presenceTimeoutMs).toBe(9000);
  });

  it('derives maxRunMs from the platform cap when the host does not set one', async () => {
    await callTicker(tickerRouteWith());
    // The default cap (800s) leaves 770s after the margin, but the library's own
    // measured lifetime (700s) is the ceiling: a bigger platform cap must never
    // silently lengthen a ticker's run.
    expect(tickerOptionsPassed().maxRunMs).toBe(Math.min(MAX_TICKER_MS, tickerRouteConfig.maxDuration * 1000 - TICKER_EXIT_MARGIN_MS));
    expect(tickerOptionsPassed().maxRunMs).toBe(MAX_TICKER_MS);
  });

  it('derives maxRunMs from a LOWERED maxDurationS, which is the whole point of the coupling', async () => {
    // A host on a plan capped below the library's own default, or one who
    // lowered `maxDuration` for cost. Before this, the loop ran to 700s and
    // the platform killed the function at 300 with no final checkpoint, no
    // release and no successor, once per cycle, silently.
    await callTicker(tickerRouteWith({ maxDurationS: 300 }));
    expect(tickerOptionsPassed().maxRunMs).toBe(300_000 - TICKER_EXIT_MARGIN_MS);
  });

  it('THROWS AT ROUTE CREATION when an explicit maxRunMs does not leave the exit margin', () => {
    expect(() => tickerRouteWith({ maxDurationS: 300, maxRunMs: 290_000 })).toThrow(/TICKER_EXIT_MARGIN_MS/);
    // The failure names both numbers and the value that would fit, because
    // the alternative is a deployment discovering the fit in production, on
    // the one path (the exit) that reports nothing when it is cut short.
    expect(() => tickerRouteWith({ maxDurationS: 300, maxRunMs: 290_000 })).toThrow(/270000ms/);
  });

  it('CONTRAST: an explicit maxRunMs that DOES fit is passed through untouched', () => {
    // Without this the case above would pass equally well against a route
    // that refused every explicit `maxRunMs`.
    expect(() => tickerRouteWith({ maxDurationS: 300, maxRunMs: 200_000 })).not.toThrow();
  });

  it('an explicit maxRunMs that fits reaches runTicker unchanged', async () => {
    await callTicker(tickerRouteWith({ maxDurationS: 300, maxRunMs: 200_000 }));
    expect(tickerOptionsPassed().maxRunMs).toBe(200_000);
  });

  it('THROWS when maxDurationS is too small for the margin to leave a loop at all', () => {
    // THE MARGIN IS A SUBTRACTION AND A SUBTRACTION GOES NEGATIVE. 10s derives
    // a maxRunMs of -20000, which is not a short ticker: every invocation
    // acquires the lease, exits 'duration' at once, releases, and spawns a
    // successor that does the same, at cold-start rate, forever, with every
    // individual run reporting the healthiest possible exit reason.
    expect(() => tickerRouteWith({ maxDurationS: 10 })).toThrow(/MIN_TICKER_RUN_MS/);
    expect(() => tickerRouteWith({ maxDurationS: 10 })).toThrow(/maxDurationS is 10s/);
    expect(() => tickerRouteWith({ maxDurationS: 10 })).toThrow(/TICKER_EXIT_MARGIN_MS/);
  });

  it('THROWS on an explicit NEGATIVE maxRunMs, which the fit check waves through by arithmetic', () => {
    // The fit check only bounds maxRunMs from ABOVE: -20000 + 30000 is exactly
    // the 10000ms cap, so it fits, and the floor is the only thing that can
    // catch it. This is the case that proves the two checks are not redundant.
    expect(() => tickerRouteWith({ maxDurationS: 10, maxRunMs: -20_000 })).toThrow(/MIN_TICKER_RUN_MS/);
  });

  it('CONTRAST: a maxDurationS exactly at the floor is accepted, and derives it', async () => {
    // Without this the two cases above would pass equally well against a route
    // that refused every small maxDurationS.
    const floorSeconds = (TICKER_EXIT_MARGIN_MS + MIN_TICKER_RUN_MS) / 1000;
    expect(() => tickerRouteWith({ maxDurationS: floorSeconds })).not.toThrow();
    await callTicker(tickerRouteWith({ maxDurationS: floorSeconds }));
    expect(tickerOptionsPassed().maxRunMs).toBe(MIN_TICKER_RUN_MS);
  });

  it('maps ?standby=1 onto standbyMs, and an ordinary invocation onto zero', async () => {
    await callTicker(tickerRouteWith(), { standby: '1' });
    expect(tickerOptionsPassed().standbyMs).toBe(STANDBY_WAIT_MS);

    mocks.runTicker.mockClear();
    await callTicker(tickerRouteWith());
    // Zero is load bearing, not a default: a relay poll's spawn is one of
    // many losers of an acquire race, and every loser waiting out a standby
    // window is paid-for nothing.
    expect(tickerOptionsPassed().standbyMs).toBe(0);
  });

  it('sets standby=1 on the spawn URL only for a STANDBY spawn, and keeps the token bound to the room', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await callTicker(tickerRouteWith());
    const { spawnSuccessor } = tickerOptionsPassed();

    await spawnSuccessor('lobby', { standby: true });
    await spawnSuccessor('lobby', { standby: false });

    const standbyUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const exitUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(standbyUrl.searchParams.get('standby')).toBe('1');
    expect(exitUrl.searchParams.get('standby')).toBe(null);

    // Unchanged from before: a fresh token, bound to the successor's room id.
    for (const url of [standbyUrl, exitUrl]) {
      expect(url.searchParams.get('room')).toBe('lobby');
      expect(verifySpawnToken('lobby', url.searchParams.get('k'), SECRET)).toBe(true);
      expect(verifySpawnToken('lobby~1', url.searchParams.get('k'), SECRET)).toBe(false);
    }
  });

  it('a STANDBY spawning its own exit successor does not hand the flag down', async () => {
    // The spawn URL is a clone of this invocation's own, so an inherited
    // `standby=1` would make the exit successor poll for a lease this ticker
    // has already released.
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await callTicker(tickerRouteWith(), { standby: '1' });
    await tickerOptionsPassed().spawnSuccessor('lobby', { standby: false });

    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('standby')).toBe(null);
  });

  // A SPAWN IS A DELIVERY, NOT A CONVERSATION. This route is the thing a
  // spawn calls, and it does not respond until `runTicker` returns, so the
  // answer to a spawn is the successor's whole 700s life. Waiting for it hit
  // undici's 300000ms `headersTimeout` and reported `TypeError: fetch failed`
  // on a ticker that had been running the room for five minutes: an error
  // line for a non-event, on every room start and every standby handoff.
  it('resolves a spawn AS DELIVERED when the route never answers, which is the ORDINARY case', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {}))); // an answer that never comes
    await callTicker(tickerRouteWith());
    const { spawnSuccessor } = tickerOptionsPassed();

    vi.useFakeTimers();
    let settled = false;
    const spawn = spawnSuccessor('lobby', { standby: true }).then((v: unknown) => {
      settled = true;
      return v;
    });
    // Pinned from BOTH sides, because a receipt that fires early is a spawn
    // reported as delivered before DNS could have failed.
    await vi.advanceTimersByTimeAsync(SPAWN_ACK_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(spawn).resolves.toBe(SPAWN_DELIVERED);
  });

  it('a rejection BEFORE the receipt is still a failure, because nothing was started', async () => {
    // The half the receipt must not swallow: an unresolvable host, a refused
    // connection, a TLS failure. These land in milliseconds and mean the room
    // has no ticker, which is the one thing the log line is for.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND ticker.invalid')));
    await callTicker(tickerRouteWith());

    await expect(tickerOptionsPassed().spawnSuccessor('lobby', { standby: false })).rejects.toThrow(
      'getaddrinfo ENOTFOUND'
    );
  });

  it('has a receipt window that FITS INSIDE the ticker\'s own exit-spawn wait', async () => {
    // The rejection above is only useful if somebody is still listening for
    // it. The ticker's exit path awaits `spawnSuccessor` raced against
    // `EXIT_SPAWN_WAIT_MS`, so a receipt window as long as that budget (it was
    // 3000 against 2000) means the race is decided before this promise can
    // settle either way: `ticker.spawn-failed` becomes unreachable for every
    // exit spawn on this host, which is exactly the exits a standby never
    // preceded. Pinned here rather than by importing one constant into the
    // other, because the ticker must not depend on an adapter and because
    // 3000 is argued from DNS, TLS and the platform accepting the request.
    expect(SPAWN_ACK_MS).toBeLessThan(EXIT_SPAWN_WAIT_MS);
    // And by a real margin, not by a millisecond: a receipt that lands at the
    // budget still has a promise hop and a timer's slop ahead of it.
    expect(EXIT_SPAWN_WAIT_MS - SPAWN_ACK_MS).toBeGreaterThanOrEqual(500);
  });

  it('a status answered QUICKLY is handed back as the route\'s own answer, unread and unwaited', async () => {
    // Deployment Protection answers one function calling another with an SSO
    // redirect rather than a 200, and it answers AT ONCE. That is a real
    // response, so it resolves exactly as it always has (this spawn has never
    // read a status); what it must not do is spend the receipt window on it.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 })));
    await callTicker(tickerRouteWith());

    vi.useFakeTimers(); // no timer is advanced below: the answer alone settles it
    const answer: unknown = await tickerOptionsPassed().spawnSuccessor('lobby', { standby: false });
    expect(answer).toBeInstanceOf(Response);
    expect((answer as Response).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The relay route.
// ---------------------------------------------------------------------------

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

function relayRouteWith(
  socket: MockSocket,
  extra: Partial<VercelRelayRouteOptions> = {}
): (req: Request) => Promise<Response> {
  const base: VercelRelayRouteOptions = {
    secret: SECRET,
    isValidBase: (b) => b === 'lobby',
    fallbackRoom: 'lobby',
    maxPlayers: 20,
    tickerUrl: '/api/ticker',
    decodeInput: () => [],
    upgradeWebSocket: async (handler) => {
      await handler(socket);
      return new Response('ok');
    },
  };
  return createRelayRoute({ ...base, ...extra });
}

function relayRequest(query: Record<string, string> = {}): Request {
  const params = new URLSearchParams({
    room: 'lobby',
    pid: 'p1',
    h: '7',
    token: makeToken({ pid: 'p1', handle: 7, sub: 'd.abc' }, { secret: SECRET }),
    ...query,
  });
  return new Request(`https://example.test/api/ws?${params.toString()}`);
}

/** The single options bag the route handed `admitSocket`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admitOptionsPassed(): any {
  expect(mocks.admitSocket).toHaveBeenCalledTimes(1);
  return mocks.admitSocket.mock.calls[0]?.[0];
}

describe('createRelayRoute', () => {
  beforeEach(() => {
    mocks.admitSocket.mockReset();
    mocks.admitSocket.mockResolvedValue(null);
    mocks.getRedis.mockReset();
    mocks.getRedis.mockReturnValue({});
    mocks.createSubscriber.mockReset();
  });

  it('still refuses an unverifiable token with 401, before any Redis command', async () => {
    const res = await relayRouteWith(new MockSocket())(
      new Request('https://example.test/api/ws?room=lobby&pid=p1&h=7&token=nonsense')
    );
    expect(res.status).toBe(401);
    expect(mocks.getRedis).not.toHaveBeenCalled();
    expect(mocks.admitSocket).not.toHaveBeenCalled();
  });

  it('WARNS ONCE when a well-formed room id was refused and replaced by the fallback', async () => {
    const log = vi.fn();
    await relayRouteWith(new MockSocket(), { log, maxRooms: 4 })(relayRequest({ room: 'lobby~7' }));

    const warns = log.mock.calls.filter((c) => c[0]?.kind === 'relay.room-normalised');
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ lvl: 'warn', room: 'lobby', meta: { raw: 'lobby~7' } });
    // And the socket really is attached to the room the warning names, which
    // is the mismatch the client cannot see for itself.
    expect(admitOptionsPassed().roomId).toBe('lobby');
  });

  it('does NOT warn when the id was accepted verbatim, and never for a request it refuses', async () => {
    const log = vi.fn();
    await relayRouteWith(new MockSocket(), { log, maxRooms: 50 })(relayRequest({ room: 'lobby~7' }));
    expect(log.mock.calls.filter((c) => c[0]?.kind === 'relay.room-normalised')).toHaveLength(0);

    // Behind the token check: an unauthenticated caller cannot drive the line.
    const log2 = vi.fn();
    const res = await relayRouteWith(new MockSocket(), { log: log2 })(
      new Request('https://example.test/api/ws?room=lobby~7&pid=p1&h=7&token=nonsense')
    );
    expect(res.status).toBe(401);
    expect(log2).not.toHaveBeenCalled();
  });

  it('SPREADS every host relay option through, rather than copying a chosen subset', async () => {
    // `metaSeedPayload` is the relay half of the roster-shape fix and
    // `onRateDrop` is one of the four observability hooks that are the ONLY
    // way a host can see the abuse path the rate limiter exists for. Both
    // existed on `RelayOptions`, both were unreachable from this route, and
    // nothing anywhere reported it.
    const metaSeedPayload = (map: Record<string, unknown>): unknown => ({ t: 'roster', players: Object.keys(map) });
    const onRateDrop = vi.fn();

    await relayRouteWith(new MockSocket(), {
      metaSeedPayload,
      onRateDrop,
      snapshotBacklogBytes: 4096,
      subscribeTimeoutMs: 1234,
      connNamespace: 'legacy',
      maxSocketsPerSubject: 3,
    })(relayRequest());

    const passed = admitOptionsPassed();
    expect(passed.relay.metaSeedPayload).toBe(metaSeedPayload);
    expect(passed.relay.onRateDrop).toBe(onRateDrop);
    expect(passed.relay.snapshotBacklogBytes).toBe(4096);
    expect(passed.relay.subscribeTimeoutMs).toBe(1234);
    // The admission half of the bag rides `admitSocket`'s own fields, not the
    // relay's, and both halves have to arrive.
    expect(passed.connNamespace).toBe('legacy');
    expect(passed.maxSocketsPerSubject).toBe(3);
    expect(passed.maxPlayers).toBe(20);
    expect(passed.pid).toBe('p1');
    expect(passed.subject).toBe('d.abc');
    expect(passed.roomId).toBe('lobby');
  });

  it('calls joinMeta with the verified claims and hands the RESULT to the relay', async () => {
    const joinMeta = vi.fn().mockReturnValue({ name: 'Alice' });
    await relayRouteWith(new MockSocket(), { joinMeta })(relayRequest({ n: 'Alice' }));

    expect(joinMeta.mock.calls[0]?.[0]).toMatchObject({ pid: 'p1', handle: 7, sub: 'd.abc' });
    expect(String(joinMeta.mock.calls[0]?.[1])).toContain('n=Alice');
    expect(admitOptionsPassed().relay.joinMeta).toEqual({ name: 'Alice' });
  });

  it('derives lifetimeMs from the platform cap, so the relay warm-swaps instead of dropping', async () => {
    await relayRouteWith(new MockSocket())(relayRequest());
    expect(admitOptionsPassed().relay.lifetimeMs).toBe(relayRouteConfig.maxDuration * 1000 - RELAY_EXIT_MARGIN_MS);
  });

  it('derives lifetimeMs from a LOWERED maxDurationS', async () => {
    await relayRouteWith(new MockSocket(), { maxDurationS: 60 })(relayRequest());
    expect(admitOptionsPassed().relay.lifetimeMs).toBe(60_000 - RELAY_EXIT_MARGIN_MS);
  });

  it('an explicitly set lifetimeMs WINS over the derived one', async () => {
    // The escape hatch for a platform whose real cap this library cannot read.
    await relayRouteWith(new MockSocket(), { maxDurationS: 60, lifetimeMs: 12_345 })(relayRequest());
    expect(admitOptionsPassed().relay.lifetimeMs).toBe(12_345);
  });

  it('THROWS when maxDurationS leaves a lifetime that cannot be warm-swapped', () => {
    // Measured before this check existed: maxDurationS 10 derived lifetimeMs 0,
    // so an admitted socket got `relay-expiring` and CLOSE_CODES.relayUnavailable
    // in the same instant, before a single snapshot. That code is deliberately
    // NOT terminal, so the client reconnects, and the replacement does it again:
    // an infinite reconnect loop on a completely healthy deployment.
    expect(() => relayRouteWith(new MockSocket(), { maxDurationS: 10 })).toThrow(/MIN_RELAY_LIFETIME_MS/);
    expect(() => relayRouteWith(new MockSocket(), { maxDurationS: 10 })).toThrow(/RELAY_EXPIRY_LEAD_MS/);
  });

  it('THROWS at ONE lead plus a second, the value the old floor admitted', () => {
    // THE FLOOR IS TWO LEADS, NOT ONE, and this is the case that says so. A
    // 6000ms lifetime makes the announcements 6000ms apart but the SWAPS
    // 1000ms apart, and the client declines any swap starting less than
    // RELAY_EXPIRY_LEAD_MS after the previous one (that rate limit is what
    // stops a compromised relay opening a socket per frame). So every swap
    // after the first is declined, the socket runs to its cap, closes 4004,
    // and the client cold-reconnects: measured on the smoothness harness at 1
    // reconnect, a 349ms snapshot gap, 3 zero-motion frames and a 234 u/s
    // peak. Exactly the stutter the swap exists to prevent, produced by a
    // value that passed the previous floor.
    expect(() => relayRouteWith(new MockSocket(), { lifetimeMs: RELAY_EXPIRY_LEAD_MS + 1000 })).toThrow(
      /MIN_RELAY_LIFETIME_MS/
    );
    expect(() => relayRouteWith(new MockSocket(), { lifetimeMs: RELAY_EXPIRY_LEAD_MS + 1000 })).toThrow(
      /TWO expiry leads/
    );
  });

  it('THROWS on an explicit lifetimeMs at the bare lead, not only on a derived one', () => {
    expect(() => relayRouteWith(new MockSocket(), { lifetimeMs: RELAY_EXPIRY_LEAD_MS })).toThrow(
      /MIN_RELAY_LIFETIME_MS/
    );
  });

  it('CONTRAST: a lifetime exactly at the floor is accepted, from either door', async () => {
    // Without this the three cases above would pass equally well against a
    // route that refused every short lifetime. Pinned against the arithmetic
    // as well as the constant, so a floor that silently drifts back to one
    // lead cannot keep this case green.
    expect(MIN_RELAY_LIFETIME_MS).toBe(2 * RELAY_EXPIRY_LEAD_MS + 1000);
    expect(() => relayRouteWith(new MockSocket(), { lifetimeMs: MIN_RELAY_LIFETIME_MS })).not.toThrow();
    const floorSeconds = (RELAY_EXIT_MARGIN_MS + MIN_RELAY_LIFETIME_MS) / 1000;
    await relayRouteWith(new MockSocket(), { maxDurationS: floorSeconds })(relayRequest());
    expect(admitOptionsPassed().relay.lifetimeMs).toBe(MIN_RELAY_LIFETIME_MS);
    // And the accepted floor really does leave a full lead of clearance
    // between one swap starting and the next announcement.
    expect(MIN_RELAY_LIFETIME_MS - RELAY_EXPIRY_LEAD_MS).toBeGreaterThan(RELAY_EXPIRY_LEAD_MS);
  });

  it('a THROW inside the upgrade callback never escapes it: logged, socket closed, promise resolved', async () => {
    // Reachable from a deployment-config mistake rather than a library bug:
    // `createSubscriber` throws on a missing REDIS_URL, which is exactly the
    // condition where every socket in the fleet takes this path at once. An
    // escaping rejection leaves the platform-upgraded socket OPEN and wired to
    // nothing until the duration cap kills it, and the client has no reason to
    // reconnect from a connection that looks alive.
    const log = vi.fn();
    const socket = new MockSocket();
    mocks.admitSocket.mockRejectedValue(new Error('createSubscriber: REDIS_URL is not set'));

    const res = await relayRouteWith(socket, { log })(relayRequest());

    expect(res.status).toBe(200);
    expect(socket.closed).toEqual([1011]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        lvl: 'error',
        kind: 'relay.upgrade-threw',
        room: 'lobby',
        pid: 'p1',
        msg: 'createSubscriber: REDIS_URL is not set',
      })
    );
  });

  it('and a host logger that throws inside that handler cannot re-raise the rejection', async () => {
    // The guard is the last thing between a throw and an unhandled rejection,
    // so every statement inside it has to be guarded too.
    const socket = new MockSocket();
    mocks.admitSocket.mockRejectedValue(new Error('boom'));
    const log = vi.fn(() => {
      throw new Error('the host logger is broken too');
    });

    await expect(relayRouteWith(socket, { log })(relayRequest())).resolves.toBeInstanceOf(Response);
    expect(socket.closed).toEqual([1011]);
  });

  it('mints a room-bound spawn token on the relay spawnTicker, and never a standby one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await relayRouteWith(new MockSocket())(relayRequest());

    await admitOptionsPassed().relay.spawnTicker('lobby');
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/ticker');
    expect(verifySpawnToken('lobby', url.searchParams.get('k'), SECRET)).toBe(true);
    // A poll spawn is one of many losers of an acquire race; it must never
    // ask to be a standby.
    expect(url.searchParams.get('standby')).toBe(null);
    vi.unstubAllGlobals();
  });

  it('resolves the relay spawn as DELIVERED instead of waiting out the ticker it just started', async () => {
    // This is the one that was measured in production: the first socket of
    // every run logged `relay.spawn-failed` with `TypeError: fetch failed`
    // five minutes after the ticker it spawned had restored the room and
    // started ticking. See `SPAWN_ACK_MS`.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    await relayRouteWith(new MockSocket())(relayRequest());
    const { spawnTicker } = admitOptionsPassed().relay;

    vi.useFakeTimers();
    const spawn = spawnTicker('lobby');
    await vi.advanceTimersByTimeAsync(SPAWN_ACK_MS);
    await expect(spawn).resolves.toBe(SPAWN_DELIVERED);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('and REJECTS one that never left, which is the only spawn worth an error line', async () => {
    // Without this the case above would pass equally well against a spawn
    // that reported success for everything, which is a room with no ticker
    // and nothing anywhere saying so.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443')));
    await relayRouteWith(new MockSocket())(relayRequest());

    await expect(admitOptionsPassed().relay.spawnTicker('lobby')).rejects.toThrow('ECONNREFUSED');
    vi.unstubAllGlobals();
  });
});

describe('createRelayRoute, against the REAL admission protocol', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
    mocks.admitSocket.mockReset();
    mocks.admitSocket.mockImplementation(mocks.real.admitSocket);
    mocks.getRedis.mockReset();
    mocks.getRedis.mockReturnValue(redis);
    mocks.createSubscriber.mockReset();
    mocks.createSubscriber.mockImplementation(() => redis.fork() as never);
    // The real relay polls for a ticker and spawns one through the route's own
    // `spawnTicker`, which is a `fetch`. Nothing in a unit test may leave the
    // machine, so it is stubbed rather than left to fail slowly against a
    // hostname that does not resolve.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a full room with the shared frame and close code, and REGISTERS NOTHING', async () => {
    await redis.set(roomKeys('lobby').stats, JSON.stringify({ players: 20 }));
    const zadd = vi.spyOn(redis, 'zadd');
    const socket = new MockSocket();

    const res = await relayRouteWith(socket)(relayRequest());

    expect(res.status).toBe(200); // the upgrade itself succeeded; the refusal is on the socket
    expect(socket.sent).toEqual([JSON.stringify({ t: SERVER_FRAMES.roomFull })]);
    expect(socket.closed).toEqual([CLOSE_CODES.capacity]);
    // `checkAdmission` writes nothing on purpose, so that a refused socket
    // never has to be un-registered. If a refusal ever started registering,
    // the entry would sit in the per-subject set until it aged out and count
    // against a cap the socket it names is not using.
    expect(zadd).not.toHaveBeenCalled();
  });

  it('CONTROL: an admitted socket IS registered, and unregistered on close', async () => {
    // Without this the case above would pass equally well against a route
    // that never registered anything at all, which is the exact defect
    // `admitSocket` exists to make impossible.
    await redis.set(roomKeys('lobby').stats, JSON.stringify({ players: 0 }));
    const zadd = vi.spyOn(redis, 'zadd');
    const zrem = vi.spyOn(redis, 'zrem');
    const socket = new MockSocket();

    await relayRouteWith(socket)(relayRequest());

    expect(socket.closed).toEqual([]);
    expect(zadd).toHaveBeenCalledTimes(1);
    const connKey = String(zadd.mock.calls[0]?.[0]);
    expect(connKey).toBe('room:conns:d.abc');

    socket.fire('close', 1000);
    expect(zrem).toHaveBeenCalledWith(connKey, expect.any(String));
  });
});
