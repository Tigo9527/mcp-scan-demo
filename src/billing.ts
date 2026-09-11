/**
 * 用户调用计费（RPC Endpoint 风格的「点数」账本）。
 *
 * 模型：每次 `tools/call` 按工具定价扣减该用户的「点数余额」并累加「已消耗」。
 * - 差异化定价：内部/引导类工具免费（0 点），外部 API 类工具较贵（见 TOOL_COST）。
 * - 默认**硬计费**：余额不足时拒绝执行（由 web 层返回 402，见 src/web/app.ts）。
 * - 匿名请求归到 `anonymous` 单桶，仅记消耗、无余额概念（匿名无法计费，收费工具会被要求登录）。
 *
 * 落盘：复用 persist 模块的 scheduleSave，按实例分片 `billing-<instanceId>.json`，
 * 与 stats.ts / store.ts 同一模式。多副本下各写各的，admin 总额仅含本实例（页面已注明「本实例视角」）。
 *
 * 内部逻辑**绝不抛异常**：埋点在 SDK 的请求处理链路上，任何抛出都会被吞掉并转成 400。
 */
import { config } from './config.js';
import { loadJsonSync, scheduleSave } from './persist.js';

const ANONYMOUS = 'anonymous';

/** 差异化定价（点数 / 次）。免费工具 = 0。 */
export const TOOL_COST: Record<string, number> = {
  // 内部 / 引导类，免费
  server_info: 0,
  login: 0,
  web3_login: 0,
  whoami: 0,
  my_stats: 0,
  register_user: 0,
  // 外部 API 调用，按成本计费
  search_repos: 5,
  list_cfx_transfers: 10,
  list_latest_transactions: 10,
};

/** 取某工具的单价；未命中定价表时回退默认单价（env BILLING_DEFAULT_COST，默认 1，且不低于 0）。 */
export function getToolCost(name: string): number {
  if (Object.prototype.hasOwnProperty.call(TOOL_COST, name)) {
    return TOOL_COST[name]!;
  }
  const def = Number(process.env.BILLING_DEFAULT_COST ?? '1');
  return Number.isFinite(def) && def >= 0 ? def : 1;
}

