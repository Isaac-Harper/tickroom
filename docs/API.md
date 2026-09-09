# The supported surface

What semver applies to. The barrels under `src/` re-export more than this
list, because `tickroom/core` is an `export *` over every module in the pure
layer and the other subpaths re-export the constants their tests pin. Every
one of those names is reachable, but only the names below are a contract.

Three rules, stated once so the lists can stay short:

- **A supported function carries its types.** The option bag it takes and the
  value it returns are supported with it, under the names the barrel exports
  (`runTicker` brings `TickerOptions`, `HostTickerOptions` and `TickerResult`;
  `RoomConnection` brings `RoomConnectionOptions`, `PredictionOptions`,
  `SnapshotInterpolationOptions`, `FrameView`, `ConnectionStats`,
  `SessionInfo`, `TerminalReason` and `DecodedSnapshotLike`). Adding an
  optional field to one of them is a minor; removing or retyping a field is a
  major.
- **Constants are exported to be read, not relied on.** Every `UPPER_CASE`
  export exists so a host or a test can read the same number the library uses
  rather than retype it. The NAME is stable within a major; the VALUE is
  tuning and may move in a minor, with the change noted in `CHANGELOG.md`.
  The exceptions are the wire and platform couplings, which are listed
  explicitly below and whose values are part of the contract.
- **Everything else is internal.** It is reachable because a barrel exposes
  it, it is tested, and it may change or disappear in a minor. A 2.0 prunes
  it from the barrels. If you find yourself importing one of these names,
  open an issue: either it should be on this list or there is a missing
  option.

## `tickroom/core`

The contract a simulation implements, and the pure mechanisms a host can drive
directly.

- Types: `RoomRuntime`, `ClientInput`, `RoomStats`, `Counters`, `Percentiles`,
  `Logger`, `LogEvent`, `LogKind`, `RedisLike`, `CheckpointEnvelope`,
  `RoomEnvelope`, `SnapshotPayload`.
- Values: `LOG_KINDS`, `CLOSE_CODES`, `SERVER_FRAMES`, `CLIENT_FRAMES`,
  `roomKeys`, `normalizeRoomId`, `normalizeBase`, `roomIdFor`,
  `acquireLease`, `renewLease`, `releaseLease`, `OwnershipClock`,
  `CHECKPOINT_VERSION`, `packCheckpoint`, `unpackCheckpoint`,
  `inspectCheckpoint`, `graceMsFromCheckpoint`, `PlayoutBuffer`,
  `StarveTracker`, `decayOnStarve`, `mayPublish`, `TokenBucket`,
  `RollingHistogram`, `percentiles`.
- Contract constants (value included): `CLOSE_CODES` (4001 to 4004),
  `RELAY_EXPIRY_LEAD_MS`, `PING_INTERVAL_MS`, `DEPTH_INTERVAL_MS`,
  `JOIN_HEARTBEAT_MS`, `PRESENCE_TIMEOUT_HEARTBEATS`, `MAX_TICKER_MS`,
  `MAX_ROOMS_PER_BASE`, `PLAYOUT_MAX_AHEAD`.
- Internal: the frame encode and narrow helpers (`encodePing`, `encodePong`,
  `encodeDepth`, `encodeInputLead`, `isPongFrame`, `isRelayExpiringFrame`,
  `isInputLeadFrame`, `depthFor`, `PING_FRAME_PREFIX`, `DEPTH_FRAME`,
  `ROOM_REJECT_FRAME` and their frame types), the lease clock steps
  (`createOwnershipClock`, `renewDue`, `renewAttempted`, `renewConfirmed`,
  `renewFailed`, `tickerShouldExit`, `shouldSpawnTicker`), the inbox
  (`Inbox`, `INBOX_CAP`, `PER_SENDER_CAP`, `MAX_DRAIN_PER_TICK`), and the
  remaining tuning constants.

## `tickroom/server`

- Values: `runTicker`, `attachRelay`, `checkAdmission`, `admitSocket`,
  `refuseSocket`, `assignRoom`, `makeToken`, `verifyToken`, `makeSpawnToken`,
  `verifySpawnToken`, `getRedis`, `createSubscriber`, `writeCheckpoint`,
  `readCheckpoint`, `createMemoryRedis`.
