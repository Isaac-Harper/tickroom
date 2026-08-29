// A complete 2D game as a tickroom RoomRuntime.
//
// This exists to prove one claim from the README: the architecture was extracted
// from a 3D game and has nothing 3D in it. Everything below is plain 2D numbers,
// and the transport layer neither knows nor cares.
//
// Read this before writing your own runtime. It is deliberately small enough to
// hold in your head and still demonstrates every part of the contract that
// matters: idempotent join, a pure tick, a serialize/deserialize pair that
// actually round-trips, a snapshot encoder, and events handed back to the host.

import type { ClientInput, RoomRuntime } from '../../src/core/index.js';

// Play field, in arbitrary units. Nothing here is metres; pick whatever suits
// your game and quantise the wire to match.
export const FIELD_W = 200;
export const FIELD_H = 120;
const PADDLE_H = 24;
const PADDLE_SPEED = 90; // units per second
const BALL_SPEED_START = 70;
const BALL_SPEED_MAX = 160;
const BALL_SPEEDUP = 1.04; // per paddle hit
const WIN_SCORE = 7;

export interface Paddle {
  pid: string;
  /** Which end this player defends. Assigned by arrival order. */
  side: 'left' | 'right';
  y: number;
  /** Held input, -1 up through +1 down. Persists across ticks: an input is a
   *  STATE the player holds, not an EVENT that fires once. That distinction is
   *  what makes a dropped packet harmless rather than a missed move. */
  dir: number;
  score: number;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface PongState {
  tick: number;
  paddles: Map<string, Paddle>;
  ball: Ball;
  /** Ticks remaining before the ball is served. 0 means live. */
  serveIn: number;
  /** Seeded PRNG state. NEVER Math.random: a checkpoint restore has to reproduce
   *  the same sequence, or a room resumes into a different game than the one
   *  players were watching. */
  seed: number;
  winner: string | null;
}

export type PongEvent =
  | { type: 'goal'; scorer: string; score: number }
  | { type: 'win'; pid: string };

// mulberry32. Small, fast, and seedable, which is the only property that matters:
// the seed rides the checkpoint, so a successor continues the same sequence.
function nextRandom(state: PongState): number {
  state.seed = (state.seed + 0x6d2b79f5) >>> 0;
  let t = state.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function serve(state: PongState, towards: -1 | 1): void {
  const angle = (nextRandom(state) - 0.5) * 0.8; // roughly +-23 degrees
  state.ball = {
    x: FIELD_W / 2,
    y: FIELD_H / 2,
    vx: Math.cos(angle) * BALL_SPEED_START * towards,
    vy: Math.sin(angle) * BALL_SPEED_START,
  };
  state.serveIn = 20; // one second at 20Hz, so players can reset
}

export const pongRuntime: RoomRuntime<PongState, PongEvent> = {
  tickHz: 20,

  create(): PongState {
    // A fixed seed, not a clock read. `create` must be deterministic: it runs on
    // every fresh room and on every restore that could not use its checkpoint,
    // and a clock read there is an untracked input to the simulation.
    const state: PongState = {
      tick: 0,
      paddles: new Map(),
      ball: { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0 },
      serveIn: 40,
      seed: 0x9e3779b9,
      winner: null,
    };
    serve(state, 1);
    return state;
  },

  currentTick: (s) => s.tick,
  playerCount: (s) => s.paddles.size,

  // IDEMPOTENT, and this is a contract requirement rather than politeness. The
  // relay republishes a join every second as a heartbeat (pub/sub is lossy, so
  // the first one can be dropped), and a reconnecting player rejoins under the
  // same id. A join that reset the paddle would teleport a live player once a
  // second.
  join(s, pid) {
    if (s.paddles.has(pid)) return;
    const leftTaken = [...s.paddles.values()].some((p) => p.side === 'left');
    s.paddles.set(pid, {
      pid,
      side: leftTaken ? 'right' : 'left',
      y: FIELD_H / 2,
      dir: 0,
      score: 0,
    });
  },

  leave(s, pid) {
    s.paddles.delete(pid);
  },

  applyInput(s, pid, input: ClientInput) {
    const p = s.paddles.get(pid);
    if (!p) return;
    // CLAMP EVERYTHING THAT CAME OFF THE WIRE. This value was chosen by a client
    // and a hostile one is free to send 1e9. The simulation is the last place
    // that can refuse it, and an unclamped speed multiplier is the whole game.
    const raw = (input.data as { dir?: unknown })?.dir;
    const dir = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    p.dir = Math.max(-1, Math.min(1, dir));
  },

  tick(s, dt): { events: PongEvent[] } {
    const events: PongEvent[] = [];
    s.tick += 1;
    if (s.winner) return { events };

    for (const p of s.paddles.values()) {
      p.y = Math.max(PADDLE_H / 2, Math.min(FIELD_H - PADDLE_H / 2, p.y + p.dir * PADDLE_SPEED * dt));
    }

    if (s.serveIn > 0) {
      s.serveIn -= 1;
      return { events };
    }

    const b = s.ball;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Walls. Reflect and re-seat rather than only flipping the sign: a ball that
    // overshot the wall this step and only had its velocity flipped can end the
    // tick still outside the field, flip again next tick, and buzz along the
    // boundary forever. Reflecting the POSITION as well as the velocity is what
    // makes the bounce terminate.
    if (b.y < 0) {
      b.y = -b.y;
      b.vy = Math.abs(b.vy);
    } else if (b.y > FIELD_H) {
      b.y = 2 * FIELD_H - b.y;
      b.vy = -Math.abs(b.vy);
    }

    for (const p of s.paddles.values()) {
      const paddleX = p.side === 'left' ? 6 : FIELD_W - 6;
      const approaching = p.side === 'left' ? b.vx < 0 : b.vx > 0;
      if (!approaching) continue;
      if (Math.abs(b.x - paddleX) > 3) continue;
      if (Math.abs(b.y - p.y) > PADDLE_H / 2) continue;
      // Deflect by where on the paddle it struck, which is the entire skill
      // element of pong and costs one line.
      const offset = (b.y - p.y) / (PADDLE_H / 2);
      const speed = Math.min(BALL_SPEED_MAX, Math.hypot(b.vx, b.vy) * BALL_SPEEDUP);
      const angle = offset * 0.9;
      b.vx = Math.cos(angle) * speed * (p.side === 'left' ? 1 : -1);
      b.vy = Math.sin(angle) * speed;
      b.x = paddleX + (p.side === 'left' ? 3 : -3);
    }

    if (b.x < 0 || b.x > FIELD_W) {
      const scoringSide = b.x < 0 ? 'right' : 'left';
      const scorer = [...s.paddles.values()].find((p) => p.side === scoringSide);
      if (scorer) {
        scorer.score += 1;
        // Events are emitted from the PURE simulation and acted on by the host
        // OFF the hot path. That split is the point: the runtime decides that a
        // goal happened, and the host decides whether a goal writes a database
        // row, without either learning about the other.
        events.push({ type: 'goal', scorer: scorer.pid, score: scorer.score });
        if (scorer.score >= WIN_SCORE) {
          s.winner = scorer.pid;
          events.push({ type: 'win', pid: scorer.pid });
        }
      }
      serve(s, b.x < 0 ? 1 : -1);
    }

    return { events };
  },

  // A Map does not survive JSON.stringify, which is the single most common way a
  // checkpoint silently loses half a room. Convert explicitly, both ways, and let
  // the round-trip test catch it if you forget.
  serialize(s) {
    return JSON.stringify({
      tick: s.tick,
      paddles: [...s.paddles.values()],
      ball: s.ball,
      serveIn: s.serveIn,
      seed: s.seed,
      winner: s.winner,
    });
  },

  // THROWS on anything it cannot restore, deliberately. A throw is handled: the
  // ticker logs it and starts the room fresh, which is the correct outcome for a
  // corrupt or stale checkpoint. Silently returning a half-restored room is not.
  deserialize(json) {
    const raw = JSON.parse(json) as {
      tick: number; paddles: Paddle[]; ball: Ball; serveIn: number; seed: number; winner: string | null;
    };
    if (typeof raw.tick !== 'number' || !Array.isArray(raw.paddles) || !raw.ball) {
      throw new Error('pong: unusable checkpoint');
    }
    return {
      tick: raw.tick,
      paddles: new Map(raw.paddles.map((p) => [p.pid, p])),
      ball: raw.ball,
      serveIn: raw.serveIn ?? 0,
      seed: raw.seed >>> 0,
      winner: raw.winner ?? null,
    };
  },

  // JSON here for readability. A real deployment uses the binary codec: this is
  // published once per tick and delivered once PER PLAYER, so it is the single
  // largest bandwidth line in the whole system. See src/codec/.
  encodeSnapshot(s, serverTime) {
    return JSON.stringify({
      tick: s.tick,
      serverTime,
      ball: { x: Math.round(s.ball.x * 10) / 10, y: Math.round(s.ball.y * 10) / 10 },
      serveIn: s.serveIn,
      winner: s.winner,
      paddles: [...s.paddles.values()].map((p) => ({
        pid: p.pid,
        side: p.side,
        y: Math.round(p.y * 10) / 10,
        score: p.score,
      })),
    });
  },

  isFull: (s) => s.paddles.size >= 2,
};
