import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { verifyModels } from "./models.js";
import { RecognitionQueue } from "./recognizer.js";

const config = loadConfig();
const queue = new RecognitionQueue(config);
const app = await buildApp(config, queue);
await app.listen({ host: config.host, port: config.port });
void verifyModels(config.modelDir).then(() => queue.start()).catch(() => {
  app.log.error({ code: "models_unavailable" }, "Model verification failed; run prepare-models and restart the service");
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await queue.close();
  await app.close();
};
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
