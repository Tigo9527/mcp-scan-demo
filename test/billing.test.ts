import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordCall,
  checkAllowed,
  getBalance,
  getUserBilling,
  getTotalBilling,
  getToolCost,
  getPricingTable,
  resetBilling,
  creditBalance,
} from '../src/billing.js';
import { config } from '../src/config.js';

describe('计费账本（billing）', () => {
  beforeEach(() => resetBilling());

  it('差异化定价：内部/引导工具免费，外部 API 类工具较贵', () => {
    expect(getToolCost('whoami')).toBe(0);
    expect(getToolCost('server_info')).toBe(0);
    expect(getToolCost('search_repos')).toBe(5);
    expect(getToolCost('list_cfx_transfers')).toBe(10);
    expect(getToolCost('list_latest_transactions')).toBe(10);
  });

  it('未知工具回退默认单价', () => {
    expect(getToolCost('totally_unknown_tool')).toBe(1);
  });

  it('收费工具调用扣减余额并累加已消耗', () => {
    recordCall('user-1', 'search_repos'); // cost 5
    recordCall('user-1', 'list_cfx_transfers'); // cost 10
    const bill = getUserBilling('user-1')!;
    expect(bill.used).toBe(15);
    expect(bill.balance).toBe(config.billingFreeCredits - 15);
    expect(getBalance('user-1')).toBe(config.billingFreeCredits - 15);
  });

  it('免费工具不扣减余额', () => {
    recordCall('user-2', 'whoami');
    recordCall('user-2', 'my_stats');
    const bill = getUserBilling('user-2')!;
    expect(bill.used).toBe(0);
    expect(bill.balance).toBe(config.billingFreeCredits);
  });

  it('匿名调用归入 anonymous 桶，仅计消耗、无余额', () => {
    recordCall(null, 'search_repos'); // cost 5
    recordCall(undefined, 'list_cfx_transfers'); // cost 10
    const total = getTotalBilling();
    expect(total.anonymousUsed).toBe(15);
    expect(total.used).toBe(15);
    expect(total.users).toBe(0);
    // 匿名桶余额恒为 0 / 缺省
    expect(getUserBilling('anonymous')?.used).toBe(15);
  });

  it('checkAllowed：免费工具永远放行', () => {
    expect(checkAllowed('user-3', 'whoami').allowed).toBe(true);
    expect(checkAllowed(null, 'whoami').allowed).toBe(true);
  });

  it('checkAllowed：匿名调用收费工具需登录', () => {
    const a = checkAllowed(null, 'search_repos');
    expect(a.allowed).toBe(false);
    expect(a.reason).toBe('login_required');
    expect(a.cost).toBe(5);
  });

  it('checkAllowed：已登录余额不足则拒绝', () => {
    // 把余额消耗到只剩 3 点（free=1000，扣 997）
    for (let i = 0; i < 99; i += 1) recordCall('user-4', 'list_cfx_transfers'); // 99*10=990
    recordCall('user-4', 'search_repos'); // +5 = 995，余额剩 5
    expect(getBalance('user-4')).toBe(config.billingFreeCredits - 995);
    // search_repos 单价 5，余额恰够
    expect(checkAllowed('user-4', 'search_repos').allowed).toBe(true);
    // 再扣一次后余额变负，list_cfx_transfers（10）应被拒
    recordCall('user-4', 'search_repos');
    const a = checkAllowed('user-4', 'list_cfx_transfers');
    expect(a.allowed).toBe(false);
    expect(a.reason).toBe('insufficient_balance');
    expect(a.balance).toBeLessThan(10);
  });

  it('getTotalBilling 聚合所有用户（按消耗降序）', () => {
    recordCall('u-a', 'list_cfx_transfers'); // 10
    recordCall('u-a', 'list_cfx_transfers'); // 10 -> 20
    recordCall('u-b', 'search_repos'); // 5
    const total = getTotalBilling();
    expect(total.used).toBe(25);
    expect(total.users).toBe(2);
    expect(total.byUser[0]!.userId).toBe('u-a');
    expect(total.byUser[0]!.used).toBe(20);
    expect(total.byUser[1]!.userId).toBe('u-b');
  });

  it('getPricingTable 按单价降序返回', () => {
    const table = getPricingTable();
    expect(table[0]!.cost).toBeGreaterThanOrEqual(table[table.length - 1]!.cost);
    expect(table.find((t) => t.tool === 'list_cfx_transfers')?.cost).toBe(10);
  });

  it('creditBalance 充值加余额并累计 recharged', () => {
    recordCall('u-r', 'search_repos'); // -5
    const before = getBalance('u-r');
    const entry = creditBalance('u-r', 100);
    expect(entry.recharged).toBe(100);
    expect(entry.balance).toBe(before + 100);
    // 再充一次，累加而非覆盖
    creditBalance('u-r', 50);
    expect(getUserBilling('u-r')!.recharged).toBe(150);
    expect(getTotalBilling().rechargedTotal).toBe(150);
  });

  it('creditBalance 拒绝非法入参（不静默吞掉充值）', () => {
    expect(() => creditBalance('', 10)).toThrow();
    expect(() => creditBalance('u-r2', 0)).toThrow();
    expect(() => creditBalance('u-r2', Number.NaN)).toThrow();
    expect(getTotalBilling().rechargedTotal).toBe(0);
  });
});
