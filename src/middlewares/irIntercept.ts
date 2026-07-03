// src/middlewares/irIntercept.ts
//
// IR-based tool-call interception at the AI gateway layer.
//
// Flow（非流式）:
//   1. portkey 接收到上游 LLM 返回的非流式 JSON
//   2. 若响应中包含 tool_calls，则按 turn 粒度向 clawAVC 询问该轮 user_query 对应
//      的 IR；同一 turn 共享同一份 IR（第一次 tool 交互时翻译，后续命中缓存）。
//   3. 对每个 tool_call，若工具名不在 IR allowed_tools 中，则：
//      - OpenAI 形态：把 tool_calls 整体清空，并在 message.content 中追加一条
//        "当前工具有不在白名单，建议使用 xxx 工具" 的提示
//      - Anthropic 形态：将 tool_use block 替换为 text block，输出同样的提示
//   4. 命中白名单的 tool_call 原样返回。
//
// Flow（流式 stream:true）:
//   1. wrapStreamingResponseWithIRIntercept 把已 transform 过的 SSE Response 再套一层
//      buffer：把整段流读完后再决策（实现确定性优先，可接受首字延迟变大）。
//   2. 流读完后聚合成 OpenAI / Anthropic 形态的完整 JSON 做白名单判定：
//      - 不命中：把原始 SSE 文本原封不动重放到下游。
//      - 命中（方案 A，网关代发请求）：
//          * 调 retryWithRejection 通过 portkey 自己的 tryPost 用同一 provider 再发
//            一次非流式请求；request.messages 末尾追加 "上一轮 assistant tool_calls +
//            tool_result(拒绝)"，引导 LLM 改用白名单工具。
//          * 最多 3 轮；若拿到不含违规 tool_call 的响应，用 rebuildXxxStreamFromJson
//            重新构造成 SSE 流吐给下游 Agent —— Agent 完全透明。
//      - 命中（方案 B，回退）：retry 失败/超限/缺少上下文，回退到合成"拒绝消息"SSE 流。
//      - 任一分支异常 → 重放原 chunk，绝不影响主链路。
//
// 关键约束：
//   - 网关层不阻塞首次 tool_call 之前的"普通对话"：只在响应包含 tool_calls 时才介入。
//   - 总开关在 clawAVC：若未启用，本中间件直接 no-op（流式路径下也立即放行）。
//   - 翻译/缓存均由 clawAVC 完成，本中间件仅做 fetch + rewrite。

const CLAWAVC_BASE = process.env.CLAWAVC_BASE_URL || 'http://8.152.192.7:15100';
const SWITCH_URL = `${CLAWAVC_BASE}/api/config/intercept_non_ir_tools`;
const EVENT_URL = `${CLAWAVC_BASE}/api/intercept/events`;

const SWITCH_TTL_MS = 10 * 1000; // 总开关 10s 缓存
// 翻译长轮询：由 clawAVC 端 DB 配置 `intercept.turn_ir_wait_ms` 决定实际等待时长
// （默认 300s，可在前端"安全拦截"页调整，范围 5s ~ 1800s）。
// portkey 端本地 abort 兜底设为上限 + 10s buffer，避免任何配置下被本端误 abort。
const EVENT_REPORT_TIMEOUT_MS = 5 * 1000;
let IR_WAIT_TIMEOUT_MS = 600 * 1000;
let LOOP_THRESHOLD = 3;

let _switchCache: { enabled: boolean; ts: number } | null = null;

async function isInterceptEnabled(): Promise<boolean> {
  const now = Date.now();
  if (_switchCache && now - _switchCache.ts < SWITCH_TTL_MS) {
    return _switchCache.enabled;
  }
  try {
    const resp = await fetch(SWITCH_URL);
    if (!resp.ok) {
      _switchCache = { enabled: false, ts: now };
      return false;
    }
    const j: any = await resp.json();
    const enabled = !!(j && j.ok && j.data && j.data.enabled);
    _switchCache = { enabled, ts: now };
    return enabled;
  } catch (e) {
    console.error('[ir-intercept] switch fetch failed:', e);
    _switchCache = { enabled: false, ts: now };
    return false;
  }
}

/**
 * 归一化用户 query 文本：剥离 OpenClaw / Agent 注入的元信息，只保留人类实际输入。
 *
 * 已知噪声来源：
 *   1) `Sender (untrusted metadata):\n```json {...}```` —— OpenClaw 注入的发送者元信息块
 *   2) 行首时间戳 `[Tue 2026-06-30 01:04 GMT+8] ` —— Agent 在每条用户输入前自动加的时间戳
 *
 * 这些噪声会：
 *   - 污染 IR 翻译输入，让 LLM 把时间戳当语义
 *   - 让 clawAVC 侧"user_query 精确匹配回填"永远失败（monitor 侧已做剥离，
 *     而 portkey 侧若不剥离会写入带噪声的版本，两边对不上）
 *   - 在前端"运行监控"里展示带前缀的丑陋查询
 *
 * 规则：
 *   - 先剥 Sender 元信息块
 *   - 按行扫描，取最后一条非空行，并去掉行首 `[...]` 时间戳前缀
 *   - 若取不到最后一行，则退回到去元信息后的整段文本
 */
function sanitizeUserQuery(raw: string): string {
  if (typeof raw !== 'string' || !raw) return '';
  // 剥离 OpenClaw 注入的 Sender 元信息块
  let cleaned = raw.replace(
    /Sender\s*\(untrusted metadata\)\s*:\s*```json\s*\{[\s\S]*?\}\s*```\s*/g,
    ''
  );
  cleaned = cleaned.trim();
  if (!cleaned) return '';
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return cleaned;
  // 取最后一行实际正文，去掉行首 [xxx] 时间戳/标签前缀
  const lastLine = lines[lines.length - 1].replace(/^\[[^\]]*\]\s*/, '').trim();
  return lastLine || cleaned;
}

/** 从 OpenAI 形态的请求体中抽取最后一条 user 的纯文本（用于 IR 翻译输入）。 */
function extractLastUserQueryOpenAI(req: any): string {
  if (!req || !Array.isArray(req.messages)) return '';
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return sanitizeUserQuery(m.content);
    if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const p of m.content) {
        if (typeof p === 'string') parts.push(p);
        else if (p && typeof p.text === 'string') parts.push(p.text);
        else if (p && p.type === 'text' && typeof p.text === 'string')
          parts.push(p.text);
      }
      if (parts.length) return sanitizeUserQuery(parts.join('\n'));
    }
  }
  return '';
}

/** 从 Anthropic messages 形态中抽取最后一条 user 的纯文本。 */
function extractLastUserQueryAnthropic(req: any): string {
  if (!req) return '';
  // anthropic 也是 messages 数组（无 system）
  if (Array.isArray(req.messages)) return extractLastUserQueryOpenAI(req);
  return '';
}

function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ─── Loop-Breaker：同 turn 内 (tool, args_hash) 调用频次计数器 ─────────
//
// 背景：
//   Agent 在 IR 白名单极窄、唯一可选工具又"看似返回成功但内容不符合预期"时，
//   会进入"反复重试相同 tool_call"的死循环（实测：safe_file_reader__read_directory
//   永远只返回 environ 残片 → Agent 不停重试）。
//   IR 拦截本身已经把违规工具挡掉，但合法工具的"无效返回死循环"必须有独立熔断。
//
// 设计：
//   - 计数键 = `${turnKey}|${toolName}|${argsHash}`，仅在拦截链路中由 retry / aggregated
//     检查时累加；其它路径不参与统计，避免污染。
//   - LRU 上限 _LOOP_BREAKER_MAX_ENTRIES，超出按插入序剔除。
//   - 阈值由 clawAVC 下发；缺省 3（含本次）。
const _LOOP_BREAKER_COUNTS = new Map<string, number>();
const _LOOP_BREAKER_MAX_ENTRIES = 4096;

function _loopBreakerKey(
  turnKey: string,
  toolName: string,
  argsHash: string
): string {
  return `${turnKey}|${toolName}|${argsHash}`;
}

/** 给一段 arguments（OpenAI 是 string，Anthropic 是 object）算 fnv1a hash。 */
function _hashToolArgs(args: any): string {
  let s: string;
  if (typeof args === 'string') {
    s = args;
  } else {
    try {
      s = JSON.stringify(args ?? {});
    } catch {
      s = '__unserializable__';
    }
  }
  return fnv1aHex(s);
}

/**
 * 累加 aggregated（本次 LLM 响应）里所有 tool_calls 的 (tool, args) 计数。
 * 返回所有"已超阈值"的 {tool, hash, count} 列表（含本次的累计）。
 */
function bumpAndDetectLoopOpenAI(
  turnKey: string,
  aggregated: any,
  threshold: number
): Array<{ tool: string; hash: string; count: number }> {
  const tcs = aggregated?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(tcs) || tcs.length === 0) return [];
  const offenders: Array<{ tool: string; hash: string; count: number }> = [];
  for (const tc of tcs) {
    const name = tc?.function?.name;
    if (typeof name !== 'string' || !name) continue;
    const argsHash = _hashToolArgs(tc?.function?.arguments);
    const key = _loopBreakerKey(turnKey, name, argsHash);
    const next = (_LOOP_BREAKER_COUNTS.get(key) || 0) + 1;
    _LOOP_BREAKER_COUNTS.set(key, next);
    if (_LOOP_BREAKER_COUNTS.size > _LOOP_BREAKER_MAX_ENTRIES) {
      try {
        const oldest = _LOOP_BREAKER_COUNTS.keys().next().value;
        if (oldest !== undefined) _LOOP_BREAKER_COUNTS.delete(oldest);
      } catch {}
    }
    if (next >= threshold) {
      offenders.push({ tool: name, hash: argsHash, count: next });
    }
  }
  return offenders;
}

function bumpAndDetectLoopAnthropic(
  turnKey: string,
  aggregated: any,
  threshold: number
): Array<{ tool: string; hash: string; count: number }> {
  const blocks = aggregated?.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const offenders: Array<{ tool: string; hash: string; count: number }> = [];
  for (const b of blocks) {
    if (b?.type !== 'tool_use') continue;
    const name = b?.name;
    if (typeof name !== 'string' || !name) continue;
    const argsHash = _hashToolArgs(b?.input);
    const key = _loopBreakerKey(turnKey, name, argsHash);
    const next = (_LOOP_BREAKER_COUNTS.get(key) || 0) + 1;
    _LOOP_BREAKER_COUNTS.set(key, next);
    if (_LOOP_BREAKER_COUNTS.size > _LOOP_BREAKER_MAX_ENTRIES) {
      try {
        const oldest = _LOOP_BREAKER_COUNTS.keys().next().value;
        if (oldest !== undefined) _LOOP_BREAKER_COUNTS.delete(oldest);
      } catch {}
    }
    if (next >= threshold) {
      offenders.push({ tool: name, hash: argsHash, count: next });
    }
  }
  return offenders;
}

