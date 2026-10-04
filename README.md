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
export TESTCHIMP_API_KEY=...   # required unless TESTCHIMP_OAUTH_TOKEN is set (often read from project MCP env; never commit keys)
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

## Authentication and environment

| Variable | Purpose |
|---|---|
| `TESTCHIMP_API_KEY` | Project API key (sent as `TestChimp-Api-Key`). Required unless `TESTCHIMP_OAUTH_TOKEN` is set. |
| `TESTCHIMP_OAUTH_TOKEN` | OAuth 2.1 access token issued by featureservice (sent as `Authorization: Bearer`). When both are set, both are sent and the backend prefers the bearer. |
| `TESTCHIMP_BOT_ID` | QA bot id (sent as `bot-id` header for attribution). Must be 1–64 printable ASCII characters without spaces; otherwise it is ignored with a warning. |
| `TESTCHIMP_BACKEND_URL` | Featureservice base URL (default `https://featureservice.testchimp.io`). |
| `TESTCHIMP_INGRESS_URL` | Ingress base URL used for bot event acks (default `https://ingress.testchimp.io`). |
| `TESTCHIMP_HOME` | TestChimp Studio / CLI home holding `projects.json` (default `~/.testchimp`). |

## Workspace folder mapping

Map a local repository folder to a TestChimp project for the current user. The mapping lives in `~/.testchimp/projects.json` (or `$TESTCHIMP_HOME/projects.json`), the same file TestChimp Studio uses, so a folder mapped from the CLI shows up in Studio and in the headless AgentWatch daemon.

```bash
testchimp workspace map --project-id <id> --folder ~/code/shop [--project-name "Shop"] [--reassign] [--skip-repo-check]
testchimp workspace get --project-id <id>        # prints the mapping JSON; exit 1 when unmapped
```

`workspace map` follows the same rules as Studio:

