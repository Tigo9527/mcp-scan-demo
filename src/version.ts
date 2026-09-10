/**
 * 服务器版本信息，供页面页脚与 /health 展示，便于排查线上问题时定位当前跑的是
 * 哪个构建 / 哪次提交。模块加载时计算一次并缓存，避免每次请求都起子进程。
 *
 * 三个字段：
 *  - version  ：来自 package.json（发版时手动 bump，与 npm 版本一致）
 *  - commit   ：优先取环境变量 GIT_COMMIT（CI 注入），否则运行时 `git rev-parse`，
 *               两者皆不可得（无 .git / 部署包）回退 'unknown'，绝不抛错
 *  - startedAt：复用 config.startedAt，即本进程启动时刻
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';

const require = createRequire(import.meta.url);

function readVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readCommit(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export const serverInfo = {
  version: readVersion(),
  commit: readCommit(),
  startedAt: config.startedAt,
} as const;

export type ServerInfo = typeof serverInfo;
