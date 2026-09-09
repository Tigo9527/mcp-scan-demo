/**
 * web3 钱包签名登录（MetaMask 等）。
 *
 * 流程（挑战-应答，防重放）：
 *   1. 客户端用钱包地址 GET /web3/nonce 拿到一次性随机挑战 `nonce` 与待签名 `message`；
 *   2. 客户端用 `personal_sign` 对 `message` 签名；
 *   3. 客户端 POST /web3/verify 带上 `{address, signature}`，服务端用 ethers.verifyMessage
 *      恢复签名者地址，与请求地址比对一致即签发令牌（按钱包地址 find-or-create 用户）。
 *
 * 安全要点：
 *   - 挑战 `nonce` 绑定地址、5 分钟过期、验证成功即作废，避免同一签名被反复重放；
 *   - 后端用服务端保存的 nonce 重建 `message` 再验签，绝不信任客户端传来的 message；
 *   - 仅比对恢复出的地址与请求地址（大小写不敏感），不依赖任何客户端声明。
 *
 * 注意：`nonce` 存于内存（Map），多副本不共享 —— 演示场景足够；生产应换成
 * 带 TTL 的共享存储（Redis）或把 nonce 做成服务端签名令牌（stateless）。
 */
import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import * as auth from './manager.js';
import { AuthError } from './manager.js';
import type { AuthResult } from './manager.js';

/** 挑战有效期 */
const NONCE_TTL_MS = 5 * 60 * 1000;

/** 地址 -> { 挑战, 过期时间 }。演示用内存存储。 */
const nonces = new Map<string, { nonce: string; expiresAt: number }>();

/** 构造待签名文案。前端用它签名，后端用相同入参重建后验签 —— 二者必须逐字节一致。 */
export function buildWeb3Message(address: string, nonce: string): string {
  return [
    'MCP Demo 签名登录',
    '',
    `钱包地址: ${address}`,
    `随机挑战: ${nonce}`,
    '',
    '签名即代表你授权以该钱包身份登录本服务。请勿向他人泄露签名内容。',
  ].join('\n');
}

/** 为某地址签发一次性挑战，返回待签名文案。 */
export function getNonce(address: string): { address: string; nonce: string; message: string } {
  const key = address.toLowerCase();
  const nonce = randomBytes(16).toString('hex');
  // 顺手清理已过期条目，避免内存无限增长
  for (const [k, v] of nonces) {
    if (Date.now() > v.expiresAt) nonces.delete(k);
  }
  nonces.set(key, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
  return { address, nonce, message: buildWeb3Message(address, nonce) };
}

/** 校验签名并签发令牌。地址与签名不匹配或挑战失效均抛 AuthError。 */
export function verifyWeb3Signature(address: string, signature: string): AuthResult {
  const key = address.toLowerCase();
  const entry = nonces.get(key);
  if (!entry) {
    throw new AuthError('挑战不存在，请先 GET /web3/nonce 获取。', 400);
  }
  if (Date.now() > entry.expiresAt) {
    nonces.delete(key);
    throw new AuthError('挑战已过期，请重新获取 nonce。', 400);
  }

  let recovered: string;
  try {
    recovered = verifyMessage(buildWeb3Message(address, entry.nonce), signature);
  } catch {
    throw new AuthError('签名无效，无法恢复签名者地址。', 400);
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new AuthError('签名地址与请求地址不一致，验证失败。', 401);
  }

  // 一次性挑战：验证成功即作废
  nonces.delete(key);
  return auth.registerWeb3(address);
}
