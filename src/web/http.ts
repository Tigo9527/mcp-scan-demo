/**
 * HTTP 层小工具：对外基础地址推导 + 用户令牌提取。
 * 抽出来是因为 app / admin / profile 三处都要用，且逻辑必须完全一致。
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import * as authManager from '../auth/manager.js';
import type { User } from '../auth/store.js';

/**
 * 从请求推导对外基础地址（协议 + 域名）。
 * 优先级：PUBLIC_BASE_URL 环境变量 > x-forwarded-host > Host 头 > config.publicBaseUrl。
 *
 * 注意：部署平台网关只转发**内部** host / x-forwarded-host，拿不到公网域名，
 * 所以公网部署必须显式注入 PUBLIC_BASE_URL，否则这里会推导出内网地址。
 */
export function deriveBase(req: Request): string {
  const fromEnv = process.env.PUBLIC_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined) ||
    (req.secure ? 'https' : 'http');
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) ||
    (req.headers.host as string | undefined);
  if (host) return `${proto}://${host}`;
  return config.publicBaseUrl;
}

/**
 * 用户会话 Cookie 名。
 *
 * 为什么要有它：早先页面只认 `?token=` / `X-Authorization`，于是「登录后自动保持」
 * 这件事不成立——用户每次进 /profile、/recharge 都得自己往 URL 后面粘令牌，
 * 既不像正经网站，令牌还会漏进浏览器历史。登录后下发 Cookie 即可解决。
 */
export const USER_TOKEN_COOKIE = 'mcp_demo_user';
/** 与访问令牌 TTL 对齐（7 天） */
const USER_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

function isHttps(req: Request): boolean {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? '';
  return req.secure || proto.split(',')[0].trim() === 'https';
}

/** 下发用户会话 Cookie（HttpOnly + SameSite=Lax；https 下补 Secure）。 */
export function setUserTokenCookie(req: Request, res: Response, token: string): void {
  if (!token) return;
  const parts = [
    `${USER_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${USER_COOKIE_MAX_AGE}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  res.appendHeader('Set-Cookie', parts.join('; '));
}

/**
 * URL 上带令牌（?token=…）时，把它落到会话 Cookie 里，让用户后续不用再挂参数。
 *
 * **只在浏览器还没有会话 Cookie 时写**：否则管理员从 Admin 点「以该用户身份打开 Profile」
 * 这类临时身份链接时，会把自己的登录态顶掉（Cookie 是单值的）。
 */
export function adoptTokenFromUrl(req: Request, res: Response, token: string): void {
  if (!token) return;
  if (readCookie(req, USER_TOKEN_COOKIE)) return;
  setUserTokenCookie(req, res, token);
}

/** 清除用户会话 Cookie（退出登录）。 */
export function clearUserTokenCookie(req: Request, res: Response): void {
  const parts = [
    `${USER_TOKEN_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttps(req)) parts.push('Secure');
  res.appendHeader('Set-Cookie', parts.join('; '));
}

/**
 * 从请求里提取本服务的用户令牌。
 *
 * 关键：部署平台网关会**拦截并改写 Authorization 头**（注入平台自己的 JWT），
 * 因此只采信带本服务前缀 `mcp_demo_` 的值，网关注入的一律忽略。
 *
 * `allowCookie` 默认关闭 —— MCP 端点绝不能开：一旦它认会话 Cookie，
 * 任意第三方页面都能带着浏览器里的登录态去调受保护工具（CSRF）。
 * MCP 客户端必须显式带令牌（X-Authorization 头或 ?token= 参数）。
 *
 * 提醒：块注释正文里别出现「星号紧跟斜杠」的组合，会把注释提前闭合（本项目踩过）。
 */
export function resolveUserToken(
  req: Request,
  opts: { allowCookie?: boolean } = {},
): string | undefined {
  const candidates: unknown[] = [
    req.headers['x-authorization'],
    (req.query as Record<string, unknown> | undefined)?.token,
    (req.query as Record<string, unknown> | undefined)?.access_token,
    req.headers.authorization,
  ];
  if (opts.allowCookie) candidates.push(readCookie(req, USER_TOKEN_COOKIE));
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes(config.jwtTokenPrefix)) return c;
  }
  return undefined;
}

