/**
 * ConfluxScan 只读查询工具（list_cfx_transfers / list_latest_transactions）的单元测试。
 *
 * 直接 mock 全局 fetch，验证：
 *  - 两个端点拼接的 URL 与默认 base URL 正确；
 *  - 全部非空参数都进入 query string；
 *  - epoch / timestamp 区间校验在发起请求前短路抛错；
 *  - 业务 code !== 0 与 HTTP 非 2xx 都抛错；
 *  - 可用环境变量覆盖 API 基地址；
 *  - 两个工具已退出 PUBLIC_MCP_TOOLS，需登录后才能调用。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as confluxscan from '../src/confluxscan.js';
import { PUBLIC_MCP_TOOLS } from '../src/mcp/server.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  delete process.env.CONFLUXSCAN_API_URL;
  delete process.env.CONFLUXSCAN_WEB_API_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

describe('list_cfx_transfers（ConfluxScan Open API）', () => {
  it('拼接 account/cfx/transfers 并携带全部非空参数', async () => {
    fetchMock.mockImplementation(async () => okResponse({ code: 0, message: 'OK', data: [] }));
    const res = await confluxscan.listCfxTransfers({
      account: 'cfx:aanjcf1esdz50j6zhkm0k60wc7669tfkw28mzudg24',
      limit: 5,
      from: 'cfx:a',
      minTimestamp: 1000,
    });
    expect(res.code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('api.confluxscan.org/account/cfx/transfers');
    expect(url).toContain(
      'account=cfx%3Aaanjcf1esdz50j6zhkm0k60wc7669tfkw28mzudg24',
    );
    expect(url).toContain('limit=5');
    expect(url).toContain('skip=0');
    expect(url).toContain('sort=desc');
    expect(url).toContain('from=cfx%3Aa');
    expect(url).toContain('minTimestamp=1000');
  });

  it('minEpochNumber > maxEpochNumber 直接抛错且不发起请求', async () => {
    await expect(
      confluxscan.listCfxTransfers({
        account: 'cfx:x',
        minEpochNumber: 10,
        maxEpochNumber: 5,
      }),
    ).rejects.toThrow(/minEpochNumber/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('minTimestamp > maxTimestamp 直接抛错', async () => {
    await expect(
      confluxscan.listCfxTransfers({
        account: 'cfx:x',
        minTimestamp: 20,
        maxTimestamp: 10,
      }),
    ).rejects.toThrow(/minTimestamp/);
  });

  it('业务 code !== 0 抛错', async () => {
    fetchMock.mockImplementation(
      async () => okResponse({ code: 1, message: 'bad param', data: null }),
    );
    await expect(confluxscan.listCfxTransfers({ account: 'cfx:x' })).rejects.toThrow(
      /bad param/,
    );
  });

  it('HTTP 非 2xx 抛错', async () => {
    fetchMock.mockImplementation(
      async () =>
        ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response,
    );
    await expect(confluxscan.listCfxTransfers({ account: 'cfx:x' })).rejects.toThrow(/500/);
  });

  it('可用环境变量覆盖 API 基地址（测试网）', async () => {
    process.env.CONFLUXSCAN_API_URL = 'https://api-testnet.confluxscan.org';
    fetchMock.mockImplementation(async () => okResponse({ code: 0, message: 'OK', data: [] }));
    await confluxscan.listCfxTransfers({ account: 'cfx:x' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('api-testnet.confluxscan.org/account/cfx/transfers');
  });
});

describe('list_latest_transactions（ConfluxScan 浏览器 API）', () => {
  it('拼接 v1/transaction 并携带 limit/skip', async () => {
    fetchMock.mockImplementation(async () => okResponse({ code: 0, message: 'OK', data: [] }));
    await confluxscan.listLatestTransactions({ limit: 3, skip: 2 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('www.confluxscan.org/v1/transaction');
    expect(url).toContain('limit=3');
    expect(url).toContain('skip=2');
  });

  it('HTTP 非 2xx 抛错', async () => {
    fetchMock.mockImplementation(
      async () =>
        ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response,
    );
    await expect(confluxscan.listLatestTransactions({})).rejects.toThrow(/502/);
  });
});

describe('登录保护', () => {
  it('两个 conflux scan 工具不在 PUBLIC_MCP_TOOLS 中（需登录后才能调用）', () => {
    expect(PUBLIC_MCP_TOOLS.has('list_cfx_transfers')).toBe(false);
    expect(PUBLIC_MCP_TOOLS.has('list_latest_transactions')).toBe(false);
  });
});
