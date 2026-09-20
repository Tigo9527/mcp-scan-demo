/**
 * MCP 调用统计。
 *
 * 计数规则（避免数字虚高，这点很关键）：
 * - **通知类消息（`notifications/*`，没有 id）不计入**。MCP 客户端每次连接后必发
 *   `notifications/initialized`，若计入会让调用数直接翻倍。
 * - `initialize` / `tools/list` 等计入 `requests`，**但绝不计入 `toolCalls`**。
 *   只有 `tools/call` 才算工具调用——否则每次连接的 initialize 会让数字变成真实的 2~3 倍。
 * - 匿名请求统一归到 `byUser['anonymous']` 单桶（按 IP 分桶会引入 PII，
 *   且部署平台网关不一定转发 x-forwarded-for）。
 * - `recent` 只存元数据，**不存 params**（工具参数可能含敏感内容，且会落盘）。
 *
 * 内存增长防护：byUser 按 userId 分桶并设上限（按 lastSeenAt 淘汰）、
 * byDay 只保留最近 90 天、recent 用固定长度环形缓冲。
 */
import { dbEnabled, loadStats, saveStats, scheduleDbWrite } from './db.js';

const RECENT_MAX = 200;
const BY_USER_MAX = 500;
const BY_DAY_MAX = 90;
const ANONYMOUS = 'anonymous';

export interface UserStat {
  userId: string | null;
  username: string;
  /** 带 id 的请求数（含 initialize / tools/list 等） */
  calls: number;
  /** 工具维度（仅 tools/call） */
  tools: Record<string, number>;
  /** 按天维度（YYYY-MM-DD → 请求数），最多保留 90 天 */
  days: Record<string, number>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DayStat {
  requests: number;
  toolCalls: number;
  anonymous: number;
}

export interface RecentCall {
  ts: string;
  method: string;
  tool: string | null;
  userId: string | null;
  username: string;
  ok?: boolean;
}

export interface StatsSnapshot {
  /** 统计起点 */
  since: string;
  counters: {
    /** 所有带 id 的 JSON-RPC 请求 */
    requests: number;
    /** 仅 tools/call —— 页面头条数字用这个 */
    toolCalls: number;
    errors: number;
  };
  byMethod: Record<string, number>;
  byTool: Record<string, number>;
  /** key = userId，匿名统一 'anonymous' */
  byUser: Record<string, UserStat>;
  /** key = YYYY-MM-DD */
  byDay: Record<string, DayStat>;
  recent: RecentCall[];
}

export interface StatsDelta {
  counters: { requests: number; toolCalls: number; errors: number };
  byMethod: Record<string, number>;
  byTool: Record<string, number>;
  /** key = 用户桶，value = calls 增量 */
  byUser: Record<string, number>;
}

/** 最小化的 JSON-RPC 消息形状（SDK 已做 schema 校验，这里只取需要的字段） */
export interface RpcMessageLike {
  id?: string | number;
  method?: string;
  params?: { name?: string } & Record<string, unknown>;
  error?: unknown;
}

const FILE = 'stats';

let loaded = false;
let state: StatsSnapshot = emptyState();

function emptyState(): StatsSnapshot {
  return {
    since: new Date().toISOString(),
    counters: { requests: 0, toolCalls: 0, errors: 0 },
    byMethod: {},
    byTool: {},
    byUser: {},
    byDay: {},
    recent: [],
  };
}

/** 环形缓冲写指针 */
let recentIdx = 0;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  // 启用 DB 时，内存数据由 reloadStatsFromDb() 在启动期预热；这里保持同步、不读库。
}

/** 从 SQLite 重新加载统计快照到内存（启动预热 + 测试里重启模拟用）。 */
export async function reloadStatsFromDb(): Promise<void> {
  if (dbEnabled()) {
    const loaded2 = await loadStats();
    if (loaded2 && loaded2.snapshot && loaded2.snapshot.counters) {
      state = {
        ...emptyState(),
        ...loaded2.snapshot,
        counters: { ...emptyState().counters, ...loaded2.snapshot.counters },
        byMethod: loaded2.snapshot.byMethod ?? {},
        byTool: loaded2.snapshot.byTool ?? {},
        byDay: loaded2.snapshot.byDay ?? {},
        recent: Array.isArray(loaded2.snapshot.recent) ? loaded2.snapshot.recent.slice(-RECENT_MAX) : [],
      };
      recentIdx = loaded2.recentIdx % RECENT_MAX;
      for (const [k, v] of Object.entries(state.byUser)) {
        state.byUser[k] = { ...v, days: v.days ?? {} };
      }
      loaded = true;
      return;
    }
  }
  state = emptyState();
  recentIdx = 0;
  loaded = true;
}

