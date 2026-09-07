// The harness half of tickroom: what a host runs to prove its client's step
// really is its server's step before it ships one. Nothing here runs in
// production, and nothing here imports a node builtin or `ioredis`, so it
// loads in the same browser test runner the client code already runs in. See
// `lockstep.ts` for the reasoning; this file only re-exports.

export {
  runLockstep,
  sweepLockstep,
  type LockstepOptions,
  type LockstepReconcile,
  type LockstepFrame,
  type LockstepReport,
  type LockstepSweepResult,
} from './lockstep.js';
