# Architecture

Why every load-bearing decision in tickroom is what it is, and what breaks when it gets simplified.

Everything here was learned in production, most of it the expensive way. If you are about to change something in this library and it looks gratuitously complicated, the odds are good that it is documented below as the fix for a specific failure.

---

## 1. Why two functions

A serverless function can hold a WebSocket open, and a serverless function can run a loop. It cannot usefully do both for a shared room, for a reason that is structural rather than a platform limitation:

- The socket's lifetime belongs to **one client**. It ends when that client leaves.
- The authority's lifetime belongs to **the room**. It has to outlive any individual client.

Fusing them means the room's authority dies whenever one particular player closes their tab, and that twenty functions each holding one socket have no way to agree on who picked up the coin. So: **relay functions are per-socket and dumb, the ticker function is per-room and authoritative**, and Redis pub/sub is the bus between them.

This split has a happy consequence that is easy to miss. When the platform kills the ticker at its duration cap, **nobody disconnects**. The relays are a separate lifetime and keep holding their sockets, so from the client's side a ticker handoff is a sub-second gap in the snapshot stream rather than a dropped connection, a reconnect, a re-mint, or a re-anchor.

**What the interpolation delay covers, stated by the arithmetic rather than by hope.** The delay adapts within 80 to 500ms and extrapolation continues for a further 150ms past the newest snapshot, so a client keeps rendering plausible motion across at most **650ms** of silence, and far less than that whenever the network has been calm enough for the adaptive delay to sit near its floor, which is the ordinary case. A handoff is documented elsewhere in this repo as typically 0.5 to 1.2 seconds (see `STALL_MS` in `netPolicy.ts`). So the honest claim is narrower than "absorbed entirely": a handoff at the fast end of that range is genuinely invisible, and a slow one is covered for its first 650ms and then holds remote entities at their last extrapolated pose until the stream resumes, at which point they resume from where they are rather than teleporting.

The ceiling is 500 rather than 250 because a stall LONGER than the ceiling cannot be covered by definition, so it snaps every time it recurs rather than once: the delay saturates and stops growing however many times the stall repeats. Measured on a repeating 450ms stall, a 250ms ceiling gave 26 frames above 300 units/second with a peak of 675 on an entity whose true speed was 100, while a 500ms ceiling absorbed the same profile completely (0 frames, peak 100.0). The ceiling is not a cost paid by everyone: the delay is measured from real jitter, so a clean connection settles near the 80ms floor and never approaches it. Going further, to the second or so that would cover a slow handoff outright, is deliberately NOT done: that is remote-entity lag charged to every player on a bad connection to hide an event that happens once per ticker lifetime.

What the design does guarantee across a handoff of any length is that nothing structural happens: the socket stays open, the client's own prediction keeps running, the stall banner does not fire below `STALL_MS` (4s), and the successor continues the tick count rather than resetting it.

### Why Redis pub/sub specifically

The requirement is: deliver a message to N subscribers, at 20Hz, cheaply, from a process that may be replaced at any moment.

- **Pub/sub fan-out costs one command.** Measured: 5 subscribers, 1000 deliveries, still ~1 command per publish. Command count does not grow with room population.
- **It is lossy, and that is correct here.** A snapshot is a full state, not a delta, so a dropped one is superseded 50ms later. Durable queues offer at-least-once delivery, which is the wrong guarantee at the wrong price for a stream whose whole point is that the newest message obsoletes every older one.
- **A REST-style Redis API cannot subscribe.** The bus needs a real TCP connection. This rules out several managed "Redis-compatible" HTTP products for this specific job, though they remain fine for ordinary key reads.

Delivery-billed realtime services were priced and rejected: they charge per message per recipient, which is precisely the axis this design makes free.

---

## 2. The lease, and the two-clock rule

Exactly one ticker may be authoritative for a room. The mechanism is a short-TTL Redis key:

- **Acquire:** `SET key owner PX 5000 NX`. Atomic, so a race resolves to one winner and the loser returns immediately without publishing a frame.
- **Renew:** a Lua script that refreshes **only if the value still equals our owner id**. Returns false the moment ownership is lost.
- **Release:** the same owner-checked pattern for delete, so a slow ticker cannot delete a successor's lease on the way out.

### The part that regressed twice

A ticker holds two timestamps, and keeping them separate is the entire safety property:

