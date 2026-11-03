import { TurnBuffer, wave } from './turn-buffer.mjs';

let runtime, spotter, stream, vad, turn, settings, mode = 'paused', lastWake = -Infinity, wasSpeech = false, activityFrames = 0;
const send = (event, transfer = []) => self.postMessage(event, transfer);
function reset(next) { mode = next; turn?.reset(); vad?.reset(); if (spotter && stream) spotter.reset(stream); wasSpeech = false; activityFrames = 0; }
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      settings = data.settings;
      importScripts(`${data.assetBase}/voice-runtime.js`, `${data.assetBase}/sherpa-kws.js`, `${data.assetBase}/sherpa-vad.js`);
      runtime = await self.CreateVoiceRuntime({ wasmBinary: data.wasm, noInitialRun: true, print: () => {}, printErr: () => {} });
      for (const file of data.files) runtime.FS.writeFile(file.name, new Uint8Array(file.bytes));
      const chunk = settings.wake_chunk_ms === 320 ? 16 : 8;
      const model = (part, int8) => `${part}-epoch-13-avg-2-chunk-${chunk}-left-64${int8 ? '.int8' : ''}.onnx`;
      spotter = self.createKws(runtime, {
        featConfig: { samplingRate: 16000, featureDim: 80 },
        modelConfig: { transducer: { encoder: model('encoder', true), decoder: model('decoder', false), joiner: model('joiner', true) },
          tokens: 'tokens.txt', numThreads: 1, debug: 0, provider: 'cpu', modelType: '', modelingUnit: '', bpeVocab: '' },
        maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: settings.wake_score, keywordsThreshold: settings.wake_threshold,
        keywords: '', keywordsBuf: data.keywords, keywordsBufSize: new TextEncoder().encode(data.keywords).length,
      });
      stream = spotter.createStream();
      vad = self.createVad(runtime, { sileroVad: { model: 'silero_vad.onnx', threshold: 0.5,
        minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 30, windowSize: 512 },
        sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 32 });
      turn = new TurnBuffer(settings.pause_ms); reset('standby'); send({ type: 'ready' });
    } else if (data.type === 'mode') reset(data.mode);
    else if (data.type === 'audio') {
      const samples = new Float32Array(data.samples);
      if (mode === 'standby') {
        stream.acceptWaveform(16000, samples);
        while (spotter.isReady(stream)) {
          spotter.decode(stream);
          if (spotter.getResult(stream).keyword) {
            spotter.reset(stream);
            if (performance.now() - lastWake >= settings.wake_cooldown_ms) {
              lastWake = performance.now(); reset('listen'); send({ type: 'wake' }); break;
            }
          }
        }
      } else if (mode === 'listen') {
        vad.acceptWaveform(samples);
        const speaking = vad.isDetected();
        if (speaking && (!wasSpeech || ++activityFrames >= 31)) { send({ type: 'speech' }); activityFrames = 0; }
        const ended = !vad.isEmpty();
        while (!vad.isEmpty()) vad.pop();
        const audio = turn.push(samples, speaking);
        if (ended && !speaking) turn.ended(8000);
        wasSpeech = speaking;
        if (audio) { reset('paused'); const bytes = wave(audio); send({ type: 'utterance', audio: bytes.buffer }, [bytes.buffer]); }
      }
      send({ type: 'ack' });
    }
  } catch { reset('paused'); send({ type: 'error', code: 'engine' }); }
};
