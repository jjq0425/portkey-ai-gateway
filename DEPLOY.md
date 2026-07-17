# Portkey AI Gateway 部署文档（DEPLOY）

> ⚠️ **IP 地址约定（重要，部署前必读）**
>
> 本文档及项目代码中**统一以 `8.152.192.7` 代指实际服务器 IP 地址**。
> **在真正部署到目标服务器之前，请将本文档及所有相关代码/配置中的 `8.152.192.7` 全局替换为真实服务器 IP。**
> 端口因场景不同而不同（网关默认 `18788`、clawAVC 默认 `15100`），部署时请一并按真实环境核对。
>
> 需要全局替换的关键占位（示例）：
> - 网关访问地址：`http://8.152.192.7:18788`

---

## 1. 概述

Portkey AI Gateway 是一个高性能 AI 网关，提供统一的 OpenAI 兼容接口，将多家大模型（商汤 senseNova、字节豆包、龙猫 LongCat、讯飞星火等）聚合为统一的 `/v1` 接口，并内置 **IR 主动拦截** 能力（见第 7 节）。

- 项目名：`@portkey-ai/gateway`（v1.15.2）
- 运行方式：Node.js 20（推荐）直接运行，或 Docker 容器运行
- 默认服务端口：`18788`（Node 运行；可用 `--port=` 覆盖；Docker 场景见第 5 节说明）
- 默认访问地址（占位 IP）：`http://8.152.192.7:18788`
- 主动拦截依赖的 clawAVC 服务（占位 IP）：`http://8.152.192.7:15100`

---

## 2. 环境要求

- 操作系统：Linux（CentOS / Ubuntu 等）
- Node.js：`>= 20`（构建与运行均依赖 Node 20，Docker 镜像基于 `node:20-alpine`）
- npm：`>= 10.9.2`（Dockerfile 内会升级到该版本）
- 如使用 Docker 部署：Docker `>= 20` 及 `docker-compose` 或 Kubernetes
- 主动拦截功能需额外部署 **clawAVC** 服务（默认 `http://8.152.192.7:15100`）

---

## 3. 交付物（打包内容）说明

打包时**已排除**以下内容，请勿在部署包中依赖它们：

- `.portkey/local-gateway.config.json`（本地网关密钥/模型配置，含apikey敏感信息，不交接）
- `logs/` 目录（运行日志，部署时自动生成）

部署包内其余内容均完整包含，包括：

- `node_modules/`：生产依赖（已随包提供，无需重新安装）
- `src/`：含主动拦截中间件 `src/middlewares/irIntercept.ts`
- `config/`、`plugins/`、`Dockerfile`、`docker-compose.yaml`、`deployment.yaml`、`conf.json` 等

> 注意：`.portkey/local-gateway.config.json` 与 `config/local-gateway.config.json` 内含 `gatewayKeys` 及各模型 `providerApiKey`，属敏感凭据，**不随公开部署包分发**，请通过安全渠道单独提供，并在部署时放置到对应路径。

---

## 4. 部署方式一：Node.js 直接运行（推荐）

### 4.1 前置准备

将部署包解压到服务器目录，例如 `/opt/portkey-ai-gateway`：

```bash
# 在服务器上执行（将 8.152.192.7 替换为你真实的服务器 IP 进行 scp/rsync）
mkdir -p /opt/portkey-ai-gateway
scp portkey-ai-gateway.zip user@8.152.192.7:/opt/
ssh user@8.152.192.7 "cd /opt && unzip portkey-ai-gateway.zip"
```

### 4.2 放置网关配置文件

自行配置 `local-gateway.config.json` 放到 `.portkey/` 目录下：
`.portkey/local-gateway.config.json`

.portkey/目录中有一份参考配置文件 ，可参考该文件进行配置。




### 4.4 启动服务

```bash
cd portkey-ai-gateway
# 使用 npm 脚本
npm run dev:node
```

启动成功后控制台输出：

```
🚀 Your AI Gateway is running at:
   http://localhost:18788
✨ Ready for connections!
```



---

## 7. 主动拦截功能（IR Intercept）说明

> 核心文件：`src/middlewares/irIntercept.ts`
> 该模块在 **AI 网关层** 提供对 LLM 工具调用（tool_calls / tool_use）的**主动拦截**能力，
> 是本项目区别于上游 Portkey 官方网关的关键定制能力。

### 7.1 功能定位

网关在把上游 LLM 的响应返回给下游 Agent 之前，**按轮次（round）** 对照 clawAVC 下发的 **IR（意图/工具规则）白名单**，对 LLM 返回的工具调用做安全校验：

- 命中白名单 → 原样放行；
- 未命中白名单 → 主动拦截，阻止 Agent 执行违规工具，并引导其改用白名单内工具。

拦截仅在**响应包含 tool_calls** 时介入，不阻塞普通对话。

### 7.2 依赖的 clawAVC 服务

| 项 | 说明 |
| --- | --- |
| 服务地址 | 默认 `http://8.152.192.7:15100`，由环境变量 `CLAWAVC_BASE_URL` 控制（**部署时改为真实地址**） |
| 总开关 | `GET {CLAWAVC_BASE_URL}/api/config/intercept_non_ir_tools`（返回 `enabled`，网关侧缓存 10s） |
| 事件上报 | `POST {CLAWAVC_BASE_URL}/api/intercept/events`（拦截事件异步上报，失败仅打日志，不影响主链路） |
| IR 下发 | clawAVC 通过 webhook（`round_ir_ready` / `round_start` / `round_end`）将本轮 IR 推送给网关并缓存（TTL 5 分钟，等待超时默认 30s，超时不阻塞） |

