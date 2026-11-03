# NOTICE

This package redistributes a subset of the **sherpa-onnx KWS zipformer zh-en 3M** model,
release `kws-models`, version `2025-12-20`.

- Upstream: https://github.com/k2-fsa/sherpa-onnx
- Release archive: https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2
- License: Apache License 2.0, see [LICENSE](LICENSE)

## What was changed

Nothing in the files themselves. They are byte-for-byte copies from the release archive.

The archive ships more than the runtime needs. This package carries only the files the
dsh-orb spotter opens:

| File | Used for |
|---|---|
| `tokens.txt` | keyword token table |
| `en.phone` | English phone table, for writing a new wake word into tokens |
| `encoder-epoch-13-avg-2-chunk-{8,16}-left-64.int8.onnx` | encoder, both chunk sizes |
| `decoder-epoch-13-avg-2-chunk-{8,16}-left-64.onnx` | decoder, both chunk sizes |
| `joiner-epoch-13-avg-2-chunk-{8,16}-left-64.int8.onnx` | joiner, both chunk sizes |

Omitted because they are never loaded: the fp32 encoders (about 12 MB each), the fp32
joiners, and `test_wavs/`. Dropping them takes the payload from about 38 MB to about 14 MB.

## Who consumes this

Only the [dsh-orb](https://www.npmjs.com/package/dsh-orb) plugin. It downloads this tarball
from the npm registry, checks the sha256 pinned in its own source, and unpacks `kws/` into
its voice model directory. This package is not a library and has no entry point.
