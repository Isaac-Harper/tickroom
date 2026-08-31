import { randomUUID } from 'node:crypto';
import {
  type RedisLike,
  roomKeys,
  LEASE_TTL_MS,
  MAX_TICKER_MS,
  EMPTY_GRACE_MS,
  acquireLease,
  renewLease,
  releaseLease,
  tickerShouldExit,
  createOwnershipClock,
  renewAttempted,
  renewConfirmed,
  renewFailed,
  mayPublish,
  renewDue,
  type OwnershipClock,
  CHECKPOINT_VERSION,
  packCheckpoint,
  unpackCheckpoint,
  PlayoutBuffer,
  StarveTracker,
  Inbox,
  RollingHistogram,
  type RoomRuntime,
  type RoomEnvelope,
  type ClientInput,
  type CheckpointEnvelope,
  type RoomStats,
  type Logger,
} from '../core/index.js';
import { writeCheckpoint, readCheckpoint } from './checkpoint.js';
import type { Subscriber } from './redis.js';


/**
 * The leased, fixed-timestep authoritative tick loop. This is the engine
 * that makes "exactly one authoritative writer per room, and a successor
 * takes over inside a second when the platform kills this one" true. A host
 * implements `RoomRuntime` for its own simulation and calls `runTicker`
 * from whatever the platform invokes to run a long-lived function (a route
 * handler, a queue worker, a container's main loop); everything below is
 * the part that never changes between hosts.
 */
export interface TickerOptions<TState, TEvent> {
  runtime: RoomRuntime<TState, TEvent>;
  /** The shared command client (see `server/redis.ts`, `getRedis`). Never a subscriber connection: this ticker opens its own via `createSubscriber`. */
  redis: RedisLike;
  /** Builds a fresh subscriber connection for this ticker's own `keys.in` subscription. */
  createSubscriber(): Subscriber;
  roomId: string;
  namespace?: string;
  /**
   * Spawns a successor for this exact room. Given the room id, must issue
   * an authenticated request back to whatever endpoint runs `runTicker`
   * (see `session.ts`'s spawn token). Called from `finally`, not gated on
   * still holding the lease: see the long comment at the call site for why
   * both of those are load-bearing.
   */
  spawnSuccessor?(roomId: string): Promise<unknown>;
  /**
   * A digest of the world geometry / rules this room's state must have been
   * simulated against. THE SINGLE MOST IMPORTANT OPTIONAL FIELD HERE: see
   * the restore block below for what silently breaks without it.
   */
  geomKey?(): string;
  /** Events this tick emitted, handed to the host OFF the hot path (no await happens before or after this call inside the loop). */
  onEvents?(events: TEvent[], ctx: { roomId: string; tick: number; incarnation: string; redis: RedisLike }): void;
  onStats?(stats: RoomStats): void;
  log?: Logger;
  /** How often the state is checkpointed to Redis. Default 1000ms. */
  checkpointMs?: number;
  /** How often the stats gauge is flushed. Default 1000ms. */
  statsMs?: number;
  /** Hard ceiling on this ticker's own lifetime, ahead of the platform's kill. Default `MAX_TICKER_MS`. */
  maxRunMs?: number;
  /** How long an empty room is kept alive before exiting. Default `EMPTY_GRACE_MS`. */
  emptyGraceMs?: number;
  /** TTL refreshed on the meta hash every stats flush, so a hard-killed ticker cannot strand a phantom roster forever. Default 120s. */
  metaTtlS?: number;
  /** Stamped into `RoomStats.build` for whoever reads the stats gauge. */
  buildId?: string;
  /**
   * Overrides `LEASE_TTL_MS`/`LEASE_RENEW_MS` from `core/lease.ts`. A host
   * has no reason to touch these in production (the defaults are the ones
   * this whole architecture was measured against), but a test that wants to
   * exercise the split-brain guard or a handoff without waiting out a real
   * multi-second lease window needs to shrink them, so they ride the same
   * options object rather than a separate test-only entry point.
   */
  leaseTtlMs?: number;
  leaseRenewMs?: number;
}

export interface TickerResult {
  reason: 'duration' | 'empty' | 'lease-lost' | 'busy' | 'error';
  ticks: number;
  uptimeMs: number;
}

