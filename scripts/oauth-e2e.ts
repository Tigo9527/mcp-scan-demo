/**
 * 用**官方 SDK 的 auth()** 跑一遍完整 OAuth 2.1 流程的验证脚本。
 *
 * 为什么不靠单元测试代替：单元测试是我们自己按协议写的「假客户端」，
 * 它跑通只能证明我们和自己的理解一致。这里换成官方 SDK 的真实实现
 * （`discoverOAuthServerInfo` → `registerClient` → `startAuthorization` → `exchangeAuthorization`），
 * 才能真正回答「Codex / Claude Desktop 这类客户端能不能自己发现并登录」。
 *
 * 用法：npx tsx scripts/oauth-e2e.ts
 * 脚本会自己起服务（随机端口）、自己模拟浏览器完成登录，全程无需人工干预。
 */
const PORT = Number(process.env.E2E_PORT ?? 0);

// 必须在 import 业务模块**之前**就绪：config.ts 在模块加载时就快照了 env
process.env.MCP_DEMO_REQUIRE_AUTH = 'on';
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${PORT}`;

const { createApp } = await import('../src/web/app.js');
const { configure } = await import('../src/persist.js');
const authManager = await import('../src/auth/manager.js');
const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import(
  '@modelcontextprotocol/sdk/client/streamableHttp.js'
);

configure({ enabled: false }); // 别污染 data/

const USERNAME = 'sdk_e2e_user';
const PASSWORD = 'password123';
const REDIRECT = 'http://127.0.0.1:8765/cb';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function hiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    out[decodeEntities(m[1])] = decodeEntities(m[2]);
  }
  return out;
}

/** 模拟用户：打开授权页 → 填用户名密码 → 提交 → 从 302 里拿 code */
async function actAsUser(authorizationUrl: URL): Promise<string> {
  const page = await fetch(authorizationUrl, { redirect: 'manual' });
  if (page.status !== 200) throw new Error(`授权页返回 ${page.status}`);
  const hidden = hiddenInputs(await page.text());
  const res = await fetch(`${authorizationUrl.origin}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...hidden, username: USERNAME, password: PASSWORD }).toString(),
    redirect: 'manual',
  });
  let callbackUrl: string | null = null;
  if (res.status === 302) {
    callbackUrl = res.headers.get('location');
  } else if (res.status === 200) {
    const html = await res.text();
    const match = html.match(/id="cb-link"[^>]+href="([^"]+)"/);
    callbackUrl = match ? decodeEntities(match[1]) : null;
  } else {
    throw new Error(`登录后返回 ${res.status}，期望 200 或 302`);
  }
  if (!callbackUrl) throw new Error('授权完成页没有回调地址');
  const code = new URL(callbackUrl).searchParams.get('code');
  if (!code) throw new Error('回调里没有 code');
  return code;
}

async function main(): Promise<void> {
  const server = createApp().listen(PORT, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  // PUBLIC_BASE_URL 里写的是 0，这里换成真实端口后重新推导 canonical
  process.env.PUBLIC_BASE_URL = base;
  console.log(`\n▶ 本地服务已启动：${base}\n`);

  authManager.registerWithPassword(USERNAME, PASSWORD);

  const serverUrl = new URL(`${base}/mcp`);

  // 一个最小但真实的 OAuth 客户端（对应 Codex / Claude Desktop 的角色）
  const store: {
    clientInfo?: any;
    tokens?: any;
    verifier?: string;
    authorizationUrl?: URL;
  } = {};

  const provider = {
    get redirectUrl() {
      return REDIRECT;
    },
    get clientMetadata() {
      return {
        redirect_uris: [REDIRECT],
        client_name: 'sdk-e2e-script',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state: () => 'sdk-e2e-state',
    clientInformation: () => store.clientInfo,
    saveClientInformation: (info: any) => {
      store.clientInfo = info;
    },
    tokens: () => store.tokens,
    saveTokens: (t: any) => {
      store.tokens = t;
    },
    redirectToAuthorization: (url: URL) => {
      store.authorizationUrl = url;
    },
    saveCodeVerifier: (v: string) => {
      store.verifier = v;
    },
    codeVerifier: () => store.verifier!,
  };

  try {
    console.log('① SDK 自己走发现 + 动态注册，并以 REDIRECT 结束');
    const first = await auth(provider as any, { serverUrl });
    check('auth() 返回 REDIRECT', first === 'REDIRECT', String(first));
    check('已完成动态客户端注册', typeof store.clientInfo?.client_id === 'string');
    check('已生成 PKCE verifier', typeof store.verifier === 'string' && store.verifier.length > 20);
    check('已给出授权页地址', store.authorizationUrl instanceof URL);

    const u = store.authorizationUrl!;
    console.log(`   授权页：${u.toString().slice(0, 120)}…`);
    check('带 code_challenge_method=S256', u.searchParams.get('code_challenge_method') === 'S256');
    check('带 resource（RFC 8707）', u.searchParams.get('resource') === `${base}/mcp`);
    check('带 redirect_uri', u.searchParams.get('redirect_uri') === REDIRECT);
    check('带 state', u.searchParams.get('state') === 'sdk-e2e-state');

    console.log('\n② 模拟用户在授权页登录');
    const code = await actAsUser(u);
    check('拿到授权码', typeof code === 'string' && code.length > 20);

    console.log('\n③ SDK 用授权码 + PKCE 换令牌');
    const second = await auth(provider as any, { serverUrl, authorizationCode: code });
    check('auth() 返回 AUTHORIZED', second === 'AUTHORIZED', String(second));
    check('拿到 access_token', String(store.tokens?.access_token).startsWith('mcp_demo_'));
    check('拿到 refresh_token', typeof store.tokens?.refresh_token === 'string');

    console.log('\n④ 用 SDK Client 连上 /mcp 并真正调一个工具');
    const client = new Client({ name: 'sdk-e2e', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(serverUrl, {
      authProvider: provider as any,
    });
    await client.connect(transport);
    check('client.connect() 成功（未再触发 401）', true);

    const tools = await client.listTools();
    check(`listTools 返回 ${tools.tools.length} 个工具`, tools.tools.length > 0);

    const who = (await client.callTool({ name: 'whoami', arguments: {} })) as any;
    const text = String(who.content?.[0]?.text ?? '');
    check(`whoami 认出了 ${USERNAME}`, text.includes(USERNAME), text.slice(0, 200));

    await client.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('');
  if (failures > 0) {
    console.log(`✗ ${failures} 项未通过`);
    process.exit(1);
  }
  console.log('✓ 全部通过：官方 SDK 能自己发现、注册、登录并调用工具');
}

main().catch((err) => {
  console.error('\n✗ 脚本异常：', err);
  process.exit(1);
});
