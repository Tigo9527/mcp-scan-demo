# AGENTS.md — 给 Codex（以及其它 AI 编码代理）的指示

本仓库是一个 **MCP 服务 demo**（TypeScript + 官方 `@modelcontextprotocol/sdk`），
内置认证（账号密码注册/登录 + 一键注册 + GitHub OAuth）、Admin 管理端、用户 Profile 与调用统计。

## 任务：运行测试并回报可访问 URL

1. 安装依赖：`npm install`
2. 运行测试：`npm test`（等价 `npx vitest run`）
3. 测试会启动服务并把「可访问 URL」打印到 stdout，形如：

   ```
   ========== MCP DEMO VISIT URLS (for the user) ==========
     Web portal / one-click register : http://127.0.0.1:<port>/
     GitHub OAuth login              : http://127.0.0.1:<port>/auth/github
     MCP endpoint (Streamable HTTP)  : http://127.0.0.1:<port>/mcp
     User profile                    : http://127.0.0.1:<port>/profile
     Admin console                   : http://127.0.0.1:<port>/admin
     Health check                    : http://127.0.0.1:<port>/health
   ==========================================================
   ```

4. **把上面这段 URL 逐字转述给用户**，并说明：门户可一键注册拿令牌；
   浏览器里登录一次即自动保持，直接打开 `/profile` 就能看个人资料与调用统计（不用拼 `?token=`）；
   Admin 管理端用 `ADMIN_TOKEN` 登录（本地开发可用默认令牌 `dev-admin-change-me`）。

## 约定（重要）

- **`.env` 由入口 `src/index.ts` 顶部的 `import 'dotenv/config'` 加载**，它必须是第一条 import。
  `src/config.ts` 在模块顶层就把 env 快照成常量，重排 import 会让 `.env` 静默失效。
  `.env` 不覆盖已存在的环境变量（`dotenv` 默认 `override: false`），
  故部署平台注入的 `JWT_SECRET` / `ADMIN_TOKEN` / `PUBLIC_BASE_URL` 永远优先。
  **改 env 相关代码后必须跑 `npx vitest run test/dotenv.test.ts`。**
- **浏览器页面靠会话 Cookie 保持登录，`/mcp` 端点绝不认 Cookie**。
  登录（一键注册 / 账号密码 / GitHub / 钱包）成功后一律 `setUserTokenCookie()` 下发
  `mcp_demo_user`（HttpOnly + SameSite=Lax + Path=/ + 7 天，https 下补 Secure）；
  Web 页面用 `authenticateWebUserRequest()`（读 Cookie），MCP 端点继续用
  `authenticateUserRequest()`（**不读** Cookie）—— 否则任意第三方页面都能带着浏览器登录态调
  受保护工具，就是一个 CSRF。**不要为了「让 MCP 也免登录」把 Cookie 开给 `/mcp`。**
  页面里也别再教用户往 URL 上拼令牌（令牌会漏进浏览器历史 / Referer）；
  URL 上带 `?token=` 的老链接由 `adoptTokenFromUrl()` 兜底转成 Cookie，
  且**只在尚无 Cookie 时写**，避免管理员点「以该用户身份打开 Profile」时顶掉自己的登录态。
- **`/mcp` 默认要求登录：未携带有效令牌返回 401 + `WWW-Authenticate`**（`MCP_DEMO_REQUIRE_AUTH`
  默认 `on`，设成 `off` 才恢复旧的匿名握手）。**不要改回永远 200** —— 那正是「客户端识别不了
  登录方式」的根因：客户端只有收到 401 才会去读 `resource_metadata` 并启动标准 OAuth 发现。
  唯一例外：`notifications/*` 不 401，否则客户端初始化流程会被打断。
- **鉴权成功但受众（`aud`）不符时必须返回 403，绝不能返回 401**。官方 SDK 有熔断
  （`_hasCompletedAuthFlow`）：流程结束后再收到 401 会直接抛错而不是重跑流程，
  于是「受众不符」这个不可恢复的错误被伪装成「还没登录」，表现为死循环。
  老令牌没有 `aud` 声明 → 祖父条款放行（`readTokenAudience` 返回 `null`）。
- **授权发现的三个契约写死在 `src/oauth/metadata.ts` 顶部注释里，改之前先读**：
  ① canonical URI 是 `<base>/mcp`，按 RFC 9728 §3.1 元数据要挂在
  `<base>/.well-known/oauth-protected-resource/mcp`（根路径那份只是兜底）；
  ② 401 头里**只**放 `resource_metadata`，授权服务器地址由客户端从 PRM 派生；
  ③ **绝不能**在 AS 元数据里声明 `client_id_metadata_document_supported`
  —— SDK 一见到它就走 CIMD，绕过我们的 DCR 端点。
