/**
 * 存储层 MySQL 支持（与 SQLite 并存，由 STORAGE_DRIVER 选择）：
 * - 选项解析（不连库）：MYSQL_URL 优先于各项；缺省值合理
 * - 方言上报：STORAGE_DRIVER=mysql 在禁用模式下也由 persistStatus 上报，且不建立连接
 * - 真正落库冒烟（仅当 RUN_MYSQL_TESTS=1 且 MySQL 可达时运行）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  configureDb,
  flushDb,
  initDb,
  persistStatus,
  resolveMysqlOptions,
  resolveSequelizeOptions,
} from '../src/db.js';
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

  it('resolveSequelizeOptions(mysql) 用 URL 时不展开 host 分项', () => {
    process.env.MYSQL_URL = 'mysql://u:p@db:3307/mydb';
    const opt = resolveSequelizeOptions('mysql') as Record<string, unknown>;
    expect(opt.dialect).toBe('mysql');
    expect(opt.url).toBe('mysql://u:p@db:3307/mydb');
  });

  it('resolveSequelizeOptions(mysql) 用分项时展开 host/port/user/database', () => {
    delete process.env.MYSQL_URL;
    process.env.MYSQL_HOST = 'db.example.com';
    process.env.MYSQL_PORT = '3308';
    process.env.MYSQL_USER = 'app';
    process.env.MYSQL_PASSWORD = 'secret';
    process.env.MYSQL_DATABASE = 'mcp';
    const opt = resolveSequelizeOptions('mysql') as Record<string, unknown>;
    expect(opt.dialect).toBe('mysql');
    expect(opt.host).toBe('db.example.com');
    expect(opt.port).toBe(3308);
    expect(opt.username).toBe('app');
    expect(opt.database).toBe('mcp');
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
});

describe.runIf(RUN_LIVE && isDisposableTestDb())(
  'MySQL 真实落库（需 RUN_MYSQL_TESTS=1 且目标库名以 _test 结尾，避免清掉生产数据）',
  () => {
  beforeEach(() => configureDb({ enabled: true }));

  it('连 MySQL 后落库、清内存再加载，账号仍在', async () => {
    process.env.STORAGE_DRIVER = 'mysql';
    await initDb({ enabled: true });
    store.__resetForTest();
    store.createUser({ username: 'mysql_u1', email: null, provider: 'local' });
    await flushDb();
    store.__resetForTest();
    await store.reloadUsersFromDb();
    expect(store.countUsers()).toBeGreaterThanOrEqual(1);
  });
});
