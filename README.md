# tickroom

**Authoritative realtime rooms on serverless.** A leased fixed-timestep tick loop, a WebSocket relay, and Redis pub/sub as the bus.

Serverless functions are the wrong shape for realtime multiplayer in one specific way: they die. Not occasionally, on a schedule, at a duration cap measured in minutes. Everything else about them (they scale to zero, they deploy in seconds, they cost nothing idle) is what you want.

tickroom is the set of pieces that make a function's death a non-event. A room's authoritative simulation runs in a leased loop that checkpoints itself every second; when the platform kills it *on schedule*, a standby successor is already booted and waiting on the lease, so it picks up, restores the checkpoint, and keeps ticking inside a gap the client's own interpolation covers. Players see nothing at all. An **unplanned** death (a crash, an instance kill) is a different budget and this README says so plainly further down: 5 to 7 seconds, measured, with a stall banner and a small tick regression.

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

**A PLANNED death is recoverable in under a second.** The ticker checkpoints the whole room every second, and spawns a standby successor three seconds before its own duration cap, so that successor has already paid its cold start and is polling the lease at the instant the incumbent releases. The successor restores and continues the tick count. Its predecessor's players never disconnected: their sockets are held by relay functions, which are a separate lifetime entirely, and the relay's own cap is a warm socket swap rather than a drop. An unplanned death runs none of that code and takes the lease TTL plus a poll plus a cold spawn: **5 to 7 seconds, measured**.

**Fan-out is one publish.** Redis pub/sub delivers to N subscribers for the price of one `PUBLISH` command. Command count does not grow with room population. (Bandwidth does. That is the axis to watch, and tickroom measures it for you.)

**The simulation never learns where it runs.** It is a pure function of `(state, inputs, dt)`. The same code runs authoritatively on the server, speculatively on the client, and in a unit test with no network. That is the escape hatch: if serverless stops being the right host, the simulation moves to a long-lived VM unchanged.

---

## Install

```bash
npm install tickroom ioredis
```

**Everything documented here is 0.2.0**, which is what `package.json` says and what the audit's API changes landed in. **0.2.0 is not on npm yet**: the published version is 0.1.1, whose `conn.stats()` has a different shape, whose `TerminalReason` is missing three members, and whose relay has no warm swap. Until the release tag goes out, install from a checkout:

```bash
git clone https://github.com/Isaac-Harper/tickroom && cd tickroom
npm install && npm pack          # -> tickroom-0.2.0.tgz
npm install /path/to/tickroom-0.2.0.tgz   # from your own project
```

`ioredis` is an **optional** peer dependency, and it is needed only by `tickroom/server` and the two adapters, which is where the bus lives. A browser-only consumer of `tickroom/client`, `tickroom/core` and `tickroom/codec` installs `tickroom` alone:

```bash
npm install tickroom
```

Wherever it is used it has to be a real TCP client (`rediss://`): **a REST-style Redis API cannot subscribe**, which rules out several managed "Redis-compatible" HTTP products for the bus specifically.

### One process, no Redis

`createMemoryRedis()` is a supported shape, not a test artefact: it hands back the same two clients `getRedis()` and `createSubscriber` do, backed by one in-process store. Everything above the seam is unchanged, because `RedisLike` is the seam and this is the swap it exists for.

```ts
import { createMemoryRedis } from 'tickroom/server/memoryRedis';
import { attachNodeRelay, runNodeTicker } from 'tickroom/adapters/node';

// ONCE, at module scope. Two calls are two disjoint stores.
const { redis, createSubscriber } = createMemoryRedis();

attachNodeRelay(wss, { redis, createSubscriber, ...relayOpts });
runNodeTicker({ redis, createSubscriber, roomId: 'pong', runtime: pongRuntime });
```

Pass both to both halves, or neither to either: a ticker on one store and a relay on another is a room whose snapshots nobody receives, and every other signal reads healthy while it happens.

**Import it from `tickroom/server/memoryRedis`, not from `tickroom/server`.** Both work and both give you the same object, but the barrel re-exports the real factories beside it and therefore loads `ioredis` at module top, which would mean reaching the thing that exists to avoid Redis by loading Redis to get it. The subpath is a single module with no imports at all in the emitted `dist/server/memoryRedis.js`, which is what makes that a fact rather than an intention.

**What it costs is everything Redis was there for**, and the list is short because there is only one fact behind it: the store is this process's heap.

- **No horizontal scale.** A second instance of your server shares nothing with the first. There is no load balancer configuration that fixes this; the bus is the thing that is missing.
- **No survival of the process.** The checkpoint is written to the same heap it protects, so a crash, a deploy or a platform kill takes the room and its checkpoint together. **Do not use it on serverless**: the successor invocation is a different process and would restore nothing.
- **No lease across instances.** `acquireLease` still runs and still answers correctly, but the only competitor it can ever see is another `runTicker` in this process. It is a re-entrancy guard here, not a split-brain guard.

Which makes it right for exactly two shapes: **a single VM** (or container, or Pi) running one long-lived Node process, where the lease and the checkpoint were already formalities because nothing was going to kill it; and **a local dev loop**, with no service to start and no port to remember. The moment you want two instances, a rolling deploy that keeps rooms alive, or survival of a crash, swap that one line back to `getRedis()`/`createSubscriber` and change nothing else.

`ioredis` is still needed to *install*, even here. The subpath keeps it out of `createMemoryRedis`'s own import graph, but `tickroom/adapters/node` reaches the server barrel for `runTicker`, `admitSocket` and the token check, so the module still loads on this wiring. Nothing connects.

**A Redis DB INDEX DOES NOT ISOLATE TWO DEPLOYMENTS, and `namespace` does.** Pointing staging at `/1` and production at `/0` looks like separation and is not: keys are per database, but **pub/sub is instance-wide**, so the two deployments publish into the identical `room:pong:in` and `room:pong:out` channels. Measured: each acquires its own lease against its own `room:pong:lease` key, so both believe they are the exactly-one writer, and each one's relays forward the other's snapshots to their players. Two authorities, no error anywhere, and the lease mechanism cannot see it because it is doing its job correctly on each database separately. `namespace` is the seam that actually works, because it prefixes keys **and** channels together:

```ts
createTickerRoute({ ...tickerOpts, namespace: 'staging' });
createRelayRoute({ ...relayOpts, namespace: 'staging' });
```

Both routes, the same string: a namespace on one and not the other splits the room in half. (There is a second reason to leave the DB index alone, in `AGENTS.md`: ioredis re-issues `select(db)` on every reconnect with nothing catching the promise, so the shared client belongs on db 0.)

---

## Quickstart

### 1. Write your simulation

Nothing here knows about sockets, Redis, or a platform. That is the point.

