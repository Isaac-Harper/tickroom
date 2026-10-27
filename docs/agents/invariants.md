# Non-negotiable invariants, in full

Moved verbatim from `AGENTS.md`, which keeps the one-line form of each entry
and links here. Inside this file, "the invariants", "the gotchas", "the Gates
section", "the Status section" and "the table" mean
[`invariants.md`](invariants.md), [`gotchas.md`](gotchas.md),
[`gates.md`](gates.md), [`status.md`](status.md) and [`tiers.md`](tiers.md) in
this directory; "above" and "below" mean wherever that file now is.

Rules. The trap each one guards against is often a gotcha below.

- `src/core/` stays pure: no Redis, no sockets, no platform imports, no clock
  reads, ever. ENFORCED rather than asserted, by `src/client/bundling.test.ts`,
  because NOTHING IN A NORMAL GATE SEES A NODE BUILTIN REACHABLE FROM `core/`:
  `tsc`, `vitest` and `npm run build` all run in Node, where `node:zlib`
  resolves fine, and the failure appears only when a consumer bundles for the
  browser, where it is a HARD ERROR. Tree shaking does not save you (the old
  gzip module ran `promisify(gzipCb)` at module scope). The fix is to MOVE the
  module, not to drop it from the barrel: with nothing Node-only left under
  `core/` the rule is a property of the directory, so the only way back in is a
  `../server/...` import inside `core/`, an obvious layering violation rather
  than a plausible barrel tidy-up.
- `src/server/` imports nothing from `next` or `@vercel/functions`. A hard import
  would make the library refuse to install outside one platform.
- NO AWAITS IN THE TICKER HOT LOOP except the sleep to the next grid point. One
  `await` on a Redis round trip inside the loop and a slow network stretches
  every tick in the room.
- Only a CONFIRMED lease renew advances ownership, and ONE FUNCTION PER CLOCK IN
  `lease.ts`: `renewAttempted` moves `lastRenewAt`, `renewConfirmed` moves
  `lastOwnedAt`, `renewFailed` moves neither. Any function able to move both is a
  step back toward the collapsed timestamp the module exists to prevent. A caller
  that uses `renewDue` MUST call `renewAttempted`. THIS HAS REGRESSED TWICE.
  Collapse the two and a ticker whose renews are all failing keeps refreshing its
  own guard, so the pre-publish guard can never fire in the one condition it
  exists for; `renewFailed` returning the clock UNCHANGED is the fix and it looks
  like a no-op function, which is exactly why somebody keeps deleting it. The
  other half is the PACING clock: `renewConfirmed` re-anchoring `lastRenewAt`
  onto the confirmation time means that once RTT exceeds `leaseRenewMs` each
  resolution drags the pacing clock forward and nothing reaches Redis for up to
  `RTT + leaseRenewMs`. OVERLAPPING RENEWS ARE THE ACCEPTED PRICE and are safe,
  because the renew is an owner-checked compare-and-extend, `lastOwnedAt` is
  non-decreasing, and a `false` reply is a fact no later reply can take back.
- OWNERSHIP IS DATED FROM THE RENEW ATTEMPT, not from the reply, because Redis
  extended the key when it PROCESSED the command. The ACQUIRE path dates the
  same way: once an attempt has thrown, a recovery GET that finds our own owner
  already in the key dates ownership from the FIRST thrown attempt, never a
  later one, so it can only understate the lease's remaining life. The
  split-brain margin that buys is MEASURED by `tests/splitbrain.redis.test.ts`;
  changing this line, `mayPublish` or the `SET NX` invalidates a measurement
  rather than an argument.
