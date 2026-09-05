import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  makeToken,
  verifyToken,
  makeSpawnToken,
  verifySpawnToken,
  secretMatches,
  SPAWN_TOKEN_WINDOW_MS,
} from './session.js';

const OPTS = { secret: 'test-secret-value' };

describe('session tokens', () => {
  it('round trips', () => {
    const token = makeToken({ pid: 'p1', handle: 42, sub: 'd.abc' }, OPTS);
    const claims = verifyToken(token, { pid: 'p1', handle: 42 }, OPTS);
    expect(claims).not.toBeNull();
    expect(claims?.pid).toBe('p1');
    expect(claims?.handle).toBe(42);
    expect(claims?.sub).toBe('d.abc');
  });

  it('carries arbitrary extra claims through', () => {
    const token = makeToken({ pid: 'p1', handle: 1, sub: 's', tier: 'unlimited' }, OPTS);
    const claims = verifyToken(token, { pid: 'p1', handle: 1 }, OPTS);
    expect(claims?.tier).toBe('unlimited');
  });

  it('rejects a tampered payload', () => {
    const token = makeToken({ pid: 'p1', handle: 1, sub: 's' }, OPTS);
    const [payload, sig] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ pid: 'p2', handle: 1, sub: 's', iat: Date.now() })).toString(
      'base64url'
    );
    const tampered = `${tamperedPayload}.${sig}`;
    expect(verifyToken(tampered, { pid: 'p2', handle: 1 }, OPTS)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it('rejects a tampered signature', () => {
    const token = makeToken({ pid: 'p1', handle: 1, sub: 's' }, OPTS);
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(verifyToken(tampered, { pid: 'p1', handle: 1 }, OPTS)).toBeNull();
  });

  it('rejects a pid/handle mismatch even with a valid signature', () => {
    const token = makeToken({ pid: 'p1', handle: 1, sub: 's' }, OPTS);
    expect(verifyToken(token, { pid: 'p1', handle: 2 }, OPTS)).toBeNull();
    expect(verifyToken(token, { pid: 'other', handle: 1 }, OPTS)).toBeNull();
  });

  it('expires after maxAgeS', () => {
    const mintedAt = 1_000_000;
    const token = makeToken({ pid: 'p1', handle: 1, sub: 's' }, { ...OPTS, maxAgeS: 3600 }, mintedAt);
    const justBefore = verifyToken(token, { pid: 'p1', handle: 1 }, { ...OPTS, maxAgeS: 3600 }, mintedAt + 3600 * 1000 - 1);
    expect(justBefore).not.toBeNull();
    const justAfter = verifyToken(token, { pid: 'p1', handle: 1 }, { ...OPTS, maxAgeS: 3600 }, mintedAt + 3600 * 1000 + 1);
    expect(justAfter).toBeNull();
  });

  it('a non-finite maxAgeS falls back to the default instead of removing the expiry', () => {
    // `??` catches an ABSENT maxAgeS, not a NaN one, and the canonical way to
    // get NaN here is `maxAgeS: Number(process.env.SESSION_MAX_AGE_S)` with the
    // variable unset. `age > NaN` is false, so an unguarded NaN makes every
    // token ever minted permanently redeemable, silently, in the module whose
    // own header says the expiry is not optional.
    const mintedAt = 1_000_000;
    const opts = { ...OPTS, maxAgeS: Number.NaN };
    const token = makeToken({ pid: 'p1', handle: 1, sub: 's' }, opts, mintedAt);

    // A year later. With the guard this is refused by the 12h default; without
    // it, it verifies.
    const wayLater = mintedAt + 365 * 24 * 3600 * 1000;
    expect(verifyToken(token, { pid: 'p1', handle: 1 }, opts, wayLater)).toBeNull();

    // ...and the token is still good inside the default window, so the fallback
    // is the default rather than a blanket refusal that would lock everyone out.
    expect(verifyToken(token, { pid: 'p1', handle: 1 }, opts, mintedAt + 60_000)).not.toBeNull();
  });

  it('rejects a future-dated token beyond tolerable clock skew', () => {
    const now = 1_000_000;
    const token = makeToken({ pid: 'p1', handle: 1, sub: 's' }, OPTS, now + 10 * 60 * 1000);
    expect(verifyToken(token, { pid: 'p1', handle: 1 }, OPTS, now)).toBeNull();
  });

  it('tolerates a small clock skew forward', () => {
    const now = 1_000_000;
    const token = makeToken({ pid: 'p1', handle: 1, sub: 's' }, OPTS, now + 5000);
    expect(verifyToken(token, { pid: 'p1', handle: 1 }, OPTS, now)).not.toBeNull();
  });

  it('fails closed on a legacy payload shape missing required fields', () => {
    // Simulate an older/shorter token format: no `sub`, no `iat`.
    const legacyPayload = Buffer.from(JSON.stringify({ pid: 'p1', handle: 1 })).toString('base64url');
    // Manually construct a token whose payload lacks `sub`/`iat`, signed
    // correctly for THAT payload, so the only defect is the shape.
    const signature = createHmac('sha256', OPTS.secret).update(legacyPayload).digest('base64url');
    const legacyToken = `${legacyPayload}.${signature}`;
    expect(verifyToken(legacyToken, { pid: 'p1', handle: 1 }, OPTS)).toBeNull();
  });

  it('returns null for an empty token', () => {
    expect(verifyToken(null, { pid: 'p1', handle: 1 }, OPTS)).toBeNull();
    expect(verifyToken('', { pid: 'p1', handle: 1 }, OPTS)).toBeNull();
    expect(verifyToken('nodothere', { pid: 'p1', handle: 1 }, OPTS)).toBeNull();
  });
});

