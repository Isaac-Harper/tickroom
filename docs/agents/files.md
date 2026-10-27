# File map, in full

Moved verbatim from `AGENTS.md`, which keeps the one-line form of each entry
and links here. Inside this file, "the invariants", "the gotchas", "the Gates
section", "the Status section" and "the table" mean
[`invariants.md`](invariants.md), [`gotchas.md`](gotchas.md),
[`gates.md`](gates.md), [`status.md`](status.md) and [`tiers.md`](tiers.md) in
this directory; "above" and "below" mean wherever that file now is.

An INDEX, not a second copy of each file's header: what is where, what couples to
what, and the trust boundaries and orders no single file states on its own. Every
constant and option is documented at its own declaration; read those for the
values, and the invariants below for the rules.

- `src/core/types.ts` - THE CONTRACT: `RoomRuntime`, `RoomEnvelope`, `ClientInput`,
  `CheckpointEnvelope`, `RoomStats`, `Logger`. Change it only with a very good
  reason. `LogEvent.kind` is `LogKind`, not `string`. `CheckpointEnvelope`'s
  OPTIONAL `gridAt` is what lets a successor continue the predecessor's timeline;
  optional and additive, so `CHECKPOINT_VERSION` did not move.
- `src/core/log.ts` - `LOG_KINDS` and `type LogKind = (typeof LOG_KINDS)[number]`.
  `tsc` proves every `log({ kind })` is in the union; `log.test.ts` reads the
  source under `src/` to prove the converse, including a kind passed through a
  parameter, which `tsc` sees as a string. ADD THE KIND HERE FIRST, THEN EMIT IT.
- `src/core/wire.ts` - THE CONTROL-PLANE CONTRACT both ends import, so every name
  here is a coupling: `CLOSE_CODES` (4001 closedByServer, 4002 capacity, 4003
  connLimit, 4004 relayUnavailable, and only the last is not terminal for the
  client); `SERVER_FRAMES` (`meta`, `room-full`, `conn-limit`,
  `relay-expiring {t,inMs}`, `pong {t,n,c}`, `input-lead {t,lead}`, five of the six
  per-socket); `CLIENT_FRAMES` (`ping {t,n,c}`); `ROOM_REJECT_FRAME`; `DEPTH_FRAME`
  (`{ t: 'depth', d: { [pid]: ticks } }`, published by the ticker per
  `DEPTH_INTERVAL_MS`, consumed by the relay, never forwarded); `PING_INTERVAL_MS`;
  `RELAY_EXPIRY_LEAD_MS`, which the relay announces on and the connection rate
  limits its swap by; `JOIN_HEARTBEAT_MS` and `PRESENCE_TIMEOUT_HEARTBEATS`, from
  which `relay.ts` and `ticker.ts` each derive their half of the presence rule; and
  `encodeDepth`, `encodeInputLead`, `isInputLeadFrame`, `depthFor(frame, pid)`,
  which reads OWN properties and finite numbers only, since the pid is a claim.
- `src/core/redisLike.ts` - structural minimum Redis interface, so core never
  hard-imports ioredis. Optional `on?`/`off?` is what lets the ticker treat a
  `'reconnecting'` bus as ownership it cannot vouch for and DETACH. IT IS THE
  SUPPORTED SWAP POINT: a third implementation is held to this surface plus the
  pub/sub extras `Subscriber` adds, and nothing wider.
- `src/core/ids.ts` - `roomKeys`, `roomIdFor`, `normalizeRoomId`, `normalizeBase`.
  A TRUST BOUNDARY: the raw value comes from a query param and is interpolated into
  key names, which have no escaping. TWO DOORS, ONE IMPLEMENTATION:
  `normalizeRoomId` falls back to a known-good id and delegates its base half to
  `normalizeBase`, which returns `null` because its only caller already answers 400
  and redirecting a hostile `?base=` would turn a refusal into a reassignment.
  `roomKeys` is NINE suffixes, the seven original plus `crashes` and `timeline`
  (the last `serverTime` PUBLISHED, written by an exit that saves no final
  checkpoint, read as a floor, deleted by any exit that does write one).
  `KEY_SUFFIXES` is the one list, and `examples/node-server/README.md` prints all
  nine.
- `src/core/lease.ts` - the exactly-one-writer mechanism plus the `OwnershipClock`
  two-clock rule. The single most safety-critical file.
