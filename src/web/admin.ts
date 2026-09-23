/**
 * Admin 管理端。
 *
 * 鉴权：独立 admin 令牌（env `ADMIN_TOKEN`）。两通道接受，任意一条命中即可：
 *   1. Cookie `mcp_admin`（登录页下发，HttpOnly + SameSite=Lax，UI 主用）
 *   2. `X-Admin-Token` 请求头（脚本 / 自动化，不进 URL 无泄漏）
 * 登录态一律靠 Cookie 保持，UI 任何链接都不再把令牌拼进 URL（否则会漏进地址栏 / 历史 /
 * 截图 / Referer / 平台日志）。`Authorization` 头会被网关改写，**绝不能**用它传 admin 令牌。
 * admin 与 user 用不同 Cookie 名（`mcp_admin` vs `mcp_demo_user`），单浏览器可同时登录两者。
 *
 * 安全：
 * - 使用默认令牌且非本地环境 → 503（防止忘记注入 ADMIN_TOKEN 就把管理端裸奔在公网）
 * - 登录失败限流（同 IP 10 次 / 10 分钟）
 * - 所有副作用操作一律 POST（`SameSite=Lax` 会放行顶层 GET 导航，写成链接等于裸奔）
 * - 响应统一带 `Referrer-Policy: no-referrer`（防御纵深；admin 令牌已不进 URL，主要是护住表单里的其它查询参数）
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config, getAdminToken, isLocalBaseUrl, isUsingDefaultAdminToken } from '../config.js';
import * as store from '../auth/store.js';
import * as authManager from '../auth/manager.js';
import { getGithub, getRaw, resetGithub, setGithub } from '../settings.js';
import { getStatsSnapshot } from '../stats.js';
import * as billing from '../billing.js';
import * as recharge from '../recharge.js';
import { persistStatus } from '../db.js';
import { deriveBase, originOk, readCookie, requestOrigin, requireSameOrigin, wrap } from './http.js';
import {
  adminHref,
  badge,
  bar,
  card,
  esc,
  fmtTime,
  notice,
  page,
  statCard,
  table,
} from './layout.js';

const COOKIE_NAME = 'mcp_admin';
const COOKIE_MAX_AGE = 28_800; // 8 小时
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

// ---------- 鉴权 ----------

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 请求里携带的 admin 令牌（两通道：Cookie / X-Admin-Token 头），未携带返回 undefined */
export function resolveAdminToken(req: Request): string | undefined {
  const candidates: unknown[] = [
    readCookie(req, COOKIE_NAME),
    req.headers['x-admin-token'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return undefined;
}

/** 是否使用了不安全的内置默认令牌，且当前不是本地环境 */
function blockedByDefaultToken(req: Request): boolean {
  if (!isUsingDefaultAdminToken()) return false;
  // 本地开发放行；公网（publicBaseUrl 非 localhost）一律拒绝
  if (isLocalBaseUrl()) return false;
  const presented = resolveAdminToken(req);
  return presented === undefined || safeEqual(presented, getAdminToken());
}

const failures = new Map<string, { count: number; firstAt: number }>();

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function isLocked(key: string): boolean {
  const rec = failures.get(key);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > FAILURE_WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return rec.count >= MAX_FAILURES;
}

function noteFailure(key: string): void {
  const rec = failures.get(key);
  if (!rec || Date.now() - rec.firstAt > FAILURE_WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: Date.now() });
  } else {
    rec.count += 1;
  }
  // 简单防膨胀
  if (failures.size > 1000) {
    for (const [k, v] of failures) {
      if (Date.now() - v.firstAt > FAILURE_WINDOW_MS) failures.delete(k);
    }
  }
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (blockedByDefaultToken(req)) {
    res
      .status(503)
      .type('html')
      .send(
        page({
          title: 'Admin 未启用',
          body: `<h1>Admin 管理端未启用</h1>${notice(
            '当前使用的是**内置默认管理员令牌**，且服务对外地址不是本地地址，已禁用管理端以防被公网直接访问。<br><br>请通过启动参数注入真实令牌，例如：<br><code>ADMIN_TOKEN=&lt;your-token&gt; npm start</code><br>（部署到发布平台时用 <code>--start-cmd "PUBLIC_BASE_URL=... ADMIN_TOKEN=... npm start"</code> 注入）',
          )}`,
        }),
      );
    return;
  }

  const presented = resolveAdminToken(req);
  if (presented && safeEqual(presented, getAdminToken())) {
    next();
    return;
  }
  res.status(401).type('html').send(loginHtml(deriveBase(req), '令牌无效或缺失，请重新登录。'));
}

/** 跨域表单防护见 http.ts 的 originOk / requireSameOrigin（与 register/login 共用） */

/**
 * 被判定为跨站时的提示。把实际收到的 Origin 回显出来（它来自请求本身，不是秘密），
 * 便于排查「明明在本站提交却被拒」这类配置问题（例如 PUBLIC_BASE_URL 与实际访问域名不一致）。
 */
