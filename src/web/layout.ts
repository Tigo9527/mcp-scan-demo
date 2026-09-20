/**
 * 页面布局与 HTML 转义。
 *
 * 初版三个页面各自内联一份 <style>、且**完全没有转义**——
 * `registeredHtml` 直接把 `?username=` 的值插进 HTML，服务部署在公网上等于可直接利用的 XSS。
 * 这里统一收口：所有页面共用同一份 CSS，并且**所有插值一律 esc()**（含属性位置）。
 */
import { serverInfo } from '../version.js';
const CSS = `
:root{--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb;--bg:#fff;--soft:#f6f8fa;--acc:#0969da;--ok:#1f883d;--warn:#bf8700;--err:#cf222e}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
  max-width:960px;margin:0 auto;padding:0 16px 48px;color:var(--fg);line-height:1.6;background:var(--bg)}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline}
code{background:var(--soft);padding:2px 6px;border-radius:4px;font-size:.9em;word-break:break-all}
pre{background:#0d1117;color:#e6edf3;padding:14px;border-radius:8px;overflow:auto;font-size:.85em}
pre code{background:transparent;padding:0;border-radius:0;font-size:inherit;color:inherit}
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
/* Admin 二级导航：常驻在页面顶部（吸顶），别让入口埋在页面最底下 */
.subnav{display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:var(--soft);
  border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin:0 0 18px;
  position:sticky;top:8px;z-index:5}
.subnav a{color:var(--fg);opacity:.75;padding:6px 12px;border-radius:8px;font-size:.92em;
  text-decoration:none;white-space:nowrap}
.subnav a:hover{text-decoration:none;opacity:1;background:#eaeef2}
.subnav a.active{opacity:1;font-weight:600;color:var(--acc);background:var(--bg);
  border:1px solid var(--line);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.subnav .spacer{margin-left:auto}
.subnav a.mini{opacity:.6;font-size:.85em;padding:6px 8px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.8em;
  border:1px solid var(--line);background:var(--soft);color:var(--muted)}
.badge.ok{color:var(--ok);border-color:#b7e3c6;background:#eaf6ee}
.badge.warn{color:var(--warn);border-color:#f0d9a8;background:#fdf6e3}
.badge.err{color:var(--err);border-color:#f3c3c6;background:#fdecec}
.notice{border-left:4px solid var(--warn);background:#fdf6e3;padding:10px 14px;border-radius:0 8px 8px 0;margin:14px 0;font-size:.92em}
.notice.ok{border-left-color:var(--ok);background:#eaf6ee}
.notice.err{border-left-color:var(--err);background:#fdecec}
.empty{color:var(--muted);padding:16px 0}
.version-footer{margin-top:32px;padding-top:12px;border-top:1px solid var(--line);
  color:var(--muted);font-size:.85em}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.codeblock{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:12px 0}
.codeblock .cb-head{display:flex;align-items:center;gap:8px;background:var(--soft);
  padding:8px 12px;border-bottom:1px solid var(--line);font-size:.9em}
.codeblock .cb-head .cb-title{font-weight:600;margin-right:auto}
.codeblock pre{margin:0;border-radius:0}
.codeblock .cb-foot{padding:8px 12px;border-top:1px solid var(--line);font-size:.88em}
.btn.copy{margin:0;background:#24292f}
.step{font-weight:600;margin:18px 0 6px}
.step span{display:inline-block;min-width:24px;height:24px;line-height:24px;text-align:center;
  border-radius:999px;background:var(--acc);color:#fff;font-size:.85em;margin-right:8px}
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

/**
 * 一键复制代码块。code 一律 esc 后塞进 <pre>，复制时取 pre.textContent（即还原后的原文），
 * 因此既防 XSS 也不用额外维护一份 data-* 属性。
 */
export function copyBlock(code: string, opts: { title?: string; hint?: string } = {}): string {
  return `<div class="codeblock">
