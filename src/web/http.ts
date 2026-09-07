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
 * 从请求里提取本服务的用户令牌。
 *
 * 关键：部署平台网关会**拦截并改写 Authorization 头**（注入平台自己的 JWT），
 * 因此只采信带本服务前缀 `mcp_demo_` 的值，网关注入的一律忽略。
 */
export function resolveUserToken(req: Request): string | undefined {
  const candidates: unknown[] = [
    req.headers['x-authorization'],
    (req.query as Record<string, unknown> | undefined)?.token,
    (req.query as Record<string, unknown> | undefined)?.access_token,
    req.headers.authorization,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes(config.jwtTokenPrefix)) return c;
  }
  return undefined;
}

/** 校验当前请求携带的用户令牌，返回用户（匿名/无效返回 null）。 */
export function authenticateUserRequest(req: Request): User | null {
  return authManager.authenticate(resolveUserToken(req));
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