```ts
import type { RoomRuntime } from 'tickroom/core';

interface Player { x: number; y: number; vx: number; vy: number; }
interface State {
  tick: number;
  players: Map<string, Player>;
  /** Server-side playout depth per player. See `onBufferHealth` below. */
  depth: Map<string, number>;
}

/** Units per second, per axis. Exported because the client bounds its own correction glide with it (step 3). */
export const PLAYER_SPEED = 40;

/**
 * One player, one tick, and THE CLIENT RUNS THIS EXACT FUNCTION on its own
 * player (step 3). That is the payoff of stamping an input with the tick it
 * applies on: both ends run the same rule on the same input on the same tick
 * and land on the same place, so a snapshot confirms the prediction rather
 * than correcting it. Share it; never retype it. Pure, and it clamps what
 * came off the wire, so the client's copy cannot skip the clamp either.
 */
export function stepPlayer(p: { x: number; y: number }, input: { x: number; y: number }, dt: number) {
  const vx = Math.max(-1, Math.min(1, input.x));
  const vy = Math.max(-1, Math.min(1, input.y));
  return {
    x: Math.max(0, Math.min(100, p.x + vx * dt * PLAYER_SPEED)),
    y: Math.max(0, Math.min(100, p.y + vy * dt * PLAYER_SPEED)),
  };
}

export const pong: RoomRuntime<State> = {
  tickHz: 20,

  create: () => ({ tick: 0, players: new Map(), depth: new Map() }),

  tick(s, dt) {
    for (const p of s.players.values()) Object.assign(p, stepPlayer(p, { x: p.vx, y: p.vy }, dt));
    s.tick += 1;
  },

  currentTick: (s) => s.tick,
  playerCount: (s) => s.players.size,

  // Buffer stamped inputs and apply each on EXACTLY the tick it names, so this
  // simulation and a predicting client run the same input on the same tick.
  // Returning true unconditionally is the usually-right answer: an unstamped
  // input (`targetTick: 0`) still applies on arrival either way.
  usesPlayout: () => true,

  // How many ticks deep this player's buffer is running, reported every tick
  // including starved ones. The buffer lives inside the ticker, so this is the
  // ONLY route by which its depth can reach your state and therefore your
  // snapshot. Echo it back and the client trims its stamping lead to the
  // smallest one that keeps the buffer fed. Skip the hook and the loop is
  // simply inert: an optimisation lost, not a working connection lost.
  onBufferHealth(s, pid, health) {
    s.depth.set(pid, health);
  },

  // Idempotent on purpose: the relay republishes a join every second as a
  // heartbeat, and a reconnecting player rejoins under the same id. A join
  // that reset position would teleport a live player once a second.
  join(s, pid) {
    if (!s.players.has(pid)) s.players.set(pid, { x: 50, y: 50, vx: 0, vy: 0 });
  },

  leave(s, pid) {
    s.players.delete(pid);
    s.depth.delete(pid);
  },

  applyInput(s, pid, input) {
    const p = s.players.get(pid);
    if (!p) return;
    const { x, y } = input.data as { x: number; y: number };
    p.vx = Math.max(-1, Math.min(1, x));
    p.vy = Math.max(-1, Math.min(1, y));
  },

  serialize: (s) => JSON.stringify({ tick: s.tick, players: [...s.players] }),

  deserialize(json) {
    const raw = JSON.parse(json) as { tick: number; players: [string, Player][] };
    // `depth` is deliberately not serialised: it describes the ticker that is
    // exiting, not the room.
    return { tick: raw.tick, players: new Map(raw.players), depth: new Map() };
  },

  encodeSnapshot(s, serverTime) {
    return JSON.stringify({
      tick: s.tick,
      serverTime,
      players: [...s.players],
      depth: [...s.depth],
    });
  },
};
```

### 2. Mount four routes

```ts
// app/api/ticker/route.ts
import { createTickerRoute } from 'tickroom/adapters/vercel';
import { pong } from '@/sim/pong';

// Literals, always. See the note under the fourth route.
export const runtime = 'nodejs';
export const maxDuration = 800;

export const GET = createTickerRoute({
  runtime: pong,
  secret: process.env.SESSION_SECRET!,
  isValidBase: (b) => b === 'pong',
  fallbackRoom: 'pong',
  // THE ONE NUMBER THAT COUPLES THIS LIBRARY TO YOUR PLATFORM, and it is the
  // same number this file exports as `maxDuration`, in seconds: the tick loop
  // stops at min(700s, maxDurationS * 1000 - 30s), because the final
  // checkpoint, the lease release and the successor spawn all happen after the
  // loop and the platform must not kill them. Lower it on a lower plan limit
  // and the lifetime follows; raising it does NOT extend the loop past 700s.
  maxDurationS: 800,
});
```

```ts
// app/api/ws/route.ts
import { experimental_upgradeWebSocket } from '@vercel/functions';
import { createRelayRoute } from 'tickroom/adapters/vercel';

export const runtime = 'nodejs';
export const maxDuration = 800;

// Module scope, so these live as long as this instance does and every socket
// it serves shares one flush. See `onBadInput` below for why the counting and
// the flushing have to be separate.
let badInputs = 0;
let rateDrops = 0;
setInterval(() => {
  if (badInputs || rateDrops) console.warn('relay.input-refused', { badInputs, rateDrops });
  badInputs = 0;
  rateDrops = 0;
}, 10_000);

export const GET = createRelayRoute({
  secret: process.env.SESSION_SECRET!,
  isValidBase: (b) => b === 'pong',
  fallbackRoom: 'pong',
  maxPlayers: 20,
  // Relative, so it resolves against this request's own origin: fine as
  // long as the ticker route lives in the same deployment, which is the
  // common case and what the ticker route above sets up.
  tickerUrl: '/api/ticker',
  // Same coupling, other lifetime, same number as `maxDuration` above. The
  // relay announces `relay-expiring` and closes at maxDurationS * 1000 - 10s,
  // and the client swaps to a replacement socket before it does, so the
  // function's own cap costs no visible gap. Without this the socket is simply
  // dropped every ~13 minutes.
  maxDurationS: 800,
  // `decodeInput`'s parameter is `unknown`, not `ArrayBuffer`: the real
  // transport behind this route is the `ws` package, which hands a
  // `Buffer` (or an ARRAY of them for a fragmented message, which a peer or a
  // proxy chooses for itself and which nothing about a frame's size
  // prevents), so normalise before decoding rather than assuming a
  // browser-style ArrayBuffer. `Buffer.concat` is the whole of it.
  // One JSON array of `{ targetTick, data }` per message, which is what
  // `PredictedEntity` sends in step 3 (the last six ticks, re-sent whole, so
  // a lost packet is not a starved tick). A single object is accepted too.
  decodeInput: (buf) => {
    const parsed = JSON.parse(new TextDecoder().decode(Array.isArray(buf) ? Buffer.concat(buf) : (buf as Buffer)));
    return Array.isArray(parsed) ? parsed : [parsed];
  },
  // WIRE `onBadInput`. A decoder that throws is caught and dropped in
  // silence, by design (this path runs at the client's own rate, so a log
  // line per bad frame is an amplifier handed to whoever is sending them),
  // which means the ONLY symptom of a broken decoder is one player whose
  // inputs stop while the room, the roster, the snapshots and every other
  // player stay perfectly healthy. Nothing closes, nothing warns. Count it
  // in process and flush on your own cadence, never per event:
  // `examples/node-server/server.ts` does exactly that, per socket, every
  // ten seconds, in five lines. `onRateDrop` is its twin for the frames the
  // token bucket rejects before the decoder ever runs.
  onBadInput: () => void (badInputs += 1),
  onRateDrop: () => void (rateDrops += 1),
  upgradeWebSocket: experimental_upgradeWebSocket,
});
```

```ts
// app/api/session/route.ts
import { makeToken } from 'tickroom/server';

export const runtime = 'nodejs';

// What `mint()` in step 3 calls. The token carries the claims the relay will
// trust for the whole socket's life, and it EXPIRES: claims are baked in here
// and no auth provider is consulted again on the socket path (that is the
// point, it keeps an auth outage off the hot path), so without an expiry a
// token kept from a paid tier stays redeemable forever after the subscription
// lapsed. `pid` is a random id here because this quickstart has no accounts;
// use your own user id the moment you have one, because it is also the key the
// per-subject socket cap counts against.
export async function POST(req: Request): Promise<Response> {
  const pid = crypto.randomUUID();
  const handle = Math.floor(Math.random() * 65535);
  const token = makeToken({ pid, handle, sub: `d.${pid}` }, { secret: process.env.SESSION_SECRET! });
  const room = new URL(req.url).searchParams.get('room') ?? 'pong';
  return new Response(JSON.stringify({ token, playerId: pid, handle, room }), {
    headers: { 'content-type': 'application/json' },
  });
}
```

