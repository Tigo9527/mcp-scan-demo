/**
 * 用户 Profile 页面：`GET /profile?token=<mcp 令牌>`
 *
 * 用户拿到令牌后（一键注册页 / GitHub 登录页 / register_user 工具），
 * 在这里查看自己的资料与**个人维度的调用统计**，并复制 MCP 客户端配置。
 */
import { Router, type Request, type Response } from 'express';
import { authenticateUserRequest, deriveBase, resolveUserToken } from './http.js';
import { getUserStats } from '../stats.js';
import { isGitHubConfigured } from '../auth/github.js';
import { bar, badge, card, esc, fmtTime, notice, page, statCard, table } from './layout.js';
import { config } from '../config.js';
import * as billing from '../billing.js';

function noTokenHtml(base: string): string {
  return page({
    title: '我的 Profile',
    base,
    active: 'profile',
    body: `
<h1>我的 Profile</h1>
${notice('未提供有效令牌。请在 URL 后追加你的令牌：<code>/profile?token=mcp_demo_xxx</code>')}
${card(`
<h3>还没有令牌？</h3>
<p>去首页一键注册，注册成功后页面上会有「查看我的 Profile」入口，直接点进来即可。</p>
<div class="row"><a class="btn" href="${esc(base)}/register">一键注册</a>
<a class="btn alt" href="${esc(base)}/">返回首页</a></div>
`)}
`,
  });
}

export function createProfileRouter(): Router {
  const router = Router();

  router.get('/profile', (req: Request, res: Response) => {
    // 令牌在 URL 里，禁止浏览器把 Referer 带出去
    res.setHeader('Referrer-Policy', 'no-referrer');

    const base = deriveBase(req);
    const user = authenticateUserRequest(req);
    if (!user) {
      res.type('html').send(noTokenHtml(base));
      return;
    }

    const token = resolveUserToken(req) ?? '';
    const stat = getUserStats(user.id);
    const tools = stat?.tools ?? {};
    const toolCalls = Object.values(tools).reduce((a, b) => a + b, 0);
    const days = stat?.days ?? {};
    const recentDays = Object.keys(days)
      .sort()
      .slice(-7)
      .map((d) => ({ date: d, calls: days[d] as number }));
    const maxTool = Math.max(1, ...Object.values(tools));

    // 计费账本：余额/消耗，及定价表
    const bill = billing.getUserBilling(user.id);
    const usedPoints = bill?.used ?? 0;
    const balancePoints = bill?.balance ?? config.billingFreeCredits;
    const pricing = billing
      .getPricingTable()
      .map((p) => [esc(p.tool), p.cost === 0 ? '<span class="muted">免费</span>' : `${p.cost} 点/次`]);
    const lowBalance = balancePoints <= 0;

    const infoRows = [
      [esc(user.username), esc(user.email ?? '—'), badge(user.provider), esc(user.githubLogin ?? '未绑定')],
    ];

    const metaRows: string[][] = [
      ['用户 ID', `<code>${esc(user.id)}</code>`],
      ['注册时间', esc(fmtTime(user.createdAt))],
      ['最近活跃', esc(fmtTime(stat?.lastSeenAt ?? user.lastSeenAt))],
      ['首次记录时间', esc(fmtTime(stat?.firstSeenAt))],
    ];

    const toolRows = Object.entries(tools)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => [esc(name), String(n), bar(n, maxTool)]);

    const dayRows = recentDays.map((d) => [esc(d.date), String(d.calls), bar(d.calls, Math.max(1, ...recentDays.map((x) => x.calls)))]);

    const configJson = JSON.stringify(
      {
        mcpServers: {
          'mcp-demo': {
            url: `${base}/mcp?token=${token}`,
            transport: 'streamable-http',
          },
        },
      },
      null,
      2,
    );

    const body = `
<h1>我的 Profile</h1>
<p class="muted">你好，<b>${esc(user.username)}</b>。下面是你的账号信息与个人调用统计。</p>

<h2>基本信息</h2>
${table(['用户名', '邮箱', '来源', 'GitHub'], infoRows)}
${table(['字段', '值'], metaRows)}

<h2>我的调用统计</h2>
<div class="grid">
${statCard(stat?.calls ?? 0, '请求总数', '含 initialize / tools/list 等')}
${statCard(toolCalls, '工具调用次数', '仅 tools/call')}
${statCard(Object.keys(tools).length, '使用过的工具数')}
</div>
${toolRows.length > 0 ? `<h3>按工具分布</h3>${table(['工具', '次数', ''], toolRows)}` : '<div class="empty">还没有工具调用记录。</div>'}
${dayRows.length > 0 ? `<h3>最近 7 天</h3>${table(['日期', '请求数', ''], dayRows)}` : ''}
<p class="muted">统计口径：「请求总数」含 initialize / tools/list 等所有带 id 的请求，「工具调用次数」只算 tools/call；匿名请求不计入个人统计。</p>

<h2>我的计费</h2>
${lowBalance ? notice('你的调用余额已用尽，收费工具（如 ConfluxScan 查询、search_repos）会被拒绝执行。请联系管理员充值，或登录获取新的额度。') : ''}
<div class="grid">
${statCard(balancePoints, '剩余额度', `注册赠送 ${config.billingFreeCredits} 点`)}
${statCard(usedPoints, '已消耗点数', '按调用累计')}
</div>
${table(['工具', '单价'], pricing)}
<p class="muted">免费工具不扣点；外部 API 类工具（ConfluxScan 查询、search_repos）单价较高。硬计费开启时余额耗尽将拒绝执行收费工具；充值可在「充值」页完成。</p>

<h2>MCP 客户端配置</h2>
${card(`
<p>把下面这段粘进 MCP 客户端即可（令牌已内嵌在 URL 里，无需额外请求头）。</p>
<pre>${esc(configJson)}</pre>
<p class="muted">也可以用请求头方式：<code>X-Authorization: Bearer ${esc(token.slice(0, 20))}…</code>（完整令牌见上方配置）</p>
`)}

<h2>GitHub 绑定</h2>
${card(
  user.githubLogin
    ? `<p>已绑定 GitHub 账号 ${badge(`@${esc(user.githubLogin)}`, 'ok')}，可以调用 <code>search_repos</code> 工具。</p>`
    : isGitHubConfigured()
      ? `<p>尚未绑定 GitHub。绑定后即可使用 <code>search_repos</code> 工具。</p>
<div class="row"><a class="btn alt" href="${esc(base)}/auth/github">通过 GitHub 登录</a></div>`
      : `<p>服务端尚未配置 GitHub OAuth（管理员可在 Admin 管理端设置）。</p>`,
)}

<p style="margin-top:24px"><a href="${esc(base)}/">← 返回首页</a></p>
`;

    res.type('html').send(page({ title: `Profile · ${user.username}`, base, active: 'profile', body }));
  });

  return router;
}
