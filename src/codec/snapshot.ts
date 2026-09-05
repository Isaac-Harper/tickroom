// A batteries-included default codec, for anyone who does not want to design
// a bit layout on day one. Adopt it to ship a working binary wire immediately;
// replace it with a hand-tuned one once your entity shape stabilizes. Nothing
// elsewhere in tickroom depends on this file: `RoomRuntime.encodeSnapshot` may
// return any `Uint8Array` it likes, this is just a reasonable one to start
// from.
import type { ClientInput } from '../core/index.js';
import { ByteWriter, ByteReader, CodecError, ProtocolVersionError } from './bytes.js';
import { quantize, dequantize, quantizeAngle, dequantizeAngle, CM_SCALE, I16, U16 } from './quantize.js';

export interface CodecEntity {
  /**
   * A stable per-entity handle, `0..65535`. A `u16` on the wire, and OUT OF
   * RANGE THROWS rather than wrapping: see `encodeDefaultSnapshot`.
   *
   * It is a NUMBER while every pid this library hands a simulation is a
   * `string`, so a host using this codec needs a pid-to-small-int mapping.
   * `SessionInfo.handle` is that integer and is what the default socket URL
   * already carries as `h=..`.
   */
  id: number;
  x: number;
  y: number;
  /** Radians. Defaults to 0 on encode if omitted; always present on decode. */
  heading?: number | undefined;
  /** An opaque `u8` state/anim value: idle vs moving, a colour index, a phase. Defaults to 0. */
  state?: number | undefined;
}

export interface DefaultSnapshot {
  version: number;
  tick: number;
  serverTime: number;
  entities: CodecEntity[];
  /** Room-specific bytes this codec does not know how to interpret (an activities container, a score block). Round-trips opaque. */
  extra?: Uint8Array | undefined;
}

export const DEFAULT_SNAPSHOT_VERSION = 1;

export interface DefaultSnapshotCodecOptions {
  /**
   * Units per integer step for the two position fields, i.e. what one `i16`
   * count MEANS in the host's world. Defaults to `CM_SCALE` (100), which
   * reads the `x`/`y` on `CodecEntity` as METRES and spans -327.68m to
   * +327.67m at 1cm resolution.
   *
   * A HOST WHOSE COORDINATES ARE NOT METRES MUST SET THIS. Pixels and screen
   * units are the common case (this library is aimed at 2D games, cursor
   * layers and map overlays, and those rarely count in metres), and at the
   * default scale everything outside that span CLAMPS to the boundary: entities
   * pile up against a wall the host never placed, with no error, no warning
   * and nothing in a metric to see. A pixel host wants `positionScale: 1`,
   * which is -32768 to +32767 pixels at 1px resolution. Pass the same value to
   * `representableRange` at startup and assert your world bounds fit, because
   * that assertion is the only signal this ever produces.
   *
   * THE ENCODER AND THE DECODER MUST AGREE, and disagreement is silent:
   * neither the scale nor the range is on the wire, so a decoder reading at
   * 100 what an encoder wrote at 1 recovers a world 100x too small rather
   * than failing. Changing this therefore changes what the BYTES MEAN while
   * moving no byte at all, which by this repo's own rule is a protocol
   * version bump (see `docs/ARCHITECTURE.md`, and the invariant in
   * `AGENTS.md`: a wire change bumps the version when it changes MEANING, not
   * only when it changes SHAPE). The version byte is already in the frame and
   * `DEFAULT_SNAPSHOT_VERSION` deliberately does NOT move for this, because
   * the default wire is unchanged and only the HOST knows it picked a
   * different scale: owning that bump is the host's job.
   */
  positionScale?: number | undefined;
}

