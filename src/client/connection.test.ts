import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WSImpl from 'ws';
import {
  RoomConnection,
  RECONNECT_BASE_MS,
  RECONNECT_FACTOR,
  RECONNECT_JITTER_MIN,
  RECONNECT_JITTER_MAX,
  type WebSocketLike,
  type WebSocketConstructor,
  type SessionInfo,
  type DecodedSnapshotLike,
  type RoomConnectionOptions,
} from './connection.js';
import { SnapshotInterpolator, RESUME_GLIDE_MAX_MS } from './interpolation.js';
import { PING_INTERVAL_MS, PLAYOUT_MAX_AHEAD } from '../core/index.js';
import { REANCHOR_MIN_INTERVAL_MS } from './netPolicy.js';
import {
  DEFAULT_SNAPSHOT_VERSION,
  encodeDefaultSnapshot,
  decodeDefaultSnapshot,
  type DefaultSnapshot,
} from '../codec/index.js';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType?: string;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(code = 1000, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.(reason === undefined ? { code } : { code, reason });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  /** Simulates the server (or the platform) closing the socket, independent of whether our own `close()` already ran. Used to drive an orphaned socket's stray events in tests. */
  remoteClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Every `ping` this socket has been sent, as the relay sees them. */
  pings(): { n: number; c: number }[] {
    const out: { n: number; c: number }[] = [];
    for (const raw of this.sent) {
      if (typeof raw !== 'string') continue;
      const msg = JSON.parse(raw) as { t?: string; n?: number; c?: number };
      if (msg.t === 'ping') out.push({ n: msg.n as number, c: msg.c as number });
    }
    return out;
  }

  /** What the relay does with a ping: echo both fields back, directly, without touching Redis. */
  answerPings(): void {
    for (const ping of this.pings()) this.message(JSON.stringify({ t: 'pong', n: ping.n, c: ping.c }));
    this.sent = [];
  }
}

const IMPL = FakeSocket as unknown as WebSocketConstructor;

/** ws's own class, named so the type-level assertion below reads as an assignment rather than an import side effect. */
const wsCtor = WSImpl;

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return { token: 't', playerId: 'p1', handle: 1, room: 'r', ...over };
}

/** Mirrors `RTT_WINDOW` in connection.ts. Named here so the sustained-rise case says WHY it sends that many. */
const RTT_WINDOW_SIZE = 8;

/** Push one binary frame into a specific socket (the warm-swap replacement is not `live()` until it has delivered). */
function deliverTo(sock: FakeSocket): void {
  sock.message(new ArrayBuffer(4));
}

function live(): FakeSocket {
  const sock = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!sock) throw new Error('no socket was created');
  return sock;
}

/**
 * `performance.now()` is NOT faked by vitest's default `toFake` set, and this
 * class runs its whole clock, its RTT probe and its arrival stamps on it. A
 * fake-timer test that leaves it real measures nothing it thinks it does, and
 * the wall-clock-step case below needs the two domains moved SEPARATELY, which
 * is exactly what `setSystemTime` against a faked `performance` gives.
 */
function useMonotonicFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  // The reconnect ladder multiplies every delay by a random jitter factor, so
  // a fixed 0.5 makes it exactly 1.0 and every timing assertion in this file
  // deterministic. The ladder's own block stubs it differently on purpose.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RoomConnection reconnect backoff', () => {
  it('follows min(maxBackoffMs, RECONNECT_BASE_MS * 2**attempt), resetting the counter only on a real open', async () => {
    vi.useFakeTimers();
    const mint = vi.fn().mockResolvedValue(makeSession());
    const conn = new RoomConnection({
      mint,
      tickHz: 20,
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      maxBackoffMs: 800,
    });

    await conn.start();
    expect(FakeSocket.instances.length).toBe(1);

    // 100*2**0, *2**1, *2**2, *2**3 (800 is the cap here), *2**4 (1600 capped).
    // The jitter factor is pinned to 1.0 by the `Math.random` stub above.
    const delays = [100, 200, 400, 800, 800];
    for (let i = 0; i < delays.length; i++) {
      FakeSocket.instances[i]!.remoteClose(1006); // never opened: a pre-open failure
      await vi.advanceTimersByTimeAsync(delays[i]! - 1);
      expect(FakeSocket.instances.length).toBe(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.instances.length).toBe(i + 2);
    }

    conn.stop();
  });

  it('re-mints the session after three consecutive pre-open failures, and only then', async () => {
    vi.useFakeTimers();
    let mintCount = 0;
    const mint = vi.fn().mockImplementation(async () => {
      mintCount++;
      return makeSession({ token: `tok-${mintCount}` });
    });
    const conn = new RoomConnection({
      mint,
      tickHz: 20,
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: (s) => `ws://x?tok=${s.token}`,
      connectTimeoutMs: 60_000,
    });

    await conn.start();
    expect(mintCount).toBe(1);

    // THE "AND ONLY THEN" HALF, which counting at the end cannot see. Three
    // failures produce exactly one re-mint whatever the threshold is, as long
    // as it is at most three, so a final `mintCount === 2` is equally true of a
    // threshold of two or of one. The separating assertion is the one made
    // BEFORE the third failure: the first two reconnects must reuse the token.
    for (let i = 0; i < 2; i++) {
      live().remoteClose(1006);
      await vi.advanceTimersByTimeAsync(10_000); // comfortably past any backoff delay
      expect(mintCount).toBe(1);
      expect(live().url).toContain('tok-1');
    }

    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mintCount).toBe(2);
    expect(live().url).toContain('tok-2');

    conn.stop();
  });
});

describe('RoomConnection detach-before-close', () => {
  it('an orphaned socket cannot deliver a snapshot into the live connection', async () => {
    vi.useFakeTimers();
    const decode = vi.fn().mockReturnValue({ tick: 1, serverTime: 1000 });
    const onSnapshot = vi.fn();
    const mint = vi.fn().mockResolvedValue(makeSession());
    const conn = new RoomConnection({
      mint,
      tickHz: 20,
      decodeSnapshot: decode,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onSnapshot,
    });

    await conn.start();
    const first = FakeSocket.instances[0]!;
    first.open();

    first.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(300); // past the first 250ms backoff
    const second = FakeSocket.instances[1]!;
    expect(second).not.toBe(first);
    second.open();

    first.message(new ArrayBuffer(4));
    expect(onSnapshot).not.toHaveBeenCalled();

    // The live socket still works, proving the detach did not break anything else.
    second.message(new ArrayBuffer(4));
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    conn.stop();
  });

  it("an orphaned socket's own close event does not start a second reconnect ladder", async () => {
    vi.useFakeTimers();
    const mint = vi.fn().mockResolvedValue(makeSession());
    const conn = new RoomConnection({ tickHz: 20, mint, decodeSnapshot: () => null, WebSocketImpl: IMPL, socketUrl: () => 'ws://x' });

    await conn.start();
    const first = FakeSocket.instances[0]!;
    first.open();
    first.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.instances.length).toBe(2); // the real ladder created exactly one replacement

    // A stray, late close delivered by the now-orphaned first socket. The
    // window stays under `connectTimeoutMs`, so the only thing that could
    // create a third socket here is the orphan.
    first.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.instances.length).toBe(2); // no extra instances from the orphan

    conn.stop();
  });
});

describe('RoomConnection terminal codes', () => {
  it.each([
    [4002, 'capacity'],
    [4003, 'conn-limit'],
  ] as const)('close code %d maps to %s and never reconnects', async (code, reason) => {
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    const mint = vi.fn().mockResolvedValue(makeSession());
    const conn = new RoomConnection({
      mint,
      tickHz: 20,
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onTerminal,
    });

    await conn.start();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.remoteClose(code);

    expect(onTerminal).toHaveBeenCalledWith(reason);
    expect(conn.status).toBe('closed');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.instances.length).toBe(1);

    conn.stop();
  });

  it('a room-full text frame and a 4002 close debounce to one capacity event', async () => {
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    const mint = vi.fn().mockResolvedValue(makeSession());
    const conn = new RoomConnection({
      mint,
      tickHz: 20,
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onTerminal,
    });

    await conn.start();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    sock.message(JSON.stringify({ t: 'room-full' }));
    sock.remoteClose(4002);

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith('capacity');

    conn.stop();
  });

  it('a room-full frame CLOSES the socket, so a room that already refused us cannot keep streaming', async () => {
    // The terminal used to latch while the socket stayed live: measured, a
    // client with the "room is full" banner up went on receiving, decoding and
    // rendering that room's snapshots for as long as the relay kept the socket.
    vi.useFakeTimers();
    const onSnapshot = vi.fn();
    const conn = new RoomConnection({
      mint: vi.fn().mockResolvedValue(makeSession()),
      tickHz: 20,
      decodeSnapshot: () => ({ tick: 1, serverTime: Date.now() }),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onSnapshot,
    });

    await conn.start();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    sock.message(JSON.stringify({ t: 'room-full' }));

    expect(sock.readyState).toBe(3);
    sock.message(new ArrayBuffer(4));
    expect(onSnapshot).not.toHaveBeenCalled();

    conn.stop();
  });

  it('a conn-limit text frame behaves exactly like room-full: latch, then close', async () => {
    // The two frames are the same kind of thing (a refusal the relay sends just
    // before closing) and must not diverge. Today this is redundant with
    // `CLOSE_CODES.connLimit`; it is the only cover on a relay that sends the
    // frame without the paired close.
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    const onSnapshot = vi.fn();
    const conn = new RoomConnection({
      mint: vi.fn().mockResolvedValue(makeSession()),
      tickHz: 20,
      decodeSnapshot: () => ({ tick: 1, serverTime: Date.now() }),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onTerminal,
      onSnapshot,
    });

    await conn.start();
    const sock = live();
    sock.open();
    sock.message(JSON.stringify({ t: 'conn-limit' }));

    expect(onTerminal).toHaveBeenCalledWith('conn-limit');
    expect(sock.readyState).toBe(3);
    sock.message(new ArrayBuffer(4));
    expect(onSnapshot).not.toHaveBeenCalled();

    // ...and the 4003 close the relay sends after it debounces to one event.
    sock.remoteClose(4003);
    expect(onTerminal).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.instances.length).toBe(1);
    conn.stop();
  });

  it('a room-reject naming THIS player is a capacity terminal; one naming another player is dropped', async () => {
    // Defence in depth for an older relay that forwards the ticker's raw
    // rejection instead of converting it. A rejection names its subject, and
    // acting on somebody else's would eject a player the room never refused.
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    const conn = new RoomConnection({
      mint: vi.fn().mockResolvedValue(makeSession({ playerId: 'me' })),
      tickHz: 20,
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onTerminal,
    });

    await conn.start();
    const sock = FakeSocket.instances[0]!;
    sock.open();

    sock.message(JSON.stringify({ t: 'room-reject', pid: 'someone-else' }));
    expect(onTerminal).not.toHaveBeenCalled();
    expect(sock.readyState).toBe(1);

    sock.message(JSON.stringify({ t: 'room-reject', pid: 'me' }));
    expect(onTerminal).toHaveBeenCalledWith('capacity');
    expect(sock.readyState).toBe(3);

    conn.stop();
  });
});

describe('RoomConnection stop()', () => {
  it('a stop() landing during an in-flight mint prevents a socket from ever opening', async () => {
    let resolveMint!: (s: SessionInfo) => void;
    const mint = vi.fn().mockImplementation(
      () =>
        new Promise<SessionInfo>((resolve) => {
          resolveMint = resolve;
        }),
    );
    const conn = new RoomConnection({ tickHz: 20, mint, decodeSnapshot: () => null, WebSocketImpl: IMPL, socketUrl: () => 'ws://x' });

    const startPromise = conn.start();
    conn.stop();
    resolveMint(makeSession());
    await startPromise;

    expect(FakeSocket.instances.length).toBe(0);
  });

  it('fires onTerminal("stopped") exactly once and is idempotent', async () => {
    const onTerminal = vi.fn();
    const mint = vi.fn().mockResolvedValue(makeSession());
    const conn = new RoomConnection({
      mint,
      tickHz: 20,
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onTerminal,
    });
    await conn.start();
    FakeSocket.instances[0]!.open();

    conn.stop();
    conn.stop();

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith('stopped');
    expect(conn.status).toBe('idle');
  });
});

describe('RoomConnection happy path', () => {
  it('delivers a decoded snapshot, tracks status transitions, and anchors the tick', async () => {
    const onStatus = vi.fn();
    const onSnapshot = vi.fn();
    const mint = vi.fn().mockResolvedValue(makeSession());
    const decode = vi.fn().mockReturnValue({ tick: 500, serverTime: Date.now() });
    const conn = new RoomConnection({
      mint,
      tickHz: 20,
      decodeSnapshot: decode,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onStatus,
      onSnapshot,
    });

    await conn.start();
    expect(conn.status).toBe('connecting');
    const sock = FakeSocket.instances[0]!;
    sock.open();
    expect(conn.status).toBe('open');
    // THE SEQUENCE, not just the getter. This spy used to be created and never
    // read, so a stream that announced nothing, announced 'open' three times,
    // or announced a status this connection was never in read as a pass.
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(['connecting', 'open']);

    sock.message(new ArrayBuffer(8));
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(conn.tick.anchored).toBe(true);
    expect(conn.tick.value).toBeGreaterThanOrEqual(500);

    const stats = conn.stats();
    expect(stats.snapshotsReceived).toBe(1);
    expect(stats).toEqual({
      rttMs: 0,
      jitterMs: 0,
      snapshotsReceived: 1,
      rejectedSnapshots: 0,
      underrunRate: 0,
      reconnects: 0,
      relaySwaps: 0,
      swapsAttempted: 0,
      swapsFailed: 0,
      serverTickHz: 0,
      hostErrors: 0,
    });

    conn.stop();
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(['connecting', 'open', 'idle']);
  });
});

// ---------------------------------------------------------------------------
// The three seams a real app built against this library fell into, each of
// which used to be glue the host had to write correctly from memory.
// ---------------------------------------------------------------------------

