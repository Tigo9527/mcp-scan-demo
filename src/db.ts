/**
 * SQLite 存储层（Sequelize ORM）。
 *
 * 设计要点：
 * - 用 Sequelize 管理表结构（`sync()` 自动建表）与原生类型 / 查询，替代原来的「JSON 文件 + 自定义原子写」。
 * - 内存态仍是各业务模块的热点缓存（避免每次请求都查库）；落库走**防抖 + 串行化**的
 *   `scheduleDbWrite`（沿用旧 persist 层的防抖策略，避免热路径上频繁写盘）。
 * - 启动期 `initDb()` 负责连库、建表、把旧 JSON 数据自动导入；随后 `loadAllStores()`
 *   （在 index.ts 里于 `app.listen` 之前调用）把各模块内存态预热，之后请求直接走内存。
 * - `MCP_DEMO_PERSIST=0` 或 `configureDb({ enabled: false })` 会关停 DB：模块退回纯内存态，
 *   测试期间即此模式（不落库、不连 sqlite），行为与旧 `enabled:false` 一致。
 * - 永不抛出：写库失败只记录 lastError，绝不因为落盘问题让服务崩溃。
 * - 双方言：默认 `sqlite`；设 `STORAGE_DRIVER=mysql` 可切换为 MySQL（Sequelize 方言切换，
 *   模型无需改动）。MySQL 连接优先读 `MYSQL_URL`，否则读 `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Sequelize, DataTypes, Model } from 'sequelize';
import { config } from './config.js';

import type { User } from './auth/store.js';
import type { UserBilling } from './billing.js';
import type { StatsSnapshot } from './stats.js';
import type { RechargeConfig, RechargeRecord } from './recharge.js';
import type { GithubSettings } from './settings.js';

// ---------------------------------------------------------------- 配置

interface Overrides {
  dataDir?: string;
  enabled?: boolean;
}
let overrides: Overrides = {};

function isEnabled(): boolean {
  if (overrides.enabled !== undefined) return overrides.enabled;
  return process.env.MCP_DEMO_PERSIST !== '0';
}

function resolveDataDir(): string {
  return overrides.dataDir ?? process.env.DATA_DIR ?? config.dataDir;
}

// ---------------------------------------------------------------- 方言选择（sqlite / mysql）

export type StorageDriver = 'sqlite' | 'mysql';

/**
 * 当前存储方言：默认 sqlite，可由 `STORAGE_DRIVER` 环境变量切换为 mysql。
 * 非法值直接抛错（fail-fast），避免「本想用 MySQL 却悄悄落到本地 sqlite」导致数据错写。
 */
function resolveDriver(): StorageDriver {
  const raw = process.env.STORAGE_DRIVER?.trim();
  if (!raw) return 'sqlite';
  const v = raw.toLowerCase();
  if (v === 'sqlite') return 'sqlite';
  if (v === 'mysql') return 'mysql';
  throw new Error(
    `STORAGE_DRIVER 取值非法: "${raw}"（仅支持 sqlite 或 mysql）。` +
      `未设置时默认 sqlite；若本想用 MySQL，请检查拼写。`,
  );
}

export interface MySqlOptions {
  url?: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** 解析 MySQL 连接参数：优先 `MYSQL_URL`（完整连接串），否则读各分项（带默认值）。 */
export function resolveMysqlOptions(): MySqlOptions {
  const url = process.env.MYSQL_URL?.trim() || undefined;
  return {
    url,
    host: process.env.MYSQL_HOST?.trim() || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? '3306') || 3306,
    user: process.env.MYSQL_USER?.trim() || 'root',
    // 口令不做 trim：首尾空白可能是有效凭据的一部分，误删会导致认证失败。
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE?.trim() || 'mcp_demo',
  };
}

/** 把解析出的方言 / 连接参数转成 Sequelize 构造选项（不建立连接），便于测试断言。 */
export function resolveSequelizeOptions(driver: StorageDriver): Record<string, unknown> {
  if (driver === 'mysql') {
    const o = resolveMysqlOptions();
    if (o.url) return { dialect: 'mysql', url: o.url, logging: false };
    return {
      dialect: 'mysql',
      host: o.host,
      port: o.port,
      username: o.user,
      password: o.password,
      database: o.database,
      logging: false,
    };
  }
  return { dialect: 'sqlite', logging: false };
}

