// Does `tickroom/client` actually build for a browser?
//
// This is not a unit test of any behaviour, it is a build-integration gate, and
// it exists because the answer was NO and nothing caught it. `netPolicy.ts`
// imported one constant from the core barrel, that barrel re-exports the
// checkpoint module, and the checkpoint module imports `node:zlib` and
// `node:util` at module scope. Every unit test passed, `tsc --noEmit` was clean,
// and `npm run build` emitted `dist/` without complaint, because all three run
// in Node where those builtins resolve fine.
//
// The failure only appears at the one moment nothing in the repo exercised: a
// downstream project bundling for the browser, where it is a HARD ERROR
// (`Could not resolve "node:zlib"`, exit non-zero), not a warning and not merely
// wasted bytes. That is the worst possible place to discover it, since it lands
// on the person integrating the library rather than on the person who broke it.
//
// So the gate runs a real browser-target bundle of the real client entrypoint.
// A static import scan would be cheaper but weaker: it would have to reimplement
// module resolution to follow a barrel re-export into a transitive dependency,
// which is exactly the step the original bug hid behind.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
let workDir = '';

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tickroom-bundle-'));
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/**
 * Bundles an entry module for the browser and returns esbuild's outcome.
 * The entry is written INSIDE the repo so relative imports and the repo's own
 * `node_modules` resolve exactly as a real consumer's would.
 */
function bundleForBrowser(source: string, name: string): { ok: boolean; stderr: string } {
  const entry = join(repoRoot, `.bundle-probe-${name}.ts`);
  writeFileSync(entry, source, 'utf8');
  try {
    execFileSync(
      'npx',
      [
        'esbuild',
        entry,
        '--bundle',
        '--platform=browser',
        '--format=esm',
        `--outfile=${join(workDir, `${name}.js`)}`,
      ],
      { cwd: repoRoot, stdio: 'pipe' },
    );
    return { ok: true, stderr: '' };
  } catch (err) {
    const e = err as { stderr?: Buffer; message?: string };
    return { ok: false, stderr: e.stderr?.toString() ?? e.message ?? 'unknown bundling failure' };
  } finally {
    rmSync(entry, { force: true });
  }
}

describe('browser bundling', () => {
  it(
    'bundles the client entrypoint with no Node builtins in the graph',
    () => {
      const result = bundleForBrowser(
        `import { RoomConnection, SnapshotInterpolator, ErrorOffset, ClientTick, stallDecision } from './src/client/index.js';\n` +
          `export const used = [RoomConnection, SnapshotInterpolator, ErrorOffset, ClientTick, stallDecision];\n`,
        'client',
      );
      // Naming the offending builtin in the failure message matters: the fix is
      // always "stop reaching a Node-only module from client code", and the
      // module name is the whole diagnosis.
      expect(result.stderr).not.toMatch(/node:(zlib|util|crypto|fs|net|http)/);
      expect(result.ok, `client failed to bundle for the browser:\n${result.stderr}`).toBe(true);
    },
    60_000,
  );

  it(
    'bundles the codec entrypoint for the browser too',
    () => {
      // The codec is shared: a client encodes inputs with the same helpers the
      // server decodes them with, so it has to survive a browser bundle as
      // surely as the client does.
      const result = bundleForBrowser(
        `import { ByteWriter, ByteReader, quantizeCm, encodeInputWindow } from './src/codec/index.js';\n` +
          `export const used = [ByteWriter, ByteReader, quantizeCm, encodeInputWindow];\n`,
        'codec',
      );
      expect(result.stderr).not.toMatch(/node:(zlib|util|crypto|fs|net|http)/);
      expect(result.ok, `codec failed to bundle for the browser:\n${result.stderr}`).toBe(true);
    },
    60_000,
  );

  it(
    'still bundles the server entrypoint for node',
    () => {
      // The complement, so a future "fix" that moved the Node dependency out of
      // core by breaking the server cannot pass unnoticed. The server is
      // ALLOWED its builtins; it just may not be on the browser's graph.
      const entry = join(repoRoot, '.bundle-probe-server.ts');
      writeFileSync(
        entry,
        `import { runTicker, attachRelay, assignRoom } from './src/server/index.js';\n` +
          `export const used = [runTicker, attachRelay, assignRoom];\n`,
        'utf8',
      );
      try {
        execFileSync(
          'npx',
          [
            'esbuild',
            entry,
            '--bundle',
            '--platform=node',
            '--format=esm',
            '--external:ioredis',
            `--outfile=${join(workDir, 'server.js')}`,
          ],
          { cwd: repoRoot, stdio: 'pipe' },
        );
      } catch (err) {
        const e = err as { stderr?: Buffer };
        expect.fail(`server failed to bundle for node:\n${e.stderr?.toString() ?? ''}`);
      } finally {
        rmSync(entry, { force: true });
      }
    },
    60_000,
  );
});
