# The node-server example

The same two simulations (`../pong/sim.ts` and `../cursors/sim.ts`) on a plain
Node `ws` server, with no serverless platform anywhere in the loop. It is what
proves tickroom is not a Vercel library, and it is the fastest way to develop
against the library: everything except the function lifetime behaves exactly as
it does in production, so you can drive real clients through a real Redis on a
laptop.

## Run it

```bash
redis-server --port 6399 --save '' --appendonly no --daemonize yes
REDIS_URL=redis://127.0.0.1:6399 SESSION_SECRET=dev PORT=3100 npm run example:node
```

That is the whole thing. `npm run example:node` is `tsx examples/node-server/server.ts`,
and `tsx` is a devDependency of this repo, so there is nothing to install beyond
`npm install`.

You should see, immediately:

```
tickroom node example on http://localhost:3100
rooms: pong, cursors
redis: redis://127.0.0.1:6399
keys:  room:pong:in room:pong:out room:pong:lease room:pong:state room:pong:stats room:pong:meta room:pong:metaout room:pong:crashes room:pong:timeline
ticker maxRunMs=700000 standbyMs=0 | relay lifetimeMs=none
```

Nothing ticks yet. A room's ticker is started by the first socket that joins it
(`spawnTicker` in the relay options), which is the same laziness a serverless
deployment gets for free, so the process idles until somebody connects.

## Without Redis

This example wants a real Redis because it is the thing you develop production
against, and production has more than one process in it. A host that genuinely
has one process does not need the service at all: `createMemoryRedis()` from
`tickroom/server` hands back the same command client and subscriber factory
`getRedis()` and `createSubscriber` do, backed by one in-process store, and both
halves of this file take them by injection.

```ts
import { createMemoryRedis } from 'tickroom/server';

// ONCE, at module scope: two calls are two disjoint stores, and a ticker on
// one with a relay on the other is a room whose snapshots nobody receives.
const { redis, createSubscriber } = createMemoryRedis();
```

Then delete the `new Redis(REDIS_URL)` pair at the top of `server.ts` and hand
the two new ones to the same places those went: `runTicker` in `keepTicking`,
and `admitSocket` in the upgrade handler. That is the whole edit. A host using
the adapter instead of hand-wiring passes them to `runNodeTicker` and
`attachNodeRelay`, which take both as options for exactly this. Nothing else
changes, which is the point: `RedisLike` is the seam and this is the swap it
exists for.

What it costs is the whole reason the rest of this README talks about handoffs.
The store is this process's heap, so there is **no horizontal scale** (a second
instance shares nothing with the first), **no survival of the process** (the
checkpoint dies with the room it protects, so a crash or a deploy loses both,
and this is fatal by definition on any platform that kills your function), and
**no lease across instances** (`acquireLease` still answers correctly, but the
only competitor it can ever see is another `runTicker` in this process: a
re-entrancy guard, not a split-brain guard). Right for a single VM or a local
dev loop; wrong for everything else. `tests/memory.test.ts` runs this exact
wiring, with `REDIS_URL` unset so any path still reaching for a connection fails
loudly.

## Every environment variable this file reads

| | default | what it does |
| --- | --- | --- |
| `PORT` | `3100` | HTTP and WebSocket port. Both live on the same server. |
| `REDIS_URL` | `redis://localhost:6379` | The bus. Must be a real TCP client: a REST-style Redis API cannot subscribe. |
| `SESSION_SECRET` | `dev-secret-do-not-ship` | HMAC key for the session token. The default is a placeholder and the name says so. |
| `TICKER_MAX_RUN_MS` | `MAX_TICKER_MS` (700000) | The ticker's own duration cap, so **how often the planned handoff runs**. |
| `STANDBY_MS` | `0` | Passed to the successor's `runTicker` as `standbyMs`, but only when the spawn that asked for it carried `{ standby: true }`. |
| `RELAY_LIFETIME_MS` | unset (no cap) | The relay's own lifetime cap, so **how often the warm socket swap runs**. |

The last three all default to today's behaviour, so an unset environment changes
nothing about how this server runs.

## The session endpoint

```
POST /api/session?room=pong   ->   { token, playerId, handle, room }
```