<div class="cb-head"><span class="cb-title">${esc(opts.title ?? '')}</span><button type="button" class="btn small copy">复制</button></div>
<pre><code>${esc(code)}</code></pre>
${opts.hint ? `<div class="cb-foot muted">${esc(opts.hint)}</div>` : ''}
</div>`;
}

/** 步骤小标题，如 step(1, '复制配置') */
export function step(n: number, text: string): string {
  return `<div class="step"><span>${esc(n)}</span>${esc(text)}</div>`;
}

/**
 * 复制按钮的行为脚本。用事件委托挂在 document 上，页面里任意 copyBlock 都能用，
 * 且只注入一次、无外部依赖。navigator.clipboard 在非 HTTPS / 沙箱 iframe 里不可用，
 * 故保留 execCommand 兜底。
 */
const COPY_SCRIPT = `<script>
document.addEventListener('click',function(e){
  var t=e.target;if(!t||!t.closest)return;
  var b=t.closest('.copy');if(!b)return;
  var box=b.closest('.codeblock');if(!box)return;
  var pre=box.querySelector('pre');if(!pre)return;
  var text=pre.textContent||'';
  var done=function(ok){var o='复制';b.textContent=ok?'已复制':'复制失败，请手动选中';setTimeout(function(){b.textContent=o;},1600);};
  var legacy=function(){
    var ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');
    ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
    var ok=false;try{ok=document.execCommand('copy');}catch(err){ok=false;}
    document.body.removeChild(ta);done(ok);
  };
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){done(true);},legacy);
  }else{legacy();}
});
</script>`;

/** Admin 的二级页签。给了 `adminTab` 才会在页面顶部渲染 Admin 子导航。 */
export type AdminTab = 'dashboard' | 'users' | 'github' | 'recharge-settings' | 'recharge';

const ADMIN_TABS: Array<{ key: AdminTab; path: string; label: string }> = [
  { key: 'dashboard', path: '/admin', label: '仪表盘' },
  { key: 'users', path: '/admin/users', label: '用户管理' },
  { key: 'github', path: '/admin/settings', label: 'GitHub 设置' },
  { key: 'recharge-settings', path: '/admin/recharge-settings', label: '充值设置' },
  { key: 'recharge', path: '/admin/recharge', label: '充值记录' },
];

export interface PageOptions {
  title: string;
  /** 页面主体 HTML（调用方负责对所有动态值做 esc） */
  body: string;
  /** 导航栏高亮项 */
  active?: 'home' | 'admin' | 'profile' | 'setup' | 'web3' | 'recharge';
  /** 对外基础地址，用于拼导航链接 */
  base?: string;
  /** admin 令牌占位字段（保留兼容）。admin 登录态已改由 Cookie 保持，内部链接不再注入 token。 */
  adminToken?: string;
  /** Admin 子导航高亮项（仅 admin 页面传） */
  adminTab?: AdminTab;
}

/**
 * admin 内部链接。
 *
 * **不再拼接 token**：admin 登录态由 `mcp_admin` Cookie 保持，UI 任何链接都不该把令牌
 * 带进 URL（否则会漏进地址栏、浏览器历史、截图、Referer、平台访问日志）。`adminToken`
 * 形参保留仅为兼容旧调用方，本函数直接忽略它。服务端仍接受 `X-Admin-Token` 请求头供
 * 脚本/自动化使用，但不走 URL。
 */
export function adminHref(path: string, _adminToken?: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export function page(opts: PageOptions): string {
  const base = opts.base ?? '';
  const navLinks: Array<{ href: string; key: PageOptions['active']; label: string }> = [
    { href: `${base}/`, key: 'home', label: '首页' },
    { href: `${base}/web3`, key: 'web3', label: 'web3 登录' },
    { href: `${base}/setup`, key: 'setup', label: '接入配置' },
    { href: `${base}/profile`, key: 'profile', label: '我的 Profile' },
    { href: `${base}/recharge`, key: 'recharge', label: '充值' },
    { href: adminHref('/admin', opts.adminToken), key: 'admin', label: 'Admin 管理端' },
  ];

  const nav = `<nav><span class="brand">MCP Demo</span>${navLinks
    .map(
      (l) =>
        `<a href="${esc(l.href)}"${opts.active === l.key ? ' class="active"' : ''}>${esc(l.label)}</a>`,
    )
    .join('')}</nav>`;

  // Admin 子导航：入口统一放这里，不再散落在每个页面底部（底部按钮很容易被当成页脚忽略）
  const subnav = opts.adminTab
    ? `<nav class="subnav">${ADMIN_TABS.map(
        (t) =>
          `<a href="${esc(adminHref(t.path, opts.adminToken))}"${
            opts.adminTab === t.key ? ' class="active"' : ''
          }>${esc(t.label)}</a>`,
      ).join('')}<span class="spacer"></span><a class="mini" href="${esc(
        adminHref('/admin/api/stats', opts.adminToken),
      )}">统计 JSON</a><a class="mini" href="${esc(
        adminHref('/admin/logout', opts.adminToken),
      )}">退出</a></nav>`
    : '';

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title><style>${CSS}</style></head>
<body>${nav}${subnav}${opts.body}${versionFooter()}${COPY_SCRIPT}</body></html>`;
}

/**
 * 页脚版本信息：所有经 page() 渲染的页面都会带上，方便用户/排查时一眼看到
 * 当前运行的版本、提交与启动时间。动态值均经 esc() 转义。
 */
function versionFooter(): string {
  return `<footer class="version-footer">v${esc(serverInfo.version)} · commit <code>${esc(
    serverInfo.commit,
  )}</code> · 启动 ${fmtTime(serverInfo.startedAt)}</footer>`;
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

/** 提示条。`kind` 缺省为「提醒（黄）」，`ok` 绿、`err` 红。 */
export function notice(inner: string, kind?: 'ok' | 'err'): string {
  const cls = kind ? `notice ${kind}` : 'notice';
  return `<div class="${cls}">${inner}</div>`;
}

/**
 * 授权完成后的「正在跳回客户端」页。
 *
 * 浏览器通过 meta refresh + JS 自动跳回 `redirect_uri?code=...&state=...`（与标准 302 等效）。
 * 若客户端监听在本机（如 `http://127.0.0.1:35195/callback`），自动跳转即可完成登录；
 * 若**登录用的浏览器与运行客户端的机器不是同一台**，自动跳转必然失败 —— 此时页面会把
 * 完整回调 URL（含 code / state）+ 复制按钮展示出来，供用户在客户端所在机器上手动打开，
 * 这就是「最后一跳」的兜底。
 *
 * 放在 layout 而非 app.ts：它要同时被 `authorize.ts`（账号密码路径）与 `app.ts`（GitHub 回调路径）
 * 复用，放这里可避免两者之间的循环依赖。
 */
