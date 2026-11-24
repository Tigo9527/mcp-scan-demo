import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { BINANCE_CFX, TrackerDb, cfxAmount, cfxWholeAmount } from '../src/cfx-tracker.js';
import { createCfxTrackerRouter } from '../src/web/cfx-tracker.js';

const dir = mkdtempSync(path.join(tmpdir(), 'cfx-tracker-'));
process.env.CFX_TRACKER_DB = path.join(dir, 'tracker.sqlite');
let server: Server;
let base: string;

beforeAll(async () => {
  const db = new TrackerDb();
  await db.init();
  const now = Math.floor(Date.now()/1000);
  await db.run('INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?)', ['core','0x01',1,now,BINANCE_CFX,'cfx:aapwpauv99u7egnx1vh0uyvfsk7edp6rc6hactkn4b','123456789000000000000','fixture']);
  await db.run('INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?)', ['core','0x02',1,now,'cfx:aapwpauv99u7egnx1vh0uyvfsk7edp6rc6hactkn4b',BINANCE_CFX,'2000000000000000000','fixture']);
  await db.close();
  server = express().use(createCfxTrackerRouter()).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const addr = server.address(); base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); delete process.env.CFX_TRACKER_DB; rmSync(dir,{recursive:true,force:true}); });

it('精确累计 wei，并区分转入和转出', async () => {
  const res = await fetch(`${base}/api/cfx-tracker`);
  expect(res.status).toBe(200);
  const data = await res.json() as { transferCount: number; addressCount: number; ranking: Array<{ address: string; inCount: number; outCount: number; inWei: string; outWei: string }> };
  expect(data.transferCount).toBe(2);
  expect(data.addressCount).toBe(2);
  const seed = data.ranking.find((r: {address:string}) => r.address === BINANCE_CFX);
  expect(seed).toBeDefined();
  expect(seed!.inCount).toBe(1); expect(seed!.outCount).toBe(1);
  expect(seed!.inWei).toBe('2000000000000000000');
  expect(seed!.outWei).toBe('123456789000000000000');
  expect(cfxAmount(seed!.outWei)).toBe('123.456789');
  expect(cfxWholeAmount(seed!.outWei)).toBe('123');
});

it('公开页面展示排名与数据来源', async () => {
  const res = await fetch(`${base}/cfx-tracker`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('地址排名');
  expect(html).toContain(BINANCE_CFX);
  expect(html).toContain('ConfluxScan');
  expect(html).toContain('class="cfx-tracker-page"');
  expect(html).toContain('.cfx-tracker-page{max-width:none');
  expect(html).toContain('<code>cfx:aatx4z91…</code>');
  expect(html).toContain('title="' + BINANCE_CFX + '"');
  expect(html).toContain('最近 1 周');
  expect(html).toContain('最近 1 月');
  expect(html).toContain('<th scope="row">最近 1 周</th><td>2</td><td>1</td><td>1</td><td>2</td><td>123</td><td>125</td>');
  expect(html).not.toContain('123.456789');
  expect((html.match(/role="tab"/g) ?? [])).toHaveLength(4);
  expect((html.match(/role="tabpanel"/g) ?? [])).toHaveLength(4);
});

it('转移记录接口可分页读取', async () => {
  const res = await fetch(`${base}/api/cfx-tracker/transfers?limit=1&offset=1`);
  expect(res.status).toBe(200);
  const data = await res.json() as { total: number; rows: Array<{tx_hash:string}> };
  expect(data.total).toBe(2);
  expect(data.rows).toHaveLength(1);
  expect(data.rows[0].tx_hash).toBe('0x02');
});
