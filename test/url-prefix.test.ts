import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Server } from 'node:http';
import WebSocket from 'ws';

let server: Server;
let origin: string;
const oldPrefix = process.env.URL_PREFIX;
const oldPublic = process.env.PUBLIC_BASE_URL;
const oldAdmin = process.env.ADMIN_TOKEN;

beforeAll(async () => {
  process.env.URL_PREFIX = '/demo';
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:0';
  process.env.ADMIN_TOKEN = 'prefix-test-admin-token';
  const { configure } = await import('../src/db.js');
  const { createApp } = await import('../src/web/app.js');
  const { attachAgentTaskWebSocket } = await import('../src/agent-websocket.js');
  configure({ enabled: false });
  server = createApp().listen(0, '127.0.0.1');
  attachAgentTaskWebSocket(server, (_id, token) => token === 'prefix-test-token');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  process.env.PUBLIC_BASE_URL = origin;
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (oldPrefix === undefined) delete process.env.URL_PREFIX; else process.env.URL_PREFIX = oldPrefix;
  if (oldPublic === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = oldPublic;
  if (oldAdmin === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = oldAdmin;
});

it('mounts pages and browser actions only under the configured prefix', async () => {
  expect((await fetch(`${origin}/`)).status).toBe(404);
  const home = await fetch(`${origin}/demo/`);
  expect(home.status).toBe(200);
  const html = await home.text();
  expect(html).toContain(`href="${origin}/demo/profile"`);
  const register = await fetch(`${origin}/demo/register`);
  expect(await register.text()).toContain('action="/demo/register"');
  expect((await fetch(`${origin}/demo/health`)).status).toBe(200);
  expect((await fetch(`${origin}/demo/setup`)).status).toBe(200);
});

it('keeps the admin username cosmetic and scopes the session cookie', async () => {
  const login = await fetch(`${origin}/demo/admin/login`);
  const html = await login.text();
  expect(html).toContain('name="username"');
  expect(html).toContain('autocomplete="username"');
  expect(html).toContain('action="http://127.0.0.1:');
  const response = await fetch(`${origin}/demo/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: new URLSearchParams({ username: 'anything', token: 'prefix-test-admin-token' }),
  });
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`${origin}/demo/admin`);
  expect(response.headers.get('set-cookie')).toContain('Path=/demo');
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  const admin = await fetch(`${origin}/demo/admin`, { headers: { Cookie: cookie } });
  const dashboard = await admin.text();
  expect(admin.status).toBe(200);
  expect(dashboard).toContain('href="/demo/admin/users"');
  expect(dashboard).toContain("fetch('/demo/admin/api/client-errors'");
  const reset = await fetch(`${origin}/demo/admin/settings/reset`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, Origin: origin },
  });
  expect(reset.status).toBe(302);
  expect(reset.headers.get('location')).toBe(`${origin}/demo/admin/settings?saved=1`);
});

it('scopes the user session cookie to the prefix', async () => {
  const registered = await fetch(`${origin}/demo/register?username=prefix_user`);
  expect(registered.status).toBe(200);
  expect(registered.headers.get('set-cookie')).toContain('Path=/demo');
});

it('publishes prefixed MCP and OAuth discovery URLs', async () => {
  const mcp = await fetch(`${origin}/demo/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'prefix-test', version: '1' } } }) });
  expect(mcp.status).toBe(401);
  expect(mcp.headers.get('www-authenticate')).toContain(`${origin}/.well-known/oauth-protected-resource/demo/mcp`);
  const prm = await fetch(`${origin}/.well-known/oauth-protected-resource/demo/mcp`);
  expect(prm.status).toBe(200);
  expect((await prm.json() as Record<string, unknown>).resource).toBe(`${origin}/demo/mcp`);
  const as = await fetch(`${origin}/.well-known/oauth-authorization-server/demo`);
  expect(as.status).toBe(200);
  const metadata = await as.json() as Record<string, unknown>;
  expect(metadata.issuer).toBe(`${origin}/demo`);
  expect(metadata.authorization_endpoint).toBe(`${origin}/demo/oauth/authorize`);
});

it('accepts the agent WebSocket on the prefixed path', async () => {
  const url = `${origin.replace(/^http/, 'ws')}/demo/ws/agents/11111111-1111-4111-8111-111111111111/tasks?token=prefix-test-token`;
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('message', data => { resolve(JSON.parse(data.toString()) as Record<string, unknown>); socket.close(); });
    socket.once('error', reject);
  });
  expect(ready.type).toBe('ready');
});
