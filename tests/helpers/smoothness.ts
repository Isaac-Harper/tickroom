// The end-to-end smoothness harness, kept as a permanent gate rather than a
// one-off measurement. It drives the REAL `RoomConnection` (plus the
// `SnapshotInterpolator` it owns) headlessly at 60Hz against a real `ws`
// server, `admitSocket`, an in-process `runTicker` and a real Redis, with an
// emulated one-way delay in both directions, and then measures WHAT A CLIENT
// RENDERED: rendered speed, backward steps, zero-motion frames, snapshot gaps,
// tick deviation, and the server's own `RoomStats` totals.
//
// WHY THIS IS A HARNESS AND NOT A UNIT TEST. The owner's requirement is
// "clients operate smoothly while the server is running; the server is
// authoritative; clients may be a little out of sync but must not stutter".
// Every part of that is a property of the WHOLE chain over TIME: the playout
// buffer, the interpolator's clock offset and delay, the tick counter's
// re-anchor, the ticker's grid, and a handoff between two ticker lifetimes all
// have to agree. Nothing smaller than a real run measures it.
//
// The measured entity is a BOT: it moves at a constant `SPEED` on the server
// and nothing the client does can perturb it, so any variation a client
// renders is netcode, never simulation. A stamped-input sender runs alongside
// it (one record per tick, a six-record redundancy window) purely so the
// server's playout buffer is exercised the way a real host exercises it.
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientInput, RoomRuntime, RoomStats, RedisLike } from '../../src/core/index.js';
import { roomKeys } from '../../src/core/index.js';
import { admitSocket, runTicker, type RelaySocket } from '../../src/server/index.js';
import {
  RoomConnection,
  SnapshotInterpolator,
  type ConnectionStats,
  type EntitySample,
  type NetStatus,
  type WebSocketConstructor,
  type WebSocketLike,
} from '../../src/client/index.js';
import { TEST_REDIS_URL, waitFor } from './env.js';

/** Units per second the bot travels. Constant on the server, so every deviation a client renders belongs to the network path. */
export const SPEED = 100;
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
/** The render loop, at a real display's cadence rather than the sim's. */
const FRAME_MS = 16;

// ---------------------------------------------------------------- runtime

interface BotState {
  tick: number;
  players: string[];
  bot: { x: number; y: number };
  pos: Record<string, { x: number; y: number }>;
  health: Record<string, number>;
}

export interface Snap {
  tick: number;
  serverTime: number;
  /** Which ticker instance published this snapshot, so a handoff is visible from the client. */
  inst: string;
  entities: Record<string, { x: number; y: number }>;
  inputLead?: number;
  leads: Record<string, number>;
}

function createBotRuntime(inst: string, onEncode: (tick: number, serverTimeMs: number) => void): RoomRuntime<BotState, never> {
  return {
    tickHz: TICK_HZ,
    create: () => ({ tick: 0, players: [], bot: { x: 0, y: 0 }, pos: {}, health: {} }),
    tick: (s, dt) => {
      s.tick += 1;
      s.bot.x += SPEED * dt;
    },
    currentTick: (s) => s.tick,
    playerCount: (s) => s.players.length,
    join: (s, pid) => {
      if (!s.players.includes(pid)) {
        s.players.push(pid);
        s.pos[pid] ??= { x: 0, y: 0 };
      }
    },
    leave: (s, pid) => {
      s.players = s.players.filter((p) => p !== pid);
    },
    applyInput: (s, pid, input: ClientInput) => {
      const d = input.data as { dx?: number } | null;
      const p = s.pos[pid];
      if (p && d && typeof d.dx === 'number') p.x += d.dx;
    },
    usesPlayout: () => true,
    onBufferHealth: (s, pid, h) => {
      s.health[pid] = h;
    },
    serialize: (s) => JSON.stringify(s),
    deserialize: (json) => {
      const p = JSON.parse(json) as BotState;
      return { tick: p.tick, players: p.players ?? [], bot: p.bot, pos: p.pos ?? {}, health: p.health ?? {} };
    },
    encodeSnapshot: (s, serverTimeMs) => {
      onEncode(s.tick, serverTimeMs);
      const entities: Record<string, { x: number; y: number }> = { bot: { x: s.bot.x, y: s.bot.y } };
      for (const pid of s.players) entities[pid] = s.pos[pid] ?? { x: 0, y: 0 };
      return JSON.stringify({ tick: s.tick, serverTime: serverTimeMs, inst, entities, leads: s.health });
    },
  };
}

