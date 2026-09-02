# tickroom: agent onboarding

Read this once instead of re-deriving the codebase. `docs/ARCHITECTURE.md` is the
reasoning behind every load-bearing decision and is short; read it too. `README.md`
is the user-facing pitch and quickstart. Keep THIS file current: whoever changes
the architecture updates the file map, the status, and the gotchas in the same
commit.

## What this is

A TypeScript library for running authoritative realtime multiplayer rooms on
serverless functions. Extracted from a shipped multiplayer browser game and
generalised so it works for 2D games, collaborative apps, multiplayer cursors,
or anything realtime where several clients need to agree on state changing many
times a second.

PUBLIC repo, MIT licensed, and PUBLISHED TO NPM as `tickroom` (0.1.1 at the time
of writing; `npm install tickroom ioredis`). It also still installs as a git
dependency, which is what `prepare` exists for (npm builds a git dep by running
it, and `dist/` is gitignored), so the hook stays whether or not anyone uses that
route. Releases go out from a version tag via `.github/workflows/release.yml`
using npm trusted publishing (OIDC), so there is no stored npm token to leak;
that workflow's header is the operating manual for cutting one.

## The architecture in one paragraph

Browser opens a wss socket to a RELAY function (one per socket, a dumb pipe with
no simulation in it). The relay decodes the client's input and publishes it on
`room:{id}:in`. A separate TICKER function holds a short-TTL Redis LEASE on that
room, runs the authoritative fixed-timestep simulation, and publishes binary
snapshots on `room:{id}:out` at the sim rate, which the relays forward to their
sockets. The ticker checkpoints the whole room to `room:{id}:state` every second
and spawns its own successor before the platform kills it at its duration cap, so
a handoff is a sub-second gap in the snapshot stream rather than a dropped
connection. Nobody disconnects during a handoff, because the relays are a separate
lifetime from the ticker. The client's interpolation delay plus extrapolation
covers at most 650ms of that gap, NOT all of it: see the corrected arithmetic in
`docs/ARCHITECTURE.md` section 1.

## Layers, and the rule that separates them

```
src/core/      pure. no IO, no clock, no platform. testable with zero setup,
               and importable in a browser: no file under core/ imports a
               node builtin, which `bundling.test.ts` bundles to prove.
src/server/    talks to Redis, and owns everything that needs a node builtin
               (checkpoint gzip lives here for that reason alone).
               platform-agnostic otherwise: imports nothing from next
               or @vercel/functions. these are plain functions a route calls.
src/client/    browser. WebSocket + performance.now() are the only globals it
               needs; sessionStorage/location access is guarded.
src/codec/     the wire. byte reader/writer, quantisation, a default codec.
src/adapters/  thin wiring per platform. takes the platform handle by
               INJECTION so the library never hard-depends on one host.
```

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

- `src/core/types.ts` - THE CONTRACT. `RoomRuntime`, `RoomEnvelope`, `ClientInput`,
  `CheckpointEnvelope`, `RoomStats`, `Logger`. Written first, deliberately, because
  everything else is built against it. Change it only with a very good reason.
- `src/core/redisLike.ts` - structural minimum Redis interface, so core never
  hard-imports ioredis. ioredis satisfies it with no adapter.
- `src/core/ids.ts` - room identity and Redis key naming. `roomKeys`,
  `roomIdFor`, `normalizeRoomId`, `normalizeBase`. A TRUST BOUNDARY: the raw
  value comes from a query param and is interpolated into key names, which
  have no escaping. TWO DOORS, ONE IMPLEMENTATION: `normalizeRoomId` takes a
  room id and falls back to a known-good one, `normalizeBase` takes a BASE (a
  pool of instances) and returns `null`, because the only caller that needs it
  already answers 400 and silently redirecting a hostile `?base=` would turn a
  refusal into a reassignment. `normalizeRoomId` delegates its whole base half
  to `normalizeBase`, so a rule added to one cannot go missing from the other.
- `src/core/lease.ts` - the exactly-one-writer mechanism plus the `OwnershipClock`
  two-clock rule. The single most safety-critical file. See the gotcha below.
- `src/core/checkpoint.ts` - the checkpoint ENVELOPE grammar, pure:
  `CHECKPOINT_VERSION`, `packCheckpoint`, `inspectCheckpoint`,
  `unpackCheckpoint`, `graceMsFromCheckpoint`. JSON and arithmetic only.
  `inspectCheckpoint` is the one to reach for anywhere the answer gets logged:
  it returns WHY it refused (`absent`, `unparseable`, `malformed`, `version`)
  and `unpackCheckpoint` is the thin wrapper that throws that away.
- `src/server/checkpoint.ts` - checkpoint STORAGE: gzip encode/decode with
  magic-byte sniffing and the Redis read/write pair, TTL riding the SET. Lives
  in this layer because it imports `node:zlib`; it used to be in `core/` and
  re-exported from the core barrel, which made the whole barrel unimportable in
  a browser. See the browser-safety gotcha.
- `src/core/playout.ts` - `PlayoutBuffer<T>`, the tick-stamped input buffer with
  never-drop-late re-stamping.
- `src/core/starvation.ts` - the starvation decay policy and `StarveTracker`.
- `src/core/backpressure.ts` - `Inbox<T>` with a per-sender quota (the fairness
  property, see the gotcha below).
- `src/core/rateLimit.ts` - `TokenBucket`.
- `src/core/metrics.ts` - `percentiles`, `RollingHistogram`, `Counters`.
- `src/server/redis.ts` - ioredis connection helpers. Shared publisher, per-socket
  subscriber (a connection in subscribe mode cannot run ordinary commands).
- `src/server/session.ts` - HMAC tokens with a hard expiry, plus room-bound spawn
  tokens gating the ticker endpoint.
- `src/server/ticker.ts` - THE CORE. `runTicker`. The whole authoritative loop.
- `src/server/relay.ts` - `attachRelay`, `checkAdmission`. One socket to the bus.
- `src/server/balancer.ts` - `assignRoom`. Packs joiners into the lowest-index
  room with space.
- `src/client/netPolicy.ts` - `stallDecision`, `shouldReanchor`. Pure, so the
  thresholds are pinned by tests rather than only described. They cannot be
  exercised through `RoomConnection`, which needs a live socket to reach these
  states, which is exactly why they live apart.
- `src/client/errorOffset.ts` - `ErrorOffset`. Render-layer correction smoothing.
- `src/client/clientTick.ts` - the monotonic client tick. Anchored once per
  epoch, advanced in whole steps by `RoomConnection.frame()`. No longer
  dilated: see the deleted buffer-health seam below.
- `src/client/interpolation.ts` - `SnapshotInterpolator`. Playback on the SERVER
  timeline (`serverTime` is the axis; `receivedAt` exists only to estimate the
  local-versus-server clock offset, as a slew-capped sliding-window minimum),
  jitter-adaptive delay sized from one-way delay above that offset floor,
  never-freeze extrapolation, outward bracket scan for an entity a snapshot
  omits, shortest-arc heading, measured speed. `push()` is a TRUST BOUNDARY,
  against both non-finite AND implausible timestamps. A playhead stranded for
  `REANCHOR_AFTER_MS` while at least `REANCHOR_MIN_SAMPLES` frames arrive
  re-anchors the offset outright, and so do `TIMELINE_STEP_FRAMES` frames
  whose implied one-way delay is impossible within a `TIMELINE_STEP_WINDOW`
  of judged frames. The SEED frame is
  provisional rather than exempt, because it defines the floor the others are
  judged against: a run of `TIMELINE_STEP_FRAMES` frames contradicting it
  discards it. Observability: `delayMs`, `underrunRate`, `rejectedFrames`,
  `reanchors`, and the last two are lifetime counters that `clear()` does NOT
  reset.
- `src/client/connection.ts` - `RoomConnection`. Reconnect, re-mint, clock sync,
  protocol-skew recovery, stall observation, AND the two epoch-scoped components
  it owns: the tick counter and (optionally) a `SnapshotInterpolator`. Generic in
  the host's snapshot type and the interpolator's key type, both inferred.
  `frame()` is the ONE per-frame call. Also exports `RosterFrame`/`isRosterFrame`,
  the typed shape of the `onText` roster control frame.
- `src/codec/bytes.ts` - `ByteWriter` / `ByteReader`. The reader is a TRUST
  BOUNDARY and bounds-checks every read.
- `src/codec/quantize.ts` - clamping (never wrapping) quantisation helpers,
  plus `representableRange(scale, field?)`, the startup-time check that turns
  the silent clamp into an assertion a host can fail on. `CM_SCALE` is
  exported so a host can name the default it is comparing against.
- `src/codec/snapshot.ts` - a batteries-included default codec plus the input
  redundancy window. `encodeDefaultSnapshot`/`decodeDefaultSnapshot` take an
  optional `DefaultSnapshotCodecOptions` carrying `positionScale`, which
  defaults to `CM_SCALE` so the existing wire is byte-identical. A pixel host
  passes 1 (+-32767 px at 1px); both ends must agree, and the bump that
  agreement implies belongs to the host. `encodeInputWindow`/`decodeInputWindow`
  take an optional `DefaultInputWindowOptions` carrying `axisScale`, defaulting
  to `AXIS_SCALE` (127) so the existing wire is byte-identical.
  `encodeDefaultSnapshot` THROWS `CodecError` on an entity id outside
  `0..65535`.
- `src/adapters/vercel.ts` - Next.js App Router route factories. Takes
  `upgradeWebSocket` by injection; imports nothing from next or @vercel/functions.
- `src/adapters/node.ts` - the same server core behind a plain `ws` server, no
  serverless at all. Proves the design is not platform-specific.

## Non-negotiable invariants

- `src/core/` stays pure: no Redis, no sockets, no platform imports, no clock
  reads, ever. It is what makes the whole thing testable and portable, and it is
  ENFORCED rather than asserted: `src/client/bundling.test.ts` bundles the core
  barrel and the root barrel for the browser on every run, so a `node:*` import
  reaching either one reddens locally instead of on whoever integrates next.
- `src/server/` imports nothing from `next` or `@vercel/functions`. A hard import
  would make the library refuse to install outside one platform, and this
  architecture is not actually platform-specific, it just happens to be where it
  was first shipped.
- NO AWAITS IN THE TICKER HOT LOOP except the sleep to the next grid point.
  Publishes, checkpoints and lease renews are fire-and-forget with `.catch`
  handlers. One `await` on a Redis round trip inside the loop and a slow network
  stretches every tick in the room.
- Only a CONFIRMED lease renew advances ownership. See the two-clock gotcha.
- ONE FUNCTION PER CLOCK IN `lease.ts`. `renewAttempted` moves `lastRenewAt`
  and nothing else, `renewConfirmed` moves `lastOwnedAt` and nothing else,
  `renewFailed` moves neither. Any function able to move both is a step back
  toward the single collapsed timestamp the module exists to prevent, which is
  why `renewConfirmed`'s `preserveAttemptTime` option was deleted rather than
  adopted. A caller that uses `renewDue` MUST call `renewAttempted`; the
  confirmation path deliberately cannot pace on its behalf.
