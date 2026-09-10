import { describe, it, expect, beforeEach } from 'vitest';
import {
  createUser,
  getUser,
  recordClientInfo,
  __resetForTest,
} from '../src/auth/store.js';

describe('recordClientInfo（MCP 客户端自我声明存用户附属信息）', () => {
  beforeEach(() => __resetForTest());

  it('写入用户最近一次连接的客户端特征，含 name/version/lastSeenAt', () => {
    const u = createUser({ username: 'alice', email: null, provider: 'local' });
    recordClientInfo(u.id, { name: 'Claude Desktop', version: '1.2.3' });

    const got = getUser(u.id)!;
    expect(got.clientInfo).toBeDefined();
    expect(got.clientInfo?.name).toBe('Claude Desktop');
    expect(got.clientInfo?.version).toBe('1.2.3');
    expect(typeof got.clientInfo?.lastSeenAt).toBe('string');
  });

  it('用户不存在时静默忽略，不抛错', () => {
    expect(() => recordClientInfo('no-such-user', { name: 'x' })).not.toThrow();
  });

  it('重复写入覆盖为最近一次客户端（仅保留最近）', () => {
    const u = createUser({ username: 'bob', email: null, provider: 'local' });
    recordClientInfo(u.id, { name: 'Cursor', version: '0.9' });
    recordClientInfo(u.id, { name: 'CustomClient', version: '9.9' });
    expect(getUser(u.id)!.clientInfo?.name).toBe('CustomClient');
    expect(getUser(u.id)!.clientInfo?.version).toBe('9.9');
  });

  it('name/version 可为 undefined（部分客户端只声明其一）', () => {
    const u = createUser({ username: 'carol', email: null, provider: 'local' });
    recordClientInfo(u.id, { name: 'OnlyName' });
    expect(getUser(u.id)!.clientInfo?.name).toBe('OnlyName');
    expect(getUser(u.id)!.clientInfo?.version).toBeUndefined();
  });
});
