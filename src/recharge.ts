/**
 * Crypto 充值：把 EVM 链上转账兑换成计费「点数」。
 *
 * 设计要点：
 * - **链交互全部走可注入的 EvmProvider**：生产用 `ethers.JsonRpcProvider`，测试注入假 provider，
 *   单元测试不联网、不依赖真实链。
 * - **交易完成即到账**：MetaMask 返回哈希后立刻补单；原生币在 receipt 还没打包时（pending）
 *   也按 `tx.value` 入账，ERC20 必须读到 Transfer 事件才认（没有 receipt 无法知道金额）。
 * - **幂等**：同一 txHash 只入账一次，重复提交返回已有记录。
 * - **落盘**：配置是全局项（`recharge-settings`，仿 settings.ts）；
 *   充值记录单一文件 `recharge.json`（与 billing / stats 同一模式）。
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

/**
 * 「交易还没被节点看到 / 还没打包」——这类错误是**可重试**的：
 * 前端应当留在页面上后台轮询，而不是把错误甩给用户让他手动重试。
 */
export class RechargePendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RechargePendingError';
  }
}

export interface EvmProvider {
  /** eth_call，用于读 ERC20 的 name/symbol/decimals */
  call(tx: { to: string; data: string }): Promise<string>;
  getTransaction(hash: string): Promise<EvmTransaction | null>;
  getTransactionReceipt(hash: string): Promise<EvmReceipt | null>;
  /**
   * eth_chainId（可选）。用于保存配置时自动回填链 ID。
   * 可选是为了不破坏测试里的假 provider（没实现时当作「读不到」，跳过回填）。
   */
  getChainId?(): Promise<string>;
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
  /**
   * 链 ID（十六进制，如 `0x1`）。
   *
   * 它不再只是展示用：前端会在转账前比对钱包的 `eth_chainId`，
   * 不一致就唤起 `wallet_switchEthereumChain`。填错等于让用户把钱转到别的链上。
   * 保存时一定以 RPC 实际返回的为准（见 setRechargeConfig）。
   */
  chainId: string;
  /** 保存配置时自动读取并回显的代币元数据 */
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  /**
   * 最近一次**自动**读取 ERC20 元数据失败的原因（已转成人话）。
   * 有值只代表「元数据没读到」——配置**照常保存**，页面会给出告警；
   * 但 `tokenDecimals` 缺失时入账会被拒绝（否则金额算不对，等于给用户乱加钱）。
   */
  tokenMetaError?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * 配置表单的输入类型。`tokenDecimals` 来自 `<input>`，天然是字符串，
 * 所以这里显式放宽成 `number | string`（内部再转数字并校验范围）。
 */
export type RechargeConfigInput = Partial<Omit<RechargeConfig, 'tokenDecimals'>> & {
  tokenDecimals?: number | string;
};

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
const RECORD_FILE = 'recharge';

let settingsLoaded = false;
let settings: RechargeConfig | null = null;
let recordsLoaded = false;
let records: RechargeRecord[] = [];

// ---------------------------------------------------------------- 链 / 网络

/**
 * 常见链的**钱包侧**元信息。
 *
 * `wallet_addEthereumChain` 必须提供 chainName 与 nativeCurrency，而这两个字段
 * 链上读不到（不在 JSON-RPC 标准方法里），只能靠内置表；未知链退化为 `Chain <id>`，
 * 用户仍可在钱包的确认弹窗里核对 RPC 地址后自行决定是否添加。
 */
const KNOWN_CHAINS: Record<
  string,
  { name: string; symbol: string; decimals: number; explorer?: string }
> = {
  '1': { name: 'Ethereum 主网', symbol: 'ETH', decimals: 18, explorer: 'https://etherscan.io' },
  '56': { name: 'BNB Smart Chain 主网', symbol: 'BNB', decimals: 18, explorer: 'https://bscscan.com' },
  '137': { name: 'Polygon 主网', symbol: 'POL', decimals: 18, explorer: 'https://polygonscan.com' },
  '8453': { name: 'Base 主网', symbol: 'ETH', decimals: 18, explorer: 'https://basescan.org' },
  '42161': { name: 'Arbitrum One', symbol: 'ETH', decimals: 18, explorer: 'https://arbiscan.io' },
  '10': { name: 'OP 主网', symbol: 'ETH', decimals: 18, explorer: 'https://optimistic.etherscan.io' },
  '1030': { name: 'Conflux eSpace', symbol: 'CFX', decimals: 18, explorer: 'https://evm.confluxscan.net' },
  '71': { name: 'Conflux eSpace 测试网', symbol: 'CFX', decimals: 18, explorer: 'https://evmtestnet.confluxscan.net' },
  '11155111': { name: 'Sepolia 测试网', symbol: 'ETH', decimals: 18, explorer: 'https://sepolia.etherscan.io' },
  '97': { name: 'BSC 测试网', symbol: 'BNB', decimals: 18, explorer: 'https://testnet.bscscan.com' },
};

/** 把各种写法（十进制 / 0x 十六进制 / 带空格）统一成小写十六进制，如 `0x1`。非法返回 ''。 */
export function normalizeChainId(input: unknown): string {
  if (typeof input === 'number') {
    return Number.isInteger(input) && input > 0 ? `0x${input.toString(16)}` : '';
  }
  const s = String(input ?? '').trim();
  if (!s) return '';
  try {
    const n = /^0x/i.test(s) ? BigInt(s) : BigInt(s);
    if (n <= 0n) return '';
    return `0x${n.toString(16)}`;
  } catch {
    return '';
  }
}

/** 十六进制链 ID → 十进制字符串（给人和给钱包报错用）。 */
export function chainIdToDecimal(chainId: string): string {
  const hex = normalizeChainId(chainId);
  return hex ? BigInt(hex).toString(10) : '';
}

/** 已知链的显示名；未知返回 null。 */
export function chainName(chainId: string): string | null {
  return KNOWN_CHAINS[chainIdToDecimal(chainId)]?.name ?? null;
}

/** 十进制链 ID → 中文名，给前端展示「当前网络」用（不强制切换的页面只靠它认名字）。 */
export function knownChainNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, meta] of Object.entries(KNOWN_CHAINS)) out[id] = meta.name;
  return out;
}

