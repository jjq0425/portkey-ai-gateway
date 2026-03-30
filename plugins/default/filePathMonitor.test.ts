import { handler as filePathMonitorHandler } from './filePathMonitor';
import { PluginContext, PluginParameters } from '../types';

describe('filePathMonitor handler', () => {
  const eventType = 'beforeRequestHook';

  it('should detect explicit file read intent and preserve query paths', async () => {
    const context: PluginContext = {
      requestType: 'chatComplete',
      request: {
        json: {
          messages: [
            { role: 'user', content: '请读取 `src/index.ts` 和 docs/api.md' },
          ],
        },
      },
      response: { json: null },
    };

    const result = await filePathMonitorHandler(
      context,
      {} as PluginParameters,
      eventType
    );

    expect(result.error).toBeNull();
    expect(result.verdict).toBe(true);
    expect(result.data.matched).toBe(true);
    expect(result.data.permissions).toEqual(['read']);
    expect(result.data.detections[0].scopeSource).toBe('query');
    expect(result.data.detections[0].targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/index.ts', kind: 'file' }),
        expect.objectContaining({ path: 'docs/api.md', kind: 'file' }),
      ])
    );
  });

  it('should fall back to default scopes when only write intent exists', async () => {
    const context: PluginContext = {
      requestType: 'chatComplete',
      request: {
        json: {
          messages: [
            {
              role: 'user',
              content: '请帮我修改一下文件内容，但先按默认范围限制。',
            },
          ],
        },
      },
      response: { json: null },
    };

    const result = await filePathMonitorHandler(
      context,
      {} as PluginParameters,
      eventType
    );

    expect(result.error).toBeNull();
    expect(result.data.matched).toBe(true);
    expect(result.data.permissions).toEqual(['write']);
    expect(result.data.detections[0].scopeSource).toBe('default');
    expect(result.data.detections[0].targets.length).toBeGreaterThan(0);
  });

  it('should return unmatched result for non-file intent queries', async () => {
    const context: PluginContext = {
      requestType: 'chatComplete',
      request: {
        json: {
          messages: [{ role: 'user', content: '总结一下这篇文章的核心观点' }],
        },
      },
      response: { json: null },
    };

    const result = await filePathMonitorHandler(
      context,
      {} as PluginParameters,
      eventType
    );

    expect(result.error).toBeNull();
    expect(result.data.matched).toBe(false);
    expect(result.data.detections).toEqual([]);
  });
});
