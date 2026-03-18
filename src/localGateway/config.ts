import { getRuntimeKey } from 'hono/adapter';
import { VALID_PROVIDERS } from '../globals';
import { Options } from '../types/requestBody';

export interface LocalGatewayModelConfigEntry {
  provider: string;
  upstreamModel: string;
  providerApiKey?: string;
  providerApiKeyEnv?: string;
  displayName?: string;
  description?: string;
}

export interface LocalGatewayMcpConfigEntry {
  routePath: string;
  targetUrl: string;
  displayName?: string;
  description?: string;
  headers?: Record<string, string>;
}

export interface LocalGatewayConfig {
  version: number;
  generatedAt: string;
  gatewayKeys: string[];
  models: Record<string, LocalGatewayModelConfigEntry>;
  mcpServers: Record<string, LocalGatewayMcpConfigEntry>;
}

export interface LocalGatewayResolution {
  alias: string;
  providerConfig: Options;
  upstreamModel: string;
}

export interface LocalGatewayMcpResolution {
  alias: string;
  routePath: string;
  targetUrl: string;
  displayName?: string;
  description?: string;
  headers: Record<string, string>;
}

const LOCAL_GATEWAY_FILE_ENV = 'LOCAL_GATEWAY_CONFIG_PATH';
const DEFAULT_CONFIG_DIR = '.portkey';
const DEFAULT_CONFIG_FILE = 'local-gateway.config.json';
const LOCAL_RUNTIME_ONLY_MESSAGE =
  'Local gateway model aliases are only available in the node runtime.';

function isNodeRuntime() {
  return getRuntimeKey() === 'node' && typeof process !== 'undefined';
}

function getConfigPath() {
  const customPath = process.env[LOCAL_GATEWAY_FILE_ENV];
  if (customPath && customPath.trim()) {
    return customPath.trim();
  }

  const cwd = process.cwd();
  return `${cwd}/${DEFAULT_CONFIG_DIR}/${DEFAULT_CONFIG_FILE}`;
}

