# MCP Demo 服务（TypeScript）

一个**开箱即跑**的 MCP（Model Context Protocol）服务端示例：

- 使用官方 **`@modelcontextprotocol/sdk`**，基于 **Streamable HTTP** 传输（不自己造轮子）
- 内置**认证管理模块**：JWT 签发/校验、Bearer 鉴权、**账号密码注册 / 登录**、一键注册
- 实现 **MCP 标准授权发现（OAuth 2.1 Discovery）**：RFC 9728 受保护资源元数据 +
  RFC 8414 授权服务器元数据 + RFC 7591 动态客户端注册 + RFC 7636 PKCE + RFC 8707 `resource`，
  Codex / Claude Desktop / MCP Inspector 等客户端可**自行发现并完成登录**
- 接入 **GitHub OAuth 2.0**（用 `simple-oauth2`，可在 Admin 管理端**在线配置**，既可注册也可登录）
- **Admin 管理端**（带页面）：用户列表/详情、GitHub 参数设置、签发令牌、调用统计总览
- **用户 Profile 页面**：查看自己的资料与**个人维度**调用统计
- **MCP 调用统计**：按用户维度 + 总计（请求数 / 工具调用 / 按天 / 最近调用）
- 用 **Codex** 跑集成测试，测试会把**可访问 URL** 打印出来供用户打开

## 目录结构

```
src/
  config.ts           运行时配置（端口 / JWT 密钥 / 实例 ID / admin 令牌）
  db.ts               存储层（Sequelize ORM：自动建表 + 防抖写库 + 旧 JSON 自动导入；
                      默认 SQLite，可切 MySQL——见下方「存储后端」）
  settings.ts         GitHub OAuth 运行时可变设置（落盘）
  stats.ts            MCP 调用统计（计数器 + 环形缓冲 + 落盘）
  auth/
    store.ts          用户存储（内存 + 落盘 + 按需落库 + 列表/详情）
    context.ts        请求级鉴权上下文（AsyncLocalStorage）
    manager.ts        注册 / 签发 / 校验 JWT / 请求鉴权
    github.ts         GitHub OAuth 2.0 接入（凭据每次现读，state 为自签名 JWT）
  mcp/
    server.ts         MCP 服务端：server_info / login / whoami / register_user / my_stats / search_repos
  oauth/
    metadata.ts       RFC 9728 / RFC 8414 元数据文档 + 401 头取值（改前先读文件头注释）
    tickets.ts        自包含加密票据（HKDF 派生密钥 + AES-256-GCM + AAD 绑定用途）
    clients.ts        RFC 7591 动态客户端注册（client_id 即票据，回环地址忽略端口）
    register.ts       POST /oauth/register —— DCR 端点
    authorize.ts      GET/POST /oauth/authorize —— 登录页与授权码签发
    token.ts          POST /oauth/token —— authorization_code（PKCE S256）/ refresh_token
  web/
    app.ts            Express 入口：门户 / 注册 / GitHub OAuth / /mcp / 挂载 admin 与 profile
    http.ts           请求工具：基础地址推导、令牌提取、async 包装、Cookie 读取
    layout.ts         共享页面布局 + HTML 转义 esc()
    admin.ts          Admin 管理端（路由 + 页面）
    profile.ts        用户 Profile 页面
  index.ts            启动入口（顶部加载 .env）+ 连库预热 + 打印访问 URL 横幅 + 退出前刷库
test/
  integration.test.ts 集成测试：健康检查 / 注册 / 握手 / 登录引导 / 405 / XSS / my_stats
  admin.test.ts       Admin：登录鉴权 / 用户管理 / GitHub 设置 / 统计接口
  stats.test.ts       调用统计增量断言 / 按需落库 / Profile 页面
  admin-token-guard.test.ts  公网默认令牌防护（503）
  setup-page.test.ts  免登录接入页 /setup：无令牌泄露、配置可复制、MCP 工具返回 setupUrl
  dotenv.test.ts      .env 自动加载（入口 import 顺序 + 平台 env 优先于 .env）
codex.json / AGENTS.md  Codex 配置与代理指示
```

## 配置（环境变量 / `.env`）

