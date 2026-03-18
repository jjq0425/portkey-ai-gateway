import {
  appendLocalGatewayKey,
  readLocalGatewayConfig,
  removeLocalGatewayKey,
  resolveLocalMcpServer,
  resolveAuthorizationModelAlias,
  resolveLocalGatewayModelAlias,
  validateLocalGatewayToken,
  writeLocalGatewayConfig,
} from '../../../../src/localGateway/config';

const TEST_CONFIG_PATH = `${process.cwd()}/.tmp/local-gateway.test.json`;

describe('localGateway config', () => {
  beforeEach(async () => {
    process.env.LOCAL_GATEWAY_CONFIG_PATH = TEST_CONFIG_PATH;
    process.env.OPENROUTER_API_KEY = 'or-test-key';

    await writeLocalGatewayConfig({
      version: 1,
      generatedAt: '2026-03-18T00:00:00.000Z',
      gatewayKeys: ['pk-local-test'],
      models: {
        'gpt-4o-mini-local': {
          provider: 'openrouter',
          upstreamModel: 'openai/gpt-4o-mini',
          providerApiKeyEnv: 'OPENROUTER_API_KEY',
          displayName: 'GPT-4o Mini Local',
        },
      },
      mcpServers: {
        weather: {
          routePath: '/mcp1',
          targetUrl: 'http://127.0.0.1:3010/mcp',
          displayName: '天气 MCP',
          description: '测试用 MCP 代理配置',
          headers: {
            'x-test-token': 'demo',
          },
        },
      },
    });
  });

  afterEach(async () => {
    const fs = await import('node:fs/promises');
    delete process.env.LOCAL_GATEWAY_CONFIG_PATH;
    delete process.env.OPENROUTER_API_KEY;
    await fs.rm(`${process.cwd()}/.tmp`, { recursive: true, force: true });
  });

  it('reads the persisted local gateway config', async () => {
    const config = await readLocalGatewayConfig();

    expect(config?.gatewayKeys).toEqual(['pk-local-test']);
    expect(config?.models['gpt-4o-mini-local'].provider).toBe('openrouter');
    expect(config?.mcpServers.weather.routePath).toBe('/mcp1');
  });

  it('resolves a local model alias into provider config', async () => {
    const resolved = await resolveLocalGatewayModelAlias(
      { authorization: 'Bearer pk-local-test' },
      'gpt-4o-mini-local'
    );

    expect(resolved?.providerConfig.provider).toBe('openrouter');
    expect(resolved?.providerConfig.apiKey).toBe('or-test-key');
    expect(resolved?.providerConfig.overrideParams?.model).toBe(
      'openai/gpt-4o-mini'
    );
    expect(resolved?.providerConfig.defaultInputGuardrails).toEqual([]);
    expect(resolved?.providerConfig.defaultOutputGuardrails).toEqual([]);
  });

  it('validates local gateway bearer tokens', async () => {
    await expect(
      validateLocalGatewayToken({ authorization: 'Bearer pk-local-test' })
    ).resolves.toBe(true);

    await expect(
      validateLocalGatewayToken({ authorization: 'Bearer pk-local-nope' })
    ).resolves.toBe(false);
  });

  it('supports direct provider/model routing for valid local gateway keys', async () => {
    const resolved = await resolveLocalGatewayModelAlias(
      { authorization: 'Bearer pk-local-test' },
      'openrouter/hunter-alpha'
    );

    expect(resolved?.providerConfig.provider).toBe('openrouter');
    expect(resolved?.providerConfig.apiKey).toBe('or-test-key');
    expect(resolved?.providerConfig.overrideParams?.model).toBe(
      'openrouter/hunter-alpha'
    );
    expect(resolved?.providerConfig.defaultInputGuardrails).toEqual([]);
    expect(resolved?.providerConfig.defaultOutputGuardrails).toEqual([]);
  });

  it('supports provider/model routing directly from the Authorization token', () => {
    const resolved = resolveAuthorizationModelAlias(
      { authorization: 'Bearer or-request-token' },
      'openrouter/hunter-alpha'
    );

    expect(resolved?.providerConfig.provider).toBe('openrouter');
    expect(resolved?.providerConfig.apiKey).toBe('or-request-token');
    expect(resolved?.providerConfig.overrideParams?.model).toBe(
      'openrouter/hunter-alpha'
    );
  });

  it('generates and removes multiple local gateway keys', async () => {
    const appended = await appendLocalGatewayKey();

    expect(appended.gatewayKeys).toHaveLength(2);
    expect(appended.gatewayKeys[0]).toBe('pk-local-test');
    expect(appended.gatewayKeys[1]).toMatch(/^pk-local-/);

    const removed = await removeLocalGatewayKey(appended.gatewayKeys[1]);

    expect(removed.gatewayKeys).toEqual(['pk-local-test']);
    await expect(removeLocalGatewayKey('pk-local-test')).rejects.toThrow(
      'At least one local gateway key must remain.'
    );
  });

  it('resolves configured MCP routes from local gateway config', async () => {
    const resolved = await resolveLocalMcpServer('/mcp1/tools/list');

    expect(resolved?.alias).toBe('weather');
    expect(resolved?.routePath).toBe('/mcp1');
    expect(resolved?.targetUrl).toBe('http://127.0.0.1:3010/mcp');
    expect(resolved?.headers).toEqual({ 'x-test-token': 'demo' });
  });
});
