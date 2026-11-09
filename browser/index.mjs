import { encodeKeywords } from './keywords.mjs';
export { isDismiss } from './commands.mjs';

async function checkedFile(base, file, signal) {
  const url = `${base}/${file.name}?sha256=${file.sha256}`;
  let cache;
  try { cache = await caches.open('ai-hub-voice-models-v1'); } catch { /* Private browsing may disable model caching. */ }
  const cached = await cache?.match(url);
  const response = cached || await fetch(url, { credentials: 'include', signal });
  if (!response.ok) throw new Error('resource');
  const bytes = await response.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((n) => n.toString(16).padStart(2, '0')).join('');
  if (bytes.byteLength !== file.bytes || hash !== file.sha256) { await cache?.delete(url); throw new Error('integrity'); }
  if (!cached && cache) { try { await cache.put(url, new Response(bytes)); } catch { /* Quota exhaustion must not prevent local inference. */ } }
  return bytes;
}

export function createVoiceController({ assetBase, settings, onEvent }) {
  const lifetime = new AbortController();
  let worker, media, context, node, source, ready = false, pending = 0, generation = 0, disposed = false;
  const emit = (event) => { if (!disposed) onEvent(event); };
  const controller = {
    async start() {
      if (disposed || worker) return;
      const version = ++generation;
      let stage = 'browser', loadingTimer;
      try {
        if (!globalThis.isSecureContext) throw new Error('insecure');
        if (!globalThis.crypto?.subtle || !navigator.mediaDevices?.getUserMedia) throw new Error('engine');
        loadingTimer = setTimeout(() => lifetime.abort(new Error('timeout')), 120000);
        stage = 'capabilities';
        emit({ type: 'loading' });
        const response = await fetch(`${assetBase}/../api/v1/voice/capabilities`, { credentials: 'include', signal: lifetime.signal });
        if (!response.ok) throw new Error('resource');
        const manifest = await response.json();
        if (!manifest.ready || manifest.protocol_version !== 1) throw new Error('resource');
        const chunk = settings.wake_chunk_ms === 320 ? 16 : 8;
        stage = 'resources';
        const needed = manifest.files.filter((file) => !/chunk-/.test(file.name) || file.name.includes(`chunk-${chunk}-`));
        const total = needed.reduce((sum, file) => sum + file.bytes, 0); let loaded = 0;
        emit({ type: 'loading', loaded, total });
        const files = await Promise.all(needed.map(async (file) => {
          const bytes = await checkedFile(assetBase, file, lifetime.signal);
          loaded += bytes.byteLength; emit({ type: 'loading', loaded, total });
          return { name: file.name, bytes };
        }));
        clearTimeout(loadingTimer);
        if (disposed || version !== generation) return;
        const text = (name) => new TextDecoder().decode(files.find((file) => file.name === name).bytes);
        stage = 'keywords';
        const keywords = encodeKeywords(settings.wake_words, text('tokens.txt'), text('en.phone'));
        stage = 'worker';
        worker = new Worker(`${assetBase}/voice-worker.js`);
        const started = new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => {
            if (data.type === 'ready') { ready = true; resolve(); }
            else if (data.type === 'ack') pending--;
            else if (data.type === 'error') { reject(new Error(data.code)); emit(data); controller.dispose(); }
            else emit(data);
          };
          worker.onerror = () => { reject(new Error('engine')); emit({ type: 'error', code: 'engine' }); controller.dispose(); };
        });
        const wasm = files.find((file) => file.name === 'voice-runtime.wasm').bytes;
        worker.postMessage({ type: 'init', settings, assetBase, keywords, wasm,
          files: files.filter((file) => file.name !== 'voice-runtime.wasm') }, files.map((file) => file.bytes));
        let timer;
        try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('engine_timeout')), 60000); })]); }
        finally { clearTimeout(timer); }
        if (disposed || version !== generation) return;
        emit({ type: 'requesting' });
        stage = 'microphone';
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        if (disposed || version !== generation) { stream.getTracks().forEach((track) => track.stop()); return; }
        media = stream;
        stage = 'audio';
        try { context = new AudioContext({ sampleRate: 16000 }); } catch { context = new AudioContext(); }
        await context.resume();
        await context.audioWorklet.addModule(`${assetBase}/voice-capture.js`);
        if (disposed || version !== generation) return;
        source = context.createMediaStreamSource(media);
        node = new AudioWorkletNode(context, 'voice-capture');
        node.port.onmessage = ({ data }) => {
          if (!ready || disposed) return;
          if (++pending > 64) { emit({ type: 'error', code: 'overloaded' }); controller.dispose(); return; }
          worker.postMessage({ type: 'audio', samples: data.buffer }, [data.buffer]);
        };
        for (const track of media.getTracks()) track.addEventListener('ended', () => { if (!disposed) { emit({ type: 'error', code: 'microphone' }); controller.dispose(); } });
        source.connect(node); node.connect(context.destination); emit({ type: 'standby' });
      } catch (error) {
        const code = error?.name === 'NotAllowedError' ? 'permission' : error?.message === 'insecure' ? 'insecure' :
          lifetime.signal.reason?.message === 'timeout' ? 'timeout' : 'engine';
        emit({ type: 'error', code, stage }); await controller.dispose();
      } finally { clearTimeout(loadingTimer); }
    },
    mode(mode) { if (ready && !disposed) worker.postMessage({ type: 'mode', mode }); },
    async dispose() {
      if (disposed) return;
      disposed = true; generation++; lifetime.abort(); ready = false; worker?.terminate();
      media?.getTracks().forEach((track) => track.stop()); node?.disconnect(); source?.disconnect();
      if (context && context.state !== 'closed') await context.close();
    },
  };
  return controller;
}