function generateGatewayKey() {
  const randomValue =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}${Math.random().toString(16).slice(2)}`;

  return `pk-local-${randomValue.slice(0, 32)}`;
}

function createDefaultLocalGatewayConfig(): LocalGatewayConfig {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    gatewayKeys: [generateGatewayKey()],
    models: {
      'openrouter-auto': {
        provider: 'openrouter',
        upstreamModel: 'openrouter/auto',
        providerApiKeyEnv: 'OPENROUTER_API_KEY',
        displayName: 'OpenRouter Auto',
        description:
          'Default OpenRouter auto-routing alias for local OpenSDK calls.',
      },
    },
    mcpServers: {},
  };
}

async function ensureLocalGatewayConfigFile() {
  if (!isNodeRuntime()) {
    throw new Error(LOCAL_RUNTIME_ONLY_MESSAGE);
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);

  await fs.mkdir(configDir, { recursive: true });

  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(
      configPath,
      JSON.stringify(createDefaultLocalGatewayConfig(), null, 2),
      'utf8'
    );
  }

  return configPath;
}

function normalizeLocalGatewayConfig(
  config: Partial<LocalGatewayConfig>
): LocalGatewayConfig {
  const normalizeRoutePath = (value: string) => {
    if (!value) {
      return '/mcp';
    }

    const prefixed = value.startsWith('/') ? value : `/${value}`;
    return prefixed.length > 1 ? prefixed.replace(/\/+$/, '') : prefixed;
  };

  return {
    version: 1,
    generatedAt: config.generatedAt || new Date().toISOString(),
    gatewayKeys: config.gatewayKeys?.filter(
      (value) => typeof value === 'string' && value.trim()
    ) || [generateGatewayKey()],
    models: Object.fromEntries(
      Object.entries(config.models || {}).map(([alias, entry]) => [
        alias,
        {
          provider: entry.provider,
          upstreamModel: entry.upstreamModel,
          ...(entry.providerApiKey
            ? { providerApiKey: entry.providerApiKey }
            : {}),
          ...(entry.providerApiKeyEnv
            ? { providerApiKeyEnv: entry.providerApiKeyEnv }
            : {}),
          ...(entry.displayName ? { displayName: entry.displayName } : {}),
          ...(entry.description ? { description: entry.description } : {}),
        },
      ])
    ),
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers || {}).map(([alias, entry]) => [
        alias,
        {
          routePath: normalizeRoutePath(entry.routePath),
          targetUrl: entry.targetUrl,
          ...(entry.displayName ? { displayName: entry.displayName } : {}),
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.headers ? { headers: entry.headers } : {}),
        },
      ])
    ),
  };
}

export async function readLocalGatewayConfig(): Promise<LocalGatewayConfig | null> {
  if (!isNodeRuntime()) {
    return null;
  }

  const fs = await import('node:fs/promises');
  const configPath = await ensureLocalGatewayConfigFile();
  const fileContents = await fs.readFile(configPath, 'utf8');
  const parsed = JSON.parse(fileContents) as Partial<LocalGatewayConfig>;
  const normalized = normalizeLocalGatewayConfig(parsed);

  if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
    await fs.writeFile(configPath, JSON.stringify(normalized, null, 2), 'utf8');
  }

  return normalized;
}

export async function writeLocalGatewayConfig(
  config: Partial<LocalGatewayConfig>
): Promise<LocalGatewayConfig> {
  if (!isNodeRuntime()) {
    throw new Error(LOCAL_RUNTIME_ONLY_MESSAGE);
  }

  const fs = await import('node:fs/promises');
  const normalized = normalizeLocalGatewayConfig(config);
  const configPath = await ensureLocalGatewayConfigFile();
  await fs.writeFile(configPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

export function getBearerToken(headers: Record<string, any>) {
  const authHeader = headers['authorization'] || headers['Authorization'];
  if (!authHeader || typeof authHeader !== 'string') {
    return '';
  }

  return authHeader.replace(/^Bearer\s+/i, '').trim();
}

function resolveProviderApiKey(modelConfig: LocalGatewayModelConfigEntry) {
  if (modelConfig.providerApiKey) {
    return modelConfig.providerApiKey;
  }

  if (modelConfig.providerApiKeyEnv) {
    return process.env[modelConfig.providerApiKeyEnv] || '';
  }

  return '';
}

const DIRECT_PROVIDER_ENV_MAP: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  cohere: 'COHERE_API_KEY',
  'together-ai': 'TOGETHER_AI_API_KEY',
  'mistral-ai': 'MISTRAL_AI_API_KEY',
  'perplexity-ai': 'PERPLEXITY_AI_API_KEY',
};

function isLocalGatewayKey(token: string) {
  return token.startsWith('pk-local-');
}

function getProviderApiKeyEnvName(provider: string) {
  return (
    DIRECT_PROVIDER_ENV_MAP[provider] ||
    `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`
  );
}

function createDirectProviderResolution(
  modelName: string,
  providerApiKey: string,
  routingMode: 'local-config' | 'local-direct' | 'auth-header'
): LocalGatewayResolution | null {
  const [provider, ...rest] = modelName.split('/');
  if (!provider || rest.length === 0 || !VALID_PROVIDERS.includes(provider)) {
    return null;
  }

  return {
    alias: modelName,
    upstreamModel: modelName,
    providerConfig: {
      provider,
      apiKey: providerApiKey,
      forwardHeaders: [],
      beforeRequestHooks: [],
      afterRequestHooks: [],
      defaultInputGuardrails: [],
      defaultOutputGuardrails: [],
      overrideParams: {
        model: modelName,
      },
      metadata: {
        localModelAlias: modelName,
        localModelRoutingMode: routingMode,
      },
    } satisfies Options,
  };
}

function resolveDirectProviderModel(modelName: string) {
  const [provider, ...rest] = modelName.split('/');
  if (!provider || rest.length === 0 || !VALID_PROVIDERS.includes(provider)) {
    return null;
  }

  const providerApiKeyEnv = getProviderApiKeyEnvName(provider);
  const providerApiKey = process.env[providerApiKeyEnv] || '';
  if (!providerApiKey) {
    throw new Error(
      `Missing ${providerApiKeyEnv} for direct local routing of "${modelName}".`
    );
  }

  return createDirectProviderResolution(
    modelName,
    providerApiKey,
    'local-direct'
  );
}

export function resolveAuthorizationModelAlias(
  headers: Record<string, any>,
  modelAlias?: string | null
) {
  if (!modelAlias) {
    return null;
  }

  const bearerToken = getBearerToken(headers);
  if (!bearerToken || isLocalGatewayKey(bearerToken)) {
    return null;
  }

  return createDirectProviderResolution(modelAlias, bearerToken, 'auth-header');
}

export async function resolveLocalGatewayModelAlias(
  headers: Record<string, any>,
  modelAlias?: string | null
): Promise<LocalGatewayResolution | null> {
  const config = await readLocalGatewayConfig();
  // console.log('Local Gateway Config:', config)
  if (!config || !modelAlias) {
    return null;
  }

  const gatewayKey = getBearerToken(headers);
  // console.log('Gateway Key from Headers:', gatewayKey);
  if (!gatewayKey || !config.gatewayKeys.includes(gatewayKey)) {
    return null;
  }

  const modelConfig = config.models[modelAlias];
  // console.log(`Model config for alias "${modelAlias}":`, modelConfig);
  if (!modelConfig) {
    return resolveDirectProviderModel(modelAlias);
  }

  const providerApiKey = resolveProviderApiKey(modelConfig);
  // console.log(`Resolved provider API key for alias "${modelAlias}":`, !!providerApiKey);
  if (!providerApiKey) {
    throw new Error(
      `Missing provider API key for local model alias \"${modelAlias}\". Set provider_api_key or provider_api_key_env in ${getConfigPath()}.`
    );
  }

  return {
    alias: modelAlias,
    upstreamModel: modelConfig.upstreamModel,
    providerConfig: {
      provider: modelConfig.provider,
      apiKey: providerApiKey,
      forwardHeaders: [],
      beforeRequestHooks: [],
      afterRequestHooks: [],
      defaultInputGuardrails: [],
      defaultOutputGuardrails: [],
      overrideParams: {
        model: modelConfig.upstreamModel,
      },
      metadata: {
        localModelAlias: modelAlias,
        localModelRoutingMode: 'local-config',
      },
    },
  };
}

