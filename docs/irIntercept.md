# IR 拦截中间件 (irIntercept.ts) 技术文档

## 概述

`irIntercept.ts` 是 portkey AI 网关层的 **IR（Intent Recognition，意图识别）工具调用拦截** 模块。它在 LLM 返回 tool_calls 时，根据上游 clawAVC 提供的 IR 白名单进行拦截/放行决策，并在拦截命中时通过 **网关代发重试** 或 **合成拒绝消息** 让 Agent 重新决策。

## 核心目标

1. **白名单拦截**：仅允许 LLM 调用 IR 策略中 `effect=allow` 的工具
2. **死循环熔断**：检测同一 turn 内对相同工具的反复调用，强制 Agent 改用自然语言回答
3. **透明重试**：拦截后由网关代发请求让 LLM 重新决策，Agent 无感知
4. **零侵入**：对未命中拦截的请求完全不干预，不增加延迟

---

## 整体架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Agent     │────▶│  portkey GW  │────▶│   上游 LLM      │
│  (客户端)    │     │  (本模块)     │     │  (OpenAI等)     │
└─────────────┘     └──────┬───────┘     └─────────────────┘
                            │
                            │ Webhook (POST /api/webhook/ir-push)
                            ▼
                     ┌──────────────┐
                     │   clawAVC    │
                     │ (策略引擎)   │
                     └──────────────┘
```

### 组件职责

| 组件 | 职责 |
|------|------|
| **clawAVC** | 翻译用户 query → IR 策略（含 allowed_tools 白名单），通过 webhook 推送 |
| **portkey Gateway** | 接收 IR，缓存/等待，对 LLM 返回的 tool_calls 做拦截决策 |
| **上游 LLM** | 实际执行推理，返回 tool_calls 或文本 |
| **Agent** | 下游消费者，对拦截完全透明 |

---

## 数据流

### 阶段一：Round 生命周期（由 clawAVC 驱动）

```
round_start ─────▶ round_ir_ready ─────▶ (模型请求) ─────▶ round_end
     │                  │                      │                  │
     │ 记录 latestRoundId│ 缓存 IR + 唤醒等待者│ 获取 IR 做决策     │ 清理缓存
```

1. **round_start**：clawAVC 通知新轮开始，记录 `latest_round_id`
2. **round_ir_ready**：clawAVC 完成 IR 翻译，推送白名单工具列表，缓存并唤醒等待者
3. **模型请求到达**：portkey 使用 `latest_round_id` 获取 IR，做拦截决策
4. **round_end**：clawAVC 通知轮结束，清理缓存

### 阶段二：拦截决策（由 portkey 驱动）

```
LLM 返回 tool_calls
       │
       ▼
  ┌─────────────────────────────────────┐
  │ 1. 检查总开关 isInterceptEnabled()    │
  │ 2. 提取 round_id (latest_round_id)   │
  │ 3. 获取 IR (缓存命中 / 等待 webhook)   │
  │ 4. [loop-breaker] 死循环检测          │
  │ 5. 白名单匹配                         │
  └─────────────────────────────────────┘
       │
       ├── 无 IR / 超时 ────▶ ALLOW（原样放行）
       ├── loop-break 触发 ──▶ 拒绝文本流（强制 Agent 文本回答）
       ├── 白名单命中 ──────▶ retryWithRejection（方案A）或 拒绝文本流（方案B）
       └── 白名单通过 ──────▶ ALLOW（原样放行）
