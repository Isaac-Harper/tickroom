import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC session tokens. A token bakes a player's identity in at MINT time
 * (session route, join handler, whatever fronts the relay) so the socket
 * path never has to consult an auth provider again: verifying a token is
 * pure local arithmetic, with no network call and no dependency on an
 * external service staying up. That is the entire point of this scheme, and
 * it is also exactly why an EXPIRY is not optional (see `verifyToken`).
 */

/**
 * Whatever a host wants baked into the token. `pid` and `handle` are
 * required because `verifyToken` checks them against the values the caller
 * already believes it is talking to (the room-scoped player id and its
 * numeric handle), which is what stops a token minted for one player being
 * replayed to authenticate as a different one. `sub` is the durable identity
 * behind the pid (a device id, an account id) for a host that metering or
 * billing keys off. Anything else is host-specific and rides the index
 * signature untouched.
 */
export interface TokenClaims {
  pid: string;
  handle: number;
  sub: string;
  [k: string]: string | number;
}

export interface SessionAuthOptions {
  secret: string;
  /** How long a minted token stays redeemable. Defaults to 12 hours. */
  maxAgeS?: number;
}

const DEFAULT_MAX_AGE_S = 12 * 60 * 60;

/**
 * How far into the future a token's `iat` may sit before it is refused.
 * Real clock drift between the machine that minted a token and the one
 * verifying it is normally milliseconds, never seconds; a token dated more
 * than a minute in the future did not come from a slightly fast clock, it
 * came from a clock (or a forger) this process cannot trust, and if the skew
 * really is that large the AGE check below cannot be trusted in either
 * direction either.
 */
const CLOCK_SKEW_MS = 60_000;

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Buffers must be equal length before `timingSafeEqual` will even look at them; check that first, then compare in constant time. */
function constantTimeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Constant-time secret comparison, used by every dev/admin route gate in a
 * host built on tickroom (killing a ticker, forcing a state, reading a
 * balance). FAILS CLOSED when `expected` is unset: an env var that is
 * missing in this deployment must never be satisfied by an equally-missing
 * `provided` value, or a route intended to be gated by a secret that was
 * simply never configured becomes wide open instead of refused.
 */
export function secretMatches(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  if (!provided) return false;
  return constantTimeEqualStrings(provided, expected);
}

/**
 * Resolves a required secret from the environment, throwing in production
 * if it is unset rather than quietly falling back to a value that ships in
 * this repository. A missing secret must never silently degrade into "every
 * token is forgeable with a publicly known key": that failure mode is worse
 * than refusing to start. Outside production (local dev, CI without the
 * secret configured) it returns a clearly-marked insecure fallback instead
 * of throwing, so a fresh checkout can run tests and a dev server without
 * ceremony.
 */
export function requireSecret(envName: string = 'SESSION_SECRET'): string {
  const value = process.env[envName];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${envName} is not set. Refusing to start in production: without it every session ` +
        'token and every spawn token would be forgeable by anyone who reads this source.'
    );
  }
  return `dev-insecure-${envName}`;
}

/** Mints a token. `nowMs` is injectable for tests; real callers should never pass it. */
export function makeToken(claims: TokenClaims, opts: SessionAuthOptions, nowMs: number = Date.now()): string {
  const body: Record<string, string | number> = { ...claims, iat: nowMs };
  const payload = b64url(JSON.stringify(body));
  const signature = sign(payload, opts.secret);
  // Joined by the LAST '.': base64url itself never contains a literal '.',
  // so this is defensive rather than load-bearing today, but it means a
  // future payload encoding that does use '.' internally still splits
  // correctly instead of silently truncating the payload at the first one.
  return `${payload}.${signature}`;
}

/**
 * Verifies a token against the identity the caller already expects to be
 * talking to. Returns the full claims record on success, or `null` for
 * ANYTHING else: bad signature, malformed payload, a payload shape from an
 * older/incompatible token version, a pid/handle mismatch, or an expired or
 * future-dated token. There is deliberately no partial-success return: a
 * caller either gets a fully trustworthy claims record or nothing.
 */
export function verifyToken(
  token: string | null,
  expect: { pid: string; handle: number },
  opts: SessionAuthOptions,
  nowMs: number = Date.now()
): TokenClaims | null {
  if (!token) return null;

  const lastDot = token.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === token.length - 1) return null;
  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);

  if (!constantTimeEqualStrings(signature, sign(payload, opts.secret))) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;

  const claims = decoded as Record<string, unknown>;
  // Every field checked for its EXPECTED PRIMITIVE TYPE, not merely
  // presence. A shorter or older token payload (one minted before `sub` or
  // `iat` existed) must fail closed here rather than propagate `undefined`
  // into arithmetic that assumes a number, which is exactly the shape of
  // bug that turns "reject an old token" into "silently trust one forever".
  if (
    typeof claims.pid !== 'string' ||
    typeof claims.handle !== 'number' ||
    typeof claims.sub !== 'string' ||
    typeof claims.iat !== 'number'
  ) {
    return null;
  }
  if (claims.pid !== expect.pid || claims.handle !== expect.handle) return null;

  // `??` catches an ABSENT maxAgeS and not a non-finite one, and the difference
  // is the whole expiry. `maxAgeS: Number(process.env.SESSION_MAX_AGE_S)` with
  // the variable unset is `NaN`, and `age > NaN` is false, so EVERY token ever
  // minted stays redeemable forever while the future-dated check still passes:
  // a silent, permanent removal of the expiry, in the module whose own header
  // says an expiry is not optional. Fall back to the default rather than
  // refusing outright, because refusing would lock every player out of a
  // running deployment over one unset variable. A zero or negative value is
  // left alone deliberately: that expires everything, which is a host asking
  // for something drastic rather than a host failing to ask for anything.
  const maxAgeS = Number.isFinite(opts.maxAgeS) ? (opts.maxAgeS as number) : DEFAULT_MAX_AGE_S;
  const maxAgeMs = maxAgeS * 1000;
  const age = nowMs - claims.iat;
  if (age > maxAgeMs) return null; // expired
  if (age < -CLOCK_SKEW_MS) return null; // future-dated past tolerable skew; see CLOCK_SKEW_MS

  const { iat: _iat, ...rest } = claims;
  return rest as TokenClaims;
}

/**
 * A spawn token authorizes ONE server-to-server call: the relay asking the
 * platform to start a ticker for a specific room. It is never seen by a
 * client and never rides a URL a browser could bookmark or replay.
 *
 * WHY THIS EXISTS AT ALL: an unauthenticated ticker-spawn endpoint means one
 * anonymous request buys a multi-minute authoritative simulation loop plus
 * every Redis publish it makes for the rest of its run, for any room id
 * that parses, which is the single most expensive action available on the
 * whole platform to someone who has done nothing but guess a URL. Gating it
 * closes that off entirely.
 *
 * WHY IT IS BOUND TO THE ROOM ID: without that binding, a token good for
 * spawning ANY room's ticker would let a single leaked or replayed token
 * spin up tickers in every room in the deployment; binding it to one room id
 * means stealing this token buys, at most, one already-legitimate spawn.
 */
export function makeSpawnToken(roomId: string, secret: string): string {
  return sign(roomId, secret);
}

export function verifySpawnToken(roomId: string, token: string | null, secret: string): boolean {
  if (!token) return false;
  return constantTimeEqualStrings(token, sign(roomId, secret));
}
