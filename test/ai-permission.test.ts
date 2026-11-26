import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { closeDb, initDb } from '../src/db.js';
import * as auth from '../src/auth/manager.js';
import * as store from '../src/auth/store.js';
import { isAiChatEntryEnabled, reloadAppSettingsFromDb } from '../src/app-settings.js';

describe('普通用户 AI 对话权限', () => {
  let server: Server; let base: string; let dataDir: string; let user: auth.AuthResult; let other: auth.AuthResult; let agent: any;
  const admin = 'ai-permission-test-admin';
  beforeAll(async () => {
    process.env.ADMIN_TOKEN = admin;
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-ai-permission-'));
    await initDb({ enabled: true, dataDir });
    await reloadAppSettingsFromDb();
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
    expect(await home.text()).not.toContain('AI 对话');
    expect((await fetch(`${base}/agents`, { headers: { 'X-Authorization': user.token } })).status).toBe(200);
    const dashboard = await fetch(`${base}/admin`, { headers: { 'X-Admin-Token': admin } });
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('开启入口');
    expect(dashboardHtml).not.toContain('href="/admin/agents"');
    const denied = await fetch(`${base}/admin/ai-chat-entry`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Admin-Token': admin, Origin: 'https://evil.example' }, body: 'enabled=1' });
    expect(denied.status).toBe(403);
    const enabled = await fetch(`${base}/admin/ai-chat-entry`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Admin-Token': admin, Origin: base }, body: 'enabled=1', redirect: 'manual' });
    expect(enabled.status).toBe(302);
    expect(isAiChatEntryEnabled()).toBe(true);
    expect(await (await fetch(`${base}/`, { headers: { 'X-Authorization': user.token } })).text()).toContain('AI 对话');
    expect(await (await fetch(`${base}/admin`, { headers: { 'X-Admin-Token': admin } })).text()).toContain('href="/admin/agents"');
    await reloadAppSettingsFromDb();
    expect(isAiChatEntryEnabled()).toBe(true);
    const disabled = await fetch(`${base}/admin/ai-chat-entry`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Admin-Token': admin, Origin: base }, body: 'enabled=0', redirect: 'manual' });
    expect(disabled.status).toBe(302);
    expect(await (await fetch(`${base}/`, { headers: { 'X-Authorization': user.token } })).text()).not.toContain('AI 对话');
    const task = await fetch(`${base}/api/user/agents/${agent.id}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authorization': user.token, Origin: base }, body: JSON.stringify({ content: '检查代码' }) });
    expect(task.status).toBe(201);
    expect(((await (await fetch(`${base}/api/user/agents/${agent.id}/tasks`, { headers: { 'X-Authorization': user.token } })).json()) as any[]).length).toBe(1);
    expect((await fetch(`${base}/api/user/agents/${agent.id}/tasks`, { headers: { 'X-Authorization': other.token } })).status).toBe(403);
  });

  it('普通用户不能借权限调用 Admin API', async () => {
    const res = await fetch(`${base}/admin/api/agents`, { headers: { 'X-Authorization': user.token } });
    expect(res.status).toBe(403);
  });

  it('有 AI 对话权限的用户可创建自己的 Agent，其他用户不可访问', async () => {
    const grant = await fetch(`${base}/admin/users/${other.user.id}/ai-chat`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Admin-Token': admin, Origin: base }, body: 'enabled=1', redirect: 'manual' });
    expect(grant.status).toBe(302);
    const page = await fetch(`${base}/agents`, { headers: { 'X-Authorization': user.token } });
    const html = await page.text();
    expect(html).toContain('id="create-agent"');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(source => source.includes("document.getElementById('create-agent').addEventListener"));
    expect(script).toBeDefined();
    expect(() => new Script(script!)).not.toThrow();
    const body = JSON.stringify({ name: 'My Agent', description: '仅供本人使用' });
    const denied = await fetch(`${base}/api/user/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'X-Authorization': user.token }, body });
    expect(denied.status).toBe(403);
    const created = await fetch(`${base}/api/user/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Authorization': user.token }, body });
    expect(created.status).toBe(201);
    const mine = await created.json() as { id: string; createdBy: string; name: string };
    expect(mine.createdBy).toBe(user.user.id);
    expect(mine.name).toBe('My Agent');
    const ownList = await (await fetch(`${base}/api/user/agents`, { headers: { 'X-Authorization': user.token } })).json() as Array<{ id: string }>;
    expect(ownList.map(a => a.id)).toContain(mine.id);
    const otherList = await (await fetch(`${base}/api/user/agents`, { headers: { 'X-Authorization': other.token } })).json() as Array<{ id: string }>;
    expect(otherList.map(a => a.id)).not.toContain(mine.id);
    expect((await fetch(`${base}/agents/${mine.id}`, { headers: { 'X-Authorization': other.token } })).status).toBe(404);
    const otherTask = await fetch(`${base}/api/user/agents/${mine.id}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Authorization': other.token }, body: JSON.stringify({ content: '不应创建' }) });
    expect(otherTask.status).toBe(404);
    const ownTask = await fetch(`${base}/api/user/agents/${mine.id}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Authorization': user.token }, body: JSON.stringify({ content: '检查我的任务' }) });
    expect(ownTask.status).toBe(201);
  });
});
