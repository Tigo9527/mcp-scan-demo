# MCP Demo 服务（TypeScript）

一个**开箱即跑**的 MCP（Model Context Protocol）服务端示例：

- 使用官方 **`@modelcontextprotocol/sdk`**，基于 **Streamable HTTP** 传输（不自己造轮子）
- 内置**认证管理模块**：JWT 签发/校验、Bearer 鉴权、**账号密码注册 / 登录**、一键注册
- 接入 **GitHub OAuth 2.0**（用 `simple-oauth2`，可在 Admin 管理端**在线配置**，既可注册也可登录）
- **Admin 管理端**（带页面）：用户列表/详情、GitHub 参数设置、签发令牌、调用统计总览
- **用户 Profile 页面**：查看自己的资料与**个人维度**调用统计
- **MCP 调用统计**：按用户维度 + 总计（请求数 / 工具调用 / 按天 / 最近调用）
- 用 **Codex** 跑集成测试，测试会把**可访问 URL** 打印出来供用户打开

## 目录结构

```
src/
  config.ts           运行时配置（端口 / JWT 密钥 / 实例 ID / admin 令牌）
  persist.ts          极简 JSON 落盘（原子写 + 防抖 + 按实例分片 + 读降级）
  settings.ts         GitHub OAuth 运行时可变设置（落盘）
  stats.ts            MCP 调用统计（计数器 + 环形缓冲 + 落盘）
  auth/
    store.ts          用户存储（内存 + 落盘 + 跨副本物化 + 列表/详情）
    context.ts        请求级鉴权上下文（AsyncLocalStorage）
    manager.ts        注册 / 签发 / 校验 JWT / 请求鉴权
    github.ts         GitHub OAuth 2.0 接入（凭据每次现读，state 为自签名 JWT）
  mcp/
    server.ts         MCP 服务端：server_info / login / whoami / register_user / my_stats / search_repos
  web/
    app.ts            Express 入口：门户 / 注册 / GitHub OAuth / /mcp / 挂载 admin 与 profile
    http.ts           请求工具：基础地址推导、令牌提取、async 包装、Cookie 读取
    layout.ts         共享页面布局 + HTML 转义 esc()
    admin.ts          Admin 管理端（路由 + 页面）
    profile.ts        用户 Profile 页面
  index.ts            启动入口（顶部加载 .env）+ 打印访问 URL 横幅 + 退出前落盘
test/
  integration.test.ts 集成测试：健康检查 / 注册 / 握手 / 登录引导 / 405 / XSS / my_stats
  admin.test.ts       Admin：登录鉴权 / 用户管理 / GitHub 设置 / 统计接口
  stats.test.ts       调用统计增量断言 / 跨副本物化 / Profile 页面
  admin-token-guard.test.ts  公网默认令牌防护（503）
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

### 用户侧：注册与登录（三种方式）

| 方式 | 入口 | 说明 |
| --- | --- | --- |
| **账号密码注册** | `GET /register` → 填写表单 `POST /register` | 用户名（3~32 位，仅字母/数字/`_`/`-`）+ 密码（≥8 位）；口令以 scrypt 哈希存储，绝不回显、绝不进 JWT |
| **账号密码登录** | `GET /login` → 填写表单 `POST /login` | 成功后直接返回 Bearer 令牌 |
| **GitHub 注册 / 登录** | `/auth/github` | 首次即注册，之后每次登录复用同一账号（`search_repos` 等需 GitHub 权限的工具可用） |
| 一键注册（Agent 用） | `/register?username=alice` 或 MCP `register_user` 工具 | 直接发令牌、**无密码**，供钉钉等 AI Agent 自动注册 |

> 网页注册/登录均为 `POST` 表单，配合 `SameSite=Lax` Cookie + Origin 校验防 CSRF；口令只经表单提交，绝不以 URL / `GET` / `Authorization` 传递。

1. 在 `/register`（或 `/auth/github`）完成注册 → 拿到 Bearer 令牌（页面上有「查看我的 Profile →」入口）
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

- 访问 `/profile?token=<你的令牌>` 查看自己的资料、按工具/按天的个人统计，并复制 MCP 客户端配置。

### 调用统计

- 总计与用户维度在 Admin 仪表盘查看；个人维度可在 MCP 客户端调用 `my_stats` 工具，或在 `/profile` 页查看。

### GitHub OAuth（可选，可在线配置）

1. 在 https://github.com/settings/developers 新建 OAuth App，回调填 `<base>/auth/github/callback`
2. 二选一配置凭据：
   - 在 `.env`（或环境变量）填 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（启动时读入）
   - 或登录 **Admin 管理端 → GitHub 设置**在线填写（**立即生效，无需重启**）
3. 访问 `/auth/github` 完成登录，登录后返回的令牌即可调用 `search_repos`

## 部署到公网（钉钉等远程客户端测试）

本项目已发布为在线应用，公网地址：

```
https://a8b79d8a477856f1e.app.workbuddy.link
```

> 部署适配：发布平台是多副本 + 网关改写 `Authorization` 头。本服务已做：
> 1. **鉴权无状态化**：JWT 内嵌用户声明，校验不依赖服务端内存存储，任意副本都能处理。
> 2. **MCP 传输无状态化**：每次请求新建独立 transport（关闭会话管理），跨副本无状态。
> 3. **鉴权通道避开 `Authorization`**：服务端只认 `X-Authorization` 头或 `?token=` 参数
>    （必须带本服务前缀 `mcp_demo_`），网关注入的 `Authorization` 一律忽略。
> 4. **支持匿名握手 + 登录引导**：未携带令牌时不会拒绝连接，而是暴露 `login` 工具、
>    受保护工具返回中文登录引导（含可点击的登录 URL）。
> 5. **数据按实例落盘分片**：用户 / 统计 / 设置各副本写自己的文件，不互相覆盖。

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
带令牌能调用 `whoami`、匿名请求可成功握手且登录引导正常、Admin 鉴权与用户管理、GitHub 设置即时生效、
调用统计计数正确（通知类不计入、工具调用单列）、Profile 页面转义安全等。共 4 个测试文件、43 个用例。

## 暴露的 MCP 工具

| 工具 | 说明 | 是否需要鉴权 |
| --- | --- | --- |
| `server_info` | 返回服务元信息 + 登录入口 | 否（匿名可用） |
| `login` | 返回一键注册页与 GitHub OAuth 登录链接（引导登录） | 否（匿名可用） |
| `whoami` | 返回当前登录用户；未登录时返回登录引导 | 建议（匿名返回引导） |
| `register_user` | 一键注册新用户并返回令牌 | 否（匿名可用） |
| `my_stats` | 查看当前用户自己的调用统计（工具/按天） | 是（需登录） |
| `search_repos` | 用当前用户 GitHub 令牌搜索仓库（演示 OAuth） | 是 + 需 GitHub 登录 |

> `/mcp` 端点**允许匿名握手**。未携带令牌时仍可连接并调用 `login` / `server_info`，
> 受保护工具会返回中文登录引导（含登录 URL）而非直接拒绝，从而避免客户端满屏 401。

## 安全说明

- 所有页面输出经过 **HTML 转义**，用户名等用户输入不会造成 XSS。
- Admin 鉴权三通道（`Cookie` / `?admin_token=` / `X-Admin-Token`），令牌比较用 `timingSafeEqual`；
  所有副作用操作均为 POST，并有登录失败限流与 `SameSite=Lax` + Origin 校验防 CSRF。
- 公网环境下使用默认 admin 令牌会被直接禁用（503），强制要求注入真实 `ADMIN_TOKEN`。
- 部署平台网关会改写 `Authorization` 头，因此本服务**永不**信任传入的 `Authorization` 头传令牌。

## 已知限制

- **多副本**：用户列表与调用统计为**本实例视角**（Admin 仪表盘顶部明确标注 instanceId）。
  某副本注册的用户可能落在别的副本上、本实例看不到；用户随请求物化会逐步补全。
- **磁盘**：平台磁盘可能不持久化，重启/重新部署后数据可能丢失（退出前会尽量 flush）。
- `?admin_token=` / `?token=` 会进入浏览器历史与平台访问日志，已用 `Referrer-Policy: no-referrer` 缓解。