```ts
interface OwnershipClock {
  lastRenewAt: number;  // when a renew was last ATTEMPTED
  lastOwnedAt: number;  // when ownership was last CONFIRMED
}
```

Only a **confirmed** renew advances `lastOwnedAt`. An attempt moves `lastRenewAt` and nothing else. A renew that errors or hangs deliberately leaves `lastOwnedAt` exactly where it was.

Collapse these into one timestamp and the following happens. Renews start failing (a Redis fault, a latency excursion). The single clock is refreshed at every *attempt*, so the pre-publish guard never fires. The lease silently expires. A successor legitimately acquires it and starts publishing. **The original ticker keeps publishing too**, because as far as its own clock is concerned it is fine.

Now two divergent simulations interleave snapshots on one channel at 20Hz, and both write the same checkpoint. Clients see the world stutter between two realities. This is the worst failure mode the system has, and one collapsed timestamp is all it takes.

### The synchronous guard

Before every publish:

```ts
if (!mayPublish(clock, Date.now())) {
  owns = await renewLease(redis, key, owner);   // the ONE await outside the sleep
  if (!owns) break;
}
```

Two situations reach it. (a) The loop stalled past the TTL, typically a GC pause, so the async renew never ran. (b) Renews have been firing but failing, so the lease expired under us. In normal operation ownership is confirmed every renew interval, well inside the TTL, and this never runs at all.

### Exit and handoff

```
ticker exits ──► final checkpoint (only if still owns)
             ──► release lease   (only if still owns)
             ──► finally: spawn successor if players remain
```

Four things about that successor spawn, each of which was measured:

1. **It is in `finally`, not at the end of `try`.** A thrown ticker is exactly the moment a room would otherwise sit dead.
2. **It is not gated on still owning the lease.** A lost lease is precisely the case where nobody else has been told to start. Firing blind is safe: a successor that already holds the lease fails its acquire and returns immediately.
3. **It is awaited, but raced against a 2s timer.** Fire-and-forget was wrong: as the last thing the handler does, the request is post-response background IO the platform can suspend before flushing, and the spawn intermittently never left, blowing the handoff budget about 10% of the time. A bounded wait is required because the successor does not *respond* until it exits minutes later.
4. **It is not `AbortSignal.timeout`.** Aborting could propagate as a cancellation and tear down the very ticker just started, which is far worse than the bug being fixed. Race a timer and leave the request alive.

The relay's jittered lease poll remains as the backstop for *unplanned* death (a crash, an instance kill) where none of this code runs at all.

---

## 3. Checkpoints

The ticker serialises the whole room every second to `room:{id}:state`.

**Gzipped.** It is the only large value written at a cadence, forever, per populated room, and it is repetitive structured data. Measured 3.9x to 7.0x on real payloads. Bandwidth is what a flat-rate Redis plan actually bills, so this is not micro-optimisation, it is the difference between a design being affordable and not.

**Encoded async, decoded sync.** The periodic write happens inside the tick loop, which may not block, so `zlib.gzip` runs on the threadpool and becomes the head of the fire-and-forget chain the write already was. Decode is synchronous because both read paths are already outside the hot loop.

**Compression failure falls back to plain JSON.** A checkpoint that was not written at all costs a room its entire state at the next handoff, which is far worse than a large write.

**Reads sniff the gzip magic bytes.** Not a stored flag, not try-JSON-and-catch. That is what makes a rolling deploy safe in both directions: while old and new instances coexist, a new reader transparently handles the plain JSON an old writer is still producing, with no migration step and no window where a room's state is unreadable to the instance that owns it.

**The read must be `getBuffer`, never `get`.** A utf8 decode of gzip bytes is lossy and destroys the payload before anything can sniff it.

**Decode throws on corruption, deliberately.** Every caller already wraps the read in a catch that treats an unreadable checkpoint as no checkpoint (start fresh). A throw therefore reaches the existing correct path rather than inventing a second one.

**The TTL rides the same SET.** So it costs no extra command, a room with players can never expire (the write refreshes it every second), and a room nobody has touched in an hour is reaped and recreates from scratch on next join.

### The geometry digest, which is the subtlest thing here

A checkpoint carries **opaque state**. The ticker cannot tell whether that state describes the world the current deployment defines.

Without a guard, a deploy that moves a wall produces this: every live room restores its predecessor's bytes, keeps simulating the *old* world, and re-saves it. Each successor faithfully repeats this. The key's TTL is refreshed every second, so it never expires. **The room simulates a world that no longer exists, forever.** Players walk through new buildings and stop at removed ones. It is silent, permanent, and invisible in every metric.

