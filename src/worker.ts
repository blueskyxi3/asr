import { createTranscriber } from "./inference.js";

try {
  const config = JSON.parse(process.argv[2] || "{}") as { modelDir: string; threads: number };
  const transcribe = createTranscriber(config.modelDir, config.threads);
  process.on("message", (message: { audio: Uint8Array; language: string }) => {
    try { process.send?.({ type: "result", value: transcribe(message.audio, message.language) }); }
    catch { process.send?.({ type: "error" }); }
  });
  process.on("disconnect", () => process.exit(0));
  process.send?.({ type: "ready" });
} catch {
  process.send?.({ type: "error" }, () => process.exit(1));
}
