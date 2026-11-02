# AI Hub ASR

完整独立的语音转文字子项目。使用 SenseVoiceSmall INT8、Silero VAD 和 sherpa-onnx，在 Linux amd64/arm64 CPU 上运行。支持普通话、粤语、英语、日语、韩语及自动识别；录音停止后返回整段文字。

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
ASR_API_KEY=your-random-service-token-at-least-32-characters npm start
```

独立构建镜像：

```bash
docker build -t ai-hub-asr:0.1.0 .
```

发布双架构镜像时，在已配置的目标仓库使用：

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t "$ASR_IMAGE_REPOSITORY:0.1.0" --push .
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

浏览器 Agent 前端直接访问主进程现有的 `/api/user/self/assistant/audio/transcriptions`。Go 校验当前用户、插件状态、语音开关、Key、渠道和限流，再以渠道服务 Token 调用本服务。转写结果回到浏览器草稿；用户发送后，文字才进入 Agent Node/Pi 会话。

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
