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
that workflow's header is the operating manual for cutting one. THE FIRST RUN OF
THAT WORKFLOW FAILED AT THE PUBLISH: v0.2.0 on 2026-09-05 passed the build, the
typecheck and the Redis-backed suite, then npm answered the PUT with a 404,
which is what it says when no credential matched. The workflow no longer passes
`registry-url` to setup-node (that wrote a placeholder `_authToken` into the
runner's npmrc); whether the npmjs.com trusted-publisher entry for this
repository and workflow exists is still unverified, and the next tag is the
test. 0.2.0 itself was published from a laptop session and carries no
provenance.

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
close codes, `ping`/`pong`, `relay-expiring`, `room-full`, `conn-limit` and the
ticker's `room-reject`, all defined once in `src/core/wire.ts` and imported by
both the relay and `RoomConnection`. A host's own frames never look like one:
the relay recognises a ping by the literal prefix `{"t":"ping"` before it
decodes anything.

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
               ALSO the admission protocol (`admission.ts`), which used to
               live in the Vercel adapter and be imported from there.
src/client/    browser. WebSocket + performance.now() are the only globals it
               needs; sessionStorage/location access is guarded. ONE clock
               domain, `performance.now()`, end to end.
src/codec/     the wire. byte reader/writer, quantisation, a default codec.
src/adapters/  thin wiring per platform. takes the platform handle by
               INJECTION so the library never hard-depends on one host, and
               SPREADS the server option bags rather than re-listing them.
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
  `CheckpointEnvelope` gained OPTIONAL `gridAt`, the SCHEDULED GRID TIME of the
  tick the checkpoint describes, so a successor can continue the predecessor's
  timeline instead of restarting it at its own `Date.now()`. Optional and
  additive, so it is a shape change and not a meaning change and
  `CHECKPOINT_VERSION` did not move. See the timeline-continuity invariant.
- `src/core/wire.ts` - NEW, and it is the CONTROL-PLANE CONTRACT both ends
  import: `CLOSE_CODES` (4001 closedByServer, 4002 capacity, 4003 connLimit,
  4004 relayUnavailable, and only the last of those is not terminal for the
  client), `SERVER_FRAMES` (`meta`, `room-full`, `conn-limit`,
  `relay-expiring {t,inMs}`, `pong {t,n,c}`), `CLIENT_FRAMES` (`ping {t,n,c}`),
  `ROOM_REJECT_FRAME`, `PING_INTERVAL_MS` (2000), `RELAY_EXPIRY_LEAD_MS` (5000),
  and the encode/narrow helpers. These were string and number literals repeated
  in the client, two adapters and an example, and the client latched a terminal
  reason off a code an adapter happened to pick, so a change on one side could
  not be seen from the other. Pure constants, so `core` stays browser-safe.
  IT ALSO OWNS THE JOIN HEARTBEAT, for the same reason and against a different
  pair of files: `JOIN_HEARTBEAT_MS` (1000) is the relay's join republish
  cadence AND the unit the ticker's presence timeout is counted in, and
  `PRESENCE_TIMEOUT_HEARTBEATS` (5) is how many of them make a player gone.
  `relay.ts` defaults `heartbeatMs` to the first; `ticker.ts` derives
  `DEFAULT_PRESENCE_TIMEOUT_MS` from both. See the phantom-player gotcha.
- `src/core/redisLike.ts` - structural minimum Redis interface, so core never
  hard-imports ioredis. ioredis satisfies it with no adapter. Now carries an
  optional `on?(event, cb)` for connection-lifecycle events, which is what lets
  the ticker treat a `'reconnecting'` bus as ownership it cannot vouch for, AND
  the matching `off?(event, cb)`, because the shared client is a process
  singleton: without a detach, five runs left five `'reconnecting'` listeners on
  it, each one retaining a whole run's scope.
  AND IT IS THE SUPPORTED SWAP POINT NOW RATHER THAN A SHAPE THAT HAPPENS TO
  ALLOW ONE: `src/server/memoryRedis.ts` is a second SHIPPED implementation of
  exactly this interface, so "swap the bus" is a line a host can copy out of the
  README rather than a claim about what the types would permit. A third
  implementation is held to the same bar the fake was: this surface and the
  pub/sub extras `Subscriber` adds, and nothing wider.
- `src/core/ids.ts` - room identity and Redis key naming. `roomKeys`,
  `roomIdFor`, `normalizeRoomId`, `normalizeBase`. A TRUST BOUNDARY: the raw
  value comes from a query param and is interpolated into key names, which
  have no escaping. TWO DOORS, ONE IMPLEMENTATION: `normalizeRoomId` takes a
  room id and falls back to a known-good one, `normalizeBase` takes a BASE (a
  pool of instances) and returns `null`, because the only caller that needs it
  already answers 400 and silently redirecting a hostile `?base=` would turn a
  refusal into a reassignment. `normalizeRoomId` delegates its whole base half
  to `normalizeBase`, so a rule added to one cannot go missing from the other.
  `roomKeys` is NINE suffixes now: the seven original ones plus `crashes`, the
  short-lived consecutive-crash counter the ticker reads at startup and
  increments on a thrown exit, and `timeline`, the last `serverTime` the room
  PUBLISHED. `timeline` is written only by an exit that saves no final
  checkpoint (today, one that threw), read best-effort at restore and applied
  as a floor, and deleted by any exit that does write one. See the
  timeline-marker invariant for why a `gridAt` alone cannot cover the crash
  path. `KEY_SUFFIXES` is the one list; a tenth suffix goes there and nowhere
  else, and `examples/node-server/README.md` prints all nine in its startup
  banner, so that sample output is a thing to update with them.
- `src/core/lease.ts` - the exactly-one-writer mechanism plus the `OwnershipClock`
  two-clock rule. The single most safety-critical file. See the gotcha below.
- `src/core/checkpoint.ts` - the checkpoint ENVELOPE grammar, pure:
  `CHECKPOINT_VERSION`, `packCheckpoint`, `inspectCheckpoint`,
  `unpackCheckpoint`, `graceMsFromCheckpoint`. JSON and arithmetic only.
  `inspectCheckpoint` is the one to reach for anywhere the answer gets logged:
  it returns WHY it refused (`absent`, `unparseable`, `malformed`, `version`)
  and `unpackCheckpoint` is the thin wrapper that throws that away. `gridAt` is
  carried through OPTIONALLY: absent is restored as `undefined` and present-
  but-not-a-number is `malformed`, so the field is additive without loosening
  the exactness the version check depends on.
- `src/server/checkpoint.ts` - checkpoint STORAGE: gzip encode/decode with
  magic-byte sniffing and the Redis read/write pair, TTL riding the SET. Lives
  in this layer because it imports `node:zlib`; it used to be in `core/` and
  re-exported from the core barrel, which made the whole barrel unimportable in
  a browser. See the browser-safety gotcha. The write is now OWNER-CHECKED:
  `writeCheckpoint(redis, key, json, ttlS, ownerCheck?)` runs a two-key Lua SET
  that Redis itself refuses once the lease has moved on. See
  `CheckpointOwnerCheck` and the ex-owner gotcha below.
- `src/core/playout.ts` - `PlayoutBuffer<T>`, the tick-stamped input buffer with
  never-drop-late re-stamping. `lateCount` counts only the re-stamps that LAND:
  a redundancy window re-sends already-consumed ticks constantly on a perfectly
  healthy link (3 per packet), and counting those made the statistic a function
  of the window size rather than of the link. `push` now ANSWERS, with
  `PushResult` (`'kept' | 'late' | 'stale' | 'refused'`, exported from the core
  barrel): `'stale'` is a late push that lost the freshness check inside a
  healthy redundancy window and is deliberately NOT a refusal, because counting
  it as one would make the caller's refusal statistic a function of the client's
  window size in exactly the way `lateCount` already had to be fixed for. The
  refusals get their own name too: `refusedCount` beside `lateCount`, and the
  two are opposite in direction as well as in cause. A LATE push arrived after
  its tick and is applied anyway; a REFUSED one sat further AHEAD of the
  consumed floor than `maxAhead` allows and is discarded. A rising `refusedCount`
  is a configuration fault (the bound is smaller than this sender's lead), where
  a rising `lateCount` is a link, and before the split the only symptom of
  either was starves climbing with nothing naming the cause.
- `src/core/starvation.ts` - the starvation decay policy and `StarveTracker`.
  `decayOnStarve` takes the streak exactly as `RoomRuntime.onStarve` delivers
  it: 1 on the first starve, no `- 1` at the call site.
- `src/core/backpressure.ts` - `Inbox<T>` with a per-sender quota (the fairness
  property, see the gotcha below).
- `src/core/rateLimit.ts` - `TokenBucket`.
- `src/core/metrics.ts` - `percentiles`, `RollingHistogram`, `Counters`.
- `src/server/redis.ts` - ioredis connection helpers. Shared publisher, per-socket
  subscriber (a connection in subscribe mode cannot run ordinary commands), plus
  an `onError` hook with a rate-limited console default. THE TWO FACTORIES
  DEFAULT DIFFERENTLY ON PURPOSE. The shared client carries
  `commandTimeout: 2000`, merged UNDER the caller's own `redisOptions`, because
  the timeout is the only bound on a BLACK-HOLED connection: a retry count only
  starts spending once the socket has actually CLOSED, so without it every
  fire-and-forget promise and the one awaited renew hang forever and the ticker's
  `finally` never runs. The SUBSCRIBER deliberately has none, and that is not an
  oversight to "fix": after every reconnect ioredis re-issues the subscription
  itself, with no `.catch` on the promise it returns, so a `commandTimeout`
  applied to that command turns a slow resubscribe into an UNHANDLED REJECTION,
  which on current Node is a process exit taking every other socket the function
  holds with it. Nothing is lost, because the wait is bounded where it is
  ISSUED: the relay races `sub.subscribe(...)` against `subscribeTimeoutMs` and
  the ticker races its own against `leaseTtlMs`. A bound owned by the caller
  applies to the caller's own commands only, which is exactly the distinction a
  client-wide option cannot make. THIS FIX SET BRIEFLY SET ONE AND THE VERIFIER
  ROUND TOOK IT BACK OUT, reproduced with a TCP proxy holding only the
  resubscribe reply: the control exits the process, the shipped options survive
  and messages resume. `tests/subscriber.redis.test.ts` is that pair, and it is
  integration file number seven. The same uncaught-promise shape is why the
  shared client should sit on db 0: the identical ready handler issues
  `select(db)` with no `.catch` when it comes back on a different db, and a URL
  with no db index (or an explicit `/0`) never issues that SELECT at all.
- `src/server/session.ts` - HMAC tokens with a hard expiry, plus room-bound spawn
  tokens gating the ticker endpoint. The spawn token is a TIME-WINDOWED
  capability rather than a one-shot: `makeSpawnToken` signs `roomId:window` over
  `SPAWN_TOKEN_WINDOW_MS` (5 minutes) and `verifySpawnToken` accepts the current
  window and the one before it, because the token rides a query string that
  platform access logs keep. Two windows is the bound; widening it is what turns
  a bounded leak back into an unbounded one.
- `src/server/admission.ts` - NEW. `admitSocket` (check, warn on a cap that could
  not be evaluated, refuse or register, attach, unregister on close AND
  unregister when `attachRelay` THROWS, since the ZADD is already written by
  then and `createSubscriber` throws synchronously on an unset `REDIS_URL`, so a
  misconfigured deploy burned a cap slot per attempt),
  `registerConnection`, `refuseSocket` (which now also registers its attempt on
  the transport's `'open'` event where one exists, keeps the immediate attempt
  and the 250ms retry, and closes unconditionally on the last one, because a
  handshake completing at 300ms was never refused at all; and which latches
  `frameSent` and `socketClosed` SEPARATELY, because one flag made a THROWING
  send read as a completed refusal and left the socket open, unrefused and
  relay-less past 320ms while the shipped test asserted only `not.toThrow()`),
  `CONN_TOUCH_MS` (10s), `CONN_KEY_TTL_S`
  (60), both asserted against `relay.ts`'s exported `DEFAULT_CONN_STALE_MS`
  rather than against a number retyped here. It exists because that sequence AND its close codes lived in
  `adapters/vercel.ts`, were imported from there by `adapters/node.ts` (one
  platform's adapter as another's dependency, for a decision that is not
  platform-specific) and were hand-copied into the node example. Three copies of
  a protocol the CLIENT latches a terminal reconnect state off.
- `src/server/ticker.ts` - THE CORE. `runTicker`. The whole authoritative loop,
  and the file the audit changed most. `guardHost` wraps every runtime hook and
  ticker callback (a throw AND a rejected thenable, counted on `hostErrors`, one
  summary line per stats flush); `serverTime` is the SCHEDULED grid time rather
  than a clock read after `runtime.tick`; the post-stall resync sleeps a full
  tick instead of firing the next one back to back; publishes are bounded
  (`MAX_IN_FLIGHT_PUBLISHES` 4, the rest counted on `publishSkipped`); an ERROR
  exit writes no checkpoint, releases the lease, increments `room:{id}:crashes`
  and spawns nothing, and three crashes start the room fresh
  (`ticker.crash-loop`); that counter's `CRASH_KEY_TTL_S` (60) window is FIXED
  rather than sliding, because the `EXPIRE` runs only when the `INCRBY` came
  back 1, and it is cleared only once the invocation has itself run for
  `CRASH_KEY_TTL_S` of uptime; the subscribe is raced against `leaseTtlMs` and a
  failure abandons the run without spawning; the input subscription answers its
  own `probe` every `PROBE_INTERVAL_MS` (1000) and a subscription silent for
  `PROBE_DEAD_MS` (3000) exits `'input-dead'` (a new
  `TickerResult.reason`) and hands off; a THROWN checkpoint read is retried
  three times and then gives up rather than starting fresh; a renew interval
  runs from the acquire through setup to the loop; ownership is dated from the
  renew ATTEMPT; the checkpoint write is owner-checked and a refusal IS a lost
  lease; `busSuspect` on the shared client's `'reconnecting'` forces one awaited
  renew before the next publish, and that listener is `redis.off`'d on EVERY
  exit; `ticker.lease-lost` carries `meta.finder`
  (`guard`, `renew`, `checkpoint`, `setup`); a `leave` is gated on the relay
  connection id and the `room-reject` the ticker publishes CARRIES that same
  `c` (omitted when the join had none), so a pid deliberately holding two live
  sockets through a swap loses only the one that was refused;
  `present` follows `presentPids` through `reconcileMembership`;
  a pid whose join heartbeat stops for `presenceTimeoutMs`
  (`PRESENCE_TIMEOUT_HEARTBEATS` of `JOIN_HEARTBEAT_MS`, so 5000, and at least
  three relay heartbeats by construction) gets a synthesised leave; a buffer that still holds entries
  reports `onStarve` at streak 1 rather than ramping the decay; a roster publish
  the bus rejected re-dirties `metaDirty`; a STANDBY successor is spawned
  `standbyLeadMs` before the cap and the exit spawn is then skipped; and the
  input window is pushed into the playout buffer NEWEST FIRST once the buffer
  has consumed at least once. Exports `HostTickerOptions`, every option a HOST
  owns, for the adapters to spread.
  SEVEN MORE FROM THE VERIFIER ROUND, all in the same file. A restore reads the
  checkpoint's `gridAt` and CONTINUES the grid at `gridAt + tickMs` when that
  lands inside the adoption window (one tick ahead, `GRID_CATCHUP_TICKS` behind,
  and see the asymmetry invariant), so `serverTime` runs on one timeline
  across a planned handoff; every checkpoint including the final one records
  `lastScheduledAt` rather than a clock read. Checkpoint writes are serialised
  through ONE promise chain (`queueCheckpoint`) and the final write awaits it,
  because `writeCheckpoint` gzips before it issues its `SET`. Every pre-loop
  exit goes through `abandonSetup`, which runs the loop's own teardown
  (subscriber disconnected, `dispose` called, listener detached, lease released
  where releasing is right); the setup-lease-loss path used to leak the
  subscriber and skip `dispose` entirely. A setup renew that replies false sets
  BOTH `setupLostLease` and `lostLeaseExplicitly`, so a reply landing after the
  interval was cleared still ends the run rather than being discarded. The
  lifetime (`tickerShouldExit`, `uptimeMs`) is measured from INVOCATION ENTRY,
  which is what the platform's own cap measures; only the OWNERSHIP clock is
  dated from the acquire attempt, and a standby's poll comes out of the same
  `maxRunMs` budget. `standbySpawned` is set on ISSUE and cleared on REJECT
  (a spawn request to a ticker endpoint does not respond until the successor
  exits minutes later, so setting it on resolve would never fire) with
  `standbyRequested` gating the re-fire, and a rejected standby no longer
  suppresses the exit spawn. And an UNSTAMPED record discards the stamped
  records EARLIER in its own window, which is what keeps the two-pass push
  faithful to the single pass it replaced; `targetTick` must be a finite
  positive INTEGER to count as stamped at all.
  SIX MORE FROM THE COMPLETENESS ROUND, and four of them are about the
  timeline. The grid adoption window is ASYMMETRIC: one tick ahead of now and
  `GRID_CATCHUP_TICKS` (2) behind it, because behind is where a handoff
  actually lands and a symmetric window turned the case the mechanism exists
  for into the fallback it exists to avoid. Outside the window the local clock
  PACES the grid and a constant `stampOffset` carries the TIMELINE, so a
  successor whose clock runs behind its predecessor's can no longer stamp
  before the predecessor's last frame (measured at 39ms backwards on a 40ms
  skew, two seconds on a 2s skew). `roomKeys.timeline` is written from
  `lastStampedAt` BEFORE the lease is released on an error exit, applied at
  restore as `max(gridAt, timeline)` whether or not a checkpoint restored, and
  deleted after any final checkpoint. And the crash record (`INCRBY` then
  `EXPIRE`) is AWAITED inside the error exit, raced against
  `CRASH_RECORD_TIMEOUT_MS` (500) exactly as the exit spawn is, so it is no
  longer post-return background I/O a platform can freeze. The other two are
  trust-boundary work on the input subscription: a `pid` must be a non-empty
  string of at most `MAX_PID_LENGTH` (128) to reach the roster at all, and a
  probe answer must satisfy `Number.isInteger(n) && n > answered && n <= sent`
  as well as naming this ticker's owner id. See the fuzz and forged-probe
  gotchas.
  AND FOUR MORE FROM THE ROUND AFTER IT, three of them about one constant.
  `playoutMaxAhead` defaults to
  `max(PLAYOUT_MAX_AHEAD, ceil(PLAYOUT_AHEAD_MS / tickMs))` with
  `PLAYOUT_AHEAD_MS` 2000, so it is TWO SECONDS OF THIS ROOM'S TICKS: 40 at
  20Hz, byte-identical to before, and 120 at 60Hz. The reason is that a
  TOLERANCE IS A DURATION and the old constant was a tick count, so one number
  meant three different things at three rates while what it tolerates did not
  change. BE PRECISE ABOUT WHO THIS IS FOR: `RoomConnection` was never near the
  old bound at any rate or latency, because the buffer measures from its
  consumed floor at ARRIVAL and the client's lead is RTT-compensated, so the
  round trip cancels and its stamps land within `PLAYOUT_MAX_AHEAD / 2` (20
  ticks) of the floor. It is a third-party client of the documented wire,
  stamping a full round trip ahead of the server's current tick, that the old
  constant refused sooner at 60Hz than at 20Hz. Refusals are counted on
  `RoomStats.refusedInputs`, the too-far-AHEAD case only: a sender running
  behind is never refused, its stamps are applied at the next consume and show
  on `lateInputs`. `room-reject` is rate limited to one per pid per
  `REJECT_INTERVAL_MS` (1000) with the suppressed ones on
  `RoomStats.rejectsSuppressed`, because the frame rides the roster broadcast
  and is answered off a join. And `reconcileMembership` now drops the playout
  buffer, the starvation streak, `lateSeen` and `rejectedAt` for any pid
  `presentPids` stops reporting, not only for one a leave arrived for: a grace
  runtime never emits a leave for the player it eventually forgets. See the two
  invariants above.
  AND THE EXIT SPAWN HAS A NAMED BUDGET NOW, `EXIT_SPAWN_WAIT_MS` (3500), where
  it used to race a bare `sleep(2000)`. The number is not a preference about the
  handoff, it is a COUPLING: a host decides delivery on its own timer (the
  Vercel adapter's `SPAWN_ACK_MS`, 3000), so a ticker that gives up sooner never
  observes the answer it is waiting on. At 2000 the race was decided first every
  time, which made `ticker.spawn-failed` unreachable for an exit spawn on that
  host, and the exit spawn is the ONLY spawn on the `'lease-lost'`,
  `'input-dead'`, `'empty'` and refused-standby paths, so its rejection is the
  only line anywhere that says the room has no ticker there. 3500 is 3000 plus
  500ms for the promise hop and timer slop, and the extra 1500ms comes out of
  `TICKER_EXIT_MARGIN_MS` (30s), which clears the new total by an order of
  magnitude. THE COUPLING IS PINNED BY A TEST RATHER THAN BY AN IMPORT, because
  the ticker must not depend on an adapter: `vercel.test.ts` asserts
  `SPAWN_ACK_MS` is below `EXIT_SPAWN_WAIT_MS` with at least 500ms of margin,
  and `ticker.test.ts` writes the host receipt as the LITERAL 3000, since a
  delay derived from the constant would move with the mutation and pin nothing
  (3500 back to 2000 reddens all three of the new cases).
  `TickerOptions.spawnSuccessor`'s doc states the delivery contract it has
  always had: resolve once the request has been DELIVERED, reject only when it
  never left, never await the response (which is the successor's whole life),
  and the library never aborts the request it issued, it only stops waiting.
  `EXIT_SPAWN_WAIT_MS` is exported so the test can pin it and deliberately NOT
  re-exported from the server barrel: it is a coupling to check, not a knob to
  turn.
- `src/server/relay.ts` - `attachRelay`, `checkAdmission`, `HostRelayOptions`.
  One socket to the bus, and now also a CONSUMER of the control plane: a
  `room-reject` naming its own pid ends this socket rather than being forwarded,
  and a client `ping` is answered here without a Redis round trip. It bounds its
  own subscribe (`subscribeTimeoutMs` 5000), DROPS snapshots under transport
  backpressure (`snapshotBacklogBytes` 32768) while forwarding every `metaout`
  frame unconditionally, holds off repeat spawns (`spawnHoldoffMs` 5000),
  announces `relay-expiring` and closes 4004 at `lifetimeMs`, checks
  `readyState` at attach (CLOSED runs cleanup at once; CONNECTING defers the
  first join, the seed and the timers to `'open'`), runs `cleanup` itself after
  `terminate()`, uses ONE `messageBuffer` listener for both channels, and stamps
  its own connection id `c` on every join and leave. `RelaySocket` gained
  `bufferedAmount?` and the `'open'` event.
  SIX MORE FROM THE VERIFIER ROUND. A socket attached while CONNECTING gets an
  OPEN DEADLINE (`subscribeTimeoutMs`) beside the `'open'` listener, and one
  that never opens is cleaned up (`relay.open-timeout`) instead of leaking its
  subscriber, its cap slot and its heartbeat until the function's own cap.
  Control frames produced before OPEN are QUEUED (`CONTROL_QUEUE_MAX` 8,
  newest kept) and flushed on open, `seedRoster` goes through that same path,
  and nothing is logged per frame. Send failures on an OPEN socket are counted
  and flushed once per heartbeat (`relay.send-failed` with a `count`), and
  `SEND_FAILURE_LIMIT` (3) consecutive throwing sends terminate the socket and
  run cleanup. A fragmented ping (`ws` hands over a `Buffer[]`) is intercepted
  when the parts total under 128 bytes, because a peer chooses its own
  fragmentation and missing that arm routes a ping into `decodeInput`. A
  `room-reject` carrying `c` must match THIS relay's own connection id; one
  without `c` still matches on pid alone, which is an older ticker. And
  `handle.close()` resolves ONE code for both halves, so `onClose` and the wire
  no longer disagree (a bare `close(undefined)` is 1005 to `ws` and was 1000 to
  the host). `DEFAULT_CONN_STALE_MS` (30s) is exported from here for
  `admission.ts` to assert its own constants against.
  FIVE MORE FROM THE COMPLETENESS ROUND. A THIRD SUBSCRIBED CHANNEL,
  `{ns}:{roomId}:relay:{conn}`, is this socket's own liveness probe: one
  `PUBLISH` per heartbeat per socket, `PROBE_MISS_LIMIT` (3) unanswered plus
  the beat that notices logs `relay.subscriber-dead` once, terminates and runs
  `cleanup(4004)`. Per connection because a shared channel is quadratic in room
  size AND lets a healthy subscriber answer for a dead one; bounded by
  `Number.isInteger(n) && n > answered && n <= sent` because the channel name
  is derivable from the `c` this relay publishes in the clear. THE ROSTER
  CHANNEL HAS AN ALLOWLIST rather than a passthrough: `meta` and any frame `t`
  this library does not define forward, `room-reject` is consumed and aimed on
  pid AND `c` (where only `undefined` means unspecified, since a
  `typeof === 'string'` test read a wrong-typed `c` as absent and closed both
  of a swapping player's sockets), and the four per-socket `SERVER_FRAMES` are
  dropped and counted, flushed as `relay.misaddressed-frame` on the heartbeat.
  The pong reply goes through `rawSend`, so a failing pong counts toward the
  consecutive-failure run and a delivered one clears it. The 128-byte ping cap
  applies on the STRING arm as well as the buffer arms, so the boundary is a
  property of the frame rather than of the transport. And the roster seed map
  is built with `Object.create(null)` with only plain-object values accepted,
  because `map['__proto__'] = ...` on an object literal reparents the object:
  that player vanished from the seed while the ticker's own
  `Object.fromEntries` broadcast still carried them.
  AND THE LIVENESS DEADLINE ITSELF WAS WRONG, which is the round after that.
  `DEFAULT_LIVENESS_TIMEOUT_MS` is exported from here and is 90_000, not 45_000:
  a tab hidden past five minutes gets one Chromium timer callback a minute, so a
  client pinging every 2s sends one frame a minute and the old deadline reaped
  it on a healthy socket. `RelayHandle.transportPings: boolean` reports whether
  the transport supplied a `ping()` at all, and a relay attaching to one that
  did not logs `relay.no-ping` once at attach, because `socket.ping?.()` is a
  silent no-op and the fallback regime it leaves the deadline running in was
  otherwise invisible. See the two liveness invariants.
  AND IT NOW SAYS WHICH SIDE OF ITSELF A SNAPSHOT GAP CAME FROM, which is the
  instrument the deployment's pub/sub tail had no way to name. Per socket the
  relay measures the inter-arrival gap on its OWN subscriber (`busGapMax`, and
  `busGapOver150`, which carries its threshold in its name because that is the
  field name on the line too) and the time from a bus arrival to the send
  returning (`sendLagMax`), per heartbeat window, and logs ONE `relay.gaps`
  line at info only when `busGapMax` is over 150 or `sendLagMax` over 50, so a
  healthy socket stays silent like every other summary on this file.
  `RelayHandle.gapsSample()` exposes the window in progress for a host that
  wants the numbers on its own cadence. See the attribution invariant for how
  to read one of those lines against a client's own gap.
- `src/server/memoryRedis.ts` - THE IN-MEMORY REDIS, AND IT SHIPS. `MemoryRedis`
  is the former test fake under its real name: three plain Maps (strings, hashes,
  sorted sets) plus a pub/sub bus, shared through a `Hub` so `fork()` hands back a
  second client on the same store the way a command connection and a subscriber
  connection share one logical database. It runs three scripts (the renew, the
  release, and the owner-checked SET), and `on()`/`emit()` let a test drive the
  connection-lifecycle events `RedisLike.on?` exposes. `createMemoryRedis()`
  returns `{ redis, createSubscriber }`, exactly the pair `getRedis()` and
  `createSubscriber` hand out, so a host running ONE PROCESS with no Redis beside
  it passes that pair to `attachNodeRelay` and `runNodeTicker` and changes nothing
  above the seam. It moved out of `testFakeRedis.ts` because the only thing that
  made it test-only was WHERE IT LIVED, and a library that keeps its own working
  implementation out of the package leaves that host to rewrite it; it is still
  the client every unit test runs against, from this one file rather than a copy,
  so what a consumer gets is what the suite exercises thousands of times a run.
  IT IS EXPORTED TWICE, DELIBERATELY. From `tickroom/server` with everything else,
  and from the subpath `tickroom/server/memoryRedis` (`package.json` `exports`),
  which is the one to recommend: the barrel imports `ioredis` at module top, so a
  no-Redis consumer reaching the thing that exists to avoid Redis would load Redis
  to get it. `dist/server/memoryRedis.js` has no ioredis import, which is the
  check that makes the subpath worth having rather than decorative.
  FOUR DELIBERATE GAPS, stated on the file rather than left for a host to find:
  `eval` matches the library's three scripts BY SHAPE; `expire` only touches
  strings, because the meta hash and the conns zset take no TTL in this library
  and are drained by `hdel`/`zrem` instead; `publish` delivers SYNCHRONOUSLY in
  the publisher's own stack; and there is no `unsubscribe`. The trade a single
  process makes is on `createMemoryRedis` itself, in the README's "One process, no
  Redis" and in `examples/node-server/README.md`'s "Without Redis": no horizontal
  scale, no survival of the process (wrong on serverless by definition, since the
  successor invocation is a different heap), and a lease that is a re-entrancy
  guard rather than a split-brain guard.
- `src/server/testFakeRedis.ts` - ONE LINE now,
  `export { MemoryRedis as FakeRedis }`. It is the name every test file in this
  package already imports the in-memory client under, kept as an alias rather
  than a copy: a divergence between the fake the tests trust and the client
  consumers get would be invisible from either side. Still excluded from
  `tsconfig.build.json`, so the alias is not part of the package surface even
  though the implementation it points at is.
- `src/server/balancer.ts` - `assignRoom`. Packs joiners into the lowest-index
  room with space. `BalancerOptions.exclude` takes `string | string[] | null`
  now rather than one id, each entry validated on its own against the base so a
  stale one is ignored without taking the good ones with it. That widening makes
  "every instance is excluded" an ORDINARY outcome of a client walking the pool,
  where it used to be unreachable: both degenerate branches (the `mget` failure
  path and the every-candidate-full path) hand back an excluded room rather than
  manufacturing a `full` about a room whose capacity was never read.
- `src/client/netPolicy.ts` - `stallDecision`, `shouldReanchor`. Pure, so the
  thresholds are pinned by tests rather than only described. They cannot be
  exercised through `RoomConnection`, which needs a live socket to reach these
  states, which is exactly why they live apart. `shouldReanchor` is now
  TWO-SIDED: unbounded-ahead past `PLAYOUT_MAX_AHEAD / 2` fires immediately and
  is deliberately ungated, while `REANCHOR_TOLERANCE_TICKS` (2) of error in
  EITHER direction fires at most once per `REANCHOR_MIN_INTERVAL_MS` (2000) and
  not at all while the caller's server clock is mid-step (`clockStepping`). It
  takes `desiredTick`, never the raw server tick, and `lastReanchorAt` is
  documented and typed as `Number.NEGATIVE_INFINITY` for "none yet", never 0:
  `now` is a `performance.now()` reading and 0 is a real one.
- `src/client/errorOffset.ts` - `ErrorOffset`. Render-layer correction smoothing.
- `src/client/clientTick.ts` - the monotonic client tick. Anchored once per
  epoch, advanced in whole steps by `RoomConnection.frame()`. `anchorTo` is a
  bare `round(targetTick)` now: `ANCHOR_MARGIN` and `anchorMargin` are gone,
  because a lead that has to cover a MEASURED round trip cannot be a constant
  in ticks owned by a class that measures nothing. The lead lives in
  `RoomConnection.desiredTick()`. `ClientTickView` ALSO CARRIES `fraction`, the
  accumulator over the tick interval (0 inclusive to 1 exclusive, 0 before the
  first anchor and after any `anchorTo`), because the predicted entity has no
  interpolator: it advances only when a tick is stamped, so drawn raw at 60fps
  against a 20Hz counter it holds for three frames and jumps a whole tick of
  travel, reported as stutter on the player's own paddle the moment the
  stamping fix removed the rubber banding. `value - 1 + fraction` is the point
  one tick behind the newest stamp, and `PredictedEntity` aims its render
  playhead at it rather than drawing it directly (a counter jump is not time
  passing, see the gotcha). AND `tickMs`, the constant the counter was built
  with, documented beside `fraction` for the same consumer: the entity
  derives its timestep from it, which is what removed the `tickHz` option.
  Mutation-checked: `return 0` reddens 3 cases, a never-wrapping accumulator
  4, a wrap that subtracts one tick regardless of steps 1, an `anchorTo` that
  keeps the accumulator 1.
- `src/client/predictedEntity.ts` - `PredictedEntity<TInput>`, THE STAMPED
  PATH'S CLIENT HALF IN ONE OBJECT, and the way the pong example, the README
  quickstart and the bench page do prediction now. A consumer used to
  hand-write four coupled rules (stamp one record per tick and re-send a
  window; predict each through the shared pure step; replay the records with
  `targetTick > snap.tick` from every snapshot into an `ErrorOffset`, snapping
  on the first confirmation and past a distance; draw the owned entity
  between its tick states) plus an `onTickReanchor` handler to move the send
  mark and drop the window, and the reference example had two of the four
  wrong the day before this landed. OPINIONATED BY DECISION: the options are
  `conn` (structural, `{ tick: ClientTickView; send(payload: string) }`, so a
  test passes a fake and `RoomConnection` passes as is), `step`, `maxSpeed`
  and `initial`, and nothing else; THE TIMESTEP IS `conn.tick.tickMs`, read
  off the view, because a `tickHz` option was the one number a consumer could
  get wrong against the connection (it is gone). The API is
  `advance(input, dt)` once per frame after `conn.frame()` (stamps, sends,
  returns the pose to draw), `reconcile(pose, snapTick)` once per snapshot,
  `snapTo(pose)` for the jumps the GAME knows a glide is wrong for,
  `pose` (the raw prediction) and `stats` (`lastError`, `snaps`, `stamped`,
  `invalid`). `Pose` is `{ x, y, heading? }`, the fields `EntitySample`
  interpolates. The fixed decisions, as module constants: `INPUT_WINDOW` 6
  records re-sent per packet, `INPUT_HISTORY` 32 kept for the replay (the
  lead exceeds the re-send window on a slow link and a replay bounded by the
  window came up short on every snapshot there), a pose history one deeper
  (the pose after every held record plus the one they were predicted from);
  `RENDER_SLEW` 0.1 and `PLAYHEAD_SNAP_TICKS` 4 for the draw (below); glide
  taus 0.1, the per-frame position cap `maxSpeed * dt` PASSED THROUGH
  `sample` from each frame's own delta rather than baked at 60fps, heading
  cap 0.35 rad per frame, snap distance = offset cap = `maxSpeed * 0.5`; the
  wire is one JSON array of `{ targetTick, data }` sent as a STRING (the e2e
  harness already drives the relay with string frames, so the path is
  covered); heading by shortest arc and wrapped difference; the `ErrorOffset`
  `z` axis is `pose.y`. THE DRAW IS A PLAYHEAD, NOT THE COUNTER. `renderTick`
  (a float in the counter's tick units) aims at `tick.value - 1 + fraction`,
  one tick behind the newest stamp so it always sits on two stamped poses,
  and moves by each frame's own `dt / tickMs` scaled into `1 +- RENDER_SLEW`:
  never backward, never stopped, never clamped to the history's end. Past
  the newest STORED pose (where a backward re-anchor leaves it while the
  target catches up at nine tenths) it draws the SPECULATION: the newest
  stored pose stepped with the input this frame's `advance` was given, one
  tick at a time, at most `PLAYHEAD_SNAP_TICKS` deep (an anchored playhead
  further ahead than that has snapped; the bound is the belt for an
  unanchored one run ahead by a host's unclamped dt), rebuilt from the
  newest stored pose on every frame that needs it and empty on every frame
  of a steady counter, NEVER stored, replayed or sent, shifted with the
  history on a reconcile, and measured (as what the previous frame drew,
  never as the stored history clamped at its end) before it is rebuilt so an
  input that changed since it was built is carried by the offset; a target
  more than `PLAYHEAD_SNAP_TICKS` away in either direction is jumped to and
  counted on `stats.snaps`; while `tick.anchored` is false the playhead runs at real
  time and neither chases nor snaps, because `frame()` unanchors on a frozen
  loop and then advances the counter by its clamped dt in the same call
  before the next snapshot re-anchors it, and chasing that would count one
  tab switch as two snaps. The base is the history interpolated at the
  playhead (linear on x, y, shortest arc on heading, clamped to the oldest
  and newest pose outside it). RECONCILE shifts EVERY stored pose by the
  same delta, measures the correction at the playhead (drawn base before
  minus after), and gates the snap ON THE OFFSET THE ABSORB WOULD PRODUCE
  (`|offset + delta| > maxSpeed * 0.5` resets and counts), not on the size
  of the one correction, so nothing ever reaches `absorb` that its cap would
  trim. GUARDS: a `step` result that is not a finite pose, an authoritative
  pose that is not, or a replay that produces one is refused as a counted
  snap to the last finite authoritative pose (`stats.invalid` too), never
  absorbed, because NaN compares false against every gate and once absorbed
  never left; `advance(undefined)` (or a function, or a symbol) throws a
  `TypeError` naming the problem before any state moves, where it used to be
  a bare SyntaxError out of `JSON.parse` inside a rAF loop; a `dt` that is
  not a finite non-negative number is NO TIME (the playhead and the glide
  stand still for the frame, the stamps are whatever the counter shows),
  where `Math.max(0, NaN)` used to poison the playhead for good; and
  `stats.lastError` is 0 after a refused reconcile rather than the previous
  reconcile's number. RE-ANCHORS ARE HANDLED INSIDE: `tick.value + 1 <
  lastStamped` (a backward jump past one tick of slack) REWINDS the
  prediction to the stored pose after `value - 1`, moves the mark there and
  drops the records beyond it (they are re-sent fresh as the counter climbs
  back, and a playout push for a future tick the server already holds
  overwrites it), because a backward jump of k means those ticks have not
  happened yet on the server's timeline; the poses beyond the mark STAY as
  a speculative tail the playhead runs on through, a stamp for a tick
  already held overwrites it in place, and whenever anything drawn past the
  mark can change (a re-stamp that differs from the tail because the input
  changed across the jump, a stamp landing where a speculated pose was, an
  input that changed since the speculation was built) the draw is measured
  at the playhead before and after and the difference goes to the offset,
  the same rule `reconcile` uses. NOTHING IS RELABELLED. The first shape
  relabelled the history and left `curr` where it was, so the next stamp
  stepped from the pose after the OLD newest tick: a -3 under a held key
  reconciled 22.5 units out and stayed out until the dropped records aged
  out of the server's window. A forward jump larger than the history stamps
  the last `INPUT_HISTORY` ticks. EPOCHS: a false-to-true edge on
  `tick.anchored`, watched from BOTH `advance` and `reconcile` (the
  connection anchors and then hands the host the same snapshot, so the
  epoch's first reconcile lands before its first advance), drops the
  records, the poses, the mark and the playhead and unconfirms the entity,
  so the new epoch's first reconcile is a counted snap onto its truth
  rather than a 450ms glide from the old room's pose or a replay of 32
  stale records against a restarted count; and a snapshot more than
  `INPUT_HISTORY` below the oldest record held INSIDE an epoch (a count
  that restarted while the connection's rate-limited re-anchor had not
  caught up; the first snapshots of a fresh seat sit below every record by
  only the lead) is a counted snap too, not a replay. ONE PER CONNECTION: a
  module-level `WeakMap` from the `conn` object to its entity makes a
  second construction on the same connection a `RangeError` naming the
  rule, because the ticker keeps ONE playout buffer per pid and two entities
  overwrite each other's record for every tick. Each record keeps a JSON
  COPY of the input and predicts through the copy, so the replay is byte
  for byte what the server applied whatever the caller does to its input
  object afterwards.
  `snapTo(pose)` IS THE THIRD CALL AND THE ONLY ONE THE GAME DRIVES: a
  respawn, a teleport, a round reset. `reconcile` cannot tell one of those
  from an ordinary disagreement, so a respawn closer than `maxSpeed * 0.5` is
  glided like every other correction and the entity SLIDES to its spawn over
  half a second; this is the way to say it did not slide. It replaces the
  prediction, the pose history and the speculation with `pose` at the current
  mark, drops the offset, counts a snap, and unconfirms the entity so the
  server's own answer for the same event snaps onto the truth rather than
  gliding in from the pose the entity had before it. THE RECORDS ARE KEPT:
  they name ticks the server has still to apply and the next reconcile still
  has to replay them, so only the poses they produced are gone, and the
  playhead is left where it is, one tick behind the mark, which is where the
  reseeded pose sits. A non-finite pose is a `RangeError` rather than a
  counted refusal, because unlike a snapshot off a wire this is the host's own
  call with the host's own number in it. Call it from the game's own event,
  off the snapshot that carries it, BEFORE `reconcile` for that snapshot, and
  never per frame: a snapshot that merely disagrees with the prediction is
  what `reconcile` is for, and the glide is what makes an ordinary
  disagreement invisible. Pong does not use it, because no event in pong moves
  a paddle.
  `predictedEntity.test.ts` (57 cases) includes the input change contract
  end to end against a server model consuming the record stamped T on the
  step that produces T, with the historical off-by-one kept as the control
  (it reddens one tick of travel at exactly the three changes and nowhere
  else), AND THE RENDER CONTRACT against the REAL `ClientTick`, the REAL
  `PlayoutBuffer` and that server model on one wall clock (one-way delays,
  a lead, the connection's dt clamp, frozen-frame unanchor and two-sided
  re-anchor policy mirrored), asserting over every frame that the draw is
  finite, never steps backward (or reverses exactly as often as the input),
  never moves more than `1.1 * speed * dt` (plus one frame of glide where a
  scenario has corrections) outside a counted snap, and that the reconcile
  error returns to exactly zero after each disturbance: starts and stops,
  reversals, +3 and +2 re-anchors (caught up at a tenth over real time over
  30 and 20 ticks), a -1 anchor (its tick of wall time lost gradually, no
  hold, no step), -2 and -3 with the key HELD (exact at every snapshot, and
  from the jump until the playhead is back on target EVERY frame at nine
  tenths of the entity's speed, nothing under 0.85x, nothing over 1.1x, over
  about ten ticks per tick of jump, the total travel the raw travel less
  exactly the ticks the jump took), an input change while the playhead is
  on the speculation (the key released eight frames after a -3: continuous
  within one frame of glide at the frame it lands, and it lands as a glide
  of several frames, not a step; measuring the `before` against the stored
  history clamped at its end reddens it), a -5 with the key held (past the
  playhead snap threshold: one counted snap onto real history, the whole
  jump in that frame and exactly real time after), a -3 with the key
  RELEASED on the jump (the tail redrawn as a backward glide inside the
  glide bound, no backward frame beyond one frame of glide), the
  speculation's depth bound (an unanchored playhead run two seconds past the
  newest pose by an unclamped dt draws `PLAYHEAD_SNAP_TICKS` of speculation
  and no more, and released it draws the newest pose with the change carried
  by the offset), the double-step repro itself, a -20 (one counted snap,
  exact reconcile), a
  NaN/Infinity/negative `dt`, the one-per-connection guard, four epoch cases
  (same room, another room, the old records never replayed against a new
  count, a restarted count inside an epoch), a 70ms frame
  (ordinary motion), a late burst across a stop, a 450ms starve across a
  stop, a 2s frozen tab with the key released (exactly one counted snap)
  and held (a real two-second desync: every jump counted, the draw landing
  on the truth), the accumulate case (60 then 120 from 60: snap, not trim),
  NaN from `step` and from the snapshot, `advance(undefined)`, and 144 and
  30 fps exactness. Mutation-checked, 26 rows, 25 reddening (the first
  fifteen measured on the 40-case tree, the next eight on the 50-case one,
  the speculation's three and the two re-measured beside them on the
  53-case one): the backward rewind not rewinding `curr` 4, dropping the
  speculative poses 3, relabelling the history by the jump 4, the draw past
  the mark not carried to the offset 3 (was 1 on the 50-case tree), the
  speculation removed (the playhead is clamped at the history's end and the
  crawl returns: the 0.85x floor reddens on -2 and -3, the -1 anchor holds)
  4, the speculation unbounded (no `PLAYHEAD_SNAP_TICKS` cap) 1 (the depth
  bound case; the -5 case is invariant to it because the playhead snap
  fires first, which is why the bound has its own case), the `before`
  measured against the stored history clamped at its end rather than the
  speculation the previous frame drew 5 (the input change case among them),
  the `dt` guard removed 1, the one-per-connection guard removed 1,
  the epoch transition watch removed 1, the restarted-count rule removed 1,
  `lastError` left stale on a refusal 1; the slew
  removed (the draw follows the target) 8 (was 4), the slew allowed backward 1, the
  playhead snap threshold removed 3, the snap gate back on the per-reconcile
  distance 2 (the accumulate case among them), the NaN guard on `step`
  removed 1, on the snapshot removed 1, the timestep a number of its own
  rather than the view's `tickMs` 1, an unanchored counter chased and
  snapped like an anchored one 1, the history not shifted on reconcile 9,
  the JSON check after state
  moves 1, the playhead seeded at the newest stamp 7, the first pose not
  seeded 6, an invalid step resetting the offset but not the history 1. THE
  ONE EQUIVALENT MUTANT: measuring the correction at the newest pose rather
  than at the playhead reddens 0, because the history shift is uniform and
  the interpolation of a uniformly shifted trajectory shifts uniformly; the
  measurement at the playhead is kept for the reader and for any future
  non-uniform correction, not because a test pins it.
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
  reset. Three additions from the audit: `DELAY_SLEW_MAX` (0.08) caps the delay
  ease per unit of WALL TIME as well as shaping it, extrapolation is unwound as
  a per-entity GLIDE clamped to the interpolator's own overshoot (so a real
  teleport still snaps), and `FRAME_GAP_SLACK_MS` (100) is where a caller's
  clamped `dt` stops being believed for the speed smoother, which otherwise
  divides a real 30-second render gap by a quarter of a second.
  A FOURTH, FROM THE VERIFIER ROUND: `resumeFrom(held)` seeds a new epoch from
  the poses the host is still drawing, and is called IMMEDIATELY AFTER
  `clear()`, which is the whole of the ordering (clear drops the seed too, so
  seeding first seeds nothing). Each held entity's first render of the epoch
  begins at its held pose and glides onto the interpolated one over
  `EXTRAP_CAP_MS`, clamped by `RESUME_GLIDE_MAX_MS` (1000ms of that entity's
  measured speed) rather than by the extrapolation-unwind clamp, which would be
  zero here because nothing was extrapolated. The seed is consumed on first
  render and dropped at the next `clear()`, so a held entity that never comes
  back is retired at the next epoch instead of waiting forever. `DELAY_SLEW_MAX`,
  `FRAME_GAP_SLACK_MS` and `RESUME_GLIDE_MAX_MS` are all on the client barrel;
  a constant the tests reach through a deep import is a constant a consumer
  cannot reach at all.
  AND THE COMPLETENESS ROUND FOUND THAT CLAMP WAS STRUCTURALLY DEAD.
  `resumeFrom` read the entity's speed out of `this.motion`, which is the map
  `clear()` empties one line earlier in the documented call order, so every
  lookup returned `undefined`, every bound was `Infinity`, and a 5000-unit
  respawn rendered as a 4986-unit sweep at 33,000 u/s in the method whose own
  docstring promised a bound. The speed comes in ON the pose now (with
  `this.motion` kept as a genuine fallback for a host that seeds without
  clearing first), which costs the host nothing because `InterpolatedEntity`
  already carries `speed`: the map `frame()` handed back IS a valid argument.
- `src/client/connection.ts` - `RoomConnection`. Reconnect, re-mint, clock sync,
  protocol-skew recovery, stall observation, AND the two epoch-scoped components
  it owns: the tick counter and (optionally) a `SnapshotInterpolator`. Generic in
  the host's snapshot type and the interpolator's key type, both inferred.
  `frame()` is the ONE per-frame call. Also exports `RosterFrame`/`isRosterFrame`,
  the typed shape of the `onText` roster control frame. The audit added: session
  validation on `mint()`'s output; an attempt GENERATION counter so a stale
  attempt cannot tear down the live one; deadlines on `mint()` and the handshake
  (`connectTimeoutMs` 10000); a REAL round trip (`ping`/`pong` off the relay,
  reported as `stats().rttMs`); a monotonic-only server clock on
  `performance.now()` (64-sample window minimum, 5% slew, and a step escape);
  `desiredTick()` = `estimateServerTick() + rttMs/tickMs + ceil(inputLeadMs/tickMs)
  + feedbackTicks` with `inputLeadMs` defaulting to 150 (was 100: the
  consume-on-produced-tick fix took away the tick of arrival slack the
  off-by-one had given for free and starves went from about 3 to about 10 a
  minute on the deployment; one more tick of headroom at 20Hz gives it back at
  the same total latency, measured back to 8 in three minutes, see the gotchas);
  `onTickReanchor(delta)`;
  the two-sided re-anchor, decided against the counter PROJECTED by the time
  since the last `frame()` (`projectedTick`, capped at `TICK_STEP_CAP` and
  only once a frame has run this epoch), so a sub-frozen main-thread hitch
  is not read as drift while every other use of `tick.value` stays raw; an
  unanchor on a frozen render frame; the optional
  `inputLead` feedback loop; a WARM SWAP at the relay's lifetime cap (counted on
  `relaySwaps`); holding the last poses until the new epoch's first snapshot;
  terminals `'conn-limit'` (was `'rate-limited'`), `'connect-error'` and
  `'mint-failed'`; a 4001 before this epoch delivered anything read as a stale
  token that re-mints; `start({ remint })` after a terminal; `room-full`,
  `conn-limit` and an own-pid `room-reject` all latching AND closing;
  `ProtocolVersionError` (by name) triggering skew recovery; an
  `ArrayBufferView` sliced to its own window; and epoch-scoped gauges beside
  lifetime counters. `ConnectionStats` is what `stats()` returns; its current
  shape is two fields wider and is written out below.
  EIGHT MORE FROM THE VERIFIER ROUND, and the first two are ORDERING rules
  rather than features. `enterTerminal(reason, status)` latches, tears down,
  drops the held poses, settles the status, and calls `onTerminal` LAST, because
  the documented restart runs from inside that callback and `start()` reaches
  `new Impl(url)` synchronously. Every call out to host code goes through
  `emit()` (`onStatus`, `onStallChange`, `onTerminal`, `onTickReanchor`,
  `onText`, `onSnapshot`), and the close path schedules the reconnect BEFORE it
  announces the status. `rttMs` is a SLIDING-WINDOW MINIMUM over `RTT_WINDOW`
  (8) accepted samples, discarding anything above `RTT_MAX_SAMPLE_MS` (5000) or
  taken while the render loop was frozen. Once the server clock is seeded a
  snapshot more than `SNAPSHOT_TIME_PLAUSIBLE_MS` (60000) from `serverNow()`, or
  whose tick is more than `SNAPSHOT_TICK_JUMP_MAX` (1e6) from the last accepted
  one, is refused on `rejectedSnapshots`, and a run of
  `SNAPSHOT_IMPLAUSIBLE_REFUSALS` (3) is adopted as a new timeline. The first
  anchor of an epoch is PROVISIONAL with respect to the round trip it assumed
  (`anchorRttMs`): a pong that moves `rttMs` a whole tick away from it drops the
  rate limit so the next snapshot corrects it. `relay-expiring` is rate limited
  to one swap per `RELAY_EXPIRY_LEAD_MS` with the deadline floored at
  `SWAP_MIN_DEADLINE_MS` (1000). `beginEpoch()` calls
  `interpolate.into.resumeFrom(held)` immediately after `clear()`, with the
  poses `frame()` was drawing. And `lastReanchorAt`/`lastSwapStartedAt` are
  `Number.NEGATIVE_INFINITY` sentinels, never 0: see the sentinel invariant.
  SIX MORE FROM THE COMPLETENESS ROUND, and two of them are new public surface.
  `stats()` is `{ rttMs, jitterMs, snapshotsReceived, rejectedSnapshots,
  underrunRate, reconnects, relaySwaps, serverTickHz, hostErrors }`:
  `serverTickHz` is the sim rate MEASURED off consecutive snapshots as the
  median of a `TICK_RATE_WINDOW` (21) sample window, and
  `onTickRateMismatch(measuredHz)` fires ONCE PER EPOCH after
  `TICK_RATE_MISMATCH_RUN` (40) consecutive pairs disagreeing with the
  configured `tickHz` by more than `TICK_RATE_TOLERANCE` (0.2). Nothing adopts
  the measured rate; it is a report, not a correction. `hostErrors` counts
  every throw `emit()` swallowed plus one for `interpolate.entities` (guarded
  separately, because it has a RETURN VALUE and a throw has to skip the push
  specifically). The plausibility escape RE-ARMS at the adoption point:
  latched, 100 wild frames refused 3 and adopted 97, putting `tick.value` at
  -542716 and handing the host a 3.4e6 `onTickReanchor` delta. A pong is
  matched to an OUTSTANDING ping by its `n`, out of a map bounded by
  `RTT_WINDOW`, rather than timed against whichever send was newest. The
  reconnect ladder's four constants are exported from the client barrel:
  `RECONNECT_BASE_MS` (100) x `RECONNECT_FACTOR` (2) per attempt, capped at
  `maxBackoffMs` (5000), each delay times a jitter factor in
  `[RECONNECT_JITTER_MIN 0.5, RECONNECT_JITTER_MAX 1.5)`. And `WebSocketLike`'s
  four handler slots are `((ev: any) => void) | null`, which is what finally
  lets the DOM `WebSocket`, ws's class and Node's own global assign to
  `WebSocketConstructor` with NO cast: see the contravariance gotcha.
  TWO MORE COUNTERS AFTER THAT, and they make `stats()` eleven fields:
  `swapsAttempted` (warm swaps STARTED at a relay's cap) and `swapsFailed`
  (warm swaps that ended without delivering), both lifetime, with
  `swapsAttempted - relaySwaps - swapsFailed` 0 or 1 while one is in flight.
  They exist because the swap reuses the cached session, so a token whose
  `maxAgeS` is shorter than the relay lifetime chain has every replacement
  refused (401 before the upgrade, 4001 after it) and every cap silently back on
  a cold reconnect. `failSwap` (an `onclose`/`onerror` before delivery) sets
  `remintOnNextConnect` rather than clearing `this.session`, because the OLD
  SOCKET IS STILL OPEN in that window and both `frame()`'s `heldRoom` stamp and
  the own-pid `room-reject` guard read the session; the flag is consumed in
  `connectOnce`, immediately before the mint decision, which is the one place
  the ladder decides what to dial next. The deadline path keeps the session
  outright, because a slow answer says more about a cold relay start than about
  the token. Both go through `discardSwap`, which is where `swapsFailed` moves.
- `src/codec/bytes.ts` - `ByteWriter` / `ByteReader`. The reader is a TRUST
  BOUNDARY and bounds-checks every read, and the WRITER is one now too: every
  integer setter refuses a non-integer or out-of-range value with `CodecError`
  rather than letting `DataView` wrap it. Also `ProtocolVersionError`, a
  `CodecError` subtype carrying `expected`/`found` with
  `name === 'ProtocolVersionError'`, which is what `RoomConnection` duck-types
  on so a host's own codec can participate without importing anything.
- `src/codec/quantize.ts` - clamping (never wrapping) quantisation helpers,
  plus `representableRange(scale, field?)`, the startup-time check that turns
  the silent clamp into an assertion a host can fail on. `CM_SCALE` is
  exported so a host can name the default it is comparing against. `quantize`
  THROWS `CodecError` on NaN, which has no direction to clamp toward and which
  `DataView` would otherwise store as 0, i.e. a teleport to the world origin;
  `+-Infinity` still clamps, and `quantizeAngle` handles both explicitly before
  its modulo can turn them into NaN.
- `src/codec/snapshot.ts` - a batteries-included default codec plus the input
  redundancy window. `encodeDefaultSnapshot`/`decodeDefaultSnapshot` take an
  optional `DefaultSnapshotCodecOptions` carrying `positionScale`, which
  defaults to `CM_SCALE` so the existing wire is byte-identical. A pixel host
  passes 1 (+-32767 px at 1px); both ends must agree, and the bump that
  agreement implies belongs to the host. `encodeInputWindow`/`decodeInputWindow`
  take an optional `DefaultInputWindowOptions` carrying `axisScale`, defaulting
  to `AXIS_SCALE` (127) so the existing wire is byte-identical.
  `encodeDefaultSnapshot` THROWS `CodecError` on an entity id outside
  `0..65535`. `decodeDefaultSnapshot` checks the version FIRST, before a single
  field, and throws `ProtocolVersionError`; `decodeInputWindow` returns `[]` for
  anything that is not a buffer, because an input frame is one of many and a
  throw there is the relay's `onBadInput` path rather than a decode result.
- `src/adapters/vercel.ts` - Next.js App Router route factories. Takes
  `upgradeWebSocket` by injection; imports nothing from next or @vercel/functions.
  The option bags are now SPREAD from `HostTickerOptions`/`HostRelayOptions`
  rather than re-listed field by field, admission goes through `admitSocket`,
  and `maxDurationS` ties the library's lifetimes to the platform's cap:
  `maxRunMs = min(MAX_TICKER_MS, maxDurationS * 1000 - TICKER_EXIT_MARGIN_MS)`
  (30s margin) and `lifetimeMs = maxDurationS * 1000 - RELAY_EXIT_MARGIN_MS`
  (10s margin). NOTE THE DIRECTION ON THE TICKER: the platform cap only ever
  LOWERS the lifetime, so 700s stays the default and a host raising
  `maxDuration` does not silently get longer tickers out of it. The spawn URL
  carries `standby=1` and the route maps it to `STANDBY_WAIT_MS` (8000), which
  has to exceed the incumbent's `standbyLeadMs` (3000) plus its final checkpoint
  and release, and has to fit inside `maxRunMs`.
  `tickerRouteConfig`/`relayRouteConfig` ARE DOCUMENTATION, NOT SOMETHING A
  ROUTE FILE RE-EXPORTS: Next's route-segment-config parser reads `runtime` and
  `maxDuration` out of the route file's SOURCE TEXT at build time, so
  `export const runtime = tickerRouteConfig.runtime` fails `next build` on both
  Turbopack and webpack ("can't recognize the exported `runtime` field").
  The route file writes the literals itself and passes the same number as
  `maxDurationS`; the config objects exist so a host has one place to read the
  numbers from. The README quickstart used to instruct the re-export.
  BOTH LIFETIMES NOW HAVE FLOORS AS WELL AS CEILINGS: `MIN_TICKER_RUN_MS`
  (10s) and `MIN_RELAY_LIFETIME_MS` (`2 * RELAY_EXPIRY_LEAD_MS + 1000`, because
  a lifetime has to hold the swap's own lead AND a lead of clearance before the
  next relay announces), checked on
  the RESOLVED value at route creation, because `maxDurationS: 10` derived a
  `maxRunMs` of -20000 and a `lifetimeMs` of 0, which announced and closed every
  socket at once, and an explicitly negative `maxRunMs` passed the fit check by
  arithmetic. NOTHING ESCAPES A PLATFORM CALLBACK either: the upgrade handler
  logs `relay.upgrade-threw`, closes 1011 and resolves, and every statement
  inside that catch is itself guarded, because a throwing host logger would
  re-raise the rejection being swallowed.
  TWO ADDITIONS AFTER THAT. `parseExcludeList` turns the balancer route's
  `?not=a,b` into the list `assignRoom` validates, trimming and dropping empty
  entries and capping at `MAX_EXCLUDE_IDS` (64) with the excess dropped rather
  than answered with a 400, since a client being bounced repeatedly is having a
  bad enough time already; the single-id form is byte-identical. And
  `logRoomNormalised` writes one `ticker.room-normalised` /
  `relay.room-normalised` warn per request, `{ room, meta: { raw } }` with the
  raw value truncated to 64 characters, only after the token check has passed
  and only when a non-empty `?room=` differs from the id that came out. It is
  the one tell that the three `maxRooms` options disagree: a balancer at 50
  against a relay at 4 hands out `lobby~7`, the relay replaces it with the
  fallback, and the player sits alone in a room while every signal on both ends
  reads healthy. Behind the token check because a line per request is a
  log-volume amplifier until the requests are authenticated.
  AND BOTH SPAWNS WAIT FOR A RECEIPT NOW, NOT FOR AN ANSWER. `deliverSpawn`
  (`SPAWN_ACK_MS` 3000, the exported sentinel `SPAWN_DELIVERED`) resolves with
  the `Response` if one lands inside the receipt window, with the sentinel if
  none does, and REJECTS only for a failure BEFORE the receipt: DNS, TLS, a
  refused connection, which is the only kind of failure that means no ticker
  was started. A non-2xx is still handed back unread exactly as before, so
  Deployment Protection's silent SSO redirect stays as silent as it was. THE
  CONNECTION IS LEFT OPEN AND ONLY THE WAIT IS DROPPED, deliberately, rather
  than cut with `AbortSignal.timeout`: Vercel's request cancellation is opt-in
  per function path (`supportsCancellation`), so on a project that switched it
  on an abort at 3s would kill a successor 3s into a cold start measured at 5
  to 7 seconds, which is the same reasoning as the exit spawn's raced timer.
  The rejection handler stays attached for the request's whole life, because
  the headers timeout arrives 300s after this promise has settled and a
  rejection with no handler is a process-level event. `relay.spawn-failed` and
  `ticker.spawn-failed` now carry `outcome: 'rejected-before-ack'` and mean
  "this room has no ticker" and nothing else. See the gotcha for what they used
  to mean.
  AND `SPAWN_ACK_MS` IS PINNED UNDER THE TICKER'S OWN BUDGET, which is the half
  of that contract the adapter cannot state alone. `vercel.test.ts` asserts
  `SPAWN_ACK_MS < EXIT_SPAWN_WAIT_MS` with at least 500ms of margin, so raising
  the receipt window past 3000 fails here rather than silently making the exit
  spawn's rejection unreachable again; the ticker's entry above has the
  reasoning and the arithmetic. The assertion lives on this side because the
  ticker must not import an adapter, and 3000 is argued from DNS, TLS and the
  platform accepting the request rather than derived from the ticker's number.
- `src/adapters/node.ts` - the same server core behind a plain `ws` server, no
  serverless at all. Proves the design is not platform-specific. Derives its
  own option type from the Vercel one minus the three genuinely Vercel-route
  concepts, and no longer imports `registerConnection` from the other adapter.
  Its `'connection'` listener is guarded the same way as the Vercel upgrade
  handler, logging `node-relay.connection` and closing 1011. It carries its own
  copy of `logRoomNormalised` (eight lines, duplicated rather than imported,
  because an adapter must not depend on another platform's adapter; on a third
  host it moves to `core/ids.ts` beside `normalizeRoomId`).
- `src/adapters/index.ts` - DELETED. It was dead output: `package.json` names
  `./adapters/vercel` and `./adapters/node` as the entry points, so nothing
  could reach a combined barrel, and a barrel over two platform adapters would
  put both platforms in one import graph anyway.
- `examples/pong/` - THE SHIPPED STAMPED REFERENCE, and the claim
  "no shipped example stamps inputs end to end" is retired. `sim.ts` exports
  `readDir` and `stepPaddleY`, ONE definition of the paddle rule run by both
  ends, plus `usesPlayout` and an `onBufferHealth` that writes the server's
  playout depth into `PongState.depth` (deliberately NOT serialised: it
  describes the ticker that is exiting, not the room). `client.ts` IS IN TWO
  HALVES, AND THE SPLIT IS THE DOM. `createPongClient` is all of the netcode
  and none of the browser (the connection, the decode, the interpolator, the
  `PredictedEntity` and the `frame()`-then-`advance()` ordering the three
  depend on), and `startPong` is the canvas, the keys and the animation frame
  on top of it, about thirty lines of drawing. The split changes no behaviour;
  what it buys is that `tests/example.redis.test.ts` can drive THIS wiring
  through a real socket rather than a retyped copy of it, which is the only
  way the shipped example can be the thing CI checks. The prediction inside it
  is `PredictedEntity` and nothing else: one object built from `conn`, the
  shared `stepPaddleY`, `PADDLE_SPEED` and the spawn pose, one `advance` per
  frame, one `reconcile` per snapshot, and NO `onTickReanchor` handler at all,
  because the entity reads a counter jump off `tick.value` itself. The
  stamping, the six-record re-send window, the replay through an `ErrorOffset`
  and the draw between tick states that this file used to hand-write are the
  library's now, and two of those four rules were wrong here until the day
  before that landed. `codec.ts` is
  `PONG_PROTOCOL_VERSION` 2, because adding `inputLead` per paddle changed what
  the wire MEANS. `sim.test.ts` (23 cases) is the differential test: the
  client's `stepPaddleY` against the server's `applyInput` plus `tick` on the
  same stamped ticks, EXACT equality over 60 ticks, with a contrast case that
  applies the same records on arrival with a tick of jitter and asserts the
  traces DIFFER, so the first cannot pass vacuously.
- `examples/cursors/` - THE UNSTAMPED CONTRAST, deliberate and documented, with
  comments that point at pong rather than sketching the stamped shape
  hypothetically. `client.ts` TOOK THE SAME DOM SPLIT pong did, for the same
  reason and with no behaviour change: `createCursorsClient` is the connection,
  the decode, the interpolator, the labels, the roster, the held pointer state
  and the 100ms send loop that `stop()` clears, and `startCursors` is the
  canvas, the pointer listeners and the animation frame on top of it. The one
  thing the split had to add is a `decode` option, defaulting to the inline JSON
  decoder, because this example's wire IS the JSON `sim.ts` publishes and a
  consumer putting a codec on it should not have to fork the client to do it.
  New exported types beside it: `CursorsSnapshot`, `CursorLabel`,
  `PointerState`, `CursorsFrame`, `CursorsClient`. What the split buys is the
  same thing it bought pong: `tests/example-cursors.redis.test.ts` drives THIS
  wiring through a real socket rather than a retyped copy of it.
- `examples/node-server/README.md` - NEW, and it exists because a cold-start
  run measured 5 minutes 28 seconds to a first snapshot with the run command
  living only in a source comment that named the wrong port. It carries the
  exact command (`npm run example:node`), six env knobs (`REDIS_URL`,
  `SESSION_SECRET`, `PORT`, `TICKER_MAX_RUN_MS`, `STANDBY_MS`,
  `RELAY_LIFETIME_MS`, the last three all defaulting to today's behaviour), the
  session endpoint and socket URL shapes, a headless Node client, and recipes
  for watching a planned handoff and the relay's warm swap on a schedule.
  `examples/README.md` links it. The example itself wires `onBadInput` and
  `onRateDrop` into per-socket counters flushed every 10s, which is the shape
  every host should copy.
- `tests/faults.redis.test.ts` + `tests/helpers/proxy.ts` - integration file
  NINE, and the one that runs `runTicker` with the connection actually BROKEN
  rather than merely failing. The proxy is a real TCP proxy in front of Redis,
  because every fault here is a property of the SOCKET rather than of the Redis
  protocol and a fake sits on the far side of that socket: `.break(method)`
  makes a command FAIL, and it cannot make one silently never answer. Five
  cases: a black-holed subscriber with a healthy command client, a black-holed
  command client with a healthy subscriber, a lease theft with the predecessor
  still ticking, a Redis restart shape, and a deterministic crash loop. The
  proxy started inside `tests/subscriber.redis.test.ts` and was extracted
  unchanged, so a change to `holdRepliesMatching` has to keep that file green
  as well. IT GAINED `delayReplies(shape)` FOR THE SPLIT-BRAIN FILE: a latency
  DISTRIBUTION on the upstream-to-client direction (`delayMs(reply)` per reply
  chunk, plus an optional `onCommand` so a shape can key its delays off what
  was asked), read live rather than captured at the call, which is what lets
  one run be a steady 50ms, the next a steady 400ms and the next 1s spikes
  every third renew. `holdRepliesMatching` holds ONE command; this shapes
  every reply.
- `tests/example.redis.test.ts` - integration file TEN, and the one that
  closes "nothing in CI puts an example through a socket". It drives
  `examples/pong` UNMODIFIED: `pongRuntime` from `sim.ts` is the ticker's own
  runtime with `encodePongSnapshot` swapped in, so the pong binary codec is on
  the wire rather than only unit-tested; the relay is `attachNodeRelay` on a
  real `ws` server, so the token check, `normalizeRoomId` and the whole
  admission protocol are the adapter's rather than the harness's; and the
  client is `createPongClient`, the example's own DOM-free half, driven on a
  16ms timer instead of `requestAnimationFrame`. Nothing about the netcode is
  retyped in the test file. Measured: snapshot rate 19.67 to 20.33Hz over
  three seconds, our own paddle in every steady snapshot, the server's paddle
  111 unsaturated steps at a median and a maximum of exactly 90 u/s, reconcile
  error after the replay 0.0000 units, two goals decoded, `hostErrors` 0 and
  `badEnvelopes` 0. THE RECONCILE NUMBER IS THE ASSERTION THAT PINS IT, and it
  is not vacuous: the same run with the server's stamped playout disabled
  reads 9 units, one tick of travel rather than the codec's quantisation. CI's
  integration job collects it, because that job runs `vitest run tests`.
- `tests/splitbrain.redis.test.ts` - integration file ELEVEN, and the
  measurement the unplanned-death item had owed since the audit: how long a
  predecessor keeps PUBLISHING after a successor legitimately acquires, as a
  function of the renew round trips the predecessor was seeing, against a real
  Redis with the predecessor's command connection shaped by the proxy above.
  Eight cases per rep. The derived bound and the numbers are in the Owed list
  below; what belongs here is the rig. `TICKROOM_SPLITBRAIN_REPS` repeats every
  case, 1 in CI and 10 for the long form on a quiet machine. The lease is the
  same short 1500/400 `tests/faults.redis.test.ts` runs on, deliberately, since
  a shortened TTL is exactly the trade the measurement is for and the derived
  bound has no TTL term in it. EVERY OBSERVER AND THE SUCCESSOR CONNECT
  STRAIGHT TO REDIS: only the predecessor's command client is on the shaped
  path, built by the library's own factory so the `commandTimeout` in the
  bound is the shipped one, and the predecessor's subscriber is direct too, or
  the input-dead probe (3s) would end runs the lease guard is supposed to end.
- `tests/example-cursors.redis.test.ts` - integration file TWELVE, and the OTHER
  input path. File ten puts `examples/pong` through a socket and pins the
  STAMPED one; this is the same rig around `examples/cursors`, which declares no
  `usesPlayout` and leaves `targetTick` at 0, so every input takes the ticker's
  ON-ARRIVAL branch: applied the moment the envelope is drained, never buffered
  against a tick it names. That branch is the one the documentation recommends
  FIRST, because a presence layer is the shape most consumers arrive with, and
  until this file nothing that went near a socket exercised it. `cursorsRuntime`
  is the ticker's runtime unmodified and there is no codec to swap, because the
  JSON `encodeSnapshot` publishes IS this example's wire; the relay is
  `attachNodeRelay` on a real `ws` server; the clients are three headless
  `createCursorsClient`s driven on a 16ms timer. THE MEASUREMENT A STAMPED ROOM
  CANNOT STATE is the one it makes: how long after a client moves its pointer
  does the room's own snapshot show the pointer there. Across three runs,
  10.00Hz over three seconds and 81 to 194ms to the first snapshot carrying that
  exact coordinate (medians 97, 177 and 184), against a worst DERIVED from the
  wiring rather than picked (one send period plus one tick plus RTT, so 200ms)
  and asserted at 400. All three cursors in every steady snapshot and in every
  client's roster frame; 177 to 180 inputs decoded by the relay with
  `targetTick > 0` on ZERO of them, which is what proves the on-arrival branch
  is the one that ran; `hostErrors`, `badEnvelopes` and `starves` all 0, and
  `starves` can only be asserted zero HERE, because the on-arrival branch never
  creates a playout buffer to starve. NON-VACUITY IS ITS OWN ASSERTION: with the
  one `conn.send` inside `createCursorsClient` made a no-op, 11 of 11 steady
  probes never arrive and 0 of 13 coordinates are ever seen, while the rate, the
  roster and the zeroed counters all stay perfectly green. Every probe position
  is a coordinate the server has never held (the join seats a cursor at 0.5,
  0.5), so an arrival is proof the input crossed the wire and mutated the
  server's state. CI collects it, and `tests/helpers/env.ts`'s counting
  sentences say TWELVE files now.
- `tests/memory.test.ts` - THE ONE FILE IN `tests/` THAT NEEDS NOTHING, which is
  why it is named without the `.redis` and why it never skips. It is file ten's
  shape with the bus swapped out: `createMemoryRedis()` supplies the command
  client and the subscriber factory and BOTH halves of the host get the same
  pair, the ticker is `runNodeTicker` and the relay `attachNodeRelay` on a real
  `ws` server, the runtime is `pongRuntime` unmodified with JSON snapshots
  exactly as `examples/node-server/server.ts` wires it, and the client is
  `createPongClient` on a 16ms timer. It pins the two things a memory bus can
  get silently wrong: that snapshots FLOW (81 of them, so a publish really does
  reach a subscriber forked off the same store) and that STAMPED INPUTS LAND
  (reconcile `maxError` 0, `hostErrors` 0). `REDIS_URL` IS DELETED FOR THE WHOLE
  RUN, deliberately: `resolveUrl` in `server/redis.ts` throws without it, so any
  path still reaching for `getRedis()` fails loudly rather than quietly opening
  a connection to whatever is listening on 6379, which is what makes "no Redis
  anywhere" an assertion rather than a hope. The mutation is a subscriber built
  on a DISJOINT store, and it reddens it.
- `tests/helpers/jitter.ts` - HOW LATE THIS HOST ACTUALLY FIRES A TIMER,
  twelve samples of a 25ms `setTimeout` reported as a factor, taken once per
  worker. An idle machine reads 1.05 to 1.10 rather than 1.00, because node's
  own per-timer overhead is a millisecond or two, and `JITTER_LIMIT` is 1.5.
  It gates the two wall-clock files whose headline claims are zero-or-not
  properties (`smoothness.redis.test.ts`, and three fixed-window cases of
  `ticker.redis.test.ts`): over the limit they SKIP LOUDLY, naming the number
  they measured, rather than loosening a bound of zero that cannot honestly be
  loosened. A skip is a worse outcome than a pass and a better one than a red
  that means nothing. See the gotcha on WHERE that calibration is taken.
- `tsconfig.json` - `exactOptionalPropertyTypes` is ON, for the consumer's sake
  rather than for ours. See the Gates section.

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
- A LIVENESS DEADLINE IS SIZED AGAINST THE SLOWEST CADENCE A HEALTHY CLIENT CAN
  HAVE, NOT THE ONE IT ASKED FOR. The client picks a ping interval; the BROWSER
  picks the one it actually gets, and past five minutes hidden Chromium throttles
  a tab to one timer callback a minute, so a client pinging every 2s sends one
  frame a minute and `requestAnimationFrame` stops outright. At the old 45s
  deadline that reaped every backgrounded tab on a perfectly healthy socket.
  `DEFAULT_LIVENESS_TIMEOUT_MS` is 90_000 for that reason, above one throttled
  interval with slack, and it must stay above 60s for any browser client. The
  protocol pong is what makes a shorter deadline safe, because it is answered by
  the network stack below page JavaScript, so the deadline may only be shortened
  as far as the WORST transport in the deployment supports rather than as far as
  the best one does.
- AN OPTIONAL TRANSPORT CAPABILITY IS DETECTED AND REPORTED AT ATTACH, NEVER
  ASSUMED. `socket.ping?.()` on a transport with no `ping` is a silent no-op,
  which reads at every call site as a ping that went out, so the fallback path
  the deadline is actually running on is invisible. `attachRelay` tests for it
  once, logs `relay.no-ping` at attach when it is missing, and carries the answer
  on `RelayHandle.transportPings` so a host can see which regime its sockets are
  in. Any future optional method on a transport gets the same treatment: the
  no-op is not the bug, believing it worked is.
- A wire change bumps the protocol version when it changes MEANING, not only when
  it changes SHAPE. Re-ordering an enum moves no byte and is still a bump.
- Anything whose rate a client controls is COUNTED in process and flushed on a
  cadence the client cannot drive, never written to Redis or logged per message on
  the request that triggered it. Otherwise the rate limiter is an amplifier.
- AND A `room-reject` IS ONE OF THOSE PATHS, which is easy to miss because it
  looks like a reply rather than a broadcast. It goes out on the roster channel,
  so it fans out to every socket in the room, and it is answered off a join: a
  producer that can choose its join rate is choosing the room's broadcast rate
  too. One per pid per `REJECT_INTERVAL_MS` (1000), with the suppressed ones
  counted on `RoomStats.rejectsSuppressed` and reported on the flush like every
  other client-driven count. The rule is not "rate limit the noisy paths", it is
  that a fan-out obeys it exactly as a log line does.
- ANYTHING KEYED BY PID IS DROPPED WHERE `presentPids` STOPS REPORTING IT, NOT
  ONLY WHERE A LEAVE ARRIVES. A leave is one of the ways a player goes and it is
  not the reliable one: a runtime with a grace period never emits a leave for the
  player it eventually forgets, and a synthesised presence timeout is the room's
  own decision rather than a frame. `reconcileMembership` is the single place
  membership changes, so it drops that pid's playout buffer, its starvation
  streak, its `lateSeen` and its `rejectedAt` together. A map keyed by pid that
  is cleaned up on the leave path alone is a leak with a player's name on it.
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
- AND IT IS THREE LINES NOW: `beginEpoch()` CLEARS AND THEN RESUMES. The poses
  `frame()` was drawing are handed straight back with
  `interpolate.into.resumeFrom(held)`, immediately AFTER the clear, and the
  ordering is the whole thing because `clear()` drops the seed along with
  everything else. The connection is the one that can do it: the held poses are
  `frame()`'s own output and the moment they stop being valid is the epoch
  boundary, and an interpolator can neither produce the first nor see the
  second. Measured through a real socket on a 350ms outage: a 25 unit step at
  1500 u/s plus five motionless frames became a worst step of 4.47 units, a
  peak of 268 u/s and no motionless frames. It never runs on a first connect,
  because there is nothing on screen to resume from.
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
- NOTHING A HOST HOOK DOES MAY REACH THE LOOP. `guardHost` catches a throw AND
  attaches a `.catch` to anything thenable, because every `RoomRuntime` hook is
  declared `void` and an `async` method satisfies a `void` return perfectly: the
  promise is dropped, its rejection is unhandled, and a modern Node kills the
  process outright, so the room dies with no final checkpoint and no successor.
  `tick`, `currentTick`, `playerCount`, `encodeSnapshot`, `serialize`, `create`
  and `deserialize` stay UNGUARDED on purpose: those are not reached through a
  client-supplied payload, so a throw in one is a genuine loop failure and must
  stay one.
- A THROWN TICKER WRITES NO FINAL CHECKPOINT AND SPAWNS NO SUCCESSOR. The state
  at the moment of a throw is half-mutated by definition, so persisting it hands
  the successor the very bytes that killed this one. It releases the lease,
  increments `room:{id}:crashes`, and lets the relay's jittered poll pace the
  retry; three crashes inside the counter's TTL start the room fresh, loudly.
  See the crash-loop gotcha.
- THE CRASH WINDOW IS FIXED, NOT SLIDING, AND IT IS CLEARED BY UPTIME, NOT BY A
  CHECKPOINT. The `EXPIRE` runs only when the `INCRBY` came back 1, so the
  window is dated from the FIRST crash of a run: an `EXPIRE` per crash pushes
  the deadline out each time, and three unrelated throws 59s apart would then
  trip a limit that is supposed to mean three crashes inside one minute and
  wipe a healthy room. And the counter is cleared only once the invocation has
  itself run for `CRASH_KEY_TTL_S` of uptime, because clearing at the first
  checkpoint let any poison slower than `checkpointMs` escape the counter
  forever: measured at four invocations with the counter stuck at 1.
- EVERY PRE-LOOP EXIT RUNS THE LOOP'S OWN TEARDOWN. An `init` throw, a
  subscribe timeout, a checkpoint read that gave up, a setup throw and a setup
  lease loss all go through `abandonSetup`, which disconnects the subscriber,
  disposes the runtime, detaches the `'reconnecting'` listener and releases the
  lease where releasing is right. The setup-lease-loss path used to leak the
  subscriber (one live Redis connection per abandoned run, against a plan whose
  connection ceiling is the first wall this architecture hits) and skip
  `dispose` entirely.
- `serverTime` IS THE SCHEDULED GRID TIME, never a clock read taken after
  `runtime.tick`. That field is the axis every client interpolates remote motion
  on, so stamping it afterwards writes the tick's COMPUTE VARIANCE into the
  playback timeline.
- A CHECKPOINT WRITE IS OWNER-CHECKED IN REDIS, not gated on the local `owns`
  flag. The flag is a belief that lags reality by up to a renew period; Redis
  decides now, atomically, exactly as it already does for the renew and the
  release. A refusal IS a lost lease and exits the loop.
- CHECKPOINT WRITES ARE SERIALISED THROUGH ONE CHAIN, AND THE FINAL ONE AWAITS
  IT. `writeCheckpoint` compresses BEFORE it issues its `SET` and gzip time
  scales with the body, so two writes started in tick order reach Redis in
  gzip-completion order: a periodic write of a large room still deflating when
  the final write starts lands after it, and the successor restores the older
  state. Forced and measured with an 8MB body, where the successor restored
  tick 1. The chain costs nothing on the ordinary path (writes are a second
  apart and it is long settled) and makes the order the ROOM's rather than the
  compressor's.
- A CHECKPOINT CARRIES THE GRID IT WAS TAKEN ON, AND A SUCCESSOR CONTINUES IT.
  `gridAt` is the scheduled grid time of the tick the checkpoint describes, and
  a restore continues at `gridAt + tickMs` when that lands inside the adoption
  window, so `serverTime` runs on ONE timeline across a planned handoff.
  Both halves of that window are load-bearing: after a hard death the newest
  checkpoint is a periodic one the predecessor kept publishing past, and then
  `continued` is far behind now and the window refuses it, so the axis stays
  strictly increasing either way. Without it a handoff moved the timeline 20 to
  40ms earlier, cost 165 to 269 u/s for two or three frames, and walked the
  client's stamping lead down half to eight tenths of a tick per handoff
  (server depth 5 to 4 to 1 to 0 over three, measured end to end).
- THE ADOPTION WINDOW IS ASYMMETRIC, AND THE TWO SIDES ARE DIFFERENT FACTS.
  One tick AHEAD of now (a grid point simply not due yet, which the loop sleeps
  to, so one tick is all the slack there can ever be) against
  `GRID_CATCHUP_TICKS` (2) BEHIND it, which is where a handoff actually lands:
  the successor has to acquire, read, `deserialize` and subscribe first, and on
  a loaded machine that is routinely more than one tick after the predecessor
  released. A symmetric one-tick window turns exactly the case the mechanism
  exists for into the fallback it exists to avoid, and there is no middle value
  because the grid is either continued or restarted. Two, not three, because
  the loop's own drift rule resyncs past one tick of drift, so a wider window
  buys one stamp and abandons the grid anyway.
- AND OUTSIDE THE WINDOW THE CLOCK PACES THE GRID WHILE AN OFFSET CARRIES THE
  TIMELINE. Restarting the grid locally used to mean the first stamp was a bare
  `Date.now()` on a clock with no relationship to the predecessor's, so a
  successor running BEHIND stamped its first snapshot before the predecessor's
  last: 39ms backwards on a 40ms skew, two full seconds on a 2s skew. A
  backward step on the playback axis is not a stall to ride out, it is a
  timeline contradicting frames already in the client's buffer. Sleeping the
  skew off is not the fix either, because that hands the room a gap as long as
  the skew. So the first stamp is the later of the two clocks' opinions and
  `stampOffset` is added to every stamp after it: continuous and strictly
  increasing by construction, with a clock that is AHEAD getting an offset of
  zero and an ordinary forward step.
- AN EXIT THAT WRITES NO CHECKPOINT STILL OWES THE SUCCESSOR A FLOOR, AND THAT
  IS WHAT `room:{id}:timeline` IS. A thrown ticker leaves the last PERIODIC
  checkpoint standing and has already published past it, so a standby polling
  every 25ms adopts that grid point and republishes an identical
  `serverTime`/`tick` pair: 3 of 3 measured. The error exit therefore writes
  the last stamp to `timeline` BEFORE releasing the lease, because the instant
  the lease is free a standby can reach its own grid decision; a restore
  applies it as `max(gridAt, timeline)` whether or not a checkpoint restored,
  since "no checkpoint to continue" and "no timeline to stay above" are
  different questions; and any exit that DOES write a final checkpoint deletes
  the marker, because that checkpoint's own `gridAt` is the grid point of the
  state a successor will actually restore and is strictly better than a floor.
  Left behind, a marker from an earlier crashed invocation would raise the
  floor of every successor for a whole state TTL.
- AND THE CRASH RECORD IS AWAITED, NOT FIRE-AND-FORGET, because it is the last
  I/O on the crash path. Unawaited, the `EXPIRE` is not even ISSUED until the
  `INCRBY` replies, which is after `runTicker` has returned: a platform that
  freezes the instance the moment the handler resolves either loses the
  increment or lands the increment and drops the TTL, which is the crash-loop
  guard failing in both directions at once. Awaited and raced against
  `CRASH_RECORD_TIMEOUT_MS` (500), exactly like the exit spawn, so a slow Redis
  still cannot hold the exit open.
- THE INVOCATION'S LIFETIME IS MEASURED FROM INVOCATION ENTRY; ONLY OWNERSHIP
  IS DATED FROM THE ACQUIRE. `maxRunMs` exists to stay inside a cap the
  PLATFORM measures from the moment the request arrived, so a standby's poll
  comes out of the same budget rather than being free. Dating the lifetime from
  the acquire instead hands a standby that polled for eight seconds eight
  seconds it does not have.
- `standbyMs` MUST EXCEED `standbyLeadMs` PLUS THE INCUMBENT'S OWN EXIT, AND
  MUST FIT INSIDE `maxRunMs`. A standby spawned `standbyLeadMs` before the cap
  has to still be polling when the lease is finally released, which is after
  the incumbent's final checkpoint and release, not at the cap itself. The
  adapters use 8000 against 3000. `standbySpawned` is set on ISSUE and cleared
  on REJECT, because a spawn request to a ticker endpoint does not respond
  until the successor exits minutes later, so setting it on resolve would never
  fire at all; a rejected standby no longer suppresses the exit spawn.
- OWNERSHIP IS DATED FROM THE RENEW ATTEMPT, not from the reply. Redis extended
  the key when it PROCESSED the command, so crediting ownership from when the
  reply landed claims one reply delay more life than the key actually has.
  AND THE SPLIT-BRAIN MARGIN THAT BUYS IS MEASURED, NOT ARGUED, which is what
  this rule had been missing: `tests/splitbrain.redis.test.ts` derives the
  bound from this line plus `mayPublish` and `SET NX` and then measures it
  against a real Redis behind a shaped path. Every predecessor snapshot is
  ISSUED before a successor can acquire, and the renew round trip does not
  appear in that statement at all. The Owed list has the derivation and the
  numbers; what belongs here is that changing any of those three lines
  invalidates a measurement rather than an argument.
- THE INPUT WINDOW IS PUSHED NEWEST FIRST, but only after the first consume.
  Before then the buffer's ahead bound has no consumer floor to measure from and
  the first push establishes the reference itself, so newest-first would let one
  runaway far-future stamp refuse the legitimate near-term records in its own
  window. Two regimes, cleanly separated, not a trade-off.
- AN UNSTAMPED RECORD SUPERSEDES THE STAMPED ONES BEFORE IT IN ITS OWN WINDOW,
  which is what keeps the two-pass push faithful to the single pass it replaced.
  An unstamped input means the player stopped driving a stamped stream (a
  dismount, a mode switch), so the buffer is dropped; collecting the stamped
  records and pushing them at the end would let a record positioned BEFORE that
  unstamped one survive the transition it was supposed to be superseded by.
  Only records after the LAST unstamped one belong to the stream still running.
  And `targetTick` is stamped only when it is a finite POSITIVE INTEGER: the
  string "5" passes `> 0`, then keys the buffer by something no numeric consume
  can ever match, so the record starves every tick it should have fed.
- THE STEP THAT PRODUCES TICK T CONSUMES THE INPUTS STAMPED T. `currentTick`
  is the number of COMPLETED ticks (the label on the last snapshot), so the
  ticker's consume pass takes the stamp `currentTick + 1` and acks that same
  tick, then steps, and the snapshot labelled T already reflects the input
  stamped T. That is the exact set a reconciling client replays: its stored
  records with `targetTick > snap.tick`. The contract is stated once, on
  `RoomRuntime.currentTick` in `src/core/types.ts`, and pinned by the two
  `ticker.test.ts` cases under "the step that produces tick T", both of which
  redden with `consume(tickNow)` restored. Consuming the completed count
  instead applies the record stamped T to the step that produces the label
  T + 1, and see the steady-motion gotcha for why nothing noticed.
- EARLY IS NOT STARVED. A buffer that still holds entries has this player's
  inputs, stamped for ticks the room has not reached yet: nothing was lost, the
  two clocks simply disagree about where "now" is, which is exactly what every
  handoff produces. It is reported as a starve at streak 1 (repeat-last) and
  never ramps the decay. A genuinely EMPTY buffer keeps the streak, which is the
  sawtooth backstop `starvation.ts` exists for.
- A RELAY IDENTIFIES ITSELF (`c` on every join and leave), AND A LEAVE FROM A
  RELAY THE PLAYER HAS ALREADY REPLACED IS IGNORED. Sockets are swapped
  routinely and the order two relays reach the bus in is not guaranteed. A leave
  carrying no `c`, and one for a pid with no recorded `c`, are honoured exactly
  as before: there is nothing to contradict them with.
- `attachRelay` CHECKS `readyState`, NEVER ASSUMES OPEN. The caller awaited
  `checkAdmission` to get here, so the socket may already be CLOSED (cleanup runs
  at once) or still CONNECTING (the first join, the roster seed and the timers
  are deferred to `'open'`).
- A DEFERRAL NEEDS A DEADLINE, AND A CONTROL FRAME PRODUCED BEFORE OPEN NEEDS A
  QUEUE. Deferring to `'open'` is only correct if `'open'` is guaranteed, and it
  is not: a socket that never opens held its subscriber, its cap slot and its
  heartbeat until the function's own duration cap, so the CONNECTING path arms
  an open deadline (`subscribeTimeoutMs`) and cleans up on `relay.open-timeout`.
  The frames produced in that window are queued rather than attempted (a send in
  CONNECTING throws on `ws`, one `relay.send-failed` line per frame for a socket
  that had done nothing wrong) and rather than dropped (a roster seed is
  announced once and nothing repeats it): newest `CONTROL_QUEUE_MAX` (8),
  flushed on open, nothing logged per frame. `refuseSocket` gets the same
  treatment from the other side: an `'open'` listener beside the immediate
  attempt and the 250ms retry, because a handshake completing at 300ms was
  never refused at all.
- A RUN OF FAILING SENDS IS A DEAD SOCKET, AND ONE FAILING SEND IS NOT. Send
  failures on an OPEN socket are counted and flushed once per heartbeat
  (`relay.send-failed` with a `count`), on exactly the rule the rate limiter
  and the ticker's own summaries already follow; `SEND_FAILURE_LIMIT` (3)
  consecutive throwing sends terminate the socket and run cleanup, because at
  that point the transport is telling us the same thing three times and holding
  the slot open costs the room.
- THE SNAPSHOT FORWARD MAY DROP; THE `metaout` FORWARD MAY NOT. A snapshot is
  full state and the next one supersedes it, so dropping costs nothing the next
  tick does not repair. A roster change is announced exactly once and nothing
  repeats it.
- BUT THE `metaout` FORWARD IS AN ALLOWLIST, NOT A PASSTHROUGH, AND THAT IS THE
  OTHER HALF. The roster channel is a BROADCAST and four of the library's own
  `SERVER_FRAMES` (`room-full`, `conn-limit`, `relay-expiring`, `pong`) are
  per-socket facts only the relay holding that socket may originate, so an
  instance of one arriving there is misaddressed by construction. Forwarded
  verbatim, ONE `{ t: 'room-full' }` on that channel latched every client in
  the room into a terminal capacity state and closed their sockets: measured on
  an innocent client from a single frame. They are dropped and COUNTED, flushed
  once per heartbeat as `relay.misaddressed-frame`, because the publisher
  chooses the rate. A host's own control traffic (any `t` this library does not
  define, and anything that is not JSON at all) still forwards untouched, which
  is what keeps this a filter rather than a cage: the roster channel is the
  seam the library gives a host for exactly that.
- A RELAY PROBES ITS OWN SUBSCRIPTION, SAME MECHANISM AS THE TICKER'S AND FOR
  THE SAME REASON. A subscriber black-holed AFTER a successful subscribe
  produces no event at all: ioredis never reconnects so `'end'` never fires,
  the resubscribe never happens, and the inbound liveness check measures only
  what the CLIENT sends, which a healthy chatty player keeps doing. Measured
  behind a black-holing proxy: zero frames, no log, no close, forever, bounded
  only by `lifetimeMs` where a host sets one and by nothing at all on the node
  adapter. So a third channel per connection,
  `{ns}:{roomId}:relay:{conn}`, one `PUBLISH` per heartbeat, and
  `PROBE_MISS_LIMIT` (3) unanswered plus the beat that notices terminates the
  socket. PER CONNECTION, not per room: a shared channel is quadratic in room
  size and, worse, lets a healthy subscriber answer for a dead one, which turns
  the one signal built to catch this into the thing hiding it. Same argument as
  the owner filter on the ticker's own probe.
- A PROBE ANSWER IS BOUNDED BY WHAT WAS SENT, NOT MERELY MONOTONIC, on both
  probes. The relay's channel name is derivable from the `c` it publishes in
  the clear on every join, and the ticker's owner id is the lease value every
  relay can read, so anyone who can write to the bus can address either. One
  forged `n` of 1e15 against an unbounded `n > answered` pins the counter above
  every `n` the watchdog will ever reach and disables it for the rest of the
  run: measured, the control exits `'input-dead'` in 3.0s and the poisoned one
  holds the room to its full lifetime cap with its inputs going nowhere. The
  test is `Number.isInteger(n) && n > answered && n <= sent`, which caps a
  forgery at the current beat. A reply to a question nobody asked is not an
  answer.
- A GAP IS ATTRIBUTED BY WHICH SIDE OF THE SOCKET SAW IT, AND ONLY THE RELAY
  CAN SAY. A client measuring its own snapshot arrivals cannot tell a slow
  ticker, a slow bus, a paused function and a slow socket apart, which is why
  the deployment's 250 to 433ms band sat unattributed for two days with an
  in-function Redis probe reading a p99 of 2.35ms. The relay measures the
  inter-arrival gap on its own subscriber and the bus-arrival-to-send-returned
  lag per heartbeat window and logs `relay.gaps` only past the thresholds
  named in its file-map entry, so THE READING RULE IS: a `relay.gaps` line
  whose `busGapMax` matches a client's gap puts the cause UPSTREAM of the
  socket (the ticker, the bus, or this function being paused), and a client
  gap with no relay line beside it is the socket path itself. The line is
  silent on a healthy socket by design, so its absence is half the reading and
  not a missing measurement.
- A REFUSAL NEEDS TWO LATCHES, BECAUSE THE FRAME AND THE CLOSE ARE DIFFERENT
  PROMISES. `refuseSocket` keeps `frameSent` and `socketClosed` apart: one
  combined "already refused" flag, set before the send or set by the catch,
  makes a THROWING send read as a completed refusal. Measured on a socket whose
  `send` throws, the close codes after 320ms were `[]`, so the connection was
  open, unrefused and relay-less through both the immediate attempt and the
  `'open'` listener, while the shipped test asserted only `not.toThrow()`. The
  frame is best effort; the CLOSE is the refusal, and nothing a send does may
  cancel it, so the 250ms backstop closes on "not closed" rather than on
  "frame did not go out".
- ABSENT IS THE ONLY THING THAT MEANS UNSPECIFIED, on the `room-reject`'s `c`.
  A `typeof c === 'string'` guard read a wrong-typed `c` (a number, an object,
  whatever a fuzzer or a version skew produces) as absent and fell back to
  matching on pid alone, which closes BOTH of a swapping player's sockets: the
  exact regression the field exists to prevent, reached through the guard meant
  to enforce it. The test is `c !== undefined && c !== conn` refuses. A reject
  carrying no `c` at all is an older ticker and is still honoured on pid.
- A `room-reject` IS AIMED AT A CONNECTION, NOT BROADCAST AND NOT AT A PID. The
  ticker publishes it on a broadcast channel and the RELAY is the only place
  that knows which socket carries which pid, so the relay is the only place the
  frame can be aimed; every other relay drops it. AND THE PID IS NOT ENOUGH: a
  pid deliberately holds two live sockets during a relay swap or a reconnect,
  and a pid-only reject closed BOTH of them (measured: both 4002). So the
  ticker carries the refused join's own `c` and the relay matches on it. A
  reject arriving without `c` still matches on pid alone, because that is an
  older ticker and there is nothing to be more precise with.
- EVERY WAIT ON REDIS IS BOUNDED, BUT NOT ALWAYS BY THE SAME MECHANISM: a
  `commandTimeout` on the shared client, and a bound at the CALL SITE for the
  subscriber (the relay's `subscribeTimeoutMs`, the ticker's subscribe raced
  against `leaseTtlMs`), plus the checkpoint read's retry budget. An unbounded
  wait on a black-holed connection is not slow, it is permanent, and it takes
  the `finally` with it. A client-wide timeout on a SUBSCRIBER would also apply
  to the resubscribe ioredis issues for you after a reconnect, whose promise
  nothing catches, so a slow reconnect would exit the process; see the file map.
  THAT IS NOT A HYPOTHETICAL AND IT IS NOT AN OVERSIGHT TO TIDY UP. This fix set
  set one on the subscriber and the verifier round took it back out, reproduced
  with a TCP proxy holding only the resubscribe reply: the control exits the
  process and takes every other socket the function holds with it, and the
  shipped options survive the same reconnect with messages resuming.
  `tests/subscriber.redis.test.ts` is that pair, and it is the file to read
  before touching `createSubscriber`. The shared client's own db is part of the
  same rule: the identical ready handler issues `select(db)` uncaught, so use
  db 0 there.
- ONE ADMISSION PROTOCOL, and it lives in `server/admission.ts`. Not in an
  adapter, not imported by one adapter from another, not copied into an example.
  The client latches a terminal reconnect state off these close codes.
- `RoomConnection.processSnapshot` IS A TRUST BOUNDARY, exactly like
  `ByteReader` and `SnapshotInterpolator.push()`, AND FINITE IS NOT PLAUSIBLE
  HERE EITHER. `tick` and `serverTime` are
  typed `number` and arrive out of a decoder the HOST owns; a non-finite one is
  refused before any accumulator sees it and counted on `rejectedSnapshots`.
  Once the server clock is SEEDED the same counter also refuses a `serverTime`
  more than `SNAPSHOT_TIME_PLAUSIBLE_MS` (60000) from `serverNow()` and a tick
  more than `SNAPSHOT_TICK_JUMP_MAX` (1e6) from the last accepted one, and a run
  of `SNAPSHOT_IMPLAUSIBLE_REFUSALS` (3) consecutive refusals is adopted as a
  new timeline. The escape
  hatch is the same shape the interpolator's floor refusal has and needs the
  same discipline, with one difference that is the whole reason a CONSECUTIVE
  count is safe here and was not there: a WebSocket delivers in order, so
  nothing reorders this stream. THE MOTIVATION IS NOT "A ROOM RESTARTED AT TICK
  0", which this file used to say and which a 1e6 bound never trips: it is that
  the reference BOTH bounds are judged against is one this class computed for
  itself, so a reference that is wrong refuses every frame forever.
- AND THE ESCAPE RE-ARMS AT THE ADOPTION POINT. Clearing the run only on a
  PLAUSIBLE frame means that once a run has opened the gate it stays open:
  measured on 100 frames each stamped a random +-2e8ms away, 3 refused and 97
  ADOPTED, `estimateServerTick()` at 5.6e6, `tick.value` at -542716 (a stamp
  the server can never place) and a 3,432,713-tick `onTickReanchor` delta
  handed to the host. Re-armed, a genuine sustained step costs three refusals
  and one adoption per run of four until the clock re-seeds, about a second,
  while noise never gets through for free. AN ESCAPE HATCH IS A RATE, NOT A
  SWITCH, and that goes for `refuseSteppedFrame` one module along too.
- A PONG IS MATCHED TO AN OUTSTANDING PING, NEVER TIMED AGAINST THE NEWEST
  SEND. `n` is a sequence number and the client holds the send time of every
  ping it has not seen answered; a pong is a sample only if its `n` names one
  of them, and that entry is consumed. Without the match a duplicated,
  reordered or fabricated pong is timed against whatever went out most
  recently, which is a sample of nothing. The map is bounded by `RTT_WINDOW`,
  because a relay that simply stops answering must not grow anything.
- THE SERVER'S OWN TICK RATE IS MEASURED AND REPORTED, NEVER ADOPTED. `tickHz`
  is required because a default was a silent 2x error, and requiring it only
  moved the failure: a host writing 10 for a 20Hz room gets no error, no stall
  and clean stats while three derived quantities run at half basis. The server
  states its rate on every pair of snapshots (a tick delta and a `serverTime`
  delta ARE a rate), so `stats().serverTickHz` is that measurement as a median
  over `TICK_RATE_WINDOW` (21) forward in-order pairs, and
  `onTickRateMismatch(measuredHz)` fires once per epoch after
  `TICK_RATE_MISMATCH_RUN` (40) consecutive pairs more than
  `TICK_RATE_TOLERANCE` (0.2) away. NOTHING ELSE CHANGES ON THE STRENGTH OF IT.
  A class that quietly adopted the measured rate would be back to guessing a
  number the host is supposed to know, and the fix for a wrong constant is
  telling the host rather than working around them.
- A HOST CALLBACK'S THROW IS COUNTED, NOT ONLY SWALLOWED. `emit()` catches and
  increments `hostErrors`, and `interpolate.entities` is guarded separately
  because it has a RETURN VALUE: a throw there has to skip the push
  specifically while everything after it still happens. Surviving is right and
  being silent is not, and this class has no logger to be loud with, so the
  count is the whole signal. A healthy client reads 0 for its lifetime.
- AN ANCHOR IS PROVISIONAL WITH RESPECT TO THE ROUND TRIP IT ASSUMED. The first
  anchor of an epoch is taken before the first pong exists, so it is computed
  with `rttMs()` reading 0 and is short by the whole round trip, and because
  anchoring sets `lastReanchorAt` the tolerance path then refuses to correct it
  for `REANCHOR_MIN_INTERVAL_MS`. Measured at 250ms RTT: 2.2 seconds of
  stamping into ticks the server had passed, 40 late inputs counted at the
  server, then corrections still arriving 9 seconds in. So a pong that moves
  `rttMs` a whole tick away from the value the anchor assumed DROPS the rate
  limit, and the next snapshot corrects it through the ordinary tolerance path
  with an ordinary `onTickReanchor`. It reproduced in the first epoch of every
  run, which is every reconnect of every session.
- `rttMs` IS A SLIDING-WINDOW MINIMUM, NOT AN EMA, AND A FROZEN RENDER LOOP
  PRODUCES NO SAMPLE AT ALL. Every sample is the true path time plus whatever
  queueing happened on the way and queueing is non-negative, which is the same
  argument the two clock estimators already make; `RTT_WINDOW` is 8. A sample
  above `RTT_MAX_SAMPLE_MS` (5000) is discarded, and so is one taken while the
  render loop was frozen: under the old EMA a 3 second freeze on a 20ms link
  measured `rttMs` 935 and snapped the counter 18 ticks forward, and a hostile
  echo measured 60000.
- NEVER 0 FOR "NOT YET" ON A `performance.now()` AXIS. `lastReanchorAt` and
  `lastSwapStartedAt` were 0 sentinels, and 0 is a real reading: the swap rate
  limit never engaged at all on a page that opened its socket immediately, and
  the tolerance re-anchor was disabled for the first two seconds of every
  page's life. Both are `Number.NEGATIVE_INFINITY` now. THIS IS THE THIRD
  INSTANCE OF THE `PlayoutBuffer.aheadBase` TRAP in this repo, and the shape is
  always the same: a sentinel chosen from inside the value's own range.
- A TERMINAL'S CALLBACK IS THE LAST STATEMENT. `enterTerminal` latches, tears
  the socket down, drops the held poses, settles the status, and only then calls
  `onTerminal`, because the recipe this library documents restarts from INSIDE
  that callback and `start()` reaches `new Impl(url)` synchronously. The old
  order closed the socket the restart had just created: measured at two sockets,
  the restart's `readyState` 3, `reconnects` 0, dead forever, while the bare
  4002 close code (which announces nothing) survived. A callback that a host is
  expected to act from is not a notification, it is a handover.
- EVERY CALL OUT TO HOST CODE GOES THROUGH `emit()`, and the close path
  schedules the reconnect BEFORE it announces the status. Same reasoning as
  `guardHost` one layer up: the ladder is driven by a `void`ed promise, so a
  throwing `onStatus` used to stop the reconnect that was one line behind it and
  turn a routine drop into a connection that never tried again. Ordering is the
  belt and `emit` is the braces; a throwing host callback must cost the host's
  callback and nothing else.
- A RELAY SWAP IS RATE LIMITED AND ITS DEADLINE HAS A FLOOR. `relay-expiring` is
  a frame the relay chooses to send, so a hostile or broken one can send it as
  fast as it likes: 201 sockets in 10 seconds, measured. One swap per
  `RELAY_EXPIRY_LEAD_MS`, and the deadline is floored at `SWAP_MIN_DEADLINE_MS`
  (1000) so an announced `inMs` of 0 does not give the replacement no time at
  all.
- THE RECONNECT LADDER IS JITTERED, AND ITS BASE IS SIZED AGAINST THE
  INTERPOLATOR'S COVER RATHER THAN CHOSEN. `RECONNECT_BASE_MS` (100) x
  `RECONNECT_FACTOR` (2) per attempt, capped at `maxBackoffMs` (5000), each
  delay times a factor drawn uniformly from `[RECONNECT_JITTER_MIN 0.5,
  RECONNECT_JITTER_MAX 1.5)`; all four on the client barrel. It was a flat 250,
  and a healthy host opens the replacement socket in 6 to 18ms (measured in
  Chromium) against a cover of the delay floor (80ms) plus `EXTRAP_CAP_MS`
  (150), so the ladder itself was the whole visible outage: about four
  motionless frames per reconnect caused by nothing else. The jitter is not
  optional either, because this architecture builds a thundering herd by
  construction: one relay function holds many sockets and dies all at once, so
  every client on it starts its ladder in the same millisecond, measured on two
  clients at exactly [250, 250]. The cap applies to the exponential term and
  the jitter rides on top. The pre-open re-mint threshold stays keyed on
  ATTEMPTS rather than elapsed time, precisely because the delays are random
  now and anything clock-keyed would fire at a different point per client.
- A CALLBACK-PARAMETER TYPE IS CHECKED CONTRAVARIANTLY, SO `unknown` IS THE
  WRONG WIDENING. `WebSocketLike`'s four handler slots are
  `((ev: any) => void) | null`. Declared `unknown`, `strictFunctionTypes`
  demanded that `unknown` be assignable to each real implementation's own event
  type, which nothing is, so neither the DOM `WebSocket` nor ws's class was
  assignable to `WebSocketConstructor` and both READMEs told hosts to write
  `WebSocket as unknown as WebSocketConstructor`: a cast around a type that was
  simply wrong, on the one line every consumer copies. There is no sound
  alternative, because the parameter would have to be a SUBtype of the DOM's
  `Event`, of ws's, and of whatever a third implementation invents. `any` is
  the escape hatch for exactly this and costs nothing, because the class
  annotates each handler at its own assignment site. Pinned by a compile-only
  case in `connection.test.ts` (`the DOM WebSocket and ws both assign with no
  cast`) plus its sibling proving a minimal hand-rolled transport still
  satisfies the interface, so `any` cannot have quietly widened it into
  something only a real WebSocket meets.
- ONE CLOCK DOMAIN IN THE CLIENT: `performance.now()`. `Date.now()` survives
  only in `handleVersionSkew`'s reload window, where the question genuinely is
  wall time. The offset used to be differenced against `Date.now()` while every
  other stamp ran on the monotonic clock.
- A LEAD IS MEASURED, NOT ASSUMED. `desiredTick()` composes the server-tick
  estimate, the measured round trip, the configured jitter lead in MILLISECONDS
  and the optional server-depth feedback. A lead expressed as a constant number
  of ticks has no round-trip term in it at all.
- RE-ANCHOR IS TWO-SIDED, RATE-LIMITED BEHIND, AND THE TOLERANCE PATH DEFERS TO
  THE CLOCK'S STEP ESCAPE. Running behind is only harmless when it is a spike;
  a handoff and a backgrounded tab both leave the counter behind permanently.
  The unbounded-ahead path is deliberately NOT gated: that is a fact about the
  counter rather than about the clock, and it gets worse while it waits.
- THE RE-ANCHOR DECISION SEES THE COUNTER PROJECTED BY THE TIME SINCE THE LAST
  FRAME, capped at `TICK_STEP_CAP` and only once a frame has run this epoch.
  The counter moves only in `frame()`, so a main-thread hitch under the
  frozen threshold is not drift, and reading it as drift re-anchored twice
  (+N inside the hitch, -N two seconds later). Every other use of
  `tick.value` is the raw counter. See "A STALL IS NOT DRIFT".
- ONE `PredictedEntity` PER CONNECTION, enforced at construction with a
  `RangeError`. The entity is the player's input stream: the ticker keeps one
  playout buffer per pid, so two entities on one connection overwrite each
  other's record for every tick and the server consumes whichever landed
  last. A player steering several things carries them in one input record.
- A BACKWARD COUNTER JUMP REWINDS THE PREDICTION AND RELABELS NOTHING. The
  ticks beyond `value - 1` have not happened on the server's timeline: the
  records beyond the mark are dropped and re-sent as the counter climbs (a
  playout push for a held future tick overwrites it) and the poses beyond it
  stay as a speculative tail redrawn in place. And a new epoch
  (`tick.anchored` false, then true) starts the entity over: no record, pose
  or offset crosses it, and its first reconcile is a counted snap.
- A FROZEN RENDER LOOP IS AN EPOCH BOUNDARY FOR THE COUNTER, and not for the
  interpolator. Nothing was rendered during the gap, so there is no continuity
  to protect and the counter should re-anchor; the interpolator's buffer and
  clock offset are still about the same live socket.
- A WARM SWAP IS NOT AN EPOCH CHANGE. Same room, same server timeline, same tick
  anchor, same clock offset, same buffered frames. Its deadline is
  `min(connectTimeoutMs, the announced inMs)`, because a replacement given the
  full connect deadline outlives the socket it exists to replace.
- EVERY REFUSAL FRAME BEHAVES THE SAME WAY: latch AND close. A terminal that
  latches while the socket stays live leaves a client rendering a room it has
  been told it is not in, with the banner up, for as long as the relay feels
  like it.
- GAUGES ARE EPOCH-SCOPED, COUNTERS ARE LIFETIME, in `RoomConnection` exactly as
  in the interpolator. A gauge carried across an epoch describes a connection
  that no longer exists, and the first snapshot of a fresh socket is the worst
  possible moment to be reporting the outage's own numbers.
- `mint()` OUTPUT IS UNTRUSTED, and AN ATTEMPT IS IDENTIFIED BY A GENERATION.
  A 401 body is valid JSON too, and `if (this.stopped)` answers the wrong
  question: what matters is whether the attempt this code is part of was
  abandoned, which only a generation captured on entry can say.
- UNWIND EXTRAPOLATION AS A GLIDE, clamped to the interpolator's OWN overshoot.
  The clamp is the whole difference between a smoother and a lie: it can only
  ever hide this module's own guess, so a real teleport, a respawn or an
  authoritative correction still snaps.
- BOTH TERMS OF THE PLAYHEAD ARE SLEW-CAPPED: the offset at 5%, the delay at 8%
  of wall time. Both are subtracted from the playhead, so moving either quickly
  IS rendering every remote entity fast or slow for as long as the move lasts.
- A RATE MEASURED AGAINST A CLAMPED `dt` IS NOT A RATE. A caller is right to
  clamp its frame delta and right to pass the real `nowMs` alongside it; a
  consumer that divides real displacement by the clamped number reports a sprint
  no entity performed.
- WRAP, NEVER SILENT, ONE LAYER DOWN: an integer field REFUSES rather than
  wraps. Clamping is right for a coordinate because the clamped value still
  reads correctly; a state enum, a target tick or a byte length has no nearby
  value, so `DataView`'s silent wraparound turns `state 300` into 44 and
  `targetTick -1` into 4294967295.
- OPTIONS ARE SPREAD, NEVER COPIED, ACROSS THE ADAPTER BOUNDARY. A hand-picked
  subset goes stale the moment anything is added one layer down, and a field a
  type does not name is simply never passed on, with no error anywhere.
- A DERIVED LIFETIME NEEDS A FLOOR AS WELL AS A CEILING, AND THE FLOOR IS
  CHECKED ON THE RESOLVED VALUE. `min(MAX_TICKER_MS, maxDurationS * 1000 -
  TICKER_EXIT_MARGIN_MS)` is a subtraction, so a small enough `maxDurationS`
  produces a NEGATIVE lifetime rather than a short one: `maxDurationS: 10`
  derived a `maxRunMs` of -20000 and a `lifetimeMs` of 0, which announced and
  closed every socket the instant it arrived. `MIN_TICKER_RUN_MS` (10s) and
  `MIN_RELAY_LIFETIME_MS` (`2 * RELAY_EXPIRY_LEAD_MS + 1000`) are asserted at route
  creation, which is module evaluation, and on the RESOLVED number rather than
  on the host's input, because an explicit negative `maxRunMs` passed the
  existing fit check by arithmetic.
- NOTHING ESCAPES A PLATFORM CALLBACK, AND THE CATCH BLOCK IS GUARDED TOO. The
  Vercel upgrade handler and the node `'connection'` listener log
  (`relay.upgrade-threw` / `node-relay.connection`), close 1011 and resolve;
  every statement inside those catch blocks is itself wrapped, because a
  throwing host logger would re-raise the very rejection being swallowed. Same
  rule as `guardHost`, at the outermost seam the library has.
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
all twenty instead of just the abuser. `20 * perSenderCap` (64) must stay well
under the global cap (4096) so the per-sender bound binds first in the
single-abuser case.
AND IT IS A BACKSTOP THAT A SOCKET-BORNE FLOODER DOES NOT REACH, which is worth
knowing before somebody reads a `dropped` of 0 as the quota not working. Measured
with twenty clients for twenty seconds, one of them sending 200 frames a second:
`RoomStats.dropped` stayed 0 in ALL 44 flushes, because the excess dies one layer
up at that socket's own token bucket (3242 of 3777 dropped; capacity 40 refill 25,
the defaults at the time and now 100 and 70 in `relay.ts`, gives the measured
26.8 per second through the door) and 25 envelopes a second
against a per-tick drain never accumulates 64 undrained. The quota is for a
producer that reaches `room:{id}:in` WITHOUT a relay in front of it (another
deployment on the same instance, a script, a compromised host) and for a loop
that stops draining for seconds. The rest of that run is the reassurance: the
other nineteen clients were metrically identical to a no-flood control (peak 101
to 108 u/s, zero backward steps, zero zero-motion frames, zero rate drops), the
ticker held 20Hz (min 19.98), `hostErrors`/`publishFails`/`renewFails`/
`publishSkipped`/`badEnvelopes` were all 0, and the flood cost 2.6 points of one
core (13.5% against 10.9% for the whole in-process room of ticker, twenty relays
and twenty clients). Do NOT write a test that asserts `dropped > 0` under a
socket flood; it asserts the wrong layer.

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

A LOG LINE ON A CLIENT-RATE PATH IS A MEGAPHONE YOU HAND THE ABUSER, AND THE
TICKER HAD ONE. A malformed input envelope wrote a warn line per envelope:
measured at 51 lines for 51 `{data:null}` inputs, through this library's own
default decoder, on a path a socket drives at 20 to 60Hz. It is the same rule
the rate limiter and the relay's observability hooks already follow, applied to
the one place it had been forgotten: count in process, emit ONE summary line per
stats flush, on a cadence nothing on the wire can drive. `hostErrors` and
`unknownEnvelopes` both work this way, and both stay silent at zero so a healthy
room says nothing.

A CRASH LOOP IS THE CHECKPOINT'S FAULT, NOT THE SUCCESSOR'S, AND IT HAS NO
CEILING OF ITS OWN. A deterministic throw in `tick()` wrote a final checkpoint of
the HALF-MUTATED state and then spawned a successor, which restored those exact
bytes and threw in the same place. Measured: 40 spawns in 958ms, forever, with
every metric reporting each successor as a healthy cold start. Two fixes, and
both are needed: an error exit writes no checkpoint and spawns nothing (the
relay's 1 to 2 second poll paces the retry instead), and a counter in
`room:{id}:crashes` starts the room FRESH after three. Same trade and same
reasoning as the geometry digest: lose the in-progress state once instead of
forever.

A RESYNC THAT DOES NOT SLEEP IS THE RUBBER-BAND IT EXISTS TO PREVENT. The
post-stall resync set the grid to `now` and fell through with no sleep, so the
next iteration ran back to back with the current one: two snapshots left with
consecutive ticks and a `serverTime` gap of 0 to 1ms, and the client divides a
tick's worth of movement by that gap and extrapolates at 5000 units a second.
Sleeping to `now + tickMs` also hands the event loop the turn it needs to drain
the envelopes that piled up during the stall, which is the other half of
recovering from one.

A BLACK-HOLED SUBSCRIBER PRODUCES NO EVENT AT ALL, WHICH IS WHY THE TICKER NOW
TALKS TO ITSELF. No error, no close, nothing to observe: the room keeps ticking,
publishing and renewing while every join and every input is silently dropped.
Measured over a 4 second black hole: ZERO log lines, healthy stats, one input
applied. The only way to learn that a channel still delivers is to send something
down it and watch for it coming back, so the ticker publishes a `probe` on its
own input channel every `PROBE_INTERVAL_MS` and reads the answer through its
own subscriber. A subscription silent for `PROBE_DEAD_MS` is an `'input-dead'`
exit, handed off like a duration cap, because the subscription is opened once
per run and only a fresh process repairs it. THOSE ARE THEIR OWN CONSTANTS AND
NOT A MULTIPLE OF `statsMs`, which they used to be: the deadline was three stats
windows, so a host setting `statsMs` to 40 for finer metrics resolution, a
change with no relationship to liveness at all, gave itself a 120ms deadline and
tore down a healthy room the moment the bus took 150ms. A knob documented as a
metrics cadence must not be able to decide when a room dies. THE OWNER FILTER ON THE PROBE IS NOT OPTIONAL: two tickers
overlap on one room for a moment around a handoff, and without it a successor's
probes would answer for a predecessor whose subscription had already died.

A LEAVE THAT LANDS IN A HANDOFF GAP IS SIMPLY LOST, AND THE PLAYER NEVER LEAVES.
The relay heartbeats a join every second and the only removal was one
fire-and-forget `leave`, which pub/sub drops when no ticker is subscribed, which
is precisely when a relay is most likely to be closing sockets. The phantom
stayed in the roster, in the meta hash, and in every successor's restored
checkpoint: a room that could never drain, holding a capacity slot nobody could
reclaim. Fixed by the other half of the same idea: a player is present because a
relay KEEPS saying so, and a pid silent for `presenceTimeoutMs` gets the leave
the bus dropped, synthesised on a cadence nothing on the wire can drive.
AND THE TWO SIDES ARE ONE CONSTANT NOW, NOT TWO LITERALS AND A SENTENCE. The
relay's cadence and the sweep's unit are `JOIN_HEARTBEAT_MS` in
`core/wire.ts`, `relay.ts` defaults `heartbeatMs` to it, and `ticker.ts`
derives `DEFAULT_PRESENCE_TIMEOUT_MS` as `PRESENCE_TIMEOUT_HEARTBEATS` (5) of
it, pinned by a case in each file. Five, because one lost beat must not remove
a live player and because five one-second beats sit above the 5 to 7 second
unplanned-death gap, which is the successor's own restore and not a break in
the heartbeat: the relays are a separate lifetime and keep republishing right
through a ticker dying. A host that moves `heartbeatMs` owns `presenceTimeoutMs`
with it, and must keep it at AT LEAST THREE of the beats it chose.

A GRACE-PERIOD REJOIN WAS REFUSED AS A NEW ARRIVAL, BY THE FULL ROOM IT WAS
ALREADY IN. `leave` deleted from `present` unconditionally, even for a runtime
holding the player through a disconnect grace, so the reconnect that followed
met `isFull` and was answered with `room-reject` while the simulation still had
them sitting in the room. The grace period the runtime was keeping for them was
exactly what they could not use. `present` now follows `presentPids`, the same
authority the metadata already followed; the two were always one fact.

A THROWN CHECKPOINT READ IS NOT AN ABSENT CHECKPOINT, AND TREATING IT AS ONE
COSTS THE ROOM EVERYTHING. One rejected `GET` produced `runtime.create`, a new
incarnation, and a first iteration that OVERWROTE the perfectly good checkpoint
a millisecond later: measured at tick 45 to tick 3, incarnation changed, nothing
recoverable afterwards. Retrying costs a few hundred milliseconds of handoff on a
transient fault and giving up costs one invocation; neither costs the room its
state. A value that WAS read and cannot be decoded still starts fresh, because
that is a fact about the bytes rather than about the connection.

AN EX-OWNER'S CHECKPOINT OVERWRITES ITS SUCCESSOR'S, AND THE LOCAL FLAG CANNOT
SEE IT. `owns` lags reality by up to a renew period, so a ticker whose lease was
taken while its last renew was in flight still believes it owns the room and a
plain `SET` clobbers the successor's fresher state. Measured against a REAL
Redis at three such overwrites inside 1.5 seconds. The fix is the one the renew
and the release already use: let Redis decide, atomically, in the same command.

A RELIABLE QUEUE ON A LOSSY BUS IS WORSE THAN DROPPING. The snapshot forward was
the one place this library could turn Redis pub/sub into an unbounded queue, and
it did: measured at 7.65MB queued for one paused socket, then replayed as a
stale burst the moment it drained, which is the worst possible thing to hand a
jitter buffer. The same shape bit the ticker from the other end, because ioredis
buffers commands across a reconnect and replays them: one bus blip inflated every
client's adaptive delay to about 470ms and held it there for six seconds. Both
are now bounded and counted (`backlogDrops`, `publishSkipped`) rather than
queued, and in both cases the newest snapshot supersedes every older one anyway.
BUT KNOW WHICH SOCKET THAT 7.65MB WAS, BECAUSE THE BOUND IS NARROWER THAN IT
READS. It was measured by pausing the `ws` STREAM itself, which is what a wedged
transport looks like; `snapshotBacklogBytes` keys on `bufferedAmount`, the
transport's USERSPACE queue, and a modern kernel absorbs a merely slow READER
into its own send buffer long before that queue grows. macOS auto-tunes to about
4MB, so an 8 second read stall of 134KB of snapshots left `bufferedAmount` at 0
and fired no drop at all. THIS BOUND IS MEMORY SAFETY AGAINST A WEDGED SOCKET,
NOT STALENESS CONTROL. A slow reader gets the frames, late, and its client
renders the documented catch-up on resume: measured on a 2 second stall, 242
motionless frames during it and then one frame carrying the stall's whole motion
at 10,000 u/s, which is the "resume after more than 650ms of silence" snap
`docs/ARCHITECTURE.md` section 1 already documents rather than a stale-burst
artefact, because playback is on the server timeline and every frame carries its
own honest stamp.

A SOCKET CAN BE DEAD BEFORE THE RELAY EVER SEES IT, AND `terminate()` ON A
CLOSED SOCKET EMITS NOTHING. The caller awaits `checkAdmission` to get here, so
the socket may have closed during that round trip with its 'close' event already
fired and gone: attaching anyway produced a permanent zombie holding a slot
against the per-subject cap until the function's own duration cap. The same
asymmetry is why the liveness path runs `cleanup` ITSELF right after terminating
rather than waiting for an event that may never come. `cleanup` is idempotent, so
a transport that does emit 'close' costs nothing for the belt.

A SPAWN POLL WITHOUT A HOLD-OFF IS A THUNDERING HERD. The relay's ticker check
reads the lease and spawns when it is null, and a ticker cold start is longer
than the poll period, so every poll inside that start window fired another
invocation: measured at 41 invocations from 20 sockets during ONE 2.5 second cold
start, all but the first existing only to lose the acquire race. The poll keeps
running throughout (it is the backstop for a spawn that genuinely never landed);
what the hold-off bounds is how often one relay is willing to PAY for one.

TWO LISTENERS ON ONE PUB/SUB CONNECTION COST A UTF8 DECODE PER FRAME. ioredis
emits BOTH `message` and `messageBuffer` for every delivery as soon as any
`message` listener exists, so a relay listening on both had every binary snapshot
decoded to a JS string once per socket per tick purely to be thrown away by a
channel check. One `messageBuffer` listener that branches on the channel pays the
decode only for the channel that is actually text.

A 4001 IS TWO DIFFERENT EVENTS ON ONE CODE, AND COUNTING AN AUTH CLOSE ON
`preOpenFailures` CANNOT WORK. The node adapter verifies the token AFTER the
upgrade, so a session older than the host's `maxAgeS` ends the game on the next
network blip: a terminal that never re-mints. A 4001 BEFORE this epoch delivered
anything is therefore read as a stale token and three of them force a fresh mint;
once the epoch has delivered, the server had already accepted this token, so a
4001 can only be a deliberate kick. It needs its OWN counter because those
sockets DO open, and `onopen` clears `preOpenFailures`, so counting them there
could never reach the threshold.

A `void`ED PROMISE MAKES EVERY THROW SILENT. `scheduleReconnect` drives the
client's ladder with `void this.connectOnce(...)`, so a throw in the post-mint
half (a host `socketUrl` dereferencing a field its session does not carry, a
`WebSocket` constructor refusing a URL) was an unhandled rejection and the ladder
simply stopped: no timer, no terminal, status stuck on `'connecting'` forever.
The whole post-mint half is inside the try for that reason. Same shape one layer
up: an `async` host hook satisfies a `void` return, and its rejection kills the
process.

A SWAP DEADLINE LONGER THAN THE ANNOUNCED CLOSE IS A SWAP THAT NEVER HAPPENS.
`connectTimeoutMs` defaults to 10s while `relay-expiring` leads the close by 5s,
so a replacement given the full connect deadline outlives the socket it exists to
replace: the old socket's 4004 lands first, the swap is discarded, and the
ordinary cold reconnect runs anyway. Waiting past the announced close can only
ever waste the swap.

A STATISTIC ABOUT A REDUNDANCY WINDOW DEPENDS ON THE PUSH ORDER. `lateCount`
counted every already-consumed re-send, which on a healthy link is 3 per packet
purely because the client is doing the right thing, so the gauge measured the
window size rather than the link. It now counts only the re-stamps that LAND,
and `RoomStats.lateInputs` reports the per-window DELTA rather than the buffers'
lifetime totals, because `lateCount` only ever climbs and a link that was briefly
bad in the first minute would otherwise look bad forever.

A CONSTANT CAN ONLY BE PINNED FROM BOTH SIDES. `DELAY_SLEW_MAX` was swept
against two profiles that pull in opposite directions and the table is in the
source: at 0.10 a one-off 450ms hold still costs 106 frames outside +-10% of true
speed, and at 0.06 a repeating 450ms stall costs 12 frames above 300 u/s with a
peak of 117. 0.08 is the only value where both read zero, and both tests bind, so
the constant cannot be moved in either direction without one of them going red.
A constant pinned from one side only is a constant with a free direction.

THE ADAPTER OPTION BAGS WERE A SUBSET, AND A SUBSET GOES STALE SILENTLY. Both
route option types named a hand-picked selection of the server option types, so
TWENTY options (`metaPayload`, which was itself the landed fix for a real game's
roster, plus `init`, `onGeomMismatch`, `statsLabels`, `metaSeedPayload`,
`connNamespace` and every relay observability hook) were unreachable from the
very route factories the README tells people to use. A field a type does not name
is not an error, it is simply never passed on. `HostTickerOptions` and
`HostRelayOptions` are defined as "every option a HOST may set", so intersecting
with them and spreading the result makes a new option reachable on the day it
lands rather than on the day somebody remembers to copy the field through.

NOTHING TIED THE LIBRARY'S LIFETIMES TO THE PLATFORM'S CAP.
`tickerRouteConfig.maxDuration` was 800 and `MAX_TICKER_MS` was 700s, two
constants in two files agreeing only by luck, and a host on a lower plan limit
(or one who simply lowered `maxDuration` to control cost) got a platform kill
every single cycle with no final checkpoint, no lease release and no successor
spawn: every room in the fleet losing a second of state and stalling for the rest
of the lease TTL, forever, with nothing reporting it. `maxDurationS` is now the
one number that couples them, and the DIRECTION matters: the derivation is
`min(MAX_TICKER_MS, maxDurationS * 1000 - TICKER_EXIT_MARGIN_MS)`, so the cap can
only ever LOWER the lifetime and a host raising `maxDuration` does not silently
get longer tickers. An explicit `maxRunMs` has its fit checked at route creation,
which is module evaluation, so a deployment whose numbers do not fit fails on the
first request rather than on every handoff for the rest of its life.
AND THE DERIVATION NEEDED A FLOOR TOO, which the direction argument hides:
subtracting a 30 second margin from a small `maxDurationS` produces a NEGATIVE
lifetime rather than a short one. `maxDurationS: 10` derived a `maxRunMs` of
-20000 and a relay `lifetimeMs` of 0, so every socket was announced and closed
the instant it arrived, and an explicitly negative `maxRunMs` passed the fit
check by arithmetic because the comparison was still true. Both floors are
checked on the RESOLVED value at route creation now.

A BACKWARD RE-ANCHOR SILENCES A HOST THAT DEDUPES BY A HIGH-WATER MARK, AND THE
LIBRARY CANNOT SEE IT HAPPEN. Stamping inputs and skipping a tick already sent
is the obvious way to write a sender (`if (t <= lastSent) return;`), and it is
correct right up until `onTickReanchor` delivers a NEGATIVE delta: `tick.value`
is then below a mark that was set before the correction, so the guard stops
sending anything at all until the counter climbs back past it. Measured on the
end-to-end harness at 5.6 seconds of total input silence from one backward
re-anchor, and 100 self-inflicted starves at the server, from a client whose
socket, RTT and rendering were all perfectly healthy. Nothing in the library can
observe a host's own dedupe, so this is documented rather than fixed: the delta
is the number to move the mark BY (`lastSentTick += d`), and both
`onTickReanchor`'s docstring and the README quickstart now say so. TWO-SIDED
RE-ANCHORING MADE THIS REACHABLE: on the old ahead-only rule the delta was
never negative, so a fix in one module opened a trap in the host's.

A REDIS DB INDEX DOES NOT ISOLATE TWO DEPLOYMENTS, AND `namespace` DOES.
Pointing staging at `/1` and production at `/0` looks like separation and is
not: KEYS are per database, PUB/SUB IS INSTANCE-WIDE. Measured, a subscriber on
db 0 received a publisher on db 10, so the two deployments publish into the
identical `room:pong:in` and `room:pong:out` while each acquires its own lease
against its own `room:pong:lease` key and each believes it is the exactly-one
writer: two tickers interleaving snapshots, with no error anywhere, and the
lease mechanism unable to see it because it is doing its job correctly on each
database separately. `namespace` prefixes keys AND channels together, which is
why it is the seam that works, and it has to be passed to BOTH routes (one and
not the other splits the room in half). This is a separate fact from the db-0
rule in the file map, which is about ioredis re-issuing an uncaught `select(db)`
on every reconnect; both point the same way. `README.md`'s Install section
documents it now, because `namespace` had zero hits in either README before the
cold-start run went looking for the isolation seam and found none.

A HELPER SCRIPT WITH A RELATIVE SOURCE PATH WILL EVENTUALLY OVERWRITE THE FILE
YOU ARE EDITING. A mutation or snapshot script holding
`SRC = 'src/client/interpolation.ts'` resolves that against whatever cwd the
shell it runs from happens to have, and an agent shell's cwd resets to the repo
root between calls. So a script written to run from a scratch directory copies
its stale snapshot over the LIVE file the moment it is run from anywhere else,
silently, with a green exit code. That reverted `interpolation.ts` four times in
one session. ABSOLUTE PATHS ONLY in anything that writes, and never keep a
snapshot of a file you are actively editing beside a script that can write it
back. The measurement is the reason the snapshot exists; the snapshot is not the
reason to risk the file.

AN UNTRACKED SCRATCH SUITE UNDER `src/` IS COLLECTED BY VITEST AND INFLATES
EVERY COUNT IN THIS FILE. The include is `src/**/*.test.ts`, which has no idea
whether a file is tracked, so a leftover `src/__verify_*` from a mutation run
means CI on a clean checkout runs a DIFFERENT suite from the laptop that wrote
the numbers. Before quoting a whole-tree count, `git status --short` and delete
them. The same goes for any scratch `.ts` under `src/` and `npx tsc --noEmit`,
which includes the directory rather than the git index.

AND THE SAME SCRATCH FILE SHIPS TO NPM, BECAUSE `tsc` NEVER CLEANS `outDir`.
This is the gotcha above one layer further out and with a worse ending. `tsc`
emits into `dist/` and removes nothing, so a scratch directory that was compiled
once and has since been deleted from `src/` stays in `dist/` forever and is
PACKED: measured on this tree, a mutated copy of the ticker under
`dist/__verify_ticker2__` sat in the dry-run tarball at 75 files and 364 kB,
having been deleted from the source tree runs earlier. Nothing reports it. The
typecheck is clean because the source is gone, the tests are green because they
never look at `dist/`, and the only signal is a file count and a tarball size
that nobody compares against anything. `build` is `rm -rf dist && tsc -p
tsconfig.build.json` for exactly this, and the pack figures in the Gates section
are stated as MEASURED after a clean build for the same reason: they are the
readout that would have caught it. Never quote a pack size or file count that
was not re-measured after the build it describes.

A SPAWN IS A DELIVERY, NOT A CONVERSATION, AND WAITING FOR ITS ANSWER PUT AN
ERROR LINE IN THE LOG ON EVERY ROOM START. Both adapter spawns are a `fetch` at
a ticker route, and `createTickerRoute` does not respond until `runTicker`
RETURNS, because ending the response ends the function: the answer to a spawn
is the successor's WHOLE LIFE, 700s at the default cap. Node's undici gives
`fetch` a `headersTimeout` of 300000ms, so a spawn awaited for its answer fails
at 300s with `TypeError: fetch failed` (cause `HeadersTimeoutError`) against a
ticker that started 300s earlier and is running the room perfectly. Measured on
the real deployment: `relay.spawn-failed` on the FIRST SOCKET OF EVERY RUN,
sitting in the log beside the `ticker.restore` line of the very ticker it was
reporting as failed, and `ticker.spawn-failed` the same way on every standby
handoff. Both spawns were a bare `fetch` with no signal, awaited only far
enough to `.catch`, which is what made the wait invisible in the code. The fix
is `deliverSpawn`: resolve on a RECEIPT (`SPAWN_ACK_MS` 3000, or the
`Response` if one lands first) and reject only for a failure that arrives
before it, which is the only kind that means the ticker never started. THE
GENERAL RULE IS WORTH MORE THAN THE FIX: any request whose response is the
callee's entire lifetime must be waited on for a receipt, never for an answer,
and any timeout in that path is a statement about DELIVERY rather than about
health. The connection is left open rather than aborted, for the reason the
file map entry gives, and the line that survives means one thing now: this room
has no ticker.

FLUID COMPUTE CAN RUN THE STANDBY SUCCESSOR IN THE SAME CONTAINER AS THE
INCUMBENT, SO AN INSTANCE ID AT MODULE SCOPE DOES NOT MARK A HANDOFF. A ticker
spawns its own successor by calling its own route, and on Vercel's Fluid compute
that request lands in an already warm container more often than not: the module
was evaluated once, so a successor built from a module-scope id publishes the
IDENTICAL id the incumbent published and a real handoff is indistinguishable
from no handoff at all. Measured on 2026-09-03, the platform's invocation log
showed two ticker handoffs in a twelve minute run and the clients saw one,
because the first successor carried its predecessor's id. Nothing in the library
is wrong here (the lease and the checkpoint carried both handoffs correctly, and
both cost zero server ticks); what is wrong is the observer. A host that marks
handoffs for its own telemetry has to generate the id PER INVOCATION, inside the
route handler, not at module scope, and the same applies to anything else a host
scopes to "this function instance".

VERCEL AUTHENTICATION BLOCKS THE RELAY'S OWN TICKER SPAWN, AND THE ONLY SYMPTOM
IS SILENCE. Deployment Protection is on by default for a personal project, and
it guards EVERY request to the deployment including one of its own functions
calling another, so the relay's fire-and-forget spawn of `/api/ticker` is
answered with an SSO redirect rather than a 200. The spawn is caught and
discarded by design, correctly, so nothing anywhere errors: a socket opens, the
player joins, the roster seeds, and then the room sits in perfect silence with
no ticker ever started and no `/api/ticker` line in the invocation log at all.
That ABSENCE is the whole signal. Either turn Protection off, which is the right
answer for anything meant to be reachable by a browser that has not signed into
the Vercel account, or set `VERCEL_AUTOMATION_BYPASS_SECRET` and send it on the
spawn.

UPSTASH'S `CLIENT LIST` CARRIES NO SUBSCRIBE-MODE FIELDS, SO THE COST MODEL'S
SUBSCRIBER SPLIT CANNOT BE READ THERE. A real Redis answers with `flags=`,
`sub=`, `psub=` and `ssub=` on every line; Upstash (1.17.11 in front of Redis
8.2.0, measured) answers `id addr laddr db name lib-name lib-ver` and stops. A
count of the lines matching a subscribe flag therefore reads ZERO while a ticker
subscriber and one subscriber per relay socket are certainly live, which is a
plausible-looking number and a false one. `INFO clients` `connected_clients` is
accurate and is what to use: it read a peak of 8 for three players plus the
ticker and the harness, roughly two connections per player. Anything reporting
the split has to say "not reported" on a provider that does not report it rather
than print the zero.

A HIDDEN TAB FIRES `onTickReanchor` ABOUT EVERY TWO SECONDS, AND THAT IS NOT A
FAULT. `frame()` is what advances the client tick, and a backgrounded tab stops
`requestAnimationFrame` entirely, so the counter is frozen while snapshots keep
arriving on a socket the browser does not throttle: every snapshot the client
does process re-anchors the counter onto `desiredTick()`. Measured over six and
a half minutes hidden, 200 re-anchors with a maximum delta of 43 ticks, on a
connection with zero reconnects and no terminal. A host that logs or alerts on
`onTickReanchor` will page itself every time a player switches tabs, and a host
that adjusts its own `lastSentTick` by the delta (which is what the callback's
docstring asks for) is doing exactly the right thing at ~0.5 Hz. A host on
`PredictedEntity` has nothing to adjust: the entity reads the jump off
`tick.value` inside `advance`, and the callback is telemetry for it.

STEADY MOTION HIDES AN OFF-BY-ONE IN THE INPUT TIMELINE, AND ONLY AN INPUT
CHANGE REVEALS IT. The ticker consumed the stamp `currentTick` (the COMPLETED
count) before stepping, so the record stamped T was applied to the step that
produced the snapshot labelled T + 1, while the shipped pong client predicted
record T during its own step T and replayed `targetTick > snap.tick` from the
snapshot. Under a held key the record applied a tick late carries the same value
as the one that should have been, so the two ends agreed to the unit and every
existing test and harness stayed green (the smoothness harness measures a
server-driven marker, never the reconciled own entity). At every paddle START or
STOP the two disagreed by exactly one tick of travel, 4.5 units at 90 u/s and
20Hz, positive on the start and negative on the stop, at every RTT and with the
replay window fully covering the lead, and the `ErrorOffset` glided that error
away as a wobble twice per keypress. The fix consumes `currentTick + 1`, the tick
the step produces, which REMOVES a tick of input latency rather than adding one.
The lesson for any reconciliation test: it MUST change the input mid-run (dir 1
up to T, dir 0 from T + 1) and assert on the snapshot LABEL, because a steady
input cannot tell the two timelines apart and a hook's view of `state.tick` at
consume time is one below the label whichever timeline is in force.
`predictedEntity.test.ts`'s contract pair is that test in the client layer: a
server model with the produced-tick rule reconciles to exactly zero across two
direction changes, and the same run with the completed-tick rule reddens one
tick of travel at exactly the three changes (start, stop, reverse) and nowhere
else, which is the fingerprint to recognise if the timeline ever regresses.

A PREDICTED ENTITY HAS NO INTERPOLATOR, SO IT IS DRAWN FROM A PLAYHEAD ONE
TICK BEHIND ITS NEWEST STAMP OR IT STEPS AT THE TICK RATE. `SnapshotInterpolator`
renders every remote entity between snapshots, which is why steady motion of
the marker never shows this and no marker-based harness ever did. The owned
entity is predicted locally and advances only when a tick is stamped, once
per 50ms at 20Hz, while the page draws at 60fps: drawn raw it holds still for
two frames in three and jumps a whole tick of travel, 4.5 units at 90 u/s,
which the player reported as stutter the moment the timeline fix removed the
rubber banding that had been hiding it. Measured on the deployment by
`bench/paddle.mjs`: 67% of held frames with no motion and a largest
single-frame step of 4.50 before, 0% and 1.60 after (per-frame travel at 60fps
is 1.5). `PredictedEntity` owns the draw, and `examples/pong/client.ts` draws
through it. One tick of visual delay on an entity whose prediction has no
round trip in it, which is not felt, for motion at the frame rate.

A COUNTER JUMP IS NOT TIME PASSING: THE RENDER OF A PREDICTED ENTITY MUST
SLEW, NOT FOLLOW THE COUNTER. The first draw was `prev + (curr - prev) *
tick.fraction`, the standard fixed-timestep interpolation, and it is correct
only while the counter advances by wall time. The counter also JUMPS: a
forward re-anchor of +2 or +3 (the `inputLead` feedback loop's own response
to a starving buffer) stamps the catch-up ticks in one frame, and a draw that
follows the counter moves the pose 7.5 to 12 units in 16ms, with no glide and
nothing counting it; a -1 re-anchor, the COMMON epoch anchor on a link under
50ms (`beginEpoch` zeroes the RTT samples and `feedbackTicks`, so the first
anchor of every epoch lands a tick short), is tolerated as stamping slack, and
with it `(prev, curr)` sit a tick ahead of `(value, fraction)` and the draw
walks BACKWARD a whole tick of travel. An adversarial review with the real
counter and the real playout buffer found both, plus a third with the same
cause: `ErrorOffset.absorb` clamped at the snap distance while the snap gate
was per reconcile, so corrections that added up were trimmed in silence and
the render jumped by the remainder inside a reconcile nothing counted. The
entity now keeps the pose after every recent stamp and reads them at a
playhead that moves by each frame's own dt within a tenth of real time,
never backward, past the newest stored pose only on a bounded speculation
with the current input (the backward re-anchor gotcha below), snapping
(counted) only past four ticks; and the snap gate is on the offset the
absorb would produce. The brief's one number, no frame under nine tenths
after a -1 anchor, looked impossible at first (there is no stored pose
beyond the newest stamp for two ticks) and is what the speculation
delivers: the target catches the playhead up at nine tenths over ten ticks,
never a hold and never a step. And a 2s frozen tab with
the key HELD is not a render defect at all but two seconds of travel the
client never predicted: the backlog of snapshots moves the prediction 180
units, every jump is a counted snap, and only with the key released is the
freeze exactly one snap (the playhead's). The lesson for any render test of
an owned entity: drive the REAL counter with `anchorTo` jumps as well as
`advance`, assert per frame on the DRAWN pose (never backward, never more
than `1.1 * speed * dt` outside a counted snap), and count the snaps, because
the reconcile error was exactly zero through every one of these defects.

A STALL IS NOT DRIFT: THE RE-ANCHOR DECISION COMPARES THE COUNTER PROJECTED
BY THE TIME SINCE THE LAST FRAME. The counter moves only in `frame()` and
`desiredTick()` runs on the server clock, so a main-thread hitch of 100 to
300ms (a GC pause, one heavy frame, anything under the 300ms frozen threshold)
left the counter where the last frame put it while the snapshots that landed
inside the hitch read it as 2 to 5 ticks behind: the tolerance path
re-anchored +2 to +5 spuriously, the resume frame then stamped the stall's
ticks on top of that, and about two seconds later the same path re-anchored
-N to undo it, with every consumer's prediction eating both jumps as real
corrections. `RoomConnection.projectedTick(now)` is `tick.value +
(now - lastFrameAt) / tickMs`, capped at `TICK_STEP_CAP` because that is all
the resume frame can add, taken only once a frame has run this epoch (before
that `lastFrameAt` belongs to the previous epoch), and it is what
`shouldReanchor` receives as `clientTick`; the stamp itself, `fraction` and
`onTickReanchor`'s delta still read the raw counter. A genuine drift moves
`desired` by something the projection cannot explain and still fires, with
frames running and inside a hitch alike. The lesson for any test of the
re-anchor: drive the frames and the snapshots on ONE clock and put the gap in
the frames only, because a re-anchor that fires on a frame gap is a decision
about the render loop, not about the network.

A BACKWARD RE-ANCHOR OF k IS k TICKS THAT HAVE NOT HAPPENED YET, AND THE DRAW
PAYS THEM AT NINE TENTHS ON A SPECULATION. The entity used to relabel its
pose history by the jump and leave `curr` where it was, so the next stamp
stepped from the pose after the OLD newest tick: a -3 under a held key
reconciled 22.5 units out and stayed out until the records it had dropped
aged out of the server's window. It now REWINDS `curr` to the stored pose
after `value - 1`, drops the records beyond the mark (re-sent fresh as the
counter climbs, and a playout push for a future tick the server holds
overwrites it) and keeps the poses beyond the mark as a speculative tail the
playhead runs on through, redrawn in place as the ticks are re-stamped: for
a held key the reconcile is exact at every snapshot including the ones
inside the jump. What the tail ALONE could not do was keep the draw at real
time: the next NEW stored pose is `k + 1` ticks of wall time away with under
a tick of tail left to draw, and a playhead held to the history's end spread
that tail over the wait, measured at 60fps against 20Hz at 0.11x for 8
frames on a -2 and 0.08x for 11 frames on a -3, a near pause of 100 to 150ms
on the one entity the player steers, on every tolerance correction. The
playhead is not held to the history's end any more: past the newest STORED
pose it draws the SPECULATION, that pose stepped with the input the frame's
`advance` was given, one tick at a time and at most `PLAYHEAD_SNAP_TICKS`
deep, rebuilt from the newest stored pose on every frame that needs it and
never stored, replayed or sent. The lost ticks are then paid the way a
forward jump is paid: the playhead slews at `1 - RENDER_SLEW` until the
target has caught it up, about 10k ticks at exactly nine tenths of the
entity's speed (measured: 80 frames of 0.900x after a -2.67, 110 after a
-3.67, then 1.000x, the ticks lost exactly once), and for a held key the
speculation is what the re-stamps then produce, so no frame is a step. Where
a stamp or an input change makes the speculation wrong, the draw is measured
at the playhead before and after, against the speculation the previous frame
DREW and never against the stored history clamped at its end (that would
absorb a jump that was never on screen), and the difference is the offset's:
a glide of several frames inside the glide bound. A -5 is past
`PLAYHEAD_SNAP_TICKS` and is one counted snap onto real history instead, and
the same number bounds the speculation, so an unanchored playhead run ahead
by a host's unclamped dt draws at most four ticks of guess.

A ONE-TICK FEEDBACK DEADBAND WAS MEASURED WORSE, AND THE CUSHION BELONGS IN
`inputLeadMs`. The `inputLead` loop corrects only when the echoed depth is at
least `TARGET_DEPTH_TICKS` (2) off target. Narrowing that band to one tick so a
buffer one tick deep gets lifted sounds right (one tick of cushion is one late
packet from a starve) and on the deployment it did the opposite: re-anchors
per client per three minutes went from 1 to 4, 6 and 8, `starves` from 31 to
44 and `lateInputs` from 16 to 13, because every correction clears the client's
stamped window and the loop then hunts between depths of one and three. The
deadband equals the target by decision. What actually moved the starve rate
was headroom: `DEFAULT_INPUT_LEAD_MS` 100 to 150 took the same three-minute
run from 31 starves to 8 with re-anchors of 0, 1 and 1.

A HOST CALIBRATION TAKEN AT MODULE LOAD CAN UNDER-READ THE RUN IT GATES, AND
THAT IS THE WEAKEST POINT IN THE WALL-CLOCK HARDENING. `tests/helpers/jitter.ts`
measures twelve 25ms timers once per worker and the two end-to-end files skip
above `JITTER_LIMIT` (1.5) rather than loosen a bound of zero. It has to be
taken at module load for the same reason `probeRedisAvailable` is: `describe`
and `it` bodies are collected synchronously, so a decision made in an async
`beforeAll` would always read the initial value. The cost is that the reading
describes the machine at COLLECTION time, and a full-suite run is at its
busiest later, when the other forty files are actually executing: a host that
measured 1.2 while collecting can be well past 1.5 by the time the gated case
runs, and the gate will not have noticed. Nothing here fixes that yet. If one
of those files reddens on a loaded box with a jitter reading comfortably under
the limit, this is the reason, and the answer is a re-reading beside the case
rather than a wider bound.

UNDER `vi.useFakeTimers()`, ANYTHING OBSERVED DOWNSTREAM OF REAL I/O IS
TIMESTAMPED NONDETERMINISTICALLY, and gzip is I/O. `writeCheckpoint` deflates
on libuv's threadpool, so the virtual clock races a real compressor: the write
completes whenever the threadpool gets to it, the chained next `serialize` is
stamped at whatever the fake clock had been advanced to by then, and the
checkpoint spacing a test reads is the compressor's schedule rather than the
cadence under test. Measured on `ticker.test.ts`'s exact-bound spacing case,
gaps of 40, 60 and 60 for a cadence of 30 on a 16-way parallel run, and forced
to 130 and 500 by giving it a 400KB body. THE BOUND WAS NEVER THE PROBLEM AND
WIDENING IT WOULD HAVE HIDDEN THIS. The case now advances one tick at a time
and drains real event-loop turns while a write is outstanding, so the virtual
clock never moves during a real deflate; it reads [40, 40, 40] and the `>=` to
`>` mutation still reddens it. Every other virtual-time case in that file
dodges the whole class by disabling checkpoints, which is the cheaper answer
when a case does not need the write; this is the answer when it does. The same
trap is waiting behind `fs`, `dns` and anything else that finishes on the
threadpool.

A TAB WITH A DEBUGGER SESSION ATTACHED CANNOT BE DISCARDED, WHICH RULES
PLAYWRIGHT OUT OF THE MEASUREMENT ENTIRELY. `connectOverCDP` attaches a session
to every page in the browser's default context and keeps it for the life of the
page object, and Chrome refuses to discard a tab in that state without saying
so: the [Urgent Discard] click lands, the page reports success, `Discard Count`
stays 0 and the tab keeps running, which reads exactly like a discard that did
nothing. `bench/discard.mjs` therefore speaks raw CDP over a plain WebSocket
and attaches to the client tab only for the instant of each read. The
confirmation to trust is the discards page's own lifecycle row (`discarded
(urgent)` with a timestamp) or `document.wasDiscarded` after the return,
because the obvious check is destructive: attaching to a discarded tab is
enough to make Chrome reload it.

AND CHROME 152 DESTROYS THE PAGE TARGET ON A DISCARD AND DOES NOT REVIVE THE
TAB ON ACTIVATION WHILE THE MACHINE IS LOCKED, where Chrome for Testing 151 did
both the other way. 152 kills the renderer and makes a NEW target for the same
tab, so anything holding a target id from before the discard is holding a dead
one: ask the browser which target is showing the client URL, every time, rather
than remembering one. And 151 reloaded the tab the moment it was activated,
while 152 accepts the activation and leaves the tab dead until it is really
shown, which never happens if that window is not the frontmost thing on the
machine (a locked screen is enough). So a harness that waits for the activation
to revive it waits forever; `discard.mjs` sends its own `Page.reload` after a
five second grace period, reports which of the two brought the tab back, and
keeps the evidence either way, since `document.wasDiscarded` survives a reload
where a fresh navigation to the same URL would clear it. Measured on 152: the
reload revived it at 6.4s.

## Gates

From the repo root:

```
npx tsc --noEmit     # typecheck, must be clean
npx vitest run       # all tests; the tests/ files skip with no Redis reachable
npm run build        # tsc -p tsconfig.build.json, emits dist/
npm run test:integration   # tests/ only, needs a real Redis (see below)
npm run example:node       # tsx examples/node-server/server.ts, see its README
```

`.github/workflows/ci.yml` runs the first three on every push and PR to main, and
the fourth in a second job against a Redis service container. Note `npm install`
now runs `prepare`, hence `build`, so a broken build fails at install time. The
fifth is not a gate, it is the fastest way to drive a real client through a real
Redis by hand; `tsx` is a devDependency for it, and
`examples/node-server/README.md` is the operating manual.

BOTH WORKFLOWS REQUIRE REDIS NOW, AND THE RELEASE GATE IS THE ONE THAT DID NOT.
`ci.yml`'s integration job has always run `redis:8` on host port 6399 with
`TICKROOM_REQUIRE_REDIS=1`, which is what stops a misnamed service producing a
green job that ran no assertions. `release.yml` had neither, and the suite skips
cleanly with nothing listening, so the PUBLISHING build exited 0 having run zero
assertions in the lease, checkpoint, handoff, subscriber, smoothness and
fault-injection files: the one build whose version number is burned forever was
the one build nobody checked. It now stands up the identical `redis:8` service
on 6399 and sets `TICKROOM_TEST_REDIS_URL` and `TICKROOM_REQUIRE_REDIS=1` on its
own `npm test` step, so the release gate is at least as strong as CI rather than
weaker than it. Both `ci.yml` jobs carry `timeout-minutes: 20` and the release
job carries 30, because a hung job that never fails is the same shape of
non-gate as one that cannot fail.

`build` IS `rm -rf dist && tsc -p tsconfig.build.json`, AND THE `rm -rf` IS LOAD
BEARING. See the gotcha below. Measured on this tree after a clean build,
`npm pack --dry-run` is **73 files, 386.4 kB packed and 1.1 MB unpacked**.
Re-measure those three numbers after a build rather than quoting them forward:
they are the only thing that would have caught what the gotcha describes.

Most tests are unit tests against a fake in-memory Redis written inline in the
test files, so the default run works offline with no services; `tests/` is the
real-Redis suite and skips cleanly when there is none.

`TICKROOM_SPLITBRAIN_REPS=10 npm run test:integration` IS A LONG FORM, NOT A
GATE. One rep of `tests/splitbrain.redis.test.ts`'s eight cases is what CI runs;
ten reps (80 passed on fw13) is what a quiet machine runs when anything in
`lease.ts`, the renew cadence or the lease constants moves, because a margin
measured once is an anecdote. The rest of the work that takes minutes belongs
on that machine too, for the reason the Status section gives.

`tsconfig.json` sets `noUncheckedIndexedAccess: false` (see the verdict further
down) and `exactOptionalPropertyTypes: true`, AND THE SECOND ONE IS FOR THE
CONSUMER RATHER THAN FOR US. A stock `tsc --init` enables it, so a host compiles
this library's `.d.ts` under it whether or not they ever chose it. Measured at
19 errors across 11 files when it was turned on, all fixed, no runtime change,
and verified from outside by compiling a scratch consumer against `dist/` under
that flag plus `noUncheckedIndexedAccess` while assigning `T | undefined` into
every public optional. Two rules it imposes that are not obvious:

- Every optional field on a PUBLIC type is written `?: T | undefined`, and every
  optional callback is a PROPERTY signature, because method shorthand cannot
  carry `| undefined`. Internal code builds objects CONDITIONALLY
  (`...(x === undefined ? {} : { x })`) rather than assigning `undefined`.
- `Required<T>` no longer strips the `undefined`, so `core/lease.ts` resolves
  its defaults through an explicit mapped type instead.

AND THE ONE THAT WILL BITE A FUTURE WIDENING: a type in CALLBACK-PARAMETER
position must not be widened, because contravariance flips it. Widening
`WebSocketLike.onclose`'s event or `upgradeWebSocket`'s options bag would REJECT
a consumer whose handler is typed the stock narrow way. Widen what flows INTO
the library; never widen what it hands to a host's own function. (`any` on the
four `WebSocketLike` handler slots is the deliberate exception, and its
invariant above says why nothing narrower works.)

SEMVER NOTE FOR THE 0.2.0 RELEASE, because this is a source-compatibility break
that no test can see: `RoomRuntime`'s twelve optional hooks,
`RelaySocket.terminate`/`ping`, `RedisLike.on`/`off` and the option-bag
callbacks are all property signatures now, which drops method BIVARIANCE. A
consumer that annotates a hook's parameters NARROWER than the contract compiled
before and errors now. Everything in this repo uses contextual typing, so
nothing here saw it.

## Status

MEASURED ON THIS TREE, not estimated: `npx vitest run` collects 1130 tests
across 43 files (with a local Redis up on 6399, so the TWELVE integration files
run rather than skip; pointed at an unreachable one with
`TICKROOM_TEST_REDIS_URL=redis://127.0.0.1:6499` it is 1067 passed and 63
skipped across 31 files run and 12 skipped, still exit 0, because
`tests/memory.test.ts` needs nothing and runs either way); on fw13 with a real
Redis the same suite is 1130 passed across 43 files, exit 0; `npx tsc --noEmit`
is clean repo-wide including `examples/`; `npm run build` emits `dist/`
cleanly. Roughly 17,100 lines of source and 24,900 of tests. Per layer, and
these SUM to the total rather than approximating it: core 208, server 361,
client 273, codec 109, adapters 69, examples 46, `tests/` 64.

THE LONG RUNS HAPPEN ON A SECOND MACHINE NOW, AND THAT IS WHY THE WALL-CLOCK
CASES MOVED. Anything that takes minutes (the whole suite, the split-brain long
form, the bench's own multi-client runs) executes on the fw13 server, a 16-core
NixOS box, with Redis in Docker and the browser harness in the official
Playwright container rather than on the laptop. The suite ran there and was
1112 of 1114 on its first pass across 41 files (the total is higher above
because the fixes that pass produced came with their own cases), which is how
the last two wall-clock cases were found: a machine with sixteen cores busy is not a slower
laptop, it is a different measurement.

SO THE WALL-CLOCK CASES WERE FIXED AT THE SOURCE RATHER THAN GATED BY
DOCUMENTATION, which is what this paragraph used to be instead. `connection.test.ts`'s
reconnect ladder steps timer to timer (911ms of microtask churn, now 0);
`relay.test.ts`'s throttled-interval liveness pair runs on fake timers;
`ticker.test.ts`'s grid-stamp, stall-resync and checkpoint-ordering runs end on
a SAMPLE COUNT rather than on a fixed `maxRunMs` window, and its lease-theft
case waits for the loop to go quiet; the successor-spawn race, which is a
genuine 2s wall-clock deadline and cannot be anything else, carries a
calibrated tolerance (`JITTER_SCALE`, capped at 3x); the DOM `WebSocket`
assignment test guards the global rather than assuming one (Node 20 has none,
22 and every browser do); and the checkpoint exact-bound spacing case was a
fake clock racing a real gzip, which has its own gotcha above. THE TWO
END-TO-END FILES KEEP THEIR TIGHT BARS AND SKIP LOUDLY INSTEAD:
`smoothness.redis.test.ts` and three fixed-window cases of
`ticker.redis.test.ts` assert zero backward steps and zero motionless frames,
there is no honest way to scale a bound of zero, so `tests/helpers/jitter.ts`
decides whether the host can measure at all and the files say why when it
cannot.

PER FILE, which is what a mutation row is measured against: `ticker.test.ts`
146, `relay.test.ts` 124, `connection.test.ts` 122, `interpolation.test.ts` 48,
`ids.test.ts` 64, `bytes.test.ts` 52, `netPolicy.test.ts` 18, `lease.test.ts`
34, `snapshot.test.ts` 34, `playout.test.ts` 30, `quantize.test.ts` 23,
`core/checkpoint.test.ts` 23, `server/checkpoint.test.ts` 22,
`vercel.test.ts` 54, `session.test.ts` 19, `metrics.test.ts` 17,
`admission.test.ts` 16, `backpressure.test.ts` 16, `starvation.test.ts` 16,
`balancer.test.ts` 20, `redis.test.ts` 14, `adapters/node.test.ts` 15,
`errorOffset.test.ts` 10, `clientTick.test.ts` 13, `predictedEntity.test.ts`
57, `rateLimit.test.ts` 8,
`bundling.test.ts` 5, and in the examples `pong/sim.test.ts` 23,
`cursors/sim.test.ts` 19, `pong/codec.test.ts` 4.

WHAT THE 2026-09-02 WORK COST IN TESTS, per file, measured against commit
`b3ebcd7` (593 across 33 files, which is what the first version of this
paragraph reported): `ticker.test.ts` 44 to 144, `relay.test.ts` 37 to 115,
`connection.test.ts` 16 to 119, `interpolation.test.ts` 39 to 48,
`vercel.test.ts` 11 to 48, `codec/` 80 to 109 across its three files,
`lease.test.ts` to 34, `server/checkpoint.test.ts` to 22,
`netPolicy.test.ts` 13 to 18, `server/redis.test.ts` 7 to 14,
`examples/pong/sim.test.ts` 18 to 23, plus two new files
(`admission.test.ts` 16, `adapters/node.test.ts` 15) and four new integration
files (`tests/checkpoint.redis.test.ts` 11, `tests/subscriber.redis.test.ts` 2,
`tests/smoothness.redis.test.ts` 6, `tests/faults.redis.test.ts` 5). Roughly 400
cases for 69 audit findings plus what the two rounds after it turned up, which
is the ratio to expect when most of a fix is a guard: a guard needs the case
that reddens without it AND the control that stays green with it.
THE VERIFIER ROUND AND THE COMPLETENESS ROUND ARE BOTH INSIDE THOSE FIGURES,
not on top of them. That is where the last of `ticker.test.ts`'s,
`relay.test.ts`'s and `connection.test.ts`'s growth came from, and it is why the
mutation matrices further down were measured against SMALLER per-file totals
than the ones this paragraph reports: see the note at the head of that section
for why those counts are lower bounds rather than stale.

- Extracted and implemented: core, server, client, codec, adapters, plus three
  examples (a 2D game, a presence layer, a plain Node host).
- PUBLISHED to npm (`tickroom`, 0.1.0 and 0.1.1). `package.json` NOW SAYS 0.2.0
  AND 0.2.0 IS NOT PUBLISHED: everything documented in this file, in the README
  and in `docs/ARCHITECTURE.md` is the 0.2.0 tree, and the registry's 0.1.1 has
  a materially different API at what a reader would assume is the same version.
  Until the release tag goes out, the supported install is `npm pack` from a
  checkout, which the README's Install section says. The audit and the rounds
  after it changed public API in several places (`TerminalReason` gained and
  renamed members, `ConnectionStats` replaced the old `stats()` shape and then
  gained `serverTickHz`, `hostErrors`, `swapsAttempted` and `swapsFailed`,
  `RoomStats` gained five fields,
  `TickerResult.reason` gained `'input-dead'`, `adapters/index.ts` is gone,
  `ioredis` became an OPTIONAL peer, and every optional callback became a
  property signature: see the semver note in Gates), so the next release is a
  minor bump rather than a patch. DEPLOYED AND MEASURED ON A REAL VERCEL
  PROJECT ON 2026-09-03 AND AGAIN AT THE PRO CAP ON 2026-09-05 (the dated
  paragraphs at the end of the completeness round have the numbers), so the
  platform claims are no longer the untested half; it has still never carried production traffic, so every claim here is
  unit-level, integration-level, browser-level and platform-level, plus whatever
  the source architecture already proved in production. This bullet used to say "NOT published to npm... NOT run against a
  real Redis or a real WebSocket", which contradicted both the release workflow
  and the real-Redis section further down THIS FILE; if you are updating status,
  update every place that states it.
- Every test runs offline against an in-memory Redis
  (`src/server/memoryRedis.ts`, three Maps plus a pub/sub hub with `.fork()` for
  a second connection and `.break(method)` to force failures). It was built
  specifically to reproduce the production incidents this design exists to
  prevent (lease theft, the subscribe race, liveness and pong, backpressure
  fairness) deterministically and without a service, and it SHIPS now, so what a
  no-Redis consumer gets is the object the suite exercises thousands of times a
  run rather than a second implementation nobody checks.
- The upstream game this was extracted from is the production evidence for the
  design: the lease, the checkpoint handoff, the playout timeline, the stall
  thresholds and the interpolation rules were all measured there under real load.
  Where a number in a comment is quoted as "measured", that is where it came from.

### Verified by mutation, not just observed green

THE WHOLE MATRIX BELOW WAS RE-MEASURED ON A QUIET TREE ON 2026-09-02, AND THE
COUNTS ARE EXACT ON THAT TREE RATHER THAN LOWER BOUNDS. Every row in every table
that follows was applied on its own to a FROZEN COPY of this working tree, run
against the test file or files its own table names, then restored from a tarball
and checksummed before the next row went in, so no two mutations were ever live
at once and none of them measured anybody else's edit. The tree it names is that
snapshot, whose baseline is 901 passing across 37 files with a local Redis on
6399 and whose per-file totals are the ones in the headings below (ticker 113,
relay 84, connection 79, interpolation 47, codec 109, core 206, adapters 52). So
a `reddens` number here is EXACT for that tree rather than a floor over it.

AND THE TREE HAS SINCE MOVED PAST THAT SNAPSHOT, ONE WAY, WHICH IS SAID ONCE
HERE AND NOT REPEATED PER TABLE. The completeness round's gap executors landed
their cases AFTER the frozen copy was taken, and the follow-up set landed after
that, so the current per-file totals are
`ticker.test.ts` 144 (was 113), `relay.test.ts` 115 (was 84),
`connection.test.ts` 122 (was 79), `interpolation.test.ts` 48 (was 47),
`lease.test.ts` 34, `snapshot.test.ts` 34, `admission.test.ts` 16,
`vercel.test.ts` 48, `balancer.test.ts` 20, `adapters/node.test.ts` 15, plus
`predictedEntity.test.ts` 53 (new, its own matrix is in the file map), against
a whole-tree 1101 (was 901). Cases were only ever ADDED, and a case added around a
guard reddens with it, so every `reddens` number below is a LOWER BOUND on the
current tree and none of them needs re-measuring to be trusted in the direction
that matters. A count that goes UP means cases were added around the guard; a
count that goes DOWN, or falls to zero with no defence-in-depth note beside it,
is a guard losing its pin and is the thing to investigate. Re-measure the whole
table when you touch a file, not only the rows you think you moved, and
re-measure it against a copy rather than in place. Delete any untracked
`src/__verify_*` first: vitest collects them and they inflate every whole-tree
number here.

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

WHOLE-TREE, THAT SAME MUTATION REDDENS MORE THAN THE FOUR, in another file, and
it is worth knowing before you read a partial run as a clean one:
`ticker.test.ts`'s `reports lease-lost when the SYNCHRONOUS guard is the only
finder` also fails, because a `lastOwnedAt` refreshed by failures is exactly
what stops the pre-publish guard from ever firing. Re-measured on the quiet tree
on 2026-09-02 at 5 failed across the whole 901-test suite against 4 in
`lease.test.ts` alone, so exactly one `ticker.test.ts` case catches it; this line
said 6 (and before that "a fifth case" and "5 failed / 588 passed", on a 593-test
tree).
Whole-tree mutation counts rot faster than any other number in this file,
because every file's cases contribute to them.

The interpolator's shortest-arc heading was checked the same way: replacing
`lerpHeading`'s body with `a + (b - a) * t` reddens
`heading interpolates the shortest arc across the +-pi wrap` (rendered 0 against
a bound of 2.5) and nothing else. It did NOT redden before that test was
rewritten to bracket a real midpoint, which is how the test was found to be
vacuous in the first place.

The re-anchor's still-arriving GATE was checked by deleting the one line that
enforces it (`if (this.pushesSinceErrorStart < REANCHOR_MIN_SAMPLES) return
false;`), which reddens five cases: the latency-step test,
`does NOT re-anchor when the stream simply stops`,
`ONE straggler is not enough evidence to re-anchor on`, the out-of-order
cut test, and `a clean ticker handoff unwinds the extrapolation as a glide`.
Do this again if you touch `trackPlayheadError`, because without the
gate the mechanism fires on an ordinary outage, where there is nothing to anchor
to and it can only make things worse.

The ticker's two lease-lost exits were checked the same way, and the third
mutation is the interesting one. Deleting `exitReason = 'lease-lost'` from the
SYNCHRONOUS guard (section 7) reddens 4, led by
`reports lease-lost when the SYNCHRONOUS guard is the only finder`; changing the
ASYNC path's assignment (section 12) to `'duration'` reddens 5, led by
`reports lease-lost when the ASYNC renew is the finder`. Both of those said
"only" until the 2026-09-02 quiet-tree re-measure. That sibling was added
on 2026-09-02 and this line used to name `stops publishing once the lease is
stolen mid-run`: strengthening that case (it asserted nothing about publishing,
see below) meant pacing it onto the SYNCHRONOUS finder, which left section 12
with no test at all until the sibling was written. STRENGTHENING A TEST CAN
ORPHAN A MUTATION: when you make a case select a specific detector, check what
the OTHER detector lost. Deleting
`lostLeaseExplicitly = true` from the loop's renew outright now reddens ONE
(`the ASYNC renew logs its own lease loss, which for a long time only the
synchronous finder did`), and deleting the setup renew's copy as well makes it
two; this line read "leaves all 35 green" and that was true when it was written,
before the sibling case that pins it existed. The synchronous guard still catches
the same loss and reports the same reason, which is the defence in depth the fix
creates rather than a hole. Doing BOTH (the pre-fix code with only the
synchronous finder left) reddens 6, 7 with the setup renew's flag deleted too,
and reproduces the original flake exactly and deterministically on the two cases
it was found on: `expected 'duration' to be 'lease-lost'`.

EVERY GUARD IN `interpolation.ts` NOW HAS A MUTATION THAT REDDENS IT, and the
matrix below is the record. Re-run it after any change to that file; a green
suite over a guard that cannot fail is the exact trap this module has fallen
into twice.

THREE OF THESE COUNTS WERE STALE AT HEAD AND WERE CORRECTED ON 2026-09-02, which
is the same lesson this file already records about the four "redundant" paths:
a count is a statement about the tree it was measured on. The dead-epoch cut read
3 and is 4; the future-stamp refusal read 2 (as a pair of named cases) and is 3;
the same refusal made permanent read 1 and is 3; the still-arriving gate read 4
and is 5. Nothing about the code regressed and no guard weakened. Cases added
around a guard redden with it, so the number climbs on its own and the file
quietly goes out of date. Re-measure the whole table when you touch the module,
not only the rows you think you moved.

| mutation | reddens |
| --- | --- |
| finiteness guard off (serverTime, or receivedAt) | nothing ALONE, see note |
| `nowMs` finiteness guard deleted | `a NaN nowMs cannot smuggle a re-anchor past the REANCHOR_AFTER_MS wait` |
| still-arriving gate deleted | 5 cases |
| single-sample gate restored (`=== 0`) | `ONE straggler is not enough evidence to re-anchor on` |
| re-anchor removed entirely | 6 cases |
| naive front-splice in `pruneFrames` | `the count cap never evicts the frame the playhead is bracketing against` |
| dead-epoch cut deleted | 4 cases |
| time-prune suspension removed | 2 cases |
| re-anchor uses the whole offset window | 5 cases |
| delay snap on re-anchor removed | `the re-anchor snaps the delay to its target` |
| post-re-anchor playhead recompute removed | 2 cases |
| future-stamp refusal not applied | 3 cases |
| future-stamp refusal made PERMANENT | 3 cases |
| dead-epoch cut keyed on the LAST arrival | `an out-of-order arrival on the re-anchor own render frame ...` |
| delay slew cap removed (`maxStep` unbounded) | `ONE 450ms hold does not leave every entity running fast and then slow ...` |
| the unwind glide removed entirely | 2 cases |
| the glide's clamp to its own overshoot removed | `a real teleport still snaps, because the glide may only hide the extrapolation it made itself` |
| the glide differenced against last frame's pose, not the projected guess | `a REPEATING 450ms stall is still absorbed at the capped slew rate` |
| discontinuous-frame check removed (the speed smoother believes a clamped `dt`) | `a discontinuous render frame reports a real speed rather than a 10,000 u/s spike` |
| a zero-length frame zeroes the stored speed | `sampling twice at the same nowMs leaves the measured speed alone instead of zeroing it` |
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
| `resumeFrom` made a no-op | 1 |
| the resume glide clamped like the extrapolation UNWIND (to this module's own overshoot, which is zero here) | 1 |
| `clear()` no longer drops the resume seed | 1 |

THE CONNECTION'S THREE NEW SEAMS EACH HAVE A MUTATION. Disabling the
interpolator push in `processSnapshot` reddens eight cases in
`connection.test.ts` (three when this was written); stamping `serverTime` from
the local clock instead of the decoded one reddens `pushes each snapshot itself ...` with
`expected 253.038833 to be greater than 1600000000000` (the two clock domains
are ~1.7e12 apart, which is what makes that assertion unfakeable); deleting the
`interpolate?.into.clear()` from `beginEpoch` reddens four, led by `clears the
interpolator on a reconnect ...`; and deleting `this.clock.advance(dt)` from
`frame()` reddens three: both tick cases at `expected +0 to be 20` and
`expected +0 to be 10`, plus `a successor stamping +600ms of clock skew
settles`.

For the codec: removing the entity-id range check now reddens NOTHING, and that
is defence in depth rather than a hole, arriving after this line was written.
`ByteWriter.u16` became a trust boundary of its own in the same audit and refuses
the identical value with the identical `CodecError`, so `throws CodecError on an
id past the u16 ceiling ...` stays green either way; deleting BOTH is what
reddens it, and the writer's own row (`ByteWriter`'s integer range checks
removed, 12) is what pins that half. Ignoring `axisScale` on both halves still
reddens exactly `axisScale moves the boundary ...` at `expected 1 to be 64`.

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
| `renewConfirmed` re-anchors `lastRenewAt` to `now` again | 4 in `lease.test.ts`, including the traced split brain (`expected 5500 to be 1500`) |
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

### The 2026-09-02 audit's own matrix, one table per file

Every guard the audit added has a mutation that reddens it, and all of the
numbers below were re-measured directly rather than carried over from the slices
that wrote them. Each run is scoped to the file's own test file (or its
directory), so a count here is "how many cases in that file", not a whole-tree
figure. Re-run the table for a file before believing a green suite over it.

THE PER-FILE CASE TOTALS IN THE HEADINGS ARE THE CURRENT ONES, AND EVERY COUNT
BELOW HAS NOW BEEN RE-MEASURED AGAINST THEM. Cases kept landing while the matrix
was first written, and then the verifier round landed a batch more in every one
of these files: `ticker.test.ts` was 95 when its rows were first measured and is
113, `relay.test.ts` was 70 and is 84, `connection.test.ts` was 58 and is 79,
`src/adapters` was 41 and is 52. Those numbers were lower bounds for as long as
that gap stood, and they are not any more: the 2026-09-02 quiet-copy re-measure
above re-ran every row at exactly these totals, so a `reddens` number here is
EXACT for that snapshot rather than a floor over it. A number that goes DOWN
from here, or falls to zero with no defence-in-depth note beside it, is a guard
losing coverage, which is still the only direction that matters.

THE VERIFIER ROUND'S OWN GUARDS ARE MEASURED NOW, AND THIS PARAGRAPH USED TO
SAY THEY WERE NOT. Every fix in that round shipped with the case that fails
without it, and every one of those cases now also has the mutation that
reddens it: the ticker's grid continuation and adoption window, its chained
checkpoint writes, its fixed crash window, its pre-loop teardown and setup
renew, its standby flag, its lifetime clock and its unstamped-record rule; the
relay's open deadline, control queue, send-failure run, fragmented ping,
resolved close code and `room-reject` connection id; the adapters' two floors
and their guarded upgrade catch; the connection's terminal ordering, RTT
window, swap limits, plausibility bounds and resume seed. They are in the
per-file tables below, with a DEFENCE IN DEPTH note wherever a cell is green
because another guard covers the same behaviour. Nothing from that round is
owed a row. What is owed is a RE-MEASURE: a count here is a statement about the
tree it was taken on, so re-run a file's table before believing a green suite
over it.

`src/server/ticker.ts`, against `ticker.test.ts` (113 cases), plus
`tests/checkpoint.redis.test.ts` where a row names it:

| mutation | reddens |
| --- | --- |
| a thrown ticker writes a final checkpoint again | 1 |
| the input-dead probe exit removed | 2 |
| the probe's owner filter removed | 1 |
| the checkpoint write's owner check dropped | 2 |
| a leave from a replaced relay connection honoured | 1 |
| the starvation streak run on a buffer that still holds entries | 1 |
| the input window pushed oldest-first after the first consume | 1 |
| the setup renew removed (nothing renews between the acquire and the loop) | 2 |
| the presence timeout removed | 1 |
| the crash-loop limit removed (a poisoned checkpoint is always restored) | 1 |
| the in-flight publish bound removed | 1 |
| `serverTime` stamped after the sim step again | 3 |
| the post-stall resync fires the next tick with no sleep | 1 |
| the checkpoint read retry removed (one thrown GET starts the room fresh) | 2 |
| `guardHost` stops catching (a host hook's throw unwinds the loop) | 4 |
| the standby successor never spawned | 5 |
| the `c` dropped from the `room-reject` frame the ticker publishes | 1 (`names the CONNECTION on a room-reject ...`) |
| the setup throw path releases nothing (`abandonSetup('error', false)`) | 2, both `a throw during setup` cases |
| `clearInterval(setupRenewTimer)` deleted from `abandonSetup` | 1 (`... when runtime.create throws`, at `expected 7 EVALs to be 1`: the lease key alone cannot see a leaked interval, only the renew traffic can) |
| the grid continuation removed (a successor restarts at its own `Date.now()`) | 2 |
| the grid adoption window back to a symmetric one tick | 1 (`continues a grid that is already a tick and a half in the PAST ...`) |
| the standby flag not cleared on a REJECTED spawn | 1 |
| the standby flag set only on RESOLVE | 1 |
| the standby re-fire guard removed | 5 |
| the crash counter cleared at the first checkpoint again | 1 |
| the setup-lease-loss exit returns without teardown | 1 |
| the `'reconnecting'` listener never detached (two mutations) | 1 each |
| the periodic checkpoint write taken off the promise chain | 1 (`expected 1 to be greater than or equal to 13`) |
| the crash window made SLIDING (an `EXPIRE` on every crash) | 1 |
| the probe deadline back to `3 * statsMs` | 1 |
| the `onEvents` throw logged per call, and the same throw not counted (two mutations) | 1 and 1 |
| the lifetime dated from the acquire instead of from invocation entry | 1 |
| `alreadyHandedOver = standbySpawned` (the duration check dropped) | 1, the rewritten standby case |
| a late `false` setup renew reply not setting `lostLeaseExplicitly` | 1 |
| the fake's owner-checked script matched on `numKeys === 2` only | nothing ALONE, see note |
| `stamped = null` dropped (an unstamped record no longer discards the stamped ones earlier in its window) | 1 |
| `targetTick` validation back to `(targetTick ?? 0) > 0` | 1 |
| `renewConfirmed`'s `max(lastOwnedAt, attemptAt)` dropped, at each of its three sites | 1 each |
| the subscriber's envelope shape check removed | 1 |
| the probe answer's monotonic `n` bound removed | 1 |
| the pre-loop wait for a grid point still in the FUTURE removed | 1 |
| the in-flight publish bound compared AT the boundary rather than past it | 1 |
| the checkpoint cadence compared AT the boundary | 1 |
| the presence timeout compared AT the boundary | 1 |
| `tickerShouldExit`'s boundaries, each side | 1 each |
| `RENEW_SCRIPT`'s owner clause deleted | 3 in `lease.test.ts`, 39 across `src/server` + `src/core` |
| `RELEASE_SCRIPT`'s owner clause deleted | 2 |
| the crash counter's `Number.isFinite` check removed | NOTHING, an EQUIVALENT MUTANT: see the note |
| `owns &&` dropped from the async renew | NOTHING, an EQUIVALENT MUTANT: see the note |

THE NOTE ON THE FAKE'S SCRIPT MATCHING, because a green cell there is a claim
about coverage and would otherwise read as a vacuous test. `memoryRedis.ts`
(`testFakeRedis.ts` when this was measured) recognises the checkpoint SET's Lua by shape, and narrowing that recognition to
`numKeys === 2` reddens nothing: the two forms are equivalent for the three
scripts this library actually sends, so every case stays green either way. It
is defence against a FOURTH script arriving and being matched by accident, not
coverage of the owner check itself. What pins the owner check is the real-Redis
pair in `tests/checkpoint.redis.test.ts`, which runs the shipped Lua against a
real server and never goes through the fake at all.

AND ITS SIBLING, WHICH IS THE ONE THAT ACTUALLY MATTERED: THE FAKE'S `eval`
USED TO APPLY OWNER SEMANTICS ITSELF, WHATEVER THE SCRIPT SAID. Deleting the
`get(KEYS[1]) == ARGV[1]` comparison from `RENEW_SCRIPT` or `RELEASE_SCRIPT`
therefore left the WHOLE OFFLINE SUITE GREEN: three lease cases were vacuous,
and the only file that caught it was `tests/lease.redis.test.ts`, which skips
without a Redis and so is exactly the file a laptop and a misconfigured CI both
skip. The fake now DETECTS the owner clause in the script text and a script
without it performs the unconditional operation, so the Lua's own semantics are
visible offline: deleting `RENEW_SCRIPT`'s clause reddens 3 in `lease.test.ts`
and 39 across `src/server` + `src/core`, and `RELEASE_SCRIPT`'s reddens 2. THE
REUSABLE PART: a fake that implements the BEHAVIOUR its subject is supposed to
have, rather than the behaviour its subject's INPUT describes, cannot fail on
the one change it exists to catch. `lease.test.ts`'s own local fake was fixed
the same way.

`src/server/relay.ts`, against `relay.test.ts` (84 cases), plus
`admission.test.ts`, `redis.test.ts` and `tests/subscriber.redis.test.ts` where
a row names them:

| mutation | reddens |
| --- | --- |
| the snapshot backlog cap removed | 2 |
| a snapshot forwarded to a socket that is not OPEN | 1 |
| the ping answered only after `decodeInput` (interception removed) | 4 |
| `room-reject` forwarded verbatim instead of consumed | 5 |
| `room-reject` consumed but not AIMED (the pid filter dropped) | 1 |
| the subscribe bound removed | 1 |
| the subscriber `'end'` handler removed | 1 |
| the spawn hold-off removed | 2 |
| the `readyState` check at attach removed (a dead-on-arrival socket attaches) | 2 |
| the CONNECTING deferral removed (the session starts on a socket that cannot send) | 4 |
| `cleanup` after `terminate()` removed | 1 |
| the connection id dropped from join and leave | 2 |
| the lifetime timers removed | 2 |
| `commandTimeout: 5000` restored on `createSubscriber` | 1 in `redis.test.ts` (`createSubscriber sets NO commandTimeout ...`); the integration control in `tests/subscriber.redis.test.ts` measures the process death itself |
| the open deadline's body disabled | 1 (`a socket that never opens is cleaned up at the open deadline ...`) |
| `refuseSocket`'s `'open'` listener not registered | 1 |
| the final refusal attempt no longer closes a never-opened socket | 1 |
| the `room-reject` `c` check deleted (matched on pid alone again) | 1 (`ignores a reject for its own pid that names a DIFFERENT connection`) |
| `stopRegistration()` dropped from `admitSocket`'s catch | 1 in `admission.test.ts` |
| control frames attempted while not OPEN (the queue removed) | 2, the queue case and the bound case |
| the send-failure flush removed | 1 |
| the consecutive-send-failure limit removed | 1 |
| the fragmented-ping array arm removed | 1 |
| `CONN_TOUCH_MS` raised to 25s | 1 in `admission.test.ts` |
| the raw (undefined) close code handed to the transport again | 2 |
| the 128-byte ping cap dropped from the STRING arm | 2 |
| the 128-byte ping cap dropped from the BUFFER arm | 1 |
| the fragmented ping's per-part type check dropped | 1 |
| `refuseSocket`'s two latches collapsed into one | 1 in `admission.test.ts` |
| the relay self-probe removed entirely | 1 |
| the self-probe's `n <= sent` upper bound removed | 1 |
| the `metaout` allowlist removed (per-socket library frames forwarded again) | 1 |
| the pong reply sent outside `rawSend` (a failing pong no longer counts) | 1 |
| the roster seed map built with `{}` instead of `Object.create(null)` | 1 |
| the roster seed's plain-object value check removed | 1 |
| the spawn hold-off's reset on a live lease removed | 1 |
| `'open'` handled twice (the idempotence guard removed) | 1 |
| a zero-record input frame no longer short-circuited | 1 |
| the `HEXISTS` reply compared as a number rather than the string `'1'` | 1 |
| a corrupt stats value refusing admission rather than admitting | 1 |
| the backlog bound compared AT the boundary rather than past it | 1 |
| the liveness bound compared AT the boundary | 1 |
| `registerConnection`'s `EXPIRE` dropped | 1 in `admission.test.ts` |
| `registerConnection`'s `clearInterval` dropped | 1 in `admission.test.ts` |
| the gzip plain-text fallback removed | 1 in `server/checkpoint.test.ts` |
| `&& !closed` dropped from the send-failure terminate | NOTHING, an EQUIVALENT MUTANT: see the note |

THREE EQUIVALENT MUTANTS ACROSS THE SERVER TABLES, AND THEY WERE PROVED RATHER
THAN SHRUGGED AT: each one was replaced with a THROW and the whole suite run,
and nothing threw, which is what distinguishes "this branch cannot be reached"
from "no test covers this branch". `owns &&` on the async renew is unreachable
because both sites that clear `owns` break out immediately.
`Number.isFinite(crashes)` is unreachable because `parseInt` yields an integer
or `NaN` and `NaN >= limit` is already false. `&& !closed` on the send-failure
terminate is unreachable because every `rawSend` caller re-checks `closed`
first. Record all three as dead defensive code, the same category as the
interpolator's `frac` clamp. Tests exist for the latter two anyway, because they
pin real behaviour from the other direction; none of the three is owed a
mutation row that reddens.

MORE DEAD CODE, RECORDED SO NOBODY ADDS A TEST FOR IT. A 137-mutation sweep
identified these as unreachable rather than untested: `pruneAtOrBelow`'s `<=`
(the floor's own entry is already deleted), `decodeInputWindow`'s `count <= 0`
early return, the `raw.length >= 2` magic-byte precheck, the relay's
`typeof buffered === 'number'` and `Math.max(0, lead)`, the ticker's
`channel !== keys.in`, `connection.ts`'s `if (fresh)` on the terminal field and
its `terminalReason !== null` in `handleClose`, and `shouldSpawnTicker`'s
`=== null`. Adding a case for any of them writes a test that cannot fail, which
is the exact thing this whole section exists to find.

`src/client/connection.ts`, against `connection.test.ts` (79 cases):

| mutation | reddens |
| --- | --- |
| the measured RTT and feedback terms dropped from `desiredTick()` | 4 |
| the `inputLead` feedback term alone dropped | 2 |
| the server clock differenced against `Date.now()` again | 1, and see the reading note |
| the server clock's step escape removed | 2 |
| a 4001 close always terminal (no stale-token re-mint) | 1 |
| an `ArrayBufferView` decoded as its whole backing buffer | 1 |
| `ProtocolVersionError` swallowed instead of triggering skew recovery | 1 |
| the arrival gauges carried across an epoch boundary | 1 |
| the hold on the last poses across a cold reconnect removed | 3 |
| `mint()`'s output trusted (session validation removed) | 8 |
| the connect deadline removed | 1 |
| the frozen-render-frame unanchor removed | 2 |
| the re-anchor's stall projection removed (`clientTick` back to the raw counter) | 2 on the 122-case tree (`A STALL IS NOT DRIFT`, 250ms and 120ms) |
| the warm swap's deadline left at `connectTimeoutMs` | 2 |
| `room-full` latches without closing the socket | 1 |
| `processSnapshot`'s finiteness guard removed | 2 |
| the RTT ceiling (`RTT_MAX_SAMPLE_MS`) alone removed | nothing ALONE, see note |
| the close path's schedule-before-announce order alone reversed | nothing ALONE, see note |
| `onTerminal` fired BEFORE the teardown | 1 |
| the terminal status settled after the callback rather than before it | 1 |
| the frozen-render pong guard dropped | 1 |
| `rttMs` back to an EMA | 2 |
| the RTT ceiling removed AND the EMA restored | 2 |
| a terminal keeps the held poses | 1 |
| the room check dropped from `beginEpoch` | 1 |
| a restart from a terminal takes the awaited mint path | 1 |
| `onStatus` unwrapped (not routed through `emit()`) | 2 |
| `onStatus` unwrapped AND the close path's announce moved before the schedule | 3 |
| the RTT window carried across a new epoch | 1 |
| the arrival gauges kept across a WARM SWAP | 1 |
| the swap rate limit removed | 1 |
| the swap deadline floor removed | 1 |
| `lastSwapStartedAt` back to a 0 sentinel | 6 |
| the snapshot plausibility bounds removed | 2 |
| the implausible-snapshot refusal made PERMANENT | 1 |
| the provisional-anchor reset removed | 1 |
| `lastReanchorAt` back to a 0 sentinel at the DECLARATION and in `beginEpoch` | nothing ALONE, and it is a SHADOWED sentinel rather than a hole: see the note |
| ...and at the THIRD site too (`observeRtt`'s provisional-anchor drop) | 1 (`the first pong of an epoch invalidates an anchor taken with no round trip`) |
| the client clock's slew clamp removed | 1 |
| the client clock's sample-count gate removed | 1 |
| the client clock's step-evidence reset removed | 1 |
| the client clock's window bound removed | 1 |
| the client clock's negative-elapsed guard removed | 1 |
| a swap attempted after `stop()`, after a terminal, or with one already pending | 1 |
| a TEXT frame allowed to complete a swap | 1 |
| the status dedupe removed | 1 |
| `send`'s `readyState` check removed | 1 |
| `sendPing`'s `readyState` check removed | 1 |
| `estimateServerTick` answering before the clock is seeded | 1 |
| the pong sample's sign and finiteness check removed | 1 |
| the arrival-gap ring cap removed | 1 |
| `badMints` compared at the boundary rather than past it | 1 |
| the RTT window bound compared at the boundary | 1 |
| the provisional-anchor threshold compared at the boundary | 1 |
| the `inputLead` feedback deadband removed | 1 |
| the `inputLead` feedback step clamp removed | 1 |
| the `inputLead` feedback range clamp removed | 1 |
| `terminalReason !== null` in `handleClose` deleted | NOTHING, and it is DEAD CODE: see the note |
| `resumeFrom` never called from `beginEpoch` | 2 |
| the resume seed handed over BEFORE the clear | 2 |

THE `lastReanchorAt` SENTINEL ROW IS A SHADOWED SENTINEL, NOT A HOLE, AND THIS
FILE CALLED IT A HOLE UNTIL THE COMPLETENESS ROUND WENT LOOKING FOR THE TEST TO
CLOSE IT. Putting the 0 sentinel back at both places that mean "no anchor yet"
(the field initialiser and `beginEpoch`'s reset) reddens NOTHING, and the reason
is structural rather than a missing case: the FIRST anchor of every epoch
short-circuits `shouldReanchor` and writes a real `performance.now()` reading
into the field before the rate limit is ever consulted, so neither of those two
assignments can be observed. Writing a case for them would be writing a case for
a value nothing reads. THE THIRD SITE IS THE OBSERVABLE ONE and it is pinned:
`observeRtt`'s provisional-anchor drop deliberately RESETS the field so the next
snapshot can correct an anchor taken with no round trip, and putting 0 there
reddens `the first pong of an epoch invalidates an anchor taken with no round
trip`. That is the row above. `lastSwapStartedAt`, the other half of the
invariant "NEVER 0 FOR 'NOT YET' ON A `performance.now()` AXIS", is pinned hard
(6) and is where the invariant earns its keep; on `lastReanchorAt` the invariant
is now a rule about what the code MAY do rather than a claim about what a test
would catch.

THE `terminalReason !== null` ROW IS DEAD CODE, PROVED RATHER THAN ASSUMED. Both
callers of `handleClose` are gated on `this.ws === socket`, and `enterTerminal`'s
very next statement nulls `this.ws`, so no close event can reach the branch after
a terminal. Instrumented across all 112 cases in the file: ZERO hits. Record it
as dead defensive code, in the same category as the interpolator's `frac` clamp,
and do not write a test for it.

THE READING NOTE ON THE SERVER-CLOCK ROW, because that row's mutation has more
than one honest form and they measure very differently. Taking the offset SAMPLE
against `Date.now()` while the playhead stays on `performance.now()` reddens 15,
and so does putting `serverNow()` alone on `Date.now()`: both mix the two clock
domains, which is roughly every case that touches the clock. Moving BOTH sides
onto `Date.now()` together, which is the coherent pre-fix shape, reddens exactly
1, `a wall-clock step moves nothing: the offset lives entirely on the monotonic
clock`, and that is the number in the table because it is the one that isolates
what the fix actually bought. This row read 6 before the re-measure and no
reading reproduces 6.

THE TWO "NOTHING ALONE" CELLS ARE DEFENCE IN DEPTH, NOT HOLES, and they are
recorded exactly the way the interpolator's finiteness row is, for the same
reason: a green cell left unexplained reads as a vacuous test. The RTT
ceiling's cover is the SLIDING-WINDOW MINIMUM, which already ignores a sample
that large, so deleting the ceiling alone preserves the behaviour and the cases
stay green; deleting it together with the minimum (the EMA restored) reddens
one. The frozen-render discard is not the other half of that pair and has a
mutation of its own, in the rows above. The close path is the same shape:
`emit()` stops a throwing `onStatus` from unwinding the class and scheduling
the reconnect before announcing leaves nothing to unwind, so reversing the
order alone changes nothing, unwrapping `onStatus` alone reddens two, and doing
both reddens three. Measured every way in both pairs. What it costs is that the
ceiling and the announce order have no mutation of their OWN, so the ordering
in each pair is load bearing and a future edit that removes one must check the
other is still there.

`src/client/netPolicy.ts`, against `netPolicy.test.ts` + `connection.test.ts`
(97 cases together, because `shouldReanchor`'s caller is where three of these
are observable at all):

| mutation | reddens |
| --- | --- |
| the `clockStepping` gate deleted | 2 |
| re-anchor made ahead-only again | 5 |
| the tolerance path's rate limit removed | 4 |
| the unbounded-ahead path gated by `clockStepping` too | 1 |

`src/codec/`, against `src/codec` (109 cases):

| mutation | reddens |
| --- | --- |
| `ByteWriter`'s integer range checks removed (silent wraparound is back) | 12 |
| `quantize`'s NaN refusal removed | 2 |
| `decodeDefaultSnapshot`'s version check removed | 2 |
| the up-front ENTITY-COUNT check's field name changed | 1, pinned on the MESSAGE: see the note |
| the up-front EXTRA-LENGTH check's field name changed | 1, pinned on the MESSAGE |
| a plain `Uint8Array` no longer decoded as UTF-8 | 1 |

THE TWO UP-FRONT CHECKS ARE DEFENCE IN DEPTH AND ARE PINNED ON THEIR MESSAGE,
which is the only thing about them that is not already covered. `ByteWriter.u16`
refuses the identical values with the identical `CodecError`, so DELETING either
check reddens nothing: the value is refused either way. What the check buys is a
message naming the FIELD (`entities`, `extra`) rather than a generic range
error, and that is what the two cases assert. A green cell on a deletion here is
the writer doing its job, not a hole; a red one on a message change is the point.

`src/core/`, each against the suite that can observe it:

| mutation | reddens |
| --- | --- |
| `decayOnStarve` back to the pre-increment streak | 3 (`src/core` + `ticker.test.ts`, 319 together) |
| `lateCount` incremented before the freshness check | 2 in `src/core` (206) |
| the spawn token accepting a third window | 1 in `session.test.ts` (19) |

`src/adapters/`, against `src/adapters` (52 cases):

| mutation | reddens |
| --- | --- |
| `maxRunMs` no longer derived from the route's `maxDuration` | 3 |
| the platform cap allowed to RAISE the ticker lifetime as well as lower it | 1 |
| the `maxRunMs` fit check at route creation removed | 1 |
| the relay's `lifetimeMs` no longer derived from `maxDurationS` | 11 |
| the standby flag dropped from the spawn URL | 1 |
| the ticker options re-listed instead of spread | 1 |
| the relay options re-listed instead of spread | 1 |
| the ticker floor check (`MIN_TICKER_RUN_MS`) deleted | 2, including the explicitly negative `maxRunMs` |
| the relay floor reverted to ONE expiry lead (`RELAY_EXPIRY_LEAD_MS + 1000`) | 2 |
| the relay floor check (`MIN_RELAY_LIFETIME_MS`) deleted entirely | 3 |
| the upgrade catch rethrows instead of logging, closing 1011 and resolving | 2 |
| the vercel logger call inside that catch left unguarded | 1 |
| the node logger call inside its own catch left unguarded | 1 |

THE TWO ADAPTER ROWS ABOUT THE PLATFORM CAP ARE A PAIR, and only having both
pins the DIRECTION. `min(MAX_TICKER_MS, platformCapMs - TICKER_EXIT_MARGIN_MS)`
has to fail two different ways: dropping the `min` entirely (so a low
`maxDuration` no longer lowers the lifetime, the original bug) and dropping the
`MAX_TICKER_MS` term (so a high `maxDuration` silently RAISES it, which is a
different bug wearing the fix's clothes). A single mutation would have left one
of those free.

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
  `AdmissionResult.socketCapEvaluated`. That was originally logged on by both
  adapters and the node example, three times over, which is exactly the
  duplication `server/admission.ts` later collapsed: `admitSocket` emits the one
  `relay.socket-cap-unevaluated` line now and no host writes it. The
  stale-entry prune counts toward it as well as the
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

### Defects found by an exhaustive audit and fixed (2026-09-02)

NINE FINDER LENSES OVER THE WHOLE LIBRARY, 69 FINDINGS, most of them MEASURED
with a scratch harness rather than reasoned about. The lenses were: the client
render path, the client tick and inputs, the connection lifecycle, the ticker
loop, the lease and checkpoint and handoff, the relay, Redis fault modes, the
codec, and the architecture seams themselves. This is the largest single change
the library has taken and it is where `core/wire.ts` and `server/admission.ts`
came from. Everything below is fixed and pinned unless the last group says
otherwise; the mechanism of each one is written up in the gotchas and the
invariants above, and this list is the index.

CLIENT SMOOTHNESS, which is what a player actually experiences.

- Any render frame longer than 250ms left the client tick PERMANENTLY behind the
  server, because the `dt` clamp drops the excess and the re-anchor only fired
  on the ahead side. Measured: 30 seconds backgrounded, still 591 ticks behind
  fifteen seconds later.
- The stamping lead was a flat 4 ticks with NO round-trip term, which is 200ms of
  total budget at 20Hz and 67ms at 60Hz, so every player past roughly 200ms RTT
  stamped every input into a tick the server had already simulated, for the whole
  session.
- `stats().rttMs` paired the oldest outstanding send with the next SNAPSHOT, so a
  host sending at the tick rate into a room publishing at the tick rate measured
  roughly U(0, tickMs). It did not move with latency at all, and `desiredTick`
  was about to start leaning on it.
- A routine 300 to 600ms handoff left the lead permanently inflated (never
  corrected under 20 ticks) and starved the successor's playout buffer into the
  decay backstop.
- The connection's server clock ran on `Date.now()` while every other timestamp
  ran on `performance.now()`; one wall-clock step snapped the counter about 20
  ticks.
- ONE non-finite `serverTime` poisoned the connection's clock EMA forever, the
  same shape the interpolator had already been bitten by through a different door.
- Every reconnect blanked all remote entities until the new epoch's first
  snapshot, and on Vercel a reconnect is ROUTINE: the relay's own 800s cap drops
  every socket in the fleet every thirteen minutes.
- The ticker's post-stall resync ran the next tick with no sleep, producing twin
  snapshots 0 to 1ms apart on the playback axis, rendered as a 5000 u/s burst.
- `serverTime` was stamped AFTER `runtime.tick`, writing compute variance into
  the playback axis: a step alternating 3ms and 28ms rendered constant velocity
  at anywhere from 0.5x to 2.2x.
- The interpolation delay eased as a fraction of the difference with no wall-time
  cap, so one 450ms hold cost 131 frames outside +-10% of true speed.
- A clean handoff ended with a 10.4 unit BACKWARD snap when the extrapolation was
  unwound in a single frame.
- `InterpolatedEntity.speed` spiked past 10,000 u/s after a render gap, because a
  real elapsed time was divided by a clamped `dt`.
- The relay's snapshot forward was a reliable unbounded queue on a lossy bus:
  7.65MB for one paused socket, replayed as a stale burst.
- Publishes queued during a Redis blip replayed as a burst that inflated every
  client's delay to about 470ms and held it there for six seconds.

FAILURE POINTS ON THE SERVER, most of which are silent by construction.

- A deterministic throw in `tick()` wrote a final checkpoint of the half-mutated
  state and spawned a successor that restored it and threw again: 40 spawns in
  958ms, forever.
- The ticker's input subscription had no liveness at all: a black-holed
  subscriber left a room ticking, publishing and renewing with every input
  dropped and every metric green. Measured over 4 seconds: zero log lines.
- `await sub.subscribe` was unbounded, and on the rare occasion it DID reject the
  ticker logged and carried on holding a lease over a room it could not serve.
- No `commandTimeout` on the shared client, so a black-holed connection hung
  every fire-and-forget promise and the one awaited renew forever, and `finally`
  never ran.
- A thrown checkpoint READ was treated as an absent checkpoint: one rejected GET
  took a room from tick 45 to tick 3 and a new incarnation.
- A `leave` lost in a handoff gap left a phantom player restored by every
  successor forever, and the room never drained.
- A grace-period rejoin into a full room was refused as a NEW arrival, because
  `leave` cleared `present` even while the simulation still held the player.
- A stamped input whose payload made `applyInput` throw took the whole ROOM down
  (the consume pass had no guard at all), and the arrival path logged a warn line
  PER ENVELOPE: 51 lines for 51 `{data:null}` inputs.
- Nothing renewed the lease between the acquire and the first iteration, so an
  `init` plus restore longer than `leaseTtlMs` lost the lease before the loop ran
  once, and the successor paid the identical setup and lost it identically.
- Checkpoint writes were plain SETs gated on the local `owns` flag; an ex-owner
  overwrote a successor's checkpoint three times inside 1.5s on real Redis.
- `renewConfirmed` was dated from the reply rather than the attempt: 27
  predecessor snapshots published after a successor legitimately held the lease,
  with a 600ms delayed reply.
- `attachRelay` on an already-closed socket became a permanent zombie, because
  `terminate()` on a CLOSED socket emits nothing.
- The relay's lease poll had no hold-off: 20 sockets fired 41 invocations during
  one 2.5s cold start.
- A relay whose subscriber died left the player on an open, deaf socket.
- The spawn token never expired and rode the query string, which platform access
  logs keep well past the request.

AUTHORITY, DX AND THE SEAMS THEMSELVES.

- The ticker's `room-reject` had NO consumer: broadcast to every socket, re-sent
  every heartbeat, and ignored by the client, so the refused player streamed the
  room forever with no entity in it and no idea why.
- Version-skew recovery could not fire when the decoder THREW on a mismatch,
  which is exactly what this repo's own pong codec does. A deploy that bumped the
  wire left every old client silently dropping every frame.
- `ByteWriter`'s integer setters wrapped silently: state 300 became 44,
  `targetTick -1` became 4294967295, and a 70000-byte extra decoded as 4464.
- NaN through the quantiser encoded as 0, teleporting its entity to the origin.
- `RoomConnection` decoded a typed-array view's whole backing buffer, which on
  Node's pooled small allocations is 8192 bytes that are mostly somebody else's.
- Both adapters hand-copied a SUBSET of the server options, so twenty options,
  including `metaPayload` (itself the landed fix for a real game's roster), were
  unreachable from the route factories the README recommends.
- The admission protocol and its close codes lived in the Vercel adapter, were
  imported from there by the node adapter, and were copied into the example.
- Async `void` hooks typechecked, and a rejection killed the process before
  `finally` could run.
- The contract file documented a DELETED client dilation controller, a `seq` echo
  nothing performed, and a `ts` field nothing read.
- `decayOnStarve` expected the pre-increment streak while `onStarve` delivered
  the post-increment one, so the decay fired on the FIRST starve, against the
  module's own stated contract.
- `PlayoutBuffer.lateCount` counted every already-consumed re-send, which is 3
  per packet on a healthy link.
- Nothing tied `maxRunMs` to the route's own `maxDuration`.
- The README quickstart stamped `targetTick` while its runtime never opted into
  the playout buffer, and its `mint` had no `res.ok` check.

NOT FIXED, DOCUMENTED INSTEAD, and both are honest limits rather than oversights.

- AN UNPLANNED DEATH TAKES 5 TO 7 SECONDS TO RECOVER, measured: the lease TTL,
  plus the relay's jittered poll, plus a cold spawn. So the stall banner DOES
  fire on every hard death, and the restored checkpoint may be up to
  `checkpointMs` old, which is a tick REGRESSION of up to 20 ticks rather than
  merely a gap. The 3 second budget in `netPolicy.ts`'s own comment and the
  README's "recoverable in under a second" both describe the PLANNED path, and
  both now say so. Fixing this means shortening the lease TTL, which trades
  against the split-brain margin the whole design rests on: not a change to make
  casually, and not one to make without a measurement of the new margin.
  NOW MEASURED END TO END rather than reasoned from the parts: 4.7 seconds of
  silence (the lease TTL plus the poll), the stall banner at 4.0s, and a 17 to
  18 tick regression rendered as a -80 unit rewind in ONE frame followed by four
  backward frames and an 80ms hold. THE TWO TUNABLES ARE BOTH HOST OPTIONS AND
  BOTH HAVE DEFAULTS MEASURED ON THE SOURCE GAME, so a host that wants a
  different trade can take it: `leaseTtlMs`/`leaseRenewMs` at 3000/1000 keeps
  the same 3x renew margin and cuts the floor to about 3.3s, and `checkpointMs`
  at 250 cuts the regression to 5 ticks at four times the checkpoint writes.
  Neither is a default this library will change on a host's behalf, because
  both spend something (split-brain margin, Redis bandwidth) that the defaults
  were chosen to buy.
- A REDIS RESTART WITHOUT PERSISTENCE gives roughly one second of two
  authorities interleaving, until the predecessor's next renew comes back false.
  It is bounded, it is self-correcting, and it is now LOGGED
  (`ticker.lease-lost` with `meta.finder`), where before a fleet exiting
  `'lease-lost'` produced not one line saying so. Closing it entirely would need
  a fencing token on every write, which is a different architecture.

### The verifier round (2026-09-02)

THE AUDIT ABOVE WAS THEN ATTACKED, WHICH IS THE ONLY REASON TO TRUST ANY OF IT.
Three adversarial verifiers went at the ticker diff, the client-connection diff
and the relay/adapters diff with a brief to REFUTE rather than confirm, and an
end-to-end harness measured what a client actually renders: a real `ws` server,
`admitSocket` per socket, `runTicker` against a real Redis on loopback, the real
`RoomConnection` driven at 60Hz through `frame()`, and a one-way delay wrapper
on the socket. Nothing below is reasoned about; it is what the harness read.

WHAT HELD, WHICH IS THE PART A SECTION LIKE THIS USUALLY OMITS. The lease and
checkpoint invariants held under every profile: `renewFails` 0, no split brain,
no ex-owner write, no interleaving of any kind. The standby handoff held, and
held tightly: three planned handoffs in a 30 second run, ticks 161 to 162, 322
to 323 and 483 to 484, snapshot-stream gaps of 8.6, 32.1 and 20.8ms, and the
ticker measured 20.0Hz at every flush. Steady-state rendering held with room to
spare, at 0 frames of 1600 outside +-10% of true speed and zero backward steps
on both a 20ms and a 125ms link. `publishSkipped`, `publishFails`, `renewFails`,
`dropped` and `badEnvelopes` were 0 in every run, and server inter-departure max
sat at 53 to 57ms in every run that was not a hard death.

THE HARNESS TABLE, which is the measured evidence for the library's own claim
and the reason the numbers in this file are not estimates. 30 second runs, one
entity moving at a constant 100 u/s, 20Hz. `owd` is the injected one-way delay;
"frames outside +-10%" is how many rendered frames reported a speed outside a
band around the true 100 u/s, which is the quantity a player perceives as
smoothness; "snapshot gap max" is the longest silence in the stream the client
saw.

| scenario | owd | peak u/s | sd | frames outside +-10% | backward steps | snapshot gap max | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| steady state | 20ms | 106.4 | 0.23 | 0 / 1600 | 0 | 56ms | rtt 41, server depth 3 |
| steady state | 125ms | 105.8 | 0.28 | 0 | 0 | 73ms | rtt 250 |
| planned handoff x3 (standby) | 20ms | 269 | 5.9 | 9 | 0 | 8.6 / 32.1 / 20.8ms | ticks 161->162, 322->323, 483->484 |
| planned handoff x3 | 125ms | 264 | 5.8 | 7 | 0 | 24.5 / 18.7 / 24.5ms | |
| client reconnect x2 | 20ms | 112.7 | 10.8 | 22 | 0 | 347 / 349ms | held 5 frames, blank 0 |
| relay lifetime cap (`lifetimeMs` 10s) | 20ms | 102.7 | 0.16 | 0 | 0 | 57ms | relaySwaps 5, reconnects 0, status never left `open` |
| relay lifetime cap | 125ms | 109.1 | 0.40 | 0 | 0 | 77ms | relaySwaps 5 |
| hard death (NOT in the claim) | 20ms | 110.7 | 120 | 266 (17%) | 8 (worst -83.9) | 4676ms | restore tick 183 against published 201, stall banner at 4.0s |
| 3s render freeze | 20ms | 104.7 | 0.34 | 0 | 0 | 56ms | re-anchors +3, +41, +12; lateInputs 1 then 0 |

THE HARNESS IS NOW A TEST FILE RATHER THAN AN ARTEFACT, which is the part that
matters six months from now: `tests/smoothness.redis.test.ts` (6 cases, on
`tests/helpers/smoothness.ts`) runs the same chain on the same real Redis, with
each scenario shortened to about ten seconds, and pins steady state, the
planned standby handoff, the relay lifetime swap, a render freeze, a CLIENT
RECONNECT and a THREE-CLIENT ROOM. The last two were added by the completeness
round's own gap sweep and are written up under it below: everything before them
drove ONE client that never lost its socket, so the resume glide and every
property that needs company (roster fan-out, per-sender fairness, the room's
own `players` count) had no permanent end-to-end evidence at all. THE
OWNER'S REQUIREMENT IS WHAT IT PINS, in its own words: "clients operate
smoothly while the server is running; the server is authoritative; clients may
be a little out of sync but must not stutter." Everything else in this
repository is a mechanism in service of that sentence, and until this file
existed the sentence itself was measured once by a harness and asserted by
nothing.

ITS THRESHOLDS ARE DELIBERATELY LOOSE EXCEPT WHERE THEY ARE NOT, and the
exception is the one to know about before reading a red run as a flake. The
speed and gap bounds sit far outside the measured values on purpose, because a
gate tightened onto a measurement reddens on a loaded runner for reasons that
have nothing to do with the library; the stutter properties (`backward`,
`zeroMotion`, `blankFrames`, `lateAfterSteady`, `starvesAfterSteady`,
`publishFails`, `renewFails`, `hostErrors`, `reconnects`) are asserted at
exactly zero wherever the scenario is not the one that moves them, because
those are zero-or-not. THE HANDOFF CASE IS TIGHTER THAN ANY OF THEM AND IS
MECHANISM-TIGHT ON PURPOSE: the successor's first tick must be exactly the
predecessor's last plus one, and the grid gap must sit within ONE `tickMs`. A
loaded runner that lands the standby more than a few ticks late reddens that,
and it SHOULD: a standby that is not already sitting on the poll when the lease
is released is the planned handoff failing, which is a real regression and not
a timing artefact. Do not widen that bound to make a run green.

THE RECONNECT CASE'S THREE BOUNDS ARE THE OTHER PLACE TO READ BEFORE WIDENING
ANYTHING, because two of them are loose and the third is deliberately not.
`reconnects` is exactly 1 (the outage is one drop, so a second reconnect is the
ladder tripping over itself or the room refusing the returning player) and
`blankFrames` exactly 0 (the held poses cover the gap, so an empty frame is the
reconnect blanking the world). The rendered peak is bounded at 400 u/s rather
than the file's usual 150, because the resume glide covers the outage's
distance FASTER than real time on purpose and 150 would forbid the mechanism
under test: measured 203 on this harness's own 224ms outage, against the audit's
268 on a 350ms one and the 1500 the snap it replaced produced. And
`zeroMotion` is bounded at 3, which is tight and is meant to be: the measured
value with the glide is 0 and the shape it exists to catch measured 4 to 6, so
a bound with enough headroom to swallow that would not be a gate. The frames
the outage itself covers are HOLD frames (this epoch has had no snapshot yet)
and the harness excludes them from the count, so what remains is only frames
the client had data for and did not move.

TWO OF THOSE ROWS ARE HISTORICAL RATHER THAN CURRENT, and saying so is the
point of writing them down. The handoff peak of 269 u/s was 2 to 3 frames per
handoff and is FIXED since, by the grid continuation (`CheckpointEnvelope.
gridAt`); the reconnect row's resume snap is REPLACED since, by the resume
glide, which was measured afterwards through a real socket on a 350ms outage at
a worst step of 4.47 units, a peak of 268 u/s and no motionless frames against
25 units at 1500 u/s and five motionless frames before it, AND IS NOW PINNED
rather than only measured: the reconnect scenario in the test file drops the
client's own socket mid-run and asserts across the epoch boundary (224ms
outage, peak 203 u/s, 0 backward, 0 blank, 0 motionless, a boundary step of
0.000 units out of the held poses). The hard-death row
was never in the claim: it is the 5 to 7 second budget this file already
documents, measured end to end for the first time.

WHAT THEY FOUND, BY CLASS RATHER THAN ONE BY ONE, because the mechanism of each
is written up in the invariants and gotchas above and this is the index.

- TIMELINE CONTINUITY ACROSS A PLANNED HANDOFF. The successor restarted the grid
  at its own `Date.now()`, which moved the server timeline 20 to 40ms earlier
  per handoff and walked the client's stamping lead down with it.
  `CheckpointEnvelope.gridAt`.
- ORDERING THAT ONLY A SLOW PATH REVEALS. Overlapping checkpoint writes reaching
  Redis in gzip-completion order rather than tick order; a `room-reject` aimed
  at a pid rather than a connection, closing both of a swapping player's
  sockets; `handle.close()` telling the host and the wire two different codes.
- LEAKS ON THE PATHS NOBODY EXERCISES. The setup-lease-loss exit leaking its
  subscriber and skipping `dispose`; the `'reconnecting'` listener never
  detached from a process-singleton client; a CONNECTING socket that never
  opens holding its subscriber, its cap slot and its heartbeat forever;
  `admitSocket` leaving a ZADD behind when `attachRelay` throws.
- WINDOWS AND SENTINELS, the two shapes this repo keeps rediscovering. The crash
  counter's `EXPIRE` making a fixed window sliding, and its clear-at-first-
  checkpoint letting slow poison escape it forever; `lastReanchorAt` and
  `lastSwapStartedAt` using 0 as "not yet" on a `performance.now()` axis, which
  is the third instance of the `PlayoutBuffer.aheadBase` trap.
- ARITHMETIC WITH NO FLOOR. A derived `maxRunMs` of -20000 and a `lifetimeMs` of
  0 from a small `maxDurationS`, which announced and closed every socket at
  once, and an explicit negative `maxRunMs` passing the fit check by arithmetic.
- INPUTS THE LIBRARY TREATED AS TRUSTED. A `serverTime` or `tick` that is finite
  and implausible; an `rttMs` inflated by a frozen render loop or by a hostile
  echo; a `relay-expiring` sent as fast as a relay likes; a fragmented ping.
- AND THE CLASSES ALREADY NAMED IN THIS FILE, FOUND AGAIN IN NEW PLACES: a log
  line on a per-tick path (`onEvents`), a throw escaping a platform callback,
  an anchor computed from a measurement that had not been taken yet.

TWO OF THEM WERE REGRESSIONS THIS FIX SET HAD INTRODUCED ITSELF, and they are
written up first rather than last, because an audit that hides its own mistakes
is precisely the thing this file exists to prevent. Both were found by the
verifiers, not by the suite, and both were green.

- A `commandTimeout` ON THE SUBSCRIBER, ADDED BY THE FIX THAT BOUNDED EVERY
  OTHER REDIS WAIT. The reasoning was symmetric and wrong: ioredis's ready
  handler re-issues the subscription after a reconnect with NO `.catch`, so a
  client-wide timeout applies to a command this library never issued, a slow
  resubscribe becomes an unhandled rejection, and modern Node exits the
  process, taking every other socket the function holds with it. Reproduced
  with a TCP proxy holding only the resubscribe reply. `createSubscriber` sets
  none; the SUBSCRIBE is bounded where it is ISSUED, which is the distinction a
  client-wide option cannot make. `tests/subscriber.redis.test.ts` carries the
  control that dies and the shipped options that survive. THE LESSON IS THAT A
  RULE APPLIED UNIFORMLY IS NOT THE SAME AS A RULE UNDERSTOOD: "bound every
  wait" was right, and the subscriber is the one connection whose waits are not
  all ours.
- THE TERMINAL CALLBACK ORDERING, WHICH KILLED THE RESTART RECIPE THIS REPO'S
  OWN DOCS RECOMMEND. `enterTerminal` announced `onTerminal` and then tore the
  socket down, so a host calling `conn.start({ remint: true })` from inside it
  (the bounded re-assign loop the balancer exists for, printed in the README,
  in `connection.ts`'s own docstring and in this file) had the socket it had
  just created closed underneath it: measured at two sockets, the restart's
  `readyState` 3, `reconnects` 0, dead forever, while the bare 4002 close code,
  which announces nothing and therefore restarts nothing, survived perfectly.
  The callback is the last statement now. THE LESSON IS ABOUT WHAT A CALLBACK
  IS FOR: `onTerminal` is not a notification, it is a handover, and a handover
  has to leave the object in the state the receiver is expected to act on.

TWO THINGS THE ROUND MEASURED AND LEFT ALONE, recorded so the next reader does
not chase them. `starves` is never 0 at the START of a stamped stream, because
the early-is-not-starved path still counts on `starves` (the tick genuinely had
nothing to apply) and the first flush reads 1 to 5 while the client's lead
converges; steady state is 0, so the number worth alerting on is a sustained
one and not a first-window one. And AT THAT POINT NO SHIPPED EXAMPLE STAMPED
INPUTS END TO END: both left `targetTick` at 0, so the stamped path had never
been driven through a real socket by anything in this repo except the README
quickstart (`usesPlayout` on the runtime, `targetTick: conn.tick.value` on the
send) and this round's own harness. The completeness round below closed that:
`examples/pong` stamps end to end and `examples/cursors` stays unstamped as the
deliberate contrast.

### The completeness round (2026-09-02)

THE VERIFIER ROUND ANSWERED "IS THE AUDIT RIGHT". THIS ONE ASKED "WHAT DID BOTH
OF THEM NEVER LOOK AT", and the answer was mostly not behaviour. What ran:
second-round verifiers over the client, the ticker and the relay; the end-to-end
harness promoted from an artefact to a permanent test file; the library's first
run in a REAL headless Chromium; a consumer-install check from a packed tarball
into fresh Vite and Next projects; a cold-start run by a developer given only
the READMEs; a 20-client load run with one flooder and one slow reader; a
50,000-frame relay fuzz; a 137-mutation vacuity sweep; and a 192-row re-measure
of the mutation matrix on a frozen copy.

WHAT HELD, WHICH IS THE HALF A SECTION LIKE THIS USUALLY OMITS. The 192-row
re-measure found 150 rows matching and 42 needing correction, none of them in
the direction that means a guard lost its pin. The vacuity sweep found coverage
strong exactly where this file calls a path safety-critical: playout caught 13
of 14 mutations, each lease primitive's fail-closed `'OK'` check caught 5, the
owner-checked checkpoint script 4 to 10, the exit reasons 19. The load run held
20Hz (min 19.98) with every zero-or-not counter at zero and the nineteen
innocent clients metrically identical to a no-flood control. The browser run
rendered 68.5 to 72.2 u/s against a true 70 over 15 seconds at 60fps, standard
deviation 0.77, zero frames outside +-10%, zero backward steps, and zero
console, `pageerror` or `unhandledrejection` lines across ten runs and 13,687
frames with a self-test proving the capture was live. The consumer-install check
held too, and its numbers are the ones to re-check before a release:
`tickroom/client` plus glue is about 30 kB raw and 9 kB gzip in a Vite build,
importing only `RoomConnection` tree-shakes `interpolation.js` and
`errorOffset.js` to ZERO bytes (so `sideEffects: false` is honest), the packed
tarball was 306 kB with every `exports` subpath present (RE-MEASURED SINCE, and
see the `rm -rf dist` gotcha for why that figure moved: 73 files, 386.4 kB
packed and 1.1 MB unpacked on the current tree), the browser-reachable
`.d.ts` carry no `Buffer`, `NodeJS` or `node:` references, and
`upgradeWebSocket: experimental_upgradeWebSocket` typechecks against the real
`@vercel/functions` 3.9 types. `tsconfig.build.json` excluded
`src/server/testFakeRedis.ts` as well as every `*.test.ts`, so the fake did not
ship to consumers. THAT LAST CLAUSE WAS DELIBERATELY REVERSED ON 2026-09-05: the
implementation moved to `src/server/memoryRedis.ts` and now ships on purpose,
because a host running one process needs exactly it; `testFakeRedis.ts` is a
one-line alias and is what the exclude still names.

WHAT IT FOUND, BY CLASS. The mechanism of each is in the invariants and gotchas
above; this is the index.

- LIVENESS THAT COULD NOT SEE ITSELF, on the relay this time. A subscriber
  black-holed AFTER a successful subscribe produced no frame, no log and no
  close, forever. The relay now probes its own subscription per connection,
  which is the ticker's own mechanism on the other side of the bus.
- FRAMES DELIVERED TO THE WRONG AUDIENCE. One `room-full` on the broadcast
  roster channel latched `'capacity'` on every client in the room; the channel
  has an allowlist now. And a wrong-typed `c` on a `room-reject` read as absent
  and closed both of a swapping player's sockets, which is the regression the
  field exists to prevent reached through the guard meant to enforce it.
- ESCAPE HATCHES THAT LATCHED OPEN. The snapshot plausibility run cleared only
  on a plausible frame, so 100 wild frames were refused 3 and ADOPTED 97,
  leaving `tick.value` at -542716 and a 3.4e6 `onTickReanchor` delta. It
  re-arms at the adoption point now.
- A CLAMP READING STATE THE CALLER HAD JUST BEEN TOLD TO DESTROY. The resume
  glide's bound came from the motion map `clear()` empties one line earlier, so
  it was `Infinity` on the only path anyone uses and a 5000-unit respawn
  rendered as a 4986-unit sweep at 33,000 u/s.
- A REFUSAL THAT A THROWN SEND CANCELLED. `refuseSocket`'s single latch made a
  throwing send read as a completed refusal: open, unrefused and relay-less past
  320ms, with the shipped test asserting only `not.toThrow()`.
- INPUTS STILL TREATED AS TRUSTED, found by fuzzing rather than by reading.
  20,000 envelopes put roster hash fields named `"123"`, `"[object Object]"`,
  `"__proto__"`, `"constructor"`, `"null"`, `"undefined"` and `"1.5"` on the
  wire to every socket in the room; a forged probe `n` of 1e15 disabled a
  watchdog for a whole run; a `__proto__` key reparented the roster seed map so
  that player vanished from the seed while the ticker's broadcast still carried
  them; and the 128-byte ping cap applied to the buffer arms but not the string
  one, so one wire had two answers and the expensive one was reachable.
- AND TESTS THAT COULD NOT FAIL, which is the class the sweep existed for. The
  fake Redis applied the lease's owner semantics ITSELF regardless of the script
  text, so deleting the owner comparison from `RENEW_SCRIPT` or `RELEASE_SCRIPT`
  left the entire offline suite green and three lease cases were vacuous; only
  `tests/lease.redis.test.ts` caught it, and that skips without a Redis. Beside
  it: `snapshot.test.ts`'s `toThrow(CodecError)`-only cases and a "boundary
  itself" case that passed `entities: []`; `connection.test.ts`'s
  status-transition case with an unasserted spy and a slew-cap case the minimum
  alone satisfied; `admission.test.ts`'s registration case asserting `zcard`
  only; `relay.test.ts`'s `bufferedAmount` case that could not fail; and the
  ticker's flaky async-renew case, now deterministic on virtual time and green
  20 of 20. Nine documented thresholds were tested at plus-or-minus one and
  never AT the boundary.
- AND THE ONE PERMANENT PIN OF THE OWNER'S REQUIREMENT DRIVING A SINGLE
  UNBROKEN CLIENT, which is the same class one level up: the file exists, it
  runs the whole chain, and what it could not observe was anything that needs
  a SECOND client or a LOST socket. So the resume glide (`beginEpoch` ->
  `clear()` -> `resumeFrom`, the newest smoothness mechanism in the library)
  was measured once by an audit harness and asserted by nothing, and so were
  roster fan-out, per-sender fairness and the room's own `players` count. Two
  scenarios close it: a CLIENT RECONNECT that kills the socket from the client
  side mid-run and asserts across the epoch boundary, and a THREE-CLIENT ROOM
  where every client has to render every other client's entity in every frame
  of the steady window. Both are described under the verifier round's harness
  section above, with the thresholds and what each measured.

AND THEN A CRITIC WENT THROUGH THIS ROUND'S OWN FINDINGS ASKING WHICH ONES WERE
ONLY HALF CLOSED, which is the follow-up set below. It is inside this section
rather than in one of its own because it is the same round: nothing here is a
new investigation, it is the list of places where a fix landed and its neighbour
did not. The pattern that shows up four times is A NUMBER THAT WAS RIGHT ONCE:
right at one tick rate, right for one transport, right for one relay, right on
the machine it was measured on.

- A GATE THAT COULD NOT FAIL, ON THE ONE BUILD THAT CANNOT BE UNDONE.
  `release.yml` ran `npm test` with no Redis service, and the nine real-Redis
  files skip cleanly when nothing is listening, so the publishing build exited 0
  having run zero assertions in the lease, checkpoint, handoff, subscriber,
  smoothness and fault-injection suites. CI had the service and the require flag
  from the start; the release did not, which is exactly backwards. It now runs
  the same `redis:8` on 6399 with `TICKROOM_REQUIRE_REDIS=1`, plus
  `timeout-minutes` on all three jobs, because a job that hangs forever is the
  same non-gate as one that cannot redden.
- A BUILD THAT NEVER CLEANED ITS OUTPUT, which shipped a mutated ticker. `tsc`
  removes nothing from `outDir`, so `dist/__verify_ticker2__` from a mutation
  run stayed there after its source was deleted and went into the tarball: 75
  files and 364 kB in the dry run, with a clean typecheck, a green suite and no
  signal anywhere. `build` is `rm -rf dist && tsc -p tsconfig.build.json` now,
  and the pack figures in Gates are stated as re-measured because they are the
  only readout that would have caught it.
- A LIVENESS DEADLINE SIZED AGAINST THE CADENCE THE CLIENT ASKED FOR. 45s
  against a client pinging every 2s looks like twenty-two missed pings of slack
  and is one missed ping once Chromium throttles a hidden tab to one timer
  callback a minute, so every backgrounded tab past five minutes was reaped on a
  perfectly healthy socket. 90_000 now, with the reasoning as an invariant
  rather than a comment, because the next person to tune it will be looking at
  the same twenty-two.
- AN OPTIONAL TRANSPORT CAPABILITY ASSUMED RATHER THAN DETECTED. `socket.ping?.()`
  on a transport with no `ping` is a silent no-op that reads at the call site as
  a ping that went out, so which regime the deadline was actually running in was
  invisible. One `relay.no-ping` at attach and `RelayHandle.transportPings`.
- A TOLERANCE MEASURED IN TICKS. `playoutMaxAhead` is a duration wearing a tick
  count: 40 was two seconds at 20Hz and 667ms at 60Hz, so one constant meant
  three things at three rates. Two seconds of this room's ticks now. The
  measurement worth keeping is the one that says who it was NOT for: the shipped
  client never approached the old bound at any rate, because the buffer measures
  from the consumed floor at arrival and the client's lead is RTT-compensated,
  so a third-party client of the documented wire is the case.
- A REFUSAL WITH NO NAME AND NO RETURN VALUE. `PlayoutBuffer.push` returned
  `void`, so a sender whose whole window sat past the bound was discarded in
  silence with starves climbing and nothing naming the cause. It answers
  `PushResult` now, and `'stale'` is deliberately not `'refused'`, since a
  redundancy window produces stale pushes constantly on a healthy link and
  counting them would make the statistic a function of the window size, which is
  the identical mistake `lateCount` had already been fixed for once.
- A FAN-OUT THAT SKIPPED THE CLIENT-RATE RULE BY LOOKING LIKE A REPLY. A
  `room-reject` is answered off a join and published on the roster broadcast, so
  a producer choosing its join rate was choosing the room's broadcast rate. One
  per pid per second, suppressions counted.
- PER-PID STATE CLEANED ONLY WHERE A LEAVE ARRIVED. A grace runtime never emits
  a leave for the player it eventually forgets, so playout buffers, starvation
  streaks, `lateSeen` and `rejectedAt` outlived their pids.
  `reconcileMembership` owns all four now, keyed off `presentPids`.
- A RE-ASSIGN THAT COULD NAME ONLY ONE ROOM. The balancer's stats key has a 5s
  TTL and the ticker enforces capacity authoritatively, so the two disagree for
  up to a window and a single-id exclusion lets a client ping-pong between two
  rooms until its bounded budget is gone. `exclude` takes a list, the route
  parses `?not=a,b` up to 64, and "every instance excluded" became an ordinary
  outcome of two branches that were written when it could not happen.
- A MISCONFIGURATION WITH NO SYMPTOM AT ALL. `maxRooms` is three independent
  options defaulting to the same number, and when they disagree a well-formed
  `lobby~7` becomes the fallback room while every signal on both ends reads
  healthy. `ticker.room-normalised` / `relay.room-normalised`, once per
  authenticated request, is the only tell there is.
- AND THE SWAP'S OWN FAILURE MODE WAS UNMEASURABLE. The warm swap reuses the
  cached session, so a token shorter than the relay lifetime chain has every
  replacement refused and every cap silently back on a cold reconnect, which is
  this mechanism making its own worst case more likely rather than less.
  `swapsAttempted` and `swapsFailed` are the readout, and the fix on the failure
  path is a flag consumed at the next connect rather than clearing a session a
  still-open socket is reading.

THE TWO SELF-INFLICTED ITEMS ARE STILL THE TWO ABOVE, and they are worth
re-reading here because both were found by a verifier rather than by the suite
and both were green: the `commandTimeout` on the SUBSCRIBER, which turns a slow
resubscribe into a process exit, and the terminal-callback ordering, which
closed the socket the documented restart recipe had just opened. Nothing in
this round was a self-inflicted regression, and that is the number that should
go down each time rather than a claim to make about a round in advance.

DOCUMENTED, NOT FIXED, and each one is an honest limit rather than an oversight.
The per-sender inbox quota is a backstop against a producer reaching the bus
without a relay, not something a socket-borne flooder can reach: `dropped`
stayed 0 in all 44 flushes under a 200/s flood because the token bucket takes it
first. The `snapshotBacklogBytes` drop is memory safety against a wedged socket
rather than staleness control, because a kernel absorbs a slow reader into its
own send buffer first: an 8 second read stall of 134KB left `bufferedAmount` at
0. And a GENUINELY HIDDEN TAB could not be produced IN THIS ROUND:
`document.hidden` stayed false under five approaches including a CDP lifecycle
freeze and a window minimise, so a hide longer than five minutes (where Chromium
throttles timers to once a minute and the relay's liveness deadline enters) was
untested here. Run C of the deployment below produced one on 2026-09-03 and it
held, and a tab DISCARD was produced on 2026-09-05 (real Chrome 152, driven
through `chrome://discards`) and turned out not to be a liveness case at all:
the socket dies with the renderer, the relay drops the player at once, and the
tab returns as an ordinary reload. Both READMEs carry that now.

ONE NOTE FOR WHOEVER TOUCHES `tests/helpers/smoothness.ts` NEXT: compute a
rendered speed from the delta handed to `frame()`, never from a wrapper's own
`performance.now()` reading taken beside it. The browser harness did the latter
first and invented jitter out of nothing, at a standard deviation of 1.07
against 0.77 on the identical run. The in-repo helper is already correct (it
stamps `t` once and passes that same value in), and that is the property to
preserve rather than a bug to fix.

AND THREE STRUCTURAL NOTES ON THE SAME FILE, since the reconnect and
three-client cases went in. It drives N CLIENTS (`clients`, default 1): each
one gets its own socket factory, its own interpolator, its own stamped sender
and its own `SmoothnessAnalysis`, and `result.analysis`/`result.statuses` stay
the FIRST client's so a single-client scenario reads exactly as it did. A
scenario breaks a link with `ctl.dropFromClient()`, which `terminate()`s the
newest open socket (1006, no handshake) so the ordinary reconnect ladder runs
rather than a test-only path; the factory is per client on purpose, because a
shared one would let one client's outage land on another's socket. And
`result.statsRecs` KEEPS FILLING THROUGH THE TEARDOWN, so anything asking what
the room looked like while it was being played has to cut the flushes at
`result.endedAt` rather than take the last one: the last flush of a run sees
the players leaving, not playing.

AND ON 2026-09-03 THE LIBRARY RAN ON A REAL PLATFORM FOR THE FIRST TIME,
which is the one item this file kept calling the largest thing owed. A single tickroom room
went onto Vercel as `tickroom-bench.vercel.app`: personal team, PRO plan (this
paragraph said Hobby for two days and was wrong about the PLAN rather than
about the numbers), Fluid compute, Node 24, both long-lived routes exporting
`maxDuration = 300` against `maxDurationS: 300`, which was a CONFIGURATION and
also the platform default, a shared Upstash `rediss://` about 80 to 87ms from the
laptop, and the library installed from a packed 0.2.0 tarball of this working
tree. It was measured by three headless Chromium clients rendering at 60fps
against a constant-velocity marker at 100 u/s, which is the same ruler
`tests/smoothness.redis.test.ts` uses so the numbers read directly against the
loopback ones. Twelve minutes in run A; ten in run B with per-invocation ticker
ids, socket close codes and gap timestamps recorded; and a 6.5 minute hidden-tab
run C in a real windowed browser process.

WHAT IT SETTLED IS THAT THE DURATION CAP IS A NON-EVENT, which is the claim the
whole architecture is built to make. A planned ticker handoff cost a snapshot
arrival gap of 49 to 67ms on a 50ms grid with a server grid gap of exactly 50ms,
so no server tick was lost and the client paid at most one extra frame of
arrival jitter; the relay's warm swap at its own cap succeeded 6 of 6 in run A
and 6 of 6 in run B, and each retired socket closed 1005 clean about three
seconds after its replacement was adopted. Run B saw zero reconnects across all
three clients. Across 73 client-minutes there were zero backward steps, zero
blank frames and a mean rendered marker speed of exactly 100, and the
deployment's own logs carried only 200 and 101 responses with no 5xx and no
function timeout: the platform never killed anything, because the ticker exits
itself 30s before the cap. Cold spawn to first snapshot was 1.0s where the relay
had to start the room; joining a running room was 0.35 to 0.6s. Redis
connections peaked at 8 for three players plus the ticker and the harness. The
room's own counters agreed: `refusedInputs`, `hostErrors`, `publishSkipped`,
`publishFails` and `renewFails` all 0 in both runs, `starves` 43 and 33,
`lateInputs` 23 and 26, tick rate 19.84 to 21.55 Hz.

WHAT IT DID NOT SETTLE IS THE PUB/SUB TAIL, and that is the honest residual
rather than a defect anything in this repo can fix. On the measured path
(function to Upstash over TLS to function to a browser 80ms away) snapshot
arrival gaps of 150 to 250ms landed about once a minute per client and gaps of
250 to 433ms about once per five client-minutes, with nothing in the library's
own event stream near most of them. The interpolator absorbs the first band
outright; the second shows as 6 to 23 motionless frames and then a catch-up
(peak 600 to 1400 u/s on a 100 u/s marker), which is a visible hitch of about a
third of a second a few times an hour per client. The loopback harness never
sees a gap above 149ms, so this band belongs to the network path and not to the
library's scheduling. The lever a host has is the interpolation delay floor,
which trades about 200ms of remote-entity latency for absorbing the second band;
the measurement worth making next is a same-region Redis plus an in-function
latency probe, which is what would say whether the tail is the provider, the
region or the TLS hop.

THE HARNESS IS A REPO, NOT A ONE-OFF SCRIPT, and it is where any of this gets
re-run. `/Users/isaacharper/Development/tickroom-bench` holds the Next app (the
four routes exactly as the README quickstart writes them, the balancer among
them), the pong simulation with the marker added, and five browser harnesses:
`bench/run.mjs` for N clients over M minutes with the room's own stats read
every 500ms, `bench/hidden-tab.mjs` for the backgrounded case,
`bench/paddle.mjs` for the owned entity, `bench/discard.mjs` for a killed
renderer and `bench/hidden-safari.mjs` for the same measurement in real
Safari. Its README
carries the full tables run by run, the raw JSON lives in `bench/out/`, and it
documents the two traps that made earlier attempts measure nothing: Playwright's
focus emulation, which keeps `document.hidden` false forever, and the
module-scope instance id, which hides a handoff that happened in a warm
container.

AND PLAYING THE DEPLOYMENT BY HAND FOUND WHAT THREE HARNESSES COULD NOT, twice
in one day, and both times on the OWNED entity. The first was the input
timeline off-by-one in the gotchas above, which arrived as a paddle running
behind the key and lurching after release; `bench/paddle.mjs` was written to
reproduce it and the ticker was fixed to consume the input stamped for the
tick it produces. The second arrived the moment the first was fixed: with the
reconciliation now exact, the player reported the paddle MOVING IN STEPS. The
locally predicted paddle advances only when a tick is stamped, once per 50ms
at 20Hz, while the page draws at 60fps, so it held still for two frames in
three and then jumped a whole tick of travel, and the rubber banding had been
hiding it. Measured by the extended paddle check on the deployment before the
fix: 48 held frames, 67% with no motion, largest single-frame step 4.50
units. `ClientTickView` gained `fraction` (the existing accumulator as a share
of the tick, 0 inclusive to 1 exclusive, 0 before the first anchor and after
any anchor; five clientTick cases, mutation-checked), and the pong example and
the bench page keep the prediction one stamped tick behind as `prevPredictedY`
and draw `prev + (curr - prev) * conn.tick.fraction` plus the `ErrorOffset`,
shifting `prev` by the same delta on every reconcile so a correction is
carried once. One tick of visual delay on the owned entity, at most 50ms at
20Hz, for motion at the frame rate. After: 95 held frames, 0% with no motion,
largest single-frame step 1.60 units against a per-frame travel of 1.5 at 90
u/s and 60fps, zero corrections at 8 input changes, a lead of 4 to 5 ticks
over the snapshot. The suite is 1042 tests across 38 files with those cases
in.

THE TIMELINE FIX ALSO RAISED THE STARVE RATE, AND TWO RESPONSES WERE MEASURED
RATHER THAN ARGUED. The off-by-one had been giving every input a free tick of
arrival slack, so consuming on the produced tick left the buffer one tick
shallower at the same headroom: three clients for three minutes on the
deployment at about 80ms RTT reported `starves` 31 in 3593 ticks, about ten a
minute for the room, against about three a minute before the fix (33 in 11972
ticks over run B's ten minutes), `lateInputs` 16, one re-anchor per client.
(1) Tightening the `inputLead` feedback deadband from two ticks to one, so a
buffer one tick deep gets lifted: WORSE. Re-anchors per client per three
minutes went from 1 to 4, 6 and 8, starves from 31 to 44, lateInputs 16 to 13,
because every correction clears the client's stamped window and the loop then
hunts between depths of one and three. Reverted; the deadband equals the
target by decision, and the measurement is in `observeInputLead`'s doc, in the
gotchas above and in ARCHITECTURE section 4. (2) Raising `DEFAULT_INPUT_LEAD_MS`
from 100 to 150, one more tick of jitter headroom at 20Hz, which gives the
same slack back at the same total latency the old timing had, with the input
now landing on the tick it names: KEPT. The same three-minute run on that
build reported `starves` 8 in 3610 ticks and `lateInputs` 2, re-anchors 0, 1
and 1 per client, zero reconnects, tick rate 19.96 to 20.98 Hz over 179 of
180 flushes, which is about three a minute, the rate the unfixed library had,
with the reconciliation exact. A host that measures its own link lower sets
`inputLeadMs` down.

THE PREDICTION WAS LIFTED OUT OF THE EXAMPLE AND INTO THE LIBRARY (2026-09-03).
The paddle-stepping and timeline defects above were both in the forty lines
every consumer with an owned entity had to hand-write from
`examples/pong/client.ts`, and the example itself had two of the four rules
wrong until the day before, so the owner's instruction was to make this easy
from the start rather than better documented: one opinionated object, few
options, one thing that works. `src/client/predictedEntity.ts` is that object
(the file map entry has the API, the fixed decisions and the mutation matrix),
and it is now the ONLY way the pong example, the README quickstart and the
bench page predict: the example's prediction block, send loop, reconcile,
re-anchor handler and draw collapsed to a constructor, one `advance` per frame
and one `reconcile` per snapshot; the README's step 3 gained a shared
`stepPlayer` in step 1 and lost its `localSim` stub and its resync advice,
with `onTickReanchor` demoted to optional telemetry and step 2's
`decodeInput` accepting the array the entity sends; the bench page's
`reconcile` event lost `covered`/`missing` (the class keeps a history deeper
than its window, so the shortfall they measured cannot occur) and its `errZ`
became drawn minus prediction. Two decisions taken while building it that a
reader might otherwise undo: the replay history (32) is deliberately deeper
than the re-send window (6), because on a slow link the lead exceeds six ticks
and a window-bounded replay came up short on every snapshot; and each record
keeps a JSON COPY of the input, because the README's own stub (`const input =
{ x: 0, y: 0 }` written into by the controls) would otherwise alias one
object across every record and replay the current input for every past tick.
The measured cost: 21 cases, 19 mutation rows with one equivalent mutant,
whole tree 1042 to 1063. The bench repo was re-vendored with the class.

THE RENDER HALF WAS REDESIGNED AFTER AN ADVERSARIAL REVIEW (2026-09-03). The
review drove the class with the real `ClientTick`, the real `PlayoutBuffer`
and a server consuming the record stamped T on the step producing T, found
the timeline, the replay, the wire and the README correct, and found three
render defects with one cause (the draw followed the counter, and a counter
jump is not time passing: a +2/+3 forward re-anchor drew as a 7.5 to 12 unit
lurch, the common -1 epoch anchor drew a tick backward, and the offset cap
trimmed accumulated corrections in silence) plus two guards missing (NaN out
of `step` or the snapshot poisoned the draw forever; `advance(undefined)`
threw a bare SyntaxError). The draw is a render playhead now (the file map
entry has the mechanics and the matrix; the gotcha has the reasoning), the
snap gate is on the resulting offset, both guards exist, and the one option a
consumer could get wrong against the connection (`tickHz`) is gone in favour
of `ClientTickView.tickMs`. Cost: 40 cases (was 21), 15 mutation rows with one
equivalent mutant, whole tree 1063 to 1085, `RoomConnection` unchanged, the
example, the README's step 3 and the bench page updated and the bench
re-vendored.

AND ON 2026-09-04 AND 05 THE OWED LIST WAS PAID DOWN RATHER THAN ADDED TO,
which is the first time that has been true of a day in this repo. Five things
landed: the run at the cap this repo's own snippets use, the in-function probe
that attributes the pub/sub tail, the split-brain measurement the lease item
had owed since the audit, the shipped example driven through a socket by CI,
and the hidden-tab residual cut down to one browser family. ONE CORRECTION OF
RECORD GOES WITH THEM: the personal Vercel team is on the PRO plan and always
was (`vercel teams` and the API both say `plan: pro`), so every passage in this
file that said Hobby was wrong about the plan rather than about the numbers.
300 was a CONFIGURATION, which is also the platform default and the Hobby cap;
runs A to C were measured at it and stay labelled that way.

THE PRO CAP RAN FOR 27 MINUTES AND THE DURATION CAP IS STILL A NON-EVENT. At
`maxDuration` 800 the ticker's `maxRunMs` is `min(700s, 800s - 30s)` = 700s and
the relay's `lifetimeMs` is 790s, which are the numbers the README quickstart
prints, so this is the first run of the periods this repo actually recommends.
Three clients in room `pong` at a 150ms lead: both planned handoffs were seen
by all three, at 700s (`15dbf32d` to `b67b3366`) as an arrival gap of 50.0 to
50.1ms and at 1397s (`b67b3366` to `777108b9`) as 66.7 to 83.4ms, with the
server grid gap exactly 50ms both times. Every client attempted two relay warm
swaps and completed both, none failed, and each retired socket closed 1005
clean at 788s and 1574s. Zero reconnects, zero stalls, zero terminals, mean
marker speed exactly 100 on all three. AND THE CLIENT-SIDE NUMBERS ARE THE
WORST THIS BENCH HAS PRODUCED, WHICH IS THE CONTAINER AND NOT THE PLATFORM:
this run rendered in three headless Chromiums inside a Docker container on the
16-core server while a SECOND three-client run shared the box, and it shows as
35 to 61 zero-motion frames per client, maximum arrival gaps of 650 to 933ms
(most of them in the first 75 seconds: 833, 650 and 450ms), peaks up to 3290
u/s, RTT medians of 91 to 117ms against 80ms minimums, and one backward step on
one client in 97,000 frames, which is the first backward step in any run
anywhere. Read those as the renderer being starved of CPU, because the
server-side facts in the same run (handoff cost, swap success, no reconnects)
do not depend on the client drawing on time. A quiet Mac is where a smoothness
number gets measured; a loaded container is where a handoff does.

THE BUS HALF OF THE TAIL IS NOT THE BUS. `/api/probe`, a new bench route gated
by `SESSION_SECRET`, opens its own publisher and subscriber from inside a
Vercel function in `iad1` and times a PING and a PUBLISH-to-SUBSCRIBE round
trip every 100ms, which removes the relay, the browser and the last 80ms of
network from the path. Against `helped-teal-156650.upstash.io`: a 60s run, 601
samples of each, PING p50 1.26ms p90 1.84 p99 2.35 max 22.27 and pub/sub p50
1.28 p90 1.52 p99 2.10 max 22.02; a 240s run, 2406 samples of each, PING p50
1.46 p90 2.04 p99 2.38 max 14.14 and pub/sub p50 1.66 p90 1.90 p99 2.32 max
19.63. NO SAMPLE OVER 150ms IN EITHER RUN. So the 250 to 433ms arrival gaps the
clients see are not in the Redis path, and the same-region question that stood
beside this one is moot as well: the Upstash database is already in `iad1` with
the functions. What is left is the relay function (its subscriber's event loop,
or the function being paused) or the socket path to the browser, and the relay
now says which: `relay.gaps` measures the inter-arrival gap on the relay's own
subscriber and the bus-arrival-to-send-returned lag per heartbeat window and
logs one line only past 150 and 50ms. A line whose `busGapMax` matches a
client's gap puts it upstream of the socket; a client gap with no line beside
it is the socket path.

AND THE FIRST ATTRIBUTION RUN CAME BACK EMPTY, WHICH IS THE ANSWER RATHER THAN
A MISSING MEASUREMENT. Ten minutes, three clients, room `pong` at a 150ms lead
from the fw13 container on 2026-09-05 (05:07 to 05:17 UTC), against the
deployment carrying the instrumentation: the clients reported EIGHT arrival
gaps over 250ms (550, 267, 267, 283, 267, 383, 300 and 250ms) and the Vercel
runtime log carries NOT ONE `relay.gaps` line for that window, while other
relay lines from the same deployment are present in it, so info-level capture
is proven rather than assumed. The relay therefore saw no bus gap over 150ms
and no send lag over 50ms in any heartbeat window of that run: every one of
those gaps is DOWNSTREAM of the relay's `send` returning. With the in-function
probe already reading the Redis path at a p99 of 2.4ms, that clears the ticker,
the bus and the relay function, and what is left is the socket path between the
function and the browser (Vercel's WebSocket edge, or the network) or the
client's own event loop. THE CAVEAT IS THE CLIENT AGAIN: this run rendered in a
container on a loaded box and its arrival times are inferred from FRAMES, so a
render stall reads as an arrival gap; the Mac runs saw the same 250 to 433ms
band at a lower rate, which is why the band is real and this run's rate is not
the number to quote. Separating the socket path from the client's own loop
needs a client-side probe that timestamps socket `message` events
independently of the render loop (a ring of `onmessage` timestamps in the bench
page), which was built and run the same day: see the second batch below, where
every one of those gaps comes back confirmed at the socket. The room's own counters for the run:
`starves` 71 and `lateInputs` 67 over about 12,000 ticks, tick rate 19.96 to
20.95Hz.

AND THE PLATFORM PUT ONE MORE THING IN FRONT OF US ON THE WAY:
`relay.spawn-failed` with `TypeError: fetch failed`, on the first socket of
every single run, beside the `ticker.restore` line of the very ticker that
spawn had just started, and the same shape on every standby handoff as
`ticker.spawn-failed`. See the gotcha; the short version is that a spawn is a
DELIVERY and both adapter spawns had been waiting for an ANSWER that does not
come for 700 seconds, which undici's 300s `headersTimeout` reaches first.

THE SPLIT-BRAIN MARGIN IS MEASURED RATHER THAN ARGUED, which is what the lease
item had asked for by name and what nothing had produced. The derivation and
the numbers are in the Owed list; the sentence that matters here is that the
renew ROUND TRIP does not appear in the lapse margin at all, because renews are
paced from the attempt and ownership is dated from it, so every predecessor
snapshot is issued before a successor can acquire. The one case the round trip
reaches is a THEFT, which is the Redis-restart case this file already documents
as open, and it is bounded by `min(leaseRenewMs, checkpointMs) + RTT + two
ticks` rather than by the TTL. `tests/helpers/proxy.ts` gained `delayReplies`
to shape a reply distribution for it, which is the knob the file needed and the
one `holdRepliesMatching` could not be.

THE SHIPPED EXAMPLE GOES THROUGH A SOCKET IN CI NOW, and getting it there split
`examples/pong/client.ts` in two along the DOM: `createPongClient` is the
netcode and `startPong` is the canvas, the keys and the animation frame, with
no behaviour change. `tests/example.redis.test.ts` drives the first half
against `attachNodeRelay` on a real `ws` server with the pong binary codec on
the wire, and the assertion that pins it is a reconcile error of 0.0000 units
after the replay, against 9 units with the server's stamped playout disabled.
Beside it, `PredictedEntity` gained a THIRD call: `snapTo(pose)`, for the jumps
the game itself knows a glide is wrong for (a respawn, a teleport, a round
reset), which `reconcile` cannot tell from an ordinary disagreement and
therefore glides over half a second. It replaces the prediction, the history
and the speculation at the current mark, keeps the records, drops the offset,
counts a snap and unconfirms the entity so the server's own answer for the same
event snaps too. Pong does not use it, deliberately: no event in pong moves a
paddle, and an example that called it would be demonstrating the call rather
than the case for it.

AND THE HIDDEN-TAB RESIDUAL IS DOWN TO ONE BROWSER FAMILY. A real installed
Google Chrome 152 reproduced Chrome for Testing 151's run C to the number (one
frame in 6.5 minutes, 47 pings, zero reconnects, recovery at 1.019s, 201
re-anchors at a maximum of 44), and a tab DISCARD was produced for the first
time, by driving Chrome's own `chrome://discards` page after enabling internal
debugging pages. What it settled is that a discard is not a liveness question:
the socket dies with the renderer, the relay drops the player at once, the
discarded client's seat was already gone in the first roster the reloaded page
drew, and the 90s deadline never enters. A discarded tab is a reload and a
reload is a fresh session, so nothing in the library needs to survive one. Two
Chrome behaviours cost real time on the way and both are gotchas above: a tab
with a debugger session attached cannot be discarded at all, and 152 destroys
the page target and will not revive the tab on activation while the machine is
locked. Safari is written and blocked on a setting only the user can turn on,
so Safari and mobile are what the item still owes.

THE WALL-CLOCK CASES WERE FIXED AT THE SOURCE IN THE SAME BATCH, because the
long runs moved to a 16-core box and a machine with sixteen cores busy is a
different measurement rather than a slower one. What changed per file is in the
Status section, the two end-to-end files skip loudly through
`tests/helpers/jitter.ts` rather than loosening a bound of zero, and the one
case that looked like a wall-clock flake and was not (a fake clock racing a
real gzip) has its own gotcha. THE WEAK POINT IS NAMED RATHER THAN HIDDEN: that
calibration is taken at module load, and a full-suite run is busiest later.

AND ON 2026-09-05 A SECOND, SMALLER BATCH WENT OUT, EVERY ITEM OF WHICH WAS
ALREADY OWED. Nothing here was discovered; five things this file had already
named as open were closed, which is what a batch looks like once the owed list
is doing its job. Two of them were constants and documentation, one was a file
that had been sitting in the wrong directory for its whole life, one was a
browser, and one was the last leg of the arrival band.

THE EXIT SPAWN'S RACE IS A BUDGET NOW, AND THE NUMBER IS A COUPLING RATHER THAN
A PREFERENCE. `EXIT_SPAWN_WAIT_MS` (3500) in `src/server/ticker.ts` replaces
the bare `sleep(2000)`, sized to OUTLAST a host's delivery receipt (the Vercel
adapter's `SPAWN_ACK_MS`, 3000) rather than to express an opinion about how long
a handoff should take. At 2000 the race was always decided before the spawn
could settle, so `ticker.spawn-failed` was UNREACHABLE for every exit spawn on
Vercel; and the exit spawn is the only spawn on the `'lease-lost'`,
`'input-dead'`, `'empty'` and refused-standby paths, so that line is the only
thing anywhere that ever says the room has no ticker there. The extra 1500ms
comes out of `TICKER_EXIT_MARGIN_MS` (30s), which clears it by an order of
magnitude. THE COUPLING IS PINNED BY A TEST, NOT BY AN IMPORT, because a ticker
that imports an adapter is a worse problem than the one being fixed:
`vercel.test.ts` asserts `SPAWN_ACK_MS < EXIT_SPAWN_WAIT_MS` with at least
500ms of margin, and `ticker.test.ts` writes the host receipt as the LITERAL
3000, since a delay derived from the constant would move with the mutation and
pin nothing (3500 back to 2000 reddens all three new cases). Beside it,
`TickerOptions.spawnSuccessor`'s doc states the delivery contract it already
had: resolve once DELIVERED, reject only when the request never left, never
await the response, and the library never aborts what it issued. Two owed items
closed, three cases added, and `EXIT_SPAWN_WAIT_MS` deliberately stays out of
the server barrel.

THE OTHER SHIPPED EXAMPLE GOES THROUGH A SOCKET TOO, AND IT PINS THE OTHER
INPUT PATH. `tests/example-cursors.redis.test.ts` is integration file twelve and
the mirror of file ten: same rig, `examples/cursors` instead of
`examples/pong`, which means the UNSTAMPED on-arrival branch instead of the
stamped playout. That branch is the one the documentation recommends first,
because a presence layer is the shape most consumers arrive with, and until this
file nothing that touched a socket exercised it. Getting there took the same DOM
split pong took: `createCursorsClient` is the connection, the decode (with an
overridable `decode` option defaulting to the inline JSON decoder), the
interpolator, the labels, the roster, the pointer state and the 100ms send loop,
and `startCursors` is the canvas and the pointer listeners, with no behaviour
change and five new exported types. THE MEASUREMENT IS ONE A STAMPED ROOM
CANNOT MAKE: how long after a client moves its pointer does the room's own
snapshot show it there. Three runs, 10.00Hz, 81 to 194ms (medians 97, 177, 184)
against a worst DERIVED from the wiring rather than picked, one send period plus
one tick plus RTT, so 200ms, asserted at 400. `targetTick > 0` on zero of 177 to
180 decoded inputs is what proves the on-arrival branch is the one that ran, and
`starves` can be asserted zero here only because that branch never builds a
playout buffer to starve. Non-vacuity is its own assertion: with the one
`conn.send` made a no-op, 11 of 11 probes never arrive and 0 of 13 coordinates
are ever seen while every other signal stays green.

AND THE LIBRARY RUNS WITH NO REDIS AT ALL, WHICH IS A FILE MOVE MORE THAN IT IS
A FEATURE. `src/server/memoryRedis.ts` is the former test fake under its real
name (`MemoryRedis`), and `testFakeRedis.ts` is now one line of alias kept out
of the build. The only thing that had ever made that implementation test-only
was where it lived: a host running one process and wanting nothing beside it
needs precisely the object the suite was already exercising thousands of times
a run, and a library keeping its own working implementation out of the package
leaves that host to rewrite it. `createMemoryRedis()` returns
`{ redis, createSubscriber }`, the same pair the Redis factories hand out, and
the node adapter's `NodeRelayServerOptions` and `NodeTickerLoopOptions` gained
optional `redis`/`createSubscriber` so an injecting host never reaches
`getRedis()` at all. `tests/memory.test.ts` proves that end to end, with
`REDIS_URL` DELETED for the whole run so any path still reaching for a
connection fails loudly: 81 snapshots, reconcile `maxError` 0, `hostErrors` 0,
and a subscriber on a disjoint store reddens it. IT IS EXPORTED FROM A SUBPATH
AS WELL AS THE BARREL, AND THAT IS THE POINT RATHER THAN A CONVENIENCE:
`tickroom/server` imports `ioredis` at module top, so telling a no-Redis
consumer to import the barrel to reach the thing that exists to avoid Redis
would have been the documentation closing an item and the code leaving it open.
`package.json` `exports` carries `tickroom/server/memoryRedis`, and
`dist/server/memoryRedis.js` has no ioredis import. The trade is stated on the
function, in the README and in `examples/node-server/README.md` rather than
implied: one process, no horizontal scale, no survival of the process (wrong on
serverless by definition), and a lease that is a re-entrancy guard rather than a
split-brain guard. Four gaps of the implementation are named the same way,
because a fake that is quietly narrower than the thing it stands in for is the
failure mode this file has been bitten by before: `eval` matches the library's
three scripts by SHAPE, `expire` only touches strings, `publish` delivers
synchronously in the publisher's stack, and there is no `unsubscribe`.

AND SAFARI RAN, WITH A CAVEAT THAT IS ABOUT METHOD RATHER THAN RESULT. The real
Safari.app 26.6.2 over `safaridriver` WebDriver (Playwright's WebKit is not
Safari), 6.5 minutes in room `pong~9`, after the user ran `sudo safaridriver
--enable`, which is the half an agent could not do. Every sample read
`document.hidden` true; the socket stayed open the whole time with 0 reconnects,
no closes and no terminals; the player was still in the roster on return; 203
tick re-anchors at a maximum of 55; and the first frame and the roster came back
1.007s after showing, the same recovery Chrome gives. WHAT DIFFERS FROM
CHROMIUM IS THE THROTTLE: 93 pings while hidden, about one every four seconds,
against Chromium's one a minute from the second minute, so Safari throttles the
2s cadence FAR LESS and the 90s liveness default is never approached there. THE
CAVEAT IS THAT WEBDRIVER COULD NOT READ A BACKGROUND TAB: `execute/sync` would
not report tab A's state while tab B sat in front of it, so the harness switched
to A for each 30s sample and back, making A visible for a moment thirteen times.
That is a tab hidden thirty seconds at a time rather than one hidden for 6.5
minutes straight, and the 151 frames rendered are those switch moments. What it
leaves owed is a Safari read taken WITHOUT that switch, which needs a way to
observe a background tab without focusing it (a `BroadcastChannel` to a visible
helper tab, or the page posting its own state to the server), and mobile.

AND THE TAIL'S LAST LEG WAS ATTRIBUTED THE SAME DAY, which is the item the
paragraph above `relay.gaps` said it owed next. The instrument is a ring of
socket `message`-handler timestamps in the bench page, registered in
`BenchSocket`'s constructor so it runs before the library assigns its own
`onmessage`, with `performance.now()` as the handler's first statement. It
matters because EVERY arrival figure this bench had ever quoted was inferred
from FRAMES, so a stalled renderer and a delayed packet were indistinguishable,
and the loaded-container caveat that hung on run D and on the first attribution
run was exactly that ambiguity. Ten minutes, three clients, room `pong~10` at a
150ms lead from the fw13 container (07:44 to 07:54 UTC): about 12,000 socket
arrivals per client, a median gap of 49.8ms on the 50ms grid and a p99 of 69 to
75ms, and EVERY frame-inferred gap over 250ms confirmed by the socket's own
handler within a few milliseconds (267/252, 417/416, 433/428, 700/709, 283/276),
all five marked `socket` and none `render`, with no `relay.gaps` line anywhere
in the window. THE READING IS THAT THE HOLES ARE DOWNSTREAM OF `send` RETURNING
AND UPSTREAM OF THE BROWSER'S `message` EVENT: the WebSocket path from the
function through Vercel's edge, or the network to the container. The ticker, the
bus, the relay function and the render loop are all cleared, so what is left is
a PLATFORM property and the host's lever is the interpolation delay floor. One
ambiguity survives on purpose and the write-up says so rather than hiding it: a
whole-process stall stops the `message` handler too, so `socket` means "not only
the render loop" rather than "the network", and closing that needs a
`setInterval` heartbeat gap ring beside the arrivals one.

### Verified against a real Redis and a real socket

`tests/` runs against a REAL Redis (twelve files, 63 cases), not the fake.
A thirteenth file, `tests/memory.test.ts`, sits in the same directory and needs
nothing at all, which is the whole claim it exists to check, so `vitest run
tests` collects 64 cases and only 63 of them can skip. Start one with
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

TWO MORE THE VERIFIER ROUND ADDED, AND BOTH ARE THINGS THE FAKE ANSWERS THE WAY
IT WAS WRITTEN TO. `tests/checkpoint.redis.test.ts` runs the owner-checked SET
against Redis's own Lua (gzip body read back byte for byte, refused on a moved
lease, refused on an absent one), where the fake matches that script on a
substring of its TEXT rather than on `numKeys`, so it cannot quietly give a
future two-key script checkpoint semantics. And
`tests/subscriber.redis.test.ts` runs ioredis's real reconnect through a TCP
proxy, which is the only way to see a resubscribe issued by the library
itself: a fake has no ready handler, so a `commandTimeout` on a subscriber is
invisible to it in exactly the way it is fatal in production.

AND THE EIGHTH FILE IS THE WHOLE CHAIN AT ONCE. `tests/smoothness.redis.test.ts`
drives a real `ws` server, `admitSocket`, an in-process `runTicker` on real
Redis, and the real `RoomConnection` and `SnapshotInterpolator` at 60Hz through
`frame()`, with an emulated one-way delay both directions, and then asserts on
WHAT THE CLIENT RENDERED, for one client or for three of them sharing the room.
That is the only file in the repo that can observe the library's actual claim
rather than one of its mechanisms. See the verifier round's section above for
what its six cases pin, and for the bounds in it that are deliberately tight
rather than loose.

AND THE NINTH FILE IS THE FAILURE PATHS, WITH THE CONNECTION ACTUALLY BROKEN.
`tests/faults.redis.test.ts` puts a TCP proxy (`tests/helpers/proxy.ts`, shared
with the subscriber file) in front of Redis and runs `runTicker` through it for
five faults the fake structurally cannot produce, because every one of them is a
property of the SOCKET rather than of the Redis protocol: a BLACK-HOLED
subscriber with a healthy command client (exits `input-dead` 2.8s after the
fault, releases the lease, spawns a successor, and applies none of the five
inputs published into the hole), a BLACK-HOLED command client with a healthy
subscriber (publishes stop being CONFIRMED, the awaited guard renew times out on
the shipped `commandTimeout: 2000` and it exits `lease-lost` finder 'guard' at
3.3s with the `finally` demonstrably run), a LEASE THEFT with the predecessor
still ticking (Redis's own Lua refuses its next checkpoint,
`ticker.checkpoint-refused-not-owner`, it exits finder 'checkpoint', and the
stored state is the successor's), a REDIS RESTART shape (both connections
severed, restored 300ms later: the ticker rides it out to its duration cap,
snapshots resume 306ms after the sever, the subscription comes back, and there
are zero unhandled rejections), and a DETERMINISTIC CRASH LOOP (three thrown runs restore the same
poisoned checkpoint and raise the crash counter to 3; the fourth logs
`ticker.crash-loop` and starts the room fresh). `.break(method)` on the fake can
make a command FAIL; it cannot make one silently never answer, and that
distinction is the difference between every fault above and the one shape the
unit tests already cover.

GOTCHA IF YOU ARE COUNTING FILES: `tests/helpers/env.ts`'s own comments track
the suite size and were corrected to "nine" alongside the file above. The suite
is nine. Correct them there in the same commit as a tenth.

GOTCHA FOR ANYONE ADDING AN INTEGRATION TEST: never assert on server-global
state. The first version of the fan-out test gated on `INFO stats`
`total_commands_processed`, which counts every client on that server, so any
other test file running in parallel landed inside the measurement window and it
failed in the full suite while passing in isolation. Key prefixes isolate keys;
they do not isolate `INFO`, `DBSIZE`, `CLIENT LIST`, or any other server-level
metric. Measure something you own.

### The buffer-health seam, built end to end and optional

IT WAS DELETED ON 2026-09-01 AND REBUILT ON 2026-09-02, and both halves of that
history matter, because the shape it came back in is not the shape the old
specification asked for.

WHAT WAS DELETED, AND WHY THAT WAS RIGHT. `ClientTick.reportBufferHealth` and
its five tuning constants (`STEP_DILATION_MAX`, `MARGIN_TARGET`, `MARGIN_SPAN`,
`HEALTH_EASE_TAU`, `DILATION_EASE_TAU`) tuned a control loop NOTHING IN THE
LIBRARY COULD DRIVE: grep for `bufferHealth` found the method and its own
constants and nothing else, so `dilation` was permanently 1.0 and the `+-5%`
step dilation `docs/ARCHITECTURE.md` section 4 described was behaviour no
consumer could reach. Shipping an undriveable feature is worse than shipping
neither the feature nor the constants. Four `ClientTick` tests went with it. The
producer was structurally server-side (the quantity is how deep a player's
`PlayoutBuffer` runs, which only `src/server/ticker.ts` knows), and the tempting
client-side substitute (derive the margin from
`tick.value - estimateServerTick()` minus half `stats().rttMs`) drove a real
feedback loop from a signal this library's own comment calls a biased PROXY. A
wrong-but-plausible control loop nobody can measure is the exact failure this
repo is built to avoid.

WHAT WAS BUILT, WHICH IS FOUR STEPS AND NO NEW WIRE FRAME:

1. `src/server/ticker.ts` calls `RoomRuntime.onBufferHealth(state, pid, depth)`
   on every tick it maintains a buffer for that player, on the STARVED path as
   well as the consumed one, and once with 0 on the tick a buffer is dropped.
   The buffer lives in the ticker's own Map, so this is the only route by which
   its depth can reach the host's state.
2. The HOST writes that depth into its own snapshot, per player or just the one,
   as its wire allows. Nothing in the library dictates the shape, which is the
   whole reason this needs no `TickerOptions` formatter and no new control frame.
3. The host's `decodeSnapshot` picks out its OWN pid's value and returns it as
   `DecodedSnapshotLike.inputLead`.
4. `RoomConnection` reads it: an EMA (`DEPTH_EMA_ALPHA` 0.2) against a target of
   `TARGET_DEPTH_TICKS` (2), corrected by at most two ticks and at most once per
   `REANCHOR_MIN_INTERVAL_MS`, and only when the depth is at least two ticks off
   target. The correction lands as `feedbackTicks` inside `desiredTick()`, so it
   arrives as one ordinary re-anchor with an `onTickReanchor` delta rather than
   as a silent drift.

THE CLIENT TICK STILL DOES NOT DILATE, AND THAT IS THE DESIGN CHANGE. The old
seam steered the RATE the counter advanced at, which is a control loop over
every rendered frame; this one steers the LEAD the counter is anchored with,
which is a coarse correction a couple of times a minute against a quantity the
server actually measured. The open loop (`rttMs + inputLeadMs`) is a good guess
made entirely from this side of the wire; closing it converges the lead on the
smallest one that keeps the buffer fed, which is the smallest input latency that
player can have.

IT IS OPTIONAL AT EVERY STEP, deliberately. A host that never implements
`onBufferHealth`, or has no room on its wire for the depth, simply never returns
`inputLead`, the loop is inert, and the RTT-compensated lead applies on its own.
That is an optimisation lost, not a working connection lost, which is why
`inputLead` is optional on `DecodedSnapshotLike` rather than required.

### Owed before a 1.0

READ THIS LIST AS WHAT IS GENUINELY LEFT. It was rewritten after the
completeness round rather than appended to, so a struck item is history kept for
its reasoning and everything unstruck is open today.

- ~~A REAL VERCEL DEPLOYMENT~~ LANDED on 2026-09-03, and it was the largest
  one. A single room ran on `https://tickroom-bench.vercel.app` (the personal
  Vercel team is on the PRO plan, and `maxDuration` 300 against
  `maxDurationS: 300` was a CONFIGURATION rather than a ceiling: 300 is the
  platform default and the Hobby cap, and the first runs were left on it;
  Fluid compute, Node 24, a shared Upstash `rediss://` about 80 to 87ms from
  the laptop) with three headless Chromium clients at 60fps: twelve minutes in run A, ten in run B, and
  the hidden-tab run C below. WHAT THE PLATFORM ACTUALLY COST, which is the
  whole reason the item existed. A planned ticker handoff arrived as a snapshot
  arrival gap of 49 to 67ms on a 50ms grid with a server grid gap of exactly
  50ms, so the successor lost NO server tick and the client paid at most one
  extra frame of arrival jitter. The relay's warm swap at its own cap succeeded
  6 of 6 in run A and 6 of 6 in run B, two per client with none failed, and the
  retired sockets closed 1005 clean about three seconds after adoption; run B
  recorded zero reconnects across all three clients. Over 73 client-minutes:
  zero backward steps, zero blank frames, a mean rendered marker speed of
  exactly 100 against a true 100, and no 5xx and no function timeout anywhere in
  the deployment's logs. Cold spawn to first snapshot was 1.0s when the relay
  had to start the room's ticker; joining a running room was 0.35 to 0.6s. Redis
  connections peaked at 8 for three players plus the ticker and the harness,
  roughly two per player. EVERYTHING THIS ITEM STILL OWED WAS PAID ON
  2026-09-04 AND 05, and the dated paragraphs at the end of the completeness
  round have it in full. THE SAME-REGION REDIS QUESTION IS MOOT: the Upstash
  database is already in `iad1` with the functions, so there was never a move
  to make. THE IN-FUNCTION PROBE ANSWERED THE TAIL, and it answered it against
  Redis rather than for it: `/api/probe` from inside a function measured PING
  at p50 1.26 to 1.46ms, p99 2.35 to 2.38 and a worst sample of 22.27ms, and
  PUBLISH to SUBSCRIBE at p50 1.28 to 1.66, p99 2.10 to 2.32 and a worst of
  22.02, over 601 and 2406 samples of each, with NO sample over 150ms in
  either run. The 250 to 433ms arrival gaps a browser sees are therefore not
  in the Redis path; what is left is the relay function (its subscriber's
  event loop, or the function being paused) or the socket path to the browser,
  and `relay.gaps` is the instrument that separates those two. AND THE PRO CAP
  RAN, at `maxDuration` 800 with a 700s ticker and a 790s relay lifetime, with
  both planned handoffs costing a server grid gap of exactly 50ms. STILL OWED:
  only the browser residual the hidden-tab item below keeps, which is now a
  Safari read taken without the per-sample switch, and mobile.
- ~~A HIDDEN TAB LONGER THAN FIVE MINUTES~~ LANDED on 2026-09-03, as run C of
  the same deployment, and the tab was genuinely dark this time: `document.hidden`
  true, `visibilityState` hidden, ONE rendered frame in six and a half minutes.
  What produced it was a real browser process attached over CDP with Playwright's
  focus emulation disabled, rather than any of the five approaches that had
  failed before. THE THROTTLE ARRIVES EARLIER THAN THE DOCS ASSUME: the client's
  pings ran at their 2s cadence through the first minute and then dropped to
  about ONE A MINUTE from the second minute onward, 46 pings in all, where every
  write-up of this had said five minutes. The socket nonetheless stayed open for
  the whole 6.5 minutes with zero reconnects and was still in the roster on
  return; one relay warm swap and one ticker handoff both crossed WHILE HIDDEN,
  the swap succeeded and its retired socket closed 1005, and no terminal fired.
  Showing the tab again drew the first frame and re-seated the player at 1.05s.
  THE 90s LIVENESS DEFAULT IS WHAT MADE THAT WORK, and the arithmetic half of
  this item is now confirmed rather than merely reasoned: at one ping a minute
  the old `DEFAULT_LIVENESS_TIMEOUT_MS` of 45_000 would have reaped a perfectly
  healthy socket, and 90_000 held with room. The tick counter re-anchored 200
  times while hidden at a maximum delta of 43 ticks, which is `frame()` not
  running rather than a fault; the gotcha above says what a host should do about
  it. TWO THIRDS OF WHAT THIS ITEM OWED LANDED ON 2026-09-05. A REAL INSTALLED
  GOOGLE CHROME (152.0.7977.83, not Chrome for Testing) reproduced run C
  exactly: one frame rendered in six and a half minutes, pings at 15 per 30s
  through the first minute and then about one a minute for 47 in all, the
  socket open throughout with zero reconnects, no closes and no terminals,
  still in the roster on return, recovery at 1.019s to the first frame and to
  being drawn, and 201 re-anchors while hidden at a maximum of 44. No relay
  swap crossed this time, because the relay lifetime is 790s now rather than
  290s. AND A TAB DISCARD WAS FINALLY PRODUCED, which nothing had managed
  before: an urgent discard from `chrome://discards` with
  `document.wasDiscarded` true on return, revived by a `Page.reload` at 6.4s
  because Chrome 152 will not revive a discarded tab on activation while the
  machine is locked, and from that reload a first frame at 0.27s, a new player
  id at 0.37s, an open socket at 0.69s and a seat in the roster at 0.79s, with
  `reconnects` 0. WHAT IT SETTLED IS THAT A DISCARD IS NOT A LIVENESS QUESTION
  AT ALL: the discarded client's seat was already gone from the first roster
  the reloaded page drew, because the discard kills the socket and the relay
  drops the player at once, so the 90s deadline never enters. A discarded tab
  is a reload, a reload is a fresh session, and nothing in the library needs to
  survive it. AND SAFARI RAN ON 2026-09-05, on the real Safari.app (26.6.2) over
  `safaridriver` WebDriver rather than Playwright's WebKit, once the user had
  run `sudo safaridriver --enable`: 6.5 minutes in room `pong~9`, every sample
  reading `document.hidden` true, the socket open the whole time with 0
  reconnects, no closes, no terminals, still in the roster on return, 203 tick
  re-anchors at a maximum of 55, and the first frame and the roster back 1.007s
  after showing, which is the same recovery Chrome gives. THE NUMBER THAT
  DIFFERS FROM CHROMIUM IS THE THROTTLE ITSELF: 93 pings while hidden, about one
  every four seconds, where Chromium drops to one a minute from the second
  minute. So at Safari's throttling the 90s liveness default is never
  approached, which is a weaker claim than Chromium's and in the safe
  direction. READ IT WITH ITS CAVEAT, WHICH IS METHOD RATHER THAN RESULT:
  WebDriver's `execute/sync` could not read tab A's state while tab B sat in
  front of it, so the harness switched to A for each 30s sample and back, making
  A visible for a moment THIRTEEN times. That is a tab hidden thirty seconds at
  a time, not one hidden for 6.5 minutes straight, and the 151 frames rendered
  are those switch moments. STILL OWED: a Safari run WITHOUT the per-sample
  switch, which needs a way to read a background tab's state without focusing it
  (a `BroadcastChannel` to a visible helper tab, or the page posting its own
  state to the server), and mobile. And the swap FAILURE path, which is the
  residual that was always the narrow one: a successful swap is message-driven
  and rides through the throttle, as run C showed, but a swap that fails falls
  back to the reconnect ladder, and that is a TIMER the throttle does reach, so
  the outage there can still stretch to as much as a minute.
- ~~THE LEASE TTL MEASUREMENT~~ LANDED on 2026-09-05 as
  `tests/splitbrain.redis.test.ts`, eight cases against a real Redis with the
  predecessor's command connection shaped by the fault proxy, and the answer
  is that the renew round trip is NOT in the margin the design note assumed it
  was. THE BOUND IS DERIVED FROM THE CODE, because the code and the note
  differ and the code wins: Redis extends the key from the moment it PROCESSES
  the renew, ownership is dated from the ATTEMPT
  (`renewConfirmed(clock, max(lastOwnedAt, attemptAt))`), a publish needs
  `now - lastOwnedAt < leaseTtlMs`, and a successor's `SET NX` succeeds only
  once the key has expired, so EVERY PREDECESSOR SNAPSHOT IS ISSUED BEFORE THE
  SUCCESSOR CAN ACQUIRE and the renew RTT does not enter the statement. It
  holds for any `leaseTtlMs` above the command client's own `commandTimeout`
  (2000); a host that goes below that gives up the third step and buys back at
  most ONE frame. MEASURED at 1500/400 and 50Hz, with the predecessor's Redis
  path shaped to a steady 50ms, a steady 400ms, and 1s spikes every third
  renew, and then black-holed: no distribution lapsed the key on its own,
  because renews are paced from the attempt and Redis sees one every
  `leaseRenewMs` whatever the reply costs. The key lapsed 1466 to 1476ms after
  the path died, the successor's first frame landed at 1473 to 1493ms, and the
  predecessor's last snapshot was issued 469 to 1427ms BEFORE it in every run.
  A path that HEALS after the TTL delivers what it was holding, at most
  `MAX_IN_FLIGHT_PUBLISHES` (4) stale frames, measured exactly 4. THE ONE CASE
  THE ROUND TRIP REACHES IS A THEFT, the key deleted under a live owner, which
  is the Redis-restart case this file documents as open: overlap 40 to 260ms
  at a 50ms RTT, 477 to 482ms at 400ms and 965 to 984ms under the 1s spike,
  bounded by `min(leaseRenewMs, checkpointMs) + RTT + two ticks`. Duplicate
  tick numbers after an unplanned death are the documented checkpoint
  regression (up to `checkpointMs` of ticks), measured 0 to 10 and pinned at
  11. Ten reps on fw13: 80 passed. The 3000/1000 alternative is still a host's
  own trade, but what it spends is a measured number now rather than a worry,
  and the 5 to 7 second budget itself is unchanged.
- ~~THE EXAMPLES ARE STILL NOT RUN BY CI~~ LANDED on 2026-09-05 as
  `tests/example.redis.test.ts`, integration file ten, which puts
  `examples/pong` through a real socket unmodified: the example's own runtime
  under the ticker with `encodePongSnapshot` on the wire, `attachNodeRelay` on
  a real `ws` server, and the example's own `createPongClient` as the client,
  which is what the DOM split in `client.ts` was for. The assertion that pins
  it is the reconcile error after the replay, 0.0000 units against 9 units
  with the server's stamped playout disabled, so it cannot pass vacuously; the
  rest of the run reads 19.67 to 20.33Hz, 111 unsaturated paddle steps at a
  median and maximum of exactly 90 u/s, two goals decoded and zero
  `hostErrors`. AND THE CURSORS HALF LANDED THE SAME DAY as
  `tests/example-cursors.redis.test.ts`, integration file twelve, which drives
  `examples/cursors` through the same rig and pins the UNSTAMPED on-arrival
  branch the stamped file structurally cannot reach: 10.00Hz, a pointer move to
  the first snapshot carrying that exact coordinate in 81 to 194ms against a
  derived worst of 200, `targetTick > 0` on zero of 177 to 180 decoded inputs,
  and a no-op `conn.send` reddening it. CI's integration job collects both,
  because that job runs `vitest run tests`. STILL OWED, and it is one thing
  rather than two now: nothing drives an example through the VERCEL adapter in
  process. The bench deployment IS that drive, so what is missing is a test
  rather than a measurement.
- ~~A published package~~ LANDED (`tickroom` on npm, tag-triggered trusted
  publishing in `.github/workflows/release.yml`). `ioredis` is now an OPTIONAL
  peer (`peerDependenciesMeta.ioredis.optional: true`), because `false` force-
  installed a TCP Redis client into browser-only consumers of
  `tickroom/client`, `tickroom/core` and `tickroom/codec` with no warning.
  ~~THE `RedisLike` SEAM AS THE DOCUMENTED SWAP POINT~~ LANDED on 2026-09-05,
  and it landed as a shipped implementation rather than as a paragraph:
  `src/server/memoryRedis.ts` is the second implementation of the interface,
  `createMemoryRedis()` returns the same `{ redis, createSubscriber }` pair the
  Redis factories do, and the README's "One process, no Redis" is the swap
  written out. THE RESIDUAL THAT PARAGRAPH WOULD HAVE LEFT IS CLOSED BY THE
  SUBPATH: documenting the seam while the only route to it was
  `tickroom/server` would have told a no-Redis consumer to import the barrel
  that loads `ioredis` at module top, so `package.json` `exports` carries
  `tickroom/server/memoryRedis`, `dist/server/memoryRedis.js` has no ioredis
  import, and that subpath is the form the docs recommend. Still owed on this
  bullet: only ~~the 0.2.0 tag itself~~ LANDED on 2026-09-05: `tickroom@0.2.0` is on the registry, published from a laptop session after the workflow's first publish attempt was refused (see the top of this file), so it carries no provenance; the workflow's own publish is unproven until the next tag.2.0 and the registry still serves 0.1.1.
- ~~No shipped example stamps `targetTick`~~ LANDED. `examples/pong` is the
  stamped reference: one record per advanced tick, a six-record redundancy
  window, a locally predicted paddle reconciled by replaying that window through
  an `ErrorOffset`, and the `onBufferHealth` depth loop closed end to end.
  `examples/cursors` stays unstamped as a deliberate documented contrast, and
  its comments point at pong rather than sketching the shape hypothetically.
- ~~The buffer-health seam~~ LANDED, in a different shape from the one this file
  used to specify: the depth reaches the client through the HOST's own snapshot
  (`onBufferHealth` to `inputLead`) and steers the stamping LEAD rather than
  dilating the tick RATE. See the section above it. Still owed: the two-tick
  TARGET is a reasoned default rather than a swept one. The band beside it is
  no longer only reasoned: on 2026-09-03 a one-tick deadband was measured on
  the deployment and was worse (re-anchors 1 to 4, 6 and 8 per client per
  three minutes, starves 31 to 44), and the starve rate the timeline fix
  exposed was answered by `DEFAULT_INPUT_LEAD_MS` 100 to 150 (starves 31 to 8
  in three minutes), so what a host tunes first is the headroom. AND THE
  HEADROOM IS SWEPT NOW, on 2026-09-05: three five-minute three-client runs
  from the fw13 container (RTT minimum about 80ms, medians 87 to 99ms, more
  jitter than the Mac), one `?lead=` each, about 6,000 ticks apiece. At 100ms,
  `starves` 345 and `lateInputs` 362 with re-anchors of 0, 0 and 1 per client;
  at 150ms, 53 and 56 with 1, 1 and 1; at 200ms, 36 and 31 with 1, 1 and 1.
  100 to 150 is a 6.5x cut, because at 100 the cushion after the
  consume-on-produced-tick fix is ONE tick and the loop's two-tick deadband
  never lifts it (hence the zero re-anchors), and 150 to 200 buys another 1.5x
  for one more tick, 50ms, of input latency on every action. 150 is the knee
  and stays the default; a host on a jittery path (mobile, a container) sets
  `inputLeadMs: 200`. STILL OWED, AND NARROWER THAN IT WAS: that is a sweep of
  the HEADROOM, not of the target. `TARGET_DEPTH_TICKS` (2) was deliberately
  not swept beside it, because the one-tick deadband measurement above says the
  LOOP rather than the target is what governs a one-tick cushion, and sweeping
  the target would mean exposing the constant as an option, which was a
  deliberate no.
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
  run. The check lives in the probe rather than in each test file so a new
  integration file inherits it, and the seventh and eighth
  (`tests/subscriber.redis.test.ts`, `tests/smoothness.redis.test.ts`) duly
  did. Measured all three ways, on the
  six-file 37-case suite that existed at the time: flag set with no Redis
  exits 1 having run 0 of 37 tests; no flag with no Redis exits 0 with 37
  skipped (the unchanged local default); flag set with a real Redis exits 0 with
  37 passed. The suite is twelve files and 63 cases on the current tree; the
  behaviour is unchanged and only the count moved.
- ~~THE SOCKET PATH IS THE LAST UNATTRIBUTED LEG OF THE ARRIVAL BAND~~ MEASURED
  on 2026-09-05, and the answer is that the band is the SOCKET rather than the
  renderer. The instrument is the one this item asked for by name: a ring of
  socket `message`-handler timestamps in the bench page, taken in a listener
  registered in `BenchSocket`'s own constructor (so it runs before the library's
  `onmessage` assignment) with `performance.now()` as the handler's first
  statement, which is an arrival time that owes NOTHING to the render loop.
  Every arrival figure this bench had ever quoted was inferred from FRAMES, so a
  render stall and a delayed packet read identically; that ambiguity is what the
  ring removes. TEN MINUTES, THREE CLIENTS, room `pong~10` at a 150ms lead from
  the fw13 container (07:44 to 07:54 UTC), against the deployment carrying both
  the ring and `relay.gaps`: about 12,000 socket arrivals per client, median gap
  49.8ms on a 50ms grid, p99 69 to 75ms. EVERY frame-inferred gap over 250ms was
  CONFIRMED by the socket's own handler within a few milliseconds and marked
  `socket`, NONE `render`: bot0 one (267ms inferred, 252 at the socket), bot1
  one (417, 416), bot2 three (433/428, 700/709, 283/276), with nothing in the
  library's own events within 2s of any of them, and zero `relay.gaps` lines in
  the runtime log for the window. So the holes are between the relay's `send`
  returning and the browser's `message` event: the WebSocket path from the
  function through Vercel's edge to the client, or the network to fw13. The
  ticker, the bus, the relay function and the render loop are all cleared, and
  THE RESIDUAL IS A PLATFORM PROPERTY rather than a library one; the lever a
  host has is the interpolation delay floor. The run's other numbers: backward
  steps 0, 0 and 2 (bot2, across the 700ms hole), zero-motion frames 2, 9 and
  50, reconnects 0, no swaps at a 790s lifetime, server `starves` 87 and
  `lateInputs` 82 at 19.96 to 21Hz. STILL OWED, AND NARROWLY: the same run from
  a client on a quiet machine on a residential link, because the Mac runs saw
  the same band at a lower rate and this one is a container; and a WHOLE-PROCESS
  STALL DETECTOR in the page (a `setInterval` heartbeat gap ring), because a
  blocked event loop stops the `message` handler too and therefore reads as
  `socket` from inside the page. `socket` means "not only the render loop", not
  "the network".
- The package ALSO installs as a git dependency, and `"prepare": "npm run build"`
  is what makes that work: `dist/` is gitignored and every `exports` path points
  into it, so without the hook a `github:` install resolves to a package with no
  code in it at all. Publishing to npm did not retire the hook, because a `npm
  publish` also runs it and because a consumer pinning a commit is still a
  supported route. `prepare` also runs on a plain local `npm install`, which is
  harmless (it is the same `tsc -p tsconfig.build.json` the `build` script runs,
  it needs no network, and nothing in the build re-enters install).
