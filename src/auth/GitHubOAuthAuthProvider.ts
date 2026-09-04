import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  OAuthAuthProvider,
  type AuthResult,
} from "mcp-framework";
import { z } from "zod";

const githubTokenSchema = z.object({
  id: z.number(),
  url: z.string(),
  app: z.object({
    client_id: z.string().optional(),
    name: z.string().optional(),
  }).passthrough(),
  token: z.string().optional(),
  hashed_token: z.string().optional(),
  token_last_eight: z.string().optional(),
  note: z.string().nullable().optional(),
  note_url: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  scopes: z.array(z.string()).default([]),
  fingerprint: z.string().nullable().optional(),
  user: z.object({
    id: z.number(),
    login: z.string(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    avatar_url: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
  }).passthrough(),
  expires_at: z.string().nullable().optional(),
}).passthrough();

export interface GitHubOAuthAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  resource: string;
  authorizationServer: string;
  apiBaseUrl: string;
  apiVersion: string;
  requiredScopes: string[];
  requestedScopes: string[];
  cacheTtlMs: number;
  authHost: string;
  authPort: number;
  redirectUri: string;
  allowedOrigin: string;
  stateTtlSeconds: number;
  successRedirectUri?: string;
}

interface CachedAuthResult {
  expiresAt: number;
  authResult: AuthResult;
}

export class GitHubOAuthAuthProvider extends OAuthAuthProvider {
  private readonly cache = new Map<string, CachedAuthResult>();

  constructor(private readonly githubConfig: GitHubOAuthAuthProviderConfig) {
    super({
      authorizationServers: [githubConfig.authorizationServer],
      resource: githubConfig.resource,
      validation: {
        type: "introspection",
        audience: githubConfig.resource,
        issuer: githubConfig.authorizationServer,
        introspection: {
          endpoint: `${githubConfig.apiBaseUrl}/applications/${githubConfig.clientId}/token`,
          clientId: githubConfig.clientId,
          clientSecret: githubConfig.clientSecret,
          cacheTTL: githubConfig.cacheTtlMs,
        },
      },
    });
  }

  override async authenticate(request: IncomingMessage): Promise<boolean | AuthResult> {
    const token = this.extractBearerToken(request);
    if (!token) {
      return false;
    }

    const cached = this.getCachedResult(token);
    if (cached) {
      return cached;
    }

    const authResult = await this.validateGitHubToken(token);
    if (!authResult) {
      return false;
    }

    this.cacheResult(token, authResult);
    return authResult;
  }

  private extractBearerToken(request: IncomingMessage): string | null {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") {
      return null;
    }

    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    return match?.[1] ?? null;
  }

  private async validateGitHubToken(token: string): Promise<AuthResult | false> {
    const response = await fetch(
      `${this.githubConfig.apiBaseUrl}/applications/${this.githubConfig.clientId}/token`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Basic ${Buffer.from(
            `${this.githubConfig.clientId}:${this.githubConfig.clientSecret}`,
          ).toString("base64")}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": this.githubConfig.apiVersion,
        },
        body: JSON.stringify({
          access_token: token,
        }),
      },
    );

    if (!response.ok) {
      return false;
    }

    const parsed = githubTokenSchema.safeParse(await response.json());
    if (!parsed.success) {
      return false;
    }

    const missingScopes = this.githubConfig.requiredScopes.filter(
      (scope) => !parsed.data.scopes.includes(scope),
    );
    if (missingScopes.length > 0) {
      return false;
    }

    const tokenExpiresAt = this.parseExpiresAt(parsed.data.expires_at);
    if (tokenExpiresAt !== null && tokenExpiresAt <= Date.now()) {
      return false;
    }

    return {
      data: {
        authMethod: "github-oauth",
        provider: "github",
        githubUserId: parsed.data.user.id,
        githubLogin: parsed.data.user.login,
        githubName: parsed.data.user.name,
        githubEmail: parsed.data.user.email,
        githubScopes: parsed.data.scopes,
        githubTokenExpiresAt: parsed.data.expires_at,
      },
    };
  }

  private getCachedResult(token: string): AuthResult | null {
    const tokenHash = this.hashToken(token);
    const cached = this.cache.get(tokenHash);

    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(tokenHash);
      return null;
    }

    return cached.authResult;
  }

  private cacheResult(token: string, authResult: AuthResult): void {
    const tokenHash = this.hashToken(token);
    this.cache.set(tokenHash, {
      expiresAt: Date.now() + this.githubConfig.cacheTtlMs,
      authResult,
    });
  }

  private parseExpiresAt(expiresAt: string | null | undefined): number | null {
    if (!expiresAt) {
      return null;
    }

    const timestamp = Date.parse(expiresAt);
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
