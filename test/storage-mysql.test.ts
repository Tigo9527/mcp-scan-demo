/**
 * 存储层 MySQL 支持（与 SQLite 并存，由 STORAGE_DRIVER 选择）：
 * - 选项解析（不连库）：MYSQL_URL 优先于各项；缺省值合理
 * - 方言上报：STORAGE_DRIVER=mysql 在禁用模式下也由 persistStatus 上报，且不建立连接
 * - 真正落库冒烟（仅当 RUN_MYSQL_TESTS=1 且 MySQL 可达时运行）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDb,
  configureDb,
  flushDb,
  initDb,
  loadBilling,
  loadGithubSettings,
  loadRechargeRecords,
  loadRechargeSettings,
  loadStats,
  persistStatus,
  resolveMysqlOptions,
  resolveSequelizeOptions,
  saveBilling,
  saveGithubSettings,
  saveRechargeRecords,
  saveRechargeSettings,
  saveStats,
} from '../src/db.js';
import type { GithubSettings } from '../src/settings.js';
import type { RechargeConfig, RechargeRecord } from '../src/recharge.js';
import type { StatsSnapshot } from '../src/stats.js';
import type { UserBilling } from '../src/billing.js';
import * as store from '../src/auth/store.js';

const RUN_LIVE = process.env.RUN_MYSQL_TESTS === '1';

/** 真实落库测试会调用 flushDb → saveUsers（整表销毁后重写），具有破坏性。
 *  仅当目标库名以 `_test` 结尾时才允许运行，强制使用一次性/专用测试库，避免误清生产数据。 */
