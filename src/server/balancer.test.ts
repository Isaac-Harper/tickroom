import { describe, it, expect } from 'vitest';
import { roomKeys, roomIdFor } from '../core/index.js';
import { FakeRedis } from './testFakeRedis.js';
import { assignRoom } from './balancer.js';

async function setPlayers(redis: FakeRedis, roomId: string, players: number): Promise<void> {
  await redis.set(roomKeys(roomId).stats, JSON.stringify({ players }));
}

describe('assignRoom', () => {
  it('packs into the lowest index with spare capacity', async () => {
    const redis = new FakeRedis();
    await setPlayers(redis, roomIdFor('lobby', 0), 20);
    await setPlayers(redis, roomIdFor('lobby', 1), 20);
    await setPlayers(redis, roomIdFor('lobby', 2), 5);

    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20 });
    expect(result).toEqual({ room: 'lobby~2', base: 'lobby', index: 2 });
  });

  it('returns instance 0 when nothing has ever written stats', async () => {
    const redis = new FakeRedis();
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20 });
    expect(result).toEqual({ room: 'lobby', base: 'lobby', index: 0 });
  });

  it('skips an excluded room even if it has spare capacity', async () => {
    const redis = new FakeRedis();
    await setPlayers(redis, roomIdFor('lobby', 0), 5);
    await setPlayers(redis, roomIdFor('lobby', 1), 5);

    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20, exclude: 'lobby' });
    expect(result.room).toBe('lobby~1');
  });

  it('ignores an exclude value for a different base', async () => {
    const redis = new FakeRedis();
    await setPlayers(redis, roomIdFor('lobby', 0), 5);

    // "arena" is not this base, so it must not exclude "lobby" (index 0).
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20, exclude: 'arena' });
    expect(result.room).toBe('lobby');
  });

  it('reports full only when every instance up to maxRooms is at capacity', async () => {
    const redis = new FakeRedis();
    const maxRooms = 3;
    for (let i = 0; i < maxRooms; i++) {
      await setPlayers(redis, roomIdFor('lobby', i), 20);
    }
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20, maxRooms });
    expect(result.full).toBe(true);
    expect(result.room).toBe('lobby'); // falls back to instance 0
  });

  it('honours exclude on the FULL path, instead of naming the one room it never measured', async () => {
    // The excluded index is `continue`d in the capacity loop, so it is never
    // read. Falling back to index 0 regardless therefore does two wrong things
    // at once: it sends the client straight back to the instance that just
    // bounced it, burning the bounded re-assign budget against one room, and it
    // asserts `full: true` about the single room whose capacity was never
    // measured. This is the surviving half of the shape the mget-failure path
    // was already taught (see 'skips the excluded room on a Redis read error
    // too'): the two paths must agree about what `exclude` means.
    const redis = new FakeRedis();
    const maxRooms = 3;
    for (let i = 0; i < maxRooms; i++) {
      await setPlayers(redis, roomIdFor('lobby', i), 20);
    }
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20, maxRooms, exclude: 'lobby' });
    expect(result.full).toBe(true);
    expect(result.room).not.toBe('lobby'); // NOT the excluded instance 0
    expect(result.room).toBe('lobby~1');
  });

  it('falls back to the excluded room on the full path only when it is the only room there is', async () => {
    const redis = new FakeRedis();
    await setPlayers(redis, roomIdFor('lobby', 0), 20);
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20, maxRooms: 1, exclude: 'lobby' });
    expect(result).toEqual({ room: 'lobby', base: 'lobby', index: 0, full: true });
  });

  it('is not full while at least one instance has room', async () => {
    const redis = new FakeRedis();
    const maxRooms = 3;
    await setPlayers(redis, roomIdFor('lobby', 0), 20);
    await setPlayers(redis, roomIdFor('lobby', 1), 20);
    await setPlayers(redis, roomIdFor('lobby', 2), 19);
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20, maxRooms });
    expect(result.full).toBeUndefined();
    expect(result.room).toBe('lobby~2');
  });

  it('treats corrupt stats JSON as empty and reusable', async () => {
    const redis = new FakeRedis();
    await redis.set(roomKeys(roomIdFor('lobby', 0)).stats, 'not json at all');
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20 });
    expect(result.room).toBe('lobby');
  });

  it('treats a missing players field as empty', async () => {
    const redis = new FakeRedis();
    await redis.set(roomKeys(roomIdFor('lobby', 0)).stats, JSON.stringify({ tick: 100 }));
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20 });
    expect(result.room).toBe('lobby');
  });

  it('fails toward instance 0 on a Redis read error', async () => {
    const redis = new FakeRedis();
    redis.break('mget');
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20 });
    expect(result.room).toBe('lobby');
    expect(result.index).toBe(0);
  });

  // A rejection (`exclude`, the room that just bounced this client) and an
  // unrelated Redis hiccup are independent events that can and do coincide:
  // the retry a client fires right after a bounce is exactly the kind of
  // request that might also catch Redis mid-blip. The failure path used to
  // ignore `exclude` entirely and always hand back instance 0, so when the
  // two coincided the client was routed straight back to the room that just
  // rejected it. Found by a real consumer's own hand-rolled balancer, which
  // got this right where tickroom did not.
  it('skips the excluded room on a Redis read error too', async () => {
    const redis = new FakeRedis();
    redis.break('mget');
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20, exclude: 'lobby' });
    expect(result.room).toBe('lobby~1');
    expect(result.index).toBe(1);
    expect(result.full).toBeUndefined();
  });

  // Degenerate case: the excluded room is the ONLY candidate (maxRooms 1),
  // so there is nothing else to hand back. Returning the excluded room
  // anyway is chosen deliberately over reporting `full`: this path fails
  // OPEN by contract (a Redis outage must never manufacture a `full` result
  // it never actually measured, since maxPlayers/capacity were never read
  // here at all), and being bounced from a room a second time is a better
  // outcome for the player than being told the world is full when nobody
  // knows that. A caller that wants better than this in the one-room case
  // needs a real capacity read, which is exactly the read that just failed.
  it('falls back to the excluded room itself when it is the only candidate on a Redis read error', async () => {
    const redis = new FakeRedis();
    redis.break('mget');
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20, maxRooms: 1, exclude: 'lobby' });
    expect(result.room).toBe('lobby');
    expect(result.index).toBe(0);
    expect(result.full).toBeUndefined();
  });

  it('ignores a junk/foreign exclude value on a Redis read error', async () => {
    const redis = new FakeRedis();
    redis.break('mget');
    const result = await assignRoom({ redis, base: 'lobby', maxPlayers: 20, exclude: 'arena' });
    expect(result.room).toBe('lobby');
    expect(result.index).toBe(0);
  });

  it('never reports full on a Redis read error, excluded or not', async () => {
    const redis = new FakeRedis();
    redis.break('mget');
    const logged: string[] = [];
    const withoutExclude = await assignRoom({
      redis,
      base: 'lobby',
      maxPlayers: 20,
      log: (ev) => logged.push(ev.kind),
    });
    const withExclude = await assignRoom({ redis, base: 'lobby', maxPlayers: 20, exclude: 'lobby' });
    expect(withoutExclude.full).toBeUndefined();
    expect(withExclude.full).toBeUndefined();
    expect(logged).toContain('balancer.mget-failed');
  });
});