// ---------------------------------------------------------------- delayed socket

/** One client's socket implementation, plus the handle a scenario needs to break it. */
interface DelayedSocketFactory {
  Ctor: WebSocketConstructor;
  /**
   * Kills the newest OPEN socket the way a lost network kills it: an abrupt
   * 1006 from the CLIENT side, with no close handshake, so the connection runs
   * its ordinary reconnect ladder rather than any test-only path. Returns
   * false when there was nothing open to kill, which a scenario asserts on
   * rather than sleeping and hoping.
   */
  dropFromClient(): boolean;
}

/**
 * A `WebSocketLike` that holds every frame for a one-way delay before it is
 * delivered, in BOTH directions, so a localhost run measures what a real path
 * measures. The delay is monotonic per direction (`lastDown`/`lastUp`): jitter
 * may not reorder frames on a link that does not reorder them, and a client
 * that never sees reordering here is the only way a reordering assertion
 * elsewhere means anything.
 *
 * The inner socket is the `ws` package's rather than the global `WebSocket`,
 * which is what the rest of this suite uses and what keeps the file working on
 * a Node that ships the global behind a flag.
 *
 * ONE FACTORY PER CLIENT: `live` is how `dropFromClient` finds the socket the
 * connection is currently using (there are two of them during a warm swap), so
 * a factory shared between clients would let one client's outage land on
 * another client's socket.
 */
function makeDelayedSocket(owdMs: number, jitterMs: number): DelayedSocketFactory {
  const live = new Set<DelayedSocket>();

  class DelayedSocket implements WebSocketLike {
    private inner: WebSocket;
    onopen: ((ev: unknown) => void) | null = null;
    onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    private lastDown = 0;
    private lastUp = 0;

    constructor(url: string) {
      this.inner = new WebSocket(url);
      this.inner.binaryType = 'arraybuffer';
      live.add(this);
      this.inner.onopen = (ev) => this.later('down', () => this.onopen?.(ev));
      this.inner.onmessage = (ev) => this.later('down', () => this.onmessage?.({ data: ev.data }));
      this.inner.onerror = (ev) => this.onerror?.(ev);
      this.inner.onclose = (ev) => {
        live.delete(this);
        this.later('down', () => this.onclose?.({ code: ev.code, reason: ev.reason }));
      };
    }

    get readyState(): number {
      return this.inner.readyState;
    }
    get binaryType(): string {
      return this.inner.binaryType;
    }
    set binaryType(v: string) {
      this.inner.binaryType = v as 'nodebuffer' | 'arraybuffer' | 'fragments';
    }

    send(data: unknown): void {
      this.later('up', () => {
        if (this.inner.readyState === 1) this.inner.send(data as string);
      });
    }

    close(code?: number, reason?: string): void {
      this.inner.close(code, reason);
    }

    /** `terminate`, not `close`: no handshake, code 1006, which is the shape of a dropped link rather than of a decision. */
    killFromClient(): void {
      live.delete(this);
      this.inner.terminate();
    }

    private later(dir: 'up' | 'down', fn: () => void): void {
      const now = performance.now();
      const d = owdMs + (Math.random() * 2 - 1) * jitterMs;
      const at = Math.max(now + d, dir === 'down' ? this.lastDown : this.lastUp);
      if (dir === 'down') this.lastDown = at;
      else this.lastUp = at;
      setTimeout(fn, Math.max(0, at - now));
    }
  }

  return {
    Ctor: DelayedSocket,
    dropFromClient: () => {
      const open = [...live].filter((s) => s.readyState === 1);
      const victim = open[open.length - 1];
      if (!victim) return false;
      victim.killFromClient();
      return true;
    },
  };
}

// ---------------------------------------------------------------- records

interface FrameRec {
  t: number;
  x: number | null;
  extrap: boolean | null;
  stalled: boolean;
  tick: number;
  anchored: boolean;
  desired: number;
  epochSnaps: number;
  /** Every entity id this frame drew, which is how a client's view of the ROSTER is measured rather than just its view of the bot. */
  ids: string[];
  /** This client's OWN entity, the one its stamped inputs move. Null when the frame did not draw it. */
  ownX: number | null;
}