export interface ChainAddParams {
  chainId: string;
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls?: string[];
}

/**
 * 生成 `wallet_addEthereumChain` 的参数（钱包里没有目标链时用）。
 * 没有 chainId 或 RPC 时返回 null —— 缺任何一样都加不了链，此时前端应退回「请手动切换」。
 */
export function buildChainAddParams(cfg: RechargeConfig | null): ChainAddParams | null {
  if (!cfg) return null;
  const chainId = normalizeChainId(cfg.chainId);
  if (!chainId || !cfg.rpcUrl) return null;
  const known = KNOWN_CHAINS[chainIdToDecimal(chainId)];
  const symbol = known?.symbol ?? 'ETH';
  return {
    chainId,
    chainName: known?.name ?? `Chain ${chainIdToDecimal(chainId)}`,
    rpcUrls: [cfg.rpcUrl],
    nativeCurrency: { name: symbol, symbol, decimals: known?.decimals ?? 18 },
    ...(known?.explorer ? { blockExplorerUrls: [known.explorer] } : {}),
  };
}

// ---------------------------------------------------------------- provider

/** 生产 provider：按配置的 RPC 地址构造。测试用注入的假 provider，不会走到这里。 */
export function createJsonRpcProvider(rpcUrl: string): EvmProvider {
  const rpc = new JsonRpcProvider(rpcUrl);
  return {
    call: (tx) => rpc.call(tx),
    getTransaction: (hash) => rpc.getTransaction(hash) as Promise<EvmTransaction | null>,
    getTransactionReceipt: (hash) =>
      rpc.getTransactionReceipt(hash) as Promise<EvmReceipt | null>,
    getChainId: () => rpc.send('eth_chainId', []) as Promise<string>,
  };
}

// ---------------------------------------------------------------- 配置读写

/**
 * 读链 ID 的超时上限。
 *
 * 保存配置时一定会问一次 `eth_chainId`，而 RPC 可能是个不可达的地址——
 * 不加闸就会把 Admin 的保存请求拖到 ethers 自己超时（实测能到几十秒），
 * 表现为「点保存按钮一直转圈」。超时只影响这条自动识别，配置照常保存。
 */
const CHAIN_ID_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`读取超时（超过 ${ms}ms 未响应）`)), ms);
      // 别让这个定时器把进程按住不放
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

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
export function validateRechargeConfig(input: RechargeConfigInput):
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

  // 链 ID 统一存成小写十六进制，方便前端直接和钱包的 eth_chainId 比对
  const chainIdRaw = String(input.chainId ?? '').trim();
  let chainId = '';
  if (chainIdRaw) {
    chainId = normalizeChainId(chainIdRaw);
    if (!chainId) {
      return { ok: false, error: '链 ID 必须是正整数或 0x 开头的十六进制（如 56 或 0x38）。' };
    }
  }

  return {
    ok: true,
    value: {
      recipient: normalized,
      rpcUrl,
      rate,
      tokenAddress: tokenAddress ? getAddress(tokenAddress) : '',
      chainId,
    },
  };
}