/** 人类可读的存储位置描述（sqlite 为文件路径，mysql 为 host/db，不含口令）。 */
function describeStorage(): string {
  if (driverKind === 'mysql') {
    const o = resolveMysqlOptions();
    if (o.url) return describeMySqlUrl(o.url);
    return `mysql://${o.host}:${o.port}/${o.database}`;
  }
  return storagePath || resolveDataDir();
}

/** 从 MYSQL_URL 解析出不含口令的 redacted 描述（mysql://host:port/db）。 */
function describeMySqlUrl(url: string): string {
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\/+/, '');
    const port = u.port || '3306';
    return `mysql://${u.hostname}:${port}/${db}`;
  } catch {
    return 'mysql://(invalid-url)';
  }
}

// ---------------------------------------------------------------- Sequelize 实例与模型

let sequelize: Sequelize | null = null;
let storagePath = '';
let driverKind: StorageDriver = 'sqlite';
let saves = 0;
let lastError: string | null = null;

export function dbEnabled(): boolean {
  return sequelize !== null && isEnabled();
}

export function getStoragePath(): string {
  return describeStorage();
}

export class UserModel extends Model {}
export class BillingModel extends Model {}
export class RechargeSettingModel extends Model {}
export class RechargeRecordModel extends Model {}
export class GithubSettingModel extends Model {}
export class StatsModel extends Model {}

function defineModels(seq: Sequelize): void {
  UserModel.init(
    {
      id: { type: DataTypes.STRING, primaryKey: true },
      username: { type: DataTypes.STRING, allowNull: false },
      email: { type: DataTypes.STRING, allowNull: true },
      provider: { type: DataTypes.STRING, allowNull: false },
      githubLogin: { type: DataTypes.STRING, allowNull: true },
      githubToken: { type: DataTypes.TEXT, allowNull: true },
      passwordHash: { type: DataTypes.TEXT, allowNull: true },
      walletAddress: { type: DataTypes.STRING, allowNull: true },
      createdAt: { type: DataTypes.STRING, allowNull: true },
      lastSeenAt: { type: DataTypes.STRING, allowNull: true },
      clientInfo: { type: DataTypes.TEXT, allowNull: true },
    },
    { sequelize: seq, timestamps: false, modelName: 'user', tableName: 'users' },
  );

  BillingModel.init(
    {
      userId: { type: DataTypes.STRING, primaryKey: true },
      used: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      balance: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      recharged: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      firstSeenAt: { type: DataTypes.STRING, allowNull: true },
      lastSeenAt: { type: DataTypes.STRING, allowNull: true },
    },
    { sequelize: seq, timestamps: false, modelName: 'billing', tableName: 'billing' },
  );

  RechargeSettingModel.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
      recipient: { type: DataTypes.STRING, allowNull: false },
      rpcUrl: { type: DataTypes.TEXT, allowNull: false },
      rate: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      tokenAddress: { type: DataTypes.STRING, allowNull: true },
      tokenDecimals: { type: DataTypes.INTEGER, allowNull: true },
      chainId: { type: DataTypes.STRING, allowNull: true },
      tokenName: { type: DataTypes.STRING, allowNull: true },
      tokenSymbol: { type: DataTypes.STRING, allowNull: true },
      tokenMetaError: { type: DataTypes.TEXT, allowNull: true },
      updatedAt: { type: DataTypes.STRING, allowNull: true },
      updatedBy: { type: DataTypes.STRING, allowNull: true },
    },
    { sequelize: seq, timestamps: false, modelName: 'rechargeSetting', tableName: 'recharge_settings' },
  );

  RechargeRecordModel.init(
    {
      id: { type: DataTypes.STRING, primaryKey: true },
      txHash: { type: DataTypes.STRING, allowNull: false, unique: true },
      userId: { type: DataTypes.STRING, allowNull: false },
      username: { type: DataTypes.STRING, allowNull: false },
      kind: { type: DataTypes.STRING, allowNull: false },
      token: { type: DataTypes.STRING, allowNull: false },
      amount: { type: DataTypes.STRING, allowNull: false },
      rawAmount: { type: DataTypes.TEXT, allowNull: false },
      points: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      rate: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      status: { type: DataTypes.STRING, allowNull: false },
      createdAt: { type: DataTypes.STRING, allowNull: true },
    },
    { sequelize: seq, timestamps: false, modelName: 'rechargeRecord', tableName: 'recharge_records' },
  );

  GithubSettingModel.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
      clientId: { type: DataTypes.TEXT, allowNull: true },
      clientSecret: { type: DataTypes.TEXT, allowNull: true },
      redirectUri: { type: DataTypes.TEXT, allowNull: true },
      scope: { type: DataTypes.TEXT, allowNull: true },
      updatedAt: { type: DataTypes.STRING, allowNull: true },
      updatedBy: { type: DataTypes.STRING, allowNull: true },
    },
    { sequelize: seq, timestamps: false, modelName: 'githubSetting', tableName: 'github_settings' },
  );

  StatsModel.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
      since: { type: DataTypes.STRING, allowNull: true },
      counters: { type: DataTypes.TEXT, allowNull: true },
      byMethod: { type: DataTypes.TEXT, allowNull: true },
      byTool: { type: DataTypes.TEXT, allowNull: true },
      byUser: { type: DataTypes.TEXT, allowNull: true },
      byDay: { type: DataTypes.TEXT, allowNull: true },
      recent: { type: DataTypes.TEXT, allowNull: true },
      recentIdx: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { sequelize: seq, timestamps: false, modelName: 'stats', tableName: 'stats' },
  );
}

