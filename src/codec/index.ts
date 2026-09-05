export { ByteWriter, ByteReader, CodecError, ProtocolVersionError } from './bytes.js';
export {
  quantize,
  dequantize,
  representableRange,
  I16,
  U16,
  CM_SCALE,
  quantizeCm,
  dequantizeCm,
  quantizeAngle,
  dequantizeAngle,
} from './quantize.js';
export type {
  CodecEntity,
  DefaultSnapshot,
  DefaultSnapshotCodecOptions,
  DefaultInputRecord,
  DefaultInputWindowOptions,
} from './snapshot.js';
export {
  DEFAULT_SNAPSHOT_VERSION,
  encodeDefaultSnapshot,
  decodeDefaultSnapshot,
  INPUT_WINDOW_MAX,
  AXIS_SCALE,
  encodeInputWindow,
  decodeInputWindow,
  inputWindowToClientInputs,
} from './snapshot.js';
