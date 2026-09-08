# tickroom

**Authoritative realtime rooms on serverless.** A leased fixed-timestep tick loop, a WebSocket relay, and Redis pub/sub as the bus.

Serverless functions are the wrong shape for realtime multiplayer in one specific way: they die, on a schedule, at a duration cap measured in minutes. Everything else about them (they scale to zero, they deploy in seconds, they cost nothing idle) is what you want. tickroom is the set of pieces that make a function's death a non-event: a room's authoritative simulation runs in a leased loop that checkpoints itself every second, and when the platform kills it *on schedule* a standby successor is already booted and waiting on the lease, so it picks up, restores, and keeps ticking inside a gap the client's own interpolation covers. Players see nothing. An **unplanned** death (a crash, an instance kill) is a different budget and this repo says so plainly: 5 to 7 seconds, measured, with a stall banner and a small tick regression. Extracted from a shipped multiplayer game and generalised, so the simulation contract is game-agnostic: a 2D platformer, a physics sandbox, multiplayer cursors, a collaborative whiteboard, or anything where several people need to agree on state that changes many times a second.

---

## Install

```bash
npm install tickroom ioredis
```

`ioredis` is an **optional** peer dependency, needed only by `tickroom/server` and the two adapters, which is where the bus lives. A browser-only consumer of `tickroom/client`, `tickroom/core` and `tickroom/codec` installs `tickroom` alone. Wherever it is used it has to be a real TCP client (`rediss://`): **a REST-style Redis API cannot subscribe**. `createMemoryRedis()` from `tickroom/server/memoryRedis` is a supported swap for a single long-lived process or a local dev loop, with no Redis at all.

**This is 1.0.0**, which is what `package.json` says and what the tag publishes. `CHANGELOG.md`'s "Migrating from 0.3" list is the break-by-break guide: `conn.frame(now, input)`, the `predict` option in place of a hand-held `PredictedEntity`, the binary input wire, and `DecodedSnapshotLike.inputLead` gone.

---

## Quickstart

### 1. Your simulation

Nothing here knows about sockets, Redis, or a platform. That is the point.

```ts
import type { RoomRuntime } from 'tickroom/core';
import type { DefaultInput } from 'tickroom/codec';

interface State { tick: number; players: Map<string, { x: number; y: number; vx: number; vy: number }> }

/** ONE definition of the movement rule. The client runs this exact function on its own player in step 3. */
export const PLAYER_SPEED = 40;
export function stepPlayer(p: { x: number; y: number }, input: DefaultInput, dt: number) {
  const [vx, vy] = input.axes;
  return { x: p.x + vx * dt * PLAYER_SPEED, y: p.y + vy * dt * PLAYER_SPEED };
}

export const game: RoomRuntime<State> = {
  tickHz: 20,
  create: () => ({ tick: 0, players: new Map() }),
  tick(s, dt) {
    for (const p of s.players.values()) Object.assign(p, stepPlayer(p, { axes: [p.vx, p.vy], buttons: 0 }, dt));
    s.tick += 1;
  },
  currentTick: (s) => s.tick,
  playerCount: (s) => s.players.size,
  // Apply each stamped input on EXACTLY the tick it names, so this simulation
  // and a predicting client run the same input on the same tick.
  usesPlayout: () => true,
  // Idempotent: the relay republishes a join every second as a heartbeat.
  join(s, pid) { if (!s.players.has(pid)) s.players.set(pid, { x: 50, y: 50, vx: 0, vy: 0 }); },
  leave(s, pid) { s.players.delete(pid); },
  applyInput(s, pid, input) {
    const p = s.players.get(pid);
    if (p) [p.vx, p.vy] = (input.data as DefaultInput).axes;
  },
  serialize: (s) => JSON.stringify({ tick: s.tick, players: [...s.players] }),
  deserialize: (json) => { const r = JSON.parse(json); return { tick: r.tick, players: new Map(r.players) }; },
  encodeSnapshot: (s, serverTime) => JSON.stringify({ tick: s.tick, serverTime, players: [...s.players] }),
};
```

### 2. The room, in one call

`createRoom` states every shared fact once and hands back the four route
handlers. Mounting them by hand meant writing the secret, the room pool, the
capacity, the namespace and the duration cap into four separate files, where a
disagreement between any two of them is silent.

```ts
// lib/room.ts
import { experimental_upgradeWebSocket } from '@vercel/functions';
import { createRoom } from 'tickroom/adapters/vercel';
import { game } from '@/sim/game';

export const room = createRoom({
  runtime: game,
  secret: process.env.SESSION_SECRET!,
  rooms: { isValidBase: (b) => b === 'lobby', fallbackRoom: 'lobby', maxPlayers: 20 },
  // THE ONE NUMBER THAT COUPLES THIS LIBRARY TO YOUR PLATFORM, in seconds, and
  // the same number each route file exports as `maxDuration`.
  maxDurationS: 800,
  upgradeWebSocket: experimental_upgradeWebSocket,
});
```