interface SnapRec {
  t: number;
  tick: number;
  serverTime: number;
  inst: string;
}

interface StatsRec {
  inst: string;
  at: number;
  s: RoomStats;
}

interface DepartureRec {
  inst: string;
  tick: number;
  serverTime: number;
}

/** Everything one running client owns: what it recorded, and the three levers a scenario pulls on it. */
interface ClientRig {
  pid: string;
  conn: RoomConnection<Snap, string>;
  interp: SnapshotInterpolator<string>;
  frames: FrameRec[];
  snaps: SnapRec[];
  statuses: NetStatus[];
  reanchors: Array<{ atMs: number; delta: number }>;
  freezeRender(): void;
  resumeRender(): void;
  dropFromClient(): boolean;
  stopRender(): void;
}

// ---------------------------------------------------------------- analysis shapes

export interface RenderedStats {
  peak: number;
  min: number;
  mean: number;
  sd: number;
  /** Frames whose rendered speed sat outside +-10% of `SPEED`. */
  outside10pct: number;
  /** Frames where the bot moved BACKWARD. The stutter the owner's requirement forbids outright. */
  backward: number;
  worstBackward: number;
  /** Frames where the bot did not move at all while it should have been moving. The other half of a stutter. */
  zeroMotion: number;
  extrapFrames: number;
  missingBot: number;
  holdFrames: number;
  blankFrames: number;
  /** Frames measured at all: the denominator every count above shares. */
  measured: number;
  /**
   * The step ACROSS an epoch boundary: the last frame the client held (this
   * epoch had no snapshot yet) to the first frame it drew from the new
   * epoch's own data. Recorded separately because the frame-to-frame pass
   * above deliberately skips any pair touching a hold frame, which would
   * otherwise hide the one step the resume glide exists to smooth.
   */
  resumeSteps: Array<{ atMs: number; dx: number; speed: number }>;
}

/** A change of publishing ticker instance, as the CLIENT saw it. */
export interface ClientHandoff {
  atMs: number;
  from: string;
  to: string;
  gapMs: number;
  tickFrom: number;
  tickTo: number;
}

/** The same handoff as the SERVER performed it, taken from `encodeSnapshot` rather than from what survived the wire. */
export interface ServerHandoff {
  from: string;
  to: string;
  tickFrom: number;
  tickTo: number;
  serverTimeFrom: number;
  serverTimeTo: number;
  /** `serverTimeTo - serverTimeFrom`: the grid's own continuity across two ticker lifetimes. */
  gridGapMs: number;
}

export interface SmoothnessAnalysis {
  frames: number;
  snapshots: number;
  rendered: RenderedStats;
  /** What the client saw of the ROOM rather than of the bot: the roster, as it reached this one socket. */
  entities: {
    /** Every entity id drawn at least once in the steady window. */
    ids: string[];
    /** The ids drawn in EVERY frame of the steady window: an entity that flickered is in `ids` and not here. */
    alwaysPresent: string[];
    /**
     * How far this client's OWN entity travelled across the steady window.
     * Its only mover is this client's own stamped inputs, so it is the
     * per-sender half of fairness: a sender the server starved out in favour
     * of a noisier one reads here and nowhere else.
     */
    ownAdvance: number;
  };
  snapshotGap: { maxMs: number; over150: number[]; handoffs: ClientHandoff[] };
  tick: { maxDev: number; reanchors: Array<{ atMs: number; delta: number }> };
  server: {
    totals: {
      lateInputs: number;
      starves: number;
      hostErrors: number;
      publishSkipped: number;
      publishFails: number;
      renewFails: number;
      dropped: number;
      badEnvelopes: number;
    };
    lateAfterSteady: number;
    starvesAfterSteady: number;
    maxInterDepartureMs: number;
    handoffs: ServerHandoff[];
    instances: string[];
  };
  client: ConnectionStats & { stalledFrames: number };
}

/** One client's own view of the run. `clients[0]` is also the result's top-level `analysis`/`statuses`. */
export interface SmoothnessClientResult {
  pid: string;
  analysis: SmoothnessAnalysis;
  statuses: NetStatus[];
}