- Every exit from the tick loop names itself. `exitReason` defaults to
  `'duration'`, so a `break` that does not set it reports a healthy
  lifetime-capped exit for whatever actually happened. See the gotcha below.
- A checkpoint carries a geometry digest and a mismatch starts fresh. See the
  geometry gotcha.
- A CHECKPOINT WHOSE VERSION THIS BUILD DOES NOT IMPLEMENT STARTS FRESH, in
  both directions, and the log line says so. Same rule and same reasoning as
  the geometry digest.
- Capacity is read from ONE key (`room:{id}:stats`) by both the relay and the
  balancer. See the capacity gotcha.
- A COUNTER COUNTS WHAT HAPPENED, NOT WHAT WAS ATTEMPTED. `publishes`,
  `bytesPublished` and `bytesDelivered` move inside the publish promise's
  `.then`, never beside it.
- AN EMPTY METRIC WINDOW IS `null`, NEVER ZEROS. For a latency distribution
  zero is the BEST value, so a flattened empty window reports the healthiest
  possible reading for the sickest possible state.
- A CAP THAT COULD NOT BE EVALUATED SAYS SO. `checkAdmission` still fails OPEN
  on a Redis fault, because failing closed locks users out of a healthy
  deployment; what it may not do is fail open invisibly.
- A wire change bumps the protocol version when it changes MEANING, not only when
  it changes SHAPE. Re-ordering an enum moves no byte and is still a bump.
- Anything whose rate a client controls is COUNTED in process and flushed on a
  cadence the client cannot drive, never written to Redis or logged per message on
  the request that triggered it. Otherwise the rate limiter is an amplifier.
- Interpolate remote entities on the SERVER's clock, never on the local arrival
  clock. Arrival times are the noise; `serverTime` is the signal. See the
  defect below for what timing playback against arrivals actually measured.
- Never freeze a remote entity on interpolation underrun. Extrapolate.
- `SnapshotInterpolator.push()` IS A TRUST BOUNDARY, exactly like `ByteReader`,
  and FINITE IS NOT THE SAME AS PLAUSIBLE. A frame whose `serverTime` or
  `receivedAt` is not finite is refused before it touches any accumulator, and
  so is one whose implied one-way delay (`receivedAt - serverTime`) sits more
  than `OFFSET_FLOOR_SLACK_MS` BELOW the sliding-window floor, which is what a
  future-stamped frame looks like. Both are counted on `rejectedFrames`. The
  types say `number`; the value crossed a host-owned decode boundary, and the
  stamp came from an authority whose clock is its own. See the defects below.
- THE FUTURE-STAMP REFUSAL MUST NOT BE PERMANENT. A server clock that genuinely
  steps forward trips the same test on every frame, so a refusal with no way out
  is a total stall. Past `TIMELINE_STEP_FRAMES` refusals WITHIN
  `TIMELINE_STEP_WINDOW` judged frames the run is treated as a timeline rather
  than a glitch and becomes the new anchor. The window ages the count out
  instead of one in-floor frame resetting it, which is what makes a one-off
  corrupt stamp and a sustained step distinguishable WITHOUT depending on
  arrival order. See the run-based-discriminator gotcha.
- The interpolator's clock offset is eased, EXCEPT when the playhead has been
  stranded off the buffer for `REANCHOR_AFTER_MS` (600) with at least
  `REANCHOR_MIN_SAMPLES` (5) frames arrived since, which re-anchors it
  outright. "Frames still arriving" is the whole safety of that mechanism, not
  a detail: an outage strands the playhead the same way and there is nothing to
  re-anchor TO, so extrapolate-then-hold is correct there. The COUNT is
  load-bearing too: the re-anchor adopts the minimum of the error window's
  samples with no slew, so one straggler defines the anchor by itself. Never
  drop or weaken that gate.
- Nothing in the interpolator may evict a frame the playhead is still
  bracketing against, and while an error window is open the time-based prune is
  SUSPENDED, because its horizon is derived from a playhead the class has
  already stopped believing. BOTH HALVES ARE NOW PINNED, having previously been
  asserted here and pinned by nothing: see the mutation matrix below for the
  measurements that justified keeping them.
- A reconnect must `clear()` the interpolator, AND THE CONNECTION NOW DOES IT.
  `RoomConnection.beginEpoch()` calls `markUnanchored()` and
  `interpolate?.into.clear()` together, because they were always the same fact:
  the epoch changed. Without the clear the first frame of the new epoch brackets
  against a seconds-stale one at `frac ~= 1`, a snap per reconnect, plus the old
  path's clock offset. A host driving an interpolator by hand (no `interpolate`
  option) still owns the call. THE LESSON IS THE ONE THIS REPO KEEPS RELEARNING:
  the fix for "every consumer must hand-write these two lines correctly" is to
  write the two lines once, not to write fifteen lines of README about them.
- `RoomConnection.frame()` IS THE ONLY PER-FRAME CALL, and that is a safety
  property rather than ergonomics. It used to be three (`pollStall`,
  `tick.advance`, `interp.sample`) and the middle one appeared in no README, no
  architecture doc and not in the shipped pong client. See the defect below for
  what omitting it measured. `ClientTick.advance` is still public on the CLASS
  but `conn.tick` is typed `ClientTickView`, which does not name it, so a host
  can neither forget it nor drive it twice.
- `RoomConnectionOptions.tickHz` IS REQUIRED. It defaulted to 20, and a default
  on a number the host always knows is a silent 2x error waiting for the first
  10Hz room: it drives the tick counter's step, `estimateServerTick`'s slope and
  the underrun threshold in `stats()` at once.
- `SnapshotInterpolator<K>` HAS NO DEFAULT KEY TYPE, deliberately. Pids are
  strings everywhere the simulation contract touches; `CodecEntity.id` is a
  number. There is no default that is right for both, so a default is only ever
  silently wrong for one of them.
- `CodecEntity.id` IS REFUSED OUT OF RANGE, not clamped and not wrapped, and it
  is the one field in the default codec that does not go through the quantiser.
  Clamping is right for a coordinate and wrong for an identity: 65535 is no more
  an approximation of 70000 than 4464 is. There is no nearby value for an id.
- Prose style: no em dashes, no en dashes. Never mention AI or an assistant in
  code, comments, commits, or docs. Plain descriptive commit messages.

## Gotchas that cost real production time

THE LEASE NEEDS TWO CLOCKS AND THIS REGRESSED TWICE. `lastRenewAt` paces how
often a renew is ATTEMPTED; `lastOwnedAt` records the last CONFIRMED ownership.
Collapse them and a ticker whose renews are all failing keeps refreshing its own
guard, so the pre-publish guard can never fire in the one condition it exists for.
The lease expires, a successor legitimately takes it, and the original keeps
publishing: two divergent simulations interleaving on one channel at 20Hz, both
clobbering the same checkpoint. `renewFailed` returning the clock UNCHANGED is the
fix and it looks like a no-op function, which is exactly why somebody keeps
deleting it.

A SLOW RENEW REPLY USED TO OPEN A HOLE IN THE RENEW SCHEDULE, AND THE HOLE
LOSES THE LEASE. `renewConfirmed` re-anchored `lastRenewAt` (the PACING clock)
onto the confirmation time, so `renewDue` waited `leaseRenewMs` from the reply
rather than from the attempt. Ordinarily that is only a renew period of
`leaseRenewMs + RTT`, which quietly halves the margin `leaseRenewMs` exists to
buy. Once RTT exceeds `leaseRenewMs` the attempts overlap, several in-flight
renews resolve back to back, each one drags the pacing clock forward again, and
the next attempt is due `leaseRenewMs` after the LAST of them: nothing reaches
Redis for up to `RTT + leaseRenewMs`. Traced and pinned at RTT 4000 / renew
1500 / TTL 5000: attempts leave at 1500, 3000 and 4500 and then not again until
10000, the key lapses at 11500, a successor legitimately acquires it, and
`lastOwnedAt` (8500) keeps `mayPublish` true until 13500. Two seconds of exactly
the split brain the two-clock rule exists to prevent, reached without either
clock ever being collapsed. Fixed by making `renewConfirmed` move only
`lastOwnedAt`. OVERLAPPING RENEWS ARE THE ACCEPTED PRICE AND ARE NOT NEW: they
already happened whenever RTT exceeded `leaseRenewMs`, the bound is the same
`ceil(RTT / leaseRenewMs)` either way, and they are safe because `renewLease`
is an owner-checked compare-and-extend, `lastOwnedAt` is non-decreasing across
resolutions, and a `false` reply is a fact about the key that no later reply
can take back.

A HALF-BUILT SEAM IS WORSE THAN NO SEAM, AND `preserveAttemptTime` WAS ONE.
The option existed, was documented at length, was tested, named `ticker.ts` as
the caller that needed it, and `ticker.ts` never called it. Everything passed:
the fix was present in the tree and absent from every code path that runs. The
resolution was NOT to pass the flag, because an option whose only correct value
is `true` leaves the next reader re-deriving why, on the most safety-critical
module in the library. It was to delete the option and make the behaviour
unconditional, which also makes the two-clock rule structural. THE LESSON IS
THE PAIRED-SEAM ONE AGAIN, in its sharpest form: when a change adds an option,
a helper or a hook, the counterpart is the CALL SITE, and a helper with no
caller is not a landed fix, it is a comment that compiles.

ZERO IS NOT A NEUTRAL PLACEHOLDER FOR A LATENCY GAUGE. `percentiles([])`
returned `{ p50: 0, p95: 0, max: 0 }`, on the reasoning that a gauge reading 0
is sortable where a `NaN` is not. That reasoning is exactly backwards here:
zero is the BEST possible value, so "no samples at all" and "every sample
instantaneous" produced identical numbers. Paired with publish counters that
counted ATTEMPTS, a room whose every publish was rejected reported 20
publishes a second, bytes climbing at the healthy rate, and the best
`publishAwait` in the fleet. It now returns `null`, `RoomStats.cadence`,
`publishAwait` and `serverInternal` are `Percentiles | null`, and the counters
moved inside the publish promise. The reusable shape: WHEN A GAUGE'S EMPTY
VALUE IS ALSO ITS HEALTHIEST VALUE, THE EMPTY CASE HAS TO BE A DIFFERENT TYPE,
not a different number.

EVERY `break` OUT OF THE TICK LOOP MUST SET ITS OWN `exitReason`, BECAUSE THE
INITIALISER IS A PLAUSIBLE ANSWER. `exitReason` starts as `'duration'`, the one
exit that means everything is fine, so a break that forgets to set it does not
produce an obviously wrong value, it produces a reassuring one. A lost lease has
TWO finders inside `runTicker` (the async renew's `lostLeaseExplicitly`, and the
synchronous pre-publish `mayPublish` guard) and which one gets there first is a
scheduling race: the synchronous one wins exactly when the loop stalled past the
TTL, which is the condition it exists for. That path shipped with no
`exitReason` assignment, so the SAME event reported `'lease-lost'` on an idle
machine and `'duration'` on a loaded one. See the dated defect below.

