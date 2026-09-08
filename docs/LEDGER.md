# tickroom: the ledger

THE HISTORY COMPANION TO [`AGENTS.md`](../AGENTS.md). Everything here is dated: the release
attempts, the mutation matrices, the audit rounds finding by finding, the
platform measurements, and the owed items as they closed. Nothing here is an
operating rule. [`AGENTS.md`](../AGENTS.md) carries the rules; where one of them was first
stated inside a dated paragraph below, it is restated there without the date and
the story stays here.

Read it when you need to know WHY a number is what it is, whether a guard is
pinned by a test that can actually fail, or what a measurement was taken on.
Read [`AGENTS.md`](../AGENTS.md) when you need to know what to do. Prose in the
moved sections still says "above" and "below" about neighbours it had in that
file; where a reference points at a rule rather than at a measurement, the rule
is in `AGENTS.md`.

A count in a mutation table is a statement about the tree it was measured on and
rots even when the behaviour does not, so re-measure a table when you touch the
file it covers rather than trusting the number forward.

- [The release chronicle](#the-release-chronicle)
- [Verified by mutation, not just observed green](#verified-by-mutation-not-just-observed-green)
- [The 2026-09-02 audit's own matrix, one table per file](#the-2026-09-02-audits-own-matrix-one-table-per-file)
- [Defects found and fixed, in the order they were found](#defects-found-and-fixed-during-integration-worth-not-reintroducing)
- [Verified against a real Redis and a real socket](#verified-against-a-real-redis-and-a-real-socket)
- [The buffer-health seam, built end to end and optional](#the-buffer-health-seam-built-end-to-end-and-optional)
- [What the owed list closed, in the order it closed](#what-the-owed-list-closed-in-the-order-it-closed)

## The release chronicle

THE WORKFLOW FAILED AT THE PUBLISH TWICE BEFORE IT EVER PUBLISHED. v0.2.0 on
2026-09-05 took a 404 from npm. v0.3.0 on 2026-09-07 failed with `ENEEDAUTH`,
which is what `npm publish` says when the CLI never attempted the OIDC exchange
at all: the npmjs.com trusted-publisher entry did not exist. It was added on
2026-09-07 (Package tickroom, Settings, Trusted Publisher: `Isaac-Harper/tickroom`,
workflow `release.yml`, permissions npm publish and npm stage publish).

THE SAME TAG'S RE-RUNS SHOWED THE OTHER WAY THE WORKFLOW FAILS, and it is the
reason the suite is tiered. The gate included wall-clock measurements, and the
shared runner fired a timer late enough to miss two different bounds on two
consecutive re-runs of a commit that was green locally both times
(`example-cursors.redis.test.ts`, two 400ms probes coalesced into one tick;
`splitbrain.redis.test.ts`, 780ms against a 740ms theft bound). Both were fixed
at the source, and the gate no longer runs either file: the release gates on
`test:integration` and both are in the `measure` tier. `vitest.config.ts` still
retries once when `CI` is set, as the second line.

Both 0.2.0 and 0.3.0 were published from a laptop session (`npm publish --access
public` against the tagged tree, no OTP prompt) and carry no provenance. v0.3.1
WAS THE WORKFLOW'S FIRST OWN PUBLISH, on 2026-09-07: the suite passed on the
runner first time, npm accepted the OIDC exchange, and the package carries a
signed provenance statement (transparency log index 2753833818). The release
path is proven from there; `npm version` plus a pushed tag is the whole
procedure.

## Verified by mutation, not just observed green

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

## The 2026-09-02 audit's own matrix, one table per file

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

## Defects found and fixed, in the order they were found

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

## Verified against a real Redis and a real socket

`tests/` runs against a REAL Redis (thirteen files, 64 cases), not the fake.
A fourteenth file, `tests/memory.test.ts`, sits in the same directory and needs
nothing at all, which is the whole claim it exists to check, so `vitest run
tests` collects 65 cases and only 64 of them can skip. Start one with
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

## The buffer-health seam, built end to end and optional

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

WHAT WAS BUILT ON 2026-09-02, AND WHAT REPLACED IT ON 2026-09-07. The rebuild
routed the depth through the HOST: `RoomRuntime.onBufferHealth` into state,
`encodeSnapshot` onto the host's wire, `decodeSnapshot` picking its own pid's
value back out as `DecodedSnapshotLike.inputLead`, and `RoomConnection` reading
that. Four steps and no new wire frame, and every step optional. The trouble
was the optionality: three of the four steps were the host's, the one most
often missed (the `decodeSnapshot` pick) left the lead open-loop with nothing
anywhere saying so, and the README's routing paragraph was the most commonly
skipped paragraph in it. So the number travels on the library's own frames now:

1. `src/server/ticker.ts` still calls `RoomRuntime.onBufferHealth(state, pid,
   depth)` on every tick it maintains a buffer for that player, on the STARVED
   path as well as the consumed one, and once with 0 on the tick a buffer is
   dropped. That hook is for a host that wants the number in its own state (a
   HUD); nothing below depends on it.
2. The same reading is summed per pid, and once per `DEPTH_INTERVAL_MS` (1000)
   the owning ticker publishes `{ t: 'depth', d: { [pid]: mean } }` on the
   roster channel: every buffered pid, the interval's mean, absent when there
   is no buffer, suppressed when nothing is buffered at all.
3. Each RELAY consumes the frame and forwards ONLY its own pid's value to its
   one socket as `{ t: 'input-lead', lead }`, on an open socket, never queued.
4. `RoomConnection` consumes `input-lead` in `handleTextFrame` beside `pong`
   and `relay-expiring` (it never reaches `onText`) and feeds it to the same
   `observeInputLead`: an EMA (`DEPTH_EMA_ALPHA` 0.2) against
   `TARGET_DEPTH_TICKS` (2), corrected by at most two ticks and at most once
   per `REANCHOR_MIN_INTERVAL_MS`, and only when the depth is at least two
   ticks off target. The correction lands as `feedbackTicks` inside
   `desiredTick()`, so it arrives as one ordinary re-anchor with an
   `onTickReanchor` delta rather than as a silent drift.

THE THREE ORDERINGS, STATED. A relay that joined before the first depth frame
(every relay, on a fresh room, for up to one interval) leaves its client
open-loop until the frame arrives, which is what every connection did on every
host before this. A warm relay swap carries nothing: the replacement socket
forwards the next frame. The ticker's own successor starts its samples empty,
like its buffers, so the depth restarts from its first consume exactly as
`onBufferHealth` restarts.

THE CLIENT TICK STILL DOES NOT DILATE, AND THAT IS THE DESIGN CHANGE. The old
seam steered the RATE the counter advanced at, which is a control loop over
every rendered frame; this one steers the LEAD the counter is anchored with,
which is a coarse correction a couple of times a minute against a quantity the
server actually measured. The open loop (`rttMs + inputLeadMs`) is a good guess
made entirely from this side of the wire; closing it converges the lead on the
smallest one that keeps the buffer fed, which is the smallest input latency that
player can have. It is measured end to end in `tests/depth.redis.test.ts`: a
client at ten ticks of headroom comes down to two over four corrections with a
runtime that implements no `onBufferHealth` and a snapshot with no depth on it.


## What the owed list closed, in the order it closed

READ THIS AS HISTORY. Every item below was owed before 1.0 and is closed; the
struck heading is the item as it was written, and the paragraph under it is what
actually paid for it. [`AGENTS.md`](../AGENTS.md)'s "Still owed" list is what is genuinely left.

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
  bullet: nothing. ~~The 0.2.0 tag itself~~ LANDED on 2026-09-05: `tickroom@0.2.0`
  is on the registry, published from a laptop session after the workflow's first
  publish attempt was refused (see the top of this file), so it carries no
  provenance; the workflow's own publish is unproven until the next tag.

- ~~No shipped example stamps `targetTick`~~ LANDED. `examples/pong` is the
  stamped reference: one record per advanced tick, a six-record redundancy
  window, a locally predicted paddle reconciled by replaying that window through
  an `ErrorOffset`, and the `onBufferHealth` depth loop closed end to end.
  `examples/cursors` stays unstamped as a deliberate documented contrast, and
  its comments point at pong rather than sketching the shape hypothetically.
- ~~The buffer-health seam~~ LANDED, in a different shape from the one this file
  used to specify: the depth reaches the client on the library's own frames
  (the ticker's `depth`, the relay's `input-lead`) and steers the stamping
  LEAD rather than dilating the tick RATE. It went through the host's snapshot
  first (`onBufferHealth` to `inputLead`) and that route is gone. See the
  section above it. Still owed: the two-tick
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
- ~~No CI.~~ LANDED: `.github/workflows/ci.yml`, two jobs. `unit` runs
  typecheck, `npm run test:unit` and build with NO services anywhere, which is
  the no-services promise proved rather than assumed.
  `integration` runs `npm run test:integration` against a `redis:8` service
  container on host port 6399, the same port the local instructions use. A third
  workflow, `nightly.yml`, runs `npm run test:measure` on a schedule and blocks
  nothing; the tier table in Status says which file is which. There is
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
