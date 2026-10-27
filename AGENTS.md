# tickroom: agent onboarding

Read this once instead of re-deriving the codebase. It is the OPERATING manual:
what the library is, how it is layered, what may never change, what has bitten
people, and how to prove a change is good. Keep it current: whoever changes the
architecture updates the file map, the status and the gotchas in the same commit.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the reasoning behind every
  load-bearing decision and is short. Read it too.
- [`README.md`](README.md) is the pitch and the quickstart,
  [`docs/GUIDE.md`](docs/GUIDE.md) the full walk-through,
  [`docs/OPERATIONS.md`](docs/OPERATIONS.md) the cost model, the platform
  limits and the release procedure,
  [`docs/API.md`](docs/API.md) the supported export surface (a name not on it
  is reachable but internal, and a 2.0 prunes it from the barrels), and
  [`docs/VERIFICATION.md`](docs/VERIFICATION.md) the measurements.
- [`docs/agents/`](docs/agents/) holds the DETAIL this file indexes: every
  file-map entry, invariant and gotcha in full, the gates, the status and the
  tier of every test file. This file states each rule in a line; the reasoning
  and the incident behind it are one link away, and a change that invalidates
  either updates both.

## What this is

A TypeScript library for running authoritative realtime multiplayer rooms on
serverless functions. Extracted from a shipped multiplayer browser game and
generalised so it works for 2D games, collaborative apps, multiplayer cursors,
or anything realtime where several clients need to agree on state changing many
times a second.

PUBLIC repo, MIT licensed, and PUBLISHED TO NPM as `tickroom`
(`npm install tickroom ioredis`). `package.json` says 1.3.0 and this tree IS
1.3.0: `CHANGELOG.md` is the record of what each release carries; its "Migrating from 0.3" list is still the break-by-break
guide for anyone coming off the 0.x line.

RELEASES GO OUT FROM A VERSION TAG through `.github/workflows/release.yml`
using npm trusted publishing (OIDC): `npm version` plus a pushed tag is the
whole of it. The procedure, the two rules the gate encodes (integration tier
only, Redis service required) and why `prepare` stays are in
`docs/OPERATIONS.md`, "Cutting a release".

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

An INDEX, one or two lines per file: what is where and what couples to what.
[`docs/agents/files.md`](docs/agents/files.md) is the full entry for each
(trust boundaries, orders, exported names, log kinds). Every constant and option
is documented at its own declaration.

**core** (pure)

- `src/core/types.ts` - THE CONTRACT: `RoomRuntime`, `RoomEnvelope`, `ClientInput`, `CheckpointEnvelope`, `RoomStats`, `Logger`. Change only with a very good reason; `gridAt` is optional and additive.
- `src/core/log.ts` - `LOG_KINDS` and `LogKind`; `log.test.ts` proves the converse of `tsc`. ADD THE KIND HERE FIRST, THEN EMIT IT.
- `src/core/wire.ts` - THE CONTROL-PLANE CONTRACT both ends import: `CLOSE_CODES` (4001 to 4004, only 4004 non-terminal), `SERVER_FRAMES`, `CLIENT_FRAMES`, `ROOM_REJECT_FRAME`, `DEPTH_FRAME`, the ping, expiry and presence constants, and `depthFor` (own properties and finite numbers only).
- `src/core/redisLike.ts` - the structural Redis interface and THE SUPPORTED SWAP POINT; optional `on`/`off` lets the ticker detach on `'reconnecting'`.
- `src/core/ids.ts` - `roomKeys` (NINE suffixes, `KEY_SUFFIXES` the one list), `normalizeRoomId`, `normalizeBase`. A TRUST BOUNDARY: the value lands in key names.
- `src/core/lease.ts` - the exactly-one-writer lease and the `OwnershipClock` two-clock rule. The single most safety-critical file.
- `src/core/checkpoint.ts` - the envelope grammar, pure; `inspectCheckpoint` says WHY it refused, `unpackCheckpoint` throws that away.
- `src/core/playout.ts` - `PlayoutBuffer`: never-drop-late re-stamping, `aheadBase`, `PushResult` with separate `late` and `refused` counters.
- `src/core/starvation.ts` - decay policy and `StarveTracker`; `decayOnStarve` takes the streak as delivered (1 on the first starve).
- `src/core/backpressure.ts` (`Inbox`, per-sender quota), `rateLimit.ts` (`TokenBucket`), `metrics.ts` (`percentiles`, `RollingHistogram`, `Counters`).

