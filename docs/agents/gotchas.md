# Gotchas that cost real production time, in full

Moved verbatim from `AGENTS.md`, which keeps the one-line form of each entry
and links here. Inside this file, "the invariants", "the gotchas", "the Gates
section", "the Status section" and "the table" mean
[`invariants.md`](invariants.md), [`gotchas.md`](gotchas.md),
[`gates.md`](gates.md), [`status.md`](status.md) and [`tiers.md`](tiers.md) in
this directory; "above" and "below" mean wherever that file now is.

Traps rather than rules: shapes that look right and are not. The invariants above
are what the code does about them.

A HALF-BUILT SEAM IS WORSE THAN NO SEAM. `preserveAttemptTime` was documented,
tested, and named `ticker.ts` as the caller that needed it, and `ticker.ts` never
called it: the fix was in the tree and absent from every code path that runs. When
a change adds an option, a helper or a hook, the counterpart is the CALL SITE. It
was deleted rather than passed, because an option whose only correct value is
`true` leaves the next reader re-deriving why.

THE PER-SENDER INBOX QUOTA IS A FAIRNESS PROPERTY, NOT A MEMORY BOUND, AND IT IS A
BACKSTOP A SOCKET-BORNE FLOODER DOES NOT REACH. `20 * perSenderCap` (64) must stay
well under the global cap (4096) so the per-sender bound binds first. But
`RoomStats.dropped` stays 0 under a socket flood, because the excess dies one layer
up at that socket's token bucket and 25 envelopes a second against a per-tick drain
never accumulates 64 undrained. The quota is for a producer that reaches
`room:{id}:in` WITHOUT a relay in front of it and for a loop that stops draining
for seconds. Do NOT write a test that asserts `dropped > 0` under a socket flood;
it asserts the wrong layer.

A SPAWN IS A DELIVERY, NOT A CONVERSATION, AND IT LIVES IN `finally`. A ticker
route does not respond until `runTicker` RETURNS, so the answer to a spawn is the
successor's WHOLE LIFE and undici fails it at its 300s `headersTimeout` against a
healthy ticker. Fire-and-forget is wrong the other way: as the last thing a handler
does it is post-response IO the platform can suspend before flushing. And it must
NOT use `AbortSignal.timeout`, which could propagate as a cancellation and tear
down the very ticker just started. Race a plain timer, leave the request alive,
resolve on a RECEIPT. THE GENERAL RULE: any request whose response is the callee's
entire lifetime is waited on for a receipt, and any timeout in that path is a
statement about DELIVERY rather than about health.

TWO FIRST JOIN PUBLISHES, AND BOTH ARE LOAD-BEARING. The immediate one keeps a
reconnecting player from being frozen server-side; the one gated on the subscribe
ack keeps a socket from missing its own one-shot roster announcement, since pub/sub
drops a message with no subscriber. Neither covers the other.

DETACH BEFORE CLOSE ON THE CLIENT. `connect()` must null `this.ws` and close the
previous socket before constructing the replacement, and every listener body must
return early when `this.ws` no longer names its own socket. An orphaned socket
keeps decoding messages into this client's state, runs its own reconnect ladder in
parallel, and holds a slot against the per-user socket cap.

`readCheckpoint` MUST USE `getBuffer`, NEVER `get`. A utf8 decode of gzip bytes is
lossy and destroys the payload before anything can sniff it.

A BARE `raw in WORLDS` MATCHES INHERITED PROPERTIES: `constructor`, `__proto__` and
`toString` all pass. Use `Object.prototype.hasOwnProperty.call`. A real trust
boundary, because the value is interpolated into a Redis key name.

A CLAMP AGAINST A RANGE THE HOST NEVER CHOSE IS THE OTHER HALF OF "CLAMP, NEVER
WRAP". `encodeDefaultSnapshot` hardcoded `quantizeCm`, so the default codec spanned
+-327.67 METRES while this library advertises 2D games and cursor layers, which
count in PIXELS: every entity past 327 piled against an invisible wall, with no
error and nothing in a metric, which reads as a snapping bug in the CLIENT. Fixed
additively with `positionScale` and `representableRange`, asserted ONCE at startup,
NOT with a per-value hook on the encode path, which runs per entity per tick per
player. The byte-identical default is pinned against a LITERAL byte array rather
than a re-encode, which would agree with itself whatever the default is.

