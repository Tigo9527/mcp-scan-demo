/**
 * 用户存储（demo 用，内存为主 + JSON 落盘尽力持久化）。
 *
 * 相比初版的变化：
 * - 支持落盘（按实例分片 `data/users-<instanceId>.json`，多副本各写各的，不互相覆盖）
 * - 提供 `listUsers` / `countUsers` / `deleteUser`，供 admin 后台使用
 * - 提供 `upsertById`（**跨副本按需物化**）：鉴权是无状态 JWT，在 A 副本注册的用户
 *   在 B 副本内存里并不存在；流量打到哪个副本，就在哪个副本按 id 物化一份，
 *   这样 admin 用户列表会随流量逐步补全。
 * - 用户名/GitHub 索引改为 **best-effort**（不互相顶掉），用户列表一律以 byId 为准。
 * 生产环境请替换为数据库实现，并保持相同接口。
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { loadJsonSync, scheduleSave } from '../persist.js';

export type AuthProvider = 'local' | 'github';

export interface User {
  id: string;
  username: string;
  email: string | null;
  provider: AuthProvider;
  /** GitHub OAuth 登录后落地，用于调用 GitHub API */
  githubLogin?: string;
  githubToken?: string;
  /** 账号密码用户的口令哈希（scrypt，格式 `saltHex:hashHex`）。GitHub/一键注册用户无此字段。绝不进 JWT。 */
  passwordHash?: string;
  createdAt: string;
  /** 最近一次携带有效令牌访问本实例的时间 */
  lastSeenAt?: string;
  /** 内部字段：最近一次物化所用的 JWT iat（秒），用于保证数据单向前进 */
  tokenIat?: number;
}

export interface UpsertByIdResult {
  created: boolean;
  /** 是否发生了需要落盘的变更 */
  changed: boolean;
}

export interface ListUsersOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

const byId = new Map<string, User>();
const byUsername = new Map<string, string>();
const byGithubLogin = new Map<string, string>();

const FILE = `users-${config.instanceId}`;
let loaded = false;

function indexBestEffort(user: User): void {
  const u = user.username?.toLowerCase();
  if (u && !byUsername.has(u)) byUsername.set(u, user.id);
  const g = user.githubLogin?.toLowerCase();
  if (g && !byGithubLogin.has(g)) byGithubLogin.set(g, user.id);
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const data = loadJsonSync<{ users?: User[] }>(FILE, {});
  for (const u of data.users ?? []) {
    if (!u?.id || !u?.username) continue;
    byId.set(u.id, u);
    indexBestEffort(u);
  }
}

function markDirty(): void {
  scheduleSave(FILE, () => ({ users: [...byId.values()] }));
}

