/**
 * 存储层（SQLite + Sequelize）冒烟：
 * - 写库后清内存再加载，数据仍在
 * - 落盘文件是单一的 mcp-demo.sqlite（不再有 users.json 等分文件）
 * - 旧 JSON 数据在启动时自动导入（users / billing / stats / recharge / 充值设置 / GitHub 设置）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/auth/store.js';
import * as billing from '../src/billing.js';
import * as stats from '../src/stats.js';
import * as recharge from '../src/recharge.js';
import * as settings from '../src/settings.js';
import { archiveLegacyJson, closeDb, configureDb, flushDb, initDb, migrateLegacyJson, saveBilling, saveUsers, scheduleDbWrite } from '../src/db.js';

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
    archiveLegacyJson(dir, { imported: ['settings', 'stats'], skipped: [] });
    expect(existsSync(join(dir, 'users.json'))).toBe(true);
    expect(existsSync(join(dir, '_migrated_json', 'settings.json'))).toBe(true);
    expect(existsSync(join(dir, '_migrated_json', 'stats.json'))).toBe(true);
    // .bak 也一并处理
    writeFileSync(join(dir, 'recharge.json.bak'), '{}');
    archiveLegacyJson(dir, { imported: ['recharge'], skipped: [] });
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

describe('遗留 JSON 迁移标记（防清空表后重启复活，PR #2 comment 8）', () => {
  it('表非空而跳过的遗留 JSON 被移出且标记，后续启动不再复活', async () => {
    const dir = await freshDb();
    store.__resetForTest();
    // 预先造一个用户，使 users 表非空（模拟「该表已由其它途径填充」）
    store.createUser({ username: 'existing', email: null, provider: 'local' });
    await flushDb();
    store.__resetForTest();
    await store.reloadUsersFromDb();
    expect(store.countUsers()).toBe(1);

    // 放入一份遗留 users.json（含额外用户 legacy2），它应被跳过而非导入
    writeFileSync(
      join(dir, 'users.json'),
      JSON.stringify({ users: [{ id: 'u2', username: 'legacy2', provider: 'local' }] }),
    );

    // 首次「启动」：迁移扫描 → users 表非空 → 跳过，返回 skipped
    let res = await migrateLegacyJson(dir);
    expect(res.skipped).toContain('users');
    expect(res.imported).not.toContain('users');
    // 归档：跳过的文件移出 DATA_DIR 到 _skipped_for_review，并写迁移标记
    archiveLegacyJson(dir, res);
    expect(existsSync(join(dir, 'users.json'))).toBe(false);
    expect(existsSync(join(dir, '_migrated_json', '_skipped_for_review', 'users.json'))).toBe(true);
    const status = JSON.parse(readFileSync(join(dir, '_migrated_json', '_status.json'), 'utf8'));
    expect(status.users).toBe('skipped');

    // 模拟「管理员删空该表」后再次启动：迁移读取状态标记，忽略已跳过的数据集，不再复活 legacy2
    store.__resetForTest();
    await saveUsers([]); // 清空 users 表
    await flushDb();
    res = await migrateLegacyJson(dir);
    expect(res.imported).not.toContain('users');
    expect(res.skipped).not.toContain('users'); // 已被状态标记为处理过，不再参与
    store.__resetForTest();
    await store.reloadUsersFromDb();
    expect(store.countUsers()).toBe(0); // legacy2 未被复活

    rmSync(dir, { recursive: true, force: true });
  });

  it('表非空但无遗留 JSON 时不标记 skipped（避免写永久标记误忽略后续导入，PR #3 comment 3）', async () => {
    const dir = await freshDb();
    store.__resetForTest();
    store.createUser({ username: 'existing', email: null, provider: 'local' });
    await flushDb();
    store.__resetForTest();
    await store.reloadUsersFromDb();
    expect(store.countUsers()).toBe(1);

    // 表非空、但 DATA_DIR 下没有 users.json → 不应标记为 skipped
    expect(existsSync(join(dir, 'users.json'))).toBe(false);
    const res = await migrateLegacyJson(dir);
    expect(res.skipped).not.toContain('users');
    expect(res.imported).not.toContain('users');

    // 后续放入遗留 users.json 并清空该表（模拟空库替换），应能被正常导入而非被旧标记忽略
    writeFileSync(join(dir, 'users.json'), JSON.stringify({ users: [{ id: 'u9', username: 'late', provider: 'local' }] }));
    store.__resetForTest();
    await saveUsers([]); // 清空 users 表
    await flushDb();
    const res2 = await migrateLegacyJson(dir);
    expect(res2.imported).toContain('users'); // 未被错误标记忽略
    store.__resetForTest();
    await store.reloadUsersFromDb();
    expect(store.countUsers()).toBe(1);
    expect(store.listUsers().items[0]?.username).toBe('late');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('同数据集写入串行化（防并发整表替换覆盖，PR #2 comment 7）', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // 轮询直到条件成立或超时（避免固定 sleep 在慢 CI worker 上错过首个定时器触发，PR #3 comment 4）
  const waitFor = async (fn: () => boolean, timeoutMs: number): Promise<boolean> => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > timeoutMs) return false;
      await delay(10);
    }
    return true;
  };

  it('定时器已触发在途写入时，flushDb 串行等待而非并行开启第二个同表事务', async () => {
    const dir = await freshDb();
    store.__resetForTest();
    store.createUser({ username: 'u_a', email: null, provider: 'local' });

    let active = 0;
    let maxConcurrent = 0;
    const slowWrite = async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await delay(300); // 模拟慢网络事务
      await saveUsers(store.listUsers().items);
      active -= 1;
    };

    // 排程第一个写入；防抖定时器（300ms）触发后 runNow 进入慢事务、在途（active=1 可观测）
    scheduleDbWrite('users', slowWrite);
    // 等待「首个定时器已触发且事务在途」这一可观测状态，再排程第二个，确保串行化路径被真正触发
    const started = await waitFor(() => active === 1, 2000);
    expect(started).toBe(true);

    // 此刻再排程第二个并立即 flushDb：应等待在途的首个事务结束，再写第二个，不可并行
    store.createUser({ username: 'u_b', email: null, provider: 'local' });
    scheduleDbWrite('users', slowWrite);
    await flushDb();

    expect(maxConcurrent).toBe(1); // 同数据集事务从未并行
    store.__resetForTest();
    await store.reloadUsersFromDb();
    expect(store.countUsers()).toBe(2); // 最新快照完整落库，无旧快照覆盖
    rmSync(dir, { recursive: true, force: true });
  });

  it('不同数据集的整表替换事务也不会并行（全局单写者队列，防 SQLITE_BUSY，PR #3 comment 8）', async () => {
    const dir = await freshDb();
    store.__resetForTest();
    store.createUser({ username: 'u_a', email: null, provider: 'local' });
    const billingState: Record<string, billing.UserBilling> = {
      u_a: { userId: 'u_a', used: 1, balance: 1, recharged: 1, firstSeenAt: '', lastSeenAt: '' },
    };

    let active = 0;
    let maxConcurrent = 0;
    let usersRan = false;
    let billingRan = false;
    const slowUsers = async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      usersRan = true;
      await delay(200); // 模拟慢网络事务
      await saveUsers(store.listUsers().items);
      active -= 1;
    };
    const slowBilling = async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      billingRan = true;
      await delay(200);
      await saveBilling(billingState);
      active -= 1;
    };

    // 触发 users 在途事务（防抖定时器 300ms 后进入慢事务，active=1 可观测）
    scheduleDbWrite('users', slowUsers);
    const started = await waitFor(() => usersRan && active === 1, 2000);
    expect(started).toBe(true);

    // users 还在途时，再排程一个 billing 写入并 flush：应排队等 users 事务结束，
    // 不可与 users 并行（SQLite 单写者），否则会触发 SQLITE_BUSY（PR #3 comment 8）
    scheduleDbWrite('billing', slowBilling);
    await flushDb();

    expect(usersRan).toBe(true);
    expect(billingRan).toBe(true);
    expect(maxConcurrent).toBe(1); // 不同数据集也未并行

    store.__resetForTest();
    await store.reloadUsersFromDb();
    await billing.reloadBillingFromDb();
    expect(store.countUsers()).toBe(1);
    expect(billing.getUserBilling('u_a')).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });
});