/** 校验当前请求携带的用户令牌，返回用户（匿名/无效返回 null）。**不读 Cookie**（/mcp 用）。 */
export function authenticateUserRequest(req: Request): User | null {
  return authManager.authenticate(resolveUserToken(req));
}

/**
 * Web 页面（/profile、/recharge …）的用户识别：请求头 / 查询参数 / 会话 Cookie 都认。
 * 有了 Cookie，登录完就能一直保持登录，不用再往 URL 上挂令牌。
 */
export function authenticateWebUserRequest(req: Request): User | null {
  return authManager.authenticate(resolveUserToken(req, { allowCookie: true }));
}

/**
 * 包装 async 路由处理器。
 *
 * Express 4 **不会**捕获 async handler 的 rejection —— 异常逃逸出去就是
 * unhandledRejection，Node 20 默认 `--unhandled-rejections=throw`，会直接把进程干掉。
 * 所有 async 路由都必须包一层。
 */
export function wrap(
  handler: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** 极简 Cookie 读取（不引入 cookie-parser）。逐段匹配，避免 `xmcp_admin` 这类前缀误命中。 */
export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const v = part.slice(i + 1).trim().replace(/^"|"$/g, '');
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return undefined;
}

/**
 * 跨站表单防护：请求的 Origin 必须属于「本站」。
 *
 * 只比对**主机名**（忽略 scheme 与端口），并接受三个来源：
 * PUBLIC_BASE_URL 的主机、x-forwarded-host、Host 头。
 * 之前是按完整 URL 做 startsWith —— 那样只要 scheme 不同（`http://` vs `https://`）
 * 就会误判成跨站并 403，用户在公网提交表单会被自己拦住。
 *
 * **不能**只拿 req.headers.host 比：部署平台网关转发的是内部域名，
 * 单独用它会在公网环境 100% 误杀，所以必须把 publicBaseUrl 也纳入。
 * 网关可能剥离 Origin，此时放行，交给 Cookie 的 SameSite=Lax 兜底。
 */
export function originOk(req: Request): boolean {
  const origin = req.headers.origin;
  // 缺失或为 "null"（不透明来源）时放行。
  // 浏览器在沙箱 iframe、file://、data: 等场景下会发送 `Origin: null` —— 本服务通过
  // 内嵌预览面板访问时正是这种场景（面板用沙箱 iframe 承载页面），不能因此拒绝用户。
  // 真正的跨站防护由 Cookie 的 SameSite=Lax 兜底：跨站 POST 不会携带本站 Cookie。
  if (!origin || origin.toLowerCase() === 'null') return true;

  const allowed = new Set<string>();
  const addHost = (raw: string | undefined): void => {
    if (!raw) return;
    try {
      allowed.add(new URL(raw).hostname.toLowerCase());
    } catch {
      // 不是完整 URL 时按 host[:port] 处理
      allowed.add(raw.split(':')[0].trim().toLowerCase());
    }
  };

  addHost(config.publicBaseUrl);
  addHost(req.headers['x-forwarded-host'] as string | undefined);
  addHost(req.headers.host);

  try {
    if (allowed.has(new URL(origin).hostname.toLowerCase())) return true;
  } catch {
    /* 非法 Origin，交给下面的兜底判断 */
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

/** 取请求携带的 Origin（仅用于错误提示，帮助定位配置问题） */
export function requestOrigin(req: Request): string {
  const o = req.headers.origin;
  return typeof o === 'string' ? o : '(未携带)';
}

/** Express 中间件：跨站 POST/表单请求一律拒绝（配合 SameSite=Lax Cookie 防 CSRF）。 */
export function requireSameOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!originOk(req)) {
    res.status(403).type('text/plain; charset=utf-8').send('跨站请求已被拒绝（Origin 不匹配）。');
    return;
  }
  next();
}

/**
 * 公开端点的 CORS（服务发现 / 授权 / MCP）。
 *
 * 浏览器里的 MCP 客户端（Inspector、Web 版）要能读到 `WWW-Authenticate`，
 * 否则 401 触发不了发现流程；「不 expose 就等于不存在」。
 * 元数据本身是公开信息，允许任意来源读取。
 */
export function allowPublicCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, X-Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, MCP-Unauthorized-Status',
  );
  // 少了这一行，浏览器 JS 读不到 401 响应上的 WWW-Authenticate，发现流程无从触发
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Session-Id');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