- Types beyond the ones the functions above carry: `RelaySocket`,
  `RelayHandle`, `Subscriber`, `TokenClaims`, `CheckpointOwnerCheck`,
  `MemoryRedisHandle`.
- Contract constants: `SPAWN_TOKEN_WINDOW_MS`, `STATE_TTL_S`.
- Internal: `encodeCheckpoint`, `decodeCheckpoint`, `publishCustom`,
  `registerConnection`, `secretMatches`, `requireSecret`, the `MemoryRedis`
  class (use the factory), `resetRedisForTests`, `DEFAULT_CONN_STALE_MS`,
  `CONN_TOUCH_MS`, `CONN_KEY_TTL_S`.

`tickroom/server/memoryRedis` is `createMemoryRedis` and its handle type,
and exists so a no-Redis host never loads `ioredis`.

## `tickroom/client`

- Values: `RoomConnection`, `isRosterFrame`, `SnapshotInterpolator`,
  `PredictedEntity`, `ClientTick`, `ErrorOffset`, `stallDecision`,
  `shouldReanchor`.
- Types beyond the ones those carry: `RosterFrame`, `WebSocketLike`,
  `WebSocketConstructor`, `NetStatus`, `EntitySample`, `InterpolatedEntity`,
  `SnapshotFrame`, `Vec2`, `Pose`, `StampedRecord`, `Offset`, `Offset2D`.
- Contract constants: the reconnect ladder (`RECONNECT_BASE_MS`,
  `RECONNECT_FACTOR`, `RECONNECT_JITTER_MIN`, `RECONNECT_JITTER_MAX`) and the
  stamped-input wire (`INPUT_WINDOW`, `INPUT_HISTORY`).
- Every other exported constant is interpolator, stall and re-anchor tuning:
  readable, renamed only in a major, revalued in a minor.

`PredictedEntity`, `ClientTick` and `ErrorOffset` are the low-level form of
what `predict` on the connection does for you. They stay supported for a host
that needs its own call order; the documented path is the option.

## `tickroom/codec`

Everything the barrel exports is supported: `ByteWriter`, `ByteReader`,
`CodecError`, `ProtocolVersionError`, `quantize`, `dequantize`,
`representableRange`, `I16`, `U16`, `quantizeCm`, `dequantizeCm`,
`CM_SCALE`, `quantizeAngle`, `dequantizeAngle`, `encodeDefaultSnapshot`,
`decodeDefaultSnapshot`, `DEFAULT_SNAPSHOT_VERSION`, `encodeInputWindow`,
`decodeInputWindow`, `decodeInputAuto`, `inputWindowToClientInputs`,
`INPUT_WINDOW_MAX`, `AXIS_SCALE`, and the `Default*` and `CodecEntity` types.
`CM_SCALE`, `AXIS_SCALE`, `DEFAULT_SNAPSHOT_VERSION` and `INPUT_WINDOW_MAX`
are wire couplings: a change to any of them is a wire version bump and a
major.

## `tickroom/adapters/vercel`

- Values: `createRoom`, `createTickerRoute`, `createRelayRoute`,
  `createBalancerRoute`, `tickerRouteConfig`, `relayRouteConfig`.
- Types: `VercelRoom`, `VercelRoomOptions`, `VercelRoomsOptions`,
  `VercelRoomSessionOptions`, `VercelTickerRouteOptions`,
  `VercelRelayRouteOptions`, `VercelBalancerRouteOptions`.
- Contract constants, because each is a number a route file or a platform
  setting has to agree with: `MIN_TICKER_RUN_MS`, `MIN_RELAY_LIFETIME_MS`,
  `TICKER_EXIT_MARGIN_MS`, `RELAY_EXIT_MARGIN_MS`, `SPAWN_ACK_MS`.
- Internal: `defaultDecodeInput`, `SPAWN_DELIVERED`, `STANDBY_WAIT_MS`, and
  the `refuseSocket` and `registerConnection` re-exports (import them from
  `tickroom/server`).

## `tickroom/adapters/node`

`attachNodeRelay`, `runNodeTicker` and their option types. All supported.

## `tickroom/testing`

`runLockstep`, `sweepLockstep` and their option, frame, reconcile, report and
sweep-result types. All supported.