function buildRejectMessage(badTool: string, allowed: string[]): string {
  const allowedHint = allowed && allowed.length ? allowed.join(', ') : '（无）';
  return (
    `[clawAVC IR 拦截] 当前工具调用 \`${badTool}\` 不在本轮 IR 白名单内，已被网关拒绝。` +
    `建议改用以下工具完成任务：${allowedHint}。`
  );
}

/**
 * 死循环熔断拒绝文案：用于"同一 turn 内已对同名同参 tool 调用过多次"场景。
 * 与白名单拒绝区分，明确告诉 Agent 不要再调任何工具，请直接用自然语言回答。
 */
function buildLoopBreakerMessage(
  offenders: Array<{ tool: string; count: number }>
): string {
  const list = offenders
    .map((o) => `\`${o.tool}\`(已调用 ${o.count} 次)`)
    .join('、');
  return (
    `[clawAVC IR 熔断] 检测到本轮对相同工具的反复调用：${list}。` +
    `继续重复同样的调用不会得到新结果。请改用自然语言直接回答用户原始问题，` +
    `不要再调用任何工具。如果信息确实不足，请坦诚告知用户并请求更明确的指引。`
  );
}

/**
 * OpenAI chat.completions 形态拦截。
 * - 若某个 tool_call 的函数名不在白名单：清空该 choice 的 tool_calls，并将 content
 *   设置为提示消息，finish_reason 改为 "stop"。
 * @returns 实际被拦截的工具名数组（用于上报）
 */
function interceptOpenAIChatJson(
  json: any,
  allowed: Set<string>,
  allowedList: string[]
): string[] {
  const allViolations: string[] = [];
  if (!json || !Array.isArray(json.choices)) return allViolations;
  for (const ch of json.choices) {
    const msg = ch?.message;
    const tcs = msg?.tool_calls;
    if (!Array.isArray(tcs) || tcs.length === 0) continue;

    const violations: string[] = [];
    for (const tc of tcs) {
      const name = tc?.function?.name;
      if (typeof name !== 'string') continue;
      if (!allowed.has(name)) violations.push(name);
    }
    if (violations.length === 0) continue;

    // 命中拦截：清空 tool_calls，写入拒绝文案
    const rejectText = buildRejectMessage(violations.join(', '), allowedList);
    msg.tool_calls = [];
    if (typeof msg.content === 'string' && msg.content) {
      msg.content = `${msg.content}\n\n${rejectText}`;
    } else {
      msg.content = rejectText;
    }
    ch.finish_reason = 'stop';
    allViolations.push(...violations);
  }
  return allViolations;
}

/**
 * Anthropic messages 形态拦截。
 * - 将所有 tool_use block 中不在白名单的，整体替换为 text block；
 *   保留白名单内的 tool_use block。
 * @returns 实际被拦截的工具名数组（用于上报）
 */
function interceptAnthropicMessagesJson(
  json: any,
  allowed: Set<string>,
  allowedList: string[]
): string[] {
  if (!json || !Array.isArray(json.content)) return [];
  const violations: string[] = [];
  const newContent: any[] = [];
  for (const block of json.content) {
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      if (!allowed.has(block.name)) {
        violations.push(block.name);
        continue; // 丢弃该 tool_use
      }
    }
    newContent.push(block);
  }
  if (violations.length > 0) {
    newContent.push({
      type: 'text',
      text: buildRejectMessage(violations.join(', '), allowedList),
    });
    json.content = newContent;
    json.stop_reason = 'end_turn';
  }
  return violations;
}

/**
 * 检查一个非流式 JSON 是否包含 tool_calls / tool_use 块。
 */
function responseHasToolCalls(json: any): boolean {
  if (!json || typeof json !== 'object') return false;
  if (Array.isArray(json.choices)) {
    for (const ch of json.choices) {
      const tcs = ch?.message?.tool_calls;
      if (Array.isArray(tcs) && tcs.length > 0) return true;
    }
  }
  if (Array.isArray(json.content)) {
    for (const block of json.content) {
      if (block?.type === 'tool_use') return true;
    }
  }
  return false;
}

/**
 * 入口：对非流式响应 JSON 进行 IR 拦截。
 * 仅在以下条件全部满足时介入：
 *   - clawAVC 总开关已开启
 *   - 响应包含 tool_calls / tool_use
 *   - 能从请求体中提取出 user_query 与 turn_key
 *   - clawAVC 成功返回 IR
 *
 * @returns true 表示发生了修改
 */
export async function interceptNonStreamingJson(
  responseBodyJson: any,
  gatewayRequest: any,
  c?: any
): Promise<boolean> {
  try {
    // 当被 retryWithRejection 内部代发请求触发时（c.set('__ir_internal_retry', true)），
    // 自身要 no-op，避免递归。
    if (c && typeof c.get === 'function') {
      try {
        if (c.get('__ir_internal_retry')) {
          return false;
        }
      } catch {}
    }
    if (!responseHasToolCalls(responseBodyJson)) return false;

    const enabled = await isInterceptEnabled();
    if (!enabled) return false;

    // 从请求体中抽取 user_query
    const userQuery =
      extractLastUserQueryOpenAI(gatewayRequest) ||
      extractLastUserQueryAnthropic(gatewayRequest);

    // 使用 latest_round_id（在 round_start 或 round_ir_ready 时设置）
    const roundId = _latestRoundId;
    if (!roundId) {
      console.log(
        `[ir-intercept] (non-stream) ⏭️ No latest_round_id available - ALLOW\n` +
          `   user_query: ${userQuery.slice(0, 50)}...`
      );
      return false;
    }

    // 获取 IR（从缓存或等待 webhook 推送）
    const irData = await getIR(roundId);

    // 情况1：无 IR → 放行
    if (!irData) {
      console.log(
        `[ir-intercept] (non-stream) ⏭️ No IR or timeout - ALLOW\n` +
          `   round_id: ${roundId}`
      );
      return false;
    }

    const allowedList = irData.allowed_tools || [];
    const allowed = new Set<string>(allowedList);

    // [loop-breaker] 死循环熔断：累计本响应的 (tool, args) 计数
    const lbEnabled = true;
    const lbThreshold = LOOP_THRESHOLD;
    let loopOffenders: Array<{ tool: string; hash: string; count: number }> =
      [];
    if (lbEnabled) {
      // 非流式 JSON 里既可能是 OpenAI 也可能是 Anthropic，两个都试
      loopOffenders = [
        ...bumpAndDetectLoopOpenAI(roundId, responseBodyJson, lbThreshold),
        ...bumpAndDetectLoopAnthropic(roundId, responseBodyJson, lbThreshold),
      ];
    }
    if (loopOffenders.length > 0) {
      // 把 responseBodyJson 改写成"loop break 拒绝文本"，清空 tool_calls
      const rejectText = buildLoopBreakerMessage(loopOffenders);
      // OpenAI choice 形态
      if (Array.isArray(responseBodyJson?.choices)) {
        for (const ch of responseBodyJson.choices) {
          if (ch?.message) {
            ch.message.tool_calls = [];
            ch.message.content = rejectText;
          }
          if (ch) ch.finish_reason = 'stop';
        }
      }
      // Anthropic content blocks 形态
      if (Array.isArray(responseBodyJson?.content)) {
        responseBodyJson.content = [{ type: 'text', text: rejectText }];
        responseBodyJson.stop_reason = 'end_turn';
      }
      console.warn(
        `[ir-intercept] LOOP-BREAKER triggered round=${roundId} ` +
          `threshold=${lbThreshold} ` +
          `offenders=${JSON.stringify(
            loopOffenders.map((o) => ({ tool: o.tool, count: o.count }))
          )}`
      );
      reportInterceptEvent({
        event_type: 'ir_loop_break',
        protocol: Array.isArray(responseBodyJson?.content)
          ? 'anthropic'
          : 'openai',
        turn_key: roundId,
        user_query: userQuery,
        violations: loopOffenders.map((o) => o.tool),
        allowed_tools: allowedList,
        source: 'portkey-gateway',
        extra: {
          loop_break: true,
          loop_break_threshold: lbThreshold,
          loop_break_offenders: loopOffenders.map((o) => ({
            tool: o.tool,
            count: o.count,
          })),
        },
      });
      return true;
    }

    const openaiViolations = interceptOpenAIChatJson(
      responseBodyJson,
      allowed,
      allowedList
    );
    const anthropicViolations = interceptAnthropicMessagesJson(
      responseBodyJson,
      allowed,
      allowedList
    );
    const violations = [...openaiViolations, ...anthropicViolations];
    const changed = violations.length > 0;

    if (changed) {
      const protocol = openaiViolations.length > 0 ? 'openai' : 'anthropic';
      console.log(
        `[ir-intercept] round=${roundId} allowed=${allowedList.length} ` +
          `violations=${JSON.stringify(violations)} -> rewrote response`
      );
      // fire-and-forget 上报 clawAVC（不阻塞响应）
      reportInterceptEvent({
        event_type: 'ir_tool_block',
        protocol,
        turn_key: roundId,
        user_query: userQuery,
        violations,
        allowed_tools: allowedList,
        source: 'portkey-gateway',
      });
    }
    return changed;
  } catch (e) {
    console.error('[ir-intercept] interceptNonStreamingJson failed:', e);
    return false;
  }
}

/**
 * 异步上报拦截事件到 clawAVC，失败仅打 log，不影响主链路。
 */
function reportInterceptEvent(payload: {
  event_type: string;
  protocol: string;
  turn_key: string;
  user_query: string;
  violations: string[];
  allowed_tools: string[];
  source: string;
  extra?: Record<string, any>;
}): void {
  const body = JSON.stringify(payload);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), EVENT_REPORT_TIMEOUT_MS);
  fetch(EVENT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: ctl.signal,
  })
    .then((r) => {
      if (!r.ok) {
        console.warn('[ir-intercept] event report HTTP', r.status);
      }
    })
    .catch((e) => {
      console.warn('[ir-intercept] event report failed:', e?.message || e);
    })
    .finally(() => clearTimeout(timer));
}

// ============================================================================
// Streaming interception
// ============================================================================

type StreamFormat = 'openai' | 'anthropic';

/**
 * 把 fn(endpointStrings) 映射成我们关心的两种 SSE 形态。
 * 其他形态（complete / embed / 等）返回 null，表示不介入流式拦截。
 */
function streamFormatFromFn(fn: string | undefined): StreamFormat | null {
  if (fn === 'chatComplete' || fn === 'createModelResponse') return 'openai';
  if (fn === 'messages') return 'anthropic';
  return null;
}

