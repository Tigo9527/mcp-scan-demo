/**
 * MCP 服务端：基于官方 @modelcontextprotocol/sdk 的 McpServer，
 * 通过 Streamable HTTP 暴露工具。工具处理函数在执行时可通过
 * getCurrentUser() 拿到当前登录用户（由 web 层经 authContext 注入）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getCurrentUser, getRequestBaseUrl } from '../auth/context.js';
import * as auth from '../auth/manager.js';
import { isGitHubConfigured } from '../auth/github.js';
import { getUserStats } from '../stats.js';

const text = (obj: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
});

/** 工具清单。server_info 直接引用它，避免工具列表与实际注册的不一致。 */
const TOOL_NAMES = [
  'server_info',
  'login',
  'whoami',
  'register_user',
  'my_stats',
  'search_repos',
];

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-demo',
    version: '1.0.0',
  });

  server.tool(
    'server_info',
    '返回 MCP 服务元信息（名称、版本、鉴权要求、登录入口、端点）。',
    {},
    async () => {
      const base = getRequestBaseUrl();
      return text({
        name: 'mcp-demo',
        version: '1.0.0',
        transport: 'Streamable HTTP',
        auth: 'Bearer token (account/password or GitHub OAuth)',
        requiresAuth: true,
        loginUrl: `${base}/login`,
        registerUrl: `${base}/register`,
        githubAuthUrl: `${base}/auth/github`,
        note: '未携带有效令牌时，调用 login 工具即可获取登录入口；或在浏览器打开 loginUrl 完成注册后，将令牌配置到客户端请求头 X-Authorization: Bearer <token>（或 MCP 端点 URL 后追加 ?token=<token>）。',
        mcpEndpoint: `${base}/mcp`,
        profileUrl: `${base}/profile`,
        githubConfigured: isGitHubConfigured(),
        tools: TOOL_NAMES,
      });
    },
  );

  server.tool(
    'login',
    '获取登录入口。未携带有效令牌时调用本工具，会返回一键注册页与 GitHub OAuth 登录链接，供用户在浏览器完成登录并获取令牌。',
    {},
    async () => {
      const base = getRequestBaseUrl();
      return text({
        message:
          '本服务需要登录后才能使用受保护工具（whoami / my_stats / search_repos 等）。请在浏览器打开下方链接完成登录：',
        loginUrl: `${base}/login`,
        registerUrl: `${base}/register`,
        githubAuthUrl: `${base}/auth/github`,
        profileUrl: `${base}/profile`,
        howToUseToken:
          '登录（账号密码或 GitHub）后会得到一个 mcp_demo_ 开头的令牌。把它配置到 MCP 客户端：请求头 X-Authorization: Bearer <token>，或在 MCP 端点 URL 后追加 ?token=<token>；把令牌拼到 profileUrl 后可查看个人资料与调用统计。',
      });
    },
  );

  server.tool(
    'whoami',
    '返回当前 Bearer 令牌对应的登录用户信息。未携带令牌时返回登录引导。',
    {},
    async () => {
      const user = getCurrentUser();
      if (!user) {
        const base = getRequestBaseUrl();
        return {
          isError: true,
          ...text({
            error: '未登录：当前请求未携带有效令牌。',
            action:
              '调用 login 工具获取登录入口，或在浏览器打开下方链接完成注册，再把返回的令牌配置到客户端。',
            registerUrl: `${base}/register`,
            githubAuthUrl: `${base}/auth/github`,
          }),
        };
      }
      return text({
        id: user.id,
        username: user.username,
        email: user.email,
        provider: user.provider,
        githubLogin: user.githubLogin ?? null,
        createdAt: user.createdAt,
      });
    },
  );

  server.tool(
    'register_user',
    '一键注册一个新用户并直接返回访问令牌（演示「一键注册」能力）。此工具无需先登录即可调用。',
    {
      username: z.string().optional().describe('可选用户名，缺省自动生成'),
      email: z.string().optional().describe('可选邮箱，缺省自动生成'),
    },
    async ({ username, email }) => {
      const base = getRequestBaseUrl();
      const result = auth.registerOneClick({ username, email });
      return text({
        message: '注册成功，使用下方 token 配置到 MCP 客户端即可调用受保护工具。',
        token: result.token,
        user: {
          id: result.user.id,
          username: result.user.username,
          email: result.user.email,
          provider: result.user.provider,
        },
        mcpEndpoint: `${base}/mcp`,
        howToUseToken:
          '把 token 放到请求头 X-Authorization: Bearer <token>，或 MCP 端点 URL 后追加 ?token=<token>。',
      });
    },
  );

  server.tool(
    'my_stats',
    '查看当前登录用户自己的 MCP 调用统计（工具调用次数、按工具分布、最近 7 天趋势、profile 页面链接）。需要登录后调用。',
    {},
    async () => {
      const user = getCurrentUser();
      if (!user) {
        const base = getRequestBaseUrl();
        return {
          isError: true,
          ...text({
            error: '未登录：当前请求未携带有效令牌，无法查看个人统计。',
            action: '调用 login 工具获取登录入口，或调用 register_user 一键注册。',
            registerUrl: `${base}/register`,
            githubAuthUrl: `${base}/auth/github`,
          }),
        };
      }

      const base = getRequestBaseUrl();
      const stat = getUserStats(user.id);
      const last7 = (stat?.days ?? {}) as Record<string, number>;
      const recent7Days = Object.keys(last7)
        .sort()
        .slice(-7)
        .map((d) => ({ date: d, calls: last7[d] }));

      return text({
        user: { id: user.id, username: user.username, provider: user.provider },
        toolCalls: stat?.tools
          ? Object.values(stat.tools).reduce((a, b) => a + b, 0)
          : 0,
        requests: stat?.calls ?? 0,
        byTool: stat?.tools ?? {},
        last7Days: recent7Days,
        firstSeenAt: stat?.firstSeenAt ?? null,
        lastSeenAt: stat?.lastSeenAt ?? null,
        profileUrl: `${base}/profile`,
        note: '统计为本实例视角（平台多副本部署，数据不跨副本共享）。',
      });
    },
  );

  server.tool(
    'search_repos',
    '使用当前用户的 GitHub 令牌搜索公开仓库（演示 OAuth 能力，需先经 /auth/github 登录）。',
    {
      query: z.string().describe('GitHub 搜索关键词'),
      limit: z.number().int().min(1).max(30).optional().describe('返回条数，默认 5'),
    },
    async ({ query, limit = 5 }) => {
      const user = getCurrentUser();
      if (!user?.githubToken) {
        const base = getRequestBaseUrl();
        return text({
          hint: '尚未通过 GitHub 登录，无法调用 GitHub API。',
          action: `请在浏览器访问 ${base}/auth/github 完成 OAuth 登录，登录后把返回的令牌配置到客户端，再调用本工具。`,
          loginUrl: `${base}/auth/github`,
        });
      }
      const data = (await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`,
        {
          headers: {
            Authorization: `Bearer ${user.githubToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'mcp-demo',
          },
        },
      ).then(async (r) => {
        if (!r.ok) throw new Error(`GitHub search API ${r.status}`);
        return r.json();
      })) as {
        items?: Array<{ full_name: string; html_url: string; stargazers_count: number; description: string | null }>;
      };

      return text({
        query,
        count: data.items?.length ?? 0,
        repos: (data.items ?? []).map((r) => ({
          name: r.full_name,
          url: r.html_url,
          stars: r.stargazers_count,
          description: r.description,
        })),
      });
    },
  );

  return server;
}
