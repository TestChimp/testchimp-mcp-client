# Changelog

## 2.0.0

Breaking client update for TestChimp MCP API 2.0.0 (Aware PRs #496 and #497). 85 tools.

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

### Removed (replaced by the tools above)

- `get-eaas-config`, `provision-ephemeral-environment`, `provision-ephemeral-environment-and-wait`, `get-ephemeral-environment-status`
- `report-dast-findings`, `report-sast-findings`, `report-deps-findings`, `report-secrets-findings`
- `list-workflow-executions`, `get-workflow-execution`, `get-last-run-workflow-detail`
- `get-policy`, `list-policies`
- `list-api-operation-services`, `list-api-operations`, `get-api-operation-detail`
- `list-meeting-filter-options`, `get-meeting-set`
- `mark-entity-distinct`, `unmark-entity-distinct`, `mark-semantic-tests-distinct`
- `get-batch-view-url`, `get-suite-execution-stats`, `get-perf-run`, `get-release-details`
- `create-issue`, `update-issue-status`

`destroy-ephemeral-environment` is unchanged and stays destructive.

### Changed

- `get-org-capabilities` advertises `planLabel`, `trial` / `freeTrialActive`, and `chimphandsCredits`
- `get-release` lists when `version` is omitted (`environment`, `pageSize`, `pageToken`, `excludeArchived`); `detail=GATE` replaces `get-release-details`
- `list-meetings` accepts `includeFilterOptions` and `meetingSetId`
- `fetch-execution-report` includes `batchViewUrl`
- `get-execution-history` accepts `aggregate=true`
- `list-perf-runs` accepts `runId` and `includeRaw`

CLI subcommands match the kebab-case MCP names (existing nested `bot` / `workspace` aliases unchanged).

Old `/api/mcp/*` paths remain hidden server aliases for one client release. This package talks to the new paths.

`server.json` version is 2.0.0. Do not run `mcp-publisher` from this change.
