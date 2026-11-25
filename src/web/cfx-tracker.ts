import { Router } from 'express';
import { BINANCE_CFX, TrackerDb, cfxWholeAmount } from '../cfx-tracker.js';
import { lookupMinerAddresses, lookupTrackerMetadata, type TrackerMetadata } from '../cfx-tracker-meta.js';
import { esc, page } from './layout.js';
import { deriveBase, wrap } from './http.js';

type Transfer = { space: string; tx_hash: string; timestamp: number; from_address: string; to_address: string; amount_wei: string };
type Link = { core_tx_hash: string; core_to: string; es_address: string | null; amount_wei: string; status: string };
type Rank = { address: string; inCount: number; outCount: number; inWei: bigint; outWei: bigint };
type PeriodSummary = { count: number; inCount: number; outCount: number; inWei: bigint; outWei: bigint };

function dateTs(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const ts = Date.parse(`${value}T00:00:00Z`) / 1000;
  return Number.isFinite(ts) ? ts : fallback;
}
function hrefFor(address: string): string {
  return address.startsWith('0x')
    ? `https://evm.confluxscan.org/address/${encodeURIComponent(address)}`
    : `https://www.confluxscan.org/address/${encodeURIComponent(address).replace(/%3A/gi, ':')}`;
}
function addr(address: string, metadata: TrackerMetadata): string {
  const shortened = address.length > 18 ? `${address.slice(0, address.startsWith('cfx:') ? 12 : 10)}…${address.slice(-6)}` : address;
  const meta = metadata.get(address);
  const badges = [
    meta?.kind === 'builtin' ? '内置合约' : meta?.kind === 'contract' ? '合约' : '',
    meta?.name,
    meta?.tag,
  ].filter(Boolean).map(value => `<span class="tracker-address-badge">${esc(value)}</span>`).join('');
  return `<span class="tracker-address-cell"><a class="tracker-address" href="${esc(hrefFor(address))}" title="${esc(address)}" aria-label="${esc(address)}" target="_blank" rel="noopener noreferrer"><code>${esc(shortened)}</code></a>${badges}</span>`;
}

function summarize(transfers: Transfer[], since: number): PeriodSummary {
  const result = { count: 0, inCount: 0, outCount: 0, inWei: 0n, outWei: 0n };
  for (const t of transfers) {
    if (t.timestamp < since) continue;
    result.count++;
    if (t.to_address === BINANCE_CFX) { result.inCount++; result.inWei += BigInt(t.amount_wei); }
    if (t.from_address === BINANCE_CFX) { result.outCount++; result.outWei += BigInt(t.amount_wei); }
  }
  return result;
}

async function snapshot(from: number, to: number) {
  const db = new TrackerDb();
  try {
    await db.init();
    const now = Math.floor(Date.now() / 1000);
    const [transfers, links, checkpoints, linkCount, seedTransfers] = await Promise.all([
      db.all<Transfer>('SELECT space,tx_hash,timestamp,from_address,to_address,amount_wei FROM transfers WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp DESC', [from, to]),
      db.all<Link>('SELECT core_tx_hash,core_to,es_address,amount_wei,status FROM cross_space_links WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT 100', [from, to]),
      db.all<{source: string; start_ts: number; end_ts: number; completed_at: string; records: number}>('SELECT * FROM checkpoints ORDER BY end_ts DESC'),
      db.get<{count: number}>('SELECT COUNT(*) AS count FROM cross_space_links WHERE timestamp BETWEEN ? AND ?', [from, to]),
      db.all<Transfer>('SELECT space,tx_hash,timestamp,from_address,to_address,amount_wei FROM transfers WHERE (from_address=? OR to_address=?) AND timestamp BETWEEN ? AND ?', [BINANCE_CFX, BINANCE_CFX, now - 30*86400, now]),
    ]);
    const ranks = new Map<string, Rank>();
    const touch = (address: string): Rank => {
      let r = ranks.get(address);
      if (!r) { r = { address, inCount: 0, outCount: 0, inWei: 0n, outWei: 0n }; ranks.set(address, r); }
      return r;
    };
    const pairs = new Map<string, { from: string; to: string; count: number; wei: bigint }>();
    for (const t of transfers) {
      const amount = BigInt(t.amount_wei);
      const fromRank = touch(t.from_address); fromRank.outCount++; fromRank.outWei += amount;
      const toRank = touch(t.to_address); toRank.inCount++; toRank.inWei += amount;
      const key = `${t.from_address}|${t.to_address}`;
      let p = pairs.get(key);
      if (!p) { p = { from: t.from_address, to: t.to_address, count: 0, wei: 0n }; pairs.set(key, p); }
      p.count++; p.wei += amount;
    }
    const ranking = [...ranks.values()].sort((a,b) => (b.inCount+b.outCount) - (a.inCount+a.outCount) || a.address.localeCompare(b.address));
    return { transfers, links, linkCount: linkCount?.count ?? 0, checkpoints, ranking, pairs: [...pairs.values()].sort((a,b) => b.count-a.count), recent: { week: summarize(seedTransfers, now - 7*86400), month: summarize(seedTransfers, now - 30*86400), asOf: now }, from, to };
  } finally { await db.close(); }
}

