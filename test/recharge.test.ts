/**
 * Crypto 充值模块（src/recharge.ts）单元测试。
 *
 * 全部用**注入的假 provider**，不联网、不依赖真实链：
 *  - ERC20 元数据读取（name / symbol / decimals）
 *  - 配置校验（地址 / RPC / 汇率）
 *  - 链上校验：原生币（含 pending）、ERC20（Transfer 事件 / 未打包报错）
 *  - 提交入账与幂等（同一 txHash 只加一次点数）
 *  - 记录筛选
 *  - 保存配置时读 meta：读不到也落盘（只告警），decimals 缺失时入账被拒
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Interface } from 'ethers';
import * as recharge from '../src/recharge.js';
import * as billing from '../src/billing.js';
import { configure } from '../src/persist.js';
import { config } from '../src/config.js';

const ERC20 = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const EVENT = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

const SEL = {
  name: ERC20.getFunction('name')!.selector,
  symbol: ERC20.getFunction('symbol')!.selector,
  decimals: ERC20.getFunction('decimals')!.selector,
};

const RECIPIENT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const PAYER = '0x3333333333333333333333333333333333333333';
const TX = '0x' + 'ab'.repeat(32);

/**
 * 假 provider。`chainId` 传了就实现 getChainId（模拟 RPC 能返回链 ID），
 * 不传则没有这个方法——用来覆盖「RPC 读不到链 ID」这条分支。
 */
function tokenProvider(
  meta?: { name: string; symbol: string; decimals: number },
  chainId?: string,
) {
  return {
    ...(chainId === undefined ? {} : { async getChainId() { return chainId; } }),
    async call({ data }: { to: string; data: string }) {
      const sel = data.slice(0, 10);
      if (!meta) return '0x'; // 模拟「地址不是合约」
      if (sel === SEL.name) return ERC20.encodeFunctionResult('name', [meta.name]);
      if (sel === SEL.symbol) return ERC20.encodeFunctionResult('symbol', [meta.symbol]);
      if (sel === SEL.decimals) return ERC20.encodeFunctionResult('decimals', [meta.decimals]);
      return '0x';
    },
    async getTransaction() {
      return null;
    },
    async getTransactionReceipt() {
      return null;
    },
  } as unknown as recharge.EvmProvider;
}

function makeProvider(opts: {
  to?: string | null;
  value?: bigint;
  receipt?: recharge.EvmReceipt | null;
  tx?: boolean;
}): recharge.EvmProvider {
  return {
    async call() {
      return '0x';
    },
    async getTransaction(hash: string) {
      if (opts.tx === false) return null;
      return { hash, from: PAYER, to: opts.to ?? RECIPIENT, value: opts.value ?? 0n };
    },
    async getTransactionReceipt() {
      return opts.receipt ?? null;
    },
  };
}

function transferLog(to: string, amount: bigint, token: string = TOKEN) {
  const frag = EVENT.getEvent('Transfer')!;
  const log = EVENT.encodeEventLog(frag, [PAYER, to, amount]);
  return { address: token, topics: log.topics as string[], data: log.data };
}

const BASE_CONFIG = {
  recipient: RECIPIENT,
  rpcUrl: 'http://127.0.0.1:1',
  rate: 100,
  tokenAddress: '',
  chainId: '1',
};

