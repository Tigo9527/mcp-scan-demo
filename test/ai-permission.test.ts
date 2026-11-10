import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { closeDb, initDb } from '../src/db.js';
import * as auth from '../src/auth/manager.js';
import * as store from '../src/auth/store.js';

describe('普通用户 AI 对话权限', () => {
  let server: Server; let base: string; let dataDir: string; let user: auth.AuthResult; let other: auth.AuthResult; let agent: any;
  const admin = 'ai-permission-test-admin';
  beforeAll(async () => {
    process.env.ADMIN_TOKEN = admin;
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-ai-permission-'));
    await initDb({ enabled: true, dataDir });
    user = auth.registerOneClick({ username: 'ai_user' });
    other = auth.registerOneClick({ username: 'ai_other' });
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const a = server.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    const res = await fetch(`${base}/admin/api/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': admin, Origin: base }, body: JSON.stringify({ name: 'Review Bot' }) });
    agent = await res.json();
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

  it('默认不显示页签且普通用户不能访问', async () => {
    const home = await fetch(`${base}/`, { headers: { 'X-Authorization': user.token } });
    expect(await home.text()).not.toContain('AI 对话');
    expect((await fetch(`${base}/agents`, { headers: { 'X-Authorization': user.token } })).status).toBe(403);
  });

  it('Admin 授权后可访问，任务只返回给任务所属用户', async () => {
    const grant = await fetch(`${base}/admin/users/${user.user.id}/ai-chat`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Admin-Token': admin, Origin: base }, body: 'enabled=1', redirect: 'manual' });
    expect(grant.status).toBe(302);
    expect(store.getUser(user.user.id)?.aiChatEnabled).toBe(true);
    const home = await fetch(`${base}/`, { headers: { 'X-Authorization': user.token } });
    expect(await home.text()).toContain('AI 对话');
    expect((await fetch(`${base}/agents`, { headers: { 'X-Authorization': user.token } })).status).toBe(200);
    const task = await fetch(`${base}/api/user/agents/${agent.id}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authorization': user.token, Origin: base }, body: JSON.stringify({ content: '检查代码' }) });
    expect(task.status).toBe(201);
    expect(((await (await fetch(`${base}/api/user/agents/${agent.id}/tasks`, { headers: { 'X-Authorization': user.token } })).json()) as any[]).length).toBe(1);
    expect((await fetch(`${base}/api/user/agents/${agent.id}/tasks`, { headers: { 'X-Authorization': other.token } })).status).toBe(403);
  });

  it('普通用户不能借权限调用 Admin API', async () => {
    const res = await fetch(`${base}/admin/api/agents`, { headers: { 'X-Authorization': user.token } });
    expect(res.status).toBe(403);
  });
});