服务启动时会自动读取项目根目录的 `.env`（`dotenv` 在入口 `src/index.ts` 顶部加载）：

```bash
cp .env.example .env   # 按需修改；.env 已在 .gitignore 中，不会被提交
npm start              # 无需再手动 export / 写前缀
```

两条必须记住的语义：

1. **`.env` 不覆盖已存在的环境变量**（`dotenv` 默认 `override: false`）。
   所以部署平台注入的 `JWT_SECRET` / `ADMIN_TOKEN` / `PUBLIC_BASE_URL` **永远优先**于仓库里的 `.env`，
   线上配置不会因为仓库里多了个 `.env` 而被悄悄改掉。本地想临时压过 `.env`，照旧用前缀即可：
   `PORT=4001 npm start`。
2. **`.env` 只影响本地开发**。公网部署用的是平台注入的环境变量，跟文件无关。

> 实现上 `src/config.ts` 在模块顶层就把 env 快照成常量，因此 `import 'dotenv/config'`
> 必须是 `src/index.ts` 的**第一条** import——重排会让 `.env` 静默失效。`test/dotenv.test.ts` 锁住了这个顺序。

## 快速开始

```bash
npm install
npm start            # 启动后控制台会打印可访问 URL，含 /admin 与 /profile
```

打开门户地址（默认 http://localhost:3000/）：

### 接入 MCP 客户端（免登录，可直接转发）

新用户不需要先注册就能连接：支持标准 OAuth Discovery 的客户端会在第一次请求时被
**自动引导登录**，无需任何手工配置。

所以准备了一个**免登录、不含任何令牌**的接入页：<https://你的域名/setup>

- 页面直接给出可一键复制的 `mcpServers` 配置（URL 里没有 token）
- 三步引导：复制配置 → 客户端自动弹登录页 → 不支持的客户端手工填令牌
- 附 `curl` 冒烟命令与常见坑（405 是正常的、别用 `Authorization` 头、401 是登录入口不是故障）
- 首页 `/` 的「MCP 客户端配置」卡片里也放了一份同样的配置块

> 这个链接可以放心发给任何人——页面里没有任何令牌。测试 `test/setup-page.test.ts`
> 专门断言了页面与首页**不出现** `mcp_demo_` 开头的真实令牌。

### 用户侧：注册与登录（三种方式）

| 方式 | 入口 | 说明 |
| --- | --- | --- |
| **账号密码注册** | `GET /register` → 填写表单 `POST /register` | 用户名（3~32 位，仅字母/数字/`_`/`-`）+ 密码（≥8 位）；口令以 scrypt 哈希存储，绝不回显、绝不进 JWT |
| **账号密码登录** | `GET /login` → 填写表单 `POST /login` | 成功后直接返回 Bearer 令牌 |
| **GitHub 注册 / 登录** | `/auth/github` | 首次即注册，之后每次登录复用同一账号（`search_repos` 等需 GitHub 权限的工具可用） |
| 一键注册（Agent 用） | `/register?username=alice` 或 MCP `register_user` 工具 | 直接发令牌、**无密码**，供钉钉等 AI Agent 自动注册 |

> 网页注册/登录均为 `POST` 表单，配合 `SameSite=Lax` Cookie + Origin 校验防 CSRF；口令只经表单提交，绝不以 URL / `GET` / `Authorization` 传递。

> **登录态自动保持**：注册 / 登录（账号密码、GitHub、钱包）成功后会下发会话 Cookie
> `mcp_demo_user`（HttpOnly + SameSite=Lax + 7 天），之后直接访问 `/profile`、`/recharge`
> 就是登录态，不必再往 URL 上拼 `?token=`（令牌也不该进浏览器历史）。
> `/mcp` 端点**刻意不读**这份 Cookie —— 否则第三方页面能带着浏览器登录态调受保护工具（CSRF），
> MCP 客户端必须显式带令牌。退出登录走 `/logout`。
>
> 注意：部署平台网关会把响应里的 `SameSite=Lax` 改写成 `SameSite=None`（跨站也会带 Cookie），
> 所以 CSRF 防护不靠 SameSite，而是靠「`/mcp` 不读 Cookie」+「所有写路由校验 Origin」两道。