/**
 * 把 ethers / 网络层的一长串原始错误翻成人话。
 *
 * 背景：曾经直接把 `server response 525 <none> (request={...})` 甩到页面上，
 * 管理员根本看不出是「RPC 不可用」还是「合约填错了」——而这两者的处置完全不同。
 */
export function humanizeRpcError(err: unknown, rpcUrl: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (/合约未返回|无法解码|decimals 取值异常/.test(raw)) return raw; // 已是人话

  const status = raw.match(/responseStatus"?\s*[:=]\s*"?(\d{3})/)?.[1];
  if (status) {
    return `RPC 返回 HTTP ${status}（${rpcUrl}）——该节点不可用、拒绝本机访问或需要鉴权，请换一个 RPC 地址。`;
  }
  if (/TIMEOUT|ETIMEDOUT/i.test(raw)) {
    return `读取超时（${rpcUrl}）——节点没有在预期时间内响应，请稍后重试或换一个 RPC。`;
  }
  if (/NETWORK_ERROR|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return `连不上 RPC（${rpcUrl}）——网络不可达或被防火墙拦截，请换一个 RPC 地址。`;
  }
  if (/CALL_EXCEPTION|missing revert data/i.test(raw)) {
    return '合约调用失败：这个地址在当前链上可能不是 ERC20（或链选错了）。';
  }
  return `读取失败：${raw.replace(/\s+/g, ' ').slice(0, 180)}`;
}

/**
 * 保存配置。
 *
 * 配置了 ERC20 时会尝试读取链上 name / symbol / decimals，但**读不到也要保存**：
 * RPC 抽风属于运营事件，不该把管理员锁在门外。读失败时把原因记进 `tokenMetaError`
 * 由页面告警，并提供「重新读取 / 手工填写」两条补救路径；只有 decimals 彻底缺失时
 * 才在**入账**环节拒绝（verifyRechargeTx），避免金额算错。
 *
 * 元数据取值优先级：手工填写 > 本次链上读取 > 上一次成功读到的（合约地址未变时）。
 */
export async function setRechargeConfig(
  input: RechargeConfigInput,
  opts: { provider?: EvmProvider } = {},
): Promise<
  | { ok: true; config: RechargeConfig; warning?: string; info?: string }
  | { ok: false; error: string }
