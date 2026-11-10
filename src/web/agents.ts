/** Admin AI 对话与限时任务链接。任务数据直接写入现有 Sequelize 数据库。 */
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { AgentModel, AgentTaskModel, AgentAutomationModel, dbEnabled } from '../db.js';
import { config, getAdminToken, isLocalBaseUrl } from '../config.js';
import { isAdminRequest } from './admin.js';
import { deriveBase, requireSameOrigin, wrap } from './http.js';
import { esc, page } from './layout.js';
import { publishAgentTask } from '../agent-websocket.js';

const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REPORT = 50_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_DIR = path.resolve(config.dataDir, 'agent-attachments');
const reportAttempts = new Map<string, { count: number; until: number }>();
type AutomationState = 'off' | 'starting' | 'on' | 'stopping';

async function automationFor(agentId: string): Promise<{ state: AutomationState; controlTaskId: string | null; taskSince: string | null }> {
  const record = await AgentAutomationModel.findByPk(agentId);
  return record ? { state: record.get('state') as AutomationState, controlTaskId: record.get('controlTaskId') as string | null, taskSince: record.get('taskSince') as string | null } : { state: 'off', controlTaskId: null, taskSince: null };
}

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

function pollTokenFor(agentId: string): string {
  return createHmac('sha256', taskKey()).update(`poll.${agentId}`).digest('base64url');
}