**server**

- `src/server/checkpoint.ts` - checkpoint STORAGE (gzip, `node:zlib`, hence this layer); the write is OWNER-CHECKED by a two-key Lua SET.
- `src/server/redis.ts` - ioredis factories. The shared client has `commandTimeout: 2000`, the SUBSCRIBER deliberately none; read `tests/subscriber.redis.test.ts` before touching `createSubscriber`.
- `src/server/session.ts` - HMAC tokens, and room-bound spawn tokens valid for TWO windows of `SPAWN_TOKEN_WINDOW_MS`.
- `src/server/admission.ts` - `admitSocket`, `registerConnection`, `refuseSocket` (two latches). The per-subject cap is SOFT by two round trips.
- `src/server/ticker.ts` - THE CORE, `runTicker`; read it slowly. `guardHost`, grid-time `serverTime`, `queueCheckpoint`, `abandonSetup`, `reconcileMembership`, the acquire recovery, the `room-reject` budget, the depth frame. `EXIT_SPAWN_WAIT_MS` (3500) is coupled to the adapter's `SPAWN_ACK_MS` (3000).
- `src/server/relay.ts` - `attachRelay`, `checkAdmission`: one socket to the bus. Ping by literal prefix, `joinFragments`, the roster ALLOWLIST, 4004 never 1006, `relay.gaps`.
- `src/server/roomSubscriber.ts` - ONE SUBSCRIBER PER ROOM PER PROCESS, reference counted: delivery, the shared SUBSCRIBE ack, the resubscribe, error counting, the self-probe. Keyed on the `createSubscriber` reference too; `sharedSubscriber: false` is the escape hatch.
- `src/server/memoryRedis.ts` - THE IN-MEMORY REDIS, AND IT SHIPS, exported twice (the `tickroom/server/memoryRedis` subpath has no ioredis import). FOUR DELIBERATE GAPS.
- `src/server/balancer.ts` - `assignRoom`; every-instance-excluded is an ORDINARY outcome.

**client**

- `src/client/netPolicy.ts` - `stallDecision`, `shouldReanchor` (two-sided; takes `desiredTick`, never the raw server tick).
- `src/client/errorOffset.ts` - `ErrorOffset`, render-layer correction smoothing.
- `src/client/clientTick.ts` - the monotonic client tick; `anchorTo` is a bare round, the lead lives in `desiredTick()`.
- `src/client/predictedEntity.ts` - `PredictedEntity`, THE OBJECT `predict` OWNS: `advance`, `reconcile`, `snapTo`, `renderTick`; binary wire by default with every input shape-checked; no stamping while unanchored; `idleInput` STEPS THE STARTUP GAP. `predictedEntity.test.ts` has 68 cases.
- `src/client/interpolation.ts` - `SnapshotInterpolator` on the SERVER timeline; `push()` IS A TRUST BOUNDARY; `teleport(key)` has a call-order contract, `forget` is not the call for a jump.
- `src/client/connection.ts` - `RoomConnection`, owner of the tick counter, the interpolator and the entity. `frame()` IS THE ONLY PER-FRAME CALL; it owns three orders; `desiredTick()` is the whole lead; `processSnapshot` is a trust boundary; `stats()` is eleven fields.

**codec, adapters, testing**

- `src/codec/bytes.ts` - `ByteWriter`/`ByteReader`, BOTH TRUST BOUNDARIES (refuse, never wrap; any `ArrayBufferView`), and `ProtocolVersionError`, duck-typed BY NAME.
- `src/codec/quantize.ts` - clamping helpers, `representableRange`, `CM_SCALE`; `quantize` throws on NaN.
- `src/codec/snapshot.ts` - the default codec and input window; `decodeInputAuto` is THE ONE DECODER FOR BOTH INPUT WIRES and never throws.
- `src/adapters/vercel.ts` - route factories by INJECTION; `createRoom` IS THE PRIMARY ENTRY POINT; `maxDurationS` ties the lifetimes to the platform cap; `deliverSpawn`; the session route is the fourth piece.
- `src/adapters/node.ts` - the same core behind `ws`; imports server modules directly, never the barrel, nothing from the other adapter; `requireBothOrNeither`.
- `src/testing/lockstep.ts` - `runLockstep`/`sweepLockstep`: a host's runtime against its own step, server half MIRRORING `ticker.ts`, options mirroring `predict`. No node builtin.

