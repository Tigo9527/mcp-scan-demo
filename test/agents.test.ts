import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { AgentTaskModel, closeDb, initDb } from '../src/db.js';

describe('Admin AI 对话和任务链接', () => {
  let server: Server;
  let base: string;
  let dataDir: string;
  const admin = { 'X-Admin-Token': 'agent-test-admin-token' };
  const oldAdminToken = process.env.ADMIN_TOKEN;

  beforeAll(async () => {
    process.env.ADMIN_TOKEN = admin['X-Admin-Token'];
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-agent-test-'));
    await initDb({ enabled: true, dataDir });
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await closeDb();
    rmSync(dataDir, { recursive: true, force: true });
    if (oldAdminToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = oldAdminToken;
  });

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  it('Admin 创建 Agent 和任务，CLI 获取并回报，页面安全展示 Markdown', async () => {
    expect((await fetch(`${base}/admin/agents`)).status).toBe(403);
    expect((await fetch(`${base}/admin/api/agents`)).status).toBe(403);
    expect((await post(`${base}/admin/api/agents`, { name: 'x' })).status).toBe(403);

    const create = await post(`${base}/admin/api/agents`, { name: ' Review Bot ', description: '测试' }, admin);
    expect(create.status).toBe(201);
    const agent: any = await create.json();
    expect(agent.name).toBe('Review Bot');
    const list: any = await (await fetch(`${base}/admin/api/agents`, { headers: admin })).json();
    expect(list.some((a: { id: string }) => a.id === agent.id)).toBe(true);
    const page = await fetch(`${base}/admin/agents/${agent.id}`, { headers: admin });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('生成任务链接');
    expect(html).toContain('它应从这里获取任务，并按要求回报结果');
    expect(html).toContain('copyGeneratedText(data.url)');

    const taskResponse = await post(`${base}/admin/api/agents/${agent.id}/tasks`, { content: '检查代码' }, admin);
    expect(taskResponse.status).toBe(201);
    const { url, taskId }: any = await taskResponse.json();
    const taskList: any = await (await fetch(`${base}/admin/api/agents/${agent.id}/tasks`, { headers: admin })).json();
    expect(taskList[0].url).toBe(url);
    const editResponse = await fetch(`${base}/admin/api/tasks/${taskId}`, { method: 'PATCH', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '检查更新后的代码' }) });
    expect(editResponse.status).toBe(200);
    const editedData: any = await editResponse.json();
    expect(editedData.url).not.toBe(url);
    const urlAfterEdit = editedData.url;
    const task: any = await (await fetch(urlAfterEdit)).json();
    expect(task.content).toBe('检查更新后的代码');
    expect(task.report.url).toBe(`${urlAfterEdit}/report`);
    expect((await fetch(`${base}/api/tasks/not-valid`)).status).toBe(403);
    expect((await post(`${base}/api/tasks/not-valid/report`, { result: 'bad' })).status).toBe(403);

    const report = '**完成** <script>alert(1)</script>\n第二行 [链接](javascript:alert(1))';
    expect((await post(task.report.url, { result: report })).status).toBe(200);
    const repeat = await post(task.report.url, { result: report });
    expect(((await repeat.json()) as any).idempotent).toBe(true);
    expect((await post(task.report.url, { result: '替换' })).status).toBe(409);

    const messages: any = await (await fetch(`${base}/admin/api/agents/${agent.id}/tasks`, { headers: admin })).json();
    expect(messages[0].id).toBe(taskId);
    expect(messages[0].status).toBe('reported');
    expect(messages[0].resultHtml).toContain('<strong>完成</strong>');
    expect(messages[0].resultHtml).toContain('<br />');
    expect(messages[0].resultHtml).not.toContain('<script>');
    expect(messages[0].resultHtml).not.toContain('href="javascript:');
    expect((await fetch(`${base}/admin/api/agents/${agent.id}/tasks`)).status).toBe(403);
  });

  it('拒绝跨站写入、非法内容与过期链接', async () => {
    const list: any = await (await fetch(`${base}/admin/api/agents`, { headers: admin })).json();
    const agentId = list[0].id;
    expect((await post(`${base}/admin/api/agents`, { name: 'CSRF' }, { ...admin, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(`${base}/admin/api/agents/${agentId}/tasks`, { content: 'x' }, { ...admin, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(`${base}/admin/api/agents/${agentId}/tasks`, { content: '' }, admin)).status).toBe(400);
    const response = await post(`${base}/admin/api/agents/${agentId}/tasks`, { content: '等待' }, admin);
    const { url, taskId }: any = await response.json();
    expect((await post(`${url}/report`, { result: 'x'.repeat(50_001) })).status).toBe(400);
    expect((await post(`${url}/report`, { result: 'ok' }, { Origin: 'https://evil.example' })).status).toBe(403);
    await AgentTaskModel.update({ tokenExpiresAt: new Date(0).toISOString() }, { where: { id: taskId } });
    expect((await fetch(url)).status).toBe(403);
    expect((await post(`${url}/report`, { result: 'ok' })).status).toBe(403);
  });
});