> **开关关闭时本中间件直接 no-op（放行）**，流式与非流式路径均立即放行，因此 clawAVC 不可用时不影响网关正常服务。

### 7.3 拦截流程

**非流式（stream:false）**
1. LLM 返回非流式 JSON，若含 tool_calls 则按轮次向 clawAVC 查询该轮 IR（同一轮共享一份 IR，命中缓存）。
2. 对每个 tool_call：不在白名单的工具，OpenAI 形态清空 tool_calls 并在 content 追加“建议使用白名单工具”的提示；Anthropic 形态将 tool_use block 替换为 text block。
3. 命中白名单的 tool_call 原样返回。
4. 额外带 **Loop-Breaker（死循环熔断）**：同轮内对同一 `(工具, 参数)` 反复调用超过阈值（默认 3 次）时，直接熔断，要求 Agent 用自然语言直接作答。

**流式（stream:true）**
1. 把整段 SSE 流 buffer 后聚合为完整 JSON 做白名单判定（确定性优先，首字延迟略有增加）。
2. 未命中白名单时：
   - **方案 A（网关代发）**：通过网关自身的 `tryPost` 用同一 provider 再发一次非流式请求，在 messages 末尾追加“上一轮被拒工具 + 拒绝结果”，引导 LLM 改用白名单工具；最多 3 轮；成功后用 `rebuildXxxStreamFromJson` 重新构造 SSE 流返回 —— **对下游 Agent 完全透明**。
   - **方案 B（回退）**：代发失败 / 超限 / 缺少上下文时，回退为合成“拒绝消息”SSE 流。
3. 任一分支异常 → 重放原始 chunk，**绝不影响主链路**。

### 7.4 部署与排障要点

- 必须正确设置 `CLAWAVC_BASE_URL` 指向真实 clawAVC 服务；否则 `8.152.192.7:15100` 占位地址无法连通，拦截功能不生效（开关探测失败会放行，不影响主链路）。
- 拦截日志均以 `[ir-intercept]` 前缀输出，便于在 `gateway.out` 中检索：
  - `ALLOW` / `Decision: ALLOW`：放行；
  - `rewrote response` / `rewrote stream`：已拦截改写；
  - `LOOP_BREAK`：触发死循环熔断；
  - `retryWithRejection ...`：正在代发引导请求。
- 白名单来源于 clawAVC 推送的 IR（解析 `level2.policies` 中 `effect=allow` 的 `tool` 类型对象），由 clawAVC 侧“安全拦截”页配置。

---

## 8. 访问与验证

部署完成后，使用占位 IP 的访问地址为：

- 网关根地址：`http://8.152.192.7:18788`
- OpenAI 兼容接口：`http://8.152.192.7:18788/v1`
- 管理 UI（开发态）：`http://8.152.192.7:18788/public/`

### 8.1 连通性测试

```bash
curl http://8.152.192.7:18788/v1/models \
  -H "Authorization: Bearer <gatewayKey>"
```

`<gatewayKey>` 取自 `.portkey/local-gateway.config.json` 中的 `gatewayKeys`。

### 8.2 调用示例（以豆包模型为例）

```bash
curl http://8.152.192.7:18788/v1/chat/completions \
  -H "Authorization: Bearer <gatewayKey>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "doubao",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### 8.3 主动拦截验证

在 clawAVC 侧开启“拦截非白名单工具”开关，并配置某轮 IR 白名单；当 LLM 尝试调用白名单外工具时，观察网关日志 `[ir-intercept] ... rewrote response/stream`，或下游收到拒绝提示文案 `[clawAVC IR 拦截] ...`。

---

## 9. 配置说明

### 9.1 本地网关配置 `.portkey/local-gateway.config.json`

| 字段 | 说明 |
| --- | --- |
| `gatewayKeys` | 网关访问密钥列表，调用时作为 `Authorization: Bearer` |
| `models` | 模型别名映射，每个模型含 `upstreamModel`、`providerApiKey`、`customHost`、`displayName` |
| `mcpServers` | MCP 服务器配置（当前为空） |

可用环境变量 `LOCAL_GATEWAY_CONFIG_PATH` 覆盖默认路径 `{cwd}/.portkey/local-gateway.config.json`。

### 9.2 `conf.json`（插件 / 缓存配置）

用于启用插件、配置缓存等；部署时按需调整，缺省 `cache: false`。

---

## 10. 防火墙与端口放行

确保服务器防火墙 / 安全组放行对应端口：

```bash
# 网关端口（示例 18788）
firewall-cmd --permanent --add-port=18788/tcp
# 如 clawAVC 与本网关同机且需对外，也需放行 15100（按真实架构决定）
firewall-cmd --permanent --add-port=15100/tcp
firewall-cmd --reload
```

---

## 11. 重要提醒清单（部署前逐条确认）

1. ✅ 将全文 `8.152.192.7` 全局替换为**真实服务器 IP**。
2. ✅ 将端口 `18788`（网关）与 `15100`（clawAVC）与真实环境核对一致。
3. ✅ 设置环境变量 `CLAWAVC_BASE_URL` 指向真实 clawAVC 服务（默认 `http://8.152.192.7:15100`）。
4. ✅ 单独提供并正确放置 `.portkey/local-gateway.config.json`（含密钥，不随包分发）。
6. ✅ 防火墙 / 安全组已放行对应端口。
7. ✅ 主动拦截依赖 clawAVC 服务可达，否则拦截功能不生效（主链路仍正常放行）。