// ---------------------------------------------------------------- 行 ↔ 域对象 转换

function toUserRow(u: User): Record<string, unknown> {
  return {
    id: u.id,
    username: u.username,
    email: u.email ?? null,
    provider: u.provider,
    githubLogin: u.githubLogin ?? null,
    githubToken: u.githubToken ?? null,
    passwordHash: u.passwordHash ?? null,
    walletAddress: u.walletAddress ?? null,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt ?? null,
    clientInfo: JSON.stringify(u.clientInfo ?? null),
  };
}

function fromUserRow(r: Record<string, unknown>): User {
  let clientInfo: User['clientInfo'];
  if (r.clientInfo) {
    try {
      clientInfo = JSON.parse(String(r.clientInfo)) as User['clientInfo'];
    } catch {
      clientInfo = undefined;
    }
  }
  return {
    id: String(r.id),
    username: String(r.username),
    email: (r.email as string | null) ?? null,
    provider: r.provider as User['provider'],
    githubLogin: (r.githubLogin as string | null) ?? undefined,
    githubToken: (r.githubToken as string | null) ?? undefined,
    passwordHash: (r.passwordHash as string | null) ?? undefined,
    walletAddress: (r.walletAddress as string | null) ?? undefined,
    createdAt: String(r.createdAt ?? ''),
    lastSeenAt: (r.lastSeenAt as string | null) ?? undefined,
    clientInfo: clientInfo ?? undefined,
  };
}

function toBillingRow(userId: string, b: UserBilling): Record<string, unknown> {
  return {
    userId,
    used: b.used | 0,
    balance: b.balance | 0,
    recharged: b.recharged | 0,
    firstSeenAt: b.firstSeenAt,
    lastSeenAt: b.lastSeenAt,
  };
}

function fromBillingRow(r: Record<string, unknown>): { key: string; entry: UserBilling } {
  const userId = r.userId === 'anonymous' ? null : String(r.userId);
  return {
    key: String(r.userId),
    entry: {
      userId,
      used: Number(r.used) || 0,
      balance: Number(r.balance) || 0,
      recharged: Number(r.recharged) || 0,
      firstSeenAt: String(r.firstSeenAt ?? ''),
      lastSeenAt: String(r.lastSeenAt ?? r.firstSeenAt ?? ''),
    },
  };
}