describe('RoomConnection owns the interpolator', () => {
  /** A room whose snapshots carry one moving entity, wired the way a host now wires one. */
  function cursorRoom(interp: SnapshotInterpolator<string>) {
    let serverTime = Date.now();
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: () => ({ tick: 100, serverTime, players: [{ id: 'p2', x: 7, y: 9 }] }),
      interpolate: {
        into: interp,
        entities: (snap) => new Map(snap.players.map((p) => [p.id, { x: p.x, y: p.y }])),
      },
    });
    return { conn, advanceServer: (ms: number) => void (serverTime += ms) };
  }

  it('pushes each snapshot itself, with the SERVER stamp as the playback axis and its own arrival stamp', async () => {
    // The two fields that never varied across any hand-written copy of this
    // bridge are exactly the two the docs spent fifteen lines of capitalised
    // warning on, so they are the two the library now writes. `serverTime` must
    // be the authority's stamp (passing a second local clock reading makes the
    // whole server-timeline design a no-op that replays every delivery burst as
    // motion), and `receivedAt` must be the same clock `sample()` reads.
    const interp = new SnapshotInterpolator<string>();
    const push = vi.spyOn(interp, 'push');
    const { conn } = cursorRoom(interp);

    await conn.start();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.message(new ArrayBuffer(8));

    expect(push).toHaveBeenCalledTimes(1);
    const frame = push.mock.calls[0]![0];
    // A wall-clock epoch stamp, not a monotonic one: the two are ~1.7e12 apart,
    // so this cannot pass by accident if the connection stamped both fields
    // from one clock.
    expect(frame.serverTime).toBeGreaterThan(1_600_000_000_000);
    expect(Number.isFinite(frame.receivedAt)).toBe(true);
    expect(frame.receivedAt).toBeLessThan(1_600_000_000_000);
    expect([...frame.entities]).toEqual([['p2', { x: 7, y: 9 }]]);
  });

  it('clears the interpolator on a reconnect, so the new epoch cannot bracket against the old one', async () => {
    // A buffer carried across an epoch brackets the new socket's first frame
    // against one from seconds ago at frac ~= 1, which is a guaranteed snap on
    // every reconnect, and the previous path's clock offset comes with it. Only
    // the connection knows when an epoch begins, and it already does the
    // identical thing one line away for the tick counter.
    //
    // THE BUFFER IS WHAT IS ASSERTED ON, NOT `frame()`. `frame()` deliberately
    // keeps DRAWING the last poses across a cold reconnect (see the hold test
    // below), so asking it for an empty map would now conflate two different
    // mechanisms; the interpolator itself is where the clear has to show.
    vi.useFakeTimers();
    const interp = new SnapshotInterpolator<string>();
    const { conn } = cursorRoom(interp);

    await conn.start();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.message(new ArrayBuffer(8));
    // Behaviour, not a spy: the buffered frame is genuinely renderable.
    expect(conn.frame(1000).entities.has('p2')).toBe(true);

    FakeSocket.instances[0]!.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);

    // Nothing left to bracket against, before the new socket has delivered a
    // single frame.
    expect(interp.sample(0, 2000).size).toBe(0);
    conn.stop();
  });

  it('frame() advances the tick counter, so a stamped input cannot freeze at its anchor', async () => {
    // THE SILENT ONE. `tick.advance(dt)` used to be a third per-frame call
    // documented in no README, no architecture doc and not even in this repo's
    // own client example. Omitting it froze `tick.value` at its one anchor
    // while the server ran away (measured: pinned at 4 against a server tick of
    // 20.2 after two seconds), so every input carried a `targetTick` further
    // and further into the past, and because `shouldReanchor` gates on
    // `initialized` the omission also permanently disabled the recovery. The
    // connection now drives it from the one call that returns the poses to
    // draw, so a host that renders anything at all is already advancing it.
    const interp = new SnapshotInterpolator<string>();
    const { conn } = cursorRoom(interp);

    await conn.start();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.message(new ArrayBuffer(8));

    const anchored = conn.tick.value;
    expect(conn.tick.anchored).toBe(true);

    // One second of rendered frames at 20Hz nominal, and the first call is the
    // zero-delta one that establishes the reference.
    for (let i = 0; i <= 60; i++) conn.frame(i * (1000 / 60));
    expect(conn.tick.value - anchored).toBe(20);
    expect(conn.tick.initialized).toBe(true);
    // The view the connection hands out is the counter itself, so the render
    // interpolation fraction is readable off it with no cast.
    expect(conn.tick.fraction).toBeGreaterThanOrEqual(0);
    expect(conn.tick.fraction).toBeLessThan(1);
    conn.stop();
  });

  it('tickHz is the basis for the tick counter, so a 10Hz room advances at 10Hz', async () => {
    // `tickHz` used to default to 20. A 10Hz room whose client did not mention
    // it therefore ran the counter at twice the right rate, along with
    // `estimateServerTick`'s slope and the underrun threshold, silently. It is
    // now required, so the omission is a compile error rather than a 2x error;
    // this pins that the value is actually the basis and not decoration.
    const interp = new SnapshotInterpolator<string>();
    const conn = new RoomConnection({
      tickHz: 10,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: () => ({ tick: 100, serverTime: Date.now() }),
      interpolate: { into: interp, entities: () => new Map() },
    });

    await conn.start();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.message(new ArrayBuffer(8));

    const anchored = conn.tick.value;
    for (let i = 0; i <= 60; i++) conn.frame(i * (1000 / 60));
    expect(conn.tick.value - anchored).toBe(10);
    conn.stop();
  });

  it('composes with the library own default codec, with no cast in either direction', async () => {
    // THE LIBRARY DID NOT COMPOSE WITH ITSELF. `decodeDefaultSnapshot` was not
    // assignable to `decodeSnapshot` at all (TS2322: `DefaultSnapshot` is an
    // interface, so it has no implicit index signature and could not satisfy
    // the old `DecodedSnapshotLike`), and the return trip needed the
    // `as unknown as` double cast TypeScript's own error text calls a mistake.
    // This test exists mostly to be COMPILED: the assignment below is the
    // assertion, and it did not typecheck before the index signature came off
    // and the payload type was threaded through generically.
    const interp = new SnapshotInterpolator<number>();
    const seen: DefaultSnapshot[] = [];
    const wire = encodeDefaultSnapshot(
      {
        version: DEFAULT_SNAPSHOT_VERSION,
        tick: 42,
        serverTime: Date.now(),
        entities: [{ id: 7, x: 640, y: 480 }],
      },
      { positionScale: 1 },
    );

    const conn = new RoomConnection({
      tickHz: 10,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: (buf) => decodeDefaultSnapshot(buf, { positionScale: 1 }),
      interpolate: {
        into: interp,
        // `snap` is `DefaultSnapshot` here, and `e` is `CodecEntity`, both
        // inferred rather than asserted.
        entities: (snap) => new Map(snap.entities.map((e) => [e.id, { x: e.x, y: e.y }])),
      },
      onSnapshot: (snap) => void seen.push(snap),
    });

    await conn.start();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.message(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength));

    // `extra` is a `DefaultSnapshot` field, so reading it here proves the
    // concrete type survived the round trip rather than being erased.
    expect(seen[0]!.entities[0]!.x).toBe(640);
    expect(seen[0]!.extra).toEqual(new Uint8Array(0));
    expect(conn.frame(1000).entities.get(7)!.y).toBe(480);
    conn.stop();
  });

  it('holds the last poses across a COLD reconnect, and the new epoch first snapshot ends the hold', async () => {
    // A reconnect used to blank every remote entity from `connectOnce` until
    // the new epoch's first snapshot, which on Vercel happens at every relay's
    // own ~13 minute lifetime cap whether anything is wrong or not. A stale
    // pose is a better answer than no pose, and it is flagged as a guess so a
    // host can fade or ghost them.
    vi.useFakeTimers();
    const interp = new SnapshotInterpolator<string>();
    const { conn } = cursorRoom(interp);

    await conn.start();
    live().open();
    live().message(new ArrayBuffer(8));
    const drawn = conn.frame(1000).entities.get('p2')!;
    expect(drawn).toBeTruthy();

    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(interp.sample(0, 2000).size).toBe(0); // the buffer really is empty

    const held = conn.frame(2000).entities.get('p2');
    expect(held).toBeTruthy();
    expect(held!.x).toBe(drawn.x);
    expect(held!.speed).toBe(0);
    expect(held!.extrapolated).toBe(true);

    // The first snapshot of the new epoch ends the hold: what is drawn now
    // comes from the buffer again.
    live().open();
    live().message(new ArrayBuffer(8));
    const fresh = conn.frame(2100).entities.get('p2');
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(held);
    conn.stop();
  });
});

// ---------------------------------------------------------------------------
// The trust boundary on a decoded snapshot, and the two clock domains.
// ---------------------------------------------------------------------------

type ClockRoomOptions = Partial<RoomConnectionOptions<DecodedSnapshotLike, string>>;

/** A connection whose snapshot payload the test sets frame by frame. */
function clockRoom(over: ClockRoomOptions = {}) {
  let next: DecodedSnapshotLike = { tick: 0, serverTime: 0 };
  const conn = new RoomConnection<DecodedSnapshotLike, string>({
    tickHz: 20,
    mint: vi.fn().mockResolvedValue(makeSession()),
    WebSocketImpl: IMPL,
    socketUrl: () => 'ws://x',
    decodeSnapshot: () => ({ ...next }),
    ...over,
  });
  const deliver = (snap: DecodedSnapshotLike): void => {
    next = snap;
    live().message(new ArrayBuffer(4));
  };
  return { conn, deliver };
}

describe('RoomConnection snapshot trust boundary', () => {
  it('refuses a snapshot whose serverTime or tick is not finite, before it touches any accumulator', async () => {
    // THE SAME BOUNDARY `SnapshotInterpolator.push()` APPLIES. These fields are
    // typed `number` and arrive out of a decoder the HOST owns, so the type is
    // a compile-time claim about a runtime value: a codec that simply omits
    // `serverTime` hands over `undefined`, whose arithmetic is NaN. ONE such
    // frame used to poison the clock permanently, because an EMA can never
    // leave NaN: `estimateServerTick()` went NaN for the rest of the
    // connection, `shouldReanchor` could never fire again (every comparison
    // against NaN is false), and after the next reconnect `tick.value` was NaN
    // with `initialized` true, so every stamped input carried NaN.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    deliver({ tick: 100, serverTime: performance.now() });
    const anchored = conn.tick.value;
    expect(Number.isFinite(anchored)).toBe(true);

    deliver({ tick: 101, serverTime: undefined as unknown as number });
    deliver({ tick: NaN, serverTime: performance.now() });

    expect(conn.stats().rejectedSnapshots).toBe(2);
    expect(conn.stats().snapshotsReceived).toBe(1);
    expect(Number.isFinite(conn.estimateServerTick())).toBe(true);
    expect(Number.isFinite(conn.serverNow())).toBe(true);

    // ...and the connection is still usable afterwards, which is the half a
    // "count it and carry on" fix has to prove.
    await vi.advanceTimersByTimeAsync(50);
    deliver({ tick: 102, serverTime: performance.now() });
    expect(conn.stats().snapshotsReceived).toBe(2);
    expect(Number.isFinite(conn.tick.value)).toBe(true);
    conn.stop();
  });
});

