# Migrating from `testchimp-mcp-client` to `@testchimp/cli`

1. **MCP host config** — Replace package name and add the `mcp` subcommand:

   ```json
   "args": ["-y", "@testchimp/cli@latest", "mcp"]
   ```

2. **Tool names** — MCP tools are now **kebab-case** (e.g. `create-user-story` instead of `create_user_story`). Update skills, prompts, and docs accordingly.

3. **npm** — Install `@testchimp/cli`; remove `testchimp-mcp-client` from `devDependencies` if present.

4. **Optional npm shim** — To keep the old package name resolving for a transition period, publish a thin `testchimp-mcp-client` package that depends on `@testchimp/cli` and sets `bin.testchimp-mcp` to `node_modules/@testchimp/cli/dist/bin/legacy-mcp.js` (publish separately if needed).

## MCP API 2.0.0 (`@testchimp/cli` 2.0.0)

Tool names and request shapes follow TestChimp MCP API 2.0.0. Update skills, prompts, and host configs that still call 1.x tool names. Old `/api/mcp/*` paths remain hidden server aliases for one client release; this package uses the new paths.

| Old tool | New tool | Notes |
|---|---|---|
| `get-eaas-config` | `ephemeral-environment` | `action=CONFIG` |
| `provision-ephemeral-environment` | `ephemeral-environment` | `action=PROVISION`, `wait=false` |
| `provision-ephemeral-environment-and-wait` | `ephemeral-environment` | `action=PROVISION` (`wait` defaults true) |
| `get-ephemeral-environment-status` | `ephemeral-environment` | `action=STATUS`, `bnsEnvironmentId` |
| `destroy-ephemeral-environment` | unchanged | still destructive |
| `report-dast-findings` | `report-scan-findings` | `scanner=DAST` |
| `report-sast-findings` | `report-scan-findings` | `scanner=SAST` |
| `report-deps-findings` | `report-scan-findings` | `scanner=DEPS` |
| `report-secrets-findings` | `report-scan-findings` | `scanner=SECRETS` |
| `list-workflow-executions` | `get-workflow-executions` | same list filters |
| `get-workflow-execution` | `get-workflow-executions` | `workflowExecutionId` |
| `get-last-run-workflow-detail` | `get-workflow-executions` | `workflowId` + `latestOnly=true` |
| `get-policy` | `get-policies` | `policyFileName` |
| `list-policies` | `get-policies` | omit `policyFileName` |
| `list-api-operation-services` | `get-api-operations` | no identity args |
| `list-api-operations` | `get-api-operations` | `rootFilePath` / `serviceKey` |
| `get-api-operation-detail` | `get-api-operations` | `id`, or `oasOperationId`, or method+path |
| `list-meeting-filter-options` | `list-meetings` | `includeFilterOptions=true` |
| `get-meeting-set` | `list-meetings` | `meetingSetId` |
| `mark-entity-distinct` | `set-entity-distinct` | `distinct` defaults true |
| `unmark-entity-distinct` | `set-entity-distinct` | `distinct=false` |
| `mark-semantic-tests-distinct` | `set-entity-distinct` | `entityType=TEST` + the two locators |
| `get-batch-view-url` | `fetch-execution-report` | response includes `batchViewUrl` |
| `get-suite-execution-stats` | `get-execution-history` | `aggregate=true` |
| `get-perf-run` | `list-perf-runs` | `runId` (+ `includeRaw`) |
| `get-release-details` | `get-release` | `version` + `detail=GATE` |
| `create-issue` | `upsert-issue` | omit `issueId`; `title` required |
| `update-issue-status` | `upsert-issue` | `issueId` + patch fields |

New: `list-issues`, `upsert-release`, `manage-test-run`. `get-org-capabilities` now includes `planLabel`, `trial` / `freeTrialActive`, and `chimphandsCredits`. `get-release` lists catalog entries when `version` is omitted.

CLI subcommands match the kebab-case MCP names. Nested `bot` / `workspace` aliases (`bot ack`, `bot register-profile`, `workspace save-creds`, …) are unchanged.
