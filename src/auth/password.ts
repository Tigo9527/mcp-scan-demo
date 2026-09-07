/**
 * 口令哈希与校验（账号密码注册/登录用）。
 *
 * 用 Node 内置 `crypto.scrypt` —— 这是平台提供的标准 KDF，**不是自己造密码学**。
 * 不引入 bcrypt/argon2 等额外依赖，保持 demo 轻量。
 *
 * 存储格式：`saltHex:hashHex`（16 字节随机盐 + 64 字节哈希，均十六进制）。
 * 关键约束（见 AGENTS.md 安全约定）：
 * - 口令**绝不**写进 JWT、**绝不**经任何 API 回显、**绝不**入日志。
 * - 比较用 `timingSafeEqual` 防时序侧信道。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const HASH_BYTES = 64;

/** 把明文口令哈希为 `saltHex:hashHex`，不直接返回明文。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, HASH_BYTES);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** 校验明文口令与存储值是否匹配（盐/哈希长度非法时一律视为不匹配）。 */
export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const sep = stored.indexOf(':');
  if (sep < 0) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) return false;
  const actual = scryptSync(password, salt, HASH_BYTES);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

/**
 * 校验用户名格式。仅允许字母/数字/下划线/连字符，长度 3~32。
 * 返回 null 表示合法，否则返回可读的中文错误（供页面回显）。
 */
export function validateUsername(username: string): string | null {
  const u = username?.trim();
  if (!u) return '用户名不能为空';
  if (u.length < 3 || u.length > 32) return '用户名长度需为 3~32 个字符';
  if (!USERNAME_RE.test(u)) return '用户名仅允许字母、数字、下划线（_）和连字符（-）';
  return null;
}

/** 校验口令强度。当前约定：至少 8 位。返回 null 表示合法。 */
export function validatePassword(password: string): string | null {
  if (!password) return '密码不能为空';
  if (password.length < 8) return '密码长度至少为 8 位';
  return null;
}