describe('RoomConnection server clock', () => {
  /** Feed `count` snapshots at the room's tick rate, stamping `serverTime` for a given one-way delay and clock skew. */
  async function stream(
    deliver: (s: DecodedSnapshotLike) => void,
    opts: { count: number; startTick: number; delayMs?: number; skewMs?: number; render?: () => void },
  ): Promise<number> {
    let tick = opts.startTick;
    for (let i = 0; i < opts.count; i++) {
      await vi.advanceTimersByTimeAsync(50);
      const localNow = performance.now();
      deliver({ tick, serverTime: localNow - (opts.delayMs ?? 0) + (opts.skewMs ?? 0) });
      opts.render?.();
      tick++;
    }
    return tick;
  }

  it('a wall-clock step moves nothing: the offset lives entirely on the monotonic clock', async () => {
    // The offset used to be differenced against `Date.now()` while `frame()`
    // and every arrival stamp ran on `performance.now()`. A wall-clock step is
    // an ORDINARY event (an NTP correction on wake, a phone picking up carrier
    // time) and it moved the tick estimate by the whole step: measured, the
    // counter snapped back about 20 ticks at 20Hz while remote rendering, on
    // the monotonic clock, carried on untouched.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    let tick = await stream(deliver, { count: 20, startTick: 1000 });
    expect(Math.abs(conn.estimateServerTick() - (tick - 1))).toBeLessThan(0.5);

    // The system clock jumps a full second forward. No fake time passes.
    vi.setSystemTime(new Date(Date.now() + 1000));
    expect(Math.abs(conn.estimateServerTick() - (tick - 1))).toBeLessThan(0.5);

    tick = await stream(deliver, { count: 20, startTick: tick });
    expect(Math.abs(conn.estimateServerTick() - (tick - 1))).toBeLessThan(0.5);
    conn.stop();
  });

  it('a +1000ms one-way delay step settles within about a second instead of waiting out the offset window', async () => {
    // A sliding minimum is right for noise and wrong for a STEP. Without an
    // escape hatch a route change of this size waits for the whole 64-sample
    // window to turn over, which is the same defect, with the same fix, that
    // `SnapshotInterpolator` already carries.
    //
    // IT IS THE WINDOW, NOT THE SLEW, THAT PACES THIS DIRECTION, and this case
    // used to claim the slew cap in its own name. A delay INCREASE raises every
    // sample, and a minimum cannot follow a rise until the low samples age out,
    // so the clamp is never the binding constraint here and this case survives
    // its removal. The DOWNWARD step below is the one that pins it.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    let tick = await stream(deliver, { count: 40, startTick: 500 });
    const settledBefore = conn.serverNow() - (performance.now() - 0);
    expect(Math.abs(settledBefore)).toBeLessThan(5);

    // 300ms into the step the window alone has barely moved: this is what makes
    // the assertion below a statement about the escape hatch rather than about
    // an estimator that simply chases every sample.
    tick = await stream(deliver, { count: 6, startTick: tick, delayMs: 1000 });
    expect(conn.serverNow() - (performance.now() - 1000)).toBeGreaterThan(500);

    tick = await stream(deliver, { count: 24, startTick: tick, delayMs: 1000 });
    // The estimate now reads the server's clock as it was when the packet left,
    // which is what the offset floor means and is exactly what `desiredTick`
    // compensates for with the measured round trip.
    expect(Math.abs(conn.serverNow() - (performance.now() - 1000))).toBeLessThan(50);
    conn.stop();
  });

  it('a successor stamping +600ms of clock skew settles, and does not leave the counter behind', async () => {
    // `ticker.ts` stamps `serverTime` from the running instance's own
    // `Date.now()`, so a handoff carries the successor machine's skew in either
    // direction. The counter has to end up tracking the new timeline rather
    // than sitting permanently off it.
    //
    // AND IT MUST GET THERE WITHOUT A CORRECTION, because no real error ever
    // accumulated: the counter and the true server tick both ran at wall rate
    // through the whole handoff, and only the OFFSET was wrong. Acting on the
    // apparent error while the step escape is still deciding produced two
    // opposite 12-tick snaps two seconds apart, which is a visible correction
    // in exchange for nothing. `shouldReanchor`'s `clockStepping` gate is what
    // holds the counter still for the ~650ms the escape needs.
    useMonotonicFakeTimers();
    const onTickReanchor = vi.fn();
    const { conn, deliver } = clockRoom({ onTickReanchor });
    await conn.start();
    live().open();
    const render = (): void => void conn.frame();

    let tick = await stream(deliver, { count: 40, startTick: 2000, render });
    expect(onTickReanchor).not.toHaveBeenCalled();

    // The escape needs about 650ms (13 snapshots at 20Hz) to re-seed, so
    // everything sampled from snapshot 20 on is comfortably past it.
    const errorsAfterReseed: number[] = [];
    let i = 0;
    const sample = (): void => {
      render();
      if (i++ >= 20) errorsAfterReseed.push(conn.tick.value - conn.desiredTick());
    };
    tick = await stream(deliver, { count: 100, startTick: tick, skewMs: 600, render: sample });

    // The clock tracks the successor: `serverNow()` reads its stamps back.
    expect(Math.abs(conn.serverNow() - (performance.now() + 600))).toBeLessThan(50);
    // And the counter sits where it wants to be, not a handoff behind it.
    expect(Math.abs(conn.tick.value - conn.desiredTick())).toBeLessThan(2);
    expect(conn.tick.value).toBeGreaterThan(tick - 1);

    // ONE correction at most, and no wobble at all once the offset is re-seeded.
    expect(onTickReanchor.mock.calls.length).toBeLessThanOrEqual(1);
    expect(Math.max(...errorsAfterReseed.map((e) => Math.abs(e)))).toBeLessThan(1.5);
    conn.stop();
  });

  it('a DOWNWARD offset step is followed at no more than 5% of wall time', async () => {
    // THE OTHER DIRECTION, AND THE ONE THE CLAMP ACTUALLY GUARDS. A successor
    // stamping LATER lowers every sample, and one low sample redefines a
    // minimum outright: the floor is at the new timeline on the very first
    // stepped frame, with nothing but the slew between the estimate and a
    // 600ms jump. Uncapped, `serverNow()` (and with it `estimateServerTick`,
    // the stamping lead and every re-anchor decision) crosses the whole step
    // in one snapshot, which is a route flap rendered as motion.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    let tick = await stream(deliver, { count: 40, startTick: 700 });
    expect(Math.abs(conn.serverNow() - performance.now())).toBeLessThan(1);

    // Ten stepped samples, which is inside `SERVER_CLOCK_STEP_MS` and so is
    // entirely before the escape hatch can fire.
    const offsets = [performance.now() - conn.serverNow()];
    for (let i = 0; i < 10; i++) {
      tick = await stream(deliver, { count: 1, startTick: tick, skewMs: 600 });
      offsets.push(performance.now() - conn.serverNow());
    }
    const steps = offsets.slice(1).map((o, i) => Math.abs(o - offsets[i]!));
    expect(Math.max(...steps)).toBeLessThanOrEqual(0.05 * 50 + 1e-6);

    // CONTROL: the cap paces the move, it does not refuse it. The escape hatch
    // re-seeds the window a little past `SERVER_CLOCK_STEP_MS` and the whole
    // 600ms lands, which is the case above running the other way.
    await stream(deliver, { count: 20, startTick: tick, skewMs: 600 });
    expect(Math.abs(conn.serverNow() - (performance.now() + 600))).toBeLessThan(50);
    conn.stop();
  });

  it('an outage followed by ONE straggler does not re-seed the clock', async () => {
    // THE SAMPLE COUNT IS THE SAFETY ON THE ESCAPE, exactly as
    // `REANCHOR_MIN_SAMPLES` is on the interpolator's re-anchor. An outage
    // disagrees with the estimate for as long as it lasts, just as a genuine
    // step does, and there is nothing to re-seed the window FROM: adopting one
    // late frame makes that frame's own queueing the new timeline.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    let tick = await stream(deliver, { count: 40, startTick: 300 });

    // One disagreeing sample opens the step window, then the room goes quiet
    // for longer than `SERVER_CLOCK_STEP_MS` and exactly one frame arrives.
    // The TIME half of the escape is satisfied; the COUNT half is not.
    tick = await stream(deliver, { count: 1, startTick: tick, skewMs: 600 });
    await vi.advanceTimersByTimeAsync(650);
    deliver({ tick: tick++, serverTime: performance.now() + 600 });
    expect(Math.abs(conn.serverNow() - performance.now())).toBeLessThan(100);

    // CONTROL: it is a count, not a refusal. Frames that keep arriving reach
    // `SERVER_CLOCK_STEP_SAMPLES` and the step is adopted.
    await stream(deliver, { count: 4, startTick: tick, skewMs: 600 });
    expect(Math.abs(conn.serverNow() - (performance.now() + 600))).toBeLessThan(50);
    conn.stop();
  });

  it('a plausible sample clears the accumulated step evidence, so two unrelated excursions never combine into an escape', async () => {
    // The escape adopts a RUN, and a run is only evidence of a timeline while
    // it is unbroken: a sample that agrees with the estimate says the old
    // timeline is still there. Without the clear, two ordinary congestion
    // excursions minutes apart would eventually sum to five samples spanning
    // more than `SERVER_CLOCK_STEP_MS` and re-seed the clock off neither.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    let tick = await stream(deliver, { count: 40, startTick: 800 });

    // Eight disagree, ONE agrees, six more disagree. Fourteen excursions in
    // all, and the last of them lands more than `SERVER_CLOCK_STEP_MS` after
    // the first, so an escape that never forgot the first run fires here.
    tick = await stream(deliver, { count: 8, startTick: tick, skewMs: 600 });
    tick = await stream(deliver, { count: 1, startTick: tick });
    tick = await stream(deliver, { count: 6, startTick: tick, skewMs: 600 });
    expect(Math.abs(conn.serverNow() - performance.now())).toBeLessThan(100);

    // CONTROL: the same excursion, uninterrupted, IS adopted.
    await stream(deliver, { count: 14, startTick: tick, skewMs: 600 });
    expect(Math.abs(conn.serverNow() - (performance.now() + 600))).toBeLessThan(50);
    conn.stop();
  });

  it('the offset window is bounded at SERVER_CLOCK_WINDOW, so a genuinely worsening path is eventually followed', async () => {
    // A minimum over a window that never evicts is a minimum over the whole
    // epoch, and the best moment a connection ever had is not an estimate of
    // the path it is on now: the client would go on reading the server's clock
    // as it was on its luckiest packet, for as long as the socket lives.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    // Seventy clean samples fill the window with the good path.
    const tick = await stream(deliver, { count: 70, startTick: 400 });
    expect(Math.abs(conn.serverNow() - performance.now())).toBeLessThan(1);

    // The path then worsens by 40ms and stays there. That is under one tick,
    // so the step escape never engages and the window turning over is the only
    // mechanism left that can follow it.
    await stream(deliver, { count: 90, startTick: tick, delayMs: 40 });
    expect(Math.abs(conn.serverNow() - (performance.now() - 40))).toBeLessThan(2);
    conn.stop();
  });

  it('a backwards localNow yields no slew rather than an inverted one', async () => {
    // `performance.now()` is monotonic by contract and the clamp is what keeps
    // that a guard rather than an assumption. `elapsed` is a subtraction of two
    // readings of it, and a negative one turns the limiter inside out: with
    // `maxSlew` negative, `max(-maxSlew, min(maxSlew, delta))` stops bounding
    // the move toward the floor and becomes a PUSH of `|elapsed| * 5%` away
    // from it, in the one situation where the estimator has least to go on.
    let fakeNow = 5000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    for (let i = 0; i < 8; i++) {
      fakeNow += 50;
      deliver({ tick: 500 + i, serverTime: fakeNow });
    }
    expect(conn.serverNow()).toBe(fakeNow); // the offset settled at exactly zero

    // The clock reads a full second EARLIER, and the frame that comes with it
    // sits 600ms off the settled offset, so the window floor really does move
    // and the slew is the only thing pacing it.
    fakeNow -= 1000;
    deliver({ tick: 600, serverTime: fakeNow + 600 });
    expect(conn.serverNow()).toBe(fakeNow);

    // CONTROL: time moving FORWARD again pays the ordinary 5% of it, so the
    // clamp is a floor of zero on the pace rather than a stalled estimator.
    fakeNow += 50;
    deliver({ tick: 601, serverTime: fakeNow + 600 });
    expect(fakeNow - conn.serverNow()).toBeCloseTo(-0.05 * 50, 9);

    conn.stop();
    clock.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The round trip, the stamping lead, and the re-anchor.
// ---------------------------------------------------------------------------

describe('RoomConnection round trip', () => {
  it('pings on open and on the interval, and a pong sets rttMs', async () => {
    // `stats().rttMs` used to pair the oldest outstanding `send()` with the
    // next SNAPSHOT to arrive, which on matched send and snapshot rates
    // measures roughly U(0, tickMs): it moved with the tick rate and not with
    // the network at all. `desiredTick` now leans on this number, which makes a
    // fake one actively harmful rather than merely useless.
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const sock = live();
    sock.open();

    expect(sock.pings().length).toBe(1);
    expect(conn.stats().rttMs).toBe(0); // nothing measured yet

    await vi.advanceTimersByTimeAsync(200);
    sock.answerPings();
    expect(conn.stats().rttMs).toBeCloseTo(200, 5);

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(sock.pings().length).toBe(1);
    conn.stop();
  });

  it('a pong is consumed by the library and never reaches onText', async () => {
    useMonotonicFakeTimers();
    const onText = vi.fn();
    const { conn } = clockRoom({ onText });
    await conn.start();
    const sock = live();
    sock.open();

    await vi.advanceTimersByTimeAsync(120);
    sock.answerPings();
    sock.message(JSON.stringify({ t: 'meta', map: {} }));

    expect(conn.stats().rttMs).toBeCloseTo(120, 5);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith({ t: 'meta', map: {} });
    conn.stop();
  });

  it('the ping timer does not keep a stopped connection alive', async () => {
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const sock = live();
    sock.open();
    const before = sock.sent.length;

    conn.stop();
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 5);
    expect(sock.sent.length).toBe(before);
  });
});

describe('RoomConnection stamping lead', () => {
  it('leads the server tick by the MEASURED round trip plus inputLeadMs, not by a constant', async () => {
    // The lead used to be a flat 4 ticks inside `ClientTick`, with no
    // round-trip term at all: 200ms of total budget at 20Hz and 67ms at 60Hz,
    // so every player above roughly 200ms of RTT stamped every input into a
    // tick the server had already simulated, for the whole session.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom({ inputLeadMs: 100 });
    await conn.start();
    const sock = live();
    sock.open();

    await vi.advanceTimersByTimeAsync(200);
    sock.answerPings();
    expect(conn.stats().rttMs).toBeCloseTo(200, 5);

    deliver({ tick: 900, serverTime: performance.now() });
    // 900 (estimate) + 200/50 (round trip) + ceil(100/50) (jitter lead).
    expect(conn.tick.value).toBe(906);
    conn.stop();
  });

  it('the same room with no measured round trip leads by inputLeadMs alone', async () => {
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom({ inputLeadMs: 100 });
    await conn.start();
    live().open();

    deliver({ tick: 900, serverTime: performance.now() });
    expect(conn.tick.value).toBe(902);
    conn.stop();
  });

  it('onTickReanchor fires with the delta on every anchor except the very first of the lifetime', async () => {
    // `anchorTo` has always returned this number and documented it for exactly
    // this use, and its only caller threw it away, so the one signal that says
    // "your prediction is now wrong by this much" reached nobody.
    useMonotonicFakeTimers();
    const onTickReanchor = vi.fn();
    const { conn, deliver } = clockRoom({ onTickReanchor });
    await conn.start();
    live().open();

    deliver({ tick: 300, serverTime: performance.now() });
    expect(onTickReanchor).not.toHaveBeenCalled(); // nothing has been rendered yet

    // A frame longer than the dt cap unanchors the counter, so the next
    // snapshot is a genuine mid-life re-anchor.
    conn.frame();
    await vi.advanceTimersByTimeAsync(30_000);
    conn.frame();
    deliver({ tick: 900, serverTime: performance.now() });

    expect(onTickReanchor).toHaveBeenCalledTimes(1);
    expect(onTickReanchor.mock.calls[0]![0]).toBeGreaterThan(500);
    conn.stop();
  });
});

describe('RoomConnection re-anchor', () => {
  it('a counter left BEHIND is pulled back to the lead within the re-anchor interval', async () => {
    // A routine 300 to 600ms handoff gap, and every frame the render loop runs
    // longer than the dt cap, leave the counter behind the server by the lost
    // time. The predicate used to fire on the ahead side only, so nothing ever
    // corrected it: measured, the lead stayed inflated by 6 to 12 ticks for the
    // rest of the epoch and every stamped input applied hundreds of
    // milliseconds later than it needed to.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    deliver({ tick: 100, serverTime: performance.now() });
    conn.frame();

    // Frames just under the C6 unanchor threshold, so the ONLY mechanism that
    // can correct the drift here is the behind-side rule. Each one advances the
    // counter by the clamped 250ms while the world advances 290ms.
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(290);
      conn.frame();
    }
    expect(conn.tick.anchored).toBe(true); // never unanchored: this is not the frozen-tab path
    const behindBy = conn.desiredTick() - conn.tick.value;
    expect(behindBy).toBeGreaterThan(4);

    deliver({ tick: 152, serverTime: performance.now() });
    expect(Math.abs(conn.tick.value - conn.desiredTick())).toBeLessThan(1);
    conn.stop();
  });

  it('a frame gap longer than the dt cap unanchors the counter, so the next snapshot re-anchors it', async () => {
    // `frame()` clamps dt and `ClientTick.advance` caps its own step count on
    // top of that, so every millisecond of a backgrounded tab past the cap is
    // DROPPED and the counter comes back that far behind for the rest of the
    // epoch: measured at 591 ticks behind fifteen seconds after a 30 second
    // background, with every stamped input re-stamped on arrival while the
    // host's prediction ran on a different timeline. Nothing was rendered
    // during the gap, so there is no continuity to protect.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    deliver({ tick: 100, serverTime: performance.now() });
    conn.frame();
    expect(conn.tick.anchored).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    conn.frame();
    expect(conn.tick.anchored).toBe(false);

    deliver({ tick: 700, serverTime: performance.now() });
    expect(conn.tick.anchored).toBe(true);
    expect(Math.abs(conn.tick.value - conn.desiredTick())).toBeLessThan(1);
    conn.stop();
  });

  it('a gap only just past the dt cap is a long frame, not an epoch boundary', async () => {
    // The threshold is the cap PLUS one tick, so an ordinary slow frame (a GC
    // pause, one heavy render) keeps its anchor: unanchoring on those would
    // turn every stutter into a correction.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();
    deliver({ tick: 100, serverTime: performance.now() });
    conn.frame();

    await vi.advanceTimersByTimeAsync(290);
    conn.frame();
    expect(conn.tick.anchored).toBe(true);
    conn.stop();
  });

  /**
   * A perfect link on the fake clock: the server's clock IS the local clock,
   * it produces a snapshot every 50ms stamped with its production time and
   * delivered at once, and the render loop runs a frame every 16ms except
   * while `frames` is off (a main-thread hitch: the socket handler still
   * runs, the counter does not). `drift(n)` moves the server's reported tick
   * by `n` from then on, which is what a real drift looks like from here.
   */
  function perfectLink(conn: RoomConnection<DecodedSnapshotLike, string>, deliver: (s: DecodedSnapshotLike) => void) {
    let tick = 100;
    let extra = 0;
    let nextSnapAt = performance.now();
    let nextFrameAt = performance.now();
    return {
      drift(ticks: number): void {
        extra += ticks;
      },
      async run(ms: number, frames = true): Promise<void> {
        const until = performance.now() + ms;
        while (performance.now() < until) {
          await vi.advanceTimersByTimeAsync(2);
          const now = performance.now();
          if (now >= nextSnapAt) {
            deliver({ tick: tick + extra, serverTime: now });
            tick += 1;
            nextSnapAt += 50;
          }
          if (now >= nextFrameAt) {
            if (frames) conn.frame();
            nextFrameAt += 16;
          }
        }
        // The resume frame: the first one after a stall lands when the
        // main thread comes back, not on the old cadence.
        if (!frames) {
          conn.frame();
          nextFrameAt = performance.now() + 16;
        }
      },
    };
  }

  async function steadyLink(onTickReanchor: ReturnType<typeof vi.fn>) {
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom({ onTickReanchor });
    await conn.start();
    live().open();
    const link = perfectLink(conn, deliver);
    // Past the re-anchor interval, so the tolerance path is armed and the
    // only thing standing between a stall and a spurious re-anchor is the
    // decision itself.
    await link.run(2500);
    expect(onTickReanchor).not.toHaveBeenCalled();
    expect(Math.abs(conn.tick.value - conn.desiredTick())).toBeLessThan(2);
    return { conn, link };
  }

  for (const stallMs of [250, 120]) {
    it(`A STALL IS NOT DRIFT: a ${stallMs}ms main-thread hitch on a perfect link produces no re-anchor`, async () => {
      // The counter moves only in `frame()`. Compared raw against `desired`,
      // which keeps running on the server clock, a hitch under the frozen
      // threshold read as +2 to +5 of drift at the snapshots that landed
      // inside it, re-anchored, and then re-anchored BACK two seconds later
      // once the resume frame had stamped the stall's ticks, and every
      // consumer's prediction ate both. The decision now compares the
      // counter projected by the time since the last frame, which is
      // exactly what the resume frame adds.
      const onTickReanchor = vi.fn();
      const { conn, link } = await steadyLink(onTickReanchor);
      await link.run(stallMs, false);
      expect(onTickReanchor).not.toHaveBeenCalled();
      await link.run(2500);
      expect(onTickReanchor).not.toHaveBeenCalled();
      expect(conn.tick.anchored).toBe(true);
      expect(Math.abs(conn.tick.value - conn.desiredTick())).toBeLessThan(2);
      conn.stop();
    });
  }

  it('a genuine 3-tick drift still re-anchors, with frames running and inside a 250ms hitch alike', async () => {
    // The control for the projection: the server's tick moves three ahead
    // of where the local clock says it should be, which no projection of the
    // local counter can explain, so the tolerance path fires as before.
    const onTickReanchor = vi.fn();
    const { conn, link } = await steadyLink(onTickReanchor);
    link.drift(3);
    await link.run(200);
    expect(onTickReanchor).toHaveBeenCalledTimes(1);
    expect(onTickReanchor.mock.calls[0]![0]).toBeGreaterThanOrEqual(2);
    conn.stop();

    // And the projection does not MASK a drift that lands during a stall:
    // the projected counter explains the stall and nothing more.
    const stalled = vi.fn();
    const second = await steadyLink(stalled);
    second.link.drift(3);
    await second.link.run(250, false);
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(stalled.mock.calls[0]![0]).toBeGreaterThanOrEqual(2);
    second.conn.stop();
  });
});

describe('RoomConnection server-depth feedback', () => {
  async function feed(
    deliver: (s: DecodedSnapshotLike) => void,
    conn: RoomConnection<DecodedSnapshotLike, string>,
    count: number,
    startTick: number,
    inputLead?: number,
  ): Promise<number> {
    let tick = startTick;
    for (let i = 0; i < count; i++) {
      await vi.advanceTimersByTimeAsync(50);
      deliver({ tick, serverTime: performance.now(), inputLead });
      conn.frame();
      tick++;
    }
    return tick;
  }

  it('trims the lead when the host echoes back a server buffer that is running early', async () => {
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom({ inputLeadMs: 100 });
    await conn.start();
    live().open();

    let tick = await feed(deliver, conn, 4, 100, 10);
    const leadBefore = conn.desiredTick() - conn.estimateServerTick();
    expect(leadBefore).toBeCloseTo(2, 5); // ceil(100/50), nothing measured yet

    tick = await feed(deliver, conn, 60, tick, 10);
    const leadAfter = conn.desiredTick() - conn.estimateServerTick();
    expect(leadAfter).toBeLessThan(leadBefore);
    expect(leadAfter).toBeCloseTo(0, 5); // clamped at -leadTicks, so the floor is zero lead
    conn.stop();
  });

  it('is inert when the snapshot does not carry the field, and the RTT-compensated lead applies alone', async () => {
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom({ inputLeadMs: 100 });
    await conn.start();
    live().open();

    let tick = await feed(deliver, conn, 4, 100);
    const leadBefore = conn.desiredTick() - conn.estimateServerTick();
    tick = await feed(deliver, conn, 60, tick);
    expect(conn.desiredTick() - conn.estimateServerTick()).toBeCloseTo(leadBefore, 5);
    conn.stop();
  });

  it('a reconnect resets the feedback, because a new server has its own buffer', async () => {
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom({ inputLeadMs: 100 });
    await conn.start();
    live().open();

    await feed(deliver, conn, 64, 100, 10);
    expect(conn.desiredTick() - conn.estimateServerTick()).toBeCloseTo(0, 5);

    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    live().open();
    deliver({ tick: 900, serverTime: performance.now() });
    expect(conn.desiredTick() - conn.estimateServerTick()).toBeCloseTo(2, 5);
    conn.stop();
  });
});

// ---------------------------------------------------------------------------
// The ladder: cancellation, unhandled throws, deadlines, tokens and sessions.
// ---------------------------------------------------------------------------

describe('RoomConnection attempt generation', () => {
  it('a stop() from inside onStatus("connecting") cannot be followed by a socket', async () => {
    // Measured: the socket was created AFTER the stop, opened, and delivered
    // snapshots into a connection nothing could stop again, because `stop()`
    // had already latched and returns early on the second call.
    //
    // ON A RECONNECT, WHICH IS THE PATH THAT HAD NO CHECK AT ALL. A first
    // connect goes through `mint()`, and there has always been a re-entrancy
    // check on the far side of that await; an ordinary reconnect reuses the
    // session on hand and ran from `setStatus('connecting')` to
    // `new Impl(url)` with nothing in between. Asserting this on a first
    // connect would pass against the old code too.
    vi.useFakeTimers();
    let stopOnConnecting = false;
    let conn!: RoomConnection<DecodedSnapshotLike, string>;
    conn = new RoomConnection<DecodedSnapshotLike, string>({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onStatus: (s) => {
        if (s === 'connecting' && stopOnConnecting) {
          stopOnConnecting = false;
          conn.stop();
        }
      },
    });

    await conn.start();
    live().open();
    expect(FakeSocket.instances.length).toBe(1);

    stopOnConnecting = true;
    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(FakeSocket.instances.length).toBe(1);
    expect(conn.status).toBe('idle');
  });

  it('a stop() and start() during a slow mint leaves the stale attempt with no socket and no ladder', async () => {
    // The stale attempt used to open its own socket for the abandoned start,
    // and if its mint REJECTED instead, its `scheduleReconnect` tore down the
    // healthy new socket the second start had already established.
    vi.useFakeTimers();
    const mints: ((s: SessionInfo) => void)[] = [];
    const rejects: ((e: unknown) => void)[] = [];
    const conn = new RoomConnection({
      tickHz: 20,
      mint: () =>
        new Promise<SessionInfo>((resolve, reject) => {
          mints.push(resolve);
          rejects.push(reject);
        }),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
    });

    const first = conn.start();
    conn.stop();
    const second = conn.start();

    // The SECOND mint resolves and gets its socket.
    mints[1]!(makeSession());
    await second;
    expect(FakeSocket.instances.length).toBe(1);

    // The first, abandoned mint now rejects. Its `scheduleReconnect` must not
    // run: there is exactly one live socket and no timer waiting to replace it.
    rejects[0]!(new Error('too late'));
    await first;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.instances.length).toBe(1);
    expect(conn.stats().reconnects).toBe(0);
    conn.stop();
  });
});

describe('RoomConnection connect failures', () => {
  it('a throw after the mint schedules a reconnect instead of becoming an unhandled rejection, and latches after three', async () => {
    // `scheduleReconnect` runs `void this.connectOnce(...)`, so a throw here (a
    // host `socketUrl` dereferencing a field its session does not carry, a
    // `WebSocket` constructor refusing a URL) used to kill the ladder outright:
    // no timer, no terminal, status stuck on 'connecting' forever. Measured.
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => {
        throw new Error('host bug');
      },
      onTerminal,
    });

    await conn.start();
    expect(FakeSocket.instances.length).toBe(0);
    expect(onTerminal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100); // second attempt, at RECONNECT_BASE_MS
    expect(onTerminal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200); // third attempt, which latches
    expect(onTerminal).toHaveBeenCalledWith('connect-error');
    expect(conn.status).toBe('closed');
  });

  it('a mint that never settles is abandoned at connectTimeoutMs and takes the ordinary ladder', async () => {
    vi.useFakeTimers();
    let mintCalls = 0;
    const conn = new RoomConnection({
      tickHz: 20,
      mint: () => {
        mintCalls++;
        return new Promise<SessionInfo>(() => {
          /* never settles */
        });
      },
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      connectTimeoutMs: 3_000,
    });

    const started = conn.start();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(conn.stats().reconnects).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await started;
    expect(conn.stats().reconnects).toBe(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(mintCalls).toBe(2);
    conn.stop();
  });

  it('a socket that never opens is closed at connectTimeoutMs and counts as a pre-open failure', async () => {
    vi.useFakeTimers();
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      connectTimeoutMs: 3_000,
    });

    await conn.start();
    const first = live();
    expect(FakeSocket.instances.length).toBe(1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(first.readyState).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(first.readyState).toBe(3);
    expect(conn.status).toBe('closed');

    await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.instances.length).toBe(2);
    conn.stop();
  });
});

