// The contract between tickroom's transport and YOUR simulation.
//
// The single most important property of this architecture, and the reason it
// generalises past the game it was extracted from: THE SIMULATION KNOWS NOTHING
// ABOUT TRANSPORT. It imports no Redis client, opens no socket, reads no clock
// of its own, and takes no serverless platform dependency. It is a pure function
// of (state, inputs, dt) plus a serialize/deserialize pair.
//
// That is what lets the same simulation run in three places unchanged: the
// authoritative ticker on the server, a client-side prediction shadow, and a
// vitest process with no network at all. It is also the escape hatch: the day
// serverless stops being the right host, the simulation moves to a long-lived VM
// without a line changing, because nothing in it ever knew where it was running.
//
// Implement `RoomRuntime` and tickroom supplies everything else: the lease that
// guarantees exactly one authoritative writer, the checkpoint that survives a
// function's death, the relay that fans snapshots out to sockets, the playout
// buffer that makes an input land on the same tick at both ends, and the client
// that reconnects, resumes, and interpolates.

/**
 * Anything that can be published on the snapshot channel. A `Uint8Array` is
 * strongly preferred (a binary codec is typically 5-20x smaller than the
 * equivalent JSON, and snapshot fan-out is the single largest bandwidth line in
 * this architecture), but a string is accepted so a prototype can ship before
 * its codec does.
 */
export type SnapshotPayload = Uint8Array | string;

/**
 * One inbound message from one client, after your `decodeInput` has run.
 *
 * `targetTick` is the mechanism that makes networked simulation deterministic,
 * and it is worth understanding before ignoring it. An input applied "when it
 * arrives" lands on a different tick for every client, because every client has
 * a different latency, and it lands on a different tick on replay than it did
 * live. Stamping the input with the tick it is MEANT to apply on, buffering it,
 * and applying it on exactly that tick makes the server and the client's own
 * prediction run the identical input on the identical tick.
 *
 * Leave it 0 (or absent) for inputs that do not need it. An unstamped input is
 * applied the moment it arrives, which is correct for anything where a tick of
 * skew is imperceptible: chat, a cursor position, a low-speed avatar. Stamp the
 * things where it is not: a vehicle, a projectile, anything the client predicts
 * locally and would have to visibly correct.
 */
export interface ClientInput {
  /** Monotonic per-client sequence number. Echoed back in the snapshot so the client can measure a true RTT. */
  seq: number;
  /** The tick this input should apply on. 0 or absent means apply on arrival. */
  targetTick?: number;
  /** Your payload. tickroom never inspects this. */
  data: unknown;
}

/**
 * A client joining, leaving, or sending input. Produced by the relay, consumed
 * by the ticker.
 *
 * The `custom` variant is the out-of-band control channel: an admin command, a
 * dev route forcing a phase, a scheduled job nudging the room. It is NOT
 * produced by the relay, deliberately, because a client must never be able to
 * reach `onCustom`. Produce one server-side with `publishCustom` (see
 * `server/ticker.ts`) from whatever endpoint is already authenticated to issue
 * it, and the ticker will hand it to `RoomRuntime.onCustom`.
 *
 * The ticker's envelope switch has an explicit default branch for a `t` it does
 * not recognise, which counts and reports it rather than dropping it in
 * silence. That branch exists because an envelope shape that vanishes without a
 * trace is indistinguishable from a Redis outage, a subscribe that never landed
 * and a producer that was never deployed, and all three were guessed at in turn
 * before anyone thought to check whether the message was simply being ignored.
 */
export type RoomEnvelope =
  | { t: 'join'; pid: string; meta?: Record<string, unknown> }
  | { t: 'leave'; pid: string }
  | { t: 'in'; pid: string; w: ClientInput[]; ts?: number }
  | { t: 'custom'; pid?: string; name: string; data?: unknown };

/**
 * Your simulation, as tickroom sees it.
 *
 * Every method is SYNCHRONOUS and must stay that way. The tick loop's whole
 * timing guarantee rests on nothing in it ever awaiting: publishes, checkpoints
 * and lease renews are all fire-and-forget with catch handlers, so the only
 * thing that paces the loop is the sleep to the next grid point. One `await` on
 * a Redis round trip inside `tick()` and a slow network stretches every tick in
 * the room.
 *
 * @typeParam TState - Your room state. Opaque to tickroom.
 * @typeParam TEvent - Events your tick emits for the host to act on (a score, a
 *   payout, a phase change). Emitted from the pure sim, acted on off the hot path.
 */
