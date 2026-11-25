/** Mount path for every HTTP and WebSocket endpoint. Empty means site root. */
export function normalizeUrlPrefix(value: string | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw || raw === '/') return '';
  const prefix = `/${raw.replace(/^\/+|\/+$/g, '')}`;
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(prefix) || prefix.includes('//') || prefix.split('/').includes('..')) {
    throw new Error('URL_PREFIX must be a URL path such as /demo');
  }
  return prefix;
}

/** Accept an origin or an already-prefixed public base URL. */
export function baseWithPrefix(raw: string, prefix: string): string {
  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, '');
  if (prefix && path && path !== prefix) throw new Error('BASE_URL / PUBLIC_BASE_URL path must match URL_PREFIX');
  return `${url.origin}${prefix || path}`;
}
