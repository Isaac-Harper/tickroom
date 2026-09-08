// Every `LogEvent.kind` this library emits, as one list, so `LogEvent.kind` is
// a union rather than a string. A consumer can then switch over it
// exhaustively, and the library can notice a kind it stopped emitting: the
// handoff diagnosis that turned on `ticker.fresh` was written against a kind
// that did not exist yet, and nothing could say so. `log.test.ts` reads the
// source under `src/` to prove every kind here is emitted somewhere and every
// literal emitted is here, which is the half `tsc` cannot see (a kind passed
// through a variable, or a template literal).
//
// Grouped by EMITTER, which is the prefix. Add a kind here first, then emit
// it; the test reddens on either half missing.

/** Every log kind the library emits, grouped by the component that emits it. */
export const LOG_KINDS = [
  // --- ticker (`src/server/ticker.ts`), one per room lifetime event ---
  /** error: `RoomRuntime.init` threw; this invocation exits without a room. */
  'ticker.init-failed',
  /** error: setup (the checkpoint read, the subscribe, the restore) threw; the lease goes back and nothing is spawned. */
  'ticker.setup-threw',
  /** error: three consecutive invocations threw; the stored checkpoint is ignored and the room starts fresh. */
  'ticker.crash-loop',
  /** error: the checkpoint read threw `CHECKPOINT_READ_ATTEMPTS` times; giving up rather than starting fresh over a transient. */
  'ticker.checkpoint-read-failed',
  /** warn: the stored checkpoint was absent, unparseable, malformed or from another version; starting fresh, `meta.reason` says which. */
  'ticker.checkpoint-refused',
  /** warn: restoring a checkpoint with no `geomKey` configured, so a world change could not be detected. */
  'ticker.no-geom-key',
  /** info: the room restored from its checkpoint, `meta.tick` being the tick it resumed at. */
  'ticker.restore',
  /** warn: `deserialize` threw on the stored checkpoint; the room starts fresh. */
  'ticker.restore-failed',
  /** warn: the checkpoint's geometry key disagrees with this ticker's; it is not restored whole. */
  'ticker.geom-mismatch',
  /** info: `restorePartial` carried what it could across a geometry mismatch. */
  'ticker.geom-partial-restore',
  /** warn: `restorePartial` threw; the room starts fresh. */
  'ticker.geom-partial-restore-failed',
  /** info: the room started without restoring, `meta.checkpoint` naming what the read found. */
  'ticker.fresh',
  /** warn: roster entries in the meta hash were not objects and were dropped rather than republished. */
  'ticker.meta-restore-refused',
  /** warn: the meta hash could not be read at startup; the roster starts empty. */
  'ticker.meta-read-failed',
  /** warn: the input subscriber emitted an error, at most one line per `statsMs`. */
  'ticker.subscriber-error',
  /** error: the input subscribe did not complete inside `leaseTtlMs`; refusing to run a ticker that cannot receive input. */
  'ticker.subscribe-failed',
  /** error: Redis refused a checkpoint write because the lease had moved on; treated as a lost lease. */
  'ticker.checkpoint-refused-not-owner',
  /** error: removing a departed player from the meta hash failed. */
  'ticker.meta-hdel-failed',
  /** error: writing a joining player into the meta hash failed. */
  'ticker.meta-hset-failed',
  /** error: the host's `metaPayload` formatter threw; the roster frame is suppressed for this change. */
  'ticker.meta-payload-threw',
  /** error: the roster publish was rejected by the bus; the roster is re-marked dirty. */
  'ticker.metaout-failed',
  /** error: the playout depth publish was rejected by the bus; the next interval carries a fresh mean. */
  'ticker.depth-failed',
  /** error: this ticker no longer holds the lease, `meta.finder` saying which check noticed. */
  'ticker.lease-lost',
  /** error: a snapshot publish was rejected by the bus. */
  'ticker.publish-failed',
  /** error: a periodic checkpoint write threw. */
  'ticker.checkpoint-write-failed',
  /** error: the stats gauge write threw. */
  'ticker.stats-write-failed',
  /** warn: players whose join heartbeat stopped for `presenceTimeoutMs` were given a synthesised leave. */
  'ticker.presence-timeout',
  /** warn: envelopes arrived with a type this ticker has no branch for, counted once per flush. */
  'ticker.unknown-envelope',
  /** error: the host simulation threw out of its own hooks this window, counted once per flush. */
  'ticker.host-errors',
  /** error: the host's `onStats` callback threw. */
  'ticker.onStats-threw',
  /** error: the input subscription stopped delivering; handing off to a successor with a fresh connection. */
  'ticker.input-dead',
  /** error: `spawnSuccessor` rejected or timed out, `meta.standby` marking the early spawn. */
  'ticker.spawn-failed',
  /** error: the tick loop threw; the room exits with reason `error`. */
  'ticker.tick-threw',
  /** error: the timeline marker write on an error exit threw. */
  'ticker.timeline-write-failed',
  /** error: releasing the lease on exit threw. */
  'ticker.release-failed',
  /** error: the final checkpoint write on exit threw. */
  'ticker.final-checkpoint-failed',
  /** error: `RoomRuntime.dispose` threw. */
  'ticker.dispose-threw',
  /** warn: the ticker route refused the requested room id and replaced it with the fallback (Vercel adapter). */
  'ticker.room-normalised',

  // --- relay (`src/server/relay.ts`, `admission.ts`, the adapters), one per socket event ---
  /** error: input publishes were rejected by the bus, counted once per heartbeat. */
  'relay.publish-failed',
  /** warn: snapshots were dropped under transport backpressure, counted once per heartbeat. */
  'relay.backlog-drop',
  /** warn: the subscriber emitted errors, counted once per heartbeat. */
  'relay.subscriber-error',
  /** warn: per-socket library frames arrived on the roster channel and were dropped, counted once per heartbeat. */
  'relay.misaddressed-frame',
  /** error: sends on an open socket threw, counted once per heartbeat. */
  'relay.send-failed',
  /** info: the bus gap or the send lag passed its report threshold this window. */
  'relay.gaps',
  /** warn: the roster seed read failed; the client starts with an empty roster. */
  'relay.meta-seed-failed',
  /** error: `spawnTicker` rejected. */
  'relay.spawn-failed',
  /** warn: the lease check behind the spawn decision threw. */
  'relay.lease-check-failed',
  /** error: the host's `onClose` threw. */
  'relay.onClose-threw',
  /** warn: the transport exposes no `ping()`, so liveness rests on client traffic alone. */
  'relay.no-ping',
  /** error: the subscriber ended or stopped answering its probe; the socket closes so the client lands on a fresh relay. */
  'relay.subscriber-dead',
  /** warn: the socket went silent past `livenessTimeoutMs` and was terminated. */
  'relay.liveness-drop',
  /** info: `lifetimeMs` was reached; the announced close happened. */
  'relay.lifetime-reached',
  /** info: the ticker refused this socket's join; `room-full` was sent and the socket closed with the capacity code. */
  'relay.room-full',
  /** warn: a socket attached while CONNECTING never opened inside `subscribeTimeoutMs`. */
  'relay.open-timeout',
  /** error: the subscribe did not complete inside `subscribeTimeoutMs`; the socket closes as relay-unavailable. */
  'relay.subscribe-failed',
  /** error: the transport emitted an error. */
  'relay.socket-error',
  /** warn: admitted without applying `maxSocketsPerSubject` because the connection set could not be read. */
  'relay.socket-cap-unevaluated',
  /** warn: the relay route refused the requested room id and replaced it with the fallback. */
  'relay.room-normalised',
  /** error: the upgrade handler threw (Vercel adapter). */
  'relay.upgrade-threw',
  /** error: a connection failed before the relay attached (node adapter). */
  'node-relay.connection',

  // --- balancer (`src/server/balancer.ts`) ---
  /** error: the stats `MGET` behind a room assignment threw. */
  'balancer.mget-failed',
  /** warn: a room's stats gauge was not parseable; that room is skipped. */
  'balancer.corrupt-stats',
] as const;

/** One of `LOG_KINDS`. */
export type LogKind = (typeof LOG_KINDS)[number];
