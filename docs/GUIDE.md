# The guide

The whole walk-through: install, the four routes, the browser client, testing
your own step, and the things that cost real production time to learn. The
[README](../README.md) is the short version; this is the one with every caveat
still in it.

- [Install](#install), including [one process, no Redis](#one-process-no-redis)
- [1. Write your simulation](#1-write-your-simulation)
- [2. Mount the room](#2-mount-the-room), and
  [the low-level form](#the-low-level-form-the-four-factories)
- [3. Connect from the browser](#3-connect-from-the-browser)
- [Testing your step](#testing-your-step)
- [Things it is worth knowing before you build on this](#things-it-is-worth-knowing-before-you-build-on-this)

Beside it: [`ARCHITECTURE.md`](ARCHITECTURE.md) for why any of this is shaped
the way it is, [`OPERATIONS.md`](OPERATIONS.md) for the cost model, the platform
limits and the release procedure, [`VERIFICATION.md`](VERIFICATION.md) for the
measurements, and [`LEDGER.md`](LEDGER.md) for the dated history.

---

## Install

```bash
npm install tickroom ioredis
```

**This document describes 1.0.0**, which is what `package.json` says and what
the tag publishes. `CHANGELOG.md` has the whole entry, and its "Migrating
from 0.3" list is the break-by-break guide: `conn.frame(now, input)`, the
`predict` option in place of a hand-held `PredictedEntity`, the binary input
wire, and `DecodedSnapshotLike.inputLead` gone.

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
createRoom({ ...opts, namespace: 'staging' });

// or, on the low-level form, once per route:
createTickerRoute({ ...tickerOpts, namespace: 'staging' });
createRelayRoute({ ...relayOpts, namespace: 'staging' });
createBalancerRoute({ ...balancerOpts, namespace: 'staging' });
```

Every route, the same string: a namespace on one and not the other splits the room in half, each side reading and writing keys the other never sees, with a lease acquired on each and no error anywhere. `createRoom` states it once for exactly that reason. (There is a second reason to leave the DB index alone, in [`AGENTS.md`](../AGENTS.md): ioredis re-issues `select(db)` on every reconnect with nothing catching the promise, so the shared client belongs on db 0.)

## Quickstart

### 1. Write your simulation

Nothing here knows about sockets, Redis, or a platform. That is the point.

```ts
import type { RoomRuntime } from 'tickroom/core';
import type { DefaultInput } from 'tickroom/codec';

interface Player { x: number; y: number; vx: number; vy: number; }
interface State {
  tick: number;
  players: Map<string, Player>;
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
 *
 * The input is `DefaultInput` from `tickroom/codec`, a stick and a button
 * mask, because that is the shape the client's default binary wire carries
 * (step 3) and the relay's default decoder hands back (step 2). Any other
 * shape works too, on the JSON wire.
 */
export function stepPlayer(p: { x: number; y: number }, input: DefaultInput, dt: number) {
  const vx = Math.max(-1, Math.min(1, input.axes[0]));
  const vy = Math.max(-1, Math.min(1, input.axes[1]));
  return {
    x: Math.max(0, Math.min(100, p.x + vx * dt * PLAYER_SPEED)),
    y: Math.max(0, Math.min(100, p.y + vy * dt * PLAYER_SPEED)),
  };
}

export const pong: RoomRuntime<State> = {
  tickHz: 20,

  create: () => ({ tick: 0, players: new Map() }),

  tick(s, dt) {
    for (const p of s.players.values()) Object.assign(p, stepPlayer(p, { axes: [p.vx, p.vy], buttons: 0 }, dt));
    s.tick += 1;
  },

  currentTick: (s) => s.tick,
  playerCount: (s) => s.players.size,

  // Buffer stamped inputs and apply each on EXACTLY the tick it names, so this
  // simulation and a predicting client run the same input on the same tick.
  // Returning true unconditionally is the usually-right answer: an unstamped
  // input (`targetTick: 0`) still applies on arrival either way.
  usesPlayout: () => true,

  // Idempotent on purpose: the relay republishes a join every second as a
  // heartbeat, and a reconnecting player rejoins under the same id. A join
  // that reset position would teleport a live player once a second.
  join(s, pid) {
    if (!s.players.has(pid)) s.players.set(pid, { x: 50, y: 50, vx: 0, vy: 0 });
  },

  leave(s, pid) {
    s.players.delete(pid);
  },

  applyInput(s, pid, input) {
    const p = s.players.get(pid);
    if (!p) return;
    const { axes } = input.data as DefaultInput;
    p.vx = Math.max(-1, Math.min(1, axes[0]));
    p.vy = Math.max(-1, Math.min(1, axes[1]));
  },

  serialize: (s) => JSON.stringify({ tick: s.tick, players: [...s.players] }),

  deserialize(json) {
    const raw = JSON.parse(json) as { tick: number; players: [string, Player][] };
    return { tick: raw.tick, players: new Map(raw.players) };
  },

  encodeSnapshot(s, serverTime) {
    return JSON.stringify({
      tick: s.tick,
      serverTime,
      players: [...s.players],
    });
  },
};
```

### 2. Mount the room

Four routes, one call. **Every fact below is stated once and used everywhere it applies**, which is the whole reason this exists: mounting the four routes by hand meant writing the secret, the room validator, the fallback room, the capacity, the namespace and the duration cap into four separate files, and a disagreement between any two of them is silent. A relay admitting 20 against a balancer assigning for 8 fills a room the balancer calls full while seats sit empty. A ticker on 300 beside a relay on 800 holds sockets for eight minutes after its own tick loop is gone. A `maxRooms` that differs hands a client `pong~7` that the relay quietly replaces with the fallback, and the player sits alone in a room nobody else can see them in. None of the three reports anything, because from each route's own point of view nothing went wrong.

```ts
// lib/room.ts
import { experimental_upgradeWebSocket } from '@vercel/functions';
import { createRoom } from 'tickroom/adapters/vercel';
import { pong } from '@/sim/pong';

export const room = createRoom({
  runtime: pong,
  // Signs session tokens AND the spawn tokens the relay calls the ticker with.
  secret: process.env.SESSION_SECRET!,
  // The pool, for all four routes at once.
  rooms: { isValidBase: (b) => b === 'pong', fallbackRoom: 'pong', maxPlayers: 20 },
  // THE ONE NUMBER THAT COUPLES THIS LIBRARY TO YOUR PLATFORM, in seconds, and
  // it is the same number the two route files below export as `maxDuration`:
  // the tick loop stops at min(700s, maxDurationS * 1000 - 30s), because the
  // final checkpoint, the lease release and the successor spawn all happen
  // after the loop and the platform must not kill them, and the relay
  // announces `relay-expiring` at maxDurationS * 1000 - 10s so the client
  // swaps to a replacement socket before this function dies. Lower it on a
  // lower plan limit and both lifetimes follow; raising it does NOT extend the
  // loop past 700s.
  maxDurationS: 800,
  // `namespace` belongs here too, unset on one deployment and 'staging' on
  // another: it prefixes every key AND every channel, for all four routes at
  // once. See "A Redis DB index does not isolate two deployments" above for
  // what setting it on one route and not another costs.
  //
  // Injected, not imported. See below.
  upgradeWebSocket: experimental_upgradeWebSocket,
});
```

Then each route file is one handler and its literals:

```ts
// app/api/ticker/route.ts
import { room } from '@/lib/room';

// Literals, always. See the note under the fourth file.
export const runtime = 'nodejs';
export const maxDuration = 800;

export const GET = room.ticker;
```

```ts
// app/api/ws/route.ts
import { room } from '@/lib/room';

export const runtime = 'nodejs';
export const maxDuration = 800;

export const GET = room.ws;
```

```ts
// app/api/session/route.ts
import { room } from '@/lib/room';

export const runtime = 'nodejs';

// What `mint()` in step 3 calls. Answers `{ token, playerId, handle, room }`,
// which is exactly the `SessionInfo` the client consumes.
export const POST = room.session;
```

```ts
// app/api/room/route.ts
import { room } from '@/lib/room';

export const runtime = 'nodejs';

// Answers `{ room, base, index, full? }`: which physical room instance a
// joiner should land in. Step 3's `mint()` calls this FIRST, before
// `/api/session`, so the session it asks for names the room the balancer
// actually placed it in; it calls this again, this time with `?not=` naming
// every room that has already refused this client, whenever `onTerminal` sees
// a `'capacity'` terminal. Keep every refused room, not just the last one: see
// the re-assign recipe under "Things worth knowing".
export const GET = room.balancer;
```

**`runtime` and `maxDuration` are literals in all four files, and `maxDuration` must equal the `maxDurationS` beside it.** Next's route-segment-config parser reads those two exports out of the source text at build time, so `export const maxDuration = room.config.ticker.maxDuration` fails the build ("Next.js can't recognize the exported `runtime` field in route. It needs to be a static string"); `room.config` (and `tickerRouteConfig`/`relayRouteConfig` under it) is still the one place to read the numbers this library expects, but it is documentation, not something to re-export.

**The session route is the hand-written one made real.** It mints a random `pid` and `handle`, signs `{ pid, handle, sub }` with `makeToken`, and answers the four fields `RoomConnection.mint` wants. The token carries the claims the relay will trust for the whole socket's life and it EXPIRES: claims are baked in at mint and no auth provider is consulted again on the socket path (that is the point, it keeps an auth outage off the hot path), so without an expiry a token kept from a paid tier stays redeemable forever after the subscription lapsed. Four optional hooks shape it, and a host with no accounts needs none of them:

```ts
session: {
  // Passed to the MINT and to the RELAY, so the expiry is one both halves
  // enforce. An expiry only the mint knows about is an expiry on paper.
  maxAgeS: 60 * 60,
  // Your own identity, signed. Whatever this returns wins over the generated
  // values, and the response reports what was actually signed: `pid` is also
  // the key the per-subject socket cap counts against, so use your user id the
  // moment you have one.
  claims: async (req, body) => ({ pid: await userId(req), sub: 'account-1' }),
  // Which room this session is for. The default is `room` from the JSON body,
  // then `?room=`, then `rooms.fallbackRoom`. Returning null refuses with 400.
  room: (req, body) => (body as { room?: string }).room ?? null,
},
```

Without a `claims` hook the subject is the request body's own `sub` when it is a short, key-safe string, and `d.<pid>` otherwise: `sub` is interpolated into a Redis key name (`room:conns:<sub>`, the set the per-subject socket cap counts), and Redis key names have no escaping, so a body-supplied one is filtered on the same terms a room id is. **A room the pool does not recognise is answered with 400, never reassigned.** `normalizeRoomId` answers an id it cannot validate with the fallback, which is right on the socket path and wrong here: a client that asked for one room and was quietly minted a session for another joins a game it did not ask for, and this response is the only place that could have told it.

**`decodeInput` has a default, and it is the two frames this library actually ships.** `decodeInputAuto` from `tickroom/codec` reads the binary input window the client's `predict` option sends by default (69 bytes for the six re-sent records, the last six ticks whole so a lost packet does not starve a tick) and the JSON frame it sends on `predict.wire: 'json'` (one array of `{ targetTick, data }` records per message, as a text frame or as bytes), sniffed on the first byte, and answers anything malformed on either path with `[]` rather than throwing. Pass your own `decodeInput` for anything else, and make it throw if you want `onBadInput` to count a broken client: the default never does. Fragmentation is not your problem either way: a peer or a proxy chooses its own, and the relay joins a fragmented message before any decoder sees it.

**Wire `onBadInput` and `onRateDrop`, and COUNT rather than log.** Both run at a rate the client owns, so a log line per event hands an abuser an amplifier: the refused frame becomes more expensive than the accepted one. A decoder that throws is caught and dropped in silence by design, which means the only symptom of a broken decoder is one player whose inputs stop while the room, the roster, the snapshots and every other player stay perfectly healthy:

```ts
let badInputs = 0;
let rateDrops = 0;
setInterval(() => {
  if (badInputs || rateDrops) console.warn('relay.input-refused', { badInputs, rateDrops });
  badInputs = 0;
  rateDrops = 0;
}, 10_000);

// ...in createRoom:
onBadInput: () => void (badInputs += 1),
onRateDrop: () => void (rateDrops += 1),
```

**Everything a route accepts is still reachable, through three escape hatches applied last.** `ticker`, `relay` and `balancer` take a partial of the matching factory's options and win over the composed values, so `init`, `geomKey`, `onGeomMismatch`, `metaPayload`, `metaSeedPayload`, `statsLabels`, `presenceTimeoutMs`, `log`, every observability hook and every bound are just extra keys:

```ts
createRoom({
  ...opts,
  ticker: { geomKey: () => 'pong:v1', init: warmTheAssets },
  relay: { maxSocketsPerSubject: 3 },
});
```

A shared fact set in one of those bags is set in one route only, which is the mismatch this call exists to remove: state `secret`, `rooms`, `namespace` and `maxDurationS` at the top level and keep these for what genuinely differs.

**`createRoom` throws at creation, which is module evaluation**, for a `rooms.maxPlayers` that is not a positive integer, for a missing secret, and (from the factory that owns the number, with its name in the message) for a `maxDurationS` whose derived lifetimes do not fit. A deployment whose numbers do not fit fails on its first request rather than on every handoff for the rest of its life.

**`upgradeWebSocket` is injected, not imported.** tickroom takes no hard dependency on any platform, so the same server core runs behind plain `ws` on a VM (see `adapters/node.ts`).

**`maxDurationS` has a floor as well as a ceiling, and both routes throw at creation if you miss it.** Each derivation is a subtraction (`maxDurationS * 1000` minus a 30s ticker margin, minus a 10s relay margin), so a small enough number produces a *negative* lifetime rather than a short one: `maxDurationS: 10` derived a ticker `maxRunMs` of -20000 and a relay `lifetimeMs` of 0, which announced `relay-expiring` and closed every socket the instant it arrived. `MIN_TICKER_RUN_MS` (10s) and `MIN_RELAY_LIFETIME_MS` (`2 * RELAY_EXPIRY_LEAD_MS + 1000`, so 11s, because a lifetime has to hold the swap's own lead AND a lead of clearance before the next relay announces) are checked on the *resolved* number at route creation.

**Both numbers above are 800 because that is a Pro plan's cap; 300 is the platform default and the Hobby cap**, which makes the ticker's handoff period 270s and the relay's swap period 290s instead of 700s and 790s. Both configurations were measured on a real Pro deployment, at zero server ticks lost per handoff either way: six warm swaps of six at 300, and six of six again at 800 over 27 minutes. **On a project with Vercel Authentication turned on, turn it off** (or set `VERCEL_AUTOMATION_BYPASS_SECRET` and send it on the spawn): Deployment Protection guards every request to the deployment including one function calling another, so it answers the relay's own fire-and-forget spawn of the ticker route with an SSO redirect, and because that spawn is caught and discarded by design the only symptom is a room that joins, seeds its roster, and then never ticks.

**One more coupling if you set `standbyMs` yourself.** The standby successor is spawned `standbyLeadMs` (3000) before the cap and polls the lease until it wins or gives up, so `standbyMs` has to comfortably exceed that lead **plus the incumbent's own exit**: the lease is released after the final checkpoint and the release, not at the cap itself. The routes pass 8000 against 3000. It also has to fit *inside* `maxRunMs`, because a standby's poll is spent out of the same lifetime budget the platform is measuring from the moment the request arrived. Leave both alone and the defaults already satisfy this.

#### The low-level form: the four factories

`createRoom` composes three exported factories and a session handler, and all three factories are still public and still supported. Reach for them when you genuinely want four different configurations (two deployments on two plans, a relay hosted somewhere else) rather than one room stated once; for anything short of that, the escape hatches above are the same thing without the restatement.

```ts
// app/api/ticker/route.ts
import { createTickerRoute } from 'tickroom/adapters/vercel';
import { pong } from '@/sim/pong';

export const runtime = 'nodejs';
export const maxDuration = 800;

export const GET = createTickerRoute({
  runtime: pong,
  secret: process.env.SESSION_SECRET!,
  isValidBase: (b) => b === 'pong',
  fallbackRoom: 'pong',
  maxDurationS: 800,
});
```

```ts
// app/api/ws/route.ts
import { experimental_upgradeWebSocket } from '@vercel/functions';
import { createRelayRoute } from 'tickroom/adapters/vercel';
import { decodeInputAuto } from 'tickroom/codec';

export const runtime = 'nodejs';
export const maxDuration = 800;

export const GET = createRelayRoute({
  secret: process.env.SESSION_SECRET!,
  isValidBase: (b) => b === 'pong',
  fallbackRoom: 'pong',
  maxPlayers: 20,
  // Relative, so it resolves against this request's own origin: fine as long
  // as the ticker route lives in the same deployment.
  tickerUrl: '/api/ticker',
  maxDurationS: 800,
  // `decodeInput`'s parameter is `unknown`, not `ArrayBuffer`: the real
  // transport behind this route is the `ws` package, which hands over a
  // `Buffer` rather than a browser-style ArrayBuffer, and a text frame arrives
  // as a `string`. The default is `decodeInputAuto` from `tickroom/codec`,
  // which reads both frames the client in step 3 can send; this is that
  // default, written out. Pass your own for a wire of your own.
  decodeInput: decodeInputAuto,
  onBadInput: () => void (badInputs += 1),
  onRateDrop: () => void (rateDrops += 1),
  upgradeWebSocket: experimental_upgradeWebSocket,
});
```

```ts
// app/api/session/route.ts
import { makeToken } from 'tickroom/server';

export const runtime = 'nodejs';

// `room.session` is this, with the room validated against the same pool the
// other three routes use rather than trusted from the query string.
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

// No `secret` here, unlike the two routes above: this route takes no token and
// reads no claims. It only reads one stats key per candidate room and hands
// back an index, and that stats key has a 5s TTL while the ticker enforces
// capacity authoritatively, so a stale answer here costs a bounced connect,
// never a wrong one.
//
// `maxRooms` is left unset, same as the ticker and relay routes above, so all
// three default to the same `MAX_ROOMS_PER_BASE` (50). AND THE THREE VALUES
// MUST AGREE: a balancer at 50 against a relay at 4 hands out `pong~7`, which
// the relay then refuses as out of range and silently replaces with the
// fallback room, while every signal on both ends reads healthy and the player
// sits alone in a room nobody else can see them in. That agreement is what
// `createRoom` makes structural instead of a rule you have to keep.
export const GET = createBalancerRoute({
  isValidBase: (b) => b === 'pong',
  fallbackBase: 'pong',
  maxPlayers: 20,
});
```

**Every server option is reachable from these two factories.** The route option types are `HostTickerOptions`/`HostRelayOptions` intersected with the handful of fields a route genuinely owns, and the bag is *spread* into `runTicker`/`attachRelay` rather than copied field by field. So `init`, `geomKey`, `onGeomMismatch`, `metaPayload`, `metaSeedPayload`, `statsLabels`, `presenceTimeoutMs`, every observability hook and every bound are all just extra keys here. They used to be a hand-picked subset, and a field a type does not name is not an error, it is simply never passed on: twenty options were unreachable that way, with nothing anywhere reporting it.

### 3. Connect from the browser

```ts
import { RoomConnection, type SessionInfo } from 'tickroom/client';
import type { DefaultInput } from 'tickroom/codec';
import { PLAYER_SPEED, stepPlayer } from '@/sim/pong';

interface Snapshot {
  tick: number;
  serverTime: number;
  players: [string, { x: number; y: number }][];
  /** Pids this tick PUT somewhere rather than moved: a respawn, an elimination. See `interpolate.teleported` and `predict.teleported`. */
  respawned?: string[];
}

// Yours, not tickroom's: a HUD, the input state your controls write into, and
// a renderer. Stubbed here so this block compiles as written; replace all
// three with the real thing. The input is the DEFAULT shape, a stick and a
// button mask, because that is what the default binary wire carries; see
// `predict.wire` below for anything else.
const banner = { toggle: (stalled: boolean) => {}, terminal: (msg: string) => {} };
const input: DefaultInput = { axes: [0, 0], buttons: 0 };
function draw(id: string, x: number, y: number) {}

let myPid = '';
let myRoom = '';
// Every room this client has been bounced FROM by a capacity terminal, so a
// re-assign never lands back on one. See `mint` and `onTerminal` below, and
// the re-assign recipe under "Things worth knowing".
let refused: string[] = [];
let tries = 0;

// ALL THREE TYPE ARGUMENTS, WRITTEN OUT. They are inferable (`decodeSnapshot`'s
// return type fixes the first, `interpolate.entities` the second, and
// `predict.step`'s input parameter the third), and writing them anyway is
// what makes a mistake in any of them an error HERE rather than a widened
// shape reaching `onSnapshot`, `predict.ownPose` or `frame()` several lines
// later. The key type is the one decision: pids are strings everywhere in
// tickroom, so a JSON room like this one is keyed by `string`; a room on the
// default binary codec is keyed by `number`, because `CodecEntity.id` is one.
const conn = new RoomConnection<Snapshot, string, DefaultInput>({
  // MUST EQUAL YOUR `RoomRuntime.tickHz`. It drives the tick counter's step,
  // `estimateServerTick`'s slope, the underrun threshold and the prediction's
  // timestep at once, so a mismatch is a silent multiplier on all four rather
  // than an error.
  //
  // The symptom, if you ever see it: `onTickReanchor` firing every couple of
  // seconds with a delta of the SAME SIGN every time (the counter running at
  // the wrong slope, dragged back on a timer it can never catch), and the
  // server's playout depth pinned at 0 because the buffer is starved on every
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

  // Your decoder and nothing else. `tick` and `serverTime` are the two fields
  // the connection reads; the server's playout depth, which trims the
  // stamping lead, arrives on the library's own control frame rather than
  // through anything your snapshot carries.
  decodeSnapshot: (buf) => JSON.parse(new TextDecoder().decode(buf)) as Snapshot,

  // EVERYONE ELSE'S ENTITIES, interpolated. The connection constructs the
  // interpolator (pass `into` to pin its delay bounds or keep a handle on it),
  // pushes every snapshot in with the right timestamps and clears it on every
  // reconnect. You say which parts of a snapshot MOVE, and which entities this
  // snapshot PUT somewhere rather than walked: a respawn or an elimination is
  // not motion, and interpolating across it walks the entity over the whole
  // distance at playback speed. Name the keys and the connection calls
  // `teleport(key)` for each AFTER its own push, which is the one order that
  // call needs and the one a host used to have to remember. One declaration
  // is the whole answer at any delay; `forget` is not that call and measures
  // worse than doing nothing.
  interpolate: {
    entities: (snap) => new Map(snap.players),
    teleported: (snap) => (snap.respawned ?? []).filter((pid) => pid !== myPid),
  },

  // YOUR OWN ENTITY, PREDICTED LOCALLY. The interpolation delay is right for
  // everyone else's entities and wrong for the one you are steering, so this
  // one runs the stamped path instead: one record per TICK (never per frame,
  // never per keydown) carrying the tick it applies on, predicted here through
  // the SAME pure step the runtime runs, the last six records re-sent on every
  // packet so a lost packet is not a starved tick, replayed from every
  // snapshot, corrected as a glide rather than a teleport (a snap on the first
  // confirmation and whenever the offset would grow past half a second of
  // travel), and drawn from a render playhead that moves at real time through
  // its recent poses, one tick behind the newest, so it moves at the frame
  // rate instead of stepping at the tick rate and a counter re-anchor is
  // caught up over a second rather than drawn as a lurch. The connection owns
  // all of it: it advances the prediction inside `frame()` AFTER the counter
  // and the interpolator, reconciles it against every snapshot AFTER your
  // `onSnapshot` has run (so a step that reads context you keep from the
  // snapshot, a grid or a closing ring, replays through THIS snapshot's
  // context rather than the previous one's), and snaps it before the
  // reconcile that confirms a jump you declare. Those three orders are the
  // ones a host got wrong by hand, and there is no call here left to put in
  // the wrong place. The reconciled pose is `frame().own` on the next frame.
  predict: {
    // `(pose, input, dt, tick)`. The fourth argument is the tick this call is
    // PRODUCING, which is the record's own `targetTick`: a replay runs several
    // ticks inside one snapshot, so a step whose world changes over time (a
    // closing arena, a grid that moved two ticks ago) indexes it with that
    // number rather than with the newest one. A step that does not care
    // ignores it and compiles unchanged, which is what `stepPlayer` does here.
    step: stepPlayer,
    maxSpeed: PLAYER_SPEED,
    initial: { x: 50, y: 50 },
    // Where YOU are in a snapshot, or `null` while you are not in it yet. The
    // connection replays the records it stamped after `snap.tick` from this
    // pose and glides any difference away; on a healthy link that difference
    // is your wire's own rounding and nothing else.
    ownPose: (snap) => snap.players.find(([pid]) => pid === myPid)?.[1] ?? null,
    // This snapshot PUT you somewhere. Yours is predicted rather than
    // interpolated, so it is declared here rather than above, and the
    // connection snaps the prediction onto `ownPose` BEFORE reconciling, so
    // the server's answer is a fresh confirmation rather than a half-second
    // slide from where you were.
    teleported: (snap) => (snap.respawned ?? []).includes(myPid),
    // THE WIRE. Omitted, the input goes out as the binary window from
    // `tickroom/codec` (69 bytes for six records), which requires the input
    // to be `DefaultInput`, a stick and a button mask, as it is here; the
    // first input is checked and a `TypeError` names both alternatives if it
    // is not. `wire: 'json'` sends any JSON-shaped input as one text frame
    // (about 300 bytes for the same six), and `encodeInput` is your own wire.
    // The relay's default `decodeInput` in step 2 reads the first two.
  },

  // Everything the interpolator cannot smooth and the prediction does not own:
  // scores, a winner, a phase. By the time this runs the frame is pushed, every
  // declared teleport is made and your own entity is reconciled, so `conn.own`
  // read here is the state THIS snapshot produced.
  onSnapshot: (snap) => {},

  onStallChange: (stalled) => banner.toggle(stalled),

  // OPTIONAL, AND TELEMETRY ONLY. The tick counter just jumped by this much
  // (a handoff, a backgrounded tab, a clock step), and the delta can be
  // NEGATIVE. This used to be load bearing: a host that deduped its sends by
  // a last-stamped-tick high-water mark had to move that mark by the delta
  // here, or a `if (t <= lastSentTick) return;` guard went silent until the
  // counter climbed back past it, measured on a real socket at 5.6 seconds of
  // input silence and 100 self-inflicted starves from one backward re-anchor.
  // The prediction reads the jump off the counter itself and resets its own
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

// THE ONE PER-FRAME CALL. `conn.frame(now, input)` advances the tick counter
// inputs are stamped against, polls the stall detector, samples the
// interpolator, and THEN stamps whatever ticks the counter crossed with the
// input as HELD STATE (a lost packet then costs nothing: the next tick
// re-asserts the same intent), sends them, and returns both the poses to draw
// and your own. `input` is REQUIRED once `predict` is set, and the connection
// throws if it is missing rather than stamping a record the server cannot
// read. `own` is `null` until the server has confirmed you have an entity.
//
// AND IT RUNS ON EVERY CALLBACK. No `if (now - last < 1000 / 60) return;`
// frame gate: see the note below.
function frame(now: number) {
  const { entities, own } = conn.frame(now, input);
  for (const [id, e] of entities) if (id !== myPid) draw(id, e.x, e.y);
  if (own) draw(myPid, own.x, own.y);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

**Your `step` has to be pure of CLIENT-FRAME state, not just of its own.** It
must not keep state, which the option's own docs say, and the part that is
easier to miss: every hook it reads has to be evaluated *from the pose it is
handed*, on the tick it is handed, and never from something latched on a
different frame. A replay starts from the SERVER's pose and re-runs your
records, so a collision test that answers for the raw prediction instead of for
the pose in front of it answers a question about a place the replay is not.
Measured on a real game: an own-bomb check computed once per frame from the raw
pose made the replay from the server's pose unable to move at all, so every
snapshot produced a correction, and the player rubberbanded on a link with
nothing wrong with it. If your step needs "is this tile passable for me", it
computes it from the pose argument and the `tick` argument, every call.

**Render every `requestAnimationFrame`, and never gate on a minimum frame
interval.** A `if (now - last < 1000 / 61) return;` looks like a frame limiter
and is a frame *dropper*: rAF timestamps jitter by a millisecond or two either
side of the display's period, so the ones that land under the threshold are
skipped outright, and every skip is a visible hitch on a moving entity.
Measured on a 60Hz display with a `1000 / 61` gate: 16% of frames dropped. The
browser already paces you at the display rate; `conn.frame(now)` measures its
own delta and every smoother in this library runs on real elapsed time, so a
frame that arrives early costs a small `dt` and nothing else.

**A `Pose` is `x`, `y` and an optional `heading`, and a replay keeps nothing
else.** The prediction stores, shifts and interpolates exactly those three
fields, so anything else you return from `step` (a velocity, a stun timer, a
grounded flag, an ammo count) is dropped the moment a record is replayed or a
correction shifts the history. That state belongs in your own object, derived
from the pose, or on the wire from the server: a field the prediction carries
but the replay does not is a divergence with no symptom until a snapshot lands.

**`conn.own` is the raw prediction and `frame().own` is the drawn one, and
they differ on purpose.** The drawn pose sits on a playhead one tick behind the
newest stamp with the remains of the last correction added, which is right for
the screen and wrong for a rule: a collision latch or a bomb placed at the
player's feet wants where the entity IS, which is `conn.own`. `conn.ownStats`
(`lastError`, `snaps`, `stamped`, `invalid`) is what a debug overlay reads to
see how far the prediction and the server actually disagree.

**Throw `ProtocolVersionError` out of `decodeSnapshot` on a wire mismatch.** The connection's skew recovery (reload once, then latch `'version-skew'`) fires on a returned `version` field *or* on a thrown error whose `name` is `'ProtocolVersionError'`, and the second is what a binary codec actually does: `decodeDefaultSnapshot` checks the version before reading a single field and throws exactly that. It is duck-typed on the name, so your own codec can participate without importing anything. A decoder that swallows the mismatch instead leaves every old client silently dropping every frame after a deploy, with nothing reloading and nothing latching.

That is the whole browser integration, upstream and down. You now have
reconnect-with-backoff, session re-minting, a smoothed server clock,
server-timeline interpolation that adapts to measured jitter, never-freeze
extrapolation, and a stall detector that can tell a dead room from a slow one.

**Every callback above is called inside a catch, and `conn.stats().hostErrors`
is how you find out.** A throw out of `onStatus`, `onTerminal`,
`onTickReanchor`, `onStallChange`, `onText`, `onSnapshot`, `interpolate.entities`,
`interpolate.teleported`, `predict.ownPose` or `predict.teleported` costs that
one call and nothing else, because
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
agree. `predict` sends the last six stamped records, oldest first, as one
frame per stamp: the binary input window by default (`seq` on that wire is the
record's own `targetTick`, since the library never reads `seq`), one JSON array
of `{ targetTick, data }` as a text frame on `wire: 'json'`, or whatever your
`encodeInput` returns. Step 2's default `decodeInput` reads the first two; a
host stamping by hand can send whatever its own decoder reads. Everything else
about the client is typed end to end, so this is the seam to get right.

**The roster arrives on `onText`, and it is typed.** The relay seeds a joining
socket with a roster frame and the ticker broadcasts one on every change:

```ts
import { isRosterFrame } from 'tickroom/client';

onText: (msg) => {
  if (!isRosterFrame(msg)) return;
  setPresence(Object.keys(msg.map)); // keyed by pid; values are your joinMeta
},
```

### Testing your step

`predict` replays your step from the server's pose. If that step reads any
context the server does not read at the same tick, the replay is wrong and
**nothing anywhere reports it**: the arithmetic is pure, the reconcile runs, the
error stays small, and what a player sees is rubberbanding. No check inside this
library can see it, because the context lives in your closure.

`tickroom/testing` runs both ends against each other so it can. It drives your
real `RoomRuntime` the way the ticker does, through your real codec so the
client sees wire-quantised poses, with the real prediction `predict` owns
stamping `lead` ticks ahead of a server whose snapshots arrive `delay` ticks
late, on the same wire (`wire` and `encodeInput` mean exactly what they mean
on `predict`, and `decodeInput` defaults to the relay's own `decodeInputAuto`).

```ts
import { runLockstep, sweepLockstep } from 'tickroom/testing';

const scenario = {
  runtime: pongRuntime,
  pid: 'p1',
  setup: (s) => { pongRuntime.join(s, 'p1'); s.paddles.get('p1')!.y = 12; },
  encode: (s) => encodePongSnapshot(s, s.tick * 50),
  decode: (bytes) => decodePongSnapshot(bytes as Uint8Array),
  ownPose: (snap) => {
    const mine = snap.paddles.find((p) => p.pid === 'p1');
    return mine === undefined ? null : { x: 0, y: mine.y };
  },
  step: (pose, input, dt) => ({ x: pose.x, y: stepPaddleY(pose.y, input.dir, dt) }),
  maxSpeed: PADDLE_SPEED,
  wire: 'json', // `{ dir }` is not the default binary shape, exactly as on the page
  input: () => ({ dir: 1 }),
  ticks: 20,
};

for (const { lead, delay, report } of sweepLockstep(scenario, [3, 6, 10], [2, 5])) {
  expect(report.maxError, `lead ${lead}, delay ${delay}`).toBe(0);
  expect(report.pinned).toEqual([]);
}
```

**Sweep it, never sample it.** A step reading its context at the wrong tick is
exact whenever the client happens to be stamping the tick it reads, so one lead
proves nothing. `maxError` is the largest reconcile error in your own units and
should sit at your wire's quantisation and no higher; `pinned` is the ticks
where the server's pose moved and the client's raw pose did not, which is what a
step refusing to move looks like from inside. `report.trace` is the whole run,
tick by tick, when a number is not enough. Pass `onSnapshot` and update the same
client-side context your page updates, or the harness tests a world your page
never gives the step.

It imports no Node builtin and no `ioredis`, so it loads in the browser test
runner your client code already runs in. `src/testing/lockstep.test.ts` runs the
pong example through it both ways: exact at every lead and delay, and a
deliberately broken step reported as pinned and wrong.

## Things it is worth knowing before you build on this

Each of these cost real production time to learn. They are documented at length in [`ARCHITECTURE.md`](ARCHITECTURE.md) and in the source comments.

**The lease needs two clocks, not one.** `lastRenewAt` paces attempts, `lastOwnedAt` records confirmed ownership. Collapse them and a ticker whose renews are all *failing* keeps refreshing its own guard, so the guard can never fire in the one situation it exists for.

**A checkpoint must carry a digest of the world it was simulated against.** Otherwise a deploy that moves a wall leaves every live room restoring and re-saving a simulation of the old world forever, because each successor faithfully restores its predecessor's bytes. Silent, permanent, invisible in every metric.

**Capacity must be read from one key.** If the relay and the balancer read different keys, a hard-dead ticker leaves one of them permanently wrong, the balancer keeps handing out a room the relay keeps rejecting, and joiners strand on "full" with no way to heal.

**Keep every room you were refused from, and send them all.** A capacity terminal (`CLOSE_CODES.capacity`, 4002, or a `room-full` frame) names the room in the session you were using, so push that id onto a list and pass the whole list on the next mint: `GET /api/room?base=lobby&not=lobby,lobby~1`. Do not send only the last one. The balancer reads a stats key with a 5-second TTL while the ticker enforces capacity authoritatively, so the two disagree for up to a window, and a single-id exclusion lets a client ping-pong between two rooms until its bounded re-assign budget is gone, which reaches the player as "the game is full" while seats are free. Entries are validated individually against the base, so a stale id from a previous session is ignored without affecting the others, and up to 64 are honoured per request.

**And the three `maxRooms` values must agree.** It is an independent option on the ticker route, the relay route and the balancer route, each defaulting to `MAX_ROOMS_PER_BASE` (50), and a balancer at 50 against a relay at 4 hands a client `lobby~7` that the relay refuses as out of range and silently replaces with the fallback room. The session then says one room and the snapshots come from another, while every signal on both ends reads healthy: socket open, roster populated, tick rate nominal, and the player alone in a game nobody can see them in. The tell is a `ticker.room-normalised` or `relay.room-normalised` warn, one per authenticated request, carrying the raw id that was refused. It is the only symptom this failure has, so wire the routes' `log` before you need it.

**Every route takes a `log`, and what it receives is typed.** A `Logger` is `(ev: LogEvent) => void`, and `LogEvent.kind` is not a string: it is `LogKind`, the union derived from `LOG_KINDS` in `tickroom/core`, one `const` array listing every kind the library emits, grouped by emitter (`ticker.*`, `relay.*`, `node-relay.*`, `balancer.*`) with a one-line doc on each. A sink can therefore switch over it exhaustively and a `kind` the library stopped emitting is a compile error in your switch rather than a filter that quietly matches nothing; on the library's side a source test proves every kind in the list is still emitted and every kind emitted is in the list. The list is the reference for which lines exist: `ticker.fresh`, `ticker.restore` and `relay.room-full` are the positive ones, `ticker.lease-lost` carries `meta.finder`, and every counted-not-logged path (`relay.misaddressed-frame`, `ticker.host-errors`) flushes one line per cadence with a `count`. The default sink is the console; supply your own and never let it throw.

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

**The depth loop closes on its own, with nothing on your wire.** The client's stamping lead is an open-loop guess (`measured RTT + your jitter headroom`) until the server tells it how deep the playout buffer is actually running. That quantity only exists inside the ticker, so the ticker publishes it: once a second, one `depth` frame on the roster channel carrying the mean depth over that second for every player it holds a buffer for, and each relay forwards its own client one `input-lead` frame with that client's value. `RoomConnection` consumes the frame the way it consumes a `pong`, so it never reaches `onText`, and trims the lead toward a two-tick cushion. A client that joins before the first frame runs open-loop for at most that one second, which is what every connection did before the frame existed. The cost is one publish per room per second of about 30 bytes plus a dozen per buffered player, fanned out once per socket: measured at 29 bytes a second beside 1,610 bytes a second of snapshots for a one-player room at 20Hz. `RoomRuntime.onBufferHealth` still fires with the same reading, for a host that wants the number in its own state for a HUD; the loop no longer depends on it.

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

