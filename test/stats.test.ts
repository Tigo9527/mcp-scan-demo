/**
 * 调用统计与 Profile 测试。
 *
 * 统计是模块级单例，且前一个用例的请求也会往计数器里灌数据，
 * 所以断言一律用**增量**（diffStats）而不是绝对值。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/web/app.js';
import { configure } from '../src/persist.js';
import { diffStats, getStatsSnapshot, resetStats } from '../src/stats.js';
import * as store from '../src/auth/store.js';
import { issueTokenForId } from '../src/auth/manager.js';

const JSON_RPC = 'application/json';

let server: Server;
let base: string;

async function registerAndGetToken(username: string): Promise<string> {
  const res = await fetch(`${base}/register?username=${username}`);
  const html = await res.text();
  const m = html.match(/mcp_demo_[A-Za-z0-9._-]+/);
  return m ? m[0] : '';
}

async function mcpInitialize(token?: string): Promise<string> {
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
  return res.headers.get('mcp-session-id') ?? '';
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

beforeAll(async () => {
  configure({ enabled: false });
  // 本文件的用例以匿名请求验证统计埋点，故关闭严格鉴权（默认开启会直接 401，
  // 请求根本到不了 transport 也就无从统计）。严格模式见 test/oauth.test.ts。
  vi.stubEnv('MCP_DEMO_REQUIRE_AUTH', 'off');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  vi.unstubAllEnvs();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  resetStats();
});

describe('MCP 调用统计', () => {
  it('initialize 只计入 requests，不计入 toolCalls', async () => {
    const before = getStatsSnapshot();
    await mcpInitialize();
    const delta = diffStats(getStatsSnapshot(), before);

    expect(delta.counters.requests).toBe(1);
    expect(delta.counters.toolCalls).toBe(0);
    expect(delta.byMethod.initialize).toBe(1);
  });

  it('tools/call 同时计入 requests 与 toolCalls', async () => {
    const token = await registerAndGetToken('stats_caller');
    const before = getStatsSnapshot();
    const sessionId = await mcpInitialize(token);
    await mcpCall(token, sessionId, 'tools/call', { name: 'whoami', arguments: {} });
    const delta = diffStats(getStatsSnapshot(), before);

    // initialize + tools/call
    expect(delta.counters.requests).toBe(2);
    expect(delta.counters.toolCalls).toBe(1);
    expect(delta.byTool.whoami).toBe(1);
    expect(delta.byMethod['tools/call']).toBe(1);
  });

  it('通知类消息（无 id）不计入统计', async () => {
    const before = getStatsSnapshot();
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': JSON_RPC,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    const delta = diffStats(getStatsSnapshot(), before);

    // 客户端每次连接都必发这条通知，计入会让调用数翻倍
    expect(delta.counters.requests).toBe(0);
    expect(delta.counters.toolCalls).toBe(0);
  });

  it('匿名请求归入 anonymous 桶', async () => {
    const before = getStatsSnapshot();
    await mcpInitialize();
    const delta = diffStats(getStatsSnapshot(), before);

    expect(delta.byUser['anonymous']).toBe(1);
  });

  it('按用户维度统计：能定位到具体用户 id', async () => {
    const token = await registerAndGetToken('stats_dim_user');
    const user = store.listUsers({ query: 'stats_dim_user' }).items[0]!;

    const before = getStatsSnapshot();
    const sessionId = await mcpInitialize(token);
    await mcpCall(token, sessionId, 'tools/call', { name: 'whoami', arguments: {} });
    const delta = diffStats(getStatsSnapshot(), before);

    expect(delta.byUser[user.id]).toBe(2);
    const stat = getStatsSnapshot().byUser[user.id]!;
    expect(stat.username).toBe('stats_dim_user');
    expect(stat.tools.whoami).toBe(1);
  });

  it('快照是深拷贝（两次取值互不影响）', () => {
    const a = getStatsSnapshot();
    a.counters.requests = 99999;
    const b = getStatsSnapshot();
    expect(b.counters.requests).not.toBe(99999);
  });

  it('按需落库：用 admin 签发的令牌调用后，用户会被补进存储', async () => {
    const remoteId = randomUUID();
    const { token } = issueTokenForId(remoteId, 'remote_user');
    expect(store.getUser(remoteId)).toBeUndefined();

    const sessionId = await mcpInitialize(token);
    await mcpCall(token, sessionId, 'tools/call', { name: 'whoami', arguments: {} });

    const materialized = store.getUser(remoteId);
    expect(materialized).toBeTruthy();
    expect(materialized!.username).toBe('remote_user');
  });
});

describe('用户 Profile 页面', () => {
  it('未携带令牌时提示去注册', async () => {
    const res = await fetch(`${base}/profile`);
    const html = await res.text();
    expect(html).toContain('你还没登录');
    expect(html).toContain('/register');
  });

  it('携带令牌时展示资料与个人统计', async () => {
    const token = await registerAndGetToken('profile_page_user');
    const sessionId = await mcpInitialize(token);
    await mcpCall(token, sessionId, 'tools/call', { name: 'whoami', arguments: {} });
    await mcpCall(token, sessionId, 'tools/call', { name: 'my_stats', arguments: {} });

    const res = await fetch(`${base}/profile?token=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('profile_page_user');
    expect(html).toContain('我的调用统计');
    expect(html).toContain('my_stats');
    // 令牌在 URL 里，必须禁止 Referer 外泄
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('profile 页对用户名做了 HTML 转义', async () => {
    const payload = '<script>alert(1)</script>';
    const res = await fetch(`${base}/register?username=${encodeURIComponent(payload)}`);
    const html0 = await res.text();
    const token = html0.match(/mcp_demo_[A-Za-z0-9._-]+/)?.[0] ?? '';
    expect(token).not.toBe('');

    const res2 = await fetch(`${base}/profile?token=${token}`);
    const html = await res2.text();
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