```

---

## 核心数据结构

### IR 缓存

```typescript
const _irCache = new Map<string, {
  ir: any;              // IR 策略 JSON
  allowedTools: string[]; // 提取的白名单工具名
  timestamp: number;     // 缓存时间戳
}>();
```

### 等待者队列

```typescript
const _irWaiters = new Map<string, {
  resolve: (ir: any) => void;  // 唤醒函数
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;       // 超时定时器
}>();
```

### 最新 Round ID

```typescript
let _latestRoundId: string | null = null;
```

在 `round_start` / `round_ir_ready` 时设置，在 `round_end` 时清空。模型请求处理时直接使用此值，无需从请求体中解析。

---

## 关键函数

### 入口函数

| 函数 | 作用 | 调用时机 |
|------|------|----------|
| `interceptNonStreamingJson()` | 非流式响应拦截 | 非流式 JSON 响应后 |
| `wrapStreamingResponseWithIRIntercept()` | 流式响应拦截（包装 SSE） | 流式响应返回前 |

### Webhook 处理

| 函数 | 作用 |
|------|------|
| `handlePushEvent()` | 处理 clawAVC 推送的 round_start / round_ir_ready / round_end 事件 |
| `extractAllowedToolsFromIR()` | 从 IR JSON 提取白名单工具名 |

### IR 获取

| 函数 | 作用 |
|------|------|
| `getIR(roundId)` | 优先从缓存获取，缓存未命中则等待 webhook 推送（带超时） |
| `waitForIR(roundId)` | 创建 Promise 等待 IR，超时后 resolve(null) |

### 拦截逻辑

| 函数 | 作用 |
|------|------|
| `interceptOpenAIChatJson()` | OpenAI 形态：清空违规 tool_calls，写入拒绝文案 |
| `interceptAnthropicMessagesJson()` | Anthropic 形态：违规 tool_use block 替换为 text block |
| `collectOpenAIViolations()` / `collectAnthropicViolations()` | 收集违规工具名（不修改 JSON） |
| `responseHasToolCalls()` | 检查响应是否包含 tool_calls |

### 死循环熔断

| 函数 | 作用 |
|------|------|
| `bumpAndDetectLoopOpenAI()` | 累加 (tool, args_hash) 计数，返回超阈值的 offender 列表 |
| `bumpAndDetectLoopAnthropic()` | 同上，Anthropic 形态 |
| `buildLoopBreakerMessage()` | 构造熔断拒绝文案 |
| `_hashToolArgs()` | 对工具参数做 fnv1a hash |

### 重试逻辑

| 函数 | 作用 |
|------|------|
| `retryWithRejection()` | 网关代发请求，最多 N 轮，让 LLM 用合法工具重新决策 |
| `pushAssistantAndToolResults()` | 构造 retry messages：追加 assistant tool_calls + tool_result(拒绝) |
| `sanitizeHistoryMessages()` | 清洗历史 messages 中引用非白名单工具的记录 |
| `filterToolsToAllowed()` | 把请求的 tools 字段过滤为仅白名单 |
| `mergeConsecutiveSameRoleOpenAI()` / `mergeConsecutiveSameRoleAnthropic()` | 合并连续相同 role 的消息（避免上游 400） |

### SSE 流构造 / 解析

| 函数 | 作用 |
|------|------|
| `aggregateOpenAIStream()` | OpenAI SSE 流 → 聚合为完整 JSON |
| `aggregateAnthropicStream()` | Anthropic SSE 流 → 聚合为完整 JSON |
| `rebuildOpenAIStreamFromJson()` | 非流式 JSON → SSE 流文本（方案 A 结果） |
| `rebuildAnthropicStreamFromJson()` | 同上，Anthropic 形态 |
| `buildOpenAIRejectStream()` | 构造"拒绝消息"SSE 流（方案 B 兜底） |
| `buildAnthropicRejectStream()` | 同上，Anthropic 形态 |

### 工具函数

| 函数 | 作用 |
|------|------|
| `isInterceptEnabled()` | 查询 clawAVC 总开关（带 10s 缓存） |
| `sanitizeUserQuery()` | 剥离 OpenClaw 注入的元信息和时间戳前缀 |
| `extractLastUserQueryOpenAI()` / `extractLastUserQueryAnthropic()` | 从请求体提取最后一条 user 纯文本 |
| `reportInterceptEvent()` | fire-and-forget 上报拦截事件到 clawAVC |

---

## 非流式拦截流程详解

```
interceptNonStreamingJson(responseBodyJson, gatewayRequest, c)
│
├─ 1. 防递归检查：若 c.get('__ir_internal_retry') → 直接返回 false
│
├─ 2. 若响应不含 tool_calls → 直接返回 false（不干预）
│
├─ 3. 检查总开关 isInterceptEnabled()
│     └─ 关闭 → 返回 false
│
├─ 4. 提取 userQuery
│
├─ 5. 获取 roundId = _latestRoundId
│     └─ 无 → ALLOW（日志 + 放行）
│
├─ 6. 获取 IR = await getIR(roundId)
│     ├─ 缓存命中 → 直接返回
│     ├─ 无缓存 → 注册 waiter，等待 webhook 唤醒
│     └─ 超时 → 返回 null → ALLOW（日志 + 放行）
│
├─ 7. [loop-breaker] 死循环检测
│     ├─ 遍历 tool_calls，累加 (roundId|tool|argsHash) 计数
│     └─ 超阈值 → 触发熔断，改写响应为拒绝文本 + 上报事件 → 返回 true
│
├─ 8. 白名单匹配
│     ├─ 无违规 → 返回 false（不干预）
│     └─ 有违规 → 改写响应（清空违规 tool_calls，写入拒绝文案）+ 上报事件 → 返回 true
│
└─ 9. 异常 → 返回 false（不影响主链路）
```

---

## 流式拦截流程详解

```
wrapStreamingResponseWithIRIntercept(response, fn, gatewayRequest, c, providerOption, requestHeaders)
│
├─ 1. 判断协议类型 streamFormatFromFn(fn)
│     ├─ 'openai' / 'anthropic' → 继续
│     └─ 其他 → 直接返回原 response
│
├─ 2. 防递归检查：若 c.get('__ir_internal_retry') → 直接返回原 response
│
├─ 3. Buffer 整段 SSE 流（TransformStream）
│     └─ 读取失败 → 把已 buffer 的部分原样吐出
│
├─ 4. 快速旁路：开关关闭 → 重放原 chunk
│
├─ 5. 聚合流为 JSON
│     ├─ OpenAI: aggregateOpenAIStream(buffered)
│     └─ Anthropic: aggregateAnthropicStream(buffered)
│
├─ 6. 若无 tool_calls → 重放原 chunk
│
├─ 7. 获取 roundId = _latestRoundId
│     └─ 无 → 重放原 chunk
│
├─ 8. 获取 IR = await getIR(roundId)
│     └─ 无 → 重放原 chunk
│
├─ 9. [loop-breaker] 死循环检测
│     └─ 触发 → synth = 拒绝文本流
│
├─ 10. 白名单匹配
│
├─ 11. 若无违规 → 重放原 chunk
│
├─ 12. 若有违规
│     ├─ 方案 A: retryWithRejection（最多 3 轮）
│     │   ├─ 成功且无违规 → synth = retry 结果的 SSE 流
│     │   └─ 失败/仍有违规 → synth = null
│     │
│     └─ 方案 B（A 失败时兜底）: synth = 拒绝文本 SSE 流
│
├─ 13. 写入 synth 到 response
│
└─ 14. 异常 → 重放原 chunk（绝不影响主链路）
```

---

## Webhook 事件处理

clawAVC 通过 `POST /api/webhook/ir-push` 推送事件，`handlePushEvent()` 处理：

### push_type: round_start

```typescript
_latestRoundId = body.round_id;
```

### push_type: round_ir_ready

```typescript
_latestRoundId = body.round_id;
_irCache.set(body.round_id, { ir, allowedTools, timestamp });
// 唤醒等待中的 Promise
const waiter = _irWaiters.get(body.round_id);
if (waiter) {
  clearTimeout(waiter.timer);
  _irWaiters.delete(body.round_id);
  waiter.resolve({ ir, allowed_tools });
}
```

### push_type: round_end

```typescript
_irCache.delete(body.round_id);
_irWaiters.delete(body.round_id);
if (_latestRoundId === body.round_id) {
  _latestRoundId = null;
}
```

---

## 死循环熔断（Loop-Breaker）

### 问题背景

当 IR 白名单极窄（仅 1 个工具）且该工具返回不符合预期时，Agent 会陷入"反复调用同一工具"的死循环。白名单拦截只能挡违规工具，但合法工具的"无效返回死循环"需要独立熔断机制。

### 设计

- **计数键**：`${roundId}|${toolName}|${argsHash}`（argsHash 用 fnv1a）
- **阈值**：默认 3（含本次）
- **LRU 上限**：4096 条，超出按插入序剔除
- **触发动作**：把响应改写为拒绝文本，强制 Agent 用自然语言回答

### 触发后响应改写

```
[clawAVC IR 熔断] 检测到本轮对相同工具的反复调用：`safe_file_reader__read_directory`(已调用 3 次)。
继续重复同样的调用不会得到新结果。请改用自然语言直接回答用户原始问题，
不要再调用任何工具。如果信息确实不足，请坦诚告知用户并请求更明确的指引。
```

---

## 网关代发重试（retryWithRejection）

### 流程

```
retryWithRejection({ c, providerOption, gatewayRequest, aggregated, violations, allowedList })
│
├─ 1. 标记 __ir_internal_retry = true（防止递归）
│
├─ 2. 清洗历史 messages：sanitizeHistoryMessages()
│     └─ 把历史中引用非白名单工具的 tool_call/tool_result mock 为文本
│
├─ 3. 构造 retry messages：pushAssistantAndToolResults()
│     ├─ 追加上一轮 assistant tool_calls（仅保留合法的）
│     ├─ 追加对应的 tool_result（拒绝说明）
│     └─ 追加 user 引导文本（告知可用工具）
│
├─ 4. 协议归一化
│     ├─ 合并连续相同 role 的消息
│     ├─ 规范化 arguments 为合法 JSON
│     └─ 清理无意义字段（tool_calls=[]、orphan tool_call_id 等）
│
├─ 5. 过滤 tools 字段：filterToolsToAllowed()
│     └─ 仅保留白名单工具，从源头阻断 LLM 再次选到违规工具
│
├─ 6. 调用 tryPost 发请求
│     └─ 复用 portkey 自己的 tryPost，对 Agent 完全透明
│
├─ 7. 解析响应
│     ├─ 若为 SSE（某些 provider 仅支持 stream=true）→ 聚合为 JSON
│     └─ 若为普通 JSON → 直接使用
│
├─ 8. 检查新响应是否还有违规
│     ├─ 无违规 → 返回 retryJson
│     └─ 仍有违规 → 继续下一轮（最多 3 轮）
│
└─ 9. 3 轮用尽仍有违规 → 返回 null（调用方走方案 B）
```

### 防御性措施

1. **content-type 规范化**：统一设为小写 `application/json`，避免 body 为空导致 400
2. **arguments 规范化**：非 JSON 字符串包成 `{"_raw": "..."}`
3. **消息字段归一化**：处理 `tool_calls=[]`、空 content、orphan 字段等
4. **连续 role 合并**：避免 `[user, user]` 或 `[assistant, assistant]` 连续导致 400

---

## 配置项

| 常量 | 值 | 说明 |
|------|-----|------|
| `CLAWAVC_BASE` | 环境变量 `CLAWAVC_BASE_URL` 或 `http://8.152.192.7:15100` | clawAVC 服务地址 |
| `SWITCH_TTL_MS` | 10,000 | 总开关缓存 TTL |
| `IR_CACHE_TTL_MS` | 300,000 (5 分钟) | IR 缓存 TTL |
| `IR_WAIT_TIMEOUT_MS` | 600,000 (10 分钟) | 等待 IR 超时 |
| `EVENT_REPORT_TIMEOUT_MS` | 5,000 | 事件上报超时 |
| `_LOOP_BREAKER_MAX_ENTRIES` | 4096 | 死循环计数器 LRU 上限 |
| `lbThreshold` | 3 | 死循环熔断阈值 |

