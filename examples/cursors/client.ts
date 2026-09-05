// The browser half of the cursors example.
//
// Read this alongside sim.ts. Between them they are a complete multiplayer
// presence layer, and the client half is mostly drawing code: the transport is
// one options bag and one call per frame.
//
// This example exists because cursors is the use case tickroom advertises first
// and the one that had no browser half at all, so the only shipped client was a
// game and every presence-layer question (how do I send, what do I stamp, what
// key type is my snapshot) had to be answered by reading declarations.
//
// THREE THINGS DIFFER FROM PONG, and all three are configuration rather than
// different transport code:
//
//   1. `tickHz: 10`, matching `cursorsRuntime.tickHz`. Not a default, not a
//      guess: the client's whole tick basis rides on it.
//   2. INPUTS ARE UNSTAMPED. `targetTick` stays at 0 and the server applies each
//      input on arrival. Nothing is predicted locally, so a tick of skew is
//      invisible and the playout buffer never has to engage. The opposite call,
//      made for real rather than sketched in a comment, is
//      `examples/pong/client.ts`: it is the shipped reference for the stamped
//      path, and it stamps because it predicts. Read it when you reach the
//      point of predicting anything locally.
//   3. THE KEY TYPE IS `string`, because this room's snapshot identifies a
//      cursor by pid. A room on the default binary codec is keyed by NUMBER
//      instead (`CodecEntity.id`), which is why the interpolator has no default
//      key type: there is no answer that is right for both.
//
// THE FILE IS IN TWO HALVES, AND THE SPLIT IS THE DOM, exactly as pong's is.
// `createCursorsClient` below is all of the netcode and none of the browser:
// the connection, the decode, the interpolator, the held pointer state and the
// 10Hz send loop that re-asserts it. `startCursors` is the canvas, the pointer
// events and the animation frame on top of it, and it is thirty lines of
// drawing. The half worth copying is the first one, and keeping it free of
// `document` is also what lets `tests/example-cursors.redis.test.ts` drive THIS
// wiring through a real socket instead of a retyped copy of it, which is the
// only way the shipped example can be the thing CI checks.

import {
  RoomConnection,
  SnapshotInterpolator,
  isRosterFrame,
  type EntitySample,
  type InterpolatedEntity,
  type SessionInfo,
  type TerminalReason,
  type WebSocketConstructor,
} from '../../src/client/index.js';

/** Exactly what `cursorsRuntime.encodeSnapshot` emits. A plain interface: no index signature and no library type to extend, because `decodeSnapshot`'s return type is what carries this shape through the connection and back out of `onSnapshot`. */
export interface CursorsSnapshot {
  tick: number;
  serverTime: number;
  cursors: { pid: string; x: number; y: number; n: string; h: number; d: boolean; idle: boolean }[];
}

/** What `applyInput` reads. Normalised 0..1, so two clients with different viewport sizes point at the same thing. */
interface CursorInput {
  seq: number;
  targetTick: number;
  data: { x: number; y: number; down: boolean };
}

/** Per-cursor state the interpolator cannot smooth, from the newest snapshot. Discrete, so blending it would be meaningless. */
export interface CursorLabel {
  name: string;
  hue: number;
  idle: boolean;
}

/** Our own pointer, held rather than eventful: the send loop re-asserts it at the room's rate. `seen` is false until the pointer has been somewhere, which is also "there is nothing of ours to draw yet". */
export interface PointerState {
  x: number;
  y: number;
  down: boolean;
  seen: boolean;
}

const PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff',
];

/** MUST equal `cursorsRuntime.tickHz`. Required on the connection rather than defaulted, so the mismatch that used to be silent (a 10Hz room defaulting to a 20Hz basis) cannot compile. */
const TICK_HZ = 10;

/** The send cadence, matching `TICK_HZ`. See the send loop for why input is held state sent at a steady rate rather than an event per pointer move. */
const SEND_MS = 100;

