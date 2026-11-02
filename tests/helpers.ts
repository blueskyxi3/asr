import { loadConfig } from "../src/config.js";

export const config = () => loadConfig({ ASR_API_KEY: "test-service-token-that-is-at-least-32-characters" });
export function wave(seconds = 1): Buffer {
  const b = Buffer.alloc(44 + Math.floor(seconds * 16000) * 2);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}

export async function until(test: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