function toSettingsRow(c: RechargeConfig): Record<string, unknown> {
  return {
    id: 1,
    recipient: c.recipient,
    rpcUrl: c.rpcUrl,
    rate: c.rate,
    tokenAddress: c.tokenAddress || null,
    tokenDecimals: c.tokenDecimals ?? null,
    chainId: c.chainId || null,
    tokenName: c.tokenName ?? null,
    tokenSymbol: c.tokenSymbol ?? null,
    tokenMetaError: c.tokenMetaError ?? null,
    updatedAt: c.updatedAt ?? null,
    updatedBy: c.updatedBy ?? null,
  };
}

function fromSettingsRow(r: Record<string, unknown>): RechargeConfig {
  return {
    recipient: String(r.recipient),
    rpcUrl: String(r.rpcUrl),
    rate: Number(r.rate) || 0,
    tokenAddress: (r.tokenAddress as string | null) || '',
    chainId: (r.chainId as string | null) || '',
    tokenDecimals: (r.tokenDecimals as number | null) ?? undefined,
    tokenName: (r.tokenName as string | null) ?? undefined,
    tokenSymbol: (r.tokenSymbol as string | null) ?? undefined,
    tokenMetaError: (r.tokenMetaError as string | null) ?? undefined,
    updatedAt: (r.updatedAt as string | null) ?? undefined,
    updatedBy: (r.updatedBy as string | null) ?? undefined,
  };
}

function toRecordRow(r: RechargeRecord): Record<string, unknown> {
  return {
    id: r.id,
    txHash: r.txHash,
    userId: r.userId,
    username: r.username,
    kind: r.kind,
    token: r.token,
    amount: r.amount,
    rawAmount: r.rawAmount,
    points: r.points,
    rate: r.rate,
    status: r.status,
    createdAt: r.createdAt,
  };
}

function fromRecordRow(r: Record<string, unknown>): RechargeRecord {
  return {
    id: String(r.id),
    txHash: String(r.txHash),
    userId: String(r.userId),
    username: String(r.username),
    kind: r.kind as RechargeRecord['kind'],
    token: String(r.token),
    amount: String(r.amount),
    rawAmount: String(r.rawAmount),
    points: Number(r.points) || 0,
    rate: Number(r.rate) || 0,
    status: r.status as RechargeRecord['status'],
    createdAt: String(r.createdAt ?? ''),
  };
}

function toGithubRow(s: GithubSettings): Record<string, unknown> {
  return {
    id: 1,
    clientId: s.clientId ?? null,
    clientSecret: s.clientSecret ?? null,
    redirectUri: s.redirectUri ?? null,
    scope: s.scope ?? null,
    updatedAt: s.updatedAt ?? null,
    updatedBy: s.updatedBy ?? null,
  };
}

function fromGithubRow(r: Record<string, unknown>): GithubSettings {
  return {
    clientId: (r.clientId as string | null) ?? undefined,
    clientSecret: (r.clientSecret as string | null) ?? undefined,
    redirectUri: (r.redirectUri as string | null) ?? undefined,
    scope: (r.scope as string | null) ?? undefined,
    updatedAt: (r.updatedAt as string | null) ?? undefined,
    updatedBy: (r.updatedBy as string | null) ?? undefined,
  };
}

function toStatsRow(s: StatsSnapshot, recentIdx: number): Record<string, unknown> {
  return {
    id: 1,
    since: s.since,
    counters: JSON.stringify(s.counters),
    byMethod: JSON.stringify(s.byMethod),
    byTool: JSON.stringify(s.byTool),
    byUser: JSON.stringify(s.byUser),
    byDay: JSON.stringify(s.byDay),
    recent: JSON.stringify(s.recent),
    recentIdx,
  };
}

