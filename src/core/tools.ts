import { type z, type ZodTypeAny } from "zod";
import { normalizeScope } from "./normalize.js";
import type { PostMcpFn } from "./client.js";
import { runProvisionEphemeralEnvironmentAndWait, type ProgressLog } from "./ephemeralWait.js";
import * as S from "./schemas.js";
import { resolveGitHeadSha } from "./gitSha.js";
import { buildAgentTraceabilityPayload } from "./agentTraceability.js";

export interface ToolContext {
  postMcp: PostMcpFn;
  onProgress?: ProgressLog;
}

export interface ToolDefinition {
  kebab: string;
  description: string;
  inputSchema: ZodTypeAny;
  execute: (args: unknown, ctx: ToolContext) => Promise<string>;
}

function platformToProtoEnum(platform: "web" | "ios" | "android"): string {
  switch (platform) {
    case "ios":
      return "IOS_EXECUTION_PLATFORM";
    case "android":
      return "ANDROID_EXECUTION_PLATFORM";
    default:
      return "WEB_EXECUTION_PLATFORM";
  }
}

/** Build ExecutionScope JSON after Zod parse (platform aliases already normalized). */
function executionScopeBody(scope: z.infer<typeof S.executionScopeSchema>): Record<string, unknown> {
  return {
    environment: scope.environment,
    timeWindow: scope.timeWindow,
    ...(scope.release != null ? { release: scope.release } : {}),
    ...(scope.branchName != null ? { branchName: scope.branchName } : {}),
    ...(scope.platform != null ? { platform: scope.platform } : {}),
    ...(scope.automationEmitsOnly != null ? { automationEmitsOnly: scope.automationEmitsOnly } : {}),
    ...(scope.metadataFilters != null && scope.metadataFilters.length > 0
      ? { metadataFilters: scope.metadataFilters }
      : {}),
  };
}


function listCoverageBody(args: z.infer<typeof S.listCoverageInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.release != null) body.release = args.release;
  if (args.environment != null) body.environment = args.environment;
  if (args.scope != null) body.scope = normalizeScope(args.scope);
  if (args.includeNonCoveredUserStories != null) body.includeNonCoveredUserStories = args.includeNonCoveredUserStories;
  if (args.includeNonCoveredTestScenarios != null) {
    body.includeNonCoveredTestScenarios = args.includeNonCoveredTestScenarios;
  }
  if (args.branchName != null && args.branchName.trim() !== "") body.branchName = args.branchName.trim();
  if (args.platform != null) body.platform = platformToProtoEnum(args.platform);
  if (args.recordTypes != null && args.recordTypes.length > 0) {
    const normalized = args.recordTypes.map((t) => {
      const raw = String(t).trim();
      if (raw === "manual") return "MANUAL";
      if (raw === "smart_test") return "SMART_TEST";
      return raw;
    });
    body.recordTypes = normalized;
  }
  return body;
}

function listExecutionBody(args: z.infer<typeof S.listExecutionInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.release != null) body.release = args.release;
  if (args.environment != null) body.environment = args.environment;
  if (args.scope != null) body.scope = normalizeScope(args.scope);
  if (args.branchName != null && args.branchName.trim() !== "") body.branchName = args.branchName.trim();
  if (args.scenarioId != null && args.scenarioId.trim() !== "") body.scenarioId = args.scenarioId.trim();
  if (args.testId != null && args.testId.trim() !== "") body.testId = args.testId.trim();
  const dimensionFilters = [...(args.dimensionFilters ?? [])];
  if (args.platform != null) {
    const hasPlatformFilter = dimensionFilters.some(
      (f) => f.dimension === "PLATFORM_EXECUTION_JOB_FILTER_DIMENSION",
    );
    if (!hasPlatformFilter) {
      dimensionFilters.push({
        dimension: "PLATFORM_EXECUTION_JOB_FILTER_DIMENSION",
        values: [args.platform.toUpperCase()],
      });
    }
  }
  if (dimensionFilters.length > 0) body.dimensionFilters = dimensionFilters;
  if (args.limit != null) body.limit = args.limit;
  if (args.offset != null) body.offset = args.offset;
  return body;
}

type RequirementSubjectType = z.infer<typeof S.requirementSubjectTypeSchema>;

function requirementQualitySubjectBody(
  subjectType: RequirementSubjectType,
  opts: { subjectEntityId?: string; ordinalId?: number },
): Record<string, unknown> {
  const body: Record<string, unknown> = { subjectType };
  const entityId = (opts.subjectEntityId ?? "").trim();
  if (entityId !== "") body.subjectEntityId = entityId;
  if (opts.ordinalId != null && opts.ordinalId > 0) body.ordinalId = opts.ordinalId;
  return body;
}

/** Resolve platform subjectEntityId from explicit id or get-requirement-quality-report via ordinal. */
async function resolveRequirementSubjectEntityId(
  postMcp: PostMcpFn,
  subjectType: RequirementSubjectType,
  opts: { subjectEntityId?: string; ordinalId?: number },
): Promise<string> {
  const explicit = (opts.subjectEntityId ?? "").trim();
  if (explicit !== "") return explicit;
  if (opts.ordinalId == null || opts.ordinalId <= 0) {
    throw new Error("Provide subjectEntityId or ordinalId");
  }
  const json = await postMcp(
    "/api/mcp/get_requirement_quality_report",
    requirementQualitySubjectBody(subjectType, { ordinalId: opts.ordinalId }),
  );
  const parsed = JSON.parse(json) as { report?: { subject?: { subjectEntityId?: string } } };
  const resolved = (parsed.report?.subject?.subjectEntityId ?? "").trim();
  if (resolved !== "") return resolved;
  throw new Error(
    `Cannot resolve subjectEntityId for ${subjectType} ordinal ${opts.ordinalId}. ` +
      "Provide --subject-entity-id, or confirm the story/scenario ordinal exists in this project " +
      "(get-requirement-quality-report resolves entity id by ordinal even when no prior report exists).",
  );
}

