// Barrel for the transport-and-hosting layer: connections, the tick loop,
// the socket relay, and room assignment. Everything here is platform-agnostic
// (no `next`, no `@vercel/functions`, no framework of any kind); a framework
// adapter is a thin wrapper around these functions, not a reimplementation
// of them.

// Checkpoint STORAGE (gzip + Redis). Lives in this layer, not `core/`, because
// it imports `node:zlib`; the PURE envelope grammar (`packCheckpoint`,
// `unpackCheckpoint`, `graceMsFromCheckpoint`, `CHECKPOINT_VERSION`) stays in
// `tickroom/core`. See the header of `./checkpoint.ts`.
export type { CheckpointOwnerCheck } from './checkpoint.js';
export { STATE_TTL_S, encodeCheckpoint, decodeCheckpoint, writeCheckpoint, readCheckpoint } from './checkpoint.js';

export type { RedisFactoryOptions, Subscriber } from './redis.js';
export { getRedis, createSubscriber, resetRedisForTests } from './redis.js';

// The no-Redis shape: one process, one heap, the same two clients. Read
// `createMemoryRedis`'s comment before reaching for it, because what it gives
// up is everything Redis was there for.
export type { MemoryRedisHandle } from './memoryRedis.js';
export { MemoryRedis, createMemoryRedis } from './memoryRedis.js';

export type { TokenClaims, SessionAuthOptions } from './session.js';
export { makeToken, verifyToken, makeSpawnToken, verifySpawnToken, secretMatches, requireSecret, SPAWN_TOKEN_WINDOW_MS } from './session.js';

export type { TickerOptions, TickerResult, HostTickerOptions } from './ticker.js';
export { runTicker, publishCustom } from './ticker.js';

export type {
  RelaySocket,
  RelayOptions,
  RelayHandle,
  RelayGapsSample,
  HostRelayOptions,
  AdmissionOptions,
  AdmissionResult,
} from './relay.js';
export { attachRelay, checkAdmission, DEFAULT_CONN_STALE_MS } from './relay.js';

// The admission-register-refuse protocol every host runs identically, so a
// third adapter cannot drift from the first two and the client's close codes
// have one server-side definition. See `./admission.ts`.
export type { AdmitSocketOptions } from './admission.js';
export { admitSocket, refuseSocket, registerConnection, CONN_TOUCH_MS, CONN_KEY_TTL_S } from './admission.js';

export type { BalancerOptions, BalancerResult } from './balancer.js';
export { assignRoom } from './balancer.js';
