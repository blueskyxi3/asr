import { resolve } from "node:path";

export const modelId = "sensevoice-small-int8";
export const languages = ["auto", "zh", "en", "yue", "ja", "ko"] as const;

export interface Config {
  host: string;
  port: number;
  apiKey: string;
  modelDir: string;
  threads: number;
  workers: number;
  maxQueue: number;
  queueTimeoutMs: number;
  inferenceTimeoutMs: number;
  startupTimeoutMs: number;
  maxAudioBytes: number;
  maxDurationSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const number = (name: string, fallback: number, min = 1, max = 2_147_483_647) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const apiKey = env.ASR_API_KEY?.trim();
  if (!apiKey || apiKey.length < 32) throw new Error("ASR_API_KEY must contain at least 32 characters");
  return {
    host: env.ASR_HOST || "0.0.0.0",
    port: number("ASR_PORT", 8000, 1, 65535),
    apiKey,
    modelDir: resolve(env.ASR_MODEL_DIR || "models"),
    threads: number("ASR_THREADS", 2, 1, 64),
    workers: number("ASR_WORKERS", 1, 1, 16),
    maxQueue: number("ASR_MAX_QUEUE", 4, 0, 1000),
    queueTimeoutMs: number("ASR_QUEUE_TIMEOUT_MS", 10_000),
    inferenceTimeoutMs: number("ASR_INFERENCE_TIMEOUT_MS", 120_000),
    startupTimeoutMs: number("ASR_STARTUP_TIMEOUT_MS", 60_000),
    maxAudioBytes: number("ASR_MAX_AUDIO_BYTES", 4 * 1024 * 1024, 46, 4 * 1024 * 1024),
    maxDurationSeconds: number("ASR_MAX_DURATION_SECONDS", 120, 1, 120),
  };
}
