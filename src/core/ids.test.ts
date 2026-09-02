import { describe, expect, it } from 'vitest';
import { baseOf, MAX_ROOMS_PER_BASE, normalizeBase, normalizeRoomId, parseRoomId, roomIdFor, roomKeys } from './ids.js';

const ROOMS = new Set(['lobby', 'arena', 'park']);
const isValidBase = (b: string): boolean => ROOMS.has(b);
const FALLBACK = 'lobby';

describe('roomKeys', () => {
  it('builds every suffix under the namespace', () => {
    const keys = roomKeys('park');
    expect(keys).toEqual({
      in: 'room:park:in',
      out: 'room:park:out',
      lease: 'room:park:lease',
      state: 'room:park:state',
      stats: 'room:park:stats',
      meta: 'room:park:meta',
      metaout: 'room:park:metaout',
    });
  });

  it('honours a custom namespace', () => {
    const keys = roomKeys('park', 'tr');
    expect(keys.state).toBe('tr:park:state');
  });
});

describe('roomIdFor', () => {
  it('instance 0 is byte-for-byte the bare base id', () => {
    expect(roomIdFor('lobby', 0)).toBe('lobby');
  });

  it('any other instance suffixes with ~N', () => {
    expect(roomIdFor('lobby', 3)).toBe('lobby~3');
  });
});

describe('parseRoomId', () => {
  it('parses a bare id as index 0', () => {
    expect(parseRoomId('lobby')).toEqual({ base: 'lobby', index: 0 });
  });

  it('parses a numbered instance', () => {
    expect(parseRoomId('lobby~3')).toEqual({ base: 'lobby', index: 3 });
  });

  it('rejects a negative index', () => {
    expect(parseRoomId('lobby~-1')).toBeNull();
  });

  it('rejects a fractional index', () => {
    expect(parseRoomId('lobby~1.5')).toBeNull();
  });

  it('rejects a trailing tilde with no digits', () => {
    expect(parseRoomId('lobby~')).toBeNull();
  });

  it('rejects a double tilde', () => {
    expect(parseRoomId('lobby~~2')).toBeNull();
  });

  it('rejects an empty base before the tilde', () => {
    expect(parseRoomId('~2')).toBeNull();
  });

  it('round-trips through roomIdFor', () => {
    for (const [base, index] of [
      ['lobby', 0],
      ['lobby', 1],
      ['arena', 49],
    ] as const) {
      const id = roomIdFor(base, index);
      expect(parseRoomId(id)).toEqual({ base, index });
    }
  });
});

describe('baseOf', () => {
  it('strips a numbered suffix', () => {
    expect(baseOf('lobby~7')).toBe('lobby');
  });

  it('returns a bare id unchanged', () => {
    expect(baseOf('lobby')).toBe('lobby');
  });

  it('falls back to the raw string for something unparseable rather than throwing', () => {
    expect(baseOf('lobby~-1')).toBe('lobby~-1');
  });
});

