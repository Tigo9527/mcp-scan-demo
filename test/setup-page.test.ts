/**
 * 免登录接入页 /setup 的回归测试。
 *
 * 核心契约：这个页面（以及首页的配置块）是**直接转发给新用户**的，
 * 因此**绝不能出现任何真实令牌**。一旦有人手滑把 ?token= 或 result.token 拼进去，
 * 下面的断言会立刻变红。
 *
 * 同时锁住：配置 JSON 必须是合法 JSON、可匿名访问、带一键复制按钮、内容经过 esc。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp, publicMcpConfigJson } from '../src/web/app.js';
import { copyBlock } from '../src/web/layout.js';
import { configure } from '../src/persist.js';

let server: Server;
let base: string;

/** 真实令牌的形状：mcp_demo_ 前缀 + 一长串 */
const TOKEN_RE = /mcp_demo_[A-Za-z0-9._-]{8,}/;
const JSON_RPC = 'application/json';

beforeAll(async () => {
  configure({ enabled: false });
  // 末尾两组用例是匿名调用 MCP 工具，需要关闭严格鉴权；严格模式见 test/oauth.test.ts
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

async function get(path: string): Promise<{ status: number; body: string }> {
  // 刻意不带任何 Cookie / Authorization，模拟「新用户直接打开链接」
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.text() };
}

async function mcpCall(method: string, params: unknown, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': JSON_RPC,
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

describe('免登录接入页 /setup', () => {
  it('无需任何令牌 / Cookie 即可访问', async () => {
    const { status, body } = await get('/setup');
    expect(status).toBe(200);
    expect(body).toContain('<title>接入 MCP 客户端</title>');
  });

  it('给出可直接复制、且不含令牌的 mcpServers 配置', async () => {
    const { body } = await get('/setup');
    expect(body).toContain('mcpServers');
    // 代码块内容经过 esc()，引号会变成 &quot;；浏览器取 textContent 时还原成原文
    expect(body).toContain(`&quot;url&quot;: &quot;${base}/mcp&quot;`);
    expect(body).toContain('streamable-http');
  });

  it('页面上绝不出现真实令牌', async () => {
    const { body } = await get('/setup');
    expect(body).not.toMatch(TOKEN_RE);
    expect(body).not.toContain('?token=mcp_demo_');
  });

  it('带令牌的写法用占位符，并明确提示不要用 Authorization 头', async () => {
    const { body } = await get('/setup');
    // 占位符经 esc 后应为 &lt;你的令牌&gt;
    expect(body).toContain('&lt;你的令牌&gt;');
    expect(body).toContain('X-Authorization');
    expect(body).toContain('Authorization</code> 头传令牌');
  });

  it('提供一键复制按钮与 curl 冒烟命令', async () => {
    const { body } = await get('/setup');
    expect(body).toContain('class="btn small copy"');
    expect(body).toContain('curl -s');
    expect(body).toContain('/health');
    expect(body).toContain('initialize');
  });

  it('导航栏有「接入配置」入口', async () => {
    const { body } = await get('/setup');
    expect(body).toContain(`href="${base}/setup"`);
    expect(body).toContain('接入配置');
  });
});

describe('首页的免登录配置块', () => {
  it('首页也直接给出可复制的不含令牌配置，并链到 /setup', async () => {
    const { body } = await get('/');
    expect(body).toContain(`&quot;url&quot;: &quot;${base}/mcp&quot;`);
    expect(body).toContain('class="btn small copy"');
    expect(body).toContain(`href="${base}/setup"`);
  });

  it('首页同样不含真实令牌', async () => {
    const { body } = await get('/');
    expect(body).not.toMatch(TOKEN_RE);
  });
});

describe('配置生成与转义', () => {
  it('publicMcpConfigJson 是合法 JSON、指向 /mcp 且不含 token', () => {
    const json = publicMcpConfigJson(base);
    const parsed = JSON.parse(json) as {
      mcpServers: Record<string, { url: string; transport: string }>;
    };
    expect(parsed.mcpServers['mcp-demo'].url).toBe(`${base}/mcp`);
    expect(parsed.mcpServers['mcp-demo'].transport).toBe('streamable-http');
    expect(json).not.toContain('token');
  });

  it('copyBlock 对内容做 HTML 转义（防 XSS）', () => {
    const html = copyBlock('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)');
  });
});

/** 工具返回体是 { content: [{ type:'text', text: '<JSON 字符串>' }] }，这里解出原文对象 */
function unwrapToolPayload(res: unknown): Record<string, any> {
  const content = (res as { result?: { content?: Array<{ text?: string }> } }).result?.content;
  const raw = content?.[0]?.text ?? '{}';
  return JSON.parse(raw) as Record<string, any>;
}

describe('MCP 工具里的接入信息', () => {
  it('server_info 返回 setupUrl 与可直接用的 mcpConfig', async () => {
    const data = unwrapToolPayload(await mcpCall('tools/call', { name: 'server_info', arguments: {} }));
    expect(data.setupUrl).toBe(`${base}/setup`);
    expect(data.mcpConfig?.mcpServers?.['mcp-demo']?.url).toBe(`${base}/mcp`);
  });

  it('login 工具返回 setupUrl 与 mcpConfig（未登录引导用）', async () => {
    const data = unwrapToolPayload(await mcpCall('tools/call', { name: 'login', arguments: {} }));
    expect(data.setupUrl).toBe(`${base}/setup`);
    expect(data.mcpConfig?.mcpServers?.['mcp-demo']?.url).toBe(`${base}/mcp`);
    expect(data.mcpConfig).not.toHaveProperty('token');
  });
});
