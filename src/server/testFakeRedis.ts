// The name every test file in this package imports the in-memory client
// under, kept as an alias rather than a copy.
//
// The implementation moved to `./memoryRedis.ts` and SHIPS now, because a
// host running one process with no Redis needs exactly the object the suite
// was already using. Keeping this file a one-line re-export is what makes
// that one implementation rather than two: a divergence between "the fake the
// tests trust" and "the client consumers get" would be invisible from either
// side, which is the same shape of gap as a fake that is stricter than the
// thing it stands in for (see `eval` over there).
//
// Excluded from `tsconfig.build.json` like every `*.test.ts`, so the alias
// itself is not part of the package surface; `createMemoryRedis` and
// `MemoryRedis` from `tickroom/server` are.
export { MemoryRedis as FakeRedis } from './memoryRedis.js';
