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
 *    多副本部署时回调极大概率落到另一个副本 → session 读不到 → 「state 校验失败」，
 *    OAuth 成功率约 1/k。改成 JWT 后与整体无状态架构一致，任意副本都能校验。
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

/** 生成防 CSRF 的 state（自签名 JWT，10 分钟有效，跨副本可校验） */
export function createState(): string {
  return jwt.sign({ nonce: randomUUID(), purpose: 'github-oauth' }, config.jwtSecret, {
    expiresIn: '10m',
  });
}

/** 校验回调带回的 state */
export function verifyState(state: string | undefined): boolean {
  if (!state) return false;
  try {
    const payload = jwt.verify(state, config.jwtSecret) as jwt.JwtPayload;
    return payload.purpose === 'github-oauth';
  } catch {
    return false;
  }
}

/** 生成 GitHub 授权跳转地址（state 用于防 CSRF）。 */
export function getAuthorizationUrl(state: string): string {
  const g = getGithub();
  return client().authorizeURL({
    redirect_uri: g.redirectUri,
    scope: g.scope,
    state,
  });
}

/** 用回调 code 换 token，并拉取 GitHub 用户、落地为本地账号。 */
export async function exchangeAndLogin(code: string): Promise<OAuthResult> {
  const g = getGithub();
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
