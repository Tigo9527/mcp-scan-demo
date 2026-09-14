/**
 * 用户充值页 `/recharge`：
 *   GET  /recharge          展示收款配置 + MetaMask 转账 + 手动补单 + 自己的充值历史
 *   POST /recharge          提交交易哈希入账（幂等；同一哈希只入账一次）
 *
 * 与 /profile 一样靠 `authenticateWebUserRequest` 识别用户：请求头 `X-Authorization`、
 * `?token=` 查询参数，以及登录时下发的**会话 Cookie**（登录态自动保持，不必再挂令牌）。
 * 未登录时给出引导而不是 401 —— 这是浏览器页面，不是 MCP 端点。
 *
 * 「交易完成即到账」：MetaMask 返回哈希后前端立刻回填并提交补单；原生币即使尚未打包
 * 也按 tx.value 入账（状态 pending），ERC20 需要等打包读 Transfer 事件，故可能提示稍后重试。
 */
import { Router, type Request, type Response } from 'express';
import {
  adoptTokenFromUrl,
  authenticateWebUserRequest,
  deriveBase,
  requireSameOrigin,
  resolveUserToken,
  wrap,
} from './http.js';
import { badge, card, copyBlock, esc, fmtTime, notice, page, table } from './layout.js';
import { ENSURE_CHAIN_JS, type ChainView } from './chain.js';
import {
  buildChainAddParams,
  chainIdToDecimal,
  chainName,
  normalizeChainId,
  getRechargeConfig,
  listRecharges,
  submitRechargeTx,
  RechargePendingError,
  type RechargeConfig,
} from '../recharge.js';
import * as billing from '../billing.js';

/** ERC20 transfer(address,uint256) 的 4 字节选择器，前端据此拼 calldata */
const TRANSFER_SELECTOR = '0xa9059cbb';

function noAuthHtml(base: string): string {
  return page({
    title: '充值',
    base,
    active: 'recharge',
    body: `
<h1>💰 充值点数</h1>
${notice('请先登录后再充值。登录一次即可保持，之后直接进这个页面就行。')}
<div class="row"><a class="btn" href="${esc(base)}/login">去登录</a>
<a class="btn alt" href="${esc(base)}/">返回首页</a></div>
`,
  });
}

function notConfiguredHtml(base: string): string {
  return page({
    title: '充值',
    base,
    active: 'recharge',
    body: `
<h1>💰 充值点数</h1>
${notice('管理员尚未配置收款地址，暂时无法充值。')}
<p class="muted">配置路径：Admin 管理端 → 充值设置（支持 EVM 原生币与 ERC20）。</p>
<div class="row"><a class="btn alt" href="${esc(base)}/">返回首页</a></div>
`,
  });
}

