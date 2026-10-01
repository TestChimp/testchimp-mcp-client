# @testchimp/cli

**TestChimp CLI** and **MCP server** for calling TestChimp [`/api/mcp/*`](https://featureservice.testchimp.io) endpoints with `TESTCHIMP-API-KEY`.

This repository folder may still be named `testchimp-mcp-client` locally; the **published npm package** is **`@testchimp/cli`**.

## Install

```bash
npm install -D @testchimp/cli@latest
```

## MCP (agents in Cursor, Claude Code, VS Code, etc.)

Register the server so the host runs:

```bash
npx -y @testchimp/cli@latest mcp
```

Example `mcpServers.testchimp`:

```json
{
  "command": "npx",
  "args": ["-y", "@testchimp/cli@latest", "mcp"],
  "env": {
    "TESTCHIMP_API_KEY": "your-project-key",
    "TESTCHIMP_BACKEND_URL": ""
  }
}
```

The config **file path** depends on the host (e.g. Cursor often uses `<repo>/.cursor/mcp.json`). Tool names use **kebab-case** (e.g. `get-requirement-coverage`, `create-user-story`).

## CLI

```bash
export TESTCHIMP_API_KEY=...   # required (often read from project MCP env; never commit keys)
testchimp --help
testchimp get-requirement-coverage --branch-name main --help
testchimp create-user-story --platform-file-path plans/stories/foo.md --title "Checkout"
testchimp list-screen-states --json-input '{}'
testchimp upsert-screen-states --json-input '{"screenStates":[{"screen":"Checkout","states":["empty","filled"]}]}'
testchimp list-perf-runs --testchimp-id TC-123 --kind JOURNEY --limit 20
testchimp get-perf-run --run-id 01ABC --include-raw
testchimp promote-perf-baseline --run-id 01ABC --env-class CI
testchimp compare-perf-to-baseline --run-id 01ABC --max-p95-regression-percent 10
testchimp list-related-perf-tests --scenario-titles "Checkout,Refund"
testchimp list-api-operation-interactions --operation-id 01XYZ --interaction-type REAL --limit 100
testchimp list-meeting-filter-options
testchimp list-meetings --from 2026-09-01 --to 2026-09-30 --domain customer.com --label Sales --search "pricing"
testchimp get-meeting-transcript --meeting-id <meeting-id> --summary-only
```

- **stdout:** API response JSON.
- **stderr:** progress for `provision-ephemeral-environment-and-wait` (“still waiting…” polls).
- **performance gate:** `compare-perf-to-baseline` still prints its JSON response but exits nonzero when `regressed` is `true` (top-level or under `comparison`).
- **Meetings:** `list-meetings` / `list-meeting-filter-options` cover team-wide Meeting Bots meetings only (same filters as the Meetings page). `--from` / `--to` take `YYYY-MM-DD` (inclusive local days), ISO datetimes, or epoch millis; `--label`, `--participant`, `--domain` are repeatable or comma-separated.
- **Flags:** default for each subcommand; **`--json-input '<json>'`** or **`--json-input @file.json`** merges over flags (JSON wins on conflicts). Use JSON for nested bodies (e.g. TrueCoverage scopes).

## Migration from `testchimp-mcp-client`

The npm package **`testchimp-mcp-client`** is superseded by **`@testchimp/cli`**. Update MCP `args` to `["-y", "@testchimp/cli@latest", "mcp"]` and rename tool references to **kebab-case**. See [MIGRATION.md](./MIGRATION.md).

## License

MIT
