# Changelog

## Unreleased

## 2.0.7

### Added

- `list-tests-with-verification-issues` — `POST /api/mcp/list_tests_with_verification_issues`. Tests the signed-in user wrote that a human reviewer flagged as not properly covering a scenario, with the reviewer's note saying what is wrong. Optional `userId` and `limit`. Fix the test, then call `mark-tests-for-review` so the flag resets and the test returns to human review. CLI: `testchimp list-tests-with-verification-issues`. Needs a backend with the endpoint.
- `get-qa-posture` now includes `testsWithVerificationIssuesCount` (distinct tests with a flagged scenario).

`server.json` version is 2.0.7. Do not run `mcp-publisher` from this change.

## 2.0.6

### Added

- Hosted MCP: every tool takes an optional `projectId` argument, sent as `TestChimp-Project-Id`. One user-scoped connector can now serve many repos; a repo names its project with the `projectId` from its `.testchimp/creds.json`. `projectApiKey` still wins when both are given, and a malformed `projectId` is rejected before any upstream call.
- `list-projects` (`POST /api/mcp/list_my_projects`, OAuth connections only): the signed-in user's projects as `{projectId, projectName}`. Used by `/testchimp connect-project`. Needs a backend with the endpoint.
- The CLI reads `<repo>/.testchimp/creds.json` (flat: `projectId`, `projectApiKey`, `userId`, `backendUrl`, `ingressUrl`, optional `cliVersion`) before `.testchimp/mcp.json`, and exports `TESTCHIMP_USER_ID` from it. `mcp.json` (Studio's file) is still read and still written by `save-workspace-creds`, unchanged.

### Changed

- Tool descriptions and errors point hosted / plugin agents at `.testchimp/creds.json`.

## 2.0.5

### Added

- API-key calls to featureservice send `TESTCHIMP_USER_ID` as the `user-id` header (the project key is not per user). Used for per-user agent connectivity and for `invite-team-members` with a project key.

- `get-onboarding-status` — `POST /api/mcp/get_onboarding_status`. Project onboarding progress (the TestChimp setup launchpad steps) plus `nextStepCommand`, the `/testchimp` command to suggest next (empty when the next step is in the TestChimp UI). Optional `userId` (defaults to `TESTCHIMP_USER_ID`). Read-only; needs a backend with the launchpad endpoint.

- `WORKFLOW_STARTED` on `report-agent-action` (preferred first call after minting a ULID).

### Changed

- `report-agent-action` docs: plan re-upsert with `PlanApproved` moves the execution to `PLAN_APPROVED` (after `PLANNED`), so launchpad can show waiting-for-agent instead of awaiting-approval.

`server.json` version is 2.0.5. Do not run `mcp-publisher` from this change.

## 2.0.4

### Added

- `get-proof-points` — `POST /api/mcp/get_proof_points`. Project QA proof points for listings and Dealpuffin-style integrations (`releasesLast30Days`, `scenarioCoveragePercent`, `testScenarioCount`, `windowDays`, `asOfMillis`). Empty body; typically used with a restricted project API key that allows only this tool.

`server.json` version is 2.0.4. Do not run `mcp-publisher` from this change.

## 2.0.3

### Added

- `create-security-scan` — `POST /api/mcp/create_security_scan`. Create a queued release security scan (`version` + exactly one of `dastCheckConfig` / `sastCheckConfig` / `depsCheckConfig` / `leaksCheckConfig`). Returns `{ scanId, prompt }` for `/testchimp run security scan`.
- `upsert-release` optional `focusAreas` (plans `FileScope` entries). Omit or empty = full scenario set.

`server.json` version is 2.0.3. Do not run `mcp-publisher` from this change.

## 2.0.2

### Added

- `ask-user-question-async` — `POST /api/mcp/ask_user_question_async`. Ask a person a question with structured choices when a workflow is running on a cloud agent and no live UI is attached. Requires `workflowExecutionId`. Refuses when `CHIMPHANDS_UI_ATTACHED` is true or `TESTCHIMP_EXECUTION_SOURCE=LOCAL_AGENT`.

`server.json` version is 2.0.2. Do not run `mcp-publisher` from this change.

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