Each route file is then one handler and its literals (`runtime` and
`maxDuration` must be literals: Next reads them out of the source text at build
time):

```ts
// app/api/ws/route.ts  ... and ticker/route.ts, session/route.ts, room/route.ts
import { room } from '@/lib/room';
export const runtime = 'nodejs';
export const maxDuration = 800;
export const GET = room.ws;   // room.ticker, room.session (POST), room.balancer
```

The three factories underneath (`createTickerRoute`, `createRelayRoute`,
`createBalancerRoute`) are still exported and supported as the low-level form.

### 3. The browser

```ts
import { RoomConnection, type SessionInfo } from 'tickroom/client';
import type { DefaultInput } from 'tickroom/codec';
import { PLAYER_SPEED, stepPlayer } from '@/sim/game';

const conn = new RoomConnection<Snapshot, string, DefaultInput>({
  // MUST EQUAL YOUR RoomRuntime.tickHz. conn.stats().serverTickHz reports the
  // rate the server is actually running, and onTickRateMismatch fires if the
  // two disagree.
  tickHz: 20,
  mint: async (): Promise<SessionInfo> => {
    const res = await fetch('/api/session', { method: 'POST' });
    if (!res.ok) throw new Error(`mint failed: ${res.status}`);
    return (await res.json()) as SessionInfo;
  },
  decodeSnapshot: (buf) => JSON.parse(new TextDecoder().decode(buf)) as Snapshot,

  // EVERYONE ELSE'S ENTITIES, interpolated on the server's clock. The
  // connection builds the interpolator, pushes every snapshot into it and
  // clears it on reconnect; you say what MOVES and what this snapshot PUT
  // somewhere (a respawn is not motion, and interpolating across it walks the
  // entity the whole distance at playback speed).
  interpolate: {
    entities: (snap) => new Map(snap.players),
    teleported: (snap) => (snap.respawned ?? []).filter((pid) => pid !== myPid),
  },

  // YOUR OWN ENTITY, predicted locally through the SAME pure step the server
  // runs: one record per tick, the last six re-sent per packet, replayed from
  // every snapshot, corrected as a glide, and drawn from a render playhead so
  // it moves at the frame rate rather than stepping at the tick rate. The
  // connection owns the three call orders a host used to keep by hand.
  predict: {
    step: stepPlayer,          // (pose, input, dt, tick)
    maxSpeed: PLAYER_SPEED,
    ownPose: (snap) => snap.players.find(([pid]) => pid === myPid)?.[1] ?? null,
    teleported: (snap) => (snap.respawned ?? []).includes(myPid),
    // wire: 'json' if your input is not DefaultInput ({ axes, buttons }).
  },

  onSnapshot: (snap) => {},                          // fully reconciled by now
  onStallChange: (stalled) => banner.toggle(stalled),
  onTerminal: (reason) => { /* 'capacity' is the one worth handling */ },
});

await conn.start();

// THE ONE PER-FRAME CALL. Advances the tick inputs are stamped against, polls
// the stall detector, samples the interpolator, then stamps, predicts and sends.
function frame(now: number) {
  const { entities, own } = conn.frame(now, input);
  for (const [id, e] of entities) if (id !== myPid) draw(id, e.x, e.y);
  if (own) draw(myPid, own.x, own.y);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

### 4. Test your step against itself

`predict` replays your step from the server's pose, so a step that reads context
the server does not read at the same tick is wrong and **nothing anywhere
reports it**: the arithmetic is pure, the reconcile runs, and what a player sees
is rubberbanding. `tickroom/testing` runs both ends against each other so it can.

```ts
import { sweepLockstep } from 'tickroom/testing';

