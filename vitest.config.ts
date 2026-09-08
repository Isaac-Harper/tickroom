import { defineConfig } from 'vitest/config';

// THREE TIERS, ONE CONFIG, SELECTED BY `TICKROOM_TIER`.
//
// The tiers exist because the 44 test files answer three different questions
// and a single run conflates them. A `unit` file needs no services and its
// outcome is decided by the code. An `integration` file needs a real Redis and
// its outcome is still decided by the code: a checkpoint round trips or it does
// not, a subscriber survives a reconnect or it dies, an admission is refused or
// it is not. A `measurement` file needs a real Redis AND asserts on WALL CLOCK:
// a rate band, a latency bound, or a zero-tolerance smoothness claim ("no frame
// stepped backwards", "no frame was motionless"). The first two are the same
// answer on any machine. The third is only an answer on a machine quiet enough
// to measure, which a shared GitHub runner is not: the v0.3.0 release failed
// twice on two different timing bounds while the same commit was green locally
// both times.
//
// So the release gate runs `integration` and the measurement tier runs
// elsewhere, nightly and on a quiet machine. The classification per file is the
// table in AGENTS.md, and it is the source of truth; the globs below follow it.
//
// The tier is chosen with an env var rather than with three config files
// because one list of globs in one place is the thing a future file has to be
// added to, and three files is three chances to add it to two of them. The npm
// scripts set the var (`test:unit`, `test:integration`, `test:measure`); with
// it unset this is the whole suite, which is what `npm test` runs and what a
// developer runs.

/** No services at all. Must pass with nothing listening anywhere, which is the claim `tests/memory.test.ts` exists to check. */
const UNIT = ['src/**/*.test.ts', 'examples/**/*.test.ts', 'tests/memory.test.ts'];

/**
 * Real Redis, deterministic outcomes. The unit tier is included rather than
 * replaced: this is the release gate, and a gate that skips the fast half to
 * save a minute is a gate with a hole in it.
 *
 * `ticker.redis.test.ts` and `faults.redis.test.ts` are here despite each
 * carrying a few wall-clock cases, because the rest of each file is
 * deterministic and worth gating on. Their measurement cases are gated INSIDE
 * the file on `TOO_JITTERY` (`tests/helpers/jitter.ts`), so a loaded runner
 * skips those cases loudly with the measured number in the reason rather than
 * reddening the release on a bound it cannot honestly measure.
 */
const INTEGRATION = [
  ...UNIT,
  'tests/checkpoint.redis.test.ts',
  'tests/e2e.redis.test.ts',
  'tests/faults.redis.test.ts',
  'tests/lease.redis.test.ts',
  'tests/pubsub.redis.test.ts',
  'tests/redisLike.test.ts',
  'tests/subscriber.redis.test.ts',
  'tests/ticker.redis.test.ts',
];

/**
 * Real Redis and a wall clock. Every case in these four files asserts on
 * timing, on a rate band, or on a zero that a loaded host cannot deliver, so
 * the files are measurement end to end rather than mixed. They run nightly and
 * on the fw13 machine, never as a required check, and they skip loudly rather
 * than loosening a bound: see `tests/helpers/jitter.ts`.
 */
const MEASUREMENT = [
  'tests/example-cursors.redis.test.ts',
  'tests/example.redis.test.ts',
  'tests/smoothness.redis.test.ts',
  'tests/splitbrain.redis.test.ts',
];

/**
 * Unset means everything, which is `npm test`: the whole suite, exactly the
 * glob this file has always carried. It stays a CATCH-ALL rather than the
 * concatenation of the three tiers on purpose, so a thirteenth file under
 * `tests/` runs somewhere from the moment it is written. It still has to be
 * added to `INTEGRATION` or `MEASUREMENT` above to reach a gate, and to the
 * classification table in AGENTS.md to be findable.
 */
const ALL = ['src/**/*.test.ts', 'tests/**/*.test.ts', 'examples/**/*.test.ts'];

function includeFor(tier: string | undefined): string[] {
  switch (tier) {
    case undefined:
      return ALL;
    case 'unit':
      return UNIT;
    case 'integration':
      return INTEGRATION;
    case 'measure':
      return MEASUREMENT;
    default:
      throw new Error(`TICKROOM_TIER=${tier} is not one of unit, integration, measure`);
  }
}

const tier = process.env['TICKROOM_TIER'];

export default defineConfig({
  test: {
    include: includeFor(tier),
    environment: 'node',
    // THE MEASUREMENT TIER RUNS ITS FILES ONE AT A TIME, AND THAT IS PART OF
    // THE MEASUREMENT RATHER THAN A CONVENIENCE. Four files that each drive a
    // 60Hz render loop, a 10Hz send loop and a real socket are, run in
    // parallel, each other's load: measured here, the cursors example fails on
    // probes a starved timer coalesced when the four race and passes run alone
    // on the same tree in the same minute. Vitest's default pool is right for
    // the other two tiers, where nothing depends on a timer landing on time,
    // and wrong for this one, where every assertion does. It costs the sum
    // instead of the max, about two minutes, which is what the nightly job's
    // 45 minute budget is for.
    fileParallelism: tier !== 'measure',
    // THE SECOND LINE, NOT THE FIRST. The first is the tier split above: the
    // release gate no longer runs the measurement files at all, so the bounds
    // that failed two release runs are not on that path any more. This is what
    // remains for the wall-clock cases that still ride along inside
    // `ticker.redis.test.ts` and `faults.redis.test.ts` on a CI runner, and for
    // the nightly measurement job. A retry does not loosen a bound; it asks the
    // host to try to meet it once more. Locally nothing changes, so a real
    // regression is still red on the first run here.
    retry: process.env['CI'] === undefined ? 0 : 1,
  },
});
