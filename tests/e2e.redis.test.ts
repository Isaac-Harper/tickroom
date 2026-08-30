// Two things this file proves that no unit test can, because both are
// specifically about REAL processes and a REAL socket:
//
//   1. checkAdmission's capacity/conn-cap decisions against real Redis
//      state, including the exact stats-vs-meta disagreement
//      docs/ARCHITECTURE.md section 6 says would otherwise brick a room.
//   2. The full chain, wired the way a real host wires it: a real `ws`
//      WebSocketServer, `attachRelay` on a real socket, a real `runTicker`
//      loop, real Redis pub/sub between them, and a real client on the
//      other end of a real TCP connection receiving a real snapshot.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Redis from 'ioredis';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { type RedisLike, type ClientInput, roomKeys } from '../src/core/index.js';
import { attachRelay, checkAdmission, runTicker, type RelaySocket } from '../src/server/index.js';
import { createCounterRuntime } from './helpers/toyRuntime.js';
import { TEST_REDIS_URL, probeRedisAvailable, newNamespace, flushNamespace, skipReason, waitFor } from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: e2e] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

// ---------------------------------------------------------------------------
// checkAdmission, driven directly against real Redis state we seed by hand.
// No socket needed here: AdmissionOptions/AdmissionResult are already the
// whole surface, and seeding the exact disagreement by hand is both simpler
// and more precise than trying to provoke it by racing real tickers.
// ---------------------------------------------------------------------------
d('checkAdmission / real Redis', () => {
  const namespace = newNamespace('admission');
  let raw: Redis;
  let redis: RedisLike;

  beforeAll(() => {
    raw = new Redis(TEST_REDIS_URL);
    redis = raw;
  });

  afterAll(async () => {
    await flushNamespace(TEST_REDIS_URL, namespace);
    raw.disconnect();
  });

  it('reads capacity from the stats key, never the meta hash, when the two disagree', async () => {
    const roomId = `room-${randomUUID().slice(0, 6)}`;
    const keys = roomKeys(roomId, namespace);

    // Stats says FULL, meta is empty (the shape of a genuinely full, live
    // room): a brand-new player must be refused.
    await raw.set(keys.stats, JSON.stringify({ players: 999 }));
    const refused = await checkAdmission({ redis, roomId, pid: 'newcomer', subject: 'sub-a', namespace, maxPlayers: 5 });
    expect(refused.admit).toBe(false);
    expect(refused.reason).toBe('full');

    // Stats is MISSING (the ticker died, or never existed), meta is
    // phantom-full (a predecessor that never got to clean up its hash): a
    // new player must still be admitted. Reading meta here instead is
    // exactly the bug ARCHITECTURE.md section 6 describes as bricking a
    // room forever, since nothing ever clears a stale meta hash on its own.
    await raw.del(keys.stats);
    await raw.hset(keys.meta, 'ghost-1', JSON.stringify({ name: 'ghost' }));
    await raw.hset(keys.meta, 'ghost-2', JSON.stringify({ name: 'ghost' }));
    const admitted = await checkAdmission({ redis, roomId, pid: 'newcomer-2', subject: 'sub-b', namespace, maxPlayers: 1 });
    expect(admitted.admit).toBe(true);

    // A REJOIN (pid already present in meta) is always admitted regardless
    // of how full stats reads, even against the same phantom entries above.
    await raw.set(keys.stats, JSON.stringify({ players: 999 }));
    const rejoin = await checkAdmission({ redis, roomId, pid: 'ghost-1', subject: 'sub-c', namespace, maxPlayers: 1 });
    expect(rejoin.admit).toBe(true);
  });

  it('refuses past maxSocketsPerSubject, registered in the real ZSET checkAdmission reads', async () => {
    const roomId = `room-${randomUUID().slice(0, 6)}`;
    const subject = `subject-${randomUUID().slice(0, 6)}`;
    const cap = 3;

    // checkAdmission is a QUERY: it never writes the registration itself
    // (see its own doc comment), so this loop plays the caller's role,
    // exactly as a real relay's upgrade handler does.
    for (let i = 0; i < cap; i++) {
      const admission = await checkAdmission({
        redis,
        roomId,
        pid: `p${i}`,
        subject,
        namespace,
        maxPlayers: 100,
        maxSocketsPerSubject: cap,
      });
      expect(admission.admit).toBe(true);
      await raw.zadd(admission.connKey, Date.now(), admission.connId);
    }

    const over = await checkAdmission({
      redis,
      roomId,
      pid: 'p-over-cap',
      subject,
      namespace,
      maxPlayers: 100,
      maxSocketsPerSubject: cap,
    });
    expect(over.admit).toBe(false);
    expect(over.reason).toBe('conn-limit');
  });

  it('a socket closing (zrem of its connId) frees the slot so a reconnect is admitted', async () => {
    const roomId = `room-${randomUUID().slice(0, 6)}`;
    const subject = `subject-${randomUUID().slice(0, 6)}`;
    const cap = 2;

    const first = await checkAdmission({ redis, roomId, pid: 'p0', subject, namespace, maxPlayers: 100, maxSocketsPerSubject: cap });
    await raw.zadd(first.connKey, Date.now(), first.connId);
    const second = await checkAdmission({ redis, roomId, pid: 'p1', subject, namespace, maxPlayers: 100, maxSocketsPerSubject: cap });
    await raw.zadd(second.connKey, Date.now(), second.connId);

    const refused = await checkAdmission({ redis, roomId, pid: 'p2', subject, namespace, maxPlayers: 100, maxSocketsPerSubject: cap });
    expect(refused.admit).toBe(false);

    // "the socket closes": the caller's own cleanup path removes its connId.
    await raw.zrem(first.connKey, first.connId);

    const reconnect = await checkAdmission({ redis, roomId, pid: 'p2', subject, namespace, maxPlayers: 100, maxSocketsPerSubject: cap });
    expect(reconnect.admit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End to end: a real ws server, a real socket, a real ticker, real Redis
// between them. examples/node-server/server.ts is the reference wiring this
// mirrors (read, not edited: another agent owns that file right now).
// ---------------------------------------------------------------------------
d('end-to-end over a real WebSocket', () => {
  const namespace = newNamespace('e2e');
  let raw: Redis;
  let redis: RedisLike;
  let httpServer: Server;
  let wss: WebSocketServer;
  let port: number;
  const runningTickers = new Map<string, Promise<unknown>>();
  const openSockets = new Set<WebSocket>();

  function startTicker(roomId: string): void {
    if (runningTickers.has(roomId)) return;
    runningTickers.set(
      roomId,
      runTicker({
        runtime: createCounterRuntime(20),
        redis,
        createSubscriber: () => new Redis(TEST_REDIS_URL),
        roomId,
        namespace,
        geomKey: () => 'e2e-test:v1',
        // Bounded so a test that forgets to explicitly stop one still lets
        // the process exit; short enough that afterAll's drain is fast,
        // long enough to comfortably outlast every test below.
        maxRunMs: 6000,
        emptyGraceMs: 1500,
      })
    );
  }

  beforeAll(async () => {
    raw = new Redis(TEST_REDIS_URL);
    redis = raw;

    httpServer = createServer();
    wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const roomId = url.searchParams.get('room') ?? 'default';
      const pid = url.searchParams.get('pid') ?? randomUUID();
      const subject = url.searchParams.get('subject') ?? pid;

      wss.handleUpgrade(req, socket, head, (ws) => {
        void (async () => {
          const admission = await checkAdmission({ redis, roomId, pid, subject, namespace, maxPlayers: 20 });
          if (!admission.admit) {
            ws.send(JSON.stringify({ t: admission.reason }));
            ws.close(admission.reason === 'full' ? 4002 : 4003);
            return;
          }
          await redis.zadd(admission.connKey, Date.now(), admission.connId);

          attachRelay({
            // The `ws` package's socket exposes a superset of RelaySocket
            // (readyState numbering matches the WebSocket standard by
            // design, per RelaySocket's own doc comment), so this is the
            // one intentional cast in this file, matching the reference
            // wiring in examples/node-server/server.ts.
            socket: ws as unknown as RelaySocket,
            redis,
            createSubscriber: () => new Redis(TEST_REDIS_URL),
            roomId,
            pid,
            namespace,
            joinMeta: { name: pid },
            decodeInput: (data): ClientInput[] => {
              const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
              const parsed = JSON.parse(buf.toString('utf8')) as ClientInput | ClientInput[];
              return Array.isArray(parsed) ? parsed : [parsed];
            },
            spawnTicker: async (id) => {
              startTicker(id);
            },
            onClose: () => {
              redis.zrem(admission.connKey, admission.connId).catch(() => {});
            },
          });
        })();
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });

  afterEach(() => {
    for (const s of openSockets) {
      try {
        s.close();
      } catch {
        // already gone
      }
    }
    openSockets.clear();
  });

  afterAll(async () => {
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    // Every ticker started above is bounded by maxRunMs, so this resolves
    // on its own; waiting for it here (rather than abandoning the promises)
    // is what stops a slow ticker from leaking into the NEXT test file.
    await Promise.allSettled(runningTickers.values());
    await flushNamespace(TEST_REDIS_URL, namespace);
    raw.disconnect();
  }, 15_000);

  function connect(params: Record<string, string>): WebSocket {
    const query = new URLSearchParams(params).toString();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?${query}`);
    openSockets.add(ws);
    ws.on('close', () => openSockets.delete(ws));
    return ws;
  }

  it('a real client receives a real snapshot through relay + ticker + Redis', async () => {
    const roomId = `room-${randomUUID().slice(0, 6)}`;
    const client = connect({ room: roomId, pid: randomUUID() });

    const snapshot = await new Promise<{ tick: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no snapshot arrived within budget')), 8000);
      client.on('message', (data) => {
        try {
          const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
          const parsed = JSON.parse(text) as { tick?: number };
          // Filters out the metaout control frame (`{t:'meta', ...}`),
          // which has no `tick` field: only a genuine snapshot does.
          if (typeof parsed.tick === 'number') {
            clearTimeout(timer);
            resolve(parsed as { tick: number });
          }
        } catch {
          // not JSON, or not a snapshot shape: keep waiting for the next frame
        }
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(snapshot.tick).toBeGreaterThanOrEqual(0);
  }, 12_000);

  it('closing a real socket runs the relay cleanup, freeing its connection-cap slot', async () => {
    const roomId = `room-${randomUUID().slice(0, 6)}`;
    const subject = `subject-${randomUUID().slice(0, 6)}`;
    const connKey = `${namespace}:conns:${subject}`;

    const client = connect({ room: roomId, pid: randomUUID(), subject });
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });

    const registered = await waitFor(async () => (await raw.zcard(connKey)) === 1, 2000, 25);
    expect(registered).toBe(true);

    client.close();

    const freed = await waitFor(async () => (await raw.zcard(connKey)) === 0, 2000, 25);
    expect(freed).toBe(true);
  }, 10_000);
});
