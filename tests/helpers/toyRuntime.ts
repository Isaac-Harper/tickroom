// A minimal, deterministic RoomRuntime used by the ticker/e2e integration
// tests. Deliberately not imported from `examples/`: another agent is
// actively editing those, and this suite has no business depending on files
// under concurrent edit. It implements exactly the RoomRuntime contract
// (src/core/types.ts) plus the two optional hooks the ticker tests exercise
// (`isFull`, `graceUntilTick`), and nothing else.
import type { ClientInput, RoomRuntime } from '../../src/core/index.js';

export interface CounterState {
  tick: number;
  players: Set<string>;
  counters: Record<string, number>;
  /** Set by a `custom` envelope in the e2e test, to prove the host's onCustom path reaches the sim. */
  maxPlayers: number;
}

export type CounterEvent = { kind: 'tick'; tick: number } | { kind: 'join'; pid: string };

/** `tickHz` is a parameter, not a constant, because different tests want different real-time budgets: a handoff test wants a slow, easy-to-reason-about rate, a "measure the tick rate over 2s" test wants something close to a real game's 20Hz. */
export function createCounterRuntime(tickHz: number): RoomRuntime<CounterState, CounterEvent> {
  return {
    tickHz,

    create: (): CounterState => ({ tick: 0, players: new Set(), counters: {}, maxPlayers: 0 }),

    tick: (state) => {
      state.tick += 1;
      return { events: [{ kind: 'tick', tick: state.tick }] };
    },

    currentTick: (state) => state.tick,
    playerCount: (state) => state.players.size,

    // IDEMPOTENT, as the contract requires: the relay heartbeats a join
    // every second, so this must not reset an existing player's counter.
    join: (state, pid) => {
      if (!state.players.has(pid)) {
        state.players.add(pid);
        state.counters[pid] = 0;
      }
    },

    leave: (state, pid) => {
      state.players.delete(pid);
      delete state.counters[pid];
    },

    applyInput: (state, pid, input: ClientInput) => {
      if (!state.players.has(pid)) return;
      state.counters[pid] = (state.counters[pid] ?? 0) + ((input.data as number) ?? 0);
    },

    serialize: (state) =>
      JSON.stringify({
        tick: state.tick,
        players: Array.from(state.players),
        counters: state.counters,
        maxPlayers: state.maxPlayers,
      }),

    deserialize: (json): CounterState => {
      const parsed = JSON.parse(json) as {
        tick: number;
        players: string[];
        counters: Record<string, number>;
        maxPlayers: number;
      };
      return {
        tick: parsed.tick,
        players: new Set(parsed.players),
        counters: parsed.counters,
        maxPlayers: parsed.maxPlayers ?? 0,
      };
    },

    encodeSnapshot: (state, serverTimeMs) =>
      JSON.stringify({ tick: state.tick, players: Array.from(state.players), counters: state.counters, t: serverTimeMs }),

    isFull: (state) => state.maxPlayers > 0 && state.players.size >= state.maxPlayers,

    onCustom: (state, name, data) => {
      if (name === 'set-max-players' && typeof data === 'number') state.maxPlayers = data;
    },
  };
}