describe('normalizeRoomId: the trust boundary', () => {
  it.each([
    ['a:b', 'contains a colon, which would smuggle extra key segments'],
    ['__proto__', 'a prototype-chain property name'],
    ['constructor', 'a prototype-chain property name'],
    ['toString', 'a prototype-chain property name'],
    ['lobby~999', 'index past the room cap'],
    ['lobby~-1', 'negative index'],
    ['lobby~1.5', 'fractional index'],
    ['', 'empty string'],
    ['a'.repeat(200), 'far past the length cap'],
    ['lob by', 'contains whitespace'],
    ['lobby\x07', 'contains a non-whitespace control character'],
    ['lobby*', 'contains a Redis glob wildcard'],
    ['nope', 'a base id the registry does not recognise'],
  ])('falls back for %j (%s)', (raw) => {
    expect(normalizeRoomId(raw, { isValidBase, fallback: FALLBACK })).toBe(FALLBACK);
  });

  // THE CHARACTER FILTER AND THE LENGTH CAP, MEASURED APART FROM THE
  // REGISTRY CHECK, which is the only way either of them is observable at
  // all. Every case in the table above ALSO fails `isValidBase` (the
  // registry three lines up holds lobby/arena/park and nothing else), so the
  // fallback it observes is produced by the registry and says nothing about
  // the two guards that ran before it: deleting the `FORBIDDEN_CHARS` test
  // or the length comparison outright left every one of those cases green.
  // The cases below hand `normalizeRoomId` a registry that RECOGNISES the
  // dirty id, so the guard under test is the only thing left that can refuse
  // it, and each group carries a control that must still be ACCEPTED so a
  // fallback cannot come from somewhere else and read as coverage.
  //
  // A registry recognising an id with a colon or a control byte in it is not
  // a contrived setup: `isValidBase` is host-supplied, the module comment
  // already treats it as something that can be written wrong, and these
  // bytes are exactly the ones that would otherwise be interpolated into an
  // unescaped Redis key name.
  describe('the character filter, isolated from the registry', () => {
    const DIRTY = [
      ['a:b', 'a colon, which would smuggle an extra segment into every room key'],
      ['a*b', 'a Redis glob wildcard, so a KEYS/SCAN pattern is never constructible from a query param'],
      ['a b', 'an ASCII space'],
      ['a\tb', 'a tab'],
      ['a\nb', 'a newline, which is log injection'],
      ['a\x00b', 'a NUL byte'],
      ['a\x1bb', 'an ESC, i.e. a terminal escape sequence in an operator tmux session'],
      ['a\x7fb', 'a DEL'],
      ['a\x9fb', 'a C1 control byte'],
    ] as const;
    const recognisesDirty = new Set<string>([...DIRTY.map(([raw]) => raw), 'ab']);
    const isValidDirtyBase = (b: string): boolean => recognisesDirty.has(b);

    it.each(DIRTY)('refuses %j (%s) even though the registry recognises it', (raw) => {
      expect(normalizeRoomId(raw, { isValidBase: isValidDirtyBase, fallback: FALLBACK })).toBe(FALLBACK);
    });

    it('CONTROL: the same registry accepts the id with the offending byte gone', () => {
      // Without this the group above would still pass if `normalizeRoomId`
      // rejected everything for some unrelated reason.
      expect(normalizeRoomId('ab', { isValidBase: isValidDirtyBase, fallback: FALLBACK })).toBe('ab');
    });
  });

  describe('the length cap, isolated from the registry', () => {
    const atCap = 'a'.repeat(64);
    const overCap = 'a'.repeat(65);
    const recognisesLong = new Set([atCap, overCap]);
    const isValidLongBase = (b: string): boolean => recognisesLong.has(b);

    it('accepts an id of exactly the maximum length', () => {
      expect(normalizeRoomId(atCap, { isValidBase: isValidLongBase, fallback: FALLBACK })).toBe(atCap);
    });

    it('refuses an id one byte over the maximum, with the registry recognising it', () => {
      expect(normalizeRoomId(overCap, { isValidBase: isValidLongBase, fallback: FALLBACK })).toBe(FALLBACK);
    });
  });

  it('accepts a valid bare base', () => {
    expect(normalizeRoomId('arena', { isValidBase, fallback: FALLBACK })).toBe('arena');
  });

  it('accepts a valid numbered instance under the cap', () => {
    expect(normalizeRoomId('arena~5', { isValidBase, fallback: FALLBACK })).toBe('arena~5');
  });

  it('accepts index 0 explicitly written out', () => {
    expect(normalizeRoomId('arena~0', { isValidBase, fallback: FALLBACK })).toBe('arena');
  });

  it('respects a custom maxRooms', () => {
    expect(normalizeRoomId('arena~2', { isValidBase, fallback: FALLBACK, maxRooms: 2 })).toBe(FALLBACK);
    expect(normalizeRoomId('arena~1', { isValidBase, fallback: FALLBACK, maxRooms: 2 })).toBe('arena~1');
  });

  it('defaults maxRooms to MAX_ROOMS_PER_BASE', () => {
    expect(normalizeRoomId(`arena~${MAX_ROOMS_PER_BASE - 1}`, { isValidBase, fallback: FALLBACK })).toBe(
      `arena~${MAX_ROOMS_PER_BASE - 1}`
    );
    expect(normalizeRoomId(`arena~${MAX_ROOMS_PER_BASE}`, { isValidBase, fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('demonstrates why isValidBase must not be a bare `in` check', () => {
    // This is the exact footgun the module comment warns about: an object
    // literal used as a lookup table resolves inherited properties through
    // `in`. If a caller wrote `(b) => b in ROOMS_OBJ` instead of a proper
    // hasOwnProperty/Map check, 'constructor' would incorrectly validate.
    const roomsObjectLiteral: Record<string, boolean> = { lobby: true };
    const unsafeIsValidBase = (b: string): boolean => b in roomsObjectLiteral;
    expect(unsafeIsValidBase('constructor')).toBe(true); // the footgun, demonstrated
    // normalizeRoomId's own hardcoded defence-in-depth catches it anyway,
    // even when handed the unsafe predicate above.
    expect(normalizeRoomId('constructor', { isValidBase: unsafeIsValidBase, fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('never throws on non-string-shaped input smuggled past the type system', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => normalizeRoomId(null as any, { isValidBase, fallback: FALLBACK })).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeRoomId(null as any, { isValidBase, fallback: FALLBACK })).toBe(FALLBACK);
  });
});

describe('normalizeBase: the trust boundary for a BASE, which is not a room id', () => {
  // THE REGISTRY MUST RECOGNISE THE DIRTY VALUE IN EVERY CASE BELOW, or the
  // test says nothing about the sanitiser. That is the exact mistake the
  // `normalizeRoomId` table above already documents: every dirty case there
  // ALSO failed `isValidBase`, so the refusal it observed was the registry's
  // and deleting the character filter outright left the whole group green.
  // `isValidBase` is HOST-SUPPLIED and this module's own comment treats it as
  // something that gets written wrong, so it can never be the thing under
  // test here.
  const DIRTY = [
    ['a:b', 'a colon, which would smuggle an extra segment into every room key built from this base'],
    ['a*b', 'a Redis glob wildcard, so a KEYS/SCAN pattern is never constructible from a query param'],
    ['a b', 'an ASCII space'],
    ['a\nb', 'a newline, which is log injection'],
    ['a\x00b', 'a NUL byte'],
    ['a\x1bb', 'an ESC, i.e. a terminal escape sequence in an operator tmux session'],
    ['a\x9fb', 'a C1 control byte'],
    ['a~1', 'a tilde: a base is a POOL, and roomIdFor would compose this into a~1~3 that parseRoomId cannot read back'],
    ['constructor', 'a prototype-chain property name, which a bare `raw in WORLDS` registry would wave through'],
    ['__proto__', 'a prototype-chain property name'],
    ['toString', 'a prototype-chain property name'],
  ] as const;
  const recognisesEverything = (): boolean => true;

  it.each(DIRTY)('refuses %j (%s), with a registry that recognises it', (raw) => {
    expect(normalizeBase(raw, { isValidBase: recognisesEverything })).toBeNull();
  });

  it('CONTROL: the same all-accepting registry passes a clean base straight through', () => {
    // Without this, the group above would pass equally well against a
    // function that returned null for absolutely everything.
    expect(normalizeBase('ab', { isValidBase: recognisesEverything })).toBe('ab');
  });

  it('refuses the empty string and anything past the length cap, registry notwithstanding', () => {
    expect(normalizeBase('', { isValidBase: recognisesEverything })).toBeNull();
    expect(normalizeBase('a'.repeat(64), { isValidBase: recognisesEverything })).toBe('a'.repeat(64));
    expect(normalizeBase('a'.repeat(65), { isValidBase: recognisesEverything })).toBeNull();
  });

  it('still refuses a base the registry does not recognise', () => {
    expect(normalizeBase('nope', { isValidBase })).toBeNull();
    expect(normalizeBase('arena', { isValidBase })).toBe('arena');
  });

  it('never throws on non-string-shaped input smuggled past the type system', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => normalizeBase(null as any, { isValidBase })).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeBase(undefined as any, { isValidBase })).toBeNull();
  });

  it('returns null rather than a fallback, so a hostile base is REFUSED and not silently reassigned', () => {
    // The balancer route answers 400 on this. Handing back some default room
    // would turn an attack on a Redis key name into a quiet redirect, and the
    // operator would never see it.
    expect(normalizeBase('a:b', { isValidBase: recognisesEverything })).toBeNull();
  });

  it('is the ONE implementation of the base rules, shared with normalizeRoomId', () => {
    // Both entry points must refuse the same base for the same reason, or
    // the balancer route and the relay route disagree about what a room may
    // be called. Measured rather than asserted: the same dirty values, run
    // through the room-id door with a registry that recognises them.
    const recognises = { isValidBase: recognisesEverything, fallback: FALLBACK };
    for (const [raw] of DIRTY) {
      if (raw.includes('~')) continue; // parseRoomId owns the suffix grammar
      expect(normalizeRoomId(raw, recognises)).toBe(FALLBACK);
    }
  });
});
