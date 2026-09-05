// The browser half of the pong example.
//
// Read this alongside sim.ts. Between them they are a complete multiplayer game:
// roughly 200 lines of simulation and 150 of client, and NONE of it deals with
// reconnects, clock skew, jitter, or a server that gets killed every few minutes.
// That is what the library is for.
//
// The one idea worth internalising: WE DO NOT DRAW WHAT THE SERVER SAID. We
// draw what `conn.frame()` returns, which is the server's state replayed on a
// deliberate delay so that jitter has somewhere to hide. See section 5 of
// docs/ARCHITECTURE.md for why that delay is the correct trade.
//
// THE SECOND IDEA, AND THE ONE THIS FILE IS THE REFERENCE FOR: your OWN entity
// is the one thing that delay is not acceptable for, because you are steering
// it. So it runs the stamped path instead, and both halves of it:
//
//   1. EVERY INPUT CARRIES THE TICK IT APPLIES ON (`targetTick`), one record
//      per client tick, with the last few re-sent on every packet. The server
//      buffers them and applies each on exactly the tick it names.
//   2. THE CLIENT APPLIES THAT SAME RECORD, ON THAT SAME TICK, to its own copy
//      of its own paddle, through the identical `stepPaddleY` the simulation
//      uses. The paddle answers the key instantly, with no round trip in it.
//
// Because both ends ran the same function on the same input on the same tick,
// they agree, and a snapshot is a confirmation rather than a correction. When
// they do NOT agree (a dropped packet the redundancy window did not cover, a
// starved tick the server filled with a repeat, a re-anchor), the difference
// is bled off over a few frames instead of teleporting the paddle.
//
// THIS FILE USED TO WRITE ALL OF THAT OUT BY HAND: a redundancy window and the
// send loop, the prediction stepped once per stamped tick, the replay from
// every snapshot into an `ErrorOffset` with a snap on the first confirmation,
// the previous tick's state kept beside the current one for the draw, and a
// re-anchor handler to keep the send mark and the window honest. Forty lines,
// four coupled rules, and two of them were wrong here until the day the
// library took them over. They are `PredictedEntity` now: one object, one call
// per frame, one call per snapshot, and nothing for this file to get wrong.
// Remote paddles and the ball keep coming from `conn.frame()` on the
// interpolation delay, which is correct for them: nobody is steering them here.
//
// THE FILE IS IN TWO HALVES, AND THE SPLIT IS THE DOM. `createPongClient`
// below is all of the netcode and none of the browser: the connection, the
// decode, the interpolator, the prediction and the per-frame ordering the two
// depend on. `startPong` is the canvas, the keys and the animation frame on
// top of it, and it is thirty lines of drawing. The half worth copying is the
// first one, and keeping it free of `document` is also what lets
// `tests/example.redis.test.ts` drive THIS wiring through a real socket
// instead of a retyped copy of it, which is the only way the shipped example
// can be the thing CI checks.

import {
  PredictedEntity,
  RoomConnection,
  SnapshotInterpolator,
  type EntitySample,
  type InterpolatedEntity,
  type Pose,
  type SessionInfo,
  type TerminalReason,
  type WebSocketConstructor,
} from '../../src/client/index.js';
import { FIELD_H, FIELD_W, PADDLE_SPEED, readDir, stepPaddleY } from './sim.js';

// A plain interface, with no index signature and no relationship to any
// tickroom type. `decodeSnapshot`'s return type is what fixes the payload type
// for `onSnapshot` and for `interpolate.entities`, so this shape flows through
// the connection and comes back out intact. It used to have to extend
// `DecodedSnapshotLike` for the index signature, and `onSnapshot` still handed
// it back erased, which is why this file used to open its callback with the
// `as unknown as` double cast TypeScript's own error text calls a mistake.
export interface PongSnapshot {
  tick: number;
  serverTime: number;
  ball: { x: number; y: number };
  serveIn: number;
  winner: string | null;
  paddles: { pid: string; side: 'left' | 'right'; y: number; score: number; inputLead: number }[];
  /** Step 3 of the loop `sim.ts`'s `onBufferHealth` opened: OUR OWN pid's
   *  playout depth, lifted out of `paddles` in `decodeSnapshot` below. This is
   *  the one field `RoomConnection` reads out of a host's snapshot beyond
   *  `tick` and `serverTime`, and it is optional there: omit it and the
   *  RTT-compensated lead applies on its own.
   *
   *  `| undefined` SPELLED OUT, because `exactOptionalPropertyTypes` is on:
   *  `decodeSnapshot` below writes `mine?.inputLead`, which is genuinely
   *  `undefined` for a snapshot that does not name us yet, and a bare
   *  `inputLead?: number` refuses that write. It used to compile only because
   *  nothing named this type: the connection inferred its own wider shape from
   *  the decoder. `PongClient.conn` names it, so the two now have to agree. */
  inputLead?: number | undefined;
}

