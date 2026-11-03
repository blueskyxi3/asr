# AI Hub ASR

完整独立的语音转文字与浏览器语音控制子项目。使用 SenseVoiceSmall INT8、Silero VAD 和 sherpa-onnx，在 Linux amd64/arm64 CPU 上运行。支持普通话、粤语、英语、日语、韩语及自动识别；录音停止后返回整段文字。0.2.0 增加浏览器本地 KWS 唤醒、VAD 分段与退出口令匹配 SDK。

此目录可独立复制、安装、构建、测试和部署，不依赖 AI Hub、Agent SDK、数据库或 Redis。模型在常驻子进程中运行，HTTP 主进程负责认证、输入校验、排队及取消。源码与 Agent 的 npm workspaces、process 安装包相互独立。

## Docker Compose 启动

以下命令均在 `asr/` 目录执行。

1. `cp .env.example .env`，使用 `openssl rand -hex 32` 生成服务 Token 并填入 `.env` 的 `ASR_API_KEY`。该 Token 只用于主进程到 ASR 的渠道认证，不复用用户 Key 或 Agent 插件配对密钥。
2. 构建和显式准备模型：

   ```bash
   docker compose build
   docker compose run --rm model-prepare
   docker compose up -d asr
   docker compose ps
   ```

3. 默认只开放容器网络内的 8000 端口。将 AI Hub 容器接入这个 Compose 项目的网络后，渠道基础地址为 `http://asr:8000`。可在 `docker network ls` 中找到本项目的网络，再用 `docker network connect 网络名 主站容器名` 连接已有主站容器。

本机独立调用可使用专门的本地覆盖文件，仅映射到回环地址：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d asr
curl -f http://127.0.0.1:18080/readyz
```

模型准备容器可写模型卷；运行容器以非 root 身份只读挂载该卷。转写请求不下载模型。文件缺失或校验失败时，`/healthz` 仍报告进程存活，`/readyz` 和转写返回 503；显式准备后重启服务。

## 独立 Node 运行

要求 Node.js 22+。原生包支持 Linux glibc amd64/arm64，macOS 可用于开发联调。

```bash
npm ci
npm run typecheck
npm run build
npm run prepare-models
# 可选：准备浏览器语音资源（Docker 镜像构建已经包含 WASM）
npm run build:wasm
npm run prepare-voice
ASR_API_KEY=your-random-service-token-at-least-32-characters npm start
```

独立构建镜像：

```bash
docker build -t ai-hub-asr:0.2.0 .
```

发布双架构镜像时，在已配置的目标仓库使用：

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t "$ASR_IMAGE_REPOSITORY:0.2.0" --push .
```

构建上下文仅为当前目录，目标平台依赖在对应镜像内安装，不复制宿主机的 `node_modules`。

## 模型来源与离线部署

`models.lock.json` 固定以下文件的上游修订、字节数、SHA-256 和许可证来源：

| 文件 | 大小 | 用途 |
| --- | ---: | --- |
| `model.int8.onnx` | 239,233,841 B | SenseVoiceSmall INT8 权重 |
| `tokens.txt` | 315,894 B | 配套词表 |
| `silero_vad.onnx` | 1,807,522 B | 人声检测与分段 |

默认从 Hugging Face 下载。`ASR_MODEL_ORIGIN=https://hf-mirror.com` 或私有兼容源可以显式替换源站，仍使用锁定路径和校验值，不自动回退到其他源。下载到唯一 `.part` 文件，校验后原子发布；取消和失败清理未完成文件，已校验缓存继续复用。

离线部署可先在联网机器准备好模型，再将三个文件复制到同一目录，并设置 `ASR_MODEL_DIR` 或挂载到 `/models`。启动会重新校验文件，正常识别无需网络。显式准备命令还会把许可证快照复制到模型目录中的 `licenses/`。

SenseVoice 权重使用自定义 FunASR 模型许可证，Silero 使用 MIT，sherpa-onnx 软件使用 Apache-2.0。完整快照及来源保留在 `licenses/`；推理框架许可证不替代模型许可证。实现参考 DeepSeek Harness 的 MIT 语音插件设计，保留其许可声明。

## HTTP API

业务接口要求 `Authorization: Bearer <ASR_API_KEY>`。健康检查不要求 Token，仅用于内网监控。

