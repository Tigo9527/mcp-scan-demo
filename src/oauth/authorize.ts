/**
 * 授权端点 `/oauth/authorize`。
 *
 * 流程：客户端带着 DCR 拿到的 client_id + PKCE challenge 把用户浏览器导航到这里 →
 * 校验参数 → 展示登录页 → 用户提交账号密码 → 校验通过后签发一次性授权码 →
 * 302 回客户端的 redirect_uri。
 *
 * 刻意**不**用会话：GET 渲染表单、POST 一次性完成登录与授权，参数全部经隐藏字段往返，
 * 并在 POST 时**重新完整校验**（隐藏字段是用户可篡改的，redirect_uri 必须仍属于该 client）。
 * 这样多副本部署下无需共享任何登录态。
 *
 * 暂只支持账号密码登录：GitHub 在本部署环境出站被封，接进来只会给一个点不动的按钮。
 */
import { Router, type Request, type Response } from 'express';
import * as auth from '../auth/manager.js';
import * as store from '../auth/store.js';
import { readClient, redirectUriAllowed } from './clients.js';
import {
  canonicalResourceUri,
  MCP_PATH,
  OAUTH_SCOPE,
} from './metadata.js';
import { seal } from './tickets.js';
import { deriveBase, requireSameOrigin, wrap } from '../web/http.js';
import { authorizeCompleteHtml, card, esc, notice, page } from '../web/layout.js';
import { isGitHubConfigured } from '../auth/github.js';

/** 授权码有效期。短时效是无共享存储时防重放的主要手段之一（另一道是 PKCE）。 */
const CODE_TTL_SECONDS = 60;

/** 授权请求票据有效期：要穿过 GitHub 这一跳（用户可能慢慢点），给到 10 分钟。 */
const AUTHORIZE_TICKET_TTL_SECONDS = 600;

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

/**
 * 原始授权请求快照，用加密票据穿过 GitHub 流程。
 * 全是公开 OAuth 参数（code_challenge 是 S256 哈希，非 verifier），经 AES-256-GCM 加密携带，无泄露风险。
 */
