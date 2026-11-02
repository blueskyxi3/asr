import { createRequire } from "node:module";
import { join } from "node:path";
import { languages } from "./config.js";
import { AsrError } from "./errors.js";
import { validateWave } from "./wave.js";

export interface Transcript { text: string; audioSeconds: number; inferenceSeconds: number }
interface Stream { acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void }
interface Recognizer {
  createStream(): Stream;
  setConfig(config: object): void;
  decode(stream: Stream): void;
  getResult(stream: Stream): { text: string };
}
interface Detector {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(copy: false): { start: number; samples: Float32Array };
  pop(): void;
  reset(): void;
  flush(): void;
}

/** Synchronous native inference is confined to a disposable child process. */
export function createTranscriber(modelDir: string, threads: number) {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as {
    OfflineRecognizer: new (config: object) => Recognizer;
    Vad: new (config: object, bufferSeconds: number) => Detector;
  };
  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { senseVoice: { model: join(modelDir, "model.int8.onnx"), language: "auto", useInverseTextNormalization: 1 },
      tokens: join(modelDir, "tokens.txt"), numThreads: threads, provider: "cpu", debug: 0 },
  };
  const recognizer = new sherpa.OfflineRecognizer(config);
  const detector = new sherpa.Vad({ sileroVad: {
    model: join(modelDir, "silero_vad.onnx"), threshold: 0.5, minSilenceDuration: 0.5,
    minSpeechDuration: 0.25, maxSpeechDuration: 30, windowSize: 512,
  }, sampleRate: 16000, numThreads: threads, provider: "cpu", debug: 0 }, 32);
  const silence = new Float32Array(16000);
  const warmup = recognizer.createStream();
  warmup.acceptWaveform({ samples: silence, sampleRate: 16000 });
  recognizer.decode(warmup);
  detector.acceptWaveform(silence);
  detector.reset();
  return (audio: Uint8Array, language: string): Transcript => {
    if (!languages.includes(language as typeof languages[number])) throw new AsrError("invalid_language", "Unsupported language");
    const audioSeconds = validateWave(audio, 120, 4 * 1024 * 1024);
    const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44);
    const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768);
    config.modelConfig.senseVoice.language = language;
    recognizer.setConfig(config);
    detector.reset();
    const started = performance.now();
    const texts: string[] = [];
    let first = true;
    const drain = () => {
      while (!detector.isEmpty()) {
        const segment = detector.front(false);
        let speech = segment.samples;
        if (first) {
          first = false;
          const from = Math.max(0, segment.start - 4800);
          if (from < segment.start) {
            speech = new Float32Array(segment.start - from + segment.samples.length);
            speech.set(samples.subarray(from, segment.start));
            speech.set(segment.samples, segment.start - from);
          }
        }
        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples: speech, sampleRate: 16000 });
        recognizer.decode(stream);
        texts.push(recognizer.getResult(stream).text.trim());
        detector.pop();
      }
    };
    for (let offset = 0; offset < samples.length; offset += 512) {
      detector.acceptWaveform(samples.subarray(offset, offset + 512));
      drain();
    }
    detector.flush(); drain();
    return { text: texts.filter(Boolean).join(" ").trim(), audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 };
  };
}