export interface SmoothnessResult {
  analysis: SmoothnessAnalysis;
  /** Every `onStatus` value seen, in order, up to the moment the run ended (so the teardown's own `idle` is not in it). */
  statuses: NetStatus[];
  /** Every client the run drove, in start order. A single-client run has exactly one entry, equal to the two fields above. */
  clients: SmoothnessClientResult[];
  /** One line per interesting event, printed by the tests only on a failure. */
  events: string[];
  /** Raw stats flushes, so a test can ask about a specific window rather than a total. */
  statsRecs: StatsRec[];
  /** `performance.now()` at the moment the harness started. Every `at`/`atMs` above is relative to the same clock. */
  t0: number;
  /**
   * `performance.now()` at the moment the run window closed, BEFORE the
   * teardown. `statsRecs` keeps filling until the last ticker exits, so a test
   * asking what the room looked like while it was being played has to cut the
   * flushes here rather than take the last one.
   */
  endedAt: number;
}

/** One client, as a scenario's own actions reach it mid-run. */
export interface SmoothnessClientControl {
  pid: string;
  conn: RoomConnection<Snap, string>;
  interp: SnapshotInterpolator<string>;
  /** Stops calling `frame()`, exactly as a backgrounded tab does. The socket stays open and snapshots keep arriving. */
  freezeRender(): void;
  resumeRender(): void;
  /** Kills this client's live socket from the CLIENT side, 1006 and no handshake. False if it had none open. */
  dropFromClient(): boolean;
}

/** What a scenario's own actions can reach mid-run. The bare `conn`/`interp`/`freeze` members are `clients[0]`, which is every scenario that drives one client. */
export interface SmoothnessControl extends SmoothnessClientControl {
  clients: SmoothnessClientControl[];
  log(line: string): void;
  /** `performance.now()`, the clock every record in the result is stamped on. */
  now(): number;
}

export interface SmoothnessOptions {
  namespace: string;
  /** One-way delay in ms, applied in both directions. Jitter is 10% of it. */
  owdMs: number;
  /** How long to run after the client starts, before the result is analysed. A scenario's own `during` may run longer. */
  runMs: number;
  /** The ticker's duration cap. Below `runMs` it produces a planned standby handoff (or several) inside the run. */
  maxRunMs: number;
  /** Passed to a successor spawned with `standby: true`. */
  standbyMs?: number;
  /** The relay's own lifetime cap, which the client answers with a warm swap. */
  relayLifetimeMs?: number;
  /** Ignore everything before `firstSnapshotAt + this` when analysing: a room's first second is a cold start, not steady state. */
  steadyLeadMs?: number;
  /** How many honest stamped clients share the room. Default 1. Each gets its own socket, its own sender and its own analysis. */
  clients?: number;
  during?(ctl: SmoothnessControl): Promise<void>;
}

// ---------------------------------------------------------------- the run

/**
 * Runs one scenario end to end and returns what the client rendered.
 *
 * Everything it creates it also tears down: the ws server, the client, and
 * every ticker it started. The tickers are AWAITED rather than abandoned,
 * exactly as `e2e.redis.test.ts` awaits its own, because a ticker that
 * outlives its test keeps a subscriber and a lease and lands in whatever runs
 * next. `emptyGraceMs` is what paces that exit: the relay publishes a leave
 * when the socket closes, the room reads empty, and the loop exits.
 */
