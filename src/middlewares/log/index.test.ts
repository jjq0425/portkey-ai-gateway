import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createLogEntry,
  getDisplayEndpoint,
  getLogsFilename,
  persistLogEntry,
  shouldLogRequest,
  truncateResponsePayload,
} from './index';

describe('log middleware helpers', () => {
  describe('shouldLogRequest', () => {
    it('logs legacy v1 chat completion routes', () => {
      expect(
        shouldLogRequest('http://localhost:18788/v1/chat/completions')
      ).toBe(true);
    });

    it('logs non-v1 compatibility chat completion routes used by SDK base URLs', () => {
      expect(shouldLogRequest('http://localhost:18788/chat/completions')).toBe(
        true
      );
    });

    it('ignores the browser log stream endpoint itself', () => {
      expect(shouldLogRequest('http://localhost:18788/log/stream')).toBe(false);
    });
  });

  describe('getDisplayEndpoint', () => {
    it('extracts the request path without relying on a hard-coded port', () => {
      expect(
        getDisplayEndpoint('http://localhost:18788/chat/completions?foo=bar')
      ).toBe('/chat/completions?foo=bar');
    });
  });

  describe('log file persistence helpers', () => {
    it('creates JSON entries that can be written to disk', () => {
      expect(
        createLogEntry({
          time: '3/18/2026, 10:00:00 AM',
          method: 'POST',
          endpoint: '/chat/completions',
          status: 200,
          duration: 25,
          requestOptions: [{ requestParams: { model: 'demo' } }],
          response: { id: 'resp_123' },
        })
      ).toEqual({
        time: '3/18/2026, 10:00:00 AM',
        method: 'POST',
        endpoint: '/chat/completions',
        status: 200,
        duration: 25,
        requestOptions: [{ requestParams: { model: 'demo' } }],
        response: { id: 'resp_123' },
      });
    });

    it('uses daily jsonl log files', () => {
      expect(getLogsFilename(new Date('2026-03-18T12:34:56.000Z'))).toBe(
        '2026-03-18.jsonl'
      );
    });

    it('truncates oversized response payloads before persistence', () => {
      const truncated = truncateResponsePayload({
        text: 'x'.repeat(100001),
      });

      expect(typeof truncated).toBe('string');
      expect(truncated.endsWith('...')).toBe(true);
    });

    it('persists json lines into the configured logs directory', async () => {
      const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'gateway-logs-')
      );
      process.env.PORTKEY_LOGS_DIR = path.join(tempRoot, 'logs');

      try {
        await persistLogEntry({
          time: '3/18/2026, 10:00:00 AM',
          method: 'POST',
          endpoint: '/chat/completions',
          status: 200,
          duration: 25,
          requestOptions: [],
          response: { ok: true },
        });

        const logFile = path.join(
          process.env.PORTKEY_LOGS_DIR,
          getLogsFilename()
        );
        const content = await fs.readFile(logFile, 'utf8');
        const [line] = content.trim().split('\n');

        expect(JSON.parse(line)).toMatchObject({
          method: 'POST',
          endpoint: '/chat/completions',
          status: 200,
          response: { ok: true },
        });
      } finally {
        delete process.env.PORTKEY_LOGS_DIR;
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });
  });
});