1. 在 `/register`（或 `/auth/github`）完成注册 → 拿到 Bearer 令牌（浏览器已自动登录，页面上有「查看我的 Profile →」入口）
2. 把令牌拼到端点 URL 后，或放到请求头 `X-Authorization`：

```json
{
  "mcpServers": {
    "mcp-demo": {
      "url": "http://localhost:3000/mcp?token=<你的令牌>",
      "transport": "streamable-http"
    }
  }
}
```

### Admin 管理端

- 登录地址 `/admin`，令牌来自环境变量 `ADMIN_TOKEN`（本地不设置时用默认 `dev-admin-change-me`）。
- 功能：用户列表（搜索 / 详情 / 签发新令牌 / 删除）、GitHub OAuth 参数在线设置、
  调用统计总览（总计卡片 + 工具 Top + 调用方 Top + 最近 14 天 + 最近调用）。

### 用户 Profile

- 登录后访问 `/profile` 查看自己的资料、按工具/按天的个人统计，并复制 MCP 客户端配置（登录态由会话 Cookie 保持，无需拼 `?token=`）。
- 充值页会在转账框下方显示该钱包在收款资产上的可用余额（ERC20 走 `balanceOf`，原生币走
  `eth_getBalance`，都用服务端配置的 RPC 读）。余额不足会被拦下；**读不到则只提示、不阻拦**——
  RPC 抖一下不该让用户充不了值。
- 充值页在钱包转账前会比对 `eth_chainId`：不在收款链上就自动唤起切换网络，
  钱包里没这条链时请求添加（RPC 用充值设置里配的地址）。链 ID 由保存配置时从 RPC 自动识别，
  手填与 RPC 不一致时以 RPC 为准——填错链等于让用户把钱转到另一条链上。

### 调用统计

- 总计与用户维度在 Admin 仪表盘查看；个人维度可在 MCP 客户端调用 `my_stats` 工具，或在 `/profile` 页查看。

### GitHub OAuth（可选，可在线配置）

1. 在 https://github.com/settings/developers 新建 OAuth App，回调填 `<base>/auth/github/callback`
2. 二选一配置凭据：
   - 在 `.env`（或环境变量）填 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（启动时读入）
   - 或登录 **Admin 管理端 → GitHub 设置**在线填写（**立即生效，无需重启**）
3. 访问 `/auth/github` 完成登录，登录后返回的令牌即可调用 `search_repos`

## 标准 OAuth 2.1 授权发现（Authorization Discovery）

不带令牌请求 `/mcp` 会拿到 **401 + `WWW-Authenticate`**，客户端据此自行完成整条登录流程：

```
客户端 ──POST /mcp──▶ 401 WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"
        ──GET  该地址──▶ { resource, authorization_servers: ["https://host"] }        (RFC 9728)
        ──GET  /.well-known/oauth-authorization-server──▶ { authorization_endpoint, token_endpoint,
                                                            registration_endpoint, … }  (RFC 8414)
        ──POST /oauth/register──▶ { client_id }                                        (RFC 7591 DCR)
        ──浏览器导航 /oauth/authorize?code_challenge=…&resource=…──▶ 登录页            (RFC 7636 PKCE)
        ──POST /oauth/token（code + code_verifier + resource）──▶ access_token         (RFC 8707)
        ──POST /mcp（Authorization: Bearer …）──▶ 200
```

| 端点 | 说明 |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp` | 受保护资源元数据（canonical 路径版本，主用） |
| `GET /.well-known/oauth-protected-resource` | 同上，给把 canonical 当成纯 origin 的客户端兜底 |
| `GET /.well-known/oauth-authorization-server` | 授权服务器元数据；`/.well-known/openid-configuration` 是同内容别名 |
| `POST /oauth/register` | 动态客户端注册，免鉴权，只发公开客户端（`token_endpoint_auth_method: none`） |
| `GET/POST /oauth/authorize` | 登录页 + 授权码签发（授权码 60 秒有效） |
| `POST /oauth/token` | `authorization_code`（强制 PKCE S256）与 `refresh_token` 两种 grant |

几条实现上的取舍，改代码前值得知道：

1. **元数据地址必须带 `/mcp` 后缀**。canonical URI 是 `https://host/mcp`，按 RFC 9728 §3.1
   well-known 要插在 host 与 path 之间；只挂根路径会让客户端 404 后放弃发现。
