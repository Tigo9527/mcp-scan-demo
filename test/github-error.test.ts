/**
 * GitHub OAuth 失败原因的提示翻译。
 *
 * 背景：部署环境常对出站做域名白名单，github.com 被黑洞时底层只抛
 * "Client network socket disconnected before secure TLS connection was established"，
 * 用户会误以为是 Client ID / 回调地址填错，反复排查配置。网络类错误必须被识别出来。
 */
import { describe, it, expect } from 'vitest';
import { humanizeOAuthError } from '../src/auth/github.js';

describe('humanizeOAuthError', () => {
  it('网络/TLS 类错误 → 提示是环境出站问题，而非配置问题', () => {
    const msg = humanizeOAuthError(
      new Error('Client request error: Client network socket disconnected before secure TLS connection was established'),
    );
    expect(msg).toContain('github.com');
    expect(msg).toContain('与 Client ID / 回调地址无关');
  });

  it('其它网络错误（DNS / 超时 / fetch failed）同样识别', () => {
    for (const raw of ['getaddrinfo ENOTFOUND api.github.com', 'ETIMEDOUT', 'fetch failed', 'ECONNRESET']) {
      expect(humanizeOAuthError(new Error(raw))).toContain('github.com');
    }
  });

  it('非网络错误 → 原样返回（保留真实原因，如 bad_verification_code）', () => {
    const raw = 'The code passed is incorrect or expired.';
    expect(humanizeOAuthError(new Error(raw))).toBe(raw);
  });

  it('非 Error 入参也能安全处理', () => {
    expect(humanizeOAuthError('boom')).toBe('boom');
  });
});
