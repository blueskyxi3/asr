import { resolve } from "node:path";
import { prepareVoiceModels } from "./voice-assets.js";
const controller = new AbortController();
process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
try {
  await prepareVoiceModels(resolve(process.env.ASR_MODEL_DIR || "models"), AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]));
  process.stdout.write("Voice models verified and prepared.\n");
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Voice preparation failed"}\n`); process.exitCode = 1; }
