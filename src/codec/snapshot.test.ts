import { describe, it, expect } from 'vitest';
import { ByteWriter } from './bytes.js';
import {
  DEFAULT_SNAPSHOT_VERSION,
  encodeDefaultSnapshot,
  decodeDefaultSnapshot,
  INPUT_WINDOW_MAX,
  encodeInputWindow,
  decodeInputWindow,
  inputWindowToClientInputs,
  type DefaultSnapshot,
  type DefaultInputRecord,
} from './snapshot.js';
import { I16, CM_SCALE, representableRange } from './quantize.js';

describe('default snapshot codec', () => {
  it('round-trips a snapshot with several entities', () => {
    const snap: DefaultSnapshot = {
      version: DEFAULT_SNAPSHOT_VERSION,
      tick: 123456,
      serverTime: 1_700_000_000_123.456,
      entities: [
        { id: 1, x: 10.5, y: -20.25, heading: 0.5, state: 1 },
        { id: 2, x: -300, y: 300, heading: 0, state: 0 },
        { id: 65535, x: 0, y: 0, heading: Math.PI, state: 255 },
      ],
    };
    const buf = encodeDefaultSnapshot(snap);
    const back = decodeDefaultSnapshot(buf);

    expect(back.version).toBe(snap.version);
    expect(back.tick).toBe(snap.tick);
    expect(back.serverTime).toBe(snap.serverTime);
    expect(back.entities).toHaveLength(3);

    expect(back.entities[0].id).toBe(1);
    expect(back.entities[0].x).toBeCloseTo(10.5, 2);
    expect(back.entities[0].y).toBeCloseTo(-20.25, 2);
    expect(back.entities[0].heading).toBeCloseTo(0.5, 3);
    expect(back.entities[0].state).toBe(1);

    expect(back.entities[2].id).toBe(65535);
    expect(back.entities[2].heading).toBeCloseTo(Math.PI, 3);
    expect(back.entities[2].state).toBe(255);
  });

  it('round-trips an empty entity list', () => {
    const snap: DefaultSnapshot = { version: 1, tick: 0, serverTime: 0, entities: [] };
    const back = decodeDefaultSnapshot(encodeDefaultSnapshot(snap));
    expect(back.entities).toEqual([]);
  });

  it('defaults heading and state to 0 when omitted on encode', () => {
    const snap: DefaultSnapshot = {
      version: 1,
      tick: 1,
      serverTime: 0,
      entities: [{ id: 1, x: 0, y: 0 }],
    };
    const back = decodeDefaultSnapshot(encodeDefaultSnapshot(snap));
    expect(back.entities[0].heading).toBe(0);
    expect(back.entities[0].state).toBe(0);
  });

  it('round-trips extra opaque bytes untouched', () => {
    const extra = new Uint8Array([9, 8, 7, 6, 5]);
    const snap: DefaultSnapshot = { version: 1, tick: 1, serverTime: 0, entities: [], extra };
    const back = decodeDefaultSnapshot(encodeDefaultSnapshot(snap));
    expect(Array.from(back.extra!)).toEqual([9, 8, 7, 6, 5]);
  });

  it('a truncated buffer throws rather than returning a half-decoded snapshot', () => {
    const snap: DefaultSnapshot = {
      version: 1,
      tick: 1,
      serverTime: 0,
      entities: [
        { id: 1, x: 1, y: 1 },
        { id: 2, x: 2, y: 2 },
      ],
    };
    const full = encodeDefaultSnapshot(snap);
    // Cut the buffer off partway through the second entity's fields, so a
    // permissive decoder would return one real entity and one entity built
    // from garbage (or from the trailing extra-length field misread as
    // entity data) instead of failing outright.
    const truncated = full.slice(0, full.length - 3);
    expect(() => decodeDefaultSnapshot(truncated)).toThrow();
  });

  it('a buffer truncated right after the header throws', () => {
    const header = new ByteWriter().u8(1).u32(0).f64(0).u16(5).finish(); // claims 5 entities, has none
    expect(() => decodeDefaultSnapshot(header)).toThrow();
  });
});