export interface RoomRuntime<TState = unknown, TEvent = unknown> {
  /** Fixed simulation rate. 20 is a good default for most games; 10 is plenty for cursors and whiteboards; 60 is rarely worth the bandwidth. */
  readonly tickHz: number;

  /** Build a fresh room. Called when no checkpoint exists, or when one cannot be restored. */
  create(roomId: string): TState;

  /**
   * Advance the simulation exactly one tick. Pure with respect to the outside
   * world: no clock reads, no randomness that is not seeded from state, no IO.
   * Two runs from the same state with the same inputs must produce the same
   * result, or a checkpoint restore silently diverges from what players saw.
   */
  tick(state: TState, dt: number): { events?: TEvent[] } | void;

  /** Current tick number. tickroom reads it for the client tick timeline and the stats gauge. */
  currentTick(state: TState): number;

  /** How many players are in the room. Drives the empty-room drain and the capacity gauges. */
  playerCount(state: TState): number;

  /**
   * Optional: who is in the room RIGHT NOW, according to the simulation itself.
   *
   * Supply this and the ticker reconciles its metadata map (the pid -> name /
   * colour / whatever map it mirrors into the meta hash and republishes to
   * every socket) against your membership on every tick, instead of removing a
   * player's metadata the moment a `leave` envelope arrives.
   *
   * WHAT BREAKS WITHOUT IT, and it only breaks in the games that most need it:
   * any simulation with a DISCONNECT GRACE. A `leave` envelope is produced by a
   * socket closing, not by a player quitting, and a socket closes on a phone
   * changing cell, a laptop lid, a tab throttled into the background, or a
   * routine reconnect. A simulation that deliberately holds a departed player
   * for several seconds so their reconnect resumes seamlessly still has that
   * player; the transport does not. Under leave-time removal the roster
   * announcement goes out saying they left, every other client tears down their
   * name tag, and then they reappear a second later as a fresh arrival. The
   * player is still standing exactly where they were the whole time.
   *
   * Membership is a property of the SIMULATION, so the simulation is the only
   * thing that can answer it. `leave` stays a signal ("this socket went away"),
   * it stops being a verdict.
   *
   * Returning a fresh array each call is fine; the ticker only iterates it.
   * Omit it entirely and the ticker keeps today's behaviour exactly.
   */
  presentPids?(state: TState): Iterable<string>;

  /** Admit a player. Must be IDEMPOTENT: the relay re-publishes a join every second as a heartbeat, and a reconnecting player rejoins by name. */
  join(state: TState, pid: string, meta?: Record<string, unknown>): void;

  /** Remove a player, or start their disconnect grace. Called on socket close. */
  leave(state: TState, pid: string): void;

  /** Apply one input for one player, right now. */
  applyInput(state: TState, pid: string, input: ClientInput): void;

  /**
   * Serialize the whole room to a string. This is what survives a function
   * dying: a successor restores it and play continues, usually inside a second.
   * Include everything a fresh process would need and nothing it can re-derive.
   */
  serialize(state: TState): string;

  /**
   * Rebuild a room from `serialize` output. THROW on anything you cannot
   * restore. A throw is handled: the ticker logs it and starts the room fresh,
   * which is the correct outcome for a corrupt or stale checkpoint. Silently
   * returning a half-restored room is not.
   */
  deserialize(json: string): TState;

  /** Encode the snapshot broadcast to every client this tick. Called once per tick, so keep it cheap and allocation-light. */
  encodeSnapshot(state: TState, serverTimeMs: number): SnapshotPayload;

  /** Optional: refuse a NEW player past capacity. A rejoin is always admitted, so this only ever sees genuinely new arrivals. */
  isFull?(state: TState): boolean;

