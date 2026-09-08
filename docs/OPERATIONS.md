# Operations

What running this costs, what the platform underneath it will and will not let
you do, and how a release gets cut. The numbers here are measured; where a
figure came from a dated run, [`LEDGER.md`](LEDGER.md) has the run.

- [Cost model](#cost-model)
- [Platform limits](#platform-limits)
- [Redis](#redis)
- [Cutting a release](#cutting-a-release)

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

## Platform limits

**`maxDurationS` is the one number that couples this library to your platform**,
and it is stated once on `createRoom` and repeated as the literal `maxDuration`
each route file exports. The ticker's loop stops at
`min(700s, maxDurationS * 1000 - 30s)`, because the final checkpoint, the lease
release and the successor spawn all happen after the loop and the platform must
not kill them; the relay announces `relay-expiring` at
`maxDurationS * 1000 - 10s` so the client swaps to a replacement socket before
the function dies. The direction matters: the platform cap can only ever *lower*
the ticker's lifetime, so raising `maxDuration` does not extend the loop past
700s. Both derivations are subtractions and both have floors checked at route
creation, so a `maxDurationS` too small to fit fails on the first request rather
than announcing and closing every socket forever.

**800 is a Vercel Pro cap; 300 is the platform default and the Hobby cap.** At
300 the ticker's handoff period is 270s and the relay's swap period 290s, and at
800 they are 700s and 790s. Both were measured on a real Pro deployment at zero
server ticks lost per handoff either way; the runs are in
[`VERIFICATION.md`](VERIFICATION.md).

**Turn Vercel Authentication off, or bypass it on the spawn.** Deployment
Protection is on by default for a personal project and guards every request to
the deployment *including one of its own functions calling another*, so it
answers the relay's fire-and-forget spawn of the ticker route with an SSO
redirect. That spawn is caught and discarded by design, so nothing anywhere
errors: a socket opens, the player joins, the roster seeds, and then the room
sits in perfect silence with no ticker ever started and no `/api/ticker` line in
the invocation log at all. That absence is the whole signal. Either turn
Protection off, which is the right answer for anything meant to be reachable by
a browser that has not signed into your Vercel account, or set
`VERCEL_AUTOMATION_BYPASS_SECRET` and send it on the spawn.

**Fluid compute can run a standby successor in the same container as the
incumbent**, so an instance id generated at module scope does not mark a
handoff: the module was evaluated once, and a successor built from a
module-scope id publishes the identical id its predecessor published. Nothing in
the library is wrong there (the lease and the checkpoint carry the handoff
correctly either way); the observer is. Generate any such id *per invocation*,
inside the route handler.

**`standbyMs` has to outlive the incumbent's exit.** The standby successor is
spawned `standbyLeadMs` (3000) before the cap and polls the lease until it wins
or gives up, so `standbyMs` must comfortably exceed that lead *plus* the
incumbent's own final checkpoint and release, and must fit *inside* `maxRunMs`,
because a standby's poll is spent out of the same lifetime budget the platform
measures from the moment the request arrived. The routes pass 8000 against 3000.
Leave both alone and the defaults already satisfy this.

**The first ceiling you hit is concurrent connections, not commands.** Every
socket needs its own subscriber, because a connection in subscribe mode cannot
run ordinary commands. That is why the relay enforces a per-user socket cap:
without it, one client opening sockets can exhaust the connection ceiling and
take the room's own ticker subscriber down with it, which is a total outage
rather than a nuisance. A real deployment measured a peak of 8 Redis connections
for three players plus the ticker and the harness, roughly two per player.

## Redis

**It has to be a real TCP client (`rediss://`).** A REST-style Redis API cannot
subscribe, which rules out several managed "Redis-compatible" HTTP products for
the bus specifically.

**Pick a flat-rate plan.** Per-command billing on this traffic shape is roughly
two orders of magnitude more expensive than flat-rate, and the same room that
costs about $30/month flat costs thousands metered.

**A Redis DB index does not isolate two deployments, and `namespace` does.**
Keys are per database, but pub/sub is instance-wide, so staging on `/1` and
production on `/0` publish into the identical `room:pong:in` and `room:pong:out`
while each acquires its own lease against its own key and each believes it is
the exactly-one writer: two authorities, no error anywhere, and the lease
mechanism unable to see it because it is doing its job correctly on each
database separately. `namespace` prefixes keys *and* channels together and has
to be set on every route; `createRoom` states it once for exactly that reason.
There is a second reason to leave the DB index alone: ioredis re-issues
`select(db)` on every reconnect with nothing catching the promise, so the shared
client belongs on db 0.

**Upstash's `CLIENT LIST` carries no subscribe-mode fields.** A real Redis
answers with `flags=`, `sub=`, `psub=` and `ssub=` on every line; Upstash answers
`id addr laddr db name lib-name lib-ver` and stops, so a count of lines matching
a subscribe flag reads **zero** while a ticker subscriber and one subscriber per
relay socket are certainly live. That is a plausible-looking number and a false
one. `INFO clients` `connected_clients` is accurate and is what to use, and
anything reporting the subscriber split has to say "not reported" on a provider
that does not report it rather than print the zero.

## Cutting a release

`npm version <level>` plus a pushed tag is the whole procedure.
`.github/workflows/release.yml` publishes from the tag through **npm trusted
publishing (OIDC)**, so there is no stored npm token anywhere and the package
carries a signed provenance statement. That workflow's header is the operating
manual; the trusted-publisher entry lives on npmjs.com under the package's
Settings, naming this repository and `release.yml`.

Two rules the failed attempts left behind, both of which the workflow now
encodes:

- **The release gate runs the integration tier, never the measurement one.** Its
  bounds are readings rather than tolerances, and a shared runner cannot take a
  reading: v0.3.0 failed twice on two different timing bounds while the same
  commit was green locally both times. A publish blocked by a noisy runner is a
  publish blocked by nothing, and the pressure that creates is to widen the
  bound, which throws away the measurement to save the release.
- **The release job stands up the same Redis service CI does, and requires it.**
  The real-Redis files skip cleanly when nothing is listening, which is right on
  a laptop and exactly wrong in the job whose only purpose is to run them:
  without the service the publishing build exited 0 having executed zero
  assertions in the lease, checkpoint, handoff, subscriber and fault-injection
  suites. `TICKROOM_REQUIRE_REDIS=1` makes the probe throw instead of skipping. A
  gate that cannot fail is worse than no gate, and this is the one build whose
  version number is burned forever.

The measurement tier runs nightly instead (`.github/workflows/nightly.yml`,
reporting only, uploading its log as an artifact and blocking nothing) and by
hand on a quiet machine.

The package also installs as a git dependency, which is what
`"prepare": "npm run build"` exists for: `dist/` is gitignored and every
`exports` path points into it, so without the hook a `github:` install resolves
to a package with no code in it. Publishing to npm did not retire the hook,
because `npm publish` runs it too.

`build` is `rm -rf dist && tsc -p tsconfig.build.json`, and the `rm -rf` is load
bearing: `tsc` never cleans `outDir`, so a scratch directory compiled once and
since deleted from `src/` stays in `dist/` forever and is packed, with nothing
reporting it. Measured on this tree after a clean build, `npm pack --dry-run` is
**73 files, 386.4 kB packed and 1.1 MB unpacked**. Re-measure those three numbers
after a build rather than quoting them forward.