describe('RoomConnection session validation', () => {
  it('the FIRST start() rejects with a descriptive error when mint() returns something unusable', async () => {
    // A 401 body is JSON too, and it used to BECOME the session: every URL was
    // then built with a literal `undefined` and the ladder looped forever with
    // no terminal and nothing to read.
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue({ error: 'unauthorized' } as unknown as SessionInfo),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
    });

    await expect(conn.start()).rejects.toThrow(/unusable session/);
    expect(FakeSocket.instances.length).toBe(0);
  });

  it.each([
    ['a missing token', { playerId: 'p', handle: 1, room: 'r' }],
    ['an empty token', { token: '', playerId: 'p', handle: 1, room: 'r' }],
    ['a non-finite handle', { token: 't', playerId: 'p', handle: NaN, room: 'r' }],
    ['a missing room', { token: 't', playerId: 'p', handle: 1 }],
  ])('rejects %s', async (_label, session) => {
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(session as unknown as SessionInfo),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
    });
    await expect(conn.start()).rejects.toThrow(/unusable session/);
  });

  it('three consecutive unusable re-mints latch mint-failed rather than looping', async () => {
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    let good = true;
    const conn = new RoomConnection({
      tickHz: 20,
      mint: async () => (good ? makeSession() : ({ error: 'nope' } as unknown as SessionInfo)),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      connectTimeoutMs: 60_000,
      onTerminal,
    });

    await conn.start();
    good = false;

    // Three pre-open failures force a fresh mint, and every mint from here is
    // unusable.
    for (let i = 0; i < 8; i++) {
      const sock = FakeSocket.instances[FakeSocket.instances.length - 1];
      if (sock && sock.readyState !== 3) sock.remoteClose(1006);
      await vi.advanceTimersByTimeAsync(10_000);
      if (onTerminal.mock.calls.length > 0) break;
    }

    expect(onTerminal).toHaveBeenCalledWith('mint-failed');
  });
});

describe('RoomConnection expired token', () => {
  it('a 4001 BEFORE this epoch delivered anything reconnects, and three of them force a fresh mint', async () => {
    // The node adapter verifies the token AFTER the upgrade and closes 4001, so
    // a session older than the host's `maxAgeS` (12 hours by default) used to
    // end the game on the next network blip: the client latched
    // 'closed-by-server' and never re-minted.
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    let mintCount = 0;
    const conn = new RoomConnection({
      tickHz: 20,
      mint: async () => {
        mintCount++;
        return makeSession({ token: `tok-${mintCount}` });
      },
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: (s) => `ws://x?tok=${s.token}`,
      connectTimeoutMs: 60_000,
      onTerminal,
    });

    await conn.start();
    for (let i = 0; i < 3; i++) {
      const sock = live();
      sock.open();
      sock.remoteClose(4001);
      expect(onTerminal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
    }

    expect(mintCount).toBe(2);
    expect(live().url).toContain('tok-2');

    // ...and the fresh token being refused too IS an answer, so that one
    // latches rather than looping.
    const fresh = live();
    fresh.open();
    fresh.remoteClose(4001);
    expect(onTerminal).toHaveBeenCalledWith('closed-by-server');
  });

  it('a 4001 AFTER the epoch has delivered is a deliberate kick and latches immediately', async () => {
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    const { conn, deliver } = clockRoom({ onTerminal });
    await conn.start();
    const sock = live();
    sock.open();
    deliver({ tick: 5, serverTime: performance.now() });

    sock.remoteClose(4001);
    expect(onTerminal).toHaveBeenCalledWith('closed-by-server');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.instances.length).toBe(1);
  });
});

describe('RoomConnection restart after a terminal', () => {
  it('start() after a terminal reconnects, and remint drops the session so mint() runs again', async () => {
    // `start()` returned early unless `stopped`, so calling it from
    // `onTerminal` did nothing at all, and a `stop()` first still reused the
    // private session. The bounded re-assign loop the balancer exists for
    // ("this room is full, ask for another and reconnect") could not be written
    // against this class.
    vi.useFakeTimers();
    let mintCount = 0;
    let tries = 0;
    let conn!: RoomConnection<DecodedSnapshotLike, string>;
    conn = new RoomConnection<DecodedSnapshotLike, string>({
      tickHz: 20,
      mint: async () => {
        mintCount++;
        return makeSession({ token: `tok-${mintCount}`, room: `r${mintCount}` });
      },
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: (s) => `ws://x?room=${s.room}`,
      onTerminal: (reason) => {
        if (reason === 'capacity' && tries++ < 2) void conn.start({ remint: true });
      },
    });

    await conn.start();
    expect(live().url).toContain('room=r1');

    live().open();
    live().remoteClose(4002);
    await vi.advanceTimersByTimeAsync(0);
    expect(mintCount).toBe(2);
    expect(live().url).toContain('room=r2');

    live().open();
    live().remoteClose(4002);
    await vi.advanceTimersByTimeAsync(0);
    expect(mintCount).toBe(3);
    expect(live().url).toContain('room=r3');

    // The third refusal is not retried, and the terminal stands.
    live().open();
    live().remoteClose(4002);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.instances.length).toBe(3);
    conn.stop();
  });

  it('a plain start() after a terminal keeps the session it already has', async () => {
    vi.useFakeTimers();
    let mintCount = 0;
    const conn = new RoomConnection({
      tickHz: 20,
      mint: async () => {
        mintCount++;
        return makeSession({ token: `tok-${mintCount}` });
      },
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: (s) => `ws://x?tok=${s.token}`,
    });

    await conn.start();
    live().open();
    live().remoteClose(4002);

    await conn.start();
    expect(mintCount).toBe(1);
    expect(live().url).toContain('tok-1');
    expect(conn.status).toBe('connecting');
    conn.stop();
  });
});

// ---------------------------------------------------------------------------
// Framing, decoding and the relay's own lifetime cap.
// ---------------------------------------------------------------------------

describe('RoomConnection binary framing', () => {
  it('decodes an ArrayBufferView from its OWN window, not from its backing buffer', async () => {
    // Node pools small allocations behind one 8KB `ArrayBuffer`, so a `Buffer`
    // handed to `onmessage` is a VIEW into a much larger buffer. Passing
    // `data.buffer` whole handed the decoder 8192 bytes that are mostly
    // somebody else's: measured as a snapshot of zeros.
    const seen: number[][] = [];
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: (buf) => {
        seen.push([...new Uint8Array(buf)]);
        return { tick: 1, serverTime: Date.now() };
      },
    });

    await conn.start();
    live().open();

    const pool = new Uint8Array(64);
    pool.fill(0xff);
    pool.set([1, 2, 3, 4], 16);
    live().message(new Uint8Array(pool.buffer, 16, 4));

    expect(seen).toEqual([[1, 2, 3, 4]]);
    conn.stop();
  });
});

describe('RoomConnection version skew', () => {
  it('a decoder that THROWS ProtocolVersionError takes the skew path, not the silent-drop path', async () => {
    // Skew recovery used to run only off a RETURNED `decoded.version`, and the
    // shipped codecs THROW on a version mismatch, which the catch around
    // `decodeSnapshot` swallowed. A deploy that bumped the wire therefore left
    // every old client dropping every frame with nothing reloading, nothing
    // latching and every other signal reading healthy.
    const onTerminal = vi.fn();
    class ProtocolVersionError extends Error {
      override name = 'ProtocolVersionError';
    }
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: () => {
        throw new ProtocolVersionError('wire 3, this bundle speaks 2');
      },
      onTerminal,
    });

    await conn.start();
    const sock = live();
    sock.open();
    sock.message(new ArrayBuffer(4));

    expect(onTerminal).toHaveBeenCalledWith('version-skew');
    expect(sock.readyState).toBe(3);
    conn.stop();
  });

  it('any OTHER decoder throw is still swallowed as one dropped frame', async () => {
    const onTerminal = vi.fn();
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: () => {
        throw new RangeError('truncated payload');
      },
      onTerminal,
    });

    await conn.start();
    const sock = live();
    sock.open();
    sock.message(new ArrayBuffer(4));

    expect(onTerminal).not.toHaveBeenCalled();
    expect(sock.readyState).toBe(1);
    conn.stop();
  });
});

describe('RoomConnection warm swap', () => {
  it('swaps onto a replacement socket at the relay lifetime cap, without starting a new epoch', async () => {
    // The relay holding this socket dies at its own platform duration cap
    // (800s on Vercel), so EVERY socket in EVERY room reconnects roughly every
    // thirteen minutes whether anything is wrong or not, and a reconnect blanks
    // every remote entity and makes the interpolator re-seed its delay. Same
    // room, same server timeline, same tick anchor: an epoch change would throw
    // all of that away and produce exactly the gap this removes.
    useMonotonicFakeTimers();
    const onTickReanchor = vi.fn();
    const onText = vi.fn();
    const { conn, deliver } = clockRoom({ onTickReanchor, onText });
    await conn.start();
    const original = live();
    original.open();

    let tick = 400;
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(i % 2 === 0 ? 40 : 60); // uneven, so jitter is measurable
      deliver({ tick: tick++, serverTime: performance.now() });
      conn.frame();
    }
    const jitterBefore = conn.stats().jitterMs;
    const anchorBefore = conn.tick.value;
    expect(jitterBefore).toBeGreaterThan(0);
    expect(conn.stats().relaySwaps).toBe(0);

    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 5000 }));
    expect(onText).not.toHaveBeenCalled(); // library bookkeeping, not the host's
    expect(FakeSocket.instances.length).toBe(2);
    const replacement = live();
    expect(replacement).not.toBe(original);

    // Opening alone is not enough: a relay that accepted the upgrade and then
    // failed its own bus subscription is open and useless.
    replacement.open();
    expect(conn.stats().relaySwaps).toBe(0);
    expect(original.readyState).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    deliver({ tick: tick++, serverTime: performance.now() });

    expect(conn.stats().relaySwaps).toBe(1);
    expect(original.readyState).toBe(3); // the old socket is closed, after the swap, not before
    expect(replacement.readyState).toBe(1);
    // NOT a new epoch: the anchor, the clock and the arrival history all
    // continue, so there is no correction for a host to absorb.
    expect(conn.tick.anchored).toBe(true);
    expect(conn.tick.value).toBeGreaterThanOrEqual(anchorBefore);
    expect(onTickReanchor).not.toHaveBeenCalled();
    expect(conn.stats().snapshotsReceived).toBe(21);
    // ...but a DIFFERENT RELAY IS A DIFFERENT PATH, so the arrival-shaped
    // gauges do reset even though the epoch does not. Carrying them meant a
    // replacement that took two seconds to subscribe reported the handover's
    // shape (jitter 458ms, underrun 0.51) as the fresh socket's health.
    expect(jitterBefore).toBeGreaterThan(0);
    expect(conn.stats().jitterMs).toBe(0);
    expect(conn.stats().underrunRate).toBe(0);

    // The old socket's own 4004 arrives afterwards and is inert.
    original.remoteClose(4004);
    expect(conn.status).toBe('open');
    conn.stop();
  });

  it('a replacement that dies before delivering costs nothing, and the old socket keeps the ordinary ladder', async () => {
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const original = live();
    original.open();

    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 5000 }));
    const replacement = live();
    replacement.remoteClose(1006);

    expect(conn.stats().relaySwaps).toBe(0);
    expect(conn.status).toBe('open');
    expect(original.readyState).toBe(1);

    // The relay closes at its cap and the ordinary reconnect takes over.
    original.remoteClose(4004);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBe(3);
    conn.stop();
  });

  it('a replacement is given the sooner of connectTimeoutMs and the announced close', async () => {
    // `connectTimeoutMs` defaults to 10s while `relay-expiring` leads the close
    // by `RELAY_EXPIRY_LEAD_MS` (5s), so a replacement holding the full connect
    // deadline OUTLIVES the socket it exists to replace: the old socket's 4004
    // lands first, `handleClose` discards the swap, and the ordinary cold
    // reconnect runs anyway, which is the exact gap the swap exists to remove.
    useMonotonicFakeTimers();
    const { conn } = clockRoom({ connectTimeoutMs: 10_000 });
    await conn.start();
    const original = live();
    original.open();

    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 1_500 }));
    const replacement = live();
    replacement.open();

    await vi.advanceTimersByTimeAsync(1_499);
    expect(replacement.readyState).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(replacement.readyState).toBe(3);
    expect(conn.stats().relaySwaps).toBe(0);
    expect(original.readyState).toBe(1); // the live socket is untouched
    conn.stop();
  });

  it('a replacement that never delivers is discarded at connectTimeoutMs', async () => {
    useMonotonicFakeTimers();
    const { conn } = clockRoom({ connectTimeoutMs: 3_000 });
    await conn.start();
    const original = live();
    original.open();

    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 9_000 }));
    const replacement = live();
    replacement.open();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(replacement.readyState).toBe(3);
    expect(conn.stats().relaySwaps).toBe(0);
    expect(original.readyState).toBe(1);

    // ...and a second announcement can still start a fresh attempt, once the
    // one-swap-per-lead-window limit has aged out.
    await vi.advanceTimersByTimeAsync(2_100);
    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 9_000 }));
    expect(FakeSocket.instances.length).toBe(3);
    conn.stop();
  });
});

describe('RoomConnection stats', () => {
  it('a new epoch resets the GAUGES and deliberately not the COUNTERS', async () => {
    // Measured: the first snapshot of a new epoch reported a jitter of 435ms
    // and an underrun rate of 0.49, both of them the shape of the OUTAGE rather
    // than of the fresh socket, which is the worst possible moment to be
    // reporting a sick connection. Same split the interpolator's `clear()`
    // already makes.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    let tick = 10;
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(i % 2 === 0 ? 20 : 400);
      deliver({ tick: tick++, serverTime: performance.now() });
    }
    deliver({ tick: NaN, serverTime: performance.now() });

    const before = conn.stats();
    expect(before.jitterMs).toBeGreaterThan(0);
    expect(before.underrunRate).toBeGreaterThan(0);
    expect(before.snapshotsReceived).toBe(10);
    expect(before.rejectedSnapshots).toBe(1);

    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    live().open();

    const after = conn.stats();
    expect(after.jitterMs).toBe(0);
    expect(after.underrunRate).toBe(0);
    expect(after.snapshotsReceived).toBe(10);
    expect(after.rejectedSnapshots).toBe(1);
    expect(after.reconnects).toBe(1);
    conn.stop();
  });
});

// ---------------------------------------------------------------------------
// What an adversarial pass over this class found, each one a defect that a
// green suite over the mechanism it belongs to did not see.
// ---------------------------------------------------------------------------

