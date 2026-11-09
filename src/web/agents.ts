/** Admin AI 对话与限时任务链接。任务数据直接写入现有 Sequelize 数据库。 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { AgentModel, AgentTaskModel, dbEnabled } from '../db.js';
import { config, getAdminToken, isLocalBaseUrl } from '../config.js';
import { isAdminRequest } from './admin.js';
import { deriveBase, requireSameOrigin, wrap } from './http.js';
import { esc, page } from './layout.js';

const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REPORT = 50_000;
const reportAttempts = new Map<string, { count: number; until: number }>();

function taskKey(): Buffer {
  // 公网环境必须配置 ADMIN_TOKEN；把它纳入派生材料，避免 JWT_SECRET 遗留默认值时
  // 任务链接签名只依赖公开的开发密钥。管理员令牌轮换后，旧任务链接随之失效。
  return Buffer.from(hkdfSync('sha256', `${config.jwtSecret}\0${getAdminToken()}`, Buffer.alloc(0), 'mcp-demo-agent-task-v1', 32));
}

function adminOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminRequest(req)) { res.status(403).json({ error: 'Admin 权限不足' }); return; }
  next();
}

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!dbEnabled()) { res.status(503).json({ error: '数据库未启用，无法保存 Agent 任务' }); return; }
  next();
}

function tokenFor(id: string, expiresAt: string): string {
  const expiry = String(Date.parse(expiresAt));
  const payload = `${id}.${expiry}`;
  const sig = createHmac('sha256', taskKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function tokenParts(token: string): { id: string; expiresAt: string } | null {
  const match = /^([0-9a-f-]{36})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, id, expiry, signature] = match;
  const expected = createHmac('sha256', taskKey()).update(`${id}.${expiry}`).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const date = new Date(Number(expiry));
  if (!Number.isFinite(date.getTime())) return null;
  return { id, expiresAt: date.toISOString() };
}

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= limit ? text : null;
}

function linkBase(req: Request): string {
  // 公网链接以部署配置为准，避免 Host / X-Forwarded-Host 污染任务与回报地址。
  const configured = config.publicBaseUrl.trim();
  return configured && /^https?:\/\//i.test(configured) && !isLocalBaseUrl()
    ? configured.replace(/\/+$/, '')
    : deriveBase(req);
}

function row(model: AgentModel | AgentTaskModel): Record<string, unknown> {
  return model.get({ plain: true }) as Record<string, unknown>;
}

function safeMarkdown(source: string): string {
  // Agent 回报通常来自终端输出，单个换行也应在网页中保留；否则 Markdown
  // 会按规范把它折叠为空格，导致 console 与对话页显示不一致。
  const html = marked.parse(source, { async: false, breaks: true, gfm: true }) as string;
  return sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'h1', 'h2', 'h3'],
    allowedAttributes: { a: ['href', 'title', 'rel', 'target'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...attrs, rel: 'noopener noreferrer nofollow', target: '_blank' } }) },
  });
}

async function taskFromToken(token: string): Promise<Record<string, unknown> | null> {
  const parts = tokenParts(token);
  if (!parts || Date.parse(parts.expiresAt) <= Date.now()) return null;
  const task = await AgentTaskModel.findByPk(parts.id);
  if (!task) return null;
  const data = row(task);
  return data.tokenExpiresAt === parts.expiresAt && data.agentId ? data : null;
}

function rateLimited(req: Request): boolean {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const item = reportAttempts.get(ip);
  if (!item || item.until <= now) {
    reportAttempts.set(ip, { count: 1, until: now + 60_000 });
  } else {
    item.count++;
    if (item.count > 60) return true;
  }
  if (reportAttempts.size > 1000) {
    for (const [k, v] of reportAttempts) if (v.until <= now) reportAttempts.delete(k);
  }
  return false;
}

function listHtml(base: string): string {
  return page({ title: 'AI 对话', base, active: 'admin', adminTab: 'agents', body: `
<h1>AI 对话</h1>
<form id="create-agent" class="card">
<label for="agent-name">Agent 名称</label><input id="agent-name" name="name" maxlength="100" required>
<label for="agent-description">描述</label><textarea id="agent-description" name="description" maxlength="2000" rows="3"></textarea>
<p><button class="btn" type="submit">创建 Agent</button></p><p id="create-status" role="status"></p>
</form>
<h2>Agent 列表</h2><div id="agent-list" class="empty">加载中…</div>
<script>
const list=document.getElementById('agent-list'), status=document.getElementById('create-status');
async function loadAgents(){
  const r=await fetch('/admin/api/agents');
  if(!r.ok){list.textContent='加载失败';return;}
  const agents=await r.json();list.replaceChildren();
  if(!agents.length){list.className='empty';list.textContent='暂无 Agent';return;}
  list.className='';
  for(const a of agents){const c=document.createElement('div');c.className='card';
    const link=document.createElement('a');link.href='/admin/agents/'+encodeURIComponent(a.id);link.textContent=a.name;
    const p=document.createElement('p');p.textContent=a.description||'暂无描述';
    const small=document.createElement('small');small.textContent='创建于 '+a.createdAt;
    c.append(link,p,small);list.append(c);}
}
document.getElementById('create-agent').addEventListener('submit',async e=>{
  e.preventDefault();status.textContent='创建中…';const f=new FormData(e.target);
  const r=await fetch('/admin/api/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.get('name'),description:f.get('description')})});
  const data=await r.json();status.textContent=r.ok?'创建成功':data.error||'创建失败';
  if(r.ok){e.target.reset();loadAgents();}
});
loadAgents().catch(()=>{list.textContent='加载失败';});
</script>` });
}

function conversationHtml(base: string, agent: Record<string, unknown>): string {
  return page({ title: `与 ${String(agent.name)} 对话`, base, active: 'admin', adminTab: 'agents', body: `
<p><a href="/admin/agents">← Agent 列表</a></p><h1>${esc(agent.name)}</h1><p>${esc(agent.description)}</p>
<div id="messages" class="empty">加载中…</div>
<form id="create-task" class="card"><label for="task-content">任务内容</label>
<textarea id="task-content" name="content" rows="6" maxlength="20000" required></textarea>
<p><button class="btn" type="submit">生成任务链接</button></p><p id="task-status" role="status"></p>
</form>
<script>
const agentId=${JSON.stringify(String(agent.id))};
const messages=document.getElementById('messages'),status=document.getElementById('task-status');
async function copyGeneratedText(text){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    try{await navigator.clipboard.writeText(text);return true;}catch(_err){}
  }
  const ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');
  ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
  let ok=false;try{ok=document.execCommand('copy');}catch(_err){ok=false;}
  document.body.removeChild(ta);return ok;
}
function shareText(url){return '请阅读这个任务，并按要求回报结果。\\n'+url;}
async function loadTasks(){
  const r=await fetch('/admin/api/agents/'+encodeURIComponent(agentId)+'/tasks');
  if(!r.ok){messages.textContent='加载失败';return;}
  const tasks=await r.json();messages.replaceChildren();
  if(!tasks.length){messages.className='empty';messages.textContent='暂无对话。输入任务后生成链接。';return;}
  messages.className='';
  for(const t of tasks){const c=document.createElement('section');c.className='card';
    const label=document.createElement('strong');label.textContent='你 · '+t.createdAt;
    const content=document.createElement('p');content.className='task-content';content.style.whiteSpace='pre-wrap';content.contentEditable='false';content.textContent=t.content;
    c.append(label,content);
    const editActions=document.createElement('div');editActions.className='row';
    const editButton=document.createElement('button');editButton.type='button';editButton.className='btn small alt';editButton.textContent='编辑';
    const saveButton=document.createElement('button');saveButton.type='button';saveButton.className='btn small';saveButton.textContent='保存并重新生成链接';saveButton.hidden=true;
    const cancelButton=document.createElement('button');cancelButton.type='button';cancelButton.className='btn small alt';cancelButton.textContent='取消';cancelButton.hidden=true;
    editActions.append(editButton,saveButton,cancelButton);c.append(editActions);
    let originalContent=t.content;
    editButton.addEventListener('click',()=>{originalContent=content.textContent||'';content.contentEditable='true';content.classList.add('editing');editButton.hidden=true;saveButton.hidden=false;cancelButton.hidden=false;content.focus();});
    cancelButton.addEventListener('click',()=>{content.textContent=originalContent;content.contentEditable='false';content.classList.remove('editing');editButton.hidden=false;saveButton.hidden=true;cancelButton.hidden=true;});
    saveButton.addEventListener('click',async()=>{const next=(content.textContent||'').trim();if(!next){status.textContent='任务内容不能为空';return;}saveButton.disabled=true;const rr=await fetch('/admin/api/tasks/'+encodeURIComponent(t.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:next})});const dd=await rr.json();saveButton.disabled=false;if(!rr.ok){status.textContent=dd.error||'编辑失败';return;}status.textContent='任务已更新并重新生成链接。';await copyGeneratedText(shareText(dd.url));loadTasks();});
    const linkBox=document.createElement('div');linkBox.className='codeblock';
    const head=document.createElement('div');head.className='cb-head';
    const title=document.createElement('span');title.className='cb-title';title.textContent='任务链接（请交给 CLI AI）';
    const copy=document.createElement('button');copy.type='button';copy.className='btn small copy';copy.textContent='复制';
    head.append(title,copy);const pre=document.createElement('pre');const code=document.createElement('code');code.textContent=shareText(t.url);pre.append(code);linkBox.append(head,pre);c.append(linkBox);
    if(t.result!==null){const reply=document.createElement('div');reply.className='card';
      const who=document.createElement('strong');who.textContent='Agent 回报 · '+t.reportedAt;
      const body=document.createElement('div');body.innerHTML=t.resultHtml;
      reply.append(who,body);c.append(reply);
    }else{const pending=document.createElement('p');pending.className='muted';pending.textContent='等待回报 · 链接有效期至 '+t.tokenExpiresAt;c.append(pending);}
    messages.append(c);}
}
document.getElementById('create-task').addEventListener('submit',async e=>{
  e.preventDefault();status.textContent='生成中…';const content=new FormData(e.target).get('content');
  const r=await fetch('/admin/api/agents/'+encodeURIComponent(agentId)+'/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})});
  const data=await r.json();
  if(!r.ok){status.textContent=data.error||'生成失败';return;}
  e.target.reset();
  const copied=await copyGeneratedText(shareText(data.url));
  status.textContent=copied?'链接已生成并自动复制，有效期 7 天。链接持有人可读取任务并回报。':'链接已生成，但浏览器未能自动复制，请点击“复制”。';
  loadTasks();
});
loadTasks().catch(()=>{messages.textContent='加载失败';});setInterval(()=>loadTasks().catch(()=>{}),5000);
</script>` });
}

export function createAgentRouter(): Router {
  const router = Router();
  router.use(['/admin/agents', '/admin/api/agents', '/api/tasks'], (_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/admin/agents', adminOnly, requireDb, (req, res) => res.type('html').send(listHtml(deriveBase(req))));
  router.get('/admin/agents/:id', adminOnly, requireDb, wrap(async (req, res) => {
    const agent = await AgentModel.findByPk(req.params.id);
    if (!agent) { res.status(404).type('text').send('Agent 不存在'); return; }
    res.type('html').send(conversationHtml(deriveBase(req), row(agent)));
  }));

  router.get('/admin/api/agents', adminOnly, requireDb, wrap(async (_req, res) => {
    const agents = await AgentModel.findAll({ order: [['createdAt', 'DESC']] });
    res.json(agents.map(row));
  }));
  router.post('/admin/api/agents', adminOnly, requireSameOrigin, requireDb, wrap(async (req, res) => {
    const name = cleanText(req.body?.name, 100);
    const description = req.body?.description === undefined || req.body?.description === '' ? '' : cleanText(req.body.description, 2000);
    if (!name || description === null) { res.status(400).json({ error: '名称必填且不超过 100 字，描述不超过 2000 字' }); return; }
    const agent = await AgentModel.create({ id: randomUUID(), name, description, createdBy: 'admin', createdAt: new Date().toISOString() });
    res.status(201).json(row(agent));
  }));

  router.get('/admin/api/agents/:id/tasks', adminOnly, requireDb, wrap(async (req, res) => {
    if (!(await AgentModel.findByPk(req.params.id))) { res.status(404).json({ error: 'Agent 不存在' }); return; }
    const tasks = await AgentTaskModel.findAll({ where: { agentId: req.params.id }, order: [['createdAt', 'ASC']] });
    res.json(tasks.map(t => { const d = row(t); const token = tokenFor(String(d.id), String(d.tokenExpiresAt)); return { ...d, url: `${linkBase(req)}/api/tasks/${token}`, resultHtml: d.result === null ? null : safeMarkdown(String(d.result)) }; }));
  }));
  router.post('/admin/api/agents/:id/tasks', adminOnly, requireSameOrigin, requireDb, wrap(async (req, res) => {
    if (!(await AgentModel.findByPk(req.params.id))) { res.status(404).json({ error: 'Agent 不存在' }); return; }
    const content = cleanText(req.body?.content, 20_000);
    if (!content) { res.status(400).json({ error: '任务内容必填且不超过 20000 字' }); return; }
    const id = randomUUID(), tokenExpiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    await AgentTaskModel.create({ id, agentId: req.params.id, content, tokenExpiresAt, status: 'pending', result: null, reportedAt: null, reportSource: null, createdAt: new Date().toISOString() });
    const token = tokenFor(id, tokenExpiresAt);
    res.status(201).json({ taskId: id, url: `${linkBase(req)}/api/tasks/${token}`, expiresAt: tokenExpiresAt });
  }));

  router.patch('/admin/api/tasks/:id', adminOnly, requireSameOrigin, requireDb, wrap(async (req, res) => {
    const content = cleanText(req.body?.content, 20_000);
    if (!content) { res.status(400).json({ error: '任务内容必填且不超过 20000 字' }); return; }
    const task = await AgentTaskModel.findByPk(req.params.id);
    if (!task) { res.status(404).json({ error: '任务不存在' }); return; }
    const tokenExpiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    await task.update({ content, tokenExpiresAt, status: 'pending', result: null, reportedAt: null, reportSource: null });
    const url = `${linkBase(req)}/api/tasks/${tokenFor(req.params.id, tokenExpiresAt)}`;
    res.json({ taskId: req.params.id, url, expiresAt: tokenExpiresAt });
  }));

  router.get('/api/tasks/:token', requireDb, wrap(async (req, res) => {
    const task = await taskFromToken(req.params.token);
    if (!task) { res.status(403).json({ error: '任务凭证无效或已过期' }); return; }
    const agent = await AgentModel.findByPk(String(task.agentId));
    if (!agent) { res.status(404).json({ error: 'Agent 不存在' }); return; }
    const url = `${linkBase(req)}/api/tasks/${req.params.token}/report`;
    res.json({ taskId: task.id, agent: { id: agent.get('id'), name: agent.get('name'), description: agent.get('description') }, content: task.content, status: task.status, expiresAt: task.tokenExpiresAt, report: { url, method: 'POST', contentType: 'application/json', body: { result: 'Markdown 格式的任务结果' }, rule: '首次回报生效；相同内容重复提交幂等，不同内容返回 409。凭证已包含在 URL 中，7 天后失效。' } });
  }));
  router.post('/api/tasks/:token/report', requireSameOrigin, requireDb, wrap(async (req, res) => {
    if (rateLimited(req)) { res.status(429).json({ error: '回报过于频繁' }); return; }
    const task = await taskFromToken(req.params.token);
    if (!task) { res.status(403).json({ error: '任务凭证无效或已过期' }); return; }
    const result = cleanText(req.body?.result, MAX_REPORT);
    if (!result) { res.status(400).json({ error: 'result 必填且不超过 50000 字' }); return; }
    const reportedAt = new Date().toISOString();
    const [updated] = await AgentTaskModel.update({ status: 'reported', result, reportedAt, reportSource: req.ip || 'unknown' }, { where: { id: task.id, status: 'pending' } });
    if (!updated) {
      const current = await AgentTaskModel.findByPk(String(task.id));
      if (current?.get('result') === result) { res.json({ ok: true, taskId: task.id, idempotent: true }); return; }
      res.status(409).json({ error: '任务已有不同回报' }); return;
    }
    res.json({ ok: true, taskId: task.id, reportedAt });
  }));
  return router;
}