describe('the default codec carries a host-chosen position scale', () => {
  // The snapshot behind the pinned bytes below. Kept beside them so the two
  // are read together.
  const pinnedSnapshot: DefaultSnapshot = {
    version: DEFAULT_SNAPSHOT_VERSION,
    tick: 7,
    serverTime: 1_700_000_000_123.5,
    entities: [
      { id: 1, x: 1.5, y: -2.25, heading: 0.5, state: 3 },
      { id: 2, x: 300, y: -300, heading: Math.PI, state: 0 },
    ],
    extra: new Uint8Array([1, 2, 3]),
  };

  it('encoding with NO options is byte-for-byte what it was before the option existed', () => {
    // THE POINT OF PINNING A LITERAL rather than comparing against a
    // re-encode: this test has to be able to fail. Two calls into the same
    // encoder agree with each other whatever the default scale happens to
    // be, so a re-encode comparison would stay green through exactly the
    // change it exists to catch. These bytes were captured from the tree
    // before `positionScale` was added; if they move, the default wire moved,
    // which is a protocol break for every existing consumer whether or not
    // anybody meant it.
    const expected = [
      1, 7, 0, 0, 0, 0, 184, 135, 86, 254, 188, 120, 66, 2, 0, 1, 0, 150, 0, 31, 255, 95, 20, 3, 2,
      0, 48, 117, 208, 138, 0, 128, 0, 3, 0, 1, 2, 3,
    ];
    expect(Array.from(encodeDefaultSnapshot(pinnedSnapshot))).toEqual(expected);
    // Passing the default explicitly must also be a no-op on the wire.
    expect(Array.from(encodeDefaultSnapshot(pinnedSnapshot, { positionScale: CM_SCALE }))).toEqual(
      expected
    );
  });

  it('a pixel host at scale 1 round-trips a position the metre default would destroy', () => {
    // x = 5000 is an ordinary coordinate in a 2D game measured in pixels and
    // is fifteen times past the far edge of what the centimetre default can
    // represent. This is the whole defect: at the default it clamps to
    // 327.67 with no error of any kind, and the entity parks itself against
    // an invisible wall.
    const snap: DefaultSnapshot = {
      version: DEFAULT_SNAPSHOT_VERSION,
      tick: 1,
      serverTime: 0,
      entities: [{ id: 1, x: 5000, y: -4200, heading: 0.25, state: 2 }],
    };

    const pixels = decodeDefaultSnapshot(encodeDefaultSnapshot(snap, { positionScale: 1 }), {
      positionScale: 1,
    });
    expect(pixels.entities[0].x).toBeCloseTo(5000, 6);
    expect(pixels.entities[0].y).toBeCloseTo(-4200, 6);
    expect(pixels.entities[0].heading).toBeCloseTo(0.25, 3);
    expect(pixels.entities[0].state).toBe(2);

    // The same snapshot through the default, for contrast: silently pinned.
    const metres = decodeDefaultSnapshot(encodeDefaultSnapshot(snap));
    expect(metres.entities[0].x).toBeCloseTo(327.67, 2);
    expect(metres.entities[0].y).toBeCloseTo(-327.68, 2);
  });

  it('a value past the configured range still CLAMPS and never wraps, at either scale', () => {
    // The existing invariant, pinned at the new scale as well as the old: an
    // out-of-range value must pin at the boundary it already nearly reached,
    // never reappear at the opposite edge of the world.
    const far: DefaultSnapshot = {
      version: DEFAULT_SNAPSHOT_VERSION,
      tick: 1,
      serverTime: 0,
      entities: [{ id: 1, x: 1_000_000, y: -1_000_000 }],
    };

    const atDefault = decodeDefaultSnapshot(encodeDefaultSnapshot(far)).entities[0];
    expect(atDefault.x).toBeCloseTo(representableRange(CM_SCALE).max, 6);
    expect(atDefault.y).toBeCloseTo(representableRange(CM_SCALE).min, 6);
    expect(atDefault.x).toBeGreaterThan(0);
    expect(atDefault.y).toBeLessThan(0);

    const atPixels = decodeDefaultSnapshot(encodeDefaultSnapshot(far, { positionScale: 1 }), {
      positionScale: 1,
    }).entities[0];
    expect(atPixels.x).toBe(I16.max);
    expect(atPixels.y).toBe(I16.min);
    expect(atPixels.x).toBeGreaterThan(0);
    expect(atPixels.y).toBeLessThan(0);
  });
});

