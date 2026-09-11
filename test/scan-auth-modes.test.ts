/**
 * ConfluxScan 工具（list_cfx_transfers / list_latest_transactions）鉴权契约的**补漏**测试。
 *
 * 契约：**访问 scan 数据必须登录，任何模式下都是。** 链上数据公开 ≠ 本服务工具匿名可用。
 *
 * test/integration.test.ts 已覆盖默认 401 模式与 `MCP-Unauthorized-Status: 200` 模式，
 * 本文件补上剩下的两种漏网场景：
 *   1. `MCP_DEMO_REQUIRE_AUTH=off`（逃生通道）—— 路由层完全不拦，只剩工具内部的
 *      `getCurrentUser()` 这一道单点保险，一旦有人删掉那几行就会直接泄露链上数据；
 *   2. 批量请求（JSON-RPC batch）里混入 scan 工具 —— 匿名放行判定是 `every()`，
 *      只要 batch 里有一条不合规就该整批拒绝。
 *
 * 判据不看 HTTP 状态码（它随模式变化），而是看**响应体绝不能出现 Scan 的数据特征**。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { configure } from '../src/persist.js';

/** 埋进 mock 上游响应里的数据特征：一旦出现在匿名响应中，说明鉴权被绕过 */
const SCAN_MARKER = 'MOCK-SCAN-DATA-SHOULD-NOT-LEAK';
const ACCOUNT = 'cfx:aanjcf1esdz50j6zhkm0k60wc7669tfkw28mzudg24';

let server: Server;
let base: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  configure({ enabled: false });
  // 拦截 Scan 上游：既不打真实外网，又能埋入可断言的数据特征。
  // 测试给本地服务发请求也走 fetch，故非 Scan 的 URL 一律放行给真实实现。
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
    if (url.includes('confluxscan')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, message: 'OK', data: { list: [{ hash: SCAN_MARKER }] } }),
      } as unknown as Response);
    }
    return realFetch(input as Request, init);
  });

  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

async function mcpCall(
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, text: await res.text() };
}

/** 入参必须合法，否则会先被 schema 校验挡下，根本走不到登录检查 */
const SCAN_CALLS = [
  {
    name: 'list_cfx_transfers',
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_cfx_transfers', arguments: { account: ACCOUNT, limit: 2 } },
    },
  },
  {
    name: 'list_latest_transactions',
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_latest_transactions', arguments: { limit: 2 } },
    },
  },
];

async function registerToken(username: string): Promise<string> {
  const res = await fetch(`${base}/register?username=${username}`);
  expect(res.ok).toBe(true);
  const m = /mcp_demo_[A-Za-z0-9._-]+/.exec(await res.text());
  expect(m, '注册页应返回令牌').not.toBeNull();
  return m![0];
}

describe('MCP_DEMO_REQUIRE_AUTH=off（逃生通道）下 scan 仍然必须登录', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(SCAN_CALLS)('匿名调用 $name → 拿不到数据，只拿到登录引导', async ({ payload }) => {
    vi.stubEnv('MCP_DEMO_REQUIRE_AUTH', 'off');
    const res = await mcpCall(payload);

    // 该模式路由层放行，但还有两道保险：计费层拦在工具执行之前（401 + 「请先登录」），
    // 万一哪天绕过计费，工具内部还有 getCurrentUser() 检查（200 + 「未登录」引导）。
    // 走哪条路径都可能，唯一不变的是——**拿不到数据**。
    expect(res.text).not.toContain(SCAN_MARKER);
    expect(res.text).toMatch(/未登录|请先登录/);
  });

  it('逃生通道下公开工具仍可用（证明上面不是整体 500 导致的假通过）', async () => {
    vi.stubEnv('MCP_DEMO_REQUIRE_AUTH', 'off');
    const res = await mcpCall({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'server_info', arguments: {} },
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('mcp-demo');
  });
});

describe('批量请求里混入 scan 工具', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('anonMode 下 initialize + scan 的 batch 整批被拒，不返回数据', async () => {
    const res = await mcpCall(
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 't', version: '1' },
          },
        },
        SCAN_CALLS[1].payload,
      ],
      { 'MCP-Unauthorized-Status': '200' },
    );
    expect(res.text).not.toContain(SCAN_MARKER);
  });
});

describe('登录后可以正常拿到数据（确认上面的判据真的有效）', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(SCAN_CALLS)('带令牌调用 $name → 返回含数据特征的正常结果', async ({ payload }) => {
    const token = await registerToken(`scan-mode-${Math.random().toString(36).slice(2, 8)}`);
    const res = await mcpCall(payload, { 'X-Authorization': `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.text).toContain(SCAN_MARKER);
    expect(res.text).not.toContain('未登录');
  });
});