export function createCfxTrackerRouter(
  metadataProvider: (addresses: string[]) => Promise<TrackerMetadata> = lookupTrackerMetadata,
  minerProvider: (addresses: string[]) => Promise<Set<string>> = lookupMinerAddresses,
): Router {
  const router = Router();
  router.get('/cfx-tracker', wrap(async (req, res) => {
    const defaultFrom = Math.floor(Date.now()/1000) - 93*86400;
    const from = dateTs(req.query.from, defaultFrom);
    const to = dateTs(req.query.to, Math.floor(Date.now()/1000)+86400);
    if (from > to) { res.status(400).send('开始日期晚于结束日期'); return; }
    const data = await snapshot(from, to);
    const sort = String(req.query.sort ?? 'count');
    const metric = (r: Rank) => sort === 'in' ? r.inWei : sort === 'out' ? r.outWei : r.inWei - r.outWei;
    if (sort !== 'count') data.ranking.sort((a,b) => metric(a) === metric(b) ? a.address.localeCompare(b.address) : metric(a) > metric(b) ? -1 : 1);
    const visibleRanks = data.ranking.slice(0, 100);
    const visiblePairs = data.pairs.slice(0, 30);
    const visibleLinks = data.links.slice(0, 30);
    const coreTransfers = data.transfers.filter(t => t.space === 'core').slice(0, 50);
    const espaceTransfers = data.transfers.filter(t => t.space === 'espace').slice(0, 50);
    const visibleTransfers = [...coreTransfers, ...espaceTransfers];
    const [metadata, miners] = await Promise.all([metadataProvider([
      BINANCE_CFX,
      ...visibleRanks.map(r => r.address),
      ...visiblePairs.flatMap(p => [p.from, p.to]),
      ...visibleLinks.flatMap(l => [l.core_to, ...(l.es_address ? [l.es_address] : [])]),
      ...visibleTransfers.flatMap(t => [t.from_address, t.to_address]),
    ]), minerProvider(visibleRanks.filter(r => r.inWei === 0n && r.address.startsWith('cfx:')).map(r => r.address))]);
    const addressLink = (address: string) => addr(address, metadata);
    const rankRows = visibleRanks.map((r,i) => `<tr><td>${i+1}</td><td>${addressLink(r.address)}${miners.has(r.address) ? '<span class="tracker-address-badge">矿工</span>' : ''}</td><td class="tracker-number">${r.inCount+r.outCount}</td><td class="tracker-number">${r.inCount} / ${r.outCount}</td><td class="tracker-number">${esc(cfxWholeAmount(r.inWei))}</td><td class="tracker-number">${esc(cfxWholeAmount(r.outWei))}</td><td class="tracker-number">${esc(cfxWholeAmount(r.inWei-r.outWei))}</td></tr>`).join('');
    const pairRows = visiblePairs.map(p => `<tr><td>${addressLink(p.from)}</td><td>${addressLink(p.to)}</td><td class="tracker-number">${p.count}</td><td class="tracker-number">${esc(cfxWholeAmount(p.wei))}</td></tr>`).join('');
    const linkRows = visibleLinks.map(l => `<tr><td><a href="https://www.confluxscan.org/transaction/${esc(l.core_tx_hash)}" title="${esc(l.core_tx_hash)}" target="_blank" rel="noopener noreferrer"><code>${esc(l.core_tx_hash.slice(0,12))}…</code></a></td><td>${addressLink(l.core_to)}</td><td>${l.es_address ? addressLink(l.es_address) : '未解析'}</td><td class="tracker-number">${esc(cfxWholeAmount(l.amount_wei))}</td></tr>`).join('');
    const transferRows = (transfers: Transfer[]) => transfers.map(t => `<tr><td>${esc(new Date(t.timestamp*1000).toISOString().slice(0,19).replace('T',' '))}</td><td>${addressLink(t.from_address)}</td><td>${addressLink(t.to_address)}</td><td class="tracker-number">${esc(cfxWholeAmount(t.amount_wei))}</td></tr>`).join('');
    const summaryRow = (label: string, s: PeriodSummary) => `<tr><th scope="row">${esc(label)}</th><td>${s.count}</td><td>${s.inCount}</td><td>${s.outCount}</td><td>${esc(cfxWholeAmount(s.inWei))}</td><td>${esc(cfxWholeAmount(s.outWei))}</td><td>${esc(cfxWholeAmount(s.inWei-s.outWei))}</td></tr>`;
    const fromValue = new Date(from*1000).toISOString().slice(0,10), toValue = new Date(to*1000).toISOString().slice(0,10);
    const complete = data.checkpoints.filter(c => c.source.startsWith('core:')).length;
    const eComplete = data.checkpoints.filter(c => c.source.startsWith('espace:')).length;
    const latest = data.transfers.length ? new Date(data.transfers[0].timestamp*1000).toISOString().slice(0,19).replace('T',' ') : '无';
    res.type('html').send(page({ title: '币安 CFX 地址追踪', base: deriveBase(req), bodyClass: 'cfx-tracker-page', body: `
<h1>币安 CFX 地址与交易追踪</h1>
<p>起点：${addressLink(BINANCE_CFX)}</p>
<form method="get" action="/cfx-tracker" class="row"><label>开始（UTC）<input type="date" name="from" value="${esc(fromValue)}"></label><label>结束（UTC）<input type="date" name="to" value="${esc(toValue)}"></label><label>排序<select name="sort"><option value="count" ${sort==='count'?'selected':''}>交易次数</option><option value="in" ${sort==='in'?'selected':''}>转入金额</option><option value="out" ${sort==='out'?'selected':''}>转出金额</option><option value="total" ${sort==='total'?'selected':''}>净流入金额</option></select></label><button class="btn">查询</button></form>
<div class="grid"><div class="stat"><div class="n">${data.transfers.length}</div><div class="l">CFX 转移记录</div></div><div class="stat"><div class="n">${data.ranking.length}</div><div class="l">涉及地址</div></div><div class="stat"><div class="n">${data.linkCount}</div><div class="l">跨 Space 关联</div></div></div>
<h2>币安地址最近交易汇总</h2>
<p class="muted">截至 ${esc(new Date(data.recent.asOf*1000).toISOString().slice(0,19).replace('T',' '))} UTC，滚动 7 天和 30 天；仅统计上述币安 Core 地址的直接转移，不随上方筛选区间变化。金额四舍五入到整数 CFX。</p>
<div style="overflow:auto"><table class="tracker-summary"><thead><tr><th>区间</th><th>总次数</th><th>入金次数</th><th>出金次数</th><th>入金 CFX</th><th>出金 CFX</th><th>净流入 CFX</th></tr></thead><tbody>${summaryRow('最近 1 周', data.recent.week)}${summaryRow('最近 1 月', data.recent.month)}</tbody></table></div>
<p class="muted">最近一条记录：${esc(latest)} UTC。Core 已完成 ${complete} 个时间段；eSpace 已完成 ${eComplete} 个映射地址。排名只统计当前采集到的交易，不能把零笔理解成该地址没有其他转入或转出。净流入为转入减转出；同一经济转移可能在 Core 与 eSpace 各有一段。</p>
<p class="muted">地址名称、标签和矿工标记来自 ConfluxScan 公开接口；仅对样本中转入 CFX 为 0 的 Core 地址查询挖出区块。接口不可用时不标记矿工。</p>
<div class="tracker-tabs" role="tablist" aria-label="追踪数据表">
  <button type="button" class="tracker-tab" role="tab" id="tracker-tab-rank" aria-controls="tracker-panel-rank" aria-selected="true">地址排名（前 100）</button>
  <button type="button" class="tracker-tab" role="tab" id="tracker-tab-pairs" aria-controls="tracker-panel-pairs" aria-selected="false" tabindex="-1">地址间转移（前 30）</button>
  <button type="button" class="tracker-tab" role="tab" id="tracker-tab-links" aria-controls="tracker-panel-links" aria-selected="false" tabindex="-1">跨 Space 映射（最近 30）</button>
  <button type="button" class="tracker-tab" role="tab" id="tracker-tab-core" aria-controls="tracker-panel-core" aria-selected="false" tabindex="-1">最近转移 · Core（50 条）</button>
  <button type="button" class="tracker-tab" role="tab" id="tracker-tab-espace" aria-controls="tracker-panel-espace" aria-selected="false" tabindex="-1">最近转移 · eSpace（50 条）</button>
</div>
<section class="tracker-tab-panel" role="tabpanel" id="tracker-panel-rank" aria-labelledby="tracker-tab-rank"><div style="overflow:auto"><table class="tracker-table"><thead><tr><th>#</th><th>地址</th><th>次数</th><th>转入/转出次数</th><th>转入 CFX</th><th>转出 CFX</th><th>净流入 CFX</th></tr></thead><tbody>${rankRows}</tbody></table></div></section>
<section class="tracker-tab-panel" role="tabpanel" id="tracker-panel-pairs" aria-labelledby="tracker-tab-pairs" hidden><div style="overflow:auto"><table class="tracker-table"><thead><tr><th>从</th><th>到</th><th>次数</th><th>金额 CFX</th></tr></thead><tbody>${pairRows}</tbody></table></div></section>
<section class="tracker-tab-panel" role="tabpanel" id="tracker-panel-links" aria-labelledby="tracker-tab-links" hidden><div style="overflow:auto"><table class="tracker-table"><thead><tr><th>Core 交易</th><th>Core 目标</th><th>eSpace 映射地址</th><th>金额 CFX</th></tr></thead><tbody>${linkRows}</tbody></table></div></section>
<section class="tracker-tab-panel" role="tabpanel" id="tracker-panel-core" aria-labelledby="tracker-tab-core" hidden><div style="overflow:auto"><table class="tracker-table"><thead><tr><th>时间 UTC</th><th>从</th><th>到</th><th>CFX</th></tr></thead><tbody>${transferRows(coreTransfers)}</tbody></table></div></section>
<section class="tracker-tab-panel" role="tabpanel" id="tracker-panel-espace" aria-labelledby="tracker-tab-espace" hidden><div style="overflow:auto"><table class="tracker-table"><thead><tr><th>时间 UTC</th><th>从</th><th>到</th><th>CFX</th></tr></thead><tbody>${transferRows(espaceTransfers)}</tbody></table></div></section>
<script>(function(){const tabs=[...document.querySelectorAll('.tracker-tab')];function show(tab){for(const item of tabs){const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;document.getElementById(item.getAttribute('aria-controls')).hidden=!selected;}}for(const tab of tabs){tab.addEventListener('click',()=>show(tab));tab.addEventListener('keydown',e=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();const next=tabs[(tabs.indexOf(tab)+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];show(next);next.focus();});}})();</script>
<p class="muted">数据来源：ConfluxScan Core CFX Transfers、Core 交易详情及 eSpace txlist。数据保存在 SQLite，按检查点续抓。页面只展示记录，不发起链上交易。</p>
` }));
  }));
  router.get('/api/cfx-tracker', wrap(async (req, res) => {
    const from = dateTs(req.query.from, Math.floor(Date.now()/1000)-93*86400);
    const to = dateTs(req.query.to, Math.floor(Date.now()/1000)+86400);
    if (from > to) { res.status(400).json({ error: 'invalid range' }); return; }
    const d = await snapshot(from, to);
    res.json({ from, to, seed: BINANCE_CFX, transferCount: d.transfers.length, addressCount: d.ranking.length, crossSpaceLinkCount: d.linkCount, checkpoints: d.checkpoints, ranking: d.ranking.map(r => ({address:r.address, inCount:r.inCount,outCount:r.outCount,inWei:r.inWei.toString(),outWei:r.outWei.toString()})), pairs: d.pairs.map(p => ({from:p.from,to:p.to,count:p.count,amountWei:p.wei.toString()})), crossSpaceLinks: d.links });
  }));
  router.get('/api/cfx-tracker/transfers', wrap(async (req, res) => {
    const from = dateTs(req.query.from, Math.floor(Date.now()/1000)-93*86400);
    const to = dateTs(req.query.to, Math.floor(Date.now()/1000)+86400);
    if (from > to) { res.status(400).json({ error: 'invalid range' }); return; }
    const requestedLimit = Number(req.query.limit);
    const requestedOffset = Number(req.query.offset);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(500, Math.floor(requestedLimit)) : 100;
    const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.floor(requestedOffset) : 0;
    const db = new TrackerDb();
    try {
      await db.init();
      const [rows, total] = await Promise.all([
        db.all<Transfer>('SELECT space,tx_hash,timestamp,from_address,to_address,amount_wei FROM transfers WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp DESC, tx_hash LIMIT ? OFFSET ?', [from,to,limit,offset]),
        db.get<{count:number}>('SELECT COUNT(*) AS count FROM transfers WHERE timestamp BETWEEN ? AND ?', [from,to]),
      ]);
      res.json({ total: total?.count ?? 0, offset, limit, rows });
    } finally { await db.close(); }
  }));
  return router;
}
