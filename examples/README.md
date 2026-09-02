# Examples

Three shapes, one transport. Each is a complete `RoomRuntime` you can read in a
sitting.

| | What it shows |
| --- | --- |
| [`pong/sim.ts`](pong/sim.ts) | A real 2D game. Server-authoritative paddles and ball, seeded randomness that survives a checkpoint, events handed back to the host. |
| [`cursors/sim.ts`](cursors/sim.ts) | Realtime presence, no game at all. A slower tick, unstamped inputs, an idle fade. |
| [`node-server/`](node-server) | The same runtimes on a plain Node `ws` server, no serverless involved. |

Both simulations have a browser half beside them, [`pong/client.ts`](pong/client.ts) and
[`cursors/client.ts`](cursors/client.ts), and the pair is the point: read a
`sim.ts` and its `client.ts` together and you have seen a whole application.
The two clients differ in three places (`tickHz`, the send cadence that matches
it, and what `interpolate.entities` pulls out of a snapshot) and are otherwise
the same twenty lines of wiring, which is the claim the transport makes about
itself. Both leave `targetTick` at 0 and both key the interpolator by pid;
neither predicts anything locally, and each says in a comment what stamping
would look like if it did.

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

**Stamped versus unstamped inputs is also per-runtime.** Pong could stamp its
paddle inputs so a predicting client and the server apply them on the identical
tick. Cursors deliberately does not: nothing is predicted locally, a tick of skew
is invisible, and apply-on-arrival is one less moving part. Leave `targetTick` at
0 and the playout buffer never engages.

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

## The JSON-to-binary upgrade path, worked all the way through

`pong/codec.ts` is what "you must write a codec eventually" looks like in
practice, not just in the README's table of contents. It re-encodes pong's
exact snapshot (`encodePongSnapshot` / `decodePongSnapshot`) using
`ByteWriter`, `ByteReader`, and `quantize` from `src/codec/`, and
`pong/codec.test.ts` measures the result instead of asserting it in prose:

| | bytes |
| --- | --- |
| JSON (`sim.ts`'s `encodeSnapshot`) | 215 |
| Binary (`codec.ts`'s `encodePongSnapshot`) | 51 |
| Ratio | 4.22x smaller |

That is one realistic two-player snapshot (nonzero ball velocity, paddles off
their spawn position, mid-game). It is not a contrived best case: the JSON
version already rounds every float to one decimal place, and the binary
version still comes in at under a quarter of the size, because JSON pays for
field names, quotes, and decimal ASCII on every single tick, and a snapshot
is encoded once per tick and delivered once *per player* (see
`RoomStats.bytesDelivered` in the README's cost model). That multiplication
is what makes the switch worth making: a full room publishing at 20Hz turns
this file's 164-byte-per-tick saving into a real bandwidth line, and a
two-player room barely notices either way.

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
  of plausible-looking garbage.
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
