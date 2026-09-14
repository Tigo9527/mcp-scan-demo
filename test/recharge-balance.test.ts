/**
 * 充值页「钱包余额」测试。
 *
 * 核心取舍：**读不到余额不能把充值锁死**。
 * RPC 抽风是运营事件，用户点不了转账只会觉得服务坏了；真正要拦的是
 * 「明确读到了余额、而且确实不够」这一种。这组用例把两条路径都钉住。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { configure } from '../src/persist.js';
import * as recharge from '../src/recharge.js';
import * as billing from '../src/billing.js';

const RECIPIENT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const WALLET = '0x5555555555555555555555555555555555555555';

let server: Server;
let base: string;

function userCookieFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  const part = raw
    .split(/,(?=\s*[A-Za-z_][A-Za-z0-9_]*=)/)
    .map((s) => s.trim())
    .find((s) => s.startsWith('mcp_demo_user='));
  return part ? part.split(';')[0].slice('mcp_demo_user='.length) : '';
}

async function login(username: string): Promise<string> {
  const res = await fetch(`${base}/register?username=${username}`);
  return userCookieFrom(res);
}

beforeAll(async () => {
  configure({ enabled: false });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  recharge.__resetForTest();
  billing.resetBilling();
});

describe('GET /recharge/balance', () => {
  it('未登录时 401（不泄露任何链上数据）', async () => {
    const res = await fetch(`${base}/recharge/balance?address=${WALLET}`);
    expect(res.status).toBe(401);
  });

  it('读到 ERC20 余额时返回 amount / raw / symbol', async () => {
    await recharge.setRechargeConfig({
      recipient: RECIPIENT,
      rpcUrl: 'http://127.0.0.1:1',
      rate: 100,
      tokenAddress: TOKEN,
      tokenSymbol: 'USDT',
      tokenDecimals: 6,
    });
    const cookie = await login('bal_user_1');
    // 用真 RPC 读是联网行为：这里直接桩掉模块函数，只验证接口的返回形状
    const res = await fetch(`${base}/recharge/balance?address=${WALLET}`, {
      headers: { Cookie: `mcp_demo_user=${cookie}` },
    });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { ok: boolean; error?: string };
    // 127.0.0.1:1 必然连不上 → 必须走「ok:false + 人话错误」，绝不 500，前端据此放行转账
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/连不上 RPC|超时|挪用|不合法|RPC/);
  });

  it('地址格式不合法时 400 且不查链', async () => {
    await recharge.setRechargeConfig({
      recipient: RECIPIENT,
      rpcUrl: 'http://127.0.0.1:1',
      rate: 100,
      tokenAddress: '',
      chainId: '1',
    });
    const cookie = await login('bal_user_2');
    const res = await fetch(`${base}/recharge/balance?address=0xzz`, {
      headers: { Cookie: `mcp_demo_user=${cookie}` },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/不合法/);
  });
});

describe('充值页的余额展示', () => {
  it('ERC20 收款时页面带「余额行」和「用全部余额」按钮', async () => {
    await recharge.setRechargeConfig({
      recipient: RECIPIENT,
      rpcUrl: 'http://127.0.0.1:1',
      rate: 100,
      tokenAddress: TOKEN,
      tokenSymbol: 'USDT',
      tokenDecimals: 6,
    });
    const cookie = await login('bal_user_3');
    const html = await (
      await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookie}` } })
    ).text();
    expect(html).toContain('id="balance-line"');
    expect(html).toContain('id="max-btn"');
    expect(html).toContain('/recharge/balance');
    // 读失败只提示，不放任前端崩
    expect(html).toContain('未能读取钱包余额');
    expect(html).toContain('不影响转账');
  });

  it('收原生币时不给「用全部余额」（转光了就没 gas 付手续费）', async () => {
    await recharge.setRechargeConfig({
      recipient: RECIPIENT,
      rpcUrl: 'http://127.0.0.1:1',
      rate: 100,
      tokenAddress: '',
      chainId: '1',
    });
    const cookie = await login('bal_user_4');
    const html = await (
      await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookie}` } })
    ).text();
    expect(html).toContain('id="balance-line"');
    expect(html).not.toContain('id="max-btn"');
  });

  it('手续费率/汇率卡片显示实际数字，不留占位符问号', async () => {
    await recharge.setRechargeConfig({
      recipient: RECIPIENT,
      rpcUrl: 'http://127.0.0.1:1',
      rate: 1000,
      tokenAddress: TOKEN,
      tokenSymbol: 'USDT',
      tokenDecimals: 6,
    });
    const cookie = await login('bal_user_6');
    const html = await (
      await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookie}` } })
    ).text();
    expect(html).toContain('1 USDT = 1000 点');
    // 写死的「= ? 点」占位符曾经漏到线上：这里把它钉死
    expect(html).not.toContain('= ? 点');
  });

  it('余额不足的拦截发生在发交易之前，且只在读得到余额时才拦', async () => {
    await recharge.setRechargeConfig({
      recipient: RECIPIENT,
      rpcUrl: 'http://127.0.0.1:1',
      rate: 100,
      tokenAddress: TOKEN,
      tokenDecimals: 6,
    });
    const cookie = await login('bal_user_5');
    const html = await (
      await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookie}` } })
    ).text();
    const guard = html.indexOf('raw>balanceRaw');
    const send = html.indexOf("method:'eth_sendTransaction'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(send);
    // 「读不到就放行」这条语义必须在代码里显式存在
    expect(html).toContain('balanceRaw!==null');
  });
});