---

## 协议支持

### OpenAI Chat Completions

- **请求识别**：`fn === 'chatComplete'` 或 `fn === 'createModelResponse'`
- **tool_calls 位置**：`choices[0].message.tool_calls[]`
- **工具名字段**：`tool_call.function.name`
- **参数字段**：`tool_call.function.arguments`（必须是 JSON 字符串）

### Anthropic Messages

- **请求识别**：`fn === 'messages'`
- **tool_use 位置**：`message.content[]` 中 `type: 'tool_use'` 的 block
- **工具名字段**：`content[i].name`
- **参数字段**：`content[i].input`（可以是 object）

---

## 异常处理原则

1. **任何异常都不影响主链路**：流式场景下，异常时重放原 chunk
2. **递归防护**：`__ir_internal_retry` 标记防止 retry 触发自身拦截
3. **超时放行**：IR 等待超时后直接放行，不阻塞 Agent
4. **fire-and-forget 上报**：事件上报失败仅打 log，不影响响应

---

## 日志约定

| 图标 | 含义 |
|------|------|
| `⏭️` | 放行（无 IR / 超时 / 开关关闭） |
| `✅` | IR 缓存命中 / webhook 唤醒成功 |
| `⏳` | 等待 IR / round 开始 |
| `🔔` | 等待者被唤醒 |
| `⏸️` | IR 已缓存但无等待者 |
| `🗑️` | 缓存过期清理 |
| `🚀` | Round 开始 |
| `🏁` | Round 结束 |
| `🚨` | 死循环熔断触发 |
| `🚫` | 拒绝消息流构造 |
| `⏰` | 超时 |