export interface UserBilling {
  userId: string | null;
  /** 累计已消耗点数 */
  used: number;
  /** 当前余额（免费额度 + 充值 - 已消耗）。匿名桶恒为 0（无意义）。 */
  balance: number;
  /** 累计充值所得点数（不含赠送额度） */
  recharged: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface TotalBilling {
  /** 所有用户（含匿名）累计消耗 */
  used: number;
  /** 所有已登录用户余额之和 */
  balance: number;
  /** 计费用户数（不含匿名） */
  users: number;
  /** 匿名桶累计消耗 */
  anonymousUsed: number;
  /** 所有用户累计充值点数 */
  rechargedTotal: number;
  /** 每个用户的明细，按已消耗降序 */
  byUser: Array<{ userId: string | null; username: string; used: number; balance: number }>;
}

export interface Allowance {
  allowed: boolean;
  cost: number;
  balance: number;
  /** 拒绝原因（allowed=false 时有值） */
  reason?: 'insufficient_balance' | 'login_required';
}

const FILE = `billing-${config.instanceId}`;

let loaded = false;
let state: Record<string, UserBilling> = {};

function emptyEntry(userId: string | null, iso: string): UserBilling {
  return {
    userId,
    used: 0,
    balance: userId ? config.billingFreeCredits : 0,
    recharged: 0,
    firstSeenAt: iso,
    lastSeenAt: iso,
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const saved = loadJsonSync<Record<string, UserBilling> | null>(FILE, null);
  if (saved && typeof saved === 'object') {
    state = {};
    for (const [k, v] of Object.entries(saved)) {
      if (!v || typeof v !== 'object') continue;
      state[k] = {
        userId: v.userId ?? (k === ANONYMOUS ? null : k),
        used: Number(v.used) || 0,
        balance: Number(v.balance) || 0,
        recharged: Number(v.recharged) || 0,
        firstSeenAt: v.firstSeenAt ?? new Date().toISOString(),
        lastSeenAt: v.lastSeenAt ?? v.firstSeenAt ?? new Date().toISOString(),
      };
    }
  }
}

function markDirty(): void {
  scheduleSave(FILE, () => structuredClone(state));
}

/**
 * 记录一次工具调用（扣费）。内部绝不抛异常。
 * @param userId 已登录用户 id；匿名传 null（归入 anonymous 桶，仅计消耗）
 * @param toolName 工具名（用于查单价）
 */
export function recordCall(userId: string | null | undefined, toolName: string): void {
  try {
    ensureLoaded();
    const cost = getToolCost(toolName);
    const now = new Date().toISOString();
    const bucket = userId || ANONYMOUS;
    const entry = state[bucket] ?? emptyEntry(userId ?? null, now);
    entry.userId = userId ?? null;
    entry.used += cost;
    // 匿名桶无余额概念，不扣减
    if (bucket !== ANONYMOUS) entry.balance -= cost;
    entry.lastSeenAt = now;
    state[bucket] = entry;
    markDirty();
  } catch (err) {
    console.error('[billing] recordCall 失败：', err instanceof Error ? err.message : String(err));
  }
}

/**
 * 判断某次调用是否被允许（用于硬计费拦截）。
 * - 免费工具（cost=0）永远放行。
 * - 已登录：enforce 时余额需 >= cost，否则 insufficient_balance。
 * - 匿名 + 收费工具：login_required（匿名无法计费，需登录）。
 */
export function checkAllowed(userId: string | null | undefined, toolName: string): Allowance {
  const cost = getToolCost(toolName);
  if (cost <= 0) return { allowed: true, cost, balance: 0 };

  const bucket = userId || ANONYMOUS;
  if (bucket === ANONYMOUS) {
    return { allowed: false, cost, balance: 0, reason: 'login_required' };
  }
  const entry = state[bucket];
  const balance = entry?.balance ?? config.billingFreeCredits;
  if (balance < cost) {
    return { allowed: false, cost, balance, reason: 'insufficient_balance' };
  }
  return { allowed: true, cost, balance };
}

/** 单个用户的计费账本（不含匿名） */
export function getUserBilling(userId: string): UserBilling | null {
  ensureLoaded();
  const entry = state[userId];
  return entry ? structuredClone(entry) : null;
}

/** 单个用户余额（不存在视为满额免费额度） */
export function getBalance(userId: string): number {
  ensureLoaded();
  const entry = state[userId];
  return entry?.balance ?? config.billingFreeCredits;
}

/**
 * 充值入账：给指定用户加余额，并累计 `recharged`。
 *
 * 与 `recordCall` 不同，这里是**显式业务操作**（不是埋点），出错必须让调用方知道，
 * 否则会出现「链上已扣款、点数没到账」的静默故障，故参数非法时直接抛错。
 */
export function creditBalance(userId: string, points: number): UserBilling {
  ensureLoaded();
  if (!userId) throw new Error('creditBalance 需要已登录用户 id');
  const n = Number(points);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`充值点数必须为正数，收到：${String(points)}`);
  }
  const now = new Date().toISOString();
  const entry = state[userId] ?? emptyEntry(userId, now);
  entry.userId = userId;
  entry.balance += n;
  entry.recharged += n;
  entry.lastSeenAt = now;
  state[userId] = entry;
  markDirty();
  return structuredClone(entry);
}

/** 聚合总计费数据（本实例视角） */
export function getTotalBilling(): TotalBilling {
  ensureLoaded();
  let used = 0;
  let balance = 0;
  let users = 0;
  let anonymousUsed = 0;
  let rechargedTotal = 0;
  const rows: Array<{ userId: string | null; username: string; used: number; balance: number }> = [];

  for (const [k, v] of Object.entries(state)) {
    used += v.used;
    if (k === ANONYMOUS) {
      anonymousUsed += v.used;
      rows.push({ userId: null, username: '匿名', used: v.used, balance: 0 });
    } else {
      balance += v.balance;
      rechargedTotal += v.recharged ?? 0;
      users += 1;
      rows.push({ userId: k, username: v.userId ? k : k, used: v.used, balance: v.balance });
    }
  }

  rows.sort((a, b) => b.used - a.used);
  return { used, balance, users, anonymousUsed, rechargedTotal, byUser: rows };
}

/** 定价表（用于页面展示与测试） */
export function getPricingTable(): Array<{ tool: string; cost: number }> {
  return Object.entries(TOOL_COST)
    .map(([tool, cost]) => ({ tool, cost }))
    .sort((a, b) => b.cost - a.cost);
}

/** 测试用：清空内存态（不落盘） */
export function resetBilling(): void {
  loaded = true;
  state = {};
}
