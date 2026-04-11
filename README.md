# testchimp-mcp-client

MCP (Model Context Protocol) server for [TestChimp](https://testchimp.io). Exposes tools that call TestChimp **featureservice** `/api/mcp/*` endpoints using **`TestChimp-Api-Key` only** (project is resolved server-side).

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `TESTCHIMP_API_KEY` | Yes | Project API key from TestChimp project settings. |
| `TESTCHIMP_BACKEND_URL` | No | Featureservice base URL (default: `https://featureservice.testchimp.io`). Set for staging or local dev. |

## Tools

- **`get_requirement_coverage`** — POST `/api/mcp/list_requirement_coverage` (scenario / requirement coverage scoped by platform-rooted `scope.folderPath` under **`tests/...`** or **`plans/...`**).
- **`get_execution_history`** — POST `/api/mcp/list_execution_history`.
- **`get_test_advice`** — POST `/api/mcp/get_test_advice` (stub until PR analysis ships).

## Cursor

Add to MCP config (e.g. `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "testchimp": {
      "command": "npx",
      "args": ["-y", "testchimp-mcp-client"],
      "env": {
        "TESTCHIMP_API_KEY": "your-api-key",
        "TESTCHIMP_BACKEND_URL": "https://featureservice.testchimp.io"
      }
    }
  }
}
```

For a published npm package name, adjust `args` to your scope (e.g. `@testchimp/mcp-client`) after publish.

## Scope path format

- Send `scope.folderPath` as platform path segments rooted at `tests` or `plans`.
  - Example: `["tests","checkout"]`
  - Example: `["plans","checkout"]`
- These platform roots map to whatever repo folders are configured in TestChimp integrations (for example, platform `tests/...` may map to repo `ui_tests/...`).

## Build

```bash
npm install
npm run build
```

Run locally: `node dist/index.js` (stdio MCP; typically launched by the IDE).

## License

MIT