- `src/core/checkpoint.ts` - the checkpoint ENVELOPE grammar, pure:
  `CHECKPOINT_VERSION`, `packCheckpoint`, `inspectCheckpoint`, `unpackCheckpoint`,
  `graceMsFromCheckpoint`. `inspectCheckpoint` is the one to reach for anywhere the
  answer gets logged: it returns WHY it refused (`absent`, `unparseable`,
  `malformed`, `version`); `unpackCheckpoint` throws that away.
- `src/server/checkpoint.ts` - checkpoint STORAGE: gzip with magic-byte sniffing
  and the Redis read/write pair. In this layer because it imports `node:zlib`, and
  it MOVED here rather than merely leaving the core barrel: no node builtin under
  `core/`. The write is OWNER-CHECKED:
  `writeCheckpoint(redis, key, json, ttlS, ownerCheck?)` runs a two-key Lua SET
  Redis itself refuses once the lease has moved on.
- `src/core/playout.ts` - `PlayoutBuffer<T>`, the tick-stamped input buffer with
  never-drop-late re-stamping, plus `aheadBase`, the ahead bound's own reference.
  `push` answers `PushResult` (`'kept' | 'late' | 'stale' | 'refused'`); `late` and
  `refused` are opposite in direction and in cause and get SEPARATE counters, and
  `lateCount` counts only the re-stamps that LAND, so neither statistic is a
  function of the client's window size.
- `src/core/starvation.ts` - the decay policy and `StarveTracker`. `decayOnStarve`
  takes the streak exactly as `RoomRuntime.onStarve` delivers it: 1 on the first
  starve, no `- 1` at the call site.
- `src/core/backpressure.ts` - `Inbox<T>` with a per-sender quota (the fairness
  property, see the gotcha). `src/core/rateLimit.ts` - `TokenBucket`.
  `src/core/metrics.ts` - `percentiles`, `RollingHistogram`, `Counters`.
- `src/server/redis.ts` - ioredis helpers: shared publisher, dedicated subscribers
  (a connection in subscribe mode cannot run ordinary commands), an `onError` hook
  with a rate-limited console default. THE TWO FACTORIES DEFAULT DIFFERENTLY ON
  PURPOSE: the shared client carries `commandTimeout: 2000` merged UNDER the
  caller's own `redisOptions`, which is the bound
  `tests/splitbrain.redis.test.ts` measures against, and the SUBSCRIBER
  deliberately has none. Read `tests/subscriber.redis.test.ts` before touching
  `createSubscriber`.
- `src/server/session.ts` - HMAC tokens with a hard expiry, plus room-bound spawn
  tokens gating the ticker endpoint. The spawn token is a TIME-WINDOWED capability
  rather than a one-shot: `makeSpawnToken` signs `roomId:window` over
  `SPAWN_TOKEN_WINDOW_MS`, `verifySpawnToken` accepts the current window and the
  one before it, and TWO WINDOWS IS THE BOUND.
- `src/server/admission.ts` - `admitSocket` (check, warn on a cap that could not be
  evaluated, refuse or register, attach, unregister on close AND when `attachRelay`
  THROWS, since the ZADD is already written by then), `registerConnection`,
  `refuseSocket` (frame, retry, unconditional close, `frameSent` and `socketClosed`
  latched SEPARATELY). `CONN_TOUCH_MS` and `CONN_KEY_TTL_S` are asserted against
  `relay.ts`'s exported `DEFAULT_CONN_STALE_MS`, never a number retyped here.
  THE PER-SUBJECT CAP IS SOFT: the count (`checkAdmission`) and the registration
  (the `ZADD`) are two round trips, so sockets for one subject admitted
  concurrently can overshoot it by however many were in flight at once, which is
  the accepted price for not making it a single Lua script.
