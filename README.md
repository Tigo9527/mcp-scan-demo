# MCP Scan Demo

A minimal TypeScript MCP server built with `mcp-framework`. The Streamable HTTP
endpoint requires one static Bearer token loaded from `.env`.

Authentication is selected with `MCP_AUTH_MODE`. Static ****** remains the
default for backward compatibility, while `oauth` enables OAuth 2.1 JWT
validation and `siwe` enables Sign-In with Ethereum.

## Run

```bash
npm install
cp .env.example .env
# Edit MCP_TOKEN in .env
npm run build
npm start
```

For local development:

```bash
npm run dev
```

The endpoints are:

- MCP: `http://127.0.0.1:8080/mcp`
- Health check: `http://127.0.0.1:8080/health`

## Authentication

Every request to `/mcp` must include:

```http
Authorization: Bearer replace-with-a-long-random-token
```

Generate a token with:

```bash
openssl rand -hex 32
```

An example initialize request:

```bash
curl -i http://127.0.0.1:8080/mcp \
  -H 'Authorization: Bearer replace-with-a-long-random-token' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": {
        "name": "curl",
        "version": "1.0.0"
      }
    }
  }'
```

### OAuth 2.1 authentication

Set the following values in `.env` to validate OAuth JWT access tokens through
the authorization server's JWKS endpoint:

```env
MCP_AUTH_MODE=oauth
OAUTH_AUTHORIZATION_SERVER=https://auth.example.com
OAUTH_RESOURCE=https://mcp.example.com
OAUTH_AUDIENCE=https://mcp.example.com
OAUTH_ISSUER=https://auth.example.com/
OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json
OAUTH_ALGORITHMS=RS256
```

`OAUTH_ALGORITHMS` is optional and accepts a comma-separated list. All other
OAuth variables above are required. The server validates the JWT signature,
issuer, audience, and expiry.

OAuth Protected Resource Metadata is available at:

```text
http://127.0.0.1:8080/.well-known/oauth-protected-resource
```

The OAuth client sends its access token to `/mcp` using the same standard
`Authorization` header used by MCP HTTP clients.

### GitHub OAuth authentication

GitHub OAuth mode provides a browser login flow and validates opaque GitHub
OAuth App access tokens by calling the GitHub API. GitHub owns the account
system; this server handles the OAuth redirect and checks the resulting bearer
token before allowing `/mcp` requests.

Create a GitHub OAuth App, then configure:

```env
MCP_AUTH_MODE=github-oauth
MCP_HOST=127.0.0.1
MCP_PORT=8080

GITHUB_CLIENT_ID=your-github-oauth-app-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-app-client-secret
GITHUB_OAUTH_RESOURCE=http://127.0.0.1:8080/mcp
GITHUB_AUTH_HOST=127.0.0.1
GITHUB_AUTH_PORT=8082
GITHUB_REDIRECT_URI=http://127.0.0.1:8082/auth/github/callback
GITHUB_SUCCESS_REDIRECT_URI=http://localhost:3000/oauth/github/complete
GITHUB_ALLOWED_ORIGIN=http://localhost:3000
GITHUB_AUTHORIZATION_SERVER=https://github.com/login/oauth
GITHUB_API_URL=https://api.github.com
GITHUB_API_VERSION=2022-11-28
GITHUB_REQUESTED_SCOPES=read:user
GITHUB_REQUIRED_SCOPES=read:user
GITHUB_TOKEN_CACHE_TTL_SECONDS=300
GITHUB_STATE_TTL_SECONDS=300
```

Set the GitHub OAuth App callback URL to the exact `GITHUB_REDIRECT_URI` value.
For the local template above, use:

```text
http://127.0.0.1:8082/auth/github/callback
```

Start the server, then open:

```text
http://127.0.0.1:8082/auth/github
```

The login flow is:

1. `/auth/github/login` creates a one-time state value and redirects to GitHub.
2. GitHub redirects back to `/auth/github/callback` with `code` and `state`.
3. The service validates `state` and exchanges `code` at GitHub's token endpoint.
4. The callback returns an MCP bearer token page, or redirects to
   `GITHUB_SUCCESS_REDIRECT_URI` with the token in the URL fragment.
5. Send MCP requests with:

```text
Authorization: Bearer <github-access-token>
```

When `GITHUB_REQUIRED_SCOPES` is set, every listed comma-separated scope must be
present on the GitHub token. OAuth Protected Resource Metadata is available at
the same endpoint used by JWT OAuth mode:

```text
http://127.0.0.1:8080/.well-known/oauth-protected-resource
```

### Sign-In with Ethereum

SIWE mode is intended for EVM-compatible wallets, including Conflux eSpace. It
runs a small authentication service next to the MCP server:

```env
MCP_AUTH_MODE=siwe
SIWE_AUTH_HOST=127.0.0.1
SIWE_AUTH_PORT=8081
SIWE_DOMAIN=localhost:8081
SIWE_URI=http://localhost:8081
SIWE_CHAIN_IDS=1030,71
SIWE_ALLOWED_ORIGIN=http://localhost:3000
SIWE_NONCE_TTL_SECONDS=300
SIWE_SESSION_TTL_SECONDS=3600
```

The example chain IDs are Conflux eSpace mainnet (`1030`) and testnet (`71`).
Set `SIWE_DOMAIN`, `SIWE_URI`, and `SIWE_ALLOWED_ORIGIN` to the public values
used by your application.