/**
 * 把一段聚合好的 OpenAI chatCompletion SSE 文本还原成"最终 JSON"。
 *   - 把所有 `data: {...}` chunk 解析出来
 *   - 按 choices[i].delta.{content, tool_calls[j].{function.name, function.arguments}}
 *     累积成一个 OpenAI 非流式 chatCompletion 结构（messages 而非 delta）
 *   - 同时返回原始 chunk 文本数组，便于"放行时重放"
 */
function aggregateOpenAIStream(buffer: string): {
  chunks: string[];
  aggregated: any;
} {
  const chunks: string[] = [];
  const aggregated: any = { id: '', object: 'chat.completion', choices: [] };

  // SSE 以 \n\n 分割，每段可能含 "data: xxx" 行
  const parts = buffer.split('\n\n');
  for (const part of parts) {
    if (!part) continue;
    chunks.push(part + '\n\n');
    const lines = part.split('\n');
    for (const line of lines) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m) continue;
      const data = m[1].trim();
      if (!data || data === '[DONE]') continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.id && !aggregated.id) aggregated.id = json.id;
      if (json.model && !aggregated.model) aggregated.model = json.model;
      if (!Array.isArray(json.choices)) continue;
      for (const ch of json.choices) {
        if (typeof ch.index !== 'number') continue;
        const idx = ch.index;
        while (aggregated.choices.length <= idx) {
          aggregated.choices.push({
            index: aggregated.choices.length,
            message: { role: 'assistant', content: '', tool_calls: [] },
            finish_reason: null,
          });
        }
        const target = aggregated.choices[idx];
        const delta = ch.delta || {};
        if (typeof delta.role === 'string') target.message.role = delta.role;
        if (typeof delta.content === 'string' && delta.content) {
          target.message.content =
            (target.message.content || '') + delta.content;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tcDelta of delta.tool_calls) {
            const tcIdx = typeof tcDelta.index === 'number' ? tcDelta.index : 0;
            while (target.message.tool_calls.length <= tcIdx) {
              target.message.tool_calls.push({
                index: target.message.tool_calls.length,
                id: '',
                type: 'function',
                function: { name: '', arguments: '' },
              });
            }
            const tc = target.message.tool_calls[tcIdx];
            if (typeof tcDelta.id === 'string' && tcDelta.id)
              tc.id = tcDelta.id;
            if (typeof tcDelta.type === 'string') tc.type = tcDelta.type;
            const fn = tcDelta.function || {};
            if (typeof fn.name === 'string' && fn.name)
              tc.function.name = fn.name;
            if (typeof fn.arguments === 'string')
              tc.function.arguments =
                (tc.function.arguments || '') + fn.arguments;
          }
        }
        if (ch.finish_reason) target.finish_reason = ch.finish_reason;
      }
    }
  }
  // 去掉 tool_calls 数组里的 index 字段，对齐非流式 JSON 形态
  for (const c of aggregated.choices) {
    if (Array.isArray(c.message?.tool_calls)) {
      c.message.tool_calls = c.message.tool_calls.map((tc: any) => {
        const { index, ...rest } = tc;
        return rest;
      });
      if (c.message.tool_calls.length === 0) delete c.message.tool_calls;
    }
  }
  return { chunks, aggregated };
}

/**
 * 把一段聚合好的 Anthropic messages SSE 文本还原成"最终 JSON"。
 *   关键事件：content_block_start / content_block_delta / message_stop
 */
function aggregateAnthropicStream(buffer: string): {
  chunks: string[];
  aggregated: any;
} {
  const chunks: string[] = [];
  const aggregated: any = {
    type: 'message',
    role: 'assistant',
    content: [],
    stop_reason: null,
  };
  // 临时容器：index -> { type, name?, text?, partial_json? }
  const blocks: Record<number, any> = {};

  const parts = buffer.split('\n\n');
  for (const part of parts) {
    if (!part) continue;
    chunks.push(part + '\n\n');
    let eventName = '';
    let dataLine = '';
    for (const line of part.split('\n')) {
      const em = line.match(/^event:\s*(.*)$/);
      if (em) {
        eventName = em[1].trim();
        continue;
      }
      const dm = line.match(/^data:\s*(.*)$/);
      if (dm) {
        dataLine = dm[1].trim();
      }
    }
    if (!dataLine) continue;
    let json: any;
    try {
      json = JSON.parse(dataLine);
    } catch {
      continue;
    }
    const type = eventName || json.type;
    if (type === 'message_start' && json.message) {
      if (json.message.id) aggregated.id = json.message.id;
      if (json.message.model) aggregated.model = json.message.model;
    } else if (type === 'content_block_start') {
      const idx = json.index;
      const block = json.content_block || {};
      blocks[idx] = { ...block, _text: '', _json: '' };
    } else if (type === 'content_block_delta') {
      const idx = json.index;
      const d = json.delta || {};
      if (!blocks[idx]) blocks[idx] = { type: d.type, _text: '', _json: '' };
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        blocks[idx]._text += d.text;
      } else if (
        d.type === 'input_json_delta' &&
        typeof d.partial_json === 'string'
      ) {
        blocks[idx]._json += d.partial_json;
      }
    } else if (type === 'message_delta' && json.delta) {
      if (json.delta.stop_reason)
        aggregated.stop_reason = json.delta.stop_reason;
    }
  }
  // 把 blocks 排序展开成 content[]
  const sortedIdx = Object.keys(blocks)
    .map((x) => Number(x))
    .sort((a, b) => a - b);
  for (const i of sortedIdx) {
    const b = blocks[i];
    if (b.type === 'text') {
      aggregated.content.push({ type: 'text', text: b._text || b.text || '' });
    } else if (b.type === 'tool_use') {
      let input = b.input;
      if (b._json) {
        try {
          input = JSON.parse(b._json);
        } catch {
          // 解析失败保留原始字符串，仍用工具名做白名单判定即可
          input = { _raw: b._json };
        }
      }
      aggregated.content.push({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: input ?? {},
      });
    }
  }
  return { chunks, aggregated };
}

/**
 * 构造一段"拒绝消息"OpenAI chatCompletion SSE 流。
 * 形如：data: { choices:[{delta:{role:"assistant",content:"..."}}] }\n\n ... data: [DONE]\n\n
 */
function buildOpenAIRejectStream(
  text: string,
  id: string,
  model: string
): string {
  const created = Math.floor(Date.now() / 1000);
  const base = {
    id: id || `chatcmpl-ir-${created}`,
    object: 'chat.completion.chunk',
    created,
    model: model || 'ir-intercept',
  };
  const first = {
    ...base,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null,
      },
    ],
  };
  const body = {
    ...base,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
  const last = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
  return (
    `data: ${JSON.stringify(first)}\n\n` +
    `data: ${JSON.stringify(body)}\n\n` +
    `data: ${JSON.stringify(last)}\n\n` +
    `data: [DONE]\n\n`
  );
}

/**
 * 构造一段"拒绝消息"Anthropic messages SSE 流。
 */
function buildAnthropicRejectStream(
  text: string,
  id: string,
  model: string
): string {
  const msgId = id || `msg_ir_${Date.now()}`;
  const mdl = model || 'ir-intercept';
  const messageStart = {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: mdl,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  const blockStart = {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  };
  const blockDelta = {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  };
  const blockStop = { type: 'content_block_stop', index: 0 };
  const messageDelta = {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 0 },
  };
  const messageStop = { type: 'message_stop' };
  return (
    `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`
  );
}

/**
 * 把命中拦截的 aggregated 响应 + 拒绝消息塞回对话历史，
 * 用 portkey 自己的 tryPost 用同样的 provider config 再发一次非流式请求。
 *
 * 关键点：
 *   - 这是"网关代发"，对 Agent 完全透明，Agent 不知道发生过拦截。
 *   - 设置 `stream: false` 避免内部递归触发 wrapStreamingResponseWithIRIntercept。
 *   - 在 Hono Context 里打标记 `__ir_internal_retry`，让 interceptNonStreamingJson 跳过自身。
 *   - 重试上限 N 次，超限回退到 null（调用方可继续走"吐拒绝文本"兜底）。
 *
 * @returns 最终拿到的非流式 aggregated JSON（OpenAI / Anthropic 形态），或 null 表示超限/失败。
 */
