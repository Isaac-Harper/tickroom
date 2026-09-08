# tickroom: agent onboarding

Read this once instead of re-deriving the codebase. It is the OPERATING manual:
what the library is, how it is layered, what may never change, what has bitten
people, and how to prove a change is good. Keep it current: whoever changes the
architecture updates the file map, the status and the gotchas in the same commit.

- [`docs/LEDGER.md`](docs/LEDGER.md) is the dated companion: the release
  chronicle, the mutation matrices, every audit round finding by finding, the
  platform measurements, and the owed items as they closed. Nothing in it is a
  rule. A dated incident note belongs there, not here.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the reasoning behind every
  load-bearing decision and is short. Read it too.
- [`README.md`](README.md) is the pitch and the quickstart,
  [`docs/GUIDE.md`](docs/GUIDE.md) the full walk-through,
  [`docs/OPERATIONS.md`](docs/OPERATIONS.md) the cost model, the platform
  limits and the release procedure, and
  [`docs/VERIFICATION.md`](docs/VERIFICATION.md) the measurements.

## What this is

A TypeScript library for running authoritative realtime multiplayer rooms on
serverless functions. Extracted from a shipped multiplayer browser game and
generalised so it works for 2D games, collaborative apps, multiplayer cursors,
or anything realtime where several clients need to agree on state changing many
times a second.

PUBLIC repo, MIT licensed, and PUBLISHED TO NPM as `tickroom`
(`npm install tickroom ioredis`). `package.json` says 1.0.0 and this tree IS
1.0.0: `CHANGELOG.md` is the record of what that release carries, and its
"Migrating from 0.3" list is the break-by-break guide. It also still installs as
a git dependency, which is what `prepare` exists for (npm builds a git dep by
running it, and `dist/` is gitignored), so the hook stays whether or not anyone
uses that route.

RELEASES GO OUT FROM A VERSION TAG through `.github/workflows/release.yml` using
npm trusted publishing (OIDC), so there is no stored npm token to leak; that
workflow's header is the operating manual for cutting one, and
`docs/OPERATIONS.md` has the procedure. `npm version` plus a pushed tag is the
whole of it. The trusted-publisher entry exists on npmjs.com and the workflow
has published on its own once, with provenance. TWO RULES THE FAILED ATTEMPTS
LEFT BEHIND, both operative and both without their dates here (the chronicle is
in the ledger): the release gate runs `test:integration` and never the
measurement tier, because a publish blocked by a noisy shared runner is a
publish blocked by nothing; and the release workflow stands up the SAME Redis
service CI does and sets `TICKROOM_REQUIRE_REDIS=1`, because the real-Redis
files skip cleanly and a publishing build that skipped its way to green is the
one build nobody checked.

## The architecture in one paragraph

Browser opens a wss socket to a RELAY function (one per socket, a dumb pipe with
no simulation in it). The relay decodes the client's input and publishes it on
`room:{id}:in`. A separate TICKER function holds a short-TTL Redis LEASE on that
room, runs the authoritative fixed-timestep simulation, and publishes binary
snapshots on `room:{id}:out` at the sim rate, which the relays forward to their
sockets. The ticker checkpoints the whole room to `room:{id}:state` every second
and, `standbyLeadMs` (3000) BEFORE the platform kills it at its duration cap,
spawns a STANDBY successor that has already paid its cold start and its `init`
and is sitting on the lease poll at the instant the incumbent releases. Nobody
disconnects during a handoff, because the relays are a separate lifetime from
the ticker; and the relay's OWN duration cap is a warm swap rather than a drop,
because it announces `relay-expiring` five seconds ahead and the client adopts a
replacement socket once that socket proves it can deliver.

The two lifetimes have honest and very different budgets. A PLANNED handoff (the
duration cap, the standby path) is a release plus one 25ms poll plus a restore.
An UNPLANNED death (a crash, an instance kill) is the lease TTL plus the relay's
jittered poll plus a cold spawn, MEASURED AT 5 TO 7 SECONDS, so the stall banner
fires and the restored checkpoint may be up to `checkpointMs` old. The client's
interpolation delay plus extrapolation covers at most 650ms of either, and after
that entities glide back onto the confirmed path rather than snapping. See the
arithmetic in `docs/ARCHITECTURE.md` section 1.

The library also owns a small CONTROL PLANE on top of the host's own traffic:
close codes, `ping`/`pong`, `relay-expiring`, `room-full`, `conn-limit`, the
ticker's `room-reject`, and the ticker's once-a-second `depth` frame that each
relay turns into its own client's `input-lead`, all defined once in
`src/core/wire.ts` and imported by both the relay and `RoomConnection`. A
host's own frames never look like one: the relay recognises a ping by the
literal prefix `{"t":"ping"` before it decodes anything. The control plane is
also how the stamping lead closes its loop: the playout depth travels on the
library's frames, so a host's snapshot carries nothing for it.

## Layers, and the rule that separates them

```
src/core/      pure. no IO, no clock, no platform. testable with zero setup,
               and importable in a browser: no file under core/ imports a
               node builtin, which `bundling.test.ts` bundles to prove.
               ALSO the control-plane wire contract (`wire.ts`), because it
               is the one thing both the server and the client must agree
               on and pure constants are safe in both.
src/server/    talks to Redis, and owns everything that needs a node builtin
               (checkpoint gzip lives here for that reason alone).
               platform-agnostic otherwise: imports nothing from next
               or @vercel/functions. these are plain functions a route calls.
               ALSO the admission protocol (`admission.ts`).
src/client/    browser. WebSocket + performance.now() are the only globals it
               needs; sessionStorage/location access is guarded. ONE clock
               domain, `performance.now()`, end to end.
src/codec/     the wire. byte reader/writer, quantisation, a default codec.
src/adapters/  thin wiring per platform. takes the platform handle by
               INJECTION so the library never hard-depends on one host, and
               SPREADS the server option bags rather than re-listing them.
src/testing/   the lockstep harness a host runs against its OWN step. drives
               a `RoomRuntime` the way the ticker does, so it reads as server
               code, but it is under the CLIENT's rule: no node builtin, no
               ioredis, because the runner that already holds the host's step
               is the browser one. `bundling.test.ts` bundles it to prove it.
```

`package.json` `exports` carries one subpath per public entry point: `.`,
`./core`, `./server`, `./server/memoryRedis`, `./client`, `./codec`,
`./adapters/vercel`, `./adapters/node` and `./testing`. `dist/` is gitignored
and every one of them points into it, which is what `"prepare": "npm run build"`
exists for.

THE CONTRACT IS `src/core/types.ts`. `RoomRuntime<TState, TEvent>` is the interface
a user's simulation implements, and the single most important property of the
whole design is that a simulation implementing it knows NOTHING about transport:
no Redis, no socket, no platform import, no clock of its own. That is what lets
the same simulation run authoritatively on the server, speculatively on the
client, and in a unit test with no network, and it is the escape hatch if
serverless ever stops being the right host.

Every `RoomRuntime` method is SYNCHRONOUS and must stay that way. The tick loop's
whole timing guarantee rests on nothing in it ever awaiting.

## File map

The reasoning lives in the invariants and the gotchas below; this is the index
of what is where, with the load-bearing constants named.

- `src/core/types.ts` - THE CONTRACT. `RoomRuntime`, `RoomEnvelope`, `ClientInput`,
  `CheckpointEnvelope`, `RoomStats`, `Logger`. Written first, deliberately,
  because everything else is built against it. Change it only with a very good
  reason. `LogEvent.kind` is `LogKind`, not `string`. `CheckpointEnvelope`
  carries OPTIONAL `gridAt`, the scheduled grid time of the tick it describes,
  so a successor continues the predecessor's timeline; optional and additive, so
  `CHECKPOINT_VERSION` did not move.
- `src/core/log.ts` - `LOG_KINDS`, ONE `const` array of every `LogEvent.kind`
  the library emits, grouped by emitter with a one-line doc each, and
  `type LogKind = (typeof LOG_KINDS)[number]`. `tsc` proves every
  `log({ kind })` is in the union; `log.test.ts` reads the source under `src/`
  to prove the converse, including a kind passed through a parameter, which
  `tsc` sees as a string. ADD THE KIND HERE FIRST, THEN EMIT IT.
