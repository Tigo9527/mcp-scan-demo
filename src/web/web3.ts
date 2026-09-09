/**
 * web3 钱包登录的 HTTP 端点（公开、允许跨域）：
 *   GET  /web3/nonce?address=0x...   领取一次性挑战与待签名文案
 *   POST /web3/verify                 校验签名并签发令牌 { address, signature }
 *
 * 这两个端点与 /register 一样属于「公开注册入口」，不经过 /mcp 的鉴权闸门。
 */
import { Router, type Request, type Response } from 'express';
import { allowPublicCors, wrap } from './http.js';
import { AuthError } from '../auth/manager.js';
import * as web3 from '../auth/web3.js';

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
      res.status(200).json({ address, nonce, message });
    }),
  );

  router.options('/web3/verify', allowPublicCors);
  router.post(
    '/web3/verify',
    allowPublicCors,
    wrap((req: Request, res: Response) => {
      const body = (req.body ?? {}) as { address?: string; signature?: string };
      const address = typeof body.address === 'string' ? body.address.trim() : '';
      const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
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
