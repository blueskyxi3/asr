export const rate = 16000;

// Audio sample time, rather than wall-clock timers, determines the end of a turn.
export class TurnBuffer {
  constructor(pauseMs, maxSeconds = 120) { this.pause = Math.round(pauseMs * rate / 1000); this.max = maxSeconds * rate; this.reset(); }
  reset() { this.chunks = []; this.length = 0; this.lastSpeech = 0; this.hasSpeech = false; }
  push(samples, speech) {
    this.chunks.push(samples.slice()); this.length += samples.length;
    if (speech) { this.hasSpeech = true; this.lastSpeech = this.length; }
    if (this.hasSpeech && (this.length >= this.max || this.length - this.lastSpeech >= this.pause)) {
      const audio = new Float32Array(Math.min(this.length, this.max)); let offset = 0;
      for (const chunk of this.chunks) {
        const part = chunk.subarray(0, audio.length - offset); audio.set(part, offset); offset += part.length;
        if (offset === audio.length) break;
      }
      this.reset(); return audio;
    }
    // Waiting for the first speech must not accumulate minutes of silence.
    if (!this.hasSpeech && this.length > rate / 2) {
      const tail = this.chunks.slice(-Math.ceil(rate / 2 / samples.length));
      this.chunks = tail; this.length = tail.reduce((sum, chunk) => sum + chunk.length, 0);
    }
    return null;
  }
  ended(silenceSamples) {
    // Silero confirms a speech ending after minSilenceDuration; do not add it twice.
    if (this.hasSpeech) this.lastSpeech = Math.max(0, this.length - silenceSamples);
  }
}

export function wave(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2); const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); });
  return bytes;
}
