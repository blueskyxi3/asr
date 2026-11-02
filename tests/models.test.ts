import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareModels, verifyModels, type Asset } from "../src/models.js";

test("preparation verifies bytes and hash, publishes atomically, and reuses intact offline caches", async t => {
  const directory = await mkdtemp(join(tmpdir(), "asr-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("verified model fixture"); let calls = 0; let corrupt = false;
  const server = createServer((_req, res) => { calls++; res.end(corrupt ? Buffer.from("x".repeat(bytes.length)) : bytes); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const asset: Asset = { name: "fixture.onnx", url: `http://127.0.0.1:${address.port}/model`, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), license: "fixture" };
  await prepareModels(directory, new AbortController().signal, undefined, [asset]);
  assert.deepEqual(await readFile(join(directory, asset.name)), bytes);
  await prepareModels(directory, new AbortController().signal, undefined, [asset]);
  assert.equal(calls, 1);
  corrupt = true; await writeFile(join(directory, asset.name), "broken");
  await assert.rejects(verifyModels(directory, [asset]), /corrupted/);
  await assert.rejects(prepareModels(directory, new AbortController().signal, undefined, [asset]), /Integrity/);
  assert.equal((await readdir(directory)).some(name => name.endsWith(".part")), false);
  assert.equal(await readFile(join(directory, asset.name), "utf8"), "broken");
});
