/**
 * web3 钱包签名登录（MetaMask）的回归测试。
 *
 * 覆盖：地址校验、挑战-应答完整流程、地址不匹配拒绝、一次性挑战防重放、页面渲染、
 * 以及 web3_login 工具在公开工具清单内可被发现。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { configure } from '../src/persist.js';
import { canonicalResourceUri } from '../src/oauth/metadata.js';
import { seal } from '../src/oauth/tickets.js';
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

/**
 * web3 签名登录完成 MCP 授权（授权参数穿透，与 GitHub / 账号密码注册同构）。
 *
 * 复现 OAuth 最后一跳断裂：客户端把用户导航到 /oauth/authorize 带齐 redirect_uri / PKCE / state，
 * 但若用户选择「用钱包签名登录」，旧版 /web3/verify 只返回 JSON 令牌，授权握手断在这里——
 * 不签发 code、不回跳 redirect_uri，客户端收不到通知。现在 authorize 票据穿过 web3 流程，
 * 签名校验成功后还原并回跳，与另两条路径共用 completeAuthorize 最后一跳。
 */
describe('通过 web3 签名完成 MCP 授权（授权参数穿透）', () => {
  const REDIRECT = 'http://127.0.0.1:54321/cb'; // 回环 + 随机端口，模拟桌面客户端

  function b64u(buf: Buffer): string {
    return buf.toString('base64url');
  }
  function pkce(): { verifier: string; challenge: string } {
    const verifier = b64u(randomBytes(32));
    const challenge = b64u(createHash('sha256').update(verifier, 'utf8').digest());
    return { verifier, challenge };
  }
  function decodeEntities(s: string): string {
    return s
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  /** 从「正在跳回客户端」页里抠出回调 URL（含 code / state） */
  function extractCallback(html: string): string {
    const m = /id="cb-link"[^>]*href="([^"]+)"/.exec(html);
    expect(m, `页面应包含回跳链接，实际：${html.slice(0, 300)}`).toBeTruthy();
    return decodeEntities(m![1]);
  }
  async function registerClient(): Promise<{ clientId: string }> {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        client_name: 'web3-client',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(res.status).toBe(201);
    const c = (await res.json()) as { client_id: string };
    return { clientId: c.client_id };
  }

  it('GET /web3/nonce 原样回显 authorize 票据', async () => {
    const { clientId } = await registerClient();
    const { challenge } = pkce();
    const ticket = seal(
      'authorize',
      {
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        scope: 'mcp',
        resource: canonicalResourceUri(base),
      },
      600,
    );
    const wallet = Wallet.createRandom();
    const res = await fetch(`${base}/web3/nonce?address=${wallet.address}&authorize=${encodeURIComponent(ticket)}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { authorize?: string };
    expect(json.authorize).toBe(ticket);
  });

  it('授权页含「用钱包签名登录并授权」入口（带 authorize 票据）', async () => {
    const { clientId } = await registerClient();
    const { challenge } = pkce();
    const u = new URL(`${base}/oauth/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', REDIRECT);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('resource', canonicalResourceUri(base));
    const res = await fetch(u.toString(), { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/web3?authorize=');
  });

  it('web3 签名 + authorize 票据 → 完成授权、回跳页、code 可换令牌', async () => {
    const { clientId } = await registerClient();
    const { verifier, challenge } = pkce();
    const authorizeTicket = seal(
      'authorize',
      {
        clientId,
        redirectUri: REDIRECT,
        state: 'web3-state-1',
        codeChallenge: challenge,
        scope: 'mcp',
        resource: canonicalResourceUri(base),
      },
      600,
    );
    const wallet = Wallet.createRandom();
    const nonce = (await (
      await fetch(`${base}/web3/nonce?address=${wallet.address}&authorize=${encodeURIComponent(authorizeTicket)}`)
    ).json()) as { message: string };
    const signature = await wallet.signMessage(nonce.message);
    const v = await fetch(`${base}/web3/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature, authorize: authorizeTicket }),
    });
    expect(v.status).toBe(200);
    expect(v.headers.get('content-type')).toContain('text/html');
    const html = await v.text();
    expect(html).toContain('正在跳回客户端');
    const callbackUrl = extractCallback(html);
    const loc = new URL(callbackUrl);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('web3-state-1');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();

    // 端到端：用拿到的 code 走令牌端点，验证授权码真的有效（PKCE + 受众 + 客户端匹配）
    const tok = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: code!,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: canonicalResourceUri(base),
      }),
    });
    expect(tok.status).toBe(200);
    const json = (await tok.json()) as { access_token: string };
    expect(json.access_token).toMatch(/^mcp_demo_/);
  });

  it('authorize 票据无效/已过期 → 退化为普通登录（返回 JSON 令牌，不回跳）', async () => {
    const wallet = Wallet.createRandom();
    const nonce = (await (await fetch(`${base}/web3/nonce?address=${wallet.address}`)).json()) as {
      message: string;
    };
    const signature = await wallet.signMessage(nonce.message);
    const expired = seal(
      'authorize',
      {
        clientId: 'whatever',
        redirectUri: REDIRECT,
        codeChallenge: 'x',
        scope: 'mcp',
        resource: canonicalResourceUri(base),
      },
      -10,
    );
    const v = await fetch(`${base}/web3/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature, authorize: expired }),
    });
    expect(v.status).toBe(200);
    expect(v.headers.get('content-type')).not.toContain('text/html');
    const json = (await v.json()) as { token: string };
    expect(json.token.startsWith('mcp_demo_')).toBe(true);
  });
});
