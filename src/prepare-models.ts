import { resolve } from "node:path";
import { prepareModels } from "./models.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  await prepareModels(resolve(process.env.ASR_MODEL_DIR || "models"),
    AbortSignal.any([controller.signal, AbortSignal.timeout(3_600_000)]), process.env.ASR_MODEL_ORIGIN);
  process.stdout.write("Models verified and prepared.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Model preparation failed"}\n`);
  process.exitCode = 1;
}
