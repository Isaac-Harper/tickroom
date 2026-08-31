# tickroom: agent onboarding

Read this once instead of re-deriving the codebase. `docs/ARCHITECTURE.md` is the
reasoning behind every load-bearing decision and is short; read it too. `README.md`
is the user-facing pitch and quickstart. Keep THIS file current: whoever changes
the architecture updates the file map, the status, and the gotchas in the same
commit.

## What this is

A TypeScript library for running authoritative realtime multiplayer rooms on
serverless functions. Extracted from `~/Development/glade` (a shipped multiplayer
browser game) and generalised so it works for 2D games, collaborative apps,
multiplayer cursors, or anything realtime where several clients need to agree on
state changing many times a second.

Private repo, no publish yet. MIT licensed, public by default when it ships.

## The architecture in one paragraph

Browser opens a wss socket to a RELAY function (one per socket, a dumb pipe with
no simulation in it). The relay decodes the client's input and publishes it on
`room:{id}:in`. A separate TICKER function holds a short-TTL Redis LEASE on that
room, runs the authoritative fixed-timestep simulation, and publishes binary
snapshots on `room:{id}:out` at the sim rate, which the relays forward to their
sockets. The ticker checkpoints the whole room to `room:{id}:state` every second
and spawns its own successor before the platform kills it at its duration cap, so
a handoff is a sub-second gap in the snapshot stream that the client's
interpolation delay absorbs entirely. Nobody disconnects during a handoff, because
the relays are a separate lifetime from the ticker.

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
- `src/client/interpolation.ts` - `SnapshotInterpolator`. Adaptive delay,
  never-freeze extrapolation, shortest-arc heading, measured speed.
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
- Never freeze a remote entity on interpolation underrun. Extrapolate.
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

MEASURED ON THIS TREE, not estimated: `npx vitest run` is 403 tests across 31
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
- The upstream source (`~/Development/glade`) is the production evidence for the
  design: the lease, the checkpoint handoff, the playout timeline, the stall
  thresholds and the interpolation rules were all measured there under real load.
  Where a number in a comment is quoted as "measured", that is where it came from.

### Verified by mutation, not just observed green

The two-clock rule was checked by reintroducing the historical bug (making
`renewFailed` advance `lastOwnedAt`) and confirming `lease.test.ts` fails two
cases, then restoring. If you change anything in `lease.ts`, do this again. A
green test that cannot fail is worse than no test, and this is the one invariant
in the library whose failure mode is silent and catastrophic.

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