function getRejectedOriginMessage(req: Request): string {
  return `跨站请求已被拒绝。当前请求携带的 Origin 为 ${requestOrigin(req)}，与本站对外地址不一致。<br>请确认你是通过本站页面提交表单；若 PUBLIC_BASE_URL 与实际访问域名不符，请修正后重启。`;
}

function setAdminCookie(req: Request, res: Response, token: string): void {
  const secure =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    config.publicBaseUrl.startsWith('https://');
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  // 注意：不能用 req.headers.host 判断是否 https —— 平台网关转发的是内部域名
  if (secure) parts.push('Secure');
  res.appendHeader('Set-Cookie', parts.join('; '));
}

// ---------- 页面 ----------

function loginHtml(base: string, error?: string): string {
  return page({
    title: 'Admin 登录',
    base,
    active: 'admin',
    body: `
<h1>Admin 管理端登录</h1>
${error ? notice(esc(error)) : ''}
${card(`
<form method="post" action="${esc(base)}/admin/login">
<label for="token">管理员令牌</label>
<input id="token" name="token" type="password" autocomplete="current-password" placeholder="ADMIN_TOKEN" required>
<p class="muted">令牌由环境变量 <code>ADMIN_TOKEN</code> 配置。连续 10 次失败会锁定 10 分钟。</p>
<button class="btn" type="submit">登录</button>
</form>
`)}
<p class="muted">也可以用请求头 <code>X-Admin-Token</code> 直接访问管理端接口（脚本 / 自动化常用）。</p>
<p><a href="${esc(base)}/">← 返回首页</a></p>
`,
  });
}

function dashboardHtml(base: string, adminToken: string): string {
  const s = getStatsSnapshot();
  const users = store.listUsers();
  const gh = getGithub();
  const ps = persistStatus();
  const b = billing.getTotalBilling();
  const rc = recharge.getRechargeStats();

  const topTools = Object.entries(s.byTool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const maxTool = Math.max(1, ...topTools.map(([, n]) => n));

  const topUsers = Object.entries(s.byUser)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 10);
  const maxUser = Math.max(1, ...topUsers.map(([, v]) => v.calls));

  const recent = [...s.recent].reverse().slice(0, 20);

  const dayRows = Object.entries(s.byDay)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 14)
    .map(([d, v]) => [
      esc(d),
      String(v.requests),
      String(v.toolCalls),
      String(v.anonymous),
      bar(v.toolCalls, Math.max(1, ...Object.values(s.byDay).map((x) => x.toolCalls))),
    ]);

  return page({
    title: 'Admin · 仪表盘',
    base,
    active: 'admin',
    adminToken,
    body: `
<h1>仪表盘</h1>

<h2>总计</h2>
<div class="grid">
${statCard(s.counters.requests, '请求总数', '带 id 的 JSON-RPC 请求')}
${statCard(s.counters.toolCalls, '工具调用次数', '仅 tools/call')}
${statCard(s.counters.errors, '错误响应数')}
${statCard(users.total, '用户数')}
${statCard(Object.keys(s.byUser).length, '活跃调用方', '含匿名桶')}
${statCard(b.used, '总计费点数', `所有用户累计消耗；匿名 ${b.anonymousUsed}`)}
${statCard(b.rechargedTotal, '总充值点数', `累计充值入账；共 ${rc.count} 笔`)}
</div>
<p class="muted">统计起点 ${esc(fmtTime(s.since))} · 落盘 ${ps.enabled ? `已启用（${esc(ps.db)} · ${esc(ps.storage)}）` : '已关闭'}${ps.lastError ? ` · <span style="color:var(--err)">最近错误：${esc(ps.lastError)}</span>` : ''}</p>

<h2>系统信息</h2>
${table(
  ['项', '值'],
  [
    ['instanceId', `<code>${esc(config.instanceId)}</code>`],
    ['进程启动时间', esc(fmtTime(config.startedAt))],
    ['对外地址', `<code>${esc(config.publicBaseUrl)}</code>`],
    ['GitHub OAuth', badge(gh.configured ? '已配置' : '未配置', gh.configured ? 'ok' : 'warn')],
    ['GitHub 配置来源', badge(gh.source === 'admin' ? 'Admin 后台覆盖' : '环境变量', gh.source === 'admin' ? 'ok' : '')],
    ['Admin 令牌', badge(isUsingDefaultAdminToken() ? '默认（不安全）' : '已注入', isUsingDefaultAdminToken() ? 'err' : 'ok')],
    ['数据落盘', badge(ps.enabled ? (ps.writable ? '正常' : '不可写') : '已关闭', ps.enabled && ps.writable ? 'ok' : 'warn')],
  ],
)}

<h2>工具调用 Top 10</h2>
${topTools.length === 0 ? '<div class="empty">暂无工具调用记录。</div>' : table(['工具', '次数', ''], topTools.map(([name, n]) => [esc(name), String(n), bar(n, maxTool)]))}

<h2>调用方 Top 10</h2>
${topUsers.length === 0 ? '<div class="empty">暂无记录。</div>' : table(['调用方', '请求数', '工具调用', ''], topUsers.map(([key, v]) => {
    const toolSum = Object.values(v.tools).reduce((a, b) => a + b, 0);
    const label = v.userId
      ? `<a href="${esc(adminHref(`/admin/users/${encodeURIComponent(v.userId)}`, adminToken))}">${esc(v.username)}</a>`
      : `<span class="muted">${esc(v.username)}（匿名）</span>`;
    return [label, String(v.calls), String(toolSum), bar(v.calls, maxUser)];
  }))}

<h2>计费明细</h2>
${b.byUser.length === 0 ? '<div class="empty">暂无计费记录。</div>' : table(['用户', '已消耗', '余额', ''], b.byUser.slice(0, 15).map((r) => {
    const bar2 = bar(r.used, Math.max(1, ...b.byUser.map((x) => x.used)));
    const label = r.userId
      ? `<a href="${esc(adminHref(`/admin/users/${encodeURIComponent(r.userId)}`, adminToken))}">${esc(r.username)}</a>`
      : `<span class="muted">${esc(r.username)}</span>`;
    return [label, String(r.used), r.userId ? String(r.balance) : '<span class="muted">—</span>', bar2];
  }))}
<p class="muted">余额 = 赠送额度（${esc(String(config.billingFreeCredits))}）- 已消耗；硬计费开启时余额耗尽将拒绝执行收费工具。匿名用户无余额概念（按调用计费须先登录），其消耗计入总计但不计入用户余额。</p>

<h2>最近 14 天趋势</h2>
${dayRows.length === 0 ? '<div class="empty">暂无记录。</div>' : table(['日期', '请求数', '工具调用', '匿名', ''], dayRows)}

<h2>最近调用</h2>
${recent.length === 0 ? '<div class="empty">暂无记录。</div>' : table(['时间', '方法', '工具', '调用方'], recent.map((c) => [
    esc(fmtTime(c.ts)),
    `<code>${esc(c.method)}</code>`,
    c.tool ? `<code>${esc(c.tool)}</code>` : '—',
    c.userId ? esc(c.username) : '<span class="muted">匿名</span>',
  ]))}
`,
    adminTab: 'dashboard',
  });
}