export async function getLocalGatewaySummary(headers?: Record<string, any>) {
  const config = await readLocalGatewayConfig();
  if (!config) {
    return null;
  }

  const bearerToken = headers ? getBearerToken(headers) : '';
  const hasAccess = !headers || config.gatewayKeys.includes(bearerToken);

  return {
    configPath: getConfigPath(),
    hasAccess,
    defaultGatewayKey: config.gatewayKeys[0] || '',
    gatewayKeysCount: config.gatewayKeys.length,
    models: Object.entries(config.models).map(([alias, modelConfig]) => ({
      alias,
      provider: modelConfig.provider,
      upstreamModel: modelConfig.upstreamModel,
      displayName: modelConfig.displayName || alias,
      description: modelConfig.description || '',
      providerApiKeyEnv: modelConfig.providerApiKeyEnv || '',
    })),
    mcpServers: Object.entries(config.mcpServers || {}).map(
      ([alias, mcpConfig]) => ({
        alias,
        routePath: mcpConfig.routePath,
        targetUrl: mcpConfig.targetUrl,
        displayName: mcpConfig.displayName || alias,
        description: mcpConfig.description || '',
        headers: mcpConfig.headers || {},
      })
    ),
  };
}

export async function validateLocalGatewayToken(headers: Record<string, any>) {
  const config = await readLocalGatewayConfig();
  if (!config) {
    return false;
  }

  const gatewayKey = getBearerToken(headers);
  return !!gatewayKey && config.gatewayKeys.includes(gatewayKey);
}

function trimTrailingSlash(value: string) {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

export async function resolveLocalMcpServer(
  requestPath: string
): Promise<LocalGatewayMcpResolution | null> {
  const config = await readLocalGatewayConfig();
  if (!config) {
    return null;
  }

  const normalizedRequestPath = trimTrailingSlash(requestPath || '/');

  for (const [alias, entry] of Object.entries(config.mcpServers || {})) {
    const routePath = trimTrailingSlash(entry.routePath);
    if (
      normalizedRequestPath === routePath ||
      normalizedRequestPath.startsWith(`${routePath}/`)
    ) {
      return {
        alias,
        routePath,
        targetUrl: entry.targetUrl,
        displayName: entry.displayName,
        description: entry.description,
        headers: entry.headers || {},
      };
    }
  }

  return null;
}
