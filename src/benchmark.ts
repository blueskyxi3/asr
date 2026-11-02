import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateWave } from "./wave.js";
import { modelId } from "./config.js";

interface Sample { file: string; reference: string; language?: string }
function distance(a: string[], b: string[]): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return row[b.length]!;
}
const normalize = (text: string) => text.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");

const manifest = process.argv[2];
if (!manifest || !process.env.ASR_API_KEY) throw new Error("Usage: ASR_API_KEY=... npm run benchmark -- samples.json");
const samples = JSON.parse(await readFile(manifest, "utf8")) as Sample[];
const runs = Number(process.env.ASR_BENCH_RUNS || 20);
if (!Number.isInteger(runs) || runs < 1 || runs > 1000 || !Array.isArray(samples) || !samples.length) throw new Error("Invalid benchmark manifest or run count");
const reports = [];
for (const sample of samples) {
  const audio = await readFile(resolve(dirname(resolve(manifest)), sample.file));
  const seconds = validateWave(audio, 120, 4 * 1024 * 1024);
  const latencies: number[] = [];
  let text = ""; let coldMs = 0;
  for (let run = 0; run <= runs; run++) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "sample.wav");
    form.append("model", modelId); form.append("response_format", "json");
    if (sample.language) form.append("language", sample.language);
    const started = performance.now();
    const response = await fetch(`${process.env.ASR_URL || "http://127.0.0.1:8000"}/v1/audio/transcriptions`, {
      method: "POST", headers: { authorization: `Bearer ${process.env.ASR_API_KEY}` }, body: form, signal: AbortSignal.timeout(150_000),
    });
    const result = await response.json() as { text?: string };
    if (!response.ok || typeof result.text !== "string") throw new Error(`Benchmark request failed: HTTP ${response.status}`);
    text = result.text;
    const elapsed = performance.now() - started;
    if (run === 0) coldMs = elapsed; else latencies.push(elapsed);
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.ceil(latencies.length * 0.5) - 1]!;
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
  const reference = normalize(sample.reference), actual = normalize(text);
  const words = (value: string) => value.toLowerCase().replace(/[\p{P}\p{S}]/gu, "").trim().split(/\s+/u).filter(Boolean);
  reports.push({ file: sample.file, audioSeconds: seconds, runs, text, reference: sample.reference,
    cer: reference.length ? distance([...reference], [...actual]) / [...reference].length : null,
    wer: sample.language === "en" ? distance(words(sample.reference), words(text)) / Math.max(1, words(sample.reference).length) : null,
    firstRequestMs: coldMs, p50Ms: p50, p95Ms: p95, rtfAtP95: p95 / 1000 / seconds });
}
process.stdout.write(`${JSON.stringify({ measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch, reports }, null, 2)}\n`);
