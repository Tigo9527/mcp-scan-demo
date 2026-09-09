/**
 * OAuth 2.1 完整流程的端到端测试：发现 → 动态注册 → 授权 → 换令牌 → 调 MCP → 刷新。
 *
 * 与 oauth.test.ts 的分工：那边只锁「发现」这一段（元数据地址、401 头格式），
 * 这里扮演一个**真实的 OAuth 客户端**，把后续每一步都跑一遍，重点覆盖失败路径 ——
 * 授权码这套东西最容易出的不是「正常流程跑不通」，而是「校验漏了一条被人绕过」。
 *
 * 刻意不用 SDK 的 auth()：那需要浏览器交互，测试里没法自动化；这里手工走协议，
 * 但 PKCE / state / resource 全部按真实客户端的方式生成。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.js';
import { configure } from '../src/persist.js';
import * as auth from '../src/auth/manager.js';
import * as store from '../src/auth/store.js';
import { canonicalResourceUri, MCP_PATH } from '../src/oauth/metadata.js';
import { seal } from '../src/oauth/tickets.js';
import * as github from '../src/auth/github.js';
import { setGithub, resetGithub, getGithub } from '../src/settings.js';

// 真实 GitHub 交换会触网，且需要真实凭据；这里只把 exchangeAndLogin 替换成桩，
// 其余 github 模块（createState / verifyState / isGitHubConfigured 等）保留真实实现。
vi.mock('../src/auth/github.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/auth/github.js')>();
  return { ...actual, exchangeAndLogin: vi.fn() };
});

let server: Server;
let base: string;

const REDIRECT = 'http://127.0.0.1:54321/cb'; // 回环 + 随机端口，模拟桌面客户端
const USERNAME = 'oauth_flow_user';
const PASSWORD = 'password123';

beforeAll(async () => {
  configure({ enabled: false });
  vi.stubEnv('MCP_DEMO_REQUIRE_AUTH', 'on');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  auth.registerWithPassword(USERNAME, PASSWORD);
});

afterAll(() => {
  vi.unstubAllEnvs();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ---------------- 工具 ----------------

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

/** 像真实客户端一样，从授权页里把隐藏字段抠出来（这些是 POST 时要原样回传的） */
function hiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    out[decodeEntities(m[1])] = decodeEntities(m[2]);
  }
  return out;
}

async function registerClient(redirectUris: unknown[], name = 'vitest client'): Promise<Response> {
  return fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      client_name: name,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
}

function authorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state?: string;
  resource?: string;
}): string {
  const u = new URL(`${base}/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('resource', p.resource ?? canonicalResourceUri(base));
  if (p.state) u.searchParams.set('state', p.state);
  return u.toString();
}

/** 从「正在跳回客户端」页里抠出回调 URL（含 code / state） */
function extractCallback(html: string): string {
  const m = /id="cb-link"[^>]*href="([^"]+)"/.exec(html);
  expect(m, `页面应包含回跳链接，实际：${html.slice(0, 300)}`).toBeTruthy();
  return decodeEntities(m![1]);
}

/** 走完 DCR + 授权页 + 登录，返回授权码（登录成功后渲染「回跳客户端」页，从页内提取 code） */
async function obtainCode(opts: { redirectUri?: string; state?: string } = {}): Promise<{
  code: string;
  clientId: string;
  verifier: string;
  redirectUri: string;
}> {
  const reg = await registerClient([opts.redirectUri ?? REDIRECT]);
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const redirectUri = opts.redirectUri ?? REDIRECT;

  const page = await fetch(
    authorizeUrl({ clientId: client.client_id, redirectUri, challenge, state: opts.state }),
    { redirect: 'manual' },
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  const hidden = hiddenInputs(html);

  const res = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...hidden, username: USERNAME, password: PASSWORD }).toString(),
    redirect: 'manual',
  });
  expect(res.status).toBe(200);
  const callbackUrl = extractCallback(await res.text());
  const loc = new URL(callbackUrl);
  const code = loc.searchParams.get('code');
  expect(code, `应回传授权码，实际页面回跳地址：${callbackUrl}`).toBeTruthy();
  return { code: code!, clientId: client.client_id, verifier, redirectUri };
}

async function exchange(body: Record<string, string>): Promise<Response> {
  return fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function mcpCall(token: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'vitest-oauth-flow', version: '1.0.0' },
      },
    }),
  });
}

// ---------------- 发现链 ----------------

describe('发现链：401 → PRM → AS → 注册端点', () => {
  it('从 401 头一路能走到 DCR，且每跳地址都真的可用', async () => {
    // 受保护工具 whoami 未带令牌必须 401，触发标准 OAuth 发现（revert 旧版匿名放行后，
    // 包括 initialize 在内的未鉴权请求统一返回 401）
    const unauth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
    });
    expect(unauth.status).toBe(401);

    const prmUrl = /resource_metadata="([^"]*)"/.exec(
      unauth.headers.get('www-authenticate') ?? '',
    )?.[1];
    expect(prmUrl).toBeTruthy();

    const prm = (await (await fetch(prmUrl!)).json()) as { authorization_servers: string[] };
    const asBase = prm.authorization_servers[0];
    expect(asBase).toBe(base);

    const as = (await (
      await fetch(`${asBase}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, string>;
    expect(as.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(as.authorization_endpoint).toBe(`${base}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${base}/oauth/token`);

    const reg = await registerClient([REDIRECT]);
    expect(reg.status).toBe(201);
  });
});

