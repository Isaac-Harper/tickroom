# Verification

Every measured claim in this repository, with the machine and the date it was
taken on. The [README](../README.md) quotes the headline numbers and links here;
the dated write-ups, the mutation matrices and the audit rounds finding by
finding are in [`LEDGER.md`](LEDGER.md).

- [The tiers, and why the measurement one gates nothing](#the-suite)
- [Measured against a real Redis](#measured-against-a-real-redis)
- [Measured on what a client actually renders](#measured-end-to-end-on-what-a-client-actually-renders)
- [The shipped example, through a real socket](#the-shipped-example-through-a-real-socket)
- [The other example, and the other input path](#the-other-example-and-the-other-input-path)
- [Measured on Vercel](#measured-on-vercel)
- [Status, honestly](#status-honestly)

---

## The suite

The suite is 47 files in three tiers, split by what a machine has to be for the
answer to mean anything.

```bash
npm run test:unit              # 1149 tests across 34 files, NO services at all
redis-server --port 6399 --save '' --appendonly no --daemonize yes
npm run test:integration       # 1197 across 43, the same architecture on a real Redis
npm run test:measure           # 16 across 4, wall-clock numbers, quiet machine only
npm test                       # all three, 1213 across 47
```

| tier | what it is | needs | where it runs |
| --- | --- | --- | --- |
| `unit` | no services, outcome decided by the code | nothing | CI on every push and PR |
| `integration` | real Redis, outcome still decided by the code: a checkpoint round trips, a lease is refused, a subscriber survives a reconnect | Redis on 6399 | CI, and the **release gate** |
| `measure` | real Redis and a wall clock: a rate band, a latency bound, a zero-tolerance smoothness claim | Redis on 6399, and a quiet host | nightly, and by hand on a dedicated machine |

`test:measure` runs its four files one at a time rather than in parallel,
because four files each driving a 60Hz render loop and a real socket are, run
together, each other's load. `test:unit` must pass with nothing listening
anywhere, which is the promise
`createMemoryRedis` makes to a consumer who never stands up a Redis, and
`tests/memory.test.ts` is the file that checks it. `test:integration` and
`test:measure` set `TICKROOM_REQUIRE_REDIS=1`, so an unreachable Redis fails
loudly instead of skipping to a green exit that asserted nothing. `npx tsc
--noEmit` is clean repo-wide including `examples/`.

**The measurement tier is not on the release gate, on purpose.** Its bounds are
readings, not tolerances, and a shared CI runner cannot take a reading: the
v0.3.0 release failed twice on two different timing bounds while the same commit
was green locally both times. Loosening a bound to survive that throws away the
measurement to save the release, so the split is the fix instead. Every number
quoted below comes from `npm run test:measure` on a quiet machine. A few wall-clock cases still sit inside otherwise deterministic files
(`tests/ticker.redis.test.ts`, `tests/faults.redis.test.ts`); those are gated on
a timer-jitter probe (`tests/helpers/jitter.ts`) and **skip loudly**, naming the
factor they measured, rather than reddening on a bound the host cannot honestly
meet.

## Measured against a real Redis

`tests/` runs against a REAL Redis rather than the fake, which is what proves
that `ioredis` satisfies `RedisLike` with no adapter (a claim previously only
ever checked against a hand-written fake, i.e. a claim about the fake), the
`getBuffer` trap where a plain `get` corrupts a gzipped checkpoint before
anything can sniff its magic bytes, the lease resolving 20 CONCURRENT acquires
to exactly one winner, a real TTL expiring so a dead room reads as empty and
reusable, and that a connection in SUBSCRIBE mode really does refuse ordinary
commands. Measured on Redis 8.10.1:

| | measured |
| --- | --- |
| Checkpoint compression | 5,749B to 749B, **7.68x** |
| Fan-out | 50 publishes issued exactly **50** commands, delivered to 5 subscribers |
| Tick rate | **20.45Hz** against a 20Hz target, over real wall time |
| **Handoff** | predecessor died at tick 26, successor **restored at tick 26**, longest snapshot-stream gap **10ms** |

That handoff number is the library's central claim made executable. Read it as a
floor rather than a typical figure: this is loopback Redis with no network and no
cold function start, so production is slower. What it demonstrates is the
mechanism, that a successor picks up the lease, restores the checkpoint, and
continues the tick count rather than resetting the room.

## Measured, end to end, on what a client actually renders

The numbers above are about the server. These are from a harness that runs the
whole stack: a real `ws` server, `admitSocket` per socket, `runTicker` against a
real Redis, the real `RoomConnection` driven at 60Hz through `frame()`, and an
injected one-way delay. 30 second runs, one entity moving at a constant
100 u/s, 20Hz. "outside +-10%" counts rendered frames whose speed fell outside a
band around that true 100, which is the quantity a player perceives as
smoothness.

| scenario | one-way delay | peak u/s | outside +-10% | backward steps | worst gap |
| --- | --- | --- | --- | --- | --- |
| steady state | 20ms | 106.4 | **0 / 1600** | 0 | 56ms |
| steady state | 125ms | 105.8 | **0** | 0 | 73ms |
| planned handoff x3 | 20ms | 269 | 9 | 0 | 8.6 / 32.1 / 20.8ms |
| relay lifetime cap (10s) | 20ms | 102.7 | **0** | 0 | 57ms |
| client reconnect x2 | 20ms | 112.7 | 22 | 0 | 347 / 349ms |
| 3s render freeze | 20ms | 104.7 | **0** | 0 | 56ms |
| hard death (**not** in the claim) | 20ms | 110.7 | 266 (17%) | 8 | 4676ms |
| **real browser**, headless Chromium, 15s at 60fps | loopback | 72.2 (true 70) | **0** | 0 | 55ms |

`publishSkipped`, `publishFails`, `renewFails`, `dropped` and `badEnvelopes`
were 0 in every run, and the ticker measured 20.0Hz at every flush. The relay
lifetime cap row is the warm swap doing its job: five swaps, **zero
reconnects**, and the connection status never left `open`. The handoff row's
269 u/s peak was two or three frames per handoff and is fixed since, by the
successor continuing the predecessor's tick grid; the reconnect row's snap is
replaced since, by the resume glide (a 25 unit step at 1500 u/s became a
4.47 unit worst step, with no motionless frames). The hard-death row is the
5 to 7 second budget documented above, measured rather than argued.

**The last row is a real browser, which is the one thing a Node harness cannot
be.** Headless Chromium driving the shipped `examples/pong` client through
Playwright: 15 seconds at 60fps rendered between 68.5 and 72.2 u/s against a
true 70, standard deviation 0.77, and zero frames outside +-10%. The rest of
that run is the same shape as the table above and is worth naming because it is
the browser's own machinery rather than an emulation of it. A relay swap at
`lifetimeMs` 12000 completed in 3 to 52ms, four times, with `reconnects` 0 and
the status never leaving `open`. Three server-side kills mid-rally each cost a
300ms outage with the held poses on screen throughout, four motionless frames
before the resume glide and a worst step of about 5 units. A 5 second render
freeze left the socket open and the pings flowing, refused every pong sample
taken across it by design, and re-anchored the counter +14 onto `desiredTick()`
two frames after the loop came back. A wire version bump reloaded the page
exactly once and then latched `'version-skew'`. Across ten runs and 13,687
frames the console, `pageerror` and `unhandledrejection` channels carried zero
lines, with a self-test proving the capture was live.

**What that run could not reach is a genuinely hidden tab, and a later one
did.** `document.hidden` stayed false under five approaches including a CDP
lifecycle freeze and a window minimise, so the rAF freeze above is the half
Playwright can emulate; backgrounding a tab for real takes a browser process
attached over CDP with focus emulation disabled, which is what run C in the
next section does. **The throttle arrives earlier than the documentation
assumes**: a hidden tab drops to about one timer callback a minute from the
second minute, not the fifth, so a client pinging every 2s sends one frame a
minute and `requestAnimationFrame` stops entirely. The relay's old 45s liveness
deadline reaped every one of those sockets while they were perfectly healthy.
The default is 90s now, above one throttled interval with slack, and
`livenessTimeoutMs` must stay above 60s for any browser client: a real hidden
tab held an open socket across 6.5 minutes on that default, with zero
reconnects and a warm swap and a ticker handoff both crossing while it was
dark, and a real installed Google Chrome reproduced that run to the number. A
tab **discard** is measured too, and it is not a liveness case at all: the
socket dies with the renderer, the seat is gone before the page comes back, and
the tab returns as an ordinary reload. **Safari throttles far less**, which is
the safe direction here: the real Safari.app over `safaridriver` sent 93 pings
in 6.5 minutes hidden, about one every four seconds against Chromium's one a
minute, with the socket open throughout, zero reconnects and recovery at
1.007s, so the 90s default is never approached there. That run carries a method
caveat and it is in the still-open list in [`AGENTS.md`](../AGENTS.md). What is still untested is **mobile**.

**That harness is a test file, not a one-off.** `tests/smoothness.redis.test.ts`
runs the same chain on the same real Redis, with each scenario shortened to
about ten seconds, and pins six of the rows above: steady state, the planned
standby handoff, the relay lifetime swap, a render freeze, an ordinary client
reconnect and a three-client room. The last two are the newest and are worth
naming, because they pin the two claims a single-client steady run cannot
reach. The RECONNECT case closes the client's socket mid-run (about a 220ms
outage, which is the ladder's 100ms first delay plus a mint, a connect and the
injected one-way delay) and asserts exactly one reconnect, zero backward steps,
zero blank frames, at most three motionless frames and every resume step and
the run's peak under 400 u/s: the measured figures are 0 motionless frames and
a peak of 203, against the 4 to 6 motionless frames the pre-glide snap
produced. It also asserts `lateInputs` back to 0 within a second of the socket
reopening, which is the stamping lead re-seating rather than the render
recovering. The THREE-CLIENT case asserts that every client sees all three
players plus the bot in every steady frame, that the least-served sender stays
above 0.6 of the best-served one (measured 0.99, and a starved sender reads far
below it), that each client renders zero backward steps and a peak under 150,
that starves stay at or under two per client after the steady window, and that
`RoomStats.players` is 3. The speed and gap
bounds in it are deliberately loose, because a gate tightened onto a measured
number reddens on a loaded CI runner for reasons that have nothing to do with
this library; what it asserts at exactly **zero** is the stutter itself, a
backward step or a frozen frame, which is a zero-or-not property. One bound is
tighter than the rest on purpose: across a handoff the successor's first tick
must be exactly the predecessor's last **plus one**, and the server-time grid
must continue within a single tick. If a loaded runner lands the standby late
enough to break that, it is the planned handoff genuinely failing rather than a
flake, and the bound should not be widened to make the run green.

Beyond green, the guards are checked by **mutation**: each one is broken on
purpose and the suite has to notice. [`LEDGER.md`](LEDGER.md) carries the whole matrix, one
table per file, with the tree each was measured on. It is worth reading before
changing anything in `lease.ts`, `ticker.ts` or `interpolation.ts`, because a
green test over a guard that cannot fail is the exact trap this library has
fallen into more than once.

## The shipped example, through a real socket

**Everything above drives a runtime written for the harness that drives it.**
This one drives `examples/pong` unmodified, which is the gap CI carried as a
known one for weeks. `tests/example.redis.test.ts` runs the example's own
`pongRuntime` under `runTicker` with `encodePongSnapshot` on the wire, the
adapter's own `attachNodeRelay` on a real `ws` server, and the example's own
`createPongClient` as the client, on a 16ms timer in place of
`requestAnimationFrame`. Nothing about the netcode is retyped in the test: the
decode, the interpolator wiring, the `predict` option, the one
`frame(now, input)` call and the input rule are all the example's.

| | measured |
| --- | --- |
| snapshot rate | **19.67 to 20.33Hz** over 3 seconds |
| our own paddle | present in **every** steady snapshot |
| the server's paddle | 111 unsaturated steps, median and max exactly **90 u/s** |
| reconcile error after the replay | **0.0000 units** |
| the same, with the server's stamped playout disabled | **9 units**, so the row above is not vacuous |
| goals decoded through the binary codec | 2 |
| `hostErrors`, `badEnvelopes` | **0**, **0** |

That reconcile row is the whole point of the file. The client predicts its own
paddle with `stepPaddleY`, the server applies the same record on the same tick
with the same function, and if the input timeline is off by so much as a tick
the two disagree by `PADDLE_SPEED / tickHz` (4.5 units) rather than by the
codec's own quantisation. Getting the example onto this path is what split
`examples/pong/client.ts` in two along the DOM: `createPongClient` is all of the
netcode and none of the browser, `startPong` is the canvas, the keys and the
animation frame on top of it, and the behaviour of neither changed. CI's
integration job collects it.

## The other example, and the other input path

**`examples/pong` pins the stamped path; `examples/cursors` is the only thing
that pins the unstamped one.** `cursorsRuntime` declares no `usesPlayout` and
the client leaves `targetTick` at 0, so every input takes the ticker's
**on-arrival** branch: applied the moment the envelope is drained, never
buffered against a tick it names. That is the branch step 1 recommends first,
because a presence layer is the shape most people arrive with, and until
`tests/example-cursors.redis.test.ts` nothing that went near a socket exercised
it. The rig is file ten's: `cursorsRuntime` unmodified with no codec to swap
(the JSON `encodeSnapshot` publishes *is* this example's wire), `attachNodeRelay`
on a real `ws` server, and three headless `createCursorsClient`s on a 16ms
timer. Getting there took the same DOM split pong took, with a `decode` option
added so putting a codec on it does not mean forking the client.

| | measured |
| --- | --- |
| snapshot rate | **10.00Hz** over 3 seconds |
| pointer move to the first snapshot carrying that exact coordinate | **81 to 194ms**, medians 97, 177 and 184 across three runs |
| the bound it is asserted against | one send period + one tick + RTT = **200ms** derived, asserted at 400 |
| all three cursors | present in every steady snapshot and every client's roster frame |
| inputs decoded with `targetTick > 0` | **0** of 177 to 180, which is what proves the on-arrival branch ran |
| `hostErrors`, `badEnvelopes`, `starves` | **0**, **0**, **0** |
| the same run with the client's one `conn.send` made a no-op | 11 of 11 probes never arrive, **0 of 13** coordinates ever seen |

The last row is what makes the rest of them worth reading. Every probe position
is a coordinate the server has never held, so an arrival is proof the input
crossed the wire and moved the room's state; with the send disabled, the rate,
the roster and the zeroed counters all stay perfectly green while nothing
arrives at all. And `starves` can only be asserted at zero *here*: the
on-arrival branch never builds a playout buffer to starve, which is exactly the
difference between the two paths.

## Measured on Vercel

Everything above is loopback: a `ws` server in the test process, a Redis on
127.0.0.1, and a simulated one-way delay standing in for a network. **On
2026-09-03 the same analysis ran against a real deployment**, which is the half
a test suite cannot reach. A single room on `tickroom-bench.vercel.app`, a
personal team on the **Pro** plan, Fluid compute, Node 24, both long-lived
routes exporting `maxDuration = 300` against `maxDurationS: 300` (a
configuration, and the platform's own default; the run at the Pro cap of 800 is
further down), a managed Upstash `rediss://` about 80 to 87ms from the machine
driving it, and three headless Chromium clients at 60fps rendering the same
constant-velocity 100 u/s marker the table above measures.

**Run A, three clients, twelve minutes.**

| client | frames | backward | blank | zero-motion | peak u/s | mean u/s | worst gap | reconnects | swaps ok/att/failed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bot0 | 43,271 | **0** | **0** | 23 | 578 | 100.03 | 433ms | 1 | **2/2/0** |
| bot1 | 43,255 | **0** | **0** | 0 | 115 | 100 | 184ms | 0 | **2/2/0** |
| bot2 | 43,229 | **0** | **0** | 14 | 1395 | 100 | 433ms | 0 | **2/2/0** |

One ticker handoff was visible to the clients, at an arrival gap of 66ms on a
50ms grid with a server grid gap of exactly 50ms. The room itself, over 709 of
720 stats flushes: `starves` 43, `lateInputs` 23, `refusedInputs` 0,
`hostErrors` 0, `publishSkipped` 0, `publishFails` 0, `renewFails` 0, 14,367
publishes at 19.84 to 21.55Hz, 6.2MB published and 19.1MB delivered, and a peak
of 8 Redis connections.

**Run B, three clients, ten minutes**, with per-invocation ticker ids, socket
close codes and gap timestamps recorded.

| client | frames | backward | blank | zero-motion | peak u/s | mean u/s | worst gap | reconnects | swaps ok/att/failed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bot0 | 36,068 | **0** | **0** | 9 | 190 | 100 | 367ms | **0** | **2/2/0** |
| bot1 | 36,039 | **0** | **0** | 6 | 604 | 100 | 400ms | **0** | **2/2/0** |
| bot2 | 36,010 | **0** | **0** | 6 | 138 | 100 | 283ms | **0** | **2/2/0** |

Both ticker handoffs were seen by all three clients: at 270s an arrival gap of
49.8 to 49.9ms, at 538s one of 49.2 to 66.6ms, and a server grid gap of exactly
**50ms** both times, so a planned handoff on a real platform costs **no server
tick** and at most one extra frame of arrival jitter. Six relay warm swaps of
six succeeded, none failed, and each retired socket closed **1005 clean** about
three seconds after its replacement was adopted. The room: `starves` 33,
`lateInputs` 26, `refusedInputs` 0, `hostErrors` 0, `publishFails` 0,
`renewFails` 0, 11,972 publishes at 19.96 to 21.01Hz, 5.1MB published and 15.2MB
delivered, peak players 3, peak 8 Redis connections. The deployment's own logs
over the whole session carried only 200 and 101 responses: **no 5xx, no function
timeout, and no warn or error line anywhere**.

**Run C, one genuinely hidden tab, 6.5 minutes.** A real windowed browser
process attached over CDP with Playwright's focus emulation disabled, which is
what it takes to background a tab at all.

| | measured |
| --- | --- |
| tab state | `document.hidden` true, `visibilityState` hidden, **1 frame rendered** in 6.5 minutes |
| client pings | the 2s cadence for the first minute, then **about one a minute**; 46 in total |
| socket | open throughout, **0 reconnects**, still in the roster on return |
| crossed while hidden | one relay warm swap (succeeded, retired socket 1005) and one ticker handoff |
| recovery on show | first drawn frame and re-seated in the roster at **1.05s** |
| liveness | the **90s** default held; the old 45s default would have reaped this socket |
| tick re-anchors | 200, max delta 43 ticks, because `frame()` is not running |

**Cold start and join.**

| | measured |
| --- | --- |
| cold spawn of the room's ticker to first snapshot | **1.0s** |
| joining a room that is already running | **0.35 to 0.6s** |

**Run D, the Pro cap, three clients, 27 minutes** (2026-09-05). The runs above
were configured at 300s; this one runs at 800, so the ticker's `maxRunMs` is
`min(700s, 800s - 30s)` = **700s** and the relay's `lifetimeMs` is **790s**,
which are the periods this README's own snippets produce.

| | measured |
| --- | --- |
| ticker handoffs | both seen by all three clients: at 700s an arrival gap of **50.0 to 50.1ms**, at 1397s one of **66.7 to 83.4ms**, server grid gap exactly **50ms** both times |
| relay warm swaps | 2 attempted and 2 succeeded per client, **0 failed**; retired sockets closed **1005 clean** at 788s and 1574s |
| reconnects, stalls, terminals | **0**, **0**, **0** |
| mean rendered marker speed | exactly **100** on all three |

**The client-side numbers in that run are the worst this bench has produced,
and that is the container rather than the platform.** It rendered in three
headless Chromiums inside a Docker container on a 16-core server while a second
three-client run shared the box: 35 to 61 zero-motion frames per client, worst
arrival gaps of 650 to 933ms (most of them in the first 75 seconds), peaks up
to 3290 u/s, RTT medians of 91 to 117ms against 80ms minimums, and one backward
step on one client in 97,000 frames, which is the first backward step in any
run here. Read those as a renderer starved of CPU. The server-side facts in the
same run, the handoff cost, the swap success and the absence of reconnects, do
not depend on the client drawing on time, which is why they are the rows above.

**The hidden tab again, in a real installed Google Chrome** (152, not Chrome
for Testing), 6.5 minutes: **1 frame rendered**, pings at 15 per 30s through
the first minute and then about one a minute for **47** in all, the socket open
throughout with **0 reconnects**, no closes and no terminals, still in the
roster on return, recovery at **1.019s** to the first frame and to being drawn,
and 201 tick re-anchors at a maximum of 44. The same result as Chrome for
Testing 151 produced, on the browser a player actually runs.

**And a tab discard, which nothing had produced before.** A discard kills the
renderer outright, so the socket, the connection, the tick counter and the
player's seat go with it and the tab comes back as a **reload**. Chrome 152
would not revive it on activation while the machine was locked, so the harness
reloaded it at 6.4s; counting from that reload, the first frame was at
**0.27s**, a new player id at **0.37s**, an open socket at **0.69s**, drawn in
the roster at **0.79s**, with `reconnects` **0**. What it settles is that a
discard is not a liveness question at all: the discarded client's seat was
already gone from the first roster the reloaded page drew, because the socket
died with the renderer and the relay dropped the player at once, so the 90s
deadline never enters. A discarded tab is a reload, a reload is a fresh
session, and nothing here needs to survive one.

**The residual is the pub/sub tail, and it is worth stating plainly.** On this
path (a function, to Upstash over TLS, to another function, to a browser 80ms
away) snapshot arrival gaps of **150 to 250ms** land about once a minute per
client, and gaps of **250 to 433ms** about once per five client-minutes, with
nothing in the library's own events near most of them. The interpolator absorbs
the first band outright. The second shows as 6 to 23 motionless frames followed
by a catch-up, peaking at 600 to 1400 u/s on an entity whose true speed is 100:
a visible hitch of about a third of a second, a few times an hour per client.
Across all 73 client-minutes there were **zero backward steps, zero blank frames
and a mean speed of exactly 100**. The loopback harness never sees a gap above
149ms, so this band belongs to the network path rather than to this library's
scheduling. The lever a host has is the **interpolation delay floor**, which
trades roughly 200ms of remote-entity latency for absorbing the second band. The
two measurements that would attribute it have both been made, and they rule
Redis out. The database is in the **same region** as the functions (`iad1`), so
there was no move to make there. And an in-function probe, opening its own
publisher and subscriber from inside a Vercel function and timing round trips
every 100ms with the browser, the relay and the last 80ms of network removed,
reads:

| | PING | PUBLISH to SUBSCRIBE |
| --- | --- | --- |
| 60s, 601 samples each | p50 **1.26ms**, p90 1.84, p99 2.35, max 22.27 | p50 **1.28ms**, p90 1.52, p99 2.10, max 22.02 |
| 240s, 2406 samples each | p50 **1.46ms**, p90 2.04, p99 2.38, max 14.14 | p50 **1.66ms**, p90 1.90, p99 2.32, max 19.63 |

**No sample over 150ms in either run.** So the band is not in the Redis path.
What is left is the relay function (its subscriber's event loop, or the
function being paused between snapshots) or the socket path to the browser, and
the relay now reports which: `relay.gaps` measures the inter-arrival gap on the
relay's own subscriber and the time from a bus arrival to the send returning,
per heartbeat window, and logs one line only when those pass 150 and 50ms. A
line whose `busGapMax` matches a client's gap puts the cause upstream of the
socket; a client gap with no line beside it is the socket path itself. **The
first run of that read the second way.** Ten minutes, three clients: eight
client-side gaps over 250ms and **not one** `relay.gaps` line in the
deployment's log for that window, with other relay lines from the same
deployment present in it, so the absence is a measurement rather than a logging
failure. That clears the ticker, the bus and the relay function and leaves the
socket path between the function and the browser, or the client's own event
loop.

**And a second run separated those two, which finishes the attribution.** Every
arrival time quoted above is inferred from rendered frames, so a stalled
renderer reads exactly like a delayed packet; the bench page now also keeps a
ring of timestamps taken in a socket `message` listener registered before the
library's own, which is an arrival time that owes nothing to the render loop.
Ten minutes, three clients: about 12,000 socket arrivals each, a median gap of
**49.8ms** on the 50ms grid and a p99 of 69 to 75ms, and **every** frame-inferred
gap over 250ms confirmed by the socket's own handler within a few milliseconds
(267/252, 417/416, 433/428, 700/709, 283/276), all marked `socket` and **none**
`render`, with no `relay.gaps` line in the window. So the holes sit between the
relay's `send` returning and the browser's `message` event: the WebSocket path
from the function through Vercel's edge, or the network. **The residual is a
platform property rather than a library one**, and the lever a host has is the
interpolation delay floor. One ambiguity is left on purpose: a whole-process
stall stops the message handler too, so `socket` means "not only the render
loop", never "the network".
## Status, honestly

Published to npm, and **measured on a real Vercel deployment on 2026-09-03**,
then again at the Pro plan's 800s cap on 2026-09-05, rather than only on
loopback. The architecture's production evidence is still
the game it was extracted from, where the lease, the checkpoint handoff, the
playout timeline, the stall thresholds and the interpolation rules were all
measured under real load. This repo proves the extraction is faithful, that the
mechanisms work against a real Redis and a real socket, and that the platform
half holds where it used to be reasoned about rather than observed: the duration
cap, the standby's head start, the relay's warm swap, a cold start's cost and
the connection count per player are all in the verification section above with
numbers on them. What it has still not done is serve a player.

**An exhaustive audit landed on 2026-09-02**: nine finder lenses over the whole
library, 69 findings, most of them measured with a scratch harness rather than
reasoned about. It is where the standby successor, the relay warm swap, the
measured round trip, the owner-checked checkpoint, the input-subscription
liveness probe, the crash counter, `core/wire.ts` and `server/admission.ts` all
come from, and it is written up finding by finding in [`LEDGER.md`](LEDGER.md). Two things it
found are **documented rather than fixed**, both above: the 5 to 7 second
unplanned-death budget, and roughly one second of two interleaved authorities
after a Redis restart with no persistence (bounded, self-correcting, and now
logged). The audit changed public API in several places, so the next release is a
minor bump: `TerminalReason` gained members and renamed one, `conn.stats()` has a
new shape, `RoomStats` gained five fields, `TickerResult.reason` gained
`'input-dead'`, and the unreachable `adapters/index.ts` barrel is gone.

**That audit was then attacked**, which is the only reason to trust any of it.
Three adversarial passes went at the ticker, the client connection and the
relay and adapters with a brief to refute rather than confirm, and the
end-to-end harness whose numbers are in the verification section above measured
what a client actually renders. The lease and checkpoint invariants held under
every profile, the standby handoff held at tick 161 to 162 with no interleaving
of any kind, and steady-state rendering held at zero frames of 1600 outside
+-10% of true speed. What it found was mostly ordering and lifetime: a
successor that restarted the server timeline instead of continuing it,
overlapping checkpoint writes landing in compression order, a capacity refusal
that closed both of a swapping player's sockets, and several leaks on paths
nothing exercises. **Two of them were regressions the audit itself had
introduced**, and both are written up by name in [`LEDGER.md`](LEDGER.md) rather than
quietly folded in, because an audit that hides its own mistakes is worth
nothing: a `commandTimeout` on the Redis *subscriber*, which turns a slow
resubscribe into a process exit, and a terminal-callback ordering that closed
the socket the restart recipe in step 3 above had just opened.

**And then a completeness round went looking for what both of those had
missed**, which is where the numbers in the verification section above come
from. Second-round verifiers re-attacked the client, the ticker and the relay; a
137-mutation vacuity sweep asked which guards had tests that could not fail; the
end-to-end harness became a permanent test file; and the library was run for the
first time in a real headless Chromium, installed from its own packed tarball
into fresh Vite and Next projects, loaded with twenty clients one of which was
flooding, and fuzzed at 50,000 frames. What it found was mostly coverage rather
than behaviour: a fake Redis that applied the lease's owner semantics itself
regardless of what the shipped Lua said, so three lease cases were vacuous; a
handful of guards asserted in prose and pinned by nothing. What it found in
behaviour was a relay whose subscriber could be black-holed after a successful
subscribe with nothing anywhere noticing, a `room-full` on the roster channel
latching every client in the room, a snapshot-plausibility escape hatch that
never re-armed, and a resume glide whose clamp read motion state the caller had
just been told to destroy. All fixed and pinned. Three things it measured and
left alone are documented rather than fixed, all above: the per-sender inbox
quota is a backstop against a producer that reaches the bus without a relay
rather than something a socket-borne flooder can reach, the snapshot backlog
drop is memory safety against a wedged socket rather than staleness control
(a modern kernel absorbs a stalled reader into its own send buffer first), and a
tab hidden for more than five minutes was untested at the time because no
browser automation in that round could produce one, which the Vercel run has
since closed.

CI runs the typecheck, the build and the unit tier with no services on every
push and PR, plus the integration tier against a Redis service container.
Releases publish from a tag through npm trusted publishing, so no token is
stored anywhere, and the release workflow stands up **the same Redis service CI
does** and requires it. That matters more than it sounds: the real-Redis files
skip cleanly when nothing is listening, so without the service the publishing
build ran to a green exit having executed zero assertions in the lease,
checkpoint, handoff, subscriber and fault-injection suites. A gate that cannot
fail is worse than no gate, and this is the one build whose version number is
burned forever, so the release gate is at least as strong as CI rather than
weaker.

The release gate runs the **integration tier**, not the measurement one. A
publish blocked by a noisy shared runner is a publish blocked by nothing, and
the pressure it creates is to widen the bound rather than to fix the code. The
measurement tier runs nightly instead (`.github/workflows/nightly.yml`,
reporting only, uploading its log as an artifact and blocking nothing) and by
hand on the quiet machine the numbers above were taken on.

**What is still open** is the list [`AGENTS.md`](../AGENTS.md) keeps, and it is
the same list:

- **A Safari read without the per-sample switch, and mobile.** Safari ran on
  2026-09-05 and throttles far less than Chromium, but WebDriver would not
  report a background tab's state while another tab sat in front of it, so the
  harness switched to the measured tab for each 30s sample and back. That is a
  tab hidden thirty seconds at a time, not one hidden straight through. Reading
  it without the switch needs a `BroadcastChannel` to a visible helper tab, or
  the page posting its own state to the server. Mobile is untouched.
- **The relay swap's failure path.** A successful swap is message-driven and
  rides through a hidden tab's throttle; a failed one falls back to the
  reconnect ladder, which is a timer the throttle does reach, so that outage
  can still stretch toward a minute. Untested.
- **Nothing drives an example through the Vercel adapter in process.** Both
  shipped examples now go through a real socket in CI, pong on the stamped path
  and cursors on the unstamped one. The bench deployment *is* the drive through
  the Vercel adapter, so what is missing here is a test rather than a
  measurement.
- **The depth loop's two-tick target is a reasoned default, not a swept
  one.** The headroom beside it is swept (100, 150 and 200ms on a real
  deployment) and the band was measured; the target itself would need the
  constant exposed as an option, which was a deliberate no.
- **The arrival band is attributed now, and what is left of it is narrow.** A
  socket `message`-timestamp ring confirmed every frame-inferred gap over 250ms
  at the socket itself, so the band is the WebSocket path rather than the
  renderer, the ticker, the bus or the relay. Still owed: the same run from a
  quiet machine on a residential link rather than a loaded container, and a
  whole-process stall detector in the page, since a blocked event loop stops the
  message handler too and cannot be told apart from inside it.
- **No lint script**, so CI runs no linter.

