/**
 * 钱包网络（chainId）校验的前端注入测试。
 *
 * 关注点不是「JS 跑起来对不对」（那要真浏览器），而是**页面有没有把切链所需的东西交给前端**：
 * 目标链 ID、加链参数、切换/添加的两个 RPC 方法、chainChanged 监听。
 * 少了任何一样，用户就可能在错误的链上把钱转出去。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import vm from 'node:vm';
import { createApp } from '../src/web/app.js';
import { configure } from '../src/persist.js';
import * as recharge from '../src/recharge.js';
import * as billing from '../src/billing.js';

const RECIPIENT = '0x1111111111111111111111111111111111111111';

let server: Server;
let base: string;

/**
 * 假 provider：**必须注入**，否则 setRechargeConfig 会真的去连 rpcUrl（测试联网 = 慢 + 不稳定）。
 * `chainId` 不传表示「RPC 读不到链 ID」这条分支。
 */
function fakeProvider(chainId?: string) {
  return {
    ...(chainId === undefined ? {} : { async getChainId() { return chainId; } }),
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
}

function saveConfig(chainId: string, rpcUrl = 'https://rpc.example') {
  return recharge.setRechargeConfig(
    {
      recipient: RECIPIENT,
      rpcUrl,
      rate: 100,
      tokenAddress: '',
      chainId,
    },
    // 链 ID 与期望值一致，避免被「以 RPC 为准」的逻辑改掉
    { provider: fakeProvider(chainId ? recharge.normalizeChainId(chainId) : undefined) },
  );
}

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

describe('充值页的钱包网络校验', () => {
  it('页面带上目标链 ID 与切链所需的全部脚本', async () => {
    await saveConfig('56', 'https://bsc-rpc.example');
    const cookie = await login('chain_guard_user');
    const res = await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookie}` } });
    expect(res.status).toBe(200);
    const html = await res.text();

    // 目标链：十六进制 0x38 == 56（BSC），以及人类可读的链名
    expect(html).toContain('0x38');
    expect(html).toContain('56');

    // 切链三件套
    expect(html).toContain('wallet_switchEthereumChain');
    expect(html).toContain('wallet_addEthereumChain');
    expect(html).toContain("method:'eth_chainId'");
    // 用户在钱包里手动换网时要能同步提示
    expect(html).toContain('chainChanged');
    // 加链参数：钱包里没有这条链时用它唤起添加
    expect(html).toContain('"chainName"');
    expect(html).toContain('https://bsc-rpc.example');
    expect(html).toContain('BNB');
  });

  it('转账前一定会先校验网络（切换发生在 eth_sendTransaction 之前）', async () => {
    await saveConfig('56', 'https://bsc-rpc.example');
    const cookie = await login('chain_guard_user2');
    const res = await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookie}` } });
    const html = await res.text();
    const guard = html.indexOf('ensureChain(window.ethereum');
    const send = html.indexOf("method:'eth_sendTransaction'");
    expect(guard).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(send);
  });

  it('未配置链 ID 时明确告知不会强制切换（而不是假装保护过）', async () => {
    await saveConfig('', 'https://some-rpc.example');
    const cookie = await login('chain_guard_user3');
    const res = await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookie}` } });
    const html = await res.text();
    expect(html).toContain('未指定');
    expect(html).toContain('不会强制切换网络');
  });

  it('存量配置里的十进制链 ID 也会被归一化（否则和钱包的 0x… 永远比不上）', async () => {
    // 历史数据 / 手填可能存成十进制 "71"（Conflux eSpace 测试网），
    // 钱包的 eth_chainId 恒为 "0x47"——前端拿到的一定要是 hex。
    recharge.__resetForTest();
    await saveConfig('71', 'https://evmtestnet.confluxrpc.com');
    const cookie = await login('chain_guard_decimal');
    const res = await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookie}` } });
    const html = await res.text();
    expect(html).toContain('0x47');
    expect(html).toContain('Conflux eSpace 测试网');
    // 加链参数同样必须是 hex
    expect(html).toContain('"chainId":"0x47"');
  });

  it('收款信息里展示的是链名 + 链 ID，不是裸的十六进制', async () => {
    await saveConfig('1', 'https://eth-rpc.example');
    const cookie = await login('chain_guard_user4');
    const res = await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookie}` } });
    const html = await res.text();
    expect(html).toContain('Ethereum 主网');
    expect(html).toContain('0x1');
  });
});

describe('页面脚本本身可解析', () => {
  /**
   * 这些脚本是服务端拼出来的，没有构建环节 —— 语法错误要等用户在浏览器里点按钮才暴露。
   * 这里做一次「能不能编译」，把这类低级错误挡在提交前。
   */
  function scriptBodies(html: string): string[] {
    const out: string[] = [];
    const re = /<script>([\s\S]*?)<\/script>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) out.push(m[1]);
    return out;
  }

  it('充值页注入的脚本语法合法（含切链逻辑）', async () => {
    await saveConfig('56', 'https://bsc-rpc.example');
    const cookie = await login('chain_guard_user5');
    const res = await fetch(`${base}/recharge`, { headers: { Cookie: `mcp_demo_user=${cookie}` } });
    const bodies = scriptBodies(await res.text());
    expect(bodies.length).toBeGreaterThan(0);
    for (const src of bodies) {
      expect(() => new vm.Script(src)).not.toThrow();
    }
  });

  it('web3 登录页注入的脚本语法合法', async () => {
    const bodies = scriptBodies(await (await fetch(`${base}/web3`)).text());
    expect(bodies.length).toBeGreaterThan(0);
    for (const src of bodies) {
      expect(() => new vm.Script(src)).not.toThrow();
    }
  });
});

describe('web3 登录页：只显示当前网络，不强制切换', () => {
  it('页面带上链名表与「当前网络」展示位', async () => {
    const res = await fetch(`${base}/web3`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('当前网络');
    expect(html).toContain('chainNames');
    expect(html).toContain('chainChanged');
    // 登录不该被收款配置卡住，所以这里没有切链调用
    expect(html).not.toContain('wallet_switchEthereumChain');
  });
});