beforeEach(async () => {
  configure({ enabled: false });
  billing.resetBilling();
  recharge.__resetForTest();
  await recharge.setRechargeConfig(BASE_CONFIG);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('readTokenMeta', () => {
  it('读取 ERC20 的 name / symbol / decimals', async () => {
    const meta = await recharge.readTokenMeta(
      tokenProvider({ name: 'Demo Token', symbol: 'DEMO', decimals: 6 }),
      TOKEN,
    );
    expect(meta).toEqual({ name: 'Demo Token', symbol: 'DEMO', decimals: 6 });
  });

  it('合约返回空数据（非 ERC20）时抛错', async () => {
    await expect(recharge.readTokenMeta(tokenProvider(), TOKEN)).rejects.toThrow(/不是 ERC20/);
  });
});

describe('validateRechargeConfig', () => {
  it('拒绝非法地址 / RPC / 汇率', () => {
    expect(recharge.validateRechargeConfig({ ...BASE_CONFIG, recipient: 'not-an-address' }).ok).toBe(false);
    expect(recharge.validateRechargeConfig({ ...BASE_CONFIG, rpcUrl: 'ftp://x' }).ok).toBe(false);
    expect(recharge.validateRechargeConfig({ ...BASE_CONFIG, rate: 0 }).ok).toBe(false);
    expect(
      recharge.validateRechargeConfig({ ...BASE_CONFIG, tokenAddress: '0x00' }).ok,
    ).toBe(false);
  });

  it('合法配置通过并规范化地址', () => {
    const r = recharge.validateRechargeConfig(BASE_CONFIG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recipient).toBe(RECIPIENT);
  });
});

describe('verifyRechargeTx', () => {
  it('原生币：读取 value 并校验收款地址', async () => {
    const provider = makeProvider({
      to: RECIPIENT,
      value: 10n ** 18n,
      receipt: { status: 1, logs: [] },
    });
    const v = await recharge.verifyRechargeTx(provider, BASE_CONFIG, TX);
    expect(v.kind).toBe('native');
    expect(v.amount).toBe('1.0');
    expect(v.pending).toBe(false);
  });

  it('原生币未打包（receipt=null）仍入账并标记 pending', async () => {
    const provider = makeProvider({ to: RECIPIENT, value: 5n * 10n ** 17n, receipt: null });
    const v = await recharge.verifyRechargeTx(provider, BASE_CONFIG, TX);
    expect(v.pending).toBe(true);
    expect(v.amount).toBe('0.5');
  });

  it('原生币收款地址不符时拒绝', async () => {
    const provider = makeProvider({ to: PAYER, value: 10n ** 18n });
    await expect(recharge.verifyRechargeTx(provider, BASE_CONFIG, TX)).rejects.toThrow(
      /收款地址/,
    );
  });

  it('ERC20：从 Transfer 事件解析金额', async () => {
    const cfg = { ...BASE_CONFIG, tokenAddress: TOKEN, tokenDecimals: 6, tokenSymbol: 'DEMO' };
    const provider = makeProvider({
      to: TOKEN,
      receipt: { status: 1, logs: [transferLog(RECIPIENT, 2_500_000n)] },
    });
    const v = await recharge.verifyRechargeTx(provider, cfg, TX);
    expect(v.kind).toBe('erc20');
    expect(v.amount).toBe('2.5');
    expect(v.token).toBe('DEMO');
    expect(v.pending).toBe(false);
  });

  it('ERC20 尚未打包（receipt=null）时拒绝入账', async () => {
    const cfg = { ...BASE_CONFIG, tokenAddress: TOKEN, tokenDecimals: 6 };
    const provider = makeProvider({ to: TOKEN, receipt: null });
    await expect(recharge.verifyRechargeTx(provider, cfg, TX)).rejects.toThrow(/尚未打包/);
  });

  it('未确认类错误抛 RechargePendingError（前端据此后台轮询等待）', async () => {
    const cfg = { ...BASE_CONFIG, tokenAddress: TOKEN };
    // ERC20 还没打包
    await expect(
      recharge.verifyRechargeTx(makeProvider({ to: TOKEN, receipt: null }), cfg, TX),
    ).rejects.toBeInstanceOf(recharge.RechargePendingError);
    // 交易还没被节点看到
    await expect(
      recharge.verifyRechargeTx(makeProvider({ tx: false }), cfg, TX),
    ).rejects.toBeInstanceOf(recharge.RechargePendingError);
  });

  it('其它错误不是待确认（前端立即报错，不空等轮询）', async () => {
    await expect(
      recharge.verifyRechargeTx(makeProvider({ to: PAYER, value: 10n ** 18n }), BASE_CONFIG, TX),
    ).rejects.not.toBeInstanceOf(recharge.RechargePendingError);
  });
});

describe('submitRechargeTx', () => {
  it('按汇率入账并记录历史', async () => {
    const provider = makeProvider({
      to: RECIPIENT,
      value: 10n ** 18n, // 1 ETH * 100 = 100 点
      receipt: { status: 1, logs: [] },
    });
    const { record, duplicated } = await recharge.submitRechargeTx(
      { userId: 'u1', username: 'alice', txHash: TX },
      { provider },
    );
    expect(duplicated).toBe(false);
    expect(record.points).toBe(100);
    expect(record.status).toBe('credited');
    expect(billing.getBalance('u1')).toBe(config.billingFreeCredits + 100);
    expect(billing.getUserBilling('u1')?.recharged).toBe(100);
    expect(recharge.listRecharges({ userId: 'u1' })).toHaveLength(1);
  });

  it('同一 txHash 重复提交只入账一次（幂等）', async () => {
    const provider = makeProvider({
      to: RECIPIENT,
      value: 10n ** 18n,
      receipt: { status: 1, logs: [] },
    });
    const first = await recharge.submitRechargeTx({ userId: 'u2', txHash: TX }, { provider });
    const balanceAfterFirst = billing.getBalance('u2');

    const second = await recharge.submitRechargeTx({ userId: 'u2', txHash: TX.toUpperCase() }, { provider });
    expect(second.duplicated).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(billing.getBalance('u2')).toBe(balanceAfterFirst);
    expect(recharge.listRecharges()).toHaveLength(1);
  });
});

describe('listRecharges 筛选', () => {
  it('可按用户 / 类型 / 状态筛选', async () => {
    // 记录里只有一笔 ERC20：u2 的 1 DEMO（decimals=6）→ 100 点
    recharge.__resetForTest();
    const saved = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: TOKEN },
      { provider: tokenProvider({ name: 'Demo Token', symbol: 'DEMO', decimals: 6 }) },
    );
    expect(saved.ok).toBe(true);
    await recharge.submitRechargeTx(
      { userId: 'u2', txHash: '0x' + 'cd'.repeat(32) },
      {
        provider: makeProvider({
          to: TOKEN,
          receipt: { status: 1, logs: [transferLog(RECIPIENT, 1_000_000n)] },
        }),
      },
    );

    expect(recharge.listRecharges()).toHaveLength(1);
    expect(recharge.listRecharges({ userId: 'u2' })).toHaveLength(1);
    expect(recharge.listRecharges({ status: 'credited' })).toHaveLength(1);
    expect(recharge.listRecharges({ status: 'pending' })).toHaveLength(0);
    expect(recharge.listRecharges({ userId: 'u1' })).toHaveLength(0);
    expect(recharge.listRecharges({ kind: 'erc20' })).toHaveLength(1);
    expect(recharge.listRecharges({ kind: 'native' })).toHaveLength(0);
  });
});

