// Barrel for the transport-and-hosting layer: connections, the tick loop,
// the socket relay, and room assignment. Everything here is platform-agnostic
// (no `next`, no `@vercel/functions`, no framework of any kind); a framework
// adapter is a thin wrapper around these functions, not a reimplementation
// of them.

// Checkpoint STORAGE (gzip + Redis). Lives in this layer, not `core/`, because
// it imports `node:zlib`; the PURE envelope grammar (`packCheckpoint`,
// `unpackCheckpoint`, `graceMsFromCheckpoint`, `CHECKPOINT_VERSION`) stays in
// `tickroom/core`. See the header of `./checkpoint.ts`.
export { STATE_TTL_S, encodeCheckpoint, decodeCheckpoint, writeCheckpoint, readCheckpoint } from './checkpoint.js';

export type { RedisFactoryOptions, Subscriber } from './redis.js';
export { getRedis, createSubscriber, resetRedisForTests } from './redis.js';

export type { TokenClaims, SessionAuthOptions } from './session.js';
export { makeToken, verifyToken, makeSpawnToken, verifySpawnToken, secretMatches, requireSecret } from './session.js';

export type { TickerOptions, TickerResult } from './ticker.js';
export { runTicker } from './ticker.js';

export type { RelaySocket, RelayOptions, RelayHandle, AdmissionOptions, AdmissionResult } from './relay.js';
export { attachRelay, checkAdmission } from './relay.js';

export type { BalancerOptions, BalancerResult } from './balancer.js';
export { assignRoom } from './balancer.js';
