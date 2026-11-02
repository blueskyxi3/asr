import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { verifyModels } from "../src/models.js";
import { ChildTranscriber, RecognitionQueue } from "../src/recognizer.js";
import { until, wave } from "./helpers.js";

test("real native model loads offline, detects silence, transcribes and recovers from crash and cancellation", { skip: !process.env.ASR_MODEL_DIR, timeout: 180_000 }, async t => {
  const config = loadConfig({ ...process.env, ASR_API_KEY: "test-service-token-that-is-at-least-32-characters" });
  await verifyModels(config.modelDir);
  let worker!: ChildTranscriber;
  const queue = new RecognitionQueue(config, () => worker = new ChildTranscriber(config));
  t.after(() => queue.close());
  await queue.start(); assert.equal(queue.ready, true);
  assert.equal((await queue.transcribe(wave(), "auto", new AbortController().signal)).text, "");
  if (process.env.ASR_TEST_AUDIO) {
    const result = await queue.transcribe(await readFile(process.env.ASR_TEST_AUDIO), "auto", new AbortController().signal);
    assert.ok(result.text.length > 0, "real speech must produce text");
    if (process.env.ASR_TEST_EXPECTED) assert.ok(result.text.includes(process.env.ASR_TEST_EXPECTED), result.text);
    t.diagnostic(JSON.stringify({ text: result.text, audioSeconds: result.audioSeconds, inferenceSeconds: result.inferenceSeconds }));
  }
  const child = Reflect.get(worker, "child") as ChildProcess;
  assert.ok(child.pid);
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGKILL"); await exited;
  await until(() => queue.ready, 60_000);
  assert.equal((await queue.transcribe(wave(), "zh", new AbortController().signal)).text, "");
  const controller = new AbortController();
  const active = queue.transcribe(wave(120), "auto", controller.signal);
  const cancelled = assert.rejects(active, (error: unknown) => error instanceof Error && "code" in error && error.code === "cancelled");
  controller.abort(); await cancelled;
  await until(() => queue.ready, 60_000);
  assert.equal((await queue.transcribe(wave(), "auto", new AbortController().signal)).text, "");
});
