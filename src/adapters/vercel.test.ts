// The adapters are thin HTTP translation and are mostly tested through the
// `src/server/` functions they call. THE ONE THING THAT CANNOT BE TESTED
// THERE IS WHETHER A ROUTE ACTUALLY CALLS THEM, and that is precisely how the
// balancer route came to be the one route of three with no `normalizeRoomId`
// equivalent on it at all: every check it was missing was present, correct and
// well tested one layer down, in a function this route never reached for.
//
// `assignRoom` and `getRedis` are stubbed because a route that gets past the
// trust boundary would otherwise open a real ioredis connection. Nothing else
// is: `normalizeBase` and the route body are the real ones.
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assignRoom: vi.fn(),
  getRedis: vi.fn(),
}));

vi.mock('../server/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/index.js')>()),
  assignRoom: mocks.assignRoom,
  getRedis: mocks.getRedis,
}));

// eslint-disable-next-line import/first
import { createBalancerRoute } from './vercel.js';

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
