// The transport-facing client: mints a session, opens a socket, survives
// reconnects and server handoffs invisibly, keeps a smoothed clock, and
// exposes a monotonic tick timeline for stamping predicted input. Framework
// free: the only browser globals it touches are `WebSocket`, `performance`,
// and, defensively, `sessionStorage`/`location` for the version-skew reload
// path, every one of them guarded so this class does not throw when used
// outside a browser tab (a test runner, a headless worker).

import { ClientTick, type ClientTickView } from './clientTick.js';
import type { SnapshotInterpolator, EntitySample, InterpolatedEntity } from './interpolation.js';
import { stallDecision, shouldReanchor, STALL_COLD_MS, type StallDecision, type NetStatus } from './netPolicy.js';

export type { NetStatus } from './netPolicy.js';

export interface SessionInfo {
  token: string;
  playerId: string;
  handle: number;
  room: string;
  [k: string]: unknown;
}

/**
 * The THREE fields this class reads out of a decoded snapshot, and the whole
 * contract a host's own snapshot type has to satisfy. `tick` and `serverTime`
 * run the tick timeline and the smoothed clock; `version` drives the
 * protocol-skew check when the host opts into one. Everything else in a
 * snapshot is the host's and is carried through untouched.
 *
 * THERE IS NO INDEX SIGNATURE HERE, AND REMOVING IT WAS A FIX. It used to
 * carry `[k: string]: unknown`, which bought nothing (nothing in this class
 * reads a fourth field) and cost the library its own composability: an
 * `interface` gets no implicit index signature, so `DefaultSnapshot`, this
 * repo's own shipped decoder output, was not assignable to it and
 * `decodeSnapshot: (buf) => decodeDefaultSnapshot(buf)` failed with TS2322.
 * The index signature also erased the payload type on the way back out, so
 * `onSnapshot` handed back a shape whose own fields were `unknown` and every
 * consumer, including `examples/pong/client.ts`, recovered it with the
 * `as unknown as` double cast TypeScript's own error text calls a mistake.
 * The payload type is now threaded generically from `decodeSnapshot`'s return
 * type to `onSnapshot`'s parameter instead, so neither cast is needed at
 * either end.
 */
export interface DecodedSnapshotLike {
  version?: number;
  tick: number;
  serverTime: number;
}

/**
 * The roster control frame the relay seeds a joining socket with and the
 * ticker broadcasts on every roster change. Exported because a browser-only
 * consumer has no reason to open the SERVER declarations, which is where this
 * shape was documented and nowhere else: `onText` is `unknown`, so narrowing
 * to the WRONG shape typechecks perfectly and yields an empty roster forever,
 * i.e. no names, no presence count and no join or leave notifications, with
 * nothing anywhere reporting a problem.
 *
 * `map` is keyed by pid. Its values are whatever the host wrote into that
 * player's join metadata, so they stay `unknown`: this library cannot know
 * that shape and must not pretend to.
 */
export interface RosterFrame {
  t: 'meta';
  /** True only on the ONE-SHOT frame a socket is seeded with on join. Absent on the broadcasts that follow. A client that renders both identically can ignore it. */
  seed?: boolean;
  map: Record<string, unknown>;
}

