# Gates, in full

Moved verbatim from `AGENTS.md`, which keeps the one-line form of each entry
and links here. Inside this file, "the invariants", "the gotchas", "the Gates
section", "the Status section" and "the table" mean
[`invariants.md`](invariants.md), [`gotchas.md`](gotchas.md),
[`gates.md`](gates.md), [`status.md`](status.md) and [`tiers.md`](tiers.md) in
this directory; "above" and "below" mean wherever that file now is.

From the repo root:

```
npx tsc --noEmit           # typecheck, must be clean
npm run lint               # eslint over src, tests, examples, must be clean
npm run build              # rm -rf dist && tsc -p tsconfig.build.json
npm run test:unit          # the unit tier, NO services anywhere, green offline
npm run test:integration   # unit + integration tiers, needs a real Redis
npm run test:measure       # the measurement tier, real Redis AND a quiet machine
npm test                   # all 47 files, every tier, what a developer runs
npm run example:node       # tsx examples/node-server/server.ts, see its README
```

`.github/workflows/ci.yml` runs the typecheck, the build and `test:unit` with no
services on every push and PR to main, and `test:integration` in a second job
against a `redis:8` service container on host port 6399. `release.yml` gates on
build, typecheck and `test:integration` against the SAME service. `nightly.yml`
runs `test:measure` on a schedule, uploads its log as an artifact, and blocks
nothing. `npm install` runs `prepare`, hence `build`, so a broken build fails at
install time. `example:node` is not a gate, it is the fastest way to drive a real
client through a real Redis by hand. The release procedure itself and why the
gate encodes these two rules are in `docs/OPERATIONS.md`, "Cutting a release".

THE SUITE IS TIERED, AND THE TIER IS WHAT DECIDES WHERE A FILE RUNS. Three
tiers, selected by `TICKROOM_TIER` in `vitest.config.ts` (one env var and one
list of globs, rather than three config files that are three chances to add a
new file to two of them):

- `unit`: no services, the outcome decided by the code. 34 files.
- `integration`: real Redis, the outcome STILL decided by the code (a checkpoint
  round trips, a lease is refused, a subscriber survives a reconnect, an
  admission is granted). Includes the unit tier rather than replacing it, so it
  is 43 files, and it is the release gate.
- `measure`: real Redis AND a wall clock (a rate band, a latency bound, a
  zero-tolerance smoothness claim). 4 files. Nightly and by hand on a quiet
  machine, NEVER on a required check. THIS TIER RUNS ITS FILES ONE AT A TIME
  (`fileParallelism: false`), which is part of the measurement rather than a
  convenience: four files each driving a 60Hz render loop and a real socket are,
  in parallel, each other's load. It costs the sum rather than the max, about
  two minutes.

The per-file classification is the table at the end of the Status section, and
that table is the source of truth. A new file under `tests/` runs under `npm
test` from the moment it is written (the default include is still the catch-all
glob) but reaches no gate until it is added to `INTEGRATION` or `MEASUREMENT` in
`vitest.config.ts` and to that table, and `tests/tiers.test.ts` fails the unit
tier if it is in none.

WHY THE MEASUREMENT TIER IS OFF THE RELEASE GATE. It used to be on it, via `npm
test`, and it cost two release runs on two different timing bounds while the same
commit was green locally both times. A publish blocked by a noisy runner is a
publish blocked by nothing, and the pressure that creates is to widen the bound,
which throws away the measurement to save the release. `retry: 1` when `CI` is
set is still in `vitest.config.ts` as the SECOND line, covering the wall-clock
cases that still ride inside `ticker.redis.test.ts` and `faults.redis.test.ts`;
it does not loosen a bound, it asks the host to meet it once more, and locally it
is 0 so a real regression is red on the first run. `JITTER_LIMIT` stays 1.5: it
is not a tolerance on the library, it is the point past which the host has no
instrument, and the fix for a failing measurement on a shared runner is the tier,
not the constant.

