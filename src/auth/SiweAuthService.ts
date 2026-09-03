import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AuthProvider, AuthResult } from "mcp-framework";
import {
  generateNonce,
  SiweMessage,
} from "siwe";
import { z } from "zod";

const verifyRequestSchema = z.object({
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

interface NonceRecord {
  expiresAt: number;
}

interface SessionRecord {
  address: string;
  chainId: number;
  expiresAt: number;
}

export interface SiweAuthServiceConfig {
  host: string;
  port: number;
  domain: string;
  uri: string;
  chainIds: number[];
  allowedOrigin: string;
  nonceTtlSeconds: number;
  sessionTtlSeconds: number;
}

class SiweAuthenticationError extends Error {}

export class SiweAuthService implements AuthProvider {
  private readonly nonces = new Map<string, NonceRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private server?: Server;

  constructor(private readonly config: SiweAuthServiceConfig) {}

  async authenticate(request: IncomingMessage): Promise<boolean | AuthResult> {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") {
      return false;
    }

    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) {
      return false;
    }

    this.pruneExpiredRecords();
    const session = this.sessions.get(this.hashToken(match[1]));
    if (!session) {
      return false;
    }

    return {
      data: {
        address: session.address,
        chainId: session.chainId,
        authMethod: "siwe",
      },
    };
  }

  getAuthError() {
    return {
      status: 401,
      message: "Missing, invalid, or expired SIWE session token",
      headers: {
        "WWW-Authenticate": 'Bearer realm="MCP Server"',
      },
    };
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("SIWE authentication service is already running");
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response);
      });

      server.once("error", reject);
      server.listen(this.config.port, this.config.host, () => {
        server.off("error", reject);
        server.on("error", (error) => {
          console.error("SIWE authentication server error:", error);
        });
        this.server = server;
        resolve();
      });
    });
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

      if (request.method === "GET" && url.pathname === "/auth/siwe/nonce") {
        this.handleNonce(response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/auth/siwe/verify") {
        await this.handleVerify(request, response);
        return;
      }

      this.sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof SiweAuthenticationError || error instanceof SyntaxError) {
        this.sendJson(response, 400, {
          error: error.message,
        });
        return;
      }

      console.error("SIWE authentication request failed:", error);
      this.sendJson(response, 500, {
        error: "Internal server error",
      });
    }
  }

  private handleNonce(response: ServerResponse): void {
    this.pruneExpiredRecords();
    const nonce = generateNonce();
    const expiresAt = Date.now() + this.config.nonceTtlSeconds * 1000;
    this.nonces.set(nonce, { expiresAt });

    this.sendJson(response, 200, {
      nonce,
      domain: this.config.domain,
      uri: this.config.uri,
      chainIds: this.config.chainIds,
      expirationTime: new Date(expiresAt).toISOString(),
    });
  }

  private async handleVerify(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = verifyRequestSchema.safeParse(
      JSON.parse(await this.readBody(request)),
    );
    if (!body.success) {
      throw new SiweAuthenticationError(
        body.error.issues.map((issue) => issue.message).join("; "),
      );
    }

    const message = new SiweMessage(body.data.message);
    const nonceRecord = this.nonces.get(message.nonce);
    this.nonces.delete(message.nonce);

    if (!nonceRecord || nonceRecord.expiresAt <= Date.now()) {
      throw new SiweAuthenticationError("SIWE nonce is missing, expired, or already used");
    }

    if (message.uri !== this.config.uri) {
      throw new SiweAuthenticationError("SIWE message URI does not match this service");
    }

    if (!this.config.chainIds.includes(message.chainId)) {
      throw new SiweAuthenticationError("SIWE message chain ID is not allowed");
    }

    const verification = await message.verify(
      {
        signature: body.data.signature,
        domain: this.config.domain,
        nonce: message.nonce,
        time: new Date().toISOString(),
      },
      {
        suppressExceptions: true,
      },
    );

    if (!verification.success) {
      throw new SiweAuthenticationError(
        verification.error?.type ?? "SIWE signature verification failed",
      );
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.config.sessionTtlSeconds * 1000;
    this.sessions.set(this.hashToken(token), {
      address: message.address,
      chainId: message.chainId,
      expiresAt,
    });

    this.sendJson(response, 200, {
      accessToken: token,
      tokenType: "Bearer",
      expiresIn: this.config.sessionTtlSeconds,
      address: message.address,
      chainId: message.chainId,
    });
  }

  private validateOrigin(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const origin = request.headers.origin;
    if (!origin || origin === this.config.allowedOrigin) {
      return true;
    }

    this.sendJson(response, 403, { error: "Origin is not allowed" });
    return false;
  }

  private setCorsHeaders(response: ServerResponse): void {
    response.setHeader("Access-Control-Allow-Origin", this.config.allowedOrigin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, mcp-protocol-version, mcp-session-id",
    );
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

  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 64 * 1024) {
        throw new SiweAuthenticationError("Request body exceeds 64 KiB");
      }
      chunks.push(buffer);
    }

    return Buffer.concat(chunks).toString("utf8");
  }

  private pruneExpiredRecords(): void {
    const now = Date.now();

    for (const [nonce, record] of this.nonces) {
      if (record.expiresAt <= now) {
        this.nonces.delete(nonce);
      }
    }

    for (const [tokenHash, record] of this.sessions) {
      if (record.expiresAt <= now) {
        this.sessions.delete(tokenHash);
      }
    }
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
