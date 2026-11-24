import { Router } from 'express';
import { BINANCE_CFX, TrackerDb, cfxAmount } from '../cfx-tracker.js';
import { esc, page } from './layout.js';
import { wrap } from './http.js';

type Transfer = { space: string; tx_hash: string; timestamp: number; from_address: string; to_address: string; amount_wei: string };
type Link = { core_tx_hash: string; core_to: string; es_address: string | null; amount_wei: string; status: string };
type Rank = { address: string; inCount: number; outCount: number; inWei: bigint; outWei: bigint };

function dateTs(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const ts = Date.parse(`${value}T00:00:00Z`) / 1000;
  return Number.isFinite(ts) ? ts : fallback;
}
function hrefFor(address: string): string {
  return address.startsWith('0x')
    ? `https://evm.confluxscan.org/address/${encodeURIComponent(address)}`
    : `https://www.confluxscan.org/address/${encodeURIComponent(address)}`;
}
function addr(address: string): string { return `<a href="${esc(hrefFor(address))}" target="_blank" rel="noopener noreferrer"><code>${esc(address)}</code></a>`; }

async function snapshot(from: number, to: number) {
  const db = new TrackerDb();
  try {
    await db.init();
    const [transfers, links, checkpoints, linkCount] = await Promise.all([
      db.all<Transfer>('SELECT space,tx_hash,timestamp,from_address,to_address,amount_wei FROM transfers WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp DESC', [from, to]),
      db.all<Link>('SELECT core_tx_hash,core_to,es_address,amount_wei,status FROM cross_space_links WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT 100', [from, to]),
      db.all<{source: string; start_ts: number; end_ts: number; completed_at: string; records: number}>('SELECT * FROM checkpoints ORDER BY end_ts DESC'),
      db.get<{count: number}>('SELECT COUNT(*) AS count FROM cross_space_links WHERE timestamp BETWEEN ? AND ?', [from, to]),
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
    return { transfers, links, linkCount: linkCount?.count ?? 0, checkpoints, ranking, pairs: [...pairs.values()].sort((a,b) => b.count-a.count), from, to };
  } finally { await db.close(); }
}

export function createCfxTrackerRouter(): Router {
  const router = Router();
  router.get('/cfx-tracker', wrap(async (req, res) => {
    const defaultFrom = Math.floor(Date.now()/1000) - 93*86400;
    const from = dateTs(req.query.from, defaultFrom);
    const to = dateTs(req.query.to, Math.floor(Date.now()/1000)+86400);
    if (from > to) { res.status(400).send('开始日期晚于结束日期'); return; }
    const data = await snapshot(from, to);
    const sort = String(req.query.sort ?? 'count');
    const metric = (r: Rank) => sort === 'in' ? r.inWei : sort === 'out' ? r.outWei : r.inWei + r.outWei;
    if (sort !== 'count') data.ranking.sort((a,b) => metric(a) === metric(b) ? a.address.localeCompare(b.address) : metric(a) > metric(b) ? -1 : 1);
    const rankRows = data.ranking.slice(0, 100).map((r,i) => `<tr><td>${i+1}</td><td>${addr(r.address)}</td><td>${r.inCount+r.outCount}</td><td>${r.inCount} / ${r.outCount}</td><td>${esc(cfxAmount(r.inWei.toString()))}</td><td>${esc(cfxAmount(r.outWei.toString()))}</td><td>${esc(cfxAmount((r.inWei+r.outWei).toString()))}</td></tr>`).join('');
    const pairRows = data.pairs.slice(0, 30).map(p => `<tr><td>${addr(p.from)}</td><td>${addr(p.to)}</td><td>${p.count}</td><td>${esc(cfxAmount(p.wei.toString()))}</td></tr>`).join('');
    const linkRows = data.links.slice(0, 30).map(l => `<tr><td><a href="https://www.confluxscan.org/transaction/${esc(l.core_tx_hash)}"><code>${esc(l.core_tx_hash)}</code></a></td><td>${addr(l.core_to)}</td><td>${l.es_address ? addr(l.es_address) : '未解析'}</td><td>${esc(cfxAmount(l.amount_wei))}</td></tr>`).join('');
    const transferRows = data.transfers.slice(0, 50).map(t => `<tr><td>${esc(new Date(t.timestamp*1000).toISOString().slice(0,19).replace('T',' '))}</td><td>${esc(t.space)}</td><td>${addr(t.from_address)}</td><td>${addr(t.to_address)}</td><td>${esc(cfxAmount(t.amount_wei))}</td></tr>`).join('');
    const fromValue = new Date(from*1000).toISOString().slice(0,10), toValue = new Date(to*1000).toISOString().slice(0,10);
    const complete = data.checkpoints.filter(c => c.source.startsWith('core:')).length;
    const eComplete = data.checkpoints.filter(c => c.source.startsWith('espace:')).length;
    const latest = data.transfers.length ? new Date(data.transfers[0].timestamp*1000).toISOString().slice(0,19).replace('T',' ') : '无';
    res.type('html').send(page({ title: '币安 CFX 地址追踪', base: `${req.protocol}://${req.get('host')}`, body: `
<h1>币安 CFX 地址与交易追踪</h1>
<p>起点：${addr(BINANCE_CFX)}</p>
<form method="get" action="/cfx-tracker" class="row"><label>开始（UTC）<input type="date" name="from" value="${esc(fromValue)}"></label><label>结束（UTC）<input type="date" name="to" value="${esc(toValue)}"></label><label>排序<select name="sort"><option value="count" ${sort==='count'?'selected':''}>交易次数</option><option value="in" ${sort==='in'?'selected':''}>转入金额</option><option value="out" ${sort==='out'?'selected':''}>转出金额</option><option value="total" ${sort==='total'?'selected':''}>进出总金额</option></select></label><button class="btn">查询</button></form>
<div class="grid"><div class="stat"><div class="n">${data.transfers.length}</div><div class="l">CFX 转移记录</div></div><div class="stat"><div class="n">${data.ranking.length}</div><div class="l">涉及地址</div></div><div class="stat"><div class="n">${data.linkCount}</div><div class="l">跨 Space 关联</div></div></div>
<p class="muted">最近一条记录：${esc(latest)} UTC。Core 已完成 ${complete} 个时间段；eSpace 已完成 ${eComplete} 个映射地址。每条 CFX 转移计一次；同一经济转移可能在 Core 与 eSpace 各有一段，跨 Space 金额相加会重复。所有金额均为 CFX，按 wei 精确累计后显示。</p>
<h2>地址排名（前 100）</h2><div style="overflow:auto"><table><thead><tr><th>#</th><th>地址</th><th>次数</th><th>进 / 出次数</th><th>转入 CFX</th><th>转出 CFX</th><th>总和 CFX</th></tr></thead><tbody>${rankRows}</tbody></table></div>
<h2>地址间转移（前 30）</h2><div style="overflow:auto"><table><thead><tr><th>从</th><th>到</th><th>次数</th><th>金额 CFX</th></tr></thead><tbody>${pairRows}</tbody></table></div>
<h2>跨 Space 映射（最近 30）</h2><div style="overflow:auto"><table><thead><tr><th>Core 交易</th><th>Core 目标</th><th>eSpace 映射地址</th><th>金额 CFX</th></tr></thead><tbody>${linkRows}</tbody></table></div>
<h2>最近转移（50 条）</h2><div style="overflow:auto"><table><thead><tr><th>时间 UTC</th><th>Space</th><th>从</th><th>到</th><th>CFX</th></tr></thead><tbody>${transferRows}</tbody></table></div>
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