describe('RoomConnection terminal ordering', () => {
  it('a restart from inside onTerminal keeps its socket, reads connecting, and still has a ladder', async () => {
    // `onTerminal` used to fire BEFORE the teardown, and `start()` reaches
    // `new Impl(url)` synchronously whenever a session is already on hand, so
    // the documented restart recipe installed its socket on `this.ws` and the
    // teardown queued behind the callback then closed that brand new socket and
    // nulled the field. Its own `onclose` hit the `this.ws !== socket` guard, so
    // nothing scheduled a reconnect either. Measured on the TEXT-FRAME path:
    // two sockets, the restart's readyState 3, reconnects 0, dead for good,
    // while the identical restart driven by the bare 4002 close code survived.
    vi.useFakeTimers();
    let restarts = 0;
    let conn!: RoomConnection<DecodedSnapshotLike, string>;
    conn = new RoomConnection<DecodedSnapshotLike, string>({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onTerminal: (r) => {
        if (r === 'capacity' && restarts++ === 0) void conn.start();
      },
    });

    await conn.start();
    const first = live();
    first.open();
    first.message(JSON.stringify({ t: 'room-full' }));

    expect(FakeSocket.instances.length).toBe(2);
    const restarted = live();
    expect(restarted).not.toBe(first);
    expect(first.readyState).toBe(3); // the refused socket IS closed
    expect(restarted.readyState).not.toBe(3); // ...and the replacement is not
    // The status change is part of the sequence, so it has already settled when
    // the host restarts: reading 'closed' here would describe the connection
    // the host just replaced.
    expect(conn.status).toBe('connecting');

    // ...and it is a live connection rather than a corpse: it opens, and when
    // it drops it still has a ladder.
    restarted.open();
    expect(conn.status).toBe('open');
    restarted.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBe(3);
    conn.stop();
  });

  it('a second terminal for one logical event still tears down, and still tells the host once', async () => {
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onTerminal,
    });

    await conn.start();
    live().open();
    live().message(JSON.stringify({ t: 'room-full' }));
    conn.stop(); // a deliberate stop on top of an already latched terminal

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith('capacity');
    expect(conn.status).toBe('idle');
  });
});

/**
 * Produce one honest round-trip sample of exactly `delayMs`. The pong has to
 * carry a ping this client actually sent, echoed verbatim, because anything
 * else is now refused; and the render loop has to be running when it lands,
 * because a pong the loop froze across is refused too.
 */
async function honestPong(conn: RoomConnection<DecodedSnapshotLike, string>, sock: FakeSocket, delayMs: number): Promise<void> {
  // Advance to the NEXT ping boundary exactly, rather than by one interval:
  // waiting out the round trip each round otherwise walks the phase forward
  // and every later sample carries the accumulated drift.
  const sent = sock.pings();
  const lastAt = sent.length > 0 ? sent[sent.length - 1]!.c : performance.now();
  await vi.advanceTimersByTimeAsync(Math.max(0, lastAt + PING_INTERVAL_MS - performance.now()));
  conn.frame();
  const pings = sock.pings();
  const ping = pings[pings.length - 1]!;
  await vi.advanceTimersByTimeAsync(delayMs);
  conn.frame();
  sock.message(JSON.stringify({ t: 'pong', n: ping.n, c: ping.c }));
}

describe('RoomConnection round-trip contamination', () => {
  it('discards a pong the local render loop froze across, and accepts the next honest one', async () => {
    // The sample includes OUR OWN queueing, so a stopped render loop measures
    // this tab and not the network. `desiredTick()` leans on this number, so a
    // three second freeze on a 20ms link put rttMs at 935, snapped the counter
    // 18 ticks forward and spent about twenty seconds unwinding it.
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const sock = live();
    sock.open();
    conn.frame();

    await vi.advanceTimersByTimeAsync(3_000); // frozen: not one frame() call
    sock.answerPings();
    expect(conn.stats().rttMs).toBe(0); // nothing measured, rather than 3000

    conn.frame(); // the loop is running again
    await vi.advanceTimersByTimeAsync(1_000); // a fresh ping goes out at t=4000
    conn.frame();
    await vi.advanceTimersByTimeAsync(30);
    sock.answerPings();
    expect(conn.stats().rttMs).toBeCloseTo(30, 5);
    conn.stop();
  });

  it('a single slow or hostile echo cannot move the reported round trip', async () => {
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const sock = live();
    sock.open();

    conn.frame();
    for (let i = 0; i < 3; i++) await honestPong(conn, sock, 20);
    expect(conn.stats().rttMs).toBeCloseTo(20, 5);

    // Under the ceiling, so only the sliding-window MINIMUM refuses it.
    await honestPong(conn, sock, 4_000);
    expect(conn.stats().rttMs).toBeCloseTo(20, 5);

    // ...and one past the ceiling is refused outright, which is what keeps it
    // out of the window in the first place.
    await honestPong(conn, sock, 6_000);
    expect(conn.stats().rttMs).toBeCloseTo(20, 5);
    conn.stop();
  });

  it('a sustained rise on a worsening path IS followed, so the minimum is not a floor forever', async () => {
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const sock = live();
    sock.open();

    conn.frame();
    for (let i = 0; i < 3; i++) await honestPong(conn, sock, 20);
    expect(conn.stats().rttMs).toBeCloseTo(20, 5);

    for (let i = 0; i < RTT_WINDOW_SIZE; i++) await honestPong(conn, sock, 180);
    expect(conn.stats().rttMs).toBeCloseTo(180, 5);
    conn.stop();
  });
});

describe('RoomConnection held poses are scoped', () => {
  function heldRoom(interp: SnapshotInterpolator<string>, mint: () => Promise<SessionInfo>) {
    return new RoomConnection({
      tickHz: 20,
      mint,
      WebSocketImpl: IMPL,
      socketUrl: (s) => `ws://x?room=${s.room}`,
      decodeSnapshot: () => ({ tick: 100, serverTime: Date.now(), players: [{ id: 'p2', x: 7, y: 9 }] }),
      interpolate: {
        into: interp,
        entities: (snap) => new Map(snap.players.map((p) => [p.id, { x: p.x, y: p.y }])),
      },
    });
  }

  it('a terminal ends the hold, so a refused connection cannot leave a ghost on screen', async () => {
    // Ten minutes after a capacity terminal the host was still drawing the last
    // pose it ever saw, with `stalled` false, because the hold only ever asked
    // whether the epoch had delivered.
    vi.useFakeTimers();
    const interp = new SnapshotInterpolator<string>();
    const conn = heldRoom(interp, vi.fn().mockResolvedValue(makeSession()));

    await conn.start();
    live().open();
    live().message(new ArrayBuffer(8));
    expect(conn.frame(1000).entities.has('p2')).toBe(true);

    // The hold is only what is drawing once the buffer has been cleared, which
    // is a reconnect. That is also exactly where the ghost was measured: the
    // reconnect goes on to be REFUSED.
    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    const heldFrame = conn.frame(2000).entities.get('p2');
    expect(heldFrame?.extrapolated).toBe(true);

    live().open();
    live().remoteClose(4002);
    expect(conn.frame(2100).entities.size).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(conn.frame(602_100).entities.size).toBe(0);
  });

  it('a forced re-mint into a DIFFERENT room drops the held poses', async () => {
    // The reachable path: three pre-open failures force a fresh mint, the
    // balancer answers with another room, and room A's players were drawn over
    // room B until B's first snapshot.
    vi.useFakeTimers();
    let mintCount = 0;
    const interp = new SnapshotInterpolator<string>();
    const conn = heldRoom(interp, async () => {
      mintCount++;
      return makeSession({ room: `r${mintCount}` });
    });

    await conn.start();
    live().open();
    live().message(new ArrayBuffer(8));
    expect(conn.frame(1000).entities.has('p2')).toBe(true);

    // Reconnects INTO THE SAME ROOM keep the poses: that is what the hold is
    // for, and it is what makes the assertion below about the ROOM rather than
    // about reconnecting. Three of them are needed to force a re-mint, and the
    // FIRST close does not count toward that because its socket had opened.
    for (let i = 0; i < 3; i++) {
      live().remoteClose(1006);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(conn.frame(2000 + i * 1000).entities.has('p2')).toBe(true);
      expect(mintCount).toBe(1);
    }

    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mintCount).toBe(2);
    expect(live().url).toContain('room=r2');
    expect(conn.frame(9000).entities.size).toBe(0);
    conn.stop();
  });
});

describe('RoomConnection restart from a terminal', () => {
  it('an unusable re-mint from inside onTerminal latches mint-failed instead of rejecting', async () => {
    // The recipe this class documents is `void conn.start({ remint: true })`,
    // and a rejected promise nobody holds is an unhandled rejection plus a
    // connection that latched nothing, so `'mint-failed'` was unreachable on
    // the one path a host actually writes.
    vi.useFakeTimers();
    const seen: string[] = [];
    let good = true;
    let restart: Promise<void> | null = null;
    let conn!: RoomConnection<DecodedSnapshotLike, string>;
    conn = new RoomConnection<DecodedSnapshotLike, string>({
      tickHz: 20,
      mint: async () => (good ? makeSession() : ({ error: 'nope' } as unknown as SessionInfo)),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      connectTimeoutMs: 60_000,
      onTerminal: (r) => {
        seen.push(r);
        if (r === 'capacity') {
          good = false;
          restart = conn.start({ remint: true });
        }
      },
    });

    await conn.start();
    live().open();
    live().remoteClose(4002);

    // The restart RESOLVES. It is `void`ed in the recipe, so a rejection here
    // is an unhandled rejection and nothing else.
    await expect(restart!).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toEqual(['capacity', 'mint-failed']);
  });

  it('a first, awaited start() still throws on an unusable session', async () => {
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue({ error: 'unauthorized' } as unknown as SessionInfo),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
    });
    await expect(conn.start()).rejects.toThrow(/unusable session/);
  });
});

describe('RoomConnection host callbacks cannot break it', () => {
  it('a throwing onStatus cannot kill the reconnect ladder', async () => {
    // `onStatus` is called from the close handler one line before
    // `scheduleReconnect()`, so a throw in it turned a routine drop into a
    // connection that never tried again.
    vi.useFakeTimers();
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onStatus: () => {
        throw new Error('host bug');
      },
    });

    await conn.start();
    live().open();
    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBe(2);
    conn.stop();
  });

  it('the reconnect is already scheduled when the close status is announced', async () => {
    // Two independent defences rather than one behind the other: `emit()` stops
    // a throw, and scheduling first means that even an unwrapped announcement
    // could not have taken the ladder with it.
    //
    // THE OBVIOUS WAY TO TEST THIS IS VACUOUS, and it was written that way
    // first: throwing from `onStatus` and then counting sockets cannot see the
    // ordering at all, because `emit()` swallows the throw and the ladder
    // survives either way. The ordering IS directly observable, though, from
    // inside the callback itself: by the time the host is told the socket
    // closed, the retry it is about to ask about has already been booked.
    vi.useFakeTimers();
    let reconnectsAtClose = -1;
    let conn!: RoomConnection<DecodedSnapshotLike, string>;
    conn = new RoomConnection<DecodedSnapshotLike, string>({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onStatus: (s) => {
        if (s === 'closed') reconnectsAtClose = conn.stats().reconnects;
      },
    });

    await conn.start();
    live().open();
    live().remoteClose(1006);
    expect(reconnectsAtClose).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBe(2);
    conn.stop();
  });

  it('a throwing interpolate.entities costs the push only, and is counted', async () => {
    // It was the ONE call out of this class that ran bare, and it is the
    // expensive one to lose: a throw escaped `onmessage`, so it cost the push
    // AND `onSnapshot`, while the frame had already been counted on
    // `snapshotsReceived` and so did not even read as a dropped frame.
    useMonotonicFakeTimers();
    const seen: number[] = [];
    const interp = new SnapshotInterpolator<string>();
    const push = vi.spyOn(interp, 'push');
    const conn = new RoomConnection<DecodedSnapshotLike, string>({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: () => ({ tick: 400, serverTime: performance.now() }),
      interpolate: {
        into: interp,
        entities: () => {
          throw new Error('host bug');
        },
      },
      onSnapshot: (snap) => void seen.push(snap.tick),
    });

    await conn.start();
    const sock = live();
    sock.open();
    sock.message(new ArrayBuffer(4));
    await vi.advanceTimersByTimeAsync(50);
    sock.message(new ArrayBuffer(4));

    expect(push).not.toHaveBeenCalled(); // nothing half-built reached the buffer
    expect(seen).toEqual([400, 400]); // ...and the rest of the frame still happened
    expect(conn.stats().hostErrors).toBe(2);
    expect(conn.stats().snapshotsReceived).toBe(2);
    expect(conn.tick.anchored).toBe(true);
    conn.stop();
  });

  it('counts every swallowed host throw, so a silent bug is at least visible', async () => {
    useMonotonicFakeTimers();
    const conn = new RoomConnection<DecodedSnapshotLike, string>({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: () => ({ tick: 400, serverTime: performance.now() }),
      onSnapshot: () => {
        throw new Error('host bug');
      },
      onText: () => {
        throw new Error('host bug');
      },
    });

    await conn.start();
    const sock = live();
    sock.open();
    expect(conn.stats().hostErrors).toBe(0);
    sock.message(new ArrayBuffer(4));
    sock.message(JSON.stringify({ t: 'meta', map: {} }));
    expect(conn.stats().hostErrors).toBe(2);
    conn.stop();
  });

  it('every host callback can throw and the connection still runs', async () => {
    useMonotonicFakeTimers();
    const boom = (): never => {
      throw new Error('host bug');
    };
    const interp = new SnapshotInterpolator<string>();
    const conn = new RoomConnection<DecodedSnapshotLike, string>({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: () => ({ tick: 400, serverTime: performance.now() }),
      interpolate: { into: interp, entities: () => new Map() },
      onSnapshot: boom,
      onText: boom,
      onStatus: boom,
      onStallChange: boom,
      onTickReanchor: boom,
      onTerminal: boom,
    });

    await conn.start();
    const sock = live();
    sock.open();
    sock.message(new ArrayBuffer(4));
    sock.message(JSON.stringify({ t: 'meta', map: {} }));
    conn.frame();
    await vi.advanceTimersByTimeAsync(30_000); // a frozen frame, so the re-anchor callback runs too
    conn.frame();
    sock.message(new ArrayBuffer(4));
    expect(conn.stats().snapshotsReceived).toBe(2);
    expect(conn.tick.anchored).toBe(true);

    sock.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBe(2);
    conn.stop();
  });
});

describe('RoomConnection gauge scope', () => {
  it('the round trip does not survive a new epoch, because it led the counter by a dead path', async () => {
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const sock = live();
    sock.open();
    conn.frame();
    await vi.advanceTimersByTimeAsync(400);
    conn.frame();
    sock.answerPings();
    expect(conn.stats().rttMs).toBeGreaterThan(300);

    sock.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conn.stats().rttMs).toBe(0);
    conn.stop();
  });
});

describe('RoomConnection warm swap is rate limited', () => {
  it('a flood of relay-expiring frames opens at most one replacement per lead window', async () => {
    // The frame is a server-controlled socket-open primitive. Measured at 201
    // sockets in ten seconds from `{ t: 'relay-expiring', inMs: 1 }` at 20Hz.
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const original = live();
    original.open();

    for (let i = 0; i < 40; i++) {
      original.message(JSON.stringify({ t: 'relay-expiring', inMs: 1 }));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(FakeSocket.instances.length).toBe(2); // exactly one replacement in 2s

    await vi.advanceTimersByTimeAsync(4_000); // past RELAY_EXPIRY_LEAD_MS since the first
    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 1 }));
    expect(FakeSocket.instances.length).toBe(3);
    conn.stop();
  });

  it('the swap deadline is floored, so a relay claiming a 1ms close cannot discard every replacement', async () => {
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const original = live();
    original.open();

    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 1 }));
    const replacement = live();
    replacement.open();

    await vi.advanceTimersByTimeAsync(900);
    expect(replacement.readyState).toBe(1); // still being given a chance

    await vi.advanceTimersByTimeAsync(50);
    deliverTo(replacement);
    expect(conn.stats().relaySwaps).toBe(1);
    conn.stop();
  });
});

