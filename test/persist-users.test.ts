/**
 * 用户持久化：跨「重启」（落盘 → 清内存 → 重新加载）后仍能找回账号。
 *
 * 直接复现用户报告的「只看到 1 个账号」与「登录反复回登录页」根因：
 * 落盘文件名固定为 `users.json`，进程重启后读回同一份数据。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/auth/store.js';
import { configure, flush } from '../src/persist.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-persist-'));
  configure({ enabled: true, dataDir: dir });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  configure({ enabled: false });
});

describe('用户持久化', () => {
  it('落盘后清内存再加载，账号仍在', async () => {
    store.__resetForTest();
    for (let i = 0; i < 3; i++) {
      store.createUser({ username: `persist_u${i}`, email: null, provider: 'local' });
    }
    await flush();

    // 模拟进程重启：清空内存态
    store.__resetForTest();
    expect(store.countUsers()).toBe(3);
  });

  it('落盘文件名固定为 users.json（不随进程 / 实例变化）', async () => {
    store.__resetForTest();
    store.createUser({ username: 'persist_fixed', email: null, provider: 'local' });
    await flush();

    expect(existsSync(join(dir, 'users.json'))).toBe(true);
    // 只有这一个名字，不存在任何带后缀的变体
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(dir).filter((n) => n.startsWith('users'));
    expect(files).toContain('users.json');
    expect(files.filter((n) => n !== 'users.json' && n !== 'users.json.bak')).toEqual([]);
  });

  it('已有的 users.json 会被直接读回（重启不丢数据）', async () => {
    const legacy = [
      { id: 'legacy-1', username: 'legacy_a', email: null, provider: 'local', createdAt: new Date().toISOString() },
      { id: 'legacy-2', username: 'legacy_b', email: null, provider: 'local', createdAt: new Date().toISOString() },
    ];
    writeFileSync(join(dir, 'users.json'), JSON.stringify({ users: legacy }), 'utf8');

    store.__resetForTest();
    expect(store.countUsers()).toBe(2);
    expect(store.getUserByUsername('legacy_a')).toBeTruthy();
    expect(store.getUserByUsername('legacy_b')).toBeTruthy();
  });
});