export function createUser(input: {
  username: string;
  email: string | null;
  provider: AuthProvider;
  githubLogin?: string;
  githubToken?: string;
  passwordHash?: string;
}): User {
  ensureLoaded();
  const user: User = {
    id: randomUUID(),
    username: input.username,
    email: input.email,
    provider: input.provider,
    githubLogin: input.githubLogin,
    githubToken: input.githubToken,
    passwordHash: input.passwordHash,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  byId.set(user.id, user);
  indexBestEffort(user);
  markDirty();
  return user;
}

export function getUser(id: string): User | undefined {
  ensureLoaded();
  return byId.get(id);
}

export function getUserByUsername(username: string): User | undefined {
  ensureLoaded();
  const id = byUsername.get(username.toLowerCase());
  return id ? byId.get(id) : undefined;
}

/** GitHub 用户首次登录时创建，之后每次登录刷新令牌（find-or-create）。 */
export function upsertGitHubUser(input: {
  githubLogin: string;
  email: string | null;
  githubToken: string;
}): User {
  ensureLoaded();
  const existingId = byGithubLogin.get(input.githubLogin.toLowerCase());
  if (existingId) {
    const user = byId.get(existingId)!;
    user.githubToken = input.githubToken;
    user.email = input.email ?? user.email;
    user.lastSeenAt = new Date().toISOString();
    markDirty();
    return user;
  }
  return createUser({
    username: input.githubLogin,
    email: input.email,
    provider: 'github',
    githubLogin: input.githubLogin,
    githubToken: input.githubToken,
  });
}

/**
 * 按 id 物化一个由 JWT 还原出来的用户（跨副本补全用）。
 *
 * 关键规则：**仅当新令牌的 iat 不早于已记录值时，才刷新用户资料字段**。
 * 否则用户先用新令牌刷新了资料、之后一个 7 天前的旧令牌打过来，会把新数据覆盖回旧值。
 * 不满足条件时只更新 lastSeenAt。
 */
export function upsertById(user: User & { tokenIat?: number }): UpsertByIdResult {
  ensureLoaded();
  const now = new Date().toISOString();
  const existing = byId.get(user.id);

  if (!existing) {
    const created: User = {
      id: user.id,
      username: user.username,
      email: user.email,
      provider: user.provider,
      githubLogin: user.githubLogin,
      githubToken: user.githubToken,
      createdAt: user.createdAt ?? now,
      lastSeenAt: now,
      tokenIat: user.tokenIat,
    };
    byId.set(created.id, created);
    indexBestEffort(created);
    markDirty();
    return { created: true, changed: true };
  }

  const incomingIat = user.tokenIat ?? 0;
  const knownIat = existing.tokenIat ?? 0;
  let changed = false;

  if (incomingIat >= knownIat) {
    if (existing.username !== user.username) {
      existing.username = user.username;
      changed = true;
    }
    if (existing.email !== user.email) {
      existing.email = user.email;
      changed = true;
    }
    if (existing.githubLogin !== user.githubLogin) {
      existing.githubLogin = user.githubLogin;
      changed = true;
    }
    if (user.githubToken && existing.githubToken !== user.githubToken) {
      existing.githubToken = user.githubToken;
      changed = true;
    }
    if (existing.tokenIat !== incomingIat) {
      existing.tokenIat = incomingIat;
      changed = true;
    }
  }

  // lastSeenAt 超过 60s 才刷新并落盘，避免每个请求都重写文件
  const last = existing.lastSeenAt ? Date.parse(existing.lastSeenAt) : 0;
  if (!last || Date.now() - last > 60_000) {
    existing.lastSeenAt = now;
    changed = true;
  }

  if (changed) markDirty();
  return { created: false, changed };
}

/**
 * 用户列表（admin 用）。一律以 byId 为准 —— id 唯一，天然去重，
 * 不会因为跨副本同名导致索引互顶而丢记录。
 */
export function listUsers(options: ListUsersOptions = {}): { items: User[]; total: number } {
  ensureLoaded();
  const q = options.query?.trim().toLowerCase();
  let items = [...byId.values()];

  if (q) {
    items = items.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        (u.email ?? '').toLowerCase().includes(q) ||
        (u.githubLogin ?? '').toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q),
    );
  }

  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const total = items.length;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit && options.limit > 0 ? options.limit : items.length;
  return { items: items.slice(offset, offset + limit), total };
}

export function countUsers(): number {
  ensureLoaded();
  return byId.size;
}

export function deleteUser(id: string): boolean {
  ensureLoaded();
  const user = byId.get(id);
  if (!user) return false;
  byId.delete(id);
  if (byUsername.get(user.username.toLowerCase()) === id) {
    byUsername.delete(user.username.toLowerCase());
  }
  const g = user.githubLogin?.toLowerCase();
  if (g && byGithubLogin.get(g) === id) byGithubLogin.delete(g);
  markDirty();
  return true;
}

/** 统计重名用户（admin 页用于标记，跨副本同名属正常现象） */
export function duplicatedUsernames(): Set<string> {
  ensureLoaded();
  const counts = new Map<string, number>();
  for (const u of byId.values()) {
    const k = u.username.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k));
}

/** 测试用：清空内存态（不落盘） */
export function __resetForTest(): void {
  byId.clear();
  byUsername.clear();
  byGithubLogin.clear();
  loaded = false;
}