describe('RoomConnection snapshot plausibility', () => {
  it('refuses a snapshot stamped implausibly far from the server clock', async () => {
    // FINITE IS NOT PLAUSIBLE. One frame stamped a year in the past made
    // `estimateServerTick()` return 6.3e8, and arriving as the first frame
    // after a frozen-render unanchor it ANCHORED the counter to 1e12 and handed
    // the host a 1e12 `onTickReanchor` delta to fold into its prediction.
    useMonotonicFakeTimers();
    const onTickReanchor = vi.fn();
    const { conn, deliver } = clockRoom({ onTickReanchor });
    await conn.start();
    live().open();

    deliver({ tick: 100, serverTime: performance.now() });
    const sane = conn.estimateServerTick();

    conn.frame();
    await vi.advanceTimersByTimeAsync(30_000); // a frozen render loop: the counter is unanchored
    conn.frame();
    expect(conn.tick.anchored).toBe(false);

    deliver({ tick: 101, serverTime: performance.now() - 365 * 24 * 3600 * 1000 });
    expect(conn.stats().rejectedSnapshots).toBe(1);
    expect(conn.stats().snapshotsReceived).toBe(1);
    expect(conn.tick.anchored).toBe(false); // it did not anchor to a year ago
    expect(Math.abs(conn.estimateServerTick() - sane)).toBeLessThan(700); // 30s of ticks, not 6e8
    expect(onTickReanchor).not.toHaveBeenCalled();
    conn.stop();
  });

  it('refuses a wild tick jump, then ADOPTS a sustained one, and RE-ARMS immediately afterwards', async () => {
    // A refusal with no way out is a total stall, which is the lesson the
    // interpolator learned twice, so a run past the threshold is adopted.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    deliver({ tick: 2_000_000, serverTime: performance.now() });
    expect(conn.stats().snapshotsReceived).toBe(1);

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(50);
      deliver({ tick: i, serverTime: performance.now() });
    }
    expect(conn.stats().rejectedSnapshots).toBe(3);
    expect(conn.stats().snapshotsReceived).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    deliver({ tick: 3, serverTime: performance.now() });
    expect(conn.stats().snapshotsReceived).toBe(2);
    expect(conn.estimateServerTick()).toBeLessThan(100);

    // AND THE GATE CLOSES AGAIN BEHIND IT. The counter used to be cleared only
    // by a PLAUSIBLE frame, so an adoption left it latched open and every later
    // wild frame walked straight through: measured on 100 frames each stamped
    // a random distance away, 3 refused and 97 ADOPTED, `tick.value` at
    // -542716 and an `onTickReanchor` delta of 3.4 million. A stream that is
    // still wild AFTER the adoption, rather than settling onto the new
    // timeline, must be refused again.
    const acceptedBefore = conn.stats().snapshotsReceived;
    const wild = [9_000_000, -4_000_000, 7_500_000, 12_000_000, -8_000_000, 3_000_000];
    for (const tick of wild) {
      await vi.advanceTimersByTimeAsync(50);
      deliver({ tick, serverTime: performance.now() });
    }
    // Three refusals then one adoption per run of four, never more.
    const accepted = conn.stats().snapshotsReceived - acceptedBefore;
    expect(accepted).toBeLessThanOrEqual(Math.ceil(wild.length / (3 + 1)));
    expect(accepted).toBeLessThan(wild.length);
    conn.stop();
  });

  it('refuses the great majority of a sustained run of wild stamps, rather than 3 of 100', async () => {
    // The measured shape of the latched gate: 100 frames each stamped a random
    // +-2e8ms away produced 3 refusals and 97 ADOPTIONS. Re-armed, the run
    // costs three refusals per adoption, so at least 75 of them are refused.
    //
    // A RESIDUAL THIS DOES NOT FIX, recorded so the next reader does not read
    // this case as more than it is: the frames that ARE adopted still anchor
    // the counter to whatever they carry, because adoption takes the frame at
    // face value rather than taking a coherent value out of the run the way
    // `SnapshotInterpolator`'s re-anchor takes the minimum of its error
    // window. Against sustained incoherent noise the counter still moves; what
    // the re-arm buys is that it moves at a bounded RATE instead of on every
    // frame. A genuine step, which is what the escape exists for, is coherent
    // and settles within about a second.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    deliver({ tick: 1000, serverTime: performance.now() });
    conn.frame();

    let seed = 7;
    for (let i = 0; i < 100; i++) {
      await vi.advanceTimersByTimeAsync(50);
      conn.frame();
      seed = (seed * 1103515245 + 12345) % 2147483648;
      deliver({ tick: 1000 + i, serverTime: performance.now() + ((seed % 400_000_000) - 200_000_000) });
    }

    expect(conn.stats().rejectedSnapshots).toBeGreaterThanOrEqual(75);
    expect(conn.stats().snapshotsReceived).toBeLessThanOrEqual(26);
    conn.stop();
  });

  it('an ordinary stream never trips either bound', async () => {
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(50);
      deliver({ tick: 500 + i, serverTime: performance.now() });
    }
    expect(conn.stats().rejectedSnapshots).toBe(0);
    expect(conn.stats().snapshotsReceived).toBe(60);
    conn.stop();
  });
});

describe('RoomConnection first anchor is provisional', () => {
  it('the first pong of an epoch invalidates an anchor taken with no round trip, correcting on the NEXT snapshot', async () => {
    // The first anchor of an epoch is taken before any pong exists, so it is
    // computed with `rttMs()` reading 0 and is short by the whole round trip;
    // and because anchoring sets `lastReanchorAt`, the tolerance path then
    // refused to correct it for two seconds. Measured end to end at 250ms RTT:
    // `tick.value - desiredTick()` sat between -5.2 and -5.8 for 2.2 seconds
    // and the server counted 40 late inputs in the first three seconds, in the
    // FIRST EPOCH OF EVERY RUN.
    useMonotonicFakeTimers();
    const onTickReanchor = vi.fn();
    const { conn, deliver } = clockRoom({ onTickReanchor });
    await conn.start();
    const sock = live();
    sock.open();
    conn.frame();

    // The first snapshot beats the first pong, which is the ordinary case.
    await vi.advanceTimersByTimeAsync(50);
    conn.frame();
    deliver({ tick: 100, serverTime: performance.now() });
    expect(conn.tick.value - conn.desiredTick()).toBeCloseTo(0, 5);

    // The pong lands: a 250ms round trip, five ticks of lead the anchor did not
    // include.
    await vi.advanceTimersByTimeAsync(200);
    conn.frame();
    sock.answerPings();
    expect(conn.stats().rttMs).toBeCloseTo(250, 5);
    expect(conn.tick.value - conn.desiredTick()).toBeLessThan(-4);

    // ...and the very NEXT snapshot corrects it, rather than the one two
    // seconds from now.
    await vi.advanceTimersByTimeAsync(50);
    conn.frame();
    deliver({ tick: 105, serverTime: performance.now() });
    expect(Math.abs(conn.tick.value - conn.desiredTick())).toBeLessThan(1);
    expect(onTickReanchor).toHaveBeenCalledTimes(1);
    expect(onTickReanchor.mock.calls[0]![0]).toBeGreaterThan(3);
    conn.stop();
  });
});

describe('RoomConnection resumes the interpolator from the held poses', () => {
  /** A room with one entity moving at a constant 400 units per second, so a discontinuity is measurable rather than merely visible. */
  function movingRoom(interp: SnapshotInterpolator<string>) {
    const SPEED = 0.4;
    let x = 0;
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: () => ({ tick: 100, serverTime: performance.now(), players: [{ id: 'p2', x, y: 0 }] }),
      interpolate: {
        into: interp,
        entities: (snap) => new Map(snap.players.map((p) => [p.id, { x: p.x, y: p.y }])),
      },
    });
    const tick = (): void => void (x = performance.now() * SPEED);
    const respawn = (to: number): void => void (x = to);
    return { conn, tick, respawn };
  }

  it('the entity glides out of the pose the host was holding, instead of snapping to the new epoch', async () => {
    // The connection is the only thing that can do this: the poses being held
    // on screen are `frame()`'s own output, and the moment they stop being
    // valid is the epoch boundary. Measured on this profile, seeding the fresh
    // buffer turns a 202-unit worst frame step and six motionless frames into a
    // 28-unit worst step and one.
    useMonotonicFakeTimers();
    const interp = new SnapshotInterpolator<string>();
    const { conn, tick } = movingRoom(interp);

    await conn.start();
    live().open();
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(50);
      tick();
      live().message(new ArrayBuffer(4));
      conn.frame();
    }

    const held = conn.frame().entities.get('p2')!.x;
    expect(held).toBeGreaterThan(0);

    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(400); // the outage, during which the world moved on
    live().open();

    const drawn: number[] = [held];
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(16);
      tick();
      if (i % 3 === 0) live().message(new ArrayBuffer(4));
      const pose = conn.frame().entities.get('p2');
      if (pose) drawn.push(pose.x);
    }

    let worstStep = 0;
    let motionless = 0;
    for (let i = 1; i < drawn.length; i++) {
      const step = Math.abs(drawn[i]! - drawn[i - 1]!);
      if (step > worstStep) worstStep = step;
      if (step === 0) motionless++;
    }

    // The FIRST measured step is the one that matters: it is the transition out
    // of the held pose, which is where the snap lived.
    expect(Math.abs(drawn[1]! - held)).toBeLessThan(1);
    expect(worstStep).toBeLessThan(80);
    expect(motionless).toBeLessThanOrEqual(2);
    // ...and it does converge, rather than gliding somewhere comfortable and staying there.
    expect(drawn[drawn.length - 1]!).toBeGreaterThan(held + 100);
    conn.stop();
  });

  it('passes the poses WITH their measured speed, so a respawn across a reconnect is clamped', async () => {
    // The seed's clamp is scaled by the entity's own measured speed, and
    // `clear()` has just wiped the motion state the interpolator would
    // otherwise read it from, so the speed has to travel WITH the poses. It
    // does, because what this class holds is `frame()`'s own output, which is
    // `InterpolatedEntity` and carries `speed` already.
    //
    // Measured on this profile: the entity is moving at 403 u/s and respawns
    // 100,000 units away during the outage, so the glide is clamped to 403
    // units and the first rendered frame lands 403 short of the truth. With no
    // speed to scale it the clamp is unbounded, the glide starts from the held
    // pose, and the host is shown an entity 99,600 units from where it is.
    useMonotonicFakeTimers();
    const interp = new SnapshotInterpolator<string>();
    const seeded: { speed: number | undefined }[] = [];
    const realResume = interp.resumeFrom.bind(interp);
    interp.resumeFrom = (held) => {
      for (const pose of held.values()) seeded.push({ speed: (pose as { speed?: number }).speed });
      realResume(held);
    };
    const { conn, tick, respawn } = movingRoom(interp);

    await conn.start();
    live().open();
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(50);
      tick();
      live().message(new ArrayBuffer(4));
      conn.frame();
    }
    const held = conn.frame().entities.get('p2')!;
    expect(held.speed).toBeGreaterThan(100);

    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(400);
    expect(seeded.length).toBe(1);
    expect(seeded[0]!.speed).toBeCloseTo(held.speed, 5); // the pin the clamp depends on

    const RESPAWN_X = 100_000;

    // The clamp MAGNITUDE is `interpolation.ts`'s to assert and is pinned
    // there; what this case owns is the half the connection is responsible
    // for, which is that the speed reaches the seed at all. Without it the
    // interpolator has nothing to scale the bound with (`clear()` has just
    // wiped the motion state it would otherwise read) and the glide is
    // unclamped, which on this profile shows the host an entity 99,600 units
    // from where it actually is.
    expect(seeded[0]!.speed).toBeGreaterThan(100);
    expect(Number.isFinite(seeded[0]!.speed)).toBe(true);

    respawn(RESPAWN_X);
    live().open();
    await vi.advanceTimersByTimeAsync(16);
    live().message(new ArrayBuffer(4));
    expect(conn.frame().entities.get('p2')).toBeDefined();
    conn.stop();
  });

  it('seeds the fresh buffer AFTER the clear, or the clear would throw the seed straight back out', async () => {
    // The ordering is the whole thing, and no rendered pose can distinguish it
    // from "never seeded at all", so this one is structural on purpose.
    vi.useFakeTimers();
    const order: string[] = [];
    const interp = new SnapshotInterpolator<string>();
    const realClear = interp.clear.bind(interp);
    const realResume = interp.resumeFrom.bind(interp);
    const seeded: Map<string, { x: number; y: number }>[] = [];
    interp.clear = () => {
      order.push('clear');
      realClear();
    };
    interp.resumeFrom = (held) => {
      order.push('resumeFrom');
      seeded.push(new Map([...held].map(([k, v]) => [k, { x: v.x, y: v.y }])));
      realResume(held);
    };

    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: () => ({ tick: 100, serverTime: Date.now(), players: [{ id: 'p2', x: 7, y: 9 }] }),
      interpolate: {
        into: interp,
        entities: (snap) => new Map(snap.players.map((p) => [p.id, { x: p.x, y: p.y }])),
      },
    });

    await conn.start();
    expect(seeded.length).toBe(0); // nothing drawn yet, so there is nothing to resume from
    live().open();
    live().message(new ArrayBuffer(8));
    expect(conn.frame(1000).entities.has('p2')).toBe(true);

    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seeded.length).toBe(1);
    expect(seeded[0]!.get('p2')!.x).toBe(7);
    expect(order.slice(-2)).toEqual(['clear', 'resumeFrom']);
    conn.stop();
  });
});

describe('RoomConnection measures the server tick rate', () => {
  /** Feed `count` snapshots emitted on a `hz` grid, arriving as they are emitted. */
  async function streamAt(deliver: (s: DecodedSnapshotLike) => void, hz: number, count: number, startTick = 1000): Promise<void> {
    const stepMs = 1000 / hz;
    for (let i = 0; i < count; i++) {
      await vi.advanceTimersByTimeAsync(stepMs);
      deliver({ tick: startTick + i, serverTime: performance.now() });
    }
  }

  it('a client configured for 10Hz against a 20Hz room is TOLD, once, with the measured rate', async () => {
    // A wrong `tickHz` is otherwise completely silent: no error, no stall,
    // clean stats, while the counter, the stamping lead and the underrun
    // threshold all run at half basis. The only tells were `onTickReanchor`
    // firing a same-signed delta every couple of seconds and the server's
    // playout depth pinned at 0, neither of which reads as "your tickHz is
    // wrong" to anyone.
    useMonotonicFakeTimers();
    const onTickRateMismatch = vi.fn();
    const { conn, deliver } = clockRoom({ tickHz: 10, onTickRateMismatch });
    await conn.start();
    live().open();

    await streamAt(deliver, 20, 60);

    expect(onTickRateMismatch).toHaveBeenCalledTimes(1);
    expect(onTickRateMismatch.mock.calls[0]![0]).toBeCloseTo(20, 1);
    expect(conn.stats().serverTickHz).toBeCloseTo(20, 1);

    // Once per epoch, not once per snapshot.
    await streamAt(deliver, 20, 60, 2000);
    expect(onTickRateMismatch).toHaveBeenCalledTimes(1);
    conn.stop();
  });

  it('a matching rate never fires it, and the measurement still reads back', async () => {
    useMonotonicFakeTimers();
    const onTickRateMismatch = vi.fn();
    const { conn, deliver } = clockRoom({ tickHz: 20, onTickRateMismatch });
    await conn.start();
    live().open();

    await streamAt(deliver, 20, 120);

    expect(onTickRateMismatch).not.toHaveBeenCalled();
    expect(conn.stats().serverTickHz).toBeCloseTo(20, 1);
    conn.stop();
  });

  it('is 0 before two snapshots have been accepted, and survives nothing it should not', async () => {
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom({ tickHz: 20 });
    await conn.start();
    live().open();
    expect(conn.stats().serverTickHz).toBe(0);
    deliver({ tick: 1, serverTime: performance.now() });
    expect(conn.stats().serverTickHz).toBe(0);

    await streamAt(deliver, 20, 30, 2);
    expect(conn.stats().serverTickHz).toBeCloseTo(20, 1);

    // A new epoch re-measures from nothing: a rate is a property of the room
    // this connection is talking to now.
    live().remoteClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conn.stats().serverTickHz).toBe(0);
    conn.stop();
  });

  it('a re-anchor storm on a CORRECTLY configured client never trips it', async () => {
    // The mismatch signal has to be about the RATE and nothing else, or it
    // becomes a second name for "this connection is having a bad time".
    useMonotonicFakeTimers();
    const onTickRateMismatch = vi.fn();
    const onTickReanchor = vi.fn();
    const { conn, deliver } = clockRoom({ tickHz: 20, onTickRateMismatch, onTickReanchor });
    await conn.start();
    live().open();

    // The render loop stutters past the unanchor threshold every frame, so
    // every snapshot re-anchors; the SERVER meanwhile keeps ticking at a clean
    // 20Hz right through it, which is 9 ticks per 450ms of wall time.
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(50);
      deliver({ tick: 1000 + i * 9, serverTime: performance.now() });
      conn.frame();
      await vi.advanceTimersByTimeAsync(400);
      conn.frame();
    }

    expect(onTickReanchor.mock.calls.length).toBeGreaterThan(20);
    expect(onTickRateMismatch).not.toHaveBeenCalled();
    conn.stop();
  });
});

describe('RoomConnection pong matching', () => {
  it('a pong for a ping this client never sent is ignored', async () => {
    // `n` and `c` are both attacker-chosen on a socket the client does not
    // control, and `desiredTick()` leans on the result: eight forged pongs
    // stamped with the current clock took an honest 400ms reading to 0, which
    // strips the whole round-trip term out of the stamping lead.
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const sock = live();
    sock.open();

    conn.frame();
    await vi.advanceTimersByTimeAsync(400);
    conn.frame();
    sock.answerPings();
    expect(conn.stats().rttMs).toBeCloseTo(400, 5);

    for (let n = 900; n < 908; n++) {
      conn.frame();
      sock.message(JSON.stringify({ t: 'pong', n, c: performance.now() }));
    }
    expect(conn.stats().rttMs).toBeCloseTo(400, 5);
    conn.stop();
  });

  it('a pong with a real n but a doctored c is ignored, and the sample uses the RECORDED stamp', async () => {
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const sock = live();
    sock.open();
    conn.frame();

    const ping = sock.pings()[0]!;
    await vi.advanceTimersByTimeAsync(300);
    conn.frame();

    // Right sequence number, chosen timestamp.
    sock.message(JSON.stringify({ t: 'pong', n: ping.n, c: performance.now() }));
    expect(conn.stats().rttMs).toBe(0);

    // The honest echo still lands, and reports the real 300ms.
    sock.message(JSON.stringify({ t: 'pong', n: ping.n, c: ping.c }));
    expect(conn.stats().rttMs).toBeCloseTo(300, 5);

    // ...and it is consumed: a replay of the same pong measures nothing new.
    await vi.advanceTimersByTimeAsync(500);
    conn.frame();
    sock.message(JSON.stringify({ t: 'pong', n: ping.n, c: ping.c }));
    expect(conn.stats().rttMs).toBeCloseTo(300, 5);
    conn.stop();
  });
});

// ---------------------------------------------------------------------------
// The real WebSocket implementations must satisfy `WebSocketConstructor`
// WITHOUT a cast, and the reconnect ladder must not build a thundering herd.
// ---------------------------------------------------------------------------