2. **401 头里只给 `resource_metadata`**，授权服务器地址由客户端从 PRM 派生。
3. **AS 元数据里刻意不声明 `client_id_metadata_document_supported`** —— 官方 SDK 一见到它
   就走 CIMD，绕过我们的 DCR 端点。
4. **受众（`aud`）不符返回 403 而不是 401**。官方 SDK 有熔断：鉴权流程完成后再收到 401 会
   直接抛错而不是重跑流程，401 会把「受众不符」伪装成「还没登录」，表现为死循环。
5. **所有 OAuth 状态都是自包含加密票据**（`src/oauth/tickets.ts`），不落盘。
   `persist.ts` 无锁无 CAS（并发写会互相覆盖）、`settings.json` 每个进程只读一次，
   所以必须用「签名的、自带内容的」票据。代价见「已知限制」。

想关掉强制登录（恢复旧的匿名握手，例如给钉钉这类不带 OAuth 的客户端用）：

```bash
MCP_DEMO_REQUIRE_AUTH=off npm start   # 默认 on
```

验证是否真的对第三方客户端可用（用官方 SDK 的 `auth()` 跑完整流程，不需要人工点浏览器）：

```bash
npm run oauth:e2e
```

> ⚠️ **公网部署必须显式注入 `PUBLIC_BASE_URL`**。上面所有地址（canonical resource、
> 元数据 URL、令牌的 `aud`）都由它推导。部署平台网关只转发**内部** host，
> 缺了这个变量会推导出内网地址 —— 表现为客户端发现到的资源是内网域名、令牌 `aud` 对不上而被 403。

## 部署到公网（钉钉等远程客户端测试）

本项目已发布为在线应用，公网地址：

```
https://a8b79d8a477856f1e.app.workbuddy.link
```

> 部署适配：平台网关会改写 `Authorization` 头。本服务已做：
> 1. **鉴权无状态化**：JWT 内嵌用户声明，校验不依赖服务端内存存储，重启后依然有效。
> 2. **MCP 传输无状态化**：每次请求新建独立 transport（关闭会话管理），不依赖进程内会话。
> 3. **鉴权通道避开 `Authorization`**：服务端只认 `X-Authorization` 头或 `?token=` 参数
>    （必须带本服务前缀 `mcp_demo_`），网关注入的 `Authorization` 一律忽略。
> 4. **支持匿名握手 + 登录引导**：未携带令牌时不会拒绝连接，而是暴露 `login` 工具、
>    受保护工具返回中文登录引导（含可点击的登录 URL）。
> 5. **存储后端可切换**：默认所有数据集落在 `data/mcp-demo.sqlite`（users / billing / recharge_records /
>    recharge_settings / github_settings / stats 六张表），启动自动建表、旧 JSON 自动导入。
>    也可切换为 MySQL（见下方「存储后端」）。存储不存在按进程 / 实例拆分——见下方单实例说明。

### 存储后端（SQLite / MySQL）

存储层由 `src/db.ts` 实现，通过 `STORAGE_DRIVER` 选择方言（默认 `sqlite`）：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `STORAGE_DRIVER` | `sqlite`（默认）或 `mysql` | `sqlite` |
| `MYSQL_URL` | MySQL 连接串（完整 `mysql://user:pass@host:port/db`），优先于下方各项 | 空 |
| `MYSQL_HOST` / `MYSQL_PORT` | 分项连接参数 | `127.0.0.1` / `3306` |
| `MYSQL_USER` / `MYSQL_PASSWORD` | 账号 / 口令（口令原样传入，不做 trim） | `root` / 空 |
| `MYSQL_DATABASE` | 数据库名 | `mcp_demo` |

`/health` 与 Admin 控制台会回显当前 `db` 方言与连接描述（不含口令）。

**重要限制（务必先读）：**

- **单实例持久化**：MySQL 后端沿用「内存态为唯一权威 + 写库为整表替换（事务保护）」的模型，
  与 SQLite 一致。**多副本 / 多进程共用同一 MySQL 库会导致跨实例数据覆盖**——整表替换会清掉其它实例
  刚写入的行、再写入本进程的内存快照。因此 MySQL 仅适合**单实例**部署，请勿多副本共享同一数据库。
