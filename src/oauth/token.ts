/**
 * 令牌端点 `/oauth/token`（RFC 6749 §5 / RFC 7636 PKCE / RFC 8707 resource）。
 *
 * 支持两种 grant：`authorization_code`（强制 PKCE S256）与 `refresh_token`。
 * 全部状态都在票据里，服务端只额外维护一张**尽力而为**的「已用授权码」表：
 * 多副本下没有共享存储，这张表只覆盖本副本，真正的重放防线是
 * 「60 秒有效期 + PKCE」—— 攻击者必须同时截获授权码与 code_verifier。
 */
import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import * as auth from '../auth/manager.js';
import * as store from '../auth/store.js';
import { readClient, redirectUriAllowed } from './clients.js';
import { canonicalResourceUri } from './metadata.js';
import { open } from './tickets.js';
import { deriveBase, wrap } from '../web/http.js';

/** jti → 过期时间（毫秒）。仅本副本有效，见文件头说明。 */
const usedCodes = new Map<string, number>();

function pruneUsedCodes(): void {
  if (usedCodes.size < 1000) return;
  const now = Date.now();
  for (const [jti, exp] of usedCodes) {
    if (exp <= now) usedCodes.delete(jti);
  }
}

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

/** PKCE：S256 校验（RFC 7636） */
function pkceOk(verifier: string, challenge: string): boolean {
  const computed = b64u(createHash('sha256').update(verifier, 'utf8').digest());
  return computed === challenge;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function oauthError(
  res: Response,
  status: number,
  code: string,
  description: string,
): void {
  res
    .status(status)
    .setHeader('Cache-Control', 'no-store')
    .setHeader('Pragma', 'no-cache')
    .json({ error: code, error_description: description });
}

/** 按 id 找用户；跨副本可能查不到（用户是在别的副本注册的），退回用票据里的声明重建。 */
function resolveUser(data: {
  sub?: string;
  username?: string;
  email?: string | null;
  provider?: string;
  createdAt?: string;
}): store.User | null {
  if (!data.sub) return null;
  const existing = store.getUser(data.sub);
  if (existing) return existing;
  if (!data.username) return null;
  return {
    id: data.sub,
    username: data.username,
    email: data.email ?? null,
    provider: (data.provider as store.User['provider']) ?? 'local',
    createdAt: data.createdAt ?? new Date().toISOString(),
  };
}

export function createTokenRouter(): Router {
  const router = Router();

  router.post(
    '/oauth/token',
    wrap(async (req: Request, res: Response) => {
      const base = deriveBase(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const grant = str(body.grant_type);

      if (grant === 'authorization_code') {
        const code = str(body.code);
        const clientId = str(body.client_id);
        const redirectUri = str(body.redirect_uri);
        const verifier = str(body.code_verifier);

        const data = open<{
          clientId: string;
          redirectUri: string;
          codeChallenge: string;
          scope: string;
          resource: string;
          sub?: string;
          username?: string;
          email?: string | null;
          provider?: string;
          createdAt?: string;
          exp: number;
          jti: string;
        }>('code', code);

        if (!data) {
          oauthError(res, 400, 'invalid_grant', '授权码无效或已过期（60 秒）。');
          return;
        }
        pruneUsedCodes();
        if (usedCodes.has(data.jti)) {
          oauthError(res, 400, 'invalid_grant', '授权码已被使用。');
          return;
        }
        if (data.clientId !== clientId) {
          oauthError(res, 400, 'invalid_grant', '授权码与 client_id 不匹配。');
          return;
        }
        const client = readClient(clientId);
        if (!client) {
          oauthError(res, 400, 'invalid_client', 'client_id 无效。');
          return;
        }
        if (redirectUri !== data.redirectUri || !redirectUriAllowed(client, redirectUri)) {
          oauthError(res, 400, 'invalid_grant', 'redirect_uri 与授权请求不一致。');
          return;
        }
        if (!verifier || !pkceOk(verifier, data.codeChallenge)) {
          oauthError(res, 400, 'invalid_grant', 'code_verifier 校验失败（PKCE S256）。');
          return;
        }
        const resource = str(body.resource) || data.resource;
        if (resource !== canonicalResourceUri(base)) {
          oauthError(res, 400, 'invalid_target', `resource 必须是 ${canonicalResourceUri(base)}`);
          return;
        }

        const user = resolveUser(data);
        if (!user) {
          oauthError(res, 400, 'invalid_grant', '授权码对应的用户不存在。');
          return;
        }

        usedCodes.set(data.jti, data.exp * 1000);
        const { access_token, expires_in } = auth.issueOAuthAccessToken({
          user,
          resource,
          issuer: base,
          scope: data.scope,
          clientId,
        });
        res
          .setHeader('Cache-Control', 'no-store')
          .json({
            access_token,
            token_type: 'Bearer',
            expires_in,
            scope: data.scope,
            refresh_token: auth.issueOAuthRefreshToken({
              user,
              resource,
              issuer: base,
              scope: data.scope,
              clientId,
            }),
          });
        return;
      }

      if (grant === 'refresh_token') {
        const refresh = str(body.refresh_token);
        const clientId = str(body.client_id);
        const r = auth.readOAuthRefreshToken(refresh);
        if (!r) {
          oauthError(res, 400, 'invalid_grant', 'refresh_token 无效或已过期。');
          return;
        }
        if (r.clientId && r.clientId !== clientId) {
          oauthError(res, 400, 'invalid_grant', 'refresh_token 与 client_id 不匹配。');
          return;
        }
        if (r.resource !== canonicalResourceUri(base)) {
          oauthError(res, 400, 'invalid_target', `resource 必须是 ${canonicalResourceUri(base)}`);
          return;
        }
        const user = resolveUser({ sub: r.sub });
        if (!user) {
          oauthError(res, 400, 'invalid_grant', 'refresh_token 对应的用户不存在。');
          return;
        }
        const { access_token, expires_in } = auth.issueOAuthAccessToken({
          user,
          resource: r.resource,
          issuer: base,
          scope: r.scope,
          clientId,
        });
        res.setHeader('Cache-Control', 'no-store').json({
          access_token,
          token_type: 'Bearer',
          expires_in,
          scope: r.scope,
          // 不轮换：无状态方案检测不到旧 refresh_token 是否被重放，轮换反而会更不安全
          refresh_token: refresh,
        });
        return;
      }

      oauthError(res, 400, 'unsupported_grant_type', '支持 authorization_code 与 refresh_token。');
    }),
  );

  return router;
}