/**
 * Everything the netcode below cannot decide for itself: where a session comes
 * from, where the socket lives, which WebSocket to open, how a snapshot frame
 * turns into a `CursorsSnapshot`, and what to tell the player about the two
 * states that are not the room. All of it is optional except `mint`, and every
 * default is the browser tab's answer.
 */
export interface CursorsClientOptions {
  /** Obtain a session. `startCursors`'s own is the `POST /api/session` below; a headless client mints or fetches its own. */
  mint(): Promise<SessionInfo>;
  /** Build the socket URL. Omitted, `RoomConnection`'s default uses `location`, which is right in a tab and absent anywhere else. */
  socketUrl?: ((session: SessionInfo) => string) | undefined;
  /** Omitted, the global `WebSocket`. */
  WebSocketImpl?: WebSocketConstructor | undefined;
  /** Turn one snapshot frame into a `CursorsSnapshot`. Defaults to the JSON `sim.ts`'s `encodeSnapshot` publishes, which is the whole of this example's wire; pass your own when you put a codec on it, exactly as `examples/pong/codec.ts` does. */
  decode?: ((buf: ArrayBuffer) => CursorsSnapshot) | undefined;
  onStallChange?: ((stalled: boolean) => void) | undefined;
  onTerminal?: ((reason: TerminalReason) => void) | undefined;
}

/** What one frame has to draw. Returned by `frame()` rather than read off the client, because every field of it is only meaningful for the frame it came from. */
export interface CursorsFrame {
  /** Every OTHER cursor, interpolated. Ours is deliberately not in here; see `interpolate.entities`. */
  entities: Map<string, InterpolatedEntity>;
  /** Names, colours and idle flags from the newest snapshot, keyed by pid. */
  labels: Map<string, CursorLabel>;
  /** Who the relay says is here, from the roster control frame. */
  roster: string[];
  /** Empty until `mint()` has answered. */
  selfPid: string;
  /** OUR pointer, live and at zero latency: the one thing drawn from local state rather than from the buffer. */
  self: Readonly<PointerState>;
}

export interface CursorsClient {
  /** The connection itself, for `stats()` and for a host that wants to send something of its own. */
  readonly conn: RoomConnection<CursorsSnapshot, string>;
  /** Held pointer position, normalised 0..1. Nothing is sent from here; a send is one record per SEND_MS, from the loop inside. */
  setPointer(x: number, y: number): void;
  /** Held button state, same deal. */
  setDown(down: boolean): void;
  /** THE ONE PER-FRAME CALL. Advances the tick counter, polls the stall detector, samples the interpolator, and returns everything a frame draws. */
  frame(now: number): CursorsFrame;
  start(): Promise<void>;
  stop(): void;
}

/**
 * The whole of the cursors client except the drawing: no canvas, no pointer
 * events, no `requestAnimationFrame`, no `document`. `startCursors` is this
 * plus thirty lines of 2D context.
 */
