/**
 * 运行时配置。所有项均可用环境变量覆盖，详见 .env.example。
 *
 * 注意：本文件是**启动时的 env 快照**，运行期不可变（且因 `as const` 编译期只读）。
 * - GitHub OAuth 参数请一律通过 `src/settings.ts` 的 `getGithub()` 读取，
 *   因为它支持 admin 后台在运行时修改；`config.githubSeed` 仅供 settings 层播种，
 *   业务代码禁止直接读（读到的会是永远不变的 env 旧值）。
 * - admin 令牌请一律通过 `getAdminToken()` 读取（惰性读 env，便于测试期覆盖）。
 */
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
    redirectUri: process.env.GITHUB_REDIRECT_URI ?? '',
    scope: process.env.GITHUB_SCOPE ?? 'read:user user:email',
  },

  /** 数据落盘目录（SQLite 文件所在目录，惰性读取，见 src/db.ts） */
  dataDir: process.env.DATA_DIR ?? './data',

  /**
   * 新用户赠送的免费计费点数（余额初始值）。硬计费开启时，余额耗尽则拦截收费工具。
   * 通过 env BILLING_FREE_CREDITS 覆盖。
   */
  billingFreeCredits: Math.max(0, Number(process.env.BILLING_FREE_CREDITS ?? '1000') || 0),

  /**
   * 进程标识，仅用于日志与健康检查展示（**不参与落盘文件名**：数据文件是固定名字，
   * 见 src/db.ts）。通过 env INSTANCE_ID 覆盖。
   */
  instanceId: process.env.INSTANCE_ID ?? 'default',
  /** 进程启动时间 */
  startedAt: new Date().toISOString(),
} as const;

export type AppConfig = typeof config;

/** admin 令牌的默认值。仅用于本地开发；非本地环境使用默认令牌会被拒绝（见 src/web/admin.ts） */
export const DEFAULT_ADMIN_TOKEN = 'dev-admin-change-me';

/**
 * 读取 admin 令牌。**惰性读取** env，便于测试在 beforeAll 里覆盖。
 * 必须是固定值（启动时随机会导致重启后令牌就变了、根本登不进去），
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

/**
 * 未鉴权的 MCP 请求是否返回 401 + `WWW-Authenticate`。
 *
 * 默认**开启**：标准 MCP 客户端（Codex / Claude Desktop / Cursor 等）只有在收到 401 时才会
 * 去读取 `/.well-known/oauth-protected-resource`，进而发现登录方式。永远返回 200 的话，
 * 客户端一路绿灯，压根不会启动 OAuth 流程 —— 这正是「客户端识别不了登录方式」的根因。
 *
 * 设为 `off` 恢复旧的匿名放行行为（钉钉等客户端不带令牌也能握手，再由工具返回注册引导）。
 * 惰性读取 env，便于测试覆盖。
 */
export function requireAuthForMcp(): boolean {
  const v = (process.env.MCP_DEMO_REQUIRE_AUTH ?? 'on').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false';
}

/**
 * 是否启用**硬计费**：余额不足时拦截收费工具的调用（返回 402）。
 * 默认开启。设为 off / 0 / false 则退化为纯统计展示（余额可为负仍放行）。
 * 惰性读取 env，便于测试覆盖。
 */
export function isBillingEnforced(): boolean {
  const v = (process.env.BILLING_ENFORCE ?? 'on').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}