function rechargeHtml(opts: {
  base: string;
  token: string;
  cfg: RechargeConfig;
  rows: ReturnType<typeof listRecharges>;
  balance: number;
  recharged: number;
  message?: { kind: 'ok' | 'err'; text: string };
  /** 有待确认的交易哈希时，页面加载即开始后台轮询（来自补单表单的重试） */
  pendingHash?: string;
}): string {
  const { base, cfg, rows } = opts;
  const isToken = Boolean(cfg.tokenAddress);
  const decimals = cfg.tokenDecimals ?? 18;
  const symbol = isToken ? cfg.tokenSymbol || 'ERC20' : 'ETH（原生币）';

  const meta = {
    recipient: cfg.recipient,
    tokenAddress: cfg.tokenAddress,
    decimals,
    selector: TRANSFER_SELECTOR,
  };

  // 目标链：前端据此在转账前比对钱包网络，不一致就唤起切换 / 添加。
  // 必须归一化成 hex：存量配置里可能是十进制（"71"），而钱包的 eth_chainId 恒为
  // 十六进制（"0x47"），直接比字符串会永远不相等，表现为「明明是对的链却一直让切」。
  const targetChainId = cfg.chainId ? normalizeChainId(cfg.chainId) : '';
  const chain: ChainView = {
    chainId: targetChainId,
    chainIdDec: targetChainId ? chainIdToDecimal(targetChainId) : '',
    name: (targetChainId && chainName(targetChainId)) || '',
    addParams: buildChainAddParams(cfg),
  };
  const chainLabel = chain.chainId
    ? `${chain.name || 'Chain ' + chain.chainIdDec}（链 ID ${chain.chainIdDec}）`
    : '';

  return page({
    title: '充值',
    base,
    active: 'recharge',
    body: `
<h1>💰 充值点数</h1>
${opts.message ? notice(esc(opts.message.text)) : ''}

<div id="pending-box" style="display:none;border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0">
<b>⏳ 正在等待链上确认</b>
<p id="pending-msg" class="muted" style="margin:6px 0 0"></p>
<p class="muted" style="margin:6px 0 0">后台自动重试，<b>不阻塞你的操作</b>——可以照常浏览本页或离开，确认成功后会自动到账。</p>
</div>

${card(`
<div class="grid">
<div class="stat"><div class="v">${esc(String(opts.balance))}</div><div class="l">当前余额（点）</div></div>
<div class="stat"><div class="v">${esc(String(opts.recharged))}</div><div class="l">累计充值（点）</div></div>
<div class="stat"><div class="v">${esc(String(cfg.rate))}</div><div class="l">汇率（1 ${esc(isToken ? (cfg.tokenSymbol || '代币') : 'ETH')} = ? 点）</div></div>
</div>
`)}

<h2>收款信息</h2>
${card(`
${table(
  ['项', '值'],
  [
    ['收款地址', `<code>${esc(cfg.recipient)}</code>`],
    ['收取币种', esc(symbol)],
    [
      '代币合约',
      isToken ? `<code>${esc(cfg.tokenAddress)}</code>` : '<span class="muted">原生币（无需合约）</span>',
    ],
    [
      '代币元数据',
      isToken
        ? `${esc(cfg.tokenName || '—')}（${esc(cfg.tokenSymbol || '—')}）· decimals ${esc(String(decimals))}`
        : '<span class="muted">—</span>',
    ],
    [
      '链 / 网络',
      targetChainId
        ? `${esc(chainLabel)} <code>${esc(targetChainId)}</code>`
        : '<span class="muted">未指定（转账前不会强制切换网络）</span>',
    ],
  ],
)}
${copyBlock(cfg.recipient, { title: '收款地址（复制）' })}
`)}

<h2>方式一：用 MetaMask 转账</h2>
${card(`
<div id="net-box" class="muted" style="margin:0 0 10px"></div>
<button id="switch-net" class="btn alt" type="button" style="display:none;margin-bottom:10px">切换网络</button>
<label for="amount">转账数量（${esc(isToken ? (cfg.tokenSymbol || '代币') : 'ETH')}）</label>
<input id="amount" type="text" inputmode="decimal" placeholder="0.01" style="max-width:240px">
<p class="muted">按当前汇率 1 ≈ ${esc(String(cfg.rate))} 点，预计到账 <b id="estimate">0</b> 点。</p>
<button id="send" class="btn" type="button">用钱包发送</button>
<p id="status" class="muted" style="margin-top:10px"></p>
<p class="muted">点击后会拉起钱包确认；确认成功即自动回填哈希并提交补单，无需等待打包。</p>
`)}

<h2>方式二：手动补单</h2>
${card(`
<p class="muted">已经在别处转过账？直接填交易哈希补单即可。同一哈希只会入账一次。</p>
<form id="recharge-form" method="post" action="${esc(base)}/recharge">
<input type="hidden" name="token" value="${esc(opts.token)}">
<label for="txHash">交易哈希（0x…）</label>
<input id="txHash" name="txHash" placeholder="0x + 64 位十六进制" style="max-width:520px">
<button class="btn" type="submit">提交补单</button>
</form>
`)}

<h2>我的充值历史</h2>
${rows.length === 0
  ? '<div class="empty">还没有充值记录。</div>'
  : table(
      ['时间', '币种', '数量', '点数', '状态', '交易哈希'],
      rows.map((r) => [
        esc(fmtTime(r.createdAt)),
        esc(r.token),
        esc(r.amount),
        String(r.points),
        badge(r.status === 'pending' ? '待确认' : '已到账', r.status === 'pending' ? 'warn' : 'ok'),
        `<code>${esc(r.txHash.slice(0, 10))}…${esc(r.txHash.slice(-6))}</code>`,
      ]),
    )}

<div class="row" style="margin-top:20px">
<a class="btn alt" href="${esc(`${base}/profile`)}">我的 Profile</a>
<a class="btn alt" href="${esc(base)}/">返回首页</a>
</div>

<script>
(function(){
  var cfg=${JSON.stringify(meta)};
  var rate=${JSON.stringify(cfg.rate)};
  var chain=${JSON.stringify(chain)};
  var claimUrl=${JSON.stringify(`${base}/recharge/claim`)};
  var token=${JSON.stringify(opts.token)};
  var pendingHash=${JSON.stringify(opts.pendingHash ?? '')};
  var maxTries=30, intervalMs=6000;
  var amountEl=document.getElementById('amount');
  var estEl=document.getElementById('estimate');
  var btn=document.getElementById('send');
  var status=document.getElementById('status');
  var hashEl=document.getElementById('txHash');
  var form=document.getElementById('recharge-form');
  var netBox=document.getElementById('net-box');
  var netBtn=document.getElementById('switch-net');
  var setStatus=function(s){status.textContent=s;};

  ${ENSURE_CHAIN_JS}

  /** 刷新「钱包当前网络 vs 目标链」的提示，并决定要不要显示切换按钮 */
  async function refreshNet(){
    if(!window.ethereum){netBox.textContent='未检测到钱包（MetaMask 等），可用下方手动补单。';return;}
    var cur;
    try{cur=await window.ethereum.request({method:'eth_chainId'});}catch(e){netBox.textContent='读取钱包网络失败。';return;}
    if(!chain.chainId){
      netBox.textContent='当前网络：链 ID '+hexToDec(cur)+'。本服务未指定链，请自行确认与收款设置一致。';
      netBtn.style.display='none';return;
    }
    if(sameChain(cur,chain.chainId)){
      netBox.textContent='✅ 钱包网络已就绪：'+chainLabel(chain,cur)+'（链 ID '+hexToDec(cur)+'）';
      netBtn.style.display='none';return;
    }
    netBox.textContent='⚠️ 钱包当前在链 ID '+hexToDec(cur)+'，收款网络是 '+chainLabel(chain,chain.chainId)+'——转错链将收不到账。';
    netBtn.style.display='inline-block';
    netBtn.textContent='切换到 '+chainLabel(chain,chain.chainId);
  }
  if(window.ethereum){
    refreshNet();
    // 用户在钱包里手动换网时同步提示，避免「刚切过去又切回来」没人提醒
    if(window.ethereum.on) window.ethereum.on('chainChanged',function(){refreshNet();});
    netBtn.addEventListener('click',async function(){
      netBtn.disabled=true;
      try{await ensureChain(window.ethereum,chain,setStatus);await refreshNet();}
      catch(e){setStatus('切换网络失败：'+(e&&e.message?e.message:String(e)));}
      netBtn.disabled=false;
    });
  }else{
    netBox.textContent='未检测到钱包（MetaMask 等），可用下方手动补单。';
  }

  function toRaw(v){
    // 用字符串解析避免浮点误差：'0.1' * 10^18
    var s=String(v||'').trim();
    if(!/^\\d*(\\.\\d*)?$/.test(s)||s===''||s==='.') return null;
    var neg=s[0]==='-'; if(neg) s=s.slice(1);
    var parts=s.split('.');
    var int=parts[0]||'0';
    var frac=(parts[1]||'');
    if(frac.length>cfg.decimals) frac=frac.slice(0,cfg.decimals);
    while(frac.length<cfg.decimals) frac+='0';
    var raw=BigInt(int||'0')*BigInt('1'+new Array(cfg.decimals+1).join('0'))+BigInt(frac||'0');
    return neg?-raw:raw;
  }
  function padHex(hex,len){ while(hex.length<len) hex='0'+hex; return hex; }
  function padWord(hex){ return padHex(hex,64); }

  var box=document.getElementById('pending-box');
  var pmsg=document.getElementById('pending-msg');
  function showPending(t){box.style.display='block';pmsg.textContent=t;}

  /**
   * 后台轮询补单：不弹窗、不禁用任何控件，只在页面顶部显示一条进度，
   * 用户可以照常浏览/离开；确认成功后自动刷新页面。
   */
  function poll(hash){
    var tries=0,timer=null;
    function step(){
      // 令牌走 X-Authorization 头：本服务只认这个头 / ?token= 查询参数，不读 body 里的 token
      fetch(claimUrl,{method:'POST',headers:{'Content-Type':'application/json','X-Authorization':'Bearer '+token},body:JSON.stringify({txHash:hash})})
      .then(function(r){return r.json().catch(function(){return {};});})
      .then(function(d){
        if(d.ok){
          showPending('✅ 已到账 '+d.points+' 点，正在刷新…');
          var u=new URL(window.location.href);
          u.searchParams.delete('pending');u.searchParams.delete('err');
          u.searchParams.set('ok','1');
          u.searchParams.set('msg', d.duplicated
            ? ('该交易此前已入账（'+d.points+' 点），未重复加分。')
            : ('充值成功，到账 '+d.points+' 点。'));
          setTimeout(function(){window.location.href=u.toString();},900);
          return;
        }
        if(d.code==='pending'){
          tries++;
          if(tries>=maxTries){
            showPending('⚠️ 已等待约 '+Math.round(maxTries*intervalMs/1000)+' 秒仍未确认；可稍后用下方表单手动补单。');
            return;
          }
          showPending('⏳ 等待链上确认…（第 '+tries+' 次，每 '+(intervalMs/1000)+' 秒一次）');
          timer=setTimeout(step,intervalMs);
          return;
        }
        showPending('❌ '+(d.error||'补单失败'));
      })
      .catch(function(e){
        showPending('网络异常，正在重试…（'+(e&&e.message?e.message:String(e))+'）');
        timer=setTimeout(step,intervalMs);
      });
    }
    showPending('⏳ 已提交，正在等待链上确认…');
    step();
  }
  if(pendingHash) poll(pendingHash);

  if(amountEl){
    amountEl.addEventListener('input',function(){
      var raw=toRaw(amountEl.value);
      estEl.textContent = raw===null? '0' : String(Number(raw)/Math.pow(10,cfg.decimals)*rate|0);
    });
  }
  if(!window.ethereum){
    setStatus('未检测到钱包（MetaMask 等）。请安装钱包，或用下方手动补单。');
    btn.disabled=true;
  }else{
  btn.addEventListener('click',async function(){
    var raw=toRaw(amountEl.value);
    if(raw===null||raw<=0n){setStatus('请输入正确的转账数量。');return;}
    btn.disabled=true;setStatus('请在钱包中确认交易…');
    try{
      var accts=await window.ethereum.request({method:'eth_requestAccounts'});
      var from=accts&&accts[0];
      if(!from){setStatus('未能获取钱包地址。');btn.disabled=false;return;}
      // 转账前必须确认网络：转错链 = 钱出去了但服务端按配置的链查不到，等于白转
      await ensureChain(window.ethereum,chain,setStatus);
      var params;
      if(cfg.tokenAddress){
        var data=cfg.selector+padWord(cfg.recipient.toLowerCase().replace(/^0x/,''))+padWord(raw.toString(16));
        params={from:from,to:cfg.tokenAddress,data:data};
      }else{
        params={from:from,to:cfg.recipient,value:'0x'+raw.toString(16)};
      }
      var hash=await window.ethereum.request({method:'eth_sendTransaction',params:[params]});
      setStatus('交易已提交：'+hash+'（可照常操作，到账后本页会自动刷新）');
      hashEl.value=hash;
      btn.disabled=false;
      poll(hash);
    }catch(e){
      setStatus('失败：'+(e&&e.message?e.message:String(e)));
      btn.disabled=false;
    }
  });
  }
})();
</script>
`,
  });
}

