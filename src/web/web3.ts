/**
 * web3 钱包登录的 HTTP 端点（公开、允许跨域）：
 *   GET  /web3/nonce?address=0x...&authorize=<ticket>   领取一次性挑战与待签名文案
 *   POST /web3/verify                                   { address, signature, authorize? }
 *
 * 这两个端点与 /register 一样属于「公开注册入口」，不经过 /mcp 的鉴权闸门。
 *
 * authorize 票据（可选）：来自 /oauth/authorize 登录页的「用钱包签名登录并授权」入口。
 * 带上它时，校验签名成功后会像 OAuth 一样签发授权码并回跳发起方（redirect_uri），
 * 而非返回 JSON 令牌——这样 MCP 客户端（Codex / Claude Desktop 等）登录完能直接回到本地监听。
 * 不带时维持原行为：返回令牌，由前端跳到 /web3?token=... 结果页。
 */
import { Router, type Request, type Response } from 'express';
import { allowPublicCors, deriveBase, setUserTokenCookie, wrap } from './http.js';
import { AuthError } from '../auth/manager.js';
import * as web3 from '../auth/web3.js';
import { completeAuthorizeFromTicket } from '../oauth/complete.js';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function createWeb3Router(): Router {
  const router = Router();

  router.options('/web3/nonce', allowPublicCors);
  router.get(
    '/web3/nonce',
    allowPublicCors,
    wrap((req: Request, res: Response) => {
      const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
      if (!ADDRESS_RE.test(address)) {
        res.status(400).json({
          error: 'invalid_address',
          error_description: 'address 必须为 0x 开头的 40 位十六进制以太坊地址。',
        });
        return;
      }
      const { nonce, message } = web3.getNonce(address);
      const authorize =
        typeof req.query.authorize === 'string' ? req.query.authorize : undefined;
      const body: Record<string, string> = { address, nonce, message };
      // 原样回显 authorize 票据，便于调用方在下一步 /web3/verify 中继续携带
      if (authorize) body.authorize = authorize;
      res.status(200).json(body);
    }),
  );

  router.options('/web3/verify', allowPublicCors);
  router.post(
    '/web3/verify',
    allowPublicCors,
    wrap((req: Request, res: Response) => {
      const body = (req.body ?? {}) as { address?: string; signature?: string; authorize?: string };
      const address = typeof body.address === 'string' ? body.address.trim() : '';
      const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
      const authorize = typeof body.authorize === 'string' ? body.authorize : undefined;
      if (!ADDRESS_RE.test(address)) {
        res.status(400).json({
          error: 'invalid_address',
          error_description: 'address 必须为 0x 开头的 40 位十六进制以太坊地址。',
        });
        return;
      }
      if (!signature) {
        res.status(400).json({ error: 'invalid_signature', error_description: '缺少 signature。' });
        return;
      }
      try {
        const result = web3.verifyWeb3Signature(address, signature);
        // 钱包登录同样落会话 Cookie，之后进 /profile、/recharge 自动保持登录
        setUserTokenCookie(req, res, result.token);
        // OAuth 授权流程：签发授权码并回跳发起方（与账号密码 / GitHub 登录共用最后一跳）
        const oauthHtml = completeAuthorizeFromTicket(result, deriveBase(req), authorize);
        if (oauthHtml) {
          res.status(200).type('html').send(oauthHtml);
          return;
        }
        res.status(200).json({
          token: result.token,
          user: {
            id: result.user.id,
            username: result.user.username,
            provider: result.user.provider,
            walletAddress: result.user.walletAddress ?? null,
          },
        });
      } catch (err) {
        const status = err instanceof AuthError ? err.status : 400;
        const msg = err instanceof Error ? err.message : '验证失败';
        res.status(status).json({ error: 'web3_verify_failed', error_description: msg });
      }
    }),
  );

  return router;
}
