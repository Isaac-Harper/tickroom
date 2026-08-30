# tickroom

**Authoritative realtime rooms on serverless.** A leased fixed-timestep tick loop, a WebSocket relay, and Redis pub/sub as the bus.

Serverless functions are the wrong shape for realtime multiplayer in one specific way: they die. Not occasionally, on a schedule, at a duration cap measured in minutes. Everything else about them (they scale to zero, they deploy in seconds, they cost nothing idle) is what you want.

tickroom is the set of pieces that make a function's death a non-event. A room's authoritative simulation runs in a leased loop that checkpoints itself every second; when the platform kills it, a successor picks up the lease, restores the checkpoint, and keeps ticking. In practice players see nothing at all.

This is extracted from a shipped multiplayer game and generalised. The simulation contract is deliberately game-agnostic: it works for a 2D platformer, a physics sandbox, multiplayer cursors, a collaborative whiteboard, a shared timeline scrubber, or anything else where several people need to agree on state that changes many times a second.

---

## The problem, stated properly

You want twenty people in a shared world that updates 20 times a second. The obvious serverless shape does not work:

- **A function per client cannot be authoritative.** Twenty functions each holding one socket cannot agree on who picked up the coin.
- **A function cannot hold a room open forever.** It has a hard duration cap. Whatever is authoritative has to survive being killed.
- **You cannot pin a client to an instance.** Connections land wherever, and a deploy splits old and new. All coordination has to go through shared state.
- **Naive fan-out bankrupts you.** Delivery-billed realtime services charge per message per recipient, which is precisely the axis a 20Hz room maxes out.

## The shape that does work

```
                   ┌──────────────────────────────────────────┐
   browser ───────►│  RELAY FUNCTION  (one per socket)        │
      ▲            │  dumb pipe: no game logic lives here     │
      │            └───────────┬─────────────────┬────────────┘
      │                        │ publishes       │ subscribes
      │                        │ decoded input   │ snapshots
      │                        ▼                 ▲
      │            ┌───────────────────────────────────────────┐
      │            │  REDIS PUB/SUB                            │
      │            │  room:{id}:in   room:{id}:out             │
      │            │  room:{id}:lease  room:{id}:state         │
      │            └───────────▲─────────────────┬─────────────┘
      │                        │ subscribes      │ publishes at 20Hz
      │                        │                 ▼
      │            ┌───────────────────────────────────────────┐
      └────────────│  TICKER FUNCTION  (exactly ONE per room)  │
      snapshots    │  holds the lease · runs YOUR simulation   │
                   │  checkpoints every second                 │
                   │  spawns its own successor on the way out  │
                   └───────────────────────────────────────────┘
```

Four properties fall out of it:

**Exactly one writer, guaranteed.** A short-TTL Redis lease with an owner-checked renew. Two tickers racing resolves to one, strictly, and the loser exits without publishing a single frame.

**Death is recoverable in under a second.** The ticker checkpoints the whole room every second, and spawns its own successor before it exits. The successor restores and continues. Its predecessor's players never disconnected: their sockets are held by relay functions, which are a separate lifetime entirely.

**Fan-out is one publish.** Redis pub/sub delivers to N subscribers for the price of one `PUBLISH` command. Command count does not grow with room population. (Bandwidth does. That is the axis to watch, and tickroom measures it for you.)

**The simulation never learns where it runs.** It is a pure function of `(state, inputs, dt)`. The same code runs authoritatively on the server, speculatively on the client, and in a unit test with no network. That is the escape hatch: if serverless stops being the right host, the simulation moves to a long-lived VM unchanged.

---

## Install

```bash
npm install tickroom ioredis
```

`ioredis` is a peer dependency. It has to be a real TCP client (`rediss://`): **a REST-style Redis API cannot subscribe**, which rules out several managed "Redis-compatible" HTTP products for the bus specifically.

---

## Quickstart

### 1. Write your simulation

Nothing here knows about sockets, Redis, or a platform. That is the point.

```ts
import type { RoomRuntime, ClientInput } from 'tickroom/core';

interface Player { x: number; y: number; vx: number; vy: number; }
interface State { tick: number; players: Map<string, Player>; }

export const pong: RoomRuntime<State> = {
  tickHz: 20,

  create: () => ({ tick: 0, players: new Map() }),

  tick(s, dt) {
    for (const p of s.players.values()) {
      p.x = Math.max(0, Math.min(100, p.x + p.vx * dt * 40));
      p.y = Math.max(0, Math.min(100, p.y + p.vy * dt * 40));
    }
    s.tick += 1;
  },

  currentTick: (s) => s.tick,
  playerCount: (s) => s.players.size,

  // Idempotent on purpose: the relay republishes a join every second as a
  // heartbeat, and a reconnecting player rejoins under the same id.
  join(s, pid) {
    if (!s.players.has(pid)) s.players.set(pid, { x: 50, y: 50, vx: 0, vy: 0 });
  },

  leave: (s, pid) => void s.players.delete(pid),

  applyInput(s, pid, input) {
    const p = s.players.get(pid);
    if (!p) return;
    const { x, y } = input.data as { x: number; y: number };
    p.vx = Math.max(-1, Math.min(1, x));
    p.vy = Math.max(-1, Math.min(1, y));
  },

  serialize: (s) => JSON.stringify({ tick: s.tick, players: [...s.players] }),

  deserialize(json) {
    const raw = JSON.parse(json);
    return { tick: raw.tick, players: new Map(raw.players) };
  },

  encodeSnapshot(s, serverTime) {
    return JSON.stringify({ tick: s.tick, serverTime, players: [...s.players] });
  },
};
```

