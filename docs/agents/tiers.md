# The tier of every test file

Moved verbatim from `AGENTS.md`, which keeps the one-line form of each entry
and links here. Inside this file, "the invariants", "the gotchas", "the Gates
section", "the Status section" and "the table" mean
[`invariants.md`](invariants.md), [`gotchas.md`](gotchas.md),
[`gates.md`](gates.md), [`status.md`](status.md) and [`tiers.md`](tiers.md) in
this directory; "above" and "below" mean wherever that file now is.

THE SOURCE OF TRUTH FOR THE SPLIT. `vitest.config.ts` follows this table; if the
two disagree the config is wrong. The three questions the tiers answer are
different, which is the whole reason for the split: `unit` and `integration` are
decided by the CODE and are the same answer on any machine, so they gate a
release; `measure` is decided by the WALL CLOCK and is only an answer on a
machine quiet enough to take a reading.

| file | tier | why |
| --- | --- | --- |
| `src/adapters/node.test.ts` | unit | no services |
| `src/adapters/vercel.test.ts` | unit | no services |
| `src/client/bundling.test.ts` | unit | no services |
| `src/client/clientTick.test.ts` | unit | no services |
| `src/client/connection.test.ts` | unit | no services; its reconnect ladder steps timer to timer rather than over wall time |
| `src/client/errorOffset.test.ts` | unit | no services |
| `src/client/interpolation.test.ts` | unit | no services |
| `src/client/netPolicy.test.ts` | unit | no services |
| `src/client/predictedEntity.test.ts` | unit | no services |
| `src/codec/bytes.test.ts` | unit | no services |
| `src/codec/quantize.test.ts` | unit | no services |
| `src/codec/snapshot.test.ts` | unit | no services |
| `src/core/backpressure.test.ts` | unit | no services |
| `src/core/checkpoint.test.ts` | unit | no services |
| `src/core/ids.test.ts` | unit | no services |
| `src/core/lease.test.ts` | unit | no services; the pure clock functions and a fake Redis |
| `src/core/log.test.ts` | unit | no services; source-text, every log kind emitted is in the union and every kind in the union is emitted |
| `src/core/metrics.test.ts` | unit | no services |
| `src/core/playout.test.ts` | unit | no services |
| `src/core/rateLimit.test.ts` | unit | no services |
| `src/core/starvation.test.ts` | unit | no services |
| `src/server/admission.test.ts` | unit | no services |
| `src/server/balancer.test.ts` | unit | no services |
| `src/server/checkpoint.test.ts` | unit | no services |
| `src/server/redis.test.ts` | unit | no services; pins the OPTIONS the factory passes, not what they do |
| `src/server/relay.test.ts` | unit | no services; its throttled-interval liveness pair runs on fake timers |
| `src/server/session.test.ts` | unit | no services |
| `src/server/ticker.test.ts` | unit | no services; ends on a SAMPLE COUNT rather than a fixed wall-clock window |
| `src/testing/lockstep.test.ts` | unit | no services |
| `examples/cursors/sim.test.ts` | unit | no services, pure simulation |
| `examples/pong/codec.test.ts` | unit | no services, pure codec |
| `examples/pong/sim.test.ts` | unit | no services, pure simulation |
| `tests/memory.test.ts` | unit | THE ONE FILE UNDER `tests/` THAT NEEDS NOTHING, which is the claim it exists to check: `createMemoryRedis` is the bus. It drives a real `ws` socket over four seconds, but its bounds are presence claims and 0.5x-generous counts, not a rate band |
| `tests/tiers.test.ts` | unit | no services; the guard that every file under `tests/` is in exactly one tier |
| `tests/checkpoint.redis.test.ts` | integration | real Redis; gzip round trips or it does not. Its TTL bounds are the server's own, with seconds of slack |
| `tests/depth.redis.test.ts` | integration | real Redis; the depth frame reaches a client through a real ticker and relay and closes the stamping-lead loop, a deterministic outcome |
| `tests/e2e.redis.test.ts` | integration | real Redis and a real socket; admission decisions and "a snapshot arrived", all polled to a condition |
| `tests/faults.redis.test.ts` | integration, 3 of 5 cases gated | real Redis behind a proxy. Lease theft and the crash loop assert on tick numbers and a counter Redis holds: same answer anywhere. The two black-hole cases and the restart case TIME the exit against a probe deadline, a lease TTL and a run cap, so they are `itSteady` |
| `tests/lease.redis.test.ts` | integration | real Redis; N concurrent SET NX, the Lua owner checks, a TTL expiring on the server clock. The one timing bound is a 5000 to 8000ms window on a TTL |
| `tests/pubsub.redis.test.ts` | integration | real Redis; fan-out cost and subscribe-mode locking, both counted rather than timed |
| `tests/redisLike.test.ts` | integration | real Redis; every `RedisLike` method against real ioredis. No timing at all |
| `tests/subscriber.redis.test.ts` | integration | real Redis and two child processes; the control DIES and the fixed one SURVIVES, which is a binary outcome, not a duration |
| `tests/ticker.redis.test.ts` | integration, 3 of 5 cases gated | real Redis. The stats-TTL and handoff cases are polled to a condition. The rate case's +-25% band and the two geometry cases' interlocking floor/ceiling on a 200Hz loop are wall-clock counts, so they are `itSteady` |
| `tests/example-cursors.redis.test.ts` | measurement | real Redis, real socket, real client on a 16ms timer. Snapshot rate inside +-10% of 20Hz and a move-to-snapshot latency bound built from a send period plus a round trip plus a tick |
| `tests/example.redis.test.ts` | measurement | same rig around `examples/pong`. Snapshot rate inside +-10%, zero frames that failed to draw, and a paddle step that is EXACTLY one tick of `PADDLE_SPEED` on every unsaturated step |
| `tests/smoothness.redis.test.ts` | measurement | a real 60Hz render loop over a real socket, asserting zero backward steps, zero motionless frames, zero blank frames |
| `tests/splitbrain.redis.test.ts` | measurement | two real tickers racing one Redis; the overlap is in milliseconds and the lapse assertions carry no slack term at all by design |

TWO FILES ARE MIXED AND STAY WHERE THEY ARE. `ticker.redis.test.ts` and
`faults.redis.test.ts` each carry a few wall-clock cases inside a mostly
deterministic file, and the deterministic majority (the handoff, the stats TTL,
the lease theft, the crash counter) is exactly what a release gate is for. So the
measurement cases are gated PER CASE inside the file rather than the file being
moved out of the gate, which is the smaller loss.
