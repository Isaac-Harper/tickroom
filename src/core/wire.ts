// The control-plane wire contract shared by the relay (server) and
// `RoomConnection` (client): WebSocket close codes and the `t` discriminator of
// every JSON control frame either side sends. Snapshots are the host's own
// codec and never appear here; this file is only the handful of frames the
// LIBRARY itself puts on a socket.
//
// ONE DEFINITION, IMPORTED BY BOTH ENDS. These used to be string and number
// literals repeated in the client, two adapters and an example, and the client
// latched a terminal reason off a code an adapter happened to pick. A change
// on one side could not be seen from the other. Pure constants, so `core`
// stays browser-safe.

/** Close codes the library itself uses. 4000-4999 is the range the WebSocket standard reserves for applications. */
export const CLOSE_CODES = {
  /** The server ended the session on purpose (a kick, a shutdown). Terminal for the client. */
  closedByServer: 4001,
  /** The room is full. Terminal for the client; a host may re-assign and reconnect. */
  capacity: 4002,
  /** This subject already holds the maximum number of sockets. Terminal for the client. */
  connLimit: 4003,
  /**
   * The relay could not serve this socket (its bus subscription failed or
   * timed out) or is ending at its own lifetime cap. NOT terminal: the client
   * reconnects through its ordinary ladder, which lands on a fresh relay.
   */
  relayUnavailable: 4004,
} as const;

/** `t` values of the text control frames the RELAY sends to a client. */
export const SERVER_FRAMES = {
  /** The roster: `{ t: 'meta', seed?: true, map }`. Seeded on join and broadcast on every change. */
  meta: 'meta',
  /** Sent just before `CLOSE_CODES.capacity`. */
  roomFull: 'room-full',
  /** Sent just before `CLOSE_CODES.connLimit`. */
  connLimit: 'conn-limit',
  /**
   * `{ t: 'relay-expiring', inMs }`: this relay will close the socket in
   * `inMs`. A client opens a replacement socket now and swaps to it once it
   * delivers, so the relay's own lifetime cap costs no visible gap. Sent once,
   * `RELAY_EXPIRY_LEAD_MS` before the close.
   */
  relayExpiring: 'relay-expiring',
  /** `{ t: 'pong', n, c }`: the echo of a client `ping`, both fields copied verbatim. */
  pong: 'pong',
  /**
   * `{ t: 'input-lead', lead }`: how deep the ticker's playout buffer for
   * THIS client ran over the last `DEPTH_INTERVAL_MS`, in ticks. The relay
   * derives it from the ticker's `DEPTH_FRAME` (below), forwarding only its
   * own pid's value, and `RoomConnection` consumes it to trim its stamping
   * lead. Never reaches `onText`, exactly like `pong`.
   */
  inputLead: 'input-lead',
} as const;

/** `t` values of the text control frames a CLIENT sends to the relay. */
export const CLIENT_FRAMES = {
  /**
   * `{ t: 'ping', n, c }`: a round-trip probe the relay answers directly,
   * without touching Redis. `n` is a sequence number, `c` the client's own
   * clock reading, echoed back so the client differences it against `now`.
   * A text frame whose body starts with `{"t":"ping"` is intercepted by the
   * relay BEFORE `decodeInput` runs, so a host's own input frames must not
   * begin that way (the library's control frames own the `t` key).
   */
  ping: 'ping',
} as const;

/**
 * The ticker publishes `{ t: 'room-reject', pid, c? }` on the roster channel
 * when `RoomRuntime.isFull` refuses a NEW player, `c` being the refused join's
 * relay connection id. The RELAY consumes it: the one relay whose `pid` (and,
 * when present, `c`) matches sends `room-full`, closes with
 * `CLOSE_CODES.capacity` and stops its join heartbeat; every other relay
 * drops the frame, so a client never sees a rejection meant for someone else,
 * and a player who deliberately holds two sockets during a swap or a reconnect
 * loses only the one that was refused.
 */
export const ROOM_REJECT_FRAME = 'room-reject';

/**
 * The ticker publishes `{ t: 'depth', d: { [pid]: ticks } }` on the roster
 * channel every `DEPTH_INTERVAL_MS`, carrying the MEAN playout depth over that
 * interval for every pid it currently holds a buffer for (a pid without one
 * is absent, not 0: an unstamped client has no lead to steer). The RELAY
 * consumes it, exactly as it consumes `room-reject`: it looks up its own pid
 * and sends the client one `SERVER_FRAMES.inputLead`, or nothing when the
 * frame does not name it. The frame itself is never forwarded.
 *
 * THIS IS THE LIBRARY'S OWN NUMBER ON THE LIBRARY'S OWN FRAMES. The depth used
 * to reach the client only if the host routed it: `RoomRuntime.onBufferHealth`
 * into state, `encodeSnapshot` onto its wire, `decodeSnapshot` picking its own
 * pid's value back out. Three host steps for one library number, and the one
 * most often missed, which left the stamping lead open-loop with nothing
 * saying so. `onBufferHealth` stays for a host that wants the number in its
 * own state (a HUD); the loop no longer depends on it.
 */
export const DEPTH_FRAME = 'depth';