BOTH GATING WORKFLOWS REQUIRE REDIS, AND THE RELEASE GATE IS THE ONE THAT DID
NOT. The suite skips cleanly with nothing listening, so a publishing build
without the service exited 0 having run zero assertions in the lease, checkpoint,
handoff, subscriber and fault-injection files. `TICKROOM_REQUIRE_REDIS=1` is
baked into the `test:integration` and `test:measure` scripts so a run started by
hand cannot skip its way to green either, and the workflows repeat it so each
states the requirement rather than inheriting it from a script somebody could
edit. Both `ci.yml` jobs carry `timeout-minutes: 20`, the release job 30 and the
nightly 45, because a hung job that never fails is the same shape of non-gate as
one that cannot fail.

`test:unit` MUST BE GREEN WITH NOTHING LISTENING, and the way to prove it is to
point `TICKROOM_TEST_REDIS_URL` at an unused port
(`TICKROOM_TEST_REDIS_URL=redis://127.0.0.1:6499 npm run test:unit`) rather than
to trust that nothing was running. The real-Redis files namespace every key per
run (`itest-{uuid}`) and delete it afterwards, so they never disturb a shared
instance. Start one with
`redis-server --port 6399 --save '' --appendonly no --daemonize yes`.
On the fw13 server the test Redis runs in rootless Podman rather than a plain
binary, and rootless Podman's default pasta networking adds intermittent
~40ms reply stalls on pipelined commands, which flaked
`tests/smoothness.redis.test.ts` about 1 in 3 runs (a planned handoff missing
the grid adoption window) on an unchanged tree. Run it with host networking
instead:
`podman run -d --name tickroom-redis --network host docker.io/library/redis:8 redis-server --port 6399 --save '' --appendonly no`.

`TICKROOM_SPLITBRAIN_REPS=10 npm run test:measure` IS A LONG FORM, NOT A GATE.
One rep of `tests/splitbrain.redis.test.ts`'s eight cases is what the nightly
runs; ten reps is what a quiet machine runs when anything in `lease.ts`, the
renew cadence or the lease constants moves, because a margin measured once is an
anecdote.

Measured on this tree after a clean build, `npm pack --dry-run` is **81 files,
414.1 kB packed and 1.2 MB unpacked**. Re-measure those three numbers after a
build rather than quoting them forward: they are the only thing that would have
caught the `outDir` gotcha above.

`tsconfig.json` sets `noUncheckedIndexedAccess: false` and
`exactOptionalPropertyTypes: true`, AND THE SECOND ONE IS FOR THE CONSUMER RATHER
THAN FOR US: a stock `tsc --init` enables it, so a host compiles this library's
`.d.ts` under it whether or not they ever chose it. Two rules it imposes that are
not obvious:

- Every optional field on a PUBLIC type is written `?: T | undefined`, and every
  optional callback is a PROPERTY signature, because method shorthand cannot
  carry `| undefined`. Internal code builds objects CONDITIONALLY
  (`...(x === undefined ? {} : { x })`) rather than assigning `undefined`.
- `Required<T>` no longer strips the `undefined`, so `core/lease.ts` resolves its
  defaults through an explicit mapped type instead.

AND THE ONE THAT WILL BITE A FUTURE WIDENING: a type in CALLBACK-PARAMETER
position must not be widened, because contravariance flips it. Widening
`WebSocketLike.onclose`'s event or `upgradeWebSocket`'s options bag would REJECT
a consumer whose handler is typed the stock narrow way. Widen what flows INTO the
library; never widen what it hands to a host's own function. (`any` on the four
`WebSocketLike` handler slots is the deliberate exception, and its invariant says
why nothing narrower works.)

SEMVER NOTE, because property signatures are a source-compatibility break no test
can see: `RoomRuntime`'s optional hooks, `RelaySocket.terminate`/`ping`,
`RedisLike.on`/`off` and the option-bag callbacks are all property signatures,
which drops method BIVARIANCE. A consumer that annotates a hook's parameters
NARROWER than the contract compiled before 0.2.0 and errors now. Everything in
this repo uses contextual typing, so nothing here saw it.

THE BENCH'S OWN VERCEL PROJECT WAS REMOVED ON 2026-09-08 at the owner's request.
Every `tickroom-bench.vercel.app` URL in this file names a deployment that no
longer exists; the numbers stand as measured. The measurement page now lives in
the demo app at `https://tickroom-demo.vercel.app/bench` (room base `bench`, its
own sim with the marker entity and the per-invocation instance id), and the
harness in the tickroom-bench repository targets that URL. The demo's own pages
are the package's site.