> {
  const checked = validateRechargeConfig(input);
  if (!checked.ok) return checked;

  const prev = ensureSettings();
  const next: RechargeConfig = { ...checked.value };
  const warnings: string[] = [];
  const infos: string[] = [];

  // ---- 链 ID：一律以 RPC 实际返回的为准 ----
  // 手填的和 RPC 不一致时以 RPC 为准：填错链 = 用户把钱转到另一条链上，收不到也退不回。
  // 读不到就保留现状（不阻塞保存），前端此时不强制切换网络。
  {
    const provider = opts.provider ?? createJsonRpcProvider(next.rpcUrl);
    try {
      const fromRpc = normalizeChainId(
        await withTimeout(provider.getChainId?.() ?? Promise.resolve(undefined), CHAIN_ID_TIMEOUT_MS),
      );
      if (fromRpc) {
        if (next.chainId && next.chainId !== fromRpc) {
          warnings.push(
            `链 ID 以 RPC 实际返回为准：已由 ${chainIdToDecimal(next.chainId)} 更正为 ${chainIdToDecimal(fromRpc)}${chainName(fromRpc) ? `（${chainName(fromRpc)}）` : ''}。`,
          );
        } else if (!next.chainId) {
          infos.push(
            `已自动识别链 ID：${chainIdToDecimal(fromRpc)}${chainName(fromRpc) ? `（${chainName(fromRpc)}）` : ''}。`,
          );
        }
        next.chainId = fromRpc;
      } else if (!next.chainId) {
        warnings.push('RPC 未返回链 ID，暂未设置；用户转账前将不强制切换网络。');
      }
    } catch (err) {
      if (!next.chainId) {
        warnings.push(
          `没读到链 ID（${humanizeRpcError(err, next.rpcUrl)}），暂未设置；用户转账前将不强制切换网络。`,
        );
      }
    }
  }

  if (next.tokenAddress) {
    // ---- 手工填写（自动读取失败时的兜底）----
    const manualName = String(input.tokenName ?? '').trim();
    const manualSymbol = String(input.tokenSymbol ?? '').trim();
    const manualRaw = String(input.tokenDecimals ?? '').trim();
    const manualDecimals = manualRaw === '' ? undefined : Number(manualRaw);
    if (
      manualDecimals !== undefined &&
      (!Number.isInteger(manualDecimals) || manualDecimals < 0 || manualDecimals > 36)
    ) {
      return { ok: false, error: '手工填写的 decimals 必须是 0~36 的整数。' };
    }

    // ---- 链上自动读取（缺什么补什么）----
    let auto: TokenMeta | null = null;
    let autoError = '';
    if (!manualName || !manualSymbol || manualDecimals === undefined) {
      const provider = opts.provider ?? createJsonRpcProvider(next.rpcUrl);
      try {
        auto = await readTokenMeta(provider, next.tokenAddress);
      } catch (err) {
        autoError = humanizeRpcError(err, next.rpcUrl);
      }
    }

    // 换了合约就不能再沿用旧元数据（否则 decimals 会张冠李戴）
    const sameToken = sameAddress(prev?.tokenAddress, next.tokenAddress);
    const name = manualName || auto?.name || (sameToken ? prev?.tokenName ?? '' : '');
    const symbol = manualSymbol || auto?.symbol || (sameToken ? prev?.tokenSymbol ?? '' : '');
    const decimals =
      manualDecimals ?? auto?.decimals ?? (sameToken ? prev?.tokenDecimals : undefined);

    next.tokenName = name;
    next.tokenSymbol = symbol;
    if (decimals === undefined) {
      delete next.tokenDecimals;
      next.tokenMetaError =
        autoError || '缺少 decimals：请手工填写，或换一个可用 RPC 后点「重新读取元数据」。';
      warnings.push(
        `已保存，但 ERC20 元数据不完整（${next.tokenMetaError}）decimals 补全前无法入账。`,
      );
    } else {
      next.tokenDecimals = decimals;
      if (autoError) {
        next.tokenMetaError = autoError;
        warnings.push(
          `已保存，但本次没能从链上读到元数据（${autoError}）当前沿用已保存的值，入账不受影响。`,
        );
      } else {
        delete next.tokenMetaError;
      }
    }
  } else {
    delete next.tokenName;
    delete next.tokenSymbol;
    delete next.tokenDecimals;
    delete next.tokenMetaError;
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = 'admin';
  settings = next;
  settingsLoaded = true;
  scheduleSave(SETTINGS_FILE, () => ({ ...next }));
  const warning = warnings.length ? warnings.join(' ') : undefined;
  const info = infos.length ? infos.join(' ') : undefined;
  return {
    ok: true,
    config: { ...next },
    ...(warning ? { warning } : {}),
    ...(info ? { info } : {}),
  };
}

/**
 * 用当前已保存的配置重读一次 ERC20 元数据（页面上的「重新读取元数据」按钮）。
 * RPC 恢复后点一下即可补齐 name / symbol / decimals，不用重填整张表单。
 */
export async function refreshTokenMeta(
  opts: { provider?: EvmProvider } = {},
): Promise<
  { ok: true; config: RechargeConfig; warning?: string; info?: string } | { ok: false; error: string }
> {
  const cur = ensureSettings();
  if (!cur) return { ok: false, error: '还没保存过充值配置，请先填写并保存。' };
  if (!cur.tokenAddress) return { ok: false, error: '当前收的是原生币，不需要读 ERC20 元数据。' };
  // 清空手工值，强制走链上读取；读失败时会回退到上一次的 decimals（合约地址没变）
  return setRechargeConfig({ ...cur, tokenName: '', tokenSymbol: '', tokenDecimals: undefined }, opts);
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
  if (!tx) {
    // 刚发出的交易可能还没被节点同步到，属于可重试
    throw new RechargePendingError('交易暂未同步到节点，正在等待确认…');
  }

  if (cfg.tokenAddress) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) {
      throw new RechargePendingError('该 ERC20 转账尚未打包，正在等待链上确认…');
    }
    if (receipt.status === 0) {
      throw new Error('这笔交易在链上失败了（status=0），无法入账。');
    }
    // decimals 缺失时绝不猜（默认 18 会让 6 位代币的金额差 10^12 倍）——直接拒绝入账
    if (cfg.tokenDecimals === undefined) {
      throw new Error('ERC20 元数据不完整（缺少 decimals），暂不能入账，请联系管理员在充值设置里补全。');
    }
    const decimals = cfg.tokenDecimals;
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
