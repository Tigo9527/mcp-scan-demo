/**
 * 认证管理模块：注册（一键 / 显式 / 账号密码）、签发与校验 JWT、请求鉴权、账号密码登录。
 * 依赖 jsonwebtoken（标准库，不自己造轮子）。口令哈希见 ./password.ts（Node 内置 scrypt）。
 */
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import * as store from './store.js';
import { hashPassword, validatePassword, validateUsername, verifyPassword } from './password.js';

export interface AuthResult {
  user: store.User;
  token: string;
}

/** 认证业务错误：携带建议的 HTTP 状态码，便于 Web/工具层直接映射。 */
export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

const TOKEN_TTL = '7d';

/** 为用户签发访问令牌，格式：mcp_demo_<jwt>。
 *  采用无状态设计：用户关键信息（username/email/provider/githubToken）直接写进 JWT，
 *  这样在发布平台多副本部署时，任意副本都能独立校验，无需共享内存存储。 */
export function issueToken(user: store.User): string {
  const jwtToken = jwt.sign(
    {
      sub: user.id,
      username: user.username,
      email: user.email,
      provider: user.provider,
      githubLogin: user.githubLogin,
      githubToken: user.githubToken,
      // 真实注册时间：跨副本物化用户时用它，避免退化成「iat 伪造的注册时间」
      createdAt: user.createdAt,
    },
    config.jwtSecret,
    { expiresIn: TOKEN_TTL },
  );
  return `${config.jwtTokenPrefix}${jwtToken}`;
}

/** 校验令牌，返回 userId；无效/过期返回 null */
export function verifyToken(token: string): string | null {
  const raw = token.startsWith(config.jwtTokenPrefix)
    ? token.slice(config.jwtTokenPrefix.length)
    : token.replace(/^Bearer\s+/i, '');
  try {
    const payload = jwt.verify(raw, config.jwtSecret) as jwt.JwtPayload;
    return (payload.sub as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * 从令牌解析并校验当前用户（无状态：直接由 JWT 声明重建，不查存储）。
 * 返回的 User 上带 `tokenIat`，供 store.upsertById 判断数据新旧、保证单向前进。
 */
export function authenticate(tokenOrHeader: string | undefined): store.User | null {
  if (!tokenOrHeader) return null;
  const token = tokenOrHeader.startsWith('Bearer ')
    ? tokenOrHeader.slice(7)
    : tokenOrHeader;
  const raw = token.startsWith(config.jwtTokenPrefix)
    ? token.slice(config.jwtTokenPrefix.length)
    : token;
  try {
    const payload = jwt.verify(raw, config.jwtSecret) as jwt.JwtPayload;
    if (!payload.sub) return null;
    return {
      id: payload.sub as string,
      username: (payload.username as string) ?? 'unknown',
      email: (payload.email as string) ?? null,
      provider: (payload.provider as store.AuthProvider) ?? 'local',
      githubLogin: payload.githubLogin as string | undefined,
      githubToken: payload.githubToken as string | undefined,
      // 旧令牌没有 createdAt claim，回退到 iat（秒级精度，误差可接受）
      createdAt:
        (payload.createdAt as string | undefined) ??
        (payload.iat
          ? new Date((payload.iat as number) * 1000).toISOString()
          : new Date().toISOString()),
      tokenIat: payload.iat,
    };
  } catch {
    return null;
  }
}

/**
 * admin 专用：为指定用户 id 签发令牌。
 * JWT 本身是身份真值来源，所以即便该用户不在本实例内存里（跨副本），也能签发。
 */
export function issueTokenForId(
  id: string,
  fallbackUsername?: string,
): { token: string; user: store.User } {
  const existing = store.getUser(id);
  const user: store.User = existing ?? {
    id,
    username: fallbackUsername ?? `unknown_${id.slice(0, 8)}`,
    email: null,
    provider: 'local',
    createdAt: new Date().toISOString(),
  };
  return { token: issueToken(user), user };
}

/** 一键注册：无需密码，直接生成一个本地用户并返回令牌（供 MCP Agent 自动注册等场景）。 */
export function registerOneClick(profile?: {
  username?: string;
  email?: string;
}): AuthResult {
  const username =
    profile?.username?.trim() || `demo_${randomUUID().slice(0, 8)}`;
  const email = profile?.email?.trim() || `${username}@mcp-demo.local`;
  const user = store.createUser({ username, email, provider: 'local' });
  return { user, token: issueToken(user) };
}

/** 账号密码注册：校验格式、查重、哈希口令后创建本地用户并返回令牌。口令绝不进 JWT。 */
export function registerWithPassword(username: string, password: string): AuthResult {
  const usernameErr = validateUsername(username);
  if (usernameErr) throw new AuthError(usernameErr, 400);
  const passwordErr = validatePassword(password);
  if (passwordErr) throw new AuthError(passwordErr, 400);

  const normalized = username.trim();
  if (store.getUserByUsername(normalized)) {
    throw new AuthError('该用户名已被占用，请换一个或直接登录。', 409);
  }

  const user = store.createUser({
    username: normalized,
    email: `${normalized}@mcp-demo.local`,
    provider: 'local',
    passwordHash: hashPassword(password),
  });
  return { user, token: issueToken(user) };
}

/** 账号密码登录：校验凭据后返回令牌。不存在/非账号密码账号/口令不匹配均返回通用错误，避免用户枚举。 */
export function loginWithPassword(username: string, password: string): AuthResult {
  const user = store.getUserByUsername((username ?? '').trim());
  // 统一的「用户名或密码错误」，不暴露账号是否存在、是否绑定了 GitHub
  if (!user || user.provider !== 'local' || !user.passwordHash) {
    throw new AuthError('用户名或密码错误', 401);
  }
  if (!verifyPassword(password, user.passwordHash)) {
    throw new AuthError('用户名或密码错误', 401);
  }
  user.lastSeenAt = new Date().toISOString();
  return { user, token: issueToken(user) };
}
