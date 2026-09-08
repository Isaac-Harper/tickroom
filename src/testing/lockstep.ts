// THE CLIENT AND THE SERVER, RUN SIDE BY SIDE, WITH THE HOST'S OWN WIRE
// BETWEEN THEM.
//
// Everything else this library ships checks one half. `predictedEntity.test.ts`
// runs the entity against a step the test itself wrote; a host's own unit tests
// run the runtime against inputs the test itself stamped. Both pass while the
// two ends read DIFFERENT WORLDS, and that is the divergence nobody catches,
// because no library check can see inside a host's step.
//
// THE BUG THIS EXISTS TO CATCH, from a real game built on this library. Its
// step read a collision latch computed from the CLIENT'S RAW POSE rather than
// from the pose it was being handed. The library replayed faithfully from the
// server's pose, the latch said "solid", and every replay refused to move: the
// prediction was dragged back onto the authoritative pose on every snapshot,
// which on screen was rubberbanding after every bomb drop. The step was pure,
// the arithmetic was right, the reconcile ran, and nothing anywhere reported a
// fault. A lockstep run reports it in one number.
//
// So this harness owns no game rules. It wires the pieces a page wires and
// nothing else:
//
//   - the host's real `RoomRuntime` as the server, driven the way
//     `src/server/ticker.ts` drives it;
//   - the host's real codec both ways, so the client reads WIRE-QUANTISED
//     poses rather than the server's own floats;
//   - the real `PredictedEntity` (the object `RoomConnection`'s `predict`
//     option owns) on a fake conn, stamping against a real `ClientTick` that
//     runs `lead` ticks ahead of the server, on the same wire the connection
//     would use;
//   - the real `PlayoutBuffer` and `StarveTracker` on the server side, so the
//     consume order and the hooks are the ticker's and not a convenient
//     approximation of them.
//
// THE NETWORK IS THE TWO NUMBERS THAT MATTER. `lead` is how far ahead of the
// server the client's counter stamps, and `delay` is how many ticks a snapshot
// takes to arrive. Everything else a real link does (jitter, loss, the
// re-anchor) is deliberately absent: this measures whether the two sides
// AGREE, and agreement has to be exact before noise is worth measuring.
//
// THE NUMBER TO JUDGE A RUN BY IS THE WIRE'S OWN RESOLUTION. A host that
// quantises poses to a hundredth of a unit can honestly differ by that
// rounding and by nothing else. A step reading its context at the wrong tick
// reads MANY TIMES that, immediately and on every snapshot, and pins besides.
//
// NOTHING HERE IMPORTS A NODE BUILTIN OR `ioredis`, deliberately: the whole
// point is that a host can run this in the same browser test runner its client
// code already runs in. `src/client/bundling.test.ts` bundles this entrypoint
// for the browser to keep that true.

import { ClientTick } from '../client/clientTick.js';
import { PredictedEntity, type Pose, type PredictedEntityOptions, type StampedRecord } from '../client/predictedEntity.js';
import { decodeInputAuto } from '../codec/snapshot.js';
import { PlayoutBuffer } from '../core/playout.js';
import { StarveTracker } from '../core/starvation.js';
import type { ClientInput, RoomRuntime, SnapshotPayload } from '../core/types.js';

/** The room id `runLockstep` creates its state with. A lockstep run is one room and never restores one, so nothing here needs it to be a knob. */
const LOCKSTEP_ROOM_ID = 'lockstep';

