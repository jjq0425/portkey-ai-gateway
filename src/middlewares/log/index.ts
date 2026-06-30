import { Context } from 'hono';
import { getRuntimeKey } from 'hono/adapter';

let logId = 0;
const MAX_RESPONSE_LENGTH = 100000;

function getLogsDir() {
  return process.env.PORTKEY_LOGS_DIR || 'logs';
}

// Map to store all connected log clients
const logClients: Map<string | number, any> = new Map();

const addLogClient = (clientId: any, client: any) => {
  logClients.set(clientId, client);
};

const removeLogClient = (clientId: any) => {
  logClients.delete(clientId);
};

export function shouldLogRequest(url: string) {
  try {
    const { pathname } = new URL(url);

    return ![
      '/',
      '/public',
      '/public/',
      '/public/logs',
      '/public/models',
      '/public/mcp',
      '/public/keys',
      '/public/api/local-gateway',
      '/public/api/local-gateway/keys',
      '/public/api/logs',
      '/log/stream',
      '/favicon.ico',
    ].some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
  } catch {
    return !url.includes('/public') && !url.includes('/log/stream');
  }
}

export function getDisplayEndpoint(url: string) {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.pathname}${parsedUrl.search}`;
  } catch {
    return url;
  }
}

export function getLogsFilename(date = new Date()) {
  return `${date.toISOString().slice(0, 10)}.jsonl`;
}

/**
 * 尝试从 SSE 风格的 preview 字符串中提取最终文本。
 * 支持格式：重复的 "data: {json}" 块，优先返回最后一个块的 top-level `content` 字段，
 * 否则按 `choices[*].content` 或 `choices[*].delta.content` 顺序拼接。
 */
export function extractTextFromSSEPreview(preview: string): string | null {
  if (!preview || typeof preview !== 'string') return null;
  // 将事件按空行分割（每个事件通常以双换行结束）
  const events = preview.split(/\r?\n\r?\n/).map((s) => s.trim()).filter(Boolean);
  const parsed: any[] = [];

  for (const ev of events) {
    // 收集所有以 data: 开头的行并尝试解析 JSON
    const lines = ev.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const jsonPart = line.slice(5).trim();
      try {
        const obj = JSON.parse(jsonPart);
        parsed.push(obj);
      } catch {
        // 忽略无法解析的片段
      }
    }
  }

  if (!parsed.length) return null;

  // 优先返回最后一个对象的 top-level content
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i];
    if (p && typeof p.content === 'string' && p.content) return p.content;
  }

  // 否则，尝试拼接 delta 或 choices 中的 content
  const parts: string[] = [];
  for (const p of parsed) {
    if (!p) continue;
    if (Array.isArray(p.choices) && p.choices.length) {
      const c0 = p.choices[0];
      if (c0) {
        // delta.content 优先
        if (c0.delta && typeof c0.delta.content === 'string') {
          parts.push(c0.delta.content);
          continue;
        }
        if (typeof c0.content === 'string') {
          parts.push(c0.content);
          continue;
        }
      }
    }
    // fallback: top-level content field
    if (typeof p.content === 'string') parts.push(p.content);
  }

  if (parts.length) return parts.join('');
  return null;
}

async function getResponsePayload(c: Context, requestOptionsArray: any[] = []) {
  if (requestOptionsArray[0]?.requestParams?.stream) {
    // 尝试为 stream 返回一个短的预览（不会尝试消费过多数据）
    try {
      const cloned = c.res.clone();

      // 如果是 web ReadableStream
      const body: any = (cloned as any).body;
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        const maxBytes = 64 * 1024; // 限制为 64KB 预览，尽量抓完整流
        let total = 0;
        const finalRegex = /"lastOne"\s*:\s*true|"finish_reason"\s*:\s*"(?!null)\w+"/;
        let decodedSoFar = '';
        while (true) {
          // 以非阻塞方式读取首个可用 chunk
          // 读取下一块，若超出长度或结束则停止
          // 注意：对于无限流，这里只会读取有限数据
          // eslint-disable-next-line no-await-in-loop
          const { value, done } = await reader.read();
          if (done || !value) break;
          const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
          chunks.push(u8);
          total += u8.length;
          // 及时解码当前已读内容并检测是否包含 final 标志
          try {
            decodedSoFar = new TextDecoder().decode(concat(chunks));
          } catch {
            decodedSoFar = '';
          }
          if (finalRegex.test(decodedSoFar)) {
            break;
          }
          if (total >= maxBytes) break;
        }
        const concat = (arrs: Uint8Array[]) => {
          const tot = arrs.reduce((s, a) => s + a.length, 0);
          const out = new Uint8Array(tot);
          let off = 0;
          for (const a of arrs) {
            out.set(a, off);
            off += a.length;
          }
          return out;
        };
        const text = decodedSoFar || new TextDecoder().decode(concat(chunks));
        // 如果是 SSE 风格的 data: {...}\n\n 拼接，尝试解析并提取最终的完整文本。
        try {
          const final = extractTextFromSSEPreview(text);
          if (final) return { stream: true, preview: final };
        } catch {
          // ignore and return raw preview
        }
        return { stream: true, preview: text };
      }

      // 退回到尝试读取为文本（带超时保护）
      const txtPromise = (async () => {
        try {
          return await (cloned as any).text();
        } catch (e) {
          try {
            return JSON.stringify(await (cloned as any).json());
          } catch {
            return null;
          }
        }
      })();

      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('preview-timeout')), 500));
      // eslint-disable-next-line no-unsafe-optional-chaining
      const txt = await Promise.race([txtPromise, timeout]).catch(() => null);
      if (typeof txt === 'string' && txt) {
        // 尝试从可能包含 data: JSON 的预览中提取最终文本
        try {
          const final = extractTextFromSSEPreview(txt);
          if (final) return { stream: true, preview: final };
        } catch {}
        return { stream: true, preview: txt.slice(0, 2000) };
      }
      return { message: 'The response was a stream.' };
    } catch (e: any) {
      return { message: 'The response was a stream.', error: String(e) };
    }
  }

  try {
    return await c.res.clone().json();
  } catch {
    try {
      return await c.res.clone().text();
    } catch {
      return null;
    }
  }
}

export function truncateResponsePayload(responsePayload: any) {
  const responseString = JSON.stringify(responsePayload);

  if (responseString.length > MAX_RESPONSE_LENGTH) {
    return responseString.substring(0, MAX_RESPONSE_LENGTH) + '...';
  }

  return responsePayload;
}

export function createLogEntry({
  time = new Date().toLocaleString(),
  sourceType,
  method,
  endpoint,
  status,
  duration,
  requestOptions = [],
  response,
}: {
  time?: string;
  sourceType?: 'gateway' | 'mcp';
  method: string;
  endpoint: string;
  status: number;
  duration: number;
  requestOptions?: any[];
  response?: any;
}) {
  return {
    time,
    sourceType,
    method,
    endpoint,
    status,
    duration,
    requestOptions,
    response,
  };
}

export async function persistLogEntry(logEntry: Record<string, any>) {
  const { appendFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const logsDir = getLogsDir();
  await mkdir(logsDir, { recursive: true });
  const logFilePath = join(logsDir, getLogsFilename());
  await appendFile(logFilePath, JSON.stringify(logEntry) + '\n', 'utf8');
}

export async function readPersistedLogEntries(limit = 100) {
  const { mkdir, readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const logsDir = getLogsDir();
  await mkdir(logsDir, { recursive: true });

  const logFiles = (await readdir(logsDir))
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .sort()
    .reverse();

  const entries: Record<string, any>[] = [];

  for (const fileName of logFiles) {
    const fileContent = await readFile(join(logsDir, fileName), 'utf8');
    const lines = fileContent
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse();

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Ignore malformed log lines so one bad entry doesn't break the UI.
      }

      if (entries.length >= limit) {
        return entries.slice(0, limit);
      }
    }
  }

  return entries.slice(0, limit);
}

export async function clearPersistedLogs() {
  const { mkdir, readdir, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const logsDir = getLogsDir();
  await mkdir(logsDir, { recursive: true });

  const logFiles = (await readdir(logsDir)).filter((fileName) =>
    fileName.endsWith('.jsonl')
  );

  await Promise.all(
    logFiles.map((fileName) => rm(join(logsDir, fileName), { force: true }))
  );

  return { deletedCount: logFiles.length };
}

export function getLogSourceType(endpoint: string) {
  return [
    '/v1/',
    '/chat/completions',
    '/completions',
    '/embeddings',
    '/responses',
    '/models',
  ].some((prefix) => endpoint.startsWith(prefix))
    ? 'gateway'
    : 'mcp';
}

const broadcastLog = async (log: any) => {
  const message = {
    data: log,
    event: 'log',
    id: String(logId++),
  };

  const deadClients: any = [];

  // Run all sends in parallel
  await Promise.all(
    Array.from(logClients.entries()).map(async ([id, client]) => {
      try {
        await Promise.race([
          client.sendLog(message),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Send timeout')), 1000)
          ),
        ]);
      } catch (error: any) {
        console.error(`Failed to send log to client ${id}:`, error.message);
        deadClients.push(id);
      }
    })
  );

  // Remove dead clients after iteration
  deadClients.forEach((id: any) => {
    removeLogClient(id);
  });
};

async function processLog(c: Context, start: number) {
  const ms = Date.now() - start;
  if (!shouldLogRequest(c.req.url)) return;

  const requestOptionsArray = c.get('requestOptions') ?? [];

  try {
    const responsePayload = truncateResponsePayload(
      await getResponsePayload(c, requestOptionsArray)
    );

    if (requestOptionsArray.length) {
      requestOptionsArray[0].response = responsePayload;
    }

    const logEntry = createLogEntry({
      sourceType: getLogSourceType(getDisplayEndpoint(c.req.url)),
      method: c.req.method,
      endpoint: getDisplayEndpoint(c.req.url),
      status: c.res.status,
      duration: ms,
      requestOptions: requestOptionsArray,
      response: responsePayload,
    });

    if (getRuntimeKey() === 'node') {
      await persistLogEntry(logEntry);
    }

    await broadcastLog(JSON.stringify(logEntry));
  } catch (error) {
    console.error('Error processing log:', error);
  }
}

export const logHandler = () => {
  return async (c: Context, next: any) => {
    c.set('addLogClient', addLogClient);
    c.set('removeLogClient', removeLogClient);

    const start = Date.now();

    await next();

    const runtime = getRuntimeKey();

    if (runtime == 'workerd') {
      c.executionCtx.waitUntil(processLog(c, start));
    } else if (['node', 'bun', 'deno'].includes(runtime)) {
      processLog(c, start).then().catch(console.error);
    }
  };
};
