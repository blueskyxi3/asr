# Kubernetes 安装

使用 **Deployment，1 个副本**，配套 ClusterIP Service 和模型 PVC。`ASR_WORKERS=1`，仅加载一个常驻推理进程，不需要 GPU、数据库或 Redis。以下命令均在 ASR 仓库根目录执行。

清单不固定 namespace，示例使用项目现有的 `compute-power-zone`；可修改 `ASR_NAMESPACE` 安装到其他 namespace。

## 1. 准备镜像和存储

`deployment.yaml` 的 initContainer 和服务容器均使用：

```text
ctt-repository-cn-guangzhou.cr.volces.com/compute-power-zone/ai-hub-asr:0.2.0
```

安装前确保这个镜像已推送且集群可拉取；使用其他仓库时同时修改两处 `image`。需要自行构建时：

```bash
export ASR_IMAGE=ctt-repository-cn-guangzhou.cr.volces.com/compute-power-zone/ai-hub-asr:0.2.0
docker buildx build --platform linux/amd64,linux/arm64 -t "$ASR_IMAGE" --push .
```

构建上下文必须为 ASR 仓库根目录。私有镜像仓库需要在 Pod 的 `spec.template.spec.imagePullSecrets` 配置同 namespace 中已有的拉取凭据。

`pvc.yaml` 申请 2 GiB、`ReadWriteOnce` 模型存储，默认使用集群的默认 StorageClass。没有默认 StorageClass 时，先按集群情况填写 `storageClassName`；项目使用 `ebs-ssd` 的集群可取消对应注释。存储需支持 `fsGroup: 1000`，以便非 root 的模型准备容器写入。服务容器申请 2 CPU / 2 GiB，限制 4 CPU / 4 GiB，节点须有相应可用资源。

## 2. 创建 namespace 和密钥

```bash
export ASR_NAMESPACE=compute-power-zone
kubectl create namespace "$ASR_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# 首次安装生成两个独立密钥；已有部署应沿用现有值。
export ASR_API_KEY="$(openssl rand -hex 32)"
export ASR_HOST_SECRET="$(openssl rand -hex 32)"
kubectl -n "$ASR_NAMESPACE" create secret generic ai-hub-asr \
  --from-literal=ASR_API_KEY="$ASR_API_KEY" \
  --from-literal=ASR_HOST_SECRET="$ASR_HOST_SECRET" \
  --dry-run=client -o yaml | kubectl -n "$ASR_NAMESPACE" apply -f -
```

`ASR_API_KEY` 用于转写渠道认证，至少 32 字符；`ASR_HOST_SECRET` 用于 AI Hub 的 ASR external 模块配对，须与模块安装时提供的密钥一致。只使用转写接口时可不创建 `ASR_HOST_SECRET`。密钥不写入安装清单，应保存在现有密钥管理系统中。

## 3. 安装并等待就绪

```bash
kubectl -n "$ASR_NAMESPACE" apply -f k8s/pvc.yaml -f k8s/deployment.yaml
kubectl -n "$ASR_NAMESPACE" rollout status deployment/ai-hub-asr --timeout=90m
kubectl -n "$ASR_NAMESPACE" get deployment ai-hub-asr
kubectl -n "$ASR_NAMESPACE" get pods -l app.kubernetes.io/name=ai-hub-asr
```

验收时 Deployment 的 `READY` 应为 `1/1`，`UP-TO-DATE` 和 `AVAILABLE` 均为 `1`，Pod 为 `1/1 Running`。

首次启动的 `model-prepare` initContainer 会下载并校验 ASR、VAD 和浏览器唤醒模型，再启动 ASR。以后重建 Pod 时复用 PVC 中校验通过的模型。模型准备可写 `/models`，服务容器只读挂载；转写请求不触发下载。镜像中已包含浏览器 WASM。