// ---------------- 动态注册（RFC 7591） ----------------

describe('动态客户端注册', () => {
  it('返回 201 + client_id，且签发的是公开客户端', async () => {
    const res = await registerClient([REDIRECT]);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const json = (await res.json()) as Record<string, unknown>;
    expect(typeof json.client_id).toBe('string');
    expect(json.token_endpoint_auth_method).toBe('none');
    expect(typeof json.client_id_issued_at).toBe('number');
    expect(json.redirect_uris).toEqual([REDIRECT]);
    expect(json.client_name).toBe('vitest client');
  });

  it('非回环地址用 http 会被拒绝（OAuth 2.1 要求 https）', async () => {
    const res = await registerClient(['http://example.com/cb']);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid_redirect_uri');
  });

  it('带 fragment 的 redirect_uri 一律拒绝', async () => {
    const res = await registerClient(['https://example.com/cb#frag']);
    expect(res.status).toBe(400);
  });

  it('要求 client_secret 的客户端直接被拒（本服务只发公开客户端）', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client_metadata');
  });

  it('OPTIONS 预检可用（浏览器里的客户端要能注册）', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// ---------------- 授权端点 ----------------

describe('授权端点 /oauth/authorize', () => {
  it('参数合法时渲染登录页，并把必要参数放进隐藏字段', async () => {
    const reg = await registerClient([REDIRECT], '页面客户端');
    const client = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();

    const res = await fetch(
      authorizeUrl({ clientId: client.client_id, redirectUri: REDIRECT, challenge, state: 'xyz' }),
      { redirect: 'manual' },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('页面客户端');
    const hidden = hiddenInputs(html);
    expect(hidden.client_id).toBe(client.client_id);
    expect(hidden.code_challenge).toBe(challenge);
    expect(hidden.state).toBe('xyz');
    expect(hidden.response_type).toBe('code');
    expect(hidden.resource).toBe(`${base}${MCP_PATH}`);
  });

  it('client_id 无效时渲染错误页，绝不重定向（否则就是开放重定向）', async () => {
    const { challenge } = pkce();
    const res = await fetch(
      authorizeUrl({ clientId: 'not-a-client', redirectUri: REDIRECT, challenge }),
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirect_uri 与注册不符时拒绝', async () => {
    const reg = await registerClient([REDIRECT]);
    const client = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const res = await fetch(
      authorizeUrl({
        clientId: client.client_id,
        redirectUri: 'http://127.0.0.1:1/other',
        challenge,
      }),
      { redirect: 'manual' },
    );
    // 校验通过才允许回传错误，这里是「与注册不符」，所以走渲染错误页
    expect(res.status).toBe(400);
  });

  it('缺 PKCE 或不是 S256 时拒绝（OAuth 2.1 强制）', async () => {
    const reg = await registerClient([REDIRECT]);
    const client = (await reg.json()) as { client_id: string };
    const u = new URL(`${base}/oauth/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', client.client_id);
    u.searchParams.set('redirect_uri', REDIRECT);
    u.searchParams.set('code_challenge', 'abc');
    u.searchParams.set('code_challenge_method', 'plain');
    const res = await fetch(u.toString(), { redirect: 'manual' });
    expect(res.status).toBe(302); // 校验通过的地址才回传 error
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
  });

  it('resource 不是本服务 canonical URI 时拒绝（RFC 8707）', async () => {
    const reg = await registerClient([REDIRECT]);
    const client = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const res = await fetch(
      authorizeUrl({
        clientId: client.client_id,
        redirectUri: REDIRECT,
        challenge,
        resource: 'https://evil.example/mcp',
      }),
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('回环地址的端口不参与比对（RFC 8252 §7.3，桌面客户端用随机端口）', async () => {
    const reg = await registerClient(['http://127.0.0.1:1111/cb']);
    const client = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const res = await fetch(
      authorizeUrl({
        clientId: client.client_id,
        redirectUri: 'http://127.0.0.1:2222/cb',
        challenge,
      }),
      { redirect: 'manual' },
    );
    expect(res.status).toBe(200);
  });

  it('口令错误时回到登录页并提示，不签发授权码', async () => {
    const reg = await registerClient([REDIRECT]);
    const client = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const page = await fetch(
      authorizeUrl({ clientId: client.client_id, redirectUri: REDIRECT, challenge }),
      { redirect: 'manual' },
    );
    const hidden = hiddenInputs(await page.text());

    const res = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...hidden,
        username: USERNAME,
        password: 'wrong-password',
      }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
  });
});

// ---------------- 令牌端点 ----------------

describe('令牌端点 /oauth/token', () => {
  it('authorization_code + PKCE 换到可用令牌，且带着 refresh_token', async () => {
    const { code, clientId, verifier, redirectUri } = await obtainCode({ state: 'st-1' });
    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}${MCP_PATH}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.token_type).toBe('Bearer');
    expect(json.expires_in).toBe(3600);
    expect(String(json.access_token)).toMatch(/^mcp_demo_/);
    expect(typeof json.refresh_token).toBe('string');

    // 拿到的令牌真的能调 /mcp
    const mcp = await mcpCall(String(json.access_token));
    expect(mcp.status).toBe(200);
    const result = (await mcp.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(result.result?.serverInfo?.name).toBe('mcp-demo');
  });

  it('授权码只能用一次（重放被拒）', async () => {
    const { code, clientId, verifier, redirectUri } = await obtainCode();
    const body = {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    };
    expect((await exchange(body)).status).toBe(200);
    const second = await exchange(body);
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('code_verifier 错误 → invalid_grant', async () => {
    const { code, clientId, redirectUri } = await obtainCode();
    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: b64u(randomBytes(32)),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('client_id 与授权码不匹配 → invalid_grant', async () => {
    const { code, verifier, redirectUri } = await obtainCode();
    const other = (await (await registerClient([REDIRECT])).json()) as { client_id: string };
    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      client_id: other.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    expect(res.status).toBe(400);
  });

  it('redirect_uri 与授权请求不一致 → invalid_grant', async () => {
    const { code, clientId, verifier } = await obtainCode();
    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9/nope',
      code_verifier: verifier,
    });
    expect(res.status).toBe(400);
  });

  it('拿 client_id 当授权码用 → 无效（票据用途由 AAD 绑定）', async () => {
    const reg = await registerClient([REDIRECT]);
    const client = (await reg.json()) as { client_id: string };
    const res = await exchange({
      grant_type: 'authorization_code',
      code: client.client_id,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('被篡改的授权码 → invalid_grant（AES-GCM 认证失败）', async () => {
    const { code, clientId, verifier, redirectUri } = await obtainCode();
    const parts = code.split('.');
    parts[3] = Buffer.from('tampered-ciphertext').toString('base64url');
    const res = await exchange({
      grant_type: 'authorization_code',
      code: parts.join('.'),
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    expect(res.status).toBe(400);
  });

  it('过期的授权码 → invalid_grant', async () => {
    const expired = seal('code', { clientId: 'c', redirectUri: REDIRECT }, -10);
    const res = await exchange({
      grant_type: 'authorization_code',
      code: expired,
      client_id: 'c',
      redirect_uri: REDIRECT,
      code_verifier: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('refresh_token 能换到新的访问令牌', async () => {
    const { code, clientId, verifier, redirectUri } = await obtainCode();
    const first = (await (
      await exchange({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      })
    ).json()) as { access_token: string; refresh_token: string };

    const res = await exchange({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { access_token: string; refresh_token: string };
    expect(json.access_token).toMatch(/^mcp_demo_/);
    // 不轮换：无状态方案检测不到旧 refresh_token 是否被重放，轮换不会更安全
    expect(json.refresh_token).toBe(first.refresh_token);

    expect((await mcpCall(json.access_token)).status).toBe(200);
  });

  it('refresh_token 与 client_id 不匹配 → invalid_grant', async () => {
    const { code, clientId, verifier, redirectUri } = await obtainCode();
    const first = (await (
      await exchange({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      })
    ).json()) as { refresh_token: string };
    const other = (await (await registerClient([REDIRECT])).json()) as { client_id: string };
    const res = await exchange({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: other.client_id,
    });
    expect(res.status).toBe(400);
  });

  it('访问令牌当 refresh_token 用 → invalid_grant（purpose 不匹配）', async () => {
    const { code, clientId, verifier, redirectUri } = await obtainCode();
    const first = (await (
      await exchange({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      })
    ).json()) as { access_token: string };
    const res = await exchange({
      grant_type: 'refresh_token',
      refresh_token: first.access_token,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
  });

  it('不支持的 grant_type → unsupported_grant_type', async () => {
    const res = await exchange({ grant_type: 'client_credentials' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unsupported_grant_type');
  });
});

// ---------------- 受众校验（RFC 8707） ----------------

describe('访问令牌的受众校验', () => {
  it('aud 与本服务不符 → 403 而不是 401（401 会让 SDK 陷入死循环）', async () => {
    const user = store.getUser(auth.registerWithPassword('oauth_aud_user', PASSWORD).user.id)!;
    const foreign = auth.issueOAuthAccessToken({
      user,
      resource: 'https://evil.example/mcp',
      issuer: base,
      scope: 'mcp',
      clientId: 'whatever',
    });
    const res = await mcpCall(foreign.access_token);
    expect(res.status).toBe(403);
    const header = res.headers.get('www-authenticate') ?? '';
    expect(header).toContain('insufficient_scope');
  });

  it('老令牌没有 aud 声明 → 放行（祖父条款）', async () => {
    const legacy = auth.registerWithPassword('oauth_legacy_user', PASSWORD).token;
    const res = await mcpCall(legacy);
    expect(res.status).toBe(200);
  });
});

// ---------------- GitHub 流程携带授权参数（穿透最后一跳） ----------------
//
// 复现 Codex 命令行登录失败的根因：授权 URL 带着 redirect_uri / PKCE / state，
// 但旧版 /auth/github/callback 只渲染通用的「登录成功」页，不知道要回跳客户端。
// 现在把原始授权请求封进 authorize 票据、穿过 GitHub 流程，登录成功后还原并回跳。

describe('通过 GitHub 完成 MCP 授权（授权参数穿透）', () => {
  afterEach(() => {
    resetGithub();
    vi.mocked(github).exchangeAndLogin.mockReset();
  });

  function enableGithub(): void {
    setGithub({
      clientId: 'Iv1.testclientid',
      clientSecret: 'test-secret',
      redirectUri: `${base}/auth/github/callback`,
      scope: 'read:user',
    });
  }

  async function fakeGithubLogin(): Promise<void> {
    // 每个用例用独立用户名，避免「用户名已占用」（同文件多次调用 registerWithPassword）
    const u = auth.registerWithPassword(`gh_${randomUUID().slice(0, 8)}`, PASSWORD).user;
    vi.mocked(github).exchangeAndLogin.mockResolvedValue({ user: u, token: 'fake-gh-token' });
  }

  it('授权页在 GitHub 已配置时含 authorize 票据链接；未配置时不含', async () => {
    expect(getGithub().configured).toBe(false);
    let reg = await registerClient([REDIRECT], 'page-gh-1');
    let client = (await reg.json()) as { client_id: string };
    let { challenge } = pkce();
    let res = await fetch(
      authorizeUrl({ clientId: client.client_id, redirectUri: REDIRECT, challenge, state: 's1' }),
      { redirect: 'manual' },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('/auth/github?authorize=');

    enableGithub();
    expect(getGithub().configured).toBe(true);
    reg = await registerClient([REDIRECT], 'page-gh-2');
    client = (await reg.json()) as { client_id: string };
    ({ challenge } = pkce());
    res = await fetch(
      authorizeUrl({ clientId: client.client_id, redirectUri: REDIRECT, challenge, state: 's1' }),
      { redirect: 'manual' },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/auth/github?authorize=');
  });

  it('GitHub 回调带 authorize 票据 → 完成授权、渲染回跳页、code 可换令牌', async () => {
    enableGithub();
    await fakeGithubLogin();

    const reg = await registerClient([REDIRECT], 'gh-client');
    const client = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const authorizeTicket = seal(
      'authorize',
      {
        clientId: client.client_id,
        redirectUri: REDIRECT,
        state: 'gh-state-1',
        codeChallenge: challenge,
        scope: 'mcp',
        resource: canonicalResourceUri(base),
      },
      600,
    );
    const stateJwt = github.createState(authorizeTicket);

    const res = await fetch(
      `${base}/auth/github/callback?code=fakecode&state=${encodeURIComponent(stateJwt)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('正在跳回客户端');
    const callbackUrl = extractCallback(html);
    const loc = new URL(callbackUrl);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('gh-state-1');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();

    // 端到端：用拿到的 code 走令牌端点，验证授权码真的有效（PKCE + 受众 + 客户端匹配）
    const tok = await exchange({
      grant_type: 'authorization_code',
      code: code!,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: canonicalResourceUri(base),
    });
    expect(tok.status).toBe(200);
    const json = (await tok.json()) as { access_token: string };
    expect(json.access_token).toMatch(/^mcp_demo_/);
  });

  it('authorize 票据被篡改或已过期 → 渲染错误页，不回跳', async () => {
    enableGithub();
    await fakeGithubLogin();

    // 篡改：state JWT 合法，但里面的 authorize 票据是乱码
    const badState = github.createState('not-a-real-ticket');
    let res = await fetch(
      `${base}/auth/github/callback?code=fake&state=${encodeURIComponent(badState)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    let html = await res.text();
    expect(html).not.toContain('正在跳回客户端');
    expect(html).toContain('授权票据');

    // 过期：seal 用负 ttl
    const reg = await registerClient([REDIRECT]);
    const client = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const expired = seal(
      'authorize',
      {
        clientId: client.client_id,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        scope: 'mcp',
        resource: canonicalResourceUri(base),
      },
      -10,
    );
    const s2 = github.createState(expired);
    res = await fetch(
      `${base}/auth/github/callback?code=fake&state=${encodeURIComponent(s2)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    html = await res.text();
    expect(html).not.toContain('正在跳回客户端');
  });

  it('无 authorize 票据 → 回退到普通 GitHub 登录成功页（向后兼容）', async () => {
    enableGithub();
    await fakeGithubLogin();

    const stateJwt = github.createState(); // 不带票据
    const res = await fetch(
      `${base}/auth/github/callback?code=fake&state=${encodeURIComponent(stateJwt)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('GitHub 登录成功');
    expect(html).not.toContain('正在跳回客户端');
  });
});

// ---------------- 账号密码注册完成 MCP 授权（穿透最后一跳） ----------------
//
// 复现钉钉等客户端安装 MCP 时的问题：用户在授权登录页点「注册新账号」，
// 旧版 /register 不带任何 OAuth 上下文，注册成功后只展示令牌页，授权握手断在这里——
// 不签发 code、不回跳 redirect_uri，客户端收不到通知。现在注册链接带 authorize 票据，
// 注册成功即在授权流程内签发 code 并回跳。

describe('通过账号密码注册完成 MCP 授权', () => {
  function extractAuthorizeTicketFromRegisterLink(html: string): string {
    const m = /\/register\?authorize=([^"&]+)/.exec(html);
    expect(m, `授权页应含带 authorize 票据的注册链接，实际：${html.slice(0, 300)}`).toBeTruthy();
    return decodeEntities(m![1]);
  }

  it('授权页的「注册新账号」链接带 authorize 票据', async () => {
    const reg = await registerClient([REDIRECT], 'reg-link-client');
    const client = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const res = await fetch(
      authorizeUrl({ clientId: client.client_id, redirectUri: REDIRECT, challenge, state: 'reg-state' }),
      { redirect: 'manual' },
    );
    expect(res.status).toBe(200);
    const ticket = extractAuthorizeTicketFromRegisterLink(await res.text());
    expect(ticket.length).toBeGreaterThan(0);
  });

  it('从授权页注册新账号 → 完成授权、渲染回跳页、code 可换令牌', async () => {
    const reg = await registerClient([REDIRECT], 'reg-client');
    const client = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const page = await fetch(
      authorizeUrl({ clientId: client.client_id, redirectUri: REDIRECT, challenge, state: 'reg-state-2' }),
      { redirect: 'manual' },
    );
    const ticket = extractAuthorizeTicketFromRegisterLink(await page.text());

    // 进入注册页，确认 authorize 票据以隐藏字段形式保留
    const regPage = await fetch(`${base}/register?authorize=${encodeURIComponent(ticket)}`);
    expect(regPage.status).toBe(200);
    expect(await regPage.text()).toContain('name="authorize"');

    // 提交注册表单（带 authorize 隐藏字段），使用全新账号
    const username = `reg_user_${randomUUID().slice(0, 8)}`;
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password: PASSWORD, authorize: ticket }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('正在跳回客户端');
    const callbackUrl = extractCallback(html);
    const loc = new URL(callbackUrl);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('reg-state-2');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();

    // 端到端：用拿到的 code 走令牌端点，验证授权码真的有效（PKCE + 受众 + 客户端匹配）
    const tok = await exchange({
      grant_type: 'authorization_code',
      code: code!,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: canonicalResourceUri(base),
    });
    expect(tok.status).toBe(200);
    const json = (await tok.json()) as { access_token: string };
    expect(json.access_token).toMatch(/^mcp_demo_/);
  });

  it('无 authorize 票据的注册 → 保持普通「注册成功」令牌页（不回跳）', async () => {
    const username = `reg_plain_${randomUUID().slice(0, 8)}`;
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password: PASSWORD }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('注册成功');
    expect(html).not.toContain('正在跳回客户端');
  });

  it('注册用户名已占用（失败路径）→ 重新渲染注册页且 authorize 票据保留，不回跳', async () => {
    const reg = await registerClient([REDIRECT], 'reg-fail-client');
    const client = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const page = await fetch(
      authorizeUrl({ clientId: client.client_id, redirectUri: REDIRECT, challenge, state: 'reg-state-3' }),
      { redirect: 'manual' },
    );
    const ticket = extractAuthorizeTicketFromRegisterLink(await page.text());

    // USERNAME 在 beforeAll 已注册，用它提交必然失败
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: USERNAME, password: PASSWORD, authorize: ticket }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const html = await res.text();
    expect(html).toContain('name="authorize"');
    expect(html).not.toContain('正在跳回客户端');
  });
});
