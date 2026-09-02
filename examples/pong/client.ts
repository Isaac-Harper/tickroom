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

import { RoomConnection, SnapshotInterpolator, type EntitySample } from '../../src/client/index.js';
import { FIELD_H, FIELD_W } from './sim.js';

// A plain interface, with no index signature and no relationship to any
// tickroom type. `decodeSnapshot`'s return type is what fixes the payload type
// for `onSnapshot` and for `interpolate.entities`, so this shape flows through
// the connection and comes back out intact. It used to have to extend
// `DecodedSnapshotLike` for the index signature, and `onSnapshot` still handed
// it back erased, which is why this file used to open its callback with the
// `as unknown as` double cast TypeScript's own error text calls a mistake.
interface PongSnapshot {
  tick: number;
  serverTime: number;
  ball: { x: number; y: number };
  serveIn: number;
  winner: string | null;
  paddles: { pid: string; side: 'left' | 'right'; y: number; score: number }[];
}

export function startPong(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d')!;
  const interp = new SnapshotInterpolator<string>();

  // Everything the interpolator does not smooth: scores, the winner, the serve
  // countdown. These are discrete state, not motion, so interpolating them would
  // be meaningless (there is no "half a point").
  let scores = new Map<string, number>();
  let winner: string | null = null;
  let serveIn = 0;
  let selfPid = '';

  const conn = new RoomConnection({
    // Must match `pong.tickHz` in sim.ts. Required rather than defaulted,
    // because a client silently running on the wrong basis skews the tick
    // counter, the server-tick estimate and the underrun threshold at once.
    tickHz: 20,

    mint: async () => {
      const res = await fetch('/api/session?room=pong', { method: 'POST' });
      // A mint has more than one failure shape and only one of them is JSON. A
      // rate limiter answering 429 with a text body makes res.json() throw, and
      // an unguarded throw here rejects the whole boot: black canvas, no
      // message, no retry. Check ok before parsing.
      if (!res.ok) throw new Error(`mint failed: ${res.status}`);
      const session = await res.json();
      selfPid = session.playerId;
      return session;
    },

    decodeSnapshot: (buf) => JSON.parse(new TextDecoder().decode(buf)) as PongSnapshot,

    // The connection owns the interpolator: it pushes every decoded snapshot in
    // with the right two timestamps and clears the buffer on every epoch
    // change. All this side has to say is which parts of a snapshot MOVE.
    interpolate: {
      into: interp,
      entities: (snap) => {
        // The ball and each paddle are entities; a score is not. Interpolating
        // discrete state is meaningless (there is no half a point), so it is
        // read in `onSnapshot` instead.
        const entities = new Map<string, EntitySample>();
        entities.set('ball', { x: snap.ball.x, y: snap.ball.y });
        for (const p of snap.paddles) {
          entities.set(p.pid, { x: p.side === 'left' ? 6 : FIELD_W - 6, y: p.y });
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
        'rate-limited': 'Already playing in another tab.',
        'version-skew': 'Update needed. Reload to continue.',
        'closed-by-server': 'Session ended.',
        stopped: '',
      }[reason];
      el.classList.add('visible');
    },
  });

  // Input is a HELD STATE, sent at a steady rate, not an event fired on keydown.
  // That distinction is the whole reason a dropped packet is harmless here: the
  // next tick re-asserts the same intent. An event-based scheme would need
  // reliable delivery for a keyup, and a lost keyup means a paddle that never
  // stops.
  let dir = 0;
  const onKey = (e: KeyboardEvent, down: boolean) => {
    if (e.key === 'ArrowUp' || e.key === 'w') dir = down ? -1 : 0;
    else if (e.key === 'ArrowDown' || e.key === 's') dir = down ? 1 : 0;
    else return;
    e.preventDefault();
  };
  const keydown = (e: KeyboardEvent) => onKey(e, true);
  const keyup = (e: KeyboardEvent) => onKey(e, false);
  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);

  // UNSTAMPED, deliberately: no `targetTick`, so the server applies each input
  // on arrival and the playout buffer never engages. Pong predicts nothing
  // locally, and a tick of skew on a paddle is invisible. Stamp it with
  // `conn.tick.value` (and check `conn.tick.initialized` first) the moment you
  // add local prediction, so the client and the server run the identical input
  // on the identical tick; see `examples/cursors/client.ts` for that shape.
  const sendTimer = setInterval(() => {
    conn.send(new TextEncoder().encode(JSON.stringify({ seq: Date.now(), data: { dir } })));
  }, 50);

  let raf = 0;
  const frame = (now: number) => {
    // THE ONE PER-FRAME CALL. It advances the tick counter inputs are stamped
    // against, polls the stall detector, and samples the interpolator, all from
    // one delta the connection measures for itself. This used to be three
    // separate calls and one of them was documented nowhere, so a client that
    // looked completely healthy could be stamping every input a second and a
    // half into the past.
    const { entities: view } = conn.frame(now);
    const sx = canvas.width / FIELD_W;
    const sy = canvas.height / FIELD_H;

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#fff';
    for (const [id, e] of view) {
      if (id === 'ball') {
        if (serveIn === 0) ctx.fillRect(e.x * sx - 3, e.y * sy - 3, 6, 6);
      } else {
        // Your own paddle is drawn brighter, which matters more than it sounds:
        // with two identical rectangles on screen, players genuinely lose track
        // of which one is theirs.
        ctx.fillStyle = id === selfPid ? '#fff' : '#888';
        ctx.fillRect(e.x * sx - 2, e.y * sy - 12 * sy, 4, 24 * sy);
      }
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

  void conn.start();

  // Every example returns its teardown. A connection that outlives its canvas
  // keeps a socket open, keeps the room's player count wrong, and on a metered
  // deployment keeps billing.
  return () => {
    cancelAnimationFrame(raf);
    clearInterval(sendTimer);
    window.removeEventListener('keydown', keydown);
    window.removeEventListener('keyup', keyup);
    conn.stop();
  };
}