`room` is echoed back as given and defaults to `pong`; the two rooms this
server serves are `pong` and `cursors`. Everything else 404s. The token carries
the claims the relay trusts for the whole socket's life and it **expires**, so
a client re-mints rather than keeping one.

## The socket URL

```
ws://localhost:$PORT/?token=..&pid=..&h=..&room=pong
```

Any path works: the upgrade handler reads the query string and ignores the
path, which is why the headless recipe below writes a bare `/`. A browser
client using `RoomConnection`'s default URL builder would hit `/api/ws`
instead, and that lands on the same upgrade handler.

`pid` and `h` are not decoration. `verifyToken` is given the pid and handle the
caller *claims* to be, so a token minted for one player cannot be replayed to
authenticate as a different one by forging the query string alone. Get them
wrong and the upgrade is refused with a 401 before a socket exists.

## A headless client, in Node

There is no browser in this recipe and none is needed. `RoomConnection` reaches
for exactly two globals, and both have an option that replaces them:
`socketUrl` instead of `location`, and `WebSocketImpl` instead of the global
`WebSocket`. `ws`'s own `WebSocket` and Node's built-in global (Node 22 and up)
both assign straight to `WebSocketConstructor`, with no cast: the interface
declares its four handler slots as `(ev: any) => void`, which is the only
declaration a contravariantly-checked property can carry that every real
implementation satisfies.

```ts
// headless.ts, run with: npx tsx headless.ts
import { RoomConnection, type SessionInfo } from 'tickroom/client';
// import WebSocket from 'ws';   // or use the global, on Node 22+

const BASE = 'http://localhost:3100';

interface Snapshot { tick: number; serverTime: number }

const conn = new RoomConnection<Snapshot, string>({
  tickHz: 20, // pong's rate. `cursorsRuntime` is 10; a mismatch is silent.

  mint: async (): Promise<SessionInfo> => {
    const res = await fetch(`${BASE}/api/session?room=pong`, { method: 'POST' });
    if (!res.ok) throw new Error(`mint failed: ${res.status}`);
    return (await res.json()) as SessionInfo;
  },

  // No `location` outside a browser, so the URL is built here instead. The
  // shape is the one above; the path is free.
  socketUrl: (s) =>
    `ws://localhost:3100/?token=${encodeURIComponent(s.token)}` +
    `&pid=${encodeURIComponent(s.playerId)}&h=${s.handle}&room=${encodeURIComponent(s.room)}`,

  WebSocketImpl: globalThis.WebSocket,

  decodeSnapshot: (buf) => JSON.parse(new TextDecoder().decode(buf)) as Snapshot,

  onStatus: (st) => console.log(`status ${st}`),
  onTerminal: (r) => console.log(`terminal ${r}`),
});

await conn.start();

// One input per tick, stamped, exactly as `../pong/client.ts` sends them.
let seq = 0;
setInterval(() => {
  conn.send(new TextEncoder().encode(JSON.stringify({
    seq: seq++, targetTick: conn.tick.value, data: { dir: 1 },
  })));
}, 50);

// THE ONE PER-FRAME CALL, and it is required off-browser too: it advances the
// tick counter your inputs are stamped against. There is no
// `requestAnimationFrame` here, so drive it on a timer.
setInterval(() => conn.frame(performance.now()), 16);

setInterval(() => console.log(conn.stats()), 5000);
```

`conn.stats()` is what makes the next two sections observable from the client
side: watch `relaySwaps` climb and `reconnects` stay at zero.

## Watching a planned handoff

The ticker's default lifetime is 700 seconds, so on the defaults this example
demonstrates the handoff roughly twice an hour. Shorten it:

```bash
REDIS_URL=redis://127.0.0.1:6399 SESSION_SECRET=dev PORT=3100 \
  TICKER_MAX_RUN_MS=8000 STANDBY_MS=8000 npm run example:node
