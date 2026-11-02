import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { buildApp } from '../dist/src/app.js';
import { loadConfig, modelId } from '../dist/src/config.js';
import { verifyModels } from '../dist/src/models.js';
import { RecognitionQueue } from '../dist/src/recognizer.js';

const config = loadConfig();
await verifyModels(config.modelDir);
const queue = new RecognitionQueue(config);
const app = await buildApp(config, queue, false);
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/readyz`)).status, 503);
  assert.equal((await fetch(`${url}/v1/models`)).status, 401);
  await queue.start();
  assert.ok(queue.ready, 'native model must actually load');
  const headers = { authorization: `Bearer ${config.apiKey}` };
  assert.equal((await (await fetch(`${url}/v1/models`, { headers })).json()).data[0].id, modelId);
  const audio = await readFile('/samples/zh.wav');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'sample.wav'); form.append('model', modelId);
  const response = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', headers, body: form });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.text.includes('早上9点至下午5点'), result.text);
  const child = spawn(process.execPath, ['dist/src/benchmark.js', '/samples/samples.json'], {
    cwd: '/app', env: { ...process.env, ASR_URL: url }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let report = ''; child.stdout.on('data', chunk => { report += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0);
  const benchmark = JSON.parse(report);
  const peakMemoryBytes = Number((await readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim());
  process.stdout.write(`${JSON.stringify({ platform: process.arch, offline: true, peakMemoryBytes, ...benchmark }, null, 2)}\n`);
} finally { await queue.close(); await app.close(); }
