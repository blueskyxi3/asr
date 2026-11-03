"""Build only KWS/VAD C exports from the pinned upstream source (no model weights)."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request

os.environ.setdefault('SOURCE_DATE_EPOCH', '1766188800')

cache = Path(os.environ.get('VOICE_BUILD_CACHE', '.cache')).resolve()
cache.mkdir(parents=True, exist_ok=True)
archive = cache / 'sherpa.tar.gz'
expected = 'b0374cc56dbc186d442ae73d5de743bb092470b640c4c50ce7b029044c0c4fa8'
if not archive.exists():
    urllib.request.urlretrieve('https://codeload.github.com/k2-fsa/sherpa-onnx/tar.gz/refs/tags/v1.13.8', archive)
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise RuntimeError('sherpa source integrity mismatch')
root = cache / 'source/sherpa-onnx-1.13.8'
if not (root / 'CMakeLists.txt').exists():
    with tarfile.open(archive) as source:
        source.extractall(cache / 'source', members=(m for m in source if m.isfile() or m.isdir()), filter='data')
exports = {'CopyHeap', 'malloc', 'free'}
for directory in ['kws', 'vad']:
    text = (root / f'wasm/{directory}/CMakeLists.txt').read_text()
    block = re.search(r'set\(exported_functions\s+(.*?)\n\)', text, re.S).group(1)
    exports.update(re.findall(r'^\s*(SherpaOnnx\w+)\s*$', block, re.M))
target = root / 'wasm/web'
(target / 'voice.cc').write_text('#include <cstring>\nextern "C" void CopyHeap(const void *from, int n, void *to) { std::memcpy(to, from, n); }\nint main() { return 0; }\n')
functions = json.dumps(['_' + name for name in sorted(exports)], separators=(',', ':'))
methods = json.dumps(['FS', 'stringToUTF8', 'setValue', 'getValue', 'lengthBytesUTF8', 'UTF8ToString', 'HEAPU8', 'HEAPF32'], separators=(',', ':'))
(target / 'CMakeLists.txt').write_text(f'''add_executable(voice-runtime voice.cc)
target_link_libraries(voice-runtime sherpa-onnx-c-api)
target_link_options(voice-runtime PRIVATE
  "-sMODULARIZE=1" "-sEXPORT_NAME=CreateVoiceRuntime" "-sENVIRONMENT=worker,node"
  "-sFORCE_FILESYSTEM=1" "-sINITIAL_MEMORY=67108864" "-sALLOW_MEMORY_GROWTH=1"
  "-sSTACK_SIZE=5242880" [=[-sEXPORTED_FUNCTIONS={functions}]=]
  [=[-sEXPORTED_RUNTIME_METHODS={methods}]=])
''')
build = cache / 'wasm-build'
flags = ['PYTHON', 'TESTS', 'CHECK', 'PORTAUDIO', 'JNI', 'TTS', 'WEBSOCKET', 'GPU', 'BINARY']
command = ['emcmake', 'cmake', '-S', str(root), '-B', str(build), '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
           '-DSHERPA_ONNX_ENABLE_C_API=ON', '-DSHERPA_ONNX_ENABLE_WASM=ON', '-DSHERPA_ONNX_ENABLE_WASM_WEB=ON',
           '-DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF']
command += [f'-DSHERPA_ONNX_ENABLE_{name}=OFF' for name in flags]
subprocess.run(command, check=True, env={**os.environ, 'SHERPA_ONNX_IS_USING_BUILD_WASM_SH': 'ON'})
subprocess.run(['cmake', '--build', str(build), '--target', 'voice-runtime', '-j3'], check=True)
output = Path(os.environ.get('VOICE_BUILD_OUT', 'browser-dist')).resolve()
output.mkdir(parents=True, exist_ok=True)
for suffix in ['js', 'wasm']:
    shutil.copyfile(build / f'bin/voice-runtime.{suffix}', output / f'voice-runtime.{suffix}')
for directory, function in [('kws', 'createKws'), ('vad', 'createVad')]:
    content = (root / f'wasm/{directory}/sherpa-onnx-{directory}.js').read_text()
    (output / f'sherpa-{directory}.js').write_text(f'(() => {{\n{content}\nself.{function} = {function};\n}})();\n')
shutil.copyfile(root / 'LICENSE', output / 'sherpa-LICENSE')
