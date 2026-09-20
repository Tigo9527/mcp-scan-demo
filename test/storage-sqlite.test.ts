/**
 * 存储层（SQLite + Sequelize）冒烟：
 * - 写库后清内存再加载，数据仍在
 * - 落盘文件是单一的 mcp-demo.sqlite（不再有 users.json 等分文件）
 * - 旧 JSON 数据在启动时自动导入（users / billing / stats / recharge / 充值设置 / GitHub 设置）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/auth/store.js';
import * as billing from '../src/billing.js';
import * as stats from '../src/stats.js';
import * as recharge from '../src/recharge.js';
import * as settings from '../src/settings.js';
import { archiveLegacyJson, closeDb, configureDb, flushDb, initDb, saveUsers } from '../src/db.js';

async function freshDb(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-sqlite-'));
  await initDb({ enabled: true, dataDir: dir });
  return dir;
}

beforeEach(() => {
  configureDb({ enabled: true });
});
afterEach(async () => {
  await closeDb();
  configureDb({ enabled: false });
});

describe('SQLite 持久化', () => {
  it('落库后清内存再加载，账号仍在', async () => {
    const dir = await freshDb();
    store.__resetForTest();
    for (let i = 0; i < 3; i++) {
      store.createUser({ username: `sqlite_u${i}`, email: null, provider: 'local' });
    }
    await flushDb();

    // 模拟进程重启：清空内存态后从库重新加载
    store.__resetForTest();
    await store.reloadUsersFromDb();
    expect(store.countUsers()).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('落盘文件是单一的 mcp-demo.sqlite（不再有 users.json 等分文件）', async () => {
    const dir = await freshDb();
    store.__resetForTest();
    store.createUser({ username: 'sqlite_fixed', email: null, provider: 'local' });
    await flushDb();

    const files = readdirSync(dir);
    expect(files).toContain('mcp-demo.sqlite');
    expect(files.some((n) => n.endsWith('.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('旧 JSON 数据在启动时自动导入（users / billing / stats / recharge / 设置）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-migrate-'));

    const now = new Date().toISOString();
    const uid = 'legacy-user-1';
    writeFileSync(
      join(dir, 'users.json'),
      JSON.stringify({
        users: [{ id: uid, username: 'legacy_a', email: null, provider: 'local', createdAt: now }],
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'billing.json'),
      JSON.stringify({
        [uid]: { userId: uid, used: 5, balance: 995, recharged: 1000, firstSeenAt: now, lastSeenAt: now },
        anonymous: { userId: null, used: 2, balance: 0, recharged: 0, firstSeenAt: now, lastSeenAt: now },
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'stats.json'),
      JSON.stringify({
        since: now,
        counters: { requests: 10, toolCalls: 3, errors: 1 },
        byMethod: { 'tools/call': 3 },
        byTool: { search_repos: 3 },
        byUser: { [uid]: { userId: uid, username: 'legacy_a', calls: 3, tools: { search_repos: 3 }, days: {}, firstSeenAt: now, lastSeenAt: now } },
        byDay: { '2026-01-01': { requests: 10, toolCalls: 3, anonymous: 0 } },
        recent: [],
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'recharge.json'),
      JSON.stringify([
        {
          id: 'r1',
          txHash: '0x' + 'a'.repeat(64),
          userId: uid,
          username: 'legacy_a',
          kind: 'erc20',
          token: 'USDT',
          amount: '1',
          rawAmount: '1000000',
          points: 1000,
          rate: 1000,
          status: 'credited',
          createdAt: now,
        },
      ]),
      'utf8',
    );
    writeFileSync(
      join(dir, 'recharge-settings.json'),
      JSON.stringify({
        recipient: '0x1111111111111111111111111111111111111111',
        rpcUrl: 'https://example.test',
        rate: 1000,
        tokenAddress: '0x2222222222222222222222222222222222222222',
        chainId: '0x1',
        tokenName: 'Tether',
        tokenSymbol: 'USDT',
        tokenDecimals: 6,
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ clientId: 'gh_client', clientSecret: 'gh_secret', updatedAt: now, updatedBy: 'admin' }),
      'utf8',
    );

    await initDb({ enabled: true, dataDir: dir });
    await store.reloadUsersFromDb();
    await billing.reloadBillingFromDb();
    await stats.reloadStatsFromDb();
    await recharge.reloadRechargeSettingsFromDb();
    await recharge.reloadRechargeRecordsFromDb();
    await settings.reloadGithubFromDb();

    // users
    expect(store.getUserByUsername('legacy_a')).toBeTruthy();
    // billing
    expect(billing.getBalance(uid)).toBe(995);
    expect(billing.getUserBilling('anonymous')).toBeTruthy();
    // stats
    expect(stats.getStatsSnapshot().counters.toolCalls).toBe(3);
    // recharge records
    expect(recharge.listRecharges().length).toBe(1);
    expect(recharge.listRecharges()[0]!.points).toBe(1000);
    // recharge settings
    expect(recharge.getRechargeConfig()?.tokenSymbol).toBe('USDT');
    // github settings
    expect(settings.getGithub().clientId).toBe('gh_client');

    // 旧 JSON 已被移出 data/（保留在 _migrated_json 子目录），目录里只剩 .sqlite
    const remaining = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(remaining).not.toContain('users.json');
    expect(existsSync(join(dir, 'mcp-demo.sqlite'))).toBe(true);

    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('整表替换的事务安全（destroy+bulkCreate 必须原子）', () => {
  it('bulkCreate 失败时事务回滚，旧数据不丢', async () => {
    const dir = await freshDb();
    store.__resetForTest();
    store.createUser({ username: 'u_a', email: null, provider: 'local' });
    store.createUser({ username: 'u_b', email: null, provider: 'local' });
    await flushDb();
    store.__resetForTest();
    await store.reloadUsersFromDb();
    expect(store.countUsers()).toBe(2);

    // username 为 null 违反 NOT NULL，bulkCreate 抛错 → 事务回滚 destroy
    await expect(
      saveUsers([{ id: 'bad', username: null as unknown as string, provider: 'local' } as never]),
    ).rejects.toBeTruthy();

    // 旧数据仍在（destroy 已被回滚）
    store.__resetForTest();
    await store.reloadUsersFromDb();
    expect(store.countUsers()).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('archiveLegacyJson 只归档真正导入过的数据集', () => {
  it('传 keys 时只移走指定文件，跳过的文件保留原处', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-arch-'));
    writeFileSync(join(dir, 'users.json'), '{}');
    writeFileSync(join(dir, 'settings.json'), '{}');
    writeFileSync(join(dir, 'stats.json'), '{}');
    // 仅 settings / stats 被导入过 → 只有它们被移走，users.json 保留（表非空被跳过的场景）
    archiveLegacyJson(dir, ['settings', 'stats']);
    expect(existsSync(join(dir, 'users.json'))).toBe(true);
    expect(existsSync(join(dir, '_migrated_json', 'settings.json'))).toBe(true);
    expect(existsSync(join(dir, '_migrated_json', 'stats.json'))).toBe(true);
    // .bak 也一并处理
    writeFileSync(join(dir, 'recharge.json.bak'), '{}');
    archiveLegacyJson(dir, ['recharge']);
    expect(existsSync(join(dir, '_migrated_json', 'recharge.json.bak'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('不传 keys 时移动全部（sqlite 新建库场景）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-arch-'));
    writeFileSync(join(dir, 'users.json'), '{}');
    writeFileSync(join(dir, 'billing.json'), '{}');
    archiveLegacyJson(dir);
    expect(existsSync(join(dir, 'users.json'))).toBe(false);
    expect(existsSync(join(dir, '_migrated_json', 'users.json'))).toBe(true);
    expect(existsSync(join(dir, '_migrated_json', 'billing.json'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