/**
 * Wire layout, all little-endian (see `bytes.ts`):
 *
 *   header:  u8 version, u32 tick, f64 serverTime, u16 entityCount
 *   entity:  u16 id, i16 x, i16 y, u16 heading(turn), u8 state
 *            ... repeated entityCount times
 *   trailer: u16 extraLength, extraLength bytes
 *
 * `x` and `y` are quantised at `positionScale`, which DEFAULTS to `CM_SCALE`
 * but is no longer fixed at it, so this layout does not name their unit: the
 * bytes mean whatever scale the caller passed, and both ends must agree. This
 * comment used to say `x(cm)`, which stopped being true the moment the scale
 * became a parameter, and it is the first thing a host reads when working out
 * what its coordinates mean, i.e. exactly the confusion the parameter was
 * added to end.
 *
 * `version` is written but NOT enforced HERE: this function only encodes, so
 * it never has a reason to refuse an unexpected value someone asks it to
 * write. `decodeDefaultSnapshot` is where the version is enforced, and it
 * throws on a mismatch rather than leaving that as a policy call for the
 * caller; see that function's own docstring for why.
 *
 * AN OUT-OF-RANGE ENTITY ID THROWS, and it is the one field here that does not
 * go through the quantiser. `x` and `y` clamp, which is right for a coordinate
 * (an entity pinned at a boundary it nearly reached reads as an entity against
 * a wall) and is exactly wrong for an identity: `ByteWriter.u16` WRAPS, so an
 * id of 70000 was written as 4464 and two players silently shared one entity
 * for the rest of the room's life, in a library whose own quantiser docs shout
 * CLAMP, NEVER WRAP. Neither answer works for an identity, because there is no
 * such thing as a nearby id: 65535 is not an approximation of 70000, it is a
 * different player. A host derives these from something monotonic (a join
 * counter, a row id) often enough that the wrap is reachable in ordinary use,
 * so this refuses the frame the way `encodeInputWindow` already refuses a
 * window with too many records.
 *
 * `entities.length` AND `extra.length` ARE CHECKED AGAINST THE u16 CEILING
 * TOO, up front, for the same reason `id` is: both ride a `u16` header field
 * (`entityCount`, `extraLength`) that `ByteWriter.u16` now refuses to wrap
 * rather than silently truncate, but a caller deserves a message that names
 * which field overflowed rather than the generic one `ByteWriter` throws
 * partway through encoding. Measured: 65537 entities wrapped `entityCount` to
 * 1 and the decoder returned a one-entity snapshot with 65536 more silently
 * dropped; a 70000-byte `extra` block wrapped `extraLength` to 4464 and the
 * decoder handed back 4464 bytes and threw away the rest.
 */
