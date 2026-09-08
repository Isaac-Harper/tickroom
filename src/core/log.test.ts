// THE HALF OF THE LOG-KIND CONTRACT `tsc` CANNOT SEE. `LogEvent.kind` is the
// `LOG_KINDS` union, so every `log({ kind: '...' })` is checked at compile
// time. What the compiler cannot say is the converse: that every kind in the
// union is still EMITTED somewhere, and that a kind reaching `log` through a
// variable or a template literal is in the list. So this reads the source.
//
// A kind in the union that nothing emits is a dead name a consumer will
// switch on forever, which is exactly how `ticker.fresh` came to be diagnosed
// against before it existed.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_KINDS } from './log.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every non-test `.ts` file under `src/`, read as text. */
function sources(dir: string = SRC): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push({ file: path, text: readFileSync(path, 'utf8') });
  }
  return out;
}

const SOURCES = sources().filter((s) => !s.file.endsWith(join('core', 'log.ts')));

/** Every `kind: '...'` literal in the source, the shape of a direct emission. */
function emittedLiterals(): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const { file, text } of SOURCES) {
    for (const m of text.matchAll(/\bkind:\s*'([^']+)'/g)) {
      const list = seen.get(m[1]!) ?? [];
      list.push(file);
      seen.set(m[1]!, list);
    }
  }
  return seen;
}

/** Every quoted string that LOOKS like a kind (`emitter.event`), wherever it sits: a kind passed through a parameter is one of these. */
function quotedKindLike(): Set<string> {
  const seen = new Set<string>();
  const prefixes = new Set(LOG_KINDS.map((k) => k.split('.')[0]!));
  for (const { text } of SOURCES) {
    for (const m of text.matchAll(/'([a-z-]+)\.([A-Za-z-]+)'/g)) {
      // A quoted file name (`'relay.ts'`) has the shape and is not a kind.
      if (prefixes.has(m[1]!) && m[2] !== 'ts' && m[2] !== 'js') seen.add(`${m[1]}.${m[2]}`);
    }
  }
  return seen;
}

describe('LOG_KINDS', () => {
  it('lists each kind once', () => {
    expect(new Set(LOG_KINDS).size).toBe(LOG_KINDS.length);
  });

  it('every kind in the union is emitted somewhere under src/', () => {
    const quoted = quotedKindLike();
    const dead = LOG_KINDS.filter((k) => !quoted.has(k));
    expect(dead, 'kinds nothing under src/ mentions').toEqual([]);
  });

  it('every `kind:` literal under src/ is in the union', () => {
    // Belt and braces over `tsc`: a literal the compiler already checks, and a
    // template literal or a widened string it would not.
    const union = new Set<string>(LOG_KINDS);
    const unlisted = [...emittedLiterals()].filter(([k]) => !union.has(k)).map(([k, files]) => `${k} (${files.join(', ')})`);
    expect(unlisted, 'emitted kinds missing from LOG_KINDS').toEqual([]);
  });

  it('every quoted kind-shaped string under src/ is in the union, so a kind passed through a variable is caught too', () => {
    const union = new Set<string>(LOG_KINDS);
    const unlisted = [...quotedKindLike()].filter((k) => !union.has(k));
    expect(unlisted, 'kind-shaped literals missing from LOG_KINDS').toEqual([]);
  });

  it('is grouped by emitter, with the prefix naming the file that emits it', () => {
    for (const kind of LOG_KINDS) {
      expect(kind).toMatch(/^(ticker|relay|node-relay|balancer)\.[A-Za-z-]+$/);
    }
  });
});