BEFORE WRITING A RUN-BASED DISCRIMINATOR IN THE INTERPOLATOR, ASK WHAT REORDERS THE
STREAM, BECAUSE SOMETHING ALWAYS DOES. Three times in that module: the dead-epoch
cut keying on the LAST arrival rather than the newest; the seed frame defining the
statistic it was judged against; and the floor-refusal escape counting CONSECUTIVE
refusals, which a latency DROP larger than `OFFSET_FLOOR_SLACK_MS` reorders by
construction, so every old frame cleared the count.

A RESYNC THAT DOES NOT SLEEP IS THE RUBBER-BAND IT EXISTS TO PREVENT. Setting the
grid to `now` and falling through leaves two snapshots with consecutive ticks and a
`serverTime` gap of 0 to 1ms, and the client divides a tick's movement by that gap.
Sleeping to `now + tickMs` also hands the event loop the turn it needs to drain the
envelopes that piled up during the stall.

A BLACK-HOLED SUBSCRIBER PRODUCES NO EVENT AT ALL, WHICH IS WHY BOTH SIDES NOW TALK
TO THEMSELVES. No error, no close, nothing to observe: the room keeps ticking,
publishing and renewing while every join and every input is silently dropped. AND
THE PROBE'S CONSTANTS ARE THEIR OWN, NOT A MULTIPLE OF `statsMs`: a host setting
`statsMs` to 40 for finer metrics resolution gave itself a 120ms deadline and tore
down a healthy room. A knob documented as a metrics cadence must not be able to
decide when a room dies.

A LEAVE THAT LANDS IN A HANDOFF GAP IS SIMPLY LOST, AND THE PLAYER NEVER LEAVES.
Pub/sub drops a `leave` when no ticker is subscribed, which is precisely when a
relay is most likely to be closing sockets, and the phantom stays in the roster,
the meta hash and every successor's checkpoint: a room that can never drain,
holding a capacity slot nobody can reclaim. FIVE heartbeats before a synthesised
leave, because one lost beat must not remove a live player and five one-second
beats sit above the 5 to 7 second unplanned-death gap. A host that moves
`heartbeatMs` owns `presenceTimeoutMs` with it, at AT LEAST THREE of its beats.

A GRACE-PERIOD REJOIN WAS REFUSED AS A NEW ARRIVAL, BY THE FULL ROOM IT WAS ALREADY
IN. `leave` deleted from `present` unconditionally, even for a runtime holding the
player through a disconnect grace, so the reconnect met `isFull` and was answered
with `room-reject` while the simulation still had them in the room.

A THROWN CHECKPOINT READ IS NOT AN ABSENT CHECKPOINT. One rejected `GET` produced
`runtime.create`, a new incarnation, and a first iteration that OVERWROTE the
perfectly good checkpoint a millisecond later. Retrying costs a few hundred
milliseconds of handoff and giving up costs one invocation; neither costs the room
its state. A value that WAS read and cannot be decoded still starts fresh: that is
a fact about the bytes rather than about the connection.

A RELIABLE QUEUE ON A LOSSY BUS IS WORSE THAN DROPPING, AND THE BOUND IS NARROWER
THAN IT READS. The snapshot forward turned pub/sub into an unbounded queue and
ioredis's own command buffering did the same from the other end. But
`snapshotBacklogBytes` keys on `bufferedAmount`, the transport's USERSPACE queue,
and a modern kernel absorbs a merely slow READER into its own send buffer long
before that queue grows: THIS BOUND IS MEMORY SAFETY AGAINST A WEDGED SOCKET, NOT
STALENESS CONTROL. A slow reader gets the frames late and renders the documented
catch-up on resume.

A SPAWN POLL WITHOUT A HOLD-OFF IS A THUNDERING HERD. A ticker cold start is longer
than the poll period, so every poll inside that window fired another invocation
that existed only to lose the acquire race. The poll keeps running throughout; what
the hold-off bounds is how often one relay is willing to PAY.

TWO LISTENERS ON ONE PUB/SUB CONNECTION COST A UTF8 DECODE PER FRAME. ioredis emits
BOTH `message` and `messageBuffer` as soon as any `message` listener exists, so a
relay listening on both decoded every binary snapshot to a JS string once per
socket per tick purely to throw it away on a channel check.