function fromStatsRow(r: Record<string, unknown>): { snapshot: StatsSnapshot; recentIdx: number } {
  const parse = (v: unknown, fallback: unknown) => {
    if (!v) return fallback;
    try {
      return JSON.parse(String(v));
    } catch {
      return fallback;
    }
  };
  const counters = parse(r.counters, { requests: 0, toolCalls: 0, errors: 0 });
  return {
    snapshot: {
      since: String(r.since ?? ''),
      counters,
      byMethod: parse(r.byMethod, {}) as StatsSnapshot['byMethod'],
      byTool: parse(r.byTool, {}) as StatsSnapshot['byTool'],
      byUser: parse(r.byUser, {}) as StatsSnapshot['byUser'],
      byDay: parse(r.byDay, {}) as StatsSnapshot['byDay'],
      recent: parse(r.recent, []) as StatsSnapshot['recent'],
    },
    recentIdx: Number(r.recentIdx) || 0,
  };
}

// ---------------------------------------------------------------- 启动 / 迁移

/** 测试期覆盖（优先于环境变量）。传 `{ enabled: false }` 可完全关停 DB。 */
export function configureDb(next: Overrides): void {
  overrides = { ...overrides, ...next };
}

/** 旧 JSON 数据自动导入：仅当对应表为空时才导入，保证幂等（重复启动不重复导入）。 */
async function migrateLegacyJson(dir: string): Promise<void> {
  const readJson = (name: string): unknown => {
    try {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) return undefined;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return undefined;
    }
  };

  if ((await UserModel.count()) === 0) {
    const data = readJson('users.json') as { users?: User[] } | undefined;
    const users = (data?.users ?? []).filter((u) => u?.id && u?.username);
    if (users.length) await UserModel.bulkCreate(users.map(toUserRow));
  }

  if ((await BillingModel.count()) === 0) {
    const data = readJson('billing.json') as Record<string, UserBilling> | undefined;
    const rows: Record<string, unknown>[] = [];
    for (const [k, v] of Object.entries(data ?? {})) {
      if (!v || typeof v !== 'object') continue;
      rows.push(toBillingRow(k, v));
    }
    if (rows.length) await BillingModel.bulkCreate(rows);
  }

  if ((await RechargeRecordModel.count()) === 0) {
    const data = readJson('recharge.json') as RechargeRecord[] | undefined;
    const rows = (Array.isArray(data) ? data : []).filter((r) => r && typeof r === 'object');
    if (rows.length) await RechargeRecordModel.bulkCreate(rows.map(toRecordRow));
  }

  if ((await RechargeSettingModel.count()) === 0) {
    const data = readJson('recharge-settings.json') as RechargeConfig | undefined;
    if (data && data.recipient) await RechargeSettingModel.create(toSettingsRow(data));
  }

  if ((await GithubSettingModel.count()) === 0) {
    const data = readJson('settings.json') as GithubSettings | undefined;
    if (data && (data.clientId !== undefined || data.clientSecret !== undefined)) {
      await GithubSettingModel.create(toGithubRow(data));
    }
  }

  if ((await StatsModel.count()) === 0) {
    const data = readJson('stats.json') as StatsSnapshot | undefined;
    if (data && data.counters) {
      await StatsModel.create(toStatsRow(data, (data.recent?.length ?? 0) % 200));
    }
  }
}

/** 把已迁移的遗留 JSON 移出 data/，保持目录里只有 .sqlite。失败不阻塞。 */
function archiveLegacyJson(dir: string): void {
  const names = [
    'users.json',
    'billing.json',
    'recharge.json',
    'recharge-settings.json',
    'settings.json',
    'stats.json',
    'users.json.bak',
    'billing.json.bak',
    'recharge.json.bak',
    'recharge-settings.json.bak',
    'settings.json.bak',
    'stats.json.bak',
  ];
  const dest = path.join(dir, '_migrated_json');
  for (const n of names) {
    const src = path.join(dir, n);
    if (!fs.existsSync(src)) continue;
    try {
      fs.mkdirSync(dest, { recursive: true });
      fs.renameSync(src, path.join(dest, n));
    } catch {
      /* 忽略：迁移已成功，留着旧文件不影响 */
    }
  }
}

