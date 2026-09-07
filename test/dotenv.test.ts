/**
 * .env 自动加载（dotenv）的回归测试。
 *
 * 关键契约有两条，任何一条被破坏都会让「改了 .env 却不生效」这种最难查的 bug 回来：
 *   1. `src/index.ts` 的第一条 import 必须是 `dotenv/config`。
 *      src/config.ts 在**模块顶层**就把 env 快照成常量，ESM 按声明顺序求值，
 *      只要 dotenv 不是第一个求值，config 拿到的就是空 env。
 *   2. .env **不覆盖**已存在的环境变量（dotenv 默认 override: false）。
 *      这条保证部署平台注入的 JWT_SECRET / ADMIN_TOKEN 永远优先于仓库里的 .env。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = new URL('..', import.meta.url).pathname;
const dotenvConfigUrl = pathToFileURL(join(repoRoot, 'node_modules/dotenv/config.js')).href;

const tempDirs: string[] = [];

function makeTempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-demo-dotenv-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

/** 在指定 cwd 下起一个子进程，先 import dotenv/config，再打印目标环境变量 */
function readEnvFromChild(cwd: string, varName: string, preset: Record<string, string> = {}): string {
  const script = `import ${JSON.stringify(dotenvConfigUrl)}; process.stdout.write(process.env.${varName} ?? '<unset>');`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: { ...process.env, ...preset },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('.env 自动加载', () => {
  it('入口 src/index.ts 的第一条 import 必须是 dotenv/config', () => {
    const src = readFileSync(join(repoRoot, 'src/index.ts'), 'utf8');
    const firstImport = src.match(/^import\s+['"]([^'"]+)['"]/m)?.[1];
    expect(firstImport).toBe('dotenv/config');
  });

  it('dotenv/config 必须排在 src/config.js 之前（config 是顶层 env 快照）', () => {
    const src = readFileSync(join(repoRoot, 'src/index.ts'), 'utf8');
    const dotenvAt = src.indexOf("'dotenv/config'");
    const configAt = src.indexOf('./config.js');
    expect(dotenvAt).toBeGreaterThan(-1);
    expect(configAt).toBeGreaterThan(-1);
    expect(dotenvAt).toBeLessThan(configAt);
  });

  it('.env 里的值会被加载进 process.env', () => {
    const dir = makeTempDir({ '.env': 'MCP_DEMO_ENV_PROBE=from-dotenv\n' });
    expect(readEnvFromChild(dir, 'MCP_DEMO_ENV_PROBE')).toBe('from-dotenv');
  });

  it('已存在的环境变量优先，不会被 .env 覆盖（部署平台注入值永远赢）', () => {
    const dir = makeTempDir({ '.env': 'MCP_DEMO_ENV_PROBE=from-dotenv\n' });
    expect(
      readEnvFromChild(dir, 'MCP_DEMO_ENV_PROBE', { MCP_DEMO_ENV_PROBE: 'from-platform' }),
    ).toBe('from-platform');
  });

  it('.env 缺失时不报错、进程正常退出', () => {
    const dir = makeTempDir({});
    expect(readEnvFromChild(dir, 'MCP_DEMO_ENV_PROBE')).toBe('<unset>');
  });

  it('.env 已被 .gitignore 忽略', () => {
    const ignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
    expect(ignore.split('\n').map((l) => l.trim())).toContain('.env');
  });
});
