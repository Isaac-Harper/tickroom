// A TCP proxy the integration suite puts in front of Redis so a test can break
// the connection in the exact shapes production breaks in, and in no other way.
//
// WHY A PROXY AND NOT A FAKE. Every fault this file injects is a property of
// the SOCKET rather than of the Redis protocol, and a fake Redis is written on
// the far side of that socket: it has no way to stop answering without also
// telling its client that it stopped. That distinction is the whole point. A
// black hole (bytes stop moving, nobody closes anything, no error event fires
// anywhere) and a sever (RST, an error event, a reconnect ladder) look
// identical to a fake and produce opposite behaviour in ioredis and therefore
// in the ticker. So the fault has to be injected below the client, which means
// a real socket, which means this.
//
// IT STARTED LIFE INSIDE `tests/subscriber.redis.test.ts` and was extracted
// here unchanged when `tests/faults.redis.test.ts` needed the same machinery
// for four more faults. The reply-holding half is still shaped by that first
// caller's requirement (see `holdRepliesMatching`), and the subscriber test
// still drives it, so a change here has to keep that file green as well.
import net from 'node:net';

/** Decides whether a chunk from the CLIENT is the command whose reply should be held. Takes the raw bytes because RESP framing is not worth parsing for this. */
export type ChunkMatcher = (chunk: Buffer) => boolean;

/**
 * The one matcher anyone has needed so far: the `SUBSCRIBE` ioredis re-issues
 * for itself out of `readyHandler` after every reconnect. Named rather than
 * inlined because the subscriber test's entire measurement rests on it holding
 * THAT command's reply and no other one, and a substring check is easy to
 * widen by accident.
 */
export const isSubscribeCommand: ChunkMatcher = (chunk) =>
  chunk.toString('utf8').toLowerCase().includes('subscribe');

/** A latency distribution for the upstream-to-client direction. See `delayReplies`. */
export interface ReplyShape {
  /** How long to hold this reply chunk, in milliseconds. Zero passes it straight through. */
  delayMs(reply: Buffer): number;
  /** Sees every client chunk at the moment it is forwarded upstream, so a shape can key its delays off what was asked. */
  onCommand?(command: Buffer): void;
}

