import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoomConnection, type WebSocketLike, type WebSocketConstructor, type SessionInfo } from './connection.js';
import { SnapshotInterpolator } from './interpolation.js';
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
    this.onclose?.({ code, reason });
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
}

const IMPL = FakeSocket as unknown as WebSocketConstructor;

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return { token: 't', playerId: 'p1', handle: 1, room: 'r', ...over };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RoomConnection reconnect backoff', () => {
  it('follows min(maxBackoffMs, 250 * 2**attempt), resetting the counter only on a real open', async () => {
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

    const delays = [250, 500, 800, 800]; // 250*2**0, *2**1, *2**2 (1000 capped to 800), *2**3 (2000 capped to 800)
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
    });

    await conn.start();
    expect(mintCount).toBe(1);

    // THE "AND ONLY THEN" HALF, which counting at the end cannot see. Three
    // failures produce exactly one re-mint whatever the threshold is, as long
    // as it is at most three, so a final `mintCount === 2` is equally true of a
    // threshold of two or of one. The separating assertion is the one made
    // BEFORE the third failure: the first two reconnects must reuse the token.
    for (let i = 0; i < 2; i++) {
      FakeSocket.instances[FakeSocket.instances.length - 1]!.remoteClose(1006);
      await vi.advanceTimersByTimeAsync(10_000); // comfortably past any backoff delay
      expect(mintCount).toBe(1);
      expect(FakeSocket.instances[FakeSocket.instances.length - 1]!.url).toContain('tok-1');
    }

    FakeSocket.instances[FakeSocket.instances.length - 1]!.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mintCount).toBe(2);
    expect(FakeSocket.instances[FakeSocket.instances.length - 1]!.url).toContain('tok-2');

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

    // A stray, late close delivered by the now-orphaned first socket.
    first.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.instances.length).toBe(2); // no extra instances from the orphan

    conn.stop();
  });
});

describe('RoomConnection terminal codes', () => {
  it.each([
    [4001, 'closed-by-server'],
    [4002, 'capacity'],
    [4003, 'rate-limited'],
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

    sock.message(new ArrayBuffer(8));
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(conn.tick.anchored).toBe(true);
    expect(conn.tick.value).toBeGreaterThanOrEqual(500);

    const stats = conn.stats();
    expect(stats.snapshotsReceived).toBe(1);

    conn.stop();
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
    vi.useFakeTimers();
    const interp = new SnapshotInterpolator<string>();
    const { conn } = cursorRoom(interp);

    await conn.start();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.message(new ArrayBuffer(8));
    // Behaviour, not a spy: the buffered frame is genuinely renderable.
    expect(conn.frame(1000).entities.has('p2')).toBe(true);

    FakeSocket.instances[0]!.remoteClose(1006);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);

    // Nothing left to bracket against, before the new socket has delivered a
    // single frame.
    expect(conn.frame(2000).entities.size).toBe(0);
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
});