/**
 * How often the ticker publishes `DEPTH_FRAME`, and why once a second. The
 * client corrects its lead at most once per `REANCHOR_MIN_INTERVAL_MS` (2000)
 * and against an EMA, so a faster frame buys it nothing it can act on; and
 * the value is a MEAN over the interval rather than a point sample, so one
 * frame carries a whole second of consumes (twenty at 20Hz) rather than one
 * tick's reading of a buffer that jitters by a tick on a healthy link. Fixed
 * rather than change-triggered, because a change-triggered publish is a rate
 * a client's own stamping jitter can drive, and every client-driven rate in
 * this library is counted and flushed on a cadence instead. The bus cost is
 * one publish per room per second, fanned out once per socket, against
 * `tickHz` snapshot publishes in the same second.
 */
export const DEPTH_INTERVAL_MS = 1000;

/** The ping cadence a `RoomConnection` uses. Two seconds is frequent enough to track a mobile client's changing path and cheap enough to be free. */
export const PING_INTERVAL_MS = 2000;

/** How long before its lifetime cap a relay announces `relay-expiring`. Long enough for a cold replacement relay to start and subscribe. */
export const RELAY_EXPIRY_LEAD_MS = 5000;

/**
 * The relay's join republish cadence, AND the unit the ticker's presence
 * timeout is expressed in. It lives here because it is ONE fact seen from two
 * sides: the relay republishes a `join` this often, and the ticker decides a
 * player is gone by counting how many of these have been missed. As two
 * literals in two files the coupling was documented on the ticker's option
 * and enforced nowhere, so lowering one silently narrowed the other's margin.
 */
export const JOIN_HEARTBEAT_MS = 1000;

/**
 * How many missed join heartbeats make a player gone, and why it is FIVE.
 * It has to be more than one, because a single lost beat is not a departure.
 * It has to fire at all, because a `leave` lost in a handoff gap would
 * otherwise leave a phantom player nobody could drain. And five one-second
 * beats sits above the 5 to 7 second unplanned-death gap the docs record,
 * which is the SUCCESSOR'S OWN restore and not a break in the heartbeat: the
 * relays are a separate lifetime and keep republishing right through a ticker
 * dying, so a player whose relay is alive is never reaped by one.
 */
export const PRESENCE_TIMEOUT_HEARTBEATS = 5;

export interface PingFrame {
  t: typeof CLIENT_FRAMES.ping;
  n: number;
  c: number;
}

export interface PongFrame {
  t: typeof SERVER_FRAMES.pong;
  n: number;
  c: number;
}

export interface RelayExpiringFrame {
  t: typeof SERVER_FRAMES.relayExpiring;
  inMs: number;
}

export interface DepthFrame {
  t: typeof DEPTH_FRAME;
  d: Record<string, number>;
}

export interface InputLeadFrame {
  t: typeof SERVER_FRAMES.inputLead;
  lead: number;
}

/** The prefix test the relay uses to spot a ping without parsing every input frame. */
export const PING_FRAME_PREFIX = '{"t":"ping"';

export function encodePing(n: number, c: number): string {
  return JSON.stringify({ t: CLIENT_FRAMES.ping, n, c } satisfies PingFrame);
}

export function encodePong(n: number, c: number): string {
  return JSON.stringify({ t: SERVER_FRAMES.pong, n, c } satisfies PongFrame);
}

export function isPongFrame(msg: unknown): msg is PongFrame {
  if (typeof msg !== 'object' || msg === null) return false;
  const f = msg as { t?: unknown; n?: unknown; c?: unknown };
  return f.t === SERVER_FRAMES.pong && typeof f.n === 'number' && typeof f.c === 'number';
}

export function isRelayExpiringFrame(msg: unknown): msg is RelayExpiringFrame {
  if (typeof msg !== 'object' || msg === null) return false;
  const f = msg as { t?: unknown; inMs?: unknown };
  return f.t === SERVER_FRAMES.relayExpiring && typeof f.inMs === 'number';
}

export function encodeDepth(d: Record<string, number>): string {
  return JSON.stringify({ t: DEPTH_FRAME, d } satisfies DepthFrame);
}

export function encodeInputLead(lead: number): string {
  return JSON.stringify({ t: SERVER_FRAMES.inputLead, lead } satisfies InputLeadFrame);
}

export function isInputLeadFrame(msg: unknown): msg is InputLeadFrame {
  if (typeof msg !== 'object' || msg === null) return false;
  const f = msg as { t?: unknown; lead?: unknown };
  return f.t === SERVER_FRAMES.inputLead && typeof f.lead === 'number' && Number.isFinite(f.lead);
}

/**
 * The depth a `DEPTH_FRAME` carries for `pid`, or `undefined` when the frame
 * does not name it or is not a depth frame at all. An OWN property only, and
 * a finite number only: the pid is the client's claim and the frame came off
 * the bus, so `d['constructor']` must not read a function off the prototype
 * as a depth.
 */
export function depthFor(msg: unknown, pid: string): number | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const f = msg as { t?: unknown; d?: unknown };
  if (f.t !== DEPTH_FRAME || typeof f.d !== 'object' || f.d === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(f.d, pid)) return undefined;
  const lead = (f.d as Record<string, unknown>)[pid];
  return typeof lead === 'number' && Number.isFinite(lead) ? lead : undefined;
}
