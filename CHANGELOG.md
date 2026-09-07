# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-09-07

No library change. The release pipeline: the suite the workflow gates on now
scales its split-brain scheduling slack by the host's measured timer lateness,
tolerates probes a starved timer coalesced into one tick in the cursors
end-to-end case, and retries a case once on CI only. This is the first release
the workflow publishes itself, through npm trusted publishing, so it carries
provenance; 0.3.0 and 0.2.0 were published by hand and do not.

## [0.3.0] - 2026-09-07

### Added

- `ticker.fresh`: a ticker that starts a room without restoring now logs one
  info event saying so, with `meta.checkpoint` naming what the read found
  (`absent`, a refusal reason, or `not-restored` after a geometry mismatch or a
  `deserialize` throw that already logged its own line). A cold start used to
  be silent, so a log reader could not tell "no checkpoint" from "the restore
  path was never reached".

- `SnapshotInterpolator.teleport(key)`: forget one entity's history and place it
  on the frame you have just pushed. Call it from `onSnapshot` AFTER the
  destination frame is pushed, once. `forget(key)` alone leaves the entity
  streaking across the map to its new position, because the next frame pair it
  interpolates spans the teleport.
- `PredictedEntity`'s `step` is handed the tick it is stepping as a fourth
  argument: `step(pose, input, dt, tick)`. Backwards compatible, because a
  three argument step is still assignable. Take it wherever the step reads
  anything that changes with the tick, so a replay reads that context at the
  tick it is replaying rather than at the tick the frame drew.
- `tickroom/testing`, a lockstep client-versus-server harness. `runLockstep` and
  `sweepLockstep` drive your real `RoomRuntime` the way the ticker drives it,
  through your real codec, against the real `PredictedEntity` at a modelled lead
  and delay, and report `maxError`, the reconciles above a threshold, the ticks
  where the prediction was pinned, and the whole per-tick trace. It exists for
  the one class of divergence no library check can see: a step reading context
  the server does not read at the same tick. Imports no Node builtin and no
  `ioredis`, so it loads in a browser test runner.

### Changed

- The relay joins a fragmented `ws` message (an array of buffers) into one
  buffer before calling `decodeInput`, and hands a text frame through as a
  `string`. `decodeInput(data: unknown)` keeps its signature, so a host's
  existing `Array.isArray(data) ? Buffer.concat(data) : data` arm still compiles
  and is now dead code.
- README guidance for a predicted step and the draw loop: keep the step pure of
  anything that only exists on the client's own frame, render every frame rather
  than only on a new snapshot, and note that the interpolator carries only the
  pose fields it knows about, so anything else on an entity has to be read off
  the snapshot directly.

## [0.2.0] - 2026-09-05

The first release with a real API surface, and a source-compatibility break
against 0.1.x in several places. This entry is the migration guide, since 0.1.x
never shipped one.

### Changed

- **One per-frame call.** `RoomConnection.pollStall()` is private and
  `ClientTickView` lost `advance()` and `reportBufferHealth()`. Call
  `conn.frame(now)` once per rendered frame instead: it advances the tick, polls
  the stall and returns the poses to draw.
- **Buffer health is not a call anymore.** The server's playout depth reaches
  the connection only as `inputLead` on the decoded snapshot, which your
  `decodeSnapshot` picks out of your own wire and returns. There is nothing to
  report by hand.
- **`TerminalReason` renamed one member and gained two.** `'rate-limited'` is
  now `'conn-limit'`; `'connect-error'` and `'mint-failed'` are new. A switch
  over the old union needs the rename plus the two new arms.
- **The `in` envelope lost `ts`.** A record's timing is its `targetTick` and
  nothing else. Anything reading `env.ts` off the bus reads the tick instead.
- **`decodeInput` takes `unknown`.** It is handed whatever the transport
  delivered: a `Buffer`, an array of them for a fragmented message, or a
  `string`. Narrow inside your decoder rather than typing the parameter as
  `ArrayBuffer`. (0.3.0 joins the array for you.)
- **The ticker times presence out after five seconds.** A pid whose join
  heartbeat stops for `presenceTimeoutMs` is treated as departed and gets a
  synthesised leave. A test harness or a bot that speaks the relay protocol
  itself has to keep republishing its join, exactly as `attachRelay` does.
- **`ConnectionStats` replaced the old `stats()` shape.** It is now
  `{ rttMs, jitterMs, snapshotsReceived, rejectedSnapshots, underrunRate,
  reconnects, relaySwaps, swapsAttempted, swapsFailed, serverTickHz,
  hostErrors }`. `hostErrors` is the one to watch: it counts throws out of your
  own callbacks, which nothing else reports.
- **`RoomRuntime.tickHz` is required.** The rate was never safe to default,
  because the client derives its timestep from it. State it on the runtime.
- **Every optional hook and option-bag callback is a property signature**
  (`onStarve?: ((...) => void) | undefined`) rather than a method. That drops
  method bivariance, so a consumer who annotated a hook's parameters NARROWER
  than the contract compiled before and errors now. Widen the annotation, or
  drop it and let it be inferred.
