// The transport-facing client: mints a session, opens a socket, survives
// reconnects and server handoffs invisibly, keeps a smoothed clock, and
// exposes a monotonic tick timeline for stamping predicted input. Framework
// free: the only browser globals it touches are `WebSocket`, `performance`,
// and, defensively, `sessionStorage`/`location` for the version-skew reload
// path, every one of them guarded so this class does not throw when used
// outside a browser tab (a test runner, a headless worker).

import { ClientTick } from './clientTick.js';
import { stallDecision, shouldReanchor, STALL_COLD_MS, type StallDecision, type NetStatus } from './netPolicy.js';

export type { NetStatus } from './netPolicy.js';

export interface SessionInfo {
  token: string;
  playerId: string;
  handle: number;
  room: string;
  [k: string]: unknown;
}

export interface DecodedSnapshotLike {
  version?: number;
  tick: number;
  serverTime: number;
  [k: string]: unknown;
}

export type TerminalReason = 'closed-by-server' | 'capacity' | 'rate-limited' | 'version-skew' | 'stopped';

/**
 * The structural subset of the DOM `WebSocket` interface tickroom needs. A
 * real `WebSocket` satisfies this with zero adapter code (same reasoning as
 * `RedisLike` in core: narrow the interface to what is actually called, so a
 * fake implementation for tests, or an alternative transport, only has to
 * implement a handful of members instead of the entire real API surface).
 */