**examples, tests, config**

- `examples/pong/` - THE SHIPPED STAMPED REFERENCE (`stepPaddleY` shared by both ends, `PONG_PROTOCOL_VERSION` 3). `examples/cursors/` - THE UNSTAMPED CONTRAST. `examples/node-server/README.md` - the plain Node host's manual.
- `tests/faults.redis.test.ts` + `tests/helpers/proxy.ts` - faults behind a real TCP proxy; the proxy is shared with `subscriber.redis.test.ts`.
- `tests/example.redis.test.ts`, `tests/example-cursors.redis.test.ts` - the two examples unmodified through a real socket, stamped and on-arrival.
- `tests/splitbrain.redis.test.ts` - how long a predecessor keeps publishing; `TICKROOM_SPLITBRAIN_REPS`.
- `tests/depth.redis.test.ts` - the depth loop with the host carrying nothing.
- `tests/memory.test.ts` - the one `tests/` file needing nothing; `REDIS_URL` deleted for the run.
- `tests/tiers.test.ts` - every `tests/` file in exactly one tier. `tests/helpers/jitter.ts` - timer lateness against `JITTER_LIMIT`; over it, gated files SKIP LOUDLY.
- `tsconfig.json` - `exactOptionalPropertyTypes` ON, for the consumer's sake; see Gates.

## Non-negotiable invariants

Rules, one line each. [`docs/agents/invariants.md`](docs/agents/invariants.md)
carries every one with its full reasoning and the incident behind it; read that
entry before changing anything a rule names. The trap each one guards against is
often a gotcha.

**Layering and the loop**

- `src/core/` stays pure, ENFORCED by `bundling.test.ts`; a Node-only module MOVES out of `core/`, it is not merely dropped from the barrel.
- `src/server/` imports nothing from `next` or `@vercel/functions`.
- NO AWAITS IN THE TICKER HOT LOOP except the sleep to the next grid point.
- Every `RoomRuntime` method is SYNCHRONOUS.

**Lease and ownership**

- Only a CONFIRMED renew advances ownership, ONE FUNCTION PER CLOCK in `lease.ts` (`renewAttempted`, `renewConfirmed`, `renewFailed` moving neither). THIS HAS REGRESSED TWICE; overlapping renews are the accepted price.
- OWNERSHIP IS DATED FROM THE RENEW ATTEMPT, and an acquire recovered after a throw from the FIRST thrown attempt; `splitbrain.redis.test.ts` measures the margin.
- EVERY EXIT FROM THE TICK LOOP NAMES ITSELF; a lost lease has two finders that both set it, and a CONFIRMED LOSS IS CHECKED BEFORE THE PUBLISH BLOCK.
- THE INVOCATION'S LIFETIME IS MEASURED FROM INVOCATION ENTRY; only ownership is dated from the acquire.
- `standbyMs` MUST EXCEED `standbyLeadMs` plus the incumbent's exit and fit inside `maxRunMs`; `standbySpawned` is set on ISSUE, cleared on REJECT.

**Checkpoints and the timeline**

- A geometry digest mismatch starts fresh, and so does a checkpoint VERSION this build does not implement, in both directions.
- A CHECKPOINT WRITE IS OWNER-CHECKED IN REDIS; a refusal is a lost lease.
- CHECKPOINT WRITES ARE SERIALISED THROUGH ONE CHAIN, the envelope serialised when the chain reaches the write, and nothing written once `crashed` is set.
- A THROWN TICKER WRITES NO FINAL CHECKPOINT AND SPAWNS NO SUCCESSOR; it records the crash before the marker and the release; three crashes start the room FRESH.
- THE CRASH WINDOW IS FIXED, CLEARED BY UPTIME, and the record is AWAITED (raced).
- EVERY PRE-LOOP EXIT RUNS THE LOOP'S OWN TEARDOWN through `abandonSetup`.
- `serverTime` IS THE SCHEDULED GRID TIME, never a clock read after `runtime.tick`.
- A CHECKPOINT CARRIES ITS GRID AND A SUCCESSOR CONTINUES IT, inside an ASYMMETRIC window (one tick ahead, `GRID_CATCHUP_TICKS` behind); OUTSIDE it the clock paces the grid and an offset carries the timeline.
- AN EXIT THAT WRITES NO CHECKPOINT OWES A FLOOR, `room:{id}:timeline`: written before release, applied as `max(gridAt, timeline)`, deleted only by a final checkpoint that landed.