describe('WebSocketConstructor accepts the real implementations', () => {
  it('the DOM WebSocket and ws both assign with no cast', () => {
    // THIS CASE EXISTS TO BE COMPILED; the runtime assertion is a formality.
    // Under `strictFunctionTypes` the handler slots used to be declared
    // `((ev: unknown) => void) | null`, which is checked CONTRAVARIANTLY, so
    // neither real implementation was assignable: measured as `Type
    // '((event: Event) => void) | null' is not assignable to type
    // '((ev: unknown) => void) | null'`. Both READMEs papered over it with
    // `WebSocketImpl: WebSocket as unknown as WebSocketConstructor`, a cast
    // around a type that was simply wrong, on the one line every consumer
    // copies. If either assignment below stops compiling, that cast is back.
    // `typeof` on an undeclared global is the one expression that does not
    // throw, and Node 20 has no global `WebSocket` (22 and every browser do),
    // so the DOM half is exercised where it exists and still COMPILED where
    // it does not, which is the half that matters.
    const domImpl: WebSocketConstructor | undefined = typeof WebSocket === 'undefined' ? undefined : WebSocket;
    const wsImpl: WebSocketConstructor = wsCtor;
    if (domImpl !== undefined) expect(typeof domImpl).toBe('function');
    expect(wsImpl).toBe(wsCtor);
  });

  it('a minimal hand-rolled transport still satisfies it, so the interface stayed narrow', () => {
    // The other half of widening the slots: `any` must not have quietly turned
    // the interface into something only a real WebSocket can satisfy. A fake
    // implementing exactly the members this class calls is still enough, which
    // is the whole reason the structural interface exists.
    const minimal: WebSocketConstructor = FakeSocket as unknown as WebSocketConstructor;
    expect(typeof minimal).toBe('function');
  });
});

describe('RoomConnection reconnect ladder', () => {
  /**
   * Every delay the ladder scheduled, in order, by watching when each socket
   * appeared. FAKE TIMERS, stepped TIMER TO TIMER rather than millisecond by
   * millisecond: the virtual clock is what the delay is read off, so both
   * spellings measure the identical number, but the 1ms version cost one
   * awaited microtask flush per virtual millisecond and the capped ladder
   * below spans 26 seconds of virtual time. That was 26,000 flushes for ten
   * numbers, ~900ms on an idle machine and past vitest's 5s default timeout
   * on a loaded one: a real-time cost with no measurement behind it. Stepping
   * to the next scheduled timer lands on exactly the same instants, since the
   * only thing that can advance `Date.now()` here is a timer firing.
   */
  async function ladderDelays(conn: RoomConnection<DecodedSnapshotLike, string>, steps: number): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < steps; i++) {
      const before = FakeSocket.instances.length;
      live().remoteClose(1006);
      await vi.advanceTimersByTimeAsync(0); // let the close handler arm its timer
      const startedAt = Date.now();
      while (FakeSocket.instances.length === before && Date.now() - startedAt < 60_000) {
        if (vi.getTimerCount() === 0) break; // nothing left to fire; the assertion below reports it
        await vi.advanceTimersToNextTimerAsync();
      }
      out.push(Date.now() - startedAt);
    }
    return out;
  }

  it('the first delay lands in [50, 150), which is 100ms jittered and not a flat 250', async () => {
    // A healthy host opens the replacement socket in 6 to 18ms, and the
    // interpolator's cover is its delay (80ms at the floor) plus
    // EXTRAP_CAP_MS (150), so a flat 250 made the LADDER the outage: about
    // four motionless frames per reconnect that nothing else caused.
    //
    // BOTH ENDS OF THE JITTER RANGE, because neither alone separates the two
    // bases: 250 at the bottom of the range is 125, which sits inside [50,150)
    // just as happily as 100 at the top does. The pair pins the base and the
    // range together, and the bounds are literals, because a bound written in
    // terms of the constants moves with them and cannot fail on the one change
    // it exists to catch.
    vi.useFakeTimers();
    const firstDelayWith = async (draw: number): Promise<number> => {
      vi.spyOn(Math, 'random').mockReturnValue(draw);
      const conn = new RoomConnection<DecodedSnapshotLike, string>({
        tickHz: 20,
        mint: vi.fn().mockResolvedValue(makeSession()),
        decodeSnapshot: () => null,
        WebSocketImpl: IMPL,
        socketUrl: () => 'ws://x',
      });
      await conn.start();
      const [delay] = await ladderDelays(conn, 1);
      conn.stop();
      return delay!;
    };

    const atBottom = await firstDelayWith(0);
    expect(atBottom).toBeGreaterThanOrEqual(50);
    expect(atBottom).toBeLessThan(100);

    const atTop = await firstDelayWith(0.999);
    expect(atTop).toBeGreaterThanOrEqual(100);
    expect(atTop).toBeLessThan(150);
  });

  it('backs off exponentially and caps at maxBackoffMs, jitter included', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // the top of the jitter range
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      maxBackoffMs: 5000,
    });
    await conn.start();

    const delays = await ladderDelays(conn, 10);
    for (let i = 0; i < delays.length; i++) {
      const capped = Math.min(5000, RECONNECT_BASE_MS * RECONNECT_FACTOR ** i);
      expect(delays[i]!).toBeGreaterThanOrEqual(Math.floor(capped * RECONNECT_JITTER_MIN));
      expect(delays[i]!).toBeLessThanOrEqual(Math.ceil(capped * RECONNECT_JITTER_MAX));
    }
    // The tenth is the capped one: 100 * 2**9 is 51200, so it is the cap that
    // decides it, and even at the top of the jitter range it stays bounded.
    expect(delays[9]!).toBeGreaterThanOrEqual(5000 * RECONNECT_JITTER_MIN);
    expect(delays[9]!).toBeLessThanOrEqual(Math.ceil(5000 * RECONNECT_JITTER_MAX));
    conn.stop();
  });

  it('two connections dropped together do not retry in the same millisecond', async () => {
    // THE ARCHITECTURE BUILDS A THUNDERING HERD BY CONSTRUCTION: one relay
    // function holds many sockets and dies all at once, so without jitter
    // every client on that instance retries in lockstep. Measured on two
    // clients dropped together, both scheduled at exactly [250, 250].
    vi.useFakeTimers();
    const draws = [0.05, 0.95, 0.1, 0.9];
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => draws[i++ % draws.length]!);

    const make = (): RoomConnection<DecodedSnapshotLike, string> =>
      new RoomConnection<DecodedSnapshotLike, string>({
        tickHz: 20,
        mint: vi.fn().mockResolvedValue(makeSession()),
        decodeSnapshot: () => null,
        WebSocketImpl: IMPL,
        socketUrl: () => 'ws://x',
      });
    const a = make();
    const b = make();
    await a.start();
    await b.start();
    const sockA = FakeSocket.instances[0]!;
    const sockB = FakeSocket.instances[1]!;

    // Both dropped in the same instant, exactly as one relay death does it.
    sockA.remoteClose(1006);
    sockB.remoteClose(1006);

    const at: Record<string, number> = {};
    for (let ms = 1; ms <= 400; ms++) {
      await vi.advanceTimersByTimeAsync(1);
      if (FakeSocket.instances.length >= 3 && at.a === undefined) at.a = ms;
      if (FakeSocket.instances.length >= 4 && at.b === undefined) at.b = ms;
    }

    expect(at.a).toBeDefined();
    expect(at.b).toBeDefined();
    expect(at.a).not.toBe(at.b);
    a.stop();
    b.stop();
  });
});

// ---------------------------------------------------------------------------
// The guards a mutation sweep found nothing standing behind: the terminal
// latch, the warm swap's own preconditions, the status edge, the transport's
// readyState, and the four boundaries.
// ---------------------------------------------------------------------------

describe('RoomConnection close after a terminal', () => {
  it('a socket close AFTER a terminal has latched schedules no reconnect and opens no socket', async () => {
    // A terminal is a decision about the CONNECTION, and the transport's own
    // close event arrives after it by construction: `enterTerminal` closes the
    // socket and the platform delivers the event whenever it feels like.
    // Treating that event as an ordinary drop restarts the ladder against a
    // room that has already refused this client, or, on the skew path, against
    // a server this bundle cannot decode.
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    class ProtocolVersionError extends Error {
      override name = 'ProtocolVersionError';
    }
    const conn = new RoomConnection({
      tickHz: 20,
      mint: vi.fn().mockResolvedValue(makeSession()),
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      decodeSnapshot: () => {
        throw new ProtocolVersionError('wire 3, this bundle speaks 2');
      },
      onTerminal,
    });

    await conn.start();
    const sock = live();
    sock.open();
    sock.message(new ArrayBuffer(4));
    expect(onTerminal).toHaveBeenCalledWith('version-skew');

    sock.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(conn.status).toBe('closed');
    conn.stop();
  });
});

describe('RoomConnection warm swap preconditions', () => {
  it('a relay-expiring frame after stop(), after a terminal, or while a replacement is still pending opens no replacement', async () => {
    // A swap is an OPTIMISATION on a live connection, so every state in which
    // there is nothing to optimise refuses it. The pending arm is the one a
    // hostile relay can reach on its own: the rate limit only paces the frame,
    // and a replacement given a nine second deadline outlives that window, so
    // without this a relay announcing every five seconds accumulates sockets
    // it never has to deliver on.
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const original = live();
    original.open();

    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 9000 }));
    expect(FakeSocket.instances).toHaveLength(2);

    // Past the rate-limit window, with the first replacement still open and
    // still holding its own deadline.
    await vi.advanceTimersByTimeAsync(6_000);
    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 9000 }));
    expect(FakeSocket.instances).toHaveLength(2);

    // CONTROL: once the pending one is out of the way the next frame is
    // honoured, so this is a precondition and not a one-swap-per-epoch rule.
    // It is retired by its DEADLINE rather than by a close, deliberately: a
    // replacement that CLOSES is evidence about the session and drops it (see
    // the swap-accounting block below), which would make this arm fail for a
    // reason that has nothing to do with the precondition it is testing.
    await vi.advanceTimersByTimeAsync(3_100);
    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 9000 }));
    expect(FakeSocket.instances).toHaveLength(3);

    // ...and neither a stopped nor a latched connection has anything to swap.
    conn.stop();
    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 9000 }));
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('a TEXT frame on the replacement does not complete the swap, only a binary snapshot does', async () => {
    // Open is not enough to swap on and neither is talkative: a relay that
    // accepted the upgrade and then failed its own bus subscription still
    // seeds a roster. The swap has to be paid for in the thing the socket
    // exists to carry, or the client hands its live socket to a replacement
    // that will never deliver a snapshot and waits out a full ladder to find
    // out. The seed itself is a duplicate of one the live socket already
    // delivered, which is why dropping it costs nothing.
    useMonotonicFakeTimers();
    const onText = vi.fn();
    const { conn } = clockRoom({ onText });
    await conn.start();
    const original = live();
    original.open();

    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 5000 }));
    const replacement = live();
    replacement.open();

    replacement.message(JSON.stringify({ t: 'meta', seed: true, map: { p1: {} } }));
    expect(conn.stats().relaySwaps).toBe(0);
    expect(original.readyState).toBe(1);
    expect(onText).not.toHaveBeenCalled();

    // CONTROL: one binary frame on the same socket does complete it.
    deliverTo(replacement);
    expect(conn.stats().relaySwaps).toBe(1);
    expect(original.readyState).toBe(3);
    conn.stop();
  });
});

describe('RoomConnection status is announced on edges only', () => {
  it('a repeated status is announced once', async () => {
    // Every connect attempt opens with `setStatus('connecting')`, and a mint
    // endpoint that is down produces one attempt per ladder step with no other
    // status in between. Without the edge check a host wiring `onStatus` to a
    // banner, a re-render or an analytics event gets one per retry, forever,
    // at a rate the failure itself picks.
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const mint = vi.fn().mockRejectedValue(new Error('mint endpoint is down'));
    const conn = new RoomConnection({
      mint,
      tickHz: 20,
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onStatus,
    });

    await conn.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mint.mock.calls.length).toBeGreaterThan(3); // the ladder really did run
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(['connecting']);
    expect(conn.status).toBe('connecting');

    // CONTROL: an EDGE is still announced, so this is a dedupe and not a mute.
    mint.mockResolvedValue(makeSession());
    await vi.advanceTimersByTimeAsync(10_000);
    live().open();
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(['connecting', 'open']);
    conn.stop();
  });
});

describe('RoomConnection guards the transport', () => {
  it('send() and sendPing() on a CONNECTING or CLOSED socket do not touch the transport', async () => {
    // `ws` throws on a send before the handshake completes and after the close,
    // and the browser's own `WebSocket` raises `InvalidStateError` for the
    // first. Neither is an event this class recovers from (the close event is),
    // so neither is worth reaching the transport at all: a host stamping input
    // every frame would otherwise spend the whole connect window in a catch.
    vi.useFakeTimers();
    const conn = new RoomConnection({
      mint: vi.fn().mockResolvedValue(makeSession()),
      tickHz: 20,
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
    });
    await conn.start();
    const sock = live();
    const payloads = (): unknown[] => sock.sent.filter((d) => typeof d !== 'string');

    expect(sock.readyState).toBe(0); // CONNECTING: the handshake is not done
    conn.send(new ArrayBuffer(2));
    expect(payloads()).toHaveLength(0);
    expect(sock.pings()).toHaveLength(0);

    // CONTROL, or the two assertions above are equally true of a class that
    // never sends anything at all.
    sock.open();
    conn.send(new ArrayBuffer(2));
    expect(payloads()).toHaveLength(1);
    expect(sock.pings()).toHaveLength(1); // one on open

    // CLOSED, with the close event not yet delivered: `handleClose` has not
    // run, so the ping interval is still armed and `this.ws` still names it.
    sock.readyState = 3;
    conn.send(new ArrayBuffer(2));
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
    expect(payloads()).toHaveLength(1);
    expect(sock.pings()).toHaveLength(1);
    conn.stop();
  });
});

describe('RoomConnection reads no measurement it has not taken', () => {
  it('estimateServerTick reads 0 until the clock is seeded', async () => {
    // `lastSnapTick` and `lastSnapServerTime` are both 0 before the first
    // accepted snapshot, so extrapolating from them measures `performance.now()`
    // in tick intervals and calls the answer a server tick. A page open for a
    // minute against a 20Hz room would report tick 1200 for a room that has not
    // spoken yet, and `desiredTick()` would stamp input against it.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(conn.estimateServerTick()).toBe(0);

    // A REFUSED snapshot does not seed it either: the trust boundary runs
    // before every accumulator, this one included.
    deliver({ tick: 100, serverTime: undefined as unknown as number });
    expect(conn.stats().rejectedSnapshots).toBe(1);
    expect(conn.estimateServerTick()).toBe(0);

    // CONTROL: the first ACCEPTED snapshot seeds it, and it reads the room.
    deliver({ tick: 900, serverTime: performance.now() });
    expect(conn.estimateServerTick()).toBeCloseTo(900, 5);
    conn.stop();
  });

  it('a negative or non-finite pong sample is discarded', async () => {
    // The sample is `now() - sentAt` and `rttMs()` is a sliding-window MINIMUM,
    // so a nonsense sample is not noise that averages out: it becomes the
    // reported round trip for the whole window and strips the round-trip term
    // out of `desiredTick()`, which puts every stamped input a round trip into
    // the past. `sample < 0` is exactly what a clock that is not monotonic
    // produces, and it is the one arithmetic a minimum cannot survive.
    useMonotonicFakeTimers();
    let fakeNow = 9000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);
    const { conn } = clockRoom();
    await conn.start();
    const sock = live();
    sock.open();
    expect(sock.pings()).toHaveLength(1);

    fakeNow -= 500; // the clock now reads earlier than the stamp it is measured against
    sock.answerPings();
    expect(conn.stats().rttMs).toBe(0);

    // CONTROL: the next probe over the same socket is measured normally, so
    // the refusal is about the sample and not about the pong path.
    fakeNow += 500;
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    fakeNow += 40;
    sock.answerPings();
    expect(conn.stats().rttMs).toBe(40);

    conn.stop();
    clock.mockRestore();
  });

  it('arrivalGaps stays bounded at ARRIVAL_GAP_RING_CAP', async () => {
    // `stats().jitterMs` is the standard deviation of this ring, and a ring
    // that never evicts reports the worst moment the epoch ever had rather
    // than the last second of it: one handover, one backgrounded tab or one
    // bad minute would sit in the number for as long as the socket lives, and
    // a host sizing its own buffer off it would size for a link that recovered
    // long ago.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();

    let tick = 200;
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(i % 2 === 0 ? 10 : 500);
      deliver({ tick: tick++, serverTime: performance.now() });
    }
    expect(conn.stats().jitterMs).toBeGreaterThan(100);

    // Twenty-five even arrivals: more than the ring holds, so nothing from the
    // uneven run above can still be in it.
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(50);
      deliver({ tick: tick++, serverTime: performance.now() });
    }
    expect(conn.stats().snapshotsReceived).toBe(35);
    expect(conn.stats().jitterMs).toBe(0);
    conn.stop();
  });
});