- **SQLite→MySQL 不自动迁移**：若 `DATA_DIR` 下已存在 `mcp-demo.sqlite`（说明之前跑在 SQLite 上、旧 JSON 已迁走），
  直接设 `STORAGE_DRIVER=mysql` 会启动失败（fail-fast），避免静默以空库启动丢失数据。请先手动把 SQLite 数据迁到
  MySQL，或确认不再需要旧数据后删除该 `.sqlite` 文件再启动。MySQL   启动时会把 `DATA_DIR` 下尚未导入的旧 JSON 按表为空才导入：
  - 真正导入过的数据集，其文件移入 `DATA_DIR/_migrated_json/`；
  - 表非空而被跳过的文件（可能含额外用户/配置），移入 `DATA_DIR/_migrated_json/_skipped_for_review/`
    （待人工处理，**不会留在 `DATA_DIR`**），并写 `_migrated_json/_status.json` 记录每个数据集的
    `imported` / `skipped` 标记，后续启动会忽略已处理的数据集，避免清空某表后重启又重放陈旧数据。
- 已有 MySQL 表（早期 `TEXT` 列）如需更大的统计容量，请将 stats 相关列改为 `LONGTEXT`（`DataTypes.TEXT('long')`）。

### 钉钉 MCP 配置（不含 token，靠登录引导）

配置见 `mcp-config-dingtalk.json`，**只有干净的端点 URL，不含任何令牌**：

```json
{
  "mcpServers": {
    "mcp-demo": {
      "url": "https://a8b79d8a477856f1e.app.workbuddy.link/mcp",
      "transport": "streamable-http"
    }
  }
}
```

接入后在钉钉里**无需任何令牌即可连接**，服务以「匿名」身份握手并提供 `login` 工具。
完成登录的流程如下：

1. 在钉钉对话里问「怎么登录 / 你是谁」，AI 会调用 `login` 或 `whoami` 工具，
   返回**一键注册链接**（`…/register`）和 GitHub 登录链接（`/auth/github`）。
2. 用户**在浏览器**打开注册链接 → 一键拿到令牌（形如 `mcp_demo_xxx`）。
3. 把令牌填回钉钉的 MCP 配置「鉴权 / 自定义请求头」：
   - 推荐用 **`X-Authorization: Bearer <token>`**（不要用 `Authorization`，会被平台网关改写吞掉）；
   - 或在端点 URL 后追加 `?token=<token>`。
4. 之后钉钉即可调用 `whoami` / `search_repos` / `my_stats` 等受保护工具。

要点：
- 令牌有效期 7 天；无状态 JWT，重新部署后旧令牌仍有效。
- 若钉钉只提供「SSE」类型选项，选它即可（底层仍 POST 到该 URL）。
- 部署时用 `--start-cmd "PUBLIC_BASE_URL=... ADMIN_TOKEN=... npm start"` 注入对外域名与 admin 令牌；
  不注入 `ADMIN_TOKEN` 时，公网地址会被判定为非本地环境，Admin 管理端返回 503 禁用。

## 测试

本仓库已配好 Codex：

```bash
npm install -g @openai/codex     # 安装 Codex CLI（需配置 CODEX_API_KEY）
npm run test:codex               # 等价于 codex exec "...运行 npm test 并回报 URL..."
```

或直接本地运行（无需 Codex）：

```bash
npm test
```

测试会启动服务，把可访问 URL 打印到 stdout，并断言：健康检查可用、一键注册返回令牌、
带令牌能调用 `whoami`、Admin 鉴权与用户管理、GitHub 设置即时生效、
调用统计计数正确（通知类不计入、工具调用单列）、Profile 页面转义安全等。

与授权相关的三份测试单独说：

| 文件 | 覆盖 |
| --- | --- |
| `test/oauth.test.ts` | 发现契约：元数据地址（含 `/mcp` 后缀）、AS 必填字段、不声明 CIMD、401 头可被 SDK 正则解析、CORS |
| `test/oauth-flow.test.ts` | 扮演真实客户端跑完 DCR → 授权 → 换令牌 → 调 MCP → 刷新，重点覆盖失败路径（重放 / PKCE 错误 / 篡改 / 过期 / 受众不符） |
| `scripts/oauth-e2e.ts`（`npm run oauth:e2e`） | 用**官方 SDK 的 `auth()`** 真实走一遍完整流程并调通工具 —— 唯一能证明第三方客户端真能自己登录的验证 |