**Inputs and the tick**

- THE INPUT WINDOW IS PUSHED NEWEST FIRST, only after the first consume; the ahead bound has its OWN reference (`aheadBase`), never `lastConsumedTick`.
- AN UNSTAMPED RECORD SUPERSEDES THE STAMPED ONES BEFORE IT; `targetTick` is stamped only as a finite POSITIVE INTEGER.
- THE STEP THAT PRODUCES TICK T CONSUMES THE INPUTS STAMPED T, so a client replays `targetTick > snap.tick`.
- EARLY IS NOT STARVED: a non-empty buffer starves at streak 1 and never ramps the decay.
- ONE INPUT STREAM PER CONNECTION: one playout buffer per pid.
- A wire change bumps the protocol version when it changes MEANING, not only shape.

**Membership, admission, relay**

- Capacity is read from ONE key (`room:{id}:stats`) by relay and balancer, NEVER the meta hash.
- ANYTHING KEYED BY PID IS DROPPED WHERE `presentPids` STOPS REPORTING IT, and a pid buffered but never present by `dropStrangers`.
- A CAP THAT COULD NOT BE EVALUATED SAYS SO; admission fails open, never invisibly.
- ONE ADMISSION PROTOCOL, in `server/admission.ts`.
- A RELAY IDENTIFIES ITSELF (`c`), and a leave from a relay already replaced is ignored.
- A `room-reject` IS AIMED AT A CONNECTION; ABSENT is the only thing that means unspecified on its `c` (`c !== undefined && c !== conn` refuses).
- `attachRelay` CHECKS `readyState`, NEVER ASSUMES OPEN.
- A DEFERRAL NEEDS A DEADLINE, AND A CONTROL FRAME PRODUCED BEFORE OPEN NEEDS A QUEUE.
- A RUN OF FAILING SENDS IS A DEAD SOCKET, AND ONE FAILING SEND IS NOT.
- A REFUSAL NEEDS TWO LATCHES: the frame is best effort, the CLOSE is the refusal.
- THE SNAPSHOT FORWARD MAY DROP; THE `metaout` FORWARD MAY NOT, and it is an ALLOWLIST: misaddressed per-socket frames are dropped and counted.
- A RELAY PROBES ITS OWN SUBSCRIPTION, one probe per subscription; A PROBE ANSWER IS BOUNDED BY WHAT WAS SENT (`Number.isInteger(n) && n > answered && n <= sent`).
- A GAP IS ATTRIBUTED BY WHICH SIDE OF THE SOCKET SAW IT; a silent `relay.gaps` is half the reading.
- A LIVENESS DEADLINE IS SIZED AGAINST THE SLOWEST HEALTHY CADENCE: `DEFAULT_LIVENESS_TIMEOUT_MS` stays above 60s.
- AN OPTIONAL TRANSPORT CAPABILITY IS DETECTED AND REPORTED AT ATTACH, NEVER ASSUMED.
- EVERY WAIT ON REDIS IS BOUNDED, but not by the same mechanism; NO client-wide timeout on a SUBSCRIBER (reproduced, taken back out), and db 0.

**Metrics and host code**

- A COUNTER COUNTS WHAT HAPPENED, inside the publish promise's `.then`.
- AN EMPTY METRIC WINDOW IS `null`, NEVER ZEROS.
- Anything whose rate a client controls is COUNTED and flushed on a cadence, never logged or written per message; a `room-reject` fan-out is one of those paths.
- NOTHING A HOST HOOK DOES MAY REACH THE LOOP (`guardHost`, thenables included); the non-payload hooks stay unguarded on purpose.
- NOTHING ESCAPES A PLATFORM CALLBACK, AND THE CATCH BLOCK IS GUARDED TOO.
- OPTIONS ARE SPREAD, NEVER COPIED, ACROSS THE ADAPTER BOUNDARY.
- A DERIVED LIFETIME NEEDS A FLOOR AS WELL AS A CEILING, checked on the RESOLVED value, and is tied to the platform's cap.

