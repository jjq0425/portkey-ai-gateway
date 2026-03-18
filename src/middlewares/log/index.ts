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
      '/public/api/local-gateway',
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

async function getResponsePayload(c: Context, requestOptionsArray: any[] = []) {
  if (requestOptionsArray[0]?.requestParams?.stream) {
    return { message: 'The response was a stream.' };
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