async function retryWithRejection(opts: {
  c: any;
  providerOption: any;
  requestHeaders: Record<string, string>;
  fn: string;
  format: StreamFormat;
  gatewayRequest: any;
  aggregated: any;
  violations: string[];
  allowedList: string[];
  maxRetries: number;
}): Promise<any | null> {
  const {
    c,
    providerOption,
    requestHeaders,
    fn,
    format,
    gatewayRequest,
    allowedList,
    maxRetries,
  } = opts;
  if (!c || !providerOption) {
    console.warn(
      '[ir-intercept] retryWithRejection skipped: missing honoContext or providerOption'
    );
    return null;
  }

  // 动态 import，避免循环依赖（handlerUtils 用到 streamHandler，streamHandler 又转回我们）
  const { tryPost } = await import('../handlers/handlerUtils');

  // 标记位：让 interceptNonStreamingJson 和 wrap 跳过自身处理，避免无限递归
  try {
    c.set('__ir_internal_retry', true);
  } catch {}

  // 累积的 messages，每轮被拦截后会追加 assistant tool_calls + tool results
  // **先对 gatewayRequest.messages 做一次历史清洗**：Agent 多轮 history 里
  // 可能已经有引用非白名单工具的 assistant.tool_calls / tool 结果对，必须
  // 把它们 mock 成 assistant text，否则上游因 tools 字段与 messages 引用不一致
  // 直接 400 invalid_arguments。
  const startMessages = sanitizeHistoryMessages(
    Array.isArray(gatewayRequest?.messages) ? [...gatewayRequest.messages] : [],
    allowedList,
    format
  );
  let workingMessages = startMessages;
  let workingAggregated = opts.aggregated;
  let workingViolations = opts.violations;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // 1) 把上一轮 LLM 的 assistant response 拼回 history（含被拒 tool_call）
    workingMessages = pushAssistantAndToolResults(
      workingMessages,
      workingAggregated,
      workingViolations,
      allowedList,
      format
    );

    // 1.5) push 之后可能在末尾出现 [..., user_orig, user_guidance] 之类的连续 user，
    //      或 sanitize 内部已合并过但与 push 出的新消息又产生连续 → 再做一次合并。
    workingMessages =
      format === 'openai'
        ? mergeConsecutiveSameRoleOpenAI(workingMessages)
        : mergeConsecutiveSameRoleAnthropic(workingMessages);

    // 2) 构造重发 request：保持原 stream 设置（关键：LongCat 等只支持 stream=true，
    //    实测 stream=false 会被上游以 `invalid arguments` 拒绝），把 tools 过滤为
    //    只剩白名单（从源头阻断 LLM 再次选到违规工具，帮助 retry 快速收敛）
    const retryRequest: any = {
      ...gatewayRequest,
      messages: workingMessages,
      // 不再强制 stream:false；保留原请求的 stream 字段
    };
    const filteredTools = filterToolsToAllowed(
      gatewayRequest,
      allowedList,
      format
    );
    if (filteredTools !== undefined) {
      if (filteredTools.length === 0) {
        // 白名单为空 → 删掉 tools / tool_choice，让 LLM 走纯文本回答
        // （OpenAI 不接受 tools:[]；Anthropic 也类似）
        delete retryRequest.tools;
        delete retryRequest.tool_choice;
      } else {
        retryRequest.tools = filteredTools;
        // 如果原请求强制了 tool_choice: required/specific tool，可能引用到被过滤掉的工具，
        // 这里统一降级为 'auto'，让 LLM 自己决定调工具还是直接给答案
        if (
          retryRequest.tool_choice &&
          retryRequest.tool_choice !== 'auto' &&
          retryRequest.tool_choice !== 'none'
        ) {
          retryRequest.tool_choice = 'auto';
        }
      }
    }
    // 移除可能引发某些 provider 严格校验失败的字段
    // （仅在 retry 路径上动手，绝不影响原始流）
    delete retryRequest.stream_options;

    // **防御性规范化 arguments**：OpenAI Chat Completions 协议规定
    // `tool_calls[].function.arguments` 必须是 stringified JSON object，
    // 很多上游 provider (DeepSeek/Kimi/Doubao/智谱 等) 会严格校验该字段必须能
    // JSON.parse 出一个 object。Agent 历史里可能保存的是裸 shell 命令字符串
    // (如 "ls -la")，原始流式响应那一轮上游可能宽容地接受了，但 retry 时
    // 上游会以 `invalid arguments` (code:3) 返回 400。
    // 这里统一把 arguments 规范成合法 JSON：
    //   - 已是合法 JSON object 字符串 -> 保持原样
    //   - 不是 -> 包成 {"_raw": "<原内容>"} 字符串
    if (format === 'openai' && Array.isArray(retryRequest.messages)) {
      let normalizedCount = 0;
      retryRequest.messages = retryRequest.messages.map((m: any) => {
        if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
        const newTcs = m.tool_calls.map((tc: any) => {
          const fn = tc?.function;
          if (!fn) return tc;
          let args = fn.arguments;
          if (typeof args !== 'string') {
            try {
              args = JSON.stringify(args ?? {});
            } catch {
              args = '{}';
            }
          }
          // 试探 JSON.parse + 检查解析结果是不是 object（不是 array、不是 string、不是 number）
          let ok = false;
          try {
            const parsed = JSON.parse(args);
            ok =
              parsed !== null &&
              typeof parsed === 'object' &&
              !Array.isArray(parsed);
          } catch {
            ok = false;
          }
          if (ok) return tc;
          normalizedCount += 1;
          return {
            ...tc,
            function: {
              ...fn,
              arguments: JSON.stringify({ _raw: args }),
            },
          };
        });
        return { ...m, tool_calls: newTcs };
      });
      if (normalizedCount > 0) {
        console.log(
          `[ir-intercept] retryWithRejection arguments_normalized=${normalizedCount} ` +
            `(wrapped non-JSON tool_call arguments in {_raw:...})`
        );
      }
    }

    // **协议字段归一化**（仅 OpenAI 路径）：
    // 不同上游 provider 对 OpenAI Chat Completions 协议的容忍度差异很大。
    // LongCat 等国产 provider 会返回 {"code":"3","message":"invalid arguments"}
    // 而完全不告诉你具体哪个字段不合法。已知的潜在地雷：
    //   1) assistant.content = null 但同时无 tool_calls → 期望字符串
    //   2) assistant.tool_calls = []（空数组）→ 期望删除该字段
    //   3) assistant 既有 content="...string..." 又有 tool_calls → 部分严格 provider 要求 content=null
    //   4) message 残留无意义字段（如顶层 tool_call_id 出现在非 tool 消息上）
    //   5) content 是空字符串
    // 这里逐条 message 做防御性归一化。
    if (format === 'openai' && Array.isArray(retryRequest.messages)) {
      let coerceCount = 0;
      retryRequest.messages = retryRequest.messages.map((m: any) => {
        if (!m || typeof m !== 'object') return m;
        const role = m.role;
        const out: any = { ...m };

        if (role === 'assistant') {
          const hasTcs =
            Array.isArray(out.tool_calls) && out.tool_calls.length > 0;
          if (Array.isArray(out.tool_calls) && out.tool_calls.length === 0) {
            // tool_calls=[] → 删除（OpenAI 规范不允许空数组）
            delete out.tool_calls;
            coerceCount++;
          }
          if (hasTcs) {
            // 有 tool_calls 时 content 既可以是 null 也可以是字符串（LongCat 历史日志
            // 实证：843 条 assistant+tool_calls 里 content=null 122 条、content=str 721 条
            // 都成功，但 content="" 0 条 — 仅"空字符串"会被拒）。
            if (typeof out.content === 'string' && out.content.length === 0) {
              out.content = null;
              coerceCount++;
            }
          } else {
            // 无 tool_calls 时 content 必须是非空字符串
            if (out.content === null || out.content === undefined) {
              out.content = '(empty)';
              coerceCount++;
            } else if (
              typeof out.content === 'string' &&
              out.content.length === 0
            ) {
              out.content = '(empty)';
              coerceCount++;
            }
          }
          // 非 tool 消息上不应有 tool_call_id
          if ('tool_call_id' in out) {
            delete out.tool_call_id;
            coerceCount++;
          }
        } else if (role === 'user' || role === 'system') {
          if (typeof out.content !== 'string') {
            // 非字符串 content（Anthropic blocks 形态）某些 provider 不接受
            if (Array.isArray(out.content)) {
              // 提取 text 块拼接
              const txt = out.content
                .map((b: any) =>
                  typeof b === 'string'
                    ? b
                    : typeof b?.text === 'string'
                      ? b.text
                      : ''
                )
                .filter((s: string) => s)
                .join('\n\n');
              out.content = txt || '(empty)';
              coerceCount++;
            } else if (out.content === null || out.content === undefined) {
              out.content = '(empty)';
              coerceCount++;
            } else {
              out.content = String(out.content);
              coerceCount++;
            }
          } else if (out.content.length === 0) {
            out.content = '(empty)';
            coerceCount++;
          }
          // 清除无意义字段
          if ('tool_calls' in out) {
            delete out.tool_calls;
            coerceCount++;
          }
          if ('tool_call_id' in out) {
            delete out.tool_call_id;
            coerceCount++;
          }
        } else if (role === 'tool') {
          // tool 消息必须有 tool_call_id + content
          if (typeof out.content !== 'string') {
            if (out.content == null) {
              out.content = '(empty)';
              coerceCount++;
            } else {
              try {
                out.content = JSON.stringify(out.content);
                coerceCount++;
              } catch {
                out.content = '(empty)';
                coerceCount++;
              }
            }
          }
          if ('tool_calls' in out) {
            delete out.tool_calls;
            coerceCount++;
          }
        }
        return out;
      });
      if (coerceCount > 0) {
        console.log(
          `[ir-intercept] retryWithRejection message_fields_coerced=${coerceCount} ` +
            `(normalized assistant content/tool_calls, removed orphan fields)`
        );
      }
    }

    // 排查辅助：打印第一条 user / 末尾两条 message role + 残留的 tool_calls 工具名
    const tailRoles = workingMessages
      .slice(-3)
      .map((m: any) => m?.role || '?')
      .join('->');
    // 列出 workingMessages 中所有 assistant.tool_calls 的工具名，
    // 帮助诊断"上游 400 是因为 messages 引用了非白名单工具"
    const residualToolCallNames: string[] = [];
    for (const m of workingMessages) {
      if (format === 'openai') {
        if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            const n = tc?.function?.name;
            if (typeof n === 'string') residualToolCallNames.push(n);
          }
        }
      } else {
        if (m?.role === 'assistant' && Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type === 'tool_use' && typeof b.name === 'string') {
              residualToolCallNames.push(b.name);
            }
          }
        }
      }
    }
    console.log(
      `[ir-intercept] retryWithRejection attempt=${attempt}/${maxRetries} ` +
        `format=${format} prev_violations=${JSON.stringify(workingViolations)} ` +
        `messages_len=${workingMessages.length} tail_roles=${tailRoles} ` +
        `tools_after_filter=${Array.isArray(filteredTools) ? filteredTools.length : 'unchanged'} ` +
        `residual_tool_calls=${JSON.stringify(residualToolCallNames)} ` +
        `consecutive_same_role=${(() => {
          let n = 0;
          for (let i = 1; i < workingMessages.length; i++) {
            const a = workingMessages[i - 1]?.role;
            const b = workingMessages[i]?.role;
            if (a && a === b && a !== 'tool') n++;
          }
          return n;
        })()}`
    );

    // 3) 调网关自身的 tryPost；fn 与原请求一致，currentIndex 用 0
    //
    // **关键修复**：constructRequestBody 只在 `requestContext.getHeader('content-type')`
    // 非空时才 `JSON.stringify(body)`，否则 body=null（发出空请求体）。而 getHeader
    // 内部查的是**小写** requestHeaders['content-type']（普通对象大小写敏感）。
    // 响应处理阶段透传下来的 requestHeaders 可能：(a) 根本没有 content-type；
    // (b) key 是大写 'Content-Type'；(c) 在流式阶段被改写成 'text/event-stream'。
    // 任一情况都会让 retry 请求 body 为空 → 上游返回 `invalid arguments`(code:3) 400。
    // 这里统一删除所有 content-type 变体，强制设小写 application/json，保证 body 序列化。
    const retryHeaders: Record<string, string> = {
      ...(requestHeaders || {}),
    };
    const ctKeysBefore = Object.keys(retryHeaders).filter(
      (k) => k.toLowerCase() === 'content-type'
    );
    const ctValsBefore = ctKeysBefore.map((k) => retryHeaders[k]);
    for (const k of ctKeysBefore) delete retryHeaders[k];
    retryHeaders['content-type'] = 'application/json';
    console.log(
      `[ir-intercept] retryWithRejection content-type normalized: ` +
        `before=${JSON.stringify(ctValsBefore)} -> 'application/json' ` +
        `(empty/missing/mismatched content-type would cause empty body 400)`
    );

    let retryResp: Response;
    try {
      retryResp = await tryPost(
        c,
        providerOption,
        retryRequest,
        retryHeaders,
        fn as any,
        0,
        'POST'
      );
    } catch (e: any) {
      console.error(
        `[ir-intercept] retryWithRejection tryPost failed: ${e?.message || e}`
      );
      return null;
    }
    if (!retryResp.ok) {
      // 把上游错误 body 也打出来，方便排查 400 的真实原因
      let errBody = '';
      try {
        errBody = (await retryResp.clone().text()).slice(0, 2000);
      } catch {}
      // 同时打印我们重发的 request 摘要：让肉眼能比对到底哪个字段不被接受
      // 注意：要从 retryRequest.messages 取（已经过 arguments 规范化），
      // 而不是 workingMessages（规范化前的旧引用）
      let reqBrief = '';
      try {
        const reqMsgs: any[] = Array.isArray(retryRequest.messages)
          ? retryRequest.messages
          : [];
        const tcs = reqMsgs
          .filter(
            (m: any) => m?.role === 'assistant' && Array.isArray(m.tool_calls)
          )
          .flatMap((m: any) =>
            m.tool_calls.map((tc: any) => {
              const argsStr =
                typeof tc?.function?.arguments === 'string'
                  ? tc.function.arguments
                  : '';
              // 试着 parse 一下，告诉我们 arguments 究竟是否是合法 JSON object
              let argsOk: 'json_object' | 'not_object' | 'invalid' = 'invalid';
              try {
                const p = JSON.parse(argsStr);
                argsOk =
                  p !== null && typeof p === 'object' && !Array.isArray(p)
                    ? 'json_object'
                    : 'not_object';
              } catch {
                argsOk = 'invalid';
              }
              return {
                id: tc?.id,
                name: tc?.function?.name,
                args_type: typeof tc?.function?.arguments,
                args_len: argsStr.length,
                args_ok: argsOk,
                args_head: argsStr.slice(0, 80),
              };
            })
          );
        const toolMsgs = reqMsgs
          .filter((m: any) => m?.role === 'tool')
          .map((m: any) => ({
            tool_call_id: m?.tool_call_id,
            content_type: typeof m?.content,
            content_len:
              typeof m?.content === 'string'
                ? m.content.length
                : Array.isArray(m?.content)
                  ? m.content.length
                  : -1,
          }));
        reqBrief = JSON.stringify({
          roles: reqMsgs.map((m: any) => m?.role),
          // 每条 message 的关键字段摘要：让我们能看出哪条出问题
          msgs_brief: reqMsgs.map((m: any, i: number) => ({
            i,
            role: m?.role,
            content_type:
              m?.content === null
                ? 'null'
                : Array.isArray(m?.content)
                  ? 'array'
                  : typeof m?.content,
            content_len:
              typeof m?.content === 'string'
                ? m.content.length
                : Array.isArray(m?.content)
                  ? m.content.length
                  : -1,
            content_head:
              typeof m?.content === 'string' ? m.content.slice(0, 60) : '',
            has_tool_calls:
              Array.isArray(m?.tool_calls) && m.tool_calls.length > 0,
            tool_calls_count: Array.isArray(m?.tool_calls)
              ? m.tool_calls.length
              : 0,
            has_tool_call_id: typeof m?.tool_call_id === 'string',
            extra_keys: Object.keys(m || {}).filter(
              (k) =>
                ![
                  'role',
                  'content',
                  'tool_calls',
                  'tool_call_id',
                  'name',
                ].includes(k)
            ),
          })),
          tool_calls: tcs,
          tool_msgs: toolMsgs,
          tools_in_request: Array.isArray(retryRequest.tools)
            ? retryRequest.tools.map((t: any) => t?.function?.name || t?.name)
            : undefined,
          // tools schema 摘要：让我们能比对 tool 声明字段
          tools_schema_brief: Array.isArray(retryRequest.tools)
            ? retryRequest.tools.map((t: any) => ({
                type: t?.type,
                name: t?.function?.name || t?.name,
                has_description: !!(t?.function?.description || t?.description),
                params_type:
                  t?.function?.parameters?.type || t?.input_schema?.type,
                params_keys: Object.keys(
                  t?.function?.parameters?.properties ||
                    t?.input_schema?.properties ||
                    {}
                ),
              }))
            : undefined,
          // 顶层请求字段诊断（model / tool_choice / temperature 等）
          top_keys: Object.keys(retryRequest || {}).filter(
            (k) => k !== 'messages'
          ),
          model: retryRequest.model,
          tool_choice: retryRequest.tool_choice,
        });
      } catch {}
      console.error(
        `[ir-intercept] retryWithRejection HTTP ${retryResp.status}, ` +
          `fallback to reject-text. upstream_body=${errBody} ` +
          `req_brief=${reqBrief}`
      );
      return null;
    }

    let retryJson: any;
    try {
      // 兼容两种响应：
      //   - 非流式 (stream:false)：直接 JSON
      //   - 流式 (stream:true，LongCat/某些 provider 仅支持流)：SSE 文本 → 聚合成 JSON
      const ctype = (retryResp.headers.get('content-type') || '').toLowerCase();
      const isSse =
        ctype.includes('text/event-stream') || retryRequest.stream === true;
      if (isSse) {
        const sseText = await retryResp.clone().text();
        if (format === 'openai') {
          const { aggregated } = aggregateOpenAIStream(sseText);
          retryJson = aggregated;
        } else {
          const { aggregated } = aggregateAnthropicStream(sseText);
          retryJson = aggregated;
        }
        console.log(
          `[ir-intercept] retryWithRejection attempt=${attempt} aggregated SSE -> ` +
            `json (${format}), choices_or_content=${
              format === 'openai'
                ? Array.isArray(retryJson?.choices)
                  ? retryJson.choices.length
                  : 0
                : Array.isArray(retryJson?.content)
                  ? retryJson.content.length
                  : 0
            }`
        );
      } else {
        retryJson = await retryResp.clone().json();
      }
    } catch (e) {
      console.error(
        '[ir-intercept] retryWithRejection parse response failed:',
        e
      );
      return null;
    }

    // 4) 检查新响应是否还含违规 tool_call
    if (!responseHasToolCalls(retryJson)) {
      console.log(
        `[ir-intercept] retryWithRejection attempt=${attempt} -> clean text response`
      );
      return retryJson;
    }
    const allowedSet = new Set<string>(allowedList);
    const nextViolations =
      format === 'openai'
        ? collectOpenAIViolations(retryJson, allowedSet)
        : collectAnthropicViolations(retryJson, allowedSet);
    if (nextViolations.length === 0) {
      console.log(
        `[ir-intercept] retryWithRejection attempt=${attempt} -> all tool_calls within whitelist`
      );
      return retryJson;
    }
    // 还有违规 → 继续下一轮
    workingAggregated = retryJson;
    workingViolations = nextViolations;
  }

  console.warn(
    `[ir-intercept] retryWithRejection exhausted ${maxRetries} attempts, ` +
      `last violations=${JSON.stringify(workingViolations)}`
  );
  return null;
}