describe('default input window codec', () => {
  it('round-trips a full valid window', () => {
    const records: DefaultInputRecord[] = [
      { seq: 1, targetTick: 100, axes: [1, -1], buttons: 0b0001 },
      { seq: 2, targetTick: 101, axes: [0, 0], buttons: 0 },
      { seq: 3, targetTick: 102, axes: [-1, 1], buttons: 0b1111 },
    ];
    const buf = encodeInputWindow(records);
    const back = decodeInputWindow(buf);
    expect(back).toHaveLength(3);
    expect(back[0].seq).toBe(1);
    expect(back[0].targetTick).toBe(100);
    expect(back[0].axes[0]).toBeCloseTo(1, 1);
    expect(back[0].axes[1]).toBeCloseTo(-1, 1);
    expect(back[0].buttons).toBe(0b0001);
    expect(back[2].buttons).toBe(0b1111);
  });

  it('round-trips the maximum window size', () => {
    const records: DefaultInputRecord[] = Array.from({ length: INPUT_WINDOW_MAX }, (_, i) => ({
      seq: i,
      targetTick: 1000 + i,
      axes: [0.5, -0.5] as [number, number],
      buttons: i,
    }));
    const back = decodeInputWindow(encodeInputWindow(records));
    expect(back).toHaveLength(INPUT_WINDOW_MAX);
    expect(back[INPUT_WINDOW_MAX - 1].targetTick).toBe(1000 + INPUT_WINDOW_MAX - 1);
  });

  it('encodeInputWindow refuses an empty or oversized window', () => {
    expect(() => encodeInputWindow([])).toThrow();
    const tooMany = Array.from({ length: INPUT_WINDOW_MAX + 1 }, (_, i) => ({
      seq: i,
      targetTick: i,
      axes: [0, 0] as [number, number],
      buttons: 0,
    }));
    expect(() => encodeInputWindow(tooMany)).toThrow();
  });

  it('decodeInputWindow returns [] for a wrong protocol version', () => {
    const buf = encodeInputWindow([{ seq: 1, targetTick: 1, axes: [0, 0], buttons: 0 }]);
    const corrupted = new Uint8Array(buf);
    corrupted[0] = 99; // version byte
    expect(decodeInputWindow(corrupted)).toEqual([]);
  });

  it('decodeInputWindow returns [] for an unrecognized record type', () => {
    const buf = encodeInputWindow([{ seq: 1, targetTick: 1, axes: [0, 0], buttons: 0 }]);
    const corrupted = new Uint8Array(buf);
    corrupted[1] = 99; // type byte
    expect(decodeInputWindow(corrupted)).toEqual([]);
  });

  it('decodeInputWindow returns [] for a truncated packet, never throws', () => {
    const buf = encodeInputWindow([
      { seq: 1, targetTick: 1, axes: [0, 0], buttons: 0 },
      { seq: 2, targetTick: 2, axes: [0, 0], buttons: 0 },
    ]);
    // Cut off partway through the FIRST record, so not even one complete
    // record is available: the count must clamp all the way to 0.
    const truncated = buf.slice(0, 3 + 5);
    expect(() => decodeInputWindow(truncated)).not.toThrow();
    expect(decodeInputWindow(truncated)).toEqual([]);
  });

  it('decodeInputWindow decodes only the complete records a partially-truncated packet actually holds', () => {
    const buf = encodeInputWindow([
      { seq: 1, targetTick: 1, axes: [0, 0], buttons: 0 },
      { seq: 2, targetTick: 2, axes: [0, 0], buttons: 0 },
    ]);
    // Cut off partway through the SECOND record: one complete record remains.
    const truncated = buf.slice(0, buf.length - 3);
    const result = decodeInputWindow(truncated);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(1);
  });

  it('decodeInputWindow returns [] for a header with no bytes at all', () => {
    expect(decodeInputWindow(new Uint8Array(0))).toEqual([]);
    expect(decodeInputWindow(new Uint8Array([1, 1]))).toEqual([]); // only 2 of the 3 header bytes
  });

  it('a crafted count:255 with no record bytes behind it does NOT allocate 255 records', () => {
    // A hand-built packet: valid version and type, but a declared record
    // count of 255 with zero bytes of actual record data following. A
    // decoder that trusted the declared count would try to read 255 * 11
    // bytes that are not there; this one must clamp the count against what
    // the buffer actually holds and return nothing rather than throw or
    // fabricate records from bytes that do not exist.
    const malicious = new ByteWriter().u8(1).u8(1).u8(255).finish();
    const result = decodeInputWindow(malicious);
    expect(result).toEqual([]);
    expect(result.length).not.toBe(255);
  });

  it('a crafted count:255 backed by only a few real records decodes exactly those records, not 255', () => {
    const w = new ByteWriter().u8(1).u8(1).u8(255); // declares 255, way over the truth
    // Append exactly 2 real records' worth of bytes by hand, matching the
    // wire layout: u32 seq, u32 targetTick, i8 axisX, i8 axisY, u8 buttons.
    for (let i = 0; i < 2; i++) {
      w.u32(i).u32(i).i8(0).i8(0).u8(0);
    }
    const malicious = w.finish();
    const result = decodeInputWindow(malicious);
    expect(result).toHaveLength(2);

    // THE OTHER HALF OF THE SAME CLAMP, and the half no truncated packet can
    // reach. Everything above is bounded by the BYTES PRESENT, so a decoder
    // that dropped the protocol ceiling and clamped only against the buffer
    // passes every one of those cases. An attacker willing to pay the
    // bandwidth simply sends the bytes: 40 real records, all complete, still
    // decode to INPUT_WINDOW_MAX playout entries and no more.
    const wide = new ByteWriter().u8(1).u8(1).u8(255);
    for (let i = 0; i < INPUT_WINDOW_MAX + 34; i++) {
      wide.u32(i).u32(i).i8(0).i8(0).u8(0);
    }
    const clamped = decodeInputWindow(wide.finish());
    expect(clamped).toHaveLength(INPUT_WINDOW_MAX);
    // And they are the FIRST INPUT_WINDOW_MAX records, read in wire order.
    expect(clamped.map((rec) => rec.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('inputWindowToClientInputs maps to the core ClientInput shape', () => {
    const records: DefaultInputRecord[] = [{ seq: 5, targetTick: 50, axes: [0.25, -0.75], buttons: 3 }];
    const [ci] = inputWindowToClientInputs(records);
    expect(ci.seq).toBe(5);
    expect(ci.targetTick).toBe(50);
    expect(ci.data).toEqual({ axes: [0.25, -0.75], buttons: 3 });
  });
});
