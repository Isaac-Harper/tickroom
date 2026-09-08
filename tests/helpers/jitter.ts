// HOW LATE THIS HOST ACTUALLY FIRES A TIMER, measured once per worker.
//
// Several files in this suite are genuine WALL-CLOCK measurements: they drive
// the real chain (a real socket, a real Redis, a real 60Hz render loop) and
// then assert on what a player would have seen. Their headline claims are
// zero-or-not properties, deliberately so: "no frame stepped backwards", "no
// frame was motionless", "the tick count is continuous". There is no honest
// way to scale a bound of zero, and there is no honest way to measure a 60Hz
// render loop on a machine that cannot deliver a timer within half its
// period. Run under enough load, those files stop measuring the library and
// start measuring the runner, which is how they ended up red on three
// full-suite runs while every one of them was green run alone.
//
// THIS GATE IS THE SECOND LINE, NOT THE FIRST. The first is the tier split in
// `vitest.config.ts`: the four whole-file measurements (`smoothness`,
// `splitbrain`, `example`, `example-cursors`) are the `measure` tier and are
// not on the release gate's path at all, they run nightly and on a quiet
// machine. What this gate covers is the measurement cases that still ride
// along inside otherwise deterministic integration files
// (`ticker.redis.test.ts`, `faults.redis.test.ts`) plus the measurement tier
// itself when someone runs it on a loaded host anyway. In both places the
// answer is the same: skip, loudly, with the measured number in the reason.
//
// So the calibration below decides whether the measurement is possible at
// all, and the files it gates SKIP LOUDLY rather than loosening a bound they
// cannot loosen. A skip is a worse outcome than a pass and a better one than
// a red that means nothing, and `jitterSkipReason` names the number it
// measured so a skipped run says why.
//
// The probe is twelve samples of a 25ms `setTimeout`, reported as a factor:
// 1.0 is a host firing exactly on time. An IDLE machine measures 1.05 to
// 1.10, not 1.00, because node's own per-timer overhead is a millisecond or
// two; 25ms rather than 10 is what keeps that overhead down to a rounding
// error instead of a fifth of the reading.

const SAMPLES = 12;
const DELAY_MS = 25;

/**
 * The factor above which the wall-clock cases skip. 1.5 is timers landing
 * half again as late as they were asked for, which an idle host (1.05 to
 * 1.10) is nowhere near and a machine running a full suite across every core
 * reaches easily. Deliberately a long way above the idle reading, so this
 * never fires on the machine the numbers in those files were measured on.
 *
 * DO NOT RAISE THIS TO GET A RUN GREEN, and that is the whole reason this
 * paragraph is here rather than a looser number being here. The limit is not a
 * tolerance on the library's behaviour, it is the point past which the probe
 * says this host cannot measure a 60Hz loop at all; raising it does not make a
 * loaded runner able to measure, it makes the suite assert a bound it has no
 * instrument for and calls the result a pass. If a measurement is failing on a
 * shared runner the fix is the TIER, not this constant: move the case to the
 * `measure` tier (`vitest.config.ts`) so it runs where the reading is honest.
 * The only thing that would justify moving this number is a re-measurement of
 * what an idle host actually reads, and then it moves for that reason and the
 * new reading is recorded here.
 */
export const JITTER_LIMIT = 1.5;

/** One pass of the probe. Exported for a test that wants to take its own reading rather than the module-level one. */
export async function measureTimerJitter(samples: number = SAMPLES, delayMs: number = DELAY_MS): Promise<number> {
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const at = Date.now();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    total += Date.now() - at;
  }
  return Math.max(1, total / samples / delayMs);
}

/**
 * Taken at module load, exactly like `probeRedisAvailable` in `env.ts` and
 * for the same reason: `describe`/`it` bodies are collected synchronously, so
 * a skip decision made in an async `beforeAll` would always see the initial
 * value rather than the measured one. A top-level `await` puts the real
 * answer in hand before the first `describe` runs.
 */
export const TIMER_JITTER = await measureTimerJitter();

/** True when this host is too loaded for a wall-clock measurement to mean anything. */
export const TOO_JITTERY = TIMER_JITTER > JITTER_LIMIT;

export function jitterSkipReason(label: string): string {
  return (
    `[tickroom integration: ${label}] this host fired a ${DELAY_MS}ms timer ` +
    `${TIMER_JITTER.toFixed(2)}x late over ${SAMPLES} samples, past the ${JITTER_LIMIT}x ` +
    `limit; skipping the wall-clock cases, which would measure the machine rather than ` +
    `the library. Re-run on an idle machine (an idle one reads 1.05 to 1.10), or run ` +
    `this file on its own.`
  );
}
