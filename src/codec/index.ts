export { ByteWriter, ByteReader, CodecError } from './bytes.js';
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
} from './snapshot.js';
export {
  DEFAULT_SNAPSHOT_VERSION,
  encodeDefaultSnapshot,
  decodeDefaultSnapshot,
  INPUT_WINDOW_MAX,
  encodeInputWindow,
  decodeInputWindow,
  inputWindowToClientInputs,
} from './snapshot.js';
