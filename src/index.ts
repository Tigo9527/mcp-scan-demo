import "dotenv/config";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MCPServer } from "mcp-framework";

import { createAuthConfiguration } from "./auth/createAuthConfig.js";

function readPort(value: string | undefined): number {
  const port = Number(value ?? "8080");

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MCP_PORT must be an integer between 1 and 65535");
  }

  return port;
}

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = readPort(process.env.MCP_PORT);
const basePath = dirname(fileURLToPath(import.meta.url));
const auth = createAuthConfiguration();

const server = new MCPServer({
  name: "mcp-scan-demo",
  version: "1.0.0",
  basePath,
  transport: {
    type: "http-stream",
    auth: auth.config,
    options: {
      host,
      port,
      endpoint: "/mcp",
      responseMode: "batch",
      health: {
        enabled: true,
        path: "/health",
      },
    },
  },
});

await server.start();
console.log(
  `MCP server listening at http://${host}:${port}/mcp using ${auth.mode} authentication`,
);
