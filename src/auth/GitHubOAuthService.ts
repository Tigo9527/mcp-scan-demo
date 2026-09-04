import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { z } from "zod";

import type { GitHubOAuthAuthProviderConfig } from "./GitHubOAuthAuthProvider.js";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("bearer"),
  scope: z.string().default(""),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

interface StateRecord {
  expiresAt: number;
}

class GitHubOAuthError extends Error {}

export class GitHubOAuthService {
  private readonly states = new Map<string, StateRecord>();
  private server?: Server;

  constructor(private readonly config: GitHubOAuthAuthProviderConfig) {}

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("GitHub OAuth service is already running");
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response);
      });

      server.once("error", reject);
      server.listen(this.config.authPort, this.config.authHost, () => {
        server.off("error", reject);
        server.on("error", (error) => {
          console.error("GitHub OAuth service error:", error);
        });
        this.server = server;
        resolve();
      });
      },
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.server = undefined;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (!this.validateOrigin(request, response)) {
        return;
      }

      this.setCorsHeaders(response);

      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }

      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );

      if (request.method === "GET" && url.pathname === "/auth/github") {
        this.handleIndex(response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/github/login") {
        this.handleLogin(response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/github/callback") {
        await this.handleCallback(url, response);
        return;
      }

      this.sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof GitHubOAuthError) {
        this.sendJson(response, 400, { error: error.message });
        return;
      }

      console.error("GitHub OAuth request failed:", error);
      this.sendJson(response, 500, { error: "Internal server error" });
    }
  }

  private handleIndex(response: ServerResponse): void {
    const loginUrl = "/auth/github/login";
    this.sendHtml(
      response,
      200,
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ConfluxScan MCP GitHub OAuth</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fa; color: #24292f; }
    main { width: min(520px, calc(100vw - 32px)); }
    h1 { font-size: 24px; margin: 0 0 12px; }
    p { line-height: 1.5; margin: 0 0 20px; }
    a { display: inline-block; background: #24292f; color: white; padding: 10px 14px; border-radius: 6px; text-decoration: none; font-weight: 600; }
    @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #c9d1d9; } a { background: #238636; } }
  </style>
</head>
<body>
  <main>
    <h1>ConfluxScan MCP GitHub OAuth</h1>
    <p>Sign in with GitHub to get an access token for MCP requests.</p>
    <a href="${loginUrl}">Sign in with GitHub</a>
  </main>
</body>
</html>`,
    );
  }

  private handleLogin(response: ServerResponse): void {
    this.pruneExpiredStates();

    const state = randomBytes(32).toString("base64url");
    this.states.set(state, {
      expiresAt: Date.now() + this.config.stateTtlSeconds * 1000,
    });

    const authorizeUrl = new URL(`${this.config.authorizationServer}/authorize`);
    authorizeUrl.searchParams.set("client_id", this.config.clientId);
    authorizeUrl.searchParams.set("redirect_uri", this.config.redirectUri);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set(
      "scope",
      this.config.requestedScopes.join(" "),
    );

    response.writeHead(302, { Location: authorizeUrl.toString() }).end();
  }

  private async handleCallback(
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const error = url.searchParams.get("error");
    if (error) {
      throw new GitHubOAuthError(
        url.searchParams.get("error_description") ?? error,
      );
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      throw new GitHubOAuthError(
        "GitHub OAuth callback is missing code or state",
      );
    }

    const stateRecord = this.states.get(state);
    this.states.delete(state);
    if (!stateRecord || stateRecord.expiresAt <= Date.now()) {
      throw new GitHubOAuthError(
        "GitHub OAuth state is missing, expired, or already used",
      );
    }

    const token = await this.exchangeCodeForToken(code);
    const tokenScopes = token.scope
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const missingScopes = this.config.requiredScopes.filter(
      (scope) => !tokenScopes.includes(scope),
    );
    if (missingScopes.length > 0) {
      throw new GitHubOAuthError(
        `GitHub OAuth token is missing required scopes: ${missingScopes.join(", ")}`,
      );
    }

    if (this.config.successRedirectUri) {
      const redirectUrl = new URL(this.config.successRedirectUri);
      redirectUrl.hash = new URLSearchParams({
        access_token: token.access_token,
        token_type: token.token_type,
        scope: token.scope,
      }).toString();
      response.writeHead(302, { Location: redirectUrl.toString() }).end();
      return;
    }

    this.sendTokenPage(
      response,
      token.access_token,
      token.token_type,
      token.scope,
    );
  }

  private async exchangeCodeForToken(code: string) {
    const response = await fetch(
      this.config.authorizationServer + "/access_token",
      {
        method: "POST",
        headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
        body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUri,
      }),
    });

    if (!response.ok) {
      throw new GitHubOAuthError(
        `GitHub token endpoint returned ${response.status}`,
      );
    }

    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new GitHubOAuthError("GitHub token endpoint returned an invalid response");
    }

    if (parsed.data.error) {
      throw new GitHubOAuthError(
        parsed.data.error_description ?? parsed.data.error,
      );
    }

    return parsed.data;
  }

  private sendTokenPage(
    response: ServerResponse,
    accessToken: string,
    tokenType: string,
    scope: string,
  ): void {
    const escapedToken = this.escapeHtml(accessToken);
    this.sendHtml(
      response,
      200,
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GitHub OAuth Complete</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fa; color: #24292f; }
    main { width: min(760px, calc(100vw - 32px)); }
    h1 { font-size: 24px; margin: 0 0 12px; }
    p { line-height: 1.5; }
    code { display: block; overflow-wrap: anywhere; padding: 12px; border: 1px solid #d0d7de; border-radius: 6px; background: #ffffff; }
    @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #c9d1d9; } code { background: #161b22; border-color: #30363d; } }
  </style>
</head>
<body>
  <main>
    <h1>GitHub OAuth Complete</h1>
    <p>Use this bearer token for MCP requests.</p>
    <code>Authorization: Bearer ${escapedToken}</code>
    <p>Token type: ${this.escapeHtml(tokenType)}<br>Scopes: ${this.escapeHtml(scope || "none")}</p>
  </main>
</body>
</html>`,
    );
  }

  private validateOrigin(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const origin = request.headers.origin;
    if (
      !origin ||
      this.config.allowedOrigin === "*" ||
      origin === this.config.allowedOrigin
    ) {
      return true;
    }

    this.sendJson(response, 403, { error: "Origin is not allowed" });
    return false;
  }

  private setCorsHeaders(response: ServerResponse): void {
    response.setHeader("Access-Control-Allow-Origin", this.config.allowedOrigin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ): void {
    if (response.headersSent) {
      return;
    }

    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(body));
  }

  private sendHtml(
    response: ServerResponse,
    status: number,
    html: string,
  ): void {
    if (response.headersSent) {
      return;
    }

    response.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(html);
  }

  private pruneExpiredStates(): void {
    const now = Date.now();
    for (const [state, record] of this.states) {
      if (record.expiresAt <= now) {
        this.states.delete(state);
      }
    }
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
}
