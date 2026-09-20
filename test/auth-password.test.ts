/**
 * 账号密码注册 / 登录 测试。
 *
 * 覆盖：
 *  - password.ts：scrypt 哈希、验证、防篡改
 *  - manager：registerWithPassword / loginWithPassword 的查重、成功、失败路径
 *  - 口令绝不进 JWT、绝不被 upsertById 覆盖
 *  - Web：GET/POST /register、GET/POST /login、错误口令 401、跨站 403、校验规则
 *
 * 与 integration.test.ts 一样：每个测试文件在独立模块态中运行，store 初始为空；
 * 统一用唯一用户名前缀避免互相干扰，beforeAll 关闭落盘以免污染 data/。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { config } from '../src/config.js';
import { configure } from '../src/db.js';
import * as auth from '../src/auth/manager.js';
import * as store from '../src/auth/store.js';
import { hashPassword, validatePassword, validateUsername, verifyPassword } from '../src/auth/password.js';

let server: Server;
let base: string;

beforeAll(async () => {
  configure({ enabled: false });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

// ---------------- password.ts ----------------

describe('password hashing', () => {
  it('hashPassword 产出 salt:hash 且 verifyPassword 通过', () => {
    const h = hashPassword('password123');
    expect(h).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(verifyPassword('password123', h)).toBe(true);
  });

  it('不同口令验证失败，且相同明文每次哈希不同（盐随机）', () => {
    const h = hashPassword('password123');
    expect(verifyPassword('wrong', h)).toBe(false);
    expect(hashPassword('password123')).not.toBe(h);
  });

  it('损坏/格式错误的存储值一律返回 false（不抛异常）', () => {
    expect(verifyPassword('x', undefined)).toBe(false);
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'aabb:ccdd')).toBe(false);
  });

  it('validateUsername / validatePassword 拒绝非法输入', () => {
    expect(validateUsername('ab')).not.toBeNull();
    expect(validateUsername('a'.repeat(33))).not.toBeNull();
    expect(validateUsername('bad name!')).not.toBeNull();
    expect(validateUsername('good_name-9')).toBeNull();
    expect(validatePassword('short')).not.toBeNull();
    expect(validatePassword('longenough')).toBeNull();
  });
});

// ---------------- manager：注册 / 登录 ----------------

describe('account/password auth (manager)', () => {
  it('registerWithPassword 创建带哈希的本地用户', () => {
    const { user } = auth.registerWithPassword('reg_u1', 'password123');
    expect(user.provider).toBe('local');
    expect(user.passwordHash).toBeDefined();
    expect(verifyPassword('password123', user.passwordHash)).toBe(true);
    expect(store.getUserByUsername('reg_u1')?.id).toBe(user.id);
  });

  it('重名注册被拒（409）', () => {
    auth.registerWithPassword('dup_u1', 'password123');
    expect(() => auth.registerWithPassword('dup_u1', 'anotherpass')).toThrow(auth.AuthError);
    try {
      auth.registerWithPassword('dup_u1', 'anotherpass');
    } catch (e) {
      expect(e instanceof auth.AuthError && e.status).toBe(409);
    }
  });

  it('非法用户名 / 弱口令被拒（400）', () => {
    expect(() => auth.registerWithPassword('a', 'password123')).toThrow(auth.AuthError);
    expect(() => auth.registerWithPassword('validname', 'short')).toThrow(auth.AuthError);
  });

  it('loginWithPassword 成功返回令牌；错误口令返回通用错误（401）', () => {
    auth.registerWithPassword('login_u1', 'password123');
    const ok = auth.loginWithPassword('login_u1', 'password123');
    expect(ok.token.startsWith(config.jwtTokenPrefix)).toBe(true);
    expect(() => auth.loginWithPassword('login_u1', 'wrong')).toThrow(auth.AuthError);
    try {
      auth.loginWithPassword('login_u1', 'wrong');
    } catch (e) {
      expect(e instanceof auth.AuthError && e.status).toBe(401);
    }
  });

  it('不存在的账号登录也返回通用「用户名或密码错误」（防枚举）', () => {
    try {
      auth.loginWithPassword('no_such_user_xyz', 'whatever');
    } catch (e) {
      expect(e instanceof auth.AuthError && e.status).toBe(401);
      expect((e as Error).message).toBe('用户名或密码错误');
    }
  });

  it('口令绝不写进 JWT', () => {
    const { user } = auth.registerWithPassword('jwt_u1', 'password123');
    const token = auth.issueToken(user);
    const jwt = token.slice(config.jwtTokenPrefix.length);
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    expect(payload.passwordHash).toBeUndefined();
    expect(payload.password).toBeUndefined();
  });

  it('upsertById 不覆盖既有 passwordHash（按需落库安全）', () => {
    const { user } = auth.registerWithPassword('mat_u1', 'password123');
    const rebuilt = auth.authenticate(auth.issueToken(user)); // 从 JWT 还原，无 passwordHash
    expect(rebuilt?.passwordHash).toBeUndefined();
    store.upsertById(rebuilt!);
    const after = store.getUser(user.id)!;
    expect(after.passwordHash).toBe(user.passwordHash);
  });
});

// ---------------- Web 路由 ----------------

describe('account/password auth (web)', () => {
  it('GET /register（无 username）渲染账号密码注册表单', async () => {
    const res = await fetch(`${base}/register`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('action="/register"');
    expect(html).toContain('name="password"');
  });

  it('GET /register?username= 仍走一键注册（Agent 链路不变）', async () => {
    const res = await fetch(`${base}/register?username=agent_oneclick`);
    const html = await res.text();
    expect(res.ok).toBe(true);
    expect(html).toMatch(/mcp_demo_[A-Za-z0-9._-]+/);
  });

  it('POST /register 成功返回令牌页', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
      body: new URLSearchParams({ username: 'web_reg1', password: 'password123' }).toString(),
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toMatch(/mcp_demo_[A-Za-z0-9._-]+/);
  });

  it('POST /register 重名返回 409 并回显错误', async () => {
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
      body: new URLSearchParams({ username: 'web_dup1', password: 'password123' }).toString(),
    });
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
      body: new URLSearchParams({ username: 'web_dup1', password: 'password123' }).toString(),
    });
    const html = await res.text();
    expect(res.status).toBe(409);
    expect(html).toContain('已被占用');
  });

  it('POST /register 弱口令返回 400', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
      body: new URLSearchParams({ username: 'web_weak', password: '123' }).toString(),
    });
    expect(res.status).toBe(400);
  });

  it('GET /login 渲染登录表单', async () => {
    const res = await fetch(`${base}/login`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="password"');
  });

  it('POST /login 成功返回令牌，且令牌可访问 /profile', async () => {
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
      body: new URLSearchParams({ username: 'web_login1', password: 'password123' }).toString(),
    });
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
      body: new URLSearchParams({ username: 'web_login1', password: 'password123' }).toString(),
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    const m = html.match(/mcp_demo_[A-Za-z0-9._-]+/);
    expect(m).toBeTruthy();

    const profile = await fetch(`${base}/profile?token=${m![0]}`);
    const phtml = await profile.text();
    expect(profile.status).toBe(200);
    expect(phtml).toContain('web_login1');
  });

  it('POST /login 错误口令返回 401 并回显通用错误', async () => {
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
      body: new URLSearchParams({ username: 'web_login2', password: 'password123' }).toString(),
    });
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
      body: new URLSearchParams({ username: 'web_login2', password: 'wrongpass' }).toString(),
    });
    const html = await res.text();
    expect(res.status).toBe(401);
    expect(html).toContain('用户名或密码错误');
  });

  it('POST /register 跨站 Origin 被拒（403）', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example.com' },
      body: new URLSearchParams({ username: 'xss_u', password: 'password123' }).toString(),
    });
    expect(res.status).toBe(403);
  });
});