function usersHtml(base: string, adminToken: string, query: string): string {
  const { items, total } = store.listUsers({ query });
  const dupes = store.duplicatedUsernames();
  const s = getStatsSnapshot();

  const rows = items.map((u) => {
    const stat = s.byUser[u.id];
    const toolSum = stat ? Object.values(stat.tools).reduce((a, b) => a + b, 0) : 0;
    const dup = dupes.has(u.username.toLowerCase());
    return [
      `${esc(u.username)}${dup ? ' ' + badge('重名', 'warn') : ''}`,
      esc(u.email ?? '—'),
      badge(u.provider),
      esc(u.githubLogin ?? '—'),
      esc(fmtTime(u.createdAt)),
      esc(fmtTime(u.lastSeenAt)),
      `${stat?.calls ?? 0} / ${toolSum}`,
      `<a class="btn small" href="${esc(adminHref(`/admin/users/${encodeURIComponent(u.id)}`, adminToken))}">详情</a>`,
    ];
  });

  const shown = items.length;

  return page({
    title: 'Admin · 用户',
    base,
    active: 'admin',
    adminToken,
    body: `
<h1>用户管理</h1>

<form method="get" action="${esc(base)}/admin/users" class="row" style="margin:12px 0">
<input name="q" value="${esc(query)}" placeholder="按用户名 / 邮箱 / GitHub / ID 搜索" style="max-width:320px">
<button class="btn" type="submit">搜索</button>
<a class="btn small alt" href="${esc(adminHref('/admin/users', adminToken))}">重置</a>
</form>

<p class="muted">共 ${total} 个用户${shown < total ? `（显示前 ${shown} 条）` : ''} ·「请求数 / 工具调用」列为该用户的累计统计</p>
${table(['用户名', '邮箱', '来源', 'GitHub', '注册时间', '最近活跃', '请求/工具', '操作'], rows)}
`,
    adminTab: 'users',
  });
}