for (const { lead, delay, report } of sweepLockstep(scenario, [3, 6, 10], [2, 5])) {
  expect(report.maxError, `lead ${lead}, delay ${delay}`).toBe(0);
  expect(report.pinned).toEqual([]);
}
```

Sweep it, never sample it: a step reading its context at the wrong tick is exact
whenever the client happens to be stamping the tick it reads.

The whole walk-through, with every caveat, is [`docs/GUIDE.md`](docs/GUIDE.md).

---

## What you get

| Piece | What it solves |
| --- | --- |
| `createRoom` | The four routes from one bag of facts, so a relay admitting 20 against a balancer assigning for 8 is unreachable rather than silent. Validates at module evaluation. |
| `runTicker` | The authoritative loop. Lease, restore, tick, publish, checkpoint, hand off. Spawns a **standby** successor before its cap, probes its own input subscription for liveness, and counts crashes so a poisoned checkpoint cannot loop forever. |
| `attachRelay` | One socket to the bus: rate limiting, liveness, roster seeding, join heartbeat, **drop-don't-queue** snapshot backpressure, a direct ping echo, and a warm **lifetime handoff** so the function's own cap costs no visible gap. |
| `acquireLease` / `OwnershipClock` | Exactly-one-writer, and the two-clock rule that makes it hold under failure. |
| `writeCheckpoint` | Gzipped room state with a TTL, magic-byte sniffed so rolling deploys are safe, and **owner-checked in Redis** so an ex-owner cannot overwrite its successor. |
| `PlayoutBuffer` | An input lands on the *same tick* at both ends despite jitter. |
| `RoomConnection` | Reconnect, resume, re-mint, clock sync, protocol-skew recovery, a **real measured round trip**, and a **warm swap** at the relay's lifetime cap the player never sees. |
| `conn.frame(now, input)` | The one per-frame call: advances the tick, polls the stall, samples the interpolator, then stamps and predicts, and returns the poses to draw plus your own. |
| `predict` | Your own entity, the one the interpolation delay is wrong for. One option bag owns the whole stamped path's client half, and the three call orders a host used to get wrong are the connection's. |
| `interpolate` | Everyone else's entities, played back on the **server's** clock. Adapts to measured jitter, never freezes, unwinds its own extrapolation as a glide, and takes a declared `teleport` for the jump an entity did not travel. |
| `conn.stats()` | `rttMs`, `jitterMs`, `snapshotsReceived`, `rejectedSnapshots`, `underrunRate`, `reconnects`, `relaySwaps`, `swapsAttempted`, `swapsFailed`, `serverTickHz`, `hostErrors`. The last two exist because a wrong `tickHz` and a throwing host callback were both completely silent. |
| `ByteWriter` / `quantize` | The wire format, because fan-out bandwidth is the bill. Integer fields **refuse** rather than wrap; NaN is refused rather than encoded as the origin. |
| `tickroom/testing` | Your step and your runtime run against each other at a modelled lead and delay, which is the one divergence no check inside this library can see. |

---

## How it works

The browser opens a socket to a **relay** function, a dumb pipe with no
simulation in it, which publishes decoded input on `room:{id}:in`. A separate
**ticker** function holds a short-TTL Redis lease on that room, runs the
fixed-timestep simulation, and publishes snapshots on `room:{id}:out` at the sim
rate, which the relays forward to their sockets. Fan-out is one `PUBLISH` per
tick regardless of room size, so command count does not grow with population
(bandwidth does, and the library measures it). The ticker checkpoints every
second and spawns its own standby successor before its duration cap; the relay's
own cap is a warm socket swap rather than a drop. The simulation never learns
where it runs: it is a pure function of `(state, inputs, dt)`, which is what lets
the same code run authoritatively on the server, speculatively on the client, and
in a unit test with no network.

The reasoning behind every load-bearing decision, and the arithmetic for both
handoff budgets, is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Verification

```bash
npm run test:unit          # 1149 tests across 34 files, NO services at all
npm run test:integration   # 1197 across 43, the same architecture on a real Redis
npm run test:measure       # 16 across 4, wall-clock numbers, quiet machine only
npm test                   # all three, 1213 across 47
```

Beyond green, every guard is checked by **mutation**: broken on purpose, with the
suite required to notice. The measured claims (a planned handoff costing zero
server ticks on a real Vercel deployment, zero backward steps and zero blank
frames across 73 client-minutes, both shipped examples driven through a real
socket in CI) are in [`docs/VERIFICATION.md`](docs/VERIFICATION.md), and the
dated runs behind them in [`docs/LEDGER.md`](docs/LEDGER.md).

---

## Examples

| | |
| --- | --- |
| [`examples/pong`](examples/pong) | Two-player 2D game, and the reference for the STAMPED path: tick-stamped inputs and a paddle predicted by `predict` running the simulation's own exported step. |
| [`examples/cursors`](examples/cursors) | Multiplayer cursors. Not a game at all; realtime presence, at 10Hz with unstamped inputs. |
| [`examples/node-server`](examples/node-server/README.md) | The same simulation on a plain Node `ws` server, no serverless. Its README has the run command, the env knobs and a headless client. |

Both browser examples are driven through a real socket in CI rather than only
illustrated.

---

## Docs

| | |
| --- | --- |
| [`docs/GUIDE.md`](docs/GUIDE.md) | The full walk-through: install, the four routes, the browser client, testing your step, and the things that cost real production time to learn. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Why any of this is shaped the way it is, decision by decision. |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | The cost model, the platform limits, the Redis requirements, and how a release is cut. |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | Every measured claim, with the machine it was taken on. |
| [`docs/LEDGER.md`](docs/LEDGER.md) | The dated history: mutation matrices, audit rounds, platform runs. |
| [`AGENTS.md`](AGENTS.md) | The operating manual for anyone changing this code. |

---

## Non-goals

- **Not a game engine.** No rendering, no physics, no ECS. You bring the simulation.
- **Not lockstep.** State-synchronised with client prediction. Peers never wait on each other.
- **Not a CRDT.** There is one authority and it is the server. For text or documents with no natural authority, use a CRDT.
- **Not zero-latency.** Clients render other entities 80 to 500ms behind, adaptively, and near the 80ms floor on a clean connection. That delay is what buys smoothness, and it is the correct trade for everything except a competitive shooter.

---

## License

MIT
