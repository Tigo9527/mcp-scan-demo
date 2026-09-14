/**
 * Admin 管理端测试：登录鉴权、用户列表/详情、GitHub 设置在线修改、统计接口。
 *
 * 注意 vitest 按测试文件隔离模块注册表，所以本文件里的 store / settings / stats
 * 全局状态与其它测试文件互不干扰。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { configure } from '../src/db.js';
import * as store from '../src/auth/store.js';
import { __resetForTest as resetSettings, getGithub } from '../src/settings.js';

const ADMIN_TOKEN = 'test-admin-token-xyz';

let server: Server;
let base: string;

async function registerAndGetToken(username: string): Promise<string> {
  const res = await fetch(`${base}/register?username=${username}`);
  const html = await res.text();
  const m = html.match(/mcp_demo_[A-Za-z0-9._-]+/);
  return m ? m[0] : '';
}

async function findUser(username: string) {
  const { items } = store.listUsers({ query: username });
  return items.find((u) => u.username === username);
}

function form(data: Record<string, string>) {
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString(),
    redirect: 'manual' as const,
  };
}

beforeAll(async () => {
  // 关闭落盘，避免写入 data/ 目录
  configure({ enabled: false });
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

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

beforeEach(() => {
  resetSettings();
});

describe('admin 鉴权', () => {
  it('未携带令牌访问 /admin 返回 401 并显示登录页', async () => {
    const res = await fetch(`${base}/admin`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('Admin 管理端登录');
  });

  it('错误的 admin 令牌返回 401', async () => {
    const res = await fetch(`${base}/admin?admin_token=wrong-token`, { redirect: 'manual' });
    expect(res.status).toBe(401);
  });

  it('查询参数携带正确令牌可进入仪表盘', async () => {
    const res = await fetch(`${base}/admin?admin_token=${ADMIN_TOKEN}`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('仪表盘');
    expect(html).toContain('工具调用 Top 10');
  });

  it('每个 Admin 页面顶部都有常驻子导航（入口不再埋在页面底部）', async () => {
    const pages = ['/admin', '/admin/users', '/admin/settings', '/admin/recharge-settings', '/admin/recharge'];
    for (const p of pages) {
      const res = await fetch(`${base}${p}?admin_token=${ADMIN_TOKEN}`, { redirect: 'manual' });
      expect(res.status, p).toBe(200);
      const html = await res.text();
      expect(html, p).toContain('class="subnav"');
      // 关键：子导航必须排在正文之前，否则又变成「要滚到底才看得见」
      expect(html.indexOf('class="subnav"'), p).toBeLessThan(html.indexOf('<h1>'));
      for (const label of ['仪表盘', '用户管理', 'GitHub 设置', '充值设置', '充值记录']) {
        expect(html, `${p} 缺少 ${label}`).toContain(`>${label}</a>`);
      }
      // 当前页签要高亮
      expect(html, p).toContain('class="active"');
    }
  });

  it('X-Admin-Token 请求头可用', async () => {
    const res = await fetch(`${base}/admin`, {
      headers: { 'X-Admin-Token': ADMIN_TOKEN },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
  });

  it('登录页 POST 正确令牌后下发 Cookie 并跳转', async () => {
    const res = await fetch(`${base}/admin/login`, form({ token: ADMIN_TOKEN }));
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('mcp_admin=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(res.headers.get('location') ?? '').toContain('/admin');
  });

  it('登录页 POST 错误令牌返回 401', async () => {
    const res = await fetch(`${base}/admin/login`, form({ token: 'nope' }));
    expect(res.status).toBe(401);
  });

  it('登录成功后用 Cookie 也能访问（模拟网关透传 Cookie 的情况）', async () => {
    const login = await fetch(`${base}/admin/login`, form({ token: ADMIN_TOKEN }));
    const raw = login.headers.get('set-cookie') ?? '';
    const cookie = raw.split(';')[0];
    const res = await fetch(`${base}/admin`, { headers: { Cookie: cookie }, redirect: 'manual' });
    expect(res.status).toBe(200);
  });
});

describe('admin 用户管理', () => {
  it('用户列表能看到新注册的用户', async () => {
    await registerAndGetToken('admin_list_user');
    const res = await fetch(`${base}/admin/users?admin_token=${ADMIN_TOKEN}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('admin_list_user');
  });

  it('搜索能过滤用户', async () => {
    await registerAndGetToken('searchable_user');
    const res = await fetch(
      `${base}/admin/users?admin_token=${ADMIN_TOKEN}&q=searchable_user`,
      { redirect: 'manual' },
    );
    const html = await res.text();
    expect(html).toContain('searchable_user');
    expect(html).not.toContain('admin_list_user');
  });

  it('用户详情页展示该用户资料', async () => {
    await registerAndGetToken('detail_user');
    const user = await findUser('detail_user');
    expect(user).toBeTruthy();
    const res = await fetch(
      `${base}/admin/users/${user!.id}?admin_token=${ADMIN_TOKEN}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('detail_user');
    expect(html).toContain('调用统计');
  });

  it('不存在的用户返回 404', async () => {
    const res = await fetch(
      `${base}/admin/users/does-not-exist?admin_token=${ADMIN_TOKEN}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(404);
  });

  it('可以为用户签发新令牌', async () => {
    await registerAndGetToken('issue_user');
    const user = await findUser('issue_user');
    const res = await fetch(
      `${base}/admin/users/${user!.id}/token?admin_token=${ADMIN_TOKEN}`,
      form({}),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('mcp_demo_');
  });

  it('删除用户后列表中不再出现', async () => {
    await registerAndGetToken('doomed_user');
    const user = await findUser('doomed_user');
    expect(user).toBeTruthy();
    const res = await fetch(
      `${base}/admin/users/${user!.id}/delete?admin_token=${ADMIN_TOKEN}`,
      form({}),
    );
    expect(res.status).toBe(302);
    expect(await findUser('doomed_user')).toBeUndefined();
  });
});

describe('admin GitHub 设置', () => {
  it('保存后 isGitHubConfigured 立即为真（无需重启）', async () => {
    expect(getGithub().configured).toBe(false);

    await fetch(`${base}/admin/settings?admin_token=${ADMIN_TOKEN}`, {
      ...form({
        clientId: 'Iv1.testclientid',
        clientSecret: 'test-secret-value',
        redirectUri: 'http://localhost:3000/auth/github/callback',
        scope: 'read:user',
      }),
      redirect: 'manual',
    });

    const gh = getGithub();
    expect(gh.configured).toBe(true);
    expect(gh.clientId).toBe('Iv1.testclientid');
    expect(gh.clientSecret).toBe('test-secret-value');
    expect(gh.source).toBe('admin');
    expect(gh.scope).toBe('read:user');
  });

  it('Secret 留空且未勾选清空时保持不变', async () => {
    await fetch(`${base}/admin/settings?admin_token=${ADMIN_TOKEN}`, {
      ...form({ clientId: 'id-1', clientSecret: 'secret-1' }),
      redirect: 'manual',
    });
    expect(getGithub().clientSecret).toBe('secret-1');

    await fetch(`${base}/admin/settings?admin_token=${ADMIN_TOKEN}`, {
      ...form({ clientId: 'id-2', clientSecret: '' }),
      redirect: 'manual',
    });
    expect(getGithub().clientId).toBe('id-2');
    expect(getGithub().clientSecret).toBe('secret-1');
  });

  it('勾选 clearSecret 会清空 Secret', async () => {
    await fetch(`${base}/admin/settings?admin_token=${ADMIN_TOKEN}`, {
      ...form({ clientId: 'id-3', clientSecret: 'secret-3' }),
      redirect: 'manual',
    });
    expect(getGithub().configured).toBe(true);

    await fetch(`${base}/admin/settings?admin_token=${ADMIN_TOKEN}`, {
      ...form({ clientId: 'id-3', clientSecret: '', clearSecret: '1' }),
      redirect: 'manual',
    });
    expect(getGithub().clientSecret).toBe('');
    expect(getGithub().configured).toBe(false);
  });

  it('恢复默认值会丢弃 admin 覆盖', async () => {
    await fetch(`${base}/admin/settings?admin_token=${ADMIN_TOKEN}`, {
      ...form({ clientId: 'to-be-reset', clientSecret: 's' }),
      redirect: 'manual',
    });
    expect(getGithub().clientId).toBe('to-be-reset');

    await fetch(`${base}/admin/settings/reset?admin_token=${ADMIN_TOKEN}`, form({}));
    expect(getGithub().source).toBe('env');
  });
});

describe('admin 统计接口', () => {
  it('/admin/api/stats 返回结构化统计', async () => {
    const res = await fetch(`${base}/admin/api/stats?admin_token=${ADMIN_TOKEN}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.counters).toBeDefined();
    expect(typeof json.counters.requests).toBe('number');
    expect(typeof json.counters.toolCalls).toBe('number');
    expect(json.byTool).toBeDefined();
    expect(json.byUser).toBeDefined();
  });
});
