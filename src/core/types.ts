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
  /** Monotonic per-client sequence number. tickroom carries it and never reads it; a host that wants an application-level ack echoes it in its own snapshot. The library's own round-trip measurement is the relay ping (`core/wire.ts`), which needs no echo from the simulation. */
  seq: number;
  /** The tick this input should apply on. 0 or absent means apply on arrival. */
  targetTick?: number | undefined;
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
  /**
   * `c` is the RELAY CONNECTION that produced this envelope, a random id per
   * attached socket. The ticker remembers the newest `c` it has seen for a
   * pid and ignores a `leave` from any other, so a stale relay closing AFTER
   * the player's replacement socket has already joined (a reconnect, or the
   * planned swap at a relay's lifetime cap) cannot remove a player who is
   * still there. Absent on envelopes from a relay that predates it, in which
   * case a leave is honoured unconditionally, as before.
   */
  | { t: 'join'; pid: string; meta?: Record<string, unknown> | undefined; c?: string | undefined }
  | { t: 'leave'; pid: string; c?: string | undefined }
  | { t: 'in'; pid: string; w: ClientInput[] }
  | { t: 'custom'; pid?: string | undefined; name: string; data?: unknown }
  /**
   * The ticker's own liveness probe for its input subscription: published by
   * the ticker on the shared command client and expected back through its
   * subscriber. Never produced by a relay and never handed to the runtime; a
   * run of unanswered probes is how a ticker learns its subscription is dead
   * while every other signal still reads healthy. `o` is the publishing
   * ticker's owner id: two tickers can overlap on one room for a moment
   * around a handoff, and without it each would answer the other's probes and
   * a dead subscription could hide behind a live neighbour's.
   */
  | { t: 'probe'; n: number; o: string };

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

  /**
   * The number of COMPLETED ticks: 0 from `create`, incremented by every
   * `tick`, and the label the snapshot published after that step carries.
   * tickroom reads it for the checkpoint, the stats gauge and the client tick
   * timeline.
   *
   * THIS IS ALSO WHERE THE INPUT TIMELINE IS PINNED, so it is stated once here
   * and cross-referenced from `applyBufferedInput` and `ackTick`. THE STEP THAT
   * PRODUCES TICK T CONSUMES THE INPUTS STAMPED T: with `currentTick` at
   * `T - 1` the ticker consumes the record stamped `T` from the playout buffer,
   * hands it to `applyBufferedInput`, then calls `tick`, and the snapshot
   * labelled `T` already reflects it. A client that predicted record `T` as
   * moving its entity during its own step `T` therefore agrees with that
   * snapshot exactly, and one replaying its stored records from a snapshot
   * applies exactly those with `targetTick > snap.tick`. Off by one in either
   * direction the two ends still agree under steady input, because the record
   * applied a tick late carries the same value as the one that should have
   * been, and disagree by one tick of travel at every input CHANGE, which the
   * client's error offset turns into a visible wobble.
   */
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
  presentPids?: ((state: TState) => Iterable<string>) | undefined;

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
  isFull?: ((state: TState) => boolean) | undefined;

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
  usesPlayout?: ((state: TState, pid: string) => boolean) | undefined;

  /**
   * Optional: apply an input pulled from the playout buffer for this exact
   * tick. Defaults to `applyInput`. Called BEFORE the `tick` that produces the
   * tick the input is stamped for, so `currentTick` reads `targetTick - 1` at
   * the time of the call and the snapshot labelled `targetTick` is the first
   * to reflect it; see `currentTick` for the contract.
   */
  applyBufferedInput?: ((state: TState, pid: string, input: ClientInput) => void) | undefined;

  /**
   * Optional: the buffer starved for this player this tick. `consecutiveStarves`
   * is the count INCLUDING this starve, 1 on the first, exactly what
   * `decayOnStarve` in `starvation.ts` wants as its streak argument with no
   * adjustment: repeat the last input, decay it, or do nothing. See
   * `starvation.ts` for why a bare repeat is wrong over a run of ticks.
   */
  onStarve?: ((state: TState, pid: string, consecutiveStarves: number) => void) | undefined;

  /**
   * Optional: record that the server consumed this player's input for this
   * tick, so the snapshot can echo it back as an ack. `tick` is the record's
   * own `targetTick`, which is the tick the step about to run produces and the
   * label of the first snapshot that reflects the input; see `currentTick` for
   * the contract.
   */
  ackTick?: ((state: TState, pid: string, tick: number) => void) | undefined;

  /**
   * Optional: a record from this player has just ARRIVED, before any decision
   * about when it will be applied. Fired for every record in an inbound window,
   * stamped or not, at the instant the ticker takes it off the bus.
   *
   * This is the arrival signal, and it is here for a host's own telemetry or
   * its own application-level ack: counting inputs per player, echoing
   * `input.seq` back in your snapshot so your client can match a send to a
   * server-side event, spotting a player whose stream has gone quiet before the
   * playout buffer starves. The library reads nothing from it.
   *
   * THIS IS NOT `ackTick` AND THE TWO MUST NOT BE COLLAPSED. `ackTick` fires on
   * CONSUME, which for a stamped input is deliberately some ticks after it
   * arrived: that is the entire point of the playout buffer. Anything measuring
   * a ROUND TRIP has to be stamped here, at arrival, or it reports arrival
   * latency PLUS however long the input intentionally sat in the buffer, which
   * is not a latency at all and grows with the very lead a client would then
   * increase to compensate. Ack the SEQUENCE here (round trip), report the TICK
   * from `ackTick` (timeline).
   *
   * The LIBRARY's own round trip needs neither: `RoomConnection` measures it
   * with a `ping` frame the relay answers directly (see `core/wire.ts`), so
   * nothing in the simulation has to participate.
   */
  onInputArrived?: ((state: TState, pid: string, input: ClientInput) => void) | undefined;

  /**
   * Optional: how deep this player's playout buffer is running right now, in
   * ticks. Reported every tick the ticker maintains one, and reported as 0 once
   * on the tick a buffer is dropped.
   *
   * THE BUFFER LIVES INSIDE THE TICKER, SO THIS IS THE ONLY ROUTE BY WHICH ITS
   * DEPTH CAN REACH YOUR STATE AND THEREFORE YOUR SNAPSHOT. That path is the
   * whole point of the hook, and it has four steps:
   *
   *   1. this hook stores the depth per player in your state;
   *   2. your `encodeSnapshot` puts it on your own wire, per player or just
   *      the one, in whatever shape your wire already has room for;
   *   3. your client's `decodeSnapshot` picks out ITS OWN pid's value and
   *      returns it as `DecodedSnapshotLike.inputLead`;
   *   4. `RoomConnection` uses that to steer its stamping lead toward a
   *      two-tick cushion, correcting slowly and coarsely.
   *
   * `rttMs + inputLeadMs` is an open loop: a good guess at how much lead an
   * input needs, made entirely from the client's side of the wire. This closes
   * it, so the lead converges on the smallest one that keeps the buffer fed,
   * which is the smallest input latency that player can have.
   *
   * ALL FOUR STEPS ARE OPTIONAL AND THE LOOP FAILS INERT. A host that never
   * implements this hook, or has no room on its wire for the depth, simply
   * never returns `inputLead`, and the open-loop lead applies on its own: an
   * optimisation lost, not a working connection lost.
   *
   * Reported on starved ticks as well as consumed ones, deliberately: a starve
   * is exactly when the depth matters and is exactly when `ackTick` does not
   * fire, which is why this is a separate hook rather than an extra argument on
   * that one.
   */
  onBufferHealth?: ((state: TState, pid: string, health: number) => void) | undefined;

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
  clearPlayout?: ((state: TState, pid: string) => boolean) | undefined;

  /**
   * Optional: the latest tick any in-progress scored session runs until, or 0.
   * Written into the checkpoint so a host can grant grace (a play-time limit
   * that expires mid-match should not rob the player of the match) without
   * knowing anything about what a session is.
   */
  graceUntilTick?: ((state: TState) => number) | undefined;

  /** Optional: handle a `custom` envelope (a dev route forcing a state, an admin command). Unknown names should be ignored, not thrown on. */
  onCustom?: ((state: TState, name: string, data: unknown, pid?: string) => void) | undefined;

  /** Optional: free non-GC resources (a wasm physics world, a worker). Called when the ticker exits, on every path including a throw. */
  dispose?: ((state: TState) => void) | undefined;
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
  geom?: string | undefined;
  /**
   * The SCHEDULED GRID TIME of the tick this checkpoint describes: the same
   * value that tick's snapshot was stamped with, not a clock read at write
   * time. A successor continues the grid from `gridAt + tickMs` when that
   * lands within a tick of its own now, so `serverTime` runs on ONE timeline
   * across a planned handoff instead of restarting at the successor's
   * `Date.now()`.
   *
   * Without it a handoff moves the server timeline 20 to 40ms earlier and the
   * successor's first snapshot sits 9 to 29ms after the predecessor's last for
   * a whole tick of motion: the client interpolates that tick across the short
   * span and renders 165 to 269 u/s for two or three frames, and the same
   * phase jump erodes its stamping lead by half to eight tenths of a tick per
   * handoff without ever reaching the re-anchor tolerance. Measured end to end
   * over real sockets and a real Redis: buffer depth 5 to 4 to 1 to 0 over
   * three handoffs.
   *
   * OPTIONAL, AND ITS ABSENCE IS NOT A VERSION CHANGE. An older checkpoint
   * without it restores exactly as before and the successor starts its grid at
   * `Date.now()`, which is the behaviour every build has always had.
   */
  gridAt?: number | undefined;
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
  /**
   * Snapshots whose `PUBLISH` the bus CONFIRMED, counted when the publish
   * resolves rather than when it is issued. Counting attempts is what let a
   * room with a dead bus report a healthy publish rate; see `publishFails`,
   * which is the other half and is meaningless read on its own.
   */
  publishes: number;
  /**
   * Snapshots whose `PUBLISH` was REJECTED. Nothing else in this payload can
   * stand in for it: a room publishing nothing at all and a room publishing
   * everything successfully differ only in `publishes` versus `publishFails`,
   * because a failing publish costs no bytes, produces no latency sample and
   * moves neither the tick rate nor the player count.
   */
  publishFails: number;
  /**
   * Snapshots the ticker chose NOT to issue because too many earlier ones were
   * still unconfirmed by the bus. A snapshot is a full state, so one that could
   * not go out now is worthless later (the next supersedes it); issuing it
   * anyway only queues a stale burst for a reconnecting connection to replay.
   */
  publishSkipped: number;
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
  /**
   * Throws (or rejected thenables) out of the HOST's `RoomRuntime` hooks and
   * ticker callbacks, counted here and summarised once per flush instead of
   * logged per call. Kept apart from `badEnvelopes`, which is a broken or
   * hostile SENDER: a throwing `applyInput` is a simulation bug reached
   * through a client-controlled payload, and the two need different owners.
   */
  hostErrors: number;
  /**
   * Stamped inputs REFUSED by the playout buffer for sitting further AHEAD of
   * the consumed floor than `playoutMaxAhead` allows: the sender's lead is
   * larger than this room is configured to buffer, so the record was dropped
   * outright.
   *
   * ONE DIRECTION ONLY, AND THE ASYMMETRY IS DELIBERATE. A sender whose clock
   * runs BEHIND is never refused: its stamps name ticks already consumed, and
   * never-drop-late re-stamps them onto the next consumable tick and applies
   * them a tick or two late. Those show on `lateInputs`, not here. So this
   * counter reads zero for a sender that is behind by any amount, and the pair
   * is what tells the two apart: `lateInputs` rising is a client stamping too
   * close to the present, `refusedInputs` rising is one stamping too far into
   * the future for this room's configured window.
   *
   * A CONFIGURATION FAULT RATHER THAN A NETWORK ONE, which is why it is worth
   * its own field next to `starves`: the symptom without a name was starves
   * climbing with every other gauge healthy. Rising here means raise
   * `playoutMaxAhead` (or the sender is stamping further ahead than any real
   * round trip justifies), where rising `starves` alone means almost anything.
   */
  refusedInputs: number;
  /**
   * `room-reject` frames NOT published because one had already gone to that pid
   * within the last second. A join for a refused pid is answered on the roster
   * channel, which fans out to every socket in the room, so a producer that can
   * choose the join rate would otherwise choose the reject rate too.
   */
  rejectsSuppressed: number;
  /**
   * Stamped inputs that arrived AFTER their tick had already been consumed and
   * were re-stamped forward (`PlayoutBuffer`'s never-drop-late rule). Sustained
   * lateness means that client's stamping lead is too small for its round
   * trip; the client corrects its own lead from the `inputLead` a host echoes
   * in its snapshot, and this is the server-side aggregate of the same fact.
   */
  lateInputs: number;
  /** Bytes of CONFIRMED publishes only, on the same counted-on-success rule as `publishes`: bytes that never left the process are not bandwidth. */
  bytesPublished: number;
  /**
   * `bytesPublished * players`. Every client socket holds its own Redis
   * subscriber, so one published snapshot crosses the wire once PER PLAYER.
   * That fan-out, not command count, is what a managed Redis plan bills.
   */
  bytesDelivered: number;
  /**
   * `null` when the window held no samples at all, which is NOT the same as a
   * window of zeros and must never be flattened into one: for a latency
   * distribution, zero is the best possible reading, so a room that published
   * nothing would otherwise report the healthiest `publishAwait` in the
   * fleet. See `percentiles` in `core/metrics.ts`.
   */
  cadence: Percentiles | null;
  publishAwait: Percentiles | null;
  serverInternal: Percentiles | null;
  at: number;
  build?: string | undefined;
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
  labels?: Record<string, string | number> | undefined;
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
  msg?: string | undefined;
  room?: string | undefined;
  pid?: string | undefined;
  meta?: Record<string, unknown> | undefined;
}

export type Logger = (ev: LogEvent) => void;