The fix is one field. Stamp a digest of the world geometry and rules into the checkpoint; on restore, compare it; on mismatch, discard and start fresh. A geometry-changing deploy costs every room its in-progress state once, which is the correct price and is why such deploys belong outside peak hours.

The trap is that a hand-rolled digest only covers the fields somebody remembered to mix in. If you add a field to your world definition, add it to the digest, or the digest is quietly lying.

### The envelope version, which is the same failure through a different door

The envelope carries a version, and a checkpoint whose version is not the one this build implements is refused and the room starts fresh. The direction people expect to matter is the newer one. The dangerous one is the **older**, because it *parses*: every field is present and every type is right, so a body written by the previous version is restored in full and simulated happily even though the current build changed what one of those fields means. Same properties as the geometry mismatch, and the same fix. The comparison is `!== CHECKPOINT_VERSION` rather than `>`, and it runs **before** the field-type checks, so a version that dropped a field reads as the version change it is instead of as corruption. `inspectCheckpoint` returns *why* it refused (`absent`, `unparseable`, `malformed`, `version`) so the ticker can log it; an absent checkpoint is silent, because an ordinary cold room is not a refusal.

---

## 4. The tick timeline

The naive scheme is "apply each input when it arrives". It produces two problems that look like netcode being hard and are actually just this:

- The same input lands on a **different tick for every client**, because every client has a different latency.
- It lands on a **different tick on replay** than it did live, so client-side prediction can never agree with the server.

### Stamped inputs and the playout buffer

A client stamps each input with the tick it should apply on. The server buffers it and applies it on **exactly that tick**. Now the server and the client's own prediction run the identical input on the identical tick, and prediction error collapses to approximately zero in clean conditions.

`PlayoutBuffer<T>` is the data structure:

- **Push is out-of-order safe and duplicate-overwriting.** Packets may arrive in any order.
- **Consume is exact-tick.** Either the input for this tick is there, or the buffer starves.
- **Never-drop-late.** An input arriving for an already-consumed tick is *re-stamped forward* to the next consumable tick rather than dropped, unless a fresher entry already holds that slot (entries carry their original tick so a stale straggler cannot clobber a newer input). A late input applies a tick or two behind its intent, which is far better than vanishing.
- **Bounded ahead.** Past 40 ticks (2s at 20Hz) the oldest entries are evicted, so a producer that ran away cannot grow memory.

### The starvation backstop

When the buffer starves, the obvious answer is repeat-last. That is right for **one** tick and wrong for a run of them.

Picture a player who turns and then straightens. Their packets drop. The server holds the stale *turn* input while the client drives straight. Divergence accumulates until the client's render correction adopts it, snapping the entity sideways. Then it happens again. This is the **directional sawtooth**, and it reads as the game shoving you.

So: repeat once, then from the second consecutive starve decay the held analogue value toward neutral by half each tick, snapping to zero near it. A starved buffer straightens out within about four ticks instead of holding a stale command indefinitely.

This is transport policy, not simulation. It lives outside the pure sim step, and the client deliberately does **not** mirror it (its rollback replays its own stored inputs), so a decay is a genuine divergence that the render error offset absorbs. Input redundancy makes it rare enough for that to be the right trade.

### Input redundancy: the cheapest win here

Every packet carries the **last few inputs**, not just the newest. Because push is duplicate-overwriting and out-of-order safe, the re-sends cost nothing but bytes, and a single lost or late packet can no longer starve the buffer, because the next packet carries the same tick again.

Packet loss stops being a visible correction and becomes nothing at all, for a handful of bytes per packet. Do this before reaching for anything more sophisticated.

### The monotonic client tick

The client keeps its own tick counter. It is anchored **once per connection epoch** to the server's estimated tick plus a small margin, and thereafter advances by whole steps and never jumps.

**This section used to describe a step-interval dilation, within ±5%, driven by the server reporting how deep its playout buffer was running. That control loop has been DELETED, and the honest reason is worth recording rather than quietly dropping.** The method a host would have called to feed it had no producer anywhere in the library: nothing in the ticker or the relay ever published the buffer margin, so nothing could drive it and the dilation term was permanently 1.0. Five exported constants tuned a loop that never ran. Shipping a control loop with no input is worse than shipping neither, because the constants read as a considered design and the getter reads as a working signal.

