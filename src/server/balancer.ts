import {
  type RedisLike,
  roomKeys,
  roomIdFor,
  parseRoomId,
  MAX_ROOMS_PER_BASE,
  type Logger,
} from '../core/index.js';

/**
 * Picks which physical room instance a new joiner lands in. Bare `base` is
 * instance 0; `base~1`, `base~2`, ... are the rest, up to `maxRooms`. See
 * `ids.ts` for why instance 0 keeps the bare name.
 */
export interface BalancerOptions {
  redis: RedisLike;
  base: string;
  maxPlayers: number;
  maxRooms?: number;
  namespace?: string;
  /** The room that just rejected this client (a full-room bounce), so a re-assign never lands back on it. Honoured only when it genuinely names an instance of `base`; see the implementation note. */
  exclude?: string | null;
  log?: Logger;
}

export interface BalancerResult {
  room: string;
  base: string;
  index: number;
  /** Present and `true` only when every instance up to `maxRooms` is at capacity. */
  full?: boolean;
}

const defaultLog: Logger = (ev) => {
  try {
    const fn = ev.lvl === 'error' ? console.error : ev.lvl === 'warn' ? console.warn : console.log;
    fn(`[tickroom:balancer] ${ev.kind}`, ev);
  } catch {
    // never throw out of a logger
  }
};

/**
 * The LOWEST-INDEX room with spare capacity, so joiners PACK toward instance
 * 0 and higher instances stay empty (and therefore drain their tickers via
 * the empty-room grace) until they are actually needed. Reads every
 * candidate's stats key in ONE `MGET`, not a serial `GET` per instance: the
 * loop this replaced could cost up to `maxRooms` sequential Redis round trips
 * in the JOIN PATH whenever the low-index rooms all happened to be busy,
 * which is exactly the moment a player is most impatient for the game to
 * start.
 */
export async function assignRoom(opts: BalancerOptions): Promise<BalancerResult> {
  const { redis, base, maxPlayers, namespace, exclude, log = defaultLog } = opts;
  const maxRooms = opts.maxRooms ?? MAX_ROOMS_PER_BASE;

  // Honour `exclude` only when it parses as an instance of THIS base. A
  // junk value, or a room id belonging to some other base entirely, must
  // never let an untrusted input exclude a key it has no business naming.
  let excludedIndex: number | null = null;
  if (exclude) {
    const parsed = parseRoomId(exclude);
    if (parsed !== null && parsed.base === base) {
      excludedIndex = parsed.index;
    }
  }

  const candidateIds = Array.from({ length: maxRooms }, (_, i) => roomIdFor(base, i));
  const statsKeys = candidateIds.map((id) => roomKeys(id, namespace).stats);

  let statsRaw: (string | null)[];
  try {
    statsRaw = await redis.mget(...statsKeys);
  } catch (err) {
    log({ lvl: 'error', kind: 'balancer.mget-failed', meta: { base, error: String(err) } });
    // Fail toward instance 0 rather than failing the join outright: packing
    // to the lowest index is already the steady-state behaviour, and a
    // monitoring read failing must not strand every joiner with no room at
    // all.
    return { room: roomIdFor(base, 0), base, index: 0 };
  }

  for (let i = 0; i < maxRooms; i++) {
    if (i === excludedIndex) continue;
    const raw = statsRaw[i];
    let players = 0;
    if (raw !== null && raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as { players?: unknown };
        if (typeof parsed.players === 'number') {
          players = parsed.players;
        } else {
          log({ lvl: 'warn', kind: 'balancer.corrupt-stats', meta: { room: candidateIds[i] } });
        }
      } catch (err) {
        // A room whose stats value is missing or unreadable reads as EMPTY
        // and reusable, exactly like one with no ticker at all: an operator
        // who wants to know this happened has the log line, but a joiner
        // must not be punished by a corrupt cache entry.
        log({ lvl: 'warn', kind: 'balancer.corrupt-stats', meta: { room: candidateIds[i], error: String(err) } });
        players = 0;
      }
    }
    if (players < maxPlayers) {
      return { room: candidateIds[i], base, index: i };
    }
  }

  return { room: roomIdFor(base, 0), base, index: 0, full: true };
}