describe('setRechargeConfig', () => {
  it('保存 ERC20 配置时读 meta 并回显', async () => {
    recharge.__resetForTest();
    const ok = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: TOKEN },
      { provider: tokenProvider({ name: 'Demo Token', symbol: 'DEMO', decimals: 6 }) },
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.warning).toBeUndefined();
    expect(recharge.getRechargeConfig()?.tokenSymbol).toBe('DEMO');
    expect(recharge.getRechargeConfig()?.tokenDecimals).toBe(6);
    expect(recharge.getRechargeConfig()?.tokenMetaError).toBeUndefined();
  });

  it('元数据读不到也要保存（只告警，不把管理员锁在门外）', async () => {
    recharge.__resetForTest();
    const bad = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: TOKEN },
      { provider: tokenProvider() },
    );
    expect(bad.ok).toBe(true);
    if (bad.ok) expect(bad.warning).toMatch(/decimals/);
    const cfg = recharge.getRechargeConfig();
    expect(cfg?.recipient).toBe(RECIPIENT); // 收款地址 / 汇率照样存下来了
    expect(cfg?.rate).toBe(100);
    expect(cfg?.tokenDecimals).toBeUndefined();
    expect(cfg?.tokenMetaError).toBeTruthy();
  });

  it('合约地址不变时读取失败沿用上次 decimals，入账不受影响', async () => {
    recharge.__resetForTest();
    await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: TOKEN },
      { provider: tokenProvider({ name: 'Demo Token', symbol: 'DEMO', decimals: 6 }) },
    );
    // RPC 抽风：同一个合约再保存一次
    const again = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: TOKEN.toLowerCase() },
      { provider: tokenProvider() },
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.warning).toMatch(/沿用/);
    const cfg = recharge.getRechargeConfig();
    expect(cfg?.tokenDecimals).toBe(6);
    expect(cfg?.tokenMetaError).toBeTruthy();
  });

  it('换了合约就不能沿用旧 decimals（避免张冠李戴）', async () => {
    recharge.__resetForTest();
    await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: TOKEN },
      { provider: tokenProvider({ name: 'Demo Token', symbol: 'DEMO', decimals: 6 }) },
    );
    const other = '0x4444444444444444444444444444444444444444';
    await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: other },
      { provider: tokenProvider() },
    );
    expect(recharge.getRechargeConfig()?.tokenDecimals).toBeUndefined();
  });

  it('手工填写元数据时不依赖链上读取', async () => {
    recharge.__resetForTest();
    const r = await recharge.setRechargeConfig(
      {
        ...BASE_CONFIG,
        tokenAddress: TOKEN,
        tokenName: 'Demo Token',
        tokenSymbol: 'DEMO',
        tokenDecimals: 6,
      },
      { provider: tokenProvider() }, // 链上读不到
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
    const cfg = recharge.getRechargeConfig();
    expect(cfg?.tokenDecimals).toBe(6);
    expect(cfg?.tokenSymbol).toBe('DEMO');
    expect(cfg?.tokenMetaError).toBeUndefined();
  });

  it('手工 decimals 越界时拒绝保存', async () => {
    const r = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: TOKEN, tokenName: 'x', tokenSymbol: 'X', tokenDecimals: 99 },
      { provider: tokenProvider({ name: 'x', symbol: 'X', decimals: 18 }) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/0~36/);
  });
});