- EVERY EXIT FROM THE TICK LOOP NAMES ITSELF, and a lost lease has TWO finders
  (the async renew's `lostLeaseExplicitly` and the synchronous pre-publish
  `mayPublish` guard) that must both set it. `exitReason` defaults to
  `'duration'`, the one exit that means everything is fine. A CONFIRMED LOSS IS
  CHECKED BEFORE THE PUBLISH BLOCK, not after: both finders land off the hot
  path (an async renew's refusal, a refused checkpoint write) between
  iterations or during the guard's own awaited renew, so checking them late let
  one more snapshot, depth frame and roster frame out into a room Redis had
  already handed to somebody else.
- A checkpoint carries a geometry digest and a mismatch starts fresh, and A
  CHECKPOINT WHOSE VERSION THIS BUILD DOES NOT IMPLEMENT STARTS FRESH in both
  directions, with the log line saying so. Without the digest a deploy that moves
  a wall leaves every live room restoring its predecessor's bytes, simulating the
  old world and re-saving it, with the TTL refreshed every second so it never
  expires: silent, permanent, invisible in every metric. A hand-rolled digest
  only covers the fields somebody remembered to mix in.
- Capacity is read from ONE key (`room:{id}:stats`) by both the relay and the
  balancer, NEVER from the meta hash. Stats has a 5s TTL so a room with no ticker
  reads as empty; meta persists. Read one on each side and a hard-dead ticker
  leaves meta phantom-full forever, the balancer keeps handing out a room the
  relay keeps rejecting, and the client's bounded re-assign loop strands every
  joiner on "full" with no path to self-heal.
- A COUNTER COUNTS WHAT HAPPENED, NOT WHAT WAS ATTEMPTED: `publishes`,
  `bytesPublished` and `bytesDelivered` move inside the publish promise's
  `.then`, never beside it.
- AN EMPTY METRIC WINDOW IS `null`, NEVER ZEROS. For a latency distribution zero
  is the BEST value, so a flattened empty window reports the healthiest possible
  reading for the sickest possible state. WHEN A GAUGE'S EMPTY VALUE IS ALSO ITS
  HEALTHIEST VALUE THE EMPTY CASE HAS TO BE A DIFFERENT TYPE, not a different
  number: `percentiles([])` returning zeros made "no samples at all" and "every
  sample instantaneous" identical, and paired with counters that counted
  ATTEMPTS a room whose every publish was rejected reported the healthy rate and
  the best `publishAwait` in the fleet.
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
  Otherwise the rate limiter is an amplifier: a log line on a client-rate path is
  a megaphone you hand the abuser, and the ticker had one, a warn per malformed
  input envelope on a path a socket drives at 20 to 60Hz through this library's
  own default decoder. AND A `room-reject` IS ONE OF THOSE PATHS, which is easy
  to miss because it looks like a reply: it goes out on the roster channel, so it
  fans out to every socket in the room, and it is answered off a join. A fan-out
  obeys the rule exactly as a log line does.
- ANYTHING KEYED BY PID IS DROPPED WHERE `presentPids` STOPS REPORTING IT, NOT
  ONLY WHERE A LEAVE ARRIVES. A runtime with a grace period never emits a leave
  for the player it eventually forgets. `reconcileMembership` is the single place
  membership changes; a map cleaned up on the leave path alone is a leak with a
  player's name on it. AND A PID THAT SENDS STAMPED INPUT WITHOUT EVER BECOMING A
  MEMBER IS THE SAME LEAK FROM THE OTHER DIRECTION: a refused pid, or one whose
  join never arrived, kept a playout buffer, a streak, a late baseline and a
  depth sample for the rest of the room's life, starving every tick for nothing.
  `dropStrangers` drops it after `presenceTimeoutMs` of being buffered but not
  present, the same grace as a leave, because a join can legitimately arrive
  after the input it precedes.
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
  at the moment of a throw is half-mutated by definition. It increments
  `room:{id}:crashes` BEFORE writing the timeline marker and releasing the
  lease, so a standby polling every 25ms cannot win the lease and read the
  counter before this crash is on it, and then lets the relay's poll pace the
  retry. The startup `playerCount` read lives inside the loop's own `try` now
  rather than setup's, so a throw there is counted as a crash too instead of
  escaping the guard. A
  CRASH LOOP IS THE CHECKPOINT'S FAULT, NOT THE SUCCESSOR'S, AND IT HAS NO
  CEILING OF ITS OWN: a deterministic throw that wrote a final checkpoint of the
  HALF-MUTATED state spawned a successor which restored those bytes and threw in
  the same place, with every metric reporting each successor as a healthy cold
  start. Both fixes are needed, the second being a counter that starts the room
  FRESH after three. Same trade as the geometry digest: lose the in-progress
  state once instead of forever.
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
  flag, which is a belief that lags reality by up to a renew period, so a ticker
  whose lease was taken while its last renew was in flight still believes it owns
  the room and would overwrite its successor's checkpoint. A refusal IS a lost
  lease and exits the loop.
- CHECKPOINT WRITES ARE SERIALISED THROUGH ONE CHAIN, AND THE FINAL ONE AWAITS
  IT, because `writeCheckpoint` compresses BEFORE it issues its `SET` and gzip
  time scales with the body, so two writes started in tick order otherwise reach
  Redis in gzip-completion order. The chain makes the order the ROOM's rather
  than the compressor's and costs nothing on the ordinary path. THE ENVELOPE IS
  SERIALISED WHEN THE CHAIN REACHES THE WRITE, NOT WHEN IT IS QUEUED, and a
  `crashed` flag set in the loop's catch BEFORE the error exit's first await
  turns every write not yet serialised into a no-op. Chain time always falls
  between two synchronous ticks, so the state is consistent unless a tick
  threw, and the flag covers exactly that. Serialising at queue time instead
  closed the crash too, but made a write held behind a 1s Redis spike carry the
  state of a second ago, which failed the split-brain duplicate-tick bound 4 of
  5 runs.
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
  would raise the floor of every successor for a whole state TTL. NOT DELETED
  when that final write was REFUSED, though: a refusal means no checkpoint of
  this invocation's landed and the room belongs to somebody else, and `DEL` is
  not owner-checked. A LOST LEASE OWES THE SAME FLOOR AS A THROW: an exit at
  `'lease-lost'` that ran at least one tick also writes the marker best effort,
  raced the same way the crash record is, because it too published past its
  last periodic checkpoint.
- THE INVOCATION'S LIFETIME IS MEASURED FROM INVOCATION ENTRY; ONLY OWNERSHIP IS
  DATED FROM THE ACQUIRE. `maxRunMs` exists to stay inside a cap the PLATFORM
  measures from the moment the request arrived, so a standby's poll comes out of
  the same budget rather than being free.
- `standbyMs` MUST EXCEED `standbyLeadMs` PLUS THE INCUMBENT'S OWN EXIT, AND MUST
  FIT INSIDE `maxRunMs`; `createTickerRoute` checks both on the resolved values
  at route creation rather than leaving them to be discovered live.
  `standbySpawned` is set on ISSUE and cleared on REJECT,
  because a spawn request to a ticker endpoint does not respond until the
  successor exits minutes later; a rejected standby does not suppress the exit
  spawn, and a STANDBY spawn answered inside `SPAWN_ACK_MS` is treated as a
  rejection for the same reason: the standby cannot have reached its poll yet.
- A TICKER NEVER SPAWNS ITS OWN STANDBY ON A PLATFORM THAT COUNTS HOPS. A
  function calling its own deployment is a chain, one hop deeper per call, and
  Vercel refuses it with a 508 at about the sixth hop; a ticker-issued standby
  added a hop per handoff, and a real deployment went cold on every fourth
  planned handoff, strictly periodic. On `standbyVia: 'relay'` the incumbent
  publishes `STANDBY_FRAME`, every relay races one `SET NX` on `keys.standby`,
  and only the winner spawns, as the second hop of a chain that starts at a
  browser. THE CLAIM IS THE RECEIPT: the incumbent skips its exit spawn only for
  a claim holding its OWN owner id, a refused relay spawn deletes the claim, and
  a frame nobody claimed leaves none, so neither can leave the room dark at the
  cap. The exit spawn stays the ticker's, at most the third hop.
- THE INPUT WINDOW IS PUSHED NEWEST FIRST, but only after the first consume,
  because before then the ahead bound has no consumer floor and the first push
  establishes the reference itself. Two regimes, cleanly separated. A `-1`
  MEANING "NOTHING YET" IS NOT A POSITION TO MEASURE A DISTANCE FROM: a buffer
  created fresh in a room older than `maxAhead` ticks refused EVERY push until
  some later consume anchored the floor, and it was only cheap because the client
  sends a redundancy window, so a host that sends each stamped input once loses
  the FIRST INPUT OF EVERY BUFFER. The bound gets its OWN reference (`aheadBase`);
  moving `lastConsumedTick` is the tempting one-line version and is worse than
  the bug, because a stamp is a producer's claim and that field is the consumer's
  position, so anchoring the FLOOR makes every slightly-older re-send in the same
  burst "late" and never-drop-late then dedupes all but one away.
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
  CONNECTING, with its 'close' event already fired and gone, and `terminate()` on
  a closed socket emits NOTHING. That asymmetry is why the liveness path runs
  `cleanup` ITSELF right after terminating rather than waiting for an event that
  may never come.
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
  SAME REASON: ONE PROBE PER SUBSCRIPTION, i.e. per room PER PROCESS since 1.1,
  shared the same way delivery is, rather than one global channel every room's
  probe answers on. A channel shared across rooms is quadratic in the fleet's
  size and, worse, lets a healthy subscriber answer for a dead one, which turns
  the one signal built to catch this into the thing hiding it; `sharedSubscriber:
  false` falls back to one probe per socket, the pre-1.1 shape, rather than to
  the wrong answer.
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
  under the frozen threshold is not drift: unprojected, the snapshots landing
  inside a hitch read as ticks behind, which is a spurious re-anchor, a resume
  frame stamping the stall's ticks on top, and the same path undoing it two
  seconds later. Every other use of `tick.value` is the raw counter. THE LESSON
  FOR ANY TEST OF THE RE-ANCHOR: drive the frames and the snapshots on ONE clock
  and put the gap in the frames only, because a re-anchor that fires on a frame
  gap is a decision about the render loop, not about the network.
- ONE INPUT STREAM PER CONNECTION. The ticker keeps one playout buffer per pid,
  so two windows from one socket overwrite each other's record for every tick. A
  player steering several things carries them in one input record, and a host
  building several entities by hand merges their windows into one send.
- A BACKWARD COUNTER JUMP REWINDS THE PREDICTION AND RELABELS NOTHING, because
  the ticks beyond `value - 1` have not happened on the server's timeline. A
  backward re-anchor of k is k ticks that have NOT HAPPENED YET: relabelling the
  pose history by the jump and leaving `curr` where it was makes the next stamp
  step from the pose after the OLD newest tick, and a playhead held to the
  history's END spreads the last tick of tail over the whole wait, a near pause of
  100 to 150ms on the one entity the player steers, on every tolerance
  correction. And a new epoch starts the entity over: no record, pose or offset
  crosses it, and its first reconcile is a counted snap.
- THE STARTUP GAP IS TICKS THE SERVER STEPPED, NOT TICKS THAT DID NOT HAPPEN.
  The epoch's first stamp is a whole lead past the snapshot that anchored the
  counter, and the server steps the ticks in between with the input it holds for
  the player, which no record covers. Skipping them is exact only while a step
  under that input does nothing; in a world that moves with the tick (a train the
  player rides) every snapshot below the first record reconciled out by one more
  tick of its travel. The input is the HOST's to know, so it is
  `predict.idleInput` rather than a default, and with it the first stamp and the
  replay step the gap. A reconnect where the server still holds the old socket's
  input stays inexact by design, bounded by the lead.
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
  `forget` IS THE TRAP ON THE WAY TO LEARNING THAT: it drops `lastSeenAt` and the
  motion state and leaves the FRAMES, so the key re-seeds one snapshot later
  INSIDE the same bracket and streaks anyway, in pieces, which is worse than
  doing nothing. The consumer workaround was `ceil(delayMs / tickMs) + 1`
  CONSECUTIVE forgets, one per rendered frame, which is the buffer depth
  expressed as a call count. AND `teleport`'S CALL ORDER IS A CONTRACT, NOT A
  PREFERENCE, because it reads the destination out of the buffer: called before
  the frame carrying the destination is pushed it finds the pose the entity had
  BEFORE the jump.
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
  type does not name is simply never passed on, with no error anywhere: TWENTY
  options were once unreachable from the very route factories the README tells
  people to use.
- A DERIVED LIFETIME NEEDS A FLOOR AS WELL AS A CEILING, AND THE FLOOR IS CHECKED
  ON THE RESOLVED VALUE. Each derivation is a subtraction, so a small enough
  `maxDurationS` produces a NEGATIVE lifetime rather than a short one, and an
  explicit negative `maxRunMs` passed the old fit check by arithmetic. Checked at
  route creation, which is module evaluation. AND THE LIFETIMES ARE TIED TO THE
  PLATFORM'S CAP RATHER THAN AGREEING WITH IT BY LUCK:
  `tickerRouteConfig.maxDuration` was 800 against a `MAX_TICKER_MS` of 700s, two
  files, and a host on a lower plan limit got a platform kill every cycle with no
  final checkpoint, no lease release and no successor spawn, with nothing
  reporting it.
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
