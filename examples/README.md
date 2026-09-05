# Examples

Three shapes, one transport. Each is a complete `RoomRuntime` you can read in a
sitting.

| | What it shows |
| --- | --- |
| [`pong/sim.ts`](pong/sim.ts) | A real 2D game, and the reference for the STAMPED path: tick-stamped inputs, a paddle predicted locally against the identical shared step function, and the server's playout depth fed back down the wire. Server-authoritative paddles and ball, seeded randomness that survives a checkpoint, events handed back to the host. |
| [`cursors/sim.ts`](cursors/sim.ts) | Realtime presence, no game at all. A slower tick, unstamped inputs, an idle fade. |
| [`node-server/`](node-server/README.md) | The same runtimes on a plain Node `ws` server, no serverless involved. Its README carries the exact run command, every environment knob, the session and socket URLs, a headless Node client, and the two recipes that make a planned handoff and the relay's warm swap happen on a schedule you can watch. |

Both simulations have a browser half beside them, [`pong/client.ts`](pong/client.ts) and
[`cursors/client.ts`](cursors/client.ts), and the pair is the point: read a
`sim.ts` and its `client.ts` together and you have seen a whole application.
Both key the interpolator by pid, and the transport wiring underneath them is
the same twenty lines, which is the claim the transport makes about itself.

