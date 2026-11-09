import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { registerVoiceModule } from "../src/voice-module.js";

test("voice downloads negotiate gzip without changing decoded model bytes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "asr-compression-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "voice"));
  const bytes = Buffer.from("voice-model-bytes".repeat(2048));
  await writeFile(join(directory, "voice", "tokens.txt"), bytes);
  const app = Fastify(); t.after(() => app.close());
  await registerVoiceModule(app, directory);
  for (const encoding of ["gzip, deflate, br", "gzip;q=0.5", "br, gzip; q=1"]) {
    const response = await app.inject({ url: "/assets/tokens.txt", headers: { "accept-encoding": encoding } });
    assert.equal(response.statusCode, 200); assert.equal(response.headers["content-encoding"], "gzip");
    assert.equal(response.headers.vary, "Accept-Encoding");
    assert.deepEqual(gunzipSync(response.rawPayload), bytes);
    assert.ok(response.rawPayload.length < bytes.length / 2);
  }
  for (const encoding of ["", "br", "gzip;q=0", "gzip; q=0.00, br"]) {
    const response = await app.inject({ url: "/assets/tokens.txt", headers: { "accept-encoding": encoding } });
    assert.equal(response.headers["content-encoding"], undefined); assert.deepEqual(response.rawPayload, bytes);
  }
  assert.equal((await app.inject({ url: "/assets/missing.onnx" })).statusCode, 404);
});