A 4001 IS TWO DIFFERENT EVENTS ON ONE CODE, AND COUNTING AN AUTH CLOSE ON
`preOpenFailures` CANNOT WORK. The node adapter verifies the token AFTER the
upgrade, so a session older than the host's `maxAgeS` ends the game on the next
network blip. A 4001 BEFORE this epoch delivered anything is a stale token; once
the epoch has delivered, the server had already accepted this token, so it can only
be a deliberate kick. It needs its OWN counter, because those sockets DO open and
`onopen` clears `preOpenFailures`.

A `void`ED PROMISE MAKES EVERY THROW SILENT. `scheduleReconnect` drives the ladder
with `void this.connectOnce(...)`, so a throw in the post-mint half was an unhandled
rejection and the ladder simply stopped: no timer, no terminal, status stuck on
`'connecting'` forever. Same shape one layer up: an `async` host hook satisfies a
`void` return, and its rejection kills the process.

A CONSTANT CAN ONLY BE PINNED FROM BOTH SIDES. `DELAY_SLEW_MAX` was swept against
two profiles that pull in opposite directions and the table is in the source; the
shipped value is the only one where both read zero, and both tests bind. A constant
pinned from one side only is a constant with a free direction.

A BACKWARD RE-ANCHOR SILENCES A HOST THAT DEDUPES BY A HIGH-WATER MARK, AND THE
LIBRARY CANNOT SEE IT HAPPEN. `if (t <= lastSent) return;` is the obvious way to
write a sender and is correct right up until `onTickReanchor` delivers a NEGATIVE
delta. Documented rather than fixed: the delta is the number to move the mark BY. A
host on `predict` has nothing to adjust.

A HIDDEN TAB FIRES `onTickReanchor` ABOUT EVERY TWO SECONDS, AND THAT IS NOT A
FAULT. `frame()` advances the client tick and a backgrounded tab stops
`requestAnimationFrame` entirely while snapshots keep arriving on a socket the
browser does not throttle. A host that alerts on it pages itself every time a
player switches tabs.

A REDIS DB INDEX DOES NOT ISOLATE TWO DEPLOYMENTS, AND `namespace` DOES. KEYS are
per database, PUB/SUB IS INSTANCE-WIDE, so two deployments publish into the
identical channels while each acquires its own lease against its own key and each
believes it is the exactly-one writer: two tickers interleaving snapshots, no error
anywhere, and the lease mechanism unable to see it because it is doing its job
correctly on each database separately. It has to be passed to BOTH routes. Separate
from the db-0 rule, which is about ioredis re-issuing an uncaught `select(db)` on
every reconnect; both point the same way.

STEADY MOTION HIDES AN OFF-BY-ONE IN THE INPUT TIMELINE, AND ONLY AN INPUT CHANGE
REVEALS IT. Under a held key a record applied a tick late carries the same value as
the one that should have been, so both ends agree to the unit and every existing
test stays green; at every START or STOP they disagree by exactly one tick of
travel. THE LESSON FOR ANY RECONCILIATION TEST: it MUST change the input mid-run
and assert on the snapshot LABEL, because a steady input cannot tell the two
timelines apart and a hook's view of `state.tick` at consume time is one below the
label whichever timeline is in force.

A COUNTER JUMP IS NOT TIME PASSING: THE RENDER OF A PREDICTED ENTITY MUST SLEW, NOT
FOLLOW THE COUNTER. `prev + (curr - prev) * tick.fraction` is the standard
fixed-timestep interpolation and is correct only while the counter advances by wall
time. It also JUMPS: a forward re-anchor stamps the catch-up ticks in one frame and
a draw that follows moves the pose several ticks of travel in 16ms with nothing
counting it, and a -1 re-anchor (the COMMON epoch anchor on a fast link) puts
`(prev, curr)` a tick ahead of `(value, fraction)` and the draw walks BACKWARD. THE
LESSON FOR ANY RENDER TEST OF AN OWNED ENTITY: drive the REAL counter with
`anchorTo` jumps as well as `advance`, assert per frame on the DRAWN pose, and
count the snaps, because the reconcile error was exactly zero through every one of
these defects.

