import {
  OAuthAuthProvider,
  type AuthConfig,
} from "mcp-framework";

import { BearerTokenAuthProvider } from "./BearerTokenAuthProvider.js";
import {
  GitHubOAuthAuthProvider,
  type GitHubOAuthAuthProviderConfig,
} from "./GitHubOAuthAuthProvider.js";
import { GitHubOAuthService } from "./GitHubOAuthService.js";
import {
  SiweAuthService,
  type SiweAuthServiceConfig,
} from "./SiweAuthService.js";

export type AuthMode = "bearer" | "oauth" | "github-oauth" | "siwe";

export interface AuthConfiguration {
  config: AuthConfig;
  mode: AuthMode;
  githubOAuthService?: GitHubOAuthService;
  siweService?: SiweAuthService;
}

function requireEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  mode: AuthMode,
): string {
  const value = env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable for ${mode} authentication: ${name}`,
    );
  }

  return value;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function readStringList(value: string | undefined): string[] {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function createGitHubOAuthConfig(
  env: NodeJS.ProcessEnv,
): GitHubOAuthAuthProviderConfig {
  const mode: AuthMode = "github-oauth";

  const host = env.MCP_HOST || "127.0.0.1";
  const port = env.MCP_PORT || "8080";
  const authHost = env.GITHUB_AUTH_HOST || host;
  const authPort = readPositiveInteger(
    env.GITHUB_AUTH_PORT,
    Number(port),
    "GITHUB_AUTH_PORT",
    65_535,
  );

  return {
    clientId: requireEnv(env, "GITHUB_CLIENT_ID", mode),
    clientSecret: requireEnv(env, "GITHUB_CLIENT_SECRET", mode),
    resource:
      env.GITHUB_OAUTH_RESOURCE ||
      env.OAUTH_RESOURCE ||
      "http://" + host + ":" + port + "/mcp",
    authorizationServer: trimTrailingSlash(
      env.GITHUB_AUTHORIZATION_SERVER || "https://github.com/login/oauth",
    ),
    apiBaseUrl: trimTrailingSlash(
      env.GITHUB_API_URL || "https://api.github.com",
    ),
    apiVersion: env.GITHUB_API_VERSION || "2022-11-28",
    requiredScopes: readStringList(env.GITHUB_REQUIRED_SCOPES),
    cacheTtlMs: readPositiveInteger(
      env.GITHUB_TOKEN_CACHE_TTL_SECONDS,
      300,
      "GITHUB_TOKEN_CACHE_TTL_SECONDS",
    ) * 1000,
    requestedScopes: readStringList(env.GITHUB_REQUESTED_SCOPES || env.GITHUB_REQUIRED_SCOPES || "read:user"),
    authHost,
    authPort,
    redirectUri:
      env.GITHUB_REDIRECT_URI ||
      "http://" + authHost + ":" + authPort + "/auth/github/callback",
    allowedOrigin: env.GITHUB_ALLOWED_ORIGIN || "*",
    stateTtlSeconds: readPositiveInteger(
      env.GITHUB_STATE_TTL_SECONDS,
      300,
      "GITHUB_STATE_TTL_SECONDS",
    ),
    successRedirectUri: env.GITHUB_SUCCESS_REDIRECT_URI,
  };
}

function createSiweConfig(env: NodeJS.ProcessEnv): SiweAuthServiceConfig {
  const chainIds = requireEnv(env, "SIWE_CHAIN_IDS", "siwe")
    .split(",")
    .map((chainId) => Number(chainId.trim()));

  if (
    chainIds.length === 0 ||
    chainIds.some((chainId) => !Number.isInteger(chainId) || chainId < 1)
  ) {
    throw new Error(
      "SIWE_CHAIN_IDS must be a comma-separated list of positive integers",
    );
  }

  return {
    host: env.SIWE_AUTH_HOST ?? env.MCP_HOST ?? "127.0.0.1",
    port: readPositiveInteger(
      env.SIWE_AUTH_PORT,
      8081,
      "SIWE_AUTH_PORT",
      65_535,
    ),
    domain: requireEnv(env, "SIWE_DOMAIN", "siwe"),
    uri: requireEnv(env, "SIWE_URI", "siwe"),
    chainIds,
    allowedOrigin: requireEnv(env, "SIWE_ALLOWED_ORIGIN", "siwe"),
    nonceTtlSeconds: readPositiveInteger(
      env.SIWE_NONCE_TTL_SECONDS,
      300,
      "SIWE_NONCE_TTL_SECONDS",
    ),
    sessionTtlSeconds: readPositiveInteger(
      env.SIWE_SESSION_TTL_SECONDS,
      3600,
      "SIWE_SESSION_TTL_SECONDS",
    ),
  };
}

export function createAuthConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfiguration {
  const mode = env.MCP_AUTH_MODE ?? "bearer";
  const endpoints = {
    sse: true,
    messages: true,
  };

  if (mode === "bearer") {
    return {
      mode,
      config: {
        provider: new BearerTokenAuthProvider(
          requireEnv(env, "MCP_TOKEN", mode),
        ),
        endpoints,
      },
    };
  }

  if (mode === "oauth") {
    const algorithms = readStringList(env.OAUTH_ALGORITHMS);

    return {
      mode,
      config: {
        provider: new OAuthAuthProvider({
          authorizationServers: [
            requireEnv(env, "OAUTH_AUTHORIZATION_SERVER", mode),
          ],
          resource: requireEnv(env, "OAUTH_RESOURCE", mode),
          validation: {
            type: "jwt",
            audience: requireEnv(env, "OAUTH_AUDIENCE", mode),
            issuer: requireEnv(env, "OAUTH_ISSUER", mode),
            jwksUri: requireEnv(env, "OAUTH_JWKS_URI", mode),
            ...(algorithms?.length ? { algorithms } : {}),
          },
        }),
        endpoints,
      },
    };
  }

  if (mode === "github-oauth") {
    const githubOAuthConfig = createGitHubOAuthConfig(env);
    return {
      mode,
      githubOAuthService: new GitHubOAuthService(githubOAuthConfig),
      config: {
        provider: new GitHubOAuthAuthProvider(githubOAuthConfig),
        endpoints,
      },
    };
  }

  if (mode === "siwe") {
    const siweService = new SiweAuthService(createSiweConfig(env));
    return {
      mode,
      siweService,
      config: {
        provider: siweService,
        endpoints,
      },
    };
  }

  throw new Error(
    `Unsupported MCP_AUTH_MODE "${mode}". Expected "bearer", "oauth", "github-oauth", or "siwe"`,
  );
}
