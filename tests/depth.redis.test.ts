// THE DEPTH LOOP, CLOSED WITH THE HOST CARRYING NOTHING. A real ticker, a real
// relay on a real `ws` socket, real Redis between them, and a `RoomConnection`
// stamping inputs at a deliberately oversized lead. The runtime's snapshot is
// the toy counter's (`tick`, `players`, `counters`, `t`) with no depth field
// anywhere on it, and the runtime implements no `onBufferHealth` at all. If
// the client's stamping lead comes down anyway, the number travelled on the
// library's own frames: the ticker's `depth` on the roster channel, the
// relay's `input-lead` to its one socket.
//
// Before this frame existed the same run was open-loop forever, and the only
// way to close it was three host steps in three files. The room and the
// namespace are unique per run and the namespace is flushed afterwards, like
// every other file here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { type RedisLike, type ClientInput, roomKeys, DEPTH_FRAME, DEPTH_INTERVAL_MS } from '../src/core/index.js';
import { attachRelay, runTicker, type RelaySocket } from '../src/server/index.js';
import { RoomConnection } from '../src/client/index.js';
import { REANCHOR_MIN_INTERVAL_MS } from '../src/client/netPolicy.js';
import { createCounterRuntime } from './helpers/toyRuntime.js';
import { TEST_REDIS_URL, probeRedisAvailable, newNamespace, flushNamespace, skipReason, waitFor } from './helpers/env.js';

const REDIS_AVAILABLE = await probeRedisAvailable();
if (!REDIS_AVAILABLE) console.warn(`[tickroom integration: depth] ${skipReason()}`);

const d = REDIS_AVAILABLE ? describe : describe.skip;

const TICK_HZ = 20;
/** Ten ticks of headroom at 20Hz, so the server's buffer runs about ten deep and the loop has a long way to trim. */
const INPUT_LEAD_MS = 500;
/** Long enough for the first depth frame plus three corrections at `REANCHOR_MIN_INTERVAL_MS` apiece, with slack. */
const RUN_MS = DEPTH_INTERVAL_MS + 4 * REANCHOR_MIN_INTERVAL_MS + 1000;

