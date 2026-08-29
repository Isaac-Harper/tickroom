import { describe, it, expect } from 'vitest';
import { ByteWriter, ByteReader, CodecError } from './bytes.js';

describe('ByteWriter / ByteReader round trips', () => {
  it('round-trips u8', () => {
    const buf = new ByteWriter().u8(0).u8(255).u8(17).finish();
    const r = new ByteReader(buf);
    expect(r.u8()).toBe(0);
    expect(r.u8()).toBe(255);
    expect(r.u8()).toBe(17);
  });

  it('round-trips i8', () => {
    const buf = new ByteWriter().i8(-128).i8(127).i8(-1).finish();
    const r = new ByteReader(buf);
    expect(r.i8()).toBe(-128);
    expect(r.i8()).toBe(127);
    expect(r.i8()).toBe(-1);
  });

  it('round-trips u16', () => {
    const buf = new ByteWriter().u16(0).u16(65535).u16(4660).finish();
    const r = new ByteReader(buf);
    expect(r.u16()).toBe(0);
    expect(r.u16()).toBe(65535);
    expect(r.u16()).toBe(4660);
  });

  it('round-trips i16', () => {
    const buf = new ByteWriter().i16(-32768).i16(32767).i16(-1).finish();
    const r = new ByteReader(buf);
    expect(r.i16()).toBe(-32768);
    expect(r.i16()).toBe(32767);
    expect(r.i16()).toBe(-1);
  });

  it('round-trips u32', () => {
    const buf = new ByteWriter().u32(0).u32(4294967295).u32(123456789).finish();
    const r = new ByteReader(buf);
    expect(r.u32()).toBe(0);
    expect(r.u32()).toBe(4294967295);
    expect(r.u32()).toBe(123456789);
  });

  it('round-trips i32', () => {
    const buf = new ByteWriter().i32(-2147483648).i32(2147483647).i32(-1).finish();
    const r = new ByteReader(buf);
    expect(r.i32()).toBe(-2147483648);
    expect(r.i32()).toBe(2147483647);
    expect(r.i32()).toBe(-1);
  });

  it('round-trips f32 within float32 precision', () => {
    const buf = new ByteWriter().f32(1.5).f32(-3.25).f32(0).finish();
    const r = new ByteReader(buf);
    expect(r.f32()).toBeCloseTo(1.5, 5);
    expect(r.f32()).toBeCloseTo(-3.25, 5);
    expect(r.f32()).toBe(0);
  });

  it('round-trips f64 exactly', () => {
    const buf = new ByteWriter().f64(Math.PI).f64(-1.23456789e10).finish();
    const r = new ByteReader(buf);
    expect(r.f64()).toBe(Math.PI);
    expect(r.f64()).toBe(-1.23456789e10);
  });

  it('round-trips raw bytes', () => {
    const src = new Uint8Array([1, 2, 3, 4, 5]);
    const buf = new ByteWriter().u8(9).bytes(src).u8(9).finish();
    const r = new ByteReader(buf);
    expect(r.u8()).toBe(9);
    expect(Array.from(r.bytes(5))).toEqual([1, 2, 3, 4, 5]);
    expect(r.u8()).toBe(9);
  });

  it('round-trips multi-byte UTF-8 strings', () => {
    const s = 'héllo wörld 日本語 🎮';
    const buf = new ByteWriter().str(s).finish();
    const r = new ByteReader(buf);
    expect(r.str()).toBe(s);
  });

  it('round-trips an empty string', () => {
    const buf = new ByteWriter().str('').finish();
    const r = new ByteReader(buf);
    expect(r.str()).toBe('');
  });

  it('str() refuses to encode past a u16 length prefix', () => {
    const huge = 'x'.repeat(70000);
    expect(() => new ByteWriter().str(huge)).toThrow(CodecError);
  });

  it('mixed-type sequence round-trips in declared order', () => {
    const w = new ByteWriter()
      .u8(1)
      .i16(-42)
      .u32(999999)
      .f64(2.5)
      .str('room-1')
      .u8(255);
    const buf = w.finish();
    const r = new ByteReader(buf);
    expect(r.u8()).toBe(1);
    expect(r.i16()).toBe(-42);
    expect(r.u32()).toBe(999999);
    expect(r.f64()).toBe(2.5);
    expect(r.str()).toBe('room-1');
    expect(r.u8()).toBe(255);
  });

  it('grows past its initial capacity without corrupting earlier writes', () => {
    const w = new ByteWriter(4); // tiny initial capacity forces several regrows
    for (let i = 0; i < 500; i++) w.u16(i);
    const buf = w.finish();
    expect(buf.length).toBe(1000);
    const r = new ByteReader(buf);
    for (let i = 0; i < 500; i++) expect(r.u16()).toBe(i);
  });

  it('finish() returns an exact-length copy, not the writer\'s spare capacity', () => {
    const w = new ByteWriter(256);
    w.u8(7);
    const buf = w.finish();
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(7);
  });
});

