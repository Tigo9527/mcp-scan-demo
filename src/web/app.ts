/**
 * Web 入口：Express 应用。
 * - 门户首页、一键注册、GitHub OAuth 路由
 * - MCP Streamable HTTP 端点（/mcp），带 Bearer 鉴权
 * - Admin 管理端（/admin）与用户 Profile（/profile）
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import * as auth from '../auth/manager.js';
import * as store from '../auth/store.js';
import { authContext, baseUrlContext } from '../auth/context.js';
import { createMcpServer } from '../mcp/server.js';
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
import { authenticateUserRequest, deriveBase, requireSameOrigin, wrap } from './http.js';
import { createAdminRouter } from './admin.js';
import { createProfileRouter } from './profile.js';
import { badge, card, esc, notice, page } from './layout.js';

// ---------- 页面 ----------

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
<h3>④ MCP 端点（可匿名连接，未登录时引导登录）</h3>
<p>Streamable HTTP：<code>${esc(base)}/mcp</code></p>
<p>匿名连接可调用 <code>login</code> 工具获取登录入口；登录后把令牌放到请求头 <code>X-Authorization: Bearer &lt;token&gt;</code> 或 URL 参数 <code>?token=&lt;token&gt;</code>。</p>
<p class="muted">钉钉等 AI Agent 可用「一键注册」（<code>/register?username=alice</code> 或 <code>register_user</code> 工具）自动拿令牌，无需人工填密码。</p>
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

/** 账号密码注册页 */
function registerHtml(base: string, error?: string): string {
  return page({
    title: '注册账号',
    base,
    body: `
<h1>注册账号</h1>
${error ? notice(esc(error)) : ''}
${card(`
<form method="post" action="/register">
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

  // 表单解析只挂在 admin 下（/mcp 用的是 application/json），缩小影响面
  app.use('/admin', express.urlencoded({ extended: false, limit: '32kb' }));

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

  // 注册入口：带 ?username= 走「一键注册」（供钉钉等 Agent 自动注册，行为不变）；
  // 否则渲染账号密码注册页。
  app.get('/register', (req: Request, res: Response) => {
    const base = deriveBase(req);
    const username = req.query.username as string | undefined;
    if (username) {
      const result = auth.registerOneClick({ username, email: req.query.email as string | undefined });
      res.type('html').send(registeredHtml(result, base));
      return;
    }
    res.type('html').send(registerHtml(base));
  });

  // 账号密码注册（POST 表单）。跨站表单防护 + async 兜底。
  app.post(
    '/register',
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireSameOrigin,
    wrap((req: Request, res: Response) => {
      const base = deriveBase(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = String(body.username ?? '');
      const password = String(body.password ?? '');
      try {
        const result = auth.registerWithPassword(username, password);
        res.type('html').send(registeredHtml(result, base));
      } catch (err) {
        const msg = err instanceof auth.AuthError ? err.message : '注册失败，请稍后重试。';
        res.status(err instanceof auth.AuthError ? err.status : 400).type('html').send(registerHtml(base, msg));
      }
    }),
  );

  // 账号密码登录入口
  app.get('/login', (req: Request, res: Response) => {
    res.type('html').send(loginHtml(deriveBase(req)));
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

  // GitHub OAuth：跳转授权（state 为自签名 JWT，跨副本可校验）
  app.get('/auth/github', (req: Request, res: Response) => {
    res.redirect(getAuthorizationUrl(createState()));
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
      if (!verifyState(state)) {
        res
          .status(400)
          .type('html')
          .send(oauthErrorHtml(base, 'state 校验失败或已过期（10 分钟有效），请重新发起登录。'));
        return;
      }

      try {
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

  // ---- MCP Streamable HTTP 端点（无状态模式）----
  // 多副本部署下内存会话无法跨副本共享，因此每次请求都新建一个独立的 transport + McpServer
  // （sessionIdGenerator 留空 = 关闭会话管理）。配合无状态 JWT 鉴权，任意副本都能独立处理。
  // 允许匿名握手：未携带令牌时 user 为 null，由工具（如 login / whoami）负责返回登录引导。
  const handleMcp = wrap(async (req: Request, res: Response) => {
    // 无状态模式下 GET 会建立常驻 SSE 流（含 keep-alive 定时器），客户端或爬虫
    // 反复请求会累积悬挂连接。本服务用 JSON 响应模式，主流客户端只发 POST，故直接拒绝。
    if (req.method !== 'POST') {
      res.status(405).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message:
            '本服务运行在无状态（Streamable HTTP + JSON 响应）模式，/mcp 仅支持 POST。GET/DELETE 会建立常驻 SSE 流，已禁用。',
        },
        id: null,
      });
      return;
    }

    const user = authenticateUserRequest(req);
    // 跨副本物化：JWT 是无状态的，在别的副本注册的用户本副本内存里没有。
    // 流量打到哪个副本，就在哪个副本补全一份，让 admin 用户列表逐步完整。
    if (user) {
      try {
        store.upsertById(user);
      } catch (err) {
        console.error('[mcp-demo] 用户物化失败：', err);
      }
    }

    const base = deriveBase(req);
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

  app.post('/mcp', handleMcp);
  app.get('/mcp', handleMcp);
  app.delete('/mcp', handleMcp);

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
