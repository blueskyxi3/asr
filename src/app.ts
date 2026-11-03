import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { languages, modelId, type Config } from "./config.js";
import { AsrError } from "./errors.js";
import type { RecognitionQueue } from "./recognizer.js";
import { validateWave } from "./wave.js";
import { authenticateVoice, isVoiceRoute, registerVoiceModule } from "./voice-module.js";

export type RecognizerService = Pick<RecognitionQueue, "ready" | "transcribe" | "close">;

export async function buildApp(config: Config, recognizer: RecognizerService, logging = true): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024, logger: logging ? { redact: ["req.headers.authorization"] } : false,
    requestTimeout: 150_000, connectionTimeout: 150_000,
    requestIdHeader: "x-request-id",
  });
  await app.register(multipart, { limits: { files: 1, fileSize: config.maxAudioBytes, fields: 3, parts: 4, fieldSize: 100, fieldNameSize: 64 } });
  app.addHook("onClose", () => recognizer.close());
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Request-ID", request.id);
    if (request.url.split("?")[0] === "/healthz" || request.url.split("?")[0] === "/readyz") return;
    if (isVoiceRoute(request.url)) { authenticateVoice(request, config.apiKey); return; }
    const received = Buffer.from(request.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${config.apiKey}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new AsrError("unauthorized", "Invalid service token", 401);
    }
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const known = error instanceof AsrError;
    const tooLarge = /LIMIT|TOO_LARGE/.test(error.code || "") || error.statusCode === 413;
    const status = known ? error.status : tooLarge ? 413 : error.statusCode && error.statusCode < 500 ? 400 : 500;
    const code = known ? error.code : tooLarge ? "audio_too_large" : status === 400 ? "invalid_request" : "internal_error";
    request.log.warn({ code, status }, "ASR request failed");
    if (!reply.raw.destroyed) reply.code(status).send({ error: { message: known ? error.message : status < 500 ? "Invalid transcription request" : "Recognition service failed", type: "asr_error", code } });
  });
  app.get("/healthz", () => ({ status: "ok" }));
  await registerVoiceModule(app, config.modelDir);
  app.get("/readyz", async (_request, reply) => reply.code(recognizer.ready ? 200 : 503).send({ ready: recognizer.ready }));
  app.get("/v1/models", () => ({ object: "list", data: [{ id: modelId, object: "model", created: 0, owned_by: "self-hosted" }] }));
  app.post("/v1/audio/transcriptions", async (request, reply) => {
    if (!recognizer.ready) throw new AsrError("not_ready", "Recognition models are not ready", 503);
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableFinished) controller.abort(); };
    request.raw.once("aborted", abort); reply.raw.once("close", abort);
    try {
      let audio: Buffer | undefined;
      const fields = new Map<string, string>();
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "file" || audio) throw new AsrError("invalid_file", "Expected a single file field");
          audio = await part.toBuffer();
        } else {
          if (!["model", "language", "response_format"].includes(part.fieldname) || fields.has(part.fieldname) || typeof part.value !== "string") {
            throw new AsrError("invalid_field", "Unknown or duplicate transcription field");
          }
          fields.set(part.fieldname, part.value);
        }
      }
      if (!audio) throw new AsrError("missing_file", "A WAV file is required");
      if (fields.get("model") !== modelId) throw new AsrError("invalid_model", "Unknown recognition model");
      if (fields.has("response_format") && fields.get("response_format") !== "json") throw new AsrError("invalid_format", "Only JSON responses are supported");
      const language = fields.get("language") || "auto";
      if (!languages.includes(language as typeof languages[number])) throw new AsrError("invalid_language", "Unsupported language");
      validateWave(audio, config.maxDurationSeconds, config.maxAudioBytes);
      const result = await recognizer.transcribe(audio, language, controller.signal);
      request.log.info({ audioSeconds: result.audioSeconds, inferenceSeconds: result.inferenceSeconds, queueSeconds: result.queueSeconds }, "Transcription completed");
      return { text: result.text };
    } finally { request.raw.off("aborted", abort); reply.raw.off("close", abort); }
  });
  return app;
}