**They diverge on exactly one decision, and it is the one worth understanding.**
Cursors is UNSTAMPED: `targetTick` stays 0, the server applies each input on
arrival, nothing is predicted locally. Pong is STAMPED, end to end and for real:
every input carries the tick it applies on, one record per client tick with the
last six re-sent on every packet, and the client runs `stepPaddleY` (the
simulation's own exported function, not a copy of it) on its own paddle so the
paddle answers the key with no round trip in it. The server applies the record
stamped for tick T on tick T, both ends therefore land on the same y, and a
snapshot is a confirmation rather than a correction. When they do disagree, the
difference goes into an `ErrorOffset` and is bled off over a few frames. Pong
also closes the depth loop: `onBufferHealth` stores the server's playout depth
per player, `encodeSnapshot` carries it per paddle, `decodeSnapshot` picks out
its own pid's value as `inputLead`, and the connection trims its stamping lead
to the smallest one that keeps the buffer fed.

## What to notice

**Neither simulation imports a socket, Redis, or a platform.** They import one
type. That is the whole design: the runtime is a pure function of state and
inputs, so the identical code runs authoritatively on the server, speculatively
on a client, and in a unit test with no network.

**Nothing in the transport is 3D.** tickroom was extracted from a 3D game and
`pong` is 2D, `cursors` is a normalised 0..1 plane. The transport moves opaque
bytes; dimensionality is entirely yours.

**The tick rate is a per-runtime decision and it is your largest cost lever.**
Pong runs at 20Hz because a ball needs it. Cursors runs at 10Hz because nobody
can tell, and halving the rate halves the single biggest bandwidth line in the
system. Interpolation on the client makes 10Hz read as continuous. Pick the
lowest rate at which your content still feels live.

**Stamped versus unstamped inputs is also per-runtime, and the two examples
have made opposite calls.** Pong stamps, because it predicts: a paddle that
waited a round trip for the key feels broken, and prediction is only correct if
both ends apply the same input on the same tick. `pong/sim.test.ts` runs both
ends against the shared step function and asserts they agree tick for tick, and
runs the same records apply-on-arrival to show that they do not. Cursors
deliberately does not stamp: nothing is predicted locally, a tick of skew on
somebody else's cursor is invisible, and apply-on-arrival is one less moving
part. Leave `targetTick` at 0 and the playout buffer never engages. Stamping
costs a `usesPlayout` and a client that keeps a few records around; pick it when
you predict, skip it when you do not.

## The four things both runtimes do that yours must too

**1. `join` is idempotent.** The relay republishes a join every second as a
heartbeat (pub/sub is lossy, so the first one can be dropped) and a reconnecting
player rejoins under the same id. A `join` that reset position would teleport a
live player once a second.

**2. `serialize` and `deserialize` genuinely round-trip.** A `Map` does not
survive `JSON.stringify`, which is the most common way a checkpoint silently
loses half a room. Convert explicitly in both directions, and write the
round-trip test.

**3. `deserialize` throws on anything it cannot restore.** A throw is handled:
the ticker logs it and starts the room fresh, which is correct for a corrupt or
stale checkpoint. Silently returning a half-restored room is not.

**4. Everything off the wire is clamped and validated in the simulation.** The
value was chosen by a client and a hostile one is free to send `1e9`. The
simulation is the last place that can refuse it. Note `cursors` sanitises the
display name at the simulation boundary rather than in the UI, so the next client
(a bot, a different renderer, an export) gets the check too.

## Also worth copying

**Seeded randomness, never `Math.random`.** Pong keeps a `mulberry32` seed in
state, so the seed rides the checkpoint and a successor continues the same
sequence. `Math.random` in a tick means a restored room resumes into a different
game than the one players were watching.

**`create` is deterministic.** It runs on every fresh room and on every restore
that could not use its checkpoint. A clock read there is an untracked input to
the simulation.

**Reflect the position, not just the velocity.** Pong's wall bounce re-seats the
ball as well as flipping `vy`. A ball that overshot the wall and only had its
sign flipped can end the tick still outside the field, flip again next tick, and
buzz along the boundary forever.

**Emit the edge, not the state.** The cursors idle event fires on the tick the
threshold is crossed (`=== IDLE_TICKS`), not for every tick past it, so it fires
once per cursor rather than ten times a second forever.

## What the tests prove

`pong/sim.test.ts` and `cursors/sim.test.ts` exist because "the example does
this correctly" and "an example that quietly broke would still look fine" are
both true at once, and only a test tells them apart. Each file checks:

- **The Map round-trip**, asserted on the reconstructed `Map` itself (keys,
  values, `instanceof Map`), not on the JSON string a looser test would settle
  for. A string comparison cannot tell you the receiving side got a `Map`
  back instead of the array `JSON.parse` actually produces.
- **A full game survives a restore and keeps simulating.** Both tests run
  real play, take a checkpoint mid-session, then tick the original room and
  the restored one forward through the *identical remaining input* and
  diff the final states. This is the test that actually matters: a shallow
  encode/decode/compare can pass even when a field was dropped, if that
  field's default happens to match its value at the exact moment the
  snapshot was taken. Ticking both rooms forward is what makes a forgotten
  field diverge instead of hiding.
- **Pong's seeded randomness survives the restore.** The ball's trajectory
  (and the tick of every subsequent goal) is asserted bit-identical between
  a room that never restarted and one that was checkpointed and resumed
  mid-game. If `create` or a tick ever reached for `Math.random`, this is
  the test that would catch it: neither example calls it on any tick path
  today, which was checked directly rather than assumed.
- **`deserialize` throws, in three distinct ways**, on a string that is not
  JSON, on valid JSON of the wrong shape, and on JSON missing a field the
  runtime needs (a truncated checkpoint). All three are checked separately
  because a decoder that happens to throw on one shape of garbage is not
  proof it throws on the others.
- **`join` is idempotent** under the relay's own heartbeat behaviour: a
  repeated join never duplicates a player, never resets their position or
  score, and (for cursors) a rename-and-reconnect updates the name without
  touching the hue everyone else already associates with that cursor.
- **Hostile input is clamped, not passed through.** `1e9`, `NaN`,
  `-Infinity`, a string, `null`, and a missing field are each sent through
  `applyInput` and asserted to land inside the legal range rather than
  crashing the tick or moving an entity faster than the rules allow.

`pong/sim.test.ts` proves two more, because pong is the stamped example and
the stamped path's central claim is not something a comment can assert:

- **A stamped input runs identically on both ends.** One branch is the
  client: `stepPaddleY` on a bare number, exactly as `pong/client.ts` runs
  it on its own paddle through `PredictedEntity`'s `step`. The other is the
  server: the runtime, applying the record stamped for tick T on tick T. The
  two traces are compared per tick and asserted EXACTLY equal, not close,
  because a tolerance would hide the one failure this test exists to catch, a
  client that got the rule nearly right. Nothing is shared between the
  branches except the step function itself, which is why it is exported from
  `sim.ts` rather than copied into the client: a test that compared a
  client's copy of the rule to itself
  would pass forever. A second test feeds the same records in
  apply-on-arrival order and asserts the traces DIVERGE, so the first one
  cannot pass vacuously.
- **The playout depth is excluded from the checkpoint on purpose, and the
  exclusion is invisible to the simulation.** `onBufferHealth`'s reading
  describes the ticker that is exiting, so `serialize` leaves it out and a
  restore starts it empty. The test asserts the empty `Map` and then ticks
  both rooms forward through identical input, which is what would catch a
  tick path that had started reading it.

## The JSON-to-binary upgrade path, worked all the way through

`pong/codec.ts` is what "you must write a codec eventually" looks like in
practice, not just in the README's table of contents. It re-encodes pong's
exact snapshot (`encodePongSnapshot` / `decodePongSnapshot`) using
`ByteWriter`, `ByteReader`, and `quantize` from `src/codec/`, and
`pong/codec.test.ts` measures the result instead of asserting it in prose:

| | bytes |
| --- | --- |
| JSON (`sim.ts`'s `encodeSnapshot`) | 243 |
| Binary (`codec.ts`'s `encodePongSnapshot`) | 53 |
| Ratio | 4.58x smaller |

That is one realistic two-player snapshot (nonzero ball velocity, paddles off
their spawn position, mid-game). It is not a contrived best case: the JSON
version already rounds every float to one decimal place, and the binary
version still comes in at under a quarter of the size, because JSON pays for
field names, quotes, and decimal ASCII on every single tick, and a snapshot
is encoded once per tick and delivered once *per player* (see
`RoomStats.bytesDelivered` in the README's cost model). That multiplication
is what makes the switch worth making: a full room publishing at 20Hz turns
this file's 190-byte-per-tick saving into a real bandwidth line, and a
two-player room barely notices either way.

The per-paddle `inputLead` (the server's playout depth, the field that closes
the feedback loop) costs **one byte per paddle** here against fourteen
characters of JSON, which is the same argument in miniature: the field a
binary wire adds for free is the field a JSON wire makes you think twice
about.

**Do not make this switch on day one.** Measure `bytesDelivered` first.
`pong/sim.ts` keeps its JSON `encodeSnapshot` exactly as it was; `codec.ts` is
presented as the upgrade a room reaches for once its entity shape has
stabilised and the bandwidth line has actually shown up, not a replacement
you are expected to adopt immediately. Swapping it in is a one-line change at
the call site (`RoomRuntime.encodeSnapshot` may return a `Uint8Array` exactly
as easily as a string); nothing about the runtime, the transport, or the rest
of the contract has to change to make that switch.

The three things worth reading `codec.ts` for, beyond the size number:

- **The version byte is checked before anything else is read**, which is
  what makes a rolling deploy safe. A mismatched version has to fail as a
  clean, immediate throw naming the mismatch, not a decoder that reads a
  new layout's bytes at an old layout's offsets and returns a snapshot full
  of plausible-looking garbage. **It reads 2, not 1**, because adding
  `inputLead` to each paddle changed what the wire MEANS and not only how
  long it is, and this repo's rule is that meaning is what a version bump
  tracks. A v1 decoder pointed at a v2 buffer would read the next paddle's
  pid length out of that byte, which is precisely the plausible-garbage
  failure the check turns into a throw.
- **Quantised fields are picked with a stated range and headroom**, not
  just "the smallest type that fits today". Pong's ball and paddle
  positions use an `i16` at 1/100-unit precision, which covers -327.68 to
  +327.67 units against a 200x120 field: more than 60% of extra room on
  every edge, on purpose, so a one-tick overshoot pins at a boundary
  instead of doing something worse.
- **Clamping, never wrapping, is what turns an out-of-range value into a
  non-event instead of a bug report.** A wrapped `i16` takes a position
  just past its positive limit and turns it into the most negative value
  the field can hold: an entity at the edge of the world teleports to the
  opposite edge, which is a screenshot-and-report-it bug. The same
  out-of-range value, clamped, just pins the entity at the boundary it was
  already nearly at. `quantize` in `src/codec/quantize.ts` does this for
  every caller; `codec.ts` inherits it rather than re-deciding it.
