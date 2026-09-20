/**
 * 自包含加密票据（seal / open）。
 *
 * 为什么不用「存起来再查」：早期的 JSON 文件存储层撑不住 —— 无锁无 CAS（并发写会互相覆盖）、
 * 且进程内只读一次、写进去当前进程也读不到。
 * 本项目里唯一可靠的机制是**自包含签名**（`github.ts` 的 `createState()` 就是这么做的），
 * 这里沿用同一思路，但改成**加密**，
 * 因为授权码里带着 code_challenge / 用户信息，不该被客户端直接读出来。
 *
 * 两个必须做对的细节：
 *  - 密钥用 HKDF 从 JWT_SECRET **派生**，不直接复用：避免 HMAC 与 AES-GCM 跨算法共用同一把密钥。
 *  - AES-GCM 的 AAD 绑定用途：否则一枚给 client_id 用的票据能被当成授权码去换令牌。
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { config } from '../config.js';

const VERSION = 'v1';
const HKDF_SALT = 'mcp-demo-oauth-v1';

/** 票据用途。同时用作 HKDF 的 info 与 AES-GCM 的 AAD。 */
export type TicketPurpose = 'dcr' | 'code' | 'authorize';

const keyCache = new Map<string, Buffer>();

function keyFor(purpose: TicketPurpose): Buffer {
  const cached = keyCache.get(purpose);
  if (cached) return cached;
  const derived = Buffer.from(
    hkdfSync('sha256', config.jwtSecret, HKDF_SALT, `mcp-demo:${purpose}`, 32),
  );
  keyCache.set(purpose, derived);
  return derived;
}

function aad(purpose: TicketPurpose): Buffer {
  return Buffer.from(`mcp-demo:${purpose}`, 'utf8');
}

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

function unb64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** 加密并自包含地封存一份数据。返回形如 `v1.<purpose>.<nonce>.<ciphertext>.<tag>`。 */
export function seal(
  purpose: TicketPurpose,
  payload: Record<string, unknown>,
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
    jti: randomUUID(),
  });
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), nonce);
  cipher.setAAD(aad(purpose));
  const ct = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, purpose, b64u(nonce), b64u(ct), b64u(tag)].join('.');
}

/**
 * 解封。任何一步失败（版本/用途不符、被篡改、过期、结构不对）都返回 null。
 * 调用方拿到 null 一律按「无效」处理，不要区分原因，避免给攻击者提供信息。
 */
export function open<T extends object>(
  purpose: TicketPurpose,
  ticket: string | undefined,
): (T & { exp: number; jti: string }) | null {
  if (!ticket) return null;
  const parts = ticket.split('.');
  if (parts.length !== 5) return null;
  const [version, p, nonceB64, ctB64, tagB64] = parts;
  if (version !== VERSION || p !== purpose) return null;

  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(purpose), unb64u(nonceB64));
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(unb64u(tagB64));
    const raw = Buffer.concat([
      decipher.update(unb64u(ctB64)),
      decipher.final(),
    ]).toString('utf8');
    const data = JSON.parse(raw) as T & { exp: number; jti: string };
    if (typeof data.exp !== 'number') return null;
    if (data.exp * 1000 <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}
