/**
 * 动态客户端注册端点 `POST /oauth/register`（RFC 7591）。
 *
 * 规范里 DCR 是 SHOULD，但实践上是 MUST：Codex / Claude Desktop / MCP Inspector 每次
 * 启动都是全新的、没有预置凭据的客户端，拿不到 client_id 就根本走不到 /oauth/authorize。
 *
 * 本端点**不需要任何鉴权** —— RFC 7591 §3 只要求「可选的保护」，而这里注册的是
 * 公开客户端（`token_endpoint_auth_method: none`），凭据本身不是秘密。
 * 真正的信任边界在 redirect_uri：授权码只会回注册过的地址（见 clients.ts 的 uriKey 比对）。
 */
import { Router, type Request, type Response } from 'express';
import { registerClient } from './clients.js';
import { allowPublicCors, wrap } from '../web/http.js';

/** RFC 7591 §3.2.1：注册响应里的标准错误码 */
function registrationError(
  res: Response,
  status: number,
  code: string,
  description: string,
): void {
  res
    .status(status)
    .setHeader('Cache-Control', 'no-store')
    .json({ error: code, error_description: description });
}

export function createRegisterRouter(): Router {
  const router = Router();

  router.options('/oauth/register', allowPublicCors);

  router.post(
    '/oauth/register',
    allowPublicCors,
    wrap((req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      // 只接受公开客户端。要求 client_secret 的客户端在本服务没有对应凭据可发，
      // 与其静默降级成 none，不如直接明说，省去客户端拿着错的假设往下走。
      const authMethod = body.token_endpoint_auth_method;
      if (authMethod !== undefined && authMethod !== 'none') {
        registrationError(
          res,
          400,
          'invalid_client_metadata',
          '仅支持 token_endpoint_auth_method=none（公开客户端）。',
        );
        return;
      }

      let client: ReturnType<typeof registerClient>;
      try {
        client = registerClient({
          redirect_uris: body.redirect_uris,
          client_name: body.client_name,
          grant_types: body.grant_types,
          response_types: body.response_types,
          scope: body.scope,
        });
      } catch (err) {
        registrationError(
          res,
          400,
          'invalid_redirect_uri',
          err instanceof Error ? err.message : 'redirect_uris 非法。',
        );
        return;
      }

      res
        .status(201)
        .setHeader('Cache-Control', 'no-store')
        .json({
          ...client,
          // RFC 7591 §3.2.1 要求下发注册时间
          client_id_issued_at: Math.floor(Date.now() / 1000),
        });
    }),
  );

  return router;
}