export async function runSmoothness(opts: SmoothnessOptions): Promise<SmoothnessResult> {
  const { namespace, owdMs, runMs, maxRunMs, standbyMs = 0, relayLifetimeMs, steadyLeadMs = 3000, clients = 1, during } = opts;
  const jitterMs = Math.max(1, Math.round(owdMs * 0.1));
  const roomId = 'room1';
  const keys = roomKeys(roomId, namespace);
  const redis = new Redis(TEST_REDIS_URL);
  const raw = new Redis(TEST_REDIS_URL);
  const t0 = performance.now();
  const rel = (t: number = performance.now()) => ((t - t0) / 1000).toFixed(3);
  const events: string[] = [];
  const log = (line: string) => {
    events.push(`${rel()} ${line}`);
  };

  // --- server side
  const statsRecs: StatsRec[] = [];
  const departures: DepartureRec[] = [];
  const tickers: Array<Promise<unknown>> = [];
  let tickerSeq = 0;
  let tearingDown = false;

  function startTicker(o: { standby: boolean }): void {
    // A successor requested while the harness is already tearing down would
    // outlive the run it belongs to, which is the one thing the teardown
    // cannot wait for.
    if (tearingDown) return;
    const inst = `T${++tickerSeq}`;
    log(`[spawn] ${inst} standby=${o.standby}`);
    const p = runTicker({
      runtime: createBotRuntime(inst, (tick, serverTime) => departures.push({ inst, tick, serverTime })),
      redis: redis as unknown as RedisLike,
      createSubscriber: () => new Redis(TEST_REDIS_URL),
      roomId,
      namespace,
      geomKey: () => 'smoothness:v1',
      maxRunMs,
      standbyMs: o.standby ? (standbyMs || 8000) : 0,
      checkpointMs: 1000,
      // Long enough that a slow runner's client still arrives before the
      // room reads empty at startup, short enough that the teardown's own
      // wait for this ticker is a couple of seconds rather than a minute.
      emptyGraceMs: 2500,
      spawnSuccessor: async (_id, next) => {
        startTicker(next);
      },
      onStats: (s) => statsRecs.push({ inst, at: performance.now(), s }),
      log: (e) => log(`[ticker ${inst}] ${e.lvl} ${e.kind} ${JSON.stringify(e.meta ?? {})}`),
    }).then((r) => log(`[ticker ${inst}] exit ${JSON.stringify(r)}`));
    tickers.push(p);
  }

  startTicker({ standby: false });
  // Wait for the lease before opening the door, so the relay's own spawn poll
  // does not race the ticker already starting.
  await waitFor(async () => (await raw.get(keys.lease)) !== null, 5000, 25);

  // --- ws server: admit every socket
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pid = url.searchParams.get('pid') ?? randomUUID();
    const subject = url.searchParams.get('subject') ?? pid;
    wss.handleUpgrade(req, socket, head, (ws) => {
      void admitSocket({
        socket: ws as unknown as RelaySocket,
        redis: redis as unknown as RedisLike,
        createSubscriber: () => new Redis(TEST_REDIS_URL),
        roomId,
        pid,
        subject,
        namespace,
        maxPlayers: 20,
        log: (e) => log(`[admit] ${e.lvl} ${e.kind}`),
        relay: {
          joinMeta: { name: pid },
          lifetimeMs: relayLifetimeMs,
          decodeInput: (data): ClientInput[] => {
            const buf = Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data as Buffer[])
                : Buffer.from(data as ArrayBuffer);
            const parsed = JSON.parse(buf.toString('utf8')) as ClientInput | ClientInput[];
            return Array.isArray(parsed) ? parsed : [parsed];
          },
          spawnTicker: async () => {
            log(`[relay] spawnTicker requested`);
            startTicker({ standby: false });
          },
          log: (e) => {
            if (e.lvl !== 'info') log(`[relay] ${e.lvl} ${e.kind} ${JSON.stringify(e.meta ?? {})}`);
          },
        },
      }).then((h) => log(`[admit] socket ${h ? 'attached' : 'REFUSED'} pid=${pid}`));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as { port: number }).port;

  // --- clients
  const decoder = new TextDecoder();

  /**
   * One honest client: its own socket factory, its own interpolator, its own
   * stamped sender and its own frame log. Everything a scenario measures is
   * per client, because a roster property is only visible from more than one
   * of them.
   */
  function startClient(): ClientRig {
    const pid = `p-${randomUUID().slice(0, 6)}`;
    const frames: FrameRec[] = [];
    const snaps: SnapRec[] = [];
    const statuses: NetStatus[] = [];
    const reanchors: Array<{ atMs: number; delta: number }> = [];
    let epochSnaps = 0;
    let resyncSender = false;
    const interp = new SnapshotInterpolator<string>();
    const sockets = makeDelayedSocket(owdMs, jitterMs);
    const conn = new RoomConnection<Snap, string>({
      tickHz: TICK_HZ,
      mint: async () => ({ token: 'tok', playerId: pid, handle: 1, room: roomId }),
      socketUrl: (s) => `ws://127.0.0.1:${port}/?room=${roomId}&pid=${s.playerId}&subject=${s.playerId}`,
      WebSocketImpl: sockets.Ctor,
      decodeSnapshot: (buf) => {
        const p = JSON.parse(decoder.decode(buf)) as Snap;
        p.inputLead = p.leads?.[pid];
        return p;
      },
      interpolate: {
        into: interp,
        entities: (snap) => {
          const m = new Map<string, EntitySample>();
          for (const [k, v] of Object.entries(snap.entities)) m.set(k, { x: v.x, y: v.y });
          return m;
        },
      },
      onSnapshot: (snap) => {
        epochSnaps++;
        snaps.push({ t: performance.now(), tick: snap.tick, serverTime: snap.serverTime, inst: snap.inst });
      },
      onStatus: (s) => {
        if (s === 'connecting') epochSnaps = 0;
        statuses.push(s);
        log(`[client ${pid}] status ${s}`);
      },
      onStallChange: (st) => log(`[client ${pid}] stalled=${st}`),
      onTickReanchor: (d) => {
        reanchors.push({ atMs: performance.now(), delta: d });
        log(`[client ${pid}] tick re-anchor delta=${d}`);
        // A host resyncs its own stamping on this signal: the counter moved, so
        // "the last tick I stamped" no longer means anything. Without this a
        // backward re-anchor leaves the sender waiting for the counter to pass
        // its old high-water mark (measured: 5.6s of self-inflicted starves).
        resyncSender = true;
      },
      onTerminal: (r) => log(`[client ${pid}] TERMINAL ${r}`),
    });

    // A stamped-input sender: one record per tick, six-record redundancy window,
    // which is the shape `PlayoutBuffer` documents and the shape the never-drop-late
    // re-stamping is measured against.
    let lastSentTick = -1;
    let seq = 0;
    const window: ClientInput[] = [];
    function onFrame(): void {
      const t = performance.now();
      const view = conn.frame(t);
      const bot = view.entities.get('bot');
      frames.push({
        t,
        x: bot ? bot.x : null,
        extrap: bot ? bot.extrapolated : null,
        stalled: view.stalled,
        tick: conn.tick.value,
        anchored: conn.tick.anchored,
        desired: conn.desiredTick(),
        epochSnaps,
        ids: [...view.entities.keys()],
        ownX: view.entities.get(pid)?.x ?? null,
      });
      if (conn.tick.initialized && conn.status === 'open') {
        const tv = conn.tick.value;
        if (resyncSender) {
          resyncSender = false;
          lastSentTick = -1;
          window.length = 0;
        }
        if (tv > lastSentTick) {
          for (let k = lastSentTick < 0 ? tv : lastSentTick + 1; k <= tv; k++) {
            window.push({ seq: ++seq, targetTick: k, data: { dx: 1 } });
          }
          while (window.length > 6) window.shift();
          conn.send(JSON.stringify(window));
          lastSentTick = tv;
        }
      }
    }
    let frameTimer: ReturnType<typeof setInterval> | null = setInterval(onFrame, FRAME_MS);

    return {
      pid,
      conn,
      interp,
      frames,
      snaps,
      statuses,
      reanchors,
      freezeRender: () => {
        log(`[action ${pid}] freezing render loop`);
        if (frameTimer) clearInterval(frameTimer);
        frameTimer = null;
      },
      resumeRender: () => {
        log(`[action ${pid}] resuming render loop`);
        frameTimer ??= setInterval(onFrame, FRAME_MS);
      },
      dropFromClient: () => {
        const dropped = sockets.dropFromClient();
        log(`[action ${pid}] socket dropped from the client side: ${dropped}`);
        return dropped;
      },
      stopRender: () => {
        if (frameTimer) clearInterval(frameTimer);
        frameTimer = null;
      },
    };
  }

  const rigs: ClientRig[] = [];
  for (let i = 0; i < clients; i++) rigs.push(startClient());
  await Promise.all(rigs.map((r) => r.conn.start()));
  log(`[client] started ${rigs.map((r) => r.pid).join(',')} owd=${owdMs} jitter=${jitterMs}`);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const controls: SmoothnessClientControl[] = rigs.map((r) => ({
    pid: r.pid,
    conn: r.conn,
    interp: r.interp,
    freezeRender: r.freezeRender,
    resumeRender: r.resumeRender,
    dropFromClient: r.dropFromClient,
  }));
  const ctl: SmoothnessControl = {
    ...controls[0]!,
    clients: controls,
    log,
    now: () => performance.now(),
  };

  await Promise.all([sleep(runMs), during ? during(ctl) : Promise.resolve()]);

  const endedAt = performance.now();
  const ends = rigs.map((r) => {
    r.stopRender();
    const endStats = r.conn.stats();
    log(
      `[client ${r.pid}] final ${JSON.stringify(endStats)} delay=${r.interp.delayMs.toFixed(1)} reanchors=${r.interp.reanchors} rejected=${r.interp.rejectedFrames}`
    );
    return { statuses: [...r.statuses], endStats };
  });
  for (const r of rigs) r.conn.stop();

  // --- teardown
  tearingDown = true;
  wss.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await Promise.allSettled(tickers);
  raw.disconnect();
  redis.disconnect();

  const clientResults: SmoothnessClientResult[] = rigs.map((r, i) => ({
    pid: r.pid,
    analysis: analyse(r.frames, r.snaps, statsRecs, departures, r.reanchors, ends[i]!.endStats, t0, steadyLeadMs),
    statuses: ends[i]!.statuses,
  }));

  return {
    analysis: clientResults[0]!.analysis,
    statuses: clientResults[0]!.statuses,
    clients: clientResults,
    events,
    statsRecs,
    t0,
    endedAt,
  };
}

