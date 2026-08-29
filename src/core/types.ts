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

/** A client joining, leaving, or sending input. Produced by the relay, consumed by the ticker. */
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
   */
  usesPlayout?(state: TState, pid: string): boolean;

  /** Optional: apply an input pulled from the playout buffer for this exact tick. Defaults to `applyInput`. */
  applyBufferedInput?(state: TState, pid: string, input: ClientInput): void;

  /** Optional: the buffer starved for this player this tick. Repeat the last input, decay it, or do nothing. See `starvation.ts` for why a bare repeat is wrong over a run of ticks. */
  onStarve?(state: TState, pid: string, consecutiveStarves: number): void;

  /** Optional: record that the server consumed this player's input for this tick, so the snapshot can echo it back as an ack. */
  ackTick?(state: TState, pid: string, tick: number): void;

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