## 暴露的 MCP 工具

| 工具 | 说明 | 是否需要鉴权 |
| --- | --- | --- |
| `server_info` | 返回服务元信息 + 登录入口 | 否（匿名可用） |
| `login` | 返回一键注册页与 GitHub OAuth 登录链接（引导登录） | 否（匿名可用） |
| `whoami` | 返回当前登录用户；未登录时返回登录引导 | 建议（匿名返回引导） |
| `register_user` | 一键注册新用户并返回令牌 | 否（匿名可用） |
| `my_stats` | 查看当前用户自己的调用统计（工具/按天） | 是（需登录） |
| `search_repos` | 用当前用户 GitHub 令牌搜索仓库（演示 OAuth） | 是 + 需 GitHub 登录 |
| `list_cfx_transfers` | 列出某 Conflux Core 账户的原生 CFX 转账记录（ConfluxScan Open API） | 是（需登录） |
| `list_latest_transactions` | 列出 Conflux Core 最新交易（ConfluxScan 浏览器 API） | 是（需登录） |
| `whole_chain_cfx_transfer_list` | 列出全网（指定 transferType 的）最新转账记录（ConfluxScan v1/transfer，默认测试网） | 是（需登录） |

> `/mcp` **默认要求登录**（`MCP_DEMO_REQUIRE_AUTH` 默认 `on`）：未携带有效令牌返回 401 +
> `WWW-Authenticate`，由客户端走标准 OAuth 流程。设成 `off` 后恢复匿名握手，
> 此时上表「匿名可用」的工具会照旧返回登录引导。

## 安全说明

- 所有页面输出经过 **HTML 转义**，用户名等用户输入不会造成 XSS。
- Admin 鉴权两通道（`Cookie` `mcp_admin` / `X-Admin-Token` 请求头），令牌比较用 `timingSafeEqual`；
  UI 任何链接都**不**把令牌拼进 URL（避免泄漏到地址栏 / 历史 / 截图 / Referer / 平台日志），
  登录态靠 `mcp_admin` Cookie 保持。所有副作用操作均为 POST，并有登录失败限流与
  `SameSite=Lax` + Origin 校验防 CSRF。
- 公网环境下使用默认 admin 令牌会被直接禁用（503），强制要求注入真实 `ADMIN_TOKEN`。
- 部署平台网关会改写 `Authorization` 头，因此本服务**永不**信任传入的 `Authorization` 头传令牌。

## 已知限制

- **部署平台网关会剥离 `Authorization` 头**（实测：带不带 Cookie 都一样，只认
  `X-Authorization` / `?token=` / `?access_token=`，且值需带 `mcp_demo_` 前缀），
  而官方 SDK 只会用 `Authorization` 头带令牌。结论：**Discovery 与登录流程在本平台公网能跑通，
  最后一跳（带令牌调 `/mcp`）会被网关吞掉**；本地直连 / 自托管无此限制。
- **动态注册的客户端无法单独吊销**：`client_id` 是自包含票据、不落盘，换 `JWT_SECRET`
  才能让全部已注册客户端失效。
- **授权码重放只在单进程内被拦截**：「已用授权码」表是进程内 `Map`；防线退化为
  「60 秒有效期 + PKCE」——攻击者必须同时截获授权码与 `code_verifier`。
- **refresh_token 不轮换**：同理，无状态方案检测不到旧令牌是否被重放，轮换不会更安全。
- **磁盘**：平台磁盘可能不持久化，重启/重新部署后数据可能丢失（退出前会尽量 flush）。
- `?token=`（user 端访问令牌）会进入浏览器历史与平台访问日志，已用 `Referrer-Policy: no-referrer`
  缓解；登录后该令牌会被落到 `mcp_demo_user` Cookie，后续免挂参数。admin 端已改用 `mcp_admin`
  Cookie，URL 中不再出现令牌。
