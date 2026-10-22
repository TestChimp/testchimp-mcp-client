# Changelog

## 2.0.1

### Fixed

- CLI `--version <label>` on release commands was captured as the global version flag and printed the CLI version instead of calling the API. Use `--release <label>` (alias `--release-version`) for a release catalog version. `--version` / `-V` only print the CLI version. A stray `--version <label>` on a release command errors and tells you to use `--release`. MCP tool field names are unchanged (`version` on `get-release` / `upsert-release`).

`server.json` version is 2.0.1. Do not run `mcp-publisher` from this change.

## 2.0.0

Breaking client update for TestChimp MCP API 2.0.0 (Aware PRs #496 and #497). 87 tools.

### Added

- `ephemeral-environment` — CONFIG / PROVISION (`wait` defaults true) / STATUS
- `report-scan-findings` — `scanner=DAST|SAST|DEPS|SECRETS`
- `get-workflow-executions` — list, `workflowExecutionId` detail, or `workflowId` + `latestOnly`
- `get-policies` — fetch one file or list
- `get-api-operations` — services, list, or detail
- `set-entity-distinct` — `distinct` defaults true; TEST locators
- `list-issues`
- `upsert-issue` — omit `issueId` + `title` to create; `issueId` to patch
- `upsert-release` — `version` required; optional `gitCommitSha`, `priorReleaseVersion`, `releaseType`, `lifecycleStatus`, `environment` (create), `dueDateMillis` / `branchId` (update); response `{ release, created }`
- `manage-test-run` — omit `id` to create (`release` required); optional `title`, `environment` (default QA), `dueDate` (int64), `status` (ACTIVE/COMPLETED/ARCHIVED), `batchInvocationIds`, `commitRange` FIND|LINK, `limitWhenNoPrior`
- `ingest-scenario-execution`, `list-execution-job-dimension-values`, `list-test-planning-trends`, `select-smart-smoke-tests`
- `ask-about-testchimp` — `POST /api/mcp/ask_about_testchimp` (`question` required, max 2000 characters; server limit 20 questions per project per hour). CLI/skill alias `ask-testchimp-question`. The 0.1.94 client work was never pushed; this is a new 2.0.0 implementation matching that spec. Request modeled from the live hosted MCP tools/list (Aware OpenAPI not readable from this client; response passed through).

### Removed (replaced by the tools above)

- `provision-ephemeral-environment`, `provision-ephemeral-environment-and-wait`, `get-ephemeral-environment-status`
- `report-dast-findings`, `report-sast-findings`, `report-deps-findings`, `report-secrets-findings`
- `list-workflow-executions`, `get-workflow-execution`, `get-last-run-workflow-detail`
- `get-policy`, `list-policies`
- `list-api-operation-services`, `list-api-operations`, `get-api-operation-detail`
- `list-meeting-filter-options`, `get-meeting-set`
- `mark-entity-distinct`, `unmark-entity-distinct`, `mark-semantic-tests-distinct`
- `get-batch-view-url`, `get-suite-execution-stats`, `get-perf-run`, `get-release-details`
- `create-issue`, `update-issue-status`

`get-eaas-config` is kept as a standalone tool (`POST /api/mcp/get_eaas_config`, empty body) — the skill connectivity check. `destroy-ephemeral-environment` is unchanged and stays destructive.

### Changed

- `get-org-capabilities` advertises `planLabel`, `trial` / `freeTrialActive`, and `chimphandsCredits`
- `get-release` lists when `version` is omitted (`environment`, `pageSize`, `pageToken`, `excludeArchived`); `detail=GATE` replaces `get-release-details`
- `list-meetings` accepts `includeFilterOptions` and `meetingSetId`
- `fetch-execution-report` includes `batchViewUrl`
- `get-execution-history` accepts `aggregate=true`
- `list-perf-runs` accepts `runId` and `includeRaw`
- Request/response field names, proto enums, and int64 strings aligned to Aware OpenAPI 2.0.0 (`docs/static/openapi/mcp.json`): no `agentTraceability` on `upsert-release` / `manage-test-run` / `promote-perf-baseline`; `linkedIssueOrdinalId` and int64 millis on requirement-quality reports; `stateDetails` on `upsert-screen-states`

CLI subcommands match the kebab-case MCP names (existing nested `bot` / `workspace` aliases unchanged).

Old `/api/mcp/*` paths remain hidden server aliases for one client release. This package talks to the new paths.

`server.json` version is 2.0.0. Do not run `mcp-publisher` from this change.