The login flow is:

1. `GET http://localhost:8081/auth/siwe/nonce`
2. Build an EIP-4361 message with the returned `nonce`, `domain`, and `uri`.
3. Sign the message with the wallet's `personal_sign` method.
4. Send the message and signature to
   `POST http://localhost:8081/auth/siwe/verify`.
5. Use the returned `accessToken` as the Bearer token for `/mcp`.

Example verification request:

```bash
curl http://localhost:8081/auth/siwe/verify \
  -H 'Content-Type: application/json' \
  --data '{
    "message": "<EIP-4361 message signed by the wallet>",
    "signature": "0x..."
  }'
```

The successful response contains:

```json
{
  "accessToken": "<random-session-token>",
  "tokenType": "Bearer",
  "expiresIn": 3600,
  "address": "0x...",
  "chainId": 1030
}
```

Each nonce is single-use and expires after five minutes by default. Session
tokens are random, stored only as SHA-256 hashes, and expire after one hour by
default. Both stores are in memory, so sessions are revoked when the server
restarts. Deploy the authentication endpoints behind HTTPS outside local
development.

The demo exposes these tools:

- `echo`: returns the supplied `message`.
- `list_cfx_transfers`: lists native CFX transfers for a Conflux Core account
  through ConfluxScan's `/account/cfx/transfers` API.
- `list_latest_transactions`: lists the latest Conflux Core transactions
  through the ConfluxScan explorer's `/v1/transaction` API.

The ConfluxScan API base URL can be changed in `.env`:

```env
CONFLUXSCAN_API_URL=https://api.confluxscan.org
CONFLUXSCAN_WEB_API_URL=https://www.confluxscan.org
```

Use `https://api-testnet.confluxscan.org` to query Conflux Core testnet data.
The tool supports `account`, `skip`, `limit`, `from`, `to`, epoch range,
timestamp range, and `asc`/`desc` sorting. ConfluxScan limits `skip` to 10,000,
`limit` to 100, and account transfer history to the latest 20,000 records.
See the [ConfluxScan Open API documentation](https://api.confluxscan.org/doc)
for upstream API details.

## Use with Codex CLI

Start the MCP server in one terminal:

```bash
npm start
```

In the terminal where you will run Codex, export the values from this project's
`.env` file:

```bash
set -a
. ./.env
set +a
```

Codex does not automatically read the MCP server's `.env` file. `MCP_TOKEN`
must therefore be present in the environment of the Codex process, and its
value must match the token used by the server.

Register the Streamable HTTP server:

```bash
codex mcp add mcp-scan-demo \
  --url "http://${MCP_HOST}:${MCP_PORT}/mcp" \
  --bearer-token-env-var MCP_TOKEN
```

For OAuth mode, register the server without `--bearer-token-env-var`, then
start Codex's OAuth login flow:

```bash
codex mcp add mcp-scan-demo \
  --url "http://${MCP_HOST}:${MCP_PORT}/mcp"
codex mcp login mcp-scan-demo
```

If required by the authorization server, request scopes with:

```bash
codex mcp login mcp-scan-demo --scopes scope1,scope2
```

For SIWE mode, complete the wallet login flow first, then export the returned
session token and configure Codex to read it:

```bash
export SIWE_ACCESS_TOKEN='<accessToken returned by /auth/siwe/verify>'
codex mcp add mcp-scan-demo \
  --url "http://${MCP_HOST}:${MCP_PORT}/mcp" \
  --bearer-token-env-var SIWE_ACCESS_TOKEN
```

Inspect the saved configuration:

```bash
codex mcp list
codex mcp get mcp-scan-demo
```

Then start Codex from the same terminal:

```bash
codex
```

For example, ask Codex:

```text
Use the echo MCP tool to echo "Hello from Codex".
```

To query ConfluxScan, ask:

```text
Use list_cfx_transfers to show the latest 5 native CFX transfers for
cfx:aanjcf1esdz50j6zhkm0k60wc7669tfkw28mzudg24.
```

To inspect recent network activity, ask:

```text
Use list_latest_transactions to show the latest 10 Conflux Core transactions.
```

Codex stores the server definition in `~/.codex/config.toml`. The equivalent
manual configuration is:

```toml
[mcp_servers.mcp-scan-demo]
url = "http://127.0.0.1:8080/mcp"
bearer_token_env_var = "MCP_TOKEN"
```

If `MCP_PORT` is changed in `.env`, update the registered URL by removing and
adding the server again:

```bash
codex mcp remove mcp-scan-demo
codex mcp add mcp-scan-demo \
  --url "http://${MCP_HOST}:${MCP_PORT}/mcp" \
  --bearer-token-env-var MCP_TOKEN
```

Common failures:

- `401 Unauthorized`: the exported `MCP_TOKEN` does not match the server token.
- `401 Unauthorized` in OAuth mode: check the token's issuer, audience, expiry,
  algorithm, and signing key.
- OAuth metadata not found: confirm `MCP_AUTH_MODE=oauth` and all required OAuth
  variables are configured.
- SIWE verification fails: check the signed domain, URI, chain ID, expiration,
  nonce, and configured browser origin.
- SIWE session is rejected after restart: in-memory sessions are intentionally
  revoked whenever the server process restarts.
- Connection refused: the MCP server is not running or the configured port is
  incorrect.
- Token environment variable is missing: export `.env` before starting Codex.
