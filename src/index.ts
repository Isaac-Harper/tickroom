// tickroom: authoritative realtime rooms on serverless.
//
// This root barrel exists for convenience and for discovery. PREFER THE SUBPATH
// IMPORTS in real code:
//
//   import type { RoomRuntime } from 'tickroom/core';
//   import { runTicker }         from 'tickroom/server';
//   import { RoomConnection }    from 'tickroom/client';
//   import { ByteWriter }        from 'tickroom/codec';
//
// The reason is not style, it is what ends up in your browser bundle. `server`
// reaches ioredis and node:zlib and `adapters/node` expects a Node runtime, so
// neither is re-exported here; the subpaths make that boundary explicit and
// unmissable, and keep a stray root import from widening it later.
//
// `adapters` is deliberately NOT re-exported here. Each adapter targets one host
// and takes that host's handle by injection, so there is nothing useful to hoist
// into a generic surface, and hoisting it would put a platform in everyone's
// import graph. Reach for `tickroom/adapters/vercel` or `tickroom/adapters/node`
// by name.

// The contract and the pure primitives. Safe everywhere: no IO, no clock, no
// platform, so this half is identical in a browser, on a server, and in a test.
// That claim is now enforced rather than asserted: no file under `src/core/`
// imports a platform module, and `src/client/bundling.test.ts` bundles both this
// barrel and `core` for the browser on every run. Checkpoint gzip and its Redis
// read/write pair live in `tickroom/server` for exactly this reason.
export * from './core/index.js';

// The wire. Also pure, and deliberately separate from `core` because a project
// is expected to outgrow the default codec and write its own; keeping it apart
// makes that a swap rather than a fork.
export * from './codec/index.js';
