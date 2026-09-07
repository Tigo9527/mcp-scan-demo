/**
 * 页面布局与 HTML 转义。
 *
 * 初版三个页面各自内联一份 <style>、且**完全没有转义**——
 * `registeredHtml` 直接把 `?username=` 的值插进 HTML，服务部署在公网上等于可直接利用的 XSS。
 * 这里统一收口：所有页面共用同一份 CSS，并且**所有插值一律 esc()**（含属性位置）。
 */
const CSS = `
:root{--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb;--bg:#fff;--soft:#f6f8fa;--acc:#0969da;--ok:#1f883d;--warn:#bf8700;--err:#cf222e}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
  max-width:960px;margin:0 auto;padding:0 16px 48px;color:var(--fg);line-height:1.6;background:var(--bg)}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline}
code{background:var(--soft);padding:2px 6px;border-radius:4px;font-size:.9em;word-break:break-all}
pre{background:#0d1117;color:#e6edf3;padding:14px;border-radius:8px;overflow:auto;font-size:.85em}
h1{font-size:1.6em;margin:24px 0 8px}
h2{font-size:1.25em;margin:28px 0 10px}
h3{font-size:1.05em;margin:18px 0 8px}
.muted{color:var(--muted);font-size:.92em}
.card{border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:14px 0}
.stat{border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat .n{font-size:1.7em;font-weight:600;line-height:1.2}
.stat .l{color:var(--muted);font-size:.88em;margin-top:2px}
table{border-collapse:collapse;width:100%;font-size:.92em;margin:10px 0}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--soft);font-weight:600}
tbody tr:nth-child(even){background:#fcfcfd}
.bar{background:var(--soft);border-radius:6px;height:8px;overflow:hidden;min-width:60px}
.bar>i{display:block;height:100%;background:var(--acc)}
.btn{display:inline-block;background:var(--ok);color:#fff;padding:9px 15px;border-radius:8px;
  text-decoration:none;margin:4px 6px 4px 0;border:0;font-size:.94em;cursor:pointer}
.btn:hover{text-decoration:none;opacity:.9}
.btn.alt{background:#24292f}
.btn.danger{background:var(--err)}
.btn.small{padding:5px 10px;font-size:.85em}
input,select{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font:inherit;margin:4px 0}
label{display:block;margin-top:12px;font-weight:600;font-size:.92em}
nav{display:flex;gap:16px;align-items:center;border-bottom:1px solid var(--line);
  padding:12px 16px;margin:0 -16px 8px;flex-wrap:wrap}
nav .brand{font-weight:700;margin-right:auto}
nav a{color:var(--fg);opacity:.75}
nav a.active{opacity:1;font-weight:600;color:var(--acc)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.8em;
  border:1px solid var(--line);background:var(--soft);color:var(--muted)}
.badge.ok{color:var(--ok);border-color:#b7e3c6;background:#eaf6ee}
.badge.warn{color:var(--warn);border-color:#f0d9a8;background:#fdf6e3}
.badge.err{color:var(--err);border-color:#f3c3c6;background:#fdecec}
.notice{border-left:4px solid var(--warn);background:#fdf6e3;padding:10px 14px;border-radius:0 8px 8px 0;margin:14px 0;font-size:.92em}
.empty{color:var(--muted);padding:16px 0}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
`;

/** HTML 转义。所有插值都必须过一遍，包括 href="...?token=${esc(x)}" 这类属性位置。 */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PageOptions {
  title: string;
  /** 页面主体 HTML（调用方负责对所有动态值做 esc） */
  body: string;
  /** 导航栏高亮项 */
  active?: 'home' | 'admin' | 'profile';
  /** 对外基础地址，用于拼导航链接 */
  base?: string;
  /** admin 令牌：有值时 admin 内部链接会带上，保证网关不透传 Cookie 时也能正常跳转 */
  adminToken?: string;
}

/** admin 内部链接（自动带上 admin_token，防止平台网关丢弃 Cookie 导致刷新即掉线） */
export function adminHref(path: string, adminToken?: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (!adminToken) return clean;
  return `${clean}${clean.includes('?') ? '&' : '?'}admin_token=${encodeURIComponent(adminToken)}`;
}

export function page(opts: PageOptions): string {
  const base = opts.base ?? '';
  const navLinks: Array<{ href: string; key: PageOptions['active']; label: string }> = [
    { href: `${base}/`, key: 'home', label: '首页' },
    { href: `${base}/profile`, key: 'profile', label: '我的 Profile' },
    { href: adminHref('/admin', opts.adminToken), key: 'admin', label: 'Admin 管理端' },
  ];

  const nav = `<nav><span class="brand">MCP Demo</span>${navLinks
    .map(
      (l) =>
        `<a href="${esc(l.href)}"${opts.active === l.key ? ' class="active"' : ''}>${esc(l.label)}</a>`,
    )
    .join('')}</nav>`;

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title><style>${CSS}</style></head>
<body>${nav}${opts.body}</body></html>`;
}

export function card(inner: string, cls = ''): string {
  return `<div class="card${cls ? ` ${cls}` : ''}">${inner}</div>`;
}

export function statCard(value: unknown, label: string, hint?: string): string {
  return `<div class="stat"><div class="n">${esc(value)}</div><div class="l">${esc(label)}${
    hint ? ` <span class="muted">${esc(hint)}</span>` : ''
  }</div></div>`;
}

/** 表格。调用方需自行 esc 每个单元格。 */
export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<div class="empty">暂无数据</div>';
  const head = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}

/** 条形图（纯 CSS，无前端库）。带除零与上限保护。 */
export function bar(value: number, max: number): string {
  const safeMax = max > 0 ? max : 0;
  const pct = safeMax > 0 ? Math.min(100, Math.round((value / safeMax) * 100)) : 0;
  return `<div class="bar"><i style="width:${pct}%"></i></div>`;
}

export function badge(text: string, kind: 'ok' | 'warn' | 'err' | '' = ''): string {
  return `<span class="badge${kind ? ` ${kind}` : ''}">${esc(text)}</span>`;
}

export function notice(inner: string): string {
  return `<div class="notice">${inner}</div>`;
}

/** 本地时区的可读时间（toISOString 是 UTC，直接展示会让人困惑） */
export function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