  /**
   * Optional: does this player carry a tick-stamped playout buffer? Return
   * false (the default) and every input applies on arrival. Return true and
   * tickroom drives a `PlayoutBuffer` for them, consuming exactly the input
   * stamped for each tick.
   *
   * Consulted only for a record that actually carries a `targetTick`, so
   * returning `true` unconditionally is a perfectly good answer and is usually
   * the RIGHT one: it reproduces "stamped inputs are buffered, unstamped ones
   * apply on arrival" without your simulation having to track which of its
   * players are currently driving a stamped stream.
   *
   * DO NOT implement this by reading back a buffer handle that your own
   * simulation never assigns. That reads as a faithful translation of an
   * existing "does this player have a playout buffer" field and is a silent
   * no-op: the buffer lives here in the ticker, your field stays null, this
   * returns false forever, and every stamped input quietly reverts to applying
   * on arrival. Nothing throws, nothing is counted, and the only symptom is
   * that client-side prediction stops agreeing with the server under load,
   * which reads as flaky netcode rather than as a disabled feature.
   */
  usesPlayout?(state: TState, pid: string): boolean;

  /** Optional: apply an input pulled from the playout buffer for this exact tick. Defaults to `applyInput`. */
  applyBufferedInput?(state: TState, pid: string, input: ClientInput): void;

  /** Optional: the buffer starved for this player this tick. Repeat the last input, decay it, or do nothing. See `starvation.ts` for why a bare repeat is wrong over a run of ticks. */
  onStarve?(state: TState, pid: string, consecutiveStarves: number): void;

  /** Optional: record that the server consumed this player's input for this tick, so the snapshot can echo it back as an ack. */
  ackTick?(state: TState, pid: string, tick: number): void;

  /**
   * Optional: a record from this player has just ARRIVED, before any decision
   * about when it will be applied. Fired for every record in an inbound window,
   * stamped or not, at the instant the ticker takes it off the bus.
   *
   * THIS IS NOT `ackTick` AND THE TWO MUST NOT BE COLLAPSED. `ackTick` fires on
   * CONSUME, which for a stamped input is deliberately some ticks after it
   * arrived: that is the entire point of the playout buffer. A client measures
   * its round-trip time from the acknowledgement the snapshot echoes back, and
   * feeds that measurement into the controller that dilates its own tick rate
   * to keep the server's buffer at the target depth. Acking at consume time
   * reports arrival latency PLUS however long the input deliberately sat in the
   * buffer, so the client reads its own buffering as network latency, stamps
   * further ahead to compensate, sits in the buffer longer still, and reports a
   * larger number again. The controller ends up tuning against a quantity that
   * is not latency and never converges.
   *
   * So: ack the SEQUENCE here (round trip), report the TICK from `ackTick`
   * (timeline). Both, separately, is correct; either alone is not.
   */
  onInputArrived?(state: TState, pid: string, input: ClientInput): void;

  /**
   * Optional: how deep this player's playout buffer is right now, reported
   * every tick the ticker maintains one, and reported as 0 once on the tick a
   * buffer is dropped.
   *
   * The buffer lives inside the ticker, so this is the ONLY route by which its
   * depth reaches your state and therefore your snapshot. Without it a host
   * that carries a buffer-health byte on its wire (as it must, if the client
   * dilates its tick rate against the server's buffer depth) publishes a
   * constant 0 for every player forever. That is not an absent signal, it is a
   * WRONG one: 0 means "starving", so every client reads a permanent
   * instruction to tick faster and rebuild a buffer that is in fact perfectly
   * healthy, and pins at the fast end of its dilation range for the whole
   * session. Nothing throws and no counter moves.
   *
   * Reported on starved ticks as well as consumed ones, deliberately: a starve
   * is exactly when the depth matters and is exactly when `ackTick` does not
   * fire, which is why this is a separate hook rather than an extra argument on
   * that one.
   */
  onBufferHealth?(state: TState, pid: string, health: number): void;

  /**
   * Optional: should this player's playout buffer and starvation streak be
   * dropped? Polled once per tick for each player that currently has a buffer,
   * before the consume pass.
   *
   * A buffer is created by a stamped input and is otherwise dropped only when
   * an unstamped input for the same player supersedes it. That covers the
   * common transition but not every one: a player can stop sending stamped
   * input without sending anything else at all (they leave a vehicle, a match
   * ends, they simply stand still). Their buffer then starves on every
   * remaining tick of the session, and the starvation backstop keeps decaying a
   * held input for a player who is not driving a stamped stream anymore. Only
   * the simulation knows that transition happened, so only the simulation can
   * stand the backstop down.
   *
   * Return `true` for as long as the player should not have one; it is polled,
   * not a one-shot, so it must be cheap and must be safe to answer the same way
   * repeatedly.
   */
  clearPlayout?(state: TState, pid: string): boolean;