describe('refreshTokenMeta', () => {
  it('RPC 恢复后重读成功，告警被清除', async () => {
    recharge.__resetForTest();
    await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: TOKEN },
      { provider: tokenProvider() },
    );
    expect(recharge.getRechargeConfig()?.tokenMetaError).toBeTruthy();

    const r = await recharge.refreshTokenMeta({
      provider: tokenProvider({ name: 'Demo Token', symbol: 'DEMO', decimals: 6 }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
    const cfg = recharge.getRechargeConfig();
    expect(cfg?.tokenDecimals).toBe(6);
    expect(cfg?.tokenMetaError).toBeUndefined();
  });

  it('未保存过配置 / 收原生币时给出明确提示', async () => {
    recharge.__resetForTest();
    expect((await recharge.refreshTokenMeta()).ok).toBe(false);
    await recharge.setRechargeConfig(BASE_CONFIG);
    expect((await recharge.refreshTokenMeta()).ok).toBe(false);
  });
});

describe('humanizeRpcError', () => {
  it('把 525 / 超时 / 连不上翻成人话，而不是甩一长串 ethers 报错', () => {
    const url = 'https://bad-rpc.example';
    expect(recharge.humanizeRpcError(new Error('server response 525 <none> (request={  }, response={  }, info={ "responseStatus": "525 <none>" }, code=SERVER_ERROR)'), url)).toMatch(/HTTP 525/);
    expect(recharge.humanizeRpcError(new Error('timeout ... TIMEOUT'), url)).toMatch(/超时/);
    expect(recharge.humanizeRpcError(new Error('fetch failed ECONNREFUSED'), url)).toMatch(/连不上 RPC/);
    // 已经是中文的业务错误原样返回
    expect(recharge.humanizeRpcError(new Error('合约未返回 name()（地址可能不是 ERC20）'), url)).toMatch(/合约未返回/);
  });
});

describe('链 ID 与钱包网络切换', () => {
  it('normalizeChainId 把十进制 / 十六进制 / 带空格统一成小写 hex', () => {
    expect(recharge.normalizeChainId('1')).toBe('0x1');
    expect(recharge.normalizeChainId('56')).toBe('0x38');
    expect(recharge.normalizeChainId('0x38')).toBe('0x38');
    expect(recharge.normalizeChainId(' 0X2105 ')).toBe('0x2105'); // Arbitrum One
    expect(recharge.normalizeChainId(56)).toBe('0x38');
    // 非法输入一律空串，交给上层决定是否告警
    expect(recharge.normalizeChainId('')).toBe('');
    expect(recharge.normalizeChainId('abc')).toBe('');
    expect(recharge.normalizeChainId('0')).toBe('');
    expect(recharge.normalizeChainId('-1')).toBe('');
    expect(recharge.normalizeChainId(undefined)).toBe('');
  });

  it('chainIdToDecimal / chainName 用于展示', () => {
    expect(recharge.chainIdToDecimal('0x38')).toBe('56');
    expect(recharge.chainName('0x38')).toMatch(/BNB/);
    expect(recharge.chainName('0x1')).toMatch(/Ethereum/);
    expect(recharge.chainName('0xdeadbeef')).toBeNull(); // 未知链
  });

  it('buildChainAddParams 生成钱包加链参数（链名 + RPC + 原生币）', () => {
    const p = recharge.buildChainAddParams({
      recipient: RECIPIENT,
      rpcUrl: 'https://bsc-rpc.example',
      rate: 100,
      tokenAddress: '',
      chainId: '0x38',
    });
    expect(p).toBeTruthy();
    expect(p!.chainId).toBe('0x38');
    expect(p!.chainName).toMatch(/BNB/);
    expect(p!.rpcUrls).toEqual(['https://bsc-rpc.example']);
    expect(p!.nativeCurrency.symbol).toBe('BNB');
    expect(p!.nativeCurrency.decimals).toBe(18);
  });

  it('未知链退化成 Chain <id>，仍能加链（用户可在钱包里核对 RPC 后确认）', () => {
    const p = recharge.buildChainAddParams({
      recipient: RECIPIENT,
      rpcUrl: 'https://some-rpc.example',
      rate: 100,
      tokenAddress: '',
      chainId: '0x3039',
    });
    expect(p!.chainName).toBe('Chain 12345');
    expect(p!.nativeCurrency.symbol).toBe('ETH');
  });

  it('没有 chainId 或 RPC 时不生成加链参数（此时前端只能提示手动切换）', () => {
    const base = { recipient: RECIPIENT, rate: 100, tokenAddress: '' };
    expect(recharge.buildChainAddParams({ ...base, rpcUrl: 'https://x', chainId: '' })).toBeNull();
    expect(recharge.buildChainAddParams({ ...base, rpcUrl: '', chainId: '0x1' })).toBeNull();
    expect(recharge.buildChainAddParams(null)).toBeNull();
  });

  it('保存时自动从 RPC 回填链 ID（手填留空也能识别出是 BSC）', async () => {
    recharge.__resetForTest();
    const r = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, chainId: '' },
      { provider: tokenProvider(undefined, '0x38') },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info).toMatch(/56/); // 十进制更好认
      expect(r.info).toMatch(/BNB/);
      expect(r.warning).toBeUndefined();
    }
    expect(recharge.getRechargeConfig()?.chainId).toBe('0x38');
  });

  it('手填与 RPC 不一致时以 RPC 为准并告警（填错链 = 用户把钱转到别的链）', async () => {
    recharge.__resetForTest();
    const r = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, chainId: '1' },
      { provider: tokenProvider(undefined, '0x38') },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/以 RPC 实际返回为准/);
    expect(recharge.getRechargeConfig()?.chainId).toBe('0x38');
  });

  it('RPC 读不到链 ID 时不阻塞保存：已有值就留着', async () => {
    recharge.__resetForTest();
    const r = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, chainId: '56' },
      { provider: tokenProvider() }, // 没有 getChainId
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
    expect(recharge.getRechargeConfig()?.chainId).toBe('0x38');
  });

  it('RPC 读不到且没手填：告警说明前端不会强制切换网络', async () => {
    recharge.__resetForTest();
    const r = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, chainId: '' },
      { provider: tokenProvider() },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/不强制切换网络/);
    expect(recharge.getRechargeConfig()?.chainId).toBe('');
  });

  it('RPC 抛错时同样只告警（不把管理员锁在门外）', async () => {
    recharge.__resetForTest();
    const boom = {
      async getChainId() {
        throw new Error('server response 525 <none> (info={ "responseStatus": "525 <none>" })');
      },
      async call() {
        return '0x';
      },
      async getTransaction() {
        return null;
      },
      async getTransactionReceipt() {
        return null;
      },
    } as unknown as recharge.EvmProvider;
    const r = await recharge.setRechargeConfig({ ...BASE_CONFIG, chainId: '' }, { provider: boom });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/HTTP 525/);
  });

  it('链 ID 非法时直接拒绝保存（而不是静默清空）', async () => {
    const r = await recharge.setRechargeConfig({ ...BASE_CONFIG, chainId: '不是链' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/链 ID/);
  });
});

describe('decimals 缺失时的入账防线', () => {
  it('ERC20 元数据不完整时拒绝入账（绝不默认 18 猜）', async () => {
    recharge.__resetForTest();
    await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: TOKEN },
      { provider: tokenProvider() }, // 读不到 → decimals 缺失
    );
    const provider = makeProvider({
      to: TOKEN,
      receipt: { status: 1, logs: [transferLog(RECIPIENT, 1_000_000n)] },
    });
    await expect(
      recharge.submitRechargeTx({ userId: 'u9', txHash: TX }, { provider }),
    ).rejects.toThrow(/decimals/);
    expect(billing.getBalance('u9')).toBe(config.billingFreeCredits); // 一分没加
  });
});