/** OpenAI 协议：收集违规工具名（不改 json） */
function collectOpenAIViolations(json: any, allowed: Set<string>): string[] {
  const out: string[] = [];
  if (!json || !Array.isArray(json.choices)) return out;
  for (const ch of json.choices) {
    const tcs = ch?.message?.tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      const n = tc?.function?.name;
      if (typeof n === 'string' && !allowed.has(n)) out.push(n);
    }
  }
  return out;
}

/** Anthropic 协议：收集违规工具名（不改 json） */
function collectAnthropicViolations(json: any, allowed: Set<string>): string[] {
  const out: string[] = [];
  if (!json || !Array.isArray(json.content)) return out;
  for (const b of json.content) {
    if (b?.type === 'tool_use' && typeof b.name === 'string') {
      if (!allowed.has(b.name)) out.push(b.name);
    }
  }
  return out;
}

/**
 * 把 gatewayRequest.tools 过滤为只剩白名单工具，从源头阻断 LLM 再次选到违规工具。
 *   - OpenAI: tools 是 [{type:'function', function:{name, ...}}]
 *   - Anthropic: tools 是 [{name, ...}]
 *   - 找不到 tools 字段 / 形态不识别 → 返回 undefined（表示"不动它"）
 *   - 过滤完为空数组也照样返回（让 LLM 没有任何工具可选，强制走文本回答）
 */
function filterToolsToAllowed(
  gatewayRequest: any,
  allowedList: string[],
  format: StreamFormat
): any[] | undefined {
  const tools = gatewayRequest?.tools;
  if (!Array.isArray(tools)) return undefined;
  const allowed = new Set<string>(allowedList);
  if (format === 'openai') {
    return tools.filter((t: any) => {
      const name = t?.function?.name;
      return typeof name === 'string' && allowed.has(name);
    });
  }
  // anthropic
  return tools.filter((t: any) => {
    const name = t?.name;
    return typeof name === 'string' && allowed.has(name);
  });
}

/**
 * 清洗历史 messages 中"引用了非白名单工具"的 tool_call / tool_use，
 * 将其 mock 为一条 assistant 文本消息，避免 retry 请求里 messages 引用未在
 * 当前 tools 字段中声明的工具名，导致上游 400 invalid_arguments。
 *
 * 背景：
 *   - retry 时 filterToolsToAllowed 已把 tools 削为白名单，但原始 gatewayRequest.messages
 *     里可能已经包含了 Agent 多轮以来累积的 history，比如：
 *       [..., assistant{tool_calls:[exec]}, tool{tool_call_id:exec result}, ...]
 *     `exec` 已经不在白名单 → 上游严格校验拒绝。
 *   - 简单删除 assistant 会破坏对话连续性、可能让某些 user 上下文丢失依赖；
 *     正确做法是"mock 该工具调用的执行情况"：把这对 (assistant.tool_calls=exec, tool.result)
 *     替换为一条 assistant text 消息，告诉模型"上一轮该工具因 IR 拦截未实际执行"。
 *
 * OpenAI 处理：
 *   1) 遍历 messages，对每个 assistant 检查 tool_calls，把违规项摘出来
 *   2) 若 assistant.tool_calls 全部违规 → 把整条 assistant 改为 text content（删 tool_calls 字段）
 *   3) 若部分违规 → 仅保留合法 tool_calls；把违规工具调用信息追加到 assistant.content
 *   4) 后续 role:'tool' 且 tool_call_id 命中违规 → 整条丢弃
 *      （对应的"调用"已经被 mock 进 assistant text，不再需要 tool 结果）
 *
 * Anthropic 处理：
 *   - 类似：遍历 messages.content 中的 tool_use block，违规的转成 text 块；
 *     紧随其后的 user 消息里的 tool_result block，若 tool_use_id 命中违规则丢弃。
 */

