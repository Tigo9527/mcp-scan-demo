/**
 * ConfluxScan 只读查询工具的业务逻辑。
 *
 * 从 mcp-scan-demo（mcp-framework 版本）迁移而来，原样保留两个工具的
 * 参数语义、ConfluxScan Open API 端点与返回结构，仅把工具注册方式改为
 * 官方 @modelcontextprotocol/sdk 的 server.tool()。
 *
 * 两个端点：
 *  - list_cfx_transfers      -> GET {CONFLUXSCAN_API_URL}/account/cfx/transfers
 *  - list_latest_transactions -> GET {CONFLUXSCAN_WEB_API_URL}/v1/transaction
 *
 * 均为公开只读数据，无需鉴权；base URL 可用环境变量覆盖（见 .env.example）。
 */
import { z } from 'zod';

/** ConfluxScan Open API 的统一返回外壳。 */
export interface ConfluxScanResponse {
  code: number;
  message: string;
  data: unknown;
}

export const listCfxTransfersSchema = z.object({
  account: z
    .string()
    .trim()
    .min(1)
    .describe('要查询原生 CFX 转账记录的 Conflux Core 账户地址'),
  skip: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0)
    .describe('跳过的转账记录条数，0 ~ 10000'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('返回的最大转账记录条数，1 ~ 100'),
  from: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('只统计从该 Conflux Core 地址转出的交易'),
  to: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('只统计转入该 Conflux Core 地址的交易'),
  minEpochNumber: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('包含的最小 Conflux epoch 编号'),
  maxEpochNumber: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('包含的最大 Conflux epoch 编号'),
  minTimestamp: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('包含的最小 Unix 时间戳（秒）'),
  maxTimestamp: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('包含的最大 Unix 时间戳（秒）'),
  sort: z
    .enum(['asc', 'desc'])
    .default('desc')
    .describe('按时间升序或降序排列转账记录'),
});

export const listLatestTransactionsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('返回的最新交易最大条数，1 ~ 100'),
  skip: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('跳过的最新交易记录条数'),
});

/** ConfluxScan「全网转账流」(v1/transfer) 参数。 */
export const listTransfersSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('返回的最大转账记录条数，1 ~ 100'),
  skip: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('跳过的转账记录条数'),
});

export type ListCfxTransfersInput = z.input<typeof listCfxTransfersSchema>;
export type ListLatestTransactionsInput = z.input<typeof listLatestTransactionsSchema>;
export type ListTransfersInput = z.input<typeof listTransfersSchema>;

/** 统一解析 ConfluxScan 响应：非 2xx 或业务 code !== 0 都抛错。 */
async function request(url: string): Promise<ConfluxScanResponse> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`ConfluxScan 请求失败：HTTP ${response.status}`);
  }
  const json = (await response.json()) as ConfluxScanResponse;
  if (json.code !== 0) {
    throw new Error(`ConfluxScan API 错误 ${json.code}：${json.message}`);
  }
  return json;
}

/** 列出某 Conflux Core 账户的原生 CFX 转账记录。 */
export async function listCfxTransfers(
  input: ListCfxTransfersInput,
): Promise<ConfluxScanResponse> {
  // 显式应用默认值（不依赖调用方是否预填），保证 URL 始终带完整参数
  const params = listCfxTransfersSchema.parse(input);

  if (
    params.minEpochNumber !== undefined &&
    params.maxEpochNumber !== undefined &&
    params.minEpochNumber > params.maxEpochNumber
  ) {
    throw new Error('minEpochNumber 不能大于 maxEpochNumber');
  }
  if (
    params.minTimestamp !== undefined &&
    params.maxTimestamp !== undefined &&
    params.minTimestamp > params.maxTimestamp
  ) {
    throw new Error('minTimestamp 不能大于 maxTimestamp');
  }

  const apiBaseUrl = process.env.CONFLUXSCAN_API_URL ?? 'https://api.confluxscan.org';
  const baseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL('account/cfx/transfers', baseUrl);

  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(name, String(value));
    }
  }

  return request(url.toString());
}

/** 列出 Conflux Core 的最新交易。 */
export async function listLatestTransactions(
  input: ListLatestTransactionsInput,
): Promise<ConfluxScanResponse> {
  const params = listLatestTransactionsSchema.parse(input);
  const apiBaseUrl = process.env.CONFLUXSCAN_WEB_API_URL ?? 'https://www.confluxscan.org';
  const baseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL('v1/transaction', baseUrl);
  url.searchParams.set('limit', String(params.limit));
  url.searchParams.set('skip', String(params.skip));

  return request(url.toString());
}

/** 列出 ConfluxScan 全网最新的 CFX 转账记录。 */
export async function listTransfers(input: ListTransfersInput): Promise<ConfluxScanResponse> {
  const params = listTransfersSchema.parse(input);
  // 默认 testnet（ConfluxScan 的 v1/transfer 浏览器 API 在 testnet 子域最常用）；
  // 查主网时把 CONFLUXSCAN_TRANSFER_API_URL 设为 https://www.confluxscan.org 即可。
  const apiBaseUrl = process.env.CONFLUXSCAN_TRANSFER_API_URL ?? 'https://testnet.confluxscan.org';
  const baseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL('v1/transfer', baseUrl);
  url.searchParams.set('limit', String(params.limit));
  url.searchParams.set('skip', String(params.skip));
  url.searchParams.set('transferType', 'CFX');

  return request(url.toString());
}
