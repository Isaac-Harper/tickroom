# Examples

Three shapes, one transport. Each is a complete `RoomRuntime` you can read in a
sitting.

| | What it shows |
| --- | --- |
| [`pong/sim.ts`](pong/sim.ts) | A real 2D game. Server-authoritative paddles and ball, seeded randomness that survives a checkpoint, events handed back to the host. |
| [`cursors/sim.ts`](cursors/sim.ts) | Realtime presence, no game at all. A slower tick, unstamped inputs, an idle fade. |
| [`node-server/`](node-server) | The same runtimes on a plain Node `ws` server, no serverless involved. |

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