```ts
// app/api/room/route.ts
import { createBalancerRoute } from 'tickroom/adapters/vercel';

export const runtime = 'nodejs';

// Answers `{ room, base, index, full? }`: which physical room instance a
// joiner should land in. Step 3's `mint()` calls this FIRST, before
// `/api/session`, so the session it asks for names the room the balancer
// actually placed it in; it calls this again, this time with `?not=` naming
// every room that has already refused this client, whenever `onTerminal`
// sees a `'capacity'` terminal. Keep every refused room, not just the last
// one: see the re-assign recipe under "Things worth knowing".
//
// No `secret` here, unlike the two routes above: this route takes no token
// and reads no claims. It only reads one stats key per candidate room and
// hands back an index, and that stats key has a 5s TTL while the ticker
// enforces capacity authoritatively, so a stale answer here costs a bounced
// connect, never a wrong one.
//
// `maxRooms` is left unset, same as the ticker and relay routes above, so
// all three default to the same `MAX_ROOMS_PER_BASE` (50). AND THE THREE
// VALUES MUST AGREE: a balancer at 50 against a relay at 4 hands out
// `pong~7`, which the relay then refuses as out of range and silently
// replaces with the fallback room, while every signal on both ends reads
// healthy and the player sits alone in a room nobody else can see them in.
export const GET = createBalancerRoute({
  isValidBase: (b) => b === 'pong',
  fallbackBase: 'pong',
  maxPlayers: 20,
});
```

**`runtime` and `maxDuration` are literals in all four files, and `maxDuration` must equal the `maxDurationS` beside it.** Next's route-segment-config parser reads those two exports out of the source text at build time, so `export const runtime = tickerRouteConfig.runtime` fails the build ("Next.js can't recognize the exported `runtime` field in route. It needs to be a static string"); `tickerRouteConfig`/`relayRouteConfig` are still exported as the one place to read the numbers this library expects, but they are documentation, not something to re-export.

`upgradeWebSocket` is **injected, not imported**. tickroom takes no hard dependency on any platform, so the same server core runs behind plain `ws` on a VM (see `adapters/node.ts`).

