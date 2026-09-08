/**
 * MCP 标准授权发现（Authorization Discovery）的回归测试。
 *
 * 锁住三条契约，任何一条被破坏都会让「客户端识别不了登录方式」这个 bug 回来：
 *   1. 元数据地址必须包含 canonical 路径（`<base>/.well-known/oauth-protected-resource/mcp`），
 *      不能只有根路径 —— 只挂根路径会让客户端 404 后放弃发现。
 *   2. 未鉴权请求必须返回 401 且 `WWW-Authenticate` 里的 resource_metadata 可被官方 SDK 解析。
 *      永远返回 200 的话客户端不会启动任何发现动作。
 *   3. 通知类消息与 GET /mcp 绝不能返回 401，否则客户端初始化阶段就被打断。
 *
 * 本文件刻意**不**设置 MCP_DEMO_REQUIRE_AUTH=off，以覆盖默认（严格）行为。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { configure } from '../src/persist.js';
import { MCP_PATH } from '../src/oauth/metadata.js';

let server: Server;
let base: string;

const JSON_RPC = 'application/json';

/** 官方 SDK 解析 401 头用的正则（client/auth.js:408），格式不能改 */
const RESOURCE_METADATA_RE = /resource_metadata="([^"]*)"/;

beforeAll(async () => {
  configure({ enabled: false });
  vi.stubEnv('MCP_DEMO_REQUIRE_AUTH', 'on'); // 显式锁定严格模式，避免受其它测试文件影响
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

async function mcpPost(body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': JSON_RPC,
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function registerToken(username: string): Promise<string> {
  const res = await fetch(`${base}/register?username=${username}`);
  const html = await res.text();
  const m = html.match(/mcp_demo_[A-Za-z0-9._-]+/);
  expect(m, '一键注册页应返回令牌').toBeTruthy();
  return m![0];
}

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'vitest-oauth', version: '1.0.0' },
  },
};

describe('受保护资源元数据（RFC 9728）', () => {
  it('canonical 路径 <base>/.well-known/oauth-protected-resource/mcp 可用', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource${MCP_PATH}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.resource).toBe(`${base}${MCP_PATH}`);
    expect(Array.isArray(json.authorization_servers)).toBe(true);
    expect((json.authorization_servers as string[]).length).toBeGreaterThan(0);
  });

  it('根路径版本作为兜底也可用', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.resource).toBe(`${base}${MCP_PATH}`);
  });

  it('声明了 scope 与 bearer 方式', async () => {
    const json = (await (
      await fetch(`${base}/.well-known/oauth-protected-resource${MCP_PATH}`)
    ).json()) as Record<string, unknown>;
    expect(json.scopes_supported).toContain('mcp');
    expect(json.bearer_methods_supported).toContain('header');
  });
});

describe('授权服务器元数据（RFC 8414）', () => {
  it('必填字段齐全', async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.issuer).toBe(base);
    expect(json.authorization_endpoint).toBe(`${base}/oauth/authorize`);
    expect(json.token_endpoint).toBe(`${base}/oauth/token`);
    expect(json.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(json.response_types_supported).toContain('code');
    expect(json.code_challenge_methods_supported).toContain('S256');
  });

  it('不声明 client_id_metadata_document_supported（否则 SDK 会绕过我们的 DCR）', async () => {
    const json = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty('client_id_metadata_document_supported');
  });

  it('OIDC 别名 /.well-known/openid-configuration 内容一致', async () => {
    const res = await fetch(`${base}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.issuer).toBe(base);
    expect(json.registration_endpoint).toBe(`${base}/oauth/register`);
  });
});

describe('未鉴权请求的 401 与 WWW-Authenticate', () => {
  it('initialize 未带令牌返回 401，且头可被官方 SDK 正则解析', async () => {
    const res = await mcpPost(initializeBody);
    expect(res.status).toBe(401);
    const header = res.headers.get('www-authenticate') ?? '';
    const match = RESOURCE_METADATA_RE.exec(header);
    expect(match, `WWW-Authenticate 应含 resource_metadata，实际为：${header}`).toBeTruthy();
    expect(match![1]).toBe(`${base}/.well-known/oauth-protected-resource${MCP_PATH}`);
  });

  it('resource_metadata 指向的地址确实能取到元数据', async () => {
    const res = await mcpPost(initializeBody);
    const header = res.headers.get('www-authenticate') ?? '';
    const url = RESOURCE_METADATA_RE.exec(header)?.[1];
    const meta = await fetch(url!);
    expect(meta.status).toBe(200);
  });

  it('带有效令牌时不再 401', async () => {
    const token = await registerToken('oauth_ok_user');
    const res = await mcpPost(initializeBody, token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>;
    expect(json.result?.serverInfo?.name).toBe('mcp-demo');
  });
});

describe('不该 401 的请求', () => {
  it('通知类消息（notifications/*）不要求鉴权', async () => {
    const res = await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).not.toBe(401);
  });

  it('GET /mcp 仍是 405 而非 401（否则 SSE 客户端会死循环）', async () => {
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(405);
  });
});

describe('CORS（浏览器端客户端的硬门槛）', () => {
  it('OPTIONS /mcp 返回 204 并 expose WWW-Authenticate', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });

  it('元数据端点允许任意来源读取', async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
