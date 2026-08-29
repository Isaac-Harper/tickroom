import { describe, expect, it } from 'vitest';
import { baseOf, MAX_ROOMS_PER_BASE, normalizeRoomId, parseRoomId, roomIdFor, roomKeys } from './ids.js';

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
