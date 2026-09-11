/**
 * Crypto 充值模块（src/recharge.ts）单元测试。
 *
 * 全部用**注入的假 provider**，不联网、不依赖真实链：
 *  - ERC20 元数据读取（name / symbol / decimals）
 *  - 配置校验（地址 / RPC / 汇率）
 *  - 链上校验：原生币（含 pending）、ERC20（Transfer 事件 / 未打包报错）
 *  - 提交入账与幂等（同一 txHash 只加一次点数）
 *  - 记录筛选
 *  - 保存配置时读 meta，读不到不落盘
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

function tokenProvider(meta?: { name: string; symbol: string; decimals: number }) {
  return {
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
  it('保存 ERC20 配置时读 meta，读不到则不落盘', async () => {
    recharge.__resetForTest();
    const ok = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: TOKEN },
      { provider: tokenProvider({ name: 'Demo Token', symbol: 'DEMO', decimals: 6 }) },
    );
    expect(ok.ok).toBe(true);
    expect(recharge.getRechargeConfig()?.tokenSymbol).toBe('DEMO');
    expect(recharge.getRechargeConfig()?.tokenDecimals).toBe(6);

    // 读不到元数据：不落盘，配置保持原样
    const bad = await recharge.setRechargeConfig(
      { ...BASE_CONFIG, tokenAddress: '0x4444444444444444444444444444444444444444' },
      { provider: tokenProvider() },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/未保存/);
    expect(recharge.getRechargeConfig()?.tokenSymbol).toBe('DEMO');
  });
});