d('the depth loop over a real ticker, relay and socket', () => {
  const namespace = newNamespace('depth');
  let raw: Redis;
  let redis: RedisLike;
  let httpServer: Server;
  let wss: WebSocketServer;
  let port: number;
  const tickers: Promise<unknown>[] = [];

  beforeAll(async () => {
    raw = new Redis(TEST_REDIS_URL);
    redis = raw;
    httpServer = createServer();
    wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const roomId = url.searchParams.get('room') ?? 'default';
      const pid = url.searchParams.get('pid') ?? randomUUID();
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachRelay({
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
          spawnTicker: async () => {},
        });
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });

  afterAll(async () => {
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await Promise.allSettled(tickers);
    await flushNamespace(TEST_REDIS_URL, namespace);
    raw.disconnect();
  }, 15_000);

  it(
    'a stamping client\'s lead comes down from the ticker\'s depth frame alone, with no depth on the host\'s snapshot',
    async () => {
      const roomId = `room-${randomUUID().slice(0, 6)}`;
      const keys = roomKeys(roomId, namespace);
      const pid = `p-${randomUUID().slice(0, 6)}`;

      // NO `onBufferHealth`, NO DEPTH ON THE WIRE. The one addition to the toy
      // runtime is the stamped path itself.
      tickers.push(
        runTicker({
          runtime: { ...createCounterRuntime(TICK_HZ), usesPlayout: () => true },
          redis,
          createSubscriber: () => new Redis(TEST_REDIS_URL),
          roomId,
          namespace,
          maxRunMs: RUN_MS + 4000,
          emptyGraceMs: 4000,
        })
      );
      expect(await waitFor(async () => (await raw.get(keys.lease)) !== null, 5000, 25)).toBe(true);

      // What the bus carried, both channels, so the cost can be stated
      // against the traffic it rides beside rather than assumed.
      const depthFrames: { at: number; d: Record<string, number>; bytes: number }[] = [];
      let snapshots = 0;
      let snapshotBytes = 0;
      const tap = new Redis(TEST_REDIS_URL);
      tap.on('messageBuffer', (channel: Buffer, message: Buffer) => {
        const ch = channel.toString('utf8');
        if (ch === keys.out) {
          snapshots++;
          snapshotBytes += message.byteLength;
        } else if (ch === keys.metaout) {
          const parsed = JSON.parse(message.toString('utf8')) as { t?: unknown; d?: Record<string, number> };
          if (parsed.t === DEPTH_FRAME) depthFrames.push({ at: performance.now(), d: parsed.d!, bytes: message.byteLength });
        }
      });
      await tap.subscribe(keys.out, keys.metaout);

      const onText: unknown[] = [];
      const conn = new RoomConnection<{ tick: number; serverTime: number }, string>({
        tickHz: TICK_HZ,
        inputLeadMs: INPUT_LEAD_MS,
        mint: async () => ({ token: 'tok', playerId: pid, handle: 1, room: roomId }),
        socketUrl: (s) => `ws://127.0.0.1:${port}/?room=${roomId}&pid=${s.playerId}`,
        WebSocketImpl: WebSocket,
        decodeSnapshot: (buf) => {
          const p = JSON.parse(new TextDecoder().decode(buf)) as { tick: number; t: number };
          return { tick: p.tick, serverTime: p.t };
        },
        onText: (msg) => onText.push(msg),
      });

      // ONE STAMPED RECORD PER ADVANCED TICK, the shape `PredictedEntity`
      // sends, driven on a 16ms frame timer.
      let seq = 0;
      let lastStamped = -1;
      const leads: { at: number; lead: number }[] = [];
      const frameTimer = setInterval(() => {
        const at = performance.now();
        conn.frame(at);
        if (!conn.tick.anchored) return;
        const tick = Math.floor(conn.tick.value);
        if (tick > lastStamped) {
          lastStamped = tick;
          conn.send(JSON.stringify([{ seq: ++seq, targetTick: tick, data: 1 } satisfies ClientInput]));
        }
        leads.push({ at, lead: conn.desiredTick() - conn.estimateServerTick() });
      }, 16);

      await conn.start();
      expect(await waitFor(() => conn.stats().snapshotsReceived > 0, 8000, 25)).toBe(true);
      const startedAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, RUN_MS));
      clearInterval(frameTimer);
      const endStats = conn.stats();
      const leadAtEnd = conn.desiredTick() - conn.estimateServerTick();
      conn.stop();
      await tap.unsubscribe();
      tap.disconnect();

      // The open-loop lead is what the client ran on before the first frame:
      // the configured headroom plus the (loopback, near zero) round trip.
      const openLoop = Math.max(...leads.filter((l) => l.at < startedAt + DEPTH_INTERVAL_MS / 2).map((l) => l.lead));
      const leadTicks = Math.ceil(INPUT_LEAD_MS / (1000 / TICK_HZ));
      const ownDepths = depthFrames.map((f) => f.d[pid]).filter((v): v is number => typeof v === 'number');
      const elapsedS = (performance.now() - startedAt) / 1000;
      const summary = {
        openLoop,
        leadAtEnd,
        ownDepths,
        depthFrames: depthFrames.length,
        snapshots,
        bus: {
          depthBytesPerS: +(depthFrames.reduce((n, f) => n + f.bytes, 0) / elapsedS).toFixed(1),
          snapshotBytesPerS: +(snapshotBytes / elapsedS).toFixed(1),
        },
        client: endStats,
      };
      const report = () => JSON.stringify(summary, null, 2);

      try {
        // Non-vacuity: the client really did run open-loop at the oversized
        // lead first, and the ticker really did see a buffer that deep.
        expect(openLoop, 'open-loop lead').toBeGreaterThanOrEqual(leadTicks);
        expect(ownDepths.length, 'depth frames naming this pid').toBeGreaterThanOrEqual(3);
        expect(Math.max(...ownDepths), 'deepest reading').toBeGreaterThanOrEqual(leadTicks - 3);

        // THE LOOP CLOSED. At most two ticks per `REANCHOR_MIN_INTERVAL_MS`,
        // and the run allows three corrections, so the lead is at least two
        // ticks below where it started and the server's own reading came
        // down with it.
        expect(leadAtEnd, 'lead after the loop').toBeLessThanOrEqual(openLoop - 2);
        expect(ownDepths[ownDepths.length - 1]!, 'final depth').toBeLessThan(Math.max(...ownDepths) - 1);

        // And nothing for the loop ever reached the host: no `input-lead`
        // in `onText`, no depth on the snapshot by construction.
        expect(onText.some((m) => typeof m === 'object' && m !== null && (m as { t?: unknown }).t === 'input-lead')).toBe(false);

        // THE BUS COST. One frame per interval, a few dozen bytes, against
        // twenty snapshots a second: under a twentieth of the snapshot bytes.
        expect(depthFrames.length, 'depth frames').toBeLessThanOrEqual(Math.ceil(elapsedS) + 2);
        expect(summary.bus.depthBytesPerS).toBeLessThan(summary.bus.snapshotBytesPerS / 20);
      } catch (err) {
        console.error(report());
        throw err;
      }
      console.log(`[depth] ${report()}`);
    },
    30_000
  );
});