export interface FaultProxy {
  /** The loopback port this proxy accepts on. */
  readonly port: number;
  /** The same, as a URL to hand straight to ioredis. */
  readonly url: string;
  /**
   * Stop moving bytes in BOTH directions without closing anything, which is
   * the fault no other knob here can produce: no FIN, no RST, no `'error'`,
   * no `'close'`, no `'reconnecting'`. A client sees a connection that is
   * open and simply never answers, so nothing in its retry policy is ever
   * consulted and only a timeout it set itself can end the wait.
   *
   * Bytes are HELD, not discarded, so this really is a black hole and not a
   * shredder: a `restore()` delivers everything that was in flight, the way a
   * path coming back does.
   */
  blackhole(): void;
  /**
   * Destroy every live pair AND refuse new connections until `restore()`.
   * The shape of Redis itself going away (a restart, a failover, a container
   * replaced) rather than of one connection dying, which is why the refusal
   * matters: without it a client reconnects into the very outage the test is
   * trying to hold open and the outage lasts one retry delay.
   */
  sever(): void;
  /** Back to pass-through, flushing whatever a `blackhole()` was holding. Also reopens the door a `sever()` closed. */
  restore(): void;
  /**
   * Destroy every live pair but keep ACCEPTING, so the client reconnects
   * immediately. This is the knob the subscriber test needs (it wants the
   * reconnect, it just wants the resubscribe on the far side of it to be
   * slow), and it is deliberately not the same thing as `sever()`.
   */
  cut(): void;
  /**
   * Hold the upstream's replies for `delayMs`, starting from the first client
   * chunk `match` accepts. `null` disables it.
   *
   * IT APPLIES TO FUTURE CONNECTIONS ONLY, which is not an implementation
   * detail: the caller's sequence is always "arm the delay, then break the
   * connection", and arming it on the LIVE connection would delay whatever
   * that connection was doing at the time instead of the reconnect's own
   * handshake.
   *
   * AND IT HOLDS ONE COMMAND'S REPLY, NOT EVERY REPLY ON THE CONNECTION.
   * Getting that wrong is why the first version of the subscriber test
   * measured nothing: ioredis runs a ready check (`INFO`) before it re-issues
   * the subscription, a client-wide `commandTimeout` covers that command too,
   * so delaying everything times the ready check out first, the connection
   * never becomes ready, and the command under test is never issued at all.
   */
  holdRepliesMatching(match: ChunkMatcher | null, delayMs: number): void;
  /**
   * Hold EVERY reply for `shape.delayMs(reply)`, IN ORDER: a long delay on one
   * reply stalls everything queued behind it, which is what a latency spike
   * does to one TCP connection and is also the only thing that keeps a
   * pipelined client's replies matched to its commands.
   *
   * IT APPLIES TO LIVE CONNECTIONS, read per chunk rather than captured at
   * connect like `holdRepliesMatching`, because its caller's sequence is the
   * opposite one: a ticker that ALREADY holds a lease over this connection is
   * what the shape is for. `null` removes it; chunks already queued still
   * drain on schedule, behind nothing new.
   *
   * A REPLY ALREADY QUEUED WHEN A `blackhole()` STARTS IS STILL DELIVERED. It
   * is Redis's answer to a command Redis has processed, and a path that dies
   * with that answer in flight still delivers it. Holding it back would leave
   * a predecessor's ownership clock more conservative than the key it
   * describes, which is the flattering direction for the split-brain
   * measurement this exists for (`tests/splitbrain.redis.test.ts`).
   */
  delayReplies(shape: ReplyShape | null): void;
  close(): Promise<void>;
}

/** Splits a `redis://host:port` URL into what `net.connect` wants. The defaults match ioredis's own. */
export function proxyTargetFrom(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname || '127.0.0.1', port: Number(parsed.port || 6379) };
}

/** RST rather than FIN where the platform offers it: a half-closed socket is a graceful shutdown, which is the one shape none of these faults is trying to model. */
function reset(socket: net.Socket): void {
  const resettable = socket as net.Socket & { resetAndDestroy?: () => void };
  if (typeof resettable.resetAndDestroy === 'function') resettable.resetAndDestroy();
  else socket.destroy();
}

type Mode = 'pass' | 'blackhole' | 'sever';

interface Pair {
  client: net.Socket;
  upstream: net.Socket;
  /** Bytes a black hole is holding, per direction, replayed in order by `restore()`. */
  stalledToUpstream: Buffer[];
  stalledToClient: Buffer[];
  release(): void;
}