function userDetailHtml(
  base: string,
  adminToken: string,
  user: store.User,
  issued?: { token: string; note?: string },
): string {
  const s = getStatsSnapshot();
  const bill = billing.getUserBilling(user.id);
  const stat = s.byUser[user.id];
  const tools = stat?.tools ?? {};
  const toolSum = Object.values(tools).reduce((a: number, b: number) => a + b, 0);
  const maxTool = Math.max(1, ...Object.values(tools));

  const infoRows: string[][] = [
    ['用户 ID', `<code>${esc(user.id)}</code>`],
    ['用户名', esc(user.username)],
    ['邮箱', esc(user.email ?? '—')],
    ['来源', badge(user.provider)],
    ['GitHub', user.githubLogin ? `@${esc(user.githubLogin)}` : '—'],
    ['注册时间', esc(fmtTime(user.createdAt))],
    ['最近活跃', esc(fmtTime(user.lastSeenAt))],
  ];

  return page({
    title: `Admin · ${user.username}`,
    base,
    active: 'admin',
    adminToken,
    body: `
<h1>用户详情</h1>

<h2>基本信息</h2>
${table(['字段', '值'], infoRows)}

<h2>调用统计</h2>
<div class="grid">
${statCard(stat?.calls ?? 0, '请求总数')}
${statCard(toolSum, '工具调用次数')}
${statCard(Object.keys(tools).length, '使用过的工具数')}
</div>
${Object.keys(tools).length > 0 ? table(['工具', '次数', ''], Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([n, c]) => [esc(n), String(c), bar(c, maxTool)])) : '<div class="empty">该用户暂无调用记录。</div>'}
<p class="muted">首次记录 ${esc(fmtTime(stat?.firstSeenAt))} · 最近记录 ${esc(fmtTime(stat?.lastSeenAt))}</p>

<h2>计费</h2>
<div class="grid">
${statCard(bill?.balance ?? config.billingFreeCredits, '剩余额度')}
${statCard(bill?.used ?? 0, '已消耗点数')}
</div>
<p class="muted">余额 = 赠送额度（${esc(String(config.billingFreeCredits))}）- 已消耗。硬计费开启时余额耗尽将拒绝执行收费工具。</p>

<h2>签发新令牌</h2>
${card(`
<p>为该用户签发一枚新的访问令牌（JWT，有效期 7 天）。令牌内嵌用户身份，服务端无需保存会话。</p>
${
  issued
    ? `<div style="margin:10px 0"><b>新令牌：</b><br><code>${esc(issued.token)}</code></div>
<p class="muted">请立即复制保存，此页面刷新后不再显示${issued.note ? `。${esc(issued.note)}` : ''}。</p>
<!-- 这里必须带 ?token=：管理员浏览器里只有自己的会话 Cookie，不拼令牌看到的还是自己。
     /profile 只在「尚无 Cookie」时才把 URL 令牌写进 Cookie，所以不会顶掉管理员自己的登录态。 -->
<div class="row"><a class="btn small" href="${esc(base)}/profile?token=${encodeURIComponent(issued.token)}">以该用户身份打开 Profile</a></div>`
    : ''
}
<form method="post" action="${esc(adminHref(`/admin/users/${encodeURIComponent(user.id)}/token`, adminToken))}">
<button class="btn" type="submit">签发新令牌</button>
</form>
`)}

<h2>危险操作</h2>
${card(`
<p class="muted">删除后该用户需重新注册；历史调用统计不受影响。</p>
<form method="post" action="${esc(adminHref(`/admin/users/${encodeURIComponent(user.id)}/delete`, adminToken))}" onsubmit="return confirm('确认删除用户 ${esc(user.username)}？');">
<button class="btn danger" type="submit">删除该用户</button>
</form>
`)}

`,
    adminTab: 'users',
  });
}

function settingsHtml(base: string, adminToken: string, saved?: boolean, error?: string): string {
  const gh = getGithub();
  const raw = getRaw();

  return page({
    title: 'Admin · GitHub 设置',
    base,
    active: 'admin',
    adminToken,
    body: `
<h1>GitHub OAuth 设置</h1>
${saved ? notice('已保存，立即生效（无需重启）。') : ''}
${error ? notice(esc(error)) : ''}

${card(`
<h3>当前生效值</h3>
${table(
  ['项', '值', '来源'],
  [
    ['Client ID', gh.clientId ? `<code>${esc(gh.clientId)}</code>` : '<span class="muted">未配置</span>', badge(gh.source === 'admin' ? 'Admin' : 'env', gh.source === 'admin' ? 'ok' : '')],
    ['Client Secret', gh.clientSecret ? badge('已配置（不展示）', 'ok') : '<span class="muted">未配置</span>', badge(gh.source === 'admin' ? 'Admin' : 'env', gh.source === 'admin' ? 'ok' : '')],
    ['回调地址', `<code>${esc(gh.redirectUri)}</code>`, ''],
    ['Scope', `<code>${esc(gh.scope)}</code>`, ''],
  ],
)}
<p class="muted">GitHub OAuth App 的回调地址需填写：<code>${esc(gh.redirectUri)}</code></p>
`)}

<h2>修改</h2>
${card(`
<form method="post" action="${esc(adminHref('/admin/settings', adminToken))}">
<label for="clientId">Client ID</label>
<input id="clientId" name="clientId" value="${esc(gh.clientId)}" placeholder="留空表示清空并禁用">

<label for="clientSecret">Client Secret</label>
<input id="clientSecret" name="clientSecret" type="password" autocomplete="new-password" placeholder="留空表示不修改">
<p class="muted">出于安全考虑不回显已保存的 Secret。填新值即覆盖；留空保持不变。</p>
<label class="row" style="font-weight:400"><input type="checkbox" name="clearSecret" value="1" style="width:auto;margin-right:6px"> 清空已保存的 Secret</label>

<label for="redirectUri">回调地址 Redirect URI</label>
<input id="redirectUri" name="redirectUri" value="${esc(gh.redirectUri)}">

<label for="scope">Scope</label>
<input id="scope" name="scope" value="${esc(gh.scope)}">

<p class="muted">最近更新：${esc(fmtTime(raw.updatedAt))}${raw.updatedBy ? ` 由 ${esc(raw.updatedBy)}` : ''}</p>
<button class="btn" type="submit">保存</button>
</form>
`)}

<h2>恢复默认值</h2>
${card(`
<p class="muted">丢弃 Admin 后台的覆盖值，回退到环境变量（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 等）。</p>
<form method="post" action="${esc(adminHref('/admin/settings/reset', adminToken))}">
<button class="btn danger" type="submit">恢复为环境变量默认值</button>
</form>
`)}

`,
    adminTab: 'github',
  });
}