/**
 * 合并 OpenAI messages 中连续相同 role 的相邻消息。
 *
 * 触发场景：sanitizeHistoryMessages 会把"违规 assistant.tool_calls"转为"纯文本 assistant"，
 * 并丢弃对应的 role:'tool' 消息，导致 [assistant_mock, assistant_next] 这种连续序列；
 * 或 [user, user_guidance] 连续序列。许多上游 provider (DeepSeek/Kimi/Doubao/智谱) 严格
 * 要求 messages 中相邻消息 role 不能相同，否则 400 invalid_arguments (code:3)。
 *
 * 合并规则：
 *   - role 相同 → 合并为一条
 *   - content: 字符串 + 字符串 → 用 "\n\n" 拼接；null/undefined 视为空串
 *   - tool_calls: 两条都有 → 合并数组（按 id 去重）；只有一条有 → 取该条；
 *   - 其它字段（name 等）保留前一条
 *   - tool 消息不参与合并（OpenAI 协议允许连续多条 tool）
 */
function mergeConsecutiveSameRoleOpenAI(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length <= 1) return messages;
  const out: any[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    // tool 消息间允许连续，不做合并
    if (
      prev &&
      m &&
      prev.role === m.role &&
      m.role !== 'tool' &&
      typeof m.role === 'string'
    ) {
      const prevContent = typeof prev.content === 'string' ? prev.content : '';
      const curContent = typeof m.content === 'string' ? m.content : '';
      const merged: any = { ...prev };
      const parts = [prevContent, curContent].filter((s) => s);
      merged.content =
        parts.length > 0
          ? parts.join('\n\n')
          : prev.content ?? m.content ?? null;

      // 合并 tool_calls（按 id 去重，没 id 的全保留）
      const prevTcs = Array.isArray(prev.tool_calls) ? prev.tool_calls : [];
      const curTcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (prevTcs.length || curTcs.length) {
        const seen = new Set<string>();
        const allTcs: any[] = [];
        for (const tc of [...prevTcs, ...curTcs]) {
          const id = typeof tc?.id === 'string' ? tc.id : '';
          if (id) {
            if (seen.has(id)) continue;
            seen.add(id);
          }
          allTcs.push(tc);
        }
        merged.tool_calls = allTcs;
        // OpenAI 规范：tool_calls 存在时 content 应为 null（即便我们拼了文本，
        // 也允许字符串 content，但部分严格 provider 仍要求 null）。这里若两条
        // 都没有任何文本内容，强制 null；否则保留字符串。
        if (!merged.content) merged.content = null;
      } else {
        // 没有 tool_calls 字段时，确保不要遗留前一条的 tool_calls
        delete merged.tool_calls;
      }
      out[out.length - 1] = merged;
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * 合并 Anthropic messages 中连续相同 role 的相邻消息。
 * Anthropic 的 content 是 block 数组（或字符串），合并时按数组拼接。
 */
function mergeConsecutiveSameRoleAnthropic(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length <= 1) return messages;
  const out: any[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && m && prev.role === m.role && typeof m.role === 'string') {
      const toBlocks = (c: any): any[] => {
        if (Array.isArray(c)) return c;
        if (typeof c === 'string' && c) return [{ type: 'text', text: c }];
        return [];
      };
      const merged: any = {
        ...prev,
        content: [...toBlocks(prev.content), ...toBlocks(m.content)],
      };
      out[out.length - 1] = merged;
    } else {
      out.push(m);
    }
  }
  return out;
}

function sanitizeHistoryMessages(
  messages: any[],
  allowedList: string[],
  format: StreamFormat
): any[] {
  const allowedSet = new Set<string>(allowedList);
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  if (format === 'openai') {
    // 第一遍：收集需要丢弃的 tool_call_id
    const droppedToolCallIds = new Set<string>();
    const cleaned: any[] = [];
    for (const m of messages) {
      if (
        m &&
        m.role === 'assistant' &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0
      ) {
        const violators: any[] = [];
        const keepers: any[] = [];
        for (const tc of m.tool_calls) {
          const name = tc?.function?.name;
          if (typeof name === 'string' && allowedSet.has(name)) {
            keepers.push(tc);
          } else {
            violators.push(tc);
            if (typeof tc?.id === 'string') droppedToolCallIds.add(tc.id);
          }
        }
        if (violators.length === 0) {
          cleaned.push(m);
          continue;
        }
        // 生成 mock 文本，描述被丢弃的 tool_call
        const mockLines = violators.map((tc: any) => {
          const name = tc?.function?.name || 'unknown';
          let args = tc?.function?.arguments;
          if (typeof args !== 'string') {
            try {
              args = JSON.stringify(args ?? {});
            } catch {
              args = '{}';
            }
          }
          // 截断超长 arguments 避免污染上下文
          const briefArgs =
            args.length > 200 ? args.slice(0, 200) + '...(truncated)' : args;
          return `\`${name}(${briefArgs})\``;
        });
        const mockText =
          `[IR 拦截 mock] 上一轮我尝试调用 ${mockLines.join('、')}，` +
          `但这些工具不在本轮 IR 白名单内，已被网关拦截，未实际执行。` +
          `本轮可用工具：${allowedList.length ? allowedList.join(', ') : '（无）'}。`;
        // 与原 assistant.content 合并（若有）
        const existing =
          typeof m.content === 'string' && m.content ? m.content + '\n\n' : '';
        if (keepers.length > 0) {
          // 部分违规：保留合法 tool_calls，把违规说明放到 content
          cleaned.push({
            ...m,
            content: existing + mockText,
            tool_calls: keepers,
          });
        } else {
          // 全部违规：完全去掉 tool_calls 字段，转纯文本 assistant
          const next: any = { ...m, content: existing + mockText };
          delete next.tool_calls;
          cleaned.push(next);
        }
      } else if (
        m &&
        m.role === 'tool' &&
        typeof m.tool_call_id === 'string' &&
        droppedToolCallIds.has(m.tool_call_id)
      ) {
        // 该 tool 消息对应的 tool_call 已被 mock 掉 → 整条丢弃
        continue;
      } else {
        cleaned.push(m);
      }
    }
    // **关键：合并连续相同 role 的消息**。
    // sanitize 会因为"丢弃 tool 消息"或"把违规 assistant.tool_calls 转纯文本"
    // 而产生 [assistant, assistant] / [user, user] 连续序列，许多上游 provider
    // (DeepSeek/Kimi/Doubao/智谱 等) 会以 `invalid arguments` (code:3) 返回 400。
    // 这里把它们合并成一条：tool_calls 取保留下来的合法集合，content 拼接。
    return mergeConsecutiveSameRoleOpenAI(cleaned);
  }

  // Anthropic
  const droppedToolUseIds = new Set<string>();
  const cleaned: any[] = [];
  for (const m of messages) {
    if (m && m.role === 'assistant' && Array.isArray(m.content)) {
      const newBlocks: any[] = [];
      const violators: any[] = [];
      for (const b of m.content) {
        if (b?.type === 'tool_use') {
          if (allowedSet.has(b.name)) {
            newBlocks.push(b);
          } else {
            violators.push(b);
            if (typeof b.id === 'string') droppedToolUseIds.add(b.id);
          }
        } else {
          newBlocks.push(b);
        }
      }
      if (violators.length > 0) {
        const mockLines = violators.map((b: any) => {
          let inp = b?.input;
          try {
            inp = JSON.stringify(inp ?? {});
          } catch {
            inp = '{}';
          }
          const briefArgs =
            typeof inp === 'string' && inp.length > 200
              ? inp.slice(0, 200) + '...(truncated)'
              : inp;
          return `\`${b?.name}(${briefArgs})\``;
        });
        const mockText =
          `[IR 拦截 mock] 上一轮我尝试调用 ${mockLines.join('、')}，` +
          `但这些工具不在本轮 IR 白名单内，已被网关拦截，未实际执行。` +
          `本轮可用工具：${allowedList.length ? allowedList.join(', ') : '（无）'}。`;
        newBlocks.push({ type: 'text', text: mockText });
      }
      cleaned.push({ ...m, content: newBlocks });
    } else if (m && m.role === 'user' && Array.isArray(m.content)) {
      // 过滤 user.content 中引用了被丢弃 tool_use 的 tool_result block
      const filtered = m.content.filter((b: any) => {
        if (b?.type !== 'tool_result') return true;
        return !droppedToolUseIds.has(b?.tool_use_id);
      });
      if (filtered.length === 0) {
        // 整条 user 都没东西了 → 丢弃，避免出现空消息
        continue;
      }
      cleaned.push({ ...m, content: filtered });
    } else {
      cleaned.push(m);
    }
  }
  return mergeConsecutiveSameRoleAnthropic(cleaned);
}

/**
 * 构造 retry messages：在原 history 末尾追加"上一轮 assistant tool_calls + tool_result(拒绝)"，
 * 但 **必须将违规的 tool_call 从 assistant.tool_calls 中剔除**——因为 retry 请求的 tools 字段
 * 已被 filterToolsToAllowed 过滤为仅白名单工具，若 assistant.tool_calls 还引用了未声明的工具，
 * 上游会以 `invalid arguments` 返回 400（实测复现：messages 里有 exec 的 tool_call/tool 结果，
 * 但 tools 字段只剩 safe_file_reader__read_directory → 400）。
 *
 * 策略：
 *   1) 净化 + 过滤掉违规的 tool_calls，只保留白名单内的合法 tool_calls；
 *   2) 若过滤后仍有合法 tool_calls：push 一条精简后的 assistant tool_calls 消息 +
 *      对应每个合法 tool 的 tool 结果消息（占位"已被中断"）；
 *   3) 若过滤后没有任何合法 tool_calls：完全不 push assistant 消息，避免空 tool_calls；
 *   4) 无论是 2) 还是 3)，最后都追加一条 user 文本消息，明确告诉模型上轮哪些工具被拒、
 *      建议改用哪些白名单工具，引导模型重新决策。
 */