/**
 * 连接并初始化数据库。仅在 `enabled` 时连库（sqlite 或 mysql，由 `STORAGE_DRIVER` 决定）；
 * 否则置空（模块退回纯内存）。可在同进程内多次调用（测试：不同 dataDir 重建实例），
 * 会自动关掉上一个连接。
 */
export async function initDb(opts: Overrides = {}): Promise<void> {
  overrides = { ...overrides, ...opts };
  if (!isEnabled()) {
    await closeDb();
    driverKind = resolveDriver();
    return;
  }

  await closeDb();
  driverKind = resolveDriver();

  if (driverKind === 'mysql') {
    const o = resolveMysqlOptions();
    if (o.url) {
      sequelize = new Sequelize(o.url, { dialect: 'mysql', logging: false });
    } else {
      sequelize = new Sequelize({
        dialect: 'mysql',
        host: o.host,
        port: o.port,
        username: o.user,
        password: o.password,
        database: o.database,
        logging: false,
      });
    }
    defineModels(sequelize);
    await sequelize.authenticate();
    await sequelize.sync();
    // 受保护的遗留数据导入：仅当各表为空时，才从 DATA_DIR 下的旧 JSON 导入，
    // 避免「指向 MySQL 却以空库静默启动」。注意 sqlite→mysql 的库内迁移不在此自动完成。
    await migrateLegacyJson(resolveDataDir());
    saves = 0;
    lastError = null;
    return;
  }

  // 默认：sqlite
  const dir = resolveDataDir();
  storagePath = path.join(dir, 'mcp-demo.sqlite');
  await fs.promises.mkdir(dir, { recursive: true });

  const fresh = !fs.existsSync(storagePath);
  sequelize = new Sequelize({ dialect: 'sqlite', storage: storagePath, logging: false });
  defineModels(sequelize);
  await sequelize.authenticate();
  await sequelize.sync();
  // 写并发更好（热路径频繁落盘），且崩溃恢复更稳
  try {
    await sequelize.query('PRAGMA journal_mode=WAL');
  } catch {
    /* 忽略：非致命 */
  }

  if (fresh) {
    await migrateLegacyJson(dir);
    archiveLegacyJson(dir);
  }
  saves = 0;
  lastError = null;
}

// ---------------------------------------------------------------- 各数据集读取

export async function loadUsers(): Promise<User[]> {
  if (!dbEnabled()) return [];
  const rows = (await UserModel.findAll()) as unknown as Record<string, unknown>[];
  return rows.map(fromUserRow);
}

export async function loadBilling(): Promise<Record<string, UserBilling>> {
  if (!dbEnabled()) return {};
  const rows = (await BillingModel.findAll()) as unknown as Record<string, unknown>[];
  const out: Record<string, UserBilling> = {};
  for (const r of rows) {
    const { key, entry } = fromBillingRow(r);
    out[key] = entry;
  }
  return out;
}

export async function loadRechargeRecords(): Promise<RechargeRecord[]> {
  if (!dbEnabled()) return [];
  const rows = (await RechargeRecordModel.findAll({
    order: [['createdAt', 'DESC']],
  })) as unknown as Record<string, unknown>[];
  return rows.map(fromRecordRow);
}

export async function loadRechargeSettings(): Promise<RechargeConfig | null> {
  if (!dbEnabled()) return null;
  const row = (await RechargeSettingModel.findByPk(1)) as unknown as Record<string, unknown> | null;
  return row ? fromSettingsRow(row) : null;
}

export async function loadGithubSettings(): Promise<GithubSettings | null> {
  if (!dbEnabled()) return null;
  const row = (await GithubSettingModel.findByPk(1)) as unknown as Record<string, unknown> | null;
  return row ? fromGithubRow(row) : null;
}

export async function loadStats(): Promise<{ snapshot: StatsSnapshot; recentIdx: number } | null> {
  if (!dbEnabled()) return null;
  const row = (await StatsModel.findByPk(1)) as unknown as Record<string, unknown> | null;
  return row ? fromStatsRow(row) : null;
}

// ---------------------------------------------------------------- 各数据集写入（供 scheduleDbWrite 调用）