/** 链 ID 的展示文本：已知链给中文名，未知链退化成 `Chain <十进制>`。 */
function chainDisplayName(chainId: string): string {
  return recharge.chainName(chainId) ?? `Chain ${recharge.chainIdToDecimal(chainId)}`;
}

function rechargeSettingsHtml(
  base: string,
  adminToken: string,
  opts: {
    saved?: boolean;
    error?: string;
    warning?: string;
    message?: string;
    form?: {
      recipient: string;
      rpcUrl: string;
      tokenAddress: string;
      tokenName: string;
      tokenSymbol: string;
      tokenDecimals: string;
      rate: string;
      chainId: string;
    };
  } = {},
): string {
  const cfg = recharge.getRechargeConfig();
  const c = cfg ?? { recipient: '', rpcUrl: '', rate: 0, tokenAddress: '', chainId: '' };
  const form = opts.form ?? {
    recipient: c.recipient,
    rpcUrl: c.rpcUrl,
    tokenAddress: c.tokenAddress,
    tokenName: c.tokenName ?? '',
    tokenSymbol: c.tokenSymbol ?? '',
    tokenDecimals: c.tokenDecimals === undefined ? '' : String(c.tokenDecimals),
    rate: c.rate ? String(c.rate) : '',
    chainId: c.chainId,
  };
  const isToken = Boolean(c.tokenAddress);
  /** decimals 缺失 = 入账会被拒绝，必须让管理员一眼看见 */
  const metaMissing = isToken && c.tokenDecimals === undefined;
  const metaCell = !isToken
    ? '<span class="muted">—</span>'
    : metaMissing
      ? '<b style="color:var(--err)">未获取（缺少 decimals，入账会被拒绝）</b>'
      : `${esc(c.tokenName || '—')}（${esc(c.tokenSymbol || '—')}）· decimals ${esc(String(c.tokenDecimals))}`;

  return page({
    title: 'Admin · 充值设置',
    base,
    active: 'admin',
    adminToken,
    body: `
<h1>充值设置（Crypto → 点数）</h1>
${opts.error ? notice(esc(opts.error), 'err') : ''}
${opts.warning ? notice(esc(opts.warning)) : ''}
${opts.message ? notice(esc(opts.message), 'ok') : ''}
${opts.saved ? notice('已保存，立即生效（无需重启）。', 'ok') : ''}

${card(`
<h3>当前生效配置</h3>
${table(
  ['项', '值'],
  [
    ['收款地址', c.recipient ? `<code>${esc(c.recipient)}</code>` : '<span class="muted">未配置</span>'],
    ['RPC', c.rpcUrl ? `<code>${esc(c.rpcUrl)}</code>` : '<span class="muted">未配置</span>'],
    ['收取资产', isToken ? `ERC20 <code>${esc(c.tokenAddress)}</code>` : badge('原生币', '')],
    ['代币元数据', metaCell],
    ['汇率', c.rate ? `1 ${esc(isToken ? (c.tokenSymbol || '代币') : 'ETH')} = ${esc(String(c.rate))} 点` : '<span class="muted">未配置</span>'],
    [
      '链 / 网络',
      c.chainId
        ? `${esc(chainDisplayName(c.chainId))} · <code>${esc(recharge.normalizeChainId(c.chainId))}</code>（${esc(recharge.chainIdToDecimal(c.chainId))}）`
        : '<span class="muted">未指定（用户转账前不会强制切换网络）</span>',
    ],
  ],
)}
<p class="muted">最近更新：${esc(fmtTime(c.updatedAt))}${c.updatedBy ? ` 由 ${esc(c.updatedBy)}` : ''}</p>
${isToken ? `
<form method="post" action="${esc(adminHref('/admin/recharge-settings/refresh-meta', adminToken))}" style="margin-top:10px">
<button class="btn small alt" type="submit">重新读取元数据</button>
<span class="muted">RPC 恢复 / 换过 RPC 后点这里重读 name / symbol / decimals，不用重填表单。</span>
</form>` : ''}
${isToken && c.tokenMetaError ? `<p class="muted">上次自动读取失败原因：<b>${esc(c.tokenMetaError)}</b></p>` : ''}
`)}

<h2>修改</h2>
${card(`
<form method="post" action="${esc(adminHref('/admin/recharge-settings', adminToken))}">
<label for="recipient">收款地址（0x…）</label>
<input id="recipient" name="recipient" value="${esc(form.recipient)}" placeholder="0x 开头 40 位十六进制">

<label for="rpcUrl">RPC 地址</label>
<input id="rpcUrl" name="rpcUrl" value="${esc(form.rpcUrl)}" placeholder="https://ethereum-rpc.publicnode.com">
<p class="muted">保存时会用它读 ERC20 元数据、校验转账。节点不通也能保存（只是会告警），换一个可用的再点「重新读取元数据」即可。</p>

<label for="tokenAddress">ERC20 合约地址（留空则收原生币）</label>
<input id="tokenAddress" name="tokenAddress" value="${esc(form.tokenAddress)}" placeholder="留空 = 收取原生币">
<p class="muted">填写后保存时会自动读取链上的 name / symbol / decimals 并回显；读不到<b>也会保存</b>，只是会告警，并在 decimals 补全前拒绝入账。</p>

<label for="tokenName">代币名称（可选，留空自动读）</label>
<input id="tokenName" name="tokenName" value="${esc(form.tokenName)}" placeholder="如 Tether USD">

<label for="tokenSymbol">代币符号（可选，留空自动读）</label>
<input id="tokenSymbol" name="tokenSymbol" value="${esc(form.tokenSymbol)}" placeholder="如 USDT">

<label for="tokenDecimals">decimals（可选；自动读不到时必填）</label>
<input id="tokenDecimals" name="tokenDecimals" type="number" min="0" max="36" step="1" value="${esc(form.tokenDecimals)}" placeholder="如 6 / 18">
<p class="muted">RPC 不通或合约非标准时可手工填这三项。<b>decimals 填错会算错金额</b>（USDT 是 6，多数代币是 18），不确定就换个可用 RPC 再点「重新读取元数据」。</p>

<label for="rate">汇率（1 个代币兑换多少点数）</label>
<input id="rate" name="rate" type="number" step="any" min="0" value="${esc(form.rate)}" placeholder="如 1000">

<label for="chainId">链 ID（选填，建议留空让它自动识别）</label>
<input id="chainId" name="chainId" value="${esc(form.chainId)}" placeholder="如 56 或 0x38，留空则按 RPC 返回值填充">
<p class="muted">用户在充值页转账前，前端会比对钱包的 <code>eth_chainId</code>，不一致就自动唤起切换网络（钱包里没这条链会请求添加，RPC 用上面填的地址）。<b>填错等于让用户把钱转到别的链上</b>，所以保存时一律以 RPC 实际返回的链 ID 为准，手填的不一致会被更正并提示。</p>

<button class="btn" type="submit">保存</button>
</form>
`)}

`,
    adminTab: 'recharge-settings',
  });
}

