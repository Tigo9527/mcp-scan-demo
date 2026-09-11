/**
 * Crypto 充值：把 EVM 链上转账兑换成计费「点数」。
 *
 * 设计要点：
 * - **链交互全部走可注入的 EvmProvider**：生产用 `ethers.JsonRpcProvider`，测试注入假 provider，
 *   单元测试不联网、不依赖真实链。
 * - **交易完成即到账**：MetaMask 返回哈希后立刻补单；原生币在 receipt 还没打包时（pending）
 *   也按 `tx.value` 入账，ERC20 必须读到 Transfer 事件才认（没有 receipt 无法知道金额）。
 * - **幂等**：同一 txHash 只入账一次，重复提交返回已有记录。
 * - **落盘**：配置是全局项（`recharge-settings`，仿 settings.ts，不按实例分片）；
 *   充值记录按实例分片 `recharge-<instanceId>.json`（与 billing / stats 同一模式）。
 *
 * 金额一律用**最小单位的十进制字符串**存 `rawAmount`，另存人类可读的 `amount`，
 * 避免 JS number 在 18 位精度下失真。
 */
import { config } from './config.js';
import { loadJsonSync, scheduleSave } from './persist.js';
import { creditBalance } from './billing.js';
import {
  Interface,
  JsonRpcProvider,
  formatUnits,
  getAddress,
  id as keccakId,
} from 'ethers';

// ---------------------------------------------------------------- 类型

export interface EvmProvider {
  /** eth_call，用于读 ERC20 的 name/symbol/decimals */
  call(tx: { to: string; data: string }): Promise<string>;
  getTransaction(hash: string): Promise<EvmTransaction | null>;
  getTransactionReceipt(hash: string): Promise<EvmReceipt | null>;
}

export interface EvmTransaction {
  hash: string;
  from?: string;
  to?: string | null;
  /** 原生币金额（最小单位） */
  value?: bigint | string | number;
}