// ---------------------------------------------------------------- analysis

function analyse(
  frames: FrameRec[],
  snaps: SnapRec[],
  statsRecs: StatsRec[],
  departures: DepartureRec[],
  reanchors: Array<{ atMs: number; delta: number }>,
  endStats: ConnectionStats,
  t0: number,
  steadyLeadMs: number
): SmoothnessAnalysis {
  const firstSnapAt = snaps.length ? snaps[0]!.t : t0;
  const steadyFrom = firstSnapAt + steadyLeadMs;

  const speeds: number[] = [];
  let outside = 0;
  let backward = 0;
  let worstBack = 0;
  let zeroMotion = 0;
  let measured = 0;
  let missingBot = 0;
  let extrapFrames = 0;
  const resumeSteps: Array<{ atMs: number; dx: number; speed: number }> = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!;
    const b = frames[i]!;
    if (b.t < steadyFrom) continue;
    if (b.x === null) {
      missingBot++;
      continue;
    }
    if (b.extrap) extrapFrames++;
    if (a.x === null) continue;
    // The one step the pass below cannot see: out of the poses this client was
    // holding and into the new epoch's own first rendered frame.
    if (a.epochSnaps === 0 && b.epochSnaps > 0 && b.t > a.t) {
      resumeSteps.push({
        atMs: +(b.t - t0).toFixed(1),
        dx: +(b.x - a.x).toFixed(3),
        speed: +(((b.x - a.x) / (b.t - a.t)) * 1000).toFixed(2),
      });
    }
    // HOLD frames (this epoch has had no snapshot yet, so `frame()` is
    // redrawing the last pose it had) are not "should be moving": there is
    // nothing to move them with. Excluding them is what keeps a warm swap's
    // one held frame from reading as a zero-motion stutter.
    if (b.epochSnaps === 0 || a.epochSnaps === 0) continue;
    const dtS = (b.t - a.t) / 1000;
    if (dtS <= 0) continue;
    const dx = b.x - a.x;
    measured++;
    speeds.push(dx / dtS);
    if (dx / dtS < SPEED * 0.9 || dx / dtS > SPEED * 1.1) outside++;
    if (dx < -1e-6) {
      backward++;
      if (dx < worstBack) worstBack = dx;
    }
    if (Math.abs(dx) < 1e-9) zeroMotion++;
  }
  // The roster, as this client rendered it: every id it drew in the steady
  // window, and the subset it drew in EVERY frame of it. A fan-out that
  // reaches a client late is in the first list and not the second.
  const steadyFrames = frames.filter((f) => f.t >= steadyFrom);
  const seenIds = new Set<string>();
  for (const f of steadyFrames) for (const id of f.ids) seenIds.add(id);
  const alwaysPresent = [...seenIds].filter((id) => steadyFrames.every((f) => f.ids.includes(id))).sort();
  const ownDrawn = steadyFrames.filter((f) => f.ownX !== null);
  const ownAdvance = ownDrawn.length >= 2 ? ownDrawn[ownDrawn.length - 1]!.ownX! - ownDrawn[0]!.ownX! : 0;

  const mean = speeds.reduce((s, v) => s + v, 0) / Math.max(1, speeds.length);
  const sd = Math.sqrt(speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, speeds.length));
  const peak = speeds.length ? speeds.reduce((m, v) => Math.max(m, v), -Infinity) : 0;
  const minV = speeds.length ? speeds.reduce((m, v) => Math.min(m, v), Infinity) : 0;

  // snapshot gaps at the client, and the instance changes inside them
  let maxGap = 0;
  const over150: number[] = [];
  const clientHandoffs: ClientHandoff[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const g = snaps[i]!.t - snaps[i - 1]!.t;
    if (g > maxGap) maxGap = g;
    if (g > 150) over150.push(+g.toFixed(1));
    if (snaps[i]!.inst !== snaps[i - 1]!.inst) {
      clientHandoffs.push({
        atMs: snaps[i]!.t - t0,
        from: snaps[i - 1]!.inst,
        to: snaps[i]!.inst,
        gapMs: +g.toFixed(1),
        tickFrom: snaps[i - 1]!.tick,
        tickTo: snaps[i]!.tick,
      });
    }
  }

  // tick deviation from the tick the client WANTS to be stamping
  let maxDev = 0;
  for (const f of frames) {
    if (!f.anchored || f.t < steadyFrom) continue;
    const dev = f.tick - f.desired;
    if (Math.abs(dev) > Math.abs(maxDev)) maxDev = dev;
  }

  // server stats
  const totals = { lateInputs: 0, starves: 0, hostErrors: 0, publishSkipped: 0, publishFails: 0, renewFails: 0, dropped: 0, badEnvelopes: 0 };
  let lateAfterSteady = 0;
  let starvesAfterSteady = 0;
  for (const r of statsRecs) {
    if (r.at >= steadyFrom) {
      lateAfterSteady += r.s.lateInputs;
      starvesAfterSteady += r.s.starves;
    }
    totals.lateInputs += r.s.lateInputs;
    totals.starves += r.s.starves;
    totals.hostErrors += r.s.hostErrors;
    totals.publishSkipped += r.s.publishSkipped;
    totals.publishFails += r.s.publishFails;
    totals.renewFails += r.s.renewFails;
    totals.dropped += r.s.dropped;
    totals.badEnvelopes += r.s.badEnvelopes;
  }

  // the handoff as the SERVER performed it: every point where the instance
  // publishing changed, with the tick and the grid time on both sides.
  const serverHandoffs: ServerHandoff[] = [];
  const instances: string[] = [];
  for (let i = 0; i < departures.length; i++) {
    const d = departures[i]!;
    if (!instances.includes(d.inst)) instances.push(d.inst);
    if (i === 0) continue;
    const prev = departures[i - 1]!;
    if (prev.inst === d.inst) continue;
    serverHandoffs.push({
      from: prev.inst,
      to: d.inst,
      tickFrom: prev.tick,
      tickTo: d.tick,
      serverTimeFrom: prev.serverTime,
      serverTimeTo: d.serverTime,
      gridGapMs: d.serverTime - prev.serverTime,
    });
  }
  // The ticker's own cadence, measured from the grid it stamps rather than
  // from a wall clock this process happened to read.
  let maxDep = 0;
  for (let i = 1; i < departures.length; i++) {
    const g = departures[i]!.serverTime - departures[i - 1]!.serverTime;
    if (g > maxDep) maxDep = g;
  }

  return {
    frames: frames.length,
    snapshots: snaps.length,
    rendered: {
      peak: +peak.toFixed(2),
      min: +minV.toFixed(2),
      mean: +mean.toFixed(2),
      sd: +sd.toFixed(2),
      outside10pct: outside,
      backward,
      worstBackward: +worstBack.toFixed(3),
      zeroMotion,
      extrapFrames,
      missingBot,
      holdFrames: frames.filter((f) => f.t >= steadyFrom && f.epochSnaps === 0 && f.x !== null).length,
      blankFrames: frames.filter((f) => f.t >= steadyFrom && f.x === null).length,
      measured,
      resumeSteps,
    },
    entities: { ids: [...seenIds].sort(), alwaysPresent, ownAdvance: +ownAdvance.toFixed(2) },
    snapshotGap: { maxMs: +maxGap.toFixed(1), over150, handoffs: clientHandoffs },
    tick: { maxDev: +maxDev.toFixed(2), reanchors },
    server: { totals, lateAfterSteady, starvesAfterSteady, maxInterDepartureMs: maxDep, handoffs: serverHandoffs, instances },
    client: { ...endStats, stalledFrames: frames.filter((f) => f.stalled).length },
  };
}
