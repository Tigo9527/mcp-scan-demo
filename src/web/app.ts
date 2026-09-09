/**
 * Web 入口：Express 应用。
 * - 门户首页、一键注册、GitHub OAuth 路由
 * - MCP Streamable HTTP 端点（/mcp），带 Bearer 鉴权
 * - Admin 管理端（/admin）与用户 Profile（/profile）
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import * as auth from '../auth/manager.js';
import * as store from '../auth/store.js';
import { authContext, baseUrlContext } from '../auth/context.js';
import { createMcpServer, PUBLIC_MCP_TOOLS } from '../mcp/server.js';
import {
  createState,
  exchangeAndLogin,
  getAuthorizationUrl,
  humanizeOAuthError,
  isGitHubConfigured,
  verifyState,
} from '../auth/github.js';
import type { AuthResult } from '../auth/manager.js';
import type { User } from '../auth/store.js';
import * as stats from '../stats.js';
import { persistStatus } from '../persist.js';
import {
  authenticateUserRequest,
  allowPublicCors,
  deriveBase,
  requireSameOrigin,
  resolveUserToken,
  wrap,
} from './http.js';
import {
  authorizationServerMetadata,
  canonicalResourceUri,
  MCP_PATH,
  OAUTH_SCOPE,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  WELL_KNOWN,
  wwwAuthenticate,
} from '../oauth/metadata.js';
import { requireAuthForMcp } from '../config.js';
import { createAdminRouter } from './admin.js';
import { createProfileRouter } from './profile.js';
import { createAuthorizeRouter, completeAuthorize, type AuthorizeParams, type AuthorizeTicket } from '../oauth/authorize.js';
import { createRegisterRouter } from '../oauth/register.js';
import { createWeb3Router } from './web3.js';
import { createTokenRouter } from '../oauth/token.js';
import { readClient, redirectUriAllowed } from '../oauth/clients.js';
import { open } from '../oauth/tickets.js';
import { badge, authorizeCompleteHtml, card, copyBlock, esc, notice, page, step } from './layout.js';

// ---------- 页面 ----------

/**
 * 免登录的 MCP 客户端配置。**不含任何令牌**，可公开转发给新用户。
 * 不含令牌时 /mcp 会返回 401 + WWW-Authenticate，支持标准 OAuth Discovery 的客户端
 * （Codex / Claude Desktop / MCP Inspector 等）会据此自动弹出登录页，所以这份配置可直接用。
 */
export function publicMcpConfigJson(base: string): string {
  return JSON.stringify(
    { mcpServers: { 'mcp-demo': { url: `${base}/mcp`, transport: 'streamable-http' } } },
    null,
    2,
  );
}

/** 拿到令牌后的写法 A：拼在 URL 上（占位符，绝不含真实令牌） */
function tokenMcpConfigJson(base: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'mcp-demo': { url: `${base}/mcp?token=<你的令牌>`, transport: 'streamable-http' },
      },
    },
    null,
    2,
  );
}

/** 拿到令牌后的写法 B：走 X-Authorization 头 */
function headerMcpConfigJson(base: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'mcp-demo': {
          url: `${base}/mcp`,
          transport: 'streamable-http',
          headers: { 'X-Authorization': 'Bearer <你的令牌>' },
        },
      },
    },
    null,
    2,
  );
}

/** 一行 curl 握手，用于验证端点是否可用 */
function curlInitialize(base: string): string {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'curl', version: '1.0' },
    },
  });
  return `curl -N -X POST ${base}/mcp \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -d '${payload}'`;
}

/**
 * 读取 mcp-config-aiaw.json（aiaw.app 服务清单格式）原文，用于在 /setup 页面展示可复制。
 * 优先按运行位置解析文件，全部失败则回退到内置副本，保证页面永不崩。
 */
