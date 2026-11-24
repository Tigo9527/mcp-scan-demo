import path from 'node:path';
import fs from 'node:fs';
import sqlite3 from 'sqlite3';

export const BINANCE_CFX = 'cfx:aatx4z91eg536e55vhcr1gfuewnc34v26ajab18ngb';
export const CROSS_SPACE = 'cfx:aaejuaaaaaaaaaaaaaaaaaaaaaaaaaaaa2sn102vjv';

export function trackerPath(): string {
  return process.env.CFX_TRACKER_DB ?? path.resolve(process.env.DATA_DIR ?? './data', 'cfx-tracker.sqlite');
}

export class TrackerDb {
  private db: sqlite3.Database;
  constructor(file = trackerPath()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new sqlite3.Database(file);
    this.db.configure('busyTimeout', 5000);
  }
  run(sql: string, args: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => this.db.run(sql, args, e => e ? reject(e) : resolve()));
  }
  all<T>(sql: string, args: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => this.db.all(sql, args, (e, rows) => e ? reject(e) : resolve(rows as T[])));
  }
  get<T>(sql: string, args: unknown[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => this.db.get(sql, args, (e, row) => e ? reject(e) : resolve(row as T | undefined)));
  }
  close(): Promise<void> { return new Promise((resolve, reject) => this.db.close(e => e ? reject(e) : resolve())); }
  async init(): Promise<void> {
    await this.run('PRAGMA journal_mode=WAL');
    await this.run(`CREATE TABLE IF NOT EXISTS transfers (
      space TEXT NOT NULL, tx_hash TEXT NOT NULL, trace_index INTEGER NOT NULL,
      timestamp INTEGER NOT NULL, from_address TEXT NOT NULL, to_address TEXT NOT NULL,
      amount_wei TEXT NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY(space, tx_hash, trace_index, from_address, to_address)
    )`);
    await this.run('CREATE INDEX IF NOT EXISTS idx_transfers_time ON transfers(timestamp)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_address)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_address)');
    await this.run(`CREATE TABLE IF NOT EXISTS checkpoints (
      source TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
      completed_at TEXT NOT NULL, records INTEGER NOT NULL,
      PRIMARY KEY(source, start_ts, end_ts)
    )`);
    await this.run(`CREATE TABLE IF NOT EXISTS cross_space_links (
      core_tx_hash TEXT PRIMARY KEY, timestamp INTEGER NOT NULL,
      core_to TEXT NOT NULL, es_address TEXT, amount_wei TEXT NOT NULL,
      status TEXT NOT NULL
    )`);
  }
}

/** 与页面的次数排名使用同一统计口径，选出前 100 中零转入的地址。 */
export async function topZeroInAddresses(db: TrackerDb, from: number, to: number): Promise<string[]> {
  const rows = await db.all<{ address: string; in_count: number; total_count: number }>(`
    WITH legs AS (
      SELECT from_address AS address, 0 AS in_count FROM transfers WHERE timestamp BETWEEN ? AND ?
      UNION ALL
      SELECT to_address AS address, 1 AS in_count FROM transfers WHERE timestamp BETWEEN ? AND ?
    )
    SELECT address, SUM(in_count) AS in_count, COUNT(*) AS total_count
    FROM legs GROUP BY address ORDER BY total_count DESC, address LIMIT 100`, [from, to, from, to]);
  return rows.filter(row => row.in_count === 0 && (row.address.startsWith('cfx:') || /^0x[0-9a-f]{40}$/.test(row.address))).map(row => row.address);
}

export function cfxAmount(wei: string): string {
  const n = BigInt(wei);
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}

/** 页面用整数 CFX：以 wei 精确累计后四舍五入，不经过浮点数。 */
export function cfxWholeAmount(wei: string | bigint): string {
  const n = typeof wei === 'bigint' ? wei : BigInt(wei);
  const absolute = n < 0n ? -n : n;
  const rounded = (n < 0n ? -1n : 1n) * ((absolute + 5n * 10n ** 17n) / 10n ** 18n);
  return rounded.toLocaleString('en-US');
}