export function authorizeCompleteHtml(base: string, callbackUrl: string): string {
  return page({
    title: '正在跳回客户端…',
    base,
    body: `
<h1>↩️ 正在跳回客户端…</h1>
${card(`
<p>授权已完成，正在把你跳回发起登录的 MCP 客户端。</p>
<div class="row" style="margin-top:12px">
<a id="cb-link" class="btn" href="${esc(callbackUrl)}">立即跳回客户端</a>
</div>
${copyBlock(callbackUrl, {
  title: '完整回调地址（含 code / state）',
  hint: '若页面没有自动跳转，请在<strong>运行客户端的机器</strong>（通常是本机 127.0.0.1）上打开此地址完成登录。',
})}
<p class="muted">自动跳转没发生，多半是登录用的浏览器与运行 MCP 客户端的机器不是同一台。请复制上面的地址，到客户端所在机器上手动打开即可。</p>
`)}
<meta http-equiv="refresh" content="1; url='${esc(callbackUrl)}'">
<script>setTimeout(function(){try{window.location.href=${JSON.stringify(callbackUrl)};}catch(e){}},1000);</script>
<div class="row" style="margin-top:16px"><a class="btn alt" href="${esc(base)}/">返回首页</a></div>
`,
  });
}

/** 本地时区的可读时间（toISOString 是 UTC，直接展示会让人困惑） */
export function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
