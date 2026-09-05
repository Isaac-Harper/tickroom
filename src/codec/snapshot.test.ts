import { describe, it, expect } from 'vitest';
import { ByteWriter, CodecError, ProtocolVersionError } from './bytes.js';
import {
  DEFAULT_SNAPSHOT_VERSION,
  encodeDefaultSnapshot,
  decodeDefaultSnapshot,
  INPUT_WINDOW_MAX,
  AXIS_SCALE,
  encodeInputWindow,
  decodeInputWindow,
  inputWindowToClientInputs,
  type DefaultSnapshot,
  type DefaultInputRecord,
} from './snapshot.js';
import { I16, U16, CM_SCALE, representableRange } from './quantize.js';

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

describe('decodeDefaultSnapshot checks the version FIRST, before any other field is read', () => {
  it('throws ProtocolVersionError on a version mismatch, carrying expected/found on the instance', () => {
    const buf = encodeDefaultSnapshot({
      version: DEFAULT_SNAPSHOT_VERSION,
      tick: 1,
      serverTime: 0,
      entities: [],
    });
    const mismatched = new Uint8Array(buf);
    mismatched[0] = DEFAULT_SNAPSHOT_VERSION + 1;

    expect(() => decodeDefaultSnapshot(mismatched)).toThrow(ProtocolVersionError);

    let caught: unknown;
    try {
      decodeDefaultSnapshot(mismatched);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CodecError);
    expect((caught as ProtocolVersionError).name).toBe('ProtocolVersionError');
    expect((caught as ProtocolVersionError).expected).toBe(DEFAULT_SNAPSHOT_VERSION);
    expect((caught as ProtocolVersionError).found).toBe(DEFAULT_SNAPSHOT_VERSION + 1);
  });

  it('a version mismatch throws even when there is nothing else in the buffer to misread', () => {
    // ONE byte on the wire, and it is the wrong version. A decoder that
    // checked the version anywhere but first would have to read past it,
    // hit the truncated buffer, and report THAT error instead of the version
    // mismatch that is the one actually worth reporting.
    const bogus = new Uint8Array([DEFAULT_SNAPSHOT_VERSION + 1]);
    expect(() => decodeDefaultSnapshot(bogus)).toThrow(ProtocolVersionError);
  });

  it('the matching version still decodes normally', () => {
    const buf = encodeDefaultSnapshot({
      version: DEFAULT_SNAPSHOT_VERSION,
      tick: 9,
      serverTime: 0,
      entities: [],
    });
    expect(() => decodeDefaultSnapshot(buf)).not.toThrow();
  });
});

describe('encodeDefaultSnapshot refuses more entities or extra bytes than a u16 length field can carry', () => {
  it('refuses more than 65535 entities rather than wrapping the entityCount header', () => {
    // Measured: 65537 entities wrapped entityCount to 1 and the decoder
    // returned a one-entity snapshot with the other 65536 silently dropped.
    const entities = Array.from({ length: U16.max + 2 }, (_, i) => ({
      id: i % (U16.max + 1),
      x: 0,
      y: 0,
    }));
    const snap: DefaultSnapshot = {
      version: DEFAULT_SNAPSHOT_VERSION,
      tick: 1,
      serverTime: 0,
      entities,
    };
    expect(() => encodeDefaultSnapshot(snap)).toThrow(CodecError);
    // AND THE MESSAGE NAMES THE FIELD, which is the whole reason the check is
    // up front: `ByteWriter.u16` already refuses to wrap `entityCount`, so
    // asserting the TYPE alone is equally true with this check deleted, and a
    // caller would be told "ByteWriter.u16: value must be an integer in
    // 0..65535" from partway through an encode it cannot see.
    expect(() => encodeDefaultSnapshot(snap)).toThrow(/entities/);
  });

  it('refuses an extra payload past 65535 bytes rather than wrapping the extraLength header', () => {
    // Measured: a 70000-byte extra block wrote a wrapped u16 length (4464)
    // and the decoder handed back 4464 bytes, silently dropping the rest.
    const snap: DefaultSnapshot = {
      version: DEFAULT_SNAPSHOT_VERSION,
      tick: 1,
      serverTime: 0,
      entities: [],
      extra: new Uint8Array(70000),
    };
    expect(() => encodeDefaultSnapshot(snap)).toThrow(CodecError);
    // Same reasoning as the entity count above: the generic `ByteWriter.u16`
    // message says nothing about `extra`, so naming the field is the only
    // assertion that can tell the two checks apart.
    expect(() => encodeDefaultSnapshot(snap)).toThrow(/extra/);
  });

  it('accepts exactly 65535 entities and exactly 65535 extra bytes, the boundary itself', () => {
    // WITH 65535 REAL ENTITIES, not an empty list: this case named the entity
    // bound and passed `entities: []`, so it asserted the extra-byte boundary
    // twice and the entity boundary not at all. A refusal at the bound rather
    // than past it is exactly the off-by-one this case exists to catch, and an
    // empty list cannot see it.
    const entities = Array.from({ length: U16.max }, (_, i) => ({ id: i, x: 0, y: 0 }));
    const snap: DefaultSnapshot = {
      version: DEFAULT_SNAPSHOT_VERSION,
      tick: 1,
      serverTime: 0,
      entities,
      extra: new Uint8Array(U16.max),
    };
    const back = decodeDefaultSnapshot(encodeDefaultSnapshot(snap));
    expect(back.entities).toHaveLength(U16.max);
    expect(back.entities[0].id).toBe(0);
    expect(back.entities[U16.max - 1].id).toBe(U16.max - 1);
    expect(back.extra).toHaveLength(U16.max);
  });
});