Wiring it properly means the ticker publishing playout margin, the relay forwarding it, and the client routing it in, which is a real feature across three layers rather than a client-side tidy-up. The one tempting shortcut, driving the loop from the client's own RTT estimate, is ruled out by this library's own note that the estimate is a biased proxy rather than a true round trip: a feedback loop on a biased input is worse than no loop. Until that seam is built end to end, the counter simply advances at wall-clock rate and re-anchors on drift, which is what the next paragraph describes and what the code actually does.

**Re-anchoring is directional, and only on drift.** A ticker handoff does not close the socket, so the reconnect path never fires, but the server's tick counter *pauses* for the whole interval no ticker owns the room while the client's keeps advancing at wall-clock rate. Past half the playout window the client re-anchors. Only on the ahead side: running *behind* is a latency spike, already handled without a jump by never-drop-late re-stamping, so re-anchoring there would trade a harmless late input for a visible correction.

---

## 5. Rendering other people

Remote entities are rendered **behind a deliberate delay**. This is the trade that buys smoothness and it is not optional.

**Playback runs on the SERVER's clock, not on the local arrival clock.** This is the one that decides whether any of the rest works. The server emits snapshots on a uniform grid; the network smears their arrival times, bunching several into a few milliseconds after a head-of-line stall clears and stretching the gap between others. Time playback against arrival stamps and that smear is replayed *as motion*: measured on an entity moving at a constant 100 u/s, arrival-clock playback rendered a peak of 1568 u/s, a standard deviation of 144, and 9 visible backward rewinds, where server-clock playback of the identical frames rendered 261, 20.7 and zero. The local arrival stamp is still required, for exactly one job: the minimum of `receivedAt - serverTime` over a sliding window is the least-contaminated estimate of the offset between the two clocks, and that offset is what turns a local `now` into a position on the server's timeline. It is eased toward that floor at no more than 5% of wall time, because the offset is subtracted from the playhead, so moving it IS moving playback in time, and moving it faster than a few percent of wall time is perceptible as remote entities briefly running fast or slow.

**A slow estimate needs an escape hatch.** A sliding minimum eased under a slew cap is right for noise and wrong for a *step*: a route change, a network switch, or a handoff onto a machine with its own clock skew moves the true offset in one jump, and easing toward a floor the window has not turned over yet strands the playhead off the buffer for the whole turnover. Measured: a permanent +1000ms one-way latency step cost 22.5 seconds of continuous extrapolation, rendering a 20Hz stop-go staircase. So a playhead that stays somewhere no buffered frame brackets for longer than `REANCHOR_AFTER_MS` (600ms) re-anchors the offset outright, **and only if enough frames are still arriving** (`REANCHOR_MIN_SAMPLES`, 5). That gate is the whole safety of it: an outage parks the playhead in exactly the same place and looks identical from inside the client, but there is no new data to anchor to, so extrapolate-then-hold remains correct there. The count matters as well as the fact: the re-anchor adopts the minimum of the samples that landed during the error window with no slew, so anchoring on a single straggler adopts that one packet's raw offset, which measured as a 600ms offset error held for twelve seconds. One visible correction in exchange for tens of seconds of degradation is the same trade `shouldReanchor` and `ErrorOffset.reset()` already make.

**Adaptive delay, 80 to 500ms**, sized to measured snapshot jitter and eased toward its target rather than snapped. A network that is behaving gets a tight delay; one that is not gets a looser one, automatically. The quantity it is sized from is how far each packet's one-way delay sat *above* that offset floor, which is what a jitter buffer actually has to cover. Sizing it from inter-arrival gaps instead is worse than merely imprecise: a delivery burst is a run of near-zero gaps, so it pulls the delay DOWN at exactly the moment more buffer is needed.

**On underrun, extrapolate. Never freeze.** Up to 150ms of velocity extrapolation. This is the rule most likely to be removed by someone who has not watched the alternative: a frozen entity that then teleports to catch up reads far worse than one that drifts slightly and is corrected. Freezing is never the right answer.

**Interpolate heading along the shortest arc.** Linear interpolation across the ±π wrap spins an entity the long way round, which looks like a bug because it is one.

**Derive animation from measured speed, not from a wire field.** A coarse enum on the wire can say "walking" or "running" and cannot describe an entity mid-acceleration. The client already knows the entity's real speed because it computed the interpolated motion; low-pass that and drive the animation from it. Better fidelity, zero wire cost.

