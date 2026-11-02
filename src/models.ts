import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface Asset { name: string; url: string; bytes: number; sha256: string; license: string }
export const projectRoot = new URL("../../", import.meta.url);

export async function readLock(): Promise<Asset[]> {
  const lock = JSON.parse(await readFile(new URL("models.lock.json", projectRoot), "utf8")) as { assets: Asset[] };
  return lock.assets;
}

export async function matchesAsset(path: string, asset: Asset): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== asset.bytes) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === asset.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function verifyModels(directory: string, assets: Asset[] = []): Promise<void> {
  for (const asset of assets.length ? assets : await readLock()) {
    if (!await matchesAsset(join(directory, asset.name), asset)) throw new Error(`Missing or corrupted model: ${asset.name}. Run prepare-models first.`);
  }
}

/** Download only on explicit preparation, verifying before atomic publication. */
export async function prepareModels(directory: string, signal: AbortSignal, origin?: string, assets?: Asset[]): Promise<void> {
  signal.throwIfAborted();
  let source: URL | undefined;
  if (origin) {
    source = new URL(origin);
    if (!/^https?:$/.test(source.protocol) || source.username || source.password || source.pathname !== "/" || source.search || source.hash) {
      throw new Error("ASR_MODEL_ORIGIN must be an HTTP(S) origin without credentials");
    }
  }
  await mkdir(directory, { recursive: true });
  for (const asset of assets ?? await readLock()) {
    signal.throwIfAborted();
    const destination = join(directory, asset.name);
    if (await matchesAsset(destination, asset)) continue;
    const partial = `${destination}.${randomUUID()}.part`;
    const url = new URL(asset.url);
    if (source) { url.protocol = source.protocol; url.host = source.host; }
    try {
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Download failed for ${asset.name}: HTTP ${response.status}`);
      }
      let count = 0;
      const hash = createHash("sha256");
      const checking = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        count += chunk.length;
        if (count > asset.bytes) { callback(new Error(`Size mismatch: ${asset.name}`)); return; }
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), checking, createWriteStream(partial, { flags: "wx", mode: 0o644 }), { signal });
      if (count !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error(`Integrity mismatch: ${asset.name}`);
      signal.throwIfAborted();
      await rename(partial, destination);
    } finally { await rm(partial, { force: true }); }
  }
  // Ship the exact notices alongside an explicitly prepared model directory.
  signal.throwIfAborted();
  await mkdir(join(directory, "licenses"), { recursive: true });
  for (const name of ["FunASR-MODEL_LICENSE", "Silero-LICENSE", "SOURCES.md"]) {
    await copyFile(new URL(`licenses/${name}`, projectRoot), join(directory, "licenses", name));
  }
}
