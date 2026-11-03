// Native Web Audio resampling is preferred. Average continuous fractional intervals
// when the browser cannot create a 16 kHz AudioContext (notably some Firefox devices).
class VoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.pending = []; this.sum = 0; this.weight = 0; this.ratio = sampleRate / 16000; }
  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0]; if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0; for (const channel of channels) sample += channel[index] / channels.length;
      let left = 1;
      while (left > 1e-8) {
        const used = Math.min(left, this.ratio - this.weight);
        this.sum += sample * used; this.weight += used; left -= used;
        if (this.weight >= this.ratio - 1e-8) {
          this.pending.push(this.sum / this.weight); this.sum = 0; this.weight = 0;
          if (this.pending.length === 512) { const buffer = Float32Array.from(this.pending); this.pending = []; this.port.postMessage(buffer, [buffer.buffer]); }
        }
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
