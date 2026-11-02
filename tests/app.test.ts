import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { buildApp, type RecognizerService } from "../src/app.js";
import { modelId } from "../src/config.js";
import { config, until, wave } from "./helpers.js";

async function multipart(audio: Buffer, fields: Record<string, string> = { model: modelId, response_format: "json" }) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), "recording.wav");
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const request = new Request("http://localhost", { method: "POST", body: form });
  return { payload: Buffer.from(await request.arrayBuffer()), contentType: request.headers.get("content-type")! };
}

test("OpenAI-compatible service authenticates, validates actual WAV and returns only text", async t => {
  let calls = 0; let ready = true;
  const service: RecognizerService = { get ready() { return ready; }, close: async () => {}, transcribe: async (_audio, language) => {
    calls++; assert.equal(language, "auto");
    return { text: "测试", audioSeconds: 1, inferenceSeconds: 0.01, queueSeconds: 0 };
  } };
  const cfg = config(); const app = await buildApp(cfg, service, false); t.after(() => app.close());
  assert.equal((await app.inject("/healthz")).statusCode, 200);
  assert.equal((await app.inject("/v1/models")).statusCode, 401);
  const headers = { authorization: `Bearer ${cfg.apiKey}` };
  assert.equal((await app.inject({ url: "/v1/models", headers })).json().data[0].id, modelId);
  const send = async (audio: Buffer, fields?: Record<string, string>) => {
    const body = await multipart(audio, fields);
    return app.inject({ method: "POST", url: "/v1/audio/transcriptions", headers: { ...headers, "content-type": body.contentType }, payload: body.payload });
  };
  const response = await send(wave());
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { text: "测试" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal((await send(Buffer.from("not audio"))).statusCode, 400);
  const wrongRate = wave(); wrongRate.writeUInt32LE(48000, 24);
  assert.equal((await send(wrongRate)).statusCode, 415);
  assert.equal((await send(wave(), { model: "other" })).json().error.code, "invalid_model");
  assert.equal((await send(wave(), { model: modelId, language: "de" })).json().error.code, "invalid_language");
  assert.equal((await send(wave(121))).statusCode, 413);
  assert.equal(calls, 1);
  ready = false;
  assert.equal((await app.inject("/readyz")).statusCode, 503);
  assert.equal((await send(wave())).json().error.code, "not_ready");
});

test("disconnecting an actual HTTP client aborts pending recognition", async t => {
  let entered = false, aborted = false;
  const service: RecognizerService = { ready: true, close: async () => {}, transcribe: async (_audio, _language, signal) => {
    entered = true;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      aborted = true; reject(new Error("cancelled"));
    }, { once: true }));
  } };
  const cfg = config(); const app = await buildApp(cfg, service, false); t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as { port: number };
  const body = await multipart(wave());
  const client = httpRequest(`http://127.0.0.1:${address.port}/v1/audio/transcriptions`, {
    method: "POST", headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": body.contentType, "content-length": body.payload.length },
  });
  client.on("error", () => {}); client.end(body.payload);
  await until(() => entered); client.destroy();
  await until(() => aborted);
});