- `src/server/ticker.ts` - THE CORE. `runTicker`, the whole authoritative loop, and
  the file to read slowly. `guardHost` wraps every runtime hook and ticker
  callback; `serverTime` is the SCHEDULED grid time; `playoutMaxAhead` defaults to
  `max(PLAYOUT_MAX_AHEAD, ceil(PLAYOUT_AHEAD_MS / tickMs))`, THIS room's ticks
  rather than a flat count. `EXIT_SPAWN_WAIT_MS` (3500) IS A COUPLING TO THE
  ADAPTER'S `SPAWN_ACK_MS` (3000) RATHER THAN A PREFERENCE, exported so
  `vercel.test.ts` can pin the gap at 500ms of margin and deliberately NOT
  re-exported from the server barrel. `ticker.lease-lost` carries `meta.finder`
  (`guard`, `renew`, `checkpoint`, `setup`); `busSuspect` forces one awaited renew
  before the next publish and its listener is `redis.off`'d on EVERY exit;
  checkpoint writes are serialised through `queueCheckpoint`, which serialises
  the envelope LAZILY, when the chain reaches the write, and skips it once
  `crashed` is set (synchronously, in the loop's catch), so a queued write can
  never carry a thrown tick's half-mutated state; every pre-loop exit
  goes through `abandonSetup`; a CONFIRMED lease loss is checked BEFORE the
  publish block, never after, so nothing is published past it; `acquireLease`
  errors are caught, so a standby keeps polling through a Redis blip; once any
  attempt has thrown, a later null reply is followed by a GET checking whether
  our own owner already holds the key, which counts as acquired and dates
  ownership from the FIRST thrown attempt rather than this one (understates,
  never overclaims), while a recovery GET that itself throws is a lost attempt
  (`'busy'`); whenever any attempt threw, the `'busy'` and `'error'` exits run
  an owner-checked release raced against `CRASH_RECORD_TIMEOUT_MS`; only a last
  attempt that still threw returns `'error'` (`ticker.acquire-failed`) rather
  than rejecting out of `runTicker`; `standbySpawned` is set on ISSUE and
  cleared on REJECT; `reconcileMembership` IS THE SINGLE PLACE MEMBERSHIP
  CHANGES, and drops a buffered pid that is not a member for
  `presenceTimeoutMs` (`dropStrangers`); a `room-reject` is suppressed per pid
  AND connection `c`, budgeted at `REJECTS_PER_INTERVAL` (2) per
  `REJECT_INTERVAL_MS`, since a relay's immediate join and its ack-gated join
  share one `c` and the first reject can be lost before the subscribe acks. It
  publishes `encodeDepth(mean per
  pid)` on `keys.metaout` for the relay, sampled where `onBufferHealth` is
  reported, and exports `HostTickerOptions` for the adapters to spread plus
  `DEFAULT_STANDBY_LEAD_MS`, imported directly by `adapters/vercel.ts` rather
  than through the barrel.
- `src/server/relay.ts` - `attachRelay`, `checkAdmission`, `HostRelayOptions`: one
  socket to the bus, and a CONSUMER of the control plane. It bounds its own
  subscribe, drops snapshots under transport backpressure, holds repeat spawns off,
  announces `relay-expiring` and closes 4004 at `lifetimeMs`, uses ONE
  `messageBuffer` listener for both channels, resolves ONE close code for both
  halves so `onClose` and the wire cannot disagree, stamps its connection id `c`
  on every join and leave, and probes its own subscription on a THIRD channel,
  `{ns}:{roomId}:relay:{conn}`. ITS SUBSCRIBER IS THE ROOM'S, NOT THE SOCKET'S:
  see `src/server/roomSubscriber.ts` below and `sharedSubscriber`. It exports
  `DEFAULT_CONN_STALE_MS` (which
  `admission.ts` asserts against) and `DEFAULT_LIVENESS_TIMEOUT_MS`. A DEAD
  SOCKET WITH NO `terminate` IS CLOSED WITH `relayUnavailable` (4004), NEVER
  1006, which `ws` and a browser throw on if a caller sends it (`dropSocket`);
  the open-timeout path closes 4004 for the same reason. A TRUST
  BOUNDARY on input: a `ping` is recognised by the literal prefix `{"t":"ping"`
  before anything is decoded, on the STRING and buffer arms alike, and
  `joinFragments` normalises an all-`Uint8Array` array into one buffer before
  `decodeInput` sees it. ITS ROSTER CHANNEL IS AN ALLOWLIST: `meta` and any frame
  `t` this library does not define forward, `room-reject` is aimed on pid AND `c`,
  the `depth` frame is consumed and only `depthFor(frame, pid)` leaves as an
  `input-lead` frame through `rawSend` on an OPEN socket and NEVER queued, and the
  five per-socket `SERVER_FRAMES` are dropped and counted. The roster seed map uses
  `Object.create(null)` with plain-object values only, because
  `map['__proto__'] = ...` on an object literal reparents the object. Log kinds:
  `relay.open-timeout`, `relay.no-ping`, `relay.send-failed`,
  `relay.subscriber-dead`, `relay.misaddressed-frame`, `relay.room-full`, and
  `relay.gaps` (`busGapMax`, `busGapOver150`, `sendLagMax`, live via
  `RelayHandle.gapsSample()`).
- `src/server/roomSubscriber.ts` - ONE SUBSCRIBER PER ROOM PER PROCESS, reference
  counted, which is what `attachRelay` joins instead of opening a connection of
  its own. It owns the things that are properties of the SUBSCRIPTION rather
  than of a socket: delivery (the `messageBuffer` listener and the single JSON
  parse of a roster frame, fanned out to every member in process), the shared
  SUBSCRIBE acknowledgement a socket attaching mid-subscribe waits on, the
  RESUBSCRIBE after a reconnect (on the subscriber's `'ready'` past the first,
  re-subscribing the three channels and then telling every member to re-read
  the roster, `onResubscribed`, since whatever published while it was down
  reached nobody), the subscriber's own `'error'` events COUNTED ONCE per
  subscription rather than once per socket (`takeErrors`, flushed by whichever
  member asks first), and the self-probe, one per room PER PROCESS rather than
  one per socket and drops EVERY socket it serves when it goes unanswered. A
  subscribe that never acknowledges is RETIRED (`retire`), not merely
  released, so a socket that joined it mid-failure does not leave a dead entry
  for every later socket to wait out. Everything
  per-socket stays in `relay.ts`: the backlog drop, the join heartbeat, the depth
  frame, the rate limit, liveness, lifetime. THE REGISTRY IS KEYED ON THE
  `createSubscriber` REFERENCE as well as the room, because the factory is the
  only thing that says which Redis a subscription points at; a host passing a
  fresh closure per socket degrades to a subscriber per socket (the pre-1.1
  behaviour) rather than to the wrong bus. `sharedSubscriber: false` is the
  escape hatch.
- `src/server/memoryRedis.ts` - THE IN-MEMORY REDIS, AND IT SHIPS.
  `createMemoryRedis()` returns `{ redis, createSubscriber }`, exactly the pair the
  Redis factories hand out, and is the client every unit test runs against, from
  this one file rather than a copy. IT IS EXPORTED TWICE, DELIBERATELY: from
  `tickroom/server` and from the subpath `tickroom/server/memoryRedis`, the one to
  recommend, because the barrel imports `ioredis` at module top;
  `dist/server/memoryRedis.js` has no ioredis import. FOUR DELIBERATE GAPS: `eval`
  matches the three scripts BY SHAPE, `expire` only touches strings, `publish`
  delivers SYNCHRONOUSLY, there is no `unsubscribe`.
- `src/server/balancer.ts` - `assignRoom`, packing joiners into the lowest-index
  room with space. `BalancerOptions.exclude` validates each entry on its own so a
  stale one is ignored without taking the good ones with it, which makes "every
  instance is excluded" an ORDINARY outcome: both degenerate branches hand back an
  excluded room rather than manufacturing a `full` about a room never read.
- `src/client/netPolicy.ts` - `stallDecision`, `shouldReanchor`. Pure, so the
  thresholds are pinned by tests; they cannot be reached through `RoomConnection`.
  `shouldReanchor` is TWO-SIDED, the unbounded-ahead side (keyed on
  `PLAYOUT_MAX_AHEAD`) deliberately ungated, the `REANCHOR_TOLERANCE_TICKS` side
  rate limited by `REANCHOR_MIN_INTERVAL_MS`. IT TAKES `desiredTick`, NEVER THE RAW
  SERVER TICK.
- `src/client/errorOffset.ts` - `ErrorOffset`. Render-layer correction smoothing.
- `src/client/clientTick.ts` - the monotonic client tick, anchored once per epoch
  and advanced in whole steps by `RoomConnection.frame()`. `anchorTo` is a bare
  `round(targetTick)`, because a lead covering a MEASURED round trip cannot live in
  a class that measures nothing; the lead lives in `RoomConnection.desiredTick()`.
  `ClientTickView` carries `fraction` and `tickMs` for the predicted entity, which
  derives its timestep from the second (what removed the `tickHz` option).
- `src/client/predictedEntity.ts` - `PredictedEntity<TInput>`, THE STAMPED PATH'S
  CLIENT HALF IN ONE OBJECT AND THE OBJECT `predict` OWNS. `conn` is structural
  (`{ tick: ClientTickView; send(payload) }`), so a test passes a fake and
  `RoomConnection` passes as is, and THE TIMESTEP IS `conn.tick.tickMs`. API:
  `advance(input, dt)`, `reconcile(pose, snapTick)`, `snapTo(pose)`, `pose`,
  `stats`, `renderTick` (the playhead the last `advance` drew at, `null` until the
  first `advance` on an initialized counter and from a new epoch until the next); `Pose` is `{ x, y, heading? }` and A REPLAY KEEPS NOTHING ELSE. THE WIRE
  IS BINARY BY DEFAULT: `encodeInputWindow` REQUIRES `TInput` to be `DefaultInput`,
  and EVERY input is checked before anything moves, not only the first (a
  shape a wrong-typed input can satisfy on one call and fail on the next, since
  `DefaultInput` is a type the checker is happy with at `buttons: 256` or a NaN
  axis), with a `TypeError` naming
  `wire: 'json'` and `encodeInput` as the ways out, and both wires decode through
  `decodeInputAuto`. STAMPING AND SENDING STOP WHILE THE COUNTER IS UNANCHORED
  FOR THIS EPOCH: an unanchored counter is still counting, on the OLD room's
  timeline, so a stamp taken then names a tick the new room's playout buffer
  keeps as a far-future entry; the playhead and the draw run on regardless.
  THE DRAW IS A PLAYHEAD, NOT THE COUNTER. The step is
  `step(pose, input, dt, tick)` at all three call sites, `tick` being the record's
  own `targetTick`. `snapTo(pose)` IS THE ONLY CALL THE GAME DRIVES and THE RECORDS
  ARE KEPT across it. `idleInput` (optional, copied, never sent) STEPS THE STARTUP
  GAP, at the first stamp and in the replay; see the invariant.
  `predictedEntity.test.ts` (68 cases) drives it against a
  server model and the REAL `ClientTick` and `PlayoutBuffer` on one wall clock.
- `src/client/interpolation.ts` - `SnapshotInterpolator`: buffered playback on the
  SERVER timeline (`receivedAt` only estimates the clock offset), jitter-adaptive
  delay, never-freeze extrapolation, measured speed. `push()` IS A TRUST BOUNDARY.
  Observability: `delayMs`, `underrunRate`, `rejectedFrames`, `reanchors`.
  `DELAY_SLEW_MAX`, `FRAME_GAP_SLACK_MS` and `RESUME_GLIDE_MAX_MS` are re-exported
  from the CLIENT BARREL, because a constant the tests reach through a deep import
  is one a consumer cannot reach at all. `resumeFrom(held)` is called IMMEDIATELY
  AFTER `clear()`, which is the whole of the ordering, and THE SPEED COMES IN ON
  THE POSE, not out of `this.motion`, which that order empties one line earlier.
  `teleport(key)` IS THE ONE JUMP THIS MODULE MUST NOT SMOOTH, `forget` is NOT the
  call for it (see the host-declared-jump invariant), and ITS CALL ORDER IS A
  CONTRACT, because it reads the destination out of the buffer: the connection
  calls it for the keys `interpolate.teleported` names, after its own push.
- `src/client/connection.ts` - `RoomConnection`, the transport-facing client and
  the owner of three epoch-scoped components: the tick counter, a
  `SnapshotInterpolator` (built by default when `interpolate.into` is omitted, held
  on `this.interp`, handed back by `conn.interpolator`) and the `PredictedEntity`
  (`conn.own`, `conn.ownStats`, both `null` without `predict`).
  `frame(now, input?)` IS THE ONLY PER-FRAME CALL; it also exports
  `RosterFrame`/`isRosterFrame`. THE THREE ORDERS IT OWNS, the reason `predict`
  exists: `frame` advances the entity LAST, after the counter and the interpolator
  sample, returning the drawn pose as `FrameView.own` (`null` until
  `ownConfirmed`) and the tick it was drawn at as `FrameView.ownTick` (the
  entity's `renderTick`, `null` exactly when `own` is: THE OWN RENDER TIMELINE, the
  tick a host draws anything registered with its own entity at); `processSnapshot` pushes the frame, calls `interp.teleport(key)`
  for every key of `interpolate.teleported(snap)`, THEN fires `onSnapshot`, and
  only then `snapTo` (if `predict.teleported(snap)`) and
  `reconcile(pose, snap.tick)`; THE CALLBACK RUNS BEFORE THE RECONCILE ON PURPOSE,
  or a host's step replays through a collision world one snapshot stale, and the
  reconciled pose is a frame away (`frame().own`). `desiredTick()` =
  `estimateServerTick() + rttMs/tickMs + ceil(inputLeadMs/tickMs) + feedbackTicks`
  is the whole lead; `feedbackTicks` comes from the relay's `input-lead` frame,
  read in `handleTextFrame` beside `pong` and `relay-expiring` and NEVER handed to
  `onText`. TRUST BOUNDARY: `processSnapshot`, behind
  `SNAPSHOT_TIME_PLAUSIBLE_MS`, `SNAPSHOT_TICK_JUMP_MAX` and
  `SNAPSHOT_IMPLAUSIBLE_REFUSALS`, the escape RE-ARMING at the adoption point. It
  latches AND closes on `room-full`, `conn-limit` and an own-pid `room-reject`,
  reads a pre-delivery 4001 as a stale token that re-mints, takes
  `start({ remint })` after a terminal, duck-types `ProtocolVersionError` BY NAME,
  and rate limits its warm swap by `RELAY_EXPIRY_LEAD_MS`. `failSwap` sets
  `remintOnNextConnect` rather than clearing `this.session`, because THE OLD SOCKET
  IS STILL OPEN and both `frame()`'s `heldRoom` stamp and the own-pid
  `room-reject` guard read it. `stats()` IS ELEVEN FIELDS: `{ rttMs, jitterMs,
  snapshotsReceived, rejectedSnapshots, underrunRate, reconnects, relaySwaps,
  swapsAttempted, swapsFailed, serverTickHz, hostErrors }`.
- `src/codec/bytes.ts` - `ByteWriter` / `ByteReader`, BOTH TRUST BOUNDARIES: the
  reader bounds-checks every read, and every integer setter refuses a non-integer
  or out-of-range value with `CodecError` rather than letting `DataView` wrap it.
  `ByteReader` ACCEPTS ANY `ArrayBufferView`, NOT ONLY A `Uint8Array`: a caller
  past a permissive boundary hands over a `DataView` or an `Int16Array` just as
  easily, which `new DataView(view)` refuses outright, so it reads through a
  `Uint8Array` over the view's own window (`byteOffset`/`byteLength`) instead.
  Also `ProtocolVersionError`, a `CodecError` subtype carrying `expected`/`found`
  with `name === 'ProtocolVersionError'`, which is what `RoomConnection`
  duck-types on so a host's own codec can participate without importing anything.
- `src/codec/quantize.ts` - clamping (never wrapping) helpers plus
  `representableRange(scale, field?)`, the startup-time check a host asserts its
  world bounds against, and `CM_SCALE` exported so a host can name the default it
  is comparing to. `quantize` THROWS `CodecError` on NaN, which has no direction to
  clamp toward and which `DataView` would store as 0.
- `src/codec/snapshot.ts` - a batteries-included default codec plus the input
  redundancy window. `positionScale` defaults to `CM_SCALE` and `axisScale` to
  `AXIS_SCALE` (127) so the shipped wire is byte-identical; BOTH ENDS MUST AGREE on
  either. `DefaultInput` is `{ axes: [number, number]; buttons: number }`;
  `DefaultInputRecord` adds `seq` and `targetTick`. `decodeInputAuto` is THE ONE
  DECODER FOR BOTH INPUT WIRES and the default `decodeInput` of `createRoom` and
  `runLockstep`; anything malformed is `[]`, NEVER A THROW, and the sniff is
  unambiguous because `INPUT_WINDOW_VERSION` is 1 and neither JSON opener is.
  `encodeDefaultSnapshot` THROWS on an entity id outside `0..65535`, and
  `decodeDefaultSnapshot` checks the version FIRST.
- `src/adapters/vercel.ts` - Next.js App Router route factories, `upgradeWebSocket`
  by INJECTION, importing nothing from next or @vercel/functions. Option bags are
  SPREAD from `HostTickerOptions`/`HostRelayOptions`; admission goes through
  `admitSocket`. `maxDurationS` TIES THE LIBRARY'S LIFETIMES TO THE PLATFORM'S CAP:
  `maxRunMs = min(MAX_TICKER_MS, maxDurationS * 1000 - TICKER_EXIT_MARGIN_MS)` and
  `lifetimeMs = maxDurationS * 1000 - RELAY_EXIT_MARGIN_MS`, floored on the RESOLVED
  value by `MIN_TICKER_RUN_MS` and `MIN_RELAY_LIFETIME_MS`; the cap only ever LOWERS
  the lifetime, so `MAX_TICKER_MS` (700s) stays the default. AN EXPLICIT
  `relay.lifetimeMs` IS CHECKED AGAINST `maxDurationS` AT ROUTE CREATION, same as
  the ticker route's explicit `maxRunMs`: it throws if less than
  `RELAY_EXIT_MARGIN_MS` is left before the platform's own cap, rather than
  announcing an expiry the function is killed before reaching. `standbyMs` and
  `standbyLeadMs` are resolved and checked the same way when the lead is inside
  `maxRunMs`: `standbyMs` must exceed `standbyLeadMs + STANDBY_EXIT_ALLOWANCE_MS`
  (2000, the incumbent's own checkpoint and release) and fit under `maxRunMs`.
  The spawn URL carries `standby=1`, mapped to the resolved `standbyMs`, and
  `deliverSpawn(spawnUrl, standby)`'s `SPAWN_ACK_MS` (3000) IS COUPLED TO THE
  TICKER'S `EXIT_SPAWN_WAIT_MS`: an EXIT spawn rejects only for a failure BEFORE
  the receipt and resolves on a quick answer (the ordinary acquire-race
  outcome), leaves the connection open and drops only the WAIT, never
  `AbortSignal.timeout`; a STANDBY spawn additionally REJECTS on ANY answer
  inside `SPAWN_ACK_MS`, because that means the standby never reached its lease
  poll and `runTicker` must not believe one is still coming. Exports the
  sentinel `SPAWN_DELIVERED`.
  `createRoom` IS THE PRIMARY ENTRY POINT (`VercelRoomOptions` in,
  `{ ticker, ws, session, balancer, config }` out, the `ticker`/`relay`/`balancer`
  hatches applied LAST, `namespace` before them since it prefixes keys AND
  channels, all validated at module evaluation, the message naming
  `createTickerRoute` or `createRelayRoute`). THE SESSION ROUTE IS THE FOURTH
  PIECE AND WAS NEVER A FACTORY: it answers `SessionInfo`, refuses an unrecognised
  room with 400 rather than reassigning it, takes `sub` only when short and
  key-safe (it is a Redis key segment), and copies `claims` by VALUE TYPE because
  `verifyToken` fails closed. `tickerRouteConfig`/`relayRouteConfig` ARE
  DOCUMENTATION, NOT A RE-EXPORT: Next reads `runtime`/`maxDuration` out of the
  route file's SOURCE TEXT. `logRoomNormalised` warns once per request ONLY after
  the token check, since a line per request is a log-volume amplifier and it is the
  one tell that the three `maxRooms` options disagree; `parseExcludeList` caps at
  `MAX_EXCLUDE_IDS`; `defaultDecodeInput` aliases `decodeInputAuto`;
  `createRelayRoute` takes `maxAgeS` into its own `verifyToken`.
- `src/adapters/node.ts` - the same server core behind a plain `ws` server, no
  serverless at all. IMPORTS THE SERVER MODULES DIRECTLY
  (`server/admission.js`, `server/session.js`, `server/ticker.js`), NEVER THE
  `server/index.js` BARREL, because the barrel's `server/redis.ts` re-export
  loads `ioredis` at module top and this adapter's whole reason to exist (one
  process on `createMemoryRedis()`) is the host that never installs it; the
  default `getRedis`/`createSubscriber` pair is loaded ON DEMAND instead
  (`resolveClients`), cached by the module system so the default factory stays
  one function object across calls, which the shared-subscriber registry needs.
  IT IMPORTS NOTHING FROM THE OTHER ADAPTER and carries its own
  copy of `logRoomNormalised` for that reason; its guarded `'connection'` listener
  logs `node-relay.connection` and closes 1011. IT HAS TWO OF THE FOUR PIECES
  `createRoom` COMPOSES, which is why there is no `createNodeRoom`:
  `attachNodeRelay` and `runNodeTicker` share only `redis`/`createSubscriber`,
  passing exactly one of the pair now THROWS (`requireBothOrNeither`) rather
  than silently defaulting the other onto a different store, and the
  `ensureTicker` guard the example hand-rolls.
- `src/testing/lockstep.ts` - the whole of `tickroom/testing`. `runLockstep` runs a
  host's own `RoomRuntime` and its own `predict.step` against each other with a
  modelled `lead` and `delay`, through the host's own `encode`/`decode` so the
  client reads WIRE-QUANTISED poses (options MIRROR `predict`); `sweepLockstep`
  does it per lead/delay combination, reporting `maxError`, `reconciles`, `snaps`,
  `stamped`, `trace` and `pinned`. IT EXISTS FOR THE ONE DIVERGENCE NO CHECK INSIDE
  THIS LIBRARY CAN SEE: a host's step reading context the server does not read at
  the same tick. Its server half MIRRORS `ticker.ts` (arrival pass, consume-exact
  pass for `tickNow + 1`, then the step, with the real `PlayoutBuffer` and
  `StarveTracker`), the snapshot's tick LABEL is read back out of
  `runtime.currentTick` AFTER the step, and nothing here imports a node builtin or
  `ioredis`, which `bundling.test.ts` bundles to prove.
- `examples/pong/` - THE SHIPPED STAMPED REFERENCE. `sim.ts` exports `readDir` and
  `stepPaddleY`, ONE definition of the paddle rule run by both ends, plus
  `usesPlayout`; it implements no `onBufferHealth` and carries no depth on its
  wire, so it is the proof that a host has nothing to route. `client.ts` IS IN TWO
  HALVES AND THE SPLIT IS THE DOM, which is what lets
  `tests/example.redis.test.ts` drive `createPongClient` through a real socket. The
  prediction is the `predict` option and nothing else: the shared `stepPaddleY`,
  `PADDLE_SPEED`, an `ownPose` that finds our paddle by pid, `wire: 'json'`, and NO
  `onTickReanchor` handler at all. `codec.ts` is `PONG_PROTOCOL_VERSION` 3: 2 added
  `inputLead` per paddle and 3 took it back out, each changing what the wire MEANS.
  `sim.test.ts` asserts EXACT equality between the two step definitions on the same
  stamped ticks, with a contrast case that cannot pass vacuously.
- `examples/cursors/` - THE UNSTAMPED CONTRAST, deliberate and documented, with
  comments that point at pong. `createCursorsClient` took the same DOM split and
  adds a `decode` option, defaulting to the inline JSON decoder, because this
  example's wire IS the JSON `sim.ts` publishes.
- `examples/node-server/README.md` - the operating manual for the plain Node host:
  `npm run example:node`, six env knobs, the session endpoint and socket URL
  shapes, a headless Node client, and recipes for watching a planned handoff and
  the relay's warm swap. It wires `onBadInput` and `onRateDrop` into per-socket
  counters flushed on a cadence, the shape every host should copy.
- `tests/faults.redis.test.ts` + `tests/helpers/proxy.ts` - `runTicker` with the
  connection actually BROKEN rather than merely failing, behind a real TCP proxy,
  because every fault here is a property of the SOCKET rather than of the Redis
  protocol: `.break(method)` makes a command FAIL and cannot make one silently
  never answer. Five cases: two black holes, a lease theft with the predecessor
  still ticking, a Redis restart shape, a crash loop. The proxy is SHARED with
  `tests/subscriber.redis.test.ts`, so a change to `holdRepliesMatching` has to
  keep that file green too.
- `tests/example.redis.test.ts` - the one that closes "nothing in CI puts an
  example through a socket": `examples/pong` UNMODIFIED under a real ticker,
  `attachNodeRelay` on a real `ws` server, `createPongClient` on a timer. THE
  RECONCILE NUMBER IS THE ASSERTION THAT PINS IT, and it is not vacuous: 0.0000
  units after the replay against 9 with the server's stamped playout disabled.
- `tests/example-cursors.redis.test.ts` - the OTHER input path, the same rig around
  `examples/cursors`, which declares no `usesPlayout` and leaves `targetTick` at 0,
  so every input takes the ticker's ON-ARRIVAL branch, the one the documentation
  recommends FIRST. NON-VACUITY IS ITS OWN ASSERTION, and `starves` can only be
  asserted zero HERE, because that branch never creates a playout buffer.
- `tests/splitbrain.redis.test.ts` - how long a predecessor keeps PUBLISHING after
  a successor legitimately acquires, with the predecessor's command connection
  shaped by the proxy and `TICKROOM_SPLITBRAIN_REPS` repeating every case (1 in CI,
  10 for the long form). Its lease is the same short 1500/400 `faults` runs on,
  deliberately, since a shortened TTL is exactly the trade the measurement is for. EVERY OBSERVER AND THE SUCCESSOR CONNECT STRAIGHT TO
  REDIS, and the predecessor's client is built by the library's own factory so the
  `commandTimeout` in the bound is the shipped one.
- `tests/depth.redis.test.ts` - the depth loop closed with the host carrying
  NOTHING: a real ticker with only `usesPlayout: () => true` added, a real relay on
  a real `ws` socket, and a `RoomConnection` stamping one record per advanced tick.
  It asserts the lead came down, the server's reading with it, and that no
  `input-lead` ever reached `onText`.
- `tests/memory.test.ts` - THE ONE FILE IN `tests/` THAT NEEDS NOTHING, which is
  why it is named without the `.redis` and never skips. `REDIS_URL` IS DELETED FOR
  THE WHOLE RUN, deliberately, so any path still reaching for `getRedis()` fails
  loudly rather than quietly opening a connection to whatever is on 6379.
- `tests/tiers.test.ts` - the guard that every file under `tests/` is in exactly
  one tier.
- `tests/helpers/jitter.ts` - HOW LATE THIS HOST ACTUALLY FIRES A TIMER, sampled
  once per worker and reported as a factor against `JITTER_LIMIT`. Over the limit
  the gated files SKIP LOUDLY, naming the number they measured, rather than
  loosening a bound of zero that cannot honestly be loosened.
- `tsconfig.json` - `exactOptionalPropertyTypes` is ON, for the consumer's sake
  rather than for ours. See the Gates section.