function pushAssistantAndToolResults(
  messages: any[],
  aggregated: any,
  violations: string[],
  allowedList: string[],
  format: StreamFormat
): any[] {
  const result = [...messages];
  const violationSet = new Set(violations);
  const allowedSet = new Set(allowedList);
  const hint = allowedList.length ? allowedList.join(', ') : '（无）';
  const rejectedHint = violations.length ? violations.join(', ') : '（无）';
  const guidance =
    `[IR 拦截] 上一轮你选择的工具 \`${rejectedHint}\` 不在本轮 IR 白名单内，已被网关拒绝。` +
    `本轮唯一可用工具：${hint}。请基于该工具重新规划并直接调用它来完成用户的原始任务，` +
    `不要再尝试 \`${rejectedHint}\`。`;

  if (format === 'openai') {
    const choice = aggregated?.choices?.[0];
    const msg = choice?.message;
    const rawTcs: any[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    // 仅保留白名单内（即"未违规"）的 tool_calls，并做协议净化
    const keptTcs = rawTcs
      .filter(
        (tc: any) =>
          tc?.function?.name &&
          allowedSet.has(tc.function.name) &&
          !violationSet.has(tc.function.name)
      )
      .map((tc: any, i: number) => {
        let args = tc?.function?.arguments;
        if (typeof args !== 'string') {
          try {
            args = JSON.stringify(args ?? {});
          } catch {
            args = '{}';
          }
        }
        try {
          JSON.parse(args);
        } catch {
          args = '{}';
        }
        const id =
          typeof tc?.id === 'string' && tc.id
            ? tc.id
            : `call_ir_${Date.now()}_${i}`;
        return {
          id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: args,
          },
        };
      });

    if (keptTcs.length > 0) {
      // OpenAI 规范：assistant 有 tool_calls 时 content 必须为 null
      result.push({ role: 'assistant', content: null, tool_calls: keptTcs });
      for (const tc of keptTcs) {
        result.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `[IR 拦截] 本轮已被中断，工具 \`${tc.function.name}\` 未执行。请在下一条 user 消息的指引下继续。`,
        });
      }
    }
    // 关键：追加 user 文本提示，无论是否保留了合法 tool_call
    // （openai 协议允许 tool 之后直接接 user，让模型重新决策）
    result.push({ role: 'user', content: guidance });
  } else {
    // Anthropic：assistant.content 是 block 数组；过滤掉违规的 tool_use block
    const rawBlocks: any[] = Array.isArray(aggregated?.content)
      ? aggregated.content
      : [];
    const keptBlocks = rawBlocks.filter((b: any) => {
      if (!b || typeof b !== 'object') return false;
      if (b.type === 'tool_use') {
        return allowedSet.has(b.name) && !violationSet.has(b.name);
      }
      // 保留 text 等非 tool_use 内容（assistant 的思考文本）
      return true;
    });
    const hasToolUse = keptBlocks.some((b: any) => b?.type === 'tool_use');

    if (keptBlocks.length > 0) {
      result.push({ role: 'assistant', content: keptBlocks });
      if (hasToolUse) {
        const toolResults: any[] = [];
        for (const b of keptBlocks) {
          if (b?.type !== 'tool_use') continue;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: b.id,
            content: `[IR 拦截] 本轮已被中断，工具 \`${b.name}\` 未执行。请按下文指引重新规划。`,
            is_error: false,
          });
        }
        // Anthropic 把 tool_result 放在 user 消息里，并和引导文本拼到同一个 user 消息
        toolResults.push({ type: 'text', text: guidance });
        result.push({ role: 'user', content: toolResults });
      } else {
        result.push({ role: 'user', content: guidance });
      }
    } else {
      result.push({ role: 'user', content: guidance });
    }
  }
  return result;
}

/**
 * 把一段非流式的 OpenAI chatCompletion JSON 重新构造成 SSE 流文本，
 * 让下游 Agent 仍然按"流式"姿势消费。这里做得很简单：一次性发完。
 */
function rebuildOpenAIStreamFromJson(json: any): string {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const id = json.id || `chatcmpl-ir-${Date.now()}`;
  const model = json.model || 'ir-intercept';
  const created = json.created || Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model };
  const chunks: string[] = [];
  // 1) 开头 role 块
  chunks.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [
        { index: 0, delta: { role: 'assistant' }, finish_reason: null },
      ],
    })}\n\n`
  );
  // 2) tool_calls 块（若有）
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    const tcs = msg.tool_calls.map((tc: any, i: number) => ({
      index: i,
      id: tc.id,
      type: tc.type || 'function',
      function: {
        name: tc.function?.name,
        arguments: tc.function?.arguments || '',
      },
    }));
    chunks.push(
      `data: ${JSON.stringify({
        ...base,
        choices: [
          { index: 0, delta: { tool_calls: tcs }, finish_reason: null },
        ],
      })}\n\n`
    );
  }
  // 3) content 块（若有）
  if (typeof msg.content === 'string' && msg.content) {
    chunks.push(
      `data: ${JSON.stringify({
        ...base,
        choices: [
          { index: 0, delta: { content: msg.content }, finish_reason: null },
        ],
      })}\n\n`
    );
  }
  // 4) 结尾 finish_reason
  chunks.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason:
            choice.finish_reason ||
            (msg.tool_calls?.length ? 'tool_calls' : 'stop'),
        },
      ],
    })}\n\n`
  );
  chunks.push(`data: [DONE]\n\n`);
  return chunks.join('');
}

/**
 * 把一段非流式的 Anthropic messages JSON 重新构造成 SSE 流文本。
 */
