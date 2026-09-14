/**
 * 登录态保持（会话 Cookie）测试。
 *
 * 背景：页面早先只认 `?token=` / `X-Authorization`，于是「登录一次、长期保持」不成立，
 * 用户每次进 /profile、/recharge 都得自己往 URL 后面粘令牌，令牌还会漏进浏览器历史。
 * 现在登录成功后下发 HttpOnly Cookie，页面侧自动携带。
 *
 * 重点断言：
 * 1. 一键注册 / 账号密码登录都会下发会话 Cookie；
 * 2. 不带任何参数再进 /recharge、/profile 仍是登录态（不再要求挂 ?token=）；
 * 3. /mcp 端点**不认** Cookie（防 CSRF），必须显式带令牌；
 * 4. /logout 清除 Cookie，之后再进页面回到未登录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { configure } from '../src/db.js';

let server: Server;
let base: string;

/** 从 Set-Cookie 里取出用户会话 Cookie 的值 */
function userCookieFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  const part = raw
    .split(/,(?=\s*[A-Za-z_][A-Za-z0-9_]*=)/)
    .map((s) => s.trim())
    .find((s) => s.startsWith('mcp_demo_user='));
  if (!part) return '';
  return part.split(';')[0].slice('mcp_demo_user='.length);
}

beforeAll(async () => {
  configure({ enabled: false });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('会话 Cookie：登录态自动保持', () => {
  it('一键注册会下发 HttpOnly Cookie，且 Cookie 里就是令牌', async () => {
    const res = await fetch(`${base}/register?username=cookie_user_1`);
    const html = await res.text();
    const token = html.match(/mcp_demo_[A-Za-z0-9._-]+/)?.[0] ?? '';
    expect(token).toBeTruthy();

    const cookieVal = userCookieFrom(res);
    expect(cookieVal).toBe(token);

    const sc = (res.headers.get('set-cookie') ?? '').toLowerCase();
    expect(sc).toContain('httponly');
    expect(sc).toContain('samesite=lax');
    expect(sc).toContain('path=/');
    // 明文 http 环境不该带 Secure，否则本地开发直接登录失效
    expect(sc).not.toContain('secure');
  });

  it('携带 Cookie 直接访问 /recharge 无需 ?token= 参数', async () => {
    const reg = await fetch(`${base}/register?username=cookie_user_2`);
    const cookieVal = userCookieFrom(reg);
    expect(cookieVal).toBeTruthy();

    // 对照：不带 Cookie 时必须提示先登录
    const anon = await fetch(`${base}/recharge`);
    expect(await anon.text()).toContain('请先登录后再充值');

    // 关键：URL 上不带任何令牌，只靠 Cookie
    const res = await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookieVal}` } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('请先登录后再充值');
  });

  it('携带 Cookie 直接访问 /profile 无需 ?token= 参数', async () => {
    const reg = await fetch(`${base}/register?username=cookie_user_3`);
    const cookieVal = userCookieFrom(reg);

    const res = await fetch(`${base}/profile`, { headers: { Cookie: `mcp_demo_user=${cookieVal}` } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('cookie_user_3');
    expect(html).not.toContain('你还没登录');
  });

  it('账号密码登录同样下发 Cookie', async () => {
    const username = 'cookie_pwd_user';
    // 必须用 POST 注册才会设置密码（GET ?username= 是一键注册，不带密码）
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password: 'pwd123456' }).toString(),
    });

    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password: 'pwd123456' }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    expect(userCookieFrom(res)).toMatch(/^mcp_demo_/);
  });

  it('/mcp 端点不认 Cookie（防 CSRF），只带 Cookie 会被要求鉴权', async () => {
    const reg = await fetch(`${base}/register?username=cookie_user_4`);
    const cookieVal = userCookieFrom(reg);
    expect(cookieVal).toMatch(/^mcp_demo_/);

    // MCP 客户端只用 Authorization 头，这里刻意只带 Cookie
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Cookie: `mcp_demo_user=${cookieVal}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'vitest-client', version: '1.0.0' },
        },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('/mcp 端点显式带令牌仍然正常（Cookie 不该影响 MCP 鉴权）', async () => {
    const reg = await fetch(`${base}/register?username=cookie_user_5`);
    const token = userCookieFrom(reg);
    expect(token).toMatch(/^mcp_demo_/);

    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'vitest-client', version: '1.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('/logout 清除 Cookie，之后访问页面回到未登录', async () => {
    const reg = await fetch(`${base}/register?username=cookie_user_6`);
    const cookieVal = userCookieFrom(reg);

    const out = await fetch(`${base}/logout`, { headers: { Cookie: `mcp_demo_user=${cookieVal}` } });
    const sc = out.headers.get('set-cookie') ?? '';
    expect(sc).toContain('mcp_demo_user=');
    expect(sc).toMatch(/Max-Age=0/i);

    // 清 Cookie 后再访问（模拟浏览器已删除），应提示去登录
    const res = await fetch(`${base}/profile`);
    const html = await res.text();
    expect(html).toContain('你还没登录');
  });

  it('已有会话 Cookie 时，URL 上的令牌不会顶掉登录态（管理员跳转场景）', async () => {
    // 管理员自己先登录
    const mine = await fetch(`${base}/register?username=cookie_admin`);
    const myCookie = userCookieFrom(mine);

    // 管理员去给别的用户签令牌（这里直接再注册一个用户拿令牌，等价）
    const other = await fetch(`${base}/register?username=cookie_target`);
    const otherToken = (await other.text()).match(/mcp_demo_[A-Za-z0-9._-]+/)?.[0] ?? '';
    expect(otherToken).toBeTruthy();

    // 管理员带自己的 Cookie 去访问「以该用户身份打开」的链接
    const res = await fetch(`${base}/profile?token=${otherToken}`, {
      headers: { Cookie: `mcp_demo_user=${myCookie}` },
    });
    // 已存在 Cookie，不该再下发新的（否则管理员自己的登录态就被冲掉了）
    expect(res.headers.get('set-cookie')).toBeNull();
    // 且看到的仍是目标用户（URL 令牌优先级更高）
    const html = await res.text();
    expect(html).toContain('cookie_target');
  });

  it('伪造/失效的 Cookie 不会当成登录态', async () => {
    const res = await fetch(`${base}/profile`, {
      headers: { Cookie: 'mcp_demo_user=mcp_demo_forged.token.sig' },
    });
    const html = await res.text();
    expect(html).toContain('你还没登录');
    expect(html).not.toContain('我的调用统计');
  });
});