describe('RoomConnection boundaries are AT the bound', () => {
  it('the THIRD unusable mint latches mint-failed, and the second does not', async () => {
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    let good = true;
    const mint = vi.fn(async () => (good ? makeSession() : ({ error: 'nope' } as unknown as SessionInfo)));
    const conn = new RoomConnection({
      tickHz: 20,
      mint,
      decodeSnapshot: () => null,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onTerminal,
    });

    /** Advance the ladder by exactly ONE connect attempt, which is what makes this a boundary case rather than a loop that counts at the end. */
    const nextAttempt = async (): Promise<void> => {
      const sockets = FakeSocket.instances.length;
      const mints = mint.mock.calls.length;
      for (let i = 0; i < 200; i++) {
        await vi.advanceTimersByTimeAsync(50);
        if (FakeSocket.instances.length > sockets || mint.mock.calls.length > mints) return;
      }
      throw new Error('the ladder stopped');
    };

    await conn.start();
    expect(mint).toHaveBeenCalledTimes(1);
    good = false;

    // Three pre-open failures force the first re-mint, and every unusable mint
    // from here nulls the session, so the next attempt mints again.
    for (let i = 0; i < 3; i++) {
      live().remoteClose(1006);
      await nextAttempt();
    }
    expect(mint).toHaveBeenCalledTimes(2);
    expect(onTerminal).not.toHaveBeenCalled();

    await nextAttempt();
    expect(mint).toHaveBeenCalledTimes(3);
    expect(onTerminal).not.toHaveBeenCalled(); // TWO is not the bound

    await nextAttempt();
    expect(mint).toHaveBeenCalledTimes(4);
    expect(onTerminal).toHaveBeenCalledWith('mint-failed'); // ...and three is
  });

  it('the ninth RTT sample evicts the first, and the eighth does not', async () => {
    useMonotonicFakeTimers();
    const { conn } = clockRoom();
    await conn.start();
    const sock = live();
    sock.open();

    /** One probe answered `rtt` ms after it went out, leaving the clock on the next ping interval. */
    const answer = async (rtt: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(rtt);
      sock.answerPings();
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS - rtt);
    };

    // One fast sample and seven slow ones fill the window EXACTLY, so the fast
    // one is still the minimum.
    await answer(10);
    for (let i = 0; i < 7; i++) await answer(200);
    expect(conn.stats().rttMs).toBe(10);

    // The ninth is the one that pushes it out.
    await answer(200);
    expect(conn.stats().rttMs).toBe(200);
    conn.stop();
  });

  it('an RTT change of exactly one tick drops the rate limit, and a hair under it does not', async () => {
    // The first anchor of an epoch is taken with `rttMs()` reading 0, so it is
    // short by the whole round trip, and anchoring itself sets `lastReanchorAt`
    // and locks the correction out for two seconds. A pong that disagrees with
    // the round trip the anchor ASSUMED by a whole tick is what re-opens it.
    useMonotonicFakeTimers();

    /** One epoch whose first pong reports `pongMs`, taken against an anchor that assumed none. */
    async function epochWithPong(pongMs: number): Promise<ReturnType<typeof vi.fn>> {
      const onTickReanchor = vi.fn();
      const { conn, deliver } = clockRoom({ onTickReanchor });
      await conn.start();
      const sock = live();
      sock.open(); // the first probe goes out here, stamped now
      const pingAt = performance.now();
      conn.frame();

      await vi.advanceTimersByTimeAsync(40);
      conn.frame();
      deliver({ tick: 100, serverTime: performance.now() });
      expect(onTickReanchor).not.toHaveBeenCalled(); // the first anchor is not a correction

      await vi.advanceTimersByTimeAsync(pingAt + pongMs - performance.now());
      sock.answerPings();
      expect(conn.stats().rttMs).toBe(pongMs);

      // The room is a few ticks ahead of where the counter is, in BOTH runs, so
      // the only thing separating them is the rate limit.
      await vi.advanceTimersByTimeAsync(100);
      conn.frame();
      deliver({ tick: 108, serverTime: performance.now() });
      conn.stop();
      return onTickReanchor;
    }

    expect((await epochWithPong(50)).mock.calls).toHaveLength(1);
    expect((await epochWithPong(49)).mock.calls).toHaveLength(0);
  });
});

describe('RoomConnection server-depth feedback is bounded', () => {
  it('a pathological inputLead stream moves feedbackTicks by at most 2 per correction and never past PLAYOUT_MAX_AHEAD / 2 - leadTicks, and an error under 2 changes nothing', async () => {
    // The thing being controlled is the input latency every action in the game
    // passes through, so the loop is deliberately slow and deliberately coarse.
    // `inputLead` is a number the HOST routes through its own snapshot, which
    // makes a wild one an ordinary decoder bug rather than an attack, and an
    // uncapped step turns one into the whole stamping lead in a single frame.
    useMonotonicFakeTimers();
    const leadTicks = 2; // ceil(inputLeadMs 100 / tickMs 50)

    /** Feed `count` snapshots half a second apart and read `feedbackTicks` back through `desiredTick()` after each. */
    async function run(inputLead: number, count: number): Promise<number[]> {
      const { conn, deliver } = clockRoom({ inputLeadMs: 100 });
      await conn.start();
      live().open();
      const seen: number[] = [];
      let tick = 1000;
      for (let i = 0; i < count; i++) {
        await vi.advanceTimersByTimeAsync(500);
        deliver({ tick, serverTime: performance.now(), inputLead });
        conn.frame();
        tick += 10;
        // No pong is ever answered, so `rttMs()` is 0 and this is exactly
        // `feedbackTicks`.
        seen.push(conn.desiredTick() - conn.estimateServerTick() - leadTicks);
      }
      conn.stop();
      return seen;
    }

    // A server buffer permanently a thousand ticks short of target, which is
    // the shape of a host that echoes the wrong field.
    const starved = await run(-1000, 60);
    const jumps = starved.slice(1).map((v, i) => Math.abs(v - starved[i]!));
    expect(Math.max(...jumps)).toBeLessThanOrEqual(2 + 1e-6);
    expect(Math.max(...starved)).toBeCloseTo(PLAYOUT_MAX_AHEAD / 2 - leadTicks, 6);
    expect(starved[starved.length - 1]).toBeCloseTo(PLAYOUT_MAX_AHEAD / 2 - leadTicks, 6);

    // ...and one tick off target is inside the deadband, so thirty seconds of
    // it moves nothing at all. Rounding an error of 1 would move the lead a
    // tick per correction, which is the twitch the deadband exists to refuse.
    // A one-tick band was tried against a real deployment and made it worse
    // (re-anchors 1 to 4, 6 and 8 per client per three minutes, starves up),
    // so this case is a decision, not a leftover.
    const mild = await run(1, 60); // one tick short of TARGET_DEPTH_TICKS
    expect(Math.max(...mild.map((v) => Math.abs(v)))).toBeCloseTo(0, 6);
  });
});

describe('RoomConnection sentinels are never 0 on the performance.now axis', () => {
  it('the tolerance re-anchor works within the first REANCHOR_MIN_INTERVAL_MS of a page life', async () => {
    // `lastReanchorAt` is a `performance.now()` reading, so 0 is a REAL
    // timestamp: a connection made in the first two seconds of a page reads
    // "never anchored" as "anchored two seconds ago" and refuses to correct
    // for the whole of the window it is already inside. The first epoch of the
    // first connection is exactly where the provisional anchor needs to fire.
    useMonotonicFakeTimers();
    expect(performance.now()).toBe(0); // a brand new page, which is the point
    const onTickReanchor = vi.fn();
    const { conn, deliver } = clockRoom({ onTickReanchor });
    await conn.start();
    const sock = live();
    sock.open();
    conn.frame();

    await vi.advanceTimersByTimeAsync(200);
    conn.frame();
    deliver({ tick: 100, serverTime: performance.now() }); // the first anchor, at t=200

    // A 400ms round trip the anchor did not include: eight ticks of lead it is
    // short by, well past REANCHOR_TOLERANCE_TICKS.
    await vi.advanceTimersByTimeAsync(200);
    conn.frame();
    sock.answerPings();
    expect(conn.stats().rttMs).toBe(400);

    await vi.advanceTimersByTimeAsync(50);
    conn.frame();
    deliver({ tick: 105, serverTime: performance.now() });

    expect(performance.now()).toBeLessThan(REANCHOR_MIN_INTERVAL_MS);
    expect(onTickReanchor).toHaveBeenCalledTimes(1);
    expect(Math.abs(conn.tick.value - conn.desiredTick())).toBeLessThan(1);
    conn.stop();
  });
});

describe('RoomConnection warm swap accounting', () => {
  it('a successful swap counts one attempt and no failure', async () => {
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    const original = live();
    original.open();
    deliver({ tick: 400, serverTime: performance.now() });

    expect(conn.stats().swapsAttempted).toBe(0);
    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 5000 }));
    expect(conn.stats().swapsAttempted).toBe(1);
    expect(conn.stats().swapsFailed).toBe(0);

    const replacement = live();
    replacement.open();
    await vi.advanceTimersByTimeAsync(50);
    deliver({ tick: 401, serverTime: performance.now() });

    expect(conn.stats().relaySwaps).toBe(1);
    expect(conn.stats().swapsAttempted).toBe(1);
    expect(conn.stats().swapsFailed).toBe(0);
    conn.stop();
  });

  it('a replacement refused with 4001 counts a failure and forces the next connect to re-mint', async () => {
    // THE SWAP MAKES ITS OWN WORST CASE MORE LIKELY, which is why it needs its
    // own accounting. It reuses the cached session verbatim, and a relay
    // lifetime chain outlives a session whose `maxAgeS` is shorter than it, so
    // from the moment the token expires every swap is refused (401 before the
    // upgrade on Vercel, 4001 after it on node), silently discarded, and every
    // relay cap goes back to costing the visible cold reconnect the swap
    // exists to remove, with nothing anywhere saying why.
    useMonotonicFakeTimers();
    let mintCount = 0;
    const conn = new RoomConnection<DecodedSnapshotLike, string>({
      tickHz: 20,
      mint: async () => {
        mintCount++;
        return makeSession({ token: `tok-${mintCount}` });
      },
      decodeSnapshot: () => ({ tick: 400, serverTime: performance.now() }),
      WebSocketImpl: IMPL,
      socketUrl: (session) => `ws://x?tok=${session.token}`,
    });

    await conn.start();
    const original = live();
    original.open();
    original.message(new ArrayBuffer(4));
    expect(mintCount).toBe(1);

    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 5000 }));
    const replacement = live();
    expect(replacement.url).toContain('tok-1'); // the swap reuses the session on hand
    expect(conn.stats().swapsAttempted).toBe(1);

    // The relay verifies after the upgrade and refuses the stale token.
    replacement.open();
    replacement.remoteClose(4001);

    expect(conn.stats().swapsFailed).toBe(1);
    expect(conn.stats().relaySwaps).toBe(0);
    // The live socket is untouched: a failed swap costs nothing directly.
    expect(conn.status).toBe('open');
    expect(original.readyState).toBe(1);

    // ...and when the relay does hit its cap, the ordinary ladder re-mints
    // rather than carrying the same refused token into the next epoch.
    original.remoteClose(4004);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mintCount).toBe(2);
    expect(live().url).toContain('tok-2');
    conn.stop();
  });

  it('a replacement that merely TIMES OUT keeps the session, because a slow relay says nothing about the token', async () => {
    // The other half of the rule, and the reason it is not simply "any failed
    // swap re-mints": a replacement that never answered is far more likely to
    // be a cold relay start than a bad token, and throwing away a working
    // session for that would re-mint on every slow start.
    useMonotonicFakeTimers();
    let mintCount = 0;
    const conn = new RoomConnection<DecodedSnapshotLike, string>({
      tickHz: 20,
      mint: async () => {
        mintCount++;
        return makeSession({ token: `tok-${mintCount}` });
      },
      decodeSnapshot: () => ({ tick: 400, serverTime: performance.now() }),
      WebSocketImpl: IMPL,
      socketUrl: (session) => `ws://x?tok=${session.token}`,
      connectTimeoutMs: 3_000,
    });

    await conn.start();
    const original = live();
    original.open();
    original.message(new ArrayBuffer(4));

    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 9_000 }));
    live().open(); // opens, never delivers
    await vi.advanceTimersByTimeAsync(3_000); // the deadline retires it

    expect(conn.stats().swapsFailed).toBe(1);
    expect(conn.stats().swapsAttempted).toBe(1);

    original.remoteClose(4004);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mintCount).toBe(1); // the session survived
    expect(live().url).toContain('tok-1');
    conn.stop();
  });

  it('the three swap counters stay consistent across a mixed run', async () => {
    // `swapsAttempted - relaySwaps - swapsFailed` is 0, or 1 while one is in
    // flight. A counter that cannot be reconciled is a counter nobody trusts.
    useMonotonicFakeTimers();
    const { conn, deliver } = clockRoom();
    await conn.start();
    live().open();
    deliver({ tick: 400, serverTime: performance.now() });

    // One that succeeds.
    live().message(JSON.stringify({ t: 'relay-expiring', inMs: 5_000 }));
    live().open();
    await vi.advanceTimersByTimeAsync(50);
    deliver({ tick: 401, serverTime: performance.now() });
    expect(conn.stats().relaySwaps).toBe(1);

    // ...and one that times out, past the rate-limit window.
    await vi.advanceTimersByTimeAsync(6_000);
    live().message(JSON.stringify({ t: 'relay-expiring', inMs: 9_000 }));
    live().open();
    await vi.advanceTimersByTimeAsync(10_000);

    const s = conn.stats();
    expect(s.swapsAttempted).toBe(2);
    expect(s.relaySwaps).toBe(1);
    expect(s.swapsFailed).toBe(1);
    expect(s.swapsAttempted - s.relaySwaps - s.swapsFailed).toBe(0);
    conn.stop();
  });
});

describe('RoomConnection a failed swap does not damage the live socket', () => {
  /** A room with one moving entity, a stable room id, and a token that changes on every mint. */
  function swapRoom(interp: SnapshotInterpolator<string>, pid = 'me') {
    let mintCount = 0;
    const conn = new RoomConnection({
      tickHz: 20,
      mint: async () => {
        mintCount++;
        return makeSession({ token: `tok-${mintCount}`, room: 'r-same', playerId: pid });
      },
      WebSocketImpl: IMPL,
      socketUrl: (session) => `ws://x?tok=${session.token}&room=${session.room}`,
      decodeSnapshot: () => ({ tick: 100, serverTime: Date.now(), players: [{ id: 'p2', x: 7, y: 9 }] }),
      interpolate: {
        into: interp,
        entities: (snap) => new Map(snap.players.map((p) => [p.id, { x: p.x, y: p.y }])),
      },
    });
    return { conn, mints: () => mintCount };
  }

  it('keeps the held poses across the re-mint it causes, because the room did not change', async () => {
    // THE REGRESSION THE FIRST VERSION SHIPPED. Invalidating the session inside
    // `failSwap` looked local, but the old socket is still open and serving in
    // that window, and `frame()` stamps `heldRoom` from `this.session`. One
    // rendered frame later `heldRoom` was null, so the next `beginEpoch()`
    // compared null against the room it had just re-minted INTO and dropped the
    // poses: a failed swap silently defeated the held-poses invariant on the
    // single most common path there is, a relay lifetime cap with a stale
    // token. The session is now invalidated where the ladder chooses what to
    // dial, not where the swap fails.
    vi.useFakeTimers();
    const interp = new SnapshotInterpolator<string>();
    const { conn, mints } = swapRoom(interp);

    await conn.start();
    const original = live();
    original.open();
    original.message(new ArrayBuffer(8));
    expect(conn.frame(1000).entities.has('p2')).toBe(true);

    // The relay announces its cap and the replacement is refused: a stale token.
    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 5000 }));
    const replacement = live();
    replacement.open();
    replacement.remoteClose(4001);
    expect(conn.stats().swapsFailed).toBe(1);

    // The old socket is still serving, and this is the frame that used to write
    // a null `heldRoom`.
    original.message(new ArrayBuffer(8));
    expect(conn.frame(1100).entities.has('p2')).toBe(true);

    // The announced close lands and the ladder re-mints into the SAME room.
    original.remoteClose(4004);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mints()).toBe(2);
    expect(live().url).toContain('tok-2');
    expect(live().url).toContain('room=r-same');

    // The poses survive, because nothing about the room changed.
    const held = conn.frame(2000).entities.get('p2');
    expect(held).toBeDefined();
    expect(held!.extrapolated).toBe(true);
    conn.stop();
  });

  it('still acts on an own-pid room-reject arriving on the old socket afterwards', async () => {
    // The other reader of `this.session` in that window. A null made the guard
    // `pid === this.session.playerId` unreachable, so a rejection addressed to
    // this client was dropped and the connection sat there reading 'open'.
    vi.useFakeTimers();
    const interp = new SnapshotInterpolator<string>();
    const onTerminal = vi.fn();
    const { conn } = swapRoom(interp, 'me');
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    const original = live();
    original.open();
    original.message(new ArrayBuffer(8));

    original.message(JSON.stringify({ t: 'relay-expiring', inMs: 5000 }));
    live().open();
    live().remoteClose(4001);
    expect(conn.stats().swapsFailed).toBe(1);
    expect(conn.status).toBe('open');

    // A rejection for somebody else is still somebody else's.
    original.message(JSON.stringify({ t: 'room-reject', pid: 'other' }));
    expect(conn.status).toBe('open');

    original.message(JSON.stringify({ t: 'room-reject', pid: 'me' }));
    expect(conn.status).toBe('closed');
    expect(original.readyState).toBe(3);
    void onTerminal;
  });

  it('an explicit start() does not inherit the pending re-mint, because that is the host call', async () => {
    // The flag must not surprise `start({ remint })`: an explicit restart takes
    // the host's instruction about the session, not a leftover from a swap that
    // failed under the previous socket.
    vi.useFakeTimers();
    const interp = new SnapshotInterpolator<string>();
    const { conn, mints } = swapRoom(interp);

    await conn.start();
    live().open();
    live().message(new ArrayBuffer(8));
    live().message(JSON.stringify({ t: 'relay-expiring', inMs: 5000 }));
    live().open();
    live().remoteClose(4001);
    expect(mints()).toBe(1);

    conn.stop();
    await conn.start();
    expect(mints()).toBe(1); // the cached session, as asked
    expect(live().url).toContain('tok-1');

    conn.stop();
    await conn.start({ remint: true });
    expect(mints()).toBe(2); // ...and a fresh one, also as asked
    conn.stop();
  });
});
