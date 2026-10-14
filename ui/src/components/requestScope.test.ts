import { describe, expect, it } from 'vitest';

import { requestScopeRule } from './requestScope';

describe('requestScopeRule', () => {
  it('matches only the hostname across schemes and paths', () => {
    expect(requestScopeRule('https://api.test:8443/users?q=1', 'include', 'hostname')).toMatchObject({
      kind: 'include', host: 'api.test', path: '*', protocol: 'any', port: null,
    });
  });

  it('matches the selected path prefix on its origin, including query variants', () => {
    expect(requestScopeRule('https://api.test:8443/users?q=1', 'exclude', 'path')).toMatchObject({
      kind: 'exclude', host: 'api.test', path: '/users*', protocol: 'https', port: 8443,
    });
    expect(requestScopeRule('http://api.test/', 'include', 'path')).toMatchObject({
      path: '/*', protocol: 'http', port: 80,
    });
  });

  it('rejects requests without an HTTP hostname', () => {
    expect(() => requestScopeRule('not-a-url', 'include', 'hostname')).toThrow();
    expect(() => requestScopeRule('tcp://api.test:80', 'include', 'path')).toThrow();
  });
});