export async function saveUsers(users: User[]): Promise<void> {
  if (!sequelize) return;
  await UserModel.destroy({ where: {} });
  if (users.length) await UserModel.bulkCreate(users.map(toUserRow));
}

export async function saveBilling(state: Record<string, UserBilling>): Promise<void> {
  if (!sequelize) return;
  await BillingModel.destroy({ where: {} });
  const rows = Object.entries(state).map(([k, v]) => toBillingRow(k, v));
  if (rows.length) await BillingModel.bulkCreate(rows);
}

export async function saveRechargeRecords(records: RechargeRecord[]): Promise<void> {
  if (!sequelize) return;
  await RechargeRecordModel.destroy({ where: {} });
  if (records.length) await RechargeRecordModel.bulkCreate(records.map(toRecordRow));
}

export async function saveRechargeSettings(cfg: RechargeConfig | null): Promise<void> {
  if (!sequelize) return;
  if (!cfg) {
    await RechargeSettingModel.destroy({ where: { id: 1 } });
    return;
  }
  await RechargeSettingModel.upsert(toSettingsRow(cfg) as Record<string, unknown> & { id: number });
}

export async function saveGithubSettings(s: GithubSettings): Promise<void> {
  if (!sequelize) return;
  await GithubSettingModel.upsert(toGithubRow(s) as Record<string, unknown> & { id: number });
}

export async function saveStats(snapshot: StatsSnapshot, recentIdx: number): Promise<void> {
  if (!sequelize) return;
  await StatsModel.upsert(toStatsRow(snapshot, recentIdx) as Record<string, unknown> & { id: number });
}

// ---------------------------------------------------------------- 防抖写入（同旧 persist 策略）

const pending = new Map<string, () => Promise<void>>();
const timers = new Map<string, NodeJS.Timeout>();
const firstAt = new Map<string, number>();
const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 5000;

/** 排队写库（防抖 300ms、最长 5s 强制刷、同 key 串行化）。DB 关时无任何操作。 */
export function scheduleDbWrite(name: string, task: () => Promise<void>): void {
  if (!dbEnabled()) return;
  pending.set(name, task);

  const now = Date.now();
  if (!firstAt.has(name)) firstAt.set(name, now);
  const delay = now - (firstAt.get(name) as number) >= MAX_WAIT_MS ? 0 : DEBOUNCE_MS;

  const existing = timers.get(name);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    timers.delete(name);
    void runNow(name);
  }, delay);
  if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
    (t as unknown as { unref: () => void }).unref();
  }
  timers.set(name, t);
}

async function runNow(name: string): Promise<void> {
  const prev = pending.get(name);
  if (!prev) return;
  pending.delete(name);
  firstAt.delete(name);
  try {
    await prev();
    saves += 1;
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    // 落库失败不影响服务，仅记录
    console.error(`[db] 写入 ${name} 失败：${lastError}`);
  }
}

/** 立即刷回所有待写数据（退出前 / 测试里调用）。 */
export async function flushDb(): Promise<void> {
  const names = [...pending.keys()];
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  await Promise.all(names.map((n) => runNow(n)));
}

export async function closeDb(): Promise<void> {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  pending.clear();
  firstAt.clear();
  if (sequelize) {
    try {
      await sequelize.close();
    } catch {
      /* 忽略 */
    }
    sequelize = null;
  }
}

export interface DbStatus {
  enabled: boolean;
  db: string;
  storage: string;
  writable: boolean;
  saves: number;
  lastError: string | null;
}

export function persistStatus(): DbStatus {
  return {
    enabled: dbEnabled(),
    db: driverKind,
    storage: describeStorage(),
    writable: lastError === null,
    saves,
    lastError,
  };
}

/** 注册退出前的 flush（直接 kill 也会尽量落库）。 */
export function registerShutdownFlush(): void {
  const onExit = (): void => {
    void flushDb().catch(() => undefined);
  };
  process.on('SIGTERM', onExit);
  process.on('SIGINT', onExit);
  process.on('beforeExit', onExit);
}

// 兼容旧测试：保留 persist.ts 时期的别名
export const configure = configureDb;
export const flush = flushDb;