```

Point the headless client at it and every eight seconds the ticker exits, the
loop hands the room to a fresh run, and that run restores the checkpoint:

```
[pong] ticker exited: duration after 161 ticks
[pong] info ticker.restore
[pong] ticker exited: duration after 161 ticks
[pong] info ticker.restore
```

`ticker.restore` is the whole claim made visible: the room was not restarted,
it was picked up. Meanwhile the client's own numbers do not move at all, which
is the other half of the claim, because the socket is held by a relay whose
lifetime is completely separate from the ticker's:

```
{"snapshotsReceived":600,"rejectedSnapshots":0,"reconnects":0,"relaySwaps":0}
```

`STANDBY_MS` is the successor's `standbyMs` and it is only passed on when the
spawn that asked for it carried `{ standby: true }`, which `runTicker` fires
`standbyLeadMs` (3000) before the cap. On serverless that is a second
invocation booting while the incumbent still ticks. In this one process the
loop IS the successor and cannot start early, so what the flag buys here is the
lease **poll** rather than the head start: the next run waits rather than
returning `'busy'` the moment it finds the predecessor still unwinding, and it
pays its `init` in front of the acquire the way a real standby does.

On serverless, `standbyMs` has to sit **above** `standbyLeadMs` plus the
incumbent's own exit (the final checkpoint is a gzip plus a round trip, and the
release comes after that) and **inside** `maxRunMs`, because the poll is spent
out of the very lifetime the platform is measuring. The adapters use 8000
against a 3000 lead. The recipe above sets `STANDBY_MS` equal to
`TICKER_MAX_RUN_MS`, which is fine for the same reason the paragraph turns on:
this successor starts *after* the lease is already free, so the poll resolves on
its first attempt and costs the run nothing. Each eight-second run above still
ticked 160 or 161 times, which is the full 20Hz budget.

## Watching the relay's warm swap

A long-lived process has no duration cap, so this server passes no `lifetimeMs`
by default and a socket lives as long as the client wants it to. Set one and
the swap runs on a schedule you can watch:

```bash
REDIS_URL=redis://127.0.0.1:6399 SESSION_SECRET=dev PORT=3100 \
  RELAY_LIFETIME_MS=15000 npm run example:node
```

The relay announces `relay-expiring` five seconds ahead of that cap, the client
opens a replacement socket, and it adopts the replacement only once that socket
actually delivers a snapshot. So a swap lands every ten seconds, and after 35
seconds the client reports:

```
{"snapshotsReceived":703,"rejectedSnapshots":0,"reconnects":0,"relaySwaps":3}
```

**Three swaps, zero reconnects, and the status never left `open`.** That is the
difference between a warm swap and a drop.

The server side is quiet on purpose. `relay.lifetime-reached` is logged only
when the relay actually reaches its cap with the socket still attached, i.e.
when the client did **not** swap in time, so a working swap produces no line at
all. To see it, connect a socket that ignores the announcement and hold it past
the cap:

```
[relay pong] info relay.lifetime-reached
```

which arrives with a close code of 4004 (`relayUnavailable`), the one close code
`RoomConnection` does not treat as terminal.

**There is no floor on `RELAY_LIFETIME_MS` here, and there is one on Vercel.**
`MIN_RELAY_LIFETIME_MS` is 11000 (`2 * RELAY_EXPIRY_LEAD_MS + 1000`) and
`createRelayRoute` checks it at route creation, because the lifetime a route
uses is *derived by subtraction* from `maxDurationS` and a small enough
`maxDurationS` produces a negative one. This file passes an explicit number
straight through to `attachRelay`, which has no floor of its own, so anything
under two expiry leads is yours to avoid: below 5000 the announcement and the
close arrive together and the client gets no warning at all.

## Reading the abuse counters

Two of the relay's observability hooks are wired here, and both fire on a path
whose rate a client controls:

- `onRateDrop`, once per frame the inbound token bucket rejects.
- `onBadInput`, once per frame `decodeInput` **throws** on. A decoder returning
  `[]` is a legitimate empty window and does not fire it.

They are counted per socket and flushed to the log every ten seconds, never per
event, because a line per refused frame makes the refused frame more expensive
than the accepted one and hands an abuser the very amplifier the rate limiter
exists to take away. The flush looks like:

```
[relay pong] warn relay.input-refused pid=... badInput=42 rateDropped=0
```

Wire these in your own host. Without them the relay is silent on both by
design, and the only symptom of a broken `decodeInput` is one player whose
inputs stop while the room, the roster, the snapshots and every other player
stay perfectly healthy.
