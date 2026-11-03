# Third-party sources

License snapshots retrieved on 2026-11-01. Model weights retain their own
license; sherpa-onnx's software license does not replace the model license.

- FunASR-MODEL_LICENSE: https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE (Git blob d5cc52aad23a88da10b8cffbd9b56d43ac7398fa)
- Silero-LICENSE: https://github.com/snakers4/silero-vad/blob/master/LICENSE (Git blob 0bf5e90cac691b999d4a35044f97167d7bbbf0b9)
- sherpa-onnx-LICENSE: https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE (Git blob d645695673349e3947e8e5ae42332d0ac3164cd7)
- DeepSeek-Harness-LICENSE: https://github.com/deepseek-ai/deepseek-harness/blob/main/LICENSE (Git blob c1f7a78e89e4e4dc7b86664c3b3c76eb5eee1785)

The inference and asset preparation design follows DeepSeek Harness's MIT-licensed
experimental speech provider. Its license is retained as DeepSeek-Harness-LICENSE.
SenseVoiceSmall originates from FunAudioLLM/SenseVoiceSmall; the ONNX conversion
is distributed by csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.
Silero VAD originates from snakers4/silero-vad. Exact model revisions and hashes
are recorded in models.lock.json. npm dependencies retain their packaged licenses.

## Browser voice control (2026-11-02)

- KWS-LICENSE and KWS-NOTICE.md are unmodified snapshots from `dsh-orb-kws@2026.10.0` (Apache-2.0). The upstream model is `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`, distributed at https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models . The npm package redistributes byte-identical selected model files; its archive and every retained file are pinned in `voice-assets.lock.json`. Its original NOTICE refers to the original package layout.
- The browser runtime and JavaScript KWS/VAD wrappers are built from https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8 (Apache-2.0), with source archive SHA-256 and output hashes in `voice-assets.lock.json`. `Dockerfile.wasm` pins the Emscripten compiler image; the runtime is built here rather than copied from the reference plugin.
- pinyin-pro-LICENSE is from the `pinyin-pro@3.27.0` npm package (MIT, copyright zh-lx); upstream https://github.com/zh-lx/pinyin-pro . The npm lockfile pins the exact package and integrity.
- Browser Silero VAD uses the same MIT-licensed, hash-verified file as server inference. Wake models are downloaded from npm by default, independently of the Hugging Face origins used for SenseVoice and Silero.
