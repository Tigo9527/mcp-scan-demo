import { spawn } from 'node:child_process';

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
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function poll() {
  const response = await fetch(pollUrl, { headers: { 'X-Agent-Token': pollToken }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`轮询失败：HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.tasks)) throw new Error('轮询响应格式错误');
  for (const task of data.tasks) {
    if (!running) break;
    if (typeof task.taskId !== 'string' || typeof task.url !== 'string') continue;
    if (attempted.get(task.taskId) > Date.now()) continue;
    const url = new URL(task.url);
    if (url.origin !== parsed.origin || !url.pathname.startsWith('/api/tasks/')) continue;
    attempted.set(task.taskId, Date.now() + 60000);
    console.log(`处理任务 ${task.taskId}`);
    const prompt = `请阅读这个任务，并按任务返回的 report.url 提交结果。任务 URL：${task.url}`;
    const result = await new Promise(resolve => {
      const child = spawn('codex', ['exec', '-C', process.cwd(), prompt], { stdio: 'inherit', env: childEnv });
      child.once('error', error => { console.error(`Codex 启动失败：${error.message}`); resolve(1); });
      child.once('exit', code => resolve(code ?? 1));
    });
    if (result !== 0) console.error(`任务 ${task.taskId} 执行失败；稍后重试`);
  }
}

console.log('Agent 轮询器已启动');
while (running) {
  try { await poll(); } catch (error) { console.error(error.message); }
  if (running) await pause(intervalMs);
}