| 接口 | 返回 |
| --- | --- |
| `GET /healthz` | `{"status":"ok"}` |
| `GET /readyz` | `{"ready":true}`；模型未就绪时 HTTP 503 |
| `GET /v1/models` | OpenAI 兼容模型列表，ID 为 `sensevoice-small-int8` |
| `POST /v1/audio/transcriptions` | `{"text":"识别文字"}` |

转写为 multipart，接受一个 `file`、必填 `model`、可选 `language` 和 `response_format=json`。语言为 `auto/zh/en/yue/ja/ko`，缺省 `auto`。只接受标准 44 字节头部的 16 kHz 单声道 PCM16 WAV；浏览器插件负责统一转换。静音返回空字符串。首版不接受压缩音频文件、流式转写、时间戳或翻译请求。

```bash
export ASR_API_KEY=your-random-service-token-at-least-32-characters
curl -f http://127.0.0.1:18080/v1/models \
  -H "Authorization: Bearer $ASR_API_KEY"
curl -f http://127.0.0.1:18080/v1/audio/transcriptions \
  -H "Authorization: Bearer $ASR_API_KEY" \
  -F model=sensevoice-small-int8 -F response_format=json \
  -F language=auto -F file=@recording.wav
```

错误结构为 `{"error":{"message":"...","type":"asr_error","code":"..."}}`。认证失败 401；参数无效 400；非规范 WAV 415；音频超限 413；队列满/排队超时 429；模型未就绪或工作进程失败 503；推理超时 504。前端不自动重试或更换渠道。

## 配置与资源

| 环境变量 | 默认值 |
| --- | --- |
| `ASR_API_KEY` | 必填，至少 32 字符 |
| `ASR_HOST` / `ASR_PORT` | `0.0.0.0` / `8000` |
| `ASR_MODEL_DIR` | Node 运行时为 `./models`，镜像内为 `/models` |
| `ASR_THREADS` | 每个模型工作进程 2 个 CPU 线程 |
| `ASR_WORKERS` | 1；增加会独立加载更多模型并增加内存 |
| `ASR_MAX_QUEUE` | 4 个等待任务，不含运行任务 |
| `ASR_QUEUE_TIMEOUT_MS` | 10000 |
| `ASR_INFERENCE_TIMEOUT_MS` | 120000 |
| `ASR_STARTUP_TIMEOUT_MS` | 60000 |
| `ASR_MAX_AUDIO_BYTES` | 4194304，允许调低 |
| `ASR_MAX_DURATION_SECONDS` | 120，允许调低 |
| `ASR_MODEL_ORIGIN` | 准备命令默认使用锁文件源站 |

HTTP 上传/连接超时 150 秒。FIFO 有界队列不使用数据库；排队取消直接移除，执行取消会终止对应模型进程并重新加载，其他工作进程不受影响。SIGTERM/SIGINT 停止接收任务并回收子进程。

录音只在内存中处理，不保存录音或转写历史。日志记录请求 ID、音频时长、排队时间、推理耗时和错误码，不记录 Token、音频内容或转写正文。

## AI Hub 与 Agent 集成

浏览器 Agent 前端直接访问主进程现有的 `/api/user/self/assistant/audio/transcriptions`。Go 校验当前用户、插件状态、语音开关、Key、渠道和限流，再以渠道服务 Token 调用本服务。手动录音的结果回到浏览器草稿，由用户确认发送；主动开启连续语音对话后，停顿会触发自动发送。转写本身不创建 Agent Node/Pi 会话轮次。

管理员配置：

1. 建立 OpenAI 兼容渠道，基础地址使用服务地址，密钥使用 `ASR_API_KEY`，模型为 `sensevoice-small-int8`。不要把 `/v1` 再加到基础地址。
2. 在现有模型资料中登记对应模型，输入模态 `audio`、输出模态 `text`；价格示例设为零。仅发现 `/v1/models` 不会自动补齐平台模型资料。
3. 授予用户所在分组及其自建 Key 访问该渠道/模型的权限。
4. 用户在个人设置选择该转写模型并开启语音输入。已有转写选择字段直接复用，无数据库结构变更。

AI Hub 使用现有渠道绑定，失败不自动上传其他供应商。ASR 不接收用户 Cookie、个人 Key 或聊天历史；Agent 停用不会终止独立 ASR 服务，ASR 故障也不阻断普通文本聊天。

完整交互与验收记录见主仓库 `.req/agent/asr-integration.md`。

## 测试与性能