### Corrections must never move the simulated pose

When the client's prediction diverges past a deadband, the simulation adopts the corrected state **in full and immediately**, because it is the truth. The equal-and-opposite delta is pushed into a render-layer `ErrorOffset`, so the **rendered** pose (simulated + offset) stays continuous through the jump. The offset then decays to zero at a capped per-frame velocity.

Net effect: the simulation is always on truth, and the player never sees a snap. A multi-second network dropout reconciles as a smooth glide over a second or two. The per-frame cap is what makes it a glide rather than a lurch, and it is why the cap belongs on the *step* rather than on the offset.

---

## 6. Capacity, admission, and one source of truth

`room:{id}:stats` is written by the live ticker with a **5-second TTL**. That short TTL is doing real work: a room with no ticker reads as empty, so a dead room is automatically reusable.

**Both the relay's admission check and the balancer read that same key.** This is load-bearing.

If the relay read the persistent metadata hash instead, a ticker that died hard while players were present would leave that hash phantom-full forever. The balancer, reading stats, would see the room as empty and keep sending joiners to it. The relay, reading meta, would keep rejecting them. The client's bounded re-assign loop would exhaust itself and strand every joiner on "full", **with no path to self-heal**. The room is bricked for new players and nothing in the system can notice.

One key for capacity. The metadata hash is consulted only to recognise a *rejoin*, which it can still do correctly while stale.

Admission fails **open** on a read error: a monitoring failure must never become an outage. What it must not do is fail open *quietly*. A Redis fault disables the per-user socket cap in exactly the conditions the cap is load-bearing, so `checkAdmission` reads the pipeline's per-command errors and reports `socketCapEvaluated: false` rather than letting a degraded read look like a passing check. Both adapters and the node example log a warning on it.

There is a boundary race (two joiners can both see the last slot), so the ticker enforces the cap authoritatively and publishes a targeted `room-reject` for the loser, who re-assigns to another instance and reconnects. The relay pre-check is the fast, friendly path, not the guarantee.

### Multi-room

A base room id holds up to 50 instances: `lobby` is instance 0, `lobby~1` and up are the rest. Instance 0 keeping the bare name is deliberate, so adding multi-room to a live deployment migrates no existing Redis state.

The balancer packs into the **lowest-index room with space**, so rooms fill in order and empty ones drain rather than leaving players scattered one per room.

`normalizeRoomId` is a **trust boundary**: the raw value comes from a query parameter, and it is interpolated into Redis key names, which have no escaping. Anything that does not validate falls back to a known-good id. Note in particular that a bare `raw in WORLDS` check on an object literal matches **inherited** properties, so `constructor`, `__proto__` and `toString` all pass. Use `hasOwnProperty`.

---

## 7. Backpressure and abuse

Three bounds, at three layers, each catching something the others cannot.

**Per-socket token bucket** (capacity 40, refill 25/s against a 20Hz sender). Burst tolerance with a sustained cap. Excess frames are dropped silently, exactly as a lossy network drops them, which the input redundancy window is already designed to survive.

**Per-sender inbox quota.** A global inbox cap alone is a shared resource one sender can monopolise: a single flooder fills the queue and *everyone else's* inputs are shed at the door, degrading the room for all twenty rather than just the abuser. The per-sender quota sheds the flooder's own newest, keeping the cost where it belongs. `20 × perSenderCap` stays well under the global cap so the per-sender bound binds first in the single-abuser case, which is the point.

**Per-user socket cap.** The token bucket is per *socket*, so without this one client simply opens more sockets to multiply its allowance. Worse: **every socket holds its own Redis subscriber connection**, and managed Redis caps concurrent connections per database. Enough sockets from one client exhausts that ceiling and takes the **room ticker's** subscriber down with it. That is a total outage, not a nuisance, and it is the real reason this cap exists.

**Refusals must be cheap.** Anything whose rate a client controls is *counted in process* and flushed on a cadence the client cannot drive, never written to Redis on the request that triggered it. Otherwise a rejected request costs more than an accepted one and the rate limiter becomes an amplifier. The same rule applies to logging: a per-message log line on a client-controlled path hands an abuser a log-volume attack.

---

## 8. Socket liveness