- **OAuth 状态一律走自包含加密票据（`src/oauth/tickets.ts`），不要改成「存起来再查」**：
  `persist.ts` 无锁无 CAS（并发写会互相覆盖）、`settings.json` 每个进程只读一次，
  存进去的东西下次不一定读得到。
  票据用 HKDF 从 `JWT_SECRET` 派生密钥（不复用 HMAC 的），并用 AES-GCM 的 AAD 绑定用途
  （`dcr` / `code`），防止一枚 client_id 票据被当成授权码去换令牌。
- **改了 OAuth 相关代码后必须同时跑 `npm test` 和 `npm run oauth:e2e`**。后者用官方 SDK 的
  `auth()` 真实走一遍发现 → DCR → 授权 → 换令牌 → 调工具，是唯一能证明「第三方客户端真的能
  自己登录」的验证；`test/oauth-flow.test.ts` 里的假客户端只能证明我们和自己的理解一致。
- **无状态下 `GET /mcp` 必须返回 405**。无状态模式（`sessionIdGenerator: undefined`）下
  GET 会建立常驻 SSE 流并起 keep-alive 定时器，爬虫/健康检查反复请求会累积悬挂连接。
- **不要用 `Authorization` 头在本服务内传令牌**。部署平台网关会拦截并改写它
  （注入平台自己的 JWT）。只认 `X-Authorization` 头 / `?token=` 查询参数，
  且值必须带本服务前缀 `mcp_demo_`。
  ⚠️ 实测网关会**无条件剥离** `Authorization: Bearer mcp_demo_…`（不带 Cookie 也一样），
  而官方 SDK 只会用 `Authorization` 头带令牌。结论：Discovery 与登录流程在公网能跑通，
  **最后一跳会被网关吞掉**；本地直连 / 自托管无此限制。详见 README「已知限制」。
- **GitHub OAuth 参数一律通过 `getGithub()`（src/settings.ts）读取**，
  **禁止**直接读 `config.githubSeed`（那是启动时快照，读不到 admin 后台的运行时改动）。
- **`/setup` 是免登录的接入说明页，页面里绝不能出现任何令牌**（它是直接转发给新用户的）。
  同理首页 `/` 的配置块也只能用不含令牌的 `publicMcpConfigJson()`。
  `test/setup-page.test.ts` 用 `mcp_demo_` 正则锁住了这一点，改这两处后必须跑。
- **落盘不要引入「多副本 / 分片」设计**：`src/persist.ts` 只认调用方给的固定 name，
  数据集与文件一一对应（`users.json` / `stats.json` / `billing.json` / `recharge.json`）。
  不要再搞 `instanceId` 后缀、按进程拆分文件名、启动合并分片这类东西；页面与接口文案里
  也不要再写「本实例视角 / 数据不跨副本共享」之类的说明。
- **保存配置时不要因为外部依赖不可用就整单拒绝**。曾经 ERC20 元数据读不到就拒绝落盘，
  结果 RPC 一抽风（如 `eth.llamarpc.com` 返回 525）管理员连收款地址都存不进去。
  正确做法：**照常保存 + 页面告警 + 提供「重新读取」与手工填写兜底**，
  只在真正影响资金安全的环节拦截（例如 decimals 缺失时拒绝入账，绝不默认 18 去猜）。
- **所有 HTML 插值必须过 `esc()`**（src/web/layout.ts），包括属性位置。
  用户名来自用户输入，历史上这里出过 XSS。
- **所有 async Express 路由必须用 `wrap()` 包一层**。Express 4 不捕获 async 的 rejection，
  逃逸出去会变成 unhandledRejection 并导致 Node 20 终止进程。
- **账号密码**：口令用 Node 内置 `crypto.scrypt` 哈希（src/auth/password.ts），绝不以明文存储；
  **绝不**写进 JWT、**绝不**经任何 API 回显、**绝不**入日志。注册/登录均为 `POST` 表单，
  复用 http.ts 的 `requireSameOrigin`（Origin 校验 + SameSite=Lax）防 CSRF。登录失败统一回显
  「用户名或密码错误」避免账号枚举；用户名/密码格式校验在服务端二次校验（src/auth/password.ts）。
- **保留一键注册链路**：`GET /register?username=` 与 MCP `register_user` 工具仍是无密码一键注册
  （供钉钉等 Agent 自动注册）。新增账号密码体系时不要动它们。