describe('spawn tokens', () => {
  const SECRET = 'spawn-secret';
  // Start of a window, so every test below reasons in whole windows with no
  // risk of landing on a boundary by accident.
  const WINDOW_START = 1_000 * SPAWN_TOKEN_WINDOW_MS;

  it('binds the room id: a token for one room is rejected for another', () => {
    const tokenA = makeSpawnToken('room-a', SECRET, WINDOW_START);
    expect(verifySpawnToken('room-a', tokenA, SECRET, WINDOW_START)).toBe(true);
    expect(verifySpawnToken('room-b', tokenA, SECRET, WINDOW_START)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const tokenA = makeSpawnToken('room-a', 'secret-1', WINDOW_START);
    expect(verifySpawnToken('room-a', tokenA, 'secret-2', WINDOW_START)).toBe(false);
  });

  it('rejects a missing token', () => {
    expect(verifySpawnToken('room-a', null, SECRET)).toBe(false);
  });

  it('defaults nowMs to the real clock, so a caller need not pass it', () => {
    const token = makeSpawnToken('room-a', SECRET);
    expect(verifySpawnToken('room-a', token, SECRET)).toBe(true);
  });

  it('stays valid through the window it was minted in and the one right after it', () => {
    // Minted at the very start of a window: the worst case for exposure,
    // since it is live for the rest of THIS window plus all of the next.
    const token = makeSpawnToken('room-a', SECRET, WINDOW_START);
    expect(verifySpawnToken('room-a', token, SECRET, WINDOW_START)).toBe(true);
    expect(verifySpawnToken('room-a', token, SECRET, WINDOW_START + SPAWN_TOKEN_WINDOW_MS)).toBe(true);
  });

  it('rejects a token from three windows ago: a leaked or logged token buys at most two windows', () => {
    // MUTATION CHECK for the fix that gave the token an expiry at all:
    // widening `verifySpawnToken`'s accepted range to the current window
    // plus the two before it (instead of just one) makes this pass when it
    // must not.
    const token = makeSpawnToken('room-a', SECRET, WINDOW_START);
    expect(verifySpawnToken('room-a', token, SECRET, WINDOW_START + 2 * SPAWN_TOKEN_WINDOW_MS)).toBe(false);
    expect(verifySpawnToken('room-a', token, SECRET, WINDOW_START + 3 * SPAWN_TOKEN_WINDOW_MS)).toBe(false);
  });
});

describe('secretMatches', () => {
  it('fails closed when expected is unset', () => {
    expect(secretMatches('anything', undefined)).toBe(false);
    expect(secretMatches(undefined, undefined)).toBe(false);
    expect(secretMatches(null, undefined)).toBe(false);
  });

  it('matches equal secrets and rejects unequal ones', () => {
    expect(secretMatches('abc', 'abc')).toBe(true);
    expect(secretMatches('abc', 'abd')).toBe(false);
    expect(secretMatches('abc', 'abcd')).toBe(false);
  });
});
