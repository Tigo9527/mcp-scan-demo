import { MCPInput, MCPTool } from "mcp-framework";
import { z } from "zod";

const listCfxTransfersSchema = z.object({
  account: z
    .string()
    .trim()
    .min(1)
    .describe("Conflux Core account address whose native CFX transfers will be listed"),
  skip: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0)
    .describe("Number of transfer records to skip, from 0 to 10000"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Maximum number of transfer records to return, from 1 to 100"),
  from: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Only include transfers sent from this Conflux Core address"),
  to: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Only include transfers sent to this Conflux Core address"),
  minEpochNumber: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Minimum Conflux epoch number to include"),
  maxEpochNumber: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Maximum Conflux epoch number to include"),
  minTimestamp: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Minimum Unix timestamp in seconds to include"),
  maxTimestamp: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Maximum Unix timestamp in seconds to include"),
  sort: z
    .enum(["asc", "desc"])
    .default("desc")
    .describe("Sort transfers by timestamp in ascending or descending order"),
});

interface ConfluxScanResponse {
  code: number;
  message: string;
  data: unknown;
}

class ListCfxTransfersTool extends MCPTool {
  name = "list_cfx_transfers";
  description =
    "Lists native CFX transfer records for a Conflux Core account using the ConfluxScan API";
  schema = listCfxTransfersSchema;

  async execute(input: MCPInput<this>) {
    if (
      input.minEpochNumber !== undefined &&
      input.maxEpochNumber !== undefined &&
      input.minEpochNumber > input.maxEpochNumber
    ) {
      throw new Error("minEpochNumber must not be greater than maxEpochNumber");
    }

    if (
      input.minTimestamp !== undefined &&
      input.maxTimestamp !== undefined &&
      input.minTimestamp > input.maxTimestamp
    ) {
      throw new Error("minTimestamp must not be greater than maxTimestamp");
    }

    const apiBaseUrl =
      process.env.CONFLUXSCAN_API_URL ?? "https://api.confluxscan.org";
    const baseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
    const url = new URL("account/cfx/transfers", baseUrl);

    for (const [name, value] of Object.entries(input)) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

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

export default ListCfxTransfersTool;
