/**
 * 运行时可变设置（GitHub OAuth 参数），支持 admin 后台改完**立即生效**、无需重启。
 *
 * 与 `config.githubSeed` 的关系：
 * - `config.githubSeed` 是启动时从 env 读的**种子值**，运行期不可变。
 * - 本模块是**运行时真值**，admin 可在后台修改并落盘到 `data/settings.json`。
 * - 业务代码一律用 `getGithub()`，**禁止**直接读 `config.githubSeed`。
 *
 * 关于 `undefined` 与 `''` 的区别（重要）：
 * - `undefined` = admin 没设过 → 回退到 env 种子值
 * - `''`       = admin 显式清空 → 禁用该项
 * 必须区分，否则 admin 永远无法把已配好的 GitHub 登录关掉。
 */
import { config } from './config.js';
import { dbEnabled, loadGithubSettings, saveGithubSettings, scheduleDbWrite } from './db.js';

export interface GithubSettings {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scope?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface EffectiveGithubSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  configured: boolean;
  /** 当前值来自 env 种子还是 admin 后台覆盖 */
  source: 'env' | 'admin';
}

/** GitHub 配置是全局项（`settings.json`，一份即可） */
const FILE = 'settings';

let loaded = false;
let current: GithubSettings = {};

function ensure(): GithubSettings {
  if (!loaded) {
    loaded = true;
    // 启用 DB 时，内存数据由 reloadGithubFromDb() 在启动期预热；此处不读库。
  }
  return current;
}

/** 从 SQLite 重新加载 GitHub 设置到内存（启动预热 + 测试里重启模拟用）。 */
export async function reloadGithubFromDb(): Promise<void> {
  current = dbEnabled() ? (await loadGithubSettings()) ?? {} : {};
  loaded = true;
}

function persist(): void {
  scheduleDbWrite(FILE, () => saveGithubSettings({ ...current }));
}

/** 原始存储值（admin 表单回填用）。 */
export function getRaw(): GithubSettings {
  return { ...ensure() };
}

/** 合并后的生效值。 */
export function getGithub(redirectUriFallback?: string): EffectiveGithubSettings {
  const s = ensure();
  const seed = config.githubSeed;

  const clientId = s.clientId ?? seed.clientId;
  const clientSecret = s.clientSecret ?? seed.clientSecret;
  const redirectUri =
    s.redirectUri?.trim() ||
    seed.redirectUri.trim() ||
    redirectUriFallback?.trim() ||
    `${config.publicBaseUrl}/auth/github/callback`;
  const scope = s.scope ?? seed.scope;

  const overridden =
    s.clientId !== undefined ||
    s.clientSecret !== undefined ||
    s.redirectUri !== undefined ||
    s.scope !== undefined;

  return {
    clientId,
    clientSecret,
    redirectUri,
    scope,
    configured: Boolean(clientId && clientSecret),
    source: overridden ? 'admin' : 'env',
  };
}

/** 更新（补丁式）并落盘。 */
export function setGithub(patch: Partial<GithubSettings>): GithubSettings {
  ensure();
  current = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: 'admin',
  };
  persist();
  return getRaw();
}

/** 恢复为环境变量种子值。 */
export function resetGithub(): GithubSettings {
  loaded = true;
  current = {};
  persist();
  return getRaw();
}

/** 测试用：直接把内存态复位（不影响落盘开关）。 */
export function __resetForTest(): void {
  loaded = false;
  current = {};
}