function rebuildAnthropicStreamFromJson(json: any): string {
  const msgId = json.id || `msg_ir_${Date.now()}`;
  const model = json.model || 'ir-intercept';
  const blocks = Array.isArray(json.content) ? json.content : [];
  const chunks: string[] = [];
  chunks.push(
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: json.usage || { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`
  );
  blocks.forEach((b: any, idx: number) => {
    if (b.type === 'text') {
      chunks.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'text', text: '' },
        })}\n\n`
      );
      chunks.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text: b.text || '' },
        })}\n\n`
      );
    } else if (b.type === 'tool_use') {
      chunks.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: idx,
          content_block: {
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input: {},
          },
        })}\n\n`
      );
      chunks.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: idx,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(b.input || {}),
          },
        })}\n\n`
      );
    }
    chunks.push(
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: idx,
      })}\n\n`
    );
  });
  chunks.push(
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: {
        stop_reason: json.stop_reason || 'end_turn',
        stop_sequence: null,
      },
      usage: json.usage || { output_tokens: 0 },
    })}\n\n`
  );
  chunks.push(
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
  );
  return chunks.join('');
}

/**
 * 包装一个已经经过 portkey transform 的 SSE Response：
 *   - 先 buffer 整段流
 *   - 还原 JSON，做 IR 白名单判定
 *   - 命中 → 替换为合成的拒绝 SSE 流，并 fire-and-forget 上报事件
 *   - 未命中 → 重放原 chunk
 *
 * 失败/异常 → 重放原 chunk（绝不影响主链路）。
 */
export function wrapStreamingResponseWithIRIntercept(
  response: Response,
  fn: string | undefined,
  gatewayRequest: any,
  c?: any,
  providerOption?: any,
  requestHeaders?: Record<string, string>
): Response {
  const format = streamFormatFromFn(fn);
  if (!format) return response; // 非 chat / messages 形态，不介入
  if (!response.body) return response;

  // 若已处于内部代发上下文，直接放行，避免递归包装。
  if (c && typeof c.get === 'function') {
    try {
      if (c.get('__ir_internal_retry')) {
        return response;
      }
    } catch {}
  }

  const upstream = response.body;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  (async () => {
    let buffered = '';
    const reader = upstream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
      }
    } catch (e) {
      console.error('[ir-intercept] streaming read failed:', e);
      // 把已经 buffer 的部分原样吐出（尽量不丢字）
      try {
        if (buffered) await writer.write(encoder.encode(buffered));
      } finally {
        await writer.close();
      }
      return;
    }

    let replayed = false;
    try {
      // 快速旁路：开关关闭则直接放行
      const enabled = await isInterceptEnabled();
      if (!enabled) {
        await writer.write(encoder.encode(buffered));
        replayed = true;
        return;
      }
      // 聚合 + 判定
      let aggregated: any;
      if (format === 'openai') {
        aggregated = aggregateOpenAIStream(buffered).aggregated;
      } else {
        aggregated = aggregateAnthropicStream(buffered).aggregated;
      }
      if (!responseHasToolCalls(aggregated)) {
        await writer.write(encoder.encode(buffered));
        replayed = true;
        return;
      }
      const userQuery =
        extractLastUserQueryOpenAI(gatewayRequest) ||
        extractLastUserQueryAnthropic(gatewayRequest);

      // 使用 latest_round_id（在 round_start 或 round_ir_ready 时设置）
      const roundId = _latestRoundId;
      if (!roundId) {
        console.log(
          `[ir-intercept] (stream) ⏭️ No latest_round_id available - ALLOW`
        );
        await writer.write(encoder.encode(buffered));
        replayed = true;
        return;
      }

      // 获取 IR（从缓存或等待 webhook 推送）
      const irData = await getIR(roundId);

      // 情况1：无 IR 或开关关闭 → 放行
      if (!irData) {
        console.log(
          `[ir-intercept] (stream) ⏭️ No IR or timeout - ALLOW\n` +
            `   round_id: ${roundId}`
        );
        await writer.write(encoder.encode(buffered));
        replayed = true;
        return;
      }

      const allowedList = irData.allowed_tools || [];
      const allowed = new Set<string>(allowedList);

      // [loop-breaker] 死循环熔断检测
      const lbEnabled = true; // 默认启用
      const lbThreshold = LOOP_THRESHOLD; // 默认阈值
      let loopOffenders: Array<{ tool: string; hash: string; count: number }> =
        [];
      if (lbEnabled) {
        loopOffenders =
          format === 'openai'
            ? bumpAndDetectLoopOpenAI(roundId, aggregated, lbThreshold)
            : bumpAndDetectLoopAnthropic(roundId, aggregated, lbThreshold);
      }

      // 仅"收集"违规，不修改 aggregated —— 否则 retryWithRejection 拿到的
      // assistant tool_calls 会被清空，导致 LLM 收不到"哪个工具被拒"的信号，
      // 3 轮 retry 都会重新随便选另一个工具，根本无法收敛。
      let violations: string[] =
        format === 'openai'
          ? collectOpenAIViolations(aggregated, allowed)
          : collectAnthropicViolations(aggregated, allowed);

      // 诊断：聚合后 LLM 实际请求了哪些工具
      const aggregatedToolNames =
        format === 'openai'
          ? (aggregated?.choices?.[0]?.message?.tool_calls || []).map(
              (tc: any) => tc?.function?.name
            )
          : (aggregated?.content || [])
              .filter((b: any) => b?.type === 'tool_use')
              .map((b: any) => b?.name);

      // 详细日志：LLM 返回解析和白名单匹配
      console.log(
        `[ir-intercept] (stream) LLM response analysis round=${roundId} format=${format}:` +
          ` LLM requested tools: [${aggregatedToolNames.join(', ')}],` +
          ` Allowed tools: [${allowedList.join(', ')}],` +
          ` Violations: [${violations.join(', ')}],` +
          ` Loop breaker: enabled=${lbEnabled}, threshold=${lbThreshold}`
      );

      // 没有 violations 也没有熔断 → 原样放行
      if (violations.length === 0 && loopOffenders.length === 0) {
        console.log(
          `[ir-intercept] (stream) Decision: ALLOW - all tools in whitelist, round=${roundId}`
        );
        await writer.write(encoder.encode(buffered));
        replayed = true;
        return;
      }

      // [loop-breaker] 触发：跳过 retry，直接构造 loop_break 拒绝文本
      let synth: string | null = null;
      let retried = false;
      let retriedClean = false;
      let loopBroken = false;

      if (loopOffenders.length > 0) {
        loopBroken = true;
        console.warn(
          `[ir-intercept] (stream) Decision: LOOP_BREAK - detected infinite loop, round=${roundId}` +
            ` Offenders: [${loopOffenders.map((o) => `${o.tool}(x${o.count})`).join(', ')}]` +
            ` Requested tools: [${aggregatedToolNames.join(', ')}]`
        );
        const rejectText = buildLoopBreakerMessage(loopOffenders);
        synth =
          format === 'openai'
            ? rebuildOpenAIStreamFromJson({
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: rejectText },
                    finish_reason: 'stop',
                  },
                ],
                id: `chatcmpl-loopbrk-${Date.now()}`,
                model: 'ir-intercept-loopbreaker',
                created: Math.floor(Date.now() / 1000),
              })
            : rebuildAnthropicStreamFromJson({
                id: `msg-loopbrk-${Date.now()}`,
                type: 'message',
                role: 'assistant',
                model: 'ir-intercept-loopbreaker',
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: rejectText }],
              });
      }

      if (!loopBroken && violations.length > 0) {
        console.log(
          `[ir-intercept] (stream) violations detected round=${roundId} ` +
            `format=${format} allowed=${JSON.stringify(allowedList)} ` +
            `aggregated_tools=${JSON.stringify(aggregatedToolNames)} ` +
            `violations=${JSON.stringify(violations)}`
        );
      }

      // 命中拦截。优先方案 A：网关代发请求，让 LLM 用合法工具完成任务，
      // 失败时回退到方案 B：吐合成"拒绝消息"流。
      // 注意：若已被 loop-breaker 熔断，跳过 retry 直接吐 synth。
      if (!loopBroken && c && providerOption && fn) {
        try {
          const retryJson = await retryWithRejection({
            c,
            providerOption,
            requestHeaders: requestHeaders || {},
            fn: fn as string,
            format,
            gatewayRequest,
            aggregated,
            violations,
            allowedList,
            maxRetries: 3,
          });
          retried = true;
          if (retryJson) {
            retriedClean = true;
            synth =
              format === 'openai'
                ? rebuildOpenAIStreamFromJson(retryJson)
                : rebuildAnthropicStreamFromJson(retryJson);
          }
        } catch (e) {
          console.error(
            '[ir-intercept] retryWithRejection threw, fallback to reject-text:',
            e
          );
        }
      } else if (!loopBroken) {
        console.warn(
          '[ir-intercept] retryWithRejection unavailable (missing c/providerOption/fn), ' +
            'fallback to reject-text stream'
        );
      }

      // 回退：合成"拒绝消息"流
      if (!synth) {
        console.log(
          `[ir-intercept] (stream) 🚫 Sending REJECTION message (retry exhausted or unavailable)`
        );
        const rejectText = buildRejectMessage(
          violations.join(', '),
          allowedList
        );
        synth =
          format === 'openai'
            ? buildOpenAIRejectStream(
                rejectText,
                aggregated?.id || '',
                aggregated?.model || ''
              )
            : buildAnthropicRejectStream(
                rejectText,
                aggregated?.id || '',
                aggregated?.model || ''
              );
      }
      await writer.write(encoder.encode(synth));
      replayed = true;

      console.log(
        `[ir-intercept] (stream) round=${roundId} allowed=${allowedList.length} ` +
          `violations=${JSON.stringify(violations)} ` +
          `loop_broken=${loopBroken} ` +
          `retried=${retried} retried_clean=${retriedClean} -> rewrote stream`
      );
      reportInterceptEvent({
        event_type: loopBroken ? 'ir_loop_break' : 'ir_tool_block',
        protocol: format,
        turn_key: roundId,
        user_query: userQuery,
        // loop_break 时把 offender tool 名称作为 violations 上报，便于前端展示
        violations: loopBroken ? loopOffenders.map((o) => o.tool) : violations,
        allowed_tools: allowedList,
        source: 'portkey-gateway',
        extra: {
          streaming: true,
          retried,
          retried_clean: retriedClean,
          loop_break: loopBroken || undefined,
          loop_break_threshold: loopBroken ? lbThreshold : undefined,
          loop_break_offenders: loopBroken
            ? loopOffenders.map((o) => ({ tool: o.tool, count: o.count }))
            : undefined,
        },
      });
    } catch (e) {
      console.error('[ir-intercept] streaming intercept failed:', e);
      if (!replayed) {
        try {
          await writer.write(encoder.encode(buffered));
        } catch (e2) {
          console.error('[ir-intercept] failed to replay buffered stream:', e2);
        }
      }
    } finally {
      try {
        await writer.close();
      } catch {}
    }
  })();

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ─── IR Cache & Webhook Handler ──────────────────────────────────────────
// 通过 webhook 接收 IR 并缓存，供拦截逻辑使用

// IR 缓存：round_id -> IR 数据
const _irCache = new Map<
  string,
  {
    ir: any;
    allowedTools: string[];
    timestamp: number;
  }
>();
// 等待 IR 的 Promise：round_id -> resolve 函数
const _irWaiters = new Map<
  string,
  {
    resolve: (ir: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();
// 最新的 round_id（在 round_start 或 round_ir_ready 时更新）
let _latestRoundId: string | null = null;
// 缓存 TTL：5 分钟
const IR_CACHE_TTL_MS = 5 * 60 * 1000;
// 等待超时：默认 30 秒

interface PushEvent {
  push_type: string;
  round_id?: string;
  ir_json?: string;
  push_time?: string;
}

/**
 * 从 IR JSON 中提取允许的工具列表
 */
function extractAllowedToolsFromIR(irJson: string): string[] {
  try {
    const ir = JSON.parse(irJson);
    const tools = new Set<string>();
    const level2 = ir.level2?.policies || [];
    for (const pol of level2) {
      if (pol.effect !== 'allow') continue;
      for (const obj of pol.objects || []) {
        if (obj.type === 'tool' && obj.identifier) {
          tools.add(obj.identifier);
        }
      }
    }
    return Array.from(tools);
  } catch (e) {
    console.error('[ir-intercept] Failed to parse IR JSON:', e);
    return [];
  }
}

/**
 * 处理 clawAVC 推送的 webhook 事件
 * @param body 推送内容
 */
export function handlePushEvent(body: PushEvent): void {
  console.log(
    `[ir-intercept] 📩 Webhook received:\n` +
      `   push_type: ${body.push_type}\n` +
      `   round_id: ${body.round_id || 'N/A'}\n` +
      `   ir_json_length: ${body.ir_json ? body.ir_json.length : 0}`
  );

  // 根据 push_type 处理不同事件
  switch (body.push_type) {
    case 'round_ir_ready':
      if (body.round_id && body.ir_json) {
        const allowedTools = extractAllowedToolsFromIR(body.ir_json);

        // 更新 latest_round_id
        _latestRoundId = body.round_id;

        // 缓存 IR
        _irCache.set(body.round_id, {
          ir: JSON.parse(body.ir_json),
          allowedTools,
          timestamp: Date.now(),
        });

        console.log(
          `[ir-intercept] ✅ IR cached for round=${body.round_id}\n` +
            `   allowed_tools: [${allowedTools.join(', ')}]`
        );

        // 直接使用 round_id 唤醒等待中的 Promise
        const waiter = _irWaiters.get(body.round_id);
        if (waiter) {
          console.log(
            `[ir-intercept] 🔔 Waking up waiter for round=${body.round_id}`
          );
          clearTimeout(waiter.timer);
          _irWaiters.delete(body.round_id);
          waiter.resolve({
            ir: JSON.parse(body.ir_json),
            allowed_tools: allowedTools,
          });
        } else {
          console.log(
            `[ir-intercept] ⏸️ No waiter for round=${body.round_id}, IR cached for later use`
          );
        }
      }
      break;

    case 'round_start':
      if (body.round_id) {
        _latestRoundId = body.round_id;
        console.log(`[ir-intercept] 🚀 Round started: ${body.round_id}`);
      }
      break;

    case 'round_end':
      if (body.round_id) {
        console.log(`[ir-intercept] 🏁 Round ended: ${body.round_id}`);
        // 清理缓存
        _irCache.delete(body.round_id);
        // 清理等待者
        _irWaiters.delete(body.round_id);
        // 如果结束的是当前最新的 round，清空 latest_round_id
        if (_latestRoundId === body.round_id) {
          _latestRoundId = null;
        }
      }
      break;

    default:
      console.log(`[ir-intercept] 📋 Unknown push_type: ${body.push_type}`);
  }

  // 清理过期缓存
  cleanupExpiredCache();
}

/**
 * 清理过期的 IR 缓存
 */
function cleanupExpiredCache(): void {
  const now = Date.now();
  for (const [roundId, entry] of _irCache) {
    if (now - entry.timestamp > IR_CACHE_TTL_MS) {
      _irCache.delete(roundId);
      console.log(`[ir-intercept] 🗑️ Cache expired: round=${roundId}`);
    }
  }
}

/**
 * 等待 IR 就绪（带超时）
 * @param roundId round 标识
 * @returns IR 数据，超时返回 null
 */
async function waitForIR(roundId: string): Promise<any | null> {
  console.log(`[ir-intercept] ⏳ Waiting for IR: round=${roundId}`);

  // 先检查缓存
  const cached = _irCache.get(roundId);
  if (cached) {
    console.log(`[ir-intercept] ✅ IR found in cache: round=${roundId}`);
    return cached;
  }

  // 创建等待 Promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.warn(
        `[ir-intercept] ⏰ IR wait timeout (${IR_WAIT_TIMEOUT_MS / 1000}s): round=${roundId}, bypass`
      );
      _irWaiters.delete(roundId);
      resolve(null); // 超时返回 null，让调用方放行
    }, IR_WAIT_TIMEOUT_MS);

    _irWaiters.set(roundId, { resolve, reject, timer });
    console.log(
      `[ir-intercept] ⏳ Added waiter: round=${roundId}, timeout=${IR_WAIT_TIMEOUT_MS / 1000}s`
    );
  });
}

/**
 * 获取 IR（优先从缓存，fallback 等待）
 */
async function getIR(
  roundId: string
): Promise<{ ir: any; allowed_tools: string[] } | null> {
  // 1. 先检查缓存
  const cached = _irCache.get(roundId);
  if (cached) {
    return {
      ir: cached.ir,
      allowed_tools: cached.allowedTools,
    };
  }

  // 2. 等待 webhook 推送
  const result = await waitForIR(roundId);
  if (!result) {
    return null; // 超时，放行
  }

  return result;
}
