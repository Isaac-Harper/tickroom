// A minimal little-endian byte reader/writer for hand-rolled binary wire
// formats. Nothing here is clever; the value is in being boring and correct.
//
// WHY EXPLICIT LITTLE-ENDIAN, STATED ON EVERY CALL. `DataView` defaults to
// BIG-endian on every getter/setter unless you pass `true` as the last
// argument, while `Uint16Array`/`Uint32Array` (etc.) read and write in the
// PLATFORM'S native endianness, which is little-endian on essentially every
// real deployment target (x86, ARM in its default mode) but is not guaranteed
// by the language. A codec that mixes the two, or that relies on `DataView`'s
// default, is a bug that happens to work on every machine anyone tests on and
// then silently corrupts the wire the day it runs somewhere that assumption
// does not hold, or the day someone "simplifies" a call and drops the `true`.
// So every single `DataView` call below passes `true` explicitly, with no
// exceptions, and no helper here ever reaches for a typed-array view to read
// or write a multi-byte value.

/**
 * Thrown by `ByteReader` whenever a read cannot be satisfied. `ByteReader`
 * decodes bytes a client sent, which makes it a TRUST BOUNDARY: a short,
 * truncated, or maliciously crafted buffer must fail loudly and immediately
 * rather than reading past the end of the underlying buffer (which `DataView`
 * itself would throw a generic `RangeError` for, eventually, but only after
 * potentially reading garbage from whatever came before the bounds check) or
 * silently returning a half-decoded value that then propagates as though it
 * were real data. Every accessor on `ByteReader` checks its own bounds before
 * touching the view and throws this type, never a bare `RangeError`, so a
 * caller can catch exactly `CodecError` to mean "this buffer was not what I
 * expected" without also swallowing an unrelated bug.
 */
export class CodecError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CodecError';
  }
}

const DEFAULT_INITIAL_CAPACITY = 64;

/**
 * A growable little-endian byte buffer. Every setter returns `this` so a
 * message can be built as one fluent chain, which is also what keeps a hand
 * written encoder readable as a literal description of the wire layout: the
 * order the calls appear in IS the byte order on the wire.
 *
 * Grows geometrically (doubling) rather than to the exact size needed on each
 * write, so writing N fields costs O(log N) reallocations rather than O(N):
 * a per-tick snapshot encoder that grows one field at a time must not pay a
 * copy on every single field.
 */
export class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private arr: Uint8Array;
  private len = 0;

  constructor(initialCapacity: number = DEFAULT_INITIAL_CAPACITY) {
    const cap = Math.max(initialCapacity, 8);
    this.buf = new ArrayBuffer(cap);
    this.view = new DataView(this.buf);
    this.arr = new Uint8Array(this.buf);
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    while (cap < needed) cap *= 2;
    const nextBuf = new ArrayBuffer(cap);
    new Uint8Array(nextBuf).set(this.arr.subarray(0, this.len));
    this.buf = nextBuf;
    this.view = new DataView(this.buf);
    this.arr = new Uint8Array(this.buf);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.len, v);
    this.len += 1;
    return this;
  }

  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.len, v);
    this.len += 1;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
    return this;
  }

  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.len, v, true);
    this.len += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.len, v, true);
    this.len += 4;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.len, v, true);
    this.len += 4;
    return this;
  }

  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.len, v, true);
    this.len += 4;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.len, v, true);
    this.len += 8;
    return this;
  }

  bytes(src: Uint8Array): this {
    this.ensure(src.length);
    this.arr.set(src, this.len);
    this.len += src.length;
    return this;
  }

  /** UTF-8 bytes prefixed with a `u16` byte length (NOT a character count: multi-byte characters make the two disagree). */
  str(s: string): this {
    const encoded = new TextEncoder().encode(s);
    if (encoded.length > 0xffff) {
      throw new CodecError(
        `string too long to encode with a u16 length prefix: ${encoded.length} UTF-8 bytes exceeds 65535`
      );
    }
    this.u16(encoded.length);
    return this.bytes(encoded);
  }

  /** Bytes written so far. Not the underlying buffer's capacity, which is usually larger. */
  get length(): number {
    return this.len;
  }

  /** An exact-length copy of everything written. Safe to hand off (publish, send) without the writer's spare capacity leaking along with it. */
  finish(): Uint8Array {
    return this.arr.slice(0, this.len);
  }
}

/**
 * A little-endian byte cursor over an existing buffer. Every read advances
 * the cursor and every read bounds-checks first; see `CodecError` above for
 * why that is not optional here.
 */
export class ByteReader {
  private readonly view: DataView;
  private readonly arr: Uint8Array;
  private pos = 0;

  constructor(buf: ArrayBuffer | Uint8Array) {
    if (buf instanceof Uint8Array) {
      // Respect byteOffset/byteLength rather than assuming the view covers
      // its whole underlying buffer: a caller handing us a subarray (a slice
      // of a larger frame) must only ever have that slice readable, not
      // whatever memory happens to sit around it in the parent buffer.
      this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.arr = buf;
    } else {
      this.view = new DataView(buf);
      this.arr = new Uint8Array(buf);
    }
  }

  private need(n: number): void {
    if (this.pos + n > this.arr.length) {
      throw new CodecError(
        `read past end of buffer: need ${n} byte(s) at offset ${this.pos}, only ${this.arr.length - this.pos} remaining`
      );
    }
  }

  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  i8(): number {
    this.need(1);
    const v = this.view.getInt8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** A COPY of `n` bytes, never a view into the source buffer, so the caller can hold it past the source's lifetime. */
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.arr.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /** The `str()` counterpart: reads a `u16` byte length prefix, then that many UTF-8 bytes. */
  str(): string {
    const n = this.u16();
    const raw = this.bytes(n);
    return new TextDecoder().decode(raw);
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.arr.length - this.pos;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  /** True when at least `n` more bytes are readable. The non-throwing counterpart to the bounds check every accessor already does, for a caller that wants to check before it commits to a read (see `decodeInputWindow`, which must never throw on untrusted input). */
  has(n: number): boolean {
    return this.pos + n <= this.arr.length;
  }
}