describe('ByteReader accepts both ArrayBuffer and a Uint8Array view', () => {
  it('reads correctly from a Uint8Array subarray (respects byteOffset)', () => {
    const full = new ByteWriter().u8(0xaa).u16(4660).u8(0xbb).finish();
    // Slice out just the u16 in the middle, at a non-zero byteOffset, and
    // confirm the reader does not read bytes from outside the slice.
    const middle = full.subarray(1, 3);
    const r = new ByteReader(middle);
    expect(r.u16()).toBe(4660);
    expect(r.has(1)).toBe(false);
  });

  it('reads correctly from a raw ArrayBuffer', () => {
    const buf = new ByteWriter().u32(42).finish();
    const ab = new ArrayBuffer(buf.length);
    new Uint8Array(ab).set(buf);
    const r = new ByteReader(ab);
    expect(r.u32()).toBe(42);
  });
});

describe('ByteReader is a trust boundary: every accessor throws CodecError past the end', () => {
  it('u8 throws on empty buffer', () => {
    expect(() => new ByteReader(new Uint8Array(0)).u8()).toThrow(CodecError);
  });
  it('i8 throws on empty buffer', () => {
    expect(() => new ByteReader(new Uint8Array(0)).i8()).toThrow(CodecError);
  });
  it('u16 throws with only one byte available', () => {
    expect(() => new ByteReader(new Uint8Array(1)).u16()).toThrow(CodecError);
  });
  it('i16 throws with only one byte available', () => {
    expect(() => new ByteReader(new Uint8Array(1)).i16()).toThrow(CodecError);
  });
  it('u32 throws with three bytes available', () => {
    expect(() => new ByteReader(new Uint8Array(3)).u32()).toThrow(CodecError);
  });
  it('i32 throws with three bytes available', () => {
    expect(() => new ByteReader(new Uint8Array(3)).i32()).toThrow(CodecError);
  });
  it('f32 throws with three bytes available', () => {
    expect(() => new ByteReader(new Uint8Array(3)).f32()).toThrow(CodecError);
  });
  it('f64 throws with seven bytes available', () => {
    expect(() => new ByteReader(new Uint8Array(7)).f64()).toThrow(CodecError);
  });
  it('bytes(n) throws when fewer than n bytes remain', () => {
    expect(() => new ByteReader(new Uint8Array(2)).bytes(3)).toThrow(CodecError);
  });
  it('str() throws when the declared length exceeds what remains', () => {
    // A length prefix of 100 with no payload behind it.
    const buf = new ByteWriter().u16(100).finish();
    expect(() => new ByteReader(buf).str()).toThrow(CodecError);
  });
  it('skip(n) throws when fewer than n bytes remain', () => {
    expect(() => new ByteReader(new Uint8Array(1)).skip(2)).toThrow(CodecError);
  });
  it('a second read past a partially-consumed buffer still throws', () => {
    const buf = new ByteWriter().u8(1).u8(2).finish();
    const r = new ByteReader(buf);
    r.u8();
    r.u8();
    expect(() => r.u8()).toThrow(CodecError);
  });
});

describe('ByteReader.has / offset / remaining', () => {
  it('has() reports readability without consuming or throwing', () => {
    const buf = new ByteWriter().u32(1).finish();
    const r = new ByteReader(buf);
    expect(r.has(4)).toBe(true);
    expect(r.has(5)).toBe(false);
    expect(r.offset).toBe(0);
    r.u32();
    expect(r.offset).toBe(4);
    expect(r.remaining).toBe(0);
    expect(r.has(1)).toBe(false);
  });
});

describe('explicit little-endian byte order', () => {
  it('u16 writes the low byte first', () => {
    // 0x1234 little-endian is bytes [0x34, 0x12], the opposite of what
    // DataView's own big-endian default would produce ([0x12, 0x34]). This
    // pins the explicit `true` (littleEndian) argument on every DataView call.
    const buf = new ByteWriter().u16(0x1234).finish();
    expect(Array.from(buf)).toEqual([0x34, 0x12]);
  });

  it('u32 writes bytes in ascending significance order', () => {
    const buf = new ByteWriter().u32(0x12345678).finish();
    expect(Array.from(buf)).toEqual([0x78, 0x56, 0x34, 0x12]);
  });

  it('i16 negative values use the same little-endian byte order', () => {
    // -1 as i16 is 0xffff regardless of endianness, so use a value whose
    // bytes differ: -2 is 0xfffe, little-endian bytes [0xfe, 0xff].
    const buf = new ByteWriter().i16(-2).finish();
    expect(Array.from(buf)).toEqual([0xfe, 0xff]);
  });

  it('a known hex sequence decodes to the expected u32', () => {
    const raw = new Uint8Array([0x78, 0x56, 0x34, 0x12]);
    expect(new ByteReader(raw).u32()).toBe(0x12345678);
  });
});