export interface LockstepOptions<TState, TSnap, TInput> {
  /**
   * The simulation under test, exactly as it is deployed. Driven through
   * `create`, `join` (yours, in `setup`), the playout hooks and `tick`: the
   * server half of this harness is the ticker's own loop with the bus, the
   * lease and the checkpoint removed.
   */
  runtime: RoomRuntime<TState, unknown>;
  /** The player whose prediction is under test. Seat it in `setup`. */
  pid: string;
  /**
   * The room as this run wants it: join `pid`, place whatever the scenario
   * collides against, park anyone else. Runs once, on a freshly `create`d
   * state, before the first tick.
   */
  setup: (state: TState) => void;
  /**
   * The host's own snapshot encoder, and the reason the client sees the same
   * numbers a real one would. Call it with whatever `serverTimeMs` your
   * encoder wants; nothing here reads it back.
   */
  encode: (state: TState) => SnapshotPayload;
  /** The host's own snapshot decoder, the inverse of `encode`. */
  decode: (bytes: SnapshotPayload) => TSnap;
  /**
   * THE FUNCTION UNDER TEST: the step the host hands `predict.step`, which
   * must be the same rule the runtime applies. It is passed straight through,
   * so whatever it closes over is what the replay reads, which is the entire
   * point of running it here rather than beside a copy of the runtime.
   */
  step: (pose: Pose, input: TInput, dt: number, tick: number) => Pose;
  /** `predict.maxSpeed`, units per second. Bounds the glide and sets the snap distance; see `PredictedEntityOptions`. */
  maxSpeed: number;
  /** `predict.ownPose`: the predicted player's pose out of a decoded snapshot, or `null` while the snapshot does not carry one (before a seat is assigned, after a death). A `null` reconciles nothing and leaves the trace holding the last pose that was there. */
  ownPose: (snap: TSnap) => Pose | null;
  /** `predict.wire`, and the same default: `'binary'` requires `TInput` to be `DefaultInput`. Pong's `{ dir }` needs `'json'` here exactly as it does on the page. */
  wire?: 'binary' | 'json' | undefined;
  /** `predict.encodeInput`, for a host with a wire of its own. Pair it with the `decodeInput` that reads it. */
  encodeInput?: ((records: StampedRecord<TInput>[]) => ArrayBuffer | Uint8Array | string) | undefined;
  /** The scripted input for one client tick. Called once per iteration with the tick being stamped. */
  input: (tick: number) => TInput;
  /**
   * The host's own `onSnapshot`, run on every arrival BEFORE the reconcile,
   * which is where a page's socket callback runs it. This is where the
   * client-side context a step reads (a grid, a wall map, a phase) is updated,
   * so a harness that skipped it would test the step against a world the page
   * never gives it. `tick` is the client tick that frame will stamp for.
   */
  onSnapshot?: ((snap: TSnap, tick: number) => void) | undefined;
  /**
   * The host's own relay-side `decodeInput`, so the records reaching the
   * runtime are the ones its real decoder produces. Defaults to
   * `decodeInputAuto`, the relay's own default, which reads both of the
   * library's wires. The JSON wire's records carry no `seq`, exactly as they
   * do on a real socket; the library documents that it never reads one.
   */
  decodeInput?: ((payload: unknown) => ClientInput[]) | undefined;
  /** How many ticks ahead of the server the client's counter stamps. */
  lead: number;
  /** How many ticks a snapshot takes to reach the client. */
  delay: number;
  /** How many ticks to run. Give the scenario `lead` ticks to reach steady state plus however long the interesting part takes. */
  ticks: number;
  /** `predict.initial`: where the prediction starts before the first authoritative pose. The first confirmation replaces it outright, so this only has to be plausible. Defaults to the origin. */
  initial?: Pose | undefined;
  /** Reconciles at or below this error are left out of `reconciles`. Defaults to 0, which lists every reconcile that was not exact. */
  reconcileThreshold?: number | undefined;
}

/** One reconcile as it happened: the arriving snapshot's tick and the error it reported before the offset absorbed it. */
export interface LockstepReconcile {
  tick: number;
  error: number;
}

/** One iteration: the tick the server produced, and where each side stood after it. Both poses are wire-quantised, so they are comparable directly. */
export interface LockstepFrame {
  tick: number;
  server: Pose;
  client: Pose;
}

export interface LockstepReport {
  /**
   * The largest reconcile error the run produced, in the simulation's own
   * units. THE FIRST CONFIRMATION IS NOT IN IT: the prediction before it was
   * a guess at `initial`, so the entity snaps rather than glides there by
   * design and the number says nothing about the step. Judge this against
   * the resolution of your own wire.
   */
  maxError: number;
  /** Every reconcile above `reconcileThreshold`, the first confirmation excluded for the reason above. */
  reconciles: LockstepReconcile[];
  /** How many times the draw jumped rather than glided AFTER the first confirmation. Anything here is a correction no glide could hide. */
  snaps: number;
  /**
   * THE PINNING SIGNATURE, and the one this harness exists for: the ticks
   * where the server's own pose MOVED and the client's raw `conn.own` did
   * not. A step reading its context off the wrong pose refuses to move at all,
   * and a pinned prediction still LOOKS alive from outside because it adopts
   * the server's pose on every snapshot. This is what that looks like from
   * inside.
   *
   * ONE HONEST FALSE POSITIVE, so read it beside the trace rather than alone:
   * a client already sitting against a wall the server is still `lead` ticks
   * short of reads the same way, because the server genuinely moves and the
   * prediction genuinely does not. Run a scenario up to its wall, not past it.
   */
  pinned: { tick: number }[];
  /** How many records the entity stamped, `conn.ownStats.stamped`. One per tick of a healthy run. */
  stamped: number;
  /** The whole run, tick by tick, for a host to inspect when a number above is not enough. */
  trace: LockstepFrame[];
}

