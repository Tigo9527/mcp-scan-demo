/**
 * OAuth 动态客户端注册（RFC 7591）。
 *
 * 规范里 DCR 是 SHOULD 而非 MUST，但现实是：Codex / Claude Desktop 这类客户端每次启动都是
 * 一个全新的、没有预置凭据的客户端，**没有 DCR 就拿不到 client_id，流程根本走不起来**。
 *
 * 实现上不落盘：`client_id` 本身就是一枚加密自包含票据（见 tickets.ts），
 * 里面封着该客户端注册的 redirect_uris。这样服务端无需保存任何状态。
 * 代价是无法吊销单个客户端 —— demo 可接受，代价写在 README 里。
 */
import { seal, open } from './tickets.js';

const TTL_SECONDS = 100 * 365 * 24 * 3600; // 客户端注册长期有效

export interface RegisteredClient {
  /** 客户端标识（本身就是加密票据） */
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  /** 公开客户端，无 client_secret */
  token_endpoint_auth_method?: 'none';
}

interface ClientTicket extends RegisteredClient {
  iat: number;
}

function parseUri(raw: string): URL | null {
  try {
    const u = new URL(raw);
    // 带 fragment 的 redirect_uri 一律拒绝（OAuth 2.1）
    if (u.hash) return null;
    return u;
  } catch {
    return null;
  }
}

function isLoopback(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/**
 * 用于比对的 URI 指纹。
 * 回环地址**忽略端口** —— RFC 8252 §7.3：桌面端客户端常用随机端口（`http://127.0.0.1:54321/cb`），
 * 做严格等值匹配的话第一次授权就挂。
 */
function uriKey(u: URL): string {
  const host = isLoopback(u) ? u.hostname.toLowerCase() : u.host.toLowerCase();
  return `${u.protocol}//${host}${u.pathname}${u.search}`;
}

export function isLoopbackUri(raw: string): boolean {
  const u = parseUri(raw);
  return u ? isLoopback(u) : false;
}

/** 注册一个客户端，返回可直接下发的客户端信息（含 client_id）。 */
export function registerClient(input: {
  redirect_uris?: unknown;
  client_name?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
}): RegisteredClient {
  const rawUris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  const uris: string[] = [];
  for (const u of rawUris) {
    if (typeof u !== 'string') continue;
    const parsed = parseUri(u);
    if (!parsed) continue;
    // 非回环地址必须用 https（OAuth 2.1）
    if (!isLoopback(parsed) && parsed.protocol !== 'https:') continue;
    uris.push(u);
  }
  if (uris.length === 0) {
    throw new Error('redirect_uris 至少需要一个合法的 URI（非回环地址必须为 https，且不能含 fragment）');
  }

  // client_id 先占位：它本身就是下面这枚票据，签发前还不存在
  const client: RegisteredClient = {
    client_id: '',
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
  };
  if (typeof input.client_name === 'string' && input.client_name.trim()) {
    client.client_name = input.client_name.trim().slice(0, 200);
  }
  if (Array.isArray(input.grant_types)) {
    client.grant_types = input.grant_types.filter((g): g is string => typeof g === 'string');
  }
  if (Array.isArray(input.response_types)) {
    client.response_types = input.response_types.filter((r): r is string => typeof r === 'string');
  }
  if (typeof input.scope === 'string') client.scope = input.scope;

  client.client_id = seal('dcr', client as unknown as Record<string, unknown>, TTL_SECONDS);
  return client;
}

/** 从 client_id 解出注册信息（无效/被篡改/过期返回 null）。 */
export function readClient(clientId: string | undefined): RegisteredClient | null {
  const data = open<ClientTicket>('dcr', clientId);
  if (!data) return null;
  if (!Array.isArray(data.redirect_uris)) return null;
  return { ...data, client_id: clientId! };
}

/** 校验 redirect_uri 是否在该客户端注册列表内。 */
export function redirectUriAllowed(client: RegisteredClient, raw: string): boolean {
  const target = parseUri(raw);
  if (!target) return false;
  const key = uriKey(target);
  return client.redirect_uris.some((u) => {
    const p = parseUri(u);
    return p ? uriKey(p) === key : false;
  });
}
