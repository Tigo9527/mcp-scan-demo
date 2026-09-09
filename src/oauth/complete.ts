/**
 * 登录/注册成功后，若处于 OAuth 授权流程（携带 authorize 票据），则还原并复核原始授权请求、
 * 签发授权码并回跳客户端（与 GitHub 回调路径共用 completeAuthorize + 同一套 client/redirect_uri/resource 复核）；
 * 不在授权流程中则返回 null，由调用方展示普通令牌页。
 *
 * 账号密码注册、一键注册、GitHub 回调、web3 签名登录都走这里，保证最后一跳（把 code 送回客户端本地监听）一致，
 * 且都带「手动复制回调 URL」的兜底。
 */
import { type AuthorizeParams, type AuthorizeTicket, completeAuthorize } from './authorize.js';
import { readClient, redirectUriAllowed } from './clients.js';
import { canonicalResourceUri } from './metadata.js';
import { open } from './tickets.js';
import type { AuthResult } from '../auth/manager.js';

export function completeAuthorizeFromTicket(
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
