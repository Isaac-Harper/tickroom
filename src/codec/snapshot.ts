// A batteries-included default codec, for anyone who does not want to design
// a bit layout on day one. Adopt it to ship a working binary wire immediately;
// replace it with a hand-tuned one once your entity shape stabilizes. Nothing
// elsewhere in tickroom depends on this file: `RoomRuntime.encodeSnapshot` may
// return any `Uint8Array` it likes, this is just a reasonable one to start
// from.
import type { ClientInput } from '../core/index.js';
import { ByteWriter, ByteReader, CodecError } from './bytes.js';
import { quantize, dequantize, quantizeCm, dequantizeCm, quantizeAngle, dequantizeAngle } from './quantize.js';

export interface CodecEntity {
  id: number;
  x: number;
  y: number;
  /** Radians. Defaults to 0 on encode if omitted; always present on decode. */
  heading?: number;
  /** An opaque `u8` state/anim value: idle vs moving, a colour index, a phase. Defaults to 0. */
  state?: number;
}

export interface DefaultSnapshot {
  version: number;
  tick: number;
  serverTime: number;
  entities: CodecEntity[];
  /** Room-specific bytes this codec does not know how to interpret (an activities container, a score block). Round-trips opaque. */
  extra?: Uint8Array;
}

export const DEFAULT_SNAPSHOT_VERSION = 1;

/**
 * Wire layout, all little-endian (see `bytes.ts`):
 *
 *   header:  u8 version, u32 tick, f64 serverTime, u16 entityCount
 *   entity:  u16 id, i16 x(cm), i16 y(cm), u16 heading(turn), u8 state
 *            ... repeated entityCount times
 *   trailer: u16 extraLength, extraLength bytes
 *
 * `version` is written but NOT enforced here: this function only encodes, it
 * never has a reason to refuse an unexpected version, and a decoder deciding
 * what to do about a version mismatch (drop the snapshot, best-effort decode
 * anyway, trigger a client reload) is a policy call that belongs to the
 * caller, not to the codec.
 */
export function encodeDefaultSnapshot(s: DefaultSnapshot): Uint8Array {
  const w = new ByteWriter();
  w.u8(s.version);
  w.u32(s.tick);
  w.f64(s.serverTime);
  w.u16(s.entities.length);
  for (const e of s.entities) {
    w.u16(e.id);
    w.i16(quantizeCm(e.x));
    w.i16(quantizeCm(e.y));
    w.u16(quantizeAngle(e.heading ?? 0));
    w.u8(e.state ?? 0);
  }
  const extra = s.extra ?? new Uint8Array(0);
  w.u16(extra.length);
  w.bytes(extra);
  return w.finish();
}

/**
 * The inverse of `encodeDefaultSnapshot`. Every field read goes through
 * `ByteReader`, which bounds-checks and throws `CodecError` on any shortfall
 * (see `bytes.ts`), so a TRUNCATED buffer throws here rather than returning a
 * snapshot with some entities present and the rest silently missing: a caller
 * that trusted a half-decoded snapshot would render some players' positions
 * from garbage bytes, or from whatever the next field in the buffer happened
 * to be, which is a worse failure than an exception a caller can catch and
 * treat as "drop this snapshot".
 */
export function decodeDefaultSnapshot(buf: ArrayBuffer | Uint8Array): DefaultSnapshot {
  const r = new ByteReader(buf);
  const version = r.u8();
  const tick = r.u32();
  const serverTime = r.f64();
  const entityCount = r.u16();
  const entities: CodecEntity[] = [];
  for (let i = 0; i < entityCount; i++) {
    const id = r.u16();
    const x = dequantizeCm(r.i16());
    const y = dequantizeCm(r.i16());
    const heading = dequantizeAngle(r.u16());
    const state = r.u8();
    entities.push({ id, x, y, heading, state });
  }
  const extraLength = r.u16();
  const extra = r.bytes(extraLength);
  return { version, tick, serverTime, entities, extra };
}

export interface DefaultInputRecord {
  seq: number;
  targetTick: number;
  /** Two floats in roughly [-1, 1] (a movement stick, a steer/throttle pair). Quantized to `i8` on the wire, so values are recovered to ~1/127 precision, not bit-exact. */
  axes: [number, number];
  /** A held-buttons bitmask: run, interact, an emote key, whatever the caller's input shape needs. */
  buttons: number;
}

/** How many stamped inputs one window may carry. See the module comment below for why a client sends more than one. */
export const INPUT_WINDOW_MAX = 6;

const INPUT_WINDOW_VERSION = 1;
// Distinguishes this record shape from any future one that might share the
// same version+count framing (a different axis count, a richer button field).
// A version bump changes the whole envelope's meaning; a type byte lets a
// second record shape ride the same envelope without one.
const INPUT_RECORD_TYPE = 1;

// seq(u32) + targetTick(u32) + axisX(i8) + axisY(i8) + buttons(u8)
const INPUT_RECORD_SIZE = 4 + 4 + 1 + 1 + 1;

const AXIS_SCALE = 127;

function quantizeAxis(v: number): number {
  return quantize(v, AXIS_SCALE, -AXIS_SCALE, AXIS_SCALE);
}

function dequantizeAxis(q: number): number {
  return dequantize(q, AXIS_SCALE);
}

