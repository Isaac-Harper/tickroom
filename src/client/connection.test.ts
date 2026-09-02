import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoomConnection, type WebSocketLike, type WebSocketConstructor, type SessionInfo } from './connection.js';

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
    const conn = new RoomConnection({ mint, decodeSnapshot: () => null, WebSocketImpl: IMPL, socketUrl: () => 'ws://x' });

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
    const conn = new RoomConnection({ mint, decodeSnapshot: () => null, WebSocketImpl: IMPL, socketUrl: () => 'ws://x' });

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
      decodeSnapshot: decode,
      WebSocketImpl: IMPL,
      socketUrl: () => 'ws://x',
      onStatus,
      onSnapshot,
      tickHz: 20,
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
