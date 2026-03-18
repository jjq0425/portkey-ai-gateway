import { getDisplayEndpoint, shouldLogRequest } from './index';

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
});
