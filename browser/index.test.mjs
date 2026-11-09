import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoiceController } from './index.mjs';

function environment(t, secure = true) {
  const values = { isSecureContext: secure, navigator: { mediaDevices: { getUserMedia() {} } } };
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  const events = [];
  const controller = createVoiceController({ assetBase: '/assets', settings: { wake_chunk_ms: 160 }, onEvent: event => events.push(event) });
  t.after(() => controller.dispose());
  return { controller, events };
}

test('HTTP fails before downloading models and explains the HTTPS requirement', async t => {
  const { controller, events } = environment(t, false);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not download'); });
  await controller.start();
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(events, [{ type: 'error', code: 'insecure', stage: 'browser' }]);
});

test('a stalled model response times out and cancels the resource request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, events } = environment(t);
  let started;
  const resource = new Promise(done => { started = done; });
  let requestSignal;
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    if (url.endsWith('/capabilities')) return new Response(JSON.stringify({ ready: true, protocol_version: 1,
      files: [{ name: 'voice-runtime.wasm', bytes: 1, sha256: 'test' }] }));
    requestSignal = signal; started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const start = controller.start();
  await resource; t.mock.timers.tick(120000); await start;
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(events.at(-1), { type: 'error', code: 'timeout', stage: 'resources' });
});

test('stopping a pending download aborts it without a late error or microphone request', async t => {
  const { controller, events } = environment(t);
  let requestSignal;
  t.mock.method(globalThis, 'fetch', (url, { signal }) => {
    requestSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const start = controller.start();
  await controller.dispose(); await start;
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(events, [{ type: 'loading' }]);
});
