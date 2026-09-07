/**
 * 请求级鉴权上下文。
 * - authContext：在 Express 的 /mcp 处理器里用 authContext.run(user, ...) 包裹，
 *   MCP 工具处理函数即可通过 getCurrentUser() 拿到当前登录用户（可能为 null = 匿名）。
 * - baseUrlContext：把当前请求推导出的对外基础地址（含协议与域名）注入，
 *   工具用它来拼登录 URL，避免把 localhost 暴露在公网返回里。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { User } from './store.js';
import { config } from '../config.js';

export const authContext = new AsyncLocalStorage<User | null>();

export function getCurrentUser(): User | null {
  return authContext.getStore() ?? null;
}

export const baseUrlContext = new AsyncLocalStorage<string>();

/** 获取当前请求推导出的对外基础地址，未绑定请求时回退到配置值。 */
export function getRequestBaseUrl(): string {
  return baseUrlContext.getStore() ?? config.publicBaseUrl;
}