export interface WebSocketLike {
  readyState: number;
  binaryType?: string;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface RoomConnectionOptions {
  /** Mint or fetch a session. Called on the first connect attempt and again whenever a re-mint is triggered (see the pre-open-failure rule below); an ordinary reconnect reuses the session already on hand. */
  mint(): Promise<SessionInfo>;
  /** Build the ws URL from a session. Defaults to `${wsProto}//${location.host}${path}?token=..&pid=..&h=..&room=..`, which needs a `location` global; supply this explicitly anywhere that is not a browser tab. */
  socketUrl?(session: SessionInfo): string;
  /** Path component of the default socket URL. Ignored if `socketUrl` is supplied. */
  path?: string;
  /** Fixed simulation rate this room runs at. Must match the host's `RoomRuntime.tickHz`. */
  tickHz?: number;
  /** Decode a binary snapshot. Return null to ignore the frame (a malformed or not-yet-understood payload should never throw the connection). */
  decodeSnapshot(buf: ArrayBuffer): DecodedSnapshotLike | null;
  /** Protocol version this bundle speaks. Omit to disable the skew check entirely (useful before a codec exists yet). */
  protocolVersion?: number;
  onSnapshot?(snap: DecodedSnapshotLike): void;
  /** JSON control frames the host relay sends: a roster update, a capacity notice, a quota warning. Parsed for you; handed back as the parsed value, or the raw string if it did not parse as JSON. */
  onText?(msg: unknown): void;
  onStatus?(status: NetStatus): void;
  /** Fires on EDGES only (stalled false -> true, or true -> false), never once per poll. */
  onStallChange?(stalled: boolean): void;
  onTerminal?(reason: TerminalReason): void;
  /** Cap on the exponential reconnect backoff, ms. Default 5000. */
  maxBackoffMs?: number;
  /** Inject a fake WebSocket constructor for testing, or point at an alternative implementation. Defaults to the global `WebSocket`. */
  WebSocketImpl?: WebSocketConstructor;
}

const DEFAULT_PATH = '/api/ws';
const DEFAULT_MAX_BACKOFF_MS = 5000;
const WS_OPEN = 1;
const PRE_OPEN_FAILURES_BEFORE_REMINT = 3;
const RELOAD_STORAGE_KEY = 'tickroom.reloadedAt';
const RELOAD_WINDOW_MS = 30_000;
const ARRIVAL_GAP_RING_CAP = 20;
const RTT_SEND_RING_CAP = 8;
/** A snapshot arriving later than this multiple of one tick interval is counted as an "underrun" for the diagnostic in `stats()`. Not the same measurement as `SnapshotInterpolator.underrunRate` (that one knows about the render playhead; this one only knows arrival timing), documented as a proxy at the field itself. */
const UNDERRUN_GAP_FACTOR = 1.5;
const UNDERRUN_EMA_TAU_MS = 3000;
const RTT_EMA_ALPHA = 0.2;
const SERVER_CLOCK_EMA_ALPHA = 0.05;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export class RoomConnection {
  private readonly opts: RoomConnectionOptions;
  private readonly tickMs: number;
  readonly tick: ClientTick;

  private ws: WebSocketLike | null = null;
  private _status: NetStatus = 'idle';
  private stopped = true;
  private terminalReason: TerminalReason | null = null;
  private versionSkewStopped = false;

  private attempt = 0;
  private preOpenFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private session: SessionInfo | null = null;

  private connectStartedAt = 0;
  private lastSnapAt = 0;
  private epochDelivered = false;
  private stallActive = false;
  private lastStallDecision: StallDecision | null = null;

  private serverClockOffset = 0;
  private serverClockSeeded = false;
  private lastSnapTick = 0;
  private lastSnapServerTime = 0;

  private snapshotsReceived = 0;
  private reconnects = 0;
  private lastArrivalAt: number | null = null;
  private arrivalGaps: number[] = [];
  private underrunEma = 0;
  private pendingSendTimestamps: number[] = [];
  private rttMsEma = 0;
  private rttSeeded = false;

  constructor(opts: RoomConnectionOptions) {
    this.opts = opts;
    const tickHz = opts.tickHz ?? 20;
    this.tickMs = 1000 / tickHz;
    this.tick = new ClientTick({ tickMs: this.tickMs });
  }

  get status(): NetStatus {
    return this._status;
  }

  /** Start (or restart, after a `stop()`) the connection. Resolves once the first connect attempt has been dispatched, not once a socket is open: use `onStatus`/`onSnapshot` to observe readiness. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.terminalReason = null;
    this.versionSkewStopped = false;
    this.attempt = 0;
    this.preOpenFailures = 0;
    this.connectStartedAt = now();
    this.lastSnapAt = 0;
    this.epochDelivered = false;
    this.tick.markUnanchored();
    await this.connectOnce(false);
  }

  /** Tear the connection down deliberately. Fires `onTerminal('stopped')` once, so `pollStall()` never shows a stall banner for a connection the caller closed on purpose. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close(1000, 'stopped');
      } catch {
        // A fake or already-broken socket throwing on close must not stop teardown.
      }
    }
    this.setTerminal('stopped');
    this.setStatus('idle');
  }

  send(payload: ArrayBuffer | Uint8Array | string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(payload);
    } catch {
      return;
    }
    const t = now();
    this.pendingSendTimestamps.push(t);
    if (this.pendingSendTimestamps.length > RTT_SEND_RING_CAP) this.pendingSendTimestamps.shift();
  }

  serverNow(): number {
    return Date.now() + this.serverClockOffset;
  }

  /**
   * A continuous estimate of the tick the server is on RIGHT NOW, extrapolated
   * from the newest snapshot's own tick and server-time stamp against the
   * smoothed clock. Distinct from `tick.value`, which is this CLIENT's own
   * stamping counter, deliberately anchored a few ticks ahead so a stamped
   * input has time to arrive before the server reaches that tick.
   */
  estimateServerTick(): number {
    if (!this.serverClockSeeded) return 0;
    const elapsedMs = this.serverNow() - this.lastSnapServerTime;
    return this.lastSnapTick + elapsedMs / this.tickMs;
  }

  /** Call once per rendered frame. Returns the current stall state (same as `stallView().stalled`); fires `onStallChange` on edges. */
  pollStall(): boolean {
    const decision = stallDecision({
      now: now(),
      lastSnapAt: this.lastSnapAt,
      connectStartedAt: this.connectStartedAt,
      status: this._status,
      epochDelivered: this.epochDelivered,
      stallActive: this.stallActive,
      terminal: this.terminalReason !== null,
    });
    this.lastStallDecision = decision;
    if (decision.stalled !== this.stallActive) {
      this.stallActive = decision.stalled;
      this.opts.onStallChange?.(this.stallActive);
    }
    return this.stallActive;
  }

  stallView(): StallDecision {
    return this.lastStallDecision ?? { stalled: false, silentMs: 0, thresholdMs: STALL_COLD_MS };
  }

  stats(): { rttMs: number; jitterMs: number; snapshotsReceived: number; underrunRate: number; reconnects: number } {
    return {
      rttMs: this.rttSeeded ? this.rttMsEma : 0,
      jitterMs: stddev(this.arrivalGaps),
      snapshotsReceived: this.snapshotsReceived,
      underrunRate: this.underrunEma,
      reconnects: this.reconnects,
    };
  }

  // ---- connection lifecycle ----------------------------------------------

  private async connectOnce(forceMint: boolean): Promise<void> {
    if (this.stopped) return;
    this.setStatus('connecting');

    if (!this.session || forceMint) {
      try {
        this.session = await this.opts.mint();
      } catch {
        // A stop() landing in this await must not be followed by a socket
        // opening anyway: async callers cross an await between their own
        // check and the call, so the check has to live HERE, not only at
        // the call site that invoked connectOnce.
        if (this.stopped) return;
        this.scheduleReconnect();
        return;
      }
      // Same re-check, for the success path: a stop() during a slow mint
      // must not open a socket just because the mint eventually resolved.
      if (this.stopped) return;
    }

    if (!this.session) return; // unreachable: the branch above always assigns it or returns first
    const session = this.session;
    const url = this.opts.socketUrl ? this.opts.socketUrl(session) : this.defaultSocketUrl(session);

    const Impl = this.opts.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!Impl) {
      throw new Error('tickroom: no WebSocket implementation available; pass `WebSocketImpl`.');
    }

    // DETACH-BEFORE-CLOSE. The previous socket (if any) is closed only after
    // `this.ws` no longer names it, so its handlers' own `this.ws !== socket`
    // guards see the mismatch the instant we act, however that close event
    // ends up being delivered. Without this an orphaned socket keeps
    // decoding messages into this connection's state from a room it is no
    // longer part of, runs its own reconnect ladder in parallel with the
    // replacement's, and can hold a slot against a per-user connection cap
    // until the host times it out.
    const previous = this.ws;
    this.ws = null;
    if (previous) {
      try {
        previous.close();
      } catch {
        // ignore
      }
    }

    const socket = new Impl(url);
    if (typeof socket.binaryType !== 'undefined') socket.binaryType = 'arraybuffer';
    this.ws = socket;

    this.epochDelivered = false;
    this.tick.markUnanchored();
    let openedThisSocket = false;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      openedThisSocket = true;
      this.attempt = 0;
      this.preOpenFailures = 0;
      this.setStatus('open');
    };

