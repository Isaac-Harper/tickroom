// Room identity and Redis key naming.
//
// A room id is either a bare BASE id ("lobby", instance 0) or "lobby~3" for
// instance N. Instance 0 keeping the bare name is not a stylistic choice: it
// means a deployment that ships multi-room support migrates NO existing Redis
// state. Every key an already-running single-room deployment has ever written
// (`room:lobby:state`, `room:lobby:lease`, ...) is exactly the key instance 0
// still writes the day multi-room support ships beside it. A scheme that
// numbered every instance ("lobby~0") would need a one-time migration or a
// permanent alias, for no benefit.

export interface RoomKeys {
  in: string;
  out: string;
  lease: string;
  state: string;
  stats: string;
  meta: string;
  metaout: string;
}

export const DEFAULT_NAMESPACE = 'room';
export const MAX_ROOMS_PER_BASE = 50;

const KEY_SUFFIXES = ['in', 'out', 'lease', 'state', 'stats', 'meta', 'metaout'] as const;

/** `${namespace}:${roomId}:${suffix}` for every suffix tickroom needs. */
export function roomKeys(roomId: string, namespace: string = DEFAULT_NAMESPACE): RoomKeys {
  const out = {} as RoomKeys;
  for (const suffix of KEY_SUFFIXES) {
    out[suffix] = `${namespace}:${roomId}:${suffix}`;
  }
  return out;
}

/** index 0 is the bare base id (see the module comment for why that matters); any other index is `${base}~${index}`. */
export function roomIdFor(base: string, index: number): string {
  return index === 0 ? base : `${base}~${index}`;
}

/**
 * Splits a room id into its base and instance index. Returns null for a
 * malformed suffix ("lobby~", "lobby~-1", "lobby~1.5", "lobby~~2") rather than
 * guessing, because the only caller that matters (`normalizeRoomId`) needs to
 * treat a malformed id exactly like an invalid one, not silently coerce it.
 */
export function parseRoomId(raw: string): { base: string; index: number } | null {
  const tildeAt = raw.indexOf('~');
  if (tildeAt === -1) {
    return { base: raw, index: 0 };
  }
  const base = raw.slice(0, tildeAt);
  const rest = raw.slice(tildeAt + 1);
  // A second '~' anywhere in `rest`, or a non-digit character, means this was
  // never a clean "base~N" shape. `/^\d+$/` also rejects "-1", "1.5", "", and
  // leading zeros are accepted on purpose ("lobby~03" -> 3): a caller building
  // ids programmatically should never produce one, but there is no reason to
  // reject it if they do.
  if (base.length === 0 || !/^\d+$/.test(rest)) {
    return null;
  }
  const index = Number.parseInt(rest, 10);
  if (!Number.isSafeInteger(index)) {
    return null;
  }
  return { base, index };
}

/** Strips a `~N` suffix, falling back to the raw string if it does not parse as one. Used to resolve which RULES a room instance follows, independent of which physical instance it is. */
export function baseOf(raw: string): string {
  return parseRoomId(raw)?.base ?? raw;
}

export interface NormalizeOptions {
  /**
   * Must return true only for a base id your registry actually recognises.
   *
   * WARNING: if this is backed by a plain object literal, do NOT write
   * `(b) => b in MY_ROOMS`. A bare `in` check matches INHERITED properties
   * too ("constructor", "__proto__", "toString" all resolve via the object
   * prototype chain), so an attacker sending `?room=constructor` would pass
   * validation and this module would build a live Redis key name out of it.
   * Use `Object.prototype.hasOwnProperty.call(MY_ROOMS, b)`, or back the
   * registry with a `Map` (whose `.has` has no such trap) instead of an
   * object literal. `normalizeRoomId` hard-rejects the three worst offenders
   * itself, as defence in depth, but that is not a substitute for writing
   * `isValidBase` correctly: it does not cover every dangerous property name
   * ("hasOwnProperty", "valueOf", "toLocaleString", ...), only the ones an
   * attacker is likeliest to try first.
   */
  isValidBase(base: string): boolean;
  /** Returned whenever `raw` cannot be validated. Must itself be a valid, trusted room id: it is returned unchecked. */
  fallback: string;
  /** Defaults to `MAX_ROOMS_PER_BASE`. Index 0 is always allowed regardless of this bound (it is the base id itself, not a numbered instance). */
  maxRooms?: number;
}

const DANGEROUS_BASE_NAMES = new Set(['constructor', '__proto__', 'toString']);

// Matches ':' (would let a room id smuggle extra key segments), '*' (a Redis
// glob wildcard: a KEYS/SCAN pattern must never be constructible from
// untrusted input), any ASCII whitespace, and C0/C1 control characters
// (log injection, terminal escape sequences in an operator's tmux session).
const FORBIDDEN_CHARS = /[:*\s\x00-\x1f\x7f-\x9f]/;

const MAX_ROOM_ID_LENGTH = 64;

/**
 * The one function anything reading an untrusted `?room=` query parameter
 * should call before that value ever reaches a Redis key, a log line, or a
 * ticker spawn URL. Returns `opts.fallback` for ANYTHING it cannot fully
 * validate: this is a trust boundary, and a trust boundary that fails open
 * (by best-effort sanitizing instead of rejecting) is not one. Never throws.
 */
export function normalizeRoomId(raw: string, opts: NormalizeOptions): string {
  const maxRooms = opts.maxRooms ?? MAX_ROOMS_PER_BASE;

  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ROOM_ID_LENGTH) {
    return opts.fallback;
  }
  if (FORBIDDEN_CHARS.test(raw)) {
    return opts.fallback;
  }

  const parsed = parseRoomId(raw);
  if (parsed === null) {
    return opts.fallback;
  }
  const { base, index } = parsed;

  if (base.length === 0 || DANGEROUS_BASE_NAMES.has(base)) {
    return opts.fallback;
  }
  if (!opts.isValidBase(base)) {
    return opts.fallback;
  }
  // Index 0 (the bare base id, reached when `raw` had no '~' at all) needs no
  // range check: it is not "instance 0 of a numbered pool", it IS the pool's
  // untouched original identity. Anything else must be a genuine positive
  // instance number under the cap.
  if (index !== 0 && (!Number.isInteger(index) || index < 1 || index >= maxRooms)) {
    return opts.fallback;
  }

  return roomIdFor(base, index);
}
