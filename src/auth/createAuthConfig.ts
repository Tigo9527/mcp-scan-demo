import {
  OAuthAuthProvider,
  type AuthConfig,
} from "mcp-framework";

import { BearerTokenAuthProvider } from "./BearerTokenAuthProvider.js";

export type AuthMode = "bearer" | "oauth";

export interface AuthConfiguration {
  config: AuthConfig;
  mode: AuthMode;
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
    const algorithms = env.OAUTH_ALGORITHMS
      ?.split(",")
      .map((algorithm) => algorithm.trim())
      .filter(Boolean);

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

  throw new Error(
    `Unsupported MCP_AUTH_MODE "${mode}". Expected "bearer" or "oauth"`,
  );
}