export function pollTokenMatchesValue(supplied: string, agentId: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  const expected = Buffer.from(pollTokenFor(agentId));
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function pollTokenMatches(req: Request, agentId: string): boolean {
  return pollTokenMatchesValue(String(req.headers['x-agent-token'] || ''), agentId);
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

type AttachmentMeta = { name: string; type: string; size: number; path: string; createdAt: string };
function cleanAttachmentName(name: unknown): string { return String(name || 'attachment').replace(/[^\w.()\-\u4e00-\u9fff ]/g, '_').slice(0, 120) || 'attachment'; }
function cleanupAttachments(): void {
  try {
    if (!fs.existsSync(ATTACHMENT_DIR)) return;
    const cutoff = Date.now() - ATTACHMENT_TTL_MS;
    for (const name of fs.readdirSync(ATTACHMENT_DIR)) {
      const file = path.join(ATTACHMENT_DIR, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file); } catch { /* 单个过期文件失败不影响其它任务 */ }
    }
  } catch { /* 磁盘清理失败不影响任务接口 */ }
}
function saveAttachments(taskId: string, raw: unknown): AttachmentMeta[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`附件最多 ${MAX_ATTACHMENTS} 个`);
  fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  const saved: AttachmentMeta[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('附件格式无效');
    const input = item as { name?: unknown; type?: unknown; dataUrl?: unknown };
    const match = typeof input.dataUrl === 'string' ? /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(input.dataUrl) : null;
    if (!match) throw new Error('附件必须是 base64 data URL');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('单个附件不能超过 5MB');
    const stored = `${taskId}-${randomUUID()}.bin`;
    fs.writeFileSync(path.join(ATTACHMENT_DIR, stored), buffer, { flag: 'wx' });
    saved.push({ name: cleanAttachmentName(input.name), type: match[1], size: buffer.length, path: stored, createdAt: new Date().toISOString() });
  }
  return saved;
}
function attachmentMeta(taskId: string): AttachmentMeta[] {
  const file = path.join(ATTACHMENT_DIR, `${taskId}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as AttachmentMeta[]; } catch { return []; }
}
function writeAttachmentMeta(taskId: string, raw: unknown): AttachmentMeta[] {
  const list = saveAttachments(taskId, raw);
  fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ATTACHMENT_DIR, `${taskId}.json`), JSON.stringify(list));
  return list;
}
function deleteAttachmentMeta(taskId: string): void {
  for (const a of attachmentMeta(taskId)) { try { fs.rmSync(path.join(ATTACHMENT_DIR, a.path), { force: true }); } catch {} }
  try { fs.rmSync(path.join(ATTACHMENT_DIR, `${taskId}.json`), { force: true }); } catch {}
}
function saveUploadedFile(taskId: string, buffer: Buffer, name: string, type: string): AttachmentMeta {
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('文件不能为空且不能超过 5MB');
  fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  const stored = `${taskId}-${randomUUID()}.bin`;
  fs.writeFileSync(path.join(ATTACHMENT_DIR, stored), buffer, { flag: 'wx' });
  const cleanName = cleanAttachmentName(name) || 'uploaded-file';
  const item: AttachmentMeta = { name: cleanName, type: detectUploadType(cleanName, type, buffer), size: buffer.length, path: stored, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(ATTACHMENT_DIR, `${taskId}.json`), JSON.stringify([item]));
  return item;
}
function detectUploadType(name: string, declared: string, buffer: Buffer): string {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  const ext = path.extname(name).toLowerCase();
  const known: Record<string, string> = { '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.zip': 'application/zip', '.gz': 'application/gzip', '.pdf': 'application/pdf' };
  return known[ext] || declared || 'application/octet-stream';
}
cleanupAttachments();
const attachmentCleanupTimer = setInterval(cleanupAttachments, 60 * 60 * 1000);
attachmentCleanupTimer.unref();

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
function safeTaskContent(source: string): string {
  const html = /<\/?[a-z][^>]*>/i.test(source) ? source : marked.parse(source, { async: false, breaks: true, gfm: true }) as string;
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'pre', 'code', 'a', 'img'],
    allowedAttributes: { img: ['src', 'alt', 'title', 'width', 'height'] },
    allowedSchemes: ['http', 'https', 'mailto', 'data', 'attachment'],
    allowedSchemesByTag: { img: ['data', 'attachment', 'http', 'https'] },
  });
}
function taskContentWithAttachmentUrls(source: string, taskId: string, token: string, req: Request): string {
  let html = safeTaskContent(source);
  const attachments = attachmentMeta(taskId);
  html = html.replace(/src=["']attachment:\/\/(\d+)["']/gi, (_all, index) => {
    const item = attachments[Number(index)];
    return item ? `src="${linkBase(req)}/api/tasks/${token}/attachments/${encodeURIComponent(item.path)}"` : 'src=""';
  });
  return html;
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
  return page({ title: `与 ${String(agent.name)} 对话`, base, active: 'admin', adminTab: 'agents', bodyClass: 'agent-conversation', body: `
<p><a href="/admin/agents">← Agent 列表</a></p><h1>${esc(agent.name)}</h1><p>${esc(agent.description)}</p>
<div id="messages" class="empty">加载中…</div>
<form id="create-task" class="card"><div class="task-form-header"><label for="task-content">任务内容</label><span class="task-form-links"><button id="upload-task-link" class="btn small alt" type="button">上传文件任务</button><button id="all-tasks-link" class="text-link" type="button">显示全部任务</button></span></div>
<div id="task-content" class="rich-editor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="输入任务，支持粘贴图片或选择附件"></div>
<div class="editor-tools"><label class="file-picker" for="task-files">📎 选择或拖入文件</label><input id="task-files" type="file" multiple><span class="file-hint">单个 ≤5MB · 保存 1 天</span><span id="task-attachments" class="file-chips"></span></div>
<div class="task-actions"><label class="switch-control"><input id="automation-switch" type="checkbox"><span class="switch-slider" aria-hidden="true"></span><span>自动任务</span></label><button id="unreported-toggle" class="text-link" type="button" aria-pressed="false">仅看未回报</button><button class="btn task-submit" type="submit">生成任务链接</button></div><p id="automation-state" class="muted" role="status">读取自动任务状态…</p><p id="task-status" class="muted" role="status"></p>
</form>
<script>
const agentId=${JSON.stringify(String(agent.id))};
const messages=document.getElementById('messages'),status=document.getElementById('task-status');
const automationSwitch=document.getElementById('automation-switch'),automationState=document.getElementById('automation-state'),unreportedToggle=document.getElementById('unreported-toggle');
let onlyUnreported=false,showAllTasks=false;
document.getElementById('upload-task-link').addEventListener('click',async()=>{const button=document.getElementById('upload-task-link');button.disabled=true;status.textContent='正在生成上传任务…';try{const r=await fetch('/admin/api/agents/'+encodeURIComponent(agentId)+'/upload-tasks',{method:'POST',headers:{'Content-Type':'application/json'}});const data=await r.json();if(!r.ok)throw new Error(data.error||'生成失败');status.textContent='上传任务已生成，命令已复制；在 Linux 终端命令末尾加文件路径后执行。';await copyGeneratedText(data.command);loadTasks();}catch(error){status.textContent=error.message||'生成失败';}finally{button.disabled=false;}});
document.getElementById('all-tasks-link').addEventListener('click',()=>{showAllTasks=!showAllTasks;loadTasks();messages.scrollIntoView({behavior:'smooth',block:'start'});});
unreportedToggle.addEventListener('click',()=>{onlyUnreported=!onlyUnreported;unreportedToggle.setAttribute('aria-pressed',String(onlyUnreported));unreportedToggle.textContent=onlyUnreported?'显示全部任务':'仅看未回报';loadTasks();});
async function loadAutomation(){const r=await fetch('/admin/api/agents/'+encodeURIComponent(agentId)+'/automation');if(!r.ok)return;const data=await r.json();const state=data.state;automationSwitch.checked=state==='on'||state==='starting';automationSwitch.disabled=state==='starting'||state==='stopping';automationState.textContent=({off:'自动任务未开启',starting:'等待 AI 启动并回报',on:'AI 已确认启动',stopping:'等待 AI 领取停止任务并回报'})[state]||'状态未知';}
automationSwitch.addEventListener('change',async()=>{const enabling=automationSwitch.checked;automationSwitch.disabled=true;try{const r=await fetch('/admin/api/agents/'+encodeURIComponent(agentId)+'/automation/'+(enabling?'start':'stop'),{method:'POST'});const data=await r.json();if(!r.ok)throw new Error(data.error||'操作失败');if(enabling){const copied=await copyGeneratedText(shareText(data.url));automationState.textContent=copied?'启动指令已复制，请粘贴给 AI':'启动指令已创建，请复制任务链接交给 AI';}else automationState.textContent='停止任务已创建，等待 AI 自动领取';await loadAutomation();}catch(error){automationSwitch.checked=!enabling;automationState.textContent=error.message||'操作失败';automationSwitch.disabled=false;}});
window.pendingTaskAttachments=[];
function addTaskFile(file){return new Promise((resolve,reject)=>{if(file.size>5*1024*1024){reject(new Error('单个附件不能超过 5MB'));return;}const reader=new FileReader();reader.onload=()=>{window.pendingTaskAttachments.push({name:file.name,type:file.type||'application/octet-stream',dataUrl:reader.result});resolve(reader.result);};reader.onerror=()=>reject(new Error('读取附件失败'));reader.readAsDataURL(file);});}
function refreshAttachmentList(){document.getElementById('task-attachments').textContent=window.pendingTaskAttachments.length?('已添加 '+window.pendingTaskAttachments.length+' 个附件（提交后保存 1 天）'):'';}
function prepareTaskContent(){const clone=document.getElementById('task-content').cloneNode(true);const images=[...clone.querySelectorAll('img')];images.forEach(img=>{const index=window.pendingTaskAttachments.findIndex(a=>a.dataUrl===img.getAttribute('src'));if(index>=0)img.setAttribute('src','attachment://'+index);else img.removeAttribute('src');});return clone.innerHTML;}
document.getElementById('task-files').addEventListener('change',async e=>{try{for(const file of e.target.files)await addTaskFile(file);refreshAttachmentList();}catch(err){status.textContent=err.message||'附件读取失败';}});
document.getElementById('task-content').addEventListener('paste',async e=>{const items=[...(e.clipboardData?.items||[])];const images=items.filter(item=>item.kind==='file'&&item.type.startsWith('image/'));if(!images.length)return;e.preventDefault();for(const item of images){const file=item.getAsFile();if(!file)continue;try{const dataUrl=await addTaskFile(file);const editor=document.getElementById('task-content');const img=document.createElement('img');img.src=dataUrl;img.alt=file.name;img.style.maxWidth='240px';img.style.display='block';editor.append(img,document.createElement('br'));}catch(err){status.textContent=err.message||'图片读取失败';}}refreshAttachmentList();});
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
const knownReported=new Set(), expandedTaskLinks=new Set(), expandedTaskReplies=new Set(), audioContext=window.AudioContext?new AudioContext():null;
let taskListInitialized=false, initialTaskScrollPending=true;
function shouldDeferTaskRefresh(){
  const active=document.activeElement;
  if(active&&((active instanceof HTMLElement&&active.isContentEditable)||active.tagName==='INPUT'||active.tagName==='TEXTAREA'))return true;
  const selection=window.getSelection();
  return !!selection&&selection.rangeCount>0&&!selection.isCollapsed&&selection.toString().trim().length>0;
}
function formatLocalTime(value){const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});}
function playReportSound(){
  if(!audioContext)return;
  try{const now=audioContext.currentTime, oscillator=audioContext.createOscillator(), gain=audioContext.createGain();
    oscillator.type='sine';oscillator.frequency.setValueAtTime(880,now);oscillator.frequency.setValueAtTime(1175,now+0.12);
    gain.gain.setValueAtTime(0.0001,now);gain.gain.exponentialRampToValueAtTime(0.16,now+0.02);gain.gain.exponentialRampToValueAtTime(0.0001,now+0.32);
    oscillator.connect(gain);gain.connect(audioContext.destination);oscillator.start(now);oscillator.stop(now+0.34);
  }catch(_err){}
}
async function loadTasks(){
  const r=await fetch('/admin/api/agents/'+encodeURIComponent(agentId)+'/tasks');
  if(!r.ok){messages.textContent='加载失败';return;}
  const tasks=await r.json();
  if(!taskListInitialized){const latest=tasks.slice().reverse().find(t=>t.result!==null);if(latest)expandedTaskReplies.add(latest.id);}
  const hasNewReport=taskListInitialized&&tasks.some(t=>t.result!==null&&!knownReported.has(t.id));
  tasks.forEach(t=>{if(t.result!==null)knownReported.add(t.id);});
  const taskIds=new Set(tasks.map(t=>t.id));
  for(const id of expandedTaskLinks)if(!taskIds.has(id))expandedTaskLinks.delete(id);
  const filteredTasks=onlyUnreported?tasks.filter(t=>t.result===null):tasks;
  const visibleTasks=showAllTasks?filteredTasks:filteredTasks.slice(-5);
  document.getElementById('all-tasks-link').textContent=showAllTasks?'仅显示最近 5 个任务':'显示全部任务';
  messages.replaceChildren();
  if(!visibleTasks.length){messages.className='empty';messages.textContent=onlyUnreported?'暂无未回报任务':'暂无对话。输入任务后生成链接。';taskListInitialized=true;return;}
  messages.className='';
  for(const t of visibleTasks){const c=document.createElement('section');c.className=t.result!==null?'card task-reported':'card';c.id='task-'+t.id;
    const label=document.createElement('strong');label.textContent='你 · '+formatLocalTime(t.createdAt);const anchor=document.createElement('a');anchor.className='task-anchor';anchor.href='#'+c.id;anchor.title='复制任务锚点';anchor.setAttribute('aria-label','任务锚点');anchor.textContent='¶';label.append(' ',anchor);
    const menu=document.createElement('details');menu.className='task-menu';const menuButton=document.createElement('summary');menuButton.title='任务菜单';menuButton.textContent='⋯';const deleteButton=document.createElement('button');deleteButton.type='button';deleteButton.className='text-link danger-link';deleteButton.textContent='删除';deleteButton.addEventListener('click',async()=>{if(!window.confirm('确定删除这个任务？删除后无法恢复。'))return;deleteButton.disabled=true;const rr=await fetch('/admin/api/tasks/'+encodeURIComponent(t.id),{method:'DELETE'});if(!rr.ok){deleteButton.disabled=false;status.textContent='删除失败';return;}menu.open=false;status.textContent='任务已删除';loadTasks();});menu.append(menuButton,deleteButton);c.append(menu);
    const content=document.createElement('div');content.className='task-content';content.contentEditable='false';if(t.contentHtml)content.innerHTML=t.contentHtml;else content.textContent=t.content;
    c.append(label,content);
    const editActions=document.createElement('div');editActions.className='row';
    const editButton=document.createElement('button');editButton.type='button';editButton.className='btn small alt';editButton.textContent='编辑';
    const saveButton=document.createElement('button');saveButton.type='button';saveButton.className='btn small';saveButton.textContent='保存并重新生成链接';saveButton.hidden=true;
    const cancelButton=document.createElement('button');cancelButton.type='button';cancelButton.className='btn small alt';cancelButton.textContent='取消';cancelButton.hidden=true;
    const linkToggle=document.createElement('button');linkToggle.type='button';linkToggle.className='btn small link-toggle';linkToggle.textContent='显示任务链接';
    editActions.append(editButton,saveButton,cancelButton,linkToggle);c.append(editActions);
    let originalContent=t.content;
    const markdownSource=typeof t.content==='string'&&!t.content.includes('<');
    if(t.uploadCommand){
      editButton.textContent='复制命令';
      editButton.addEventListener('click',async()=>{const copied=await copyGeneratedText(t.uploadCommand);status.textContent=copied?'上传命令已复制。':'复制失败，请手动选中命令。';});
      saveButton.hidden=true;cancelButton.hidden=true;
    }else{
      editButton.addEventListener('click',()=>{originalContent=content.innerHTML;if(markdownSource)content.textContent=t.content;content.contentEditable='true';content.classList.add('editing');editButton.hidden=true;saveButton.hidden=false;cancelButton.hidden=t.result!==null;content.focus();});
      cancelButton.addEventListener('click',()=>{content.innerHTML=originalContent;content.contentEditable='false';content.classList.remove('editing');editButton.hidden=false;saveButton.hidden=true;cancelButton.hidden=true;});
      saveButton.addEventListener('click',async()=>{const next=(content.innerHTML||'').trim();if(!next){status.textContent='任务内容不能为空';return;}saveButton.disabled=true;const rr=await fetch('/admin/api/tasks/'+encodeURIComponent(t.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:next})});const dd=await rr.json();saveButton.disabled=false;if(!rr.ok){status.textContent=dd.error||'编辑失败';return;}status.textContent='任务已更新并重新生成链接。';await copyGeneratedText(shareText(dd.url));loadTasks();});
    }
    const linkBox=document.createElement('div');linkBox.className='codeblock';
    const head=document.createElement('div');head.className='cb-head';
    const title=document.createElement('span');title.className='cb-title';title.textContent='任务链接（请交给 CLI AI）';
    const openLink=document.createElement('a');openLink.className='btn small link-open';openLink.href=t.url;openLink.target='_blank';openLink.rel='noopener';openLink.textContent='查看任务';
    const copy=document.createElement('button');copy.type='button';copy.className='btn small copy';copy.textContent='复制';
    const copyText=t.uploadCommand||shareText(t.url); title.textContent=t.uploadCommand?'文件上传命令（末尾加文件路径）':'任务链接（请交给 CLI AI）';
    head.append(title,openLink,copy);const pre=document.createElement('pre');const code=document.createElement('code');code.textContent=copyText;pre.append(code);linkBox.append(head,pre);c.append(linkBox);
    linkBox.hidden=!expandedTaskLinks.has(t.id);linkToggle.textContent=linkBox.hidden?'显示任务链接':'收起任务链接';linkToggle.setAttribute('aria-expanded',String(!linkBox.hidden));
    if(t.uploadCommand){linkToggle.hidden=true;linkBox.hidden=true;}
    linkToggle.addEventListener('click',()=>{linkBox.hidden=!linkBox.hidden;if(linkBox.hidden)expandedTaskLinks.delete(t.id);else expandedTaskLinks.add(t.id);linkToggle.textContent=linkBox.hidden?'显示任务链接':'收起任务链接';linkToggle.setAttribute('aria-expanded',String(!linkBox.hidden));});
    if(t.attachments?.length){const files=document.createElement('div');files.className='attachment-list';for(const a of t.attachments){const item=document.createElement('a');item.href=a.url;item.target='_blank';item.rel='noopener';item.textContent=a.name+' ('+Math.round(a.size/1024)+' KB)';files.append(item);}c.append(files);}
    if(t.result!==null){const reply=document.createElement('details');reply.className='task-reply';reply.open=expandedTaskReplies.has(t.id);
      const who=document.createElement('summary');who.textContent='Agent 回报 · '+formatLocalTime(t.reportedAt);
      const body=document.createElement('div');body.className='task-reply-body';body.innerHTML=t.resultHtml;
      reply.addEventListener('toggle',()=>{if(reply.open)expandedTaskReplies.add(t.id);else expandedTaskReplies.delete(t.id);});reply.append(who,body);c.append(reply);
    }else{const pending=document.createElement('p');pending.className='muted';pending.textContent='等待回报 · 链接有效期至 '+formatLocalTime(t.tokenExpiresAt);c.append(pending);}
    messages.append(c);}
  taskListInitialized=true;
  if(initialTaskScrollPending){initialTaskScrollPending=false;requestAnimationFrame(()=>{const target=messages.lastElementChild;if(target)target.scrollIntoView({behavior:'auto',block:'start'});});}
  if(hasNewReport)playReportSound();
}
document.getElementById('create-task').addEventListener('submit',async e=>{
  e.preventDefault();status.textContent='生成中…';const content=prepareTaskContent();const attachments=window.pendingTaskAttachments||[];
  const r=await fetch('/admin/api/agents/'+encodeURIComponent(agentId)+'/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,attachments})});
  const data=await r.json();
  if(!r.ok){status.textContent=data.error||'生成失败';return;}
  document.getElementById('task-content').innerHTML='';document.getElementById('task-files').value='';window.pendingTaskAttachments=[];refreshAttachmentList();
  const copied=await copyGeneratedText(shareText(data.url));
  status.textContent=copied?'链接已生成并自动复制，有效期 7 天。链接持有人可读取任务并回报。':'链接已生成，但浏览器未能自动复制，请点击“复制”。';
  loadTasks();
});
loadAutomation().catch(()=>{});loadTasks().catch(()=>{messages.textContent='加载失败';});setInterval(()=>{loadAutomation().catch(()=>{});if(!shouldDeferTaskRefresh())loadTasks().catch(()=>{});},5000);
</script>` });
}

export function createAgentRouter(): Router {
  const router = Router();
  router.use(['/admin/agents', '/admin/api/agents', '/api/tasks', '/api/agents'], (_req, res, next) => {
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
    res.json(agents.map(a => ({ ...row(a), pollUrl: `${deriveBase(_req)}/api/agents/${a.get('id')}/tasks/poll`, pollToken: pollTokenFor(String(a.get('id'))) })));
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
    res.json(tasks.map(t => { const d = row(t); const token = tokenFor(String(d.id), String(d.tokenExpiresAt)); const uploadCommand = /^(?:curl|sh -c)\s[\s\S]*--upload-file/.test(String(d.content)); return { ...d, contentHtml: taskContentWithAttachmentUrls(String(d.content), String(d.id), token, req), uploadCommand: uploadCommand ? String(d.content) : null, attachments: attachmentMeta(String(d.id)).map(({ name, type, size, path: stored }) => ({ name, type, size, url: `${linkBase(req)}/admin/api/tasks/${d.id}/attachments/${encodeURIComponent(stored)}` })), url: `${linkBase(req)}/api/tasks/${token}`, resultHtml: d.result === null ? null : safeMarkdown(String(d.result)) }; }));
  }));
  router.get('/admin/api/agents/:id/automation', adminOnly, requireDb, wrap(async (req, res) => {
    if (!(await AgentModel.findByPk(req.params.id))) { res.status(404).json({ error: 'Agent 不存在' }); return; }
    res.json(await automationFor(req.params.id));
  }));
  router.post('/admin/api/agents/:id/automation/start', adminOnly, requireSameOrigin, requireDb, wrap(async (req, res) => {
    if (!(await AgentModel.findByPk(req.params.id))) { res.status(404).json({ error: 'Agent 不存在' }); return; }
    const current = await automationFor(req.params.id);
    if (current.state !== 'off') { res.status(409).json({ error: '自动任务已启动或正在启动' }); return; }
    const taskSince = new Date().toISOString();
    const id = randomUUID(), tokenExpiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    const pollUrl = `${linkBase(req)}/api/agents/${req.params.id}/tasks/poll`;
    const content = `启动此 Agent 的自动任务。请在你的运行环境使用自有定时器或 WebSocket 客户端，通过网络访问 ${pollUrl}，请求头 X-Agent-Token: ${pollTokenFor(req.params.id)}。仅处理返回的该 Agent 任务，读取每条任务的 url，并按其 report.url 回报。必须在当前 Agent 上下文直接完成任务，不要启动子 Agent 或委托其它执行器。首次自动任务成功运行后，请回报本任务：已启动自动任务。以后遇到停止自动任务的任务，请先回报该停止任务，再关闭你自己的定时器或推送连接。`;
    await AgentTaskModel.create({ id, agentId: req.params.id, content: safeTaskContent(content), tokenExpiresAt, status: 'pending', result: null, reportedAt: null, reportSource: null, createdAt: taskSince });
    await AgentAutomationModel.upsert({ agentId: req.params.id, state: 'starting', controlTaskId: id, taskSince, updatedAt: taskSince });
    const url = `${linkBase(req)}/api/tasks/${tokenFor(id, tokenExpiresAt)}`;
    publishAgentTask(req.params.id, { taskId: id, url, createdAt: taskSince, expiresAt: tokenExpiresAt, control: 'starting' });
    res.status(201).json({ state: 'starting', taskId: id, url });
  }));
  router.post('/admin/api/agents/:id/automation/stop', adminOnly, requireSameOrigin, requireDb, wrap(async (req, res) => {
    if (!(await AgentModel.findByPk(req.params.id))) { res.status(404).json({ error: 'Agent 不存在' }); return; }
    const current = await automationFor(req.params.id);
    if (current.state !== 'on' && current.state !== 'starting') { res.status(409).json({ error: '自动任务尚未启动或正在停止' }); return; }
    const id = randomUUID(), tokenExpiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    await AgentTaskModel.create({ id, agentId: req.params.id, content: '停止自动任务：请先回报本任务“已停止自动轮询”，然后关闭此 Agent 的定时轮询任务。不要停止其它 Agent 的轮询。', tokenExpiresAt, status: 'pending', result: null, reportedAt: null, reportSource: null, createdAt: new Date().toISOString() });
    await AgentAutomationModel.upsert({ agentId: req.params.id, state: 'stopping', controlTaskId: id, taskSince: current.taskSince, updatedAt: new Date().toISOString() });
    const url = `${linkBase(req)}/api/tasks/${tokenFor(id, tokenExpiresAt)}`;
    publishAgentTask(req.params.id, { taskId: id, url, createdAt: new Date().toISOString(), expiresAt: tokenExpiresAt, control: 'stopping' });
    res.status(201).json({ state: 'stopping', taskId: id, url });
  }));
  router.get('/api/agents/:id/tasks/poll', requireDb, wrap(async (req, res) => {
    if (!pollTokenMatches(req, req.params.id)) { res.status(401).json({ error: 'Agent 轮询凭证无效' }); return; }
    const agent = await AgentModel.findByPk(req.params.id);
    if (!agent) { res.status(404).json({ error: 'Agent 不存在' }); return; }
    const automation = await automationFor(req.params.id);
    const cutoff = automation.taskSince || undefined;
    const tasks = await AgentTaskModel.findAll({ where: { agentId: req.params.id, status: 'pending' }, order: [['createdAt', 'ASC']] });
    res.json({ agent: { id: agent.get('id'), name: agent.get('name') }, tasks: tasks.map(t => row(t)).filter(d => (!cutoff || String(d.createdAt) >= cutoff) && Date.parse(String(d.tokenExpiresAt)) > Date.now()).map(d => { const token = tokenFor(String(d.id), String(d.tokenExpiresAt)); return { taskId: d.id, url: `${linkBase(req)}/api/tasks/${token}`, createdAt: d.createdAt, expiresAt: d.tokenExpiresAt, control: automation.controlTaskId === d.id ? automation.state : null }; }) });
  }));
  router.post('/admin/api/agents/:id/tasks', adminOnly, requireSameOrigin, requireDb, wrap(async (req, res) => {
    if (!(await AgentModel.findByPk(req.params.id))) { res.status(404).json({ error: 'Agent 不存在' }); return; }
    const attachmentsInput = req.body?.attachments;
    const content = cleanText(req.body?.content, 20_000) || (Array.isArray(attachmentsInput) && attachmentsInput.length ? '<p>（见附件）</p>' : null);
    if (!content) { res.status(400).json({ error: '任务内容必填且不超过 20000 字' }); return; }
    cleanupAttachments();
    const id = randomUUID(), tokenExpiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    let attachments: AttachmentMeta[];
    try { attachments = writeAttachmentMeta(id, attachmentsInput); } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : '附件无效' }); return; }
    await AgentTaskModel.create({ id, agentId: req.params.id, content: safeTaskContent(content), tokenExpiresAt, status: 'pending', result: null, reportedAt: null, reportSource: null, createdAt: new Date().toISOString() });
    const token = tokenFor(id, tokenExpiresAt);
    const url = `${linkBase(req)}/api/tasks/${token}`;
    publishAgentTask(req.params.id, { taskId: id, url, createdAt: new Date().toISOString(), expiresAt: tokenExpiresAt });
    res.status(201).json({ taskId: id, url, expiresAt: tokenExpiresAt, attachments: attachments.map(({ name, type, size }) => ({ name, type, size })) });
  }));

  router.post('/admin/api/agents/:id/upload-tasks', adminOnly, requireSameOrigin, requireDb, wrap(async (req, res) => {
    if (!(await AgentModel.findByPk(req.params.id))) { res.status(404).json({ error: 'Agent 不存在' }); return; }
    const id = randomUUID(), tokenExpiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    const token = tokenFor(id, tokenExpiresAt);
    const uploadUrl = `${linkBase(req)}/api/tasks/${token}/upload`;
    const command = `sh -c 'f="$1"; curl -fsS -X POST "${uploadUrl}" -H "Content-Type: application/octet-stream" -H "X-File-Name: $(basename "$f")" --upload-file "$f"' _ `;
    const createdAt = new Date().toISOString();
    await AgentTaskModel.create({ id, agentId: req.params.id, content: command, tokenExpiresAt, status: 'pending', result: null, reportedAt: null, reportSource: null, createdAt });
    publishAgentTask(req.params.id, { taskId: id, url: `${linkBase(req)}/api/tasks/${token}`, createdAt, expiresAt: tokenExpiresAt });
    res.status(201).json({ taskId: id, url: `${linkBase(req)}/api/tasks/${token}`, uploadUrl, command, expiresAt: tokenExpiresAt });
  }));

  router.patch('/admin/api/tasks/:id', adminOnly, requireSameOrigin, requireDb, wrap(async (req, res) => {
    const content = cleanText(req.body?.content, 20_000);
    if (!content) { res.status(400).json({ error: '任务内容必填且不超过 20000 字' }); return; }
    const task = await AgentTaskModel.findByPk(req.params.id);
    if (!task) { res.status(404).json({ error: '任务不存在' }); return; }
    const tokenExpiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    deleteAttachmentMeta(req.params.id);
    await task.update({ content: safeTaskContent(content), tokenExpiresAt, status: 'pending', result: null, reportedAt: null, reportSource: null });
    const url = `${linkBase(req)}/api/tasks/${tokenFor(req.params.id, tokenExpiresAt)}`;
    res.json({ taskId: req.params.id, url, expiresAt: tokenExpiresAt });
  }));

  router.delete('/admin/api/tasks/:id', adminOnly, requireSameOrigin, requireDb, wrap(async (req, res) => {
    const task = await AgentTaskModel.findByPk(req.params.id);
    if (!task) { res.status(404).json({ error: '任务不存在' }); return; }
    deleteAttachmentMeta(req.params.id);
    await task.destroy();
    res.json({ ok: true, taskId: req.params.id });
  }));

  router.get('/admin/api/tasks/:id/attachments/:file', adminOnly, requireDb, (req, res) => {
    const meta = attachmentMeta(req.params.id).find(a => a.path === req.params.file);
    if (!meta) { res.status(404).json({ error: '附件不存在或已过期' }); return; }
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    res.type(meta.type).sendFile(path.join(ATTACHMENT_DIR, meta.path));
  });

  router.get('/api/tasks/:token', requireDb, wrap(async (req, res) => {
    const task = await taskFromToken(req.params.token);
    if (!task) { res.status(403).json({ error: '任务凭证无效或已过期' }); return; }
    const agent = await AgentModel.findByPk(String(task.agentId));
    if (!agent) { res.status(404).json({ error: 'Agent 不存在' }); return; }
    const url = `${linkBase(req)}/api/tasks/${req.params.token}/report`;
    const attachments = attachmentMeta(String(task.id)).map(({ name, type, size, path: stored }) => ({ name, type, size, url: `${linkBase(req)}/api/tasks/${req.params.token}/attachments/${encodeURIComponent(stored)}` }));
    res.json({ taskId: task.id, agent: { id: agent.get('id'), name: agent.get('name'), description: agent.get('description') }, content: taskContentWithAttachmentUrls(String(task.content), String(task.id), req.params.token, req), attachments, status: task.status, expiresAt: task.tokenExpiresAt, report: { url, method: 'POST', contentType: 'application/json', body: { result: 'Markdown 格式的任务结果' }, rule: '首次回报生效；相同内容重复提交幂等，不同内容返回 409。凭证已包含在 URL 中，7 天后失效。' } });
  }));
  router.get('/api/tasks/:token/attachments/:file', requireDb, wrap(async (req, res) => {
    const task = await taskFromToken(req.params.token);
    if (!task) { res.status(403).json({ error: '任务凭证无效或已过期' }); return; }
    const meta = attachmentMeta(String(task.id)).find(a => a.path === req.params.file);
    if (!meta) { res.status(404).json({ error: '附件不存在或已过期' }); return; }
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    res.type(meta.type).sendFile(path.join(ATTACHMENT_DIR, meta.path));
  }));
  router.post('/api/tasks/:token/upload', express.raw({ type: '*/*', limit: `${MAX_ATTACHMENT_BYTES}b` }), requireDb, wrap(async (req, res) => {
    const task = await taskFromToken(req.params.token);
    if (!task) { res.status(403).json({ error: '任务凭证无效或已过期' }); return; }
    if (task.status !== 'pending') { res.status(409).json({ error: '任务已经完成或已被处理' }); return; }
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let item: AttachmentMeta;
    try { item = saveUploadedFile(String(task.id), buffer, String(req.headers['x-file-name'] || 'uploaded-file'), String(req.headers['content-type'] || 'application/octet-stream')); } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : '文件无效' }); return; }
    const reportedAt = new Date().toISOString();
    const result = `文件已上传：${item.name}（${item.size} bytes）`;
    await AgentTaskModel.update({ status: 'reported', result, reportedAt, reportSource: req.ip || 'unknown' }, { where: { id: task.id, status: 'pending' } });
    res.json({ ok: true, taskId: task.id, status: 'reported', result, attachment: { name: item.name, type: item.type, size: item.size, url: `${linkBase(req)}/api/tasks/${req.params.token}/attachments/${encodeURIComponent(item.path)}` } });
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
    const automation = await automationFor(String(task.agentId));
    if (automation.controlTaskId === task.id) {
      const next = automation.state === 'starting' ? 'on' : automation.state === 'stopping' ? 'off' : null;
      if (next) await AgentAutomationModel.update({ state: next, controlTaskId: null, taskSince: automation.taskSince, updatedAt: reportedAt }, { where: { agentId: task.agentId, controlTaskId: task.id, state: automation.state } });
    }
    res.json({ ok: true, taskId: task.id, reportedAt });
  }));
  return router;
}
