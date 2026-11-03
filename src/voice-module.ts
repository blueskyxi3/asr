import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AsrError } from "./errors.js";
import { browserDirectory, voiceFilesReady, voiceLock } from "./voice-assets.js";

export const voiceManifest = { id: "asr", name: "本地语音服务", version: "0.2.0", sdk_version: 2,
  extensions: ["assistant.voice.control"], entry: "/assets/plugin.js", backend: "asr" };
const equal = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };
export function isVoiceRoute(url: string): boolean { return /^\/(assets\/|internal\/|(?:api\/)?v1\/voice\/)/.test(url); }

export function authenticateVoice(request: FastifyRequest, apiKey: string, hostSecret = process.env.ASR_HOST_SECRET || ""): void {
  if (!request.url.startsWith("/internal/") && equal(String(request.headers.authorization || ""), `Bearer ${apiKey}`)) return;
  if (hostSecret.length < 32) throw new AsrError("unauthorized", "Voice module pairing is not configured", 401);
  if (request.url.startsWith("/internal/") && equal(String(request.headers["x-aihub-plugin-secret"] || ""), hostSecret)) return;
  const token = String(request.headers["x-aihub-identity"] || "");
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra || token.length > 4096) throw new AsrError("unauthorized", "Invalid module identity", 401);
  const expected = createHmac("sha256", hostSecret).update(body).digest("base64url");
  if (!equal(signature, expected)) throw new AsrError("unauthorized", "Invalid module identity", 401);
  let claims: { plugin_id: string; user_id: number; method: string; uri: string; expires_at: number };
  try { claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new AsrError("unauthorized", "Invalid module identity", 401); }
  const now = Math.floor(Date.now() / 1000);
  if (claims.plugin_id !== "asr" || !Number.isSafeInteger(claims.user_id) || claims.user_id <= 0 || claims.method !== request.method || claims.uri !== request.url || claims.expires_at <= now || claims.expires_at > now + 60) throw new AsrError("unauthorized", "Invalid module identity", 401);
}

export async function registerVoiceModule(app: FastifyInstance, modelDir: string): Promise<void> {
  const lock = await voiceLock(); const ready = await voiceFilesReady(modelDir);
  const files = [...lock.files, ...(lock.runtime || []).filter((file) => file.name === "voice-runtime.wasm")];
  const capabilities = () => ({ protocol_version: 1, ready, model: lock.model, files });
  app.get("/internal/manifest", () => voiceManifest);
  app.post("/internal/voice/capabilities", capabilities);
  app.get("/v1/voice/capabilities", capabilities);
  app.get("/api/v1/voice/capabilities", capabilities);
  const allowedCode = new Set(["plugin.js", "voice-worker.js", "voice-capture.js", ...(lock.runtime || []).map((file) => file.name)]);
  app.get<{ Params: { file: string } }>("/assets/:file", async (request, reply) => {
    const name = request.params.file;
    const model = lock.files.some((file) => file.name === name);
    if (!model && !allowedCode.has(name)) throw new AsrError("not_found", "Unknown voice resource", 404);
    try {
      const file = model ? join(modelDir, "voice", name) : new URL(name, browserDirectory);
      const data = await readFile(file);
      return reply.type(({ ".js": "text/javascript", ".wasm": "application/wasm", ".txt": "text/plain" } as Record<string, string>)[extname(name)] || "application/octet-stream").send(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AsrError("not_ready", "Prepare voice resources and restart the service", 503);
      throw error;
    }
  });
}
