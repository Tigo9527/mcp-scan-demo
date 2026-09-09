/**
 * web3 钱包签名登录（MetaMask）的回归测试。
 *
 * 覆盖：地址校验、挑战-应答完整流程、地址不匹配拒绝、一次性挑战防重放、页面渲染、
 * 以及 web3_login 工具在公开工具清单内可被发现。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { configure } from '../src/persist.js';
import { Wallet } from 'ethers';

let server: Server;
let base: string;

beforeAll(async () => {
  configure({ enabled: false });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

describe('web3 钱包登录', () => {
  it('GET /web3/nonce 校验地址并下发挑战', async () => {
    const bad = await fetch(`${base}/web3/nonce?address=not-an-address`);
    expect(bad.status).toBe(400);

    const wallet = Wallet.createRandom();
    const res = await fetch(`${base}/web3/nonce?address=${wallet.address}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { address: string; nonce: string; message: string };
    expect(json.address).toBe(wallet.address);
    expect(/^[a-f0-9]{32}$/.test(json.nonce)).toBe(true);
    expect(json.message).toContain(wallet.address);
    expect(json.message).toContain(json.nonce);
  });

  it('完整流程：签名 -> /web3/verify 拿到令牌（且可重复登录同一钱包）', async () => {
    const wallet = Wallet.createRandom();
    const n = (await (await fetch(`${base}/web3/nonce?address=${wallet.address}`)).json()) as {
      message: string;
    };
    const signature = await wallet.signMessage(n.message);
    const v = await fetch(`${base}/web3/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature }),
    });
    expect(v.status).toBe(200);
    const data = (await v.json()) as {
      token: string;
      user: { provider: string; walletAddress: string };
    };
    expect(data.token.startsWith('mcp_demo_')).toBe(true);
    expect(data.user.provider).toBe('web3');
    expect(data.user.walletAddress).toBe(wallet.address);

    // 同一钱包再次走流程仍能登录（find-or-create，不报错）
    const n2 = (await (await fetch(`${base}/web3/nonce?address=${wallet.address}`)).json()) as {
      message: string;
    };
    const sig2 = await wallet.signMessage(n2.message);
    const v2 = await fetch(`${base}/web3/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature: sig2 }),
    });
    expect(v2.status).toBe(200);
    const d2 = (await v2.json()) as { user: { walletAddress: string } };
    expect(d2.user.walletAddress).toBe(wallet.address);
  });

  it('签名地址与请求地址不匹配时拒绝（401）', async () => {
    const alice = Wallet.createRandom();
    const bob = Wallet.createRandom();
    const n = (await (await fetch(`${base}/web3/nonce?address=${alice.address}`)).json()) as {
      message: string;
    };
    // bob 用自己的钱包签 alice 的挑战
    const sig = await bob.signMessage(n.message);
    const v = await fetch(`${base}/web3/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: alice.address, signature: sig }),
    });
    expect(v.status).toBe(401);
  });

  it('挑战一次性：用完即失效，重放被拒（400）', async () => {
    const wallet = Wallet.createRandom();
    const n = (await (await fetch(`${base}/web3/nonce?address=${wallet.address}`)).json()) as {
      message: string;
    };
    const sig = await wallet.signMessage(n.message);
    const first = await fetch(`${base}/web3/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature: sig }),
    });
    expect(first.status).toBe(200);
    // 重放同一签名（挑战已作废）
    const replay = await fetch(`${base}/web3/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature: sig }),
    });
    expect(replay.status).toBe(400);
  });

  it('/web3 页面可渲染（含连接钱包按钮）', async () => {
    const res = await fetch(`${base}/web3`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('连接钱包并登录');
    expect(html).toContain('/web3/nonce');
  });

  it('web3_login 工具在公开工具清单内（anonMode 可发现）', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Unauthorized-Status': '200',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
    const names = (data.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('web3_login');
  });
});