```bash
npm test
ASR_MODEL_DIR=/absolute/model-directory npm run test:model
ASR_MODEL_DIR=/absolute/model-directory ASR_TEST_AUDIO=/absolute/speech.wav \
  ASR_TEST_EXPECTED='expected phrase' npm run test:model
```

`npm test` 覆盖协议、真实 HTTP 断连取消、格式/限额、队列与推理截止时间、资源回收、模型校验和原子下载。测试模型准备需要允许监听本机临时端口。

`test:model` 在未设置模型目录时明确跳过；设置后实际加载原生模型、识别静音、可选真实语音，并验证原生子进程遭到 SIGKILL、运行任务被取消后的重载。

性能语料格式：

```json
[{"file":"speech-30s.wav","reference":"正确转写文字","language":"zh"}]
```

```bash
ASR_API_KEY=your-service-token ASR_URL=http://127.0.0.1:18080 \
  npm run benchmark -- samples.json
```

基准默认预热一次后重复 20 次，输出 CER、英语 WER、p50/p95 及端到端 RTF。CER 仅移除大小写、标点与空白差异，不把汉字数字和阿拉伯数字自动视为相同。首次请求时长不等同于模型冷启动时长。使用固定 4 vCPU/4 GiB、无排队、30 秒清晰音频验收 p95 ≤ 5 秒，并单独记录容器峰值内存。跨架构模拟结果只用于功能验证，不能替代目标原生硬件的性能数据。

仓库内 `tests/container-smoke.mjs` 可挂载到运行镜像的 `/app/tests/`，配合只读 `/models`、`/samples`（含 `zh.wav`、`samples.json` 和样本）在 `--network none` 环境验证真实 HTTP、模型推理及性能。

## 浏览器本地唤醒与自动语音对话（0.2.0）

浏览器 SDK 和 ASR HTTP 服务属于同一独立子项目，但推理位置不同：

| 环节 | 模型 / 方法 | 运行位置与来源 |
| --- | --- | --- |
| 唤醒 | `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`，INT8 encoder/joiner + FP32 decoder | 浏览器 Worker；与 dsh-orb 0.2.0 相同的模型文件 |
| 语音分段 | Silero VAD | 浏览器 Worker；复用已锁定的 Silero 权重 |
| 停顿判定 | VAD + 音频采样时间计数 | 浏览器；默认 1200ms，可配 600–3000ms |
| 转写 | SenseVoiceSmall INT8 | 独立 ASR 进程；现有 Hugging Face 固定修订 |
| 退出口令 | 文字标准化与无声调拼音匹配 | 浏览器；不需要另一个模型 |

唤醒模型上游是 sherpa 的 [GitHub Release](https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2)。准备脚本下载作者保留原始权重的 `dsh-orb-kws@2026.10.0` npm 包，并同时检查压缩包与每个文件的大小、SHA-256；这部分不是 Hugging Face 下载。准确来源见 `voice-assets.lock.json` 和 `licenses/KWS-NOTICE.md`。可用 `ASR_KWS_MODEL_ORIGIN=https://registry.npmmirror.com` 替换 npm origin，保持包路径和哈希不变。SenseVoice/Silero 的 `ASR_MODEL_ORIGIN` 单独配置，不能拿它替换 npm 模型源。

160ms 使用 chunk-8，320ms 使用 chunk-16，分别加载对应权重。判定粒度与“停顿多久后回复”是两个独立参数。中文唤醒词转换为模型支持的带调拼音，英文使用 `en.phone`，支持的词不需要重新训练。无法编码的唤醒词会使引擎初始化失败，应改用词表支持的词。

### 构建和准备

Dockerfile 使用固定 Emscripten 4.0.23 镜像及 sherpa 1.13.8 源码构建只导出 KWS/VAD 的单线程 SIMD WASM，不需要主站开启 COOP/COEP。编译器构建阶段运行于 Linux amd64，ARM 构建机需要 Docker 的 amd64 模拟能力；生成的 WASM 在两种 ASR 镜像架构之间复用。模型权重保持在只读模型卷中，不打入镜像。

```bash
# 独立 Node 开发；首次构建 WASM 需要 Docker 和联网下载构建依赖
npm ci
npm run build:wasm
npm run build
npm run prepare-models
npm run prepare-voice

# Compose：镜像构建包含 WASM，model-prepare 同时准备 ASR 与唤醒模型
# 已有 .env 时只更新 ASR_VERSION=0.2.0，保留 ASR_API_KEY
docker compose build
docker compose run --rm model-prepare
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d asr
```