A half-open socket (network dropped, laptop slept, tab died without a close frame) is **indistinguishable from a quiet one** at the server: nothing arrives, and nothing errors. Left alone, the relay keeps publishing that player's join into the room and holding resources until the function's duration cap.

- **Any inbound frame is proof of life**, including one the rate limiter is about to drop (it still proves the peer is there) and including a protocol pong.
- **A ping rides the existing presence timer**, so liveness costs no extra timer and no extra Redis command.
- **Past the deadline, `terminate()`, not `close()`.** A peer that is already gone never answers the closing handshake, so a graceful close keeps everything running until the ws close timeout expires. `terminate` emits `close` immediately and runs the normal cleanup.
- **A missing pong alone never closes anything.** Only total inbound silence does. If a platform proxy stopped forwarding ping frames, this degrades to plain inbound recency rather than reaping healthy sockets.

The pong path is what covers a **backgrounded tab**, whose timers the browser throttles and whose animation frames stop entirely. Pongs are answered by the browser's network stack, below page JavaScript.

---

## 9. Two publishes and two roster seeds

The join sequence looks redundant. Both halves are load-bearing and answer different problems.

**The immediate publish, unconditional, at socket open.** Until the join envelope reaches the ticker, a reconnecting player can be **frozen server-side**: their inputs are accepted and stored while their entity does not move, and their client happily predicts forward the whole time. Gating this on the subscribe acknowledgement puts a fresh subscriber's TCP, TLS, AUTH and SUBSCRIBE in front of it, measured at over a second of freeze in an otherwise healthy reconnect.

**The publish gated on the subscribe ack.** The ticker announces a roster change **exactly once** (it only re-dirties its map when a join actually *changes* it, so later heartbeats announce nothing), and pub/sub drops a message with no subscriber. A socket whose subscription lands after its own announcement therefore misses itself **permanently**: the player is invisible in their own roster for the whole session.

**The roster is seeded twice** for the same reason, and the second seed is what makes it airtight, by ordering rather than by hoping:

> Redis is single-threaded, and the ticker does `HSET` on the meta hash **before** it `PUBLISH`es, on one connection. So a hash read issued strictly *after* our `SUBSCRIBE` was acknowledged cannot miss an announcement published before it. Either we receive the publish, or the `HSET` preceded it and our later read sees it. There is no third case.

Relatedly: the ticker's dirty flag **starts true**. A predecessor that died between its hash write and its metaout publish strands that announcement forever otherwise, because every later heartbeat matches the restored map and never re-dirties it.

---

## 10. Telling the player the world is gone

