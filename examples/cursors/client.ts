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
//      invisible and the playout buffer never has to engage. Contrast the
//      stamped shape in the comment on `sendCursor` below.
//   3. THE KEY TYPE IS `string`, because this room's snapshot identifies a
//      cursor by pid. A room on the default binary codec is keyed by NUMBER
//      instead (`CodecEntity.id`), which is why the interpolator has no default
//      key type: there is no answer that is right for both.

import { RoomConnection, SnapshotInterpolator, isRosterFrame, type EntitySample } from '../../src/client/index.js';

/** Exactly what `cursorsRuntime.encodeSnapshot` emits. A plain interface: no index signature and no library type to extend, because `decodeSnapshot`'s return type is what carries this shape through the connection and back out of `onSnapshot`. */
interface CursorsSnapshot {
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

const PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff',
];

export function startCursors(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d')!;

  // KEYED BY STRING, and the type argument is not optional. See note 3 above.
  const interp = new SnapshotInterpolator<string>();

  // Everything interpolation cannot smooth: a name, a colour index, an idle
  // flag. These are discrete, so blending them would be meaningless, and they
  // are read in `onSnapshot` rather than handed to the interpolator.
  const labels = new Map<string, { name: string; hue: number; idle: boolean }>();
  let selfPid = '';
  let roster: string[] = [];

  const conn = new RoomConnection({
    // MUST equal `cursorsRuntime.tickHz`. Required, so the mismatch that used
    // to be silent (a 10Hz room defaulting to a 20Hz basis) cannot compile.
    tickHz: 10,

    mint: async () => {
      const res = await fetch('/api/session?room=cursors', { method: 'POST' });
      if (!res.ok) throw new Error(`mint failed: ${res.status}`);
      const session = await res.json();
      // Re-read on EVERY mint rather than caching once at boot: a re-mint after
      // repeated pre-open failures can hand back a different identity, and a
      // stale pid here means this client starts drawing its own cursor as a
      // remote one, at interpolation delay, alongside the local one.
      selfPid = session.playerId;
      return session;
    },

    decodeSnapshot: (buf) => JSON.parse(new TextDecoder().decode(buf)) as CursorsSnapshot,

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
        'rate-limited': 'Already connected in another tab.',
        'version-skew': 'Update needed. Reload to continue.',
        'closed-by-server': 'Session ended.',
        stopped: '',
      }[reason];
      el.classList.add('visible');
    },
  });

  // ---- input ---------------------------------------------------------------

  // Normalised against the CANVAS, not the window, so the coordinate a client
  // sends means the same thing on every viewport. The simulation clamps to
  // 0..1 as well, because a value off the wire is a hostile client's choice.
  const self = { x: 0.5, y: 0.5, down: false, seen: false };
  const onMove = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    self.x = (ev.clientX - rect.left) / rect.width;
    self.y = (ev.clientY - rect.top) / rect.height;
    self.seen = true;
  };
  const onDown = () => void (self.down = true);
  const onUp = () => void (self.down = false);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('blur', onUp);

  // INPUT IS HELD STATE SENT AT A STEADY RATE, not an event fired per pointer
  // move. A pointer can fire 120 times a second and the room ticks 10 times, so
  // sending per event wastes nine packets in ten; more importantly, a dropped
  // packet then costs nothing, because the next tick re-asserts the same
  // position rather than a lost delta.
  //
  // `targetTick: 0` leaves this UNSTAMPED and the server applies it on arrival.
  // To stamp instead (which you want the moment the client predicts anything
  // locally, so both ends run the identical input on the identical tick):
  //
  //   if (!conn.tick.initialized) return;
  //   const targetTick = conn.tick.value;
  //
  // `conn.tick` is advanced by `conn.frame()`, so there is nothing extra to
  // drive; check `initialized` because the counter is meaningless before the
  // first snapshot anchors it.
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
  const sendTimer = setInterval(sendCursor, 100); // 10Hz, matching tickHz

  // ---- frame loop ----------------------------------------------------------

  let raf = 0;
  const frame = (now: number) => {
    // THE ONE PER-FRAME CALL: it advances the tick counter, polls the stall
    // detector, and samples the interpolator from one delta it measures itself.
    const { entities } = conn.frame(now);

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

  void conn.start();

  // Every example returns its teardown. A connection that outlives its canvas
  // holds a socket open, keeps the room's player count wrong, and on a metered
  // deployment keeps billing.
  return () => {
    cancelAnimationFrame(raf);
    clearInterval(sendTimer);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('blur', onUp);
    conn.stop();
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