export function createCursorsClient(opts: CursorsClientOptions): CursorsClient {
  const decode =
    opts.decode ??
    ((buf: ArrayBuffer): CursorsSnapshot => JSON.parse(new TextDecoder().decode(buf)) as CursorsSnapshot);

  // KEYED BY STRING, and the type argument is not optional. See note 3 above.
  const interp = new SnapshotInterpolator<string>();

  // Everything interpolation cannot smooth: a name, a colour index, an idle
  // flag. These are discrete, so blending them would be meaningless, and they
  // are read in `onSnapshot` rather than handed to the interpolator.
  const labels = new Map<string, CursorLabel>();
  let selfPid = '';
  let roster: string[] = [];

  // Normalised against the CANVAS, not the window, so the coordinate a client
  // sends means the same thing on every viewport. The simulation clamps to
  // 0..1 as well, because a value off the wire is a hostile client's choice.
  const self: PointerState = { x: 0.5, y: 0.5, down: false, seen: false };

  // The type arguments are STATED rather than inferred from `decodeSnapshot`,
  // for the same reason pong's are: inference produces a structurally wider
  // shape, which is fine while nothing names the type and is not assignable
  // the moment `CursorsClient` does.
  const conn = new RoomConnection<CursorsSnapshot, string>({
    // MUST equal `cursorsRuntime.tickHz`. Required, so the mismatch that used
    // to be silent (a 10Hz room defaulting to a 20Hz basis) cannot compile.
    tickHz: TICK_HZ,

    mint: async () => {
      const session = await opts.mint();
      // Re-read on EVERY mint rather than caching once at boot: a re-mint after
      // repeated pre-open failures can hand back a different identity, and a
      // stale pid here means this client starts drawing its own cursor as a
      // remote one, at interpolation delay, alongside the local one.
      selfPid = session.playerId;
      return session;
    },

    socketUrl: opts.socketUrl,
    WebSocketImpl: opts.WebSocketImpl,

    decodeSnapshot: (buf) => decode(buf),

    // The connection owns the interpolator: it pushes every snapshot in with
    // the server's stamp as the playback axis and its own arrival stamp beside
    // it, and it clears the buffer on every epoch change. This side only says
    // which part of a snapshot MOVES.
    interpolate: {
      into: interp,
      entities: (snap) => {
        const entities = new Map<string, EntitySample>();
        for (const c of snap.cursors) {
          // Skip our own cursor. It is drawn locally at zero latency from the
          // live pointer, so routing it through the buffer as well would render
          // a second copy of it a couple of hundred milliseconds behind.
          if (c.pid === selfPid) continue;
          entities.set(c.pid, { x: c.x, y: c.y });
        }
        return entities;
      },
    },

    // `snap` arrives as `CursorsSnapshot`, inferred from `decodeSnapshot`.
    onSnapshot: (snap) => {
      labels.clear();
      for (const c of snap.cursors) labels.set(c.pid, { name: c.n, hue: c.h, idle: c.idle });
    },

    // The roster control frame, narrowed by the library's own guard. Its shape
    // used to be documented only in a server declaration a browser consumer has
    // no reason to open, and `onText` is `unknown`, so narrowing to the WRONG
    // shape typechecked and yielded an empty roster forever.
    onText: (msg) => {
      if (!isRosterFrame(msg)) return;
      roster = Object.keys(msg.map);
    },

    onStallChange: opts.onStallChange,
    onTerminal: opts.onTerminal,
  });

  // ---- input ----------------------------------------------------------------
  //
  // INPUT IS HELD STATE SENT AT A STEADY RATE, not an event fired per pointer
  // move. A pointer can fire 120 times a second and the room ticks 10 times, so
  // sending per event wastes nine packets in ten; more importantly, a dropped
  // packet then costs nothing, because the next tick re-asserts the same
  // position rather than a lost delta.
  //
  // `targetTick: 0` leaves this UNSTAMPED and the server applies it on arrival.
  // To stamp instead, which you want the moment the client predicts anything
  // locally, so both ends run the identical input on the identical tick:
  //
  //   if (!conn.tick.initialized) return;
  //   const targetTick = conn.tick.value;
  //
  // `conn.tick` is advanced by `conn.frame()`, so there is nothing extra to
  // drive; check `initialized` because the counter is meaningless before the
  // first snapshot anchors it.
  //
  // THOSE TWO LINES ARE THE SMALL HALF, AND THIS COMMENT IS NOT THE PLACE TO
  // LEARN THE OTHER ONE. `examples/pong/client.ts` is the shipped stamped
  // reference and it is worth reading whole rather than reconstructing from
  // here: it keeps a ring of the last few records and re-sends them in every
  // packet so a dropped one costs nothing, it replays its own unconfirmed
  // records against the simulation's OWN exported step function so both ends
  // land on the same value, it bleeds the residual disagreement off through an
  // `ErrorOffset` instead of teleporting, and it moves its own dedupe
  // high-water mark by `onTickReanchor`'s delta so a backward re-anchor does
  // not silence it. `pong/sim.test.ts` asserts the two ends agree tick for
  // tick, which is the claim none of this can be trusted without.
  let seq = 0;
  const sendCursor = () => {
    const input: CursorInput = {
      seq: seq++,
      targetTick: 0,
      data: { x: self.x, y: self.y, down: self.down },
    };
    // One JSON-encoded `ClientInput` per message, which is what the relay's
    // `decodeInput` in the README's step 2 parses. `send()` is a no-op while
    // the socket is not open, so a send racing a reconnect costs nothing.
    conn.send(new TextEncoder().encode(JSON.stringify(input)));
  };
  const sendTimer = setInterval(sendCursor, SEND_MS); // 10Hz, matching tickHz

  return {
    conn,
    setPointer: (x, y) => {
      self.x = x;
      self.y = y;
      self.seen = true;
    },
    setDown: (down) => {
      self.down = down;
    },
    frame: (now) => {
      // THE ONE PER-FRAME CALL: it advances the tick counter, polls the stall
      // detector, and samples the interpolator from one delta it measures itself.
      const { entities } = conn.frame(now);
      return { entities, labels, roster, selfPid, self };
    },
    start: () => conn.start(),
    stop: () => {
      clearInterval(sendTimer);
      conn.stop();
    },
  };
}

