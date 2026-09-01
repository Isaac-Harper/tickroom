// The browser half of the pong example.
//
// Read this alongside sim.ts. Between them they are a complete multiplayer game:
// roughly 200 lines of simulation and 150 of client, and NONE of it deals with
// reconnects, clock skew, jitter, or a server that gets killed every few minutes.
// That is what the library is for.
//
// The one idea worth internalising: WE DO NOT DRAW WHAT THE SERVER SAID. We
// draw what the interpolator says, which is the server's state replayed on a
// deliberate delay so that jitter has somewhere to hide. See section 5 of
// docs/ARCHITECTURE.md for why that delay is the correct trade.

import { RoomConnection, SnapshotInterpolator } from '../../src/client/index.js';
import { FIELD_H, FIELD_W } from './sim.js';

// The index signature is required by `DecodedSnapshotLike`, and it is not
// bureaucracy: the connection guarantees only `tick` and `serverTime` (it needs
// those two to run the clock and the tick timeline) and treats everything else
// as opaque payload it must not assume the shape of. Declaring the extra fields
// alongside an index signature is how a caller says "these are mine, you carry
// them".
interface PongSnapshot {
  [k: string]: unknown;
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

    onSnapshot: (raw) => {
      const snap = raw as unknown as PongSnapshot;
      winner = snap.winner;
      serveIn = snap.serveIn;

      // Hand the interpolator only the things that MOVE, keyed stably. The ball
      // and each paddle are entities; the score is not.
      const entities = new Map<string, { x: number; y: number }>();
      entities.set('ball', { x: snap.ball.x, y: snap.ball.y });
      const next = new Map<string, number>();
      for (const p of snap.paddles) {
        entities.set(p.pid, { x: p.side === 'left' ? 6 : FIELD_W - 6, y: p.y });
        next.set(p.pid, p.score);
      }
      scores = next;

      interp.push({
        receivedAt: performance.now(),
        // The SERVER's clock stamp, not ours. The interpolator runs its playhead
        // on server time so that a client whose local clock drifts, or which
        // receives a burst of packets after a stall, still replays the world at
        // the rate the server produced it.
        serverTime: snap.serverTime,
        entities,
      });
    },

    onStatus: (status) => {
      // Clear the interpolator on every disconnect. `RoomConnection` holds no
      // reference to it, so nothing else can, and a buffer carried across an
      // epoch brackets the new socket's first frame against one from seconds
      // ago: a guaranteed snap on every reconnect, plus a clock offset
      // estimated over the old socket's path.
      if (status !== 'open') interp.clear();
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

  const sendTimer = setInterval(() => {
    conn.send(new TextEncoder().encode(JSON.stringify({ seq: Date.now(), data: { dir } })));
  }, 50);

  let last = performance.now();
  let raf = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    // Once per rendered frame. This is what drives the stall detector's edges,
    // and it is cheap: two timestamp comparisons and no allocation.
    conn.pollStall();

    // Pass the rAF timestamp explicitly rather than relying on the
    // interpolator's default: it happens to be the same clock
    // (performance.now()) as what onSnapshot() stamps receivedAt with above,
    // but naming it here keeps the two call sites visibly tied to one clock
    // instead of one of them reaching for a default and hoping it matches.
    const view = interp.sample(dt, now);
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