    socket.onmessage = (ev) => {
      if (this.ws !== socket) return;
      this.handleMessage(ev.data);
    };

    socket.onerror = () => {
      // Swallowed deliberately: a `close` event follows an `error` per the
      // WebSocket spec, and that is the single place reconnection is driven
      // from. Reacting here too would double-schedule a reconnect.
      if (this.ws !== socket) return;
    };

    socket.onclose = (ev) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.handleClose(ev.code, openedThisSocket);
    };
  }

  private handleClose(code: number, openedThisSocket: boolean): void {
    if (code === 4001) {
      this.setTerminal('closed-by-server');
      this.setStatus('closed');
      return;
    }
    if (code === 4002) {
      this.setTerminal('capacity');
      this.setStatus('closed');
      return;
    }
    if (code === 4003) {
      this.setTerminal('rate-limited');
      this.setStatus('closed');
      return;
    }
    if (this.terminalReason !== null) {
      // Already latched terminal by some other path (version skew, an
      // already-processed capacity frame that arrived before this close).
      this.setStatus('closed');
      return;
    }
    if (this.stopped) {
      this.setStatus('idle');
      return;
    }

    this.setStatus('closed');
    if (openedThisSocket) {
      this.preOpenFailures = 0;
    } else {
      this.preOpenFailures++;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, 250 * 2 ** this.attempt);
    this.attempt++;
    this.reconnects++;

    // A socket that keeps dying BEFORE it ever opens is a different failure
    // mode from an ordinary drop: it means the token itself may be bad (a
    // deploy changed its format, it expired, the room stopped existing), and
    // retrying the identical session forever would strand the client in an
    // unauthorized loop with no way out. Three strikes forces a fresh mint
    // on the NEXT attempt; the counter resets here rather than staying
    // permanently tripped, so it can fire again if the fresh session also
    // turns out to be bad.
    const forceMint = this.preOpenFailures >= PRE_OPEN_FAILURES_BEFORE_REMINT;
    if (forceMint) this.preOpenFailures = 0;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.connectOnce(forceMint);
    }, delay);
  }

  private setTerminal(reason: TerminalReason): void {
    if (this.terminalReason !== null) return; // debounces a text-frame-plus-close pair (or two close events) representing one logical event
    this.terminalReason = reason;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.opts.onTerminal?.(reason);
  }

  private setStatus(s: NetStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.opts.onStatus?.(s);
  }

  private defaultSocketUrl(session: SessionInfo): string {
    if (typeof location === 'undefined') {
      throw new Error('tickroom: no `location` global available; pass `socketUrl` explicitly.');
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = this.opts.path ?? DEFAULT_PATH;
    const params = new URLSearchParams({
      token: session.token,
      pid: session.playerId,
      h: String(session.handle),
      room: session.room,
    });
    return `${proto}//${location.host}${path}?${params.toString()}`;
  }

  // ---- message handling ---------------------------------------------------

  private handleMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.handleTextFrame(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.processSnapshot(data);
      return;
    }
    // An ArrayBufferView (a fake in a test might hand one over) or anything
    // else binary-shaped: try to read its buffer rather than dropping it,
    // but never throw on a shape this class does not recognise.
    if (data && typeof data === 'object' && 'buffer' in data) {
      const buf = (data as { buffer: unknown }).buffer;
      if (buf instanceof ArrayBuffer) this.processSnapshot(buf);
    }
  }

  private handleTextFrame(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.opts.onText?.(raw);
      return;
    }
    this.opts.onText?.(msg);

    if (msg !== null && typeof msg === 'object' && 't' in msg) {
      const t = (msg as { t: unknown }).t;
      if (t === 'room-full') this.setTerminal('capacity');
    }
  }

  private processSnapshot(buf: ArrayBuffer): void {
    if (this.versionSkewStopped) return;

    let decoded: DecodedSnapshotLike | null;
    try {
      decoded = this.opts.decodeSnapshot(buf);
    } catch {
      decoded = null;
    }
    if (!decoded) return;

    if (
      this.opts.protocolVersion !== undefined &&
      decoded.version !== undefined &&
      decoded.version !== this.opts.protocolVersion
    ) {
      this.handleVersionSkew();
      return;
    }

    const t = now();
    this.snapshotsReceived++;

    if (this.lastArrivalAt !== null) {
      const gap = t - this.lastArrivalAt;
      this.arrivalGaps.push(gap);
      if (this.arrivalGaps.length > ARRIVAL_GAP_RING_CAP) this.arrivalGaps.shift();

      const missed = gap > this.tickMs * UNDERRUN_GAP_FACTOR ? 1 : 0;
      const ease = 1 - Math.exp(-gap / UNDERRUN_EMA_TAU_MS);
      this.underrunEma += (missed - this.underrunEma) * ease;
    }
    this.lastArrivalAt = t;
    this.lastSnapAt = t;
    this.epochDelivered = true;

    // RTT is a best-effort PROXY here, not a true measurement: this class has
    // no application-level echo (a decoded snapshot's shape is entirely the
    // host's to define, and nothing here assumes it carries an ack). Pairing
    // the oldest outstanding `send()` with the next snapshot to arrive is
    // biased toward the tick interval on top of a real round trip, but it
    // moves with real latency and costs nothing extra to compute. A host
    // whose snapshot DOES carry an ack field can compute a true RTT itself
    // from that field and ignore this one.
    const sentAt = this.pendingSendTimestamps.shift();
    if (sentAt !== undefined) {
      const sample = t - sentAt;
      if (sample >= 0) {
        this.rttMsEma = this.rttSeeded ? this.rttMsEma + (sample - this.rttMsEma) * RTT_EMA_ALPHA : sample;
        this.rttSeeded = true;
      }
    }

    // Smoothed server clock. An UNSMOOTHED offset would make the interpolation
    // playhead (anything reading `serverNow()`) jitter by the same amount
    // every packet's network delay varies, which renders as remote entities
    // shimmering in place rather than moving smoothly.
    const rawOffset = decoded.serverTime - Date.now();
    this.serverClockOffset = this.serverClockSeeded
      ? this.serverClockOffset + (rawOffset - this.serverClockOffset) * SERVER_CLOCK_EMA_ALPHA
      : rawOffset;
    this.serverClockSeeded = true;

    this.lastSnapTick = decoded.tick;
    this.lastSnapServerTime = decoded.serverTime;

    const estimate = this.estimateServerTick();
    if (!this.tick.anchored) {
      this.tick.anchorTo(estimate);
    } else if (
      shouldReanchor({
        anchored: this.tick.anchored,
        initialized: this.tick.initialized,
        clientTick: this.tick.value,
        serverTick: estimate,
      })
    ) {
      this.tick.anchorTo(estimate);
    }

    this.opts.onSnapshot?.(decoded);
  }

  private handleVersionSkew(): void {
    let recentlyReloaded = false;
    const hasStorage = typeof sessionStorage !== 'undefined';
    if (hasStorage) {
      try {
        const raw = sessionStorage.getItem(RELOAD_STORAGE_KEY);
        const last = raw ? Number(raw) : 0;
        recentlyReloaded = last > 0 && Date.now() - last < RELOAD_WINDOW_MS;
      } catch {
        recentlyReloaded = false;
      }
    }

    if (!recentlyReloaded) {
      if (hasStorage) {
        try {
          sessionStorage.setItem(RELOAD_STORAGE_KEY, String(Date.now()));
        } catch {
          // Storage denied (private browsing, quota): fall through to the
          // terminal path below rather than looping reload attempts.
        }
      }
      if (typeof location !== 'undefined' && typeof location.reload === 'function') {
        try {
          location.reload();
          return; // navigating away; nothing past this point matters
        } catch {
          // fall through
        }
      }
    }

    // Either we already reloaded once this window (a server that keeps
    // outrunning the client must not loop reloads forever), or there is no
    // `location` to reload at all (this class running outside a browser tab).
    this.versionSkewStopped = true;
    this.setTerminal('version-skew');
    this.setStatus('closed');
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }
}