- `src/core/wire.ts` - THE CONTROL-PLANE CONTRACT both ends import.
  `CLOSE_CODES` (4001 closedByServer, 4002 capacity, 4003 connLimit, 4004
  relayUnavailable, and only the last is not terminal for the client);
  `SERVER_FRAMES` (`meta`, `room-full`, `conn-limit`, `relay-expiring {t,inMs}`,
  `pong {t,n,c}`, `input-lead {t,lead}`, five of the six per-socket);
  `CLIENT_FRAMES` (`ping {t,n,c}`); `ROOM_REJECT_FRAME`; `DEPTH_FRAME`
  (`{ t: 'depth', d: { [pid]: ticks } }`, the ticker's per-`DEPTH_INTERVAL_MS`
  (1000) broadcast of every buffered pid's MEAN playout depth, consumed by the
  relay and never forwarded); `PING_INTERVAL_MS` (2000);
  `RELAY_EXPIRY_LEAD_MS` (5000); `JOIN_HEARTBEAT_MS` (1000) and
  `PRESENCE_TIMEOUT_HEARTBEATS` (5), which `relay.ts` and `ticker.ts` each
  derive their half of the presence rule from; and the encode/narrow helpers
  (`encodeDepth`, `encodeInputLead`, `isInputLeadFrame`, `depthFor(frame, pid)`,
  which reads OWN properties and finite numbers only, since the pid is the
  client's claim). These were literals repeated in the client, two adapters and
  an example, so a change on one side could not be seen from the other. Pure
  constants, so `core` stays browser-safe.
- `src/core/redisLike.ts` - structural minimum Redis interface, so core never
  hard-imports ioredis; ioredis satisfies it with no adapter. Optional
  `on?`/`off?` for connection-lifecycle events, which is what lets the ticker
  treat a `'reconnecting'` bus as ownership it cannot vouch for and then DETACH,
  since the shared client is a process singleton. IT IS THE SUPPORTED SWAP POINT
  rather than a shape that happens to allow one, because `memoryRedis.ts` is a
  second shipped implementation of it; a third is held to this surface plus the
  pub/sub extras `Subscriber` adds, and nothing wider.
- `src/core/ids.ts` - room identity and Redis key naming. `roomKeys`,
  `roomIdFor`, `normalizeRoomId`, `normalizeBase`. A TRUST BOUNDARY: the raw
  value comes from a query param and is interpolated into key names, which have
  no escaping. TWO DOORS, ONE IMPLEMENTATION: `normalizeRoomId` falls back to a
  known-good id, `normalizeBase` returns `null`, because its only caller already
  answers 400 and silently redirecting a hostile `?base=` would turn a refusal
  into a reassignment; `normalizeRoomId` delegates its whole base half to
  `normalizeBase`. `roomKeys` is NINE suffixes, the seven original plus
  `crashes` (the consecutive-crash counter) and `timeline` (the last
  `serverTime` the room PUBLISHED, written only by an exit that saves no final
  checkpoint, read as a floor, deleted by any exit that does write one).
  `KEY_SUFFIXES` is the one list; a tenth goes there and nowhere else, and
  `examples/node-server/README.md` prints all nine in its startup banner.
- `src/core/lease.ts` - the exactly-one-writer mechanism plus the
  `OwnershipClock` two-clock rule. The single most safety-critical file.
- `src/core/checkpoint.ts` - the checkpoint ENVELOPE grammar, pure:
  `CHECKPOINT_VERSION`, `packCheckpoint`, `inspectCheckpoint`,
  `unpackCheckpoint`, `graceMsFromCheckpoint`. `inspectCheckpoint` is the one to
  reach for anywhere the answer gets logged: it returns WHY it refused
  (`absent`, `unparseable`, `malformed`, `version`) and `unpackCheckpoint` is
  the thin wrapper that throws that away. `gridAt` round-trips optionally:
  absent restores as `undefined`, present-but-not-a-number is `malformed`.
- `src/server/checkpoint.ts` - checkpoint STORAGE: gzip encode/decode with
  magic-byte sniffing and the Redis read/write pair, TTL riding the SET. In this
  layer because it imports `node:zlib`; it used to be in `core/` and made the
  whole core barrel unimportable in a browser. The write is OWNER-CHECKED:
  `writeCheckpoint(redis, key, json, ttlS, ownerCheck?)` runs a two-key Lua SET
  Redis itself refuses once the lease has moved on.
- `src/core/playout.ts` - `PlayoutBuffer<T>`, the tick-stamped input buffer with
  never-drop-late re-stamping, and `aheadBase`, the ahead bound's own reference
  (the first push establishes it, the first consume replaces it). `push`
  answers with `PushResult` (`'kept' | 'late' | 'stale' | 'refused'`). `late`
  and `refused` are opposite in direction and in cause and get separate counters:
  a LATE push arrived after its tick and is applied anyway (a link), a REFUSED
  one sat further AHEAD of the consumed floor than `maxAhead` allows (a
  configuration fault). `stale` is a late push that lost the freshness check
  inside a healthy redundancy window and is deliberately NOT a refusal, and
  `lateCount` counts only the re-stamps that LAND, both so neither statistic is
  a function of the client's window size.
- `src/core/starvation.ts` - the starvation decay policy and `StarveTracker`.
  `decayOnStarve` takes the streak exactly as `RoomRuntime.onStarve` delivers
  it: 1 on the first starve, no `- 1` at the call site.
- `src/core/backpressure.ts` - `Inbox<T>` with a per-sender quota (the fairness
  property, see the gotcha).
- `src/core/rateLimit.ts` - `TokenBucket`.
- `src/core/metrics.ts` - `percentiles`, `RollingHistogram`, `Counters`.
- `src/server/redis.ts` - ioredis connection helpers. Shared publisher,
  per-socket subscriber (a connection in subscribe mode cannot run ordinary
  commands), plus an `onError` hook with a rate-limited console default. THE TWO
  FACTORIES DEFAULT DIFFERENTLY ON PURPOSE: the shared client carries
  `commandTimeout: 2000` merged UNDER the caller's own `redisOptions`, and the
  SUBSCRIBER deliberately has none. See the bounded-wait invariant, and read
  `tests/subscriber.redis.test.ts` before touching `createSubscriber`.
- `src/server/session.ts` - HMAC tokens with a hard expiry, plus room-bound
  spawn tokens gating the ticker endpoint. The spawn token is a TIME-WINDOWED
  capability rather than a one-shot: `makeSpawnToken` signs `roomId:window` over
  `SPAWN_TOKEN_WINDOW_MS` (5 minutes) and `verifySpawnToken` accepts the current
  window and the one before it, because the token rides a query string platform
  access logs keep. Two windows is the bound; widening it turns a bounded leak
  back into an unbounded one.
- `src/server/admission.ts` - `admitSocket` (check, warn on a cap that could not
  be evaluated, refuse or register, attach, unregister on close AND when
  `attachRelay` THROWS, since the ZADD is already written by then),
  `registerConnection`, `refuseSocket` (the immediate attempt, an `'open'`
  listener, a 250ms retry, an unconditional close on the last, and `frameSent`
  and `socketClosed` latched SEPARATELY), `CONN_TOUCH_MS` (10s) and
  `CONN_KEY_TTL_S` (60), both asserted against `relay.ts`'s exported
  `DEFAULT_CONN_STALE_MS` rather than against a number retyped here. It exists
  because this sequence lived in `adapters/vercel.ts`, was imported from there
  by `adapters/node.ts` and was hand-copied into the node example: three copies
  of a protocol the CLIENT latches a terminal reconnect state off.
- `src/server/ticker.ts` - THE CORE. `runTicker`, the whole authoritative loop,
  and the file to read slowly. `guardHost` wraps every runtime hook and ticker
  callback; `serverTime` is the SCHEDULED grid time; publishes are bounded by
  `MAX_IN_FLIGHT_PUBLISHES` (4) with the rest on `publishSkipped`; the post-stall
  resync sleeps a full tick. Its constants: `PROBE_INTERVAL_MS` (1000) and
  `PROBE_DEAD_MS` (3000) for the input-liveness probe that exits `'input-dead'`;
  `CRASH_KEY_TTL_S` (60) and `CRASH_RECORD_TIMEOUT_MS` (500) for the crash
  counter; `GRID_CATCHUP_TICKS` (2) for the grid adoption window;
  `REJECT_INTERVAL_MS` (1000); `MAX_PID_LENGTH` (128); `PLAYOUT_AHEAD_MS` (2000),
  from which `playoutMaxAhead` defaults to
  `max(PLAYOUT_MAX_AHEAD, ceil(PLAYOUT_AHEAD_MS / tickMs))`, two seconds of THIS
  room's ticks rather than a flat count, because a tolerance is a duration;
  `DEPTH_INTERVAL_MS`; and `EXIT_SPAWN_WAIT_MS` (3500), a COUPLING to the
  adapter's `SPAWN_ACK_MS` (3000) rather than a preference, exported so
  `vercel.test.ts` can pin the gap at 500ms of margin and deliberately NOT
  re-exported from the server barrel: a coupling to check, not a knob to turn.
  `TickerOptions.spawnSuccessor`'s doc states its delivery contract.
  ITS EXITS AND OWNERSHIP: `ticker.lease-lost` carries `meta.finder` (`guard`,
  `renew`, `checkpoint`, `setup`); a setup renew that replies false sets BOTH
  `setupLostLease` and `lostLeaseExplicitly`; `busSuspect` on the shared client's
  `'reconnecting'` forces one awaited renew before the next publish and the
  listener is `redis.off`'d on EVERY exit; checkpoint writes are serialised
  through `queueCheckpoint`; every pre-loop exit goes through `abandonSetup`; a
  STANDBY is spawned `standbyLeadMs` before the cap with `standbySpawned` set on
  ISSUE and cleared on REJECT.
  ITS MEMBERSHIP: a `leave` is gated on the relay connection id, the
  `room-reject` it publishes carries that same `c`, `present` follows
  `presentPids` through `reconcileMembership` (the single place membership
  changes), a pid whose heartbeat stops for `presenceTimeoutMs` gets a
  synthesised leave, a buffer that still holds entries reports `onStarve` at
  streak 1, and a roster publish the bus rejected re-dirties `metaDirty`.
  ITS DEPTH FRAME, which is how the client's stamping lead closes its loop with
  the host carrying nothing: every consume samples `buf.health()` into
  `depthSamples` (sum and count per pid, at the same point `onBufferHealth` is
  reported, dropped with the buffer), and once per `DEPTH_INTERVAL_MS` the OWNER
  publishes `encodeDepth(mean per pid)` on `keys.metaout`, rounded to a hundredth
  of a tick, suppressed when nothing is buffered, fire-and-forget with
  `ticker.depth-failed`. A MEAN rather than a point sample, because one frame
  then carries a second of consumes rather than one tick's reading of a buffer
  that jitters by a tick on a healthy link; a FIXED cadence, because a
  change-triggered publish is a rate a client's stamping jitter can drive.
  `lastDepthAt` is dated from the loop's start, so a client that joined before
  the first frame runs open-loop for at most a second, and a successor starts its
  samples empty like the buffers they describe.
  Exports `HostTickerOptions`, every option a HOST owns, for the adapters to
  spread.
- `src/server/relay.ts` - `attachRelay`, `checkAdmission`, `HostRelayOptions`.
  One socket to the bus, and a CONSUMER of the control plane. It bounds its own
  subscribe (`subscribeTimeoutMs` 5000), DROPS snapshots under transport
  backpressure (`snapshotBacklogBytes` 32768), holds off repeat spawns
  (`spawnHoldoffMs` 5000), announces `relay-expiring` and closes 4004 at
  `lifetimeMs`, uses ONE `messageBuffer` listener for both channels, and stamps
  its own connection id `c` on every join and leave. It exports
  `DEFAULT_CONN_STALE_MS` (30s) and `DEFAULT_LIVENESS_TIMEOUT_MS` (90_000).
  ITS ATTACH: `readyState` checked (CLOSED cleans up at once; CONNECTING defers
  the first join, the seed and the timers to `'open'` behind an OPEN DEADLINE of
  `subscribeTimeoutMs`, logging `relay.open-timeout`), control frames produced
  before OPEN queued (`CONTROL_QUEUE_MAX` 8, newest kept, `seedRoster` through
  the same path, nothing logged per frame), one test for a transport `ping()`
  with `relay.no-ping` and `RelayHandle.transportPings` carrying the answer, and
  `cleanup` run by the relay itself after `terminate()`.
  ITS SENDS: failures on an OPEN socket counted and flushed per heartbeat
  (`relay.send-failed` with a `count`), `SEND_FAILURE_LIMIT` (3) consecutive
  throwing sends terminate, the pong reply goes through `rawSend` so a failing
  pong counts toward that run, and `handle.close()` resolves ONE code for both
  halves so `onClose` and the wire cannot disagree.
  ITS INPUT PATH: a `ping` is recognised by the literal prefix `{"t":"ping"`
  before anything is decoded, on the STRING arm and the buffer arms alike, with a
  128-byte cap that is a property of the frame rather than of the transport;
  `joinFragments` normalises an all-`Uint8Array` array into one buffer before
  `decodeInput` sees it and passes anything else through untouched.
  ITS LIVENESS: a THIRD subscribed channel, `{ns}:{roomId}:relay:{conn}`, one
  `PUBLISH` per heartbeat, `PROBE_MISS_LIMIT` (3) unanswered logs
  `relay.subscriber-dead` once, terminates and runs `cleanup(4004)`.
  ITS ROSTER CHANNEL IS AN ALLOWLIST: `meta` and any frame `t` this library does
  not define forward; `room-reject` is consumed and aimed on pid AND `c`; the
  `depth` frame is consumed and only `depthFor(frame, pid)` goes out as an
  `input-lead` control frame through `rawSend` on an OPEN socket and NEVER queued
  (one a second into an eight-slot queue would crowd out the roster seed for a
  value stale by the time the socket opens, and a frame that does not name this
  pid produces nothing, since a 0 would read as "starving, lead more"); the five
  per-socket `SERVER_FRAMES` are dropped and counted as
  `relay.misaddressed-frame`. The roster seed map is built with
  `Object.create(null)` with only plain-object values accepted, because
  `map['__proto__'] = ...` on an object literal reparents the object.
  IT SAYS WHICH SIDE OF ITSELF A GAP CAME FROM: per socket, the inter-arrival gap
  on its OWN subscriber (`busGapMax`, `busGapOver150`, whose threshold is in its
  name because that is the field name on the line too) and the
  bus-arrival-to-send-returned lag (`sendLagMax`), per heartbeat window, logged
  as ONE `relay.gaps` line at info only past 150 and 50ms.
  `RelayHandle.gapsSample()` exposes the window in progress. It also logs
  `relay.room-full` (info) when it honours a `room-reject`.
- `src/server/memoryRedis.ts` - THE IN-MEMORY REDIS, AND IT SHIPS. Three plain
  Maps (strings, hashes, sorted sets) plus a pub/sub bus, shared through a `Hub`
  so `fork()` hands back a second client on the same store the way a command
  connection and a subscriber connection share one logical database. It runs the
  library's three scripts and `on()`/`emit()` drive the lifecycle events
  `RedisLike.on?` exposes. `createMemoryRedis()` returns
  `{ redis, createSubscriber }`, exactly the pair the Redis factories hand out,
  so a host running ONE PROCESS changes nothing above the seam. It is the client
  every unit test runs against, from this one file rather than a copy. IT IS
  EXPORTED TWICE, DELIBERATELY: from `tickroom/server`, and from the subpath
  `tickroom/server/memoryRedis`, which is the one to recommend, because the
  barrel imports `ioredis` at module top and a no-Redis consumer reaching the
  thing that exists to avoid Redis would load Redis to get it.
  `dist/server/memoryRedis.js` has no ioredis import. FOUR DELIBERATE GAPS,
  stated on the file: `eval` matches the three scripts BY SHAPE; `expire` only
  touches strings; `publish` delivers SYNCHRONOUSLY in the publisher's own stack;
  there is no `unsubscribe`. The trade a single process makes is stated on
  `createMemoryRedis` itself and in the README: no horizontal scale, no survival
  of the process (wrong on serverless by definition), and a lease that is a
  re-entrancy guard rather than a split-brain guard.
- `src/server/testFakeRedis.ts` - ONE LINE, `export { MemoryRedis as FakeRedis }`,
  the name every test file imports the in-memory client under. An alias rather
  than a copy, because a divergence between the fake the tests trust and the
  client consumers get would be invisible from either side. Excluded from
  `tsconfig.build.json`.
- `src/server/balancer.ts` - `assignRoom`. Packs joiners into the lowest-index
  room with space. `BalancerOptions.exclude` takes `string | string[] | null`,
  each entry validated on its own so a stale one is ignored without taking the
  good ones with it. That widening makes "every instance is excluded" an ORDINARY
  outcome of a client walking the pool, so both degenerate branches hand back an
  excluded room rather than manufacturing a `full` about a room whose capacity
  was never read.
- `src/client/netPolicy.ts` - `stallDecision`, `shouldReanchor`. Pure, so the
  thresholds are pinned by tests rather than only described; they cannot be
  reached through `RoomConnection`, which needs a live socket to get into these
  states, which is why they live apart. `shouldReanchor` is TWO-SIDED:
  unbounded-ahead past `PLAYOUT_MAX_AHEAD / 2` fires immediately and is
  deliberately ungated, while `REANCHOR_TOLERANCE_TICKS` (2) of error in EITHER
  direction fires at most once per `REANCHOR_MIN_INTERVAL_MS` (2000) and not at
  all while the caller's server clock is mid-step. It takes `desiredTick`, never
  the raw server tick.
- `src/client/errorOffset.ts` - `ErrorOffset`. Render-layer correction smoothing.
- `src/client/clientTick.ts` - the monotonic client tick. Anchored once per
  epoch, advanced in whole steps by `RoomConnection.frame()`. `anchorTo` is a
  bare `round(targetTick)`, because a lead covering a MEASURED round trip cannot
  be a constant in ticks owned by a class that measures nothing; the lead lives
  in `RoomConnection.desiredTick()`. `ClientTickView` also carries `fraction`
  (the accumulator over the tick interval, 0 inclusive to 1 exclusive, reset by
  `anchorTo`) and `tickMs` (the constant the counter was built with), both for
  the predicted entity: it derives its timestep from the second, which is what
  removed the `tickHz` option, and aims its render playhead at
  `value - 1 + fraction`, the point one tick behind the newest stamp.
- `src/client/predictedEntity.ts` - `PredictedEntity<TInput>`, THE STAMPED
  PATH'S CLIENT HALF IN ONE OBJECT AND THE OBJECT `predict` OWNS. It replaced
  four coupled rules a consumer used to hand-write (stamp one record per tick and
  re-send a window; predict each through the shared pure step; replay the records
  with `targetTick > snap.tick` from every snapshot into an `ErrorOffset`; draw
  the owned entity between its tick states) plus an `onTickReanchor` handler. The
  connection makes the calls now; the class stays exported for a host with
  several predicted entities or a render layer of its own.
  OPINIONATED BY DECISION: the options are `conn` (structural,
  `{ tick: ClientTickView; send(payload) }`, so a test passes a fake and
  `RoomConnection` passes as is), `step`, `maxSpeed`, an optional `initial`, and
  the wire pair `wire` and `encodeInput`, and nothing else; THE TIMESTEP IS
  `conn.tick.tickMs`, because a `tickHz` option was the one number a consumer
  could get wrong against the connection. The API is `advance(input, dt)`,
  `reconcile(pose, snapTick)`, `snapTo(pose)`, `pose` and `stats`. `Pose` is
  `{ x, y, heading? }` and A REPLAY KEEPS NOTHING ELSE. Module constants:
  `INPUT_WINDOW` 6 records re-sent per packet, `INPUT_HISTORY` 32 kept for the
  replay (the lead exceeds the re-send window on a slow link), a pose history one
  deeper, `RENDER_SLEW` 0.1, `PLAYHEAD_SNAP_TICKS` 4, glide taus 0.1, a per-frame
  position cap of `maxSpeed * dt` PASSED THROUGH `sample` from each frame's own
  delta rather than baked at 60fps, a heading cap of 0.35 rad, and snap distance
  = offset cap = `maxSpeed * 0.5`.
  THE WIRE IS BINARY BY DEFAULT: `encodeInputWindow` (69 bytes for six records,
  each `targetTick` in the `seq` field the library never reads), which REQUIRES
  `TInput` to be `DefaultInput`; the first input is checked BEFORE ANYTHING MOVES
  and the `TypeError` names `wire: 'json'` and `encodeInput` as the ways out, on
  every frame until it is fixed. `'json'` is the 0.3.x text frame, which is what
  pong's `{ dir }` uses. Both decode through `decodeInputAuto`.
  THE DRAW IS A PLAYHEAD, NOT THE COUNTER. `renderTick` aims at
  `tick.value - 1 + fraction` and moves by each frame's own `dt / tickMs` scaled
  into `1 +- RENDER_SLEW`: never backward, never stopped, never clamped to the
  history's end. Past the newest STORED pose it draws the SPECULATION, that pose
  stepped with this frame's input one tick at a time, at most
  `PLAYHEAD_SNAP_TICKS` deep, rebuilt every frame that needs it, NEVER stored,
  replayed or sent, shifted with the history on a reconcile, and measured as what
  the previous frame DREW (never as the stored history clamped at its end) before
  it is rebuilt. A target further than `PLAYHEAD_SNAP_TICKS` in either direction
  is jumped to and counted; while `tick.anchored` is false the playhead runs at
  real time and neither chases nor snaps. RECONCILE shifts EVERY stored pose by
  the same delta, measures the correction at the playhead, and gates the snap ON
  THE OFFSET THE ABSORB WOULD PRODUCE rather than on the size of the one
  correction, so nothing ever reaches `absorb` that its cap would trim.
  GUARDS: a non-finite pose out of `step`, out of the snapshot or out of a replay
  is a counted snap to the last finite authoritative pose (`stats.invalid`),
  never absorbed, because NaN compares false against every gate and once absorbed
  never left; `advance(undefined)` throws before any state moves; a non-finite or
  negative `dt` is NO TIME; `stats.lastError` is 0 after a refused reconcile.
  RE-ANCHORS ARE HANDLED INSIDE, off `tick.value`, and EPOCHS are watched from
  BOTH `advance` and `reconcile` (the connection anchors and then reconciles in
  the same call). Each record keeps a JSON COPY of the input and predicts through
  the copy, so the replay is byte for byte what the server applied. The step is
  `step(pose, input, dt, tick)` at all three call sites, `tick` being the
  record's own `targetTick`; a three-argument step compiles unchanged.
  `snapTo(pose)` IS THE ONLY CALL THE GAME DRIVES: a respawn, a teleport, a round
  reset, which `reconcile` cannot tell from an ordinary disagreement. THE RECORDS
  ARE KEPT, because they name ticks the server has still to apply; only the poses
  they produced are gone. A non-finite pose is a `RangeError` rather than a
  counted refusal, because this is the host's own call with its own number in it.
  `predictedEntity.test.ts` (59 cases) drives the input-change contract against a
  server model and the RENDER contract against the REAL `ClientTick`, the REAL
  `PlayoutBuffer` and that model on one wall clock, asserting per frame that the
  draw is finite, never steps backward, never moves more than
  `1.1 * speed * dt` outside a counted snap, and that the reconcile error returns
  to exactly zero after each disturbance. Its mutation matrix is in the ledger.
- `src/client/interpolation.ts` - `SnapshotInterpolator`. Playback on the SERVER
  timeline (`serverTime` is the axis; `receivedAt` exists only to estimate the
  local-versus-server clock offset, as a slew-capped sliding-window minimum),
  jitter-adaptive delay sized from one-way delay above that offset floor,
  never-freeze extrapolation, outward bracket scan for an entity a snapshot
  omits, shortest-arc heading, measured speed. `push()` is a TRUST BOUNDARY.
  Observability: `delayMs`, `underrunRate`, `rejectedFrames` and `reanchors`,
  the last two lifetime counters `clear()` does NOT reset. Constants:
  `DELAY_SLEW_MAX` (0.08) caps the delay ease per unit of WALL TIME as well as
  shaping it, `FRAME_GAP_SLACK_MS` (100) is where a caller's clamped `dt` stops
  being believed for the speed smoother, `RESUME_GLIDE_MAX_MS` (1000) bounds the
  resume glide, and all three are on the client barrel, because a constant the
  tests reach through a deep import is a constant a consumer cannot reach at all.
  `resumeFrom(held)` seeds a new epoch from the poses the host is still drawing
  and is called IMMEDIATELY AFTER `clear()`, which is the whole of the ordering.
  Each held entity's first render begins at its held pose and glides onto the
  interpolated one over `EXTRAP_CAP_MS`, clamped by `RESUME_GLIDE_MAX_MS` of
  that entity's measured speed rather than by the extrapolation-unwind clamp,
  which would be zero here. THE SPEED COMES IN ON THE POSE, not out of
  `this.motion`, which the documented call order empties one line earlier;
  `this.motion` stays as a fallback for a host that seeds without clearing, and
  the map `frame()` handed back IS a valid argument. The seed is consumed on
  first render and dropped at the next `clear()`.
  `teleport(key)` IS THE ONE JUMP THIS MODULE MUST NOT SMOOTH. It voids the key
  out of every buffered frame older than the destination (out of a COPY of each
  frame, since the maps belong to the host), drops its motion state so `speed`
  reads 0, refreshes `lastSeenAt`, and HOLDS the entity at the destination,
  `extrapolated: false`, ahead of all three branches of `sample()`, until the
  playhead has two post-teleport frames to bracket; the hold is exactly
  `delayMs` long. A late arrival from before the destination is voided as it
  lands. `forget` is NOT the call for it: see the gotcha. THE CALL ORDER IS THE
  CONTRACT, because it reads the destination out of the buffer, and the
  connection makes the call for the keys `interpolate.teleported` names, after
  its own push. The method stays public for a host driving an interpolator by
  hand, where `onSnapshot` is the right place.
- `src/client/connection.ts` - `RoomConnection`. Reconnect, re-mint, clock sync,
  protocol-skew recovery, stall observation, AND the three epoch-scoped
  components it owns: the tick counter, a `SnapshotInterpolator` and the
  `PredictedEntity` for the player's own entity (the last two optional). Generic
  in the host's snapshot type, the interpolator's key type and the input type
  (`TInput`, defaulting to `DefaultInput`, inferred from `predict.step`).
  `frame(now, input?)` is the ONE per-frame call. Also exports `RosterFrame`
  and `isRosterFrame`, the typed shape of the `onText` roster control frame.
  THE THREE ORDERS IT OWNS, which are the reason `predict` exists at all:
  `frame(now, input)` REQUIRES `input` once `predict` is set (a `TypeError`
  naming the option, before anything moves) and advances the entity LAST, after
  the counter and the interpolator sample, returning the drawn pose as
  `FrameView.own` (`null` until `ownConfirmed`, a flag the first reconcile sets
  and `dropHeldPoses` clears, so it is scoped exactly as the held remote poses
  are); `processSnapshot` pushes the frame, calls `interp.teleport(key)` for
  every key of `interpolate.teleported(snap)`, THEN fires `onSnapshot` so the
  host refreshes whatever context its `step` reads from the snapshot, and only
  then takes `predict.ownPose(snap)` and, when it is not null, calls `snapTo`
  first if `predict.teleported(snap)` and then `reconcile(pose, snap.tick)`.
  THE CALLBACK RUNS BEFORE THE RECONCILE ON PURPOSE: the first cut had the
  reconcile first so a host could read a reconciled `conn.own` from the
  callback, and the first consumer's replay then ran every tick through a
  collision world one snapshot stale. The reconciled pose is a frame away
  (`frame().own`, `conn.own`). `conn.own` is the raw prediction and
  `conn.ownStats` its diagnostics, both `null` without `predict`.
  `interpolate.into` is OPTIONAL: the connection builds a default
  `SnapshotInterpolator` when it is omitted, held on `this.interp`, the only
  field the class reads the interpolator from, and `conn.interpolator` hands it
  back either way so a host that omitted `into` can still read `delayMs` and
  `underrunRate`. Every host callback with a RETURN VALUE is guarded separately
  and counted on `hostErrors`, because a throw there has to skip one specific
  step.
  ITS CLOCK AND LEAD: a monotonic-only server clock on `performance.now()`
  (64-sample window minimum, 5% slew, and a step escape); a REAL round trip
  (`ping`/`pong` off the relay) reported as `stats().rttMs`, a sliding-window
  minimum over `RTT_WINDOW` (8) accepted samples with anything above
  `RTT_MAX_SAMPLE_MS` (5000) or taken across a frozen render loop discarded, and
  a pong matched to an OUTSTANDING ping by its `n` out of a map bounded by
  `RTT_WINDOW`; `desiredTick()` = `estimateServerTick() + rttMs/tickMs +
  ceil(inputLeadMs/tickMs) + feedbackTicks`, `inputLeadMs` defaulting to 150;
  the epoch's first anchor is PROVISIONAL with respect to `anchorRttMs`; the
  re-anchor decision sees `projectedTick`, the counter projected by the time
  since the last `frame()`, capped at `TICK_STEP_CAP` and only once a frame has
  run this epoch, while every other use of `tick.value` stays raw.
  THE SERVER-DEPTH FEEDBACK LOOP is fed from the relay's `input-lead` control
  frame, consumed in `handleTextFrame` beside `pong` and `relay-expiring` and
  never handed to `onText`: an EMA (`DEPTH_EMA_ALPHA` 0.2) against
  `TARGET_DEPTH_TICKS` (2), corrected by at most two ticks, at most once per
  `REANCHOR_MIN_INTERVAL_MS`, and only when the depth is at least two ticks off
  target, landing as `feedbackTicks` inside `desiredTick()` so it arrives as one
  ordinary re-anchor rather than as a silent drift. THE DEADBAND EQUALS THE
  TARGET BY DECISION: a one-tick band hunts. `DecodedSnapshotLike` is
  `version?`, `tick`, `serverTime` and nothing else.
  ITS TRUST BOUNDARY: `SNAPSHOT_TIME_PLAUSIBLE_MS` (60000),
  `SNAPSHOT_TICK_JUMP_MAX` (1e6) and `SNAPSHOT_IMPLAUSIBLE_REFUSALS` (3), with
  the escape RE-ARMING at the adoption point.
  ITS RECONNECT AND SWAP: session validation on `mint()`'s output; an attempt
  GENERATION counter so a stale attempt cannot tear down the live one; deadlines
  on `mint()` and the handshake (`connectTimeoutMs` 10000); a WARM SWAP at the
  relay's cap, rate limited to one per `RELAY_EXPIRY_LEAD_MS` with the deadline
  floored at `SWAP_MIN_DEADLINE_MS` (1000); holding the last poses until the new
  epoch's first snapshot; terminals `'conn-limit'`, `'connect-error'` and
  `'mint-failed'`; a 4001 before this epoch delivered anything read as a stale
  token that re-mints; `start({ remint })` after a terminal; `room-full`,
  `conn-limit` and an own-pid `room-reject` all latching AND closing;
  `ProtocolVersionError` (by name) triggering skew recovery; an
  `ArrayBufferView` sliced to its own window; and the ladder's four exported
  constants, `RECONNECT_BASE_MS` (100) x `RECONNECT_FACTOR` (2), capped at
  `maxBackoffMs` (5000), each delay times a factor in
  `[RECONNECT_JITTER_MIN 0.5, RECONNECT_JITTER_MAX 1.5)`.
  `stats()` IS ELEVEN FIELDS: `{ rttMs, jitterMs, snapshotsReceived,
  rejectedSnapshots, underrunRate, reconnects, relaySwaps, swapsAttempted,
  swapsFailed, serverTickHz, hostErrors }`. `serverTickHz` is the sim rate
  MEASURED as the median of a `TICK_RATE_WINDOW` (21) sample window, with
  `onTickRateMismatch` firing once per epoch after `TICK_RATE_MISMATCH_RUN` (40)
  consecutive pairs more than `TICK_RATE_TOLERANCE` (0.2) away; nothing adopts
  it. `swapsAttempted` and `swapsFailed` exist because the swap reuses the
  cached session, so a token whose `maxAgeS` is shorter than the relay lifetime
  CHAIN has every replacement refused and every cap silently back on a cold
  reconnect; `swapsAttempted - relaySwaps - swapsFailed` is 0, or 1 while one is
  in flight. `failSwap` sets `remintOnNextConnect` rather than clearing
  `this.session`, because THE OLD SOCKET IS STILL OPEN in that window and both
  `frame()`'s `heldRoom` stamp and the own-pid `room-reject` guard read the
  session; the flag is consumed in `connectOnce`, immediately before the mint
  decision. The deadline path keeps the session outright, because a slow answer
  says more about a cold relay start than about the token.
- `src/codec/bytes.ts` - `ByteWriter` / `ByteReader`. The reader is a TRUST
  BOUNDARY and bounds-checks every read; the WRITER is one too, and every
  integer setter refuses a non-integer or out-of-range value with `CodecError`
  rather than letting `DataView` wrap it. Also `ProtocolVersionError`, a
  `CodecError` subtype carrying `expected`/`found` with
  `name === 'ProtocolVersionError'`, which is what `RoomConnection` duck-types
  on so a host's own codec can participate without importing anything.
- `src/codec/quantize.ts` - clamping (never wrapping) quantisation helpers, plus
  `representableRange(scale, field?)`, the startup-time check that turns the
  silent clamp into an assertion a host can fail on. `CM_SCALE` is exported so a
  host can name the default it is comparing against. `quantize` THROWS
  `CodecError` on NaN, which has no direction to clamp toward and which
  `DataView` would store as 0, i.e. a teleport to the world origin;
  `+-Infinity` still clamps, and `quantizeAngle` handles both explicitly before
  its modulo can turn them into NaN.
- `src/codec/snapshot.ts` - a batteries-included default codec plus the input
  redundancy window. `encodeDefaultSnapshot`/`decodeDefaultSnapshot` take an
  optional `positionScale`, defaulting to `CM_SCALE` so the existing wire is
  byte-identical (a pixel host passes 1 for +-32767px at 1px; both ends must
  agree, and the version bump that implies belongs to the host), and
  `encodeInputWindow`/`decodeInputWindow` take an optional `axisScale`,
  defaulting to `AXIS_SCALE` (127). `DefaultInput` is
  `{ axes: [number, number]; buttons: number }` and `DefaultInputRecord` extends
  it with `seq` and `targetTick`. `decodeInputAuto(data: unknown)` is THE ONE
  DECODER FOR BOTH INPUT WIRES and the default `decodeInput` of `createRoom` and
  `runLockstep`: a `string`, or bytes whose first byte is `[` or `{`, is JSON;
  other bytes go through `decodeInputWindow`; anything malformed on either path
  is `[]`, NEVER A THROW, and a host that wants a count writes a decoder that
  throws. The sniff is unambiguous because `INPUT_WINDOW_VERSION` is 1 and
  neither JSON opener is. `encodeDefaultSnapshot` THROWS on an entity id outside
  `0..65535`; `decodeDefaultSnapshot` checks the version FIRST, before a single
  field, and throws `ProtocolVersionError`; `decodeInputWindow` returns `[]` for
  anything that is not a buffer, because an input frame is one of many and a
  throw there is the relay's `onBadInput` path rather than a decode result.
- `src/adapters/vercel.ts` - Next.js App Router route factories. Takes
  `upgradeWebSocket` by injection; imports nothing from next or
  @vercel/functions. The option bags are SPREAD from
  `HostTickerOptions`/`HostRelayOptions` rather than re-listed field by field,
  admission goes through `admitSocket`, and `maxDurationS` ties the library's
  lifetimes to the platform's cap:
  `maxRunMs = min(MAX_TICKER_MS, maxDurationS * 1000 - TICKER_EXIT_MARGIN_MS)`
  (30s margin) and `lifetimeMs = maxDurationS * 1000 - RELAY_EXIT_MARGIN_MS`
  (10s margin), with `MIN_TICKER_RUN_MS` (10s) and `MIN_RELAY_LIFETIME_MS`
  (`2 * RELAY_EXPIRY_LEAD_MS + 1000`) as floors on the RESOLVED value. NOTE THE
  DIRECTION ON THE TICKER: the platform cap only ever LOWERS the lifetime, so
  700s stays the default and a host raising `maxDuration` does not silently get
  longer tickers. The spawn URL carries `standby=1` and the route maps it to
  `STANDBY_WAIT_MS` (8000).
  `createRoom` IS THE PRIMARY ENTRY POINT, with the three factories kept
  exported and documented as the low-level form. One bag (`runtime`, `secret`,
  `rooms: { isValidBase, fallbackRoom, maxPlayers, maxRooms? }`, `maxDurationS`,
  `namespace?`, `upgradeWebSocket`, `tickerUrl?`, `decodeInput?`, `joinMeta?`,
  `onBadInput?`, `onRateDrop?`, `session?`, plus `ticker`/`relay`/`balancer`
  partial bags applied LAST as escape hatches), returning
  `{ ticker, ws, session, balancer, config }`, each a
  `(req: Request) => Promise<Response>`. WHAT IT BUYS IS A MISMATCH MADE
  UNREACHABLE rather than a shorter file: every shared fact used to be written
  into four route files and a disagreement between two of them is silent by
  construction. It validates at creation, which is module evaluation, and the
  message still names `createTickerRoute` or `createRelayRoute` for the
  lifetimes those factories own. THE SESSION ROUTE IS THE FOURTH PIECE AND WAS
  NEVER A FACTORY: `room.session` answers the `SessionInfo` shape
  `RoomConnection.mint` expects, refuses a room its own pool does not recognise
  with 400 rather than reassigning it, takes `sub` from the body only when it is
  short and key-safe (it is a Redis key segment), and copies a `claims` hook's
  extra claims through by VALUE TYPE because `verifyToken` fails closed on a
  claim that is not a string or a number. `defaultDecodeInput` is an alias of
  `decodeInputAuto`. `createRelayRoute` takes `maxAgeS` and passes it into its
  own `verifyToken`, which previously always took the 12 hour default.
  `namespace` is shared at the top level, applied to all three factories before
  the escape hatches, because it prefixes keys AND channels and is the seam that
  actually separates two deployments; a hatch still overrides it per route.
  `tickerRouteConfig`/`relayRouteConfig` ARE DOCUMENTATION, NOT SOMETHING A
  ROUTE FILE RE-EXPORTS: Next's route-segment-config parser reads `runtime` and
  `maxDuration` out of the route file's SOURCE TEXT at build time, so
  `export const runtime = tickerRouteConfig.runtime` fails `next build`.
  BOTH SPAWNS WAIT FOR A RECEIPT, NOT FOR AN ANSWER. `deliverSpawn`
  (`SPAWN_ACK_MS` 3000, the exported sentinel `SPAWN_DELIVERED`) resolves with
  the `Response` if one lands inside the receipt window, with the sentinel if
  none does, and REJECTS only for a failure BEFORE the receipt, which is the
  only kind that means no ticker was started. A non-2xx is handed back unread.
  THE CONNECTION IS LEFT OPEN AND ONLY THE WAIT IS DROPPED, deliberately, rather
  than cut with `AbortSignal.timeout`, because Vercel's request cancellation is
  opt-in per function path and an abort at 3s would kill a successor 3s into a
  cold start measured at 5 to 7 seconds; the rejection handler stays attached
  for the request's whole life, since the headers timeout arrives 300s after
  this promise has settled.
  `parseExcludeList` turns the balancer route's `?not=a,b` into the list
  `assignRoom` validates, capping at `MAX_EXCLUDE_IDS` (64) with the excess
  dropped rather than answered with a 400. `logRoomNormalised` writes one
  `ticker.room-normalised` / `relay.room-normalised` warn per request with the
  raw value truncated to 64 characters, only after the token check has passed
  and only when a non-empty `?room=` differs from the id that came out: it is
  the one tell that the three `maxRooms` options disagree, and it sits behind
  the token check because a line per request is a log-volume amplifier until the
  requests are authenticated.
- `src/adapters/node.ts` - the same server core behind a plain `ws` server, no
  serverless at all. Proves the design is not platform-specific. Derives its own
  option type from the Vercel one minus the three genuinely Vercel-route
  concepts, and imports nothing from the other adapter. Its `'connection'`
  listener is guarded the same way as the Vercel upgrade handler, logging
  `node-relay.connection` and closing 1011. It carries its own copy of
  `logRoomNormalised` (eight lines, duplicated rather than imported, because an
  adapter must not depend on another platform's adapter; on a third host it
  moves to `core/ids.ts`). IT HAS TWO OF THE FOUR PIECES `createRoom` COMPOSES,
  which is why there is no `createNodeRoom`: `attachNodeRelay` and
  `runNodeTicker` are the pair, there is no HTTP layer here at all, and the two
  share almost nothing to state once. What they DO share is
  `redis`/`createSubscriber` (pass both or neither) and the `ensureTicker` guard
  the example hand-rolls, which is the composition worth adding on the day a
  second host wants it.
- `src/testing/lockstep.ts` - the whole of `tickroom/testing`. `runLockstep`
  runs a host's own `RoomRuntime` and its own `predict.step` against each other
  for `ticks` ticks with a modelled `lead` and `delay`, through the host's own
  `encode`/`decode` so the client reads WIRE-QUANTISED poses, on the same input
  wire the page uses (its options MIRROR `predict`, and `decodeInput` defaults
  to `decodeInputAuto`); it builds its own `PredictedEntity` on a fake conn,
  since there is no socket. `sweepLockstep` does it once per lead/delay
  combination. It reports `maxError`, the `reconciles` above a threshold,
  `snaps`, `stamped`, the per-tick `trace`, and `pinned`, the ticks where the
  server's pose moved and the client's raw `conn.own` did not. IT EXISTS FOR THE
  ONE DIVERGENCE NO CHECK INSIDE THIS LIBRARY CAN SEE: a host's step reading
  context the server does not read at the same tick. THREE THINGS ARE
  LOAD-BEARING. The server half MIRRORS `ticker.ts` (the arrival pass, the
  consume-exact pass for `tickNow + 1`, then the step, with the real
  `PlayoutBuffer` and `StarveTracker`); the snapshot's tick LABEL is read back
  out of `runtime.currentTick` AFTER the step rather than carried forward from
  the consume, because a label derived from the consume moves with a consume
  order that is off by one and the two errors CANCEL; and nothing here imports a
  node builtin or `ioredis`, which `bundling.test.ts` bundles to prove, because
  the runner that already has the host's client step in it is the browser one.
  `pinned` has one honest false positive, a client sitting against a wall the
  server has not reached yet, so scenarios stop at their wall rather than past
  it.
- `examples/pong/` - THE SHIPPED STAMPED REFERENCE. `sim.ts` exports `readDir`
  and `stepPaddleY`, ONE definition of the paddle rule run by both ends, plus
  `usesPlayout`. It implements no `onBufferHealth` and carries no depth on its
  wire, so it is the proof that a host has nothing to route. `client.ts` IS IN
  TWO HALVES AND THE SPLIT IS THE DOM: `createPongClient` is all of the netcode
  and none of the browser (one `RoomConnection` with `interpolate` and
  `predict`, and one `conn.frame(now, { dir })` per frame), `startPong` is the
  canvas, the keys and the animation frame on top. What the split buys is that
  `tests/example.redis.test.ts` drives THIS wiring through a real socket rather
  than a retyped copy of it. The prediction is the `predict` option and nothing
  else: the shared `stepPaddleY`, `PADDLE_SPEED`, the spawn pose, an `ownPose`
  that finds our paddle by pid (`null` until the roster names us),
  `wire: 'json'` because `{ dir }` is not a stick, and NO `onTickReanchor`
  handler at all. `codec.ts` is `PONG_PROTOCOL_VERSION` 3: 2 added `inputLead`
  per paddle and 3 took it back out, and each changed what the wire MEANS.
  `sim.test.ts` is the differential test: the client's `stepPaddleY` against the
  server's `applyInput` plus `tick` on the same stamped ticks, EXACT equality
  over 60 ticks, with a contrast case that applies the same records on arrival
  and asserts the traces DIFFER, so the first cannot pass vacuously.
- `examples/cursors/` - THE UNSTAMPED CONTRAST, deliberate and documented, with
  comments that point at pong rather than sketching the stamped shape
  hypothetically. `client.ts` took the same DOM split: `createCursorsClient` is
  the connection, the decode, the interpolator, the labels, the roster, the held
  pointer state and the 100ms send loop that `stop()` clears. The one thing the
  split had to add is a `decode` option, defaulting to the inline JSON decoder,
  because this example's wire IS the JSON `sim.ts` publishes.
- `examples/node-server/README.md` - the operating manual for the plain Node
  host, and it exists because a cold-start run measured 5 minutes 28 seconds to
  a first snapshot with the run command living only in a source comment that
  named the wrong port. It carries the exact command (`npm run example:node`),
  six env knobs, the session endpoint and socket URL shapes, a headless Node
  client, and recipes for watching a planned handoff and the relay's warm swap.
  The example wires `onBadInput` and `onRateDrop` into per-socket counters
  flushed every 10s, which is the shape every host should copy.
- `tests/faults.redis.test.ts` + `tests/helpers/proxy.ts` - the file that runs
  `runTicker` with the connection actually BROKEN rather than merely failing.
  The proxy is a real TCP proxy in front of Redis, because every fault here is a
  property of the SOCKET rather than of the Redis protocol and a fake sits on
  the far side of that socket: `.break(method)` makes a command FAIL, and it
  cannot make one silently never answer. Five cases: a black-holed subscriber, a
  black-holed command client, a lease theft with the predecessor still ticking,
  a Redis restart shape, and a deterministic crash loop. The proxy started
  inside `tests/subscriber.redis.test.ts` and was extracted unchanged, so a
  change to `holdRepliesMatching` (which holds ONE command) has to keep that
  file green too; `delayReplies(shape)` shapes EVERY reply, read live rather
  than captured at the call.
- `tests/example.redis.test.ts` - the one that closes "nothing in CI puts an
  example through a socket". `examples/pong` UNMODIFIED: `pongRuntime` under the
  ticker with `encodePongSnapshot` on the wire, `attachNodeRelay` on a real `ws`
  server, and `createPongClient` on a 16ms timer. THE RECONCILE NUMBER IS THE
  ASSERTION THAT PINS IT, and it is not vacuous: 0.0000 units after the replay
  against 9 with the server's stamped playout disabled, one tick of travel
  rather than the codec's quantisation.
- `tests/example-cursors.redis.test.ts` - the OTHER input path, the same rig
  around `examples/cursors`, which declares no `usesPlayout` and leaves
  `targetTick` at 0, so every input takes the ticker's ON-ARRIVAL branch. That
  branch is the one the documentation recommends FIRST. NON-VACUITY IS ITS OWN
  ASSERTION: with the one `conn.send` made a no-op no probe arrives and no
  coordinate is ever seen, while the rate, the roster and the zeroed counters
  stay perfectly green. Every probe position is a coordinate the server has
  never held. `starves` can only be asserted zero HERE, because the on-arrival
  branch never creates a playout buffer to starve.
- `tests/splitbrain.redis.test.ts` - how long a predecessor keeps PUBLISHING
  after a successor legitimately acquires, against a real Redis with the
  predecessor's command connection shaped by the proxy. The numbers are in the
  ledger; what belongs here is the rig. `TICKROOM_SPLITBRAIN_REPS` repeats every
  case, 1 in CI and 10 for the long form. The lease is the same short 1500/400
  the faults file runs on, deliberately, since a shortened TTL is exactly the
  trade the measurement is for. EVERY OBSERVER AND THE SUCCESSOR CONNECT
  STRAIGHT TO REDIS: only the predecessor's command client is on the shaped
  path, built by the library's own factory so the `commandTimeout` in the bound
  is the shipped one, and its subscriber is direct too, or the input-dead probe
  would end runs the lease guard is supposed to end.
- `tests/depth.redis.test.ts` - the depth loop closed with the host carrying
  NOTHING. A real ticker on the toy counter runtime with only
  `usesPlayout: () => true` added, a real relay on a real `ws` socket, and a
  `RoomConnection` at `inputLeadMs: 500` stamping one record per advanced tick.
  It taps both bus channels and asserts the client ran open-loop first, the
  ticker's frames read that buffer deep, the lead then came down by at least two
  ticks, the server's reading came down with it, no `input-lead` ever reached
  `onText`, and the depth frames cost under a twentieth of the snapshot bytes.
- `tests/memory.test.ts` - THE ONE FILE IN `tests/` THAT NEEDS NOTHING, which is
  why it is named without the `.redis` and why it never skips. It is the example
  file's shape with the bus swapped out: `createMemoryRedis()` supplies both
  halves of the host with the same pair. It pins the two things a memory bus can
  get silently wrong: that snapshots FLOW and that STAMPED INPUTS LAND.
  `REDIS_URL` IS DELETED FOR THE WHOLE RUN, deliberately, so any path still
  reaching for `getRedis()` fails loudly rather than quietly opening a
  connection to whatever is listening on 6379. The mutation is a subscriber
  built on a DISJOINT store, and it reddens it.
- `tests/tiers.test.ts` - the guard that every file under `tests/` is in exactly
  one tier, added when a parallel branch left `depth.redis.test.ts` in none.
- `tests/helpers/jitter.ts` - HOW LATE THIS HOST ACTUALLY FIRES A TIMER, twelve
  samples of a 25ms `setTimeout` reported as a factor, taken once per worker. An
  idle machine reads 1.05 to 1.10 rather than 1.00, and `JITTER_LIMIT` is 1.5.
  Over the limit the gated files SKIP LOUDLY, naming the number they measured,
  rather than loosening a bound of zero that cannot honestly be loosened. A skip
  is a worse outcome than a pass and a better one than a red that means nothing.
- `tsconfig.json` - `exactOptionalPropertyTypes` is ON, for the consumer's sake
  rather than for ours. See the Gates section.

## Non-negotiable invariants

Rules. The measurement each one came from is in `docs/LEDGER.md`, and the trap it
guards against is usually a gotcha below.

- `src/core/` stays pure: no Redis, no sockets, no platform imports, no clock
  reads, ever. ENFORCED rather than asserted, by `src/client/bundling.test.ts`.
- `src/server/` imports nothing from `next` or `@vercel/functions`. A hard import
  would make the library refuse to install outside one platform.
- NO AWAITS IN THE TICKER HOT LOOP except the sleep to the next grid point. One
  `await` on a Redis round trip inside the loop and a slow network stretches
  every tick in the room.
- Only a CONFIRMED lease renew advances ownership, and ONE FUNCTION PER CLOCK IN
  `lease.ts`: `renewAttempted` moves `lastRenewAt`, `renewConfirmed` moves
  `lastOwnedAt`, `renewFailed` moves neither. Any function able to move both is a
  step back toward the collapsed timestamp the module exists to prevent. A caller
  that uses `renewDue` MUST call `renewAttempted`.
- OWNERSHIP IS DATED FROM THE RENEW ATTEMPT, not from the reply, because Redis
  extended the key when it PROCESSED the command. The split-brain margin that
  buys is MEASURED by `tests/splitbrain.redis.test.ts`; changing this line,
  `mayPublish` or the `SET NX` invalidates a measurement rather than an argument.
- EVERY EXIT FROM THE TICK LOOP NAMES ITSELF, and a lost lease has TWO finders
  (the async renew's `lostLeaseExplicitly` and the synchronous pre-publish
  `mayPublish` guard) that must both set it. `exitReason` defaults to
  `'duration'`, the one exit that means everything is fine.
- A checkpoint carries a geometry digest and a mismatch starts fresh, and A
  CHECKPOINT WHOSE VERSION THIS BUILD DOES NOT IMPLEMENT STARTS FRESH in both
  directions, with the log line saying so.
- Capacity is read from ONE key (`room:{id}:stats`) by both the relay and the
  balancer.
- A COUNTER COUNTS WHAT HAPPENED, NOT WHAT WAS ATTEMPTED: `publishes`,
  `bytesPublished` and `bytesDelivered` move inside the publish promise's
  `.then`, never beside it.
- AN EMPTY METRIC WINDOW IS `null`, NEVER ZEROS. For a latency distribution zero
  is the BEST value, so a flattened empty window reports the healthiest possible
  reading for the sickest possible state.
- A CAP THAT COULD NOT BE EVALUATED SAYS SO. `checkAdmission` still fails OPEN on
  a Redis fault, because failing closed locks users out of a healthy deployment;
  what it may not do is fail open invisibly.
- A LIVENESS DEADLINE IS SIZED AGAINST THE SLOWEST CADENCE A HEALTHY CLIENT CAN
  HAVE, NOT THE ONE IT ASKED FOR. The client picks a ping interval; the BROWSER
  picks the one it gets, and a hidden tab drops to about one callback a minute.
  `DEFAULT_LIVENESS_TIMEOUT_MS` is 90_000 and must stay above 60s for any browser
  client. The protocol pong is what makes a shorter deadline safe, because the
  network stack answers it below page JavaScript, so it may only be shortened as
  far as the WORST transport in the deployment supports.
- AN OPTIONAL TRANSPORT CAPABILITY IS DETECTED AND REPORTED AT ATTACH, NEVER
  ASSUMED. `socket.ping?.()` on a transport with no `ping` is a silent no-op that
  reads at every call site as a ping that went out. The no-op is not the bug,
  believing it worked is; any future optional method gets the same treatment.
- A wire change bumps the protocol version when it changes MEANING, not only when
  it changes SHAPE. Re-ordering an enum moves no byte and is still a bump.
- Anything whose rate a client controls is COUNTED in process and flushed on a
  cadence the client cannot drive, never written to Redis or logged per message.
  Otherwise the rate limiter is an amplifier. AND A `room-reject` IS ONE OF THOSE
  PATHS, which is easy to miss because it looks like a reply: it goes out on the
  roster channel, so it fans out to every socket in the room, and it is answered
  off a join. A fan-out obeys the rule exactly as a log line does.
- ANYTHING KEYED BY PID IS DROPPED WHERE `presentPids` STOPS REPORTING IT, NOT
  ONLY WHERE A LEAVE ARRIVES. A runtime with a grace period never emits a leave
  for the player it eventually forgets. `reconcileMembership` is the single place
  membership changes; a map cleaned up on the leave path alone is a leak with a
  player's name on it.
- Interpolate remote entities on the SERVER's clock, never on the local arrival
  clock. Arrival times are the noise; `serverTime` is the signal.
- Never freeze a remote entity on interpolation underrun. Extrapolate.
- `SnapshotInterpolator.push()` IS A TRUST BOUNDARY, exactly like `ByteReader`,
  and FINITE IS NOT THE SAME AS PLAUSIBLE. A non-finite `serverTime` or
  `receivedAt` is refused before it touches any accumulator, and so is an implied
  one-way delay more than `OFFSET_FLOOR_SLACK_MS` BELOW the sliding-window floor.
  The types say `number`; the value crossed a host-owned decode boundary.
- THE FUTURE-STAMP REFUSAL MUST NOT BE PERMANENT, because a server clock that
  genuinely steps forward trips the same test on every frame. Past
  `TIMELINE_STEP_FRAMES` refusals WITHIN `TIMELINE_STEP_WINDOW` judged frames the
  run becomes the new anchor. The WINDOW ages the count out instead of one
  in-floor frame resetting it, which is what makes a one-off corrupt stamp and a
  sustained step distinguishable WITHOUT depending on arrival order.
- The interpolator's clock offset is eased, EXCEPT when the playhead has been
  stranded for `REANCHOR_AFTER_MS` (600) with at least `REANCHOR_MIN_SAMPLES` (5)
  frames arrived since. "Frames still arriving" is the whole safety of that
  mechanism: an outage strands the playhead the same way and there is nothing to
  re-anchor TO. The COUNT is load-bearing too, because the re-anchor adopts the
  minimum of the window's samples with no slew. Never weaken that gate.
- Nothing in the interpolator may evict a frame the playhead is still bracketing
  against, and while an error window is open the time-based prune is SUSPENDED,
  because its horizon is derived from a playhead the class has stopped believing.
- A reconnect CLEARS AND THEN RESUMES the interpolator, and the connection does
  it: `markUnanchored()`, `clear()`, `resumeFrom(held)`, in that order, because
  `clear()` drops the seed with everything else. The connection is the one that
  can: the held poses are `frame()`'s own output and the moment they stop being
  valid is the epoch boundary. THE LESSON IS THE ONE THIS REPO KEEPS RELEARNING:
  the fix for "every consumer must hand-write these lines correctly" is to write
  the lines once, not to write fifteen lines of README about them.
- `RoomConnection.frame()` IS THE ONLY PER-FRAME CALL, and that is a safety
  property rather than ergonomics. `ClientTick.advance` is public on the CLASS
  but `conn.tick` is typed `ClientTickView`, which does not name it, so a host
  can neither forget it nor drive it twice.
- `RoomConnectionOptions.tickHz` IS REQUIRED. A default on a number the host
  always knows is a silent 2x error waiting for the first 10Hz room: it drives
  the counter's step, `estimateServerTick`'s slope, the underrun threshold and
  the prediction's timestep at once.
- `SnapshotInterpolator<K>` HAS NO DEFAULT KEY TYPE. Pids are strings everywhere
  the simulation contract touches; `CodecEntity.id` is a number. A default is
  only ever silently wrong for one of them.
- `CodecEntity.id` IS REFUSED OUT OF RANGE, not clamped and not wrapped. Clamping
  is right for a coordinate and wrong for an identity: there is no nearby value.
- NOTHING A HOST HOOK DOES MAY REACH THE LOOP. `guardHost` catches a throw AND
  attaches a `.catch` to anything thenable, because every hook is declared `void`
  and an `async` method satisfies a `void` return perfectly. `tick`,
  `currentTick`, `playerCount`, `encodeSnapshot`, `serialize`, `create` and
  `deserialize` stay UNGUARDED on purpose: those are not reached through a
  client-supplied payload, so a throw in one is a genuine loop failure.
- A THROWN TICKER WRITES NO FINAL CHECKPOINT AND SPAWNS NO SUCCESSOR. The state
  at the moment of a throw is half-mutated by definition. It releases the lease,
  increments `room:{id}:crashes`, and lets the relay's poll pace the retry.
- THE CRASH WINDOW IS FIXED, NOT SLIDING, AND IT IS CLEARED BY UPTIME, NOT BY A
  CHECKPOINT: the `EXPIRE` runs only when the `INCRBY` came back 1, so the window
  is dated from the FIRST crash of a run, and the counter clears only once the
  invocation has itself run for `CRASH_KEY_TTL_S` of uptime, because clearing at
  the first checkpoint lets poison slower than `checkpointMs` escape forever. AND
  THE RECORD IS AWAITED, raced against `CRASH_RECORD_TIMEOUT_MS`, because
  unawaited the `EXPIRE` is not even ISSUED until after `runTicker` has returned.
- EVERY PRE-LOOP EXIT RUNS THE LOOP'S OWN TEARDOWN, through `abandonSetup`:
  subscriber disconnected, runtime disposed, listener detached, lease released
  where releasing is right.
- `serverTime` IS THE SCHEDULED GRID TIME, never a clock read taken after
  `runtime.tick`. That field is the axis every client interpolates remote motion
  on, so stamping it afterwards writes the tick's COMPUTE VARIANCE into the
  playback timeline.
- A CHECKPOINT WRITE IS OWNER-CHECKED IN REDIS, not gated on the local `owns`
  flag, which is a belief that lags reality by up to a renew period. A refusal IS
  a lost lease and exits the loop.
- CHECKPOINT WRITES ARE SERIALISED THROUGH ONE CHAIN, AND THE FINAL ONE AWAITS
  IT, because `writeCheckpoint` compresses BEFORE it issues its `SET` and gzip
  time scales with the body, so two writes started in tick order otherwise reach
  Redis in gzip-completion order. The chain makes the order the ROOM's rather
  than the compressor's and costs nothing on the ordinary path.
- A CHECKPOINT CARRIES THE GRID IT WAS TAKEN ON, AND A SUCCESSOR CONTINUES IT.
  Both halves of the adoption window are load-bearing: after a hard death the
  newest checkpoint is a periodic one the predecessor kept publishing past, so
  `continued` is far behind now and the window refuses it, and the axis stays
  strictly increasing either way. THE WINDOW IS ASYMMETRIC AND THE TWO SIDES ARE
  DIFFERENT FACTS: one tick AHEAD (a grid point not due yet, which the loop
  sleeps to, so one tick is all the slack there can be) against
  `GRID_CATCHUP_TICKS` (2) BEHIND, which is where a handoff actually lands. A
  symmetric one-tick window turns the case the mechanism exists for into the
  fallback it exists to avoid; there is no middle value, and two rather than
  three because the loop's own drift rule resyncs past one tick.
- AND OUTSIDE THE WINDOW THE CLOCK PACES THE GRID WHILE AN OFFSET CARRIES THE
  TIMELINE. Restarting locally makes the first stamp a bare `Date.now()` on a
  clock with no relationship to the predecessor's, so a successor running BEHIND
  stamps before the predecessor's last frame, and a backward step on the playback
  axis is a timeline contradicting frames already in the client's buffer.
  Sleeping the skew off is not the fix either, because that hands the room a gap
  as long as the skew.
- AN EXIT THAT WRITES NO CHECKPOINT STILL OWES THE SUCCESSOR A FLOOR, AND THAT IS
  `room:{id}:timeline`. It is written BEFORE the lease is released, because the
  instant the lease is free a standby can reach its own grid decision; applied at
  restore as `max(gridAt, timeline)` whether or not a checkpoint restored; and
  DELETED by any exit that does write a final checkpoint, because that
  checkpoint's own `gridAt` is strictly better than a floor and a stale marker
  would raise the floor of every successor for a whole state TTL.
- THE INVOCATION'S LIFETIME IS MEASURED FROM INVOCATION ENTRY; ONLY OWNERSHIP IS
  DATED FROM THE ACQUIRE. `maxRunMs` exists to stay inside a cap the PLATFORM
  measures from the moment the request arrived, so a standby's poll comes out of
  the same budget rather than being free.
- `standbyMs` MUST EXCEED `standbyLeadMs` PLUS THE INCUMBENT'S OWN EXIT, AND MUST
  FIT INSIDE `maxRunMs`. `standbySpawned` is set on ISSUE and cleared on REJECT,
  because a spawn request to a ticker endpoint does not respond until the
  successor exits minutes later; a rejected standby does not suppress the exit
  spawn.
- THE INPUT WINDOW IS PUSHED NEWEST FIRST, but only after the first consume,
  because before then the ahead bound has no consumer floor and the first push
  establishes the reference itself. Two regimes, cleanly separated.
- AN UNSTAMPED RECORD SUPERSEDES THE STAMPED ONES BEFORE IT IN ITS OWN WINDOW: an
  unstamped input means the player stopped driving a stamped stream, so only
  records after the LAST unstamped one belong to the stream still running. And
  `targetTick` counts as stamped only when it is a finite POSITIVE INTEGER: the
  string "5" passes `> 0`, then keys the buffer by something no numeric consume
  can ever match.
- THE STEP THAT PRODUCES TICK T CONSUMES THE INPUTS STAMPED T. `currentTick` is
  the number of COMPLETED ticks, so the consume pass takes `currentTick + 1`,
  acks that tick, then steps, and the snapshot labelled T already reflects the
  input stamped T. That is the exact set a reconciling client replays: its
  records with `targetTick > snap.tick`. Stated once on `RoomRuntime.currentTick`
  and pinned by two `ticker.test.ts` cases.
- EARLY IS NOT STARVED. A buffer that still holds entries has this player's
  inputs, stamped for ticks the room has not reached: nothing was lost, the two
  clocks disagree about where "now" is, which is what every handoff produces. It
  is reported at streak 1 and never ramps the decay; a genuinely EMPTY buffer
  keeps the streak, which is the sawtooth backstop.
- A RELAY IDENTIFIES ITSELF (`c` on every join and leave), AND A LEAVE FROM A
  RELAY THE PLAYER HAS ALREADY REPLACED IS IGNORED, because sockets are swapped
  routinely and the order two relays reach the bus in is not guaranteed. A leave
  carrying no `c` is honoured as before: there is nothing to contradict it with.
- `attachRelay` CHECKS `readyState`, NEVER ASSUMES OPEN. The caller awaited
  `checkAdmission` to get here, so the socket may already be CLOSED or still
  CONNECTING.
- A DEFERRAL NEEDS A DEADLINE, AND A CONTROL FRAME PRODUCED BEFORE OPEN NEEDS A
  QUEUE. Deferring to `'open'` is only correct if `'open'` is guaranteed, and it
  is not. The frames produced in that window are queued rather than attempted (a
  send in CONNECTING throws on `ws`) and rather than dropped (a roster seed is
  announced once and nothing repeats it). `refuseSocket` gets the same treatment
  from the other side.
- A RUN OF FAILING SENDS IS A DEAD SOCKET, AND ONE FAILING SEND IS NOT.
- A REFUSAL NEEDS TWO LATCHES, BECAUSE THE FRAME AND THE CLOSE ARE DIFFERENT
  PROMISES. One combined "already refused" flag makes a THROWING send read as a
  completed refusal and leaves the socket open, unrefused and relay-less. The
  frame is best effort; the CLOSE is the refusal, so the backstop closes on "not
  closed" rather than on "frame did not go out".
- THE SNAPSHOT FORWARD MAY DROP; THE `metaout` FORWARD MAY NOT. A snapshot is
  full state and the next one supersedes it; a roster change is announced exactly
  once. BUT THE `metaout` FORWARD IS AN ALLOWLIST, NOT A PASSTHROUGH, and that is
  the other half: the roster channel is a BROADCAST and the per-socket
  `SERVER_FRAMES` are facts only the relay holding that socket may originate, so
  one arriving there is misaddressed by construction and forwarding it verbatim
  latches every client in the room. They are dropped and COUNTED. A host's own
  control traffic still forwards untouched, which keeps this a filter, not a cage.
- A RELAY PROBES ITS OWN SUBSCRIPTION, SAME MECHANISM AS THE TICKER'S AND FOR THE
  SAME REASON, and PER CONNECTION rather than per room: a shared channel is
  quadratic in room size and, worse, lets a healthy subscriber answer for a dead
  one, which turns the one signal built to catch this into the thing hiding it.
- A PROBE ANSWER IS BOUNDED BY WHAT WAS SENT, NOT MERELY MONOTONIC, on both
  probes, because both channel names are derivable by anyone who can write to the
  bus: one forged `n` of 1e15 against an unbounded `n > answered` pins the
  counter above every `n` the watchdog will ever reach. The test is
  `Number.isInteger(n) && n > answered && n <= sent`. A reply to a question
  nobody asked is not an answer.
- A GAP IS ATTRIBUTED BY WHICH SIDE OF THE SOCKET SAW IT, AND ONLY THE RELAY CAN
  SAY. THE READING RULE: a `relay.gaps` line whose `busGapMax` matches a client's
  gap puts the cause UPSTREAM of the socket; a client gap with no relay line
  beside it is the socket path itself. The line is silent on a healthy socket by
  design, so its absence is half the reading and not a missing measurement.
- ABSENT IS THE ONLY THING THAT MEANS UNSPECIFIED, on the `room-reject`'s `c`. A
  `typeof c === 'string'` guard read a wrong-typed `c` as absent and fell back to
  pid alone, which closes BOTH of a swapping player's sockets: the exact
  regression the field exists to prevent, reached through the guard meant to
  enforce it. The test is `c !== undefined && c !== conn` refuses.
- A `room-reject` IS AIMED AT A CONNECTION, NOT BROADCAST AND NOT AT A PID. The
  ticker publishes it on a broadcast channel and the RELAY is the only place that
  knows which socket carries which pid; and a pid deliberately holds two live
  sockets during a swap. One arriving without `c` still matches on pid alone,
  because that is an older ticker.
- EVERY WAIT ON REDIS IS BOUNDED, BUT NOT ALWAYS BY THE SAME MECHANISM: a
  `commandTimeout` on the shared client, and a bound at the CALL SITE for the
  subscriber, plus the checkpoint read's retry budget. An unbounded wait on a
  black-holed connection is not slow, it is permanent, and it takes the `finally`
  with it. A client-wide timeout on a SUBSCRIBER would also apply to the
  resubscribe ioredis issues for you after a reconnect, whose promise nothing
  catches, so a slow reconnect would exit the process. THAT IS NOT A HYPOTHETICAL
  AND NOT AN OVERSIGHT TO TIDY UP: it was set once, reproduced through a TCP
  proxy and taken back out. The shared client's own db is part of the same rule:
  the identical ready handler issues `select(db)` uncaught, so use db 0.
- ONE ADMISSION PROTOCOL, and it lives in `server/admission.ts`. Not in an
  adapter, not imported by one adapter from another, not copied into an example.
  The client latches a terminal reconnect state off these close codes.
- `RoomConnection.processSnapshot` IS A TRUST BOUNDARY, AND FINITE IS NOT
  PLAUSIBLE HERE EITHER. A CONSECUTIVE refusal count is safe here and was not in
  the interpolator for one reason: a WebSocket delivers in order. THE MOTIVATION
  IS NOT "A ROOM RESTARTED AT TICK 0", which a 1e6 bound never trips: it is that
  the reference BOTH bounds are judged against is one this class computed for
  itself, so a reference that is wrong refuses every frame forever. AND THE
  ESCAPE RE-ARMS AT THE ADOPTION POINT, because clearing the run only on a
  plausible frame means that once a run has opened the gate it stays open. AN
  ESCAPE HATCH IS A RATE, NOT A SWITCH, and that goes for `refuseSteppedFrame`
  one module along too.
- A PONG IS MATCHED TO AN OUTSTANDING PING, NEVER TIMED AGAINST THE NEWEST SEND,
  or a duplicated, reordered or fabricated pong is timed against whatever went
  out most recently, which is a sample of nothing. The map is bounded by
  `RTT_WINDOW`, because a relay that stops answering must not grow anything.
- `rttMs` IS A SLIDING-WINDOW MINIMUM, NOT AN EMA, AND A FROZEN RENDER LOOP
  PRODUCES NO SAMPLE AT ALL. Every sample is the true path time plus queueing and
  queueing is non-negative, the same argument the two clock estimators make.
- THE SERVER'S OWN TICK RATE IS MEASURED AND REPORTED, NEVER ADOPTED. Requiring
  `tickHz` only moved the failure: a host writing 10 for a 20Hz room gets no
  error, no stall and clean stats while three derived quantities run at half
  basis. A class that quietly adopted the measured rate would be back to guessing
  a number the host is supposed to know.
- A HOST CALLBACK'S THROW IS COUNTED, NOT ONLY SWALLOWED, and every callback with
  a RETURN VALUE is guarded separately, because a throw there has to skip one
  specific step while everything after it still happens. A healthy client reads 0.
- AN ANCHOR IS PROVISIONAL WITH RESPECT TO THE ROUND TRIP IT ASSUMED. The epoch's
  first anchor is taken before the first pong exists, so it is short by the whole
  round trip, and anchoring sets `lastReanchorAt` so the tolerance path then
  refuses to correct it. A pong that moves `rttMs` a whole tick away from the
  assumed value DROPS the rate limit.
- NEVER 0 FOR "NOT YET" ON A `performance.now()` AXIS, because 0 is a real
  reading. THIS IS THE THIRD INSTANCE OF THE `PlayoutBuffer.aheadBase` TRAP in
  this repo, and the shape is always the same: a sentinel chosen from inside the
  value's own range.
- A TERMINAL'S CALLBACK IS THE LAST STATEMENT, because the recipe this library
  documents restarts from INSIDE that callback and `start()` reaches
  `new Impl(url)` synchronously. A callback a host is expected to act from is not
  a notification, it is a handover.
- EVERY CALL OUT TO HOST CODE GOES THROUGH `emit()`, and the close path schedules
  the reconnect BEFORE it announces the status, because the ladder is driven by a
  `void`ed promise. Ordering is the belt and `emit` is the braces.
- A RELAY SWAP IS RATE LIMITED AND ITS DEADLINE HAS A FLOOR, because
  `relay-expiring` is a frame the relay chooses to send and a hostile or broken
  one can send it as fast as it likes.
- A WARM SWAP IS NOT AN EPOCH CHANGE. Same room, same server timeline, same tick
  anchor, same clock offset, same buffered frames. Its deadline is
  `min(connectTimeoutMs, the announced inMs)`, because a replacement given the
  full connect deadline outlives the socket it exists to replace.
- THE RECONNECT LADDER IS JITTERED, AND ITS BASE IS SIZED AGAINST THE
  INTERPOLATOR'S COVER RATHER THAN CHOSEN. The jitter is not optional, because
  this architecture builds a thundering herd by construction: one relay function
  holds many sockets and dies all at once. The cap applies to the exponential
  term and the jitter rides on top, and the pre-open re-mint threshold stays
  keyed on ATTEMPTS rather than elapsed time precisely because the delays are
  random.
- EVERY REFUSAL FRAME BEHAVES THE SAME WAY: latch AND close. A terminal that
  latches while the socket stays live leaves a client rendering a room it has
  been told it is not in.
- GAUGES ARE EPOCH-SCOPED, COUNTERS ARE LIFETIME, in `RoomConnection` exactly as
  in the interpolator. The first snapshot of a fresh socket is the worst possible
  moment to be reporting the outage's own numbers.
- `mint()` OUTPUT IS UNTRUSTED, and AN ATTEMPT IS IDENTIFIED BY A GENERATION. A
  401 body is valid JSON too, and `if (this.stopped)` answers the wrong question:
  what matters is whether the attempt this code is part of was abandoned.
- ONE CLOCK DOMAIN IN THE CLIENT: `performance.now()`. `Date.now()` survives only
  in `handleVersionSkew`'s reload window, where the question genuinely is wall
  time.
- A LEAD IS MEASURED, NOT ASSUMED. A lead expressed as a constant number of ticks
  has no round-trip term in it at all.
- RE-ANCHOR IS TWO-SIDED, RATE-LIMITED BEHIND, AND THE TOLERANCE PATH DEFERS TO
  THE CLOCK'S STEP ESCAPE. Running behind is only harmless when it is a spike,
  and a handoff and a backgrounded tab both leave the counter behind permanently.
  The unbounded-ahead path is deliberately NOT gated: that is a fact about the
  counter rather than about the clock, and it gets worse while it waits.
- THE RE-ANCHOR DECISION SEES THE COUNTER PROJECTED BY THE TIME SINCE THE LAST
  FRAME, because the counter moves only in `frame()`, so a main-thread hitch
  under the frozen threshold is not drift. Every other use of `tick.value` is the
  raw counter.
- ONE INPUT STREAM PER CONNECTION. The ticker keeps one playout buffer per pid,
  so two windows from one socket overwrite each other's record for every tick. A
  player steering several things carries them in one input record, and a host
  building several entities by hand merges their windows into one send.
- A BACKWARD COUNTER JUMP REWINDS THE PREDICTION AND RELABELS NOTHING, because
  the ticks beyond `value - 1` have not happened on the server's timeline. And a
  new epoch starts the entity over: no record, pose or offset crosses it, and its
  first reconcile is a counted snap.
- A FROZEN RENDER LOOP IS AN EPOCH BOUNDARY FOR THE COUNTER, and not for the
  interpolator. Nothing was rendered during the gap, so there is no continuity to
  protect; the interpolator's buffer and offset are still about the same socket.
- UNWIND EXTRAPOLATION AS A GLIDE, clamped to the interpolator's OWN overshoot.
  The clamp is the whole difference between a smoother and a lie: it can only
  ever hide this module's own guess, so a real teleport still snaps.
- A JUMP THE HOST KNOWS ABOUT IS THE HOST'S TO DECLARE, on both paths and from
  the snapshot that carries it, and THE CONNECTION MAKES THE CALLS. Neither
  smoother can tell a respawn from a disagreement, and both are built to render
  the path between two poses, which is precisely what a jump has none of.
- BOTH TERMS OF THE PLAYHEAD ARE SLEW-CAPPED: the offset at 5%, the delay at 8%
  of wall time. Both are subtracted from the playhead, so moving either quickly
  IS rendering every remote entity fast or slow for as long as the move lasts.
- A RATE MEASURED AGAINST A CLAMPED `dt` IS NOT A RATE. A caller is right to
  clamp its frame delta and right to pass the real `nowMs` alongside it.
- WRAP, NEVER SILENT, ONE LAYER DOWN: an integer field REFUSES rather than wraps.
  A state enum, a target tick or a byte length has no nearby value, so
  `DataView`'s silent wraparound turns `state 300` into 44.
- OPTIONS ARE SPREAD, NEVER COPIED, ACROSS THE ADAPTER BOUNDARY. A hand-picked
  subset goes stale the moment anything is added one layer down, and a field a
  type does not name is simply never passed on, with no error anywhere.
- A DERIVED LIFETIME NEEDS A FLOOR AS WELL AS A CEILING, AND THE FLOOR IS CHECKED
  ON THE RESOLVED VALUE. Each derivation is a subtraction, so a small enough
  `maxDurationS` produces a NEGATIVE lifetime rather than a short one, and an
  explicit negative `maxRunMs` passed the old fit check by arithmetic. Checked at
  route creation, which is module evaluation.
- NOTHING ESCAPES A PLATFORM CALLBACK, AND THE CATCH BLOCK IS GUARDED TOO,
  because a throwing host logger would re-raise the very rejection being
  swallowed. Same rule as `guardHost`, at the outermost seam the library has.
- A CALLBACK-PARAMETER TYPE IS CHECKED CONTRAVARIANTLY, SO `unknown` IS THE WRONG
  WIDENING. `WebSocketLike`'s four handler slots are `((ev: any) => void) | null`.
  Declared `unknown`, `strictFunctionTypes` demanded that `unknown` be assignable
  to each real implementation's own event type, which nothing is, so both READMEs
  told hosts to write a cast around a type that was simply wrong. There is no
  sound alternative, because the parameter would have to be a SUBtype of the
  DOM's `Event`, of ws's, and of whatever a third implementation invents. Pinned
  by a compile-only case in `connection.test.ts`.
- Prose style: no em dashes, no en dashes. Never mention AI or an assistant in
  code, comments, commits, or docs. Plain descriptive commit messages.

## Gotchas that cost real production time

Traps rather than rules: shapes that look right and are not. The invariants above
are what the code does about them; the dated write-up of each, with the numbers,
is in `docs/LEDGER.md`.

THE LEASE NEEDS TWO CLOCKS AND THIS REGRESSED TWICE. Collapse `lastRenewAt` and
`lastOwnedAt` and a ticker whose renews are all failing keeps refreshing its own
guard, so the pre-publish guard can never fire in the one condition it exists
for. `renewFailed` returning the clock UNCHANGED is the fix and it looks like a
no-op function, which is exactly why somebody keeps deleting it. THE SECOND HALF
IS THE PACING CLOCK: `renewConfirmed` re-anchoring `lastRenewAt` onto the
confirmation time means that once RTT exceeds `leaseRenewMs` each resolution
drags the pacing clock forward and nothing reaches Redis for up to
`RTT + leaseRenewMs`. OVERLAPPING RENEWS ARE THE ACCEPTED PRICE and are safe,
because the renew is an owner-checked compare-and-extend, `lastOwnedAt` is
non-decreasing, and a `false` reply is a fact no later reply can take back.

A HALF-BUILT SEAM IS WORSE THAN NO SEAM. `preserveAttemptTime` existed, was
documented, was tested, named `ticker.ts` as the caller that needed it, and
`ticker.ts` never called it: the fix was in the tree and absent from every code
path that runs. When a change adds an option, a helper or a hook, the counterpart
is the CALL SITE, and a helper with no caller is not a landed fix, it is a
comment that compiles. The resolution was to delete the option rather than pass
it, because an option whose only correct value is `true` leaves the next reader
re-deriving why on the most safety-critical module in the library.

WHEN A GAUGE'S EMPTY VALUE IS ALSO ITS HEALTHIEST VALUE, THE EMPTY CASE HAS TO BE
A DIFFERENT TYPE, not a different number. `percentiles([])` returning zeros made
"no samples at all" and "every sample instantaneous" identical, and paired with
counters that counted ATTEMPTS a room whose every publish was rejected reported
the healthy rate and the best `publishAwait` in the fleet.

A CHECKPOINT WITHOUT A GEOMETRY DIGEST SIMULATES A DELETED WORLD FOREVER. A
deploy that moves a wall leaves every live room restoring its predecessor's
bytes, simulating the old world and re-saving it, with the TTL refreshed every
second so it never expires. Silent, permanent, invisible in every metric. A
hand-rolled digest only covers the fields somebody remembered to mix in.

CAPACITY MUST COME FROM THE STATS KEY, NOT THE META HASH. Stats has a 5s TTL so a
room with no ticker reads as empty; meta persists. Read one on each side and a
hard-dead ticker leaves meta phantom-full forever, the balancer keeps handing out
a room the relay keeps rejecting, and the client's bounded re-assign loop strands
every joiner on "full" with no path to self-heal.

THE PER-SENDER INBOX QUOTA IS A FAIRNESS PROPERTY, NOT A MEMORY BOUND, AND IT IS
A BACKSTOP A SOCKET-BORNE FLOODER DOES NOT REACH. `20 * perSenderCap` (64) must
stay well under the global cap (4096) so the per-sender bound binds first. But
`RoomStats.dropped` stays 0 under a socket flood, because the excess dies one
layer up at that socket's token bucket and 25 envelopes a second against a
per-tick drain never accumulates 64 undrained. The quota is for a producer that
reaches `room:{id}:in` WITHOUT a relay in front of it and for a loop that stops
draining for seconds. Do NOT write a test that asserts `dropped > 0` under a
socket flood; it asserts the wrong layer.

A SPAWN IS A DELIVERY, NOT A CONVERSATION, AND IT LIVES IN `finally`. A ticker
route does not respond until `runTicker` RETURNS, because ending the response
ends the function, so the answer to a spawn is the successor's WHOLE LIFE and
undici fails it at its 300s `headersTimeout` against a ticker that is running the
room perfectly. Fire-and-forget is wrong the other way: as the last thing a
handler does it is post-response IO the platform can suspend before flushing. And
it must NOT use `AbortSignal.timeout`, because aborting could propagate as a
cancellation and tear down the very ticker just started. Race a plain timer,
leave the request alive, and resolve on a RECEIPT. THE GENERAL RULE IS WORTH MORE
THAN THE FIX: any request whose response is the callee's entire lifetime is
waited on for a receipt, and any timeout in that path is a statement about
DELIVERY rather than about health.

TWO FIRST JOIN PUBLISHES, AND BOTH ARE LOAD-BEARING. The immediate one keeps a
reconnecting player from being frozen server-side; the one gated on the subscribe
ack keeps a socket from missing its own one-shot roster announcement, since
pub/sub drops a message with no subscriber. Neither covers the other.

DETACH BEFORE CLOSE ON THE CLIENT. `connect()` must null `this.ws` and close the
previous socket before constructing the replacement, and every listener body must
return early when `this.ws` no longer names its own socket. An orphaned socket
keeps decoding messages into this client's state from a room it is no longer
joining, runs its own reconnect ladder in parallel, and holds a slot against the
per-user socket cap.

A NODE BUILTIN REACHABLE FROM `core/` BREAKS EVERY DOWNSTREAM BROWSER BUILD, AND
NOTHING IN A NORMAL GATE SEES IT. `tsc`, `vitest` and `npm run build` all run in
Node, where `node:zlib` resolves fine; the failure appears only when a consumer
bundles for the browser, where it is a HARD ERROR. Tree shaking does not save
you, because the old module ran `promisify(gzipCb)` at module scope. The fix was
to MOVE the module, not merely to drop it from the barrel: with nothing Node-only
left under `core/` the rule is a property of the directory, so the only way back
in is a `../server/...` import inside `core/`, which is an obvious layering
violation rather than a plausible barrel tidy-up.

A `-1` MEANING "NOTHING YET" IS NOT A POSITION TO MEASURE A DISTANCE FROM. A
buffer created fresh in a room older than `maxAhead` ticks refused EVERY push
until some later consume anchored the floor, and IT WAS ONLY CHEAP BECAUSE THE
CLIENT SENT A REDUNDANCY WINDOW: a host that sends each stamped input once loses
the FIRST INPUT OF EVERY BUFFER. Fixed by giving the bound its own reference
(`aheadBase`), NOT by moving `lastConsumedTick`, which is the tempting one-line
version and is worse than the bug: a stamp is a producer's claim and that field
is the consumer's position, so anchoring the FLOOR makes every slightly-older
re-send in the same burst "late" and never-drop-late then dedupes all but one
away.

`readCheckpoint` MUST USE `getBuffer`, NEVER `get`. A utf8 decode of gzip bytes is
lossy and destroys the payload before anything can sniff it.

A BARE `raw in WORLDS` MATCHES INHERITED PROPERTIES: `constructor`, `__proto__`
and `toString` all pass. Use `Object.prototype.hasOwnProperty.call`. A real trust
boundary, because the value is interpolated into a Redis key name.

A CLAMP AGAINST A RANGE THE HOST NEVER CHOSE IS THE OTHER HALF OF "CLAMP, NEVER
WRAP". `encodeDefaultSnapshot` hardcoded `quantizeCm`, so the default codec
spanned +-327.67 METRES while this library advertises 2D games and cursor layers,
which count in PIXELS: every entity past 327 piled against an invisible wall,
with no error, no warning and nothing in a metric, which reads as a snapping bug
in the CLIENT. Fixed additively with `positionScale` and with
`representableRange`, which a host asserts its world bounds against ONCE at
startup; NOT with a per-value hook on the encode path, which runs per entity per
tick per player. The byte-identical default is pinned against a LITERAL byte
array rather than against a re-encode, because a re-encode comparison agrees with
itself whatever the default is.

BEFORE WRITING A RUN-BASED DISCRIMINATOR IN THE INTERPOLATOR, ASK WHAT REORDERS
THE STREAM, BECAUSE SOMETHING ALWAYS DOES. Three times in that module: the
dead-epoch cut keying on the LAST arrival rather than the newest; the seed frame
defining the statistic it was judged against; and the floor-refusal escape
counting CONSECUTIVE refusals, which a latency DROP larger than
`OFFSET_FLOOR_SLACK_MS` reorders by construction so every old frame cleared the
count.

A LOG LINE ON A CLIENT-RATE PATH IS A MEGAPHONE YOU HAND THE ABUSER, AND THE
TICKER HAD ONE: a malformed input envelope wrote a warn line per envelope, on a
path a socket drives at 20 to 60Hz, through this library's own default decoder.

A CRASH LOOP IS THE CHECKPOINT'S FAULT, NOT THE SUCCESSOR'S, AND IT HAS NO
CEILING OF ITS OWN. A deterministic throw wrote a final checkpoint of the
HALF-MUTATED state and spawned a successor, which restored those bytes and threw
in the same place, with every metric reporting each successor as a healthy cold
start. Two fixes, and both are needed: no checkpoint and no spawn on an error
exit, and a counter that starts the room FRESH after three. Same trade as the
geometry digest: lose the in-progress state once instead of forever.

A RESYNC THAT DOES NOT SLEEP IS THE RUBBER-BAND IT EXISTS TO PREVENT. Setting the
grid to `now` and falling through leaves two snapshots with consecutive ticks and
a `serverTime` gap of 0 to 1ms, and the client divides a tick's movement by that
gap. Sleeping to `now + tickMs` also hands the event loop the turn it needs to
drain the envelopes that piled up during the stall.

A BLACK-HOLED SUBSCRIBER PRODUCES NO EVENT AT ALL, WHICH IS WHY BOTH SIDES NOW
TALK TO THEMSELVES. No error, no close, nothing to observe: the room keeps
ticking, publishing and renewing while every join and every input is silently
dropped. AND THE PROBE'S CONSTANTS ARE THEIR OWN, NOT A MULTIPLE OF `statsMs`,
which they used to be: a host setting `statsMs` to 40 for finer metrics
resolution gave itself a 120ms deadline and tore down a healthy room. A knob
documented as a metrics cadence must not be able to decide when a room dies.

A LEAVE THAT LANDS IN A HANDOFF GAP IS SIMPLY LOST, AND THE PLAYER NEVER LEAVES.
Pub/sub drops a `leave` when no ticker is subscribed, which is precisely when a
relay is most likely to be closing sockets, and the phantom stays in the roster,
the meta hash and every successor's checkpoint: a room that can never drain,
holding a capacity slot nobody can reclaim. FIVE heartbeats before a synthesised
leave, because one lost beat must not remove a live player and five one-second
beats sit above the 5 to 7 second unplanned-death gap (the relays are a separate
lifetime and keep republishing right through a ticker dying). A host that moves
`heartbeatMs` owns `presenceTimeoutMs` with it, at AT LEAST THREE of its beats.

A GRACE-PERIOD REJOIN WAS REFUSED AS A NEW ARRIVAL, BY THE FULL ROOM IT WAS
ALREADY IN. `leave` deleted from `present` unconditionally, even for a runtime
holding the player through a disconnect grace, so the reconnect met `isFull` and
was answered with `room-reject` while the simulation still had them in the room.

A THROWN CHECKPOINT READ IS NOT AN ABSENT CHECKPOINT. One rejected `GET` produced
`runtime.create`, a new incarnation, and a first iteration that OVERWROTE the
perfectly good checkpoint a millisecond later. Retrying costs a few hundred
milliseconds of handoff and giving up costs one invocation; neither costs the
room its state. A value that WAS read and cannot be decoded still starts fresh,
because that is a fact about the bytes rather than about the connection.

AN EX-OWNER'S CHECKPOINT OVERWRITES ITS SUCCESSOR'S, AND THE LOCAL FLAG CANNOT
SEE IT. `owns` lags reality by up to a renew period, so a ticker whose lease was
taken while its last renew was in flight still believes it owns the room.

A RELIABLE QUEUE ON A LOSSY BUS IS WORSE THAN DROPPING, AND THE BOUND IS
NARROWER THAN IT READS. The snapshot forward turned pub/sub into an unbounded
queue and ioredis's own command buffering did the same from the other end. But
`snapshotBacklogBytes` keys on `bufferedAmount`, the transport's USERSPACE queue,
and a modern kernel absorbs a merely slow READER into its own send buffer long
before that queue grows: THIS BOUND IS MEMORY SAFETY AGAINST A WEDGED SOCKET, NOT
STALENESS CONTROL. A slow reader gets the frames late and renders the documented
catch-up on resume, because playback is on the server timeline and every frame
carries its own honest stamp.

A SOCKET CAN BE DEAD BEFORE THE RELAY EVER SEES IT, AND `terminate()` ON A CLOSED
SOCKET EMITS NOTHING. The caller awaits `checkAdmission` to get here, so the
socket may have closed during that round trip with its 'close' event already
fired and gone. The same asymmetry is why the liveness path runs `cleanup` ITSELF
right after terminating rather than waiting for an event that may never come.

A SPAWN POLL WITHOUT A HOLD-OFF IS A THUNDERING HERD. A ticker cold start is
longer than the poll period, so every poll inside that window fired another
invocation that existed only to lose the acquire race. The poll keeps running
throughout; what the hold-off bounds is how often one relay is willing to PAY.

TWO LISTENERS ON ONE PUB/SUB CONNECTION COST A UTF8 DECODE PER FRAME. ioredis
emits BOTH `message` and `messageBuffer` as soon as any `message` listener
exists, so a relay listening on both decoded every binary snapshot to a JS string
once per socket per tick purely to throw it away on a channel check.

A 4001 IS TWO DIFFERENT EVENTS ON ONE CODE, AND COUNTING AN AUTH CLOSE ON
`preOpenFailures` CANNOT WORK. The node adapter verifies the token AFTER the
upgrade, so a session older than the host's `maxAgeS` ends the game on the next
network blip. A 4001 BEFORE this epoch delivered anything is read as a stale
token; once the epoch has delivered, the server had already accepted this token,
so it can only be a deliberate kick. It needs its OWN counter, because those
sockets DO open and `onopen` clears `preOpenFailures`.

A `void`ED PROMISE MAKES EVERY THROW SILENT. `scheduleReconnect` drives the
ladder with `void this.connectOnce(...)`, so a throw in the post-mint half was an
unhandled rejection and the ladder simply stopped: no timer, no terminal, status
stuck on `'connecting'` forever. Same shape one layer up: an `async` host hook
satisfies a `void` return, and its rejection kills the process.

A CONSTANT CAN ONLY BE PINNED FROM BOTH SIDES. `DELAY_SLEW_MAX` was swept against
two profiles that pull in opposite directions and the table is in the source; the
shipped value is the only one where both read zero, and both tests bind. A
constant pinned from one side only is a constant with a free direction.

THE ADAPTER OPTION BAGS WERE A SUBSET, AND A SUBSET GOES STALE SILENTLY. TWENTY
options were unreachable from the very route factories the README tells people to
use, because a field a type does not name is not an error, it is simply never
passed on.

NOTHING TIED THE LIBRARY'S LIFETIMES TO THE PLATFORM'S CAP.
`tickerRouteConfig.maxDuration` was 800 and `MAX_TICKER_MS` was 700s, two
constants in two files agreeing only by luck, and a host on a lower plan limit
got a platform kill every cycle with no final checkpoint, no lease release and no
successor spawn, with nothing reporting it.

A BACKWARD RE-ANCHOR SILENCES A HOST THAT DEDUPES BY A HIGH-WATER MARK, AND THE
LIBRARY CANNOT SEE IT HAPPEN. `if (t <= lastSent) return;` is the obvious way to
write a sender and is correct right up until `onTickReanchor` delivers a NEGATIVE
delta. Documented rather than fixed: the delta is the number to move the mark BY.
A host on `predict` has nothing to adjust. TWO-SIDED RE-ANCHORING MADE THIS
REACHABLE, so a fix in one module opened a trap in the host's.

A HIDDEN TAB FIRES `onTickReanchor` ABOUT EVERY TWO SECONDS, AND THAT IS NOT A
FAULT. `frame()` advances the client tick and a backgrounded tab stops
`requestAnimationFrame` entirely while snapshots keep arriving on a socket the
browser does not throttle. A host that alerts on it pages itself every time a
player switches tabs.

A REDIS DB INDEX DOES NOT ISOLATE TWO DEPLOYMENTS, AND `namespace` DOES. KEYS are
per database, PUB/SUB IS INSTANCE-WIDE, so two deployments publish into the
identical channels while each acquires its own lease against its own key and each
believes it is the exactly-one writer: two tickers interleaving snapshots, no
error anywhere, and the lease mechanism unable to see it because it is doing its
job correctly on each database separately. It has to be passed to BOTH routes.
Separate from the db-0 rule, which is about ioredis re-issuing an uncaught
`select(db)` on every reconnect; both point the same way.

STEADY MOTION HIDES AN OFF-BY-ONE IN THE INPUT TIMELINE, AND ONLY AN INPUT CHANGE
REVEALS IT. Under a held key a record applied a tick late carries the same value
as the one that should have been, so both ends agree to the unit and every
existing test stays green; at every START or STOP they disagree by exactly one
tick of travel. THE LESSON FOR ANY RECONCILIATION TEST: it MUST change the input
mid-run and assert on the snapshot LABEL, because a steady input cannot tell the
two timelines apart and a hook's view of `state.tick` at consume time is one
below the label whichever timeline is in force.

A COUNTER JUMP IS NOT TIME PASSING: THE RENDER OF A PREDICTED ENTITY MUST SLEW,
NOT FOLLOW THE COUNTER. `prev + (curr - prev) * tick.fraction` is the standard
fixed-timestep interpolation and is correct only while the counter advances by
wall time. It also JUMPS: a forward re-anchor stamps the catch-up ticks in one
frame and a draw that follows moves the pose several ticks of travel in 16ms with
nothing counting it, and a -1 re-anchor (the COMMON epoch anchor on a fast link)
puts `(prev, curr)` a tick ahead of `(value, fraction)` and the draw walks
BACKWARD. THE LESSON FOR ANY RENDER TEST OF AN OWNED ENTITY: drive the REAL
counter with `anchorTo` jumps as well as `advance`, assert per frame on the DRAWN
pose, and count the snaps, because the reconcile error was exactly zero through
every one of these defects.

A BACKWARD RE-ANCHOR OF k IS k TICKS THAT HAVE NOT HAPPENED YET, AND THE DRAW
PAYS THEM AT NINE TENTHS ON A SPECULATION. Relabelling the pose history by the
jump and leaving `curr` where it was made the next stamp step from the pose after
the OLD newest tick. And a playhead held to the history's END spread the last
tick of tail over the whole wait, a near pause of 100 to 150ms on the one entity
the player steers, on every tolerance correction.

A STALL IS NOT DRIFT. The counter moves only in `frame()` and `desiredTick()`
runs on the server clock, so a main-thread hitch under the frozen threshold left
the counter where the last frame put it while the snapshots landing inside it
read as ticks behind: a spurious re-anchor, the resume frame stamping the stall's
ticks on top, and the same path undoing it two seconds later. THE LESSON FOR ANY
TEST OF THE RE-ANCHOR: drive the frames and the snapshots on ONE clock and put
the gap in the frames only, because a re-anchor that fires on a frame gap is a
decision about the render loop, not about the network.

A ONE-TICK FEEDBACK DEADBAND WAS MEASURED WORSE, AND THE CUSHION BELONGS IN
`inputLeadMs`. Narrowing the `input-lead` loop's band to one tick sounds right
and does the opposite, because every correction clears the client's stamped
window and the loop then hunts. The deadband equals the target by decision; what
moves the starve rate is headroom.

A JUMP THE HOST KNOWS ABOUT IS NOT AN INTERPOLATION PROBLEM, AND `forget` IS THE
TRAP ON THE WAY TO LEARNING THAT. It drops `lastSeenAt` and the motion state and
leaves the FRAMES, so the key re-seeds one snapshot later INSIDE the same bracket
and streaks anyway, in pieces, which is worse than doing nothing. A consumer's
workaround was `ceil(delayMs / tickMs) + 1` CONSECUTIVE forgets, one per rendered
frame, which is the buffer depth expressed as a call count and is exactly the
sort of thing a library is supposed to own. AND `teleport`'S CALL ORDER IS A
CONTRACT, NOT A PREFERENCE, because it reads the destination out of the buffer:
called before the frame carrying the destination is pushed it finds the pose the
entity had BEFORE the jump.

THE THREE ORDERS A CONSUMER GOT WRONG WITH A HAND-HELD `PredictedEntity`. In one
week one host advanced the entity BEFORE `conn.frame()` (every record stamped one
frame into the past), reconciled AFTER reading `entity.pose` in `onSnapshot` (a
camera and a collision latch a snapshot behind), and called `snapTo` AFTER
`reconcile` on a respawn (the server's answer gliding in from the pre-respawn
pose and then snapping to the host's guess). Each is an order between two objects
the host held at once, and THE FIX FOR AN ORDERING RULE IS TO REMOVE THE SECOND
OBJECT. What the fold did not change: the entity still watches `tick.anchored`
from both calls, because the connection anchors and then reconciles in the same
`processSnapshot`.

THE BINARY INPUT WIRE CHECKS ITS SHAPE BEFORE THE FIRST STAMP, NOT INSIDE THE
ENCODER. Checked inside the encoder on the first send, which is after the records
are pushed and the mark has moved, the `TypeError` fired once, the next frame
crossed no tick and sent nothing, and the entity sat there stamped and silent
with the error a frame in the past.

A PREDICTION STEP HAS TO BE PURE OF CLIENT-FRAME STATE, NOT MERELY OF ITS OWN,
AND THIS IS WHAT RUBBERBANDING ON A HEALTHY LINK LOOKS LIKE. `reconcile` replays
the records from the SERVER's pose, so every hook the step reads has to be
evaluated from the pose it is handed, on the tick it is handed. A consumer
latched "am I standing on my own bomb" once per frame from the RAW prediction and
read the latch inside the step, so the replay was refused every move it tried and
every snapshot produced a correction the link had nothing to do with. The fix is
the shape, not the value: hooks are functions of the arguments.

A MINIMUM-FRAME-INTERVAL GATE IN A rAF LOOP IS A FRAME DROPPER.
`if (now - last < 1000 / 61) return;` reads like a limiter and behaves like a
filter on timestamp jitter: 16% of frames dropped on a 60Hz display, each one a
visible hitch. Render every callback.

A COLD START SAYS SO NOW. Every way a ticker could fail to restore had its own
log line except the ordinary one, an absent checkpoint, so a bare "no
`ticker.restore`" could not distinguish the branches. `ticker.fresh` makes a room
started clean one positive event rather than an absence of one.

A FRAGMENTED FRAME IS THE RELAY'S PROBLEM, AND IT USED TO BE EVERY HOST'S. `ws`
delivers a fragmented message as an ARRAY of buffers, a peer or a proxy chooses
its own fragmentation, and nothing about a frame's size prevents it. Every host
wrote the same `Array.isArray(data) ? ... : data` arm in its own decoder; a host
that did not saw one player's inputs stop with the room and every other player
perfectly healthy and nothing anywhere logged. `joinFragments` normalises ONCE,
and the all-or-none rule is a test rather than a comment.

FLUID COMPUTE CAN RUN THE STANDBY SUCCESSOR IN THE SAME CONTAINER AS THE
INCUMBENT, SO AN INSTANCE ID AT MODULE SCOPE DOES NOT MARK A HANDOFF. A ticker
spawns its successor by calling its own route, and that request lands in an
already warm container more often than not. Nothing in the library is wrong
there; the observer is. Generate such an id PER INVOCATION, inside the handler.

VERCEL AUTHENTICATION BLOCKS THE RELAY'S OWN TICKER SPAWN, AND THE ONLY SYMPTOM
IS SILENCE. Deployment Protection is on by default and guards EVERY request to
the deployment including one function calling another, so the spawn gets an SSO
redirect. The spawn is caught and discarded by design, correctly, so nothing
errors: a socket opens, the player joins, the roster seeds, and the room sits in
perfect silence with no `/api/ticker` line in the invocation log at all. That
ABSENCE is the whole signal. Turn Protection off, or set
`VERCEL_AUTOMATION_BYPASS_SECRET` and send it on the spawn.

UPSTASH'S `CLIENT LIST` CARRIES NO SUBSCRIBE-MODE FIELDS, so a count of lines
matching a subscribe flag reads ZERO while a ticker subscriber and one per relay
socket are certainly live: a plausible-looking number and a false one. `INFO
clients` `connected_clients` is accurate. Anything reporting the split has to say
"not reported" on a provider that does not report it rather than print the zero.

A HOST CALIBRATION TAKEN AT MODULE LOAD CAN UNDER-READ THE RUN IT GATES, AND THAT
IS THE WEAKEST POINT IN THE WALL-CLOCK HARDENING. `tests/helpers/jitter.ts` has
to be taken at module load for the same reason `probeRedisAvailable` is:
`describe` and `it` bodies are collected synchronously. So the reading describes
the machine at COLLECTION time, and a full-suite run is at its busiest later. If
a gated file reddens on a loaded box with a jitter reading comfortably under the
limit, this is the reason, and the answer is a re-reading beside the case rather
than a wider bound.

UNDER `vi.useFakeTimers()`, ANYTHING OBSERVED DOWNSTREAM OF REAL I/O IS
TIMESTAMPED NONDETERMINISTICALLY, AND GZIP IS I/O. `writeCheckpoint` deflates on
libuv's threadpool, so the virtual clock races a real compressor and the
checkpoint spacing a test reads is the compressor's schedule rather than the
cadence under test. THE BOUND WAS NEVER THE PROBLEM AND WIDENING IT WOULD HAVE
HIDDEN THIS: the case advances one tick at a time and drains real event-loop
turns while a write is outstanding. Every other virtual-time case in that file
dodges the class by disabling checkpoints. The same trap waits behind `fs`, `dns`
and anything else that finishes on the threadpool.

A HELPER SCRIPT WITH A RELATIVE SOURCE PATH WILL EVENTUALLY OVERWRITE THE FILE
YOU ARE EDITING, because an agent shell's cwd resets to the repo root between
calls, so a script written to run from a scratch directory copies its stale
snapshot over the LIVE file, silently, with a green exit code. That reverted
`interpolation.ts` four times in one session. ABSOLUTE PATHS ONLY in anything
that writes, and never keep a snapshot of a file you are actively editing beside
a script that can write it back.

AN UNTRACKED SCRATCH SUITE UNDER `src/` IS COLLECTED BY VITEST AND INFLATES EVERY
COUNT IN THIS FILE, because the include is `src/**/*.test.ts` and has no idea
whether a file is tracked. Before quoting a whole-tree count, `git status
--short` and delete them. AND THE SAME SCRATCH FILE SHIPS TO NPM, BECAUSE `tsc`
NEVER CLEANS `outDir`: a directory compiled once and since deleted from `src/`
stays in `dist/` forever and is PACKED, with the typecheck clean because the
source is gone and the tests green because they never look at `dist/`. `build` is
`rm -rf dist && tsc -p tsconfig.build.json` for exactly this, and never quote a
pack size or file count that was not re-measured after the build it describes.

NEVER ASSERT ON SERVER-GLOBAL STATE IN AN INTEGRATION TEST. The first fan-out
test gated on `INFO stats` `total_commands_processed`, which counts every client
on that server, so any other file running in parallel landed inside the
measurement window and it failed in the full suite while passing in isolation.
Key prefixes isolate keys; they do not isolate `INFO`, `DBSIZE`, `CLIENT LIST`,
or any other server-level metric. Measure something you own.

## Gates

From the repo root:

```
npx tsc --noEmit           # typecheck, must be clean
npm run build              # rm -rf dist && tsc -p tsconfig.build.json
npm run test:unit          # the unit tier, NO services anywhere, green offline
npm run test:integration   # unit + integration tiers, needs a real Redis
npm run test:measure       # the measurement tier, real Redis AND a quiet machine
npm test                   # all 47 files, every tier, what a developer runs
npm run example:node       # tsx examples/node-server/server.ts, see its README
```

`.github/workflows/ci.yml` runs the typecheck, the build and `test:unit` with no
services on every push and PR to main, and `test:integration` in a second job
against a `redis:8` service container on host port 6399. `release.yml` gates on
build, typecheck and `test:integration` against the SAME service. `nightly.yml`
runs `test:measure` on a schedule, uploads its log as an artifact, and blocks
nothing. `npm install` runs `prepare`, hence `build`, so a broken build fails at
install time. `example:node` is not a gate, it is the fastest way to drive a real
client through a real Redis by hand.

THE SUITE IS TIERED, AND THE TIER IS WHAT DECIDES WHERE A FILE RUNS. Three
tiers, selected by `TICKROOM_TIER` in `vitest.config.ts` (one env var and one
list of globs, rather than three config files that are three chances to add a
new file to two of them):

- `unit`: no services, the outcome decided by the code. 34 files.
- `integration`: real Redis, the outcome STILL decided by the code (a checkpoint
  round trips, a lease is refused, a subscriber survives a reconnect, an
  admission is granted). Includes the unit tier rather than replacing it, so it
  is 43 files, and it is the release gate.
- `measure`: real Redis AND a wall clock (a rate band, a latency bound, a
  zero-tolerance smoothness claim). 4 files. Nightly and by hand on a quiet
  machine, NEVER on a required check. THIS TIER RUNS ITS FILES ONE AT A TIME
  (`fileParallelism: false`), which is part of the measurement rather than a
  convenience: four files each driving a 60Hz render loop and a real socket are,
  in parallel, each other's load. It costs the sum rather than the max, about
  two minutes.

The per-file classification is the table at the end of the Status section, and
that table is the source of truth. A new file under `tests/` runs under `npm
test` from the moment it is written (the default include is still the catch-all
glob) but reaches no gate until it is added to `INTEGRATION` or `MEASUREMENT` in
`vitest.config.ts` and to that table, and `tests/tiers.test.ts` fails the unit
tier if it is in none.

WHY THE MEASUREMENT TIER IS OFF THE RELEASE GATE. It used to be on it, via `npm
test`, and it cost two release runs on two different timing bounds while the same
commit was green locally both times. A publish blocked by a noisy runner is a
publish blocked by nothing, and the pressure that creates is to widen the bound,
which throws away the measurement to save the release. `retry: 1` when `CI` is
set is still in `vitest.config.ts` as the SECOND line, covering the wall-clock
cases that still ride inside `ticker.redis.test.ts` and `faults.redis.test.ts`;
it does not loosen a bound, it asks the host to meet it once more, and locally it
is 0 so a real regression is red on the first run. `JITTER_LIMIT` stays 1.5 and
its doc comment says why raising it is the wrong move: it is not a tolerance on
the library, it is the point past which the host has no instrument, and the fix
for a failing measurement on a shared runner is the tier, not the constant.

BOTH GATING WORKFLOWS REQUIRE REDIS, AND THE RELEASE GATE IS THE ONE THAT DID
NOT. The suite skips cleanly with nothing listening, so a publishing build
without the service exited 0 having run zero assertions in the lease, checkpoint,
handoff, subscriber and fault-injection files: the one build whose version number
is burned forever was the one build nobody checked. `TICKROOM_REQUIRE_REDIS=1` is
baked into the `test:integration` and `test:measure` scripts so a run started by
hand cannot skip its way to green either, and the workflows repeat it so each
states the requirement rather than inheriting it from a script somebody could
edit. Both `ci.yml` jobs carry `timeout-minutes: 20`, the release job 30 and the
nightly 45, because a hung job that never fails is the same shape of non-gate as
one that cannot fail.

`test:unit` MUST BE GREEN WITH NOTHING LISTENING, and the way to prove it is to
point `TICKROOM_TEST_REDIS_URL` at an unused port
(`TICKROOM_TEST_REDIS_URL=redis://127.0.0.1:6499 npm run test:unit`) rather than
to trust that nothing was running. The real-Redis files namespace every key per
run (`itest-{uuid}`) and delete it afterwards, so they never disturb a shared
instance. Start one with
`redis-server --port 6399 --save '' --appendonly no --daemonize yes`.

`TICKROOM_SPLITBRAIN_REPS=10 npm run test:measure` IS A LONG FORM, NOT A GATE.
One rep of `tests/splitbrain.redis.test.ts`'s eight cases is what the nightly
runs; ten reps is what a quiet machine runs when anything in `lease.ts`, the
renew cadence or the lease constants moves, because a margin measured once is an
anecdote.

Measured on this tree after a clean build, `npm pack --dry-run` is **73 files,
386.4 kB packed and 1.1 MB unpacked**. Re-measure those three numbers after a
build rather than quoting them forward: they are the only thing that would have
caught the `outDir` gotcha above.

`tsconfig.json` sets `noUncheckedIndexedAccess: false` and
`exactOptionalPropertyTypes: true`, AND THE SECOND ONE IS FOR THE CONSUMER RATHER
THAN FOR US: a stock `tsc --init` enables it, so a host compiles this library's
`.d.ts` under it whether or not they ever chose it. Two rules it imposes that are
not obvious:

- Every optional field on a PUBLIC type is written `?: T | undefined`, and every
  optional callback is a PROPERTY signature, because method shorthand cannot
  carry `| undefined`. Internal code builds objects CONDITIONALLY
  (`...(x === undefined ? {} : { x })`) rather than assigning `undefined`.
- `Required<T>` no longer strips the `undefined`, so `core/lease.ts` resolves its
  defaults through an explicit mapped type instead.

AND THE ONE THAT WILL BITE A FUTURE WIDENING: a type in CALLBACK-PARAMETER
position must not be widened, because contravariance flips it. Widening
`WebSocketLike.onclose`'s event or `upgradeWebSocket`'s options bag would REJECT
a consumer whose handler is typed the stock narrow way. Widen what flows INTO the
library; never widen what it hands to a host's own function. (`any` on the four
`WebSocketLike` handler slots is the deliberate exception, and its invariant says
why nothing narrower works.)

SEMVER NOTE, because property signatures are a source-compatibility break no test
can see: `RoomRuntime`'s optional hooks, `RelaySocket.terminate`/`ping`,
`RedisLike.on`/`off` and the option-bag callbacks are all property signatures,
which drops method BIVARIANCE. A consumer that annotates a hook's parameters
NARROWER than the contract compiled before 0.2.0 and errors now. Everything in
this repo uses contextual typing, so nothing here saw it.

THE BENCH'S OWN VERCEL PROJECT WAS REMOVED ON 2026-09-08 at the owner's request.
Every `tickroom-bench.vercel.app` URL in this file names a deployment that no
longer exists; the numbers stand as measured. The measurement page now lives in
the demo app at `https://tickroom-demo.vercel.app/bench` (room base `bench`, its
own sim with the marker entity and the per-invocation instance id), and the
harness in the tickroom-bench repository targets that URL. The demo's own pages
are the package's site.

## Status

MEASURED ON THIS TREE, not estimated, PER TIER, on the 1.0.0 commit:
`npm run test:unit` is **1149 passed across 34 files** with
`TICKROOM_TEST_REDIS_URL` pointed at an unused port (6499), which is the
no-services promise proved rather than assumed; `npm run test:integration` is
**1197 across 43** with a local Redis on 6399; `npm run test:measure` is **16
across 4** on the same Redis and a quiet laptop; `npm test` is the sum, **1213
across 47**. `npx tsc --noEmit` is clean repo-wide including `examples/`, and
`npm run build` emits `dist/` cleanly. Roughly 18,700 lines of source and 28,700
of tests. `README.md`, `AGENTS.md` and the five files under `docs/` are the whole
of the prose.

Forced jittery (`JITTER_LIMIT` dropped to 1.0 for the check, then restored) the
integration tier still exits 0 with its wall-clock cases skipped and the
measurement tier is all skipped and still exits 0, which is the loud-skip path
exercised rather than argued.

THE LONG RUNS HAPPEN ON A SECOND MACHINE. Anything that takes minutes (the whole
suite, the split-brain long form, the bench's own multi-client runs) executes on
the fw13 server, a 16-core NixOS box, with Redis in Docker and the browser
harness in the official Playwright container rather than on the laptop. A machine
with sixteen cores busy is not a slower laptop, it is a different measurement,
and that is how the last wall-clock cases were found.

THE WALL-CLOCK CASES WERE FIXED AT THE SOURCE RATHER THAN GATED BY
DOCUMENTATION: `connection.test.ts`'s reconnect ladder steps timer to timer;
`relay.test.ts`'s throttled-interval liveness pair runs on fake timers;
`ticker.test.ts`'s grid-stamp, stall-resync and checkpoint-ordering runs end on a
SAMPLE COUNT rather than on a fixed window, and its lease-theft case waits for
the loop to go quiet; the successor-spawn race, a genuine 2s wall-clock deadline
that cannot be anything else, carries a calibrated tolerance (`JITTER_SCALE`,
capped at 3x); and the DOM `WebSocket` assignment test guards the global rather
than assuming one. THE FILES THAT CANNOT BE FIXED AT THE SOURCE KEEP THEIR TIGHT
BARS, MOVE TO THE MEASUREMENT TIER, AND SKIP LOUDLY: `smoothness`, `splitbrain`,
`example` and `example-cursors` assert zero backward steps, zero motionless
frames, a millisecond overlap between two real tickers and a snapshot rate inside
+-10%, and there is no honest way to scale a bound of zero. Three cases of
`ticker.redis.test.ts` and three of `faults.redis.test.ts` stay inside their
otherwise deterministic files and carry the same gate per case
(`itSteady = it.skipIf(TOO_JITTERY)`), because the rest of each file is worth
gating a release on.

PER FILE, which is what a mutation row is measured against: the per-file case
counts and the mutation matrices they belong to are in `docs/LEDGER.md`, and a
row there is a statement about the tree it was measured on. Re-measure a table
when you touch the file it covers.

- Extracted and implemented: core, server, client, codec, adapters, plus three
  examples (a 2D game, a presence layer, a plain Node host).
- PUBLISHED to npm. DEPLOYED AND MEASURED ON A REAL VERCEL PROJECT, so the
  platform claims are no longer the untested half; the numbers are in
  `docs/VERIFICATION.md` and the dated runs in `docs/LEDGER.md`. It has still
  never carried production traffic, so every claim here is unit-level,
  integration-level, browser-level and platform-level, plus whatever the source
  architecture already proved in production. IF YOU ARE UPDATING STATUS, UPDATE
  EVERY PLACE THAT STATES IT: this bullet once contradicted both the release
  workflow and the real-Redis section of the same file.
- Every test runs offline against `src/server/memoryRedis.ts`, which was built
  specifically to reproduce the production incidents this design exists to
  prevent (lease theft, the subscribe race, liveness and pong, backpressure
  fairness) deterministically and without a service, and which SHIPS, so what a
  no-Redis consumer gets is the object the suite exercises thousands of times a
  run rather than a second implementation nobody checks.
- The upstream game this was extracted from is the production evidence for the
  design: the lease, the checkpoint handoff, the playout timeline, the stall
  thresholds and the interpolation rules were all measured there under real load.
  Where a number in a comment is quoted as "measured", that is where it came from.

### The tier of every test file

THE SOURCE OF TRUTH FOR THE SPLIT. `vitest.config.ts` follows this table; if the
two disagree the config is wrong. The three questions the tiers answer are
different, which is the whole reason for the split: `unit` and `integration` are
decided by the CODE and are the same answer on any machine, so they gate a
release; `measure` is decided by the WALL CLOCK and is only an answer on a
machine quiet enough to take a reading.

| file | tier | why |
| --- | --- | --- |
| `src/adapters/node.test.ts` | unit | no services |
| `src/adapters/vercel.test.ts` | unit | no services |
| `src/client/bundling.test.ts` | unit | no services |
| `src/client/clientTick.test.ts` | unit | no services |
| `src/client/connection.test.ts` | unit | no services; its reconnect ladder steps timer to timer rather than over wall time |
| `src/client/errorOffset.test.ts` | unit | no services |
| `src/client/interpolation.test.ts` | unit | no services |
| `src/client/netPolicy.test.ts` | unit | no services |
| `src/client/predictedEntity.test.ts` | unit | no services |
| `src/codec/bytes.test.ts` | unit | no services |
| `src/codec/quantize.test.ts` | unit | no services |
| `src/codec/snapshot.test.ts` | unit | no services |
| `src/core/backpressure.test.ts` | unit | no services |
| `src/core/checkpoint.test.ts` | unit | no services |
| `src/core/ids.test.ts` | unit | no services |
| `src/core/lease.test.ts` | unit | no services; the pure clock functions and a fake Redis |
| `src/core/log.test.ts` | unit | no services; source-text, every log kind emitted is in the union and every kind in the union is emitted |
| `src/core/metrics.test.ts` | unit | no services |
| `src/core/playout.test.ts` | unit | no services |
| `src/core/rateLimit.test.ts` | unit | no services |
| `src/core/starvation.test.ts` | unit | no services |
| `src/server/admission.test.ts` | unit | no services |
| `src/server/balancer.test.ts` | unit | no services |
| `src/server/checkpoint.test.ts` | unit | no services |
| `src/server/redis.test.ts` | unit | no services; pins the OPTIONS the factory passes, not what they do |
| `src/server/relay.test.ts` | unit | no services; its throttled-interval liveness pair runs on fake timers |
| `src/server/session.test.ts` | unit | no services |
| `src/server/ticker.test.ts` | unit | no services; ends on a SAMPLE COUNT rather than a fixed wall-clock window |
| `src/testing/lockstep.test.ts` | unit | no services |
| `examples/cursors/sim.test.ts` | unit | no services, pure simulation |
| `examples/pong/codec.test.ts` | unit | no services, pure codec |
| `examples/pong/sim.test.ts` | unit | no services, pure simulation |
| `tests/memory.test.ts` | unit | THE ONE FILE UNDER `tests/` THAT NEEDS NOTHING, which is the claim it exists to check: `createMemoryRedis` is the bus. It drives a real `ws` socket over four seconds, but its bounds are presence claims and 0.5x-generous counts, not a rate band |
| `tests/tiers.test.ts` | unit | no services; the guard that every file under `tests/` is in exactly one tier |
| `tests/checkpoint.redis.test.ts` | integration | real Redis; gzip round trips or it does not. Its TTL bounds are the server's own, with seconds of slack |
| `tests/depth.redis.test.ts` | integration | real Redis; the depth frame reaches a client through a real ticker and relay and closes the stamping-lead loop, a deterministic outcome |
| `tests/e2e.redis.test.ts` | integration | real Redis and a real socket; admission decisions and "a snapshot arrived", all polled to a condition |
| `tests/faults.redis.test.ts` | integration, 3 of 5 cases gated | real Redis behind a proxy. Lease theft and the crash loop assert on tick numbers and a counter Redis holds: same answer anywhere. The two black-hole cases and the restart case TIME the exit against a probe deadline, a lease TTL and a run cap, so they are `itSteady` |
| `tests/lease.redis.test.ts` | integration | real Redis; N concurrent SET NX, the Lua owner checks, a TTL expiring on the server clock. The one timing bound is a 5000 to 8000ms window on a TTL |
| `tests/pubsub.redis.test.ts` | integration | real Redis; fan-out cost and subscribe-mode locking, both counted rather than timed |
| `tests/redisLike.test.ts` | integration | real Redis; every `RedisLike` method against real ioredis. No timing at all |
| `tests/subscriber.redis.test.ts` | integration | real Redis and two child processes; the control DIES and the fixed one SURVIVES, which is a binary outcome, not a duration |
| `tests/ticker.redis.test.ts` | integration, 3 of 5 cases gated | real Redis. The stats-TTL and handoff cases are polled to a condition. The rate case's +-25% band and the two geometry cases' interlocking floor/ceiling on a 200Hz loop are wall-clock counts, so they are `itSteady` |
| `tests/example-cursors.redis.test.ts` | measurement | real Redis, real socket, real client on a 16ms timer. Snapshot rate inside +-10% of 20Hz and a move-to-snapshot latency bound built from a send period plus a round trip plus a tick |
| `tests/example.redis.test.ts` | measurement | same rig around `examples/pong`. Snapshot rate inside +-10%, zero frames that failed to draw, and a paddle step that is EXACTLY one tick of `PADDLE_SPEED` on every unsaturated step |
| `tests/smoothness.redis.test.ts` | measurement | a real 60Hz render loop over a real socket, asserting zero backward steps, zero motionless frames, zero blank frames |
| `tests/splitbrain.redis.test.ts` | measurement | two real tickers racing one Redis; the overlap is in milliseconds and the lapse assertions carry no slack term at all by design |

TWO FILES ARE MIXED AND STAY WHERE THEY ARE. `ticker.redis.test.ts` and
`faults.redis.test.ts` each carry a few wall-clock cases inside a mostly
deterministic file, and the deterministic majority (the handoff, the stats TTL,
the lease theft, the crash counter) is exactly what a release gate is for. So the
measurement cases are gated PER CASE inside the file rather than the file being
moved out of the gate, which is the smaller loss.

## Still owed

Everything the pre-1.0 list closed is in `docs/LEDGER.md`, dated, with the
measurement that paid for it. What is genuinely open:

- **A Safari read without the per-sample switch, and mobile.** Safari throttles
  far less than Chromium, which is the safe direction, but WebDriver would not
  report a background tab's state while another tab sat in front of it, so the
  harness switched to the measured tab for each 30s sample and back. That is a
  tab hidden thirty seconds at a time, not one hidden straight through. Reading
  it without the switch needs a `BroadcastChannel` to a visible helper tab, or
  the page posting its own state to the server. Mobile is untouched.
- **The relay swap's FAILURE path under a throttle.** A successful swap is
  message-driven and rides through a hidden tab's throttle; a failed one falls
  back to the reconnect ladder, which is a TIMER the throttle does reach, so that
  outage can still stretch toward a minute. Untested.
- **Nothing drives an example through the VERCEL adapter in process.** Both
  shipped examples go through a real socket in CI, pong on the stamped path and
  cursors on the unstamped one, and the bench deployment IS the drive through the
  Vercel adapter, so what is missing is a test rather than a measurement.
- **`TARGET_DEPTH_TICKS` (2) is a reasoned default, not a swept one.** The
  headroom beside it IS swept and the one-tick deadband was measured worse;
  sweeping the target would mean exposing the constant as an option, which was a
  deliberate no.
- **The arrival band's last two readings.** A socket `message`-timestamp ring
  confirmed every frame-inferred gap over 250ms at the socket itself, so the band
  is the WebSocket path rather than the renderer, the ticker, the bus or the
  relay. Still owed: the same run from a quiet machine on a residential link
  rather than a loaded container, and a whole-process stall detector in the page
  (a `setInterval` heartbeat gap ring), because a blocked event loop stops the
  `message` handler too and cannot be told apart from inside it. `socket` means
  "not only the render loop", never "the network".
- **No lint script**, so CI runs no linter. Add the script before adding the step.
- The package ALSO installs as a git dependency, and `"prepare": "npm run build"`
  is what makes that work: `dist/` is gitignored and every `exports` path points
  into it, so without the hook a `github:` install resolves to a package with no
  code in it at all. Publishing to npm did not retire the hook, because `npm
  publish` also runs it and a consumer pinning a commit is still a supported
  route. `prepare` also runs on a plain local `npm install`, which is harmless.
