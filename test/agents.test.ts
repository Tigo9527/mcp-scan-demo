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
    expect(html).toContain("function shareText(url){return '请阅读这个任务，并按要求回报结果。");
    expect(html).not.toContain('请把链接交给 CLI AI');
    expect(html).toContain("content.contentEditable='true'");
    expect(html).toContain('保存并重新生成链接');
    expect(html).toContain('copyGeneratedText(shareText(data.url))');
    expect(html).toContain('显示任务链接');
    expect(html).toContain('linkBox.hidden=!expandedTaskLinks.has(t.id)');
    expect(html).toContain('expandedTaskLinks.add(t.id)');
    expect(html).toContain("openLink.textContent='查看任务'");
    expect(html).toContain("reply.className='task-reply'");
    expect(html).toContain('expandedTaskReplies.has(t.id)');
    expect(html).toContain('shouldDeferTaskRefresh()');
    expect(html).toContain("const latest=tasks.slice().reverse().find(t=>t.result!==null)");
    expect(html).toContain("c.className=t.result!==null?'card task-reported':'card'");
    expect(html).toContain('.btn.link-toggle{background:var(--soft);color:var(--muted);border:1px solid var(--line)}');
    expect(html).toContain('contenteditable="true"');
    expect(html).toContain('task-files');
    expect(html).toContain('clipboardData');
    expect(html).toContain('cancelButton.hidden=t.result!==null');
    expect(html).toContain('toLocaleString(undefined,{dateStyle:\'medium\',timeStyle:\'short\'})');
    expect(html).toContain("label.textContent='你 · '+formatLocalTime(t.createdAt)");
    expect(html).toContain('formatLocalTime(t.tokenExpiresAt)');
    expect(html).toContain('const markdownSource=typeof t.content');
    expect(html).toContain('自动任务');
    expect(html).toContain('automationSwitch');
    expect(html).toContain('task-menu');
    expect(html).toContain("deleteButton.textContent='删除'");
    expect(html).toContain('slice(-5)');
    expect(html).toContain('仅看未回报');
    expect(html).toContain('onlyUnreported');
    expect(html).toContain('class="agent-conversation"');
    expect(html).toContain('playReportSound()');
    expect(html).toContain('上传文件任务');
    expect(html).toContain('upload-tasks');
    expect(html).toContain('t.uploadCommand||shareText(t.url)');
    expect(html).toContain("c.id='task-'+t.id");
    expect(html).toContain("anchor.href='#'+c.id");
    expect(html).toContain('initialTaskScrollPending');
    expect(html).toContain('scrollIntoView({behavior:\'auto\',block:\'start\'})');

    const taskResponse = await post(`${base}/admin/api/agents/${agent.id}/tasks`, { content: '检查代码' }, admin);
    expect(taskResponse.status).toBe(201);
    const { url, taskId }: any = await taskResponse.json();
    const taskList: any = await (await fetch(`${base}/admin/api/agents/${agent.id}/tasks`, { headers: admin })).json();
    expect(taskList[0].url).toBe(url);
    const markdownTaskResponse = await post(`${base}/admin/api/agents/${agent.id}/tasks`, { content: '# Markdown 标题\n\n- 第一项\n- 第二项' }, admin);
    const markdownTask: any = await markdownTaskResponse.json();
    const markdownData: any = await (await fetch(markdownTask.url)).json();
    expect(markdownData.content).toContain('<h1>Markdown 标题</h1>');
    expect(markdownData.content).toContain('<li>第一项</li>');
    const uploadTaskResponse = await post(`${base}/admin/api/agents/${agent.id}/upload-tasks`, {}, { ...admin, Origin: base });
    expect(uploadTaskResponse.status).toBe(201);
    const uploadTask: any = await uploadTaskResponse.json();
    expect(uploadTask.command).toContain('--upload-file ');
    const uploaded = await fetch(uploadTask.uploadUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'uploaded content' });
    expect(uploaded.status).toBe(200);
    const uploadedData: any = await uploaded.json();
    expect(uploadedData.status).toBe('reported');
    expect((await fetch(uploadedData.attachment.url)).status).toBe(200);
    const pollUrl = `${base}/api/agents/${agent.id}/tasks/poll`;
    const pollAgents: any[] = (await (await fetch(`${base}/admin/api/agents`, { headers: admin })).json()) as any[];
    const pollToken = pollAgents.find((a: any) => a.id === agent.id).pollToken;
    expect((await fetch(pollUrl)).status).toBe(401);
    const polled: any = await (await fetch(pollUrl, { headers: { 'X-Agent-Token': pollToken } })).json();
    expect(polled.tasks.some((entry: any) => entry.taskId === taskId)).toBe(true);
    const automationUrl = `${base}/admin/api/agents/${agent.id}/automation`;
    expect((await (await fetch(automationUrl, { headers: admin })).json() as any).state).toBe('off');
    const startResponse = await post(`${automationUrl}/start`, {}, admin);
    expect(startResponse.status).toBe(201);
    const startTask: any = await startResponse.json();
    expect((await (await fetch(automationUrl, { headers: admin })).json() as any).state).toBe('starting');
    expect((await post(`${automationUrl}/start`, {}, admin)).status).toBe(409);
    const startData: any = await (await fetch(startTask.url)).json();
    expect(startData.content).toContain('X-Agent-Token');
    expect((await post(startData.report.url, { result: '已启动自动轮询' })).status).toBe(200);
    expect((await (await fetch(automationUrl, { headers: admin })).json() as any).state).toBe('on');
    const stopResponse = await post(`${automationUrl}/stop`, {}, admin);
    expect(stopResponse.status).toBe(201);
    const stopTask: any = await stopResponse.json();
    expect((await (await fetch(automationUrl, { headers: admin })).json() as any).state).toBe('stopping');
    const stopPolled: any = await (await fetch(pollUrl, { headers: { 'X-Agent-Token': pollToken } })).json();
    expect(stopPolled.tasks.some((entry: any) => entry.taskId === stopTask.taskId)).toBe(true);
    const stopData: any = await (await fetch(stopPolled.tasks.find((entry: any) => entry.taskId === stopTask.taskId).url)).json();
    expect((await post(stopData.report.url, { result: '已停止自动轮询' })).status).toBe(200);
    expect((await (await fetch(automationUrl, { headers: admin })).json() as any).state).toBe('off');
    const editResponse = await fetch(`${base}/admin/api/tasks/${taskId}`, { method: 'PATCH', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '检查更新后的代码' }) });
    expect(editResponse.status).toBe(200);
    const editedData: any = await editResponse.json();
    expect(editedData.url).not.toBe(url);
    const urlAfterEdit = editedData.url;
    const task: any = await (await fetch(urlAfterEdit)).json();
    expect(task.content).toContain('<p>检查更新后的代码</p>');
    expect(task.report.url).toBe(`${urlAfterEdit}/report`);

    const attachmentTask = await post(`${base}/admin/api/agents/${agent.id}/tasks`, {
      content: '<p>文字<img src="data:image/png;base64,aGVsbG8=" alt="贴图"></p>',
      attachments: [{ name: 'note.txt', type: 'text/plain', dataUrl: 'data:text/plain;base64,aGVsbG8=' }],
    }, admin);
    expect(attachmentTask.status).toBe(201);
    const attachmentData: any = await attachmentTask.json();
    expect(attachmentData.attachments[0].name).toBe('note.txt');
    const attachmentList: any = await (await fetch(`${base}/admin/api/agents/${agent.id}/tasks`, { headers: admin })).json();
    const storedAttachment = attachmentList.find((entry: any) => entry.id === attachmentData.taskId).attachments[0];
    expect((await fetch(storedAttachment.url, { headers: admin })).status).toBe(200);
    const externalTask: any = await (await fetch(attachmentData.url)).json();
    expect((await fetch(externalTask.attachments[0].url)).status).toBe(200);
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
    expect((await fetch(`${base}/admin/api/tasks/${taskId}`, { method: 'DELETE', headers: { ...admin, Origin: base } })).status).toBe(200);
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
