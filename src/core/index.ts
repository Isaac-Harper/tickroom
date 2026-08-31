// The pure layer. NOTHING reachable from this barrel may import a Node builtin,
// a platform module, Redis, or a socket: client code imports it and bundlers
// compile it for the browser, where an unresolvable `node:*` specifier is a hard
// build failure rather than a warning. That rule was broken once, by
// `checkpoint.ts` re-exporting `node:zlib`, and the fix was to move the gzip and
// Redis half of it into `src/server/checkpoint.ts` so no file under `core/`
// carries a platform import at all. `src/client/bundling.test.ts` bundles this
// barrel for the browser on every run, so a regression reddens here rather than
// downstream.
export * from './types.js';
export * from './redisLike.js';
export * from './ids.js';
export * from './lease.js';
export * from './checkpoint.js';
export * from './playout.js';
export * from './starvation.js';
export * from './backpressure.js';
export * from './rateLimit.js';
export * from './metrics.js';