- The folder must exist and be a git work tree. Paths are stored as canonical real paths.
- When `TESTCHIMP_API_KEY` / `TESTCHIMP_OAUTH_TOKEN` is set, the CLI loads the project's connected repository (`get-git-folder-mapping`). If one is connected, the folder must be the repository root and one of its git remotes must match (`owner/repo`, case-insensitive). If no credential is set, no repo is connected, or the lookup fails, the check is skipped with a note on stderr. The credential's own project is used for this lookup, so run it with the same project's key or bot token. `--skip-repo-check` skips the lookup entirely.
- A folder belongs to one project. Mapping it to a second project fails unless you pass `--reassign`, which moves it (and drops the old project's entry if that leaves it with no folders).
- The file is written atomically (temp file, then rename) with mode `0600`. Other projects are left alone, and unknown fields written by newer Studio versions are kept. A file that is not valid JSON or does not match schema v2 is moved to `projects.invalid.<millis>.json` and replaced with an empty registry. Schema v1 files are migrated to v2.

The byte-level format is pinned by `fixtures/projects-registry/`, with an identical copy in the Studio repo. Both test suites replay the same upsert sequences and compare the output bytes.

## QA bots

```bash
testchimp get-my-tasks --user-id <user-id>      # OAuth tokens imply the user
testchimp list-tests-awaiting-verification --limit 20
testchimp get-qa-posture
testchimp bot get-profile
testchimp bot register-profile --role QA_ENGINEER --responsibilities "Checkout + payments" \
  --capability E2E_AUTHORING --capability TEST_BATCH_FIX \
  --subscriptions-json '[{"eventType":"git-push","filters":[{"field":"author","op":"eq","value":"me"}]},{"eventType":"e2e-batch-completed"}]'
testchimp bot ack <eventId> [<eventId>...] --ack-url <delivery ackUrl>
testchimp bot compat --skill-version 1.0.53
```

`bot ack` prints one `eventId<TAB>status` line per id and exits non-zero when any status is `BOT_ACK_UNKNOWN_EVENT`, `BOT_ACK_NOT_A_TARGET`, or `BOT_ACK_MISSING_BOT_ID`. An explicit `--ack-url` must be https (http only on localhost) and point at a TestChimp host or the `TESTCHIMP_INGRESS_URL` host. `bot compat` exits 0 and prints the deployment minimums plus `cliUpgradeRequired` / `skillUpgradeRequired`.

### AgentWatch without TestChimp Studio

```bash
testchimp bot connect --project-id <id>       # browser approval (OAuth, "agentwatch" scope)
testchimp bot connect --pair --project-id <id> # or: no browser, your QA bot approves (see below)
npx -y @testchimp/agentwatch query --project-id <id>
testchimp bot disconnect --project-id <id>    # forget the stored keys
```

Headless AgentWatch acts as the user, so it needs their user id, personal access key and the project API key. `bot connect` runs an OAuth 2.1 PKCE login with a loopback redirect, asks for the opt-in `agentwatch` scope (the consent page warns that keys will be stored locally), fetches the keys from `/bots/get_agentwatch_credentials`, and writes them to `~/.testchimp/agentwatch/credentials.json` (mode `0600`, keyed by project) with the backend and ingress URLs. It revokes the OAuth refresh token straight away and never prints the keys. Approving also opts the project in to AgentWatch.

**Pairing (no second browser consent; what QA bots use).** Every connection approved with **Use this connection as my QA bot** carries the `agentwatch_pair` scope, so the keys can reach the user's computer without another browser login, and without passing through the bot:

1. On the user's computer: `testchimp bot connect --pair [--project-id <id>]` keeps a random verifier in `~/.testchimp/agentwatch/pairing.json` (`0600`) and prints `{pairingCode, expiresAtMillis}`; the code is the verifier's SHA-256 (base64url).
2. The bot approves it with its own token: MCP tool `approve-agentwatch-pairing` (or `testchimp bot approve-pairing <code>`).
3. On the user's computer: `testchimp bot connect --finish-pair` redeems with the verifier (polls up to `--timeout-ms`, default 60 s), stores the keys like above and deletes the pending file.

Pairings are single use and expire after 10 minutes. The bot only ever sees the pairing code, which is useless without the verifier.

## Remote MCP (Streamable HTTP)

```bash
testchimp mcp --http [--port 8080] [--host 0.0.0.0]
```

Stateless Streamable HTTP at `POST /mcp`. Every request must carry `Authorization: Bearer <OAuth access token>`; the caller's token is forwarded to TestChimp for each tool call, and the server's own `TESTCHIMP_API_KEY` / `TESTCHIMP_OAUTH_TOKEN` / `TESTCHIMP_BOT_ID` are never used. Requests without a bearer get `401` with `WWW-Authenticate: Bearer resource_metadata="…"`. Other endpoints: `GET /.well-known/oauth-protected-resource` (RFC 9728 metadata), `GET /healthz`. Request bodies are capped at 1 MB.

| Variable | Purpose |
|---|---|
| `PORT` | Listen port when `--port` is not given (default `8080`; Cloud Run sets it). |
| `TESTCHIMP_MCP_PUBLIC_URL` | Public base URL of this server (e.g. `https://mcp.testchimp.io`); used for the protected-resource `resource` and `WWW-Authenticate`. Defaults to the request's forwarded proto + host. |
| `TESTCHIMP_OAUTH_ISSUER` | Authorization server advertised in the metadata (default: `TESTCHIMP_BACKEND_URL`). |
| `TESTCHIMP_BACKEND_URL` / `TESTCHIMP_INGRESS_URL` | Upstream TestChimp services. |

The repository `Dockerfile` builds an image that runs `testchimp mcp --http` as a non-root user (Cloud Run ready):

```bash
docker build -t testchimp-mcp .
docker run -p 8080:8080 -e TESTCHIMP_MCP_PUBLIC_URL=https://mcp.example.com testchimp-mcp
```

## Migration from `testchimp-mcp-client`

The npm package **`testchimp-mcp-client`** is superseded by **`@testchimp/cli`**. Update MCP `args` to `["-y", "@testchimp/cli@latest", "mcp"]` and rename tool references to **kebab-case**. See [MIGRATION.md](./MIGRATION.md).

## License

MIT