A CHECKPOINT WITHOUT A GEOMETRY DIGEST SIMULATES A DELETED WORLD FOREVER. The
state is opaque, so a deploy that moves a wall leaves every live room restoring
its predecessor's bytes, simulating the old world, and re-saving it, with the TTL
refreshed every second so it never expires. Silent, permanent, invisible in every
metric. Also note a hand-rolled digest only covers the fields somebody remembered
to mix in: add a field to your world definition, add it to the digest.

CAPACITY MUST COME FROM THE STATS KEY, NOT THE META HASH. Stats has a 5s TTL so a
room with no ticker reads as empty; meta persists. If the relay read meta and the
balancer read stats, a hard-dead ticker leaves meta phantom-full forever, the
balancer keeps handing out a room the relay keeps rejecting, and the client's
bounded re-assign loop strands every joiner on "full" with no path to self-heal.

THE PER-SENDER INBOX QUOTA IS A FAIRNESS PROPERTY, NOT A MEMORY BOUND. The global
cap alone is a shared resource one sender can monopolise: a single flooder fills
the queue and EVERYONE ELSE's inputs are shed at the door, degrading the room for
all twenty instead of just the abuser. `20 * perSenderCap` must stay well under
the global cap so the per-sender bound binds first in the single-abuser case.

THE SUCCESSOR SPAWN IS AWAITED BUT RACED, AND LIVES IN `finally`. Fire-and-forget
was measurably wrong (as the last thing the handler does it is post-response IO
the platform can suspend before flushing, and it intermittently never left,
blowing the handoff budget about 10% of the time). It must NOT use
`AbortSignal.timeout`: aborting could propagate as a cancellation and tear down
the very ticker just started. Race a plain timer and leave the request alive.

TWO FIRST JOIN PUBLISHES, AND BOTH ARE LOAD-BEARING. The immediate one keeps a
reconnecting player from being frozen server-side (inputs accepted, entity not
moving, client predicting forward the whole time). The one gated on the subscribe
ack keeps a socket from missing its own one-shot roster announcement, since
pub/sub drops a message with no subscriber. Neither covers the other.

DETACH BEFORE CLOSE ON THE CLIENT. `connect()` must null `this.ws` and close the
previous socket before constructing the replacement, and every listener body must
return early when `this.ws` no longer names its own socket. An orphaned socket
keeps decoding messages into this client's state from a room it is no longer
joining, runs its own reconnect ladder in parallel, and holds a slot against the
per-user socket cap.

A NODE BUILTIN REACHABLE FROM `core/` BREAKS EVERY DOWNSTREAM BROWSER BUILD,
AND NOTHING IN A NORMAL GATE SEES IT. `tsc --noEmit`, `vitest` and `npm run
build` all run in Node, where `node:zlib` resolves fine; the failure appears only
when a consumer bundles for the browser, where it is a HARD ERROR (`Could not
resolve "node:zlib"`, exit non-zero) rather than a warning or wasted bytes. Tree
shaking does not save you either: the old `core/checkpoint.ts` ran
`promisify(gzipCb)` at module scope, so it was never side-effect-free, and the
import is evaluated long before a bundler decides an export is unused. The fix
was to MOVE the offending module to `src/server/`, not merely to drop it from the
barrel: with nothing Node-only left under `core/` the rule is a property of the
directory, so the only way back in is a `../server/...` import inside `core/`,
which is an obvious layering violation rather than a plausible barrel tidy-up.

A `-1` MEANING "NOTHING YET" IS NOT A POSITION TO MEASURE A DISTANCE FROM.
`PlayoutBuffer` bounded a push by its distance from `lastConsumedTick`, whose
starting value of -1 means "nothing has been asked for yet" and NOT "the
consumer is at tick -1". So a buffer created fresh in a room that had been up
for more than `maxAhead` ticks (2s) refused EVERY push until some later consume
happened to anchor the floor. Measured by an integrating game: at room tick 100
and at room tick 50000 the first push into a new buffer was dropped, at tick 0
and tick 30 it was kept. That cost them exactly one starved tick per buffer
creation (in their case, the tick a player boarded a vehicle) and was the sole
source of every divergence their differential harness found. IT WAS ONLY THAT
CHEAP BECAUSE THEIR CLIENT SENDS A REDUNDANCY WINDOW: a later copy of the same
record anchored the floor. A host that sends each stamped input once loses the
FIRST INPUT OF EVERY BUFFER outright, which makes the redundancy window a
requirement rather than the optimisation this library documents it as. Fixed by
giving the bound its own reference (`aheadBase`): the first push establishes it,
the first consume replaces it with the consumer's real position. NOT by moving
`lastConsumedTick` itself, which is the tempting one-line version and is worse
than the bug: a stamp is a producer's claim and that field is the consumer's
position, so anchoring the FLOOR makes every slightly-older re-send in the same
burst "late", and never-drop-late then re-stamps them onto one slot and dedupes
all but one away. Measured: that alternative reddens three cases including the
pre-existing `accepts out-of-order pushes and consumes them in tick order`.

`readCheckpoint` MUST USE `getBuffer`, NEVER `get`. A utf8 decode of gzip bytes is
lossy and destroys the payload before anything can sniff it.

A BARE `raw in WORLDS` MATCHES INHERITED PROPERTIES. `constructor`, `__proto__`
and `toString` all pass. Use `Object.prototype.hasOwnProperty.call`. This is a
real trust boundary because the value is interpolated into a Redis key name.

CLAMP QUANTISED VALUES, NEVER WRAP. An out-of-range value that wraps teleports an
entity to the opposite side of the world (reads as a catastrophic desync); the
same value clamped pins it at a boundary (reads as an entity against a wall).

AND A CLAMP AGAINST A RANGE THE HOST NEVER CHOSE IS THE OTHER HALF OF THAT
STORY. Clamping is right; clamping SILENTLY at a boundary the host did not pick
is the trap. `encodeDefaultSnapshot` hardcoded `quantizeCm`, so the default
codec spanned +-327.67 METRES, and this library advertises 2D games, cursor
layers and map overlays, which routinely count in PIXELS. A pixel host got every
entity past 327 piled against an invisible wall, with no error, no warning and
nothing in a metric: it reads as a snapping or teleporting bug in the CLIENT,
which is an expensive place to go looking. Fixed additively with
`positionScale` on both halves of the default codec (defaulting to `CM_SCALE`,
so the default wire is byte-identical and no version bump is owed) and with
`representableRange`, which a host asserts its world bounds against ONCE at
startup. NOT with a per-value hook on the encode path: that runs per entity per
tick per player, and everything on that path is a bandwidth and CPU budget, not
a convenience. The byte-identical default is pinned against a LITERAL byte array
in `snapshot.test.ts` rather than against a re-encode, because a re-encode
comparison agrees with itself whatever the default is and cannot fail on the one
change it exists to catch; mutation-checked by moving the default scale to 1000
and confirming that test reddens.

A CONSECUTIVE COUNT IS NOT INVARIANT TO ARRIVAL ORDER, AND `push()` DOCUMENTS
OUT-OF-ORDER ARRIVALS AS ORDINARY. This is now the third time the same shape has
bitten the interpolator (the dead-epoch cut keying on the LAST arrival rather
than the newest; the seed frame defining the statistic it was judged against;
and this). The floor-refusal escape hatch counted CONSECUTIVE refusals and was
reset by any in-floor frame, which cannot survive the one event that most needs
it: a latency DROP larger than `OFFSET_FLOOR_SLACK_MS` reorders the stream by
construction, so old and new frames interleave one for one and every old one
cleared the count. Now windowed over `TIMELINE_STEP_WINDOW` (12) judged frames.
BEFORE WRITING A RUN-BASED DISCRIMINATOR IN THIS MODULE, ASK WHAT REORDERS THE
STREAM, because something always does.

## Gates

From the repo root:

```
npx tsc --noEmit     # typecheck, must be clean
npx vitest run       # all tests; the tests/ files skip with no Redis reachable
npm run build        # tsc -p tsconfig.build.json, emits dist/
npm run test:integration   # tests/ only, needs a real Redis (see below)
```

`.github/workflows/ci.yml` runs the first three on every push and PR to main, and
the fourth in a second job against a Redis service container. Note `npm install`
now runs `prepare`, hence `build`, so a broken build fails at install time.

Most tests are unit tests against a fake in-memory Redis written inline in the
test files, so the default run works offline with no services; `tests/` is the
real-Redis suite and skips cleanly when there is none.

## Status

MEASURED ON THIS TREE, not estimated: `npx vitest run` is 593 tests across 33
files, all green (with a local Redis up, so the six integration files run rather
than skip; without one it is 556 passed and 37 skipped, still exit 0);
`npx tsc --noEmit` is clean repo-wide including `examples/`; `npm run build`
emits `dist/` cleanly. Roughly 9,000 lines of source and 9,800 of tests. Per
layer: core 200, server 134, client 90, codec 80, adapters 11, examples 41,
`tests/` 37.

- Extracted and implemented: core, server, client, codec, adapters, plus three
  examples (a 2D game, a presence layer, a plain Node host).
- PUBLISHED to npm (`tickroom`, 0.1.0 and 0.1.1). NOT deployed anywhere, and
  never run against production traffic, so every claim here is unit-level and
  integration-level plus whatever the source architecture already proved in
  production. This bullet used to say "NOT published to npm... NOT run against a
  real Redis or a real WebSocket", which contradicted both the release workflow
  and the real-Redis section further down THIS FILE; if you are updating status,
  update every place that states it.
- Every test runs offline against a fake in-memory Redis
  (`src/server/testFakeRedis.ts`, a Map plus a pub/sub hub with `.fork()` for a
  second connection and `.break(method)` to force failures). That fake was built
  specifically to reproduce the production incidents this design exists to
  prevent (lease theft, the subscribe race, liveness and pong, backpressure
  fairness) deterministically and without a service.
- The upstream game this was extracted from is the production evidence for the
  design: the lease, the checkpoint handoff, the playout timeline, the stall
  thresholds and the interpolation rules were all measured there under real load.
  Where a number in a comment is quoted as "measured", that is where it came from.

### Verified by mutation, not just observed green

The two-clock rule was checked by reintroducing the historical bug (making
`renewFailed` advance `lastOwnedAt`) and confirming `lease.test.ts` fails FOUR
cases, then restoring: `renewFailed leaves the clock completely unchanged`,
`THE REGRESSION CASE: a string of failed renews must make mayPublish go false
within the TTL...`, `THE CONTRAST: the same failing renews against a COLLAPSED
clock keep mayPublish true`, and `the two-clock rule survives the change:
renewFailed still returns the clock unchanged`. This said "two" until
2026-09-02 and then "three"; it is four now that TR-10b's own case was
rewritten. A mutation matrix is a statement about the tree it was measured on,
and the COUNT rots even when the behaviour does not. If you change anything in
`lease.ts`, do this again. A green test that cannot fail is worse than no test,
and this is the one invariant in the library whose failure mode is silent and
catastrophic.

