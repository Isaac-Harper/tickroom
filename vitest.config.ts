import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'examples/**/*.test.ts'],
    environment: 'node',
    // ON A CI RUNNER ONLY, one retry. The twelve Redis-backed files are
    // wall-clock measurements, and the shared runner behind the release
    // workflow fired a timer late enough to fail two different bounds on two
    // consecutive runs of the same commit while the suite was green locally
    // both times. A retry does not loosen a bound; it asks the host to try to
    // meet it once more. Locally nothing changes, so a real regression is
    // still red on the first run here.
    retry: process.env['CI'] === undefined ? 0 : 1,
  },
});
