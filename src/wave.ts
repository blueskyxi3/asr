import { AsrError } from "./errors.js";

/** Validate the complete, canonical PCM16 WAV before native inference. */
export function validateWave(audio: Uint8Array, maxSeconds: number, maxBytes: number): number {
  if (audio.byteLength > maxBytes) throw new AsrError("audio_too_large", "Audio exceeds the byte limit", 413);
  if (audio.byteLength < 46) throw new AsrError("invalid_audio", "Empty or invalid WAV");
  const b = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE"
    || b.toString("ascii", 12, 16) !== "fmt " || b.toString("ascii", 36, 40) !== "data"
    || b.readUInt32LE(4) !== b.length - 8 || b.readUInt32LE(16) !== 16
    || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000
    || b.readUInt32LE(28) !== 32000 || b.readUInt16LE(32) !== 2 || b.readUInt16LE(34) !== 16
    || b.readUInt32LE(40) !== b.length - 44 || (b.length - 44) % 2 !== 0) {
    throw new AsrError("invalid_audio", "Expected canonical 16 kHz mono PCM16 WAV", 415);
  }
  const seconds = (b.length - 44) / 32000;
  if (seconds > maxSeconds) throw new AsrError("audio_too_long", "Audio exceeds the duration limit", 413);
  return seconds;
}
