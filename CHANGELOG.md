# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-09-09

A cleanup release. Nothing on the wire or in the contract moved.

### Added

- `docs/API.md` states the supported export surface per subpath. The barrels
  export more than it lists; a name not on it is reachable but internal and
  may change in a minor.
- `npm run lint` (typescript-eslint's recommended set, deliberately minimal)
  and a CI step running it. `noUnusedLocals` and `noUnusedParameters` are on
  in `tsconfig.json`.

### Changed

- Removed a dead `distance` helper from `tickroom/testing`'s lockstep harness.
  No exported name changed.
- The tracked `tickroom-0.1.0.tgz`, the `testFakeRedis.ts` alias file and four
  copies of the same test socket double are gone from the repo. None of them
  shipped.
- `docs/LEDGER.md`, the dated audit history, is deleted; it lives in the git
  history. `AGENTS.md` and the remaining docs were cut to what is current, and
  the per-tier test counts are stated in `AGENTS.md` only.

## [1.0.0] - 2026-09-08

The release that makes the client half one object and the server half one call.
Everything a host used to wire by hand between two objects (three call orders on
a predicted entity, four routes restating the same facts, a playout depth routed
through its own snapshot) is the library's now.

### Migrating from 0.3

Each line is a break and its replacement, most likely first.

- `conn.frame(now)` is `conn.frame(now, input)` once `predict` is set. Omitting
  the input is a `TypeError` naming the option, thrown before anything moves.
- A hand-held `PredictedEntity` becomes `predict: { step, maxSpeed, ownPose }`
  on the connection. Delete the `advance`, `reconcile` and `snapTo` call sites;
  draw `frame().own` and read `conn.own` / `conn.ownStats`.
- `DecodedSnapshotLike.inputLead` is gone. Delete the field from your snapshot,
  your `encodeSnapshot` and your `decodeSnapshot`: the depth reaches the client
  on the library's own `depth` and `input-lead` frames instead.
- The input wire is binary by default. An input that is not `DefaultInput`
  (`{ axes: [x, y], buttons }`) needs `predict.wire: 'json'`, which is exactly
  the 0.3.x frame, or `predict.encodeInput`.
- The default `decodeInput` returns `[]` for malformed input instead of
  throwing. A host that counted those on `onBadInput` writes a `decodeInput`
  that throws.
- `LogEvent.kind` is `LogKind` rather than `string`. A sink that switches over
  it exhaustively compiles; one that manufactures a kind of its own does not.
- `interpolate.into` is optional, so `new SnapshotInterpolator()` on the line
  above the connection can go. `conn.interpolator` is the handle either way.
- Four hand-mounted routes become one `createRoom` call. The three factories
  are still exported and still supported as the low-level form.
- `npm test` is three scripts. `test:unit` needs nothing, `test:integration` is
  the release gate, `test:measure` needs a quiet machine.

### Changed

- **`PredictedEntity` is folded into `RoomConnection` as the `predict` option,
  and `frame()` takes the input.** The documented way to predict your own
  entity is `predict: { step, maxSpeed, ownPose, teleported?, initial?, wire?,
  encodeInput? }` on the connection, `conn.frame(now, input)` once per frame
  (the second argument is REQUIRED once `predict` is set; omitting it is a
  `TypeError` naming the option), and `frame().own` as the pose to draw
  (`null` until the first authoritative pose). The connection advances the
  prediction after the counter and the interpolator, reconciles it against
  every snapshot AFTER `onSnapshot` has run (so a step reading context the
  host refreshes from the snapshot replays through this snapshot's context,
  not the previous one's), and snaps it before the reconcile when
  `predict.teleported(snap)` is true, so none of the three call orders a host
  used to keep by hand exist any more. `conn.own` is the raw prediction (what
  `entity.pose` was) and `conn.ownStats` what `entity.stats` was. Replace
  `new PredictedEntity({ conn, step, maxSpeed, initial })` plus
  `entity.advance(input, dt)` after `conn.frame(now)` plus
  `entity.reconcile(pose, snap.tick)` in `onSnapshot` with the option and the
  one call. The class stays exported for a host with several predicted
  entities; its `conn.send` now takes `ArrayBuffer | Uint8Array | string`,
  its `initial` is optional (the origin), and it carries the same `wire` and
  `encodeInput` options.
- **The input wire is binary by default.** `predict.wire` defaults to
  `'binary'`: `tickroom/codec`'s `encodeInputWindow`, 69 bytes for the six
  re-sent records against about 300 as JSON, with each record's `targetTick`
  written into the `seq` field the library never reads. That requires the
  input to be `DefaultInput` (`{ axes: [number, number]; buttons: number }`,
  new in `tickroom/codec`); the first input is checked at runtime, before
  anything is stamped, and a `TypeError` names the two ways out. A host whose
  input is any other JSON shape passes `wire: 'json'`, which is exactly the
  0.3.x text frame (one array of `{ targetTick, data }` per stamp), or
  `encodeInput` for a wire of its own. `examples/pong` is on `wire: 'json'`
  because `{ dir }` is not a stick.
- **The default `decodeInput` never throws.** `createRoom`'s default (and
  `runLockstep`'s) is `decodeInputAuto` from `tickroom/codec`: a `string`, or
  bytes beginning with `[` or `{`, is JSON; other bytes go through
  `decodeInputWindow`; anything malformed on either path is `[]`. The 0.3.x
  default let `JSON.parse` throw on malformed text so `onBadInput` could count
  it. A host that wants that count writes a `decodeInput` that throws.
  `defaultDecodeInput` in `tickroom/adapters/vercel` is kept as an alias of
  `decodeInputAuto`.
- **`interpolate.into` is optional.** The connection constructs a
  `SnapshotInterpolator` with the default options when it is omitted; the key
  type comes off `interpolate.entities`. Pass it to pin the delay bounds, or
  read `conn.interpolator` for the one the connection is driving either way.
- **The one-entity-per-connection rule is gone.** A second `PredictedEntity`
  on the same `conn` used to throw a `RangeError` from a module-level
  `WeakMap`. The connection now builds exactly one for `predict`, which is what
  the rule protected, and a host building several by hand owns the merge into
  one window; the ticker still keeps one playout buffer per pid.
- **`runLockstep` mirrors `predict`.** Its options are `step`, `maxSpeed`,
  `ownPose`, `wire`, `encodeInput` and `initial` with the same meanings, and
  `decodeInput` takes `unknown` and defaults to `decodeInputAuto`. A pong-shaped
  scenario adds `wire: 'json'`.
- **`FrameView` gained `own`.** `conn.frame()` returns `{ entities, own,
  stalled, dt }`; `own` is `null` without `predict` and before the first
  confirmation.
- **`RoomConnection` and `RoomConnectionOptions` take a third type argument,
  `TInput`,** defaulting to `DefaultInput` and inferred from `predict.step`. A
  host that states the first two and passes a `predict` whose input is a
  different shape states the third as well.
- **The playout depth travels on the library's own frames, and
  `DecodedSnapshotLike.inputLead` is gone.** The ticker publishes one `depth`
  frame per room per second on the roster channel carrying the mean playout
  depth of every buffered pid, each relay forwards its own client's value as an
  `input-lead` control frame, and `RoomConnection` consumes it beside `pong`
  (it never reaches `onText`). The 0.3.x route was four host-owned steps
  (`onBufferHealth` into state, onto the wire, out of `decodeSnapshot`, into
  `inputLead`) and the one most often missed left the stamping lead open-loop
  with nothing saying so. `DecodedSnapshotLike` is `version?`, `tick` and
  `serverTime` and nothing else; `RoomRuntime.onBufferHealth` still fires with
  the same reading for a host that wants it in its own state. Measured at 29
  bytes a second beside 1,610 of snapshots for one 20Hz player.
- **`LogEvent.kind` is `LogKind`, not `string`.** `LOG_KINDS` in
  `tickroom/core` is one `const` array of every kind the library emits
  (`ticker.*`, `relay.*`, `node-relay.*`, `balancer.*`, `ticker.fresh` among
  them), grouped by emitter with a one-line doc each, and `LogKind` is its
  union. A sink can switch over it exhaustively, and a kind the library stopped
  emitting is a compile error in that switch rather than a filter matching
  nothing. `tsc` proves every `log({ kind })` is in the union and `log.test.ts`
  reads the source to prove the converse.
- **`createRelayRoute` takes `maxAgeS`.** It is passed into the route's own
  `verifyToken`, which previously always took the 12 hour default, so an expiry
  a session states is one the socket path enforces. `adapters/node` honours it
  the same way through the option type it derives.
- **The suite is three scripts rather than one.** `npm run test:unit` needs no
  service anywhere, `npm run test:integration` (unit plus integration, a real
  Redis) is the release gate, and `npm run test:measure` is the wall-clock tier
  that runs nightly and by hand on a quiet machine, one file at a time.
  `TICKROOM_TIER` in `vitest.config.ts` selects them, `tests/tiers.test.ts`
  fails the unit tier if a file under `tests/` is in no tier, and the release
  workflow stands up the same Redis service CI does and requires it.

### Added

- `createRoom` in `tickroom/adapters/vercel`, the primary entry point: one bag
  (`runtime`, `secret`, `rooms`, `maxDurationS`, `namespace?`,
  `upgradeWebSocket`, and `ticker`/`relay`/`balancer` partials as escape
  hatches) returning `{ ticker, ws, session, balancer, config }`, each a
  `(req: Request) => Promise<Response>`. Every shared fact is stated once, so a
  relay admitting 20 against a balancer assigning for 8, or a ticker on
  `maxDurationS: 300` beside a relay on 800, is unreachable rather than silent.
  It validates at creation, which is module evaluation.
  `createTickerRoute`, `createRelayRoute` and `createBalancerRoute` are still
  exported and documented as the low-level form.
- `room.session`, the session route made real: it answers the `SessionInfo`
  shape `RoomConnection.mint` expects, refuses a room its own pool does not
  recognise with 400 rather than reassigning it, and takes `sub` from the body
  only when it is short and key-safe.
- `namespace` at the top level of `createRoom`, applied to all three factories
  before the escape hatches. It prefixes keys AND channels, which is the seam
  that actually separates two deployments: a Redis DB index does not, because
  pub/sub is instance-wide.
- `RoomConnection.interpolator`: the `SnapshotInterpolator` this connection is
  driving, whether it was passed as `interpolate.into` or built by the
  constructor, so a host that omits `into` can still read `delayMs` and
  `underrunRate`. `null` without `interpolate`.
- `predict` on `RoomConnectionOptions` (`PredictionOptions`), `frame(now,
  input)`, `FrameView.own`, `conn.own` and `conn.ownStats`.
- `interpolate.teleported(snap)`: the keys this snapshot PUT somewhere. The
  connection calls `SnapshotInterpolator.teleport(key)` for each after its own
  push, which is the one order that call needs; the method stays public for a
  host driving an interpolator by hand.
- `predict.teleported(snap)`: the own entity was put somewhere this snapshot.
  The connection snaps the prediction onto `ownPose(snap)` before reconciling.
- `DefaultInput` and `decodeInputAuto` in `tickroom/codec`; `StampedRecord` and
  `PredictionOptions` in `tickroom/client`.
- `wire` and `encodeInput` on `PredictedEntityOptions`, `LockstepOptions` and
  `PredictionOptions`.
- `LOG_KINDS` and `LogKind` in `tickroom/core`, and `DEPTH_FRAME`,
  `encodeDepth`, `encodeInputLead`, `isInputLeadFrame` and `depthFor` in
  `src/core/wire.ts` for the control plane both ends import.
- `relay.room-full` (info), the one line that says a socket which passed the
  cap check was still turned away.
- `.github/workflows/nightly.yml`, which runs the measurement tier on a
  schedule, uploads its log and blocks nothing.

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
