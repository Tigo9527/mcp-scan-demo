import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function argsFor(sessionId, prompt) {
  const base = sessionId ? ['exec', 'resume', sessionId, prompt] : ['exec', prompt];
  return [...base, '--json', '--dangerously-bypass-approvals-and-sandbox'];
}

export function runCodex(prompt, { codex = 'codex', cwd = process.cwd(), sessionId, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const outputFile = join(tmpdir(), `codex-worker-${randomUUID()}.txt`);
    const child = spawn(codex, argsFor(sessionId, prompt), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString(); stdout += text;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { const event = JSON.parse(line); onEvent?.(event); } catch { /* progress text is optional */ }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', async code => {
      try { await rm(outputFile, { force: true }); } catch { /* best effort */ }
      if (code !== 0) { reject(new Error(`Codex 退出码 ${code}: ${stderr.slice(-2000)}`)); return; }
      let final = stdout.trim();
      try {
        const events = final.split('\n').filter(Boolean).map(line => JSON.parse(line));
        const started = events.find(e => e.type === 'thread.started');
        const message = [...events].reverse().find(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
        resolve({ sessionId: started?.thread_id, result: message?.item?.text || final, events });
      } catch { resolve({ result: final, events: [] }); }
    });
  });
}
