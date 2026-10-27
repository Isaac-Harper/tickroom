# Status and still owed, in full

Moved verbatim from `AGENTS.md`, which keeps the one-line form of each entry
and links here. Inside this file, "the invariants", "the gotchas", "the Gates
section", "the Status section" and "the table" mean
[`invariants.md`](invariants.md), [`gotchas.md`](gotchas.md),
[`gates.md`](gates.md), [`status.md`](status.md) and [`tiers.md`](tiers.md) in
this directory; "above" and "below" mean wherever that file now is.

MEASURED ON THIS TREE, not estimated, PER TIER, on the 1.3.0 tree:
`npm run test:unit` is **1219 passed across 34 files** with
`TICKROOM_TEST_REDIS_URL` pointed at an unused port (6499), which is the
no-services promise proved rather than assumed; `npm run test:integration` is
**1267 across 43** with a local Redis on 6399; `npm run test:measure` is **16
across 4** on the same Redis and a quiet laptop (not re-run for 1.2.0 or 1.3.0,
which touched no measurement file); `npm test` is the sum, **1283 across 47**. `npx tsc --noEmit` is clean repo-wide including `examples/`, and
`npm run build` emits `dist/` cleanly. Roughly 18,700 lines of source and 28,700
of tests. `README.md`, `AGENTS.md`, the five files under `docs/` and the six
under `docs/agents/` are the whole of the prose.

Forced jittery (`JITTER_LIMIT` dropped to 1.0 for the check, then restored) the
integration tier still exits 0 with its wall-clock cases skipped and the
measurement tier is all skipped and still exits 0, which is the loud-skip path
exercised rather than argued.

THE LONG RUNS HAPPEN ON A SECOND MACHINE. Anything that takes minutes (the whole
suite, the split-brain long form, the bench's own multi-client runs) executes on
the fw13 server, a 16-core NixOS box, with Redis in Podman (host networking,
see the gotcha above) and the browser
harness in the official Playwright container rather than on the laptop. A machine
with sixteen cores busy is not a slower laptop, it is a different measurement,
and that is how the last wall-clock cases were found.

THE WALL-CLOCK CASES WERE FIXED AT THE SOURCE RATHER THAN GATED BY
DOCUMENTATION: `connection.test.ts`'s reconnect ladder steps timer to timer;
`relay.test.ts`'s throttled-interval liveness pair runs on fake timers;
`ticker.test.ts`'s grid-stamp, stall-resync and checkpoint-ordering runs end on a
SAMPLE COUNT, and its lease-theft case waits for the loop to go quiet; the
successor-spawn race carries a calibrated tolerance (`JITTER_SCALE`, capped at
3x); the DOM `WebSocket` assignment test guards the global. THE FILES THAT CANNOT
BE FIXED AT THE SOURCE KEEP THEIR TIGHT BARS, MOVE TO THE MEASUREMENT TIER, AND
SKIP LOUDLY: `smoothness`, `splitbrain`, `example` and `example-cursors` assert
zero backward steps, zero motionless frames, a millisecond overlap between two
real tickers and a snapshot rate inside +-10%, and there is no honest way to
scale a bound of zero. Three cases of `ticker.redis.test.ts` and three of
`faults.redis.test.ts` stay inside their otherwise deterministic files and carry
the same gate per case (`itSteady = it.skipIf(TOO_JITTERY)`), because the rest of
each file is worth gating a release on.

PER FILE, which is what a mutation row is measured against: re-measure a file's
case count and its mutation rows when you touch the file they cover.

- Extracted and implemented: core, server, client, codec, adapters, plus three
  examples (a 2D game, a presence layer, a plain Node host).
- PUBLISHED to npm. DEPLOYED AND MEASURED ON A REAL VERCEL PROJECT, so the
  platform claims are no longer the untested half; the numbers are in
  `docs/VERIFICATION.md`. It has still never carried production traffic, so every
  claim here is unit-level, integration-level, browser-level and platform-level,
  plus whatever the source architecture already proved in production. IF YOU ARE
  UPDATING STATUS, UPDATE EVERY PLACE THAT STATES IT: this bullet once
  contradicted both the release workflow and the real-Redis section of the same
  file.
- Every test runs offline against `src/server/memoryRedis.ts`, which was built
  specifically to reproduce the production incidents this design exists to
  prevent (lease theft, the subscribe race, liveness and pong, backpressure
  fairness) deterministically and without a service, and which SHIPS, so what a
  no-Redis consumer gets is the object the suite exercises thousands of times a
  run rather than a second implementation nobody checks.
- The upstream game this was extracted from is the production evidence for the
  design: the lease, the checkpoint handoff, the playout timeline, the stall
  thresholds and the interpolation rules were all measured there under real load.
  Where a number in a comment is quoted as "measured", that is where it came from.

## Still owed

Everything the pre-1.0 list closed is in the repository history, dated, with the
measurement that paid for it. What is genuinely open:

- **A Safari read without the per-sample switch, and mobile.** Safari throttles
  far less than Chromium, which is the safe direction, but WebDriver would not
  report a background tab's state while another tab sat in front of it, so the
  harness switched to the measured tab for each 30s sample and back. That is a
  tab hidden thirty seconds at a time, not one hidden straight through. Reading
  it without the switch needs a `BroadcastChannel` to a visible helper tab, or
  the page posting its own state to the server. Mobile is untouched.
- **The relay swap's FAILURE path under a throttle.** A successful swap is
  message-driven and rides through a hidden tab's throttle; a failed one falls
  back to the reconnect ladder, which is a TIMER the throttle does reach, so that
  outage can still stretch toward a minute. Untested.
- **Nothing drives an example through the VERCEL adapter in process.** Both
  shipped examples go through a real socket in CI, pong on the stamped path and
  cursors on the unstamped one, and the bench deployment IS the drive through the
  Vercel adapter, so what is missing is a test rather than a measurement.
- **`TARGET_DEPTH_TICKS` (2) is a reasoned default, not a swept one.** The
  headroom beside it IS swept and the one-tick deadband was measured worse;
  sweeping the target would mean exposing the constant as an option, which was a
  deliberate no.
- **The arrival band's last two readings.** A socket `message`-timestamp ring
  confirmed every frame-inferred gap over 250ms at the socket itself, so the band
  is the WebSocket path rather than the renderer, the ticker, the bus or the
  relay. Still owed: the same run from a quiet machine on a residential link
  rather than a loaded container, and a whole-process stall detector in the page
  (a `setInterval` heartbeat gap ring), because a blocked event loop stops the
  `message` handler too and cannot be told apart from inside it. `socket` means
  "not only the render loop", never "the network".