function rechargeRecordsHtml(
  base: string,
  adminToken: string,
  filter: { userId?: string; kind?: string; status?: string },
): string {
  const rows = recharge.listRecharges({
    userId: filter.userId || undefined,
    kind: (filter.kind || '') as '' | 'native' | 'erc20',
    status: (filter.status || '') as '' | 'credited' | 'pending',
  });
  const s = recharge.getRechargeStats(rows);

  return page({
    title: 'Admin · 充值记录',
    base,
    active: 'admin',
    adminToken,
    body: `
<h1>充值记录</h1>
<div class="grid">
${statCard(s.count, '笔数', '当前筛选结果')}
${statCard(s.points, '点数合计')}
${statCard(s.nativePoints, '原生币充值')}
${statCard(s.erc20Points, 'ERC20 充值')}
${statCard(s.pendingCount, '待确认', '已入账但链上尚未打包')}
</div>

<h2>筛选</h2>
${card(`
<form method="get" action="${esc(adminHref('/admin/recharge', adminToken))}">
<label for="userId">用户 ID</label>
<input id="userId" name="userId" value="${esc(filter.userId ?? '')}" placeholder="留空 = 全部用户">
<label for="kind">类型</label>
<select id="kind" name="kind">
<option value="">全部</option>
<option value="native"${filter.kind === 'native' ? ' selected' : ''}>原生币</option>
<option value="erc20"${filter.kind === 'erc20' ? ' selected' : ''}>ERC20</option>
</select>
<label for="status">状态</label>
<select id="status" name="status">
<option value="">全部</option>
<option value="credited"${filter.status === 'credited' ? ' selected' : ''}>已到账</option>
<option value="pending"${filter.status === 'pending' ? ' selected' : ''}>待确认</option>
</select>
<button class="btn" type="submit">筛选</button>
<a class="btn alt" href="${esc(adminHref('/admin/recharge', adminToken))}">重置</a>
</form>
`)}

<h2>明细</h2>
${rows.length === 0
  ? '<div class="empty">没有符合条件的充值记录。</div>'
  : table(
      ['时间', '用户', '类型', '币种', '数量', '点数', '状态', '交易哈希'],
      rows.map((r) => [
        esc(fmtTime(r.createdAt)),
        `<a href="${esc(adminHref(`/admin/users/${encodeURIComponent(r.userId)}`, adminToken))}">${esc(r.username)}</a>`,
        r.kind === 'native' ? badge('原生币', '') : badge('ERC20', ''),
        esc(r.token),
        esc(r.amount),
        String(r.points),
        badge(r.status === 'pending' ? '待确认' : '已到账', r.status === 'pending' ? 'warn' : 'ok'),
        `<code>${esc(r.txHash.slice(0, 10))}…${esc(r.txHash.slice(-6))}</code>`,
      ]),
    )}

`,
    adminTab: 'recharge',
  });
}

