/**
 * 极简 JSON 落盘层。
 *
 * 设计要点：
 * - **原子写**：先写 `*.tmp` 再 `rename`（POSIX 同目录 rename 是原子的），避免半截文件。
 * - **单一文件名**：每个数据集固定一个文件名（`users.json` / `stats.json` / …），
 *   由调用方传入 name，不做任何按进程 / 实例拆分。
 * - **防抖 + 单飞**：300ms 防抖、最长 5s 强制刷；同一名字的写操作串行化。
 * - **env 惰性读取**：DATA_DIR / MCP_DEMO_PERSIST 在每次调用时才读，
 *   这样测试可以在 beforeAll 里覆盖（ESM 下 import 先于模块体执行，不能只在模块顶部读）。
 * - **永不抛出**：落盘失败只记录 lastError，绝不因为写盘问题让服务崩溃。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

interface Overrides {
  dataDir?: string;
  enabled?: boolean;
}

let overrides: Overrides = {};

export interface PersistStatus {
  enabled: boolean;
  dir: string;
  writable: boolean;
  saves: number;
  lastError: string | null;
}

const status: PersistStatus = {
  enabled: true,
  dir: '',
  writable: true,
  saves: 0,
  lastError: null,
};

/** 测试期覆盖（优先于环境变量）。传 `{ enabled: false }` 可完全关停落盘。 */
export function configure(next: Overrides): void {
  overrides = { ...overrides, ...next };
  status.enabled = isEnabled();
  status.dir = getDataDir();
}

/** 是否启用落盘。env MCP_DEMO_PERSIST=0 可关闭。 */
export function isEnabled(): boolean {
  if (overrides.enabled !== undefined) return overrides.enabled;
  return process.env.MCP_DEMO_PERSIST !== '0';
}

export function getDataDir(): string {
  return overrides.dataDir ?? process.env.DATA_DIR ?? config.dataDir;
}

/** 数据文件的完整路径（不含扩展名，自动补 .json） */
export function filePath(name: string): string {
  return path.join(getDataDir(), `${name}.json`);
}

/**
 * 读取 JSON。任何异常都降级：
 * 主文件解析失败 → 试 `*.json.bak` → 再失败把坏文件改名 `*.json.corrupt-<ts>` 并返回 fallback。
 */
export async function loadJson<T>(name: string, fallback: T): Promise<T> {
  if (!isEnabled()) return fallback;
  const main = filePath(name);
  const bak = `${main}.bak`;

  const tryRead = async (p: string): Promise<T | undefined> => {
    try {
      const raw = await fs.readFile(p, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  };

  const parsed = await tryRead(main);
  if (parsed !== undefined) return parsed;

  const fromBak = await tryRead(bak);
  if (fromBak !== undefined) return fromBak;

  // 主文件存在但坏了：留档排查，不要静默删除
  try {
    await fs.access(main);
    await fs.rename(main, `${main}.corrupt-${Date.now()}`);
  } catch {
    /* 不存在就算了 */
  }
  return fallback;
}

/**
 * 同步读取 JSON（降级逻辑同 loadJson）。
 * 用于必须在同步上下文里拿到配置的场景（如 isGitHubConfigured()）。
 */
export function loadJsonSync<T>(name: string, fallback: T): T {
  if (!isEnabled()) return fallback;
  const main = filePath(name);
  const bak = `${main}.bak`;

  const tryRead = (p: string): T | undefined => {
    try {
      return JSON.parse(fsSync.readFileSync(p, 'utf8')) as T;
    } catch {
      return undefined;
    }
  };

  const parsed = tryRead(main);
  if (parsed !== undefined) return parsed;
  const fromBak = tryRead(bak);
  if (fromBak !== undefined) return fromBak;

  try {
    fsSync.accessSync(main);
    fsSync.renameSync(main, `${main}.corrupt-${Date.now()}`);
  } catch {
    /* 不存在就算了 */
  }
  return fallback;
}

const pending = new Map<string, () => unknown>();
const timers = new Map<string, NodeJS.Timeout>();
const firstPendingAt = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();

const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 5000;

/**
 * 排队保存。传 thunk（而非快照）可保证落盘时序列化的是最新状态。
 */
export function scheduleSave(name: string, data: unknown | (() => unknown)): void {
  if (!isEnabled()) return;
  pending.set(name, typeof data === 'function' ? (data as () => unknown) : () => data);

  const now = Date.now();
  if (!firstPendingAt.has(name)) firstPendingAt.set(name, now);
  const waited = now - (firstPendingAt.get(name) as number);
  const delay = waited >= MAX_WAIT_MS ? 0 : DEBOUNCE_MS;

  const existing = timers.get(name);
  if (existing) clearTimeout(existing);
  timers.set(
    name,
    setTimeout(() => {
      timers.delete(name);
      void saveNow(name);
    }, delay),
  );
  // 防抖定时器不应阻止进程退出
  const t = timers.get(name);
  if (t && typeof (t as unknown as { unref?: () => void }).unref === 'function') {
    (t as unknown as { unref: () => void }).unref();
  }
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });

  // 先把旧文件留一份 .bak，再原子替换（崩溃时可从 bak 恢复）
  try {
    await fs.access(file);
    await fs.copyFile(file, `${file}.bak`);
  } catch {
    /* 首次写入没有旧文件，忽略 */
  }

  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

function saveNow(name: string): Promise<void> {
  const prev = inflight.get(name);
  const run = (async () => {
    if (prev) await prev.catch(() => undefined);
    const thunk = pending.get(name);
    if (!thunk) return;
    pending.delete(name);
    firstPendingAt.delete(name);
    try {
      await writeAtomic(filePath(name), thunk());
      status.writable = true;
      status.saves += 1;
      status.lastError = null;
    } catch (err) {
      status.writable = false;
      status.lastError = err instanceof Error ? err.message : String(err);
      // 落盘失败不影响服务，仅记录一次
      console.error(`[persist] 写入 ${name} 失败：${status.lastError}`);
    }
  })();

  inflight.set(name, run);
  void run.finally(() => {
    if (inflight.get(name) === run) inflight.delete(name);
  });
  return run;
}

/** 立即写回所有待保存的数据（退出前 / 测试里调用）。 */
export async function flush(): Promise<void> {
  const names = [...pending.keys()];
  for (const name of names) {
    const t = timers.get(name);
    if (t) clearTimeout(t);
    timers.delete(name);
  }
  await Promise.all([...names.map((n) => saveNow(n)), ...inflight.values()]);
}

export function persistStatus(): PersistStatus {
  return { ...status, enabled: isEnabled(), dir: getDataDir() };
}

/** 注册退出前的 flush，尽量避免丢数据 */
export function registerShutdownFlush(): void {
  const onExit = () => {
    void flush().catch(() => undefined);
  };
  process.on('SIGTERM', onExit);
  process.on('SIGINT', onExit);
  process.on('beforeExit', onExit);
}