WHOLE-TREE, THAT SAME MUTATION REDDENS A FIFTH CASE, in another file, and it is
worth knowing before you read a partial run as a clean one:
`ticker.test.ts`'s `reports lease-lost when the SYNCHRONOUS guard is the only
finder` also fails, because a `lastOwnedAt` refreshed by failures is exactly
what stops the pre-publish guard from ever firing. Re-measured on this tree at
5 failed / 588 passed across the full suite.

The interpolator's shortest-arc heading was checked the same way: replacing
`lerpHeading`'s body with `a + (b - a) * t` reddens
`heading interpolates the shortest arc across the +-pi wrap` (rendered 0 against
a bound of 2.5) and nothing else. It did NOT redden before that test was
rewritten to bracket a real midpoint, which is how the test was found to be
vacuous in the first place.

The re-anchor's still-arriving GATE was checked by deleting the one line that
enforces it (`if (this.pushesSinceErrorStart < REANCHOR_MIN_SAMPLES) return
false;`), which reddens four cases: the latency-step test,
`does NOT re-anchor when the stream simply stops`,
`ONE straggler is not enough evidence to re-anchor on`, and the out-of-order
cut test. Do this again if you touch `trackPlayheadError`, because without the
gate the mechanism fires on an ordinary outage, where there is nothing to anchor
to and it can only make things worse.

The ticker's two lease-lost exits were checked the same way, and the third
mutation is the interesting one. Deleting `exitReason = 'lease-lost'` from the
SYNCHRONOUS guard (section 7) reddens only
`reports lease-lost when the SYNCHRONOUS guard is the only finder`; changing the
ASYNC path's assignment (section 12) to `'duration'` reddens only
`reports lease-lost when the ASYNC renew is the finder`. That sibling was added
on 2026-09-02 and this line used to name `stops publishing once the lease is
stolen mid-run`: strengthening that case (it asserted nothing about publishing,
see below) meant pacing it onto the SYNCHRONOUS finder, which left section 12
with no test at all until the sibling was written. STRENGTHENING A TEST CAN
ORPHAN A MUTATION: when you make a case select a specific detector, check what
the OTHER detector lost. Deleting
`lostLeaseExplicitly = true` outright leaves all 35 green, because the
synchronous guard now catches the same loss and reports the same reason, which
is the defence in depth the fix creates rather than a hole. Doing BOTH (the
pre-fix code with only the synchronous finder left) reproduces the original
flake exactly, deterministically, on both cases:
`expected 'duration' to be 'lease-lost'`.

EVERY GUARD IN `interpolation.ts` NOW HAS A MUTATION THAT REDDENS IT, and the
matrix below is the record. Re-run it after any change to that file; a green
suite over a guard that cannot fail is the exact trap this module has fallen
into twice.

| mutation | reddens |
| --- | --- |
| finiteness guard off (serverTime, or receivedAt) | nothing ALONE, see note |
| `nowMs` finiteness guard deleted | `a NaN nowMs cannot smuggle a re-anchor past the REANCHOR_AFTER_MS wait` |
| still-arriving gate deleted | 4 cases |
| single-sample gate restored (`=== 0`) | `ONE straggler is not enough evidence to re-anchor on` |
| re-anchor removed entirely | 6 cases |
| naive front-splice in `pruneFrames` | `the count cap never evicts the frame the playhead is bracketing against` |
| dead-epoch cut deleted | 3 cases |
| time-prune suspension removed | 2 cases |
| re-anchor uses the whole offset window | 5 cases |
| delay snap on re-anchor removed | `the re-anchor snaps the delay to its target` |
| post-re-anchor playhead recompute removed | 2 cases |
| future-stamp refusal not applied | `ONE frame stamped in the FUTURE ...` + the forward-step test |
| future-stamp refusal made PERMANENT | `a large FORWARD serverTime step is adopted ... instead of stalling forever` |
| dead-epoch cut keyed on the LAST arrival | `an out-of-order arrival on the re-anchor own render frame ...` |
| seed refutation removed (first frame exempt again) | `the FIRST frame of a connection is PROVISIONAL ...` |
| `dt` finiteness guard deleted | `a non-finite receivedAt is refused too ...` (via `underrunRate` going permanently NaN) |
| retention floor `frames.length - 2` widened | `the time prune always leaves two frames ...` |
| `bracketIndex` `<=` narrowed to `<` | `a playhead exactly on the newest frame is an UNDERRUN ...` |
| `observeInterval`'s `delta > 0` widened to `!== 0` | `a reordered arrival contributes no emission interval ...` |
| `posePartial`'s future-only arm deleted | `an entity that has JUST APPEARED renders at its one known pose ...` |
| `lerpHeading`'s OUTER `wrapAngle` dropped | `heading interpolates the shortest arc across the +-pi wrap` (at frac 0.75; frac 0.5 cannot see it) |
| speed low-pass replaced by the instantaneous value | `measures a low-passed speed from its own rendered motion` |
| `clear()` made to reset `rejectedFrameCount`/`reanchorCount` | `clear() resets the GAUGES but deliberately not the lifetime COUNTERS` |
| refusal count made CONSECUTIVE again | `the floor-refusal escape hatch counts over a WINDOW ...` (23 refused against a bound of 3) |

THE CONNECTION'S THREE NEW SEAMS EACH HAVE A MUTATION. Disabling the
interpolator push in `processSnapshot` reddens three cases in
`connection.test.ts`; stamping `serverTime` from the local clock instead of the
decoded one reddens `pushes each snapshot itself ...` with
`expected 253.038833 to be greater than 1600000000000` (the two clock domains
are ~1.7e12 apart, which is what makes that assertion unfakeable); deleting the
`interpolate?.into.clear()` from `beginEpoch` reddens `clears the interpolator
on a reconnect ...`; and deleting `this.clock.advance(dt)` from `frame()`
reddens both tick cases at `expected +0 to be 20` and `expected +0 to be 10`.

For the codec: removing the entity-id range check reddens `throws CodecError on
an id past the u16 ceiling ...`; ignoring `axisScale` on both halves reddens
`axisScale moves the boundary ...` at `expected 1 to be 64`.

THE ONE CONSTRUCT WITH NO MUTATION, AND IT IS NOT A HOLE: the `frac` clamp to
[0,1] in the interpolate branch (and the matching `t` clamp in `posePartial`) is
UNREACHABLE BY CONSTRUCTION, not merely untested. `push()` keeps `frames`
ascending by `serverTime` and `bracketIndex` returns the last frame at or before
the playhead, so `a.serverTime <= playServerTime < b.serverTime` always holds and
`frac` is in [0,1) before the clamp; `span === 0` is already handled by its own
guard. Verified by replacing both clamps with a throw on any raw value outside
[0,1] and running the whole file: nothing threw. Record it as dead defensive
code, not as a missing test.

THE NOTE ON THE FINITENESS GUARD, because a green cell there is a claim about
coverage that would otherwise be read as a vacuous test. The finiteness guard
and the future-stamp refusal are INDEPENDENT and each one on its own also
refuses a non-finite frame (`NaN >= floor - slack` is false, so a NaN offset
takes the refusal path). Deleting either alone therefore leaves the two
non-finite tests green because the behaviour is genuinely preserved; deleting
BOTH reddens them. Measured both ways. That is defence in depth, not a hole,
but it does mean the finiteness guard has no mutation of its own and the
ordering in `push()` is load bearing: the finiteness guard runs first, so
`refuseSteppedFrame` can never put a NaN in `steppedOffsets`.

THE SERVER, CORE AND ADAPTER CHANGES OF 2026-09-02 EACH HAVE ONE TOO, same
rule, same reason to re-run it after touching any of those files.

| mutation | reddens |
| --- | --- |
| `renewConfirmed` re-anchors `lastRenewAt` to `now` again | 3 in `lease.test.ts`, including the traced split brain (`expected 5500 to be 1500`) |
| `renewFailed` advances `lastOwnedAt` | 4 in `lease.test.ts` (see above) |
| `percentiles([])` back to `{p50:0,p95:0,max:0}` | 2 in `metrics.test.ts`, 2 in `ticker.test.ts` |
| publish counters moved back outside the promise | 2 in `ticker.test.ts` |
| `publishFails++` deleted | 2 in `ticker.test.ts` |
| checkpoint version check deleted | 5 in `core/checkpoint.test.ts`, 2 in `ticker.test.ts` |
| version check narrowed to `> CHECKPOINT_VERSION` (the tempting one-sided shape) | 1 in `core/checkpoint.test.ts`, 1 in `ticker.test.ts` |
| `ticker.checkpoint-refused` log line deleted | 2 in `ticker.test.ts` |
| `normalizeBase` drops `FORBIDDEN_CHARS` | 8 in `ids.test.ts` |
| `normalizeBase` drops the `~` refusal | 1 in `ids.test.ts` |
| `normalizeBase` drops `DANGEROUS_BASE_NAMES` | 5 in `ids.test.ts`, including `normalizeRoomId`'s own bare-`in` case, which is what proves the delegation is real |
| balancer route back to a bare `isValidBase(base)` | 9 in `adapters/vercel.test.ts` |
| `socketCapEvaluated` hardcoded `true` | 3 in `relay.test.ts` |
| per-command errors discarded again (`typeof socketCount === 'number'` alone) | 1 in `relay.test.ts`, the broken-prune case |

THE LAST ROW IS THE INTERESTING ONE AND IT IS NOT A HOLE. A `ZCARD` that
errored comes back as `[error, null]` on the fake and `[error, undefined]` on
ioredis, and neither is a number, so the old `typeof` check already caught that
one shape. What it could not catch is the PRUNE failing: the count is then a
real number computed over stale members, high enough to refuse a legitimate
reconnect. Reading the errors is what makes the distinction, and the broken-
prune case is the only mutation that observes it. The other three cases in that
group are pinned by the `socketCapEvaluated` row above them.

### Defects found and fixed during integration, worth not reintroducing

- `PlayoutBuffer.consume` assigned the floor unconditionally, so it could move
  BACKWARDS, which un-does never-drop-late and lets an already-consumed input
  apply twice. Guarded, and pinned by a test.
- `SnapshotInterpolator` used `x`/`z` for a 2D position, a leak from the 3D
  source. Renamed to `x`/`y`. `ErrorOffset` deliberately keeps `x`/`z` because it
  is shared with 3D consumers on a ground plane; that asymmetry is intentional,
  do not "make them consistent".
- `src/server/` had private copies of `Inbox`, `TokenBucket` and percentile math
  while `src/core/` had canonical versions. Deleted, now imported. Two
  implementations of the per-sender inbox quota would have drifted, and that
  quota is a fairness property whose failure mode is one flooder shedding
  everyone else's inputs.
- The adapters were written against guessed server shapes and cast through `as`
  at every call site, so they typechecked and would have failed at runtime.
  Rewritten against the real API. Notably `runNodeTicker` switched on
  `result.playersRemain`, a field that does not exist, so the restart decision
  was reading `undefined` every time.
- Both the Vercel adapter and the node example called `checkAdmission` without
  ever registering the connection. `checkAdmission` is a QUERY that deliberately
  writes nothing (so a refused connection never needs un-registering), which
  means registration is the caller's job, and skipping it fails SILENTLY: the cap
  keeps passing because the set it counts is always empty.

### Defects found by a real app built against this library (2026-08-30)

- `SnapshotInterpolator.sample(dt)` defaulted to a self-accumulated clock
  starting at zero when `nowMs` was omitted, a SEPARATE clock domain from the
  absolute `performance.now()` timestamps every real `push()` call stamps
  `receivedAt` with. A `dt`-accumulated clock can never advance faster than
  wall time, so any single frame slower than the buffer's delay (a GC pause, a
  backgrounded tab regaining focus) permanently widened the gap; once it
  exceeded `bufferCap` worth of history, playback pinned to `frames[0]`
  forever, several seconds of stale state with every other signal (socket,
  snapshot rate, `underrunRate`) reading healthy. `examples/pong/client.ts`
  shipped exactly this by calling `interp.sample(dt)` with no second argument,
  and every existing unit test happened to always pass `nowMs` explicitly, so
  a fully green suite never caught it. Fixed by making the OMITTED case read
  the real wall clock (`performance.now()`, falling back to `Date.now()`)
  instead of accumulating its own: omission is now correct by default rather
  than catastrophic. Pinned in `interpolation.test.ts`
  ("omitting nowMs reads the real wall clock..."), mutation-checked by
  reintroducing the old accumulator and confirming the test fails on exactly
  `x === 0` (frozen at the first frame ever pushed).
- `VercelRelayRouteOptions.upgradeWebSocket` was typed as a SYNCHRONOUS
  `(cb: (ws: any) => void) => Response`, while the real
  `@vercel/functions` export is `(handler, options?) => Promise<Response>`.
  `Promise<Response>` is not assignable to `Response`, so the README's own
  quickstart (`upgradeWebSocket: experimental_upgradeWebSocket`) failed to
  typecheck for anyone who copied it. Fixed by widening the declared type to
  match the real shape (handler returning `void | Promise<void>`, an optional
  options bag, `Promise<Response>` return), still with no hard dependency on
  `@vercel/functions` or `ws`.
- `examples/cursors/sim.ts`'s name sanitiser embedded LITERAL control bytes
  (raw NUL, 0x1f, 0x7f, U+009F) inside a regex character class instead of
  escape sequences, which reads as binary to `grep`/`diff`/most editors: a
  byte that invisible cannot be reviewed. Rewritten as
  `[\x00-\x1f\x7f-\x9f]`, byte-identical matching behaviour, same tests
  green unchanged.
- `examples/pong/codec.ts`'s `decodePongSnapshot` read `paddles[winnerIndex]`
  after a bounds check that a type checker cannot correlate with the index
  expression, so it fails to compile under `noUncheckedIndexedAccess` (which
  this library's own `tsconfig.json` does not enable, but a consumer's often
  does). Fixed by reading the indexed access into a variable and checking
  IT for `undefined` rather than asserting the earlier bounds check already
  proved it defined.
- The README's relay-route quickstart omitted `tickerUrl`, a required field
  of `VercelRelayRouteOptions`, so a copy-paste did not compile. Also fixed
  two further quickstart defects found by actually typechecking it end to
  end in a scratch file: `SnapshotInterpolator()` with no type argument
  defaults to a NUMBER key while every pid in the library is a `string`, and
  `onSnapshot`'s `snap.players` is `unknown` (from `DecodedSnapshotLike`'s
  index signature) until cast to a caller-defined shape, exactly like
  `examples/pong/client.ts`'s own `PongSnapshot` already does. Verified by
  writing the ENTIRE quickstart (all three steps) into a scratch `.ts` file
  inside `src/` (so it resolves through the real tsconfig) and confirming
  zero errors, then deleting the scratch file.
  BOTH OF THOSE TWO ARE NOW STRUCTURAL RATHER THAN DOCUMENTED, which is the
  better fix and is why the quickstart no longer casts anything.
  `SnapshotInterpolator<K>` lost its default key type outright, so the wrong
  one cannot be picked silently, and `RoomConnection` is generic in `TSnap`
  with `decodeSnapshot`'s return type fixing it, so `onSnapshot` and
  `interpolate.entities` both receive the host's own shape and neither
  `unknown` nor a cast survives.

`noUncheckedIndexedAccess` VERDICT: measured at 28 errors across 6 files
(`examples/node-server/server.ts` 1, `src/codec/snapshot.test.ts` 21,
`src/server/checkpoint.test.ts` 1 (measured while that case still lived in
`src/core/checkpoint.test.ts`), `src/server/balancer.ts` 1,
`tests/pubsub.redis.test.ts` 1, `tests/ticker.redis.test.ts` 3) when turned on
repo-wide. That touches production source (`balancer.ts`,
`node-server/server.ts`), not only test scaffolding, so it is real churn
rather than a quick pass. Left OFF in `tsconfig.json` per this finding; only
the one example file consumers actually copy (`examples/pong/codec.ts`) was
fixed to compile under it.

### Defects found by a real game integrating this library (2026-08-31)

- TR-4 WAS RECORDED AS LANDED WITH ONLY ITS RELAY HALF BUILT. `RelayOptions.
  metaSeedPayload` shipped and shapes the roster frame a joining socket is
  SEEDED with; the ticker still hardcoded the roster BROADCAST as
  `{ t: 'meta', map }` and `TickerOptions` had no formatter at all. Adopting
  the ticker as-is would have silently killed every name tag, the presence
  count, the join and leave notifications and one host's character-look
  channel, because their client does
  `if (m.t !== 'meta' || !Array.isArray(m.players)) return;` and a shape it
  does not recognise is an early return, not an error. They shipped around it
  by wrapping the Redis client in a Proxy to rewrite the payload in flight.
  `TickerOptions.metaPayload` now exists with `metaSeedPayload`'s semantics
  exactly (default shape unchanged, an `undefined` return suppresses the frame
  rather than publishing the string "undefined", a throw is reported and the
  frame is dropped). ONE DIFFERENCE THAT IS NOT COSMETIC: the ticker's
  formatter is called from the TICK LOOP, so its throw is caught rather than
  left to reject a promise. Unguarded, a throwing formatter unwinds the loop
  and takes the whole ROOM down, where the relay's equivalent only fails one
  socket's seed; that is mutation-checked (`result.reason` stops being
  `'duration'` the moment the call moves outside the try). It is also NOT
  retried: `metaDirty` is already cleared when the publish is attempted, so a
  deterministically broken formatter logs once per roster CHANGE instead of
  becoming a 20Hz log amplifier.
  THE LESSON IS ABOUT THE TRACKER, not the option. Half a paired seam passes
  every gate in this repo, because the pair only exists in the shape a client
  parses. When a change adds a formatter, a knob or a hook on one side of the
  relay/ticker split, ask what its counterpart on the other side is before
  ticking the item off.
- `PlayoutBuffer` refused every push into a freshly created buffer in any room
  past tick 40. Written up in full in the gotchas above, because the shape of
  it (a sentinel used as a coordinate) is the reusable part.

### Defects found by measuring the interpolator against a control (2026-09-01)

- `SnapshotInterpolator` TIMED PLAYBACK AGAINST THE LOCAL ARRIVAL CLOCK.
  `SnapshotFrame.serverTime` was on the type, documented as "not used for
  playback timing here", and read by nothing. Every bracket search,
  interpolation fraction and extrapolation velocity ran on `receivedAt`. The
  server emits on a uniform grid and the network smears the arrivals, so this
  replayed the smear AS MOTION: a burst of five snapshots delivered 3ms apart
  played a quarter of a second of world time in 3ms. Measured against a
  server-timeline control on identical frames, an entity moving at a constant
  100 u/s rendered a peak of 1568.83 u/s (control 261.04), a speed standard
  deviation of 144.23 (20.71), 18 frames above 300 u/s (0), 9 BACKWARD rewinds
  worst -14.37 units (0), and a max positional error of 24.72 units (6.29).
  After the fix, on the same profiles: peak 441.54, deviation 11.94, 1 frame
  above 300, ZERO rewinds, max error 5.89, and better than the control on every
  metric on the two calmer profiles. The one remaining spike is the very first
  burst of the run, before any burst has been observed, and it is a cold-start
  property of an adaptive buffer rather than of the playback axis: from the
  second burst on it is deviation 1.99, peak 100.39, max error 0.01.
  Three defects fell out of the same mistake and were fixed with it. The
  extrapolation velocity divided by the ARRIVAL gap between the last two
  frames, which inflates it by the burst factor (worth 6x on the worst-case
  jump). The delay estimator took a p95 of a 20-entry ring of arrival GAPS,
  which measured the wrong quantity, could never select the largest sample in
  its window (`ceil(20*0.95)-1` is 18, one short of the last index, so exactly
  one spike per second was always discarded), and moved BACKWARDS under load:
  87.95ms under ordinary jitter versus 80.45ms under bursts, because a burst
  floods a gap-based ring with near-zero gaps. It now measures each packet's
  one-way delay above a sliding-window minimum, which is what a jitter buffer
  covers, and a burst grows it. And an entity present in only ONE of the two
  bracketing frames rendered at that frame's exact pose, snapping by up to a
  full interval and unwinding next frame, so one transiently culled entity read
  as jitter; the bracket now scans outward for the nearest frames that do carry
  it.
  WHY NO TEST CAUGHT IT, WHICH IS THE REUSABLE PART. The test helper was four
  lines long and read `serverTime: receivedAt`. Every one of the twelve tests
  therefore ran a network with zero one-way delay and zero jitter, where the
  two clocks are identical by construction and arrival-clock and server-clock
  playback are INDISTINGUISHABLE. The single axis that decides whether remote
  motion is smooth was the single axis no test could vary. A green suite over a
  helper that collapses two independent inputs into one is not evidence about
  either of them. The helper now takes both separately, and the headline test
  was mutation-checked by putting the arrival axis back and confirming five
  cases redden (rendered speed 387.71 against a bound of 115, and 1551.35
  against 130 on the burst case).
  `clear()` also claimed to reset the adaptive delay to its starting value and
  did not (it re-clamped whatever the delay had drifted to; the start value was
  never stored), and the only assertion on it was `out.size === 0`, which
  cannot tell those apart. Fixed and pinned.

### Defects found by attacking the server-timeline rewrite (2026-09-01)

An adversarial pass over the rewrite above found six more. The two worth
carrying forward:

- ONE NON-FINITE FRAME POISONED THE INTERPOLATOR PERMANENTLY, and it was a
  REGRESSION the rewrite introduced: the same input recovered fine on the
  arrival-axis version. `receivedAt - serverTime` with a non-finite operand put
  NaN in the offset window, which reached the jitter quantile and then
  `currentDelayMs`, where `x += (NaN - x) * ease` can never leave NaN again,
  not even after the bad sample slid out of the 128-entry window. The playhead
  was NaN, every bracket comparison was false, and playback pinned to
  `frames[0]` for the rest of the connection: measured at a rendered x of 1200
  against newest data of 1495, with the socket, the snapshot rate and
  `underrunRate` all reading healthy. Only `clear()` escaped it. That is the
  SAME `frames[0]`-pinning failure as the `sample(dt)` defect above,
  reintroduced through a different door.
  WHY NOTHING CAUGHT IT: the field is typed `number`, and a type is a
  compile-time claim about a value that crosses a runtime decode boundary the
  HOST owns. The README quickstart passes `serverTime: snap.serverTime`
  straight out of a host-defined codec, and a codec that omits the field hands
  over `undefined`, whose arithmetic is NaN. Every test constructed its frames
  in-process, so no test ever exercised the boundary at all. `src/codec/bytes.ts`
  already treats decoded bytes as untrusted; the interpolator did not treat
  decoded FIELDS the same way. Fixed by refusing the frame in `push()` before
  it touches any accumulator, counting it on `rejectedFrames`, and refusing to
  STORE a non-finite delay or local clock anywhere downstream.
- THE PLAYHEAD COULD NOT RECOVER FROM A GENUINELY WRONG OFFSET, in three
  different shapes with one root cause. The offset is a sliding-window minimum
  eased under a 5% slew cap; both are deliberately slow, which is right for
  noise and wrong for a STEP, and there was no escape hatch. A permanent
  +1000ms one-way latency step (a route change) cost 22,517ms of continuous
  extrapolation rendering a 20Hz stop-go staircase, where the arrival-axis
  version self-corrected in 967ms. A +5000ms forward `serverTime` step stranded
  the playhead before `frames[0]` and left 56% of rendered frames motionless for
  about fifty seconds, because the count cap in `pruneFrames` spliced from the
  front regardless of where the playhead was. A backward `serverTime` step
  teleported the entity once, and is architecturally reachable: `ticker.ts`
  stamps `serverTime` from the running instance's `Date.now()`, so a handoff
  carries the successor machine's clock skew in either direction.
  Fixed with ONE mechanism, re-anchor on persistent playhead error, plus the
  `pruneFrames` fix. Measured after, on the same profiles: latency step
  967ms of extrapolation instead of 22,517; forward +5000 step motionless
  fraction 0.571 to 0.012 and settled 1000ms after the step instead of never;
  backward -5000 step 49,933ms of extrapolation to 617ms, worst backward jump
  1500 units to zero. The three calm-network profiles the rewrite was tuned on
  came out BYTE-IDENTICAL, so none of this cost anything in the ordinary case.
  WHY NOTHING CAUGHT IT: every interpolation test held the network profile
  STATIONARY. Jitter was varied, latency was varied, bursts were injected, but
  the distribution never changed shape mid-run, and a sliding-window estimator
  is only ever wrong about a distribution that CHANGED. The one test that did
  step the latency stepped it DOWNWARD by 200ms, the direction the floor tracks
  instantly, and existed to pin the slew cap rather than to ask whether the
  cap could be escaped.
- Three smaller ones, fixed in the same pass. The shortest-arc heading test was
  VACUOUS: with only two frames buffered it landed on the underrun branch, so
  `lerpHeading` was never called and replacing its body with a plain linear lerp
  (the exact bug the test names) left all 18 tests green. It needed a third
  frame to make the midpoint a real bracket. `interpolation.test.ts` also
  asserted `speeds.every((s) => s >= 0)`, which cannot fail because the values
  are `Math.hypot(...) / dt` magnitudes; replaced with a rewind count, which
  is the failure that profile actually produces. And `src/client/index.ts` was
  never updated with the rewrite's five new constants, so they were unreachable
  through `tickroom/client`, which `package.json` names as the only public
  entry point; the tests imported them from `./interpolation.js` directly, so
  no gate saw it. That is the half-a-paired-seam lesson again: when a change
  adds an export, the barrel is the counterpart.

### Defects found by a second adversarial pass on the interpolator (2026-09-01)

- ONE FINITE-BUT-FUTURE `serverTime` DISABLED THE UNDERRUN BRANCH FOR THE REST
  OF THE CONNECTION, and the guard that was supposed to stop exactly this class
  of thing waved it through, because it only asked `Number.isFinite`. A frame
  stamped far ahead is always the buffer's NEWEST end, so
  `i === this.frames.length - 1` can never be true again while it leads the
  playhead. That one condition IS the underrun branch, the `extrapolated` flag,
  `underrunRate`, and the re-anchor's own past-the-newest detection, so all four
  switch off together. Measured with one frame stamped 30 seconds ahead followed
  by five seconds of silence: the entity drifted 333 units BACKWARD (against
  +23.67 forward without it) while reporting `extrapolatedFrames = 0/300` and
  `underrunRate = 0.000`. It broke "never freeze a remote entity on underrun"
  and lied about its own health at the same time. `observeInterval` was poisoned
  with it: `lastServerTime` moved to the future stamp, after which no emission
  delta could ever be observed again and `intervalWindow` froze for the rest of
  the connection.
  THE FIX IS A PLAUSIBILITY TEST, NOT A MAGIC NUMBER. Once the offset estimate
  is seeded, a frame's implied one-way delay is `receivedAt - serverTime`, and
  delay is never negative, so the sliding-window MINIMUM is the floor. A frame
  can sit anywhere above it (jitter) and can lower it only by as much delay as
  was really in the previous best sample: tens of ms, low hundreds on a bad
  path. It cannot lower it by seconds. So a frame more than
  `OFFSET_FLOOR_SLACK_MS` (1000) below the floor is refused and counted on
  `rejectedFrames`.
  AND THE REFUSAL HAS TO HAVE A WAY OUT, which is the half that is easy to miss
  and would have been worse than the bug. A genuine forward clock step trips the
  identical test on its first frame and on every frame after it, so refusing
  forever is a total stall with nothing ever reaching the buffer again.
  Persistence is the discriminator: past `TIMELINE_STEP_FRAMES` (3) CONSECUTIVE
  refusals the collected offsets become the new anchor through the same escape
  hatch a stranded playhead uses, and the frame that proved it is accepted. The
  count reset on the first frame back near the floor, which is the half that
  was later replaced by a `TIMELINE_STEP_WINDOW` of judged frames; see the
  run-based-discriminator gotcha for why. Measured on a +5000ms
  forward step: settling time 1000ms to 0, worst staleness 950 to 70, peak
  rendered speed 5260 to 504 u/s, and exactly 3 frames refused across a
  forty-second run rather than a number that keeps climbing.
- THE RE-ANCHOR ANCHORED ON A SINGLE SAMPLE. Its gate was "at least one push
  since the error window opened", which is enough to tell a wrong clock estimate
  from an outage and not nearly enough to define an anchor: it adopts the
  MINIMUM of the error window's samples with NO slew, so with one sample it
  adopts that packet's raw offset whatever it is. A straggler dribbling through
  a congested link is exactly such a packet. Measured on a repeating stall with
  one queued packet delivered mid-stall: it adopted `offset = 640` against a
  true offset of 40, then held that 600ms error for about twelve seconds while
  the 5% slew walked it back, for a mean rendered position error of 16 to 55
  units over the rest of the run and a 38 unit backward step. The same
  single-sample anchor fires once per straggler during an order-preserving
  congestion dribble: SEVEN re-anchors in five seconds, each a 17 unit backward
  step, in the mechanism whose own getter documents a climbing count as "the
  offset estimate is not converging".
  Fixed with one constant, `REANCHOR_MIN_SAMPLES`, measured at 5 by sweeping 3,
  4, 5, 6 and 8 against clean ticker handoffs, dying tickers whose publish rate
  collapses, flapping links, gaps with stragglers, the repeating stall and the
  congestion dribble. 5 is the smallest value at which every benign profile
  produces ZERO re-anchors, and it takes the dribble from seven to two. It costs
  nothing on a real step: the count has a whole `REANCHOR_AFTER_MS` window to
  fill and 5 frames is 250ms at 20Hz.
- THE DEAD-EPOCH CUT CONTRADICTED `push()`'s OWN DOCUMENTED CONTRACT. `push()`
  documents out-of-order arrivals as ordinary; the re-anchor's cut keyed on the
  LAST arrival's `serverTime`, so a delayed packet landing in the very render
  frame the re-anchor fires on made the last arrival an older stamp than a frame
  already buffered, and that legitimate newer frame was cut as if it came from a
  timeline the authority had left. Reproduced at one lost frame. The cut is now
  against the NEWEST stamp among the frames that arrived DURING the error window,
  which is the live timeline's newest by construction (every dead-epoch frame
  arrived before the window opened) and is invariant to arrival order.
- THE FOUR PATHS A MUTATION MATRIX FLAGGED AS REDUNDANT WERE ALL KEPT, and this
  is the interesting part. On the previous tree, reintroducing the bug in the
  playhead-aware count cap, the time-prune suspension, the delay snap on
  re-anchor, or the post-re-anchor playhead recompute left all 24 tests green
  AND produced byte-identical measurements, because the re-anchor subsumed each
  of them. Re-measured after the three fixes above, every one of the four
  degrades something real, so all four stayed and every one gained the test it
  had been missing. Naive front-splice: two thirds of rendered frames motionless
  and THIRTY-ONE re-anchors on a profile where the count cap binds. No prune
  suspension: on a backward `serverTime` step the buffer bottoms out at ONE
  frame and every remote entity pops out of existence for 50ms, which no speed
  or staleness measure notices because they all skip a frame with nothing in it.
  No delay snap: peak rendered speed 360 to 1996 u/s on a -5000ms step. No
  playhead recompute: a single 62 unit backward step on a profile that otherwise
  never rewinds. THE LESSON IS ABOUT WHEN A MUTATION MATRIX IS RUN, not about
  the paths: "reintroducing this bug changes nothing" is a statement about the
  tree it was measured on, and three fixes later the same four mutations all
  bite. Re-run the matrix after changing the module, not once.
- THE `nowMs` FINITENESS GUARD HAD NO REPRODUCTION AND NOW HAS ONE. Deleting it
  left the whole suite green, and the obvious failure (NaN in the entity-drop
  sweep) is harmless. The real one is that NaN reaches `playheadErrorSinceMs`
  and every comparison against NaN is FALSE, so
  `localClockMs - playheadErrorSinceMs < REANCHOR_AFTER_MS` stops being a wait
  and becomes a pass: the 600ms of persistence is skipped and only the sample
  count is left. Measured on a +80ms one-way delay bump that the adaptive delay
  absorbs on its own with no correction needed: one NaN `nowMs` 300ms in turns
  zero re-anchors into one.

### Defect found by chasing a flaky test (2026-09-01)

- THE SYNCHRONOUS SPLIT-BRAIN GUARD REPORTED `'duration'` FOR A LOST LEASE, and
  it was found as a flaky unit test rather than as a bug, which is the reusable
  part. `ticker.test.ts`'s split-brain case failed once in a full-suite run on a
  loaded machine with `expected 'duration' to be 'lease-lost'` and passed 3/3 in
  isolation, which reads as a test racing wall time. It was not. `runTicker`
  detects a lost lease two independent ways: the ASYNC renew off the hot path
  (section 11), whose confirmed failure sets `lostLeaseExplicitly` and is picked
  up by the exit check that sets `exitReason = 'lease-lost'`; and the
  SYNCHRONOUS pre-publish `mayPublish` guard (section 7), which fires when
  ownership has already lapsed by the time an iteration begins. The second one
  set `owns = false`, logged `ticker.lease-lost`, and broke out of the loop
  WITHOUT touching `exitReason`, so it returned the `'duration'` initialiser.
  Which finder wins is decided by scheduling, so the reported reason depended on
  machine load, and it was wrong in exactly the case the guard exists for: a
  loop stalled past the lease TTL by a GC pause or a loaded host. Reproduced
  deterministically (no timing involved) by breaking `eval` on the fake so the
  atomic renew can never resolve at all, which closes the async path (its
  `.catch` deliberately does not set `lostLeaseExplicitly`, since a thrown renew
  is a blip and not a confirmed loss) and leaves the synchronous guard as the
  only finder: `{"reason":"duration","ticks":11,"uptimeMs":52}` against a
  5000ms `maxRunMs`. Fifty-two milliseconds reported as "I ran to my configured
  lifetime cap".
  WHY IT MATTERED BEYOND THE TEST. `TickerResult.reason` is public API.
  `adapters/node.ts` happens to treat `'duration'` and `'lease-lost'`
  identically, but `adapters/vercel.ts` returns it as the response BODY, so it
  is what a host branches on and what an operator counts. A fleet having its
  leases taken away read as a fleet of healthy duration-capped handoffs.
  WHY NOTHING CAUGHT IT: the existing test could not choose which finder fired,
  so it only ever exercised the one that was already correct, and the flake was
  the bug leaking through about once in fifty runs. A test that cannot select
  between two implementations of the same decision is testing whichever one the
  scheduler happens to pick. The new sibling case
  (`reports lease-lost when the SYNCHRONOUS guard is the only finder`) selects
  it by ORDERING, not by widening a bound, and both lease cases now also assert
  `uptimeMs` well under the duration cap so the two exits stay distinguishable
  independently of the string.

### Defects found by closing the interpolator's known-open items (2026-09-02)

- THE SEED FRAME ESCAPED THE PLAUSIBILITY GUARD, BECAUSE IT *IS* THE FLOOR THE
  GUARD TESTS AGAINST. `refuseSteppedFrame` returns early while
  `!offsetSeeded`, so the first frame of a connection is exempt. That is not
  merely an exemption: the floor is a sliding-window MINIMUM, so the first
  frame DEFINES the value every later frame is judged by, and a minimum can
  only ever be dragged further down. A future-stamped seed therefore sets a
  floor no honest frame can correct, because every real frame afterwards sits
  ABOVE it, which is indistinguishable from ordinary jitter and is waved
  through. Measured on a 20Hz stream of an entity moving at a constant
  100 u/s, the same +1500ms stamp costs NOTHING mid-run (1 frame refused, peak
  rendered speed 101 u/s, zero rewinds, playback never leaves its band) and
  costs 767ms of wrong playback on frame one: peak 4548 u/s, 21 backward
  rewinds, the pose 881ms stale, and `rejectedFrames` STILL ZERO, so the metric
  that exists to surface exactly this reported nothing. +30000ms measured 767ms
  and 3782 u/s; the size barely matters, because what is being measured is how
  long the stranded-playhead re-anchor takes to notice. Fixed by making the
  seed PROVISIONAL rather than exempt (`refuteSeedFrame`): the same test run in
  the opposite direction, so `TIMELINE_STEP_FRAMES` consecutive frames sitting
  more than `OFFSET_FLOOR_SLACK_MS` ABOVE the seed discard it, hand their own
  offsets in as the error window, and let `reanchor`'s dead-epoch cut lift the
  seed's frame out of the buffer. After: +1500ms is 0ms of settling and a peak
  of 619 u/s. The three calm profiles are byte-identical, and the one profile
  that could have regressed (a genuine congestion onset in the first frames,
  which is a real reason for later frames to sit above the seed) came out
  BETTER, not worse: peak 2100 to 1500 u/s and worst rewind 35 to 25 units,
  because anchoring to three congested packets beats holding a floor from one
  pre-congestion packet. A server whose clock is simply offset from the client's
  is untouched, since every frame carries the same offset and frame two
  corroborates frame one. The STAMPED-IN-THE-PAST direction needed no fix at
  all and was measured to confirm it: the existing floor guard already catches
  it on frame two (settling 50ms, 3 frames refused).
  THE REUSABLE PART IS THE SHAPE. When a guard measures a value against a
  statistic derived from the same stream, ask what happens to the FIRST sample,
  and specifically whether the statistic is one a single sample can pin (a
  minimum, a maximum) rather than one it can only nudge (a mean, a median).

- `rejectedFrames` AND `reanchors` DELIBERATELY SURVIVE `clear()`, AND THAT IS
  NOW WRITTEN DOWN AND PINNED. It was previously true of the code and stated
  nowhere, so the omission read as an oversight and the next tidy-up would have
  "fixed" it. The rule is GAUGES reset, COUNTERS do not: `delayMs` and
  `underrunRate` describe the current epoch and are meaningless carried across
  a reconnect, while both counters answer a question about the HOST ("is
  something above this producing timestamps it should not", "is the offset
  estimate failing to converge") that a reconnect does not refute. Since
  `clear()` is called on EVERY reconnect, resetting them would mean the more
  often a client reconnects the less evidence survives, which is exactly
  backwards. A consumer wanting a per-epoch number can difference the counter;
  recovering a lifetime total from a counter already reset is impossible.
  Pinned by `clear() resets the GAUGES but deliberately not the lifetime
  COUNTERS`, mutation-checked by making `clear()` zero them.

- THE `OFFSET_FLOOR_SLACK_MS` BOUNDARY WAS SWEPT AND IS SOUND, no dead zone and
  no discontinuity in the dangerous direction. Recorded here so nobody has to
  re-derive it. The boundary only exists for events that push a frame's implied
  one-way delay DOWN (a forward `serverTime` step, or a latency DROP); a
  latency step UP never approaches it and is handled identically either side.
  On a forward `serverTime` step, measured (settling after the step / peak
  rendered speed on a 100 u/s entity / frames refused):

  | step | settles | peak | refused | path taken |
  | --- | --- | --- | --- | --- |
  | +200ms | 0ms | 115 | 0 | absorbed, no correction needed |
  | +900ms | 12.5s | 196 | 0 | eased slew only, slow but smooth |
  | +990 / +999 / +1000ms | 1017ms | 5260 | 0 | stranded-playhead re-anchor |
  | +1001ms and above | 0ms | 450-504 | 3 | floor refusal, then re-anchor |

  So the boundary value itself (exactly 1000, which `>=` accepts) takes the
  re-anchor path and converges in about a second; every larger step takes the
  refusal path and is strictly BETTER. The band from roughly 950 to 1000 is the
  worst of the three, at a 5260 u/s spike, but that is the pre-refusal
  behaviour which was already the accepted cost of the re-anchor, and it is
  bounded and converges. Nothing falls between the two mechanisms.
  ONE REAL GAP WAS FOUND IN THE SWEEP, LEFT ALONE AT THE TIME, AND HAS SINCE
  BEEN FIXED (see the run-based-discriminator gotcha): the refusal run was
  counted as CONSECUTIVE (`steppedOffsets.length = 0` on any in-floor frame),
  which is not invariant to arrival ORDER, and `push()` documents out-of-order
  arrivals as ordinary. A latency DROP larger than the slack reorders the
  stream by definition (packets already in flight arrive on the old schedule),
  so old and new frames interleave and each old one resets the counter: the
  escape hatch never reaches `TIMELINE_STEP_FRAMES` during the overlap.
  Measured on a 3000ms base delay dropping by 1001ms: 23 legitimate frames
  refused across the overlap, then a 6106 u/s spike, where the same drop of
  1000ms (one millisecond less) refuses nothing and peaks at 133. This is the
  same lesson as the dead-epoch cut ("the cut is against the NEWEST of those
  arrivals, not the LAST one"): a run-based discriminator has to be
  order-invariant. It was left alone at the time because it needs a base
  one-way delay above a second to reach at all and the fix is a behaviour
  change rather than a correction. The behaviour change was made in the
  0.2.0 client pass: the count is now windowed over `TIMELINE_STEP_WINDOW`
  (12) judged frames rather than reset by one in-floor arrival.

### Defects found by sweeping the whole library for the five known classes (2026-09-02)

The sweep took the five shapes every real bug in this repo has fallen into and
looked for more of each, everywhere. Two were fixed here; the rest are listed in
the review notes because they change behaviour or public API and are the owner's
call, not a sweeper's.

- THE BALANCER HONOURED `exclude` ON EVERY PATH EXCEPT THE ONE THAT SAYS "FULL".
  `assignRoom` `continue`s the excluded index in the capacity loop, so that room
  is never measured, and the all-full fallback then returned `roomIdFor(base, 0)`
  regardless. Two things wrong at once: the client is sent straight back to the
  instance that just bounced it, burning the bounded re-assign budget against one
  room (the strand-on-"full" failure `exclude` exists to prevent), and `full:
  true` is asserted about the ONE room whose capacity was never read. This is the
  surviving half of the shape commit 7d20026 fixed: that commit taught the
  mget-FAILURE path to honour `exclude` and left the FULL path alone. Fixed to
  return the lowest non-excluded index, with the same degenerate guard the
  sibling path already has (the excluded room is handed back only when it is the
  only room there is). `full` is honest on the new path in a way it never was on
  index 0: every index it can return WAS measured and WAS at capacity.
  THE LESSON IS THE ONE ABOUT PAIRED SEAMS AGAIN. When a fix teaches one branch
  what an option means, the other branches that read the same option are the
  counterpart; grep the option name before ticking the item off.

- A NON-FINITE `maxAgeS` REMOVED THE SESSION EXPIRY ENTIRELY, SILENTLY.
  `(opts.maxAgeS ?? DEFAULT_MAX_AGE_S) * 1000` uses `??`, which catches an ABSENT
  value and not a `NaN` one, and the canonical way to get `NaN` here is
  `maxAgeS: Number(process.env.SESSION_MAX_AGE_S)` with the variable unset.
  `age > NaN` is false, so the expiry check never fires while the future-dated
  check still passes: every token ever minted stays redeemable forever, in the
  module whose own header says an expiry is not optional. No log, no throw, and
  nothing observable until a leaked token is replayed. Fixed with a
  `Number.isFinite` check falling back to the default rather than refusing, since
  refusing would lock every player out of a running deployment over one unset
  variable. Zero and negative are deliberately left alone: those expire
  everything, which is a host asking for something drastic rather than a host
  failing to ask for anything.
  THE SHAPE IS WORTH REMEMBERING: `??` IS NOT A VALIDITY CHECK. Every
  `?? DEFAULT` in this library sits on a number a host may well have computed
  with `Number(...)`, and `Number('')` is 0 while `Number(undefined)` is NaN.

- THE BALANCER ROUTE WAS THE ONE ROUTE OF THREE WITH NO TRUST BOUNDARY ON IT.
  The ticker and relay routes both run `normalizeRoomId`; the balancer route
  ran a bare `isValidBase(base)` and nothing else, so `FORBIDDEN_CHARS`, the
  length cap and `DANGEROUS_BASE_NAMES` were all bypassed on a value that
  `assignRoom` then interpolates into a Redis key name once per instance in
  the pool. `isValidBase` cannot be the boundary: it is HOST-supplied, this
  repo's own docs already treat it as something written wrong (a bare
  `raw in WORLDS` matches inherited properties), and it says nothing about
  characters or length at all. Fixed with a new `normalizeBase` in
  `core/ids.ts`, which `normalizeRoomId` now delegates its base half to.
  WHY NOTHING CAUGHT IT: there were no adapter tests at all, and every check
  the route was missing was present, correct and well tested one layer down in
  a function the route never reached for. A test one layer down cannot observe
  whether a route calls it. `src/adapters/vercel.test.ts` now exists for
  exactly that question and stubs only `assignRoom` and `getRedis`.

- `checkAdmission` DISCARDED THE PIPELINE'S PER-COMMAND ERRORS, so the
  per-user socket cap could silently stop enforcing during a Redis fault,
  which is precisely when it is load-bearing (that cap is not a fairness
  control: every socket holds its own Redis subscriber, so one client opening
  sockets without limit can exhaust a managed plan's connection ceiling and
  take the room ticker's own subscriber down with it). `pipeline().exec()`
  resolves with a `[error, reply]` pair PER COMMAND and does not reject when
  one fails. Deliberately NOT fixed by failing closed: refusing during a Redis
  blip locks every user out of a healthy deployment, which is worse than the
  thing being prevented. Fixed by reading the errors and adding
  `AdmissionResult.socketCapEvaluated`, which both adapters and the node
  example now log on. The stale-entry prune counts toward it as well as the
  count itself: without the prune the set still holds members for sockets long
  gone, so the count reads HIGH and would refuse a legitimate reconnect, which
  is the fail-closed direction this function will not go in on data it knows is
  stale.

- `unpackCheckpoint` PROMISED VERSION REJECTION IN ITS DOCSTRING AND PERFORMED
  NONE. It named "a value from an incompatible future version" among the
  things it returned `null` for and never looked at `v` at all. The direction
  people expect to matter is the newer one; the DANGEROUS one is the older,
  because it PARSES: every field present, every type correct, so a `v: 1` body
  handed to a build whose version 2 changed what `tick` counts is restored in
  full and simulated happily. That is the geometry-digest failure through a
  different door, with the same properties (silent, permanent, TTL refreshed
  by the very write that perpetuates it, healthy in every metric). Fixed with
  `!== CHECKPOINT_VERSION`, checked BEFORE the field types so a version that
  dropped a field reads as the version change it is rather than as corruption.
  `inspectCheckpoint` carries the reason out and the ticker logs
  `ticker.checkpoint-refused` with `reason`, `foundVersion` and
  `expectedVersion`, silent for an absent checkpoint so an ordinary cold room
  stays quiet and the refusal is a signal rather than noise.

### Verified against a real Redis and a real socket

`tests/` runs against a REAL Redis (six files), not the fake. Start one with
`redis-server --port 6399 --save '' --appendonly no --daemonize yes`, then
`npm run test:integration`. Every key is namespaced per run (`itest-{uuid}`) and
deleted afterwards, so it never disturbs a shared instance, and the suite SKIPS
cleanly with exit 0 when no Redis is reachable (override the URL with
`TICKROOM_TEST_REDIS_URL`). That is why the default `npx vitest run` stays green
offline.

MEASURED on Redis 8.10.1, and these are the numbers to re-check after any change
to the ticker, the lease or the checkpoint:

| | measured |
| --- | --- |
| Checkpoint compression | 5,749B to 749B, **7.68x** |
| Fan-out cost | 50 `publish()` calls issued exactly **50** PUBLISH commands, delivered to 5 subscribers |
| Tick rate | **20.45Hz** against a 20Hz target, over real wall time |
| **Handoff** | predecessor died at tick 26, successor **restored at tick 26**, longest gap in the snapshot stream **10ms** across 334 snapshots |

The handoff figure is the headline claim of the library and it is now executable
rather than asserted. Treat 10ms as a floor, not a typical figure: this is
loopback Redis with no network and no cold function start, so production will be
slower. What it proves is the MECHANISM (a successor restores and continues the
tick count rather than resetting), which is the part that either works or does
not.

What the real Redis proves that the fake structurally cannot: that `ioredis`
satisfies `RedisLike` with no adapter (a claim previously only ever checked
against a hand-written fake, i.e. a claim about the fake); the `getBuffer` trap,
where a plain `get` genuinely corrupts a gzipped checkpoint before anything can
sniff its magic bytes; the lease resolving 20 CONCURRENT acquires to exactly one
winner, which a single-threaded fake cannot race; a real TTL expiring so a dead
room reads as empty and reusable; and that a connection in SUBSCRIBE mode really
does refuse ordinary commands, which is the entire reason the library carries a
separate subscriber factory.

GOTCHA FOR ANYONE ADDING AN INTEGRATION TEST: never assert on server-global
state. The first version of the fan-out test gated on `INFO stats`
`total_commands_processed`, which counts every client on that server, so any
other test file running in parallel landed inside the measurement window and it
failed in the full suite while passing in isolation. Key prefixes isolate keys;
they do not isolate `INFO`, `DBSIZE`, `CLIENT LIST`, or any other server-level
metric. Measure something you own.

### The buffer-health seam, deleted deliberately and specified for whoever wants it

`ClientTick.reportBufferHealth` AND ITS FIVE TUNING CONSTANTS WERE DELETED, AND
THE REASON IS WORTH KEEPING. `STEP_DILATION_MAX`, `MARGIN_TARGET`,
`MARGIN_SPAN`, `HEALTH_EASE_TAU` and `DILATION_EASE_TAU` tuned a control loop
that NOTHING IN THE LIBRARY COULD DRIVE: grep for `bufferHealth` found the
method and its own constants and nothing else, so `dilation` was permanently
1.0 and the `+-5%` step dilation in `docs/ARCHITECTURE.md` section 4 described
behaviour no consumer could reach. Shipping an undriveable feature is worse than
shipping neither the feature nor the constants. Four `ClientTick` tests went
with it, including the defence-in-depth pair this file used to record
(`reportBufferHealth keeps dilation within +-dilationMax` had two clamps behind
it, either one deletable on its own while staying green).

The two live options were WIRE IT UP or DELETE IT, and delete won on two
grounds. First, the producer is structurally server-side: the quantity is how
many ticks of input a player's `PlayoutBuffer` holds ahead of what the ticker is
consuming, which only `src/server/ticker.ts` knows. Landing the client half
alone is precisely the half-a-paired-seam mistake TR-4 is recorded for. Second,
the tempting client-side substitute (derive the margin from
`tick.value - estimateServerTick()` minus half `stats().rttMs`) drives a real
feedback loop from a signal this library's own comment calls a biased PROXY
rather than a measurement, and a persistent bias larger than `MARGIN_SPAN` pegs
the dilation at a limit until `shouldReanchor` fires. A wrong-but-plausible
control loop nobody can measure is the exact failure this repo is built to
avoid.

THE SEAM TO BUILD, IF SOMEBODY WANTS THE FEATURE BACK, stated precisely so the
next pass does not have to re-derive it:

1. `src/server/ticker.ts` computes, per player per tick, the buffered margin
   `bufferedAheadTicks = highestBufferedTargetTick(pid) - currentTick`, from the
   `PlayoutBuffer` it already holds.
2. It publishes those on the SAME cadence and channel the roster frame uses,
   NOT per tick and NOT per player message: anything whose rate a client
   controls is counted in process and flushed on a cadence the client cannot
   drive. A `{ t: 'health', margins: Record<pid, number> }` frame at 1Hz is the
   shape; it belongs behind a `TickerOptions` formatter for the same reason
   `metaPayload` does.
3. The relay forwards it unchanged (it already forwards control frames).
4. `RoomConnectionOptions` grows `bufferMarginFrom?(msg: unknown): number | null`,
   read in `handleTextFrame`, and `frame()` feeds the result plus its own `dt`
   into the restored `ClientTick.reportBufferHealth`.

Steps 1 and 2 are the load-bearing half. Do not restore step 4 without them.

### Owed before a 1.0

- ~~A published package~~ LANDED (`tickroom` on npm, tag-triggered trusted
  publishing in `.github/workflows/release.yml`). Still owed: a decision on
  whether `ioredis` stays a peer dependency or the `RedisLike` seam is
  documented as the supported swap point.
- The integration suite runs a toy runtime, not the examples. Wiring the pong
  example end to end through it would be a stronger demonstration.
- The buffer-health seam, if anyone wants the client tick to dilate again. The
  section above it is the whole specification; the client half alone is not a
  feature.
- ~~No CI.~~ LANDED: `.github/workflows/ci.yml`, two jobs. `check` runs
  typecheck, unit tests and build with no services (the `tests/` files skip).
  `integration` runs `npm run test:integration` against a `redis:8` service
  container on host port 6399, the same port the local instructions use. There is
  still no `lint` script, so CI runs no linter; add the script before adding the
  step. THE INTEGRATION JOB CANNOT PASS VACUOUSLY: the suite's skip-when-
  unreachable behaviour is right on a laptop and exactly wrong in the job whose
  only purpose is to run it, so CI sets `TICKROOM_REQUIRE_REDIS=1` and
  `probeRedisAvailable` THROWS instead of returning false. The throw happens at
  module scope (the probe is awaited at the top level so the skip decision is
  made at collection time), which vitest reports as a failed file with no tests
  run. The check lives in the probe rather than in each test file so a seventh
  integration file inherits it. Measured all three ways: flag set with no Redis
  exits 1 having run 0 of 37 tests; no flag with no Redis exits 0 with 37
  skipped (the unchanged local default); flag set with a real Redis exits 0 with
  37 passed.
- The package ALSO installs as a git dependency, and `"prepare": "npm run build"`
  is what makes that work: `dist/` is gitignored and every `exports` path points
  into it, so without the hook a `github:` install resolves to a package with no
  code in it at all. Publishing to npm did not retire the hook, because a `npm
  publish` also runs it and because a consumer pinning a commit is still a
  supported route. `prepare` also runs on a plain local `npm install`, which is
  harmless (it is the same `tsc -p tsconfig.build.json` the `build` script runs,
  it needs no network, and nothing in the build re-enters install).