### 2. Mount two routes

```ts
// app/api/ticker/route.ts
import { createTickerRoute, tickerRouteConfig } from 'tickroom/adapters/vercel';
import { pong } from '@/sim/pong';

export const { runtime, maxDuration } = tickerRouteConfig;
export const GET = createTickerRoute({
  runtime: pong,
  secret: process.env.SESSION_SECRET!,
  isValidBase: (b) => b === 'pong',
  fallbackRoom: 'pong',
});
```

```ts
// app/api/ws/route.ts
import { experimental_upgradeWebSocket } from '@vercel/functions';
import { createRelayRoute, relayRouteConfig } from 'tickroom/adapters/vercel';

export const { runtime, maxDuration } = relayRouteConfig;
export const GET = createRelayRoute({
  secret: process.env.SESSION_SECRET!,
  isValidBase: (b) => b === 'pong',
  fallbackRoom: 'pong',
  maxPlayers: 20,
  // Relative, so it resolves against this request's own origin: fine as
  // long as the ticker route lives in the same deployment, which is the
  // common case and what the ticker route above sets up.
  tickerUrl: '/api/ticker',
  decodeInput: (buf) => [JSON.parse(new TextDecoder().decode(buf))],
  upgradeWebSocket: experimental_upgradeWebSocket,
});
```

`upgradeWebSocket` is **injected, not imported**. tickroom takes no hard dependency on any platform, so the same server core runs behind plain `ws` on a VM (see `adapters/node.ts`).

### 3. Connect from the browser

```ts
import { RoomConnection, SnapshotInterpolator, type DecodedSnapshotLike } from 'tickroom/client';

// Players are keyed by pid, a string, everywhere else in tickroom (join,
// leave, applyInput, RoomStats), so the interpolator is typed to match:
// SnapshotInterpolator() with no type argument defaults to a NUMBER key,
// which is the wrong key type for anything this library hands you a pid for.
const interp = new SnapshotInterpolator<string>();

// decodeSnapshot's return type carries an index signature (`[k: string]:
// unknown`) precisely so tickroom never assumes the shape of your payload;
// name your own fields on top of it once, here, the same way
// examples/pong/client.ts's own PongSnapshot does.
interface Snapshot extends DecodedSnapshotLike {
  players: [string, { x: number; y: number }][];
}

const conn = new RoomConnection({
  mint: () => fetch('/api/session', { method: 'POST' }).then((r) => r.json()),
  decodeSnapshot: (buf) => JSON.parse(new TextDecoder().decode(buf)),
  onSnapshot: (raw) => {
    const snap = raw as Snapshot;
    interp.push({
      receivedAt: performance.now(),
      serverTime: snap.serverTime,
      entities: new Map(snap.players.map(([id, p]) => [id, { x: p.x, y: p.y }])),
    });
  },
  onStallChange: (stalled) => banner.toggle(stalled),
});

await conn.start();