A room whose ticker hangs is worse than one that crashes, because a crash self-heals (the relay's poll spawns a successor) and a hang does not: the hung ticker still holds its lease, so nobody may replace it. Meanwhile every client's socket stays `OPEN` and the world simply stops. Measured in production: 17+ seconds of a frozen world with the socket healthy and nothing on screen.

`stallDecision` closes it with one predicate covering all three ways it happens:

- an established stream that stops (a hung or dead ticker),
- a joiner landing in a room that is **already** hung, which is every new joiner once a room hangs,
- a reconnect loop that never resumes.

Silence is measured from **the last evidence the world is alive**: the newest snapshot, or, before any has ever arrived, the moment this client first tried to connect. That single origin is what makes one predicate cover all three.

**Two thresholds, chosen by whether the current connection has delivered anything.** 4000ms for a live stream that stopped, which sits above the handoff budget so a routine healthy handoff never raises the banner. 8000ms otherwise, because a cold join legitimately takes seconds (a relay cold start, a ticker spawn, simulation init).

**Hysteresis matters.** Once stalled, the tight limit applies regardless, so only a real snapshot clears the state. Without it, a hung room whose socket then dropped would flick the message off as the window widened and back on moments later.

**Socket readiness is deliberately not in the predicate.** A closed socket in backoff is exactly as silent to the player as an open one behind a hung ticker, and hiding the message the moment the socket dropped removes it precisely when things got worse. That makes the terminal latches (capacity, rate limit, version skew, deliberate close) load-bearing rather than belt-and-braces: they are now the only thing keeping this off a state that already owns the screen.

The message is **non-blocking**. The state usually self-heals, so the player keeps control of a live world while it does.

---

## 11. Wire format

Snapshots are published at 20Hz and delivered once per player. Bytes here are the bill.

- **Binary, not JSON.** Typically 5 to 20x smaller for the same content.
- **Quantise.** Positions to centimetre-precision `i16` (a ±327m range), angles to `u16` turns. Pick the smallest field that covers your world plus headroom.
- **Clamp, never wrap.** An out-of-range value that *wraps* teleports an entity to the opposite side of the world, which reads as a catastrophic desync. The same value *clamped* pins it at the boundary, which reads as an entity pressed against a wall. One is a bug report; the other is a shrug.
- **Version the wire, and compare the version first.** Every decode checks the version before reading a single field. That is what makes a rolling deploy safe: a mismatched packet decodes to nothing rather than misreading offsets.

### The version-bump rule that is easy to get wrong

Bump the protocol version when the wire changes **meaning**, not only when it changes **shape**.

Adding a new value to an existing enum moves no byte and widens no field. A mismatched client does not crash; it reads a value it has no case for and silently does the wrong thing. Re-ordering an enum is worse: not one byte moves and not one value is new, but the same number now means something else.

**The test is whether a mismatched pair would misread each other, not whether the offsets moved.** Silently wrong is exactly what the version field exists to catch.

The decoder is a **trust boundary**. Every section stops at the bytes actually present; a count field is clamped to both its declared maximum and the bytes available, so a crafted `count: 255` cannot amplify into hundreds of allocations; and a truncated or wrong-version packet decodes to empty rather than throwing, so one malformed frame costs nothing.

---

## 12. What to measure

Two numbers precede almost every real incident:

- **`starves`**: playout buffer misses. Rising means clients and server disagree about the tick timeline.
- **`renewFails`**: lease renewal failures. Rising means a split-brain guard is about to fire, or should be.

Two more worth watching:

- **`tickHz`**, measured against **real wall time between flushes**, never assumed. A stalled loop is exactly what the number exists to expose, and computing it from the loop's own assumptions hides the failure.
- **`bytesDelivered`** = `bytesPublished × playerCount`, the fan-out that the bandwidth bill actually tracks.

### A counter counts what happened, and an empty window is not a healthy one

Two rules that sound like tidiness and are the difference between a metric and a lie.

**Counters move inside the publish promise, never beside it.** `publishes`, `bytesPublished` and `bytesDelivered` record deliveries, not attempts. A room whose every publish is rejected otherwise reports 20 publishes a second with bytes climbing at the healthy rate.

**An empty latency window is `null`, never zeros.** For a distribution of durations, zero is the *best* possible value, so flattening "no samples at all" to `{ p50: 0, p95: 0, max: 0 }` makes the sickest room in the fleet report the healthiest numbers in it. `RoomStats.cadence`, `publishAwait` and `serverInternal` are `Percentiles | null` for that reason. The general shape: when a gauge's empty value is also its healthiest value, the empty case has to be a different **type**, not a different number.

### The alerting blind spot

A ticker that dies **hard** does not report a bad value. Its room **disappears** from the metrics entirely, because every per-room gauge is derived from the stats key that the ticker itself writes. Per-room alerts then see NoData, which is usually mapped to OK, and nothing pages.

The fix is a signal that does not depend on the ticker being alive. Have the **relay** register socket presence on a slow timer (a global sorted set, re-scored periodically so a hard function kill ages out rather than leaking), then join it against the stats keys server-side. **Sockets registered to a room with no stats key** is the alert: it means players are connected to a room that nothing is simulating.

Note that this state is hard to *test* by killing tickers, because ticker death self-heals every time (the successor spawn and the relay poll race, and one of them always wins). To reproduce it, **squat the lease**: hold it without ticking. That is a hung ticker rather than a dead one, and it is the failure this gauge actually exists to catch.

---

## 13. What this deliberately is not

**Not lockstep.** Peers never wait on each other. State-synchronised with client prediction, which degrades gracefully under loss where lockstep stalls.

**Not a CRDT.** There is one authority and it is the server. For text or documents with no natural authority, use a CRDT.

**Not zero-latency.** Other entities render 80 to 500ms behind, and near the 80ms floor whenever the network is calm. That delay is what buys smoothness. It is the correct trade for everything except a competitive shooter, which wants lag compensation and rewind, a different architecture.

**Not delta-compressed.** Snapshots are full state. That is why loss is free (the next snapshot supersedes the last), and it is why the wire format matters. Deltas would cut bandwidth and reintroduce a dependency on every prior packet, which is a much worse failure mode. Revisit only when `bytesDelivered` says to.
