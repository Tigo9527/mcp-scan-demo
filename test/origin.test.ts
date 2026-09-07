/**
 * 跨站表单防护（originOk）专项测试。
 *
 * 重点锁住这个回归：之前按**完整 URL 前缀**比对，导致 scheme 不同
 * （`http://` vs `https://`）时同为本站却被误判成跨站、用户在公网提交表单被自己拦住（403）。
 * 现在改为只比对**主机名**，并同时接受 publicBaseUrl / x-forwarded-host / Host。
 *
 * 注意：config 在模块加载时读取 env，所以必须先 stubEnv 再动态 import。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Request } from 'express';

type OriginOk = (req: Request) => boolean;
let originOk: OriginOk;

beforeAll(async () => {
  vi.stubEnv('PUBLIC_BASE_URL', 'https://demo.example.com');
  const mod = await import('../src/web/http.js');
  originOk = mod.originOk as OriginOk;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** 构造最小可用的 Express Request 替身（只用到 headers） */
function req(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

describe('originOk', () => {
  it('未携带 Origin 时放行（交给 SameSite=Lax 兜底）', () => {
    expect(originOk(req({}))).toBe(true);
  });

  it('Origin 为 "null"（沙箱 iframe / 内嵌预览面板）→ 放行', () => {
    // 内嵌预览面板用沙箱 iframe 承载页面，浏览器会发送不透明来源 `Origin: null`，
    // 曾导致用户在预览里提交 admin 登录被自己拦成「跨站请求已被拒绝」。
    expect(originOk(req({ origin: 'null' }))).toBe(true);
    expect(originOk(req({ origin: 'NULL' }))).toBe(true);
  });

  it('Origin 与 PUBLIC_BASE_URL 同主机 → 放行', () => {
    expect(originOk(req({ origin: 'https://demo.example.com' }))).toBe(true);
  });

  it('同主机但 scheme 为 http（非 https）→ 放行（曾经的误杀场景）', () => {
    expect(originOk(req({ origin: 'http://demo.example.com' }))).toBe(true);
  });

  it('同主机带端口 → 放行', () => {
    expect(originOk(req({ origin: 'https://demo.example.com:8443' }))).toBe(true);
  });

  it('真正的外站 Origin → 拒绝', () => {
    expect(originOk(req({ origin: 'https://evil.example.com' }))).toBe(false);
    expect(originOk(req({ origin: 'https://demo.example.com.evil.com' }))).toBe(false);
  });

  it('本地地址一律放行（本地开发友好）', () => {
    expect(originOk(req({ origin: 'http://localhost:3000' }))).toBe(true);
    expect(originOk(req({ origin: 'http://127.0.0.1:8080' }))).toBe(true);
  });

  it('x-forwarded-host 与 Origin 一致时也放行（反代场景）', () => {
    expect(
      originOk(req({ origin: 'https://proxy.example.com', 'x-forwarded-host': 'proxy.example.com' })),
    ).toBe(true);
  });

  it('非法 Origin 字符串不会抛异常，按外站拒绝', () => {
    expect(() => originOk(req({ origin: 'not-a-url' }))).not.toThrow();
    expect(originOk(req({ origin: 'not-a-url' }))).toBe(false);
  });
});
