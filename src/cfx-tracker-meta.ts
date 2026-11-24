import cfxAddress from '@conflux-dev/conflux-address-js';
import { BINANCE_CFX } from './cfx-tracker.js';

export type TrackerAddressMeta = { kind?: 'builtin' | 'contract'; name?: string; tag?: string };
export type TrackerMetadata = Map<string, TrackerAddressMeta>;

const BUILTINS: Record<string, string> = {
  '0x0888000000000000000000000000000000000000': 'AdminControl',
  '0x0888000000000000000000000000000000000001': 'SponsorWhitelistControl',
  '0x0888000000000000000000000000000000000002': 'Staking',
  '0x0888000000000000000000000000000000000004': 'ConfluxContext',
  '0x0888000000000000000000000000000000000005': 'PoSRegister',
  '0x0888000000000000000000000000000000000006': 'CrossSpaceCall',
  '0x0888000000000000000000000000000000000007': 'ParamsControl',
};
const cache = new Map<string, { value: TrackerAddressMeta; expires: number }>();
const CACHE_MS = 30 * 60 * 1000;
const minerCache = new Map<string, { mined: boolean; expires: number }>();

export function localAddressMeta(address: string): TrackerAddressMeta {
  const result: TrackerAddressMeta = address.toLowerCase() === BINANCE_CFX ? { tag: '币安钱包 · 追踪起点' } : {};
  if (!address.startsWith('cfx:')) return result;
  try {
    const decoded = cfxAddress.decode(address);
    if (decoded.type === 'builtin') {
      const hex = `0x${Buffer.from(decoded.hexAddress).toString('hex')}`;
      result.kind = 'builtin';
      result.name = BUILTINS[hex];
    } else if (decoded.type === 'contract') result.kind = 'contract';
  } catch { /* 外部数据中的非法地址不阻断页面 */ }
  return result;
}

function usefulName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 100) : undefined;
}

async function scanJson(url: URL, fetcher: typeof fetch): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    if (!json || typeof json !== 'object') return null;
    const envelope = json as Record<string, unknown>;
    if (envelope.code !== 0 && envelope.status !== '1') return null;
    const data = envelope.data ?? envelope.result;
    return data && typeof data === 'object' ? data as Record<string, unknown> : null;
  } catch { return null; }
}

/** Scan 的 /v1/nametag 可批量读标签，/v1/contract/:address 可读已验证合约名。失败时使用本地标注。 */
export async function lookupTrackerMetadata(addresses: string[], fetcher: typeof fetch = fetch): Promise<TrackerMetadata> {
  const unique = [...new Set(addresses)];
  const now = Date.now();
  const missing = unique.filter(address => !cache.get(address) || cache.get(address)!.expires < now);
  if (missing.length) {
    const fresh = new Map(missing.map(address => [address, localAddressMeta(address)]));
    const groups = [
      { base: 'https://www.confluxscan.org', addresses: missing.filter(address => address.startsWith('cfx:')) },
      { base: 'https://evm.confluxscan.org', addresses: missing.filter(address => address.startsWith('0x')) },
    ];
    const jobs: Promise<void>[] = [];
    for (const group of groups) {
      for (let i = 0; i < group.addresses.length; i += 40) {
        const batch = group.addresses.slice(i, i + 40);
        const url = new URL('/v1/nametag', group.base);
        for (const address of batch) url.searchParams.append('address', address);
        jobs.push(scanJson(url, fetcher).then(data => {
          const map = data?.map;
          if (!map || typeof map !== 'object') return;
          for (const address of batch) {
            const entry = (map as Record<string, unknown>)[address];
            const tag = usefulName(typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry as Record<string, unknown>).nameTag : undefined);
            if (tag && address !== BINANCE_CFX) fresh.get(address)!.tag = tag;
          }
        }));
      }
    }
    for (const address of missing.filter(address => fresh.get(address)?.kind === 'contract').slice(0, 12)) {
      jobs.push(scanJson(new URL(`/v1/contract/${address}`, 'https://www.confluxscan.org'), fetcher).then(data => {
        const name = usefulName(data?.name);
        if (name) fresh.get(address)!.name = name;
      }));
    }
    await Promise.all(jobs);
    for (const [address, value] of fresh) cache.set(address, { value, expires: now + CACHE_MS });
  }
  return new Map(unique.map(address => [address, cache.get(address)!.value]));
}

/** 仅用实际区块的 miner 字段确认矿工；Scan 失败时不作标记。 */
export async function lookupMinerAddresses(addresses: string[], fetcher: typeof fetch = fetch): Promise<Set<string>> {
  const unique = [...new Set(addresses.filter(address => address.startsWith('cfx:')))];
  const now = Date.now();
  const missing = unique.filter(address => !minerCache.get(address) || minerCache.get(address)!.expires < now);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, missing.length) }, async () => {
    while (next < missing.length) {
      const address = missing[next++];
      const url = new URL('/v1/block', 'https://www.confluxscan.org');
      url.searchParams.set('miner', address);
      url.searchParams.set('limit', '1');
      const data = await scanJson(url, fetcher);
      const first = Array.isArray(data?.list) ? data.list[0] : undefined;
      const mined = !!first && typeof first === 'object' &&
        (first as Record<string, unknown>).miner?.toString().toLowerCase() === address.toLowerCase();
      minerCache.set(address, { mined, expires: now + CACHE_MS });
    }
  }));
  return new Set(unique.filter(address => minerCache.get(address)?.mined));
}
