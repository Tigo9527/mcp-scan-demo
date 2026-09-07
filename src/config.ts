/**
 * 运行时配置。所有项均可用环境变量覆盖，详见 .env.example。
 *
 * 注意：本文件是**启动时的 env 快照**，运行期不可变（且因 `as const` 编译期只读）。
 * - GitHub OAuth 参数请一律通过 `src/settings.ts` 的 `getGithub()` 读取，
 *   因为它支持 admin 后台在运行时修改；`config.githubSeed` 仅供 settings 层播种，
 *   业务代码禁止直接读（读到的会是永远不变的 env 旧值）。
 * - admin 令牌请一律通过 `getAdminToken()` 读取（惰性读 env，便于测试期覆盖）。
 */
import { randomUUID } from 'node:crypto';

const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
  host: process.env.HOST ?? '0.0.0.0',
  /** JWT 签名密钥，生产环境务必通过环境变量覆盖 */
  jwtSecret: process.env.JWT_SECRET ?? 'dev-mcp-demo-secret-change-me',
  /** 对外基础地址，用于拼接回调与 MCP 端点 URL */
  baseUrl: process.env.BASE_URL ?? `http://localhost:${port}`,
  /** 对外可见基础地址（部署在公网/反代后由环境变量覆盖，用于工具里拼登录链接） */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? process.env.BASE_URL ?? `http://localhost:${port}`,
  jwtTokenPrefix: 'mcp_demo_',

  /**
   * GitHub OAuth 的**环境种子值**，仅供 `settings.ts` 播种。
   * 业务代码请用 `getGithub()`（src/settings.ts），否则读不到 admin 后台的运行时改动。
   */
  githubSeed: {
    clientId: process.env.GITHUB_CLIENT_ID ?? '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    redirectUri:
      process.env.GITHUB_REDIRECT_URI ?? `http://localhost:${port}/auth/github/callback`,
    scope: process.env.GITHUB_SCOPE ?? 'read:user user:email',
  },

  /** 数据落盘目录（惰性读取，见 src/persist.ts） */
  dataDir: process.env.DATA_DIR ?? './data',

  /** 本实例标识。部署平台为多副本，内存数据不跨副本共享，用它在页面上标明数据归属 */
  instanceId: process.env.INSTANCE_ID ?? randomUUID().slice(0, 8),
  /** 进程启动时间 */
  startedAt: new Date().toISOString(),
} as const;

export type AppConfig = typeof config;

/** admin 令牌的默认值。仅用于本地开发；非本地环境使用默认令牌会被拒绝（见 src/web/admin.ts） */
export const DEFAULT_ADMIN_TOKEN = 'dev-admin-change-me';

/**
 * 读取 admin 令牌。**惰性读取** env，便于测试在 beforeAll 里覆盖。
 * 多副本部署下必须是固定值（启动时随机会导致每个副本都不一样、根本登不进去），
 * 所以走环境变量注入而非启动生成。
 */
export function getAdminToken(): string {
  return process.env.ADMIN_TOKEN?.trim() || DEFAULT_ADMIN_TOKEN;
}

/** 当前是否正在使用不安全的默认 admin 令牌 */
export function isUsingDefaultAdminToken(): boolean {
  return getAdminToken() === DEFAULT_ADMIN_TOKEN;
}

/** 对外地址是否为本地地址（用于判断能否放宽安全限制） */
export function isLocalBaseUrl(): boolean {
  const u = config.publicBaseUrl.toLowerCase();
  return u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1');
}