/** One combination of a sweep. */
export interface LockstepSweepResult {
  lead: number;
  delay: number;
  report: LockstepReport;
}

function distance(a: Pose, b: Pose): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function moved(a: Pose, b: Pose): boolean {
  return a.x !== b.x || a.y !== b.y;
}

/**
 * Runs one lockstep client-versus-server session and reports what the two
 * sides did.
 *
 * THE ITERATION IS THE REAL ORDER, not a convenient one. A snapshot that
 * arrives reconciles against the world the previous frame left behind
 * (`RoomConnection` calls `onSnapshot` from the socket, between frames), then
 * the counter moves, then the entity advances, then the records it just sent
 * cross to the server, and only then does the server produce the tick they
 * were stamped for.
 *
 * THE SERVER HALF IS `src/server/ticker.ts` WITH THE TRANSPORT REMOVED. The
 * arrival pass is the ticker's `'in'` branch (around lines 1900 to 2000:
 * `onInputArrived` first, a `targetTick` that is a positive integer plus
 * `usesPlayout` decides buffered against applied-on-arrival, and the window is
 * pushed newest first). The consume pass is steps 5 and 6 of the loop (around
 * lines 2109 to 2200, under the heading THE STEP THAT PRODUCES TICK T
 * CONSUMES THE INPUTS STAMPED T): `currentTick` is the number of COMPLETED
 * ticks, so the step below produces `tickNow + 1` and this pass consumes and
 * acks exactly that stamp, with `applyBufferedInput ?? applyInput` applying it
 * and `onBufferHealth` reported on the starved path as well as the consumed
 * one. Getting that order wrong by a single tick is a divergence a host cannot
 * see from either end alone, which is why it is mirrored rather than
 * approximated.
 */
