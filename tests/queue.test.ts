import assert from "node:assert/strict";
import { test } from "node:test";
import { RecognitionQueue, type Transcriber } from "../src/recognizer.js";
import { AsrError } from "../src/errors.js";
import type { Transcript } from "../src/inference.js";
import { config, until, wave } from "./helpers.js";

class FakeWorker implements Transcriber {
  ready = false;
  starts = 0;
  calls: string[] = [];
  finish?: (value: Transcript) => void;
  async start() { this.ready = true; this.starts++; }
  async close() { this.ready = false; }
  run(_audio: Uint8Array, language: string, signal: AbortSignal): Promise<Transcript> {
    this.calls.push(language);
    return new Promise((resolve, reject) => {
      const abort = () => { this.ready = false; reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      this.finish = value => { signal.removeEventListener("abort", abort); resolve(value); };
    });
  }
}
const result = { text: "hello", audioSeconds: 1, inferenceSeconds: 0.1 };
const hasCode = (code: string) => (e: unknown) => e instanceof AsrError && e.code === code;

test("bounded FIFO admission rejects overflow; cancelled waiting audio never executes", async () => {
  const worker = new FakeWorker();
  const q = new RecognitionQueue({ ...config(), maxQueue: 1 }, () => worker);
  await q.start();
  const first = q.transcribe(wave(), "zh", new AbortController().signal);
  const controller = new AbortController();
  const waiting = q.transcribe(wave(), "en", controller.signal);
  const rejected = assert.rejects(waiting, hasCode("cancelled"));
  await assert.rejects(q.transcribe(wave(), "ja", new AbortController().signal), hasCode("queue_full"));
  controller.abort(); await rejected;
  worker.finish!(result); assert.equal((await first).text, "hello");
  assert.deepEqual(worker.calls, ["zh"]);
  await q.close();
});

test("running cancellation reclaims and reloads the worker before the next request", async () => {
  const worker = new FakeWorker(); const q = new RecognitionQueue(config(), () => worker);
  await q.start();
  const controller = new AbortController();
  const first = q.transcribe(wave(), "zh", controller.signal);
  const rejection = assert.rejects(first, hasCode("cancelled"));
  const second = q.transcribe(wave(), "en", new AbortController().signal);
  controller.abort(); await rejection;
  await until(() => worker.calls.length === 2);
  assert.equal(worker.starts, 2);
  worker.finish!(result); await second; await q.close();
});

test("queue and inference have separate deadlines; shutdown settles accepted work", async () => {
  const worker = new FakeWorker();
  const q = new RecognitionQueue({ ...config(), queueTimeoutMs: 15, inferenceTimeoutMs: 60 }, () => worker);
  await q.start();
  const first = q.transcribe(wave(), "zh", new AbortController().signal);
  const failed = assert.rejects(first, hasCode("inference_timeout"));
  await assert.rejects(q.transcribe(wave(), "en", new AbortController().signal), hasCode("queue_timeout"));
  await failed; await until(() => worker.starts === 2);
  const running = q.transcribe(wave(), "ja", new AbortController().signal);
  const cancelled = assert.rejects(running, hasCode("cancelled"));
  await q.close(); await cancelled;
  await assert.rejects(q.transcribe(wave(), "ko", new AbortController().signal), hasCode("not_ready"));
});