// ---------- 路由 ----------

export function createAdminRouter(): Router {
  const router = Router();

  // 防御纵深：admin 令牌已不进 URL，这里主要是护住表单里的其它查询参数不外泄到 Referer
  router.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/admin/login', (req: Request, res: Response) => {
    const base = deriveBase(req);
    if (blockedByDefaultToken(req)) {
      res.status(503).type('html').send(
        page({
          title: 'Admin 未启用',
          base,
          body: `<h1>Admin 管理端未启用</h1>${notice('当前使用内置默认管理员令牌且对外地址非本地，已禁用。请注入 <code>ADMIN_TOKEN</code> 环境变量后重启。')}`,
        }),
      );
      return;
    }
    res.type('html').send(loginHtml(base));
  });

  router.post('/admin/login', (req: Request, res: Response) => {
    const base = deriveBase(req);
    const key = clientKey(req);

    if (blockedByDefaultToken(req)) {
      res.status(503).type('html').send(loginHtml(base, '未注入 ADMIN_TOKEN，公网环境已禁用默认令牌。'));
      return;
    }
    if (!originOk(req)) {
      res
        .status(403)
        .type('html')
        .send(loginHtml(base, getRejectedOriginMessage(req)));
      return;
    }
    if (isLocked(key)) {
      res.status(429).type('html').send(loginHtml(base, '失败次数过多，请 10 分钟后再试。'));
      return;
    }

    const submitted = String((req.body as Record<string, unknown> | undefined)?.token ?? '');
    if (submitted && safeEqual(submitted, getAdminToken())) {
      failures.delete(key);
      setAdminCookie(req, res, submitted);
      // 登录态靠 Cookie 保持，跳转不再把令牌拼进 URL（避免泄漏到地址栏 / 历史 / 日志）
      res.redirect(302, `${base}/admin`);
      return;
    }

    noteFailure(key);
    res.status(401).type('html').send(loginHtml(base, '令牌无效，请重试。'));
  });

  router.get('/admin/logout', (req: Request, res: Response) => {
    const base = deriveBase(req);
    res.appendHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect(302, `${base}/admin/login`);
  });

  router.get('/admin', requireAdmin, (req: Request, res: Response) => {
    const token = resolveAdminToken(req) ?? '';
    res.type('html').send(dashboardHtml(deriveBase(req), token));
  });

  router.get('/admin/api/stats', requireAdmin, (_req: Request, res: Response) => {
    res.json(getStatsSnapshot());
  });

  router.get('/admin/users', requireAdmin, (req: Request, res: Response) => {
    const token = resolveAdminToken(req) ?? '';
    const q = String((req.query as Record<string, unknown>).q ?? '');
    res.type('html').send(usersHtml(deriveBase(req), token, q));
  });

  router.get(
    '/admin/users/:id',
    requireAdmin,
    wrap(async (req: Request, res: Response) => {
      const token = resolveAdminToken(req) ?? '';
      const base = deriveBase(req);
      const id = String(req.params.id ?? '');
      const user = store.getUser(id);
      if (!user) {
        res.status(404).type('html').send(
          page({
            title: '用户不存在',
            base,
            active: 'admin',
            adminToken: token,
            adminTab: 'users',
            body: `<h1>用户不存在</h1><p class="muted">该用户不在用户存储中（可能已被删除，或数据目录被重置）。</p>`,
          }),
        );
        return;
      }
      res.type('html').send(userDetailHtml(base, token, user));
    }),
  );

  router.post(
    '/admin/users/:id/token',
    requireAdmin,
    requireSameOrigin,
    wrap(async (req: Request, res: Response) => {
      const token = resolveAdminToken(req) ?? '';
      const base = deriveBase(req);
      const id = String(req.params.id ?? '');
      const user = store.getUser(id);
      if (!user) {
        res.status(404).type('text/plain; charset=utf-8').send('用户不存在');
        return;
      }
      const issued = authManager.issueTokenForId(id, user.username);
      const note =
        user.id === id && !user.githubToken
          ? '注意：该用户未绑定 GitHub，search_repos 仍会提示先登录。'
          : undefined;
      res.type('html').send(userDetailHtml(base, token, user, { token: issued.token, note }));
    }),
  );

  router.post(
    '/admin/users/:id/delete',
    requireAdmin,
    requireSameOrigin,
    wrap(async (req: Request, res: Response) => {
      const token = resolveAdminToken(req) ?? '';
      const base = deriveBase(req);
      store.deleteUser(String(req.params.id ?? ''));
      res.redirect(302, `${base}${adminHref('/admin/users', token)}`);
    }),
  );

  router.get('/admin/settings', requireAdmin, (req: Request, res: Response) => {
    const token = resolveAdminToken(req) ?? '';
    const saved = (req.query as Record<string, unknown>).saved === '1';
    res.type('html').send(settingsHtml(deriveBase(req), token, saved));
  });

  router.post('/admin/settings', requireAdmin, requireSameOrigin, (req: Request, res: Response) => {
    const token = resolveAdminToken(req) ?? '';
    const base = deriveBase(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => String(v ?? '').trim();

    const patch: Parameters<typeof setGithub>[0] = {
      clientId: str(body.clientId),
      redirectUri: str(body.redirectUri),
      scope: str(body.scope),
    };
    const newSecret = str(body.clientSecret);
    if (newSecret) patch.clientSecret = newSecret;
    else if (str(body.clearSecret) === '1') patch.clientSecret = '';

    setGithub(patch);
    // 用 URL 拼接，避免 token 为空时拼出 `/admin/settings&saved=1` 这种坏地址
    const target = new URL(adminHref('/admin/settings', token), base);
    target.searchParams.set('saved', '1');
    res.redirect(302, target.toString());
  });

  router.get('/admin/recharge-settings', requireAdmin, (req: Request, res: Response) => {
    const token = resolveAdminToken(req) ?? '';
    const q = req.query as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    res.type('html').send(
      rechargeSettingsHtml(deriveBase(req), token, {
        saved: str(q.saved) === '1',
        error: str(q.err),
        warning: str(q.warn),
        message: str(q.msg),
      }),
    );
  });

  router.post(
    '/admin/recharge-settings',
    requireAdmin,
    requireSameOrigin,
    wrap(async (req: Request, res: Response) => {
      const token = resolveAdminToken(req) ?? '';
      const base = deriveBase(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const str = (v: unknown) => String(v ?? '').trim();
      const form = {
        recipient: str(body.recipient),
        rpcUrl: str(body.rpcUrl),
        tokenAddress: str(body.tokenAddress),
        tokenName: str(body.tokenName),
        tokenSymbol: str(body.tokenSymbol),
        tokenDecimals: str(body.tokenDecimals),
        rate: str(body.rate),
        chainId: str(body.chainId),
      };

      const result = await recharge.setRechargeConfig({
        ...form,
        rate: Number(form.rate),
      });

      if (!result.ok) {
        res
          .status(400)
          .type('html')
          .send(
            rechargeSettingsHtml(base, token, {
              error: result.error,
              form,
            }),
          );
        return;
      }

      const target = new URL(adminHref('/admin/recharge-settings', token), base);
      target.searchParams.set('saved', '1');
      if (result.warning) target.searchParams.set('warn', result.warning);
      if (result.info) target.searchParams.set('msg', result.info);
      res.redirect(302, target.toString());
    }),
  );

  // 「重新读取元数据」：RPC 恢复后不用重填整张表单
  router.post(
    '/admin/recharge-settings/refresh-meta',
    requireAdmin,
    requireSameOrigin,
    wrap(async (req: Request, res: Response) => {
      const token = resolveAdminToken(req) ?? '';
      const result = await recharge.refreshTokenMeta();
      const target = new URL(adminHref('/admin/recharge-settings', token), deriveBase(req));
      if (result.ok) {
        if (result.warning) target.searchParams.set('warn', result.warning);
        else target.searchParams.set('msg', result.info || '元数据已重新读取成功。');
      } else {
        target.searchParams.set('err', result.error);
      }
      res.redirect(302, target.toString());
    }),
  );

  router.get('/admin/recharge', requireAdmin, (req: Request, res: Response) => {
    const token = resolveAdminToken(req) ?? '';
    const q = req.query as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    res.type('html').send(
      rechargeRecordsHtml(deriveBase(req), token, {
        userId: str(q.userId),
        kind: str(q.kind),
        status: str(q.status),
      }),
    );
  });

  router.post(
    '/admin/settings/reset',
    requireAdmin,
    requireSameOrigin,
    (req: Request, res: Response) => {
      const token = resolveAdminToken(req) ?? '';
      const base = deriveBase(req);
      resetGithub();
      const target = new URL(adminHref('/admin/settings', token), base);
      target.searchParams.set('saved', '1');
      res.redirect(302, target.toString());
    },
  );

  return router;
}
