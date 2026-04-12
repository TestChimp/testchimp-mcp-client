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
- **`create_user_story`** — POST `/api/mcp/create_user_story` (`platformFilePath` under `plans/stories/...`, `title`).
- **`create_test_scenario`** — POST `/api/mcp/create_test_scenario` (`platformFilePath` under `plans/scenarios/...`, `title`, `userStoryOrdinalId`).
- **`update_user_story`** — POST `/api/mcp/update_user_story` (full markdown `content` with `id: US-...` in frontmatter).
- **`update_test_scenario`** — POST `/api/mcp/update_test_scenario` (full markdown `content` with `id: TS-...` and `story: US-...` in frontmatter).

## Cursor

**Install only at project level.** TestChimp API keys are **scoped to a TestChimp project**; the MCP server must use the key for **the repo you have open**. Do **not** add this server to **IDE-wide** MCP config (`~/.cursor/mcp.json` or global Cursor MCP settings): you risk using the wrong key when switching workspaces, and agents may target the wrong backend project.

**For humans and AI agents:** create or edit **`<project-root>/.cursor/mcp.json`** in the repository you are working in (the folder Cursor has open as the workspace root). That path is **`.cursor/mcp.json` relative to the project root**, not under your home directory.

The MCP server reads **`TESTCHIMP_API_KEY`** and **`TESTCHIMP_BACKEND_URL`** from **`process.env`** — it does not read `mcp.json` directly. Cursor starts the server as a **child process**; variables must be present in **that** process’s environment.

**Why `mcp.json` uses an `env` block:** If you open Cursor from the Dock, Spotlight, or similar, it usually does **not** load your shell profile (`.zshrc`, etc.), so values you only `export` in a terminal may **not** reach the MCP server. The `env` object next to `command` / `args` is the reliable way Cursor injects variables into the MCP process. (Cursor’s `mcp.json` does **not** expand `$VAR` / `${VAR}` from your shell; use literal values in `env`, or a wrapper that loads a `.env` file before starting the server.)

### Project `mcp.json` example

`<project-root>/.cursor/mcp.json`:

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

- **Do not commit secrets:** Add `.cursor/mcp.json` to **`.gitignore`** if it contains real keys, or keep only a committed `.cursor/mcp.json.example` with placeholders and document that each developer maintains a local ignored file.
- **After changing env or config:** Restart the MCP server or reload MCP / restart Cursor so the new environment is picked up.

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