/** Must equal `pongRuntime.tickHz`. The connection is the only place it is
 *  stated: the prediction reads its timestep off `conn.tick.tickMs`, so there
 *  is no second literal here to disagree with this one. Only the paddle step
 *  is imported from the simulation: the client has no use for the ball, the
 *  scoring or the serve. */
const TICK_HZ = 20;

/** Where a paddle sits for each side. The server owns the assignment; this is
 *  only where to draw it. */
const paddleX = (side: 'left' | 'right'): number => (side === 'left' ? 6 : FIELD_W - 6);

/**
 * Everything the netcode below cannot decide for itself: where a session comes
 * from, where the socket lives, which WebSocket to open, how a snapshot frame
 * turns into a `PongSnapshot`, and what to tell the player about the two
 * states that are not the game. All of it is optional except `mint`, and every
 * default is the browser tab's answer.
 */
export interface PongClientOptions {
  /** Obtain a session. `startPong`'s own is the `POST /api/session` below; a headless client mints or fetches its own. */
  mint(): Promise<SessionInfo>;
  /** Build the socket URL. Omitted, `RoomConnection`'s default uses `location`, which is right in a tab and absent anywhere else. */
  socketUrl?: ((session: SessionInfo) => string) | undefined;
  /** Omitted, the global `WebSocket`. */
  WebSocketImpl?: WebSocketConstructor | undefined;
  /**
   * Turn one snapshot frame into a `PongSnapshot`. Defaults to the JSON
   * `sim.ts`'s `encodeSnapshot` publishes, which is what a first reading
   * should see. Pass `decodePongSnapshot` from `codec.ts` when the ticker was
   * wired with `encodePongSnapshot`: that is the whole of the binary upgrade
   * on this side, exactly as the codec's own header promises, and nothing
   * else here changes.
   */
  decode?: ((buf: ArrayBuffer) => PongSnapshot) | undefined;
  onStallChange?: ((stalled: boolean) => void) | undefined;
  onTerminal?: ((reason: TerminalReason) => void) | undefined;
}

/** What one frame has to draw. Returned by `frame()` rather than read off the client, because every field of it is only meaningful for the frame it came from. */
export interface PongFrame {
  /** The interpolated room: the ball, and every paddle including our own. Ours is in here and drawn from `own` instead; see the frame loop. */
  entities: Map<string, InterpolatedEntity>;
  /** OUR paddle, from the prediction rather than the interpolator: no playback delay and no round trip in it. */
  own: Pose;
  /** Discrete state the interpolator cannot smooth, from the newest snapshot. */
  scores: Map<string, number>;
  winner: string | null;
  serveIn: number;
  /** Empty until `mint()` has answered. */
  selfPid: string;
  /** Which end we defend, from the first snapshot that names us; `null` until then, which is also "there is nothing of ours to draw yet". */
  selfSide: 'left' | 'right' | null;
}

export interface PongClient {
  /** The connection itself, for `stats()` and for a host that wants to send something of its own. */
  readonly conn: RoomConnection<PongSnapshot, string>;
  /** Exposed for the same reason `conn` is: `paddle.stats` is what a debug overlay reads to see how far the prediction and the server actually disagree. */
  readonly paddle: PredictedEntity<{ dir: number }>;
  /** Held input, -1 up through +1 down. Nothing is sent from here; a send is one record per TICK, from `frame()`. */
  setDir(dir: number): void;
  /** THE ONE PER-FRAME CALL. Advances the counter, samples the interpolator, stamps and sends this frame's ticks, and returns the pose to draw. */
  frame(now: number): PongFrame;
  start(): Promise<void>;
  stop(): void;
}

/**
 * The whole of pong's client except the drawing: no canvas, no keys, no
 * `requestAnimationFrame`, no `document`. `startPong` is this plus thirty
 * lines of 2D context.
 */