/**
 * The browser shell: a canvas, a pointer, and an animation frame over
 * `createCursorsClient`. Everything below this line is drawing.
 */
export function startCursors(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d')!;

  const client = createCursorsClient({
    mint: async () => {
      const res = await fetch('/api/session?room=cursors', { method: 'POST' });
      if (!res.ok) throw new Error(`mint failed: ${res.status}`);
      return (await res.json()) as SessionInfo;
    },

    onStallChange: (stalled) => {
      // NON-BLOCKING. A stall usually self-heals (a ticker handoff, a brief
      // network gap) and the player keeps a live pointer the whole time.
      document.getElementById('stall')?.classList.toggle('visible', stalled);
    },

    onTerminal: (reason) => {
      const el = document.getElementById('terminal');
      if (!el) return;
      el.textContent = {
        capacity: 'This room is full.',
        'conn-limit': 'Already connected in another tab.',
        'version-skew': 'Update needed. Reload to continue.',
        'closed-by-server': 'Session ended.',
        'connect-error': 'Could not reach the room. Reload to try again.',
        'mint-failed': 'Could not start a session. Reload to try again.',
        stopped: '',
      }[reason];
      el.classList.add('visible');
    },
  });

  // The pointer only ever moves the held state. Nothing is sent from here: a
  // send is one record per SEND_MS, driven from the client's own loop, because
  // the tick is the unit the server applies input on and a pointer event is not.
  const onMove = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    client.setPointer((ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height);
  };
  const onDown = () => client.setDown(true);
  const onUp = () => client.setDown(false);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('blur', onUp);

  let raf = 0;
  const frame = (now: number) => {
    const { entities, labels, roster, self } = client.frame(now);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const [pid, e] of entities) {
      const label = labels.get(pid);
      ctx.globalAlpha = label?.idle ? 0.35 : 1;
      drawCursor(ctx, e.x * canvas.width, e.y * canvas.height, PALETTE[(label?.hue ?? 0) % PALETTE.length]!, label?.name ?? '');
    }
    ctx.globalAlpha = 1;

    // Our own cursor, drawn from the live pointer rather than from the buffer.
    if (self.seen) {
      drawCursor(ctx, self.x * canvas.width, self.y * canvas.height, '#fff', 'you', self.down);
    }

    ctx.fillStyle = '#888';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`${roster.length} here`, 8, 18);

    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  void client.start();

  // Every example returns its teardown. A connection that outlives its canvas
  // holds a socket open, keeps the room's player count wrong, and on a metered
  // deployment keeps billing.
  return () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('blur', onUp);
    client.stop();
  };
}

function drawCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  colour: string,
  name: string,
  down = false,
): void {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + 16);
  ctx.lineTo(x + 4, y + 12);
  ctx.lineTo(x + 10, y + 11);
  ctx.closePath();
  ctx.fill();
  if (down) {
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (name) {
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(name, x + 12, y + 20);
  }
}