function frame(now: number, dt: number) {
  conn.pollStall();
  // Pass `now` explicitly: it is the same clock (performance.now()) that
  // onSnapshot() stamped receivedAt with above, so playback and the buffer
  // agree on what time it is. Omitting it also works (sample() defaults to
  // reading performance.now() itself), but naming it keeps both call sites
  // visibly tied to one clock.
  for (const [id, e] of interp.sample(dt, now)) draw(id, e.x, e.y);
}
```

You now have reconnect-with-backoff, session re-minting, a smoothed server clock, jitter-adaptive interpolation, never-freeze extrapolation, and a stall detector that can tell a dead room from a slow one.

---

## What you get, and what it is actually for

| Piece | What it solves |
| --- | --- |
| `runTicker` | The authoritative loop. Lease, restore, tick, publish, checkpoint, hand off. |
| `attachRelay` | One socket to the bus. Rate limiting, liveness, roster seeding, join heartbeat. |
| `assignRoom` | Packs joiners into the lowest-index room with space, so empty rooms drain. |
| `acquireLease` / `OwnershipClock` | Exactly-one-writer, and the two-clock rule that makes it hold under failure. |
| `writeCheckpoint` | Gzipped room state with a TTL, magic-byte sniffed so rolling deploys are safe. |
| `PlayoutBuffer` | An input lands on the *same tick* at both ends despite jitter. |
| `Inbox` | Backpressure with a per-sender quota, so one flooder degrades only themselves. |
| `RoomConnection` | Reconnect, resume, re-mint, clock sync, protocol-skew recovery. |
| `SnapshotInterpolator` | Other entities move smoothly. Adapts to measured jitter, never freezes. |
| `ErrorOffset` | A correction becomes a glide instead of a teleport. |
| `stallDecision` | Tell the player the world is gone, without crying wolf on a routine handoff. |
| `ByteWriter` / `quantize` | The wire format, because fan-out bandwidth is the bill. |

---

## Things it is worth knowing before you build on this

Each of these cost real production time to learn. They are documented at length in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and in the source comments.

**The lease needs two clocks, not one.** `lastRenewAt` paces attempts, `lastOwnedAt` records confirmed ownership. Collapse them and a ticker whose renews are all *failing* keeps refreshing its own guard, so the guard can never fire in the one situation it exists for.

**A checkpoint must carry a digest of the world it was simulated against.** Otherwise a deploy that moves a wall leaves every live room restoring and re-saving a simulation of the old world forever, because each successor faithfully restores its predecessor's bytes. Silent, permanent, invisible in every metric.

**Capacity must be read from one key.** If the relay and the balancer read different keys, a hard-dead ticker leaves one of them permanently wrong, the balancer keeps handing out a room the relay keeps rejecting, and joiners strand on "full" with no way to heal.

**Never freeze a remote entity on interpolation underrun.** Extrapolate for up to 150ms. A frozen entity that then teleports reads far worse than one that drifts and is corrected, and this is the single rule most likely to be optimised away by someone who has not watched it happen.

**Re-send the last few inputs in every packet.** The playout buffer's push is duplicate-overwriting and out-of-order safe, so re-sends are free, and a lost packet stops mattering.

**The successor spawn belongs in `finally`, and must be awaited but raced.** A thrown ticker is exactly when a room would otherwise sit dead. Fire-and-forget was measurably wrong: as the last thing a handler does, it is post-response IO the platform can suspend before it flushes.

---

## Cost model

Measured on the game this came from, at 20Hz with a full 20-player room:

| | per second |
| --- | --- |
| Per player | ~21 Redis commands |
| Per room, regardless of population | ~23 commands |
| A full 20-player room | ~463 commands |

**Fan-out is free in commands and expensive in bandwidth.** One `PUBLISH` reaches every subscriber for one command, so command count does not scale with population. Bytes do: every player socket holds its own subscriber, so a snapshot crosses the wire once per player. `RoomStats.bytesDelivered` measures exactly that.

Pick a **flat-rate** Redis plan. Per-command billing on this traffic shape is roughly two orders of magnitude more expensive than flat-rate, and the same room that costs about $30/month flat costs thousands metered.

**The first ceiling you hit is concurrent connections, not commands.** Every socket needs its own subscriber (a connection in subscribe mode cannot run ordinary commands). That is why the relay enforces a per-user socket cap: without it, one client opening sockets can exhaust the connection ceiling and take the room's own ticker subscriber down with it, which is a total outage rather than a nuisance.

If bandwidth ever becomes the bill, the lever is not a bigger plan, it is ending the per-socket fan-out: one subscriber per room per relay instance, or the ticker off serverless entirely.

---

## Examples

| | |
| --- | --- |
| [`examples/pong`](examples/pong) | Two-player 2D game. Server-authoritative paddles and ball. |
| [`examples/cursors`](examples/cursors) | Multiplayer cursors. Not a game at all; realtime presence. |
| [`examples/node-server`](examples/node-server) | The same simulation on a plain Node `ws` server, no serverless. |

Each example is tested, not just illustrative: the round-trip tests prove a
checkpoint genuinely resumes (both rooms ticked forward through identical input
and diffed, which is what catches a field somebody forgot to serialise) and
`examples/pong/codec.ts` works the JSON-to-binary upgrade all the way through,
measured at **215 bytes to 51, 4.22x smaller**, on a realistic two-player
snapshot.

---

## Verification

```bash
npm test                       # 400 tests, no services needed
redis-server --port 6399 --save '' --appendonly no --daemonize yes
npm run test:integration       # the same architecture against a real Redis
```

The integration suite skips cleanly (exit 0) when no Redis is reachable, so the
default run stays green offline. Measured on Redis 8.10.1:

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

---

## Non-goals

- **Not a game engine.** No rendering, no physics, no ECS. You bring the simulation.
- **Not lockstep.** State-synchronised with client prediction, not deterministic lockstep. Peers never wait on each other.
- **Not a CRDT.** There is one authority and it is the server. For text or documents with no natural authority, use a CRDT.
- **Not zero-latency.** Clients render other entities 80 to 250ms behind, adaptively. That delay is what buys smoothness, and it is the correct trade for everything except a competitive shooter.

---

## Status, honestly

Not published to npm and not deployed anywhere. The architecture's production
evidence is the game it was extracted from, where the lease, the checkpoint
handoff, the playout timeline, the stall thresholds and the interpolation rules
were all measured under real load. This repo proves the extraction is faithful
and that the mechanisms work against real Redis and a real socket; it has not
itself served a player.

Known gaps: the integration suite exercises a toy runtime rather than the
examples end to end, and there is no CI (the integration half needs a Redis
service container). Both are tracked in `AGENTS.md`.

---

## License

MIT
