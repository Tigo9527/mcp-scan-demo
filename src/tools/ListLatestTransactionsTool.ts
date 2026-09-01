import { MCPInput, MCPTool } from "mcp-framework";
import { z } from "zod";

const listLatestTransactionsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Maximum number of latest transactions to return, from 1 to 100"),
  skip: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Number of latest transaction records to skip"),
});

interface ConfluxScanResponse {
  code: number;
  message: string;
  data: unknown;
}

class ListLatestTransactionsTool extends MCPTool {
  name = "list_latest_transactions";
  description =
    "Lists the latest Conflux Core transactions from the ConfluxScan explorer";
  schema = listLatestTransactionsSchema;

  async execute(input: MCPInput<this>) {
    const apiBaseUrl =
      process.env.CONFLUXSCAN_WEB_API_URL ?? "https://www.confluxscan.org";
    const baseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
    const url = new URL("v1/transaction", baseUrl);

    url.searchParams.set("limit", String(input.limit));
    url.searchParams.set("skip", String(input.skip));

    const response = await this.fetch<ConfluxScanResponse>(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });

    if (response.code !== 0) {
      throw new Error(
        `ConfluxScan API error ${response.code}: ${response.message}`,
      );
    }

    return response;
  }
}

export default ListLatestTransactionsTool;