describe('decodeDefaultSnapshot is a trust boundary: only CodecError (or its ProtocolVersionError subtype) ever escapes', () => {
  it('every truncation length of a real, valid snapshot either decodes or throws CodecError, nothing else', () => {
    const snap: DefaultSnapshot = {
      version: DEFAULT_SNAPSHOT_VERSION,
      tick: 42,
      serverTime: 1_700_000_000_000,
      entities: [
        { id: 1, x: 1, y: 1, heading: 0.1, state: 1 },
        { id: 2, x: 2, y: 2, heading: 0.2, state: 2 },
      ],
      extra: new Uint8Array([1, 2, 3, 4]),
    };
    const full = encodeDefaultSnapshot(snap);
    for (let len = 0; len <= full.length; len++) {
      const truncated = full.slice(0, len);
      try {
        decodeDefaultSnapshot(truncated);
      } catch (err) {
        expect(err).toBeInstanceOf(CodecError);
      }
    }
  });

  it('a fuzz of random bytes at random lengths never throws anything but CodecError', () => {
    // Not a property-testing library, just a wide sweep over buffer shapes a
    // hostile or simply broken peer could hand the decoder: this is the
    // decoder's trust-boundary contract exercised directly rather than only
    // asserted in a comment.
    for (let trial = 0; trial < 500; trial++) {
      const len = Math.floor(Math.random() * 64);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
      try {
        decodeDefaultSnapshot(bytes);
      } catch (err) {
        expect(err).toBeInstanceOf(CodecError);
      }
    }
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

  it('decodeInputWindow returns [] rather than throwing for a runtime value that is not an ArrayBuffer or a view over one', () => {
    // `decodeInputWindow` is typed `ArrayBuffer | Uint8Array`, but a caller
    // past a permissive boundary (an any-typed message bus, an unvalidated
    // JSON.parse) can hand over anything at runtime. `new ByteReader` used to
    // build a `DataView` straight from whatever it got, and `DataView`'s own
    // constructor throws a bare, uncaught `TypeError` on a string, `null`, or
    // an array of `Buffer`s (all measured), breaking this function's one
    // promise: that a caller never needs a try/catch around it. Cast through
    // `unknown` because the declared type does not admit these; that mismatch
    // between what TypeScript promises and what can actually arrive at
    // runtime is exactly the case this guard exists for.
    expect(decodeInputWindow('not a buffer' as unknown as Uint8Array)).toEqual([]);
    expect(decodeInputWindow(null as unknown as Uint8Array)).toEqual([]);
    expect(decodeInputWindow(undefined as unknown as Uint8Array)).toEqual([]);
    expect(decodeInputWindow([Buffer.from([1, 2, 3])] as unknown as Uint8Array)).toEqual([]);
    expect(decodeInputWindow(42 as unknown as Uint8Array)).toEqual([]);
    expect(decodeInputWindow({} as unknown as Uint8Array)).toEqual([]);
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

describe('an out-of-range entity id is refused rather than wrapped', () => {
  function snapWith(id: number): DefaultSnapshot {
    return {
      version: DEFAULT_SNAPSHOT_VERSION,
      tick: 1,
      serverTime: 1_700_000_000_000,
      entities: [{ id, x: 0, y: 0 }],
    };
  }

  it('throws CodecError on an id past the u16 ceiling, instead of aliasing two players onto one entity', () => {
    // THE ONE FIELD IN THIS CODEC THAT BYPASSED THE QUANTISER, in a library
    // whose quantiser docs shout CLAMP, NEVER WRAP. `ByteWriter.u16` wraps, so
    // an id of 70000 was written as 4464 and decoded as 4464: two players
    // sharing one entity for the rest of the room's life, with no error and
    // nothing in a metric. A host derives an entity id from something
    // monotonic (a join counter, a database row id) often enough that 65536 is
    // reachable in ordinary use.
    //
    // CLAMPING WOULD BE NO BETTER HERE, which is why this throws rather than
    // borrowing the position fields' answer: 65535 is not an approximation of
    // 70000, it is a different player, and a clamped id aliases exactly the
    // same way a wrapped one does. There is no nearby value for an identity.
    expect(() => encodeDefaultSnapshot(snapWith(70000))).toThrow(CodecError);
    expect(() => encodeDefaultSnapshot(snapWith(U16.max + 1))).toThrow(CodecError);
    expect(() => encodeDefaultSnapshot(snapWith(-1))).toThrow(CodecError);
    expect(() => encodeDefaultSnapshot(snapWith(1.5))).toThrow(CodecError);
    expect(() => encodeDefaultSnapshot(snapWith(NaN))).toThrow(CodecError);
  });

  it('accepts both ends of the representable range, so the guard is a bound and not a narrowing', () => {
    // The refusal has to leave every legal id alone, including the boundary
    // values a naive `<`/`>` slip would take out.
    for (const id of [U16.min, 1, 255, 256, 65534, U16.max]) {
      const round = decodeDefaultSnapshot(encodeDefaultSnapshot(snapWith(id)));
      expect(round.entities[0]!.id).toBe(id);
    }
  });
});

describe('the default input window carries a host-chosen axis scale', () => {
  function rec(axes: [number, number]): DefaultInputRecord {
    return { seq: 1, targetTick: 10, axes, buttons: 0 };
  }

  it('CLAMPS out-of-range axes at the default scale, which is what a positional payload silently hits', () => {
    // The sibling of the position clamp the snapshot half documents at length,
    // in an API that had no scale knob at all. `axes` is an i8 normalised to
    // [-1, 1], so a host that reached for the shipped input window to carry
    // cursor COORDINATES got this: every remote cursor stacked in one corner,
    // no error, nothing in a metric. Pinned as behaviour rather than only
    // described, because the clamp is the only signal it ever produces.
    const [out] = decodeInputWindow(encodeInputWindow([rec([640, 480])]));
    expect(out!.axes[0]).toBe(1);
    expect(out!.axes[1]).toBe(1);

    const [neg] = decodeInputWindow(encodeInputWindow([rec([-640, -480])]));
    expect(neg!.axes[0]).toBe(-1);
    expect(neg!.axes[1]).toBe(-1);
  });

  it('axisScale moves the boundary, so a host whose axes are not a normalised stick is not silently clipped', () => {
    // The mirror of `positionScale`. At scale 1 one integer step is one whole
    // axis unit, so the same field spans +-127 instead of +-1: a host counting
    // in percent, or in a small integer range of its own, round-trips instead
    // of pinning at 1.
    const opts = { axisScale: 1 };
    const [out] = decodeInputWindow(encodeInputWindow([rec([64, -48])], opts), opts);
    expect(out!.axes[0]).toBe(64);
    expect(out!.axes[1]).toBe(-48);

    // And the boundary still clamps, at the new place rather than the old one.
    const [past] = decodeInputWindow(encodeInputWindow([rec([640, -640])], opts), opts);
    expect(past!.axes[0]).toBe(127);
    expect(past!.axes[1]).toBe(-127);
  });

  it('the DEFAULT wire is unchanged: omitting the option is exactly AXIS_SCALE', () => {
    // The option must not have moved the default, for the same reason
    // `positionScale` did not: the bytes would mean something new while moving
    // no byte, which is a protocol break that nothing on the wire could report.
    const records = [rec([0.5, -0.25])];
    expect(encodeInputWindow(records)).toEqual(encodeInputWindow(records, { axisScale: AXIS_SCALE }));
    const [out] = decodeInputWindow(encodeInputWindow(records));
    expect(out!.axes[0]).toBeCloseTo(0.5, 2);
    expect(out!.axes[1]).toBeCloseTo(-0.25, 2);
  });
});