function loadAiawConfigJson(): string {
  const fallback = JSON.stringify(
    {
      id: 'mcp-demo',
      title: 'MCP Demo',
      description: '示例 MCP 服务：提供账号登录、用户信息查询、仓库搜索等工具，支持 OAuth 2.1 授权登录。',
      transport: { type: 'http', url: 'https://mcp-demo.confluxscan.org/mcp' },
      author: 'agent3k',
      homepage: 'https://cnb.cool/agent3k/mcp-demo',
    },
    null,
    2,
  );
  const candidates = [
    path.resolve(process.cwd(), 'mcp-config-aiaw.json'),
    fileURLToPath(new URL('../mcp-config-aiaw.json', import.meta.url)),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf8').trim();
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  return fallback;
}

/** 免登录的接入说明页（/setup）。刻意不含任何令牌，链接可直接发给新用户。 */
export function setupHtml(base: string): string {
  return page({
    title: '接入 MCP 客户端',
    base,
    active: 'setup',
    body: `
<h1>🔧 接入 MCP 客户端</h1>
<p>这个页面<strong>不需要登录、不含任何令牌</strong>，可以直接把链接发给新用户。</p>

${card(`
${step(1, '复制配置，粘到你的 MCP 客户端')}
${copyBlock(publicMcpConfigJson(base), { title: 'mcpServers 配置（不含令牌）' })}
<p class="muted">适用于任意支持 Streamable HTTP 的客户端：Claude Desktop / Cursor / Cherry Studio / 钉钉 / 自研 Agent 等。</p>
`)}

${card(`
<h3>🧩 aiaw.app 等「服务清单」格式客户端</h3>
<p>以下为 <code>mcp-config-aiaw.json</code>（id / title / description / transport / author / homepage 清单格式），
直接复制到 aiaw.app 的「添加服务」即可。</p>
${copyBlock(loadAiawConfigJson(), { title: 'aiaw.app 服务清单（mcp-config-aiaw.json）' })}
`)}

${card(`
${step(2, '第一次连上时，客户端会自动让你登录')}
<p>本服务实现了 MCP 标准的授权发现（RFC 9728 / RFC 8414）：不带令牌请求 <code>/mcp</code> 会拿到
<b>401 + <code>WWW-Authenticate</code></b>，客户端据此找到授权服务器、完成动态注册，并把浏览器导航到登录页。</p>
<p class="muted">支持这个流程的客户端（Codex、Claude Desktop、MCP Inspector 等）无需任何手工配置，
录完用户名密码就通了。不支持的客户端继续看第 3 步。</p>
`)}
${card(`
${step(3, '不支持自动发现的客户端：手工拿令牌')}
<div class="row"><a class="btn" href="${esc(base)}/register">账号密码注册</a>
<a class="btn alt" href="${esc(base)}/login">账号密码登录</a></div>
<p class="muted">AI Agent（如钉钉）可用一键注册自动拿令牌：<code>${esc(base)}/register?username=alice</code></p>
${copyBlock(tokenMcpConfigJson(base), { title: '写法 A：令牌拼在 URL 上' })}
${copyBlock(headerMcpConfigJson(base), {
  title: '写法 B：用 X-Authorization 头（推荐）',
  hint: '务必用 X-Authorization，不要用 Authorization —— 部署平台网关会改写 Authorization 头。',
})}
<p class="muted">想「先装后登录」（装好客户端、列完工具，调用受保护工具时再提示登录）？
在 MCP 请求头加 <code>MCP-Unauthorized-Status: 200</code> 即可，未授权时返回 200 + 引导而非 401。</p>
`)}

${card(`
<h3>🧪 先验证一下连通性</h3>
${copyBlock(`curl -s ${base}/health`, { title: '健康检查' })}
${copyBlock(curlInitialize(base), { title: 'JSON-RPC 握手（应返回 serverInfo）' })}
`)}

${card(`
<h3>⚠️ 常见坑</h3>
<ul>
<li><code>GET /mcp</code> 返回 <b>405</b> 是<strong>正常</strong>的：本服务跑在无状态模式，只接受 POST。</li>
<li>不带令牌的请求会收到 <b>401</b>，这是触发标准登录流程的入口，不是故障；排查时看
<code>WWW-Authenticate</code> 头里的 <code>resource_metadata</code> 是否指向
<code>${esc(base)}/.well-known/oauth-protected-resource/mcp</code>。</li>
<li>不要用 <code>Authorization</code> 头传令牌，网关会改写它；用 <code>X-Authorization</code> 或 <code>?token=</code>。</li>
<li>令牌形如 <code>mcp_demo_xxxx</code>，前缀不能丢。</li>
</ul>
`)}

<div class="row"><a class="btn alt" href="${esc(base)}/">返回首页</a></div>
<p class="muted">也可以让 AI 调用 <code>server_info</code> 工具查看当前端点与登录链接。</p>
`,
  });
}

function homeHtml(base: string): string {
  return page({
    title: 'MCP Demo',
    base,
    active: 'home',
    body: `
<h1>🔌 MCP Demo 服务</h1>
<p>TypeScript + 官方 <code>@modelcontextprotocol/sdk</code>，基于 Streamable HTTP 传输，内置认证（账号密码 + 一键注册 + GitHub OAuth）、Admin 管理端与调用统计。</p>

${card(`
<h3>① 账号密码注册</h3>
<p>用用户名 + 密码创建本地账号，之后用账号密码登录。</p>
<div class="row"><a class="btn" href="${esc(base)}/register">注册账号</a></div>
`)}

${card(`
<h3>② 账号密码登录</h3>
<p>已注册用户用账号密码登录，登录后直接拿到访问令牌。</p>
<div class="row"><a class="btn alt" href="${esc(base)}/login">登录</a></div>
`)}

${card(`
<h3>③ GitHub OAuth 注册 / 登录 ${isGitHubConfigured() ? badge('已配置', 'ok') : badge('未配置', 'warn')}</h3>
<p>${
  isGitHubConfigured()
    ? '凭据已就绪，可正常跳转授权；首次登录即注册，之后每次登录复用同一账号。'
    : '尚未配置 Client ID / Secret，跳转会被 GitHub 拒绝。管理员可在 Admin 管理端 → GitHub 设置里在线填写，无需重启。'
}</p>
<div class="row"><a class="btn alt" href="${esc(base)}/auth/github">通过 GitHub 注册 / 登录</a></div>
`)}

${card(`
<h3>④ MCP 客户端配置（免登录，可直接复制）</h3>
<p>Streamable HTTP：<code>${esc(`${base}/mcp`)}</code></p>
${copyBlock(publicMcpConfigJson(base), {
  title: '不含令牌，可放心转发给新用户',
  hint: '支持标准 OAuth Discovery 的客户端会自己弹出登录页；不支持的按 /setup 手工填令牌。',
})}
<div class="row"><a class="btn small" href="${esc(base)}/setup">完整接入说明 →</a>
<a class="btn small alt" href="${esc(base)}/register">先去注册拿令牌</a></div>
`)}

${card(`
<h3>⑥ web3 钱包登录（MetaMask）</h3>
<p>无需密码：用 MetaMask 等钱包对挑战文案签名即完成注册 / 登录，身份即钱包地址。</p>
<div class="row"><a class="btn alt" href="${esc(base)}/web3">用钱包签名登录</a></div>
`)}

${card(`
<h3>⑤ 查看资料与统计</h3>
<p>用户可在 <code>/profile?token=&lt;你的令牌&gt;</code> 查看个人资料与调用统计；管理员可进入 Admin 管理端查看用户列表与全局统计。</p>
<div class="row"><a class="btn small alt" href="${esc(base)}/profile">我的 Profile</a>
<a class="btn small alt" href="${esc(base)}/admin">Admin 管理端</a></div>
`)}

<p class="muted">健康检查：<a href="${esc(base)}/health">${esc(base)}/health</a> · 当前实例 <code>${esc(config.instanceId)}</code></p>
`,
  });
}

/** 注册/登录成功后展示令牌与 MCP 配置片段（口令绝不经此回显）。 */
function tokenResultHtml(
  result: AuthResult,
  base: string,
  opts: { title: string; heading: string; intro: string },
): string {
  const profileUrl = `${base}/profile?token=${result.token}`;
  const configJson = JSON.stringify(
    {
      mcpServers: {
        'mcp-demo': {
          url: `${base}/mcp?token=${result.token}`,
          transport: 'streamable-http',
        },
      },
    },
    null,
    2,
  );

  return page({
    title: opts.title,
    base,
    body: `
<h1>${esc(opts.heading)}</h1>
${card(`<b>用户：</b> ${esc(result.user.username)}（${esc(result.user.email ?? '—')}）· 来源 ${esc(result.user.provider)}`)}

${card(`
<p>${esc(opts.intro)}</p>
<b>访问令牌（Bearer）：</b><br><code>${esc(result.token)}</code>
<p class="muted">把它放到请求头 <code>X-Authorization: Bearer &lt;token&gt;</code>，或拼到 MCP 端点 URL 后 <code>?token=&lt;token&gt;</code>。注意：不要用 <code>Authorization</code> 头，部署平台网关会改写它。</p>
`)}

${card(`
<b>MCP 客户端配置（直接复制）：</b>
<pre>${esc(configJson)}</pre>
`)}

<div class="row" style="margin:16px 0">
<a class="btn" href="${esc(profileUrl)}">查看我的 Profile →</a>
<a class="btn alt" href="${esc(base)}/login">用账号密码再次登录</a>
<a class="btn alt" href="${esc(base)}/">返回首页</a>
</div>
`,
  });
}

function registeredHtml(result: AuthResult, base: string): string {
  return tokenResultHtml(result, base, {
    title: '注册成功',
    heading: '✅ 注册成功',
    intro: '账号已创建，下方是你的访问令牌（请妥善保管，页面刷新后不再显示）。',
  });
}

function loginSuccessHtml(result: AuthResult, base: string): string {
  return tokenResultHtml(result, base, {
    title: '登录成功',
    heading: '🔓 登录成功',
    intro: '登录成功，下方是你的访问令牌（请妥善保管，页面刷新后不再显示）。',
  });
}

/**
 * 注册/登录成功后，若处于 OAuth 授权流程（携带 authorize 票据），则还原并复核原始授权请求、
 * 签发授权码并回跳客户端（与 GitHub 回调路径共用 completeAuthorize + 同一套 client/redirect_uri/resource 复核）；
 * 不在授权流程中则返回 null，由调用方展示普通令牌页。
 */
function completeAuthorizeFromTicket(
  result: AuthResult,
  base: string,
  authorizeTicket: string | undefined,
): string | null {
  if (!authorizeTicket) return null;
  const t = open<AuthorizeTicket>('authorize', authorizeTicket);
  if (!t) return null;
  const client = readClient(t.clientId);
  if (!client || !redirectUriAllowed(client, t.redirectUri)) return null;
  if (t.resource !== canonicalResourceUri(base)) return null;
  const p: AuthorizeParams = {
    clientId: t.clientId,
    redirectUri: t.redirectUri,
    state: t.state,
    codeChallenge: t.codeChallenge,
    scope: t.scope,
    resource: t.resource,
  };
  return completeAuthorize(base, p, result.user);
}

/** 账号密码注册页。authorizeTicket 非空表示本次注册是 OAuth 授权流程的一环，需原样带回 POST。 */
function registerHtml(base: string, error?: string, authorizeTicket?: string): string {
  const hidden = authorizeTicket
    ? `<input type="hidden" name="authorize" value="${esc(authorizeTicket)}">`
    : '';
  return page({
    title: '注册账号',
    base,
    body: `
<h1>注册账号</h1>
${error ? notice(esc(error)) : ''}
${card(`
<form method="post" action="/register">
${hidden}
<label for="username">用户名</label>
<input id="username" name="username" type="text" autocomplete="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_-]+" placeholder="3~32 位，仅字母/数字/_/-">
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="new-password" required minlength="8" placeholder="至少 8 位">
<p class="muted">密码仅用于本服务登录，以哈希形式存储，绝不回显、绝不进令牌。</p>
<button class="btn" type="submit">注册</button>
</form>
`)}
<div class="row" style="margin-top:12px">
<p class="muted">已有账号？<a href="${esc(base)}/login">去登录</a> · 或 <a href="${esc(base)}/auth/github">用 GitHub 注册 / 登录</a></p>
</div>
<p><a href="${esc(base)}/">← 返回首页</a></p>
`,
  });
}

/** 账号密码登录页 */
function loginHtml(base: string, error?: string): string {
  return page({
    title: '登录',
    base,
    body: `
<h1>登录</h1>
${error ? notice(esc(error)) : ''}
${card(`
<form method="post" action="/login">
<label for="username">用户名</label>
<input id="username" name="username" type="text" autocomplete="username" required>
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button class="btn" type="submit">登录</button>
</form>
`)}
<div class="row" style="margin-top:12px">
<p class="muted">还没有账号？<a href="${esc(base)}/register">去注册</a> · 或 <a href="${esc(base)}/auth/github">用 GitHub 注册 / 登录</a></p>
</div>
<p><a href="${esc(base)}/">← 返回首页</a></p>
`,
  });
}

/** web3 钱包登录页：连接 MetaMask，签名挑战，拿令牌。 */
function web3LoginHtml(base: string, error?: string, token?: string): string {
  if (token) {
    return page({
      title: 'web3 登录成功',
      base,
      body: `
<h1>🦊 web3 登录成功</h1>
${card(`<b>钱包：</b> <code>${esc(token)}</code>`)}
<p>下面这串访问令牌可直接配置到 MCP 客户端调用受保护工具；或用 <code>/profile?token=...</code> 查看资料。</p>
${copyBlock(token, { title: '访问令牌（Bearer）' })}
<div class="row" style="margin:16px 0"><a class="btn" href="${esc(`${base}/profile?token=${token}`)}">查看我的 Profile →</a>
<a class="btn alt" href="${esc(base)}/">返回首页</a></div>
`,
    });
  }
  return page({
    title: 'web3 钱包登录',
    base,
    body: `
<h1>🦊 web3 钱包登录</h1>
${error ? notice(esc(error)) : ''}
${card(`
<p>用 MetaMask（或其它注入 <code>window.ethereum</code> 的钱包）签名一段挑战文案完成登录，无需密码。首次签名即注册。</p>
<button id="web3-connect" class="btn" type="button">连接钱包并登录</button>
<p id="web3-status" class="muted" style="margin-top:10px"></p>
`)}
<div class="row" style="margin-top:12px">
<p class="muted">其它登录方式：<a href="${esc(base)}/register">账号密码注册</a> · <a href="${esc(base)}/login">账号密码登录</a> · <a href="${esc(base)}/auth/github">GitHub</a></p>
</div>
<p><a href="${esc(base)}/">← 返回首页</a></p>
<script>
(function(){
  var btn=document.getElementById('web3-connect');
  var status=document.getElementById('web3-status');
  var setStatus=function(s){status.textContent=s;};
  if(!window.ethereum){
    setStatus('未检测到钱包（MetaMask 等）。请先安装并解锁钱包。');
    btn.disabled=true;return;
  }
  btn.addEventListener('click',async function(){
    btn.disabled=true;setStatus('请在钱包中确认连接…');
    try{
      var accts=await window.ethereum.request({method:'eth_requestAccounts'});
      var address=accts&&accts[0];
      if(!address){setStatus('未能获取钱包地址。');btn.disabled=false;return;}
      setStatus('已连接 '+address.slice(0,6)+'…'+address.slice(-4)+'，正在领取签名挑战…');
      var nonceResp=await fetch('${esc(base)}/web3/nonce?address='+encodeURIComponent(address));
      if(!nonceResp.ok){setStatus('获取挑战失败：'+(nonceResp.status));btn.disabled=false;return;}
      var nonceData=await nonceResp.json();
      setStatus('请在钱包中对下方文案签名…');
      var sig=await window.ethereum.request({method:'personal_sign',params:[nonceData.message,address]});
      setStatus('签名完成，正在校验…');
      var vResp=await fetch('${esc(base)}/web3/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:address,signature:sig})});
      var vData=await vResp.json();
      if(!vResp.ok){setStatus('校验失败：'+(vData.error_description||vResp.status));btn.disabled=false;return;}
      // 跳到带令牌的结果页（避免令牌出现在地址栏，用 POST 后重定向）
      var q=new URLSearchParams({token:vData.token});
      window.location.href='${esc(base)}/web3?'+q.toString();
    }catch(e){
      setStatus('出错：'+(e&&e.message?e.message:String(e)));
      btn.disabled=false;
    }
  });
})();
</script>
`,
  });
}

/**
 * 判断请求体是否**只**包含通知类消息（`notifications/*`）。
 * 通知没有响应、也不该要求鉴权；对它们返回 401 会打断客户端的初始化流程。
 */
function isNotificationOnly(body: unknown): boolean {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return false;
  return messages.every((m) => {
    if (!m || typeof m !== 'object') return false;
    const method = (m as { method?: unknown }).method;
    return typeof method === 'string' && method.startsWith('notifications/');
  });
}

/**
 * 是否允许「客户端指定未授权返回码为 200」时的匿名请求。
 * 仅当客户端显式请求「先装后登录」（MCP-Unauthorized-Status: 200）时才启用，默认（无该头）不启用。
 * 允许匿名的有三类：
 *   1. 通知类（notifications/*，无响应，按协议本就不要求鉴权）；
 *   2. 握手 / 发现类方法（initialize / ping / tools|resources|prompts/list），安装与枚举工具所需；
 *   3. 公开工具调用（server_info / login / register_user），未登录也能拿到登录入口或一键注册。
 * 其余（尤其是受保护工具的 tools/call）仍要求登录。
 */
function isAnonymousEligible(body: unknown): boolean {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return false;
  return messages.every((m) => {
    if (!m || typeof m !== 'object') return false;
    const msg = m as { method?: unknown; params?: unknown };
    const method = msg.method;
    if (typeof method !== 'string') return false;
    if (method.startsWith('notifications/')) return true;
    if (
      method === 'initialize' ||
      method === 'ping' ||
      method === 'tools/list' ||
      method === 'resources/list' ||
      method === 'prompts/list'
    ) {
      return true;
    }
    if (method === 'tools/call') {
      const name = (msg.params as { name?: unknown } | undefined)?.name;
      return typeof name === 'string' && PUBLIC_MCP_TOOLS.has(name);
    }
    return false;
  });
}

/**
 * 读取客户端指定的「未授权返回码」。
 *
 * 标准 MCP 约定未授权返回 **401**（触发 OAuth 发现），故默认 401。
 * 客户端若想「先装后登录」（装好客户端、列完工具，真正调用受保护工具时再提示登录），
 * 可在请求头带 `MCP-Unauthorized-Status: 200`，本服务则对可匿名请求放行、
 * 对不可匿名请求返回 200 + 引导文案（而非 401）。仅接受 200 / 401，其余按默认 401 处理。
 */
function getUnauthorizedStatus(req: Request): number {
  const raw = req.headers['mcp-unauthorized-status'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === '200' ? 200 : 401;
}

function oauthSuccessHtml(user: User, token: string, base: string): string {
  const profileUrl = `${base}/profile?token=${token}`;
  return page({
    title: 'GitHub 登录成功',
    base,
    body: `
<h1>🎉 GitHub 登录成功</h1>
${card(`<b>GitHub：</b> @${esc(user.githubLogin ?? '—')} → 本地用户 <code>${esc(user.username)}</code>`)}
${card(`<b>访问令牌（Bearer）：</b><br><code>${esc(token)}</code>`)}
<p>现在可在 MCP 客户端用此令牌调用 <code>search_repos</code> 等需要 GitHub 权限的工具，也可以用 <code>my_stats</code> 查看自己的调用统计。</p>
<div class="row" style="margin:16px 0">
<a class="btn" href="${esc(profileUrl)}">查看我的 Profile →</a>
<a class="btn alt" href="${esc(base)}/login">用账号密码再次登录</a>
<a class="btn alt" href="${esc(base)}/">返回首页</a>
</div>
`,
  });
}

export function createApp() {
  const app = express();
  app.use(express.json());

  // 表单解析只挂在 admin 与 oauth 下（/mcp 用的是 application/json），缩小影响面
  app.use('/admin', express.urlencoded({ extended: false, limit: '32kb' }));
  // /oauth/authorize 的登录表单是 urlencoded；缺了它 POST 时 req.body 会是 undefined
  app.use('/oauth', express.urlencoded({ extended: false, limit: '32kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      name: 'mcp-demo',
      version: '1.0.0',
      instanceId: config.instanceId,
      startedAt: config.startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      users: store.countUsers(),
      githubConfigured: isGitHubConfigured(),
      persist: persistStatus(),
    });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(homeHtml(deriveBase(_req)));
  });

  // 接入说明页：免登录、不含任何令牌，链接可直接分享给新用户
  app.get('/setup', (req: Request, res: Response) => {
    res.type('html').send(setupHtml(deriveBase(req)));
  });

  // 注册入口：带 ?username= 走「一键注册」（供钉钉等 Agent 自动注册，行为不变）；
  // 否则渲染账号密码注册页。两者都可能带着 OAuth 授权票据（authorize），注册成功即完成授权回跳。
  app.get('/register', (req: Request, res: Response) => {
    const base = deriveBase(req);
    const username = req.query.username as string | undefined;
    const authorizeTicket =
      typeof req.query.authorize === 'string' ? req.query.authorize : undefined;
    if (username) {
      try {
        const result = auth.registerOneClick({
          username,
          email: req.query.email as string | undefined,
        });
        const oauth = completeAuthorizeFromTicket(result, base, authorizeTicket);
        res.type('html').send(oauth ?? registeredHtml(result, base));
      } catch (err) {
        const msg = err instanceof auth.AuthError ? err.message : '注册失败，请稍后重试。';
        res.status(err instanceof auth.AuthError ? err.status : 400).type('html').send(
          registerHtml(base, msg, authorizeTicket),
        );
      }
      return;
    }
    res.type('html').send(registerHtml(base, undefined, authorizeTicket));
  });

  // 账号密码注册（POST 表单）。跨站表单防护 + async 兜底。
  // 携带 authorize 票据时，注册成功即完成 OAuth 授权回跳（签发 code + 跳转 redirect_uri）。
  app.post(
    '/register',
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireSameOrigin,
    wrap((req: Request, res: Response) => {
      const base = deriveBase(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = String(body.username ?? '');
      const password = String(body.password ?? '');
      const authorizeTicket =
        typeof body.authorize === 'string' ? body.authorize : undefined;
      try {
        const result = auth.registerWithPassword(username, password);
        const oauth = completeAuthorizeFromTicket(result, base, authorizeTicket);
        res.type('html').send(oauth ?? registeredHtml(result, base));
      } catch (err) {
        const msg = err instanceof auth.AuthError ? err.message : '注册失败，请稍后重试。';
        res
          .status(err instanceof auth.AuthError ? err.status : 400)
          .type('html')
          .send(registerHtml(base, msg, authorizeTicket));
      }
    }),
  );

  // 账号密码登录入口
  app.get('/login', (req: Request, res: Response) => {
    res.type('html').send(loginHtml(deriveBase(req)));
  });

  // web3 钱包登录页（MetaMask 等）
  app.get('/web3', (req: Request, res: Response) => {
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    res.type('html').send(web3LoginHtml(deriveBase(req), undefined, token));
  });

  // 账号密码登录（POST 表单）。跨站表单防护 + async 兜底。
  app.post(
    '/login',
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireSameOrigin,
    wrap((req: Request, res: Response) => {
      const base = deriveBase(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = String(body.username ?? '');
      const password = String(body.password ?? '');
      try {
        const result = auth.loginWithPassword(username, password);
        res.type('html').send(loginSuccessHtml(result, base));
      } catch (err) {
        // 统一回显「用户名或密码错误」，避免账号枚举
        const msg = err instanceof auth.AuthError && err.status === 400 ? err.message : '用户名或密码错误';
        res.status(err instanceof auth.AuthError ? err.status : 401).type('html').send(loginHtml(base, msg));
      }
    }),
  );

  // GitHub OAuth：跳转授权（state 为自签名 JWT，跨副本可校验）。
  // 若带 authorize 票据（来自 /oauth/authorize 的「通过 GitHub 登录」链接），一并塞进 state，
  // 让登录完成后能还原原始授权请求并回跳客户端。
  app.get('/auth/github', (req: Request, res: Response) => {
    const authorizeTicket = typeof req.query.authorize === 'string' ? req.query.authorize : undefined;
    res.redirect(getAuthorizationUrl(createState(authorizeTicket)));
  });

  // GitHub OAuth：回调换令牌并落地用户
  app.get(
    '/auth/github/callback',
    wrap(async (req: Request, res: Response) => {
      const base = deriveBase(req);
      const { code, state } = req.query as { code?: string; state?: string };

      if (!code) {
        res.status(400).type('html').send(oauthErrorHtml(base, '缺少 code 参数'));
        return;
      }
      const st = verifyState(state);
      if (!st.ok) {
        res
          .status(400)
          .type('html')
          .send(oauthErrorHtml(base, 'state 校验失败或已过期（10 分钟有效），请重新发起登录。'));
        return;
      }

      try {
        // 若本次是「完成 MCP 授权」的子流程，state 里带着原始授权请求票据：
        // 先还原并复核（client / redirect_uri / resource），再交换 GitHub 令牌、签发授权码、
        // 渲染「正在跳回客户端」页。先校验票据可避免无谓的 GitHub 交换。
        if (st.authorize) {
          const t = open<AuthorizeTicket>('authorize', st.authorize);
          if (!t) {
            res
              .status(400)
              .type('html')
              .send(oauthErrorHtml(base, '授权票据无效或已过期，请重新发起登录。'));
            return;
          }
          const client = readClient(t.clientId);
          if (!client || !redirectUriAllowed(client, t.redirectUri)) {
            res
              .status(400)
              .type('html')
              .send(oauthErrorHtml(base, '授权票据中的客户端或回调地址不合法。'));
            return;
          }
          if (t.resource !== canonicalResourceUri(base)) {
            res
              .status(400)
              .type('html')
              .send(oauthErrorHtml(base, '授权票据中的 resource 与本服务不符。'));
            return;
          }
          const p: AuthorizeParams = {
            clientId: t.clientId,
            redirectUri: t.redirectUri,
            state: t.state,
            codeChallenge: t.codeChallenge,
            scope: t.scope,
            resource: t.resource,
          };
          const { user } = await exchangeAndLogin(code);
          res.status(200).type('html').send(completeAuthorize(base, p, user));
          return;
        }

        // 无票据：保持原有「GitHub 登录成功」页（向后兼容独立 GitHub 登录场景）
        const { user, token } = await exchangeAndLogin(code);
        res.type('html').send(oauthSuccessHtml(user, token, base));
      } catch (err) {
        // 网络类错误要翻译成「部署环境未放行 github.com」，否则用户会一直去查 Client ID / 回调地址
        const msg = humanizeOAuthError(err);
        res.status(500).type('html').send(oauthErrorHtml(base, `GitHub OAuth 失败：${msg}`));
      }
    }),
  );

  // 用户 Profile
  app.use(createProfileRouter());

  // Admin 管理端
  app.use(createAdminRouter());

  // ---- 授权发现（MCP Authorization Discovery）----
  // 客户端收到 401 后会读 WWW-Authenticate 里的 resource_metadata，再按 RFC 8414 找授权服务器。
  // 两个路径都要挂：canonical URI 是 <base>/mcp（带路径），按 RFC 9728 §3.1 要插在 host 与 path
  // 之间，所以主用地址带 /mcp 后缀；根路径那份是给把 canonical 当成纯 origin 的客户端兜底。
  app.get(
    WELL_KNOWN.protectedResource,
    allowPublicCors,
    (req: Request, res: Response) => {
      res.json(protectedResourceMetadata(deriveBase(req)));
    },
  );
  app.get(
    `${WELL_KNOWN.protectedResource}${MCP_PATH}`,
    allowPublicCors,
    (req: Request, res: Response) => {
      res.json(protectedResourceMetadata(deriveBase(req)));
    },
  );
  app.get(
    WELL_KNOWN.authorizationServer,
    allowPublicCors,
    (req: Request, res: Response) => {
      res.json(authorizationServerMetadata(deriveBase(req)));
    },
  );
  app.options(
    [WELL_KNOWN.protectedResource, WELL_KNOWN.authorizationServer, WELL_KNOWN.openidConfiguration],
    allowPublicCors,
  );
  // OIDC 发现别名：内容与 RFC 8414 那份一致（本服务就是自己的授权服务器）
  app.get(
    WELL_KNOWN.openidConfiguration,
    allowPublicCors,
    (req: Request, res: Response) => {
      res.json(authorizationServerMetadata(deriveBase(req)));
    },
  );

  // ---- OAuth 2.1 端点（DCR / 授权 / 令牌）----
  // 顺序无关紧要，但必须早于 404 兜底。三者都允许任意来源读取：客户端是浏览器里跑的
  // JS（Inspector、Web 版），没有 CORS 头 POST /oauth/register 会直接失败。
  app.use(createRegisterRouter());
  app.use(createAuthorizeRouter());
  app.use(createTokenRouter());
  app.use(createWeb3Router());

  // ---- MCP Streamable HTTP 端点（无状态模式）----
  // 多副本部署下内存会话无法跨副本共享，因此每次请求都新建一个独立的 transport + McpServer
  // （sessionIdGenerator 留空 = 关闭会话管理）。配合无状态 JWT 鉴权，任意副本都能独立处理。
  // 鉴权：默认要求登录，未携带有效令牌直接 401 + WWW-Authenticate（见下方 requireAuthForMcp 分支）；
  // 设 MCP_DEMO_REQUIRE_AUTH=off 可恢复旧的匿名握手（user 为 null，由工具返回注册引导）。
  const handleMcp = wrap(async (req: Request, res: Response) => {
    // 无状态模式下 GET /mcp 用于建立 SSE 流（客户端接收服务端主动消息，如 notifications/*），
    // DELETE /mcp 用于终止会话。过去为「防止常驻 SSE 连接累积」显式返回 405，但官方 SDK 的
    // StreamableHTTPClientTransport 在初始化后会尝试 GET /mcp 打开 SSE 流：收到 405 虽被
    // 「静默忽略」（视为服务端不支持 SSE），浏览器却仍会在 console 打印红字 net::ERR_ABORTED 405，
    // 看起来像故障。这里改为把 GET/DELETE 也交给 StreamableHTTPServerTransport，由它按规范返回
    // 200 (text/event-stream) / 406 等，既消除误报，又兼容需要 SSE 的客户端；无状态 + 无会话
    // 意味着多副本间无需共享 SSE 状态，单条流空闲时随客户端断开自动回收（见下方 res.on('close')）。
    const user = authenticateUserRequest(req);
    const base = deriveBase(req);

    // —— 标准 MCP 授权发现：未鉴权默认 401；客户端可指定返回码 ——
    // 默认（不带头）按 MCP 标准返回 401 + WWW-Authenticate，让客户端（Codex / Claude Desktop /
    // Cursor 等）据此启动 OAuth 发现；永远返回 200 会让客户端不触发登录发现。
    // 客户端若想「先装后登录」，可带请求头 `MCP-Unauthorized-Status: 200`：此时可匿名请求
    // （握手/发现/公开工具 server_info|login|register_user）放行，不可匿名的（受保护工具）返回
    // 200 + 引导文案。仅通知类（notifications/*，无响应、本就不要求鉴权）两种模式都放行。
    // 用 MCP_DEMO_REQUIRE_AUTH=off 可恢复完全匿名逃生通道。
    if (req.method === 'POST' && !user && requireAuthForMcp()) {
      const anonMode = getUnauthorizedStatus(req) === 200;
      const allowed = isNotificationOnly(req.body) || (anonMode && isAnonymousEligible(req.body));
      if (!allowed) {
        const status = anonMode ? 200 : 401;
        res
          .status(status)
          .setHeader('WWW-Authenticate', wwwAuthenticate(base))
          .json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message:
                '需要登录后才能调用受保护工具（whoami / my_stats / search_repos 等）。' +
                '可先调用 login 工具获取登录入口，或调用 register_user 一键注册拿到令牌；' +
                `也可按 WWW-Authenticate 头里的 resource_metadata 走标准 OAuth 2.1 流程，或打开 ${base}/setup 查看接入说明。`,
            },
            id: null,
          });
        return;
      }
      // anonMode 且可匿名：作为匿名请求继续执行（user 保持 null，由公开工具返回登录入口/数据）
    }

    // —— RFC 8707：校验令牌受众（aud） ——
    // 令牌签发给别的资源时**必须返回 403，绝不能返回 401**。官方 SDK 有熔断：
    // `_hasCompletedAuthFlow` 置位后再收到 401 会直接抛错而不是重跑一遍流程，
    // 于是「受众不符」这个不可恢复的错误会被伪装成「还没登录」，用户看到的是死循环。
    if (user) {
      const token = resolveUserToken(req);
      const aud = token ? auth.readTokenAudience(token) : null;
      // null = 老令牌没有 aud 声明，祖父条款放行；undefined = 校验失败（authenticate()
      // 已通过所以到不了这里），保险起见同样拒绝。
      const audOk = aud === null || aud === canonicalResourceUri(base);
      if (!audOk) {
        res
          .status(403)
          .setHeader(
            'WWW-Authenticate',
            `Bearer error="insufficient_scope", resource_metadata="${protectedResourceMetadataUrl(
              base,
            )}", scope="${OAUTH_SCOPE}"`,
          )
          .json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message:
                `令牌的受众（aud）是 ${String(aud)}，但本服务的 canonical resource 是 ${canonicalResourceUri(
                  base,
                )}。请重新走一次授权流程获取绑定本资源的令牌。`,
            },
            id: null,
          });
        return;
      }
    }

    // 跨副本物化：JWT 是无状态的，在别的副本注册的用户本副本内存里没有。
    // 流量打到哪个副本，就在哪个副本补全一份，让 admin 用户列表逐步完整。
    if (user) {
      try {
        store.upsertById(user);
      } catch (err) {
        console.error('[mcp-demo] 用户物化失败：', err);
      }
    }

    await baseUrlContext.run(base, () =>
      authContext.run(user, async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // 无状态：不维护会话
          enableJsonResponse: true, // 请求/响应 JSON，便于客户端与测试
        });

        // 调用统计埋点。
        // 必须**在 server.connect() 之前**设置 onmessage：Protocol.connect 会读取已有的
        // onmessage 并链式包装（protocol.js: `const _onmessage = this._transport?.onmessage`），
        // 这样我们的处理会先执行，且不破坏协议逻辑。
        // 相比解析 req.body 的好处：批量数组自动覆盖、不会把 400/406/415 的垃圾请求算进来、
        // 消息已通过 JSONRPCMessageSchema 校验、同步执行无需等待。
        // 注意：record 内部绝不能抛异常 —— SDK 把 handleRequest 整体包在 try/catch 里，
        // 抛出会被吞掉并转成 400 Parse error。
        const prevOnMessage = transport.onmessage;
        transport.onmessage = (message, extra) => {
          stats.record(message, user);
          prevOnMessage?.(message, extra);
        };

        // 统计错误响应数
        type SendFn = (message: unknown, options?: unknown) => Promise<void>;
        const originalSend = transport.send.bind(transport) as unknown as SendFn;
        (transport as unknown as { send: SendFn }).send = (message, options) => {
          stats.recordResponse(message);
          return originalSend(message, options);
        };

        const server = createMcpServer();
        await server.connect(transport);
        // 用 close 而非 finish：客户端提前断开时 finish 不会触发，transport 永不释放
        res.on('close', () => {
          transport.close().catch(() => undefined);
        });
        await transport.handleRequest(req, res, req.body);
      }),
    );
  });

  // 预检 + 实际响应都要带 CORS 头：浏览器端 MCP 客户端（aiaw.app、Inspector 等）从别的
  // origin 打 /mcp 时，若响应缺 Access-Control-Allow-Origin 会直接被拦截（401 发现流程也起不来）。
  // allowPublicCors 对非 OPTIONS 请求会 next()，不影响原鉴权逻辑；端点本就是公开可发现，沿用 * 策略。
  app.options('/mcp', allowPublicCors);
  app.post('/mcp', allowPublicCors, handleMcp);
  app.get('/mcp', allowPublicCors, handleMcp);
  app.delete('/mcp', allowPublicCors, handleMcp);

  // 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Not Found: ${req.method} ${req.path}` });
  });

  // 错误兜底。Express 4 不会捕获 async handler 的 rejection，
  // 所有 async 路由都必须用 wrap() 包一层把异常送到这里，否则会变成 unhandledRejection 并崩进程。
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[mcp-demo] 未处理错误：', err);
    if (res.headersSent) return;
    res.status(500).type('text/plain; charset=utf-8').send(`服务器内部错误：${msg}`);
  });

  return app;
}

function oauthErrorHtml(base: string, message: string): string {
  return page({
    title: 'GitHub 登录失败',
    base,
    body: `
<h1>GitHub 登录失败</h1>
${notice(esc(message))}
<p>请确认 Admin 管理端 → GitHub 设置里的 Client ID / Secret 正确，且 GitHub OAuth App 的回调地址与 redirect_uri 完全一致。</p>
<div class="row"><a class="btn alt" href="${esc(base)}/auth/github">重试</a>
<a class="btn" href="${esc(base)}/">返回首页</a></div>
`,
  });
}