**`maxDurationS` has a floor as well as a ceiling, and both routes throw at creation if you miss it.** Each derivation is a subtraction (`maxDurationS * 1000` minus a 30s ticker margin, minus a 10s relay margin), so a small enough number produces a *negative* lifetime rather than a short one: `maxDurationS: 10` derived a ticker `maxRunMs` of -20000 and a relay `lifetimeMs` of 0, which announced `relay-expiring` and closed every socket the instant it arrived. `MIN_TICKER_RUN_MS` (10s) and `MIN_RELAY_LIFETIME_MS` (`2 * RELAY_EXPIRY_LEAD_MS + 1000`, so 11s, because a lifetime has to hold the swap's own lead AND a lead of clearance before the next relay announces) are checked on the *resolved* number at route creation, which is module evaluation, so a deployment whose numbers do not fit fails on the first request rather than on every handoff for the rest of its life.

**Both numbers above are 800 because that is a Pro plan's cap; 300 is the platform default and the Hobby cap**, which makes the ticker's handoff period 270s and the relay's swap period 290s instead of 700s and 790s. Both configurations were measured on a real Pro deployment, at zero server ticks lost per handoff either way: six warm swaps of six at 300, and six of six again at 800 over 27 minutes. **On a project with Vercel Authentication turned on, turn it off** (or set `VERCEL_AUTOMATION_BYPASS_SECRET` and send it on the spawn): Deployment Protection guards every request to the deployment including one function calling another, so it answers the relay's own fire-and-forget spawn of the ticker route with an SSO redirect, and because that spawn is caught and discarded by design the only symptom is a room that joins, seeds its roster, and then never ticks.

**One more coupling if you set `standbyMs` yourself.** The standby successor is spawned `standbyLeadMs` (3000) before the cap and polls the lease until it wins or gives up, so `standbyMs` has to comfortably exceed that lead **plus the incumbent's own exit**: the lease is released after the final checkpoint and the release, not at the cap itself. The routes pass 8000 against 3000. It also has to fit *inside* `maxRunMs`, because a standby's poll is spent out of the same lifetime budget the platform is measuring from the moment the request arrived. Leave both alone and the defaults already satisfy this.

**Every server option is reachable from these two factories.** The route option types are `HostTickerOptions`/`HostRelayOptions` intersected with the handful of fields a route genuinely owns, and the bag is *spread* into `runTicker`/`attachRelay` rather than copied field by field. So `init`, `geomKey`, `onGeomMismatch`, `metaPayload`, `metaSeedPayload`, `statsLabels`, `presenceTimeoutMs`, every observability hook and every bound are all just extra keys here. They used to be a hand-picked subset, and a field a type does not name is not an error, it is simply never passed on: twenty options were unreachable that way, with nothing anywhere reporting it.

### 3. Connect from the browser

```ts
import { PredictedEntity, RoomConnection, SnapshotInterpolator, type SessionInfo } from 'tickroom/client';
import { PLAYER_SPEED, stepPlayer } from '@/sim/pong';

interface Snapshot {
  tick: number;
  serverTime: number;
  players: [string, { x: number; y: number }][];
  /** From `onBufferHealth`, per pid. Optional on the wire, optional here. */
  depth: [string, number][];
  /** The one field `RoomConnection` reads out of this: your own pid's depth. */
  inputLead?: number;
}

// The key type is REQUIRED and it is the one decision here. Pids are strings
// everywhere in tickroom, so a JSON room like this one is keyed by `string`;
// a room on the default binary codec is keyed by `number`, because
// `CodecEntity.id` is one. There is no default, precisely because there is no
// answer that is right for both.
const interp = new SnapshotInterpolator<string>();

// Yours, not tickroom's: a HUD, the input state your controls write into, and
// a renderer. Stubbed here so this block compiles as written; replace all
// three with the real thing. Nothing here predicts anything: that is
// `PredictedEntity`'s job, below the connection.
const banner = { toggle: (stalled: boolean) => {}, terminal: (msg: string) => {} };
const input = { x: 0, y: 0 };
function draw(id: string, x: number, y: number) {}

let myPid = '';
let myRoom = '';
// Every room this client has been bounced FROM by a capacity terminal, so a
// re-assign never lands back on one. See `mint` and `onTerminal` below, and
// the re-assign recipe under "Things worth knowing".
let refused: string[] = [];
let tries = 0;

// BOTH TYPE ARGUMENTS, WRITTEN OUT. They are inferable (`decodeSnapshot`'s
// return type fixes the first, `interpolate.into` fixes the second), and
// writing them anyway is what makes a mistake in either one an error HERE
// rather than a widened `DecodedSnapshotLike` reaching `interpolate.entities`
// and `onSnapshot` several lines later.
const conn = new RoomConnection<Snapshot, string>({
  // MUST EQUAL YOUR `RoomRuntime.tickHz`. It drives the tick counter's step,
  // `estimateServerTick`'s slope and the underrun threshold at once, so a
  // mismatch is a silent multiplier on all three rather than an error.
  //
  // The symptom, if you ever see it: `onTickReanchor` firing every couple of
  // seconds with a delta of the SAME SIGN every time (the counter running at
  // the wrong slope, dragged back on a timer it can never catch), and
  // `inputLead` pinned at 0 because the playout buffer is starved on every
  // tick it was stamped for. A connection that looks healthy in every other
  // number.
  tickHz: 20,

  // YOU DO NOT HAVE TO RECOGNISE THAT SYMPTOM, because the server states its
  // own rate on every pair of snapshots (a tick delta and a `serverTime` delta
  // IS a rate) and the connection reads it back to you.
  // `conn.stats().serverTickHz` is that measurement, a median over the last
  // few seconds, and this fires once per epoch once the two have disagreed by
  // more than a fifth for 40 consecutive snapshot pairs. Nothing else changes
  // on the strength of it: the counter, the lead and the clock all keep
  // running on the rate YOU configured, because a class that quietly adopted
  // the measured one would be guessing a number the host is supposed to know.
  onTickRateMismatch: (hz) => console.error(`tickHz is 20 here and ${hz} on the server`),

  // CHECK `res.ok`. A 401 or a 500 body is valid JSON too, and without this it
  // becomes the session: every URL then carries a literal `undefined` and the
  // reconnect ladder loops with nothing ever latching. The connection also
  // validates the shape it gets back, but a failed request is yours to notice.
  //
  // AND SIZE THE TOKEN'S `maxAgeS` AGAINST THE RELAY LIFETIME CHAIN, NOT
  // AGAINST ONE RELAY. The warm swap at a relay's cap reuses the session
  // already on hand, so a token that expires part way along the chain has
  // every replacement after it refused and every cap back to costing a cold
  // reconnect, silently. `conn.stats().swapsFailed` climbing with
  // `swapsAttempted` is that, and it is the only symptom.
  mint: async (): Promise<SessionInfo> => {
    // Ask the balancer which room to use BEFORE minting a session for it,
    // and pass every room this client has already been bounced from so a
    // re-assign never lands back on one (`refused`, above; `createBalancerRoute`
    // in step 2).
    const roomUrl = new URL('/api/room', location.href);
    roomUrl.searchParams.set('base', 'pong');
    if (refused.length) roomUrl.searchParams.set('not', refused.join(','));
    const roomRes = await fetch(roomUrl);
    if (!roomRes.ok) throw new Error(`room assign failed: ${roomRes.status}`);
    const { room } = (await roomRes.json()) as { room: string };

    const res = await fetch(`/api/session?room=${encodeURIComponent(room)}`, { method: 'POST' });
    if (!res.ok) throw new Error(`mint failed: ${res.status}`);
    const session = (await res.json()) as SessionInfo;
    myPid = session.playerId;
    myRoom = session.room;
    return session;
  },

  decodeSnapshot: (buf) => {
    const snap = JSON.parse(new TextDecoder().decode(buf)) as Snapshot;
    // Pick YOUR OWN pid's depth out and hand it back as `inputLead`. That
    // closes the loop the runtime's `onBufferHealth` opened, and the
    // connection trims its stamping lead toward a two-tick cushion. Omit it
    // and nothing breaks; the RTT-compensated lead applies on its own.
    //
    // `inputLead: mine?.[1]` compiles too, because the library declares the
    // field `inputLead?: number | undefined` rather than `inputLead?: number`.
    // That is deliberate and it is the rule every optional on a PUBLIC type in
    // this library follows: `exactOptionalPropertyTypes` is on in a stock
    // `tsc --init`, and under it a bare `?: number` accepts an absent key but
    // NOT an `undefined` value, which turns every `?.` at a call site into a
    // compile error. Write it whichever way reads better in your codec.
    const mine = snap.depth.find(([pid]) => pid === myPid);
    return mine ? { ...snap, inputLead: mine[1] } : snap;
  },

  // The connection pushes every snapshot into the interpolator with the right
  // timestamps and clears it on every reconnect. You say which parts move.
  interpolate: {
    into: interp,
    entities: (snap) => new Map(snap.players),
  },

  // YOUR OWN ENTITY'S AUTHORITATIVE POSE, once per snapshot. The entity
  // replays the records it stamped after `snap.tick` from it and glides any
  // difference away; on a healthy link that difference is zero.
  onSnapshot: (snap) => {
    const mine = snap.players.find(([pid]) => pid === myPid);
    if (mine) me.reconcile(mine[1], snap.tick);
  },

  onStallChange: (stalled) => banner.toggle(stalled),

  // OPTIONAL, AND TELEMETRY ONLY. The tick counter just jumped by this much
  // (a handoff, a backgrounded tab, a clock step), and the delta can be
  // NEGATIVE. This used to be load bearing: a host that deduped its sends by
  // a last-stamped-tick high-water mark had to move that mark by the delta
  // here, or a `if (t <= lastSentTick) return;` guard went silent until the
  // counter climbed back past it, measured on a real socket at 5.6 seconds of
  // input silence and 100 self-inflicted starves from one backward re-anchor.
  // `PredictedEntity` reads the jump off the counter itself and resets its own
  // mark and window, so nothing is required here any more. Count it if you
  // want to know how often it happens; a hidden tab fires it about every two
  // seconds, and that is not a fault.
  onTickReanchor: (deltaTicks) => {},

  // A terminal is a connection this class will not recover from on its own.
  // `'capacity'` is the one worth handling: it means this room instance is
  // full, and `remint: true` is what lets your session endpoint consult the
  // balancer and hand back a different instance. Bound the loop.
  //
  // RESTARTING FROM IN HERE IS SAFE: `onTerminal` is the LAST thing the
  // connection does, after it has latched, closed the old socket and settled
  // the status, so the socket `start()` opens synchronously is not torn down
  // behind you. That restart also never rejects: an unusable re-mint counts
  // toward the bad-mint budget and latches `'mint-failed'` rather than
  // throwing at a `void`ed promise nobody is holding. Only a first, awaited
  // `start()` throws.
  onTerminal: (reason) => {
    if (reason === 'capacity' && tries++ < 3) {
      if (myRoom) refused.push(myRoom);
      void conn.start({ remint: true });
      return;
    }
    banner.terminal({
      capacity: 'This room is full.',
      'conn-limit': 'Already connected in another tab.',
      'version-skew': 'Update needed. Reload to continue.',
      'closed-by-server': 'Session ended.',
      'connect-error': 'Could not reach the room. Reload to try again.',
      'mint-failed': 'Could not start a session. Reload to try again.',
      stopped: '',
    }[reason]);
  },
});

await conn.start();

// YOUR OWN ENTITY, PREDICTED LOCALLY. The interpolation delay is right for
// everyone else's entities and wrong for the one you are steering, so this one
// runs the stamped path instead: one record per TICK (never per frame, never
// per keydown) carrying the tick it applies on, predicted here through the
// SAME pure step the runtime runs, the last six records re-sent on every
// packet so a lost packet is not a starved tick, replayed from every snapshot,
// corrected as a glide rather than a teleport (a snap on the first
// confirmation and whenever the offset would grow past half a second of
// travel), and drawn from a render playhead that moves at real time through
// its recent poses, one tick behind the newest, so it moves at the frame rate
// instead of stepping at the tick rate and a counter re-anchor is caught up
// over a second rather than drawn as a lurch. Four coupled rules, and this
// object owns all of them: one call per frame, one per snapshot, nothing to
// keep in step. Its timestep is read off `conn.tick.tickMs`, so there is no
// second `tickHz` here to disagree with the one above. AND THERE IS ONE PER
// CONNECTION: this object IS your input stream (the server keeps one playout
// buffer per player), so a player steering several things carries them all
// in one input record and one step, and a second entity on the same
// connection throws rather than overwriting the first's records tick by tick.
const me = new PredictedEntity<{ x: number; y: number }>({
  conn,
  step: stepPlayer,
  maxSpeed: PLAYER_SPEED,
  initial: { x: 50, y: 50 },
});

// THE ONE PER-FRAME CALL, and then the entity's, in that order. `conn.frame()`
// advances the tick counter inputs are stamped against, polls the stall
// detector, and samples the interpolator, from one delta it measures itself.
// `me.advance()` after it stamps whatever ticks the counter crossed with the
// input as HELD STATE (a lost packet then costs nothing: the next tick
// re-asserts the same intent), sends them, and returns the pose to draw.
function frame(now: number) {
  const { entities, dt } = conn.frame(now);
  const own = me.advance({ x: input.x, y: input.y }, dt);
  for (const [id, e] of entities) if (id !== myPid) draw(id, e.x, e.y);
  draw(myPid, own.x, own.y);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

**Throw `ProtocolVersionError` out of `decodeSnapshot` on a wire mismatch.** The connection's skew recovery (reload once, then latch `'version-skew'`) fires on a returned `version` field *or* on a thrown error whose `name` is `'ProtocolVersionError'`, and the second is what a binary codec actually does: `decodeDefaultSnapshot` checks the version before reading a single field and throws exactly that. It is duck-typed on the name, so your own codec can participate without importing anything. A decoder that swallows the mismatch instead leaves every old client silently dropping every frame after a deploy, with nothing reloading and nothing latching.

That is the whole browser integration, upstream and down. You now have
reconnect-with-backoff, session re-minting, a smoothed server clock,
server-timeline interpolation that adapts to measured jitter, never-freeze
extrapolation, and a stall detector that can tell a dead room from a slow one.

**Every callback above is called inside a catch, and `conn.stats().hostErrors`
is how you find out.** A throw out of `onStatus`, `onTerminal`,
`onTickReanchor`, `onStallChange`, `onText`, `onSnapshot` or the
`interpolate.entities` selector costs that one call and nothing else, because
the reconnect ladder is driven by a `void`ed promise and an escaping throw used
to stop it dead: status stuck on `connecting`, no timer, no terminal, forever.
Surviving it is the right behaviour and being silent about it is not, so the
count is the signal. A healthy client reads 0 for its whole lifetime; anything
else is a bug in your own callback that nothing else will tell you about.

**Headless or non-browser clients.** Nothing above is browser-only, and the two
globals it reaches for each have an option that replaces them. `socketUrl(session)`
builds the whole URL yourself, which is what you want off-browser because the
default builder reads `location` and throws without one; `path` is the lighter
version of the same escape hatch, changing only the path component of that
default (`/api/ws`) and ignored entirely when `socketUrl` is supplied. And
`WebSocketImpl` takes the constructor, so a load test, a bot, or a Node
integration test runs the identical class:

```ts
import WebSocket from 'ws';
import { RoomConnection, type SessionInfo } from 'tickroom/client';

new RoomConnection<Snapshot, string>({
  tickHz: 20,
  mint: async (): Promise<SessionInfo> => {
    const res = await fetch(`${BASE}/api/session?room=pong`, { method: 'POST' });
    if (!res.ok) throw new Error(`mint failed: ${res.status}`);
    return (await res.json()) as SessionInfo;
  },
  socketUrl: (s) =>
    `ws://localhost:3100/api/ws?token=${encodeURIComponent(s.token)}` +
    `&pid=${encodeURIComponent(s.playerId)}&h=${s.handle}&room=${encodeURIComponent(s.room)}`,
  WebSocketImpl: WebSocket,
  decodeSnapshot: (buf) => JSON.parse(new TextDecoder().decode(buf)) as Snapshot,
});
```

`SessionInfo` is `{ token, playerId, handle, room }` plus whatever else your
own session route returns (it carries an index signature for exactly that), and
it is the only thing `mint` has to produce: those four fields are what the
default URL builder interpolates and what the one above does by hand. There is
no cast on `WebSocketImpl`: `ws`'s class, the DOM `WebSocket` and Node's own
global all assign to `WebSocketConstructor` directly, and a compile-only case
in `connection.test.ts` fails if that ever stops being true.
`examples/node-server/README.md` runs one of them end to end.

**What `conn.send` will not check for you.** It takes
`ArrayBuffer | Uint8Array | string`, so the payload shape is yours: the relay's
`decodeInput` in step 2 is the only thing that reads it, and the two have to
agree. `PredictedEntity` sends one JSON array of `{ targetTick, data }` records
per message as a text frame (the last six ticks, oldest first), and the
`decodeInput` in step 2 parses exactly that; a host stamping by hand can send
whatever its own decoder reads. Everything else about the client is typed end
to end, so this is the seam to get right.

**The roster arrives on `onText`, and it is typed.** The relay seeds a joining
socket with a roster frame and the ticker broadcasts one on every change:

```ts
import { isRosterFrame } from 'tickroom/client';

onText: (msg) => {
  if (!isRosterFrame(msg)) return;
  setPresence(Object.keys(msg.map)); // keyed by pid; values are your joinMeta
},
```

---

## What you get, and what it is actually for

| Piece | What it solves |
| --- | --- |
| `runTicker` | The authoritative loop. Lease, restore, tick, publish, checkpoint, hand off. Spawns a **standby** successor before its cap, probes its own input subscription for liveness, and counts crashes so a poisoned checkpoint cannot loop forever. |
| `attachRelay` | One socket to the bus. Rate limiting, liveness, roster seeding, join heartbeat, plus **drop-don't-queue** snapshot backpressure, a direct **ping echo** for the client's round trip, a **bounded subscribe**, and a warm **lifetime handoff** so the function's own cap costs no visible gap. The liveness deadline defaults to **90s** because a browser, not your client, chooses the ping interval once a tab is hidden; `RelayHandle.transportPings` reports whether the transport could supply a protocol ping at all. |
| `RoomStats` | What the room measures about itself, flushed on `statsMs`. Beside `starves`, `lateInputs`, `publishSkipped` and `hostErrors`: **`refusedInputs`** counts stamps sitting further **ahead** of the consumed floor than `playoutMaxAhead` allows (a sender running *behind* is never refused; those are late and land on `lateInputs`), and **`rejectsSuppressed`** counts `room-reject` frames withheld because one had already gone to that pid inside the last second. Both reset per flush. |
| `admitSocket` | The whole admission sequence in one call: check, warn, refuse with the right code, register, attach, unregister on close. One definition, not one per adapter. |
| `assignRoom` | Packs joiners into the lowest-index room with space, so empty rooms drain. |
| `acquireLease` / `OwnershipClock` | Exactly-one-writer, and the two-clock rule that makes it hold under failure. |
| `writeCheckpoint` | Gzipped room state with a TTL, magic-byte sniffed so rolling deploys are safe, and **owner-checked in Redis** so an ex-owner cannot overwrite its successor. |
| `PlayoutBuffer` | An input lands on the *same tick* at both ends despite jitter. |
| `Inbox` | Backpressure with a per-sender quota, so one flooder degrades only themselves. |
| `RoomConnection` | Reconnect, resume, re-mint, clock sync, protocol-skew recovery, a **real measured round trip**, and a **warm swap** at the relay's lifetime cap that the player never sees. |
| `conn.frame(now)` | The one per-frame call: advances the tick, polls the stall, returns the poses to draw. |
| `conn.tick` | The monotonic counter an input's `targetTick` is stamped from. Anchored per epoch to a **measured** lead (RTT + jitter headroom + optional server-depth feedback), advanced by `frame()`. Its `fraction` is how far it is into the next tick, 0 to 1, and its `tickMs` is the interval it was built with: `PredictedEntity` reads both, the one as its render target and the other as its timestep, so there is no tick rate to state twice. |
| `PredictedEntity` | Your own entity, the one the interpolation delay is wrong for. One object owns the whole stamped path's client half: one record per tick predicted through the **same pure step** the runtime runs, the last six re-sent on every packet, a replay from every snapshot into a bounded **glide** (a snap on the first confirmation and whenever the offset would grow past half a second of travel, so nothing is ever trimmed in silence), a render **playhead** that moves at real time (within a tenth) through the recent poses one tick behind the newest, so a counter re-anchor is caught up over a second and a frozen tab is one counted snap rather than a lurch, and the re-anchor handling read off the counter itself. `advance` once per frame, `reconcile` once per snapshot, `conn`, `step`, `maxSpeed` and `initial` the only options, and none for the four rules a host used to get wrong. |
| `conn.stats()` | `rttMs`, `jitterMs`, `snapshotsReceived`, `rejectedSnapshots`, `underrunRate`, `reconnects`, `relaySwaps`, `swapsAttempted`, `swapsFailed`, `serverTickHz`, `hostErrors`. Gauges reset per epoch, counters are lifetime. `serverTickHz` and `hostErrors` exist because a wrong `tickHz` and a throwing host callback were both completely silent. |
| `swapsAttempted` / `swapsFailed` | Warm swaps **started** at a relay's lifetime cap, and warm swaps that ended **without delivering**. Both lifetime counters, and `swapsAttempted - relaySwaps - swapsFailed` is 0, or 1 while one is in flight. `swapsFailed` tracking `swapsAttempted` means every relay lifetime cap is still costing a visible reconnect; the usual cause is a session `maxAgeS` shorter than the relay lifetime chain, so **size the token against the chain rather than against one relay**. |
| `SnapshotInterpolator` | Other entities move smoothly. Adapts to measured jitter, never freezes, and unwinds its own extrapolation as a glide. |
| `ErrorOffset` | A correction becomes a glide instead of a teleport. |
| `stallDecision` | Tell the player the world is gone, without crying wolf on a routine handoff. |
| `ByteWriter` / `quantize` | The wire format, because fan-out bandwidth is the bill. Integer fields **refuse** rather than wrap; NaN is refused rather than encoded as the origin. |
| `CLOSE_CODES` / `SERVER_FRAMES` | The control-plane contract, defined once and imported by both ends. |
| `MIN_TICKER_RUN_MS` / `MIN_RELAY_LIFETIME_MS` | The **floors** on the two derived lifetimes, beside the margins they are derived with (`TICKER_EXIT_MARGIN_MS` 30s, `RELAY_EXIT_MARGIN_MS` 10s, `RELAY_EXPIRY_LEAD_MS` 5s). Both derivations are subtractions, so a `maxDurationS` that is small enough produces a negative lifetime rather than a short one: the routes **throw at creation** instead. See the note under step 2. |

---

## Things it is worth knowing before you build on this

Each of these cost real production time to learn. They are documented at length in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and in the source comments.

**The lease needs two clocks, not one.** `lastRenewAt` paces attempts, `lastOwnedAt` records confirmed ownership. Collapse them and a ticker whose renews are all *failing* keeps refreshing its own guard, so the guard can never fire in the one situation it exists for.

**A checkpoint must carry a digest of the world it was simulated against.** Otherwise a deploy that moves a wall leaves every live room restoring and re-saving a simulation of the old world forever, because each successor faithfully restores its predecessor's bytes. Silent, permanent, invisible in every metric.

**Capacity must be read from one key.** If the relay and the balancer read different keys, a hard-dead ticker leaves one of them permanently wrong, the balancer keeps handing out a room the relay keeps rejecting, and joiners strand on "full" with no way to heal.

**Keep every room you were refused from, and send them all.** A capacity terminal (`CLOSE_CODES.capacity`, 4002, or a `room-full` frame) names the room in the session you were using, so push that id onto a list and pass the whole list on the next mint: `GET /api/room?base=lobby&not=lobby,lobby~1`. Do not send only the last one. The balancer reads a stats key with a 5-second TTL while the ticker enforces capacity authoritatively, so the two disagree for up to a window, and a single-id exclusion lets a client ping-pong between two rooms until its bounded re-assign budget is gone, which reaches the player as "the game is full" while seats are free. Entries are validated individually against the base, so a stale id from a previous session is ignored without affecting the others, and up to 64 are honoured per request.

**And the three `maxRooms` values must agree.** It is an independent option on the ticker route, the relay route and the balancer route, each defaulting to `MAX_ROOMS_PER_BASE` (50), and a balancer at 50 against a relay at 4 hands a client `lobby~7` that the relay refuses as out of range and silently replaces with the fallback room. The session then says one room and the snapshots come from another, while every signal on both ends reads healthy: socket open, roster populated, tick rate nominal, and the player alone in a game nobody can see them in. The tell is a `ticker.room-normalised` or `relay.room-normalised` warn, one per authenticated request, carrying the raw id that was refused. It is the only symptom this failure has, so wire the routes' `log` before you need it.

**Interpolate remote entities on the SERVER's clock, never on the local arrival clock.** The server emits on a uniform grid and the network smears the arrivals; timing playback against arrival stamps replays that smear as motion, so a burst of packets plays a quarter-second of the world in three milliseconds. Measured on an entity moving at a constant 100 u/s, that read as a peak of 1568 u/s and nine visible backward rewinds, against 261 and zero for the same frames played on the server clock. The arrival stamp is still required, as the sole input to the local-versus-server clock estimate.

**Never freeze a remote entity on interpolation underrun.** Extrapolate for up to 150ms. A frozen entity that then teleports reads far worse than one that drifts and is corrected, and this is the single rule most likely to be optimised away by someone who has not watched it happen.

**The default codec speaks METRES, and a 2D host usually does not.** `encodeDefaultSnapshot` packs each position into an `i16` at centimetre precision by default, which spans **+-327.67 metres**, and out-of-range values CLAMP rather than wrap. Hand it pixels or screen coordinates and everything past 327.67 pins silently at the boundary, which reads as every distant entity piled up against an invisible wall rather than as an encoding error. Set the scale instead: `encodeDefaultSnapshot(snap, { positionScale: 1 })` and the matching `decodeDefaultSnapshot(buf, { positionScale: 1 })` give a pixel host **+-32,767 pixels at 1px resolution**. Then assert your world fits, ONCE at startup, because the clamp is the only other signal you will ever get:

```ts
import { representableRange } from 'tickroom/codec';

const range = representableRange(POSITION_SCALE); // { min, max }, in your units
if (WORLD_MAX_X > range.max) throw new Error('world does not fit the wire');
```

The scale is not on the wire, so encoder and decoder must agree, and changing it changes what the bytes MEAN while moving no byte: that is a protocol version bump, and it is yours to make (the version byte is already in the frame). Pick the smallest field that covers your world plus headroom.

**`DefaultInputRecord.axes` is a normalised stick, and it clamps too.** It is an `i8`, so at the default scale it spans [-1, 1] at 1/127 and `[640, 480]` decodes as `[1, 1]`: every remote entity in one corner, silently. `axisScale` moves the boundary the way `positionScale` does (`{ axisScale: 1 }` gives +-127 at one whole unit, and both ends must agree), but note the part scaling cannot fix: the field is 254 steps wide however it is scaled. That is a stick, not a position. A payload carrying COORDINATES wants its own record on `ByteWriter` at `i16` or wider.

**`CodecEntity.id` throws rather than clamping or wrapping.** It is a `u16`, and an id outside `0..65535` is a `CodecError` at encode time. Positions clamp because an entity pinned at a boundary it nearly reached still reads correctly; an identity has no nearby value, so 65535 is not an approximation of 70000, it is a different player. Derive ids from a join counter and they stay small; derive them from a database row id and this is the error you want.

**Re-send the last few inputs in every packet.** The playout buffer's push is duplicate-overwriting and out-of-order safe, so re-sends are free, and a lost packet stops mattering. `encodeInputWindow` is that mechanism for a stick-shaped input; a positional one re-sends its own last few records the same way.

**`playoutMaxAhead` is a tolerance, and a tolerance is a duration rather than a tick count.** It defaults to two seconds of *your* room's ticks (`max(PLAYOUT_MAX_AHEAD, ceil(2000 / tickMs))`) rather than to a flat number, because the bare 40 is two seconds at 20Hz and 667ms at 60Hz: one constant meaning three different things at three tick rates, while what it tolerates (how far ahead of the room a sender may legitimately stamp) never changed. 20Hz is byte-identical at 40 and 60Hz gets 120. **This is not a bound `RoomConnection` was ever near.** The buffer measures from its consumed floor at arrival and this library's own lead is RTT-compensated, so the round trip cancels and its stamps land within at most 20 ticks of the floor at any rate and any latency. It matters for a third-party client of the documented wire, which may reasonably stamp a full round trip ahead of the server's current tick and which the old constant refused sooner at 60Hz than at 20Hz for no visible reason. Read `RoomStats.refusedInputs` if you set the option yourself: it counts the stamps this bound turned away, and only the too-far-ahead ones. A sender whose clock runs *behind* is never refused, its inputs are applied late and land on `lateInputs` instead.

**The successor spawn belongs in `finally`, and must be awaited but raced.** A room whose ticker died is exactly when it would otherwise sit dead. Fire-and-forget was measurably wrong: as the last thing a handler does, it is post-response IO the platform can suspend before it flushes. The one exception is a ticker that **threw**: it writes no checkpoint and spawns nothing, because the state at the moment of a throw is half-mutated and the successor would restore the very bytes that killed it. Measured before that fix: 40 spawns in 958ms, forever.

**A socket can be dead before the relay ever sees it.** The admission check is a Redis round trip, and the socket can close during it with its `close` event already fired and gone. Attaching anyway produced a permanent zombie holding a slot against the per-user cap until the function's duration cap. `terminate()` on an already-closed socket emits nothing either, which is why the relay runs its own cleanup rather than waiting for an event that may never arrive. If you write your own transport adapter, this is the trap.

**Drop snapshots, never queue them.** The forward from the bus to the socket is the one place this design can turn a deliberately lossy stream into a reliable unbounded queue, and doing that is strictly worse: measured at 7.65MB queued for one paused socket, then replayed as a stale burst that inflates every jitter buffer it lands in. The newest snapshot supersedes every older one, so a dropped frame costs nothing the next tick does not repair. Roster and control frames are the opposite case and are never dropped, because nothing repeats a one-shot.

**The relay's own duration cap is a warm swap, not a drop.** Without it every socket in the fleet reconnects roughly every thirteen minutes on a completely healthy deployment: a visible gap, a re-mint, a fresh subscribe and a re-seeded roster, per player, forever. Pass `maxDurationS` to the relay route and it announces `relay-expiring` five seconds ahead; the client opens a replacement socket and adopts it only once that socket actually delivers.

**And the swap reuses the session it already has, so the token has to outlive the chain rather than one relay.** This is the one failure mode the mechanism makes more likely rather than less: past the session's `maxAgeS` every replacement is refused, with a 401 before the upgrade or a 4001 after it, the swap is discarded, and each cap quietly goes back to the cold reconnect the swap exists to remove. Nothing on the server says so, because from the relay's side a refused socket is an ordinary refused socket. A replacement that closes or errors before delivering therefore marks the session for re-mint on the next connect, so the *following* cap has a token that works. The cached session is not torn up on the spot, because the old socket is still open and still serving: the held poses and the own-pid `room-reject` check both read it in that window. A replacement that merely misses its deadline keeps the session outright, because a slow answer is far more likely to be a cold relay start than a bad token. Both count on `conn.stats().swapsFailed`. Read it against `swapsAttempted`: the two climbing together is this, and the fix is a longer `maxAgeS` on the token rather than anything in the client.

**Route `onBufferHealth` into your snapshot if you want the feedback loop.** The client's stamping lead is an open-loop guess (`measured RTT + your jitter headroom`) until the server tells it how deep the playout buffer is actually running. That quantity only exists inside the ticker, so the path is: `onBufferHealth` writes it into your state, `encodeSnapshot` puts it on your wire, `decodeSnapshot` picks out your own pid's value as `inputLead`. Skip any step and the loop is simply inert, which is an optimisation lost rather than a working connection lost.

**And set the headroom before you reach for the loop.** `inputLeadMs` defaults to **150ms** and that is a swept knee rather than a chosen number: three five-minute three-client runs on a real deployment from a jittery path (round trip medians 87 to 99ms) measured `starves` of 345, 53 and 36 at 100, 150 and 200ms of headroom, over about 6,000 room ticks each. 100 to 150 is a 6.5x cut, because at 100 the cushion is one tick and the feedback loop's two-tick deadband never lifts a buffer that shallow; 150 to 200 buys another 1.5x for one more tick (50ms at 20Hz) of input latency on every action. Mobile, a container or any path with real jitter wants `inputLeadMs: 200`; a measured-lower link wants it down.

**An unplanned death takes 5 to 7 seconds, and the stall banner will fire.** The planned path is fast because the ticker cooperates: it releases the lease and a standby is already waiting. A crash or an instance kill runs none of that, so recovery is the lease TTL plus the relay's jittered poll plus a cold spawn, and the restored checkpoint may be up to `checkpointMs` old, which is a tick **regression** of up to 20 ticks rather than just a gap. Measured end to end on the defaults: 4.7 seconds of silence, the banner at 4.0s, and a 17 tick regression that arrives as an 80 unit rewind in one frame, then four backward frames and an 80ms hold. Design your UI for the banner rather than assuming it never appears.

Two host options move that number, and both are yours to set rather than defaults this library will change for you:

| tune | effect | what it costs |
| --- | --- | --- |
| `leaseTtlMs` / `leaseRenewMs` **3000 / 1000** | silence floor 4.7s to about **3.3s**, under the banner's own threshold | the split-brain margin the whole design rests on, though the 3x renew ratio is unchanged |
| `checkpointMs` **250** | regression 17 ticks to **5** | 4x the checkpoint writes, which is Redis bandwidth, which is the bill |

**And the margin that first row spends is now measured rather than argued.**
`tests/splitbrain.redis.test.ts` runs a predecessor whose Redis path is shaped
by a TCP proxy (a steady 50ms, a steady 400ms, 1s spikes every third renew, and
then dead) against a successor connected straight to Redis, and asks how long
the predecessor keeps publishing after the successor legitimately acquires. The
answer, derived from the code and then measured: **it does not**. Redis extends
the key from the moment it *processes* a renew, ownership is dated from the
*attempt*, a publish needs `now - lastOwnedAt < leaseTtlMs`, and a successor's
`SET NX` succeeds only once the key has expired, so every predecessor snapshot
is issued before the successor can acquire and **the renew round trip does not
enter the margin at all** (for any `leaseTtlMs` above the client's 2000ms
`commandTimeout`). Measured at 1500/400: no shaped distribution lapsed the key
on its own, because renews are paced from the attempt; the key lapsed 1466 to
1476ms after the path died, the successor's first frame landed at 1473 to
1493ms, and the predecessor's last snapshot was issued **469 to 1427ms before
it** every time. A path that heals after the TTL delivers at most four held
frames, measured exactly four. The one case the round trip does reach is a
**theft**, the key deleted under a live owner, which is the documented
Redis-restart case: overlap 40 to 260ms at a 50ms round trip and 965 to 984ms
under the 1s spike, bounded by `min(leaseRenewMs, checkpointMs) + RTT + two
ticks`. So shortening the TTL is still a trade, but it is a trade with a number
on it.

---

## Cost model

Measured on the game this came from, at 20Hz with a full 20-player room:

| | per second |
| --- | --- |
| Per player | ~21 Redis commands |
| Per room, regardless of population | ~23 commands |
| A full 20-player room | ~463 commands |

Three things the audit added cost essentially nothing on that budget, which is why they are on by default. **The client's round-trip ping never touches Redis at all**: the relay answers it directly, which is both what makes the number a true round trip and what makes it free. **The ticker's own liveness probe is one `PUBLISH` per second per room**, on a channel it is already subscribed to, which is under half a percent of the per-room figure above and is the only thing that can detect a subscriber whose TCP path has been black-holed. **The relay's own probe is the same mechanism on the other side of the bus, at one `PUBLISH` per socket per second**, on a channel private to that socket, which is roughly 5% of the per-player figure above. Per connection rather than per room on purpose: a shared probe channel is quadratic in room size and, worse, lets a healthy subscriber answer for a dead one, which is the one signal built to catch this becoming the thing that hides it.

**Fan-out is free in commands and expensive in bandwidth.** One `PUBLISH` reaches every subscriber for one command, so command count does not scale with population. Bytes do: every player socket holds its own subscriber, so a snapshot crosses the wire once per player. `RoomStats.bytesDelivered` measures exactly that.

Pick a **flat-rate** Redis plan. Per-command billing on this traffic shape is roughly two orders of magnitude more expensive than flat-rate, and the same room that costs about $30/month flat costs thousands metered.

**The first ceiling you hit is concurrent connections, not commands.** Every socket needs its own subscriber (a connection in subscribe mode cannot run ordinary commands). That is why the relay enforces a per-user socket cap: without it, one client opening sockets can exhaust the connection ceiling and take the room's own ticker subscriber down with it, which is a total outage rather than a nuisance.

If bandwidth ever becomes the bill, the lever is not a bigger plan, it is ending the per-socket fan-out: one subscriber per room per relay instance, or the ticker off serverless entirely.

---

## Examples

| | |
| --- | --- |
| [`examples/pong`](examples/pong) | Two-player 2D game. Server-authoritative paddles and ball, and the reference for the STAMPED path: tick-stamped inputs, a paddle owned by a `PredictedEntity` running the simulation's own exported step function, and the `onBufferHealth` depth loop closed end to end. |
| [`examples/cursors`](examples/cursors) | Multiplayer cursors, both halves. Not a game at all; realtime presence, at 10Hz with unstamped inputs. |
| [`examples/node-server`](examples/node-server/README.md) | The same simulation on a plain Node `ws` server, no serverless. Its README has the run command, the env knobs, a headless Node client, and recipes for watching a planned handoff and the relay's warm swap. |

Each example is tested, not just illustrative: the round-trip tests prove a
checkpoint genuinely resumes (both rooms ticked forward through identical input
and diffed, which is what catches a field somebody forgot to serialise) and
`examples/pong/codec.ts` works the JSON-to-binary upgrade all the way through,
measured at **243 bytes to 53, 4.58x smaller**, on a realistic two-player
snapshot. `examples/pong/sim.test.ts` runs the stamped claim itself: the
client's `stepPaddleY` and the server's own `applyInput` plus `tick` are
compared per tick over the same stamped records and asserted EXACTLY equal, with
a contrast case applying the identical records on arrival and asserting the two
traces diverge, so the first cannot pass vacuously.

---

## Verification

```bash
npm test                       # 1067 tests, no services needed (63 more skip)
redis-server --port 6399 --save '' --appendonly no --daemonize yes
npm run test:integration       # the same architecture against a real Redis
```

The integration suite skips cleanly (exit 0) when no Redis is reachable, so the
default run stays green offline; with one up the same command is **1130 across 43
files**, all green, and `npx tsc --noEmit` is clean repo-wide including
`examples/`. (`tests/memory.test.ts` is the one file in there that needs nothing
and runs either way, which is the claim it exists to check.) Measured on Redis 8.10.1:

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

### Measured, end to end, on what a client actually renders

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
caveat and it is in the Status list below. What is still untested is **mobile**.

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
purpose and the suite has to notice. `AGENTS.md` carries the whole matrix, one
table per file, re-measured on the current tree. It is worth reading before
changing anything in `lease.ts`, `ticker.ts` or `interpolation.ts`, because a
green test over a guard that cannot fail is the exact trap this library has
fallen into more than once.

### The shipped example, through a real socket

**Everything above drives a runtime written for the harness that drives it.**
This one drives `examples/pong` unmodified, which is the gap CI carried as a
known one for weeks. `tests/example.redis.test.ts` runs the example's own
`pongRuntime` under `runTicker` with `encodePongSnapshot` on the wire, the
adapter's own `attachNodeRelay` on a real `ws` server, and the example's own
`createPongClient` as the client, on a 16ms timer in place of
`requestAnimationFrame`. Nothing about the netcode is retyped in the test: the
decode, the interpolator wiring, the `PredictedEntity`, the
`frame()`-then-`advance()` ordering and the input rule are all the example's.

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

### The other example, and the other input path

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

### Measured on Vercel

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

---

## Non-goals

- **Not a game engine.** No rendering, no physics, no ECS. You bring the simulation.
- **Not lockstep.** State-synchronised with client prediction, not deterministic lockstep. Peers never wait on each other.
- **Not a CRDT.** There is one authority and it is the server. For text or documents with no natural authority, use a CRDT.
- **Not zero-latency.** Clients render other entities 80 to 500ms behind, adaptively, and near the 80ms floor on a clean connection. That delay is what buys smoothness, and it is the correct trade for everything except a competitive shooter.

---

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
come from, and it is written up finding by finding in `AGENTS.md`. Two things it
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
introduced**, and both are written up by name in `AGENTS.md` rather than
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

CI runs the typecheck, the unit tests and the build on every push and PR, plus
the integration suite against a Redis service container. Releases publish from a
tag through npm trusted publishing, so no token is stored anywhere, and the
release workflow now stands up **the same Redis service CI does** and requires
it. That matters more than it sounds: the real-Redis files skip cleanly when
nothing is listening, so without the service the publishing build ran `npm test`
to a green exit having executed zero assertions in the lease, checkpoint,
handoff, subscriber, smoothness and fault-injection suites. A gate that cannot
fail is worse than no gate, and this is the one build whose version number is
burned forever, so the release gate is now at least as strong as CI rather than
weaker.

**What is still open**, mirroring the list `AGENTS.md` keeps:

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
- **The `inputLead` loop's two-tick target is a reasoned default, not a swept
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
- **0.2.0 is not tagged.** The `RedisLike` question that used to sit beside it
  is closed: `createMemoryRedis()` is the second shipped implementation of the
  interface and `tickroom/server/memoryRedis` is the import that reaches it
  without loading `ioredis`.
- **No lint script**, so CI runs no linter.

---

## License

MIT
