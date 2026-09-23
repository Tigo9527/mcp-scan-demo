/**
 * GitHub OAuth 2.0 接入。
 * 使用 simple-oauth2（标准库）完成授权跳转与令牌交换，
 * 回调后用 GitHub REST API 拉取用户并落地为本地用户。
 *
 * 两个关键改造：
 * 1. **凭据每次现读**：初版在模块加载时就把 clientId/secret 烘焙进单例，
 *    导致 admin 后台改完必须重启才生效。现在改为每次调用时按 `getGithub()`
 *    现场构造客户端（simple-oauth2 构造函数无网络 I/O，开销可忽略）。
 * 2. **state 改为自签名 JWT**：初版把 state 存在 express-session（MemoryStore）里，
 *    内存里的 session 随时可能读不到（进程重启即丢失）→ 「state 校验失败」。
 *    改成 JWT 后与整体无状态架构一致，重启后也能校验。
 */
import { AuthorizationCode } from 'simple-oauth2';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getGithub } from '../settings.js';
import * as store from './store.js';
import { issueToken } from './manager.js';

export interface OAuthResult {
  user: store.User;
  token: string;
}

function client(): AuthorizationCode {
  const g = getGithub();
  return new AuthorizationCode({
    client: {
      id: g.clientId,
      secret: g.clientSecret,
    },
    auth: {
      tokenHost: 'https://github.com',
      tokenPath: '/login/oauth/access_token',
      authorizePath: '/login/oauth/authorize',
    },
  });
}

/**
 * 生成防 CSRF 的 state（自签名 JWT，10 分钟有效，服务端无需保存）。
 *
 * 若传入 `authorizeTicket`（加密票据），会一并塞进 state：GitHub 回调只回 `code` + `state`，
 * 所以「原始授权请求」（client_id / redirect_uri / PKCE / state / resource）必须靠 state 带回来，
 * 否则登录成功后不知道要回跳到哪个客户端的 callback，Codex 这类命令行客户端就会一直等不到回调。
 */
export function createState(authorizeTicket?: string): string {
  const payload: jwt.JwtPayload = { nonce: randomUUID(), purpose: 'github-oauth' };
  if (authorizeTicket) payload.authorize = authorizeTicket;
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '10m' });
}

/**
 * 校验回调带回的 state。
 * 返回 `{ ok, authorize }`：`authorize` 为随授权流程一并带过来的加密票据（若有），
 * 用于把原始授权请求穿过 GitHub 这一跳。
 */
export function verifyState(state: string | undefined): { ok: boolean; authorize?: string } {
  if (!state) return { ok: false };
  try {
    const payload = jwt.verify(state, config.jwtSecret) as jwt.JwtPayload;
    if (payload.purpose !== 'github-oauth') return { ok: false };
    const authorize = typeof payload.authorize === 'string' ? payload.authorize : undefined;
    return { ok: true, authorize };
  } catch {
    return { ok: false };
  }
}

/** 生成 GitHub 授权跳转地址（state 用于防 CSRF）。 */
export function getAuthorizationUrl(state: string, redirectUriFallback?: string): string {
  const g = getGithub(redirectUriFallback);
  return client().authorizeURL({
    redirect_uri: g.redirectUri,
    scope: g.scope,
    state,
  });
}

/** 用回调 code 换 token，并拉取 GitHub 用户、落地为本地账号。 */
export async function exchangeAndLogin(code: string, redirectUriFallback?: string): Promise<OAuthResult> {
  const g = getGithub(redirectUriFallback);
  const tokenResponse = await client().getToken({
    code,
    redirect_uri: g.redirectUri,
  });
  const accessToken = tokenResponse.token.access_token as string;

  const me = (await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mcp-demo',
    },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`GitHub user API ${r.status}`);
    return r.json();
  })) as {
    login: string;
    email: string | null;
    name?: string;
  };

  const user = store.upsertGitHubUser({
    githubLogin: me.login,
    email: me.email,
    githubToken: accessToken,
  });

  return { user, token: issueToken(user) };
}

/**
 * 把 OAuth 交换阶段的底层错误翻译成**可操作**的提示。
 *
 * 网络类错误单独识别：部署环境常对出站做域名白名单，github.com 被黑洞时底层只抛
 * "Client network socket disconnected before secure TLS connection was established"
 * 这类与配置无关的信息，极易被误读成 Client ID / 回调地址填错。
 */
export function humanizeOAuthError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (
    /socket|TLS|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|disconnected|network|fetch failed/i.test(
      raw,
    )
  ) {
    return `无法与 GitHub 建立连接（${raw}）。这通常是**部署环境未放行到 github.com 的出站 HTTPS**，与 Client ID / 回调地址无关。请确认该环境可访问 https://github.com（必要时配置出口代理 / 加域名白名单）；GitHub 登录与 search_repos 都依赖这条出站连接。`;
  }
  return raw;
}

/** GitHub OAuth 是否已配置（读运行时设置，admin 改完立即反映） */
export function isGitHubConfigured(): boolean {
  return getGithub().configured;
}
