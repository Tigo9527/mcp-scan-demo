/** Binance Core address -> Core transfers -> CrossSpace mapped eSpace accounts. */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import addressJs from '@conflux-dev/conflux-address-js';
import { BINANCE_CFX, CROSS_SPACE, TrackerDb, topZeroInAddresses } from '../src/cfx-tracker.js';

type CoreTransfer = { transactionHash: string; txLogIndex: number; timestamp: number; from: string; to: string; amount: string };
type CorePage = { code: number; message: string; data: { total: number; list: CoreTransfer[] } };
type EvmTx = { hash: string; timestamp: string; from: string; to: string; value: string; isError: string; transactionIndex: string };

const msDay = 86400;
const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const isRateLimited = (error: unknown) => /\b429\b|too many requests|rate.limit/i.test(String(error));
// All Core workers share one queue. Serialize requests below the API's 5/s limit.
let coreRequestQueue: Promise<void> = Promise.resolve();
let nextCoreRequestAt = 0;
const now = new Date();
const threeMonthsAgo = new Date(now);
threeMonthsAgo.setUTCMonth(now.getUTCMonth() - 3);
const fromTs = Math.floor(Date.parse(process.env.CFX_TRACKER_FROM ?? `${threeMonthsAgo.toISOString().slice(0,10)}T00:00:00Z`) / 1000);
const untilTs = Math.floor(Date.parse(process.env.CFX_TRACKER_UNTIL ?? now.toISOString()) / 1000);
if (!Number.isFinite(fromTs) || !Number.isFinite(untilTs) || fromTs >= untilTs) throw new Error('Invalid tracker date range');

async function json<T>(url: URL, deferRateLimit = false): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // curl honors HTTPS_PROXY in environments where Node's global fetch does not.
      const { stdout } = await execFileAsync('curl', ['-fsSL', '--max-time', '20', url.toString()], { timeout: 25000, maxBuffer: 10 * 1024 * 1024 });
      return JSON.parse(stdout) as T;
    } catch (e) {
      if (deferRateLimit && isRateLimited(e)) throw e;
      if (attempt === 3) throw new Error(`${url.origin}${url.pathname}: ${String(e)}`);
      await sleep((attempt + 1) * 1000);
    }
  }
  throw new Error('unreachable');
}

function corePage(url: URL): Promise<CorePage> {
  const request = coreRequestQueue.then(async () => {
    let retries = 0;
    for (;;) {
      await sleep(Math.max(0, nextCoreRequestAt - Date.now()));
      nextCoreRequestAt = Date.now() + 250;
      try {
        const page = await json<CorePage>(url, true);
        if (page.code === 0 || !isRateLimited(page.message)) return page;
      } catch (error) {
        if (!isRateLimited(error)) throw error;
      }
      const delay = Math.min(1000 * 2 ** Math.min(retries++, 5), 30_000);
      console.warn(`Core API rate limited; retrying ${url.pathname} in ${delay}ms`);
      await sleep(delay);
    }
  });
  coreRequestQueue = request.then(() => undefined, () => undefined);
  return request;
}

async function coreWindow(db: TrackerDb, account: string, start: number, end: number): Promise<void> {
  const source = `core:${account}`;
  // 已完成的连续前段无需重抓；再次运行只补上次检查点之后的新时间。
  while (start <= end) {
    const covered = await db.get<{ end_ts: number }>('SELECT MAX(end_ts) AS end_ts FROM checkpoints WHERE source=? AND start_ts<=?', [source, start]);
    if (covered?.end_ts >= start) start = covered.end_ts + 1;
    else break;
  }
  if (start > end) return;
  const base = process.env.CONFLUXSCAN_API_URL ?? 'https://api.confluxscan.org';
  const url = new URL('/account/cfx/transfers', base);
  url.searchParams.set('account', account);
  url.searchParams.set('minTimestamp', String(start));
  url.searchParams.set('maxTimestamp', String(end));
  url.searchParams.set('limit', '100');
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('skip', '0');
  const first = await corePage(url);
  if (first.code !== 0 || !first.data || !Array.isArray(first.data.list)) throw new Error(`Core API: ${first.message}`);
  const total = first.data.total;
  if (total > 10000) {
    if (start === end) throw new Error(`Core API has >10000 records in one second: ${start}`);
    const mid = Math.floor((start + end) / 2);
    await coreWindow(db, account, start, mid);
    await coreWindow(db, account, mid + 1, end);
    return;
  }
  for (let skip = 0; skip < total; skip += 100) {
    url.searchParams.set('skip', String(skip));
    const response = skip === 0 ? first : await corePage(url);
    if (response.code !== 0 || !Array.isArray(response.data?.list)) throw new Error(`Core page ${skip}: ${response.message}`);
    await db.run('BEGIN');
    try {
      for (const t of response.data.list) {
        if (t.timestamp < start || t.timestamp > end) continue;
        await db.run(`INSERT OR IGNORE INTO transfers VALUES (?,?,?,?,?,?,?,?)`,
          ['core', t.transactionHash.toLowerCase(), t.txLogIndex, t.timestamp, t.from.toLowerCase(), t.to.toLowerCase(), t.amount, 'ConfluxScan Core CFX transfers']);
      }
      await db.run('COMMIT');
    } catch (error) { await db.run('ROLLBACK'); throw error; }
  }
  await db.run('INSERT OR REPLACE INTO checkpoints VALUES (?,?,?,?,?)', [source, start, end, new Date().toISOString(), total]);
  console.log(`Core ${account} ${new Date(start * 1000).toISOString()} - ${new Date(end * 1000).toISOString()}: ${total}`);
}

