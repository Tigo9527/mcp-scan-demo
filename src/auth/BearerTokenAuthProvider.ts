import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AuthProvider } from "mcp-framework";

export class BearerTokenAuthProvider implements AuthProvider {
  constructor(private readonly expectedToken: string) {
    if (!expectedToken) {
      throw new Error("MCP_TOKEN must not be empty");
    }
  }

  async authenticate(request: IncomingMessage): Promise<boolean> {
    const authorization = request.headers.authorization;

    if (typeof authorization !== "string") {
      return false;
    }

    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) {
      return false;
    }

    const provided = Buffer.from(match[1], "utf8");
    const expected = Buffer.from(this.expectedToken, "utf8");

    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  getAuthError() {
    return {
      status: 401,
      message: "Missing or invalid Bearer token",
      headers: {
        "WWW-Authenticate": 'Bearer realm="MCP Server"',
      },
    };
  }
}
