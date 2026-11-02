import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { AsrError } from "../src/errors.js";
import { validateWave } from "../src/wave.js";
import { wave } from "./helpers.js";

test("accepts exact duration and byte limits, rejects malformed headers and overshoot", () => {
  const audio = wave(1);
  assert.equal(validateWave(audio, 1, audio.length), 1);
  assert.throws(() => validateWave(audio, 0.99, audio.length), (e: unknown) => e instanceof AsrError && e.status === 413);
  assert.throws(() => validateWave(audio, 1, audio.length - 1), (e: unknown) => e instanceof AsrError && e.status === 413);
  for (const offset of [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const invalid = Buffer.from(audio); invalid[offset] = invalid[offset]! ^ 1;
    assert.throws(() => validateWave(invalid, 120, 4 * 1024 * 1024));
  }
  assert.throws(() => validateWave(wave(0), 120, 4 * 1024 * 1024));
});

test("configuration requires a service key and bounded CPU/audio/queue settings", () => {
  assert.throws(() => loadConfig({}), /ASR_API_KEY/);
  const env = { ASR_API_KEY: "a".repeat(32) };
  for (const [key, value] of [["ASR_WORKERS", "0"], ["ASR_MAX_QUEUE", "-1"], ["ASR_MAX_DURATION_SECONDS", "121"], ["ASR_THREADS", "1.5"]]) {
    assert.throws(() => loadConfig({ ...env, [key!]: value }), new RegExp(key!));
  }
  assert.equal(loadConfig({ ...env, ASR_MAX_QUEUE: "0" }).maxQueue, 0);
});