async function loadRequirementQualityReportJson(
  args: z.infer<typeof S.reportRequirementQualityFindingsInput>,
): Promise<Record<string, unknown>> {
  if (args.report != null && Object.keys(args.report).length > 0) {
    return { ...args.report };
  }
  if (args.reportFile != null && args.reportFile.trim() !== "") {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(args.reportFile.trim(), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }
  return {};
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    kebab: "get-org-capabilities",
    description:
      "Fetch the organization's enabled capabilities (e.g. TRUE_COVERAGE, API_CONTRACT_COVERAGE) and " +
      "freeTrialActive flag. Call before relying on TrueCoverage / API contract coverage features so " +
      "playbooks can soft-skip gated insights instead of failing. Authenticated via project API key.",
    inputSchema: S.emptyInput,
    execute: async (_args, { postMcp }) => postMcp("/api/mcp/get_org_capabilities", {}),
  },
  {
    kebab: "get-requirement-coverage",
    description:
      "Fetch requirement (scenario) coverage under an optional platform-rooted folder scope (tests/... or plans/...). " +
      "Use scope.filePaths or scope.folderPath (platform tests/plans roots). Omit branchName for cross-branch coverage " +
      "(aggregates branch copies; execution jobs deduped by stable hash of tests-root-relative path + test name). " +
      "Pass branchName only when results must be limited to one Git branch. Optional platform (web|ios|android) filters rollup.",
    inputSchema: S.listCoverageInput,
    execute: async (args, { postMcp }) => {
      const json = await postMcp("/api/mcp/list_requirement_coverage", listCoverageBody(args as z.infer<typeof S.listCoverageInput>));
      return json;
    },
  },
  {
    kebab: "get-execution-history",
    description:
      "Fetch SmartTest execution history for a testId (top 5 recent runs), an optional platform-rooted folder/file scope, or a scenario when scenarioId is set. " +
      "Prefer testId when you have it from fetch-execution-report. Typically omit environment to avoid env scoping. " +
      "Use branchName and scope.filePaths as for coverage. Optional platform (web|ios|android) and dimensionFilters narrow results.",
    inputSchema: S.listExecutionInput,
    execute: async (args, { postMcp }) => {
      const json = await postMcp("/api/mcp/list_execution_history", listExecutionBody(args as z.infer<typeof S.listExecutionInput>));
      return json;
    },
  },
  {
    kebab: "fetch-execution-report",
    description:
      "Fetch a detailed execution report for failing SmartTests, given a batchInvocationId (batch run) or jobId (single run). " +
      "Returns only failing tests and includes error details and a trace viewer URL when available.",
    inputSchema: S.fetchExecutionReportInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.fetchExecutionReportInput>;
      const body: Record<string, unknown> = {};
      if (a.batchInvocationId != null && a.batchInvocationId.trim() !== "") body.batchInvocationId = a.batchInvocationId.trim();
      if (a.jobId != null && a.jobId.trim() !== "") body.jobId = a.jobId.trim();
      return postMcp("/api/mcp/fetch_execution_report", body);
    },
  },
  {
    kebab: "create-user-story",
    description:
      "Create a user story on the TestChimp project and allocate a real US-<ordinalId>. " +
      "Response includes content: canonical stub markdown already containing id: US-<ordinalId>. " +
      "BLOCKING workflow: call this FIRST → Write the returned content to the repo plans/stories path " +
      "(edit body as needed but keep id:) → call update-user-story with the full markdown. " +
      "Never write story markdown that omits id. platformFilePath must be under plans/stories/ and end with .md. " +
      "Optional agentTraceability (or flat workflowId/workflowExecutionId/policyFile/policyVersion/gitSha/…) " +
      "records AGENT_WORKFLOW_ACTIVITY inline — no separate report-agent-action needed for this create.",
    inputSchema: S.createUserStoryInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.createUserStoryInput>;
      const body: Record<string, unknown> = {
        platformFilePath: a.platformFilePath,
        title: a.title,
      };
      const trace = buildAgentTraceabilityPayload(a);
      if (trace) body.agentTraceability = trace;
      return postMcp("/api/mcp/create_user_story", body);
    },
  },
  {
    kebab: "create-test-scenario",
    description:
      "Create a test scenario linked to a user story and allocate a real TS-<ordinalId>. " +
      "Response includes content: canonical stub markdown already containing id: TS-<ordinalId> and story: US-<n>. " +
      "BLOCKING workflow: call this FIRST → Write the returned content to the repo plans/scenarios path " +
      "(edit body as needed but keep id: and story:) → call update-test-scenario with the full markdown. " +
      "Never write scenario markdown that omits id. update-test-scenario rejects missing id/story with a clear error. " +
      "platformFilePath must be under plans/scenarios/ and end with .md. " +
      "userStoryOrdinalId is the numeric part of the parent US-<n> id. " +
      "Optional agentTraceability records Activity inline (no separate report-agent-action for this create).",
    inputSchema: S.createTestScenarioInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.createTestScenarioInput>;
      const body: Record<string, unknown> = {
        platformFilePath: a.platformFilePath,
        title: a.title,
        userStoryOrdinalId: a.userStoryOrdinalId,
      };
      const trace = buildAgentTraceabilityPayload(a);
      if (trace) body.agentTraceability = trace;
      return postMcp("/api/mcp/create_test_scenario", body);
    },
  },
  {
    kebab: "update-user-story",
    description:
      "Sync a user story markdown file to the platform after local edits. " +
      "Requires frontmatter id: US-<n> (platform-issued). Missing id returns an error telling you to call create-user-story first. " +
      "Parses frontmatter (id, title, priority) and updates the linked support file and entity. " +
      "Optional agentTraceability records UPDATED Activity inline.",
    inputSchema: S.updatePlanMarkdownInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.updatePlanMarkdownInput>;
      const body: Record<string, unknown> = { content: a.content };
      const trace = buildAgentTraceabilityPayload(a);
      if (trace) body.agentTraceability = trace;
      return postMcp("/api/mcp/update_user_story", body);
    },
  },
  {
    kebab: "update-test-scenario",
    description:
      "Sync a test scenario markdown file to the platform after local edits. " +
      "Requires frontmatter id: TS-<n> and story: US-<n>. Missing either returns an error telling you to call create-test-scenario first. " +
      "Parses frontmatter and updates linking if story changes. " +
      "Optional agentTraceability records UPDATED Activity inline.",
    inputSchema: S.updatePlanMarkdownInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.updatePlanMarkdownInput>;
      const body: Record<string, unknown> = { content: a.content };
      const trace = buildAgentTraceabilityPayload(a);
      if (trace) body.agentTraceability = trace;
      return postMcp("/api/mcp/update_test_scenario", body);
    },
  },
  {
    kebab: "get-user-stories",
    description:
      "Fetch user stories from the TestChimp platform by ordinal id (numeric part of US-<n>). " +
      "Returns full plan markdown content, title, and platform file path for each found story. " +
      "Use when plan files are not yet synced to the repo.",
    inputSchema: S.getUserStoriesInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getUserStoriesInput>;
      return postMcp("/api/mcp/get_user_stories", {
        userStoryOrdinalIds: a.userStoryOrdinalIds,
      });
    },
  },
  {
    kebab: "get-test-scenarios",
    description:
      "Fetch test scenarios from the TestChimp platform by ordinal id (numeric part of TS-<n>) " +
      "and/or external TMS ids (e.g. C12345, PROJ-101 — server strips prefixes and matches numerical part). " +
      "Returns full plan markdown content, title, platform file path, linked user story ordinal ids, " +
      "and external_source / external_system_id when present. " +
      "Use when plan files are not yet synced to the repo, or when linking imported tests to scenarios by TMS id.",
    inputSchema: S.getTestScenariosInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getTestScenariosInput>;
      const body: Record<string, unknown> = {};
      if (a.scenarioOrdinalIds?.length) body.scenarioOrdinalIds = a.scenarioOrdinalIds;
      if (a.externalIds?.length) body.externalIds = a.externalIds;
      return postMcp("/api/mcp/get_test_scenarios", body);
    },
  },
  {
    kebab: "get-manual-session-details",
    description:
      "Fetch a manual test session by id. Returns project id, title, environment, steps " +
      "(playwright commands, signed screenshot URLs, notes), and linked scenario ordinal ids. " +
      "Use when authoring a SmartTest from a recorded manual session.",
    inputSchema: S.getManualSessionDetailsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getManualSessionDetailsInput>;
      return postMcp("/api/mcp/get_manual_session_details", {
        manualSessionId: a.manualSessionId,
      });
    },
  },
  {
    kebab: "get-issue-details",
    description:
      "Fetch a TestChimp issue (bug) by ordinal id. Accepts flexible issueId formats: " +
      "#B-123, B-123, #B123, B123, or plain 123. Returns title, description, status, linked entities, " +
      "artifact references, and short-lived signed URLs for GCS attachments/screenshots.",
    inputSchema: S.getIssueDetailsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getIssueDetailsInput>;
      return postMcp("/api/mcp/get_issue_details", {
        issueId: a.issueId.trim(),
      });
    },
  },
  {
    kebab: "update-issue-status",
    description:
      "Update a TestChimp issue status by ordinal id (same flexible issueId formats as get-issue-details). " +
      "status must be one of: ACTIVE, IGNORED, FIXED, DUPLICATE, IN_PROGRESS_BUG, ARCHIVED_BUG, BLOCKED. " +
      "For /testchimp fix issue: set IN_PROGRESS_BUG after applying a code fix; set FIXED only after user confirmation / commits pushed. " +
      "Optional ignoreReason when status is IGNORED: INTENDED_BEHAVIOUR | INACCURATE_ASSESSMENT | NOT_IMPORTANT. " +
      "Optional agentTraceability records UPDATED Activity inline " +
      "(requires both workflowId and workflowExecutionId for Activity attachment).",
    inputSchema: S.updateIssueStatusInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.updateIssueStatusInput>;
      const body: Record<string, unknown> = {
        issueId: a.issueId.trim(),
        status: a.status,
      };
      if (a.ignoreReason) body.ignoreReason = a.ignoreReason;
      const trace = buildAgentTraceabilityPayload(a);
      if (trace) body.agentTraceability = trace;
      return postMcp("/api/mcp/update_issue_status", body);
    },
  },
  {
    kebab: "create-issue",
    description:
      "Create a TestChimp issue in the current project. title is required. " +
      "Use simple fields for common creates, or pass the full curated contract via --json-input " +
      "(description, issueType, category, severity, status, reportedReleaseId, dueDateMillis, assignee, " +
      "linkTargets, labels, source, environment, attachments, artifactReference). " +
      "For /testchimp implement TASK_ISSUE creates: set labels=[\"TestChimp Implement\"] (not source), " +
      "severity from task priority, category (e.g. FUNCTIONAL), and linkTargets for STORY and/or SCENARIO ordinals. " +
      "Optional agentTraceability (or flat workflowId/workflowExecutionId/policyFile/…) records CREATED Activity inline — " +
      "prefer this over a separate report-agent-action for issue creates. " +
      "For Activity/timeline attachment both workflowId and workflowExecutionId (stable Plan ULID) are required; " +
      "do not omit workflowExecutionId or mint a new ULID per issue. " +
      "Authenticated via project API key; project is resolved from the key.",
    inputSchema: S.createIssueInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.createIssueInput>;
      const body: Record<string, unknown> = { title: a.title.trim() };
      if (a.description != null) body.description = a.description;
      if (a.issueType) body.issueType = a.issueType;
      if (a.category) body.category = a.category;
      if (a.severity) body.severity = a.severity;
      if (a.status) body.status = a.status;
      if (a.reportedReleaseId != null) body.reportedReleaseId = a.reportedReleaseId;
      if (a.dueDateMillis != null) body.dueDateMillis = a.dueDateMillis;
      if (a.assignee != null) body.assignee = a.assignee;
      if (a.linkTargets?.length) body.linkTargets = a.linkTargets;
      if (a.labels?.length) body.labels = a.labels;
      if (a.source != null) body.source = a.source;
      if (a.environment != null) body.environment = a.environment;
      if (a.attachments?.length) body.attachments = a.attachments;
      if (a.artifactReference != null) body.artifactReference = a.artifactReference;
      const trace = buildAgentTraceabilityPayload(a);
      if (trace) body.agentTraceability = trace;
      return postMcp("/api/mcp/create_issue", body);
    },
  },
  {
    kebab: "mark-plan-items-implementation-done",
    description:
      "Mark user stories and/or test scenarios implementation-complete in platform lifecycle (DB only; does not rewrite plan markdown). " +
      "Use scenarioOrdinalIds / userStoryOrdinalIds (numeric parts of TS-<n> / US-<n>).",
    inputSchema: S.markPlanItemsImplementationDoneInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.markPlanItemsImplementationDoneInput>;
      const body: Record<string, unknown> = {};
      if (a.scenarioOrdinalIds?.length) body.scenarioOrdinalIds = a.scenarioOrdinalIds;
      if (a.userStoryOrdinalIds?.length) body.userStoryOrdinalIds = a.userStoryOrdinalIds;
      return postMcp("/api/mcp/mark_plan_items_implementation_done", body);
    },
  },
  {
    kebab: "update-plan-items-lifecycle-status",
    description:
      "Update lifecycle_fields.status for one user story or test scenario (DB only; does not rewrite plan markdown). " +
      "entityType: story | scenario; ordinalId: numeric US-/TS- ordinal; status: draft | ready | in progress | blocked | done | archived. " +
      "Used after /testchimp implement to set status to ready (unless policy overrides).",
    inputSchema: S.updatePlanItemsLifecycleStatusInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.updatePlanItemsLifecycleStatusInput>;
      return postMcp("/api/mcp/update_plan_items_lifecycle_status", {
        entityType: a.entityType,
        ordinalId: a.ordinalId,
        status: a.status,
      });
    },
  },
  {
    kebab: "get-spec-lifecycle-details",
    description:
      "Fetch lifecycle_fields for user stories and/or test scenarios by ordinal id (DB only; no markdown). " +
      "Pass scenarioIds / storyIds as lists of bare ordinals (canonical) or prefixed forms (TS-107, #US-12). " +
      "Use after identifying scenarios in scope for create-tests to read verification_strategy (auto|manual) and skip manual ones.",
    inputSchema: S.getSpecLifecycleDetailsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getSpecLifecycleDetailsInput>;
      const body: Record<string, unknown> = {};
      if (a.scenarioIds?.length) body.scenarioIds = a.scenarioIds;
      if (a.storyIds?.length) body.storyIds = a.storyIds;
      return postMcp("/api/mcp/get_spec_lifecycle_details", body);
    },
  },
  {
    kebab: "get-eaas-config",
    description:
      "Return the project's BunnyShell (Environment-as-a-Service) settings. Secrets are never returned.",
    inputSchema: S.emptyInput,
    execute: async (_args, { postMcp }) => postMcp("/api/mcp/get_eaas_config", {}),
  },
  {
    kebab: "get-branch-specific-endpoint-config",
    description:
      "Resolve BASE_URL for a Git branch from TestChimp Branch Management (URL template and per-branch overrides).",
    inputSchema: S.getBranchSpecificEndpointConfigInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getBranchSpecificEndpointConfigInput>;
      const body: Record<string, unknown> = {};
      if (a.branchName != null && a.branchName.trim() !== "") body.branchName = a.branchName.trim();
      return postMcp("/api/mcp/get_branch_specific_endpoint_config", body);
    },
  },
  {
    kebab: "provision-ephemeral-environment-and-wait",
    description:
      "Provision a BunnyShell ephemeral environment, then poll until deployed and component URLs are available. " +
      "Progress is logged to stderr (CLI) or MCP logging when supported.",
    inputSchema: S.provisionEphemeralWaitInput,
    execute: async (args, { postMcp, onProgress }) => {
      const a = args as z.infer<typeof S.provisionEphemeralWaitInput>;
      return runProvisionEphemeralEnvironmentAndWait(postMcp, onProgress, {
        branchName: a.branchName,
        pollIntervalSeconds: a.pollIntervalSeconds,
        maxWaitMinutes: a.maxWaitMinutes,
      });
    },
  },
  {
    kebab: "provision-ephemeral-environment",
    description:
      "Create a BunnyShell ephemeral environment (create + deploy trigger only). Prefer provision-ephemeral-environment-and-wait for normal flows.",
    inputSchema: S.provisionEphemeralInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.provisionEphemeralInput>;
      const body: Record<string, unknown> = {};
      if (a.branchName != null && a.branchName.trim() !== "") body.branchName = a.branchName.trim();
      return postMcp("/api/mcp/provision_ephemeral_environment", body);
    },
  },
  {
    kebab: "get-ephemeral-environment-status",
    description: "Poll BunnyShell for environment status and component_urls_json.",
    inputSchema: S.bnsEnvironmentIdInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.bnsEnvironmentIdInput>;
      return postMcp("/api/mcp/get_ephemeral_environment_status", { bnsEnvironmentId: a.bnsEnvironmentId });
    },
  },
  {
    kebab: "destroy-ephemeral-environment",
    description: "Delete a BunnyShell environment created for this project.",
    inputSchema: S.bnsEnvironmentIdInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.bnsEnvironmentIdInput>;
      return postMcp("/api/mcp/destroy_ephemeral_environment", { bnsEnvironmentId: a.bnsEnvironmentId });
    },
  },
  {
    kebab: "list-bunnyshell-environment-events",
    description: "Troubleshooting: list BunnyShell platform events for an environment.",
    inputSchema: S.listBunnyshellEnvironmentEventsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.listBunnyshellEnvironmentEventsInput>;
      const body: Record<string, unknown> = { bnsEnvironmentId: a.bnsEnvironmentId };
      if (a.eventType != null && a.eventType.trim() !== "") body.eventType = a.eventType.trim();
      if (a.eventStatus != null && a.eventStatus.trim() !== "") body.eventStatus = a.eventStatus.trim();
      if (a.page != null) body.page = a.page;
      return postMcp("/api/mcp/list_bunnyshell_environment_events", body);
    },
  },
  {
    kebab: "list-bunnyshell-workflow-jobs",
    description: "Troubleshooting: list BunnyShell workflow jobs for an environment.",
    inputSchema: S.listBunnyshellWorkflowJobsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.listBunnyshellWorkflowJobsInput>;
      const body: Record<string, unknown> = { bnsEnvironmentId: a.bnsEnvironmentId };
      if (a.page != null) body.page = a.page;
      return postMcp("/api/mcp/list_bunnyshell_workflow_jobs", body);
    },
  },
  {
    kebab: "get-bunnyshell-workflow-job-logs",
    description: "Troubleshooting: fetch logs for a BunnyShell workflow job.",
    inputSchema: S.getBunnyshellWorkflowJobLogsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getBunnyshellWorkflowJobLogsInput>;
      return postMcp("/api/mcp/get_bunnyshell_workflow_job_logs", {
        bnsEnvironmentId: a.bnsEnvironmentId,
        workflowJobId: a.workflowJobId,
      });
    },
  },
  {
    kebab: "list-rum-environments",
    description:
      "List distinct RUM environment tags for this project. Call this first to choose environment values " +
      "for TrueCoverage ExecutionScope.environment (e.g. QA, production).",
    inputSchema: S.emptyInput,
    execute: async (_args, { postMcp }) => postMcp("/api/mcp/list_rum_environments", {}),
  },
  {
    kebab: "get-truecoverage-events",
    description:
      "TrueCoverage event funnel summaries (ListEventsRequest). " +
      "baseExecutionScope is the real-user / primary environment; optional comparisonExecutionScope for coverage " +
      "(set automationEmitsOnly:true on comparison for test-tagged emits only). " +
      "Each scope needs environment + timeWindow: { relativeWindow: \"604800s\" } or { fixedWindow: { startTime, endTime } } (RFC 3339). " +
      "Optional platform: web|ios|android or WEB_/IOS_/ANDROID_EXECUTION_PLATFORM. " +
      "Prefer list-rum-environments first.",
    inputSchema: S.listTruecoverageEventsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.listTruecoverageEventsInput>;
      const body: Record<string, unknown> = {
        baseExecutionScope: executionScopeBody(a.baseExecutionScope),
      };
      if (a.comparisonExecutionScope != null) {
        body.comparisonExecutionScope = executionScopeBody(a.comparisonExecutionScope);
      }
      return postMcp("/api/mcp/truecoverage_list_events", body);
    },
  },
  {
    kebab: "get-truecoverage-event-details",
    description:
      "TrueCoverage drill-down for one event (GetEventDetailsRequest). " +
      "Requires eventTitle plus baseExecutionScope (environment + timeWindow). " +
      "Optional comparisonExecutionScope for coverage columns (automationEmitsOnly on comparison). " +
      "Same timeWindow / platform rules as get-truecoverage-events.",
    inputSchema: S.getTruecoverageEventDetailsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getTruecoverageEventDetailsInput>;
      const body: Record<string, unknown> = {
        eventTitle: a.eventTitle,
        baseExecutionScope: executionScopeBody(a.baseExecutionScope),
      };
      if (a.comparisonExecutionScope != null) {
        body.comparisonExecutionScope = executionScopeBody(a.comparisonExecutionScope);
      }
      return postMcp("/api/mcp/truecoverage_event_details", body);
    },
  },
  {
    kebab: "get-truecoverage-child-event-tree",
    description:
      "TrueCoverage next-event tree after an event (ListChildEventTreeRequest). " +
      "Requires eventTitle, baseScope (environment + timeWindow); optional coverageScope for PRESENT/ABSENT. " +
      "Note: metadataFilters on scopes are ignored for transition stats. Field names are baseScope/coverageScope " +
      "(not baseExecutionScope).",
    inputSchema: S.listTruecoverageChildEventTreeInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.listTruecoverageChildEventTreeInput>;
      const body: Record<string, unknown> = {
        eventTitle: a.eventTitle,
        baseScope: executionScopeBody(a.baseScope),
      };
      if (a.coverageScope != null) body.coverageScope = executionScopeBody(a.coverageScope);
      return postMcp("/api/mcp/truecoverage_list_child_event_tree", body);
    },
  },
  {
    kebab: "get-truecoverage-event-transition",
    description:
      "TrueCoverage detailed transition stats between two events (GetDetailedEventTransitionSummaryRequest). " +
      "Requires eventTitle, nextEventTitle, baseScope (environment + timeWindow); optional coverageScope. " +
      "metadataFilters on scopes are ignored. Uses baseScope/coverageScope field names.",
    inputSchema: S.getTruecoverageEventTransitionInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getTruecoverageEventTransitionInput>;
      const body: Record<string, unknown> = {
        eventTitle: a.eventTitle,
        nextEventTitle: a.nextEventTitle,
        baseScope: executionScopeBody(a.baseScope),
      };
      if (a.coverageScope != null) body.coverageScope = executionScopeBody(a.coverageScope);
      return postMcp("/api/mcp/truecoverage_detailed_event_transition", body);
    },
  },
  {
    kebab: "get-truecoverage-event-time-series",
    description:
      "TrueCoverage daily time series for one metric (EventTimeSeriesRequest). " +
      "Requires baseExecutionScope (environment + timeWindow). Optional eventTitle and metricType: " +
      "SESSION_COUNT | RELATIVE_FREQUENCY | PERCENTAGE_TERMINAL_EVENT | SESSION_POSITION | " +
      "TIME_TO_NEXT_EVENT | REVERSE_INDEX | TIME_FROM_START | TIME_TO_END | TIME_SINCE_PREVIOUS_EVENT.",
    inputSchema: S.getTruecoverageEventTimeSeriesInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getTruecoverageEventTimeSeriesInput>;
      const body: Record<string, unknown> = {
        baseExecutionScope: executionScopeBody(a.baseExecutionScope),
      };
      if (a.eventTitle != null) body.eventTitle = a.eventTitle;
      if (a.metricType != null) body.metricType = a.metricType;
      return postMcp("/api/mcp/truecoverage_event_time_series", body);
    },
  },
  {
    kebab: "get-truecoverage-session-metadata-keys",
    description: "List session-level metadata keys observed in RUM for TrueCoverage filters.",
    inputSchema: S.emptyInput,
    execute: async (_args, { postMcp }) => postMcp("/api/mcp/truecoverage_session_metadata_keys", {}),
  },
  {
    kebab: "get-truecoverage-event-metadata-keys",
    description:
      "List metadata keys for a given event title (ListEventMetadataKeysRequest). " +
      "Pass eventTitle (CLI: --event-title or json-input).",
    inputSchema: S.eventMetadataKeysInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.eventMetadataKeysInput>;
      return postMcp("/api/mcp/truecoverage_event_metadata_keys", { eventTitle: a.eventTitle });
    },
  },
  {
    kebab: "list-screen-states",
    description:
      "Fetch the project's screen/state vocabulary (relational atlas) for SmartTests and traces. " +
      "Optional environment field is accepted for forward compatibility; v1 may be project-global.",
    inputSchema: S.listScreenStatesInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.listScreenStatesInput>;
      const body: Record<string, unknown> = {};
      if (a.environment != null && a.environment.trim() !== "") body.environment = a.environment.trim();
      return postMcp("/api/mcp/list_screen_states", body);
    },
  },
  {
    kebab: "get-release",
    description:
      "Fetch release catalog details for a version/label in the current project " +
      "(McpGetReleaseRequest/Response: cut git SHA, prior release + SHA, focus areas, payload). " +
      "Pass version (CLI: --version). Authenticated via project API key.",
    inputSchema: S.getReleaseInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getReleaseInput>;
      // McpGetReleaseRequest — camelCase JSON field names per JsonFormat
      const body: { version: string } = { version: a.version.trim() };
      return postMcp("/api/mcp/get_release", body);
    },
  },
  {
    kebab: "get-release-details",
    description:
      "Fetch gate-oriented release details for a version/label: scope, per-environment " +
      "priority×status test stats, open issue stats, scan summaries, and detailed in-scope " +
      "scenario/issue records (McpGetReleaseDetailsRequest/Response). Pass version (CLI: --version). " +
      "Use for CI/agent release gating. Authenticated via project API key.",
    inputSchema: S.getReleaseDetailsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getReleaseDetailsInput>;
      const body: { version: string } = { version: a.version.trim() };
      return postMcp("/api/mcp/get_release_details", body);
    },
  },
  {
    kebab: "get-security-scan-config",
    description:
      "Fetch security scan config by scan id (detail.dastCheckConfig / detail.sastCheckConfig / " +
      "detail.depsCheckConfig / detail.leaksCheckConfig, release label, status). Pass id (CLI: --id). " +
      "Used by /testchimp run security scan. For DAST honour allowActiveScan / useEphemeralSandbox / scope " +
      "on dastCheckConfig.",
    inputSchema: S.getSecurityScanConfigInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getSecurityScanConfigInput>;
      return postMcp("/api/mcp/get_security_scan_config", { scanId: a.id.trim() });
    },
  },
  {
    kebab: "update-scan-progress",
    description:
      "Update a scan's status. status must be one of: QUEUED, IN_PROGRESS, COMPLETED, EXCEPTION. " +
      "Call IN_PROGRESS when starting. Each scan is a single checker type: the category playbook " +
      "sets COMPLETED after a successful report-*-findings (or EXCEPTION on hard failure).",
    inputSchema: S.updateScanProgressInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.updateScanProgressInput>;
      return postMcp("/api/mcp/update_scan_progress", {
        scanId: a.id.trim(),
        status: a.status,
      });
    },
  },
  {
    kebab: "report-dast-findings",
    description:
      "Upload a ZAP Traditional JSON report for a security scan. Pass --id and --report-file <path>. " +
      "Backend parses alerts, dedupes by bug hash, and inserts new SECURITY bugs linked to the scan. " +
      "Does not mark the scan COMPLETED — the DAST playbook calls update-scan-progress COMPLETED after this.",
    inputSchema: S.reportDastFindingsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.reportDastFindingsInput>;
      const { readFile } = await import("node:fs/promises");
      const reportJson = await readFile(a.reportFile, "utf8");
      return postMcp("/api/mcp/report_dast_findings", {
        scanId: a.id.trim(),
        reportJson,
      });
    },
  },
  {
    kebab: "report-sast-findings",
    description:
      "Upload a full Semgrep CLI JSON report for a SAST security scan. Pass --id and --report-file <path>. " +
      "Backend stores the raw report, parses results, dedupes by bug hash, and inserts new SECURITY bugs. " +
      "Does not mark the scan COMPLETED — the SAST playbook calls update-scan-progress COMPLETED after this.",
    inputSchema: S.reportSastFindingsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.reportSastFindingsInput>;
      const { readFile } = await import("node:fs/promises");
      const reportJson = await readFile(a.reportFile, "utf8");
      return postMcp("/api/mcp/report_sast_findings", {
        scanId: a.id.trim(),
        reportJson,
      });
    },
  },
  {
    kebab: "report-secrets-findings",
    description:
      "Upload a full Gitleaks JSON report for a secrets security scan. Pass --id and --report-file <path>. " +
      "Backend redacts secret payloads, stores the report, dedupes by bug hash, and inserts SECURITY bugs. " +
      "Does not mark the scan COMPLETED — the secrets playbook calls update-scan-progress COMPLETED after this.",
    inputSchema: S.reportSecretsFindingsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.reportSecretsFindingsInput>;
      const { readFile } = await import("node:fs/promises");
      const reportJson = await readFile(a.reportFile, "utf8");
      return postMcp("/api/mcp/report_secrets_findings", {
        scanId: a.id.trim(),
        reportJson,
      });
    },
  },
  {
    kebab: "report-deps-findings",
    description:
      "Upload a full Trivy JSON report for a dependency security scan. Pass --id and --report-file <path>. " +
      "Backend stores the report, filters by security profile / ignore-unfixed, dedupes, and inserts SECURITY bugs. " +
      "Does not mark the scan COMPLETED — the deps playbook calls update-scan-progress COMPLETED after this.",
    inputSchema: S.reportDepsFindingsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.reportDepsFindingsInput>;
      const { readFile } = await import("node:fs/promises");
      const reportJson = await readFile(a.reportFile, "utf8");
      return postMcp("/api/mcp/report_deps_findings", {
        scanId: a.id.trim(),
        reportJson,
      });
    },
  },
  {
    kebab: "upsert-screen-states",
    description:
      "Merge screen names and state strings into the project's relational atlas (idempotent upsert). " +
      "Body uses camelCase screenStates: [{ screen, states: string[] }, ...] per UpsertScreenStatesRequest.",
    inputSchema: S.upsertScreenStatesInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.upsertScreenStatesInput>;
      return postMcp("/api/mcp/upsert_screen_states", { screenStates: a.screenStates });
    },
  },
  {
    kebab: "list-semantic-similar-tests",
    description:
      "List semantically similar SmartTest pairs in scope using TestLocators (no test_id). " +
      "Pairs are deduped (A→B only when A.testId < B.testId). Distinct-marked pairs are excluded.",
    inputSchema: S.listSemanticSimilarTestsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.listSemanticSimilarTestsInput>;
      const body: Record<string, unknown> = {};
      if (a.scope != null) body.scope = normalizeScope(a.scope);
      return postMcp("/api/mcp/list_semantic_similar_tests", body);
    },
  },
  {
    kebab: "mark-semantic-tests-distinct",
    description:
      "Mark two SmartTests as legitimately distinct (symmetric) using TestLocators. " +
      "Agent/API calls use marked_by_user_id = 0.",
    inputSchema: S.markSemanticTestsDistinctInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.markSemanticTestsDistinctInput>;
      return postMcp("/api/mcp/mark_semantic_tests_distinct", {
        focusTest: a.focusTest,
        distinctTest: a.distinctTest,
      });
    },
  },
  {
    kebab: "list-semantic-nearby",
    description:
      "List semantically nearby entities across types (Story/Scenario/Test/Issue/Event). " +
      "TEST uses TestLocator; STORY/SCENARIO/ISSUE use sourceOrdinalId; EVENT uses sourceEventTitle. " +
      "Response TEST hits include TestLocator (never platform test_id).",
    inputSchema: S.listSemanticNearbyInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.listSemanticNearbyInput>;
      const body: Record<string, unknown> = {
        sourceEntityType: a.sourceEntityType,
      };
      if (a.sourceTest) body.sourceTest = a.sourceTest;
      if (a.sourceOrdinalId != null) body.sourceOrdinalId = Number(a.sourceOrdinalId);
      if (a.sourceEventTitle) body.sourceEventTitle = a.sourceEventTitle;
      if (a.targetEntityTypes?.length) body.targetEntityTypes = a.targetEntityTypes;
      if (a.limit != null) body.limit = a.limit;
      return postMcp("/api/mcp/list_semantic_nearby", body);
    },
  },
  {
    kebab: "mark-entity-distinct",
    description:
      "Mark two same-type entities as distinct. TEST uses TestLocators; " +
      "STORY/SCENARIO/ISSUE use ordinals; EVENT uses titles.",
    inputSchema: S.markEntityDistinctInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.markEntityDistinctInput>;
      const body: Record<string, unknown> = { entityType: a.entityType };
      if (a.focusTest) body.focusTest = a.focusTest;
      if (a.otherTest) body.otherTest = a.otherTest;
      if (a.focusOrdinalId != null) body.focusOrdinalId = Number(a.focusOrdinalId);
      if (a.otherOrdinalId != null) body.otherOrdinalId = Number(a.otherOrdinalId);
      if (a.focusEventTitle) body.focusEventTitle = a.focusEventTitle;
      if (a.otherEventTitle) body.otherEventTitle = a.otherEventTitle;
      return postMcp("/api/mcp/mark_entity_distinct", body);
    },
  },
  {
    kebab: "unmark-entity-distinct",
    description:
      "Remove a distinct mark between two same-type entities (same identity rules as mark-entity-distinct).",
    inputSchema: S.markEntityDistinctInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.markEntityDistinctInput>;
      const body: Record<string, unknown> = { entityType: a.entityType };
      if (a.focusTest) body.focusTest = a.focusTest;
      if (a.otherTest) body.otherTest = a.otherTest;
      if (a.focusOrdinalId != null) body.focusOrdinalId = Number(a.focusOrdinalId);
      if (a.otherOrdinalId != null) body.otherOrdinalId = Number(a.otherOrdinalId);
      if (a.focusEventTitle) body.focusEventTitle = a.focusEventTitle;
      if (a.otherEventTitle) body.otherEventTitle = a.otherEventTitle;
      return postMcp("/api/mcp/unmark_entity_distinct", body);
    },
  },
  {
    kebab: "get-requirement-quality-report",
    description:
      "Fetch the stored requirement quality report (metrics + findings with user states) for a user story or test scenario. " +
      "Use before local DeFOSPAM to dedupe: do not re-report findings already IGNORED or APPLIED (match by fingerprint). " +
      "Pass subjectType STORY|SCENARIO plus subjectEntityId or ordinalId (numeric part of US-<n> / TS-<n>). " +
      "When no prior report exists, response still includes report.subject with resolved subjectEntityId.",
    inputSchema: S.getRequirementQualityReportInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getRequirementQualityReportInput>;
      return postMcp(
        "/api/mcp/get_requirement_quality_report",
        requirementQualitySubjectBody(a.subjectType, {
          subjectEntityId: a.subjectEntityId,
          ordinalId: a.ordinalId,
        }),
      );
    },
  },
  {
    kebab: "report-requirement-quality-findings",
    description:
      "Upload a DeFOSPAM / requirement quality analysis report for a user story or test scenario (local-agent path). " +
      "Pass full RequirementQualityReport JSON via --report-file or --json-input {\"report\":{...}}. " +
      "report.subject.subjectEntityId is required; use --subject-type + --ordinal-id to resolve via get-requirement-quality-report, " +
      "or set subjectEntityId explicitly. Backend merges IGNORED/APPLIED findings carry-forward on re-report.",
    inputSchema: S.reportRequirementQualityFindingsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.reportRequirementQualityFindingsInput>;
      const report = await loadRequirementQualityReportJson(a);
      const subjectRaw = (report.subject ?? {}) as Record<string, unknown>;
      const subjectType = (a.subjectType ?? subjectRaw.subjectType) as RequirementSubjectType | undefined;
      const ordinalId =
        a.ordinalId ??
        (typeof subjectRaw.ordinalId === "number" ? subjectRaw.ordinalId : undefined);
      let subjectEntityId =
        (a.subjectEntityId ?? (typeof subjectRaw.subjectEntityId === "string" ? subjectRaw.subjectEntityId : "")).trim();

      if (subjectEntityId === "" && subjectType != null) {
        subjectEntityId = await resolveRequirementSubjectEntityId(postMcp, subjectType, {
          ordinalId,
        });
      }

      if (subjectEntityId === "") {
        throw new Error(
          "report.subject.subjectEntityId is required (set in report JSON, --subject-entity-id, or resolvable via --ordinal-id)",
        );
      }

      const mergedSubject: Record<string, unknown> = {
        ...subjectRaw,
        ...(subjectType != null ? { subjectType } : {}),
        subjectEntityId,
        ...(ordinalId != null ? { ordinalId } : {}),
      };
      report.subject = mergedSubject;

      return postMcp("/api/mcp/report_requirement_quality_findings", { report });
    },
  },
  {
    kebab: "report-agent-action",
    description:
      "Report a mutating agent action under a stable workflow-execution-id (ULID). " +
      "First call for an id creates the workflow_executions row; later calls append Activity " +
      "timeline rows (AGENT_WORKFLOW_ACTIVITY). " +
      "Actions land on the entity's Activity timeline (plans, issues, SmartTest file). " +
      "entityType: USER_STORY | SCENARIO | SMART_TEST | POLICY | ISSUE | TEST_EXECUTION | " +
      "TEST_INVOCATION_BATCH | EXPLORATION | EVENT | WORKFLOW. " +
      "actionType: CREATED | UPDATED | DELETED | ANALYZED | IMPLEMENTED | ACTION_COMPLETED | ACTION_FAILED. " +
      "Identity: SMART_TEST uses `test` (TestLocator: folderPath/fileName/testSuite/testName); " +
      "other artifact types use `entityIdentity` (ordinal / filename / opaque id). Do not use platform UUIDs. " +
      "Completion (ACTION_COMPLETED / ACTION_FAILED): entityType WORKFLOW and entityIdentity = catalog workflow_id.",
    inputSchema: S.reportAgentActionInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.reportAgentActionInput>;
      const actorRaw = (a.actorType ?? "local-agent").toString();
      const actorType =
        actorRaw.toUpperCase().replace(/-/g, "_") === "CLOUD_AGENT" ? "CLOUD_AGENT" : "LOCAL_AGENT";
      const actionNorm = a.actionType.toString().toUpperCase().replace(/-/g, "_");
      let actionType = actionNorm;
      if (actionNorm === "COMPLETED" || actionNorm === "ACTION_COMPLETED") {
        actionType = "ACTION_COMPLETED";
      } else if (actionNorm === "FAILED" || actionNorm === "ACTION_FAILED") {
        actionType = "ACTION_FAILED";
      }
      const body: Record<string, unknown> = {
        workflowId: a.workflowId,
        workflowExecutionId: a.workflowExecutionId,
        actionType,
        actorType,
        entityType: a.entityType,
      };
      if (a.policyFile) body.policyFile = a.policyFile;
      if (a.policyVersion) body.policyVersion = a.policyVersion;
      const gitSha = resolveGitHeadSha(a.gitSha);
      if (gitSha) body.gitSha = gitSha;
      if (a.userId) body.userId = a.userId;
      else if (process.env.TESTCHIMP_USER_ID) body.userId = process.env.TESTCHIMP_USER_ID;
      if (a.branchName) body.branchName = a.branchName;
      // Nested traceability wins for agentModel; only fill from flat/env when nested omits it.
      if (a.traceability && typeof a.traceability === "object") {
        const nested = { ...a.traceability } as Record<string, unknown>;
        const nestedModel =
          nested.agentModel != null && String(nested.agentModel).trim() !== ""
            ? String(nested.agentModel).trim()
            : undefined;
        const flatModel = a.agentModel?.trim() || process.env.TESTCHIMP_AGENT_MODEL?.trim();
        if (nestedModel) {
          nested.agentModel = nestedModel;
        } else if (flatModel) {
          nested.agentModel = flatModel;
        }
        body.traceability = nested;
      } else {
        const model = a.agentModel?.trim() || process.env.TESTCHIMP_AGENT_MODEL?.trim();
        if (model) {
          body.traceability = { agentModel: model };
        }
      }
      if (a.test) {
        body.test = a.test;
      } else if (a.entityIdentity) {
        body.entityIdentity = a.entityIdentity;
      }
      return postMcp("/api/mcp/report_agent_action", body);
    },
  },
  {
    kebab: "get-last-run-workflow-detail",
    description:
      "Fetch the last workflow execution for a workflow-id on a branch (optional userId for per-user last run). " +
      "Used for since-last-run scoping.",
    inputSchema: S.getLastRunWorkflowDetailInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getLastRunWorkflowDetailInput>;
      const body: Record<string, unknown> = {
        workflowId: a.workflowId,
        branchName: a.branchName,
      };
      if (a.userId) body.userId = a.userId;
      return postMcp("/api/mcp/get_last_run_workflow_detail", body);
    },
  },
  {
    kebab: "list-workflow-executions",
    description: "List recent workflow executions for the project, optionally filtered by workflowId.",
    inputSchema: S.listWorkflowExecutionsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.listWorkflowExecutionsInput>;
      const body: Record<string, unknown> = {};
      if (a.workflowId) body.workflowId = a.workflowId;
      if (a.limit != null) body.limit = a.limit;
      if (a.offset != null) body.offset = a.offset;
      return postMcp("/api/mcp/list_workflow_executions", body);
    },
  },
  {
    kebab: "get-workflow-execution",
    description: "Get a workflow execution by id; pass includeActions=true for the action timeline.",
    inputSchema: S.getWorkflowExecutionInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getWorkflowExecutionInput>;
      return postMcp("/api/mcp/get_workflow_execution", {
        workflowExecutionId: a.workflowExecutionId,
        includeActions: a.includeActions ?? true,
      });
    },
  },
  {
    kebab: "get-policy",
    description:
      "Fetch a workflow policy file by name (e.g. run-qa.policy.md) from the platform POLICY_FILE store. Filename is coerced to *.policy.md (same as upsert-policy).",
    inputSchema: S.getPolicyInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getPolicyInput>;
      return postMcp("/api/mcp/get_policy", { policyFileName: a.policyFileName });
    },
  },
  {
    kebab: "list-policies",
    description:
      "List policy files for an optional workflow-id. Marks isDefault when filename is <workflow-id>.policy.md.",
    inputSchema: S.listPoliciesInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.listPoliciesInput>;
      const body: Record<string, unknown> = {};
      if (a.workflowId) body.workflowId = a.workflowId;
      return postMcp("/api/mcp/list_policies", body);
    },
  },
  {
    kebab: "upsert-policy",
    description:
      "Create or update a workflow policy file on the platform (plans/knowledge/policies/*.policy.md). policyFileName is coerced to *.policy.md (same as get-policy). Prefer after writing the file locally so the policy is available immediately (git sync also works later).",
    inputSchema: S.upsertPolicyInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.upsertPolicyInput>;
      return postMcp("/api/mcp/upsert_policy", {
        policyFileName: a.policyFileName,
        content: a.content,
      });
    },
  },
  {
    kebab: "upsert-plans-support-file",
    description:
      "Create or update any file under the mapped plans root on the platform by relative path (no git commit/push required). " +
      "Primary use: upload workflow execution plans at knowledge/workflow_plans/<workflow-id>/<workflow_execution_id>.plan.md after the Plan phase. " +
      "filePath is relative to the plans mapped root (leading plans/ is stripped). Under workflow_plans/, filenames are coerced to *.plan.md and stored as WORKFLOW_EXECUTION_PLAN. " +
      "Response includes supportFileId, filePath (canonical), filetype, created. Blocking step before Execute for cloud agents.",
    inputSchema: S.upsertPlansSupportFileInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.upsertPlansSupportFileInput>;
      return postMcp("/api/mcp/upsert_plans_support_file", {
        filePath: a.filePath,
        content: a.content,
      });
    },
  },
  {
    kebab: "list-workflow-catalog",
    description: "List supported TestChimp workflows with Active / Disabled / Missing Config status for the project.",
    inputSchema: S.listWorkflowCatalogInput,
    execute: async (_args, { postMcp }) => postMcp("/api/mcp/list_workflow_catalog", {}),
  },
  {
    kebab: "list-api-operation-services",
    description:
      "List API operation service resources for the project (configured OpenAPI root file paths + operation counts). " +
      "Use rootFilePath as the service resource id for list-api-operations / get-api-operation-detail.",
    inputSchema: S.listApiOperationServicesInput,
    execute: async (_args, { postMcp }) => postMcp("/api/mcp/list_api_operation_services", {}),
  },
  {
    kebab: "list-api-operations",
    description:
      "List API operations for a service resource with covering-test previews and coverageSummary scores " +
      "(same payload as the Operations list UI). Prefer --root-file-path (repo-relative OpenAPI root).",
    inputSchema: S.listApiOperationsInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.listApiOperationsInput>;
      const body: Record<string, unknown> = {};
      if (a.rootFilePath != null && a.rootFilePath.trim() !== "") body.rootFilePath = a.rootFilePath.trim();
      if (a.serviceKey != null && a.serviceKey.trim() !== "") body.serviceKey = a.serviceKey.trim();
      if (a.includeManual != null) body.includeManual = a.includeManual;
      if (a.includeRemoved != null) body.includeRemoved = a.includeRemoved;
      return postMcp("/api/mcp/list_api_operations", body);
    },
  },
  {
    kebab: "get-api-operation-detail",
    description:
      "Fetch detailed API operation coverage (request/query/response fields, response codes, covering tests) — " +
      "same payload as the Operation detail UI. Prefer TestChimp operation id (--id ULID); " +
      "or rootFilePath + oasOperationId; or rootFilePath + httpMethod + pathTemplate.",
    inputSchema: S.getApiOperationDetailInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getApiOperationDetailInput>;
      const body: Record<string, unknown> = {};
      if (a.id != null && a.id.trim() !== "") body.id = a.id.trim();
      if (a.rootFilePath != null && a.rootFilePath.trim() !== "") body.rootFilePath = a.rootFilePath.trim();
      if (a.serviceKey != null && a.serviceKey.trim() !== "") body.serviceKey = a.serviceKey.trim();
      if (a.oasOperationId != null && a.oasOperationId.trim() !== "") body.oasOperationId = a.oasOperationId.trim();
      if (a.httpMethod != null && a.httpMethod.trim() !== "") body.httpMethod = a.httpMethod.trim();
      if (a.pathTemplate != null && a.pathTemplate.trim() !== "") body.pathTemplate = a.pathTemplate.trim();
      if (a.includeManual != null) body.includeManual = a.includeManual;
      if (a.includeRemoved != null) body.includeRemoved = a.includeRemoved;
      return postMcp("/api/mcp/get_api_operation_detail", body);
    },
  },
];

const TOOL_BY_KEBAB = new Map(TOOL_DEFINITIONS.map((t) => [t.kebab, t]));

export function getToolDefinition(kebab: string): ToolDefinition | undefined {
  return TOOL_BY_KEBAB.get(kebab);
}

export async function runTool(
  kebab: string,
  rawArgs: unknown,
  ctx: ToolContext
): Promise<string> {
  const def = TOOL_BY_KEBAB.get(kebab);
  if (!def) throw new Error(`Unknown tool: ${kebab}`);
  const raw = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  const parsed = def.inputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid input for ${kebab}: ${parsed.error.message}`);
  }
  return def.execute(parsed.data, ctx);
}