A ONE-TICK FEEDBACK DEADBAND WAS MEASURED WORSE, AND THE CUSHION BELONGS IN
`inputLeadMs`. Narrowing the `input-lead` loop's band to one tick sounds right and
does the opposite, because every correction clears the client's stamped window and
the loop then hunts. What moves the starve rate is headroom.

THE THREE ORDERS A CONSUMER GOT WRONG WITH A HAND-HELD `PredictedEntity`: advancing
the entity BEFORE `conn.frame()` (every record stamped one frame into the past),
reconciling AFTER reading `entity.pose` in `onSnapshot` (a camera and a collision
latch a snapshot behind), and calling `snapTo` AFTER `reconcile` on a respawn (the
server's answer gliding in from the pre-respawn pose and then snapping to the
host's guess). Each is an order between two objects the host held at once, and THE
FIX FOR AN ORDERING RULE IS TO REMOVE THE SECOND OBJECT.

THE BINARY INPUT WIRE CHECKS ITS SHAPE BEFORE THE FIRST STAMP, NOT INSIDE THE
ENCODER. Checked inside the encoder on the first send, which is after the records
are pushed and the mark has moved, the `TypeError` fired once, the next frame
crossed no tick and sent nothing, and the entity sat there stamped and silent with
the error a frame in the past.

A PREDICTION STEP HAS TO BE PURE OF CLIENT-FRAME STATE, NOT MERELY OF ITS OWN, AND
THIS IS WHAT RUBBERBANDING ON A HEALTHY LINK LOOKS LIKE. `reconcile` replays the
records from the SERVER's pose, so every hook the step reads has to be evaluated
from the pose it is handed, on the tick it is handed. A consumer latched "am I
standing on my own bomb" once per frame from the RAW prediction and read the latch
inside the step, so the replay was refused every move it tried and every snapshot
produced a correction the link had nothing to do with. The fix is the shape, not
the value: hooks are functions of the arguments.

A MINIMUM-FRAME-INTERVAL GATE IN A rAF LOOP IS A FRAME DROPPER.
`if (now - last < 1000 / 61) return;` reads like a limiter and behaves like a
filter on timestamp jitter: 16% of frames dropped on a 60Hz display, each one a
visible hitch. Render every callback.

A COLD START SAYS SO NOW. Every way a ticker could fail to restore had its own log
line except the ordinary one, an absent checkpoint, so a bare "no `ticker.restore`"
could not distinguish the branches. `ticker.fresh` makes a room started clean one
positive event rather than an absence of one.

A FRAGMENTED FRAME IS THE RELAY'S PROBLEM, AND IT USED TO BE EVERY HOST'S. `ws`
delivers a fragmented message as an ARRAY of buffers, a peer or a proxy chooses its
own fragmentation, and nothing about a frame's size prevents it. Every host wrote
the same `Array.isArray(data) ? ... : data` arm in its own decoder; a host that did
not saw one player's inputs stop with the room, every other player perfectly
healthy and nothing anywhere logged. `joinFragments` normalises ONCE, and the
all-or-none rule is a test rather than a comment.

FLUID COMPUTE CAN RUN THE STANDBY SUCCESSOR IN THE SAME CONTAINER AS THE INCUMBENT,
SO AN INSTANCE ID AT MODULE SCOPE DOES NOT MARK A HANDOFF. A ticker spawns its
successor by calling its own route, and that request lands in an already warm
container more often than not. Nothing in the library is wrong there; the observer
is. Generate such an id PER INVOCATION, inside the handler.

VERCEL AUTHENTICATION BLOCKS THE RELAY'S OWN TICKER SPAWN, AND THE ONLY SYMPTOM IS
SILENCE. Deployment Protection is on by default and guards EVERY request to the
deployment including one function calling another, so the spawn gets an SSO
redirect. Up to 1.3.0 that answer resolved the spawn, so nothing errored: a socket
opened, the player joined, the roster seeded, and the room sat in perfect silence
with no `/api/ticker` line in the invocation log at all, that ABSENCE being the
whole signal. Since 1.4.0 any non-2xx inside the receipt rejects and
`relay.spawn-failed` names the status. Turn Protection off, or set
`VERCEL_AUTOMATION_BYPASS_SECRET` and send it on the spawn.

VERCEL'S LOOP PROTECTION CUT THE STANDBY CHAIN, AND A NON-2XX THAT RESOLVED HID
THE FALLBACK FAILING TOO. On a real deployment (`maxDurationS` 60, fourteen
handoffs) the log ran one cold ticker, three standby handoffs, then
`ticker.spawn-failed: standby spawn answered 508`, five cycles in a row: each
ticker-spawned standby was one hop deeper than the ticker before it, and the
platform refuses a function calling its own deployment at about the sixth. The
exit spawn then hit the same 508 and resolved as the route's answer, so nothing
said so, and the room waited for a relay's lease poll: a 135 to 350ms snapshot
gap that re-anchored the client past `PLAYHEAD_SNAP_TICKS` and snapped the own
timeline. The hop count is not documented beyond the error code; a browser's
request starts a fresh chain, which is why the relays issue the standby now.

UPSTASH'S `CLIENT LIST` CARRIES NO SUBSCRIBE-MODE FIELDS, so a count of lines
matching a subscribe flag reads ZERO while a ticker subscriber and one per relay
socket are certainly live: a plausible-looking number and a false one. `INFO
clients` `connected_clients` is accurate. Anything reporting the split has to say
"not reported" on a provider that does not report it rather than print the zero.

A HOST CALIBRATION TAKEN AT MODULE LOAD CAN UNDER-READ THE RUN IT GATES, AND THAT IS
THE WEAKEST POINT IN THE WALL-CLOCK HARDENING. `tests/helpers/jitter.ts` has to be
taken at module load for the same reason `probeRedisAvailable` is: `describe` and
`it` bodies are collected synchronously. So the reading describes the machine at
COLLECTION time, and a full-suite run is at its busiest later. If a gated file
reddens on a loaded box with a jitter reading comfortably under the limit, this is
the reason, and the answer is a re-reading beside the case rather than a wider
bound.

UNDER `vi.useFakeTimers()`, ANYTHING OBSERVED DOWNSTREAM OF REAL I/O IS TIMESTAMPED
NONDETERMINISTICALLY, AND GZIP IS I/O. `writeCheckpoint` deflates on libuv's
threadpool, so the virtual clock races a real compressor and the checkpoint spacing
a test reads is the compressor's schedule rather than the cadence under test. THE
BOUND WAS NEVER THE PROBLEM AND WIDENING IT WOULD HAVE HIDDEN THIS: the case
advances one tick at a time and drains real event-loop turns while a write is
outstanding. Every other virtual-time case in that file dodges the class by
disabling checkpoints. The same trap waits behind `fs`, `dns` and anything else
that finishes on the threadpool.

A HELPER SCRIPT WITH A RELATIVE SOURCE PATH WILL EVENTUALLY OVERWRITE THE FILE YOU
ARE EDITING, because an agent shell's cwd resets to the repo root between calls, so
a script written to run from a scratch directory copies its stale snapshot over the
LIVE file, silently, with a green exit code. ABSOLUTE PATHS ONLY in anything that
writes, and never keep a snapshot of a file you are actively editing beside a
script that can write it back.

AN UNTRACKED SCRATCH SUITE UNDER `src/` IS COLLECTED BY VITEST AND INFLATES EVERY
COUNT IN THIS FILE, because the include is `src/**/*.test.ts` and has no idea
whether a file is tracked. Before quoting a whole-tree count, `git status --short`
and delete them. AND THE SAME SCRATCH FILE SHIPS TO NPM, BECAUSE `tsc` NEVER CLEANS
`outDir`: a directory compiled once and since deleted from `src/` stays in `dist/`
forever and is PACKED, with the typecheck clean because the source is gone and the
tests green because they never look at `dist/`. `build` is
`rm -rf dist && tsc -p tsconfig.build.json` for exactly this, and never quote a
pack size or file count that was not re-measured after the build it describes.

NEVER ASSERT ON SERVER-GLOBAL STATE IN AN INTEGRATION TEST. The first fan-out test
gated on `INFO stats` `total_commands_processed`, which counts every client on that
server, so any other file running in parallel landed inside the measurement window
and it failed in the full suite while passing in isolation. Key prefixes isolate
keys; they do not isolate `INFO`, `DBSIZE`, `CLIENT LIST`, or any other
server-level metric. Measure something you own.
