import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium, firefox, webkit } from 'playwright';

const modelDir = process.env.ASR_MODEL_DIR;
const fixture = process.env.ASR_KWS_TEST_AUDIO;
const lock = JSON.parse(await readFile(new URL('../voice-assets.lock.json', import.meta.url)));
const html = `<meta charset="utf-8"><button id="start">start</button><script type="module">
import {createVoiceController} from '/assets/plugin.js';
window.events=[];
window.startVoice=(chunk=160)=>{
 window.voice=createVoiceController({assetBase:'/assets',settings:{wake_words:['法国'],wake_chunk_ms:chunk,wake_threshold:.25,wake_score:1,wake_cooldown_ms:1500,pause_ms:1200},
 onEvent:event=>window.events.push({type:event.type,code:event.code,stage:event.stage,bytes:event.audio?.byteLength})});
 return window.voice.start();
};
document.querySelector('#start').onclick=()=>window.startVoice(window.chunk);
</script>`;
for (const [name, browserType] of Object.entries({ chromium, firefox, webkit })) {
  for (const chunk of [160, 320]) {
    test(`${name} ${chunk}ms: real local KWS/VAD, no standby upload, cached model, late grant cleanup`, { skip: !modelDir || !fixture, timeout: 60000 }, async t => {
      const requests = new Map(); let posts = 0;
      const server = createServer(async (request, response) => {
        try {
          const path = new URL(request.url, 'http://localhost').pathname;
          requests.set(path, (requests.get(path) || 0) + 1);
          if (request.method === 'POST') { posts++; response.writeHead(500).end(); return; }
          if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
          if (path === '/fixture.wav') { response.setHeader('Content-Type', 'audio/wav'); response.end(await readFile(fixture)); return; }
          if (path === '/api/v1/voice/capabilities') {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ protocol_version: 1, ready: true, files: [...lock.files, ...lock.runtime.filter(file => file.name === 'voice-runtime.wasm')] })); return;
          }
          const file = path.replace('/assets/', '');
          if (file.includes('/') || !path.startsWith('/assets/')) { response.writeHead(404).end(); return; }
          const source = lock.files.some(entry => entry.name === file) ? join(modelDir, 'voice', file) : resolve('browser-dist', file);
          response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
          response.end(await readFile(source));
        } catch { response.writeHead(404).end(); }
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
      const browser = await browserType.launch({ headless: true }); t.after(() => browser.close());
      const page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.voiceTracks = [];
        window.voiceFrames = 0; window.voicePeak = 0;
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          postMessage(value, ...rest) {
            if (value.type === 'audio') {
              window.voiceFrames++;
              for (const sample of new Float32Array(value.samples)) window.voicePeak = Math.max(window.voicePeak, Math.abs(sample));
            }
            return super.postMessage(value, ...rest);
          }
        };
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
          const context = new AudioContext(); const destination = context.createMediaStreamDestination();
          const silence = context.createConstantSource(); silence.offset.value = 0; silence.connect(destination); silence.start(); await context.resume();
          window.playFixture = async () => {
            const bytes = await (await fetch('/fixture.wav')).arrayBuffer();
            const source = context.createBufferSource(); source.buffer = await context.decodeAudioData(bytes); source.connect(destination); source.start();
          };
          for (const track of destination.stream.getTracks()) {
            const stop = track.stop.bind(track); track.stop = () => { stop(); silence.stop(); void context.close(); }; window.voiceTracks.push(track);
          }
          if (window.delayGrant) return new Promise(done => { window.releaseGrant = () => done(destination.stream); });
          return destination.stream;
        } } });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.evaluate(value => { window.chunk = value; }, chunk);
      await page.click('#start');
      await page.waitForFunction(() => window.events.some(event => event.type === 'standby') || window.events.some(event => event.type === 'error'), { timeout: 20000 });
      assert.ok(!await page.evaluate(() => window.events.some(event => event.type === 'error')), JSON.stringify(await page.evaluate(() => window.events)));
      await page.waitForTimeout(1200);
      assert.equal(await page.evaluate(() => window.events.filter(event => event.type === 'wake').length), 0);
      assert.equal(posts, 0);
      await page.evaluate(() => window.playFixture());
      await page.waitForFunction(() => window.events.some(event => event.type === 'wake'), null, { timeout: 20000 }).catch(async error => {
        t.diagnostic(JSON.stringify(await page.evaluate(() => ({ events: window.events, frames: window.voiceFrames, peak: window.voicePeak })))); throw error;
      });
      await page.waitForFunction(() => window.events.some(event => event.type === 'utterance'), { timeout: 20000 });
      assert.ok(await page.evaluate(() => window.events.find(event => event.type === 'utterance').bytes) > 44);
      assert.equal(posts, 0, 'the SDK does not upload ambient or utterance audio by itself');
      await page.evaluate(() => window.voice.dispose());
      assert.equal(await page.evaluate(() => window.voiceTracks.every(track => track.readyState === 'ended')), true);
      await page.evaluate(() => { window.delayGrant = true; void window.startVoice(window.chunk); });
      await page.waitForFunction(() => Boolean(window.releaseGrant));
      await page.evaluate(async () => { await window.voice.dispose(); window.releaseGrant(); });
      await page.waitForFunction(() => window.voiceTracks.every(track => track.readyState === 'ended'));
      for (const file of lock.files.filter(entry => !entry.name.includes('chunk-') || entry.name.includes(`chunk-${chunk === 160 ? 8 : 16}-`))) {
        assert.equal(requests.get(`/assets/${file.name}`), 1, `model cached: ${file.name}`);
      }
      assert.deepEqual(errors, []);
      t.diagnostic(JSON.stringify({ browser: name, chunk, fixtureSha256: createHash('sha256').update(await readFile(fixture)).digest('hex'), audioPosts: posts }));
    });
  }
}
