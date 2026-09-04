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

let stoppingAuthServices = false;
async function stopAuthServices(): Promise<void> {
  if (stoppingAuthServices) {
    return;
  }

  stoppingAuthServices = true;
  await auth.githubOAuthService?.stop();
  await auth.siweService?.stop();
}

process.once("SIGINT", () => {
  void stopAuthServices();
});
process.once("SIGTERM", () => {
  void stopAuthServices();
});

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
      cors: {
        allowHeaders: "Content-Type, Authorization, x-api-key, mcp-protocol-version, mcp-session-id",
      },
      health: {
        enabled: true,
        path: "/health",
      },
    },
  },
});

if (auth.githubOAuthService) {
  await auth.githubOAuthService.start();
  console.log(
    `GitHub OAuth service listening at http://${process.env.GITHUB_AUTH_HOST ?? host}:${process.env.GITHUB_AUTH_PORT ?? "8082"}`,
  );
}

if (auth.siweService) {
  await auth.siweService.start();
  console.log(
    `SIWE authentication service listening at http://${process.env.SIWE_AUTH_HOST ?? host}:${process.env.SIWE_AUTH_PORT ?? "8081"}`,
  );
}

try {
  await server.start();
} catch (error) {
  await stopAuthServices();
  throw error;
}
console.log(
  `MCP server listening at http://${host}:${port}/mcp using ${auth.mode} authentication`,
);
