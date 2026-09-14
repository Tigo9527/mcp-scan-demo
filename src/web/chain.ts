/**
 * 前端「链 / 网络」处理：比对钱包的 chainId 与服务端配置的目标链，不一致就切换。
 *
 * 为什么必须做：收款地址在不同链上是不同的账本。用户在 BSC 上往「以太坊地址」转 USDT，
 * 钱照样转出去，但服务端按配置的链去查永远查不到——对用户就是「钱没了」。
 * 所以转账前必须确认钱包停在同一条链上。
 *
 * 这里只导出**脚本源码字符串**：页面是服务端渲染的，没有打包器，
 * 复用靠「拼进 <script>」，和 layout.ts 里的 copy 脚本一个路子。
 */
import type { ChainAddParams } from '../recharge.js';

/** 注入到前端的链信息（只含前端必需字段，不含任何敏感配置） */
export interface ChainView {
  /** 目标链 ID，小写十六进制，如 `0x1`；未配置时为空串 */
  chainId: string;
  /** 十进制，用于展示 */
  chainIdDec: string;
  /** 已知链的中文名；未知时为空串（前端退化成 `Chain <id>`） */
  name: string;
  /** wallet_addEthereumChain 的参数；缺少 chainId 时为 null */
  addParams: ChainAddParams | null;
}

/**
 * 前端切链函数源码。
 *
 * 约定：调用方在自己的 IIFE 里 eval/内联这段代码，得到
 *   `ensureChain(eth, chain, setStatus)` —— 成功返回 true，失败抛 Error（带中文说明）。
 * `chain.chainId` 为空（管理员没配 / 没读到）时直接放行，不折腾用户。
 */
export const ENSURE_CHAIN_JS = `
function hexToDec(h){try{return BigInt(h).toString(10);}catch(e){return String(h);}}
function sameChain(a,b){return String(a||'').toLowerCase()===String(b||'').toLowerCase();}
function chainLabel(chain,id){
  var d=hexToDec(id);
  return (chain&&chain.name)?chain.name:('Chain '+d);
}
async function ensureChain(eth,chain,setStatus){
  if(!chain||!chain.chainId) return true;
  var cur=await eth.request({method:'eth_chainId'});
  if(sameChain(cur,chain.chainId)) return true;
  var target=chainLabel(chain,chain.chainId);
  if(setStatus) setStatus('当前网络是 '+hexToDec(cur)+'，需要切换到 '+target+'（链 ID '+hexToDec(chain.chainId)+'），请在钱包中确认…');
  try{
    await eth.request({method:'wallet_switchEthereumChain',params:[{chainId:chain.chainId}]});
  }catch(e){
    var msg=(e&&e.message)?String(e.message):'';
    var notAdded=(e&&e.code===4902)||/unrecognized chain|chain.*(?:has not been|not).*added|wallet_addEthereumChain/i.test(msg);
    if(!notAdded) throw e;
    if(!chain.addParams) throw new Error('你的钱包里还没有这条链，请手动添加后重试（链 ID '+hexToDec(chain.chainId)+'）。');
    if(setStatus) setStatus('钱包里没有 '+target+'，正在请求添加…');
    try{
      await eth.request({method:'wallet_addEthereumChain',params:[chain.addParams]});
    }catch(e2){
      // 部分钱包 add 成功也会抛错（MetaMask 已知行为）：忽略，下面复查一次真实 chainId
    }
  }
  var after=await eth.request({method:'eth_chainId'});
  if(!sameChain(after,chain.chainId)){
    throw new Error('钱包仍停留在链 '+hexToDec(after)+'，请手动切换到 '+target+' 后重试。');
  }
  if(setStatus) setStatus('已切换到 '+target+'（链 ID '+hexToDec(after)+'）。');
  return true;
}
`;

/** 供测试与页面断言用：这段脚本必须包含这些关键调用，少了就说明切链被改坏了。 */
export const ENSURE_CHAIN_MARKERS = [
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'eth_chainId',
] as const;
