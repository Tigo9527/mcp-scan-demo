/**
 * Admin 默认令牌防护测试。
 *
 * 场景：忘记注入 ADMIN_TOKEN 就把服务部署到公网 —— 此时若放行内置默认令牌，
 * 管理端等于裸奔。必须返回 503 并提示注入方式。
 *
 * 由于 config.publicBaseUrl 是模块加载时从 env 快照的，必须**先 stubEnv 再动态 import**。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';

let server: Server;
let base: string;

beforeAll(async () => {
  vi.stubEnv('PUBLIC_BASE_URL', 'https://mcp.example.com');
  vi.stubEnv('ADMIN_TOKEN', '');

  const { createApp } = await import('../src/web/app.js');
  const { configure } = await import('../src/persist.js');
  configure({ enabled: false });

  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        vi.unstubAllEnvs();
        resolve();
      });
    }),
);

describe('公网环境禁用默认 admin 令牌', () => {
  it('访问 /admin 返回 503 并提示注入 ADMIN_TOKEN', async () => {
    const res = await fetch(`${base}/admin`, { redirect: 'manual' });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('ADMIN_TOKEN');
  });

  it('登录页同样返回 503', async () => {
    const res = await fetch(`${base}/admin/login`, { redirect: 'manual' });
    expect(res.status).toBe(503);
  });

  it('提交默认令牌登录也会被拒', async () => {
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'dev-admin-change-me' }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(503);
  });

  it('普通页面不受影响（门户仍可访问）', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
  });
});