**Client: clocks, anchors, connection**

- ONE CLOCK DOMAIN IN THE CLIENT: `performance.now()`.
- NEVER 0 FOR "NOT YET" ON A `performance.now()` AXIS (the third `aheadBase` trap).
- `RoomConnection.frame()` IS THE ONLY PER-FRAME CALL; `RoomConnectionOptions.tickHz` IS REQUIRED; THE SERVER'S OWN TICK RATE IS MEASURED AND REPORTED, NEVER ADOPTED.
- A LEAD IS MEASURED, NOT ASSUMED.
- RE-ANCHOR IS TWO-SIDED, RATE-LIMITED BEHIND, DEFERS TO THE CLOCK'S STEP ESCAPE, and SEES THE COUNTER PROJECTED by the time since the last frame.
- AN ANCHOR IS PROVISIONAL WITH RESPECT TO THE ROUND TRIP IT ASSUMED.
- `rttMs` IS A SLIDING-WINDOW MINIMUM; A PONG IS MATCHED TO AN OUTSTANDING PING.
- `RoomConnection.processSnapshot` IS A TRUST BOUNDARY; finite is not plausible; AN ESCAPE HATCH IS A RATE, NOT A SWITCH.
- A HOST CALLBACK'S THROW IS COUNTED; EVERY CALL OUT TO HOST CODE GOES THROUGH `emit()`; A TERMINAL'S CALLBACK IS THE LAST STATEMENT.
- EVERY REFUSAL FRAME: latch AND close. `mint()` OUTPUT IS UNTRUSTED; an attempt is identified by a generation.
- GAUGES ARE EPOCH-SCOPED, COUNTERS ARE LIFETIME.
- A RELAY SWAP IS RATE LIMITED WITH A FLOORED DEADLINE; A WARM SWAP IS NOT AN EPOCH CHANGE.
- THE RECONNECT LADDER IS JITTERED, its base sized against the interpolator's cover.

**Client: prediction and rendering**

- A BACKWARD COUNTER JUMP REWINDS THE PREDICTION AND RELABELS NOTHING; a new epoch starts the entity over.
- THE STARTUP GAP IS TICKS THE SERVER STEPPED, NOT TICKS THAT DID NOT HAPPEN; `predict.idleInput` steps it.
- A FROZEN RENDER LOOP IS AN EPOCH BOUNDARY FOR THE COUNTER, not for the interpolator.
- Interpolate remote entities on the SERVER's clock; never freeze on underrun, extrapolate; UNWIND EXTRAPOLATION AS A GLIDE clamped to the interpolator's own overshoot.
- `SnapshotInterpolator.push()` IS A TRUST BOUNDARY; THE FUTURE-STAMP REFUSAL MUST NOT BE PERMANENT (a windowed count).
- The clock offset is eased except after `REANCHOR_AFTER_MS` stranded with `REANCHOR_MIN_SAMPLES` arrived; never weaken that gate.
- Nothing evicts a frame the playhead brackets; the time prune is SUSPENDED during an error window.
- A reconnect CLEARS AND THEN RESUMES the interpolator, and the connection does it (`markUnanchored`, `clear`, `resumeFrom`).
- A JUMP THE HOST KNOWS ABOUT IS THE HOST'S TO DECLARE and the connection makes the calls; `forget` is the trap; `teleport`'s call order is a contract.
- BOTH TERMS OF THE PLAYHEAD ARE SLEW-CAPPED (offset 5%, delay 8%).
- A RATE MEASURED AGAINST A CLAMPED `dt` IS NOT A RATE.

**Types and codec**

- `SnapshotInterpolator<K>` HAS NO DEFAULT KEY TYPE; `CodecEntity.id` IS REFUSED OUT OF RANGE; an integer field REFUSES rather than wraps.
- A CALLBACK-PARAMETER TYPE IS CHECKED CONTRAVARIANTLY, SO `unknown` IS THE WRONG WIDENING (`any` on the four `WebSocketLike` slots).
- Prose style: no em dashes, no en dashes. Never mention AI or an assistant in code, comments, commits, or docs. Plain descriptive commit messages.

## Gotchas that cost real production time

Traps rather than rules: shapes that look right and are not. One line each here;
[`docs/agents/gotchas.md`](docs/agents/gotchas.md) has each one in full.