集群需能访问 Hugging Face 和 npm 模型源；需要镜像源时，在安装前修改 initContainer 的 `ASR_MODEL_ORIGIN`（例如 `https://hf-mirror.com`）和 `ASR_KWS_MODEL_ORIGIN`（例如 `https://registry.npmmirror.com`）。两者用途不同，仍使用项目锁文件校验模型。离线环境需先将完整模型目录预置到 PVC：三个 ASR 文件、`voice/` 子目录及许可证；准备方式见 [ASR 说明](../README.md#模型来源与离线部署)。文件完整时 initContainer 校验并复用，不请求模型源，PVC 仍须可写以同步许可证和 VAD 文件。

排查初始化或启动问题：

```bash
kubectl -n "$ASR_NAMESPACE" get pvc ai-hub-asr-models
kubectl -n "$ASR_NAMESPACE" logs deployment/ai-hub-asr -c model-prepare
kubectl -n "$ASR_NAMESPACE" logs deployment/ai-hub-asr -c asr
kubectl -n "$ASR_NAMESPACE" describe pods -l app.kubernetes.io/name=ai-hub-asr
```

`startupProbe` 和 `readinessProbe` 使用 `/readyz`，模型加载完成后才接收 Service 流量；启动探针允许约 5 分钟加载时间，不包含 initContainer 的模型准备时间。`livenessProbe` 使用 `/healthz` 检查 HTTP 进程。

## 4. 验证接口并接入 AI Hub

本机开一个终端保持端口转发：

```bash
kubectl -n "$ASR_NAMESPACE" port-forward service/ai-hub-asr 18080:8000
```

另一个终端设置安装时使用的 `ASR_API_KEY`，验证健康和模型列表：

```bash
curl -f http://127.0.0.1:18080/readyz
curl -f http://127.0.0.1:18080/v1/models \
  -H "Authorization: Bearer $ASR_API_KEY"
```

转写验收使用 16 kHz、单声道、PCM16 的标准 WAV：

```bash
curl -f http://127.0.0.1:18080/v1/audio/transcriptions \
  -H "Authorization: Bearer $ASR_API_KEY" \
  -F model=sensevoice-small-int8 -F response_format=json \
  -F language=auto -F file=@recording.wav
```

AI Hub 与 ASR 在同一 namespace 时，OpenAI 兼容渠道的基础地址为 `http://ai-hub-asr:8000`，密钥为 `ASR_API_KEY`，模型为 `sensevoice-small-int8`；基础地址不加 `/v1`。跨 namespace 使用 `http://ai-hub-asr.<ASR_NAMESPACE>.svc.cluster.local:8000`，替换 namespace 和集群实际 DNS 后缀。主站位于集群外时，需另行配置可达入口；ClusterIP 和 Service DNS 仅供集群内访问。

启用浏览器语音控制时，参照 [模块接入说明](../README.md#ai-hub-模块接入)，将 `catalog.example.json` 的 `external_url` 改为主站可访问的上述 Service 地址，以 `external` 模式安装，配对密钥使用 `ASR_HOST_SECRET`。模型资料、分组和用户 Key 权限仍按现有 [集成步骤](../README.md#ai-hub-与-agent-集成) 配置。

## 更新和卸载

升级镜像时同步修改两个 `image`，重新应用 `k8s/deployment.yaml` 并等待 rollout。更新 Secret 后执行 `kubectl -n "$ASR_NAMESPACE" rollout restart deployment/ai-hub-asr`，使进程重新读取环境变量。保持 `replicas: 1`；`Recreate` 在升级时先停止旧 Pod 再创建新 Pod，期间服务暂时不可用。

卸载服务并保留模型 PVC 和 Secret：

```bash
kubectl -n "$ASR_NAMESPACE" delete -f k8s/deployment.yaml
```

确定不再使用模型缓存及密钥后，可分别删除：

```bash
kubectl -n "$ASR_NAMESPACE" delete -f k8s/pvc.yaml
kubectl -n "$ASR_NAMESPACE" delete secret ai-hub-asr
```

PVC 删除后底层数据是否保留取决于 StorageClass/PV 的回收策略。

相关 Kubernetes 行为见官方文档：[Deployment 更新策略](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#strategy)、[健康探针](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)、[卷权限](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/#configure-volume-permission-and-ownership-change-policy-for-pods)。
