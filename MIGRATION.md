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
| `get-eaas-config` | unchanged | standalone connectivity check; `POST /api/mcp/get_eaas_config` |
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

New tools and 2.0 request shapes:

- `list-issues` — search/filter issues.
- `upsert-release` — `POST /api/mcp/upsert_release`. `version` is required. Optional: `gitCommitSha`, `priorReleaseVersion`, `releaseType`, `lifecycleStatus`, `environment` (create only), `dueDateMillis` and `branchId` (update only), `focusAreas` (CLI ≥ 2.0.3). Response `{ release, created }`.
- `create-security-scan` — `POST /api/mcp/create_security_scan` (CLI ≥ 2.0.3). `version` + exactly one check config. Response `{ scanId, prompt }`.
- `manage-test-run` — `POST /api/mcp/manage_test_run`. Omit `id` to create (`release` required). Optional: `title`, `environment` (server defaults QA), `dueDate` (int64 millis string), `status` (`ACTIVE` / `COMPLETED` / `ARCHIVED`), `batchInvocationIds[]`, `commitRange` `FIND`|`LINK` (sent as `MCP_TEST_RUN_COMMIT_RANGE_*`), `limitWhenNoPrior`. Response includes `id`, `summary`, `created`, link counts, commit SHAs, `discoveredBatchInvocationIds` and `unlinkedBatchInvocationIds`.
- Also new: `ingest-scenario-execution`, `list-execution-job-dimension-values`, `list-test-planning-trends`, `select-smart-smoke-tests`.
- `ask-about-testchimp` — `POST /api/mcp/ask_about_testchimp`. Request `{ question }` (required, max 2000 characters; server limit 20 questions per project per hour). CLI/skill alias `ask-testchimp-question`. The 0.1.94 client work was never pushed; this matches that server spec. Response JSON is returned as-is (OpenAPI response fields unverified from this client).
- `get-org-capabilities` — includes `planLabel`, `trial` / `freeTrialActive`, and `chimphandsCredits`.
- `get-release` — `version` plus optional `detail=GATE`. Omit `version` to list (`environment`, `pageSize`, `pageToken`, `excludeArchived`).

CLI subcommands match the kebab-case MCP names. Nested `bot` / `workspace` aliases (`bot ack`, `bot register-profile`, `workspace save-creds`, …) are unchanged.

**CLI release labels (2.0.1):** pass a release catalog version with `--release <label>` (alias `--release-version`). Do not use `--version` — that prints the CLI version only. Applies to `get-release`, `get-release-details` (alias of `get-release`), `upsert-release`, `manage-test-run`, and every other command that takes a release label. MCP / `--json-input` field names stay `version` on `get-release` and `upsert-release`.