/**
 * THE INPUT REDUNDANCY WINDOW, the single most load-bearing idea in this
 * file and the least obvious one. A naive client sends only its NEWEST
 * stamped input every tick. Under real packet loss or reordering, a single
 * dropped or delayed packet is a single dropped or delayed INPUT, and because
 * a receiver's `PlayoutBuffer` consumes exactly the item stamped for a given
 * tick (never "whatever arrived most recently"), that missing input starves
 * a real tick of simulation on the server, which then has to guess (repeat
 * the last known input, decay it toward neutral) rather than knowing what
 * actually happened.
 *
 * Instead, this window carries the client's LAST FEW stamped inputs, newest
 * last, on every packet. That is cheap because `PlayoutBuffer.push` is
 * duplicate-overwriting and out-of-order safe by construction (see
 * `core/playout.ts`): re-sending an input the receiver already has costs
 * nothing but the bytes, since a repeat push for a tick already filled is a
 * no-op. The payoff is that a SINGLE lost or reordered packet stops mattering
 * at all, because the very next packet almost always carries the missing
 * tick's input again. Packet loss goes from "a visible correction the moment
 * a starved tick's guess turns out wrong" to "nothing happens", for a few
 * extra bytes on every send. `INPUT_WINDOW_MAX` (6) is a generous window for
 * this: at a 20Hz send rate that is 300ms of redundancy, which absorbs
 * several consecutive drops, not just one.
 */
export function encodeInputWindow(records: DefaultInputRecord[]): Uint8Array {
  if (records.length < 1 || records.length > INPUT_WINDOW_MAX) {
    throw new CodecError(
      `input window must carry 1..${INPUT_WINDOW_MAX} records, got ${records.length}`
    );
  }
  const w = new ByteWriter();
  w.u8(INPUT_WINDOW_VERSION);
  w.u8(INPUT_RECORD_TYPE);
  w.u8(records.length);
  for (const rec of records) {
    w.u32(rec.seq);
    w.u32(rec.targetTick);
    w.i8(quantizeAxis(rec.axes[0]));
    w.i8(quantizeAxis(rec.axes[1]));
    w.u8(rec.buttons);
  }
  return w.finish();
}

/**
 * The inverse of `encodeInputWindow`, and a TRUST BOUNDARY in the strictest
 * sense: every byte this reads came off the network from a client, which
 * means a peer that wants to misbehave controls every field including the
 * declared record count. Two rules make that safe, and both are security
 * requirements rather than style:
 *
 * 1. VERSION (and record type) IS COMPARED FIRST, before any record is
 *    decoded. A packet from a mismatched build decodes to an EMPTY window,
 *    never to fields read at the wrong offsets, which is what would happen
 *    if decoding proceeded optimistically and only checked the version as an
 *    afterthought. This is also what makes a rolling deploy safe: an old
 *    client's packets are simply ignored by a new server (and vice versa)
 *    until both sides have rolled, rather than misread into nonsense inputs.
 *
 * 2. `count` IS CLAMPED to BOTH the protocol ceiling (`INPUT_WINDOW_MAX`) AND
 *    the number of complete records the buffer actually has bytes for. A
 *    crafted packet claiming `count: 255` must not be taken at its word: an
 *    implementation that trusted it would either read past the buffer (and
 *    on a permissive reader, silently misinterpret whatever memory follows
 *    as more input records) or, worse, allocate and push 255 playout-buffer
 *    entries from a handful of real bytes, a cheap amplification attack
 *    against server memory and CPU. Computing `count` as
 *    `min(declaredCount, INPUT_WINDOW_MAX, bytesRemaining / recordSize)`
 *    means the decoded record count can never exceed what the packet
 *    actually, physically contains.
 *
 * The consequence of both rules together is that ANY malformed input,
 * whatever the shape of the malformation, decodes to a same-shaped `[]`
 * rather than throwing: a caller on a hot path (the relay forwarding a
 * client's raw frame) should never need a try/catch around this call for it
 * to be safe to run every tick against arbitrary network input.
 */
export function decodeInputWindow(buf: ArrayBuffer | Uint8Array): DefaultInputRecord[] {
  const r = new ByteReader(buf);
  if (!r.has(3)) return [];
  const version = r.u8();
  const type = r.u8();
  const declaredCount = r.u8();
  if (version !== INPUT_WINDOW_VERSION || type !== INPUT_RECORD_TYPE) return [];

  const maxByBuffer = Math.floor(r.remaining / INPUT_RECORD_SIZE);
  const count = Math.min(declaredCount, INPUT_WINDOW_MAX, maxByBuffer);
  if (count <= 0) return [];

  const records: DefaultInputRecord[] = [];
  for (let i = 0; i < count; i++) {
    const seq = r.u32();
    const targetTick = r.u32();
    const axisX = dequantizeAxis(r.i8());
    const axisY = dequantizeAxis(r.i8());
    const buttons = r.u8();
    records.push({ seq, targetTick, axes: [axisX, axisY], buttons });
  }
  return records;
}

/** Maps a decoded input window onto the core `ClientInput` shape `RoomRuntime`/`PlayoutBuffer` consume. `data` carries the axes and buttons; adjust the shape here (or skip this helper) if your simulation wants something else. */
export function inputWindowToClientInputs(records: DefaultInputRecord[]): ClientInput[] {
  return records.map((rec) => ({
    seq: rec.seq,
    targetTick: rec.targetTick,
    data: { axes: rec.axes, buttons: rec.buttons },
  }));
}
