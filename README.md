# MCP Scan Demo

A minimal TypeScript MCP server built with `mcp-framework`. The Streamable HTTP
endpoint requires one static Bearer token loaded from `.env`.

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

The demo exposes one tool:

- `echo`: returns the supplied `message`.

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
- Connection refused: the MCP server is not running or the configured port is
  incorrect.
- Token environment variable is missing: export `.env` before starting Codex.