async function coreCounterparties(db: TrackerDb): Promise<void> {
  // 固定在币安地址的一跳范围，避免补抓过程中把新发现的地址无限递归扩展。
  const rows = await db.all<{ address: string; count: number }>(`
    SELECT CASE WHEN from_address=? THEN to_address ELSE from_address END AS address, COUNT(*) AS count
    FROM transfers WHERE space='core' AND (from_address=? OR to_address=?)
      AND timestamp BETWEEN ? AND ?
    GROUP BY address ORDER BY count DESC`, [BINANCE_CFX, BINANCE_CFX, BINANCE_CFX, fromTs, untilTs]);
  const candidates = rows.map(r => r.address).filter(address => {
    if (address === BINANCE_CFX) return false;
    try { return addressJs.decode(address).type !== 'builtin'; } catch { return false; }
  });
  const selected = process.env.CFX_TRACKER_EXPAND_ADDRESSES
    ? candidates.filter(address => process.env.CFX_TRACKER_EXPAND_ADDRESSES!.toLowerCase().split(',').includes(address))
    : candidates;
  if (process.env.CFX_TRACKER_EXPAND_ADDRESSES && !selected.length) throw new Error('No requested direct Core counterparty found');
  console.log(`Core counterparties to sync: ${selected.length}/${candidates.length}`);
  const workerCount = Math.min(4, selected.length);
  const workers: TrackerDb[] = [];
  try {
    for (let i = 0; i < workerCount; i++) {
      const worker = new TrackerDb();
      await worker.init();
      workers.push(worker);
    }
    let next = 0;
    let done = 0;
    const failures: string[] = [];
    await Promise.all(workers.map(async worker => {
      while (next < selected.length) {
        const address = selected[next++];
        try { await coreWindow(worker, address, fromTs, untilTs); }
        catch (error) { failures.push(`${address}: ${String(error)}`); }
        done++;
        if (done % 20 === 0) console.log(`Core counterparties processed: ${done}/${selected.length}`);
      }
    }));
    if (failures.length) throw new Error(`${failures.length} Core counterparties failed:\n${failures.slice(0, 10).join('\n')}`);
  } finally {
    await Promise.all(workers.map(worker => worker.close()));
  }
}

async function syncTopZeroInAddresses(db: TrackerDb): Promise<void> {
  let selected = await topZeroInAddresses(db, fromTs, untilTs);
  const attempted = new Set<string>();
  let round = 0;
  const workers: TrackerDb[] = [];
  try {
    for (let i = 0; i < Math.min(4, selected.length); i++) {
      const worker = new TrackerDb();
      await worker.init();
      workers.push(worker);
    }
    while (selected.length) {
      round++;
      console.log(`Top 100 zero-in round ${round}: ${selected.length} new addresses`);
      let next = 0;
      let done = 0;
      const failures: string[] = [];
      await Promise.all(workers.map(async worker => {
        while (next < selected.length) {
          const address = selected[next++];
          try {
            if (address.startsWith('cfx:')) await coreWindow(worker, address, fromTs, untilTs);
            else await eSpaceAccount(worker, address);
          }
          catch (error) { failures.push(`${address}: ${String(error)}`); }
          done++;
          if (done % 10 === 0) console.log(`Top zero-in addresses processed: ${done}/${selected.length}`);
        }
      }));
      if (failures.length) throw new Error(`${failures.length} zero-in addresses failed:\n${failures.slice(0, 10).join('\n')}`);
      for (const address of selected) attempted.add(address);
      selected = (await topZeroInAddresses(db, fromTs, untilTs)).filter(address => !attempted.has(address));
    }
    console.log(`前 100 零转入补抓完成：${attempted.size} 个地址，${round} 轮`);
  } finally { await Promise.all(workers.map(worker => worker.close())); }
}

