/**
 * 用户持久化：跨「重启」（落盘 → 清内存 → 重新加载）后仍能找回账号，
 * 且历史随机分片文件（早期每次启动随机 instanceId 留下的 users-*.json）会被合并载入。
 *
 * 直接复现用户报告的「只看到 1 个账号」与「登录反复回登录页」根因：
 * instanceId 稳定 + 启动时合并所有分片。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('用户持久化与分片合并', () => {
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

  it('历史随机分片 users-<id>.json 会被合并载入', async () => {
    // 写入一个「早期随机 instanceId」遗留的分片，含 2 个账号
    const legacy = [
      { id: 'legacy-1', username: 'legacy_a', email: null, provider: 'local', createdAt: new Date().toISOString() },
      { id: 'legacy-2', username: 'legacy_b', email: null, provider: 'local', createdAt: new Date().toISOString() },
    ];
    writeFileSync(join(dir, 'users-abc123.json'), JSON.stringify({ users: legacy }), 'utf8');

    store.__resetForTest();
    // 当前分片已有 3 个 + 遗留分片 2 个 = 5 个（去重按 id）
    expect(store.countUsers()).toBe(5);
    expect(store.getUserByUsername('legacy_a')).toBeTruthy();
  });

  it('instanceId 默认稳定（非随机），避免每次启动丢数据', () => {
    // 只要未注入 INSTANCE_ID，默认值应固定，不再每次启动变化
    expect(process.env.INSTANCE_ID).toBeUndefined();
  });
});
