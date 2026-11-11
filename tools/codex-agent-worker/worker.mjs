#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getTask, parsePollDetails, pollTasks, reportTask } from './task-client.mjs';
import { runCodex } from './codex-runner.mjs';

const POLL_MS = Number(process.env.CODEX_WORKER_POLL_MS || 10_000);
const IDLE_MS = Number(process.env.CODEX_WORKER_IDLE_MS || 60 * 60 * 1000);
const STATE_FILE = resolve(process.env.CODEX_WORKER_STATE || './codex-agent-worker-state.json');

async function loadState() { try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return {}; } }
async function saveState(state) { await mkdir(dirname(STATE_FILE), { recursive: true }); await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n'); }
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

export async function start(startUrl, { fetchImpl = fetch, runner = runCodex, now = () => Date.now(), once = false } = {}) {
  const startup = await getTask(startUrl, fetchImpl);
  const { pollUrl, pollToken } = parsePollDetails(startup.content);
  const state = await loadState();
  state.agentId = startup.agent.id; state.pollUrl = pollUrl; state.lastActivity = now(); state.startedAt = new Date(now()).toISOString();
  const boot = await runner('worker 已连接。请保持这个 Codex 会话可恢复，等待后续自动任务。只回复 READY。', { sessionId: state.sessionId, onEvent: event => console.log('[codex]', event.type || 'event') });
  state.sessionId = boot.sessionId || state.sessionId;
  await saveState(state);
  const welcome = `Codex 实例已经启动，session id 是 ${state.sessionId || '未返回（见状态文件）'}。worker 已连接 Agent ${startup.agent.name}，轮询间隔 ${POLL_MS / 1000} 秒。`;
  await reportTask(startup.report, welcome, fetchImpl);
  let sessionId = state.sessionId;
  let lastActivity = now();
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
  while (!stopping) {
    const data = await pollTasks(pollUrl, pollToken, fetchImpl);
    if (data.tasks?.length) {
      for (const pointer of data.tasks) {
        const task = await getTask(pointer.url, fetchImpl);
        const prompt = `执行下面的 AI 自动任务。完成后只输出面向用户的 Markdown 结果，不要启动子 Agent：\n\n${task.content}`;
        const execution = await runner(prompt, { sessionId, onEvent: event => console.log('[codex]', event.type || 'event') });
        sessionId = execution.sessionId || sessionId;
        state.sessionId = sessionId; state.lastTaskId = task.taskId; state.lastActivity = now();
        await saveState(state);
        await reportTask(task.report, execution.result, fetchImpl);
        lastActivity = now();
      }
    }
    if (now() - lastActivity >= IDLE_MS) {
      state.stoppedAt = new Date(now()).toISOString(); state.resume = { startUrl, pollUrl, sessionId, reason: 'idle-timeout' }; await saveState(state);
      console.log(JSON.stringify({ type: 'idle-timeout', resume: state.resume }));
      break;
    }
    if (once) break;
    await sleep(POLL_MS);
  }
  return state;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const startUrl = process.argv[2];
  if (!startUrl) { console.error('用法: node worker.mjs <自动任务启动链接>'); process.exit(2); }
  start(startUrl).catch(err => { console.error(err.stack || err); process.exitCode = 1; });
}
