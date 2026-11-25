import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BINANCE_CFX, TrackerDb } from '../src/cfx-tracker.js';

const dir = mkdtempSync(path.join(tmpdir(), 'cfx-sync-rounds-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('一次运行会补抓排名变化后新出现的零转入地址', async () => {
  const first = 'cfx:aara421audx4ev6t7c40a3f6vzjwf5a3apxbm53nxc';
  const second = 'cfx:aapwpauv99u7egnx1vh0uyvfsk7edp6rc6hactkn4b';
  const from = Math.floor(Date.parse('2026-11-20T00:00:00Z') / 1000);
  const file = path.join(dir, 'tracker.sqlite');
  const db = new TrackerDb(file);
  await db.init();
  await db.run('INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?)', ['core', '0x01', 0, from + 3600, first, BINANCE_CFX, '1000000000000000000', 'fixture']);
  await db.close();

  const queried: string[] = [];
  const server = createServer((req, res) => {
    const account = new URL(req.url ?? '/', 'http://localhost').searchParams.get('account') ?? '';
    queried.push(account);
    const list = account === first ? [{ transactionHash: '0x02', txLogIndex: 0, timestamp: from + 7200, from: second, to: first, amount: '2000000000000000000' }] : [];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 0, message: '', data: { total: list.length, list } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const { stdout } = await promisify(execFile)('node_modules/.bin/tsx', ['scripts/cfx-tracker-sync.ts', '--top-zero'], {
      cwd: path.resolve('.'),
      timeout: 20_000,
      env: { ...process.env, CFX_TRACKER_DB: file, CFX_TRACKER_FROM: '2026-11-20T00:00:00Z', CFX_TRACKER_UNTIL: '2026-11-21T00:00:00Z', CONFLUXSCAN_API_URL: `http://127.0.0.1:${port}`, NO_PROXY: '127.0.0.1,localhost' },
    });
    expect(stdout).toContain('round 1: 1 new addresses');
    expect(stdout).toContain('round 2: 1 new addresses');
    expect(stdout).toContain('前 100 零转入补抓完成：2 个地址，2 轮');
    expect(queried).toEqual([first, second]);
    const check = new TrackerDb(file);
    await check.init();
    expect((await check.get<{ count: number }>('SELECT COUNT(*) AS count FROM transfers WHERE to_address=?', [first]))?.count).toBe(1);
    expect(await check.get('SELECT 1 FROM checkpoints WHERE source=?', [`core:${second}`])).toBeDefined();
    await check.close();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