export function runLockstep<TState, TSnap, TInput>(opts: LockstepOptions<TState, TSnap, TInput>): LockstepReport {
  const { runtime, pid } = opts;
  const dt = 1 / runtime.tickHz;
  const tickMs = 1000 / runtime.tickHz;
  const initial: Pose = opts.initial ?? { x: 0, y: 0 };
  const threshold = opts.reconcileThreshold ?? 0;
  const decodeInput = opts.decodeInput ?? decodeInputAuto;

  // ---------------------------------------------------------------------
  // The server.
  // ---------------------------------------------------------------------
  const state = runtime.create(LOCKSTEP_ROOM_ID);
  opts.setup(state);
  const buffer = new PlayoutBuffer<ClientInput>();
  const starve = new StarveTracker();

  const readServerPose = (): Pose | null => opts.ownPose(opts.decode(opts.encode(state)));

  // ---------------------------------------------------------------------
  // The client. Every field here has a counterpart in a page.
  // ---------------------------------------------------------------------
  const tick = new ClientTick({ tickMs });
  const sent: (ArrayBuffer | Uint8Array | string)[] = [];
  const conn = { tick, send: (payload: ArrayBuffer | Uint8Array | string) => void sent.push(payload) };
  // The object `predict` owns, built from the same five options a page gives
  // that option, so the wire the records cross here is the wire they cross
  // there.
  const entity = new PredictedEntity<TInput>({
    conn,
    // Passed straight through. The cast is arity and nothing else: the entity
    // hands its step the tick it is stepping, and this option is deliberately
    // the four argument form so a host writes ONE step for both ends rather
    // than a narrower copy for this harness.
    step: opts.step as PredictedEntityOptions<TInput>['step'],
    maxSpeed: opts.maxSpeed,
    initial,
    wire: opts.wire,
    encodeInput: opts.encodeInput,
  });

  const reconciles: LockstepReconcile[] = [];
  const pinned: { tick: number }[] = [];
  const trace: LockstepFrame[] = [];
  const inFlight: { at: number; tick: number; bytes: SnapshotPayload }[] = [];
  let maxError = 0;
  let confirmed = false;
  let snapsAtFirst = 0;

  let prevServer: Pose = readServerPose() ?? initial;
  const first = runtime.currentTick(state) + 1;

  for (let k = 1; k <= opts.ticks; k++) {
    const produced = first + k - 1;
    // The tick this frame will stamp for. Anchored directly rather than
    // learned from a snapshot: a run starts mid-session, and the join
    // handshake is not what any of this measures.
    const clientTick = produced - 1 + opts.lead;

    // --- arrivals, before the counter moves ---
    while (inFlight.length > 0 && (inFlight[0]?.at ?? Infinity) <= produced) {
      const arrived = inFlight.shift()!;
      const snap = opts.decode(arrived.bytes);
      opts.onSnapshot?.(snap, clientTick);
      const authoritative = opts.ownPose(snap);
      if (authoritative !== null) {
        const wasFirst = !confirmed;
        confirmed = true;
        entity.reconcile(authoritative, arrived.tick);
        if (wasFirst) {
          snapsAtFirst = entity.stats.snaps;
        } else {
          const error = entity.stats.lastError;
          if (error > maxError) maxError = error;
          if (error > threshold) reconciles.push({ tick: arrived.tick, error });
        }
      }
    }

    // --- the client's frame ---
    tick.anchorTo(clientTick);
    const clientBefore = entity.pose;
    entity.advance(opts.input(tick.value), dt);
    const clientAfter = entity.pose;

    // --- the wire up, and the ticker's arrival pass ---
    for (const payload of sent.splice(0)) {
      let stamped: { tick: number; input: ClientInput }[] | null = null;
      for (const input of decodeInput(payload)) {
        runtime.onInputArrived?.(state, pid, input);
        const targetTick = input.targetTick;
        const isStamped = typeof targetTick === 'number' && Number.isInteger(targetTick) && targetTick > 0;
        if (isStamped && (runtime.usesPlayout?.(state, pid) ?? false)) {
          (stamped ??= []).push({ tick: targetTick, input });
        } else {
          if (!isStamped) {
            buffer.clear();
            stamped = null;
          }
          runtime.applyInput(state, pid, input);
        }
      }
      // Newest first, as the ticker pushes a window.
      if (stamped !== null) for (let i = stamped.length - 1; i >= 0; i--) buffer.push(stamped[i]!.tick, stamped[i]!.input);
    }

    // --- the server's consume pass and its step ---
    const producedTick = runtime.currentTick(state) + 1;
    const { item, starved } = buffer.consume(producedTick);
    if (starved) {
      // EARLY IS NOT STARVED: a buffer still holding entries reports streak 1
      // rather than running the decay, exactly as the ticker does.
      if (buffer.health() > 0) runtime.onStarve?.(state, pid, 1);
      else runtime.onStarve?.(state, pid, starve.onStarve(pid));
    } else if (item !== undefined) {
      starve.onConsume(pid);
      (runtime.applyBufferedInput ?? runtime.applyInput)(state, pid, item);
      runtime.ackTick?.(state, pid, producedTick);
    }
    runtime.onBufferHealth?.(state, pid, buffer.health());
    runtime.tick(state, dt);

    // --- the snapshot for this tick, on its way ---
    // THE LABEL IS READ BACK OUT OF THE RUNTIME, never carried forward from
    // the consume above, because that is where a host's own encoder reads it
    // and a client's whole replay window is `targetTick > snap.tick`. Deriving
    // it here instead would let a consume order off by one tick move the label
    // with it, and the two errors would cancel: the harness would report a
    // perfect run for a timeline nobody could reproduce.
    const label = runtime.currentTick(state);
    const bytes = opts.encode(state);
    inFlight.push({ at: produced + opts.delay, tick: label, bytes });

    const serverAfter = opts.ownPose(opts.decode(bytes)) ?? prevServer;
    trace.push({ tick: label, server: serverAfter, client: clientAfter });
    if (moved(prevServer, serverAfter) && !moved(clientBefore, clientAfter)) pinned.push({ tick: label });
    prevServer = serverAfter;
  }

  return {
    maxError,
    reconciles,
    snaps: entity.stats.snaps - snapsAtFirst,
    pinned,
    stamped: entity.stats.stamped,
    trace,
  };
}

/**
 * Every combination of `leads` and `delays`, one report each, with a fresh
 * room and a fresh entity per combination.
 *
 * ONE LEAD PROVES NOTHING ON ITS OWN. A step reading its context at the wrong
 * tick is exact whenever the client happens to be stamping the tick it reads,
 * so the offset a bug lives at has to be swept past rather than sampled at.
 * Note that `setup` and `input` run once per combination, so a scenario that
 * closes over mutable state has to reset it there rather than in the caller.
 */
export function sweepLockstep<TState, TSnap, TInput>(
  opts: Omit<LockstepOptions<TState, TSnap, TInput>, 'lead' | 'delay'>,
  leads: readonly number[],
  delays: readonly number[],
): LockstepSweepResult[] {
  const results: LockstepSweepResult[] = [];
  for (const lead of leads) {
    for (const delay of delays) {
      results.push({ lead, delay, report: runLockstep({ ...opts, lead, delay }) });
    }
  }
  return results;
}
