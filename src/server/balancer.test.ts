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
});
