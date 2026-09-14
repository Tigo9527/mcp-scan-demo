/**
 * 服务入口：启动 Express + 打印可访问 URL 横幅。
 * 测试通过 createApp() 自行监听，故本文件仅在「直接运行」时自动启动。
 */
// 必须在**所有其他 import 之前**：src/config.ts 在模块顶层就把 env 快照成常量，
// 一旦它先求值，.env 里的内容就来不及生效了。重排 import 会让 .env 静默失效。
import 'dotenv/config';
import { createApp } from './web/app.js';
import { config, getAdminToken, isUsingDefaultAdminToken } from './config.js';
import { initDb, flushDb, closeDb, registerShutdownFlush } from './db.js';
import { reloadUsersFromDb } from './auth/store.js';
import { reloadBillingFromDb } from './billing.js';
import { reloadStatsFromDb } from './stats.js';
import { reloadRechargeSettingsFromDb, reloadRechargeRecordsFromDb } from './recharge.js';
import { reloadGithubFromDb } from './settings.js';
import type { Server } from 'node:http';

// 兜底：Express 4 不捕获 async handler 的 rejection，一旦逃逸出来 Node 20 默认直接终止进程。
// 这里只记录不退出，避免一次偶发异常就让整个进程挂掉。
process.on('unhandledRejection', (reason) => {
  console.error('[mcp-demo] 未捕获的 Promise rejection：', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[mcp-demo] 未捕获异常：', err);
});

/** 启动期把各模块内存态从 SQLite 预热（在 listen 之前完成，避免首请求读到空数据）。 */
async function loadAllStores(): Promise<void> {
  await Promise.all([
    reloadUsersFromDb(),
    reloadBillingFromDb(),
    reloadStatsFromDb(),
    reloadRechargeSettingsFromDb(),
    reloadRechargeRecordsFromDb(),
    reloadGithubFromDb(),
  ]);
}

export async function startServer(port: number = config.port): Promise<Server> {
  await initDb();
  await loadAllStores();
  registerShutdownFlush();
  const app = createApp();
  const server = app.listen(port, config.host, () => {
    printBanner();
  });
  startKeepAlive();
  registerGracefulShutdown(server);
  return server;
}

/**
 * 优雅关闭：tsx 的 preflight 会给 SIGINT/SIGTERM 装「隐藏」监听并吞掉（不退出），
 * 导致 `npm start` 下按 Ctrl+C 杀不掉进程（只能 kill -9）。
 * 这里自己注册监听，收到信号后先停止接收新连接、刷盘落库，再显式 process.exit，
 * 从而盖过 tsx 的吞信号行为；生产环境（node dist/index.js）下它也是我们唯一的处理器。
 */
function registerGracefulShutdown(server: Server): void {
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.error(`[mcp-demo] 收到 ${signal}，正在关闭…`);
    const done = (): void => {
      shutdown()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    };
    server.close(done);
    // 兜底：若有连接迟迟关不掉，5s 后强制退出，避免卡死
    const hard = setTimeout(() => process.exit(1), 5_000);
    if (typeof hard.unref === 'function') hard.unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const) {
    process.on(signal, () => stop(signal));
  }
}

/**
 * 保活：发布平台在实例空闲一段时间后会将其休眠，唤醒约需 5s，
 * 常超过网关超时从而导致间歇 502。这里周期性自 ping 公开地址（走网关→本实例），
 * 让平台认为该实例仍有入向流量、不被判定为空闲而休眠。
 * 仅当注入了公网地址（非 localhost）时启用；本地开发不触发。
 */
function startKeepAlive(): void {
  const base = config.publicBaseUrl;
  if (!base || base.startsWith('http://localhost') || base.startsWith('http://127.0.0.1')) {
    return;
  }
  const target = `${base.replace(/\/+$/, '')}/health`;
  const intervalMs = 15_000;
  const timer = setInterval(() => {
    fetch(target).catch(() => undefined);
  }, intervalMs);
  // 不阻止进程退出（HTTP server 已让事件循环保持活跃，定时器照常触发）
  if (typeof timer.unref === 'function') timer.unref();
}

export function printBanner(): void {
  const base = config.baseUrl;
  const adminHint = isUsingDefaultAdminToken()
    ? '⚠ 使用默认令牌 dev-admin-change-me（公网环境会被禁用，请注入 ADMIN_TOKEN）'
    : `已注入（ADMIN_TOKEN=${getAdminToken().slice(0, 4)}****）`;

  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '  MCP Demo 服务已启动  (TypeScript + 官方 @modelcontextprotocol/sdk)',
    '╠══════════════════════════════════════════════════════════════╣',
    `   访问门户 / 一键注册 :  ${base}/`,
    `   GitHub OAuth 登录   :  ${base}/auth/github`,
    `   MCP 端点 (Streamable HTTP): ${base}/mcp`,
    `   用户 Profile        :  ${base}/profile（浏览器登录一次即自动保持）`,
    `   Admin 管理端        :  ${base}/admin`,
    `   Admin 令牌          :  ${adminHint}`,
    `   健康检查            :  ${base}/health`,
    '╚══════════════════════════════════════════════════════════════╝',
    `   实例 ID: ${config.instanceId}`,
    '',
  ];
  // 同时用 error 日志确保被 CI/Codex 捕获（stdout 可能被缓冲）
  console.log(lines.join('\n'));
  console.error(
    '[mcp-demo] visit URLs ->',
    `${base}/`,
    '|',
    `${base}/auth/github`,
    '|',
    `${base}/mcp`,
    '|',
    `${base}/admin`,
  );
}

// 退出前把待写入的数据刷盘（平台重启频繁，不 flush 的话统计基本等于内存态）
export async function shutdown(): Promise<void> {
  await flushDb().catch(() => undefined);
  await closeDb().catch(() => undefined);
}

// 仅当作为入口直接执行时才自动启动（测试 import 时不会触发）
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('index.ts') ||
    process.argv[1].endsWith('index.js') ||
    process.argv[1].replace(/\\/g, '/').endsWith('src/index.ts'));

if (invokedDirectly && process.env.MCP_DEMO_NO_BOOT !== '1') {
  void startServer();
}
