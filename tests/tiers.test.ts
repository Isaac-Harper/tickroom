// EVERY FILE UNDER `tests/` IS IN EXACTLY ONE TIER. The catch-all `npm test`
// glob runs a new file from the moment it exists, which is what hides the
// mistake this guards against: a file that is in no tier runs for a developer
// and never for a gate. Measured once, on the day the tiers landed: a branch
// written in parallel added `depth.redis.test.ts`, the catch-all ran it, the
// integration tier did not, and only the arithmetic (46 files under `npm
// test`, 45 across the tiers) gave it away. A file in two tiers is the other
// half of the same mistake, counted twice by the release gate.
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { UNIT, INTEGRATION, MEASUREMENT } from '../vitest.config.js';

const unitExplicit = UNIT.filter((entry) => entry.startsWith('tests/'));
const integrationExplicit = INTEGRATION.filter((entry) => entry.startsWith('tests/') && !unitExplicit.includes(entry));

describe('the test tiers', () => {
  it('place every file under tests/ in exactly one tier', () => {
    const files = readdirSync('tests')
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => `tests/${name}`)
      .sort();
    const misplaced: string[] = [];
    for (const file of files) {
      const hits = [unitExplicit, integrationExplicit, MEASUREMENT].filter((tier) => tier.includes(file)).length;
      if (hits !== 1) misplaced.push(`${file} is in ${hits} tiers`);
    }
    expect(misplaced, 'add the file to UNIT, INTEGRATION or MEASUREMENT in vitest.config.ts, once').toEqual([]);
    // And no tier names a file that does not exist, which is the same mistake
    // one rename later.
    const listed = [...unitExplicit, ...integrationExplicit, ...MEASUREMENT];
    expect(listed.filter((file) => !files.includes(file))).toEqual([]);
  });
});