离线机器预置完整模型目录（原有三文件和 `voice/` 子目录），并加载已构建镜像；`prepare-voice` 对完整预置文件只做校验和复用，不请求模型源。浏览器从 ASR 模块的同源代理地址获取 WASM/权重，校验后缓存模型；等待唤醒时不上传音频，麦克风只在用户主动点击监听后打开。单个分段最长 30 秒，短暂停顿继续合并，单轮最长 120 秒。

### AI Hub 模块接入

1. 生成独立配对密钥填入 ASR `.env` 的 `ASR_HOST_SECRET`，与 `ASR_API_KEY` 分开，重建或重启 ASR。
2. 更新主进程后，参考 `catalog.example.json` 登记模块 `asr`，SDK v2，扩展点 `assistant.voice.control`，以 `external` 模式安装到运行中的 ASR 地址。主进程在宿主机时使用 `http://127.0.0.1:18080`，容器网络内使用 `http://asr:8000`。示例 `secret_env` 需要 Go 进程的同名环境变量；也可通过现有插件安装流程提供配对密钥。
3. 升级 Agent 前端插件至包含语音对话界面的版本，在“系统设置 → 应用设置 → 模块化设置 → 语音唤醒与退出”保存管理员配置。总开关默认关闭。
4. 用户在个人设置开启助手及语音输入、选择转写渠道；在助手输入区主动点击“开启语音对话”。页面隐藏即停止，重新显示后需要再次点击。手动录音与连续监听互斥。

新接口为 `GET /v1/voice/capabilities`（服务 Bearer Token）；可选模块适配层提供 `GET /internal/manifest`、`POST /internal/voice/capabilities`、`GET /api/v1/voice/capabilities` 和受保护的 `/assets/:file`。内部接口验证配对密钥，浏览器代理验证绑定用户、方法、URI 和有效期的宿主签名；不使用用户 Cookie 访问 ASR。资源白名单不允许读取任意文件。

主进程的 `GET /api/user/self/assistant/voice-control` 返回无密钥的配置、版本及资源地址。`ASR_API_KEY` 仍只在 ASR 环境和渠道密钥中配置，主进程 `config.yaml` 不需要这个变量。禁用或卸载 external 模块只关闭语音扩展访问，Docker ASR 继续独立运行。

唤醒后，VAD 确认语音结束，再按最后语音采样点计时。停顿达到阈值才通过现有 Go 转写入口上传标准 WAV；退出口令优先，普通文字自动走现有 Agent 聊天入口。已有草稿、附件或识别期间草稿版本变化时，结果保留供明确插入；不会自动合并发送。识别失败保留当前录音于内存，只有点击重试才重新请求；停止监听会释放。回复与 TTS 期间暂停听写，结束后继续。回复语仅在个人语音输出开启时调用既有 TTS 渠道。

### 验证

```bash
npm test
npm run typecheck
# 真实浏览器测试；先准备模型和 WASM，并提供上游公开测试 wav
ASR_MODEL_DIR=/path/to/models \
ASR_KWS_TEST_AUDIO=/path/to/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/test_wavs/zh_3.wav \
npm run test:browser
```

公开测试 wav 来自上游完整发行包：压缩包 SHA-256 `68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6`，`zh_3.wav` SHA-256 `710e79fb3450042be50bb2f6432a2a549b53577aea041a577e53a926fcabb614`。测试配置唤醒词为该样本中的“法国”，覆盖 Chromium/Firefox/WebKit × 160/320ms、真实 AudioWorklet/KWS/VAD、待唤醒无音频上传、缓存复用及迟到授权释放。这验证功能链路，不代表任意自定义唤醒词在真实噪声环境的识别率。

2026-11-02 验证：13 项协议/单元测试、1 项真实原生模型生命周期测试、6 项真实浏览器模型测试全部通过。0.2.0 的 Linux amd64/arm64 镜像均已在断网容器中加载模型并识别公开样本。本机浏览器经 Go 插件代理和现有转写渠道的完整链路已通过，聊天响应使用测试 SSE；目标设备的真实麦克风、Safari/Edge 和声学回声仍需实机验收。详细命令、环境与性能记录保存在主仓库 `.req/agent/asr-integration.md`。