- GitHub OAuth 的 `upsertGitHubUser` 是 find-or-create：首次登录即注册，之后登录复用同一账号，已满足「注册 / 登录」。
- 统计断言请用**增量**（`diffStats`）而不是绝对值：统计是模块级单例，跨用例会累积。
- GitHub OAuth 也可在 Admin 管理端 → GitHub 设置里在线配置，无需重启。
  未配置时一键注册与令牌鉴权不受影响。

## 代码推送到 CNB（git push）— 反复踩坑，务必照此执行

本仓库托管在某个代码平台（域名用占位 `<平台域名>` 表示）。推送凭据通过平台连接器（如 `cnb-connector` 技能）获取，而非写死域名。
推送认证有两条路，**先走第 1 条**。

### ✅ 首选：干净 remote URL + 平台 credential helper（2026-09 实测有效）

环境里已配好全局凭据助手（`git config --global --get credential.helper` → `/usr/local/bin/git-credential-helper`），
**remote 保持干净**即可，凭据由 helper 自动提供：

```bash
cd /workspace/mcp-demo
git remote set-url origin https://<平台域名>/<owner>/<仓库名>.git   # 复位成不带 token 的形式（示例占位）
GIT_TERMINAL_PROMPT=0 git push origin master
```

⚠️ **别没事就往 remote URL 里塞 token**：URL 内嵌凭据优先级高于 helper，一旦塞的是只读 token（见下），
就会**盖掉 helper 里那个有写权限的**，表现为明明能推却报 `Repository Not Found`。
排查推送失败时，先把 remote 复位再试一次，比折腾 token 快得多。

### 备选：手工取 OAuth token 内嵌（仅当 helper 失效）

⚠️ **禁区：不要自己 curl 内部 token 端点。** `http://cnb-apikey.agent-gateway.auth-proxy.local/_internal/accesstoken`
返回的是**只读 deploy token**（JSON 的 `data` 字段，且只绑定到别的仓库）。用它 push 会一直报
`Repository Not Found` / `could not read Username`——token 有效但无本仓库权限，极具迷惑性。

✅ **正确做法：用 `cnb-connector` 技能取 token。** 它的 `get_token.sh cnb` 按候选顺序
`cnb → cnb-apikey → enterprise_cnb-apikey` 取，解析的是 **`access_token`** 字段（这才是带本仓库权限的 OAuth token），
导出到环境变量 `$CNB_TOKEN`。技能目录本环境在 `/root/.codebuddy/skills/cnb-connector`。

⚠️ **`cnb` connector 可能返回 404（授权失效），此时脚本会静默回退到 `cnb-apikey` 并"成功"返回**——
拿到的是只读 token，push 必失败。先确认拿的是哪个 connector：

```bash
for c in cnb cnb-apikey enterprise_cnb-apikey; do
  curl -s -o /dev/null -w "$c %{http_code}\n" --max-time 20 "http://$c.agent-gateway.auth-proxy.local/_internal/accesstoken"
done
```

只有 `cnb` 返回 200 时取到的 token 才带写权限；否则别在这条路上耗，回到上面的 helper 方案。

⚠️ **token 必须 URL-encode 才能塞进 remote URL。** 该 `access_token` 含 `+/=/` 等 URL 不安全字符，
直接拼进 URL 会触发 libcurl `Malformed input to a URL function`。用 `urllib.parse.quote(token, safe="")` 编码。

完整命令（token 全程走环境变量，禁止 `echo $CNB_TOKEN` / 明文写值）：

```bash
# 1. 取 token（导出 $CNB_TOKEN）
source /root/.codebuddy/skills/cnb-connector/scripts/get_token.sh cnb

# 2. 进入仓库
cd /workspace/mcp-demo

# 3. 编码并写入 remote URL（关键：encode）
TOKEN_ENC=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$CNB_TOKEN")
git remote set-url origin "https://oauth2:${TOKEN_ENC}@<平台域名>/<owner>/<仓库名>.git"

# 4. 推送
git push origin master
```

- **token 会过期**。遇到 401/403 或 `Repository Not Found`，重跑第 1 步取新 token 再 push 即可；
  无需改动工作区。
- 一次成功后 remote URL 已带 token，短期内同会话可直推；跨会话/过期后重跑 `get_token.sh cnb`。
- `git push` 会卡在等密码提示（无 TTY）→ 用 `GIT_TERMINAL_PROMPT=0` 或在 remote URL 已带 token 时直接推。
- 安全红线：禁止把 token 值打印到 stdout、禁止明文写进任何命令/文件。