function markDirty(): void {
  scheduleDbWrite(FILE, () => saveStats(state, recentIdx));
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function pushRecent(call: RecentCall): void {
  if (state.recent.length < RECENT_MAX) {
    state.recent.push(call);
    recentIdx = state.recent.length % RECENT_MAX;
    return;
  }
  state.recent[recentIdx] = call;
  recentIdx = (recentIdx + 1) % RECENT_MAX;
}

function pruneDays(days: Record<string, number>): void {
  const keys = Object.keys(days);
  if (keys.length <= BY_DAY_MAX) return;
  keys.sort();
  for (const k of keys.slice(0, keys.length - BY_DAY_MAX)) delete days[k];
}

function evictIfNeeded(): void {
  const keys = Object.keys(state.byUser);
  if (keys.length > BY_USER_MAX) {
    const sorted = keys
      .map((k) => state.byUser[k]!)
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? -1 : 1));
    const dropCount = keys.length - BY_USER_MAX;
    for (let i = 0; i < dropCount; i += 1) {
      const victim = sorted[i]!;
      delete state.byUser[victim.userId ?? ANONYMOUS];
    }
  }

  const days = Object.keys(state.byDay).sort();
  if (days.length > BY_DAY_MAX) {
    for (const d of days.slice(0, days.length - BY_DAY_MAX)) delete state.byDay[d];
  }
}

/**
 * 记录一条 JSON-RPC 请求。**内部绝不抛异常** —— SDK 把 handleRequest 整体包在
 * try/catch 里，任何抛出都会被吞掉并转成 `400 Parse error`，导致请求莫名其妙失败。
 */
export function record(
  message: unknown,
  user: { id?: string | null; username?: string | null } | null,
): void {
  try {
    ensureLoaded();
    const msg = message as RpcMessageLike | undefined;
    if (!msg || typeof msg !== 'object') return;
    // 通知类（无 id）不计入
    if (msg.id === undefined) return;
    const method = typeof msg.method === 'string' ? msg.method : 'unknown';
    if (!msg.method) return;

    const now = Date.now();
    const iso = new Date(now).toISOString();
    const dk = dayKey(now);
    const isToolCall = method === 'tools/call';
    const tool = isToolCall
      ? typeof msg.params?.name === 'string'
        ? msg.params.name
        : 'unknown'
      : null;

    state.counters.requests += 1;
    state.byMethod[method] = (state.byMethod[method] ?? 0) + 1;

    if (isToolCall) {
      state.counters.toolCalls += 1;
      if (tool) state.byTool[tool] = (state.byTool[tool] ?? 0) + 1;
    }

    const userId = user?.id ?? null;
    const username = user?.username ?? ANONYMOUS;
    const bucket = userId ?? ANONYMOUS;
    const stat = state.byUser[bucket] ?? {
      userId,
      username,
      calls: 0,
      tools: {},
      days: {},
      firstSeenAt: iso,
      lastSeenAt: iso,
    };
    stat.userId = userId;
    stat.username = username;
    stat.calls += 1;
    stat.lastSeenAt = iso;
    if (tool) stat.tools[tool] = (stat.tools[tool] ?? 0) + 1;
    stat.days[dk] = (stat.days[dk] ?? 0) + 1;
    pruneDays(stat.days);
    state.byUser[bucket] = stat;

    const day = state.byDay[dk] ?? { requests: 0, toolCalls: 0, anonymous: 0 };
    day.requests += 1;
    if (isToolCall) day.toolCalls += 1;
    if (!userId) day.anonymous += 1;
    state.byDay[dk] = day;

    pushRecent({ ts: iso, method, tool, userId, username });
    evictIfNeeded();
    markDirty();
  } catch (err) {
    console.error('[stats] record 失败：', err instanceof Error ? err.message : String(err));
  }
}

/** 记录一条响应（用于统计错误数）。同样绝不抛异常。 */
export function recordResponse(message: unknown): void {
  try {
    const msg = message as RpcMessageLike | undefined;
    if (!msg || typeof msg !== 'object') return;
    if (msg.error === undefined) return;
    ensureLoaded();
    state.counters.errors += 1;
    markDirty();
  } catch (err) {
    console.error(
      '[stats] recordResponse 失败：',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** 快照（**深拷贝**，否则 before/after diff 会是同一个引用、恒为 0） */
export function getStatsSnapshot(): StatsSnapshot {
  ensureLoaded();
  return structuredClone(state);
}

/** 单个用户的统计（不存在返回 null） */
export function getUserStats(userId: string): UserStat | null {
  ensureLoaded();
  const stat = state.byUser[userId];
  return stat ? structuredClone(stat) : null;
}

/** 测试用：清零 */
export function resetStats(): void {
  loaded = true;
  state = emptyState();
  recentIdx = 0;
}

/** 两个快照的增量（测试断言用，避免写死绝对值） */
export function diffStats(after: StatsSnapshot, before: StatsSnapshot): StatsDelta {
  const sub = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = (a[k] ?? 0) - (b[k] ?? 0);
      if (d !== 0) out[k] = d;
    }
    return out;
  };

  const byUserDelta: Record<string, number> = {};
  for (const k of new Set([...Object.keys(after.byUser), ...Object.keys(before.byUser)])) {
    const d = (after.byUser[k]?.calls ?? 0) - (before.byUser[k]?.calls ?? 0);
    if (d !== 0) byUserDelta[k] = d;
  }

  return {
    counters: {
      requests: after.counters.requests - before.counters.requests,
      toolCalls: after.counters.toolCalls - before.counters.toolCalls,
      errors: after.counters.errors - before.counters.errors,
    },
    byMethod: sub(after.byMethod, before.byMethod),
    byTool: sub(after.byTool, before.byTool),
    byUser: byUserDelta,
  };
}
