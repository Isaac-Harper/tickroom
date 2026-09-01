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

PUBLIC repo, MIT licensed. Not published to npm; consumers install it as a git
dependency, which is what `prepare` exists for (npm builds a git dep by running
it, and `dist/` is gitignored).

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
- `src/core/ids.ts` - room identity and Redis key naming. `roomKeys`, `roomIdFor`,
  `normalizeRoomId`. A TRUST BOUNDARY: the raw value comes from a query param and
  is interpolated into key names, which have no escaping.
- `src/core/lease.ts` - the exactly-one-writer mechanism plus the `OwnershipClock`
  two-clock rule. The single most safety-critical file. See the gotcha below.
- `src/core/checkpoint.ts` - the checkpoint ENVELOPE grammar, pure:
  `CHECKPOINT_VERSION`, `packCheckpoint`, `unpackCheckpoint`,
  `graceMsFromCheckpoint`. JSON and arithmetic only.
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
- `src/client/clientTick.ts` - the monotonic dilated client tick.
- `src/client/interpolation.ts` - `SnapshotInterpolator`. Playback on the SERVER
  timeline (`serverTime` is the axis; `receivedAt` exists only to estimate the
  local-versus-server clock offset, as a slew-capped sliding-window minimum),
  jitter-adaptive delay sized from one-way delay above that offset floor,
  never-freeze extrapolation, outward bracket scan for an entity a snapshot
  omits, shortest-arc heading, measured speed. `push()` is a TRUST BOUNDARY,
  against both non-finite AND implausible timestamps. A playhead stranded for
  `REANCHOR_AFTER_MS` while at least `REANCHOR_MIN_SAMPLES` frames arrive
  re-anchors the offset outright, and so does a run of `TIMELINE_STEP_FRAMES`
  frames whose implied one-way delay is impossible. Observability: `delayMs`,
  `underrunRate`, `rejectedFrames`, `reanchors`.
- `src/client/connection.ts` - `RoomConnection`. Reconnect, re-mint, clock sync,
  protocol-skew recovery, stall observation.
- `src/codec/bytes.ts` - `ByteWriter` / `ByteReader`. The reader is a TRUST
  BOUNDARY and bounds-checks every read.
- `src/codec/quantize.ts` - clamping (never wrapping) quantisation helpers.
- `src/codec/snapshot.ts` - a batteries-included default codec plus the input
  redundancy window.
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
- A checkpoint carries a geometry digest and a mismatch starts fresh. See the
  geometry gotcha.
- Capacity is read from ONE key (`room:{id}:stats`) by both the relay and the
  balancer. See the capacity gotcha.
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
  is a total stall. Past `TIMELINE_STEP_FRAMES` CONSECUTIVE refusals the run is
  treated as a timeline rather than a glitch and becomes the new anchor. The
  count resets on the first frame that lands back near the floor, which is what
  makes a one-off corrupt stamp and a sustained step distinguishable at all.
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
- A reconnect must `clear()` the interpolator. `RoomConnection` holds no
  reference to one, so only the caller can: from `onStatus`, the moment the
  status leaves `'open'`. Without it the first frame of the new epoch brackets
  against a seconds-stale one at `frac ~= 1`, which is a snap per reconnect.
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

MEASURED ON THIS TREE, not estimated: `npx vitest run` is 504 tests across 32
files, all green (with a local Redis up, so the six integration files run rather
than skip); `npx tsc --noEmit` is clean repo-wide including `examples/`;
`npm run build` emits `dist/` cleanly. Roughly 6,100 lines of source and 3,500 of
tests. Per layer: core 154, server 46, client 54, codec 65.

- Extracted and implemented: core, server, client, codec, adapters, plus three
  examples (a 2D game, a presence layer, a plain Node host).
- NOT published to npm. NOT deployed anywhere. NOT run against a real Redis or a
  real WebSocket, so every claim here is unit-level plus whatever the source
  architecture already proved in production.
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
`renewFailed` advance `lastOwnedAt`) and confirming `lease.test.ts` fails two
cases, then restoring. If you change anything in `lease.ts`, do this again. A
green test that cannot fail is worse than no test, and this is the one invariant
in the library whose failure mode is silent and catastrophic.

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
  count resets on the first frame back near the floor. Measured on a +5000ms
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

### Owed before a 1.0

- A published package, and a decision on whether `ioredis` stays a peer
  dependency or the `RedisLike` seam is documented as the supported swap point.
- The integration suite runs a toy runtime, not the examples. Wiring the pong
  example end to end through it would be a stronger demonstration.
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
- The package installs as a git dependency. `"prepare": "npm run build"` is what
  makes that work: `dist/` is gitignored and every `exports` path points into it,
  so without the hook a `github:` install resolves to a package with no code in
  it at all. `prepare` also runs on a plain local `npm install`, which is
  harmless (it is the same `tsc -p tsconfig.build.json` the `build` script runs,
  it needs no network, and nothing in the build re-enters install).