- A HALF-BUILT SEAM IS WORSE THAN NO SEAM: the counterpart of a new option is its CALL SITE.
- THE PER-SENDER INBOX QUOTA IS A FAIRNESS PROPERTY a socket flooder never reaches; never assert `dropped > 0` under a socket flood.
- A SPAWN IS A DELIVERY, NOT A CONVERSATION: race a plain timer, resolve on a receipt, never `AbortSignal.timeout`.
- TWO FIRST JOIN PUBLISHES, AND BOTH ARE LOAD-BEARING.
- DETACH BEFORE CLOSE ON THE CLIENT.
- `readCheckpoint` MUST USE `getBuffer`, NEVER `get`.
- A BARE `raw in WORLDS` MATCHES INHERITED PROPERTIES; use `hasOwnProperty.call`.
- A CLAMP AGAINST A RANGE THE HOST NEVER CHOSE (`positionScale`, `representableRange`).
- BEFORE A RUN-BASED DISCRIMINATOR IN THE INTERPOLATOR, ASK WHAT REORDERS THE STREAM.
- A RESYNC THAT DOES NOT SLEEP IS THE RUBBER-BAND IT EXISTS TO PREVENT.
- A BLACK-HOLED SUBSCRIBER PRODUCES NO EVENT AT ALL; the probe's constants are its own, not a multiple of `statsMs`.
- A LEAVE THAT LANDS IN A HANDOFF GAP IS LOST: five heartbeats before a synthesised leave.
- A GRACE-PERIOD REJOIN WAS REFUSED BY THE FULL ROOM IT WAS ALREADY IN.
- A THROWN CHECKPOINT READ IS NOT AN ABSENT CHECKPOINT.
- A RELIABLE QUEUE ON A LOSSY BUS IS WORSE THAN DROPPING; `snapshotBacklogBytes` is memory safety, not staleness control.
- A SPAWN POLL WITHOUT A HOLD-OFF IS A THUNDERING HERD.
- TWO LISTENERS ON ONE PUB/SUB CONNECTION COST A UTF8 DECODE PER FRAME.
- A 4001 IS TWO DIFFERENT EVENTS ON ONE CODE.
- A `void`ED PROMISE MAKES EVERY THROW SILENT.
- A CONSTANT CAN ONLY BE PINNED FROM BOTH SIDES.
- A BACKWARD RE-ANCHOR SILENCES A HOST THAT DEDUPES BY A HIGH-WATER MARK.
- A HIDDEN TAB FIRES `onTickReanchor` ABOUT EVERY TWO SECONDS, AND THAT IS NOT A FAULT.
- A REDIS DB INDEX DOES NOT ISOLATE TWO DEPLOYMENTS, AND `namespace` DOES (on BOTH routes).
- STEADY MOTION HIDES AN OFF-BY-ONE IN THE INPUT TIMELINE: a reconciliation test MUST change the input and assert on the LABEL.
- A COUNTER JUMP IS NOT TIME PASSING: drive the REAL counter with `anchorTo` jumps and assert on the DRAWN pose.
- A ONE-TICK FEEDBACK DEADBAND WAS MEASURED WORSE; the cushion belongs in `inputLeadMs`.
- THE THREE ORDERS A CONSUMER GOT WRONG WITH A HAND-HELD `PredictedEntity`: remove the second object.
- THE BINARY INPUT WIRE CHECKS ITS SHAPE BEFORE THE FIRST STAMP, NOT INSIDE THE ENCODER.
- A PREDICTION STEP HAS TO BE PURE OF CLIENT-FRAME STATE: hooks are functions of the arguments.
- A MINIMUM-FRAME-INTERVAL GATE IN A rAF LOOP IS A FRAME DROPPER.
- A COLD START SAYS SO NOW (`ticker.fresh`).
- A FRAGMENTED FRAME IS THE RELAY'S PROBLEM (`joinFragments`).
- FLUID COMPUTE CAN RUN THE STANDBY IN THE INCUMBENT'S CONTAINER: generate an instance id PER INVOCATION.
- VERCEL AUTHENTICATION BLOCKS THE RELAY'S OWN TICKER SPAWN, AND THE ONLY SYMPTOM IS SILENCE.
- UPSTASH'S `CLIENT LIST` CARRIES NO SUBSCRIBE-MODE FIELDS; read `INFO clients`.
- A HOST CALIBRATION TAKEN AT MODULE LOAD CAN UNDER-READ THE RUN IT GATES.
- UNDER `vi.useFakeTimers()`, ANYTHING DOWNSTREAM OF REAL I/O (GZIP INCLUDED) IS TIMESTAMPED NONDETERMINISTICALLY.
- A HELPER SCRIPT WITH A RELATIVE SOURCE PATH WILL EVENTUALLY OVERWRITE THE FILE YOU ARE EDITING: ABSOLUTE PATHS ONLY.
- AN UNTRACKED SCRATCH SUITE UNDER `src/` INFLATES EVERY COUNT AND SHIPS TO NPM (`tsc` never cleans `outDir`).
- NEVER ASSERT ON SERVER-GLOBAL STATE IN AN INTEGRATION TEST.