export function encodeDefaultSnapshot(
  s: DefaultSnapshot,
  opts?: DefaultSnapshotCodecOptions
): Uint8Array {
  const scale = opts?.positionScale ?? CM_SCALE;
  if (s.entities.length > U16.max) {
    throw new CodecError(
      `too many entities to encode: ${s.entities.length} exceeds the u16 entityCount ceiling of ${U16.max}`
    );
  }
  const extra = s.extra ?? new Uint8Array(0);
  if (extra.length > U16.max) {
    throw new CodecError(
      `extra payload too large to encode: ${extra.length} bytes exceeds the u16 length-prefix ceiling of ${U16.max}`
    );
  }
  const w = new ByteWriter();
  w.u8(s.version);
  w.u32(s.tick);
  w.f64(s.serverTime);
  w.u16(s.entities.length);
  for (const e of s.entities) {
    if (!Number.isInteger(e.id) || e.id < U16.min || e.id > U16.max) {
      throw new CodecError(`entity id must be an integer in ${U16.min}..${U16.max}, got ${e.id}`);
    }
    w.u16(e.id);
    w.i16(quantize(e.x, scale, I16.min, I16.max));
    w.i16(quantize(e.y, scale, I16.min, I16.max));
    w.u16(quantizeAngle(e.heading ?? 0));
    w.u8(e.state ?? 0);
  }
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
 *
 * THE VERSION BYTE IS COMPARED FIRST, before any other field is read, exactly
 * the pattern `docs/ARCHITECTURE.md` describes and `examples/pong/codec.ts`
 * works through in full: a mismatched decoder that read fields optimistically
 * and only checked the version as an afterthought would not fail on a version
 * skew, it would MISREAD, taking whatever byte offset used to be one field as
 * a different one now. Checking first turns that into an immediate
 * `ProtocolVersionError` (a `CodecError` subtype, so a caller that only wants
 * "did this decode fail" keeps working unchanged, and one that wants to
 * recover from skew specifically, e.g. `RoomConnection`, can check
 * `error.name === 'ProtocolVersionError'` or `instanceof`) before a single
 * byte of the mismatched body is touched.
 *
 * `positionScale` must MATCH the one the encoder used. Nothing on the wire
 * records it, so a mismatch is silent: see `DefaultSnapshotCodecOptions`.
 */
export function decodeDefaultSnapshot(
  buf: ArrayBuffer | Uint8Array,
  opts?: DefaultSnapshotCodecOptions
): DefaultSnapshot {
  const scale = opts?.positionScale ?? CM_SCALE;
  const r = new ByteReader(buf);
  const version = r.u8();
  if (version !== DEFAULT_SNAPSHOT_VERSION) {
    throw new ProtocolVersionError(DEFAULT_SNAPSHOT_VERSION, version);
  }
  const tick = r.u32();
  const serverTime = r.f64();
  const entityCount = r.u16();
  const entities: CodecEntity[] = [];
  for (let i = 0; i < entityCount; i++) {
    const id = r.u16();
    const x = dequantize(r.i16(), scale);
    const y = dequantize(r.i16(), scale);
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
  /**
   * Two floats (a movement stick, a steer/throttle pair). Quantized to `i8` on
   * the wire, so at the default `axisScale` they span [-1, 1] and are recovered
   * to ~1/127 precision, not bit-exact.
   *
   * OUT-OF-RANGE VALUES CLAMP, SILENTLY, exactly as positions do in the
   * snapshot half of this file. `[640, 480]` encodes and decodes as `[1, 1]`,
   * so a host that reached for this window to carry cursor COORDINATES got
   * every remote cursor stacked in one corner with no error and nothing in a
   * metric. `axisScale` moves the boundary (see `DefaultInputWindowOptions`),
   * but note what it cannot move: the field is an `i8`, so the whole range is
   * 254 steps however it is scaled. A stick is what that resolution is for. A
   * position wants its own record shape on `ByteWriter`, at `i16` or wider.
   */
  axes: [number, number];
  /** A held-buttons bitmask: run, interact, an emote key, whatever the caller's input shape needs. */
  buttons: number;
}

export interface DefaultInputWindowOptions {
  /**
   * Integer steps per axis unit, i.e. what one `i8` count MEANS in the host's
   * input space. Defaults to `AXIS_SCALE` (127), which reads `axes` as a
   * normalised stick and spans [-1, 1] at 1/127.
   *
   * The mirror of `positionScale` on the snapshot half, and it exists for the
   * same reason: the range is not on the wire, the quantiser CLAMPS at the
   * boundary, and a clamp against a range the host never chose is silent. A
   * host whose axes are percentages wants `axisScale: 1` (+-127 at 1 whole
   * unit); one whose axes are already normalised should leave it alone.
   *
   * THE ENCODER AND THE DECODER MUST AGREE. Nothing records the scale, so a
   * decoder reading at 127 what an encoder wrote at 1 recovers inputs 127x too
   * small rather than failing, and that is a change in what the BYTES MEAN
   * while moving no byte, which by this repo's rule is a protocol version bump
   * the HOST owns. `INPUT_WINDOW_VERSION` deliberately does not move for it,
   * because the default wire is unchanged.
   */
  axisScale?: number | undefined;
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

/** Default `axisScale`: 127 integer steps per axis unit, i.e. a normalised stick spanning [-1, 1] in an `i8`. Exported so a host can name the default it is comparing its own scale against, the same way `CM_SCALE` is. */
export const AXIS_SCALE = 127;

/** The clamp bound for an axis, and the reason `axisScale` can move the boundary without ever buying more than 255 steps of resolution: the field is an `i8`. SYMMETRIC, giving up the `i8`'s one extra negative step, so full deflection means the same magnitude in both directions; an asymmetric stick reads as a controller that pulls slightly to one side. */
const AXIS_LIMIT = 127;

function quantizeAxis(v: number, scale: number): number {
  return quantize(v, scale, -AXIS_LIMIT, AXIS_LIMIT);
}

function dequantizeAxis(q: number, scale: number): number {
  return dequantize(q, scale);
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
export function encodeInputWindow(
  records: DefaultInputRecord[],
  opts?: DefaultInputWindowOptions
): Uint8Array {
  const scale = opts?.axisScale ?? AXIS_SCALE;
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
    w.i8(quantizeAxis(rec.axes[0], scale));
    w.i8(quantizeAxis(rec.axes[1], scale));
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
 *
 * THAT PROMISE COVERS THE RUNTIME SHAPE OF `buf` ITSELF, not only its
 * contents, which the two rules above already handle. The parameter is typed
 * `ArrayBuffer | Uint8Array`, but a caller past a permissive boundary (an
 * any-typed message bus, a `JSON.parse`'d payload nobody validated) can hand
 * over a string, `null`, or an array of `Buffer`s despite what the type says,
 * and `new ByteReader` builds a `DataView` straight from whatever it is
 * given: `DataView`'s own constructor throws a bare, uncaught `TypeError` on
 * anything that is not an `ArrayBuffer` (or a typed-array view over one), not
 * a `CodecError` this module's contract already covers. So the runtime shape
 * is checked before `ByteReader` is ever constructed, and anything that is
 * neither an `ArrayBuffer` nor an `ArrayBufferView` decodes to `[]` exactly
 * like every other malformed input above.
 */
export function decodeInputWindow(
  buf: ArrayBuffer | Uint8Array,
  opts?: DefaultInputWindowOptions
): DefaultInputRecord[] {
  if (!(buf instanceof ArrayBuffer) && !ArrayBuffer.isView(buf)) return [];
  const scale = opts?.axisScale ?? AXIS_SCALE;
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
    const axisX = dequantizeAxis(r.i8(), scale);
    const axisY = dequantizeAxis(r.i8(), scale);
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