export async function startProxy(target: { host: string; port: number }): Promise<FaultProxy> {
  const pairs = new Set<Pair>();
  const state: { mode: Mode; match: ChunkMatcher | null; delayMs: number; shape: ReplyShape | null } = {
    mode: 'pass',
    match: null,
    delayMs: 0,
    shape: null,
  };

  const server = net.createServer((client) => {
    // A severed proxy is a Redis that is not there. Answering the accept and
    // then hanging would be a different fault (and one `blackhole` already
    // covers), so this is refused outright.
    if (state.mode === 'sever') {
      reset(client);
      return;
    }

    const upstream = net.connect(target.port, target.host);
    // Captured per connection, not read live: see `holdRepliesMatching`.
    const match = state.match;
    const delayMs = state.delayMs;
    let holding = false;
    const held: Buffer[] = [];
    const stalledToUpstream: Buffer[] = [];
    const stalledToClient: Buffer[] = [];

    // The LAST stage before the client, and every path that reaches the client
    // goes through it: straight through with no shape and nothing queued,
    // otherwise an ordered queue whose due times never go backwards, so a
    // shaped reply can never overtake one queued ahead of it. See
    // `delayReplies` for why the shape is read live rather than captured.
    const queued: { chunk: Buffer; dueAt: number }[] = [];
    let lastDueAt = 0;
    let pump: NodeJS.Timeout | null = null;
    const drain = (): void => {
      pump = null;
      for (;;) {
        const head = queued[0];
        if (head === undefined) return;
        const wait = head.dueAt - Date.now();
        if (wait > 0) {
          pump = setTimeout(drain, wait);
          return;
        }
        queued.shift();
        if (client.writable) client.write(head.chunk);
      }
    };
    const deliver = (chunk: Buffer): void => {
      const shape = state.shape;
      if (shape === null && queued.length === 0) {
        if (client.writable) client.write(chunk);
        return;
      }
      const dueAt = Math.max(lastDueAt, Date.now() + (shape === null ? 0 : shape.delayMs(chunk)));
      lastDueAt = dueAt;
      queued.push({ chunk, dueAt });
      if (pump === null) drain();
    };
    /** The one place a client chunk goes upstream, so a shape sees exactly what Redis is about to. */
    const forward = (chunk: Buffer): void => {
      state.shape?.onCommand?.(chunk);
      if (!upstream.destroyed) upstream.write(chunk);
    };

    const pair: Pair = {
      client,
      upstream,
      stalledToUpstream,
      stalledToClient,
      release(): void {
        for (const buffered of stalledToUpstream.splice(0, stalledToUpstream.length)) {
          forward(buffered);
        }
        for (const buffered of stalledToClient.splice(0, stalledToClient.length)) {
          // Through the hold, not around it: a reply that arrived during a
          // black hole is still that command's reply.
          if (holding) held.push(buffered);
          else deliver(buffered);
        }
      },
    };
    pairs.add(pair);

    // A proxy whose whole job is to break connections must never let one of
    // its own broken sockets become an unhandled `'error'` event, which node
    // treats as fatal.
    client.on('error', () => {});
    upstream.on('error', () => {});

    client.on('data', (chunk) => {
      if (state.mode === 'blackhole') {
        stalledToUpstream.push(chunk);
        return;
      }
      if (delayMs > 0 && match !== null && !holding && match(chunk)) {
        holding = true;
        setTimeout(() => {
          holding = false;
          for (const buffered of held.splice(0, held.length)) {
            deliver(buffered);
          }
        }, delayMs);
      }
      forward(chunk);
    });
    upstream.on('data', (chunk) => {
      if (state.mode === 'blackhole') stalledToClient.push(chunk);
      else if (holding) held.push(chunk);
      else deliver(chunk);
    });

    const teardown = (): void => {
      pairs.delete(pair);
      if (pump !== null) clearTimeout(pump);
      queued.length = 0;
      client.destroy();
      upstream.destroy();
    };
    client.on('close', teardown);
    upstream.on('close', teardown);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('proxy did not bind a TCP port');
  const port = address.port;

  function destroyAll(hard: boolean): void {
    for (const pair of [...pairs]) {
      if (hard) {
        reset(pair.client);
        reset(pair.upstream);
      } else {
        pair.client.destroy();
        pair.upstream.destroy();
      }
    }
  }

  return {
    port,
    url: `redis://127.0.0.1:${port}`,
    blackhole(): void {
      state.mode = 'blackhole';
    },
    sever(): void {
      state.mode = 'sever';
      destroyAll(true);
    },
    restore(): void {
      state.mode = 'pass';
      for (const pair of [...pairs]) pair.release();
    },
    cut(): void {
      destroyAll(false);
    },
    holdRepliesMatching(match: ChunkMatcher | null, delayMs: number): void {
      state.match = match;
      state.delayMs = match === null ? 0 : delayMs;
    },
    delayReplies(shape: ReplyShape | null): void {
      state.shape = shape;
    },
    close(): Promise<void> {
      state.mode = 'pass';
      destroyAll(false);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
