// The browser half of tickroom: connect, survive reconnects and server
// handoffs invisibly, keep a clock in sync, and render other players smoothly
// despite jitter. See each module for the reasoning; this file only re-exports.

export {
  STALL_MS,
  STALL_COLD_MS,
  REANCHOR_TOLERANCE_TICKS,
  REANCHOR_MIN_INTERVAL_MS,
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
  TICK_STEP_CAP,
  type ClientTickOptions,
  type ClientTickView,
} from './clientTick.js';

export {
  PredictedEntity,
  INPUT_WINDOW,
  INPUT_HISTORY,
  RENDER_SLEW,
  PLAYHEAD_SNAP_TICKS,
  type Pose,
  type PredictedEntityOptions,
} from './predictedEntity.js';

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
  TIMELINE_STEP_WINDOW,
  OFFSET_WINDOW,
  OFFSET_SLEW_MAX,
  DELAY_JITTER_QUANTILE,
  DELAY_MARGIN_MS,
  DELAY_SLEW_MAX,
  FRAME_GAP_SLACK_MS,
  RESUME_GLIDE_MAX_MS,
  PARTIAL_SCAN_FRAMES,
  type Vec2,
  type EntitySample,
  type InterpolatedEntity,
  type SnapshotFrame,
  type InterpolatorOptions,
} from './interpolation.js';

export {
  RoomConnection,
  isRosterFrame,
  RECONNECT_BASE_MS,
  RECONNECT_FACTOR,
  RECONNECT_JITTER_MIN,
  RECONNECT_JITTER_MAX,
  type SessionInfo,
  type DecodedSnapshotLike,
  type RosterFrame,
  type TerminalReason,
  type WebSocketLike,
  type WebSocketConstructor,
  type RoomConnectionOptions,
  type SnapshotInterpolationOptions,
  type FrameView,
  type ConnectionStats,
} from './connection.js';