## Gates

From the repo root:

```
npx tsc --noEmit           # typecheck, must be clean
npm run lint               # eslint over src, tests, examples, must be clean
npm run build              # rm -rf dist && tsc -p tsconfig.build.json
npm run test:unit          # the unit tier, NO services anywhere, green offline
npm run test:integration   # unit + integration tiers, needs a real Redis
npm run test:measure       # the measurement tier, real Redis AND a quiet machine
npm test                   # all 47 files, every tier, what a developer runs
npm run example:node       # tsx examples/node-server/server.ts, see its README
```

- PROVE `test:unit` WITH NOTHING LISTENING: `TICKROOM_TEST_REDIS_URL=redis://127.0.0.1:6499 npm run test:unit`.
- Integration and measure run against Redis on 6399 (`TICKROOM_REQUIRE_REDIS=1` is baked into both scripts); on fw13 that is `podman start tickroom-redis`, host networking only.
- CI runs typecheck, build and `test:unit`, then `test:integration` against `redis:8`; `release.yml` gates on build, typecheck and `test:integration`; `nightly.yml` runs `test:measure` and blocks nothing.
- THE SUITE IS TIERED by `TICKROOM_TIER` in `vitest.config.ts`: `unit` (34 files), `integration` (43, the release gate), `measure` (4, one file at a time, never on a required check). A new `tests/` file needs a tier in `vitest.config.ts` and a row in [`docs/agents/tiers.md`](docs/agents/tiers.md), the source of truth.
- `npm pack --dry-run` is re-measured after a build, never quoted forward.
- `exactOptionalPropertyTypes` is ON for the consumer: public optional fields are `?: T | undefined`, callbacks are PROPERTY signatures, and a callback-parameter type is never widened.
- Releases: `npm version <level>` plus a pushed tag; `docs/OPERATIONS.md`, "Cutting a release".

[`docs/agents/gates.md`](docs/agents/gates.md) has the rest: why the
measurement tier is off the release gate, the Redis requirement, the Podman
networking stall, the split-brain long form, the pack numbers, the
`exactOptionalPropertyTypes` rules, the semver note on property signatures, and
where the bench page lives now.

## Status

On the 1.3.0 tree: `test:unit` **1219 across 34 files** (Redis pointed at an
unused port), `test:integration` **1267 across 43** (Redis on 6399),
`test:measure` **16 across 4** (not re-run since it was last touched), `npm test`
**1283 across 47**; typecheck and build clean. PUBLISHED to npm and measured on a
real Vercel deployment (`docs/VERIFICATION.md`), never yet under production
traffic. Long runs happen on the fw13 server. IF YOU ARE UPDATING STATUS, UPDATE
EVERY PLACE THAT STATES IT, here and in
[`docs/agents/status.md`](docs/agents/status.md), which has the full statement,
the loud-skip check, how the wall-clock cases were fixed, and the evidence the
design rests on. [`docs/agents/tiers.md`](docs/agents/tiers.md) is the tier of
every test file.

## Still owed

In full in [`docs/agents/status.md`](docs/agents/status.md#still-owed):

- A Safari read without the per-sample tab switch, and mobile.
- The relay swap's FAILURE path under a background-tab throttle.
- A test driving an example through the VERCEL adapter in process.
- `TARGET_DEPTH_TICKS` (2) is reasoned, not swept.
- The arrival band's last two readings: a quiet residential run, and a whole-process stall detector in the page.