  /**
   * Optional: the latest tick any in-progress scored session runs until, or 0.
   * Written into the checkpoint so a host can grant grace (a play-time limit
   * that expires mid-match should not rob the player of the match) without
   * knowing anything about what a session is.
   */
  graceUntilTick?(state: TState): number;

  /** Optional: handle a `custom` envelope (a dev route forcing a state, an admin command). Unknown names should be ignored, not thrown on. */
  onCustom?(state: TState, name: string, data: unknown, pid?: string): void;

  /** Optional: free non-GC resources (a wasm physics world, a worker). Called when the ticker exits, on every path including a throw. */
  dispose?(state: TState): void;
}

/** What the ticker writes into the checkpoint envelope alongside your `serialize` output. */
export interface CheckpointEnvelope {
  /** Wire version of the envelope itself, so a future field can be added without stranding live rooms. */
  v: number;
  /** Sim tick at write time, so a reader can measure staleness without deserializing the body. */
  tick: number;
  /** `RoomRuntime.graceUntilTick`, hoisted so a reader (the relay's cutoff) never has to deserialize the body. */
  graceUntilTick: number;
  /**
   * A digest of the world geometry / rules this state was simulated against.
   * THE MOST IMPORTANT FIELD HERE. A checkpoint carries opaque state, so a
   * deploy that moves a wall leaves every live room restoring and re-saving a
   * simulation of the OLD map, forever, because each successor faithfully
   * restores its predecessor's bytes. Stamping a digest and refusing a mismatch
   * turns that silent permanent corruption into an ordinary fresh start.
   */
  geom?: string;
  /** Fresh per room CREATION and preserved across every RESTORE. See `LEDGER_KEY` for why an idempotency key needs both properties. */
  incarnation: string;
  /** Your `serialize` output. */
  body: string;
}

/** Diagnostic counters the ticker publishes to the room's stats key every second. */
export interface RoomStats {
  tick: number;
  players: number;
  /** Measured against real wall time between flushes, never assumed. A stalled loop is exactly what this exists to expose. */
  tickHz: number;
  uptimeS: number;
  publishes: number;
  /** Envelopes shed by backpressure. */
  dropped: number;
  /** Playout consume misses. The single most alert-worthy number here. */
  starves: number;
  /** Lease renew failures. The second most alert-worthy. */
  renewFails: number;
  badEnvelopes: number;
  /**
   * Envelopes that parsed cleanly and carried a `t` this ticker has no branch
   * for. Kept separate from `badEnvelopes` (which is malformed JSON and
   * shape-check failures) because the two mean completely different things: a
   * bad envelope is a broken or hostile sender, an unknown one is almost always
   * a DEPLOY SKEW, a producer running ahead of its consumer. Folding them
   * together is what made the original failure invisible, so do not fold them
   * back together to save a field.
   */
  unknownEnvelopes: number;
  bytesPublished: number;
  /**
   * `bytesPublished * players`. Every client socket holds its own Redis
   * subscriber, so one published snapshot crosses the wire once PER PLAYER.
   * That fan-out, not command count, is what a managed Redis plan bills.
   */
  bytesDelivered: number;
  cadence: Percentiles;
  publishAwait: Percentiles;
  serverInternal: Percentiles;
  at: number;
  build?: string;
  /**
   * Host-supplied dimensions carried through to whoever reads the stats gauge,
   * so a scraper can label a room gauge with something the library has no
   * concept of (which world this room is in, which region it was spawned in,
   * which shard owns it). tickroom never reads these; it copies them.
   *
   * KEEP THE VALUE SET SMALL AND SERVER-CHOSEN. These become label values on a
   * time series, and a label whose value a client can influence is unbounded
   * cardinality in the metrics backend. That is why this is a fixed record
   * supplied once at ticker startup rather than something recomputed per flush
   * from room state.
   */
  labels?: Record<string, string | number>;
}

export interface Percentiles {
  p50: number;
  p95: number;
  max: number;
}

/** Structured log line. Supply a sink or accept the console default; never let it block or throw into a caller. */
export interface LogEvent {
  lvl: 'info' | 'warn' | 'error';
  kind: string;
  msg?: string;
  room?: string;
  pid?: string;
  meta?: Record<string, unknown>;
}

export type Logger = (ev: LogEvent) => void;