export interface EvmReceipt {
  status?: number | null;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export interface TokenMeta {
  name: string;
  symbol: string;
  decimals: number;
}

export interface RechargeConfig {
  /** 收款地址（0x 开头 40 位十六进制） */
  recipient: string;
  /** EVM RPC 地址 */
  rpcUrl: string;
  /** 1 个代币 / 原生币 兑换多少点数 */
  rate: number;
  /** ERC20 合约地址；空字符串表示收原生币 */
  tokenAddress: string;
  /** 链 ID（可选，仅展示） */
  chainId: string;
  /** 保存配置时自动读取并回显的代币元数据 */
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  updatedAt?: string;
  updatedBy?: string;
}

export type RechargeKind = 'native' | 'erc20';
export type RechargeStatus = 'credited' | 'pending';

export interface RechargeRecord {
  id: string;
  /** 统一小写，幂等判定用 */
  txHash: string;
  userId: string;
  username: string;
  kind: RechargeKind;
  /** 原生币符号或 ERC20 symbol */
  token: string;
  /** 人类可读金额，如 "0.5" */
  amount: string;
  /** 最小单位金额（十进制字符串，避免精度丢失） */
  rawAmount: string;
  /** 本次入账点数 */
  points: number;
  /** 入账时用的汇率 */
  rate: number;
  status: RechargeStatus;
  createdAt: string;
}

export interface VerifiedTx {
  txHash: string;
  kind: RechargeKind;
  token: string;
  amount: string;
  rawAmount: string;
  /** true = 交易尚未打包（仅原生币会出现） */
  pending: boolean;
  from?: string;
}

export interface SubmitResult {
  record: RechargeRecord;
  /** true = 该哈希此前已入账，本次未重复加分 */
  duplicated: boolean;
}

// ---------------------------------------------------------------- 常量 / 存储

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const ERC20_IFACE = new Interface(ERC20_ABI);
/**
 * 解析日志必须用**带 event 声明**的 Interface：ERC20_IFACE 里只有函数，
 * 对它调用 parseLog 永远返回 null（坑：函数与事件不在同一个 ABI 里也能各建各的 Interface）。
 */
const TRANSFER_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const TRANSFER_TOPIC = keccakId('Transfer(address,address,uint256)');

const SETTINGS_FILE = 'recharge-settings';
const RECORD_FILE = `recharge-${config.instanceId}`;

let settingsLoaded = false;
let settings: RechargeConfig | null = null;
let recordsLoaded = false;
let records: RechargeRecord[] = [];

// ---------------------------------------------------------------- provider

/** 生产 provider：按配置的 RPC 地址构造。测试用注入的假 provider，不会走到这里。 */
export function createJsonRpcProvider(rpcUrl: string): EvmProvider {
  const rpc = new JsonRpcProvider(rpcUrl);
  return {
    call: (tx) => rpc.call(tx),
    getTransaction: (hash) => rpc.getTransaction(hash) as Promise<EvmTransaction | null>,
    getTransactionReceipt: (hash) =>
      rpc.getTransactionReceipt(hash) as Promise<EvmReceipt | null>,
  };
}

// ---------------------------------------------------------------- 配置读写

function ensureSettings(): RechargeConfig | null {
  if (!settingsLoaded) {
    settingsLoaded = true;
    settings = loadJsonSync<RechargeConfig | null>(SETTINGS_FILE, null);
  }
  return settings;
}

/** 当前充值配置；未配置返回 null。 */
export function getRechargeConfig(): RechargeConfig | null {
  const s = ensureSettings();
  return s ? { ...s } : null;
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * 校验配置字段。返回 `{ ok: false, error }` 而不是抛异常，便于表单回显。
 */
export function validateRechargeConfig(input: Partial<RechargeConfig>):
  | { ok: true; value: RechargeConfig }
  | { ok: false; error: string } {
  const recipient = String(input.recipient ?? '').trim();
  const rpcUrl = String(input.rpcUrl ?? '').trim();
  const tokenAddress = String(input.tokenAddress ?? '').trim();
  const rate = Number(input.rate);

  if (!ADDRESS_RE.test(recipient)) {
    return { ok: false, error: '收款地址必须是 0x 开头的 40 位十六进制地址。' };
  }
  let normalized: string;
  try {
    normalized = getAddress(recipient);
  } catch {
    return { ok: false, error: '收款地址校验失败（EIP-55 校验和不匹配）。' };
  }
  if (!/^https?:\/\//i.test(rpcUrl)) {
    return { ok: false, error: 'RPC 地址必须是 http(s):// 开头。' };
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    return { ok: false, error: '兑换比率必须是大于 0 的数字（1 个代币兑换多少点数）。' };
  }
  if (tokenAddress && !ADDRESS_RE.test(tokenAddress)) {
    return { ok: false, error: 'ERC20 合约地址必须是 0x 开头的 40 位十六进制地址。' };
  }

  return {
    ok: true,
    value: {
      recipient: normalized,
      rpcUrl,
      rate,
      tokenAddress: tokenAddress ? getAddress(tokenAddress) : '',
      chainId: String(input.chainId ?? '').trim(),
    },
  };
}

/**
 * 保存配置。配置了 ERC20 时会**先读链上元数据**：
 * 读不到（合约不存在 / RPC 不通 / 不是 ERC20）就**不落盘**并返回错误，便于直接修正重填。
 */
export async function setRechargeConfig(
  input: Partial<RechargeConfig>,
  opts: { provider?: EvmProvider } = {},
): Promise<{ ok: true; config: RechargeConfig } | { ok: false; error: string }> {
  const checked = validateRechargeConfig(input);
  if (!checked.ok) return checked;

  const next: RechargeConfig = { ...checked.value };
  if (next.tokenAddress) {
    const provider = opts.provider ?? createJsonRpcProvider(next.rpcUrl);
    try {
      const meta = await readTokenMeta(provider, next.tokenAddress);
      next.tokenName = meta.name;
      next.tokenSymbol = meta.symbol;
      next.tokenDecimals = meta.decimals;
    } catch (err) {
      return {
        ok: false,
        error: `读取 ERC20 元数据失败，配置未保存：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    delete next.tokenName;
    delete next.tokenSymbol;
    delete next.tokenDecimals;
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = 'admin';
  settings = next;
  settingsLoaded = true;
  scheduleSave(SETTINGS_FILE, () => ({ ...next }));
  return { ok: true, config: { ...next } };
}

// ---------------------------------------------------------------- ERC20 元数据

/** 读 ERC20 的 name / symbol / decimals。任一失败即抛错（调用方决定是否落盘）。 */
export async function readTokenMeta(provider: EvmProvider, tokenAddress: string): Promise<TokenMeta> {
  const call = async (fragment: string): Promise<string> => {
    const data = ERC20_IFACE.encodeFunctionData(fragment);
    const raw = await provider.call({ to: tokenAddress, data });
    if (!raw || raw === '0x') throw new Error(`合约未返回 ${fragment}（地址可能不是 ERC20）`);
    return raw;
  };

  const nameRaw = await call('name');
  const symbolRaw = await call('symbol');
  const decimalsRaw = await call('decimals');

  let name = '';
  let symbol = '';
  let decimals = NaN;
  try {
    [name] = ERC20_IFACE.decodeFunctionResult('name', nameRaw);
    [symbol] = ERC20_IFACE.decodeFunctionResult('symbol', symbolRaw);
    const [d] = ERC20_IFACE.decodeFunctionResult('decimals', decimalsRaw);
    decimals = Number(d);
  } catch {
    throw new Error('合约返回的元数据无法解码（地址可能不是标准 ERC20）');
  }
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`decimals 取值异常：${decimalsRaw}`);
  }
  return { name: String(name), symbol: String(symbol), decimals };
}

// ---------------------------------------------------------------- 链上校验

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') {
    const s = v.trim();
    try {
      return s.startsWith('0x') || s.startsWith('0X') ? BigInt(s) : BigInt(s);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function sameAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 校验一笔转账是否付给本服务的收款地址，并解析金额。
 *
 * - 原生币：读 `tx.value`；receipt 还没打包也认（pending），满足「交易完成即到账」。
 * - ERC20：必须读到 receipt 的 Transfer 事件才知道金额，故 receipt 为 null 时抛错「尚未打包」。
 */
export async function verifyRechargeTx(
  provider: EvmProvider,
  cfg: RechargeConfig,
  txHash: string,
): Promise<VerifiedTx> {
  const hash = String(txHash ?? '').trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) {
    throw new Error('交易哈希格式不正确（应为 0x 开头 64 位十六进制）。');
  }

  const tx = await provider.getTransaction(hash);
  if (!tx) throw new Error('链上查不到这笔交易，请确认哈希与所在网络是否正确。');

  if (cfg.tokenAddress) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) {
      throw new Error('该 ERC20 转账尚未打包，请稍后重试补单。');
    }
    if (receipt.status === 0) {
      throw new Error('这笔交易在链上失败了（status=0），无法入账。');
    }
    const decimals = cfg.tokenDecimals ?? 18;
    let matched: bigint | null = null;
    for (const log of receipt.logs ?? []) {
      if (!sameAddress(log.address, cfg.tokenAddress)) continue;
      if (!log.topics || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
      try {
        const parsed = TRANSFER_IFACE.parseLog({ topics: log.topics, data: log.data });
        const to = String(parsed?.args?.[1] ?? '');
        if (!sameAddress(to, cfg.recipient)) continue;
        const value = toBigInt(parsed?.args?.[2]);
        if (value > 0n) matched = (matched ?? 0n) + value;
      } catch {
        continue; // 非本合约的 Transfer，跳过
      }
    }
    if (matched === null || matched <= 0n) {
      throw new Error('这笔交易里没有转给收款地址的代币，请确认哈希、收款地址与代币合约。');
    }
    const amount = formatUnits(matched, decimals);
    return {
      txHash: hash.toLowerCase(),
      kind: 'erc20',
      token: cfg.tokenSymbol || 'ERC20',
      amount,
      rawAmount: matched.toString(),
      pending: false,
      from: tx.from,
    };
  }

  // 原生币
  if (!sameAddress(tx.to, cfg.recipient)) {
    throw new Error('这笔交易的收款地址与本服务配置不一致。');
  }
  const value = toBigInt(tx.value);
  if (value <= 0n) throw new Error('转账金额为 0，无法入账。');
  const receipt = await provider.getTransactionReceipt(hash);
  if (receipt && receipt.status === 0) {
    throw new Error('这笔交易在链上失败了（status=0），无法入账。');
  }
  return {
    txHash: hash.toLowerCase(),
    kind: 'native',
    token: 'ETH',
    amount: formatUnits(value, 18),
    rawAmount: value.toString(),
    pending: !receipt,
    from: tx.from,
  };
}

// ---------------------------------------------------------------- 入账

function ensureRecords(): RechargeRecord[] {
  if (!recordsLoaded) {
    recordsLoaded = true;
    const saved = loadJsonSync<RechargeRecord[] | null>(RECORD_FILE, null);
    records = Array.isArray(saved) ? saved.filter((r) => r && typeof r === 'object') : [];
  }
  return records;
}

function markRecordsDirty(): void {
  scheduleSave(RECORD_FILE, () => structuredClone(records));
}

function calcPoints(amount: string, rate: number): number {
  const n = Number(amount) * rate;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * 提交一笔充值（幂等）。
 *
 * 同一 txHash 只入账一次：命中历史记录时直接返回原记录（duplicated=true），
 * 不会二次加分。校验不通过时抛错，由页面展示——**失败不入历史**，方便重试。
 */
export async function submitRechargeTx(
  params: { userId: string; username?: string; txHash: string },
  opts: { provider?: EvmProvider } = {},
): Promise<SubmitResult> {
  const cfg = getRechargeConfig();
  if (!cfg) throw new Error('尚未配置充值收款地址，请联系管理员。');

  const hash = String(params.txHash ?? '').trim().toLowerCase();
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) {
    throw new Error('交易哈希格式不正确（应为 0x 开头 64 位十六进制）。');
  }

  const all = ensureRecords();
  const existing = all.find((r) => r.txHash === hash);
  if (existing) return { record: { ...existing }, duplicated: true };

  const provider = opts.provider ?? createJsonRpcProvider(cfg.rpcUrl);
  const verified = await verifyRechargeTx(provider, cfg, hash);
  const points = calcPoints(verified.amount, cfg.rate);
  if (points <= 0) {
    throw new Error('按当前汇率换算的点数为 0，请提高转账金额或调整汇率。');
  }

  creditBalance(params.userId, points);

  const record: RechargeRecord = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    txHash: hash,
    userId: params.userId,
    username: params.username ?? params.userId,
    kind: verified.kind,
    token: verified.token,
    amount: verified.amount,
    rawAmount: verified.rawAmount,
    points,
    rate: cfg.rate,
    status: verified.pending ? 'pending' : 'credited',
    createdAt: new Date().toISOString(),
  };
  records = [...all, record];
  markRecordsDirty();
  return { record: { ...record }, duplicated: false };
}

// ---------------------------------------------------------------- 查询

export interface RechargeFilter {
  userId?: string;
  kind?: RechargeKind | '';
  status?: RechargeStatus | '';
}

/** 充值历史：不传 userId 时返回全部（admin 视角），按时间倒序。 */
export function listRecharges(filter: RechargeFilter = {}): RechargeRecord[] {
  const all = ensureRecords();
  return all
    .filter((r) => !filter.userId || r.userId === filter.userId)
    .filter((r) => !filter.kind || r.kind === filter.kind)
    .filter((r) => !filter.status || r.status === filter.status)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export interface RechargeStats {
  count: number;
  points: number;
  nativePoints: number;
  erc20Points: number;
  pendingCount: number;
}

export function getRechargeStats(list?: RechargeRecord[]): RechargeStats {
  const rows = list ?? ensureRecords();
  let points = 0;
  let nativePoints = 0;
  let erc20Points = 0;
  let pendingCount = 0;
  for (const r of rows) {
    points += r.points;
    if (r.kind === 'native') nativePoints += r.points;
    else erc20Points += r.points;
    if (r.status === 'pending') pendingCount += 1;
  }
  return { count: rows.length, points, nativePoints, erc20Points, pendingCount };
}

/** 测试用：清空内存态（不落盘）。 */
export function __resetForTest(): void {
  settingsLoaded = true;
  settings = null;
  recordsLoaded = true;
  records = [];
}
