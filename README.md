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