function resolvedMySqlDatabase(): string {
  const o = resolveMysqlOptions();
  if (o.url) {
    try {
      const db = new URL(o.url).pathname.replace(/^\/+/, '');
      if (db) return db;
    } catch {
      /* 忽略：交给下方兜底 */
    }
  }
  return o.database;
}
const isDisposableTestDb = (): boolean => resolvedMySqlDatabase().endsWith('_test');
const MYSQL_KEYS = [
  'STORAGE_DRIVER',
  'MCP_DEMO_PERSIST',
  'MYSQL_URL',
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_DATABASE',
  // 一并保存/恢复：下面「现有 SQLite 存储」测试会临时改写它，避免污染后续用例
  'DATA_DIR',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of MYSQL_KEYS) savedEnv[k] = process.env[k];
});
afterEach(async () => {
  for (const k of MYSQL_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await closeDb();
  configureDb({ enabled: false });
});

describe('MySQL 存储选项解析（不连库）', () => {
  it('resolveMysqlOptions 优先用 MYSQL_URL', () => {
    process.env.MYSQL_URL = 'mysql://u:p@db:3307/mydb';
    delete process.env.MYSQL_HOST;
    delete process.env.MYSQL_DATABASE; // CI 可能注入 MYSQL_DATABASE=mcp_demo_test，清掉以验默认值
    const o = resolveMysqlOptions();
    expect(o.url).toBe('mysql://u:p@db:3307/mydb');
    expect(o.host).toBe('127.0.0.1'); // 未设置时取默认
    expect(o.database).toBe('mcp_demo');
  });

  it('resolveMysqlOptions 缺省值合理', () => {
    for (const k of MYSQL_KEYS) delete process.env[k];
    const o = resolveMysqlOptions();
    expect(o).toMatchObject({ host: '127.0.0.1', port: 3306, user: 'root', database: 'mcp_demo' });
  });

  it('MYSQL_PORT 缺失/空用默认 3306，非法值（非整数/越界）fail-fast', () => {
    delete process.env.MYSQL_PORT;
    expect(resolveMysqlOptions().port).toBe(3306);
    process.env.MYSQL_PORT = '';
    expect(resolveMysqlOptions().port).toBe(3306);
    for (const bad of ['3306x', '-1', '70000', 'abc', '3.5']) {
      process.env.MYSQL_PORT = bad;
      expect(() => resolveMysqlOptions()).toThrow(/MYSQL_PORT/);
    }
  });

  it('resolveSequelizeOptions(mysql) 用 URL 时返回 [uri, options] 重载参数', () => {
    process.env.MYSQL_URL = 'mysql://u:p@db:3307/mydb';
    const [arg, extra] = resolveSequelizeOptions('mysql');
    expect(arg).toBe('mysql://u:p@db:3307/mydb');
    expect(extra).toMatchObject({ dialect: 'mysql' });
  });

  it('resolveSequelizeOptions(mysql) 用分项时展开为连接选项对象', () => {
    delete process.env.MYSQL_URL;
    process.env.MYSQL_HOST = 'db.example.com';
    process.env.MYSQL_PORT = '3308';
    process.env.MYSQL_USER = 'app';
    process.env.MYSQL_PASSWORD = 'secret';
    process.env.MYSQL_DATABASE = 'mcp';
    const [arg] = resolveSequelizeOptions('mysql');
    const obj = arg as Record<string, unknown>;
    expect(obj.dialect).toBe('mysql');
    expect(obj.host).toBe('db.example.com');
    expect(obj.port).toBe(3308);
    expect(obj.username).toBe('app');
    expect(obj.database).toBe('mcp');
  });

  it('STORAGE_DRIVER=mysql 在禁用模式下被 persistStatus 上报且不连库', async () => {
    process.env.STORAGE_DRIVER = 'mysql';
    process.env.MCP_DEMO_PERSIST = '0'; // 纯内存：不建立任何连接
    await initDb({ enabled: false });
    const ps = persistStatus();
    expect(ps.enabled).toBe(false);
    expect(ps.db).toBe('mysql');
    expect(ps.storage).toContain('mysql://');
  });

  it('MYSQL_URL 设置时 persistStatus 上报 redacted 的 host/db（不含口令）', async () => {
    process.env.STORAGE_DRIVER = 'mysql';
    process.env.MYSQL_URL = 'mysql://u:p@db.example.com:3307/mydb';
    process.env.MCP_DEMO_PERSIST = '0'; // 不连库
    await initDb({ enabled: false });
    const ps = persistStatus();
    expect(ps.db).toBe('mysql');
    expect(ps.storage).toBe('mysql://db.example.com:3307/mydb');
    expect(ps.storage).not.toContain('u:p'); // 口令不得出现在状态里
  });

  it('STORAGE_DRIVER 非法值时 initDb 抛错（fail-fast，避免误落 sqlite）', async () => {
    process.env.STORAGE_DRIVER = 'postgres';
    process.env.MCP_DEMO_PERSIST = '0';
    await expect(initDb({ enabled: false })).rejects.toThrow(/STORAGE_DRIVER/);
  });

  it('检测到现有 SQLite 存储时切到 MySQL 启动失败（避免静默丢数据）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-sqlite-detect-'));
    writeFileSync(join(dir, 'mcp-demo.sqlite'), '');
    const prevDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    process.env.STORAGE_DRIVER = 'mysql';
    // 在尝试连 MySQL 之前就应抛错（fail-fast），不会静默以空库启动
    try {
      await expect(initDb({ enabled: true })).rejects.toThrow(/mcp-demo\.sqlite/);
    } finally {
      // 还原 runner 启动时的 DATA_DIR（afterEach 也会再兜底一次），避免影响后续用例
      if (prevDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevDataDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(RUN_LIVE && isDisposableTestDb())(
  'MySQL 真实落库（需 RUN_MYSQL_TESTS=1 且目标库名以 _test 结尾，避免清掉生产数据）',
  () => {
  beforeEach(() => configureDb({ enabled: true }));

  it('连 MySQL 后各存储（users/billing/recharge/settings/stats）落库并回读', async () => {
    process.env.STORAGE_DRIVER = 'mysql';
    await initDb({ enabled: true });

    // users（集成路径：store → flushDb → reload）
    store.__resetForTest();
    store.createUser({ username: 'mysql_u1', email: null, provider: 'local' });
    await flushDb();
    store.__resetForTest();
    await store.reloadUsersFromDb();
    expect(store.countUsers()).toBeGreaterThanOrEqual(1);

    // billing（事务整表替换）
    const billingState: Record<string, UserBilling> = {
      acct1: { userId: 'acct1', used: 5, balance: 100, recharged: 50, firstSeenAt: '', lastSeenAt: '' },
    };
    await saveBilling(billingState);
    expect((await loadBilling()).acct1?.balance).toBe(100);

    // recharge settings（upsert）
    const rc: RechargeConfig = {
      recipient: '0xabcdef0000000000000000000000000000000001',
      rpcUrl: 'https://example.test',
      rate: 1000,
      tokenAddress: '0x2222222222222222222222222222222222222222',
      chainId: '0x1',
      tokenName: 'Tether',
      tokenSymbol: 'USDT',
      tokenDecimals: 6,
    };
    await saveRechargeSettings(rc);
    expect((await loadRechargeSettings())?.tokenSymbol).toBe('USDT');

    // recharge records（事务整表替换）
    const rec: RechargeRecord = {
      id: 'r_' + Date.now(),
      txHash: '0xdeadbeef',
      userId: 'acct1',
      username: 'mysql_u1',
      kind: 'native',
      token: 'CFX',
      amount: '1',
      rawAmount: '1000000000000000000',
      points: 1000,
      rate: 1000,
      status: 'credited',
      createdAt: '',
    };
    await saveRechargeRecords([rec]);
    expect((await loadRechargeRecords()).some((r) => r.id === rec.id)).toBe(true);

    // github settings（upsert）
    const gh: GithubSettings = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://cb', scope: 'read:user' };
    await saveGithubSettings(gh);
    expect((await loadGithubSettings())?.clientId).toBe('cid');

    // stats（upsert）—— 故意写入超过 MySQL TEXT 64KiB 上限的大体积，验证 LONGTEXT 列式足够
    const bigByUser: StatsSnapshot['byUser'] = {};
    for (let i = 0; i < 4000; i++) {
      bigByUser[`user_${i}`] = {
        userId: `user_${i}`,
        username: `user_${i}`,
        calls: i,
        tools: {},
        days: {},
        firstSeenAt: '',
        lastSeenAt: '',
      };
    }
    const bigRecent: StatsSnapshot['recent'] = Array.from({ length: 800 }, (_, i) => ({
      ts: String(i),
      method: 'tools/call',
      tool: 't',
      userId: `user_${i}`,
      username: `user_${i}`,
    }));
    const snap: StatsSnapshot = {
      since: '',
      counters: { requests: 4000, toolCalls: 4000, errors: 0 },
      byMethod: {},
      byTool: {},
      byUser: bigByUser,
      byDay: {},
      recent: bigRecent,
    };
    await saveStats(snap, bigRecent.length % 200);
    const loadedStats = await loadStats();
    expect(loadedStats?.snapshot.counters.requests).toBe(4000);
    expect(Object.keys(loadedStats?.snapshot.byUser ?? {}).length).toBe(4000);
  });
});