// STATS_TTL_MS is ticker-specific presentation (how long the stats gauge
// key survives with nobody refreshing it) and has no counterpart in core.
// Everything else that used to live here (the bounded per-sender inbox, the
// percentile calculator) is now imported from `core`: see the import block
// above. Keeping a second copy of either was the actual bug this refactor
// fixes, not a style preference: two implementations of the per-sender
// quota WILL drift, and the failure mode if the global cap ever binds
// before the per-sender one is that a single flooding sender sheds EVERY
// player's input, not just their own.
const STATS_TTL_MS = 5000;

const defaultLog: Logger = (ev) => {
  try {
    const fn = ev.lvl === 'error' ? console.error : ev.lvl === 'warn' ? console.warn : console.log;
    fn(`[tickroom:ticker] ${ev.kind}`, ev);
  } catch {
    // A logger must never throw into its caller. If console itself is
    // broken there is nothing useful left to do.
  }
};

/** `RoomEnvelope['t'] === 'join'` narrowing helper kept as a free function so `handleEnvelope` reads as a plain switch rather than a wall of type guards. */
function envelopePid(env: RoomEnvelope): string | null {
  return 't' in env && typeof (env as { pid?: unknown }).pid === 'string' ? ((env as { pid: string }).pid) : null;
}

export async function runTicker<TState, TEvent>(opts: TickerOptions<TState, TEvent>): Promise<TickerResult> {
  const {
    runtime,
    redis,
    createSubscriber,
    roomId,
    namespace,
    spawnSuccessor,
    geomKey,
    onEvents,
    onStats,
    log = defaultLog,
    checkpointMs = 1000,
    statsMs = 1000,
    maxRunMs = MAX_TICKER_MS,
    emptyGraceMs = EMPTY_GRACE_MS,
    metaTtlS = 120,
    buildId,
    leaseTtlMs = LEASE_TTL_MS,
    leaseRenewMs,
  } = opts;

  const keys = roomKeys(roomId, namespace);
  const tickMs = 1000 / runtime.tickHz;
  const owner = `${roomId}:${randomUUID()}`;
  const startedAt = Date.now();

  // --- 1. acquire the lease or bail immediately ---
  //
  // Exactly one ticker may own a room at a time; this is the primitive that
  // makes that true. Losing the acquire race is not an error, it is the
  // expected outcome for every invocation except the one that wins, so
  // callers should treat 'busy' as a normal, silent return rather than a
  // failure to log.
  const acquired = await acquireLease(redis, keys.lease, owner, { leaseTtlMs });
  if (!acquired) {
    return { reason: 'busy', ticks: 0, uptimeMs: 0 };
  }

  let clock: OwnershipClock = createOwnershipClock(startedAt);
  let owns = true;
  let lostLeaseExplicitly = false;

  // --- 2. restore from checkpoint, or create fresh ---
  //
  // THE GEOMETRY DIGEST IS THE SUBTLEST THING IN THIS FUNCTION. A checkpoint
  // carries opaque bytes: this ticker has no way to know, just by looking at
  // them, whether they describe a world that still matches the rules it is
  // about to run. Without a digest check, a deploy that changes the world's
  // colliders, its win conditions, or any other piece of "geometry" leaves
  // every LIVE room quietly restoring and re-saving a simulation of the OLD
  // world FOREVER: each successor faithfully restores its predecessor's
  // bytes, the checkpoint's TTL keeps getting refreshed by that very restore,
  // and nothing about this is visible in any ordinary metric (the room keeps
  // ticking at a healthy rate, snapshots keep flowing, players just play in a
  // world that diverged from the one that was deployed). Comparing the
  // checkpoint's `geom` against the host's current `geomKey()` and refusing a
  // mismatch turns that silent, permanent corruption into an ordinary fresh
  // start, which is a much smaller and much more honest failure.
  let state: TState;
  let incarnation: string;
  {
    let rawBody: string | null = null;
    try {
      rawBody = await readCheckpoint(redis, keys.state);
    } catch (err) {
      log({ lvl: 'warn', kind: 'ticker.checkpoint-read-failed', room: roomId, meta: { error: String(err) } });
    }
    const envelope = unpackCheckpoint(rawBody);
    const expectedGeom = geomKey?.();
    // OMITTING `geomKey` IS A SILENT FOOTGUN, so say so once, loudly, rather
    // than letting it pass unremarked.
    //
    // Without a digest there is nothing tying a checkpoint to the world it was
    // simulated against, so a deploy that changes your collision geometry or
    // rules leaves every live room restoring its predecessor's bytes, continuing
    // to simulate the OLD world, and re-saving it. Each successor faithfully
    // repeats that, and the checkpoint's TTL is refreshed on every write, so it
    // never ages out. The room simulates a world that no longer exists,
    // indefinitely. Nothing throws, nothing is logged, and no metric moves:
    // players simply walk through new walls and stop at removed ones.
    //
    // It is only warned rather than required because a host with genuinely
    // static rules (a chat room, a cursor layer) is entitled to skip it, and
    // because forcing it would break a caller who has not yet written one. Warn
    // ONLY when a checkpoint actually exists: a cold room has nothing to restore
    // wrongly, so warning there would just be noise on every fresh start.
    if (expectedGeom === undefined && envelope !== null) {
      log({
        lvl: 'warn',
        kind: 'ticker.no-geom-key',
        room: roomId,
        msg:
          'restoring a checkpoint with no geomKey: a deploy that changes this world cannot be ' +
          'detected, and the room will keep simulating the world the checkpoint was written against',
      });
    }
    let restored: { state: TState; incarnation: string } | null = null;
    if (envelope !== null && (expectedGeom === undefined || envelope.geom === expectedGeom)) {
      try {
        restored = { state: runtime.deserialize(envelope.body), incarnation: envelope.incarnation };
        log({ lvl: 'info', kind: 'ticker.restore', room: roomId, meta: { tick: envelope.tick } });
      } catch (err) {
        log({ lvl: 'warn', kind: 'ticker.restore-failed', room: roomId, meta: { error: String(err) } });
      }
    } else if (envelope !== null) {
      log({
        lvl: 'warn',
        kind: 'ticker.geom-mismatch',
        room: roomId,
        meta: { expected: expectedGeom, got: envelope.geom },
      });
    }
    if (restored !== null) {
      state = restored.state;
      incarnation = restored.incarnation;
    } else {
      state = runtime.create(roomId);
      // Fresh per room CREATION, preserved across every RESTORE (see the
      // `restored` branch above, which keeps the checkpoint's own
      // incarnation rather than minting one here). This is what lets a
      // ledger idempotency key be BOTH stable across a restore (a replayed
      // event dedupes) and unique across a genuine re-creation (a drained
      // and rebuilt room is never mistaken for a replay of the old one).
      incarnation = randomUUID();
    }
  }

  // --- 3. metadata authority ---
  //
  // The ticker owns the pid -> meta map. It mirrors changes into the meta
  // hash as they happen (see the 'join'/'leave' handling below) and
  // republishes the WHOLE map on metaout only when something actually
  // changed, which is `metaDirty`.
  //
  // `metaDirty` STARTS TRUE, and that is not an accident of initialization
  // order. A predecessor that died between writing the hash and publishing
  // the metaout announcement for the same join would otherwise strand that
  // announcement forever: this successor restores a map that already
  // matches the hash bit for bit, so nothing about a normal join/leave check
  // would ever mark it dirty, and the roster that announcement was supposed
  // to deliver never reaches anyone who was not already subscribed at the
  // instant it fired. Starting dirty means the very first flush after a
  // restore (or a fresh create) always republishes the full map once, which
  // is a redundant publish in the common case and a correctness fix in the
  // uncommon one.
  const metaMap = new Map<string, Record<string, unknown>>();
  let metaDirty = true;
  const present = new Set<string>();
  try {
    const raw = await redis.hgetall(keys.meta);
    for (const [pid, json] of Object.entries(raw)) {
      try {
        metaMap.set(pid, JSON.parse(json) as Record<string, unknown>);
        present.add(pid);
      } catch {
        // A corrupt single field must not take down the whole restore.
      }
    }
  } catch (err) {
    log({ lvl: 'warn', kind: 'ticker.meta-read-failed', room: roomId, meta: { error: String(err) } });
  }

  // --- subscriber for keys.in ---
  const sub = createSubscriber();
  const inbox = new Inbox<RoomEnvelope>(); // core's defaults (cap 4096, perSenderCap 64, maxDrainPerTick 1024) are exactly what this ticker needs
  let badEnvelopes = 0;

  sub.on('message', (channel: unknown, message: unknown) => {
    if (channel !== keys.in || typeof message !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      // Malformed JSON is CLIENT-CONTROLLED input arriving at 20Hz per
      // socket; logging every occurrence would hand an abuser a log
      // amplifier (and, on a host that bills per log line, a cost
      // amplifier) for free. Count it and move on; see `badEnvelopes` on
      // the stats gauge for the aggregate signal.
      badEnvelopes++;
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { t?: unknown }).t !== 'string') {
      badEnvelopes++;
      return;
    }
    const envelope = parsed as RoomEnvelope;
    inbox.push(envelope, envelopePid(envelope));
  });
  try {
    await sub.subscribe(keys.in);
  } catch (err) {
    log({ lvl: 'error', kind: 'ticker.subscribe-failed', room: roomId, meta: { error: String(err) } });
  }

  // --- per-player playout state ---
  const playouts = new Map<string, PlayoutBuffer<ClientInput>>();
  const starve = new StarveTracker();

  // --- counters, reset every stats flush (see the stats block) ---
  let publishes = 0;
  let dropped = 0;
  let starves = 0;
  let renewFails = 0;
  let bytesPublished = 0;
  let bytesDelivered = 0;
  let ticksSinceStats = 0;
  const cadenceHist = new RollingHistogram();
  const publishAwaitHist = new RollingHistogram();
  const serverInternalHist = new RollingHistogram();

  let ticks = 0;
  let emptySince: number | null = runtime.playerCount(state) === 0 ? Date.now() : null;
  let lastCheckpointAt = 0;
  let lastStatsAt = Date.now();
  let lastLoopAt = Date.now();
  let exitReason: TickerResult['reason'] = 'duration';
  let nextTickAt = Date.now();

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

  async function writeCheckpointNow(): Promise<void> {
    const envelope: CheckpointEnvelope = {
      v: CHECKPOINT_VERSION,
      tick: runtime.currentTick(state),
      graceUntilTick: runtime.graceUntilTick?.(state) ?? 0,
      geom: geomKey?.(),
      incarnation,
      body: runtime.serialize(state),
    };
    await writeCheckpoint(redis, keys.state, packCheckpoint(envelope));
  }

  function publishMeta(): void {
    const map: Record<string, unknown> = Object.fromEntries(metaMap);
    redis
      .publish(keys.metaout, JSON.stringify({ t: 'meta', map }))
      .catch((err) => log({ lvl: 'error', kind: 'ticker.metaout-failed', room: roomId, meta: { error: String(err) } }));
  }

  function handleEnvelope(env: RoomEnvelope): void {
    switch (env.t) {
      case 'join': {
        const already = present.has(env.pid);
        // A rejoin (a reconnecting player whose grace period has not
        // expired) is ALWAYS admitted, no matter how full the room reads:
        // `isFull` only ever gets to refuse a genuinely NEW arrival. Without
        // that distinction, a room sitting at capacity would eject its own
        // existing players on every reconnect.
        if (!already && runtime.isFull?.(state)) {
          redis
            .publish(keys.metaout, JSON.stringify({ t: 'room-reject', pid: env.pid }))
            .catch(() => {
              /* best-effort; a lost reject just means the client's own timeout handles it */
            });
          return;
        }
        present.add(env.pid);
        runtime.join(state, env.pid, env.meta);

        const meta = env.meta ?? {};
        const nextJson = JSON.stringify(meta);
        const prevJson = metaMap.has(env.pid) ? JSON.stringify(metaMap.get(env.pid)) : undefined;
        if (prevJson !== nextJson) {
          metaMap.set(env.pid, meta);
          metaDirty = true;
          redis
            .hset(keys.meta, env.pid, nextJson)
            .catch((err) => log({ lvl: 'error', kind: 'ticker.meta-hset-failed', room: roomId, meta: { error: String(err) } }));
        }
        if (emptySince !== null) emptySince = null;
        break;
      }
      case 'leave': {
        present.delete(env.pid);
        runtime.leave(state, env.pid);
        if (metaMap.delete(env.pid)) {
          metaDirty = true;
          redis
            .hdel(keys.meta, env.pid)
            .catch((err) => log({ lvl: 'error', kind: 'ticker.meta-hdel-failed', room: roomId, meta: { error: String(err) } }));
        }
        playouts.delete(env.pid);
        starve.forget(env.pid);
        break;
      }
      case 'in': {
        for (const input of env.w) {
          const stamped = (input.targetTick ?? 0) > 0;
          if (stamped && (runtime.usesPlayout?.(state, env.pid) ?? false)) {
            let buf = playouts.get(env.pid);
            if (!buf) {
              buf = new PlayoutBuffer<ClientInput>();
              playouts.set(env.pid, buf);
            }
            buf.push(input.targetTick as number, input);
          } else {
            // An UNSTAMPED input for a pid that already has a playout
            // buffer means that player is no longer driving a stamped
            // stream (a car dismount, a mode switch), so the stale buffer
            // is dropped rather than left to starve silently for the rest
            // of the session: without this, the consume-exact pass below
            // would keep reporting starves and calling `onStarve` for a
            // player who is not sending stamped input at all anymore.
            if (!stamped) playouts.delete(env.pid);
            runtime.applyInput(state, env.pid, input);
          }
        }
        break;
      }
      case 'custom': {
        runtime.onCustom?.(state, env.name, env.data, env.pid);
        break;
      }
    }
  }

  try {
    while (true) {
      const iterationStart = Date.now();
      cadenceHist.push(iterationStart - lastLoopAt);
      lastLoopAt = iterationStart;

      // NO AWAITS BELOW THIS LINE UNTIL THE SLEEP AT THE BOTTOM OF THE LOOP.
      // The loop's entire timing guarantee rests on that: every publish,
      // checkpoint, and lease renew inside this iteration is fire-and-forget
      // with a `.catch`, because one awaited Redis round trip inside the hot
      // path stretches every tick in the room by that round trip's latency.

      // 4. drain the inbox
      dropped += inbox.resetDropped();
      const envelopes = inbox.drain(); // uses the Inbox's own configured maxDrainPerTick
      for (const env of envelopes) {
        try {
          handleEnvelope(env);
        } catch (err) {
          badEnvelopes++;
          log({ lvl: 'warn', kind: 'ticker.envelope-threw', room: roomId, meta: { error: String(err) } });
        }
      }

      // 5. playout consume-exact pass, BEFORE the tick
      const tickNow = runtime.currentTick(state);
      for (const [pid, buf] of playouts) {
        const { item, starved } = buf.consume(tickNow);
        if (starved) {
          starves++;
          const streak = starve.onStarve(pid);
          runtime.onStarve?.(state, pid, streak);
        } else if (item !== undefined) {
          starve.onConsume(pid);
          (runtime.applyBufferedInput ?? runtime.applyInput)(state, pid, item);
          runtime.ackTick?.(state, pid, tickNow);
        }
      }

      // 6. the sim step itself
      const tickStart = Date.now();
      const result = runtime.tick(state, 1 / runtime.tickHz);
      serverInternalHist.push(Date.now() - tickStart);
      ticks++;
      ticksSinceStats++;
      if (result && result.events && result.events.length > 0) {
        try {
          onEvents?.(result.events, { roomId, tick: runtime.currentTick(state), incarnation, redis });
        } catch (err) {
          log({ lvl: 'error', kind: 'ticker.onEvents-threw', room: roomId, meta: { error: String(err) } });
        }
      }

      // keep emptySince current before it is read by the exit check further down
      if (runtime.playerCount(state) === 0) {
        if (emptySince === null) emptySince = Date.now();
      } else {
        emptySince = null;
      }

      // 7. THE SPLIT-BRAIN GUARD, run synchronously before every publish.
      //
      // Two independent ways this fires, both real and both observed in
      // production of the system this library was extracted from:
      //   (a) this loop itself stalled past the lease TTL (a GC pause, an
      //       event-loop-blocking bug), so the scheduled async renew below
      //       never got a chance to run at all; or
      //   (b) renews HAVE been firing on schedule but failing or hanging,
      //       so ownership silently expired out from under this ticker
      //       while it kept computing ticks, and a successor may already
      //       hold the lease and be publishing its own, divergent, sim.
      // Either way, publishing now would mean two authoritative writers on
      // one channel: clients receive interleaved snapshots from two
      // different simulations, and both tickers clobber the same
      // checkpoint. `mayPublish` reads ONLY the confirmed-ownership clock
      // (never the merely-attempted one), so this check cannot be fooled by
      // a renew that has been attempting and failing the whole time.
      const now = Date.now();
      if (owns && !mayPublish(clock, now, leaseTtlMs)) {
        clock = renewAttempted(clock, now);
        let renewed = false;
        try {
          renewed = await renewLease(redis, keys.lease, owner, { leaseTtlMs });
        } catch {
          renewed = false;
        }
        if (renewed) {
          clock = renewConfirmed(clock, Date.now());
        } else {
          clock = renewFailed(clock);
          owns = false;
          log({ lvl: 'error', kind: 'ticker.lease-lost', room: roomId });
          break;
        }
      }

      if (owns) {
        // 8. publish the snapshot
        const playerCount = runtime.playerCount(state);
        const payload = runtime.encodeSnapshot(state, now);
        const message: string | Buffer = typeof payload === 'string' ? payload : Buffer.from(payload);
        const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
        const publishStartedAt = Date.now();
        redis
          .publish(keys.out, message)
          .then(() => {
            publishAwaitHist.push(Date.now() - publishStartedAt);
          })
          .catch((err) => {
            log({ lvl: 'error', kind: 'ticker.publish-failed', room: roomId, meta: { error: String(err) } });
          });
        publishes++;
        bytesPublished += bytes;
        bytesDelivered += bytes * playerCount;

        // 9. checkpoint, gated on still owning the lease
        if (now - lastCheckpointAt >= checkpointMs) {
          lastCheckpointAt = now;
          writeCheckpointNow().catch((err) =>
            log({ lvl: 'error', kind: 'ticker.checkpoint-write-failed', room: roomId, meta: { error: String(err) } })
          );
        }

        // meta: publish the roster whenever it changed
        if (metaDirty) {
          metaDirty = false;
          publishMeta();
        }
      }

      // 10. stats, flushed every `statsMs` regardless of ownership (a
      // ticker that just lost the lease still wants its final numbers seen)
      if (now - lastStatsAt >= statsMs) {
        const elapsedS = (now - lastStatsAt) / 1000;
        const measuredHz = elapsedS > 0 ? ticksSinceStats / elapsedS : runtime.tickHz;
        const stats: RoomStats = {
          tick: runtime.currentTick(state),
          players: runtime.playerCount(state),
          tickHz: measuredHz,
          uptimeS: (now - startedAt) / 1000,
          publishes,
          dropped,
          starves,
          renewFails,
          badEnvelopes,
          bytesPublished,
          bytesDelivered,
          cadence: cadenceHist.percentiles(),
          publishAwait: publishAwaitHist.percentiles(),
          serverInternal: serverInternalHist.percentiles(),
          at: now,
          build: buildId,
        };
        // Read-and-reset in ONE uninterrupted synchronous block, no `await`
        // between building `stats` and zeroing the counters it was built
        // from: several of these are also written from the subscriber's
        // `on('message')` callback, and inserting an await here would open
        // a window where that callback's own increments land between the
        // snapshot being taken and the reset, silently losing them.
        const json = JSON.stringify(stats);
        publishes = 0;
        dropped = 0;
        starves = 0;
        renewFails = 0;
        badEnvelopes = 0;
        bytesPublished = 0;
        bytesDelivered = 0;
        ticksSinceStats = 0;
        cadenceHist.clear();
        publishAwaitHist.clear();
        serverInternalHist.clear();
        lastStatsAt = now;

        redis
          .set(keys.stats, json, 'PX', STATS_TTL_MS)
          .catch((err) => log({ lvl: 'error', kind: 'ticker.stats-write-failed', room: roomId, meta: { error: String(err) } }));
        // Refresh the meta hash's TTL on this same cadence: it otherwise
        // has no expiry of its own, and a ticker that dies hard (skipping
        // its own cleanup) must not leave a phantom-full roster behind
        // forever. Riding an existing cadence costs nothing extra.
        redis.expire(keys.meta, metaTtlS).catch(() => {});
        try {
          onStats?.(stats);
        } catch (err) {
          log({ lvl: 'error', kind: 'ticker.onStats-threw', room: roomId, meta: { error: String(err) } });
        }
      }

      // 11. renew, off the hot path
      if (owns && renewDue(clock, now, leaseRenewMs)) {
        clock = renewAttempted(clock, now);
        renewLease(redis, keys.lease, owner, { leaseTtlMs })
          .then((ok) => {
            if (ok) {
              clock = renewConfirmed(clock, Date.now());
            } else {
              // An EXPLICIT loss: Redis told us, via the atomic
              // compare-and-set inside `renewLease`, that this owner no
              // longer holds the key. That is a stronger signal than a
              // thrown error (which could just as easily be a transient
              // network blip) and is acted on immediately rather than
              // waiting for the synchronous `mayPublish` guard to notice on
              // its own schedule.
              clock = renewFailed(clock);
              renewFails++;
              lostLeaseExplicitly = true;
            }
          })
          .catch(() => {
            // A genuine error, not a confirmed loss: leave `lostLeaseExplicitly`
            // untouched so the ticker keeps trying, but still move the clock
            // toward "not recently confirmed" so `mayPublish` starts its
            // countdown to false.
            clock = renewFailed(clock);
            renewFails++;
          });
      }

      // 12. exit conditions
      if (lostLeaseExplicitly) {
        owns = false;
        exitReason = 'lease-lost';
        break;
      }
      if (tickerShouldExit({ now: Date.now(), startedAt, emptySince }, { maxTickerMs: maxRunMs, emptyGraceMs })) {
        exitReason = Date.now() - startedAt >= maxRunMs ? 'duration' : 'empty';
        break;
      }

      // fixed-timestep grid: advance by exactly one tick's worth of time,
      // and if a stall (a GC pause, a slow tick) put us more than one tick
      // behind, RESYNC to now rather than bursting through several
      // catch-up iterations back to back. Bursting would publish several
      // snapshots in a fraction of a second followed by a normal gap, which
      // reads to every client as a stutter-then-rubber-band; resyncing
      // instead means the room simply loses the stalled time once, and the
      // cadence goes right back to metronome-steady.
      nextTickAt += tickMs;
      const drift = Date.now() - nextTickAt;
      if (drift > tickMs) {
        nextTickAt = Date.now();
      } else {
        await sleep(nextTickAt - Date.now());
      }
    }
  } catch (err) {
    log({ lvl: 'error', kind: 'ticker.tick-threw', room: roomId, meta: { error: String(err) } });
    exitReason = 'error';
  } finally {
    // 13. final checkpoint + release, ONLY if we still believe we own the
    // lease. A ticker that has already lost ownership must never write a
    // checkpoint or release a key: either action could clobber a
    // successor's already-fresher state or free a lease that successor is
    // actively holding.
    if (owns) {
      try {
        await writeCheckpointNow();
      } catch (err) {
        log({ lvl: 'error', kind: 'ticker.final-checkpoint-failed', room: roomId, meta: { error: String(err) } });
      }
      try {
        await releaseLease(redis, keys.lease, owner);
      } catch (err) {
        log({ lvl: 'error', kind: 'ticker.release-failed', room: roomId, meta: { error: String(err) } });
      }
    }

    // 14. spawn a successor if anyone is still here.
    //
    // Deliberately in `finally`, not at the tail of the `try`: a THROWN
    // tick is exactly the case where a room would otherwise sit dead with
    // players still connected to it, and that is the single worst outcome
    // this whole function can produce.
    //
    // Deliberately NOT gated on `owns`: a lost lease is precisely the
    // situation where nobody else has been told to start a successor, so
    // this must fire even then. It is safe to fire "blind" because a
    // successor that finds the lease already held (by whoever took it from
    // us) simply fails its own acquire and returns immediately as 'busy'.
    //
    // AWAITED but RACED against a short timer, never fire-and-forgotten.
    // Fire-and-forget was tried and was measurably wrong: as the very last
    // thing a handler does, it becomes background I/O the platform is free
    // to suspend the instant the handler returns, and the spawn request
    // intermittently never actually left the process. A bounded wait fixes
    // that without blocking forever, because the successor does not
    // RESPOND to this request until it exits, possibly minutes later.
    //
    // Deliberately NOT `AbortSignal.timeout`: aborting the request could
    // propagate as a cancellation signal that tears down the very ticker
    // that was just started, which is worse than the bug this exists to
    // fix. Racing a plain timer leaves the request alive regardless of
    // which side of the race finishes first.
    let remaining = 0;
    try {
      remaining = runtime.playerCount(state);
    } catch {
      remaining = 0;
    }
    if (remaining > 0 && spawnSuccessor) {
      await Promise.race([
        spawnSuccessor(roomId).catch((err) => {
          log({ lvl: 'error', kind: 'ticker.spawn-failed', room: roomId, meta: { error: String(err) } });
        }),
        sleep(2000),
      ]);
    }

    try {
      runtime.dispose?.(state);
    } catch (err) {
      log({ lvl: 'error', kind: 'ticker.dispose-threw', room: roomId, meta: { error: String(err) } });
    }
    try {
      sub.disconnect();
    } catch {
      // best-effort teardown only
    }
  }

  return { reason: exitReason, ticks, uptimeMs: Date.now() - startedAt };
}
