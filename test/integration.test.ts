/**
 * 集成测试：启动 MCP Demo 服务，验证
 *   1) 健康检查可用（含 instanceId）
 *   2) 一键注册返回令牌
 *   3) 带令牌调用 MCP whoami / register_user 成功
 *   4) 未带令牌的 MCP 请求返回 401 + WWW-Authenticate（标准 MCP 发现入口）
 *
 * 本文件验证的是**默认严格模式**（MCP_DEMO_REQUIRE_AUTH 缺省为 on）：
 * 未鉴权请求统一返回 401，由客户端走标准 OAuth 发现。早期的「未授权也返回 200」已 revert。
 * 完全匿名的逃生通道（MCP_DEMO_REQUIRE_AUTH=off）与「先装后登录」参数化模式见对应测试。
 *
 * 运行后会把「可访问 URL」打印到 stdout，供 Codex 转述给用户。
 * 运行方式：npm test  （或 npx vitest run）
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { config } from '../src/config.js';
import { configure } from '../src/persist.js';
import * as store from '../src/auth/store.js';
import * as billing from '../src/billing.js';

let server: Server;
let base: string;

const JSON_RPC = 'application/json';

beforeAll(async () => {
  // 测试期间关闭落盘，避免污染 data/ 目录
  configure({ enabled: false });

  // 默认严格模式（未鉴权直接 401 + WWW-Authenticate），正是本文件要验证的行为。
  // oauth.test.ts 用 vi.stubEnv 显式锁 on；这里依赖默认值即可，二者一致。
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

afterAll(() => {
  vi.unstubAllEnvs();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

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
    // 初始化握手声明的 clientInfo 应被采集并写入用户附属信息，whoami 可见
    const whoamiJson = JSON.parse(whoami.result?.content?.[0]?.text ?? '{}');
    expect(whoamiJson.clientInfo?.name).toBe('vitest-client');
    expect(whoamiJson.clientInfo?.version).toBe('1.0.0');
  });

  it('带令牌调用收费工具会累计计费（余额扣减、总额增长）', async () => {
    const token = await registerAndGetToken('payer');
    const userId = store.getUserByUsername('payer')!.id;
    const before = billing.getTotalBilling().used;

    const { sessionId } = await mcpInitialize(token);
    const r = await mcpCall(token, sessionId, 'tools/call', {
      name: 'search_repos',
      arguments: { query: 'conflux' },
    });
    // 不论工具内部是否成功（本测试未配置 GitHub），计费都按请求累计
    expect(r.result ?? r.error).toBeTruthy();

    const after = billing.getTotalBilling().used;
    expect(after).toBeGreaterThan(before);
    const bill = billing.getUserBilling(userId)!;
    expect(bill.used).toBeGreaterThanOrEqual(5); // search_repos 单价 5
    expect(bill.balance).toBe(config.billingFreeCredits - bill.used);
  });

  it('余额耗尽时收费工具被拦截（402），免费工具仍可用', async () => {
    const token = await registerAndGetToken('poor_guy');
    const userId = store.getUserByUsername('poor_guy')!.id;
    // 把余额耗到 0：免费额度 1000；list_cfx_transfers 单价 10 ×99 = 990，search_repos 单价 5 ×2 = 10
    for (let i = 0; i < 99; i += 1) billing.recordCall(userId, 'list_cfx_transfers');
    billing.recordCall(userId, 'search_repos');
    billing.recordCall(userId, 'search_repos');
    expect(billing.getBalance(userId)).toBe(0);

    const { sessionId } = await mcpInitialize(token);

    // 收费工具 search_repos（单价 5）应被 402 拦截，且不扣费
    const blocked = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': JSON_RPC,
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'search_repos', arguments: { query: 'x' } },
      }),
    });
    expect(blocked.status).toBe(402);
    const blockedBody = (await blocked.json()) as { error?: { code: number; data?: { tool: string } } };
    expect(blockedBody.error?.code).toBe(-32000);
    expect(blockedBody.error?.data?.tool).toBe('search_repos');
    // 拦截不扣费
    expect(billing.getBalance(userId)).toBe(0);

    // 免费工具 whoami 仍可用
    const ok = await mcpCall(token, sessionId, 'tools/call', {
      name: 'whoami',
      arguments: {},
    });
    expect(ok.result?.content?.[0]?.text).toContain('poor_guy');
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

  it('unauthenticated initialize returns 401 (standard MCP: triggers OAuth discovery)', async () => {
    // revert 旧版「未授权也返回 200」后，未带令牌的握手应返回 401 + WWW-Authenticate，
    // 让支持标准的客户端（Codex / Claude 等）据此启动授权发现。
    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': JSON_RPC, Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitest-client', version: '1.0.0' } },
      }),
    });
    expect(init.status).toBe(401);
    expect(init.headers.get('www-authenticate') ?? '').toContain('resource_metadata');
    const body = (await init.json()) as any;
    expect(body.error?.message ?? '').toMatch(/登录|register/);
  });

  it('unauthenticated tools/list and public tools also return 401', async () => {
    // 默认严格模式下，连 tools/list / login / server_info 这类「公开」工具也要求先登录。
    for (const m of [
      { method: 'tools/list', params: {} },
      { method: 'tools/call', params: { name: 'login', arguments: {} } },
      { method: 'tools/call', params: { name: 'server_info', arguments: {} } },
    ]) {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': JSON_RPC, Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...m }),
      });
      expect(res.status).toBe(401);
    }
  });

  it('unauthenticated whoami returns a 401 with a login hint', async () => {
    const whoami = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': JSON_RPC, Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    });
    expect(whoami.status).toBe(401);
    const body = (await whoami.json()) as any;
    expect(body.error?.message ?? '').toMatch(/登录|register/);
  });

  it('login tool (when authenticated) returns a register URL', async () => {
    const token = await registerAndGetToken('erin');
    const { sessionId } = await mcpInitialize(token);
    const login = await mcpCall(token, sessionId, 'tools/call', { name: 'login', arguments: {} });
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

  it('GET /mcp returns 405 Method Not Allowed with Allow: POST', async () => {
    // 无状态模式下本端点只接受 POST；GET 直接 405（与 Streamable HTTP 规范及 Tavily 一致），
    // 不再尝试开 SSE 流（无会话无法向客户端主动推送）。
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.status).not.toBe(401); // 关键不变量：GET 绝不能 401，否则 SSE 客户端会触发 OAuth 死循环
  });

  it('GET /mcp with any Accept header still 405 (no SSE / 406 path)', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { Accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    const res2 = await fetch(`${base}/mcp`, { headers: { Accept: 'application/json' } });
    expect(res2.status).toBe(405);
  });

  it('未登录 401 的 JSON-RPC 错误回显请求 id（而非 null）', async () => {
    // 标准 JSON-RPC 要求 error.id 与对应请求一致；过去写死 null 会让严格客户端无法关联错误。
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'my_stats', arguments: {} } }),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { jsonrpc: string; error: { code: number }; id: number };
    expect(json.jsonrpc).toBe('2.0');
    expect(json.error.code).toBe(-32000);
    expect(json.id).toBe(7);
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

describe('ConfluxScan 工具必须登录后才能调用（防回归）', () => {
  // 这两个工具底层是公开只读的 ConfluxScan API，但调用入口必须登录（已从 PUBLIC_MCP_TOOLS 移除）。
  // 回归保护：防止被重新加回公开集合后，匿名客户端直接拿到链上数据。
  const scanTools = ['list_cfx_transfers', 'list_latest_transactions'] as const;

  for (const name of scanTools) {
    it(`匿名 tools/call ${name} 默认模式返回 401（不泄露数据）`, async () => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': JSON_RPC, Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: { limit: 1 } },
        }),
      });
      expect(res.status).toBe(401);
    });

    it(`匿名 tools/call ${name} 在 anonMode 下返回错误引导而非真实数据`, async () => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': JSON_RPC,
          Accept: 'application/json, text/event-stream',
          'MCP-Unauthorized-Status': '200',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: { limit: 1 } },
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { result?: { isError?: boolean }; error?: unknown };
      // 要么顶层 error，要么 result.isError —— 总之不能出现真实链上数据（如 code:0 / total）
      const body = JSON.stringify(json);
      expect(json.error ?? json.result?.isError).toBeTruthy();
      expect(body).not.toContain('"code":0');
    });
  }
});

describe('MCP-Unauthorized-Status 参数（客户端指定未授权返回码）', () => {
  const post = (body: unknown, status?: string): Promise<Response> => {
    const headers: Record<string, string> = {
      'Content-Type': JSON_RPC,
      Accept: 'application/json, text/event-stream',
    };
    if (status) headers['MCP-Unauthorized-Status'] = status;
    return fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  };
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } },
  };

  it('带 MCP-Unauthorized-Status: 200 时，握手/发现/公开工具放行（200）', async () => {
    const init = await post(initBody, '200');
    expect(init.status).toBe(200);
    const b = (await init.json()) as any;
    expect(b.result?.serverInfo?.name).toBe('mcp-demo');

    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, '200');
    expect(list.status).toBe(200);
    const login = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'login', arguments: {} } }, '200');
    expect(login.status).toBe(200);
    const info = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'server_info', arguments: {} } }, '200');
    expect(info.status).toBe(200);
  });

  it('MCP-Unauthorized-Status: 200 时，受保护工具返回 200 + 登录引导（而非 401）', async () => {
    const whoami = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, '200');
    expect(whoami.status).toBe(200);
    const b = (await whoami.json()) as any;
    expect(b.error?.message ?? '').toMatch(/登录|register/);
  });

  it('不带参数（默认）仍严格 401，符合标准 MCP', async () => {
    const init = await post(initBody);
    expect(init.status).toBe(401);
    expect(init.headers.get('www-authenticate') ?? '').toContain('resource_metadata');
  });

  it('非法参数值（如 500）按默认 401 处理', async () => {
    const init = await post(initBody, '500');
    expect(init.status).toBe(401);
  });
});