export function createPongClient(opts: PongClientOptions): PongClient {
  const decode =
    opts.decode ?? ((buf: ArrayBuffer): PongSnapshot => JSON.parse(new TextDecoder().decode(buf)) as PongSnapshot);
  const interp = new SnapshotInterpolator<string>();

  // Everything the interpolator does not smooth: scores, the winner, the serve
  // countdown. These are discrete state, not motion, so interpolating them would
  // be meaningless (there is no "half a point").
  let scores = new Map<string, number>();
  let winner: string | null = null;
  let serveIn = 0;
  let selfPid = '';
  /** Which end we defend, from the first snapshot that names us. `null` until
   *  then, which is also "the server has not confirmed we have a paddle yet"
   *  and therefore "there is nothing of ours to draw". */
  let selfSide: 'left' | 'right' | null = null;

  /** Held input, -1 up through +1 down. A STATE the player holds, not an event
   *  that fires once, which is what makes a dropped packet harmless: the next
   *  tick re-asserts the same intent. An event scheme would need reliable
   *  delivery for a keyup, and a lost keyup is a paddle that never stops. */
  let dir = 0;

  // The type arguments are STATED rather than inferred from `decodeSnapshot`.
  // Inference produced a structurally wider shape (`inputLead` present and
  // possibly `undefined`, rather than optional), which is fine while nothing
  // names the type and is not assignable to `PongSnapshot` the moment
  // `PongClient` does.
  const conn = new RoomConnection<PongSnapshot, string>({
    // Required rather than defaulted, because a client silently running on the
    // wrong basis skews the tick counter, the server-tick estimate and the
    // underrun threshold at once.
    tickHz: TICK_HZ,

    mint: async () => {
      // The host's own mint, plus the one thing this file needs out of it: our
      // pid, which `decodeSnapshot` and `onSnapshot` both pick our own paddle
      // out of the roster with.
      const session = await opts.mint();
      selfPid = session.playerId;
      return session;
    },

    socketUrl: opts.socketUrl,
    WebSocketImpl: opts.WebSocketImpl,

    decodeSnapshot: (buf) => {
      const snap = decode(buf);
      // STEP 3 OF THE FEEDBACK LOOP `sim.ts`'s `onBufferHealth` OPENED: pick
      // OUR OWN pid's depth out of the per-paddle field and hand it back as
      // `inputLead`. The connection folds it into its stamping lead, trimming
      // toward a two-tick cushion, so the lead converges on the smallest one
      // that keeps the server's buffer fed rather than staying at the
      // open-loop `rttMs + inputLeadMs` guess. Omit this and nothing breaks:
      // the open-loop lead applies on its own.
      const mine = snap.paddles.find((p) => p.pid === selfPid);
      return { ...snap, inputLead: mine?.inputLead };
    },

    // The connection owns the interpolator: it pushes every decoded snapshot in
    // with the right two timestamps and clears the buffer on every epoch
    // change. All this side has to say is which parts of a snapshot MOVE.
    interpolate: {
      into: interp,
      entities: (snap) => {
        // The ball and each paddle are entities; a score is not. Interpolating
        // discrete state is meaningless (there is no half a point), so it is
        // read in `onSnapshot` instead.
        //
        // OUR OWN PADDLE IS PUSHED IN HERE TOO, and then not drawn from here:
        // the frame loop draws it from the prediction instead. Leaving it in
        // costs one entry and keeps this callback a plain description of what
        // the snapshot contains, rather than a description with a special case
        // for whoever happens to be looking at it.
        const entities = new Map<string, EntitySample>();
        entities.set('ball', { x: snap.ball.x, y: snap.ball.y });
        for (const p of snap.paddles) {
          entities.set(p.pid, { x: paddleX(p.side), y: p.y });
        }
        return entities;
      },
    },

    // `snap` arrives as `PongSnapshot`, not as an erased shape needing a cast.
    onSnapshot: (snap) => {
      winner = snap.winner;
      serveIn = snap.serveIn;
      const next = new Map<string, number>();
      for (const p of snap.paddles) next.set(p.pid, p.score);
      scores = next;

      // RECONCILE THE PREDICTION. The snapshot is authoritative for tick
      // `snap.tick`, but we have already stamped and simulated inputs for
      // ticks after that, so the server's y is not directly comparable to
      // ours: it is where our paddle was several ticks ago. The entity replays
      // its own stored records from there, adopts the result, and glides the
      // difference away; on a healthy link that difference is the snapshot's
      // own rounding (a tenth of a unit) and nothing else. The very first
      // confirmation snaps instead, which is also what seats the paddle's x
      // on the side the server assigned.
      const mine = snap.paddles.find((p) => p.pid === selfPid);
      if (!mine) return;
      selfSide = mine.side;
      paddle.reconcile({ x: paddleX(mine.side), y: mine.y }, snap.tick);
    },

    onStallChange: opts.onStallChange,

    // NO `onTickReanchor` HANDLER, AND THAT IS THE POINT. This file used to
    // need one to move its send high-water mark by the delta and drop the
    // in-flight window, because a backward re-anchor (a handoff, a backgrounded
    // tab, a clock step) otherwise silenced the send loop until the counter
    // climbed back past the old mark: measured at 5.6 seconds of input silence
    // on a real socket. `PredictedEntity` reads the jump off the counter
    // itself, so the callback is telemetry now, for a host that wants to count
    // re-anchors, and nothing here needs it.

    onTerminal: opts.onTerminal,
  });

  // ---- our own paddle, predicted locally ------------------------------------
  //
  // The whole of the stamped path's client half. Once per frame `advance`
  // stamps a record for every tick the counter crossed (never per frame, never
  // per keydown: the tick is the unit the server applies input on), predicts
  // each through `step`, sends the last six as one JSON array (what the relay's
  // `decodeInput` in examples/node-server parses), and returns the pose to
  // draw: its pose history read at a render playhead that moves at real time
  // (within a tenth) one tick behind the newest stamp, with what is left of
  // the last correction added. Once per snapshot `reconcile` replays and
  // re-seats. The paddle's x never changes under `step`; the first reconcile
  // seats it on the side the server chose. The timestep is `conn.tick.tickMs`,
  // read off the connection, so there is nothing here to keep equal to it.
  const paddle = new PredictedEntity<{ dir: number }>({
    conn,
    // THE SAME FUNCTION THE SIMULATION RUNS, on the same input, on the tick
    // the record names. That is the whole promise of stamping, and it is one
    // line because `stepPaddleY` is shared rather than copied.
    step: (pose, input, dt) => ({ x: pose.x, y: stepPaddleY(pose.y, input.dir, dt) }),
    // Bounds the correction glide (a paddle sliding back onto the server's
    // answer faster than a paddle can move on its own reads as a second,
    // ghostly hand on the controls: the glide adds at most this on top of the
    // paddle's motion) and sets the snap distance at half a second of travel.
    maxSpeed: PADDLE_SPEED,
    initial: { x: 0, y: FIELD_H / 2 },
  });

  return {
    conn,
    paddle,
    setDir: (d) => {
      dir = d;
    },
    frame: (now) => {
      // THE ONE PER-FRAME CALL. It advances the tick counter inputs are stamped
      // against, polls the stall detector, and samples the interpolator, all from
      // one delta the connection measures for itself. This used to be three
      // separate calls and one of them was documented nowhere, so a client that
      // looked completely healthy could be stamping every input a second and a
      // half into the past.
      const { entities, dt } = conn.frame(now);
      // AFTER `frame()`, never before: the counter this stamps against is
      // advanced by that call, so advancing first stamps every record one frame
      // into the past. `readDir` is the simulation's own clamp, run here so the
      // record we predict with is byte for byte the record the server will
      // apply: a second, subtly different sanitiser on this side is a
      // divergence with no symptom until it fires.
      const own = paddle.advance({ dir: readDir(dir) }, dt);
      return { entities, own, scores, winner, serveIn, selfPid, selfSide };
    },
    start: () => conn.start(),
    stop: () => conn.stop(),
  };
}

