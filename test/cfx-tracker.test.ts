import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { BINANCE_CFX, TrackerDb, cfxAmount, cfxWholeAmount } from '../src/cfx-tracker.js';
import { localAddressMeta, lookupMinerAddresses, lookupTrackerMetadata } from '../src/cfx-tracker-meta.js';
import { createCfxTrackerRouter } from '../src/web/cfx-tracker.js';

const dir = mkdtempSync(path.join(tmpdir(), 'cfx-tracker-'));
process.env.CFX_TRACKER_DB = path.join(dir, 'tracker.sqlite');
let server: Server;
let base: string;
const miner = 'cfx:aara421audx4ev6t7c40a3f6vzjwf5a3apxbm53nxc';

beforeAll(async () => {
  const db = new TrackerDb();
  await db.init();
  const now = Math.floor(Date.now()/1000);
  await db.run('INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?)', ['core','0x01',1,now,BINANCE_CFX,'cfx:aapwpauv99u7egnx1vh0uyvfsk7edp6rc6hactkn4b','123456789000000000000','fixture']);
  await db.run('INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?)', ['core','0x02',1,now,'cfx:aapwpauv99u7egnx1vh0uyvfsk7edp6rc6hactkn4b',BINANCE_CFX,'2000000000000000000','fixture']);
  await db.close();
  server = express().use(createCfxTrackerRouter(async addresses => new Map(addresses.map(address => [address, {
    ...localAddressMeta(address),
    ...(address.startsWith('cfx:aapw') ? { tag: '<测试标签>' } : {}),
  }])), async addresses => new Set(addresses.filter(address => address === miner)))).listen(0, '127.0.0.1');
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
  expect(cfxWholeAmount(-121456789000000000000n)).toBe('-121');
  expect(cfxWholeAmount(-121500000000000000000n)).toBe('-122');
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
  expect(html).toContain('<code>cfx:aatx4z91…b18ngb</code>');
  expect(html).toContain('title="' + BINANCE_CFX + '"');
  expect(html).toContain('/address/' + BINANCE_CFX);
  expect(html).not.toContain('/address/cfx%3A');
  expect(html).toContain('币安钱包 · 追踪起点');
  expect(html).toContain('&lt;测试标签&gt;');
  expect(html).not.toContain('<测试标签>');
  expect(html).toContain('最近 1 周');
  expect(html).toContain('最近 1 月');
  expect(html).toContain('<th scope="row">最近 1 周</th><td>2</td><td>1</td><td>1</td><td>2</td><td>123</td><td>-121</td>');
  expect(html).toContain('<th>转入/转出次数</th>');
  expect(html).toContain('<th>净流入 CFX</th>');
  expect(html).not.toContain('覆盖范围');
  expect(html).not.toContain('123.456789');
  expect((html.match(/role="tab"/g) ?? [])).toHaveLength(5);
  expect((html.match(/role="tabpanel"/g) ?? [])).toHaveLength(5);
});

it('识别 Core 内置合约，并从 Scan 公开接口尽力读取标签', async () => {
  const builtin = 'cfx:aaejuaaaaaaaaaaaaaaaaaaaaaaaaaaaa2sn102vjv';
  expect(localAddressMeta(builtin)).toEqual({ kind: 'builtin', name: 'CrossSpaceCall' });
  expect(localAddressMeta(BINANCE_CFX)).toEqual({ tag: '币安钱包 · 追踪起点' });
  const address = 'cfx:aapwpauv99u7egnx1vh0uyvfsk7edp6rc6hactkn4b';
  const calls: string[] = [];
  const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input); calls.push(url);
    return new Response(JSON.stringify({ code: 0, data: { map: { [address]: { nameTag: '公开标签' } } } }), { status: 200 });
  }) as typeof fetch;
  const result = await lookupTrackerMetadata([address, builtin], fakeFetch);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('/v1/nametag?address=');
  expect(result.get(address)?.tag).toBe('公开标签');
  expect(result.get(builtin)).toEqual({ kind: 'builtin', name: 'CrossSpaceCall' });
});

it('从 Scan 合约详情读取合约名称，接口失败时保留类型标注', async () => {
  const contract = 'cfx:acawgvnhveawgvnhveawgvnhveawgvnhverezpyypg';
  const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes('/v1/contract/')) return new Response(JSON.stringify({ code: 0, data: { name: '示例合约' } }));
    return new Response(JSON.stringify({ code: 0, data: { map: {} } }));
  }) as typeof fetch;
  const result = await lookupTrackerMetadata([contract], fakeFetch);
  expect(result.get(contract)).toEqual({ kind: 'contract', name: '示例合约' });
  expect(localAddressMeta(contract)).toEqual({ kind: 'contract' });
});

it('转移记录接口可分页读取', async () => {
  const res = await fetch(`${base}/api/cfx-tracker/transfers?limit=1&offset=1`);
  expect(res.status).toBe(200);
  const data = await res.json() as { total: number; rows: Array<{tx_hash:string}> };
  expect(data.total).toBe(2);
  expect(data.rows).toHaveLength(1);
  expect(data.rows[0].tx_hash).toBe('0x02');
});

it('补抓交易对手全账户后，排名同时累计转入和转出', async () => {
  const other = 'cfx:aapwpauv99u7egnx1vh0uyvfsk7edp6rc6hactkn4b';
  const db = new TrackerDb();
  await db.init();
  const now = Math.floor(Date.now() / 1000);
  await db.run('INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?)', ['core', '0x03', 1, now, 'cfx:aatx4z91eg536e55vhcr1gfuewnc34v26ajab18ngb', other, '5000000000000000000', 'counterparty']);
  await db.run('INSERT INTO checkpoints VALUES (?,?,?,?,?)', [`core:${other}`, now - 86400, now, new Date().toISOString(), 3]);
  await db.close();
  const response = await fetch(`${base}/api/cfx-tracker`);
  const data = await response.json() as { ranking: Array<{ address: string; inCount: number; outCount: number }> };
  expect(data.ranking.find(r => r.address === other)).toMatchObject({ inCount: 2, outCount: 1 });
  const html = await (await fetch(`${base}/cfx-tracker`)).text();
  expect(html).toContain('转入/转出次数');
  expect(html).not.toContain('覆盖范围');
});

it('仅按返回区块的 miner 字段确认矿工', async () => {
  const other = 'cfx:aajjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjmsf53p7';
  const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/v1/block');
    expect(url.searchParams.get('miner')).toBeTruthy();
    return new Response(JSON.stringify({ code: 0, data: { list: [{ miner }] } }));
  }) as typeof fetch;
  const result = await lookupMinerAddresses([miner, other], fakeFetch);
  expect(result.has(miner)).toBe(true);
  expect(result.has(other)).toBe(false);
});

it('Core 和 eSpace 最近转移分开显示，并标记零转入矿工', async () => {
  const db = new TrackerDb();
  await db.init();
  const now = Math.floor(Date.now() / 1000);
  await db.run('INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?)', ['core', '0x04', 1, now, miner, BINANCE_CFX, '1000000000000000000', 'fixture']);
  await db.run('INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?)', ['espace', '0x05', 1030, now - 86400, '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '3000000000000000000', 'fixture']);
  await db.close();
  const html = await (await fetch(`${base}/cfx-tracker`)).text();
  expect(html).toContain('最近转移 · Core（50 条）');
  expect(html).toContain('最近转移 · eSpace（50 条）');
  expect(html).toMatch(/tracker-panel-espace[^]*0x11111111/);
  expect(html).toMatch(/tracker-panel-core[^]*cfx:aara421/);
  expect(html).toContain('矿工</span>');
});
