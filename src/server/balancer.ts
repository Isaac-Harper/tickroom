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
    // Fail toward the lowest index rather than failing the join outright:
    // packing to the lowest index is already the steady-state behaviour, and
    // a monitoring read failing must not strand every joiner with no room at
    // all.
    //
    // BUT skip `excludedIndex` here too, not just in the normal-path loop
    // below. A rejection (the caller was just bounced from a full room,
    // which is what `exclude` records) and an unrelated Redis hiccup are
    // INDEPENDENT EVENTS, so they can and do coincide: the retry that
    // follows a bounce is exactly the kind of request that might also catch
    // Redis mid-blip. If this path ignored `exclude`, that coincidence
    // routes the client straight back to the room that just turned it away.
    // Callers typically bound how many times they will re-assign after a
    // rejection, so landing on the same excluded room here can burn that
    // whole retry budget against one instance and surface to the player as
    // a hard "cannot join" instead of the transparent retry this option
    // exists to provide. We cannot consult capacity on this path (the read
    // that would tell us just failed), so "toward the lowest index" becomes
    // "toward the lowest index that is not the one we already know is bad".
    //
    // This must still fail OPEN, in every sense: a Redis outage never
    // reports `full` just because we could not measure capacity, including
    // in the degenerate case where the excluded room is the ONLY candidate
    // (`maxRooms === 1`, or every other instance also happens to be
    // excluded, which cannot happen today since only one id is ever
    // excluded but is guarded here rather than assumed). There we have
    // nothing else to offer, so we hand back the excluded room anyway:
    // worse than being bounced once more, but strictly better than a
    // manufactured "full" result that was never actually measured, which
    // would tell the caller something false about the room's capacity.
    for (let i = 0; i < maxRooms; i++) {
      if (i !== excludedIndex) return { room: roomIdFor(base, i), base, index: i };
    }
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

  // EVERY MEASURED CANDIDATE IS FULL, AND `exclude` STILL HAS TO BE HONOURED
  // HERE. Index 0 was `continue`d above when it is the excluded one, so it was
  // never measured, and returning it anyway both sends the client straight back
  // to the instance that just bounced it (burning the bounded re-assign budget
  // against one room, which is the strand-on-"full" failure this option exists
  // to prevent) and asserts `full: true` about the one room whose capacity was
  // never read. Same reasoning as the mget-failure path above, which was taught
  // to honour `exclude` and left this path alone.
  //
  // `full` is honest on this path in a way it would not have been on index 0:
  // every index returned here WAS measured and WAS at capacity.
  for (let i = 0; i < maxRooms; i++) {
    if (i !== excludedIndex) return { room: roomIdFor(base, i), base, index: i, full: true };
  }
  // Degenerate case, same as above: the excluded room is the only room there
  // is, so it is the only thing left to offer.
  return { room: roomIdFor(base, 0), base, index: 0, full: true };
}
