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
     User profile                    : http://127.0.0.1:<port>/profile?token=<your-token>
     Admin console                   : http://127.0.0.1:<port>/admin
     Health check                    : http://127.0.0.1:<port>/health
   ==========================================================
   ```

4. **把上面这段 URL 逐字转述给用户**，并说明：门户可一键注册拿令牌；
   把令牌拼到 `/profile?token=...` 可查看个人资料与调用统计；
   Admin 管理端用 `ADMIN_TOKEN` 登录（本地开发可用默认令牌 `dev-admin-change-me`）。

## 约定（重要）

- **`.env` 由入口 `src/index.ts` 顶部的 `import 'dotenv/config'` 加载**，它必须是第一条 import。
  `src/config.ts` 在模块顶层就把 env 快照成常量，重排 import 会让 `.env` 静默失效。
  `.env` 不覆盖已存在的环境变量（`dotenv` 默认 `override: false`），
  故部署平台注入的 `JWT_SECRET` / `ADMIN_TOKEN` / `PUBLIC_BASE_URL` 永远优先。
  **改 env 相关代码后必须跑 `npx vitest run test/dotenv.test.ts`。**
- **`/mcp` 允许匿名握手，不要改成 401**。未携带令牌时由工具（`login` / `whoami` / `my_stats`）
  返回登录引导与登录链接。这是刻意设计：远程客户端（如钉钉）配置里不带令牌也能连上，
  再由 AI 引导用户去浏览器注册。
- **无状态下 `GET /mcp` 必须返回 405**。无状态模式（`sessionIdGenerator: undefined`）下
  GET 会建立常驻 SSE 流并起 keep-alive 定时器，爬虫/健康检查反复请求会累积悬挂连接。
- **不要用 `Authorization` 头在本服务内传令牌**。部署平台网关会拦截并改写它
  （注入平台自己的 JWT）。只认 `X-Authorization` 头 / `?token=` 查询参数，
  且值必须带本服务前缀 `mcp_demo_`。
- **GitHub OAuth 参数一律通过 `getGithub()`（src/settings.ts）读取**，
  **禁止**直接读 `config.githubSeed`（那是启动时快照，读不到 admin 后台的运行时改动）。
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