/** Narrow an `onText` payload to a `RosterFrame`. Returns false for every other control frame the host may send on the same channel, so a caller can `if (!isRosterFrame(msg)) return;` and be sure of the fields it then reads. */
export function isRosterFrame(msg: unknown): msg is RosterFrame {
  if (typeof msg !== 'object' || msg === null) return false;
  const frame = msg as { t?: unknown; map?: unknown };
  return frame.t === 'meta' && typeof frame.map === 'object' && frame.map !== null;
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

/**
 * The interpolator this connection OWNS, and the one function that says where
 * the entities live in a decoded snapshot. Both halves in one option, so it is
 * not possible to supply either without the other.
 *
 * THE CONNECTION HOLDS THE INTERPOLATOR BECAUSE THE INTERPOLATOR IS
 * EPOCH-SCOPED AND THE CONNECTION IS WHAT OWNS THE EPOCH. Every host used to
 * hand-write the same bridge into `push()`, and the two fields that never vary
 * across any writing of it (`receivedAt`, which must come from the same clock
 * `sample()` reads, and `serverTime`, which must be the authority's stamp and
 * not a second local one) are precisely the two the docs spent fifteen lines of
 * capitalised warning on. Worse, a reconnect has to `clear()` the buffer, and
 * only the caller could: skipping it brackets the first frame of the new epoch
 * against one from seconds ago at `frac ~= 1`, a guaranteed snap on every
 * reconnect, with the previous socket's path delay carried into the new
 * estimate. The connection already does the identical thing for the one other
 * epoch-scoped component it holds, one line away, in `markUnanchored()`.
 */
export interface SnapshotInterpolationOptions<TSnap, K extends string | number> {
  /** The interpolator to push into and to clear on every epoch change. Its key type decides `K`, and `SnapshotInterpolator` has no default key type, so the host states it once here. */
  into: SnapshotInterpolator<K>;
  /** Pull the entities that MOVE out of one decoded snapshot. Everything else in the snapshot (scores, a winner, a serve countdown) is discrete state that has no meaning half way between two values, so it belongs in `onSnapshot` rather than here. */
  entities(snap: TSnap): Map<K, EntitySample>;
}

export interface RoomConnectionOptions<TSnap extends DecodedSnapshotLike, K extends string | number> {
  /** Mint or fetch a session. Called on the first connect attempt and again whenever a re-mint is triggered (see the pre-open-failure rule below); an ordinary reconnect reuses the session already on hand. */
  mint(): Promise<SessionInfo>;
  /** Build the ws URL from a session. Defaults to `${wsProto}//${location.host}${path}?token=..&pid=..&h=..&room=..`, which needs a `location` global; supply this explicitly anywhere that is not a browser tab. */
  socketUrl?(session: SessionInfo): string;
  /** Path component of the default socket URL. Ignored if `socketUrl` is supplied. */
  path?: string;
  /**
   * Fixed simulation rate this room runs at. MUST match the host's
   * `RoomRuntime.tickHz`, and is REQUIRED rather than defaulted for that
   * reason: it used to default to 20, so a 10Hz room whose client simply did
   * not mention it ran every derived quantity at twice the right basis (the
   * tick counter's step, `estimateServerTick`'s slope, and the underrun
   * threshold in `stats()`), silently. The host always knows this number, so
   * asking for it costs one line and a missing one is now a compile error
   * rather than a 2x error nothing reports.
   */
  tickHz: number;
  /** Decode a binary snapshot. Return null to ignore the frame (a malformed or not-yet-understood payload should never throw the connection). Its return type is what fixes `TSnap` for `onSnapshot` and for `interpolate.entities`, so no cast is needed at either end. */
  decodeSnapshot(buf: ArrayBuffer): TSnap | null;
  /** Protocol version this bundle speaks. Omit to disable the skew check entirely (useful before a codec exists yet). */
  protocolVersion?: number;
  /** Drive an interpolator from this connection's own snapshot stream and epoch. See `SnapshotInterpolationOptions`. Omit it to keep a `SnapshotInterpolator` by hand, which is still supported and is what a host with several buffers, or with a render layer that owns its own playback, will want. */
  interpolate?: SnapshotInterpolationOptions<TSnap, K>;
  /** Every decoded snapshot, in the concrete type `decodeSnapshot` returned. For the discrete state interpolation cannot smooth; the moving entities are `interpolate`'s job. */
  onSnapshot?(snap: TSnap): void;
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
/** Ceiling on the frame delta `frame()` derives from its own clock, seconds. A backgrounded tab returns with a gap of whatever the browser felt like, and every consumer of that delta (the tick counter's step budget, the interpolator's delay ease and speed low-pass) wants a plausible frame rather than a truthful one. The tick counter caps its own step count on top of this. */
const FRAME_DT_CAP_S = 0.25;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** What one rendered frame produced: the poses to draw, the stall state, and the delta the connection measured for itself. */
export interface FrameView<K extends string | number> {
  /**
   * The interpolated pose of every tracked entity, ready to draw. EMPTY when
   * no `interpolate` option was given, because there is then no buffer for
   * this connection to sample.
   */
  entities: Map<K, InterpolatedEntity>;
  /** Same value `stallView().stalled` reports; `onStallChange` has already fired if this call changed it. */
  stalled: boolean;
  /** Seconds since the previous `frame()` call, clamped to `FRAME_DT_CAP_S`. Zero on the first call. Returned because a host's own per-frame work usually wants the same delta rather than a second, differently clamped one. */
  dt: number;
}

export class RoomConnection<
  TSnap extends DecodedSnapshotLike = DecodedSnapshotLike,
  K extends string | number = string,
> {
  private readonly opts: RoomConnectionOptions<TSnap, K>;
  private readonly tickMs: number;
  private readonly clock: ClientTick;

  /**
   * This client's own stamping tick counter, read-only. Stamp an input's
   * `targetTick` with `tick.value`, and check `tick.initialized` before
   * trusting it. Advancing it is `frame()`'s job: see `ClientTickView`.
   */
  readonly tick: ClientTickView;

  private ws: WebSocketLike | null = null;
  private lastFrameAt: number | null = null;
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

  constructor(opts: RoomConnectionOptions<TSnap, K>) {
    this.opts = opts;
    this.tickMs = 1000 / opts.tickHz;
    this.clock = new ClientTick({ tickMs: this.tickMs });
    this.tick = this.clock;
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
    this.beginEpoch();
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

  /**
   * THE ONE PER-FRAME CALL. Drive it from `requestAnimationFrame` and draw
   * what it returns.
   *
   * It advances the tick counter, polls the stall detector (firing
   * `onStallChange` on edges) and samples the interpolator, from ONE delta
   * this class measures itself.
   *
   * IT IS ONE CALL BECAUSE IT USED TO BE THREE, AND THE MOST IMPORTANT OF THE
   * THREE WAS DOCUMENTED NOWHERE. A host had to call `pollStall()`,
   * `tick.advance(dt)` and `interp.sample(dt, now)` every frame; the middle one
   * appeared in no README, no architecture doc and not even in this repo's own
   * shipped client example, and omitting it is silent and expensive. Measured:
   * `tick.value` pinned at 4 while the server reached 20.2, so every input was
   * stamped 1.6 seconds in the past and drifting without bound, and because
   * `shouldReanchor` gates on `initialized` (which only `advance()` sets) the
   * omission ALSO permanently disabled the recovery that would have masked it.
   * The room connects, remote entities move beautifully, and only the player's
   * own input is wrong, in a way that reads as latency rather than a bug.
   * Folding all three into the call that returns the poses to draw is what
   * makes forgetting one of them impossible: a host that does not call this
   * renders nothing at all, which is loud.
   *
   * `nowMs` defaults to the same clock this class stamps `receivedAt` with, so
   * playback and the arrival stamps agree by construction. Pass the
   * `requestAnimationFrame` timestamp if you would rather name it: that is the
   * same `performance.now()` domain. DO NOT pass a `Date.now()` reading, which
   * is a different domain by about 1.7e12, and differencing the two is what
   * puts the playhead somewhere no frame will ever bracket.
   */
  frame(nowMs: number = now()): FrameView<K> {
    const dt =
      this.lastFrameAt === null ? 0 : Math.max(0, Math.min(FRAME_DT_CAP_S, (nowMs - this.lastFrameAt) / 1000));
    this.lastFrameAt = nowMs;

    this.clock.advance(dt);
    const stalled = this.pollStall(nowMs);
    const entities = this.opts.interpolate
      ? this.opts.interpolate.into.sample(dt, nowMs)
      : new Map<K, InterpolatedEntity>();

    return { entities, stalled, dt };
  }

  /**
   * Reset everything scoped to one CONNECTION EPOCH, at the moment a fresh
   * attempt begins.
   *
   * The tick counter must re-anchor from the next snapshot rather than trust a
   * value it kept advancing through a gap where no server owned the room, and
   * the interpolator must drop a buffer whose frames and whose measured clock
   * offset both belong to the previous socket's path. Those two facts have
   * always been the same fact; only the first of them used to live here, and
   * the second was left to every caller to remember from `onStatus`.
   */
  private beginEpoch(): void {
    this.clock.markUnanchored();
    this.opts.interpolate?.into.clear();
  }

  /** The stall half of `frame()`, kept separate so the decision is made from one place and so a host driving its own clock can still reach it. */
  private pollStall(nowMs: number): boolean {
    const decision = stallDecision({
      now: nowMs,
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
    this.beginEpoch();
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

    let decoded: TSnap | null;
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
    if (!this.clock.anchored) {
      this.clock.anchorTo(estimate);
    } else if (
      shouldReanchor({
        anchored: this.clock.anchored,
        initialized: this.clock.initialized,
        clientTick: this.clock.value,
        serverTick: estimate,
      })
    ) {
      this.clock.anchorTo(estimate);
    }

    // BEFORE `onSnapshot`, deliberately. `onSnapshot` is host code and this
    // class does not wrap it, so a throw in it escapes into the socket's
    // message handler; putting the push first means a host callback that
    // throws costs one callback rather than also silently starving playback of
    // every frame after it.
    //
    // `receivedAt` is `t`, the same reading `frame()` measures its own delta
    // from and passes to `sample()`, so the two clocks the offset estimate
    // differences are one clock by construction rather than by a caller
    // remembering to use `performance.now()` in both places.
    const interpolate = this.opts.interpolate;
    if (interpolate) {
      interpolate.into.push({ receivedAt: t, serverTime: decoded.serverTime, entities: interpolate.entities(decoded) });
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
