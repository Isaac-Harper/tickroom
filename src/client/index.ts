// The browser half of tickroom: connect, survive reconnects and server
// handoffs invisibly, keep a clock in sync, and render other players smoothly
// despite jitter. See each module for the reasoning; this file only re-exports.

export {
  STALL_MS,
  STALL_COLD_MS,
  stallDecision,
  shouldReanchor,
  type NetStatus,
  type StallInputs,
  type StallDecision,
  type ReanchorInputs,
} from './netPolicy.js';

export { ErrorOffset, type Offset, type Offset2D, type ErrorOffsetConfig } from './errorOffset.js';

export {
  ClientTick,
  ANCHOR_MARGIN,
  TICK_STEP_CAP,
  STEP_DILATION_MAX,
  MARGIN_TARGET,
  MARGIN_SPAN,
  HEALTH_EASE_TAU,
  DILATION_EASE_TAU,
  type ClientTickOptions,
} from './clientTick.js';

export {
  SnapshotInterpolator,
  INTERP_START_MS,
  INTERP_MIN_MS,
  INTERP_MAX_MS,
  INTERP_ADAPT_LAMBDA,
  EXTRAP_CAP_MS,
  REANCHOR_AFTER_MS,
  REANCHOR_MIN_SAMPLES,
  OFFSET_FLOOR_SLACK_MS,
  TIMELINE_STEP_FRAMES,
  OFFSET_WINDOW,
  OFFSET_SLEW_MAX,
  DELAY_JITTER_QUANTILE,
  DELAY_MARGIN_MS,
  PARTIAL_SCAN_FRAMES,
  type Vec2,
  type EntitySample,
  type InterpolatedEntity,
  type SnapshotFrame,
  type InterpolatorOptions,
} from './interpolation.js';

export {
  RoomConnection,
  type SessionInfo,
  type DecodedSnapshotLike,
  type TerminalReason,
  type WebSocketLike,
  type WebSocketConstructor,
  type RoomConnectionOptions,
} from './connection.js';
