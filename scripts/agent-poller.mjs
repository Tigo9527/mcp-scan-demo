import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const pollUrl = process.env.AGENT_POLL_URL;
const pollToken = process.env.AGENT_POLL_TOKEN;
const intervalMs = Number(process.env.AGENT_POLL_INTERVAL_MS || 10000);
if (!pollUrl || !pollToken || !Number.isFinite(intervalMs) || intervalMs < 1000) {
  console.error('需要 AGENT_POLL_URL、AGENT_POLL_TOKEN；轮询间隔至少 1000ms');
  process.exit(1);
}
const parsed = new URL(pollUrl);
if (!/^https?:$/.test(parsed.protocol) || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname))) {
  console.error('轮询地址必须使用 HTTPS；仅本机地址可使用 HTTP');
  process.exit(1);
}

const attempted = new Map();
const childEnv = { ...process.env };
delete childEnv.AGENT_POLL_TOKEN;
let running = true;
let taskQueue = Promise.resolve();
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function processTask(task, data) {
  if (!running) return;
  if (typeof task.taskId !== 'string' || typeof task.url !== 'string') return;
  if (attempted.get(task.taskId) > Date.now()) return;
  const url = new URL(task.url);
  if (url.origin !== parsed.origin || !url.pathname.startsWith('/api/tasks/')) return;
  if (task.control === 'stopping') {
    const detail = await fetch(task.url, { signal: AbortSignal.timeout(10000) });
    if (!detail.ok) throw new Error(`停止任务读取失败：HTTP ${detail.status}`);
    const stopTask = await detail.json();
    const reportUrl = new URL(stopTask.report?.url || '');
    if (reportUrl.origin !== parsed.origin || reportUrl.pathname !== `${url.pathname}/report`) throw new Error('停止任务回报地址无效');
    const report = await fetch(reportUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: '已停止自动轮询' }), signal: AbortSignal.timeout(10000) });
    if (!report.ok) throw new Error(`停止任务回报失败：HTTP ${report.status}`);
    console.log(`已停止 Agent ${data.agent.id} 的自动轮询`);
    running = false;
    return;
  }
  attempted.set(task.taskId, Date.now() + 60000);
  console.log(`处理任务 ${task.taskId}`);
  const prompt = `请阅读这个任务，并按任务返回的 report.url 提交结果。任务 URL：${task.url}\n必须在当前上下文中直接完成任务，禁止启动子任务、子 Agent 或委托其它执行器；完成后直接向 report.url 回报。`;
  const result = await new Promise(resolve => {
    const child = spawn('codex', ['exec', '-C', process.cwd(), prompt], { stdio: 'inherit', env: childEnv });
    child.once('error', error => { console.error(`Codex 启动失败：${error.message}`); resolve(1); });
    child.once('exit', code => resolve(code ?? 1));
  });
  if (result !== 0) console.error(`任务 ${task.taskId} 执行失败；稍后重试`);
}

function enqueue(task, data) {
  taskQueue = taskQueue.then(() => processTask(task, data)).catch(error => console.error(error.message));
}

function connectWebSocket() {
  const wsPath = parsed.pathname.replace(/^\/api\/agents\/([^/]+)\/tasks\/poll$/, '/ws/agents/$1/tasks');
  if (wsPath === parsed.pathname) return;
  const wsUrl = new URL(parsed);
  wsUrl.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.pathname = wsPath;
  wsUrl.search = '';
  const socket = new WebSocket(wsUrl, { headers: { 'X-Agent-Token': pollToken } });
  socket.on('open', () => console.log('WebSocket 任务推送已连接'));
  socket.on('message', raw => {
    try { const message = JSON.parse(String(raw)); if (message.type === 'task') enqueue(message.task, { agent: { id: 'websocket' } }); } catch (error) { console.error(`WebSocket 消息无效：${error.message}`); }
  });
  socket.on('error', error => console.error(`WebSocket 任务推送失败：${error.message}`));
  socket.on('close', () => { if (running) setTimeout(connectWebSocket, 3000).unref(); });
}

async function poll() {
  const response = await fetch(pollUrl, { headers: { 'X-Agent-Token': pollToken }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`轮询失败：HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.tasks)) throw new Error('轮询响应格式错误');
  for (const task of data.tasks) {
    if (!running) break;
    if (typeof task.taskId !== 'string' || typeof task.url !== 'string') continue;
    enqueue(task, data);
  }
}

console.log('Agent 轮询器已启动');
connectWebSocket();
while (running) {
  try { await poll(); } catch (error) { console.error(error.message); }
  if (running) await pause(intervalMs);
}
