import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { matchesAsset, projectRoot } from "./models.js";

export interface VoiceFile { name: string; bytes: number; sha256: string }
export interface VoiceLock {
  model: string;
  package: VoiceFile & { url: string };
  files: VoiceFile[];
  runtime?: VoiceFile[];
}
export const browserDirectory = new URL("../../browser-dist/", import.meta.url);
export async function voiceLock(): Promise<VoiceLock> {
  return JSON.parse(await readFile(new URL("voice-assets.lock.json", projectRoot), "utf8")) as VoiceLock;
}
export async function voiceFilesReady(modelDir: string): Promise<boolean> {
  const lock = await voiceLock();
  if (!lock.runtime?.length) return false;
  for (const file of lock.files) {
    if (!await matchesAsset(join(modelDir, "voice", file.name), { ...file, url: "", license: "" })) return false;
  }
  for (const file of lock.runtime) {
    if (!await matchesAsset(new URL(file.name, browserDirectory).pathname, { ...file, url: "", license: "" })) return false;
  }
  return true;
}

export async function prepareVoiceModels(modelDir: string, signal: AbortSignal): Promise<void> {
  const lock = await voiceLock();
  const destination = join(modelDir, "voice"); await mkdir(destination, { recursive: true });
  const staging = await mkdtemp(join(modelDir, ".voice-"));
  try {
    const needed = await Promise.all(lock.files.filter((file) => file.name !== "silero_vad.onnx")
      .map((file) => matchesAsset(join(destination, file.name), { ...file, url: "", license: "" })));
    if (!needed.every(Boolean)) {
      const url = new URL(lock.package.url);
      if (process.env.ASR_KWS_MODEL_ORIGIN) {
        const origin = new URL(process.env.ASR_KWS_MODEL_ORIGIN);
        if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid ASR_KWS_MODEL_ORIGIN");
        url.protocol = origin.protocol; url.host = origin.host;
      }
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body) throw new Error(`Wake model download failed: HTTP ${response.status}`);
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > lock.package.bytes) { await response.body.cancel().catch(() => {}); throw new Error("Wake archive too large"); } chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);
      if (size !== lock.package.bytes || createHash("sha256").update(bytes).digest("hex") !== lock.package.sha256) throw new Error("Wake model archive integrity mismatch");
      const archive = join(staging, "model.tgz"); await writeFile(archive, bytes);
      await promisify(execFile)("tar", ["-xzf", archive, "-C", staging, "package/kws", "package/LICENSE", "package/NOTICE.md"], { signal });
      for (const file of lock.files.filter((file) => file.name !== "silero_vad.onnx")) {
        const extracted = join(staging, "package/kws", file.name);
        if (!await matchesAsset(extracted, { ...file, url: "", license: "" })) throw new Error(`Wake model integrity mismatch: ${file.name}`);
        await rename(extracted, join(destination, file.name));
      }
    }
    const silero = lock.files.find((file) => file.name === "silero_vad.onnx")!;
    if (!await matchesAsset(join(modelDir, silero.name), { ...silero, url: "", license: "" })) throw new Error("Prepare ASR models before voice models");
    await copyFile(join(modelDir, silero.name), join(destination, silero.name));
    await mkdir(join(destination, "licenses"), { recursive: true });
    for (const name of ["KWS-LICENSE", "KWS-NOTICE.md", "Silero-LICENSE"]) await copyFile(new URL(`licenses/${name}`, projectRoot), join(destination, "licenses", name));
  } finally { await rm(staging, { recursive: true, force: true }); }
}
