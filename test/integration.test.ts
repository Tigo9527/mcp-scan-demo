/**
 * 集成测试：启动 MCP Demo 服务，验证
 *   1) 健康检查可用（含 instanceId）
 *   2) 一键注册返回令牌
 *   3) 带令牌调用 MCP whoami / register_user 成功
 *   4) 匿名也能完成握手（不返回 401），由工具返回登录引导
 *
 * 注意：早期版本这里断言「无令牌必须返回 401」，现已改为匿名放行 + 登录引导，
 * 不要再改回 401（AGENTS.md 里也同步修正了）。
 *
 * 运行后会把「可访问 URL」打印到 stdout，供 Codex 转述给用户。
 * 运行方式：npm test  （或 npx vitest run）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { config } from '../src/config.js';
import { configure } from '../src/persist.js';

let server: Server;
let base: string;

const JSON_RPC = 'application/json';

beforeAll(async () => {
  // 测试期间关闭落盘，避免污染 data/ 目录
  configure({ enabled: false });

  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;

  // —— Codex 会读取下面这段输出并把 URL 转述给用户 ——
  console.log('\n========== MCP DEMO VISIT URLS (for the user) ==========');
  console.log(`  Web portal / one-click register : ${base}/`);
  console.log(`  Client setup (no login needed)  : ${base}/setup`);
  console.log(`  GitHub OAuth login              : ${base}/auth/github`);
  console.log(`  MCP endpoint (Streamable HTTP)  : ${base}/mcp`);
  console.log(`  User profile                    : ${base}/profile?token=<your-token>`);
  console.log(`  Admin console                   : ${base}/admin`);
  console.log(`  Health check                    : ${base}/health`);
  console.log('==========================================================\n');
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

async function registerAndGetToken(username: string): Promise<string> {
  const res = await fetch(`${base}/register?username=${username}`);
  expect(res.ok).toBe(true);
  const html = await res.text();
  const m = html.match(/mcp_demo_[A-Za-z0-9._-]+/);
  expect(m, 'register page should contain a token').toBeTruthy();
  return m![0];
}

async function mcpInitialize(token?: string): Promise<{ sessionId: string; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': JSON_RPC,
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest-client', version: '1.0.0' },
      },
    }),
  });
  const body = await res.json();
  return { sessionId: res.headers.get('mcp-session-id') ?? '', body };
}

async function mcpCall(
  token: string | undefined,
  sessionId: string,
  method: string,
  params: unknown,
): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': JSON_RPC,
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
  });
  return res.json();
}

describe('MCP demo server', () => {
  it('health check returns ok', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it('one-click register returns a token', async () => {
    const token = await registerAndGetToken('alice');
    expect(token.startsWith(config.jwtTokenPrefix)).toBe(true);
  });

  it('MCP initialize + whoami works with token', async () => {
    const token = await registerAndGetToken('bob');
    const { sessionId, body } = await mcpInitialize(token);
    expect(body.result?.serverInfo?.name).toBe('mcp-demo');
    // 无状态模式下 mcp-session-id 可能为空，后续请求仍可独立处理

    // 通知端初始化完成（协议要求）
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': JSON_RPC,
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    const whoami = await mcpCall(token, sessionId, 'tools/call', {
      name: 'whoami',
      arguments: {},
    });
    expect(whoami.result?.content?.[0]?.text).toContain('bob');
  });

  it('register_user tool returns a fresh token', async () => {
    const token = await registerAndGetToken('carol');
    const { sessionId } = await mcpInitialize(token);
    const r = await mcpCall(token, sessionId, 'tools/call', {
      name: 'register_user',
      arguments: { username: 'dave' },
    });
    expect(r.result?.content?.[0]?.text).toContain('mcp_demo_');
  });

  it('anonymous handshake works and tools/list exposes the login tool', async () => {
    // 不加任何令牌：端点应允许握手（不再返回 401），并暴露引导登录的工具
    const { sessionId, body } = await mcpInitialize();
    expect(body.result?.serverInfo?.name).toBe('mcp-demo');

    const list = await mcpCall(undefined, sessionId, 'tools/list', {});
    const names = (list.result?.tools ?? []).map((t: any) => t.name);
    expect(names).toContain('login');
    expect(names).toContain('whoami');
  });

  it('anonymous whoami returns a login hint (not a hard error)', async () => {
    const { sessionId } = await mcpInitialize();
    const whoami = await mcpCall(undefined, sessionId, 'tools/call', {
      name: 'whoami',
      arguments: {},
    });
    const text = whoami.result?.content?.[0]?.text ?? JSON.stringify(whoami);
    expect(text).toContain('未登录');
    expect(text).toMatch(/register|登录/);
  });

  it('login tool returns a register URL', async () => {
    const { sessionId } = await mcpInitialize();
    const login = await mcpCall(undefined, sessionId, 'tools/call', {
      name: 'login',
      arguments: {},
    });
    const text = login.result?.content?.[0]?.text ?? '';
    expect(text).toContain('/register');
  });

  it('health check exposes instanceId, persist status and user count', async () => {
    const res = await fetch(`${base}/health`);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(typeof json.instanceId).toBe('string');
    expect(json.instanceId.length).toBeGreaterThan(0);
    expect(json.persist).toBeDefined();
    expect(typeof json.users).toBe('number');
  });

  it('GET /mcp is rejected with 405 in stateless mode', async () => {
    // 无状态模式下 GET 会建立常驻 SSE 流，必须挡掉，否则爬虫/健康检查会累积悬挂连接
    const res = await fetch(`${base}/mcp`, {
      headers: { Accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBe(405);
  });

  it('register page escapes HTML (no XSS via username)', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const res = await fetch(`${base}/register?username=${encodeURIComponent(payload)}`);
    const html = await res.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('my_stats returns personal stats for an authenticated user', async () => {
    const token = await registerAndGetToken('erin');
    const { sessionId } = await mcpInitialize(token);
    const r = await mcpCall(token, sessionId, 'tools/call', {
      name: 'my_stats',
      arguments: {},
    });
    const text = r.result?.content?.[0]?.text ?? JSON.stringify(r);
    expect(text).toContain('erin');
    expect(text).toContain('byTool');
  });
});
