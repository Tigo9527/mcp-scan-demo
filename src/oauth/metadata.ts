/**
 * MCP 授权发现（Authorization Discovery）所需的元数据文档。
 *
 * 规范依据（已逐条核对原文，勿凭记忆改动）：
 *  - RFC 9728 OAuth 2.0 Protected Resource Metadata —— MCP server **MUST** 实现
 *  - RFC 8414 OAuth 2.0 Authorization Server Metadata —— 授权服务器 **MUST** 提供
 *  - MCP 规范 2025-06-18「Authorization」章节
 *
 * 三个最容易写错的点，这里固定下来：
 *
 * 1. **canonical resource 带路径**。MCP 端点是 `<base>/mcp`，按 RFC 9728 §3.1 的插入规则
 *    （well-known 插在 host 与 path 之间），元数据地址必须是
 *    `<base>/.well-known/oauth-protected-resource/mcp`。
 *    只挂 `<base>/.well-known/oauth-protected-resource` 会让客户端 404 后放弃发现。
 *    根路径那份仅作兜底（客户端把 canonical 当成不带路径的 origin 时会来这里）。
 *
 * 2. **401 头只给 resource_metadata**。授权服务器的地址**不**出现在 401 头里，
 *    而是客户端从 PRM 的 `authorization_servers` 派生后再走 RFC 8414。
 *
 * 3. **不要声明 `client_id_metadata_document_supported`**。官方 SDK 一旦见到该字段就会
 *    走 CIMD（Client ID Metadata Document）流程，绕过我们的动态注册端点。
 */

/** 本服务对外声明的 scope。MCP 规范未定义标准取值，这里用一个自解释的。 */
export const OAUTH_SCOPE = 'mcp';

/** MCP 端点路径。canonical resource URI = `<base>/mcp`。 */
export const MCP_PATH = '/mcp';

export const WELL_KNOWN = {
  protectedResource: '/.well-known/oauth-protected-resource',
  authorizationServer: '/.well-known/oauth-authorization-server',
  /**
   * OIDC 发现别名。MCP 规范不要求它，但不少客户端/库（以及一些扫码类工具）会先取
   * `openid-configuration`。本服务就是自己的授权服务器，与 RFC 8414 那份内容一致，
   * 多挂一个别名只是省掉一次 404。
   */
  openidConfiguration: '/.well-known/openid-configuration',
} as const;

/** 去掉结尾斜杠。canonical URI 的比较对尾斜杠敏感，统一在这里归一。 */
export function trimSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

/** MCP 服务的 canonical URI（RFC 8707 的 resource 参数取值）。无尾斜杠、无 fragment。 */
export function canonicalResourceUri(base: string): string {
  return `${trimSlash(base)}${MCP_PATH}`;
}

/** 受保护资源元数据地址（RFC 9728 §3.1 的插入规则） */
export function protectedResourceMetadataUrl(base: string): string {
  return `${trimSlash(base)}${WELL_KNOWN.protectedResource}${MCP_PATH}`;
}

/** 兜底地址：客户端把 canonical 当成不带路径的 origin 时会请求这里 */
export function protectedResourceMetadataRootUrl(base: string): string {
  return `${trimSlash(base)}${WELL_KNOWN.protectedResource}`;
}

/** RFC 9728 受保护资源元数据。MCP 要求至少包含 authorization_servers。 */
export function protectedResourceMetadata(base: string): Record<string, unknown> {
  const b = trimSlash(base);
  return {
    resource: canonicalResourceUri(base),
    authorization_servers: [b],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_documentation: `${b}/setup`,
  };
}

/** RFC 8414 授权服务器元数据。本服务的授权服务器与资源服务器同源。 */
export function authorizationServerMetadata(base: string): Record<string, unknown> {
  const b = trimSlash(base);
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [OAUTH_SCOPE],
    // 公开客户端（DCR 签发、无 client_secret），故只支持 none
    token_endpoint_auth_methods_supported: ['none'],
  };
}

/**
 * 401 响应头取值。形如：
 *   Bearer resource_metadata="https://host/.well-known/oauth-protected-resource/mcp", scope="mcp"
 *
 * 官方 SDK 用 `/resource_metadata="([^"]*)"/` 解析（client/auth.js:408），**格式不能改**。
 */
export function wwwAuthenticate(base: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(
    base,
  )}", scope="${OAUTH_SCOPE}"`;
}