export interface AuthorizeTicket {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

type Validation =
  | { ok: true; params: AuthorizeParams }
  | { ok: false; error: string; description: string; redirectTo?: string; state?: string };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function validate(query: Record<string, unknown>, base: string): Validation {
  const clientId = str(query.client_id);
  const redirectUri = str(query.redirect_uri);
  const state = str(query.state) || undefined;

  const client = readClient(clientId);
  if (!client) {
    return { ok: false, error: 'invalid_client', description: 'client_id 无效或已损坏。' };
  }
  if (!redirectUri || !redirectUriAllowed(client, redirectUri)) {
    return {
      ok: false,
      error: 'invalid_request',
      description: 'redirect_uri 与注册信息不匹配。',
    };
  }
  // 校验通过后才允许把错误回传给该地址；否则一律渲染错误页，避免变成开放重定向
  const redirectTo = redirectUri;

  if (str(query.response_type) !== 'code') {
    return {
      ok: false,
      error: 'unsupported_response_type',
      description: '仅支持 response_type=code。',
      redirectTo,
      state,
    };
  }

  const challenge = str(query.code_challenge);
  const method = str(query.code_challenge_method);
  if (!challenge || method !== 'S256') {
    return {
      ok: false,
      error: 'invalid_request',
      description: '缺少 code_challenge，或 code_challenge_method 不是 S256（OAuth 2.1 要求 PKCE）。',
      redirectTo,
      state,
    };
  }

  const canonical = canonicalResourceUri(base);
  const resource = str(query.resource) || canonical;
  if (resource !== canonical) {
    return {
      ok: false,
      error: 'invalid_target',
      description: `resource 必须是 ${canonical}`,
      redirectTo,
      state,
    };
  }

  return {
    ok: true,
    params: {
      clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      scope: str(query.scope) || OAUTH_SCOPE,
      resource,
    },
  };
}

function redirectError(base: string, v: Extract<Validation, { ok: false }>): string | null {
  if (!v.redirectTo) return null;
  const u = new URL(v.redirectTo);
  u.searchParams.set('error', v.error);
  u.searchParams.set('error_description', v.description);
  if (v.state) u.searchParams.set('state', v.state);
  void base;
  return u.toString();
}

function errorHtml(base: string, title: string, message: string): string {
  return page({
    title,
    base,
    body: `
<h1>${esc(title)}</h1>
${notice(esc(message))}
<div class="row"><a class="btn alt" href="${esc(base)}/setup">查看接入说明</a>
<a class="btn" href="${esc(base)}/">返回首页</a></div>
`,
  });
}

function authorizeHtml(
  base: string,
  p: AuthorizeParams,
  clientName: string,
  error?: string,
  authorizeTicket?: string,
): string {
  const hidden = [
    ['client_id', p.clientId],
    ['redirect_uri', p.redirectUri],
    ['state', p.state ?? ''],
    ['code_challenge', p.codeChallenge],
    ['code_challenge_method', 'S256'],
    ['resource', p.resource],
    ['scope', p.scope],
    ['response_type', 'code'],
  ]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');

  // 仅当 GitHub 已配置、且本次是「完成 MCP 授权」的子流程（带 authorize 票据）时，
  // 才展示「通过 GitHub 登录」入口。票据里封着原始授权请求，穿过 GitHub 后用于回跳客户端。
  const githubLink =
    isGitHubConfigured() && authorizeTicket
      ? `<div class="row" style="margin-top:16px">
<a class="btn alt" href="${esc(base)}/auth/github?authorize=${esc(authorizeTicket)}">通过 GitHub 登录并授权</a>
</div>`
      : '';

  return page({
    title: '授权登录',
    base,
    body: `
<h1>🔐 授权登录</h1>
${card(`
<p><b>${esc(clientName)}</b> 请求访问你的 MCP 服务（端点 <code>${esc(base)}${MCP_PATH}</code>）。</p>
<p class="muted">权限范围：<code>${esc(p.scope)}</code> · 授权码 60 秒内有效 · 本服务不会把你的口令交给该客户端。</p>
`)}

${error ? notice(esc(error)) : ''}

<form method="post" action="${esc(base)}/oauth/authorize">
${hidden}
<label for="username">用户名</label>
<input id="username" name="username" autocomplete="username" required>
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="row" style="margin-top:16px">
<button class="btn" type="submit">登录并授权</button>
<a class="btn alt" href="${esc(base)}/register">注册新账号</a>
</div>
</form>
${githubLink}
<p class="muted">还没有账号？先去 <a href="${esc(base)}/register">注册</a>，再回到 MCP 客户端重试。</p>
`,
  });
}

/**
 * 公共收尾：签发一次性授权码并渲染「正在跳回客户端」页。
 * 账号密码与 GitHub 两条登录路径都走这里，保证最后一跳（把 code 送回客户端本地监听）一致，
 * 且都带「手动复制回调 URL」的兜底。
 */
export function completeAuthorize(base: string, p: AuthorizeParams, user: store.User): string {
  const code = seal(
    'code',
    {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      scope: p.scope,
      resource: p.resource,
      sub: user.id,
      username: user.username,
      email: user.email,
      provider: user.provider,
      createdAt: user.createdAt,
    },
    CODE_TTL_SECONDS,
  );

  const target = new URL(p.redirectUri);
  target.searchParams.set('code', code);
  if (p.state) target.searchParams.set('state', p.state);
  return authorizeCompleteHtml(base, target.toString());
}

export function createAuthorizeRouter(): Router {
  const router = Router();

  router.get(
    '/oauth/authorize',
    wrap(async (req: Request, res: Response) => {
      const base = deriveBase(req);
      const v = validate(req.query as Record<string, unknown>, base);
      if (!v.ok) {
        const url = redirectError(base, v);
        if (url) {
          res.redirect(302, url);
          return;
        }
        res.status(400).type('html').send(errorHtml(base, '授权请求无效', v.description));
        return;
      }
      const client = readClient(v.params.clientId)!;
      // 把原始授权请求封成加密票据，供「通过 GitHub 登录」链接穿过 GitHub 流程后回跳客户端。
      const authorizeTicket = seal(
        'authorize',
        {
          clientId: v.params.clientId,
          redirectUri: v.params.redirectUri,
          state: v.params.state,
          codeChallenge: v.params.codeChallenge,
          scope: v.params.scope,
          resource: v.params.resource,
        } satisfies AuthorizeTicket,
        AUTHORIZE_TICKET_TTL_SECONDS,
      );
      res
        .type('html')
        .send(
          authorizeHtml(
            base,
            v.params,
            client.client_name ?? '未命名 MCP 客户端',
            undefined,
            authorizeTicket,
          ),
        );
    }),
  );

  router.post(
    '/oauth/authorize',
    requireSameOrigin,
    wrap(async (req: Request, res: Response) => {
      const base = deriveBase(req);
      const v = validate(req.body as Record<string, unknown>, base);
      if (!v.ok) {
        const url = redirectError(base, v);
        if (url) {
          res.redirect(302, url);
          return;
        }
        res.status(400).type('html').send(errorHtml(base, '授权请求无效', v.description));
        return;
      }
      const p = v.params;
      const client = readClient(p.clientId)!;

      const username = str((req.body as Record<string, unknown>).username);
      const password = str((req.body as Record<string, unknown>).password);

      let user: store.User;
      try {
        user = auth.loginWithPassword(username, password).user;
      } catch (err) {
        const msg =
          err instanceof auth.AuthError && err.status === 400 ? err.message : '用户名或密码错误';
        res.status(401).type('html').send(
          authorizeHtml(base, p, client.client_name ?? '未命名 MCP 客户端', msg),
        );
        return;
      }

      // 渲染「正在跳回客户端」页（含自动跳转 + 手动兜底），两条路径统一，替换裸 302。
      res.status(200).type('html').send(completeAuthorize(base, p, user));
    }),
  );

  return router;
}
