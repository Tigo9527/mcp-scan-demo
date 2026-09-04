import "dotenv/config";

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
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
const endpoint = "/mcp";
const oauthMetadataEndpoint = "/.well-known/oauth-protected-resource";
const healthEndpoint = "/health";

let stoppingAuthServices = false;
async function stopAuthServices(): Promise<void> {
  if (stoppingAuthServices) {
    return;
  }

  stoppingAuthServices = true;
  await auth.githubOAuthService?.stop();
  await auth.siweService?.stop();
}

const server = new MCPServer({
  name: "mcp-scan-demo",
  version: "1.0.0",
  basePath,
  auth: auth.config,
});

const httpServer = createServer((request, response) => {
  void (async () => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`,
    );

    if (auth.githubOAuthService && isGitHubOAuthPath(url.pathname)) {
      await auth.githubOAuthService.handleRequest(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === healthEndpoint) {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === endpoint || url.pathname === oauthMetadataEndpoint) {
      const webResponse = await server.handleRequest(toWebRequest(request));
      await sendWebResponse(response, webResponse);
      return;
    }

    response.writeHead(404).end("Not Found");
  })().catch((error) => {
    console.error("HTTP request failed:", error);
    if (!response.headersSent) {
      response.writeHead(500).end("Internal Server Error");
    }
  });
});

async function stopHttpServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  await stopAuthServices();
}

process.once("SIGINT", () => {
  void stopHttpServer();
});
process.once("SIGTERM", () => {
  void stopHttpServer();
});

function isGitHubOAuthPath(pathname: string): boolean {
  return pathname === "/auth/github" || pathname.startsWith("/auth/github/");
}

function toWebRequest(request: IncomingMessage): Request {
  const origin = `http://${request.headers.host ?? `${host}:${port}`}`;
  const url = new URL(request.url ?? "/", origin);
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }

    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const method = request.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body:
      method === "GET" || method === "HEAD"
        ? undefined
        : (Readable.toWeb(request) as unknown as BodyInit),
    duplex: "half",
  };

  return new Request(url, init);
}

async function sendWebResponse(
  response: ServerResponse,
  webResponse: Response,
): Promise<void> {
  response.statusCode = webResponse.status;
  response.statusMessage = webResponse.statusText;

  webResponse.headers.forEach((value, name) => {
    response.setHeader(name, value);
  });

  if (!webResponse.body) {
    response.end();
    return;
  }

  const body = Readable.fromWeb(
    webResponse.body as unknown as NodeReadableStream<Uint8Array>,
  );
  body.pipe(response);
  await new Promise<void>((resolve, reject) => {
    body.once("end", resolve);
    body.once("error", reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

if (auth.siweService) {
  await auth.siweService.start();
  console.log(
    `SIWE authentication service listening at http://${process.env.SIWE_AUTH_HOST ?? host}:${process.env.SIWE_AUTH_PORT ?? "8081"}`,
  );
}

try {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      httpServer.on("error", (error) => {
        console.error("HTTP server error:", error);
      });
      resolve();
    });
  });
} catch (error) {
  await stopAuthServices();
  throw error;
}

console.log(
  `MCP server listening at http://${host}:${port}${endpoint} using ${auth.mode} authentication`,
);
if (auth.githubOAuthService) {
  console.log(
    `GitHub OAuth routes mounted at http://${host}:${port}/auth/github`,
  );
}