/**
 * The browser shell: a canvas, two keys, and an animation frame over
 * `createPongClient`. Everything below this line is drawing.
 */
export function startPong(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d')!;

  const client = createPongClient({
    mint: async () => {
      const res = await fetch('/api/session?room=pong', { method: 'POST' });
      // A mint has more than one failure shape and only one of them is JSON. A
      // rate limiter answering 429 with a text body makes res.json() throw, and
      // an unguarded throw here rejects the whole boot: black canvas, no
      // message, no retry. Check ok before parsing.
      if (!res.ok) throw new Error(`mint failed: ${res.status}`);
      return (await res.json()) as SessionInfo;
    },

    onStallChange: (stalled) => {
      // NON-BLOCKING on purpose. A stall usually self-heals (a ticker handoff, a
      // brief network gap), so the player keeps control of a live world while it
      // does. A modal here would be worse than the problem.
      document.getElementById('stall')?.classList.toggle('visible', stalled);
    },

    onTerminal: (reason) => {
      // These do NOT self-heal, so unlike a stall they are allowed to own the
      // screen.
      const el = document.getElementById('terminal');
      if (!el) return;
      el.textContent = {
        capacity: 'This table is full. Try another.',
        'conn-limit': 'Already playing in another tab.',
        'version-skew': 'Update needed. Reload to continue.',
        'closed-by-server': 'Session ended.',
        'connect-error': 'Could not reach the table. Reload to try again.',
        'mint-failed': 'Could not start a session. Reload to try again.',
        stopped: '',
      }[reason];
      el.classList.add('visible');
    },
  });

  // The keys only ever move `dir`. Nothing is sent from here: a send is one
  // record per TICK, driven from the frame loop below, because the tick is the
  // unit the server applies input on and a keydown is not.
  const onKey = (e: KeyboardEvent, down: boolean) => {
    if (e.key === 'ArrowUp' || e.key === 'w') client.setDir(down ? -1 : 0);
    else if (e.key === 'ArrowDown' || e.key === 's') client.setDir(down ? 1 : 0);
    else return;
    e.preventDefault();
  };
  const keydown = (e: KeyboardEvent) => onKey(e, true);
  const keyup = (e: KeyboardEvent) => onKey(e, false);
  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);

  let raf = 0;
  const frame = (now: number) => {
    const { entities: view, own, scores, winner, serveIn, selfPid, selfSide } = client.frame(now);
    const sx = canvas.width / FIELD_W;
    const sy = canvas.height / FIELD_H;

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#fff';
    for (const [id, e] of view) {
      if (id === 'ball') {
        if (serveIn === 0) ctx.fillRect(e.x * sx - 3, e.y * sy - 3, 6, 6);
      } else if (id !== selfPid) {
        // REMOTE PADDLES COME FROM THE INTERPOLATOR, on the deliberate playback
        // delay, because nobody here is steering them and a delay is invisible
        // on an entity you do not control.
        ctx.fillStyle = '#888';
        ctx.fillRect(e.x * sx - 2, e.y * sy - 12 * sy, 4, 24 * sy);
      }
    }

    // OUR OWN PADDLE COMES FROM THE PREDICTION, plus whatever is left of the
    // last correction. No playback delay and no round trip in it: the paddle
    // is already where the key said, and the server agrees a few ticks later.
    // It is drawn brighter, which matters more than it sounds: with two
    // identical rectangles on screen players genuinely lose track of which one
    // is theirs.
    //
    // `own` is drawn from a playhead one tick behind the newest stamp, not at
    // the newest stamp: the prediction advances in whole ticks and the screen
    // does not, so drawn raw it would hold for three frames and jump a whole
    // tick of travel (4.5 units at 90 u/s), on the one entity the player is
    // steering. The playhead moves at real time through the stored poses, so
    // a counter re-anchor (a jump, not time passing) is caught up over a
    // second rather than drawn as a lurch. One tick of visual delay (50ms
    // here) on top of a prediction that has no round trip in it, which is not
    // felt where the step was seen.
    if (selfSide !== null) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(own.x * sx - 2, own.y * sy - 12 * sy, 4, 24 * sy);
    }

    ctx.fillStyle = '#fff';
    ctx.font = '16px monospace';
    ctx.fillText([...scores.values()].join('  :  '), canvas.width / 2 - 20, 24);
    if (winner) {
      ctx.fillText(winner === selfPid ? 'you win' : 'you lose', canvas.width / 2 - 36, canvas.height / 2);
    }

    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  void client.start();

  // Every example returns its teardown. A connection that outlives its canvas
  // keeps a socket open, keeps the room's player count wrong, and on a metered
  // deployment keeps billing.
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', keydown);
    window.removeEventListener('keyup', keyup);
    client.stop();
  };
}