async function crossSpace(db: TrackerDb): Promise<void> {
  const rows = await db.all<{ tx_hash: string; timestamp: number; amount_wei: string }>(
    `SELECT tx_hash,timestamp,amount_wei FROM transfers WHERE space='core' AND from_address=? AND to_address=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC`,
    [BINANCE_CFX, CROSS_SPACE, fromTs, untilTs]);
  const pending = [] as typeof rows;
  for (const row of rows) if (!await db.get('SELECT 1 FROM cross_space_links WHERE core_tx_hash=?', [row.tx_hash])) pending.push(row);
  for (let i = 0; i < pending.length; i += 8) {
    const batch = await Promise.all(pending.slice(i, i + 8).map(async row => {
      const url = new URL(`/v1/transaction/${row.tx_hash}`, process.env.CONFLUXSCAN_WEB_API_URL ?? 'https://www.confluxscan.org');
      const response = await json<{ code: number; data?: { cfxTransfers?: { list?: { to: string; from: string }[] } } }>(url);
      if (response.code !== 0) throw new Error(`Core transaction ${row.tx_hash}: ${response.code}`);
      const leg = response.data?.cfxTransfers?.list?.find(t => t.from.toLowerCase() === CROSS_SPACE);
      const es = leg ? `0x${Buffer.from(addressJs.decode(leg.to).hexAddress).toString('hex')}` : null;
      return { row, leg, es };
    }));
    for (const { row, leg, es } of batch) await db.run('INSERT INTO cross_space_links VALUES (?,?,?,?,?,?)',
      [row.tx_hash, row.timestamp, leg?.to.toLowerCase() ?? CROSS_SPACE, es, row.amount_wei, es ? 'mapped' : 'unresolved']);
    if (i % 80 === 0) console.log(`Cross-space mapped ${Math.min(i + 8, pending.length)}/${pending.length}`);
  }
  console.log(`Cross-space Core legs: ${rows.length}`);
}

async function eSpaceAccount(db: TrackerDb, es_address: string): Promise<void> {
  const base = process.env.CONFLUXSCAN_ESPACE_API_URL ?? 'https://evmapi.confluxscan.org';
  const source = `espace:${es_address}`;
  if (await db.get('SELECT 1 FROM checkpoints WHERE source=? AND start_ts=? AND end_ts=?', [source, fromTs, untilTs])) return;
  let count = 0;
  let complete = false;
  for (let page = 1; page <= 100; page++) {
      const url = new URL('/api', base);
      for (const [key, val] of Object.entries({ module: 'account', action: 'txlist', address: es_address, page: String(page), offset: '100', sort: 'desc' })) url.searchParams.set(key, val);
      const response = await json<{ status: string; message: string; result: EvmTx[] | string }>(url);
      if (!Array.isArray(response.result)) throw new Error(`eSpace ${es_address}: ${response.message}`);
      if (response.result.length === 0) { complete = true; break; }
      await db.run('BEGIN');
      try {
        for (const t of response.result) {
          const ts = Number(t.timestamp);
          // eSpace exposes the bridge mint as 0x0 -> mapped account and the actual
          // mapped -> recipient transfer. Keep only the latter to avoid a third leg.
          if (ts < fromTs || ts > untilTs || t.isError !== '0' || t.from.toLowerCase() === '0x0000000000000000000000000000000000000000' || !/^\d+$/.test(t.value) || BigInt(t.value) === 0n) continue;
          await db.run('INSERT OR IGNORE INTO transfers VALUES (?,?,?,?,?,?,?,?)',
            ['espace', t.hash.toLowerCase(), Number(t.transactionIndex), ts, t.from.toLowerCase(), t.to.toLowerCase(), t.value, 'ConfluxScan eSpace txlist']);
          count++;
        }
        await db.run('COMMIT');
      } catch (error) { await db.run('ROLLBACK'); throw error; }
      if (Number(response.result.at(-1)?.timestamp) < fromTs || response.result.length < 100) { complete = true; break; }
  }
  if (!complete) throw new Error(`eSpace ${es_address} exceeded 100 pages; checkpoint withheld`);
  await db.run('INSERT OR REPLACE INTO checkpoints VALUES (?,?,?,?,?)', [source, fromTs, untilTs, new Date().toISOString(), count]);
  console.log(`eSpace ${es_address}: ${count}`);
}

async function eSpace(db: TrackerDb): Promise<void> {
  const accounts = await db.all<{ es_address: string }>(`SELECT DISTINCT es_address FROM cross_space_links WHERE es_address IS NOT NULL`);
  for (const { es_address } of accounts) await eSpaceAccount(db, es_address);
}

const db = new TrackerDb();
try {
  await db.init();
  if (process.argv.includes('--top-zero')) {
    await syncTopZeroInAddresses(db);
  } else {
    for (let start = fromTs; start <= untilTs;) {
      const end = Math.min((Math.floor(start / (msDay * 7)) + 1) * msDay * 7 - 1, untilTs);
      await coreWindow(db, BINANCE_CFX, start, end);
      start = end + 1;
    }
    await coreCounterparties(db);
    await crossSpace(db);
    await eSpace(db);
    await syncTopZeroInAddresses(db);
  }
  console.log('Tracker sync complete');
} finally { await db.close(); }