export function createRechargeRouter(): Router {
  const router = Router();

  router.get(
    '/recharge',
    wrap((req: Request, res: Response) => {
      // 令牌可能出现在 URL 里，禁止 Referer 外泄
      res.setHeader('Referrer-Policy', 'no-referrer');
      const base = deriveBase(req);
      const user = authenticateWebUserRequest(req);
      if (!user) {
        res.type('html').send(noAuthHtml(base));
        return;
      }
      const cfg = getRechargeConfig();
      if (!cfg) {
        res.type('html').send(notConfiguredHtml(base));
        return;
      }

      const q = req.query as Record<string, unknown>;
      const token = resolveUserToken(req, { allowCookie: true }) ?? '';
      // 老链接上还挂着 ?token= 时，顺手转成会话 Cookie（已有 Cookie 就不覆盖）
      adoptTokenFromUrl(req, res, token);
      const message =
        q.ok === '1'
          ? { kind: 'ok' as const, text: String(q.msg ?? '充值已到账。') }
          : q.err
            ? { kind: 'err' as const, text: String(q.err) }
            : // decimals 缺失时入账必然被拒，直接把话说在前面，别让用户白转一笔
              cfg.tokenAddress && cfg.tokenDecimals === undefined
              ? {
                  kind: 'err' as const,
                  text: '充值暂不可用：收款代币的配置还不完整（缺少 decimals），请稍后再来或联系管理员。',
                }
              : undefined;

      const bill = billing.getUserBilling(user.id);
      res.type('html').send(
        rechargeHtml({
          base,
          token,
          cfg,
          rows: listRecharges({ userId: user.id }),
          balance: bill?.balance ?? 0,
          recharged: bill?.recharged ?? 0,
          message,
          pendingHash: typeof q.pending === 'string' && q.pending ? q.pending : undefined,
        }),
      );
    }),
  );

  router.post(
    '/recharge',
    requireSameOrigin,
    wrap(async (req: Request, res: Response) => {
      const base = deriveBase(req);
      const user = authenticateWebUserRequest(req);
      if (!user) {
        res.redirect(302, `${base}/login`);
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const txHash = String(body.txHash ?? '').trim();
      const token = String(body.token ?? '').trim();

      const back = new URL(`${base}/recharge`);
      if (token) back.searchParams.set('token', token);

      try {
        const { record, duplicated } = await submitRechargeTx({
          userId: user.id,
          username: user.username,
          txHash,
        });
        back.searchParams.set('ok', '1');
        back.searchParams.set(
          'msg',
          duplicated
            ? `该交易此前已入账（${record.points} 点），未重复加分。`
            : `充值成功，到账 ${record.points} 点。`,
        );
      } catch (err) {
        if (err instanceof RechargePendingError) {
          // 尚未确认：回到页面并让前端后台轮询，而不是把重试甩给用户
          back.searchParams.set('pending', txHash);
        } else {
          back.searchParams.set('err', err instanceof Error ? err.message : '补单失败');
        }
      }
      res.redirect(302, back.toString());
    }),
  );

  /**
   * 补单查询接口（前端轮询用）。
   * 202 + code=pending = 交易还没确认，前端应继续等；200 = 已入账。
   */
  router.post(
    '/recharge/claim',
    requireSameOrigin,
    wrap(async (req: Request, res: Response) => {
      const user = authenticateWebUserRequest(req);
      if (!user) {
        res.status(401).json({ ok: false, code: 'error', error: '未登录或令牌无效。' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const txHash = String(body.txHash ?? '').trim();
      try {
        const { record, duplicated } = await submitRechargeTx({
          userId: user.id,
          username: user.username,
          txHash,
        });
        res.json({
          ok: true,
          status: record.status,
          points: record.points,
          duplicated,
        });
      } catch (err) {
        const pending = err instanceof RechargePendingError;
        res.status(pending ? 202 : 400).json({
          ok: false,
          code: pending ? 'pending' : 'error',
          error: err instanceof Error ? err.message : '补单失败',
        });
      }
    }),
  );

  return router;
}
