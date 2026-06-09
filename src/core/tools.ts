import { type z, type ZodTypeAny } from "zod";
import { normalizeScope } from "./normalize.js";
import type { PostMcpFn } from "./client.js";
import { runProvisionEphemeralEnvironmentAndWait, type ProgressLog } from "./ephemeralWait.js";
import * as S from "./schemas.js";

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

export const TOOL_DEFINITIONS: ToolDefinition[] = [
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
      "Fetch SmartTest execution history for an optional platform-rooted folder scope, or for a scenario when scenarioId is set. " +
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
      "Create a user story on the TestChimp project and its plan file stub. " +
      "Always call this before writing a new story markdown file; use the returned ordinalId as US-<ordinalId> in frontmatter. " +
      "platformFilePath must be under plans/stories/ and end with .md.",
    inputSchema: S.createUserStoryInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.createUserStoryInput>;
      return postMcp("/api/mcp/create_user_story", {
        platformFilePath: a.platformFilePath,
        title: a.title,
      });
    },
  },
  {
    kebab: "create-test-scenario",
    description:
      "Create a test scenario linked to a user story. platformFilePath must be under plans/scenarios/ and end with .md. " +
      "userStoryOrdinalId is the numeric part of the parent US-<n> id.",
    inputSchema: S.createTestScenarioInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.createTestScenarioInput>;
      return postMcp("/api/mcp/create_test_scenario", {
        platformFilePath: a.platformFilePath,
        title: a.title,
        userStoryOrdinalId: a.userStoryOrdinalId,
      });
    },
  },
  {
    kebab: "update-user-story",
    description:
      "Sync a user story markdown file to the platform after local edits. " +
      "Parses frontmatter (id: US-..., title, priority) and updates the linked support file and entity. " +
      "Implementation status is not stored in markdown; use mark-plan-items-implementation-done.",
    inputSchema: S.updatePlanMarkdownInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.updatePlanMarkdownInput>;
      return postMcp("/api/mcp/update_user_story", { content: a.content });
    },
  },
  {
    kebab: "update-test-scenario",
    description:
      "Sync a test scenario markdown file to the platform after local edits. " +
      "Parses frontmatter (id: TS-..., story: US-..., title, priority) and updates linking if story changes. " +
      "Implementation status is not stored in markdown; use mark-plan-items-implementation-done.",
    inputSchema: S.updatePlanMarkdownInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.updatePlanMarkdownInput>;
      return postMcp("/api/mcp/update_test_scenario", { content: a.content });
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
      "Fetch test scenarios from the TestChimp platform by ordinal id (numeric part of TS-<n>). " +
      "Returns full plan markdown content, title, platform file path, and linked user story ordinal ids. " +
      "Use when plan files are not yet synced to the repo.",
    inputSchema: S.getTestScenariosInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.getTestScenariosInput>;
      return postMcp("/api/mcp/get_test_scenarios", {
        scenarioOrdinalIds: a.scenarioOrdinalIds,
      });
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
    description: "List distinct RUM environment tags for TrueCoverage scoping.",
    inputSchema: S.emptyInput,
    execute: async (_args, { postMcp }) => postMcp("/api/mcp/list_rum_environments", {}),
  },
  {
    kebab: "get-truecoverage-events",
    description:
      "TrueCoverage event funnel summaries (ListEventsRequest JSON: baseExecutionScope, comparisonExecutionScope). " +
      "Optional ExecutionScope.platform: WEB_EXECUTION_PLATFORM | IOS_EXECUTION_PLATFORM | ANDROID_EXECUTION_PLATFORM " +
      "(filters RUM rows stamped via testchimp-rum-platform header: web=1, ios=2, android=3). " +
      "Use automationEmitsOnly on comparisonExecutionScope for test-tagged emits only.",
    inputSchema: S.truecoverageJsonInput,
    execute: async (args, { postMcp }) =>
      postMcp("/api/mcp/truecoverage_list_events", (args as Record<string, unknown>) ?? {}),
  },
  {
    kebab: "get-truecoverage-event-details",
    description:
      "TrueCoverage drill-down for one event title (GetEventDetailsRequest JSON). " +
      "Optional platform on baseExecutionScope / comparisonExecutionScope (WEB_EXECUTION_PLATFORM, IOS_EXECUTION_PLATFORM, ANDROID_EXECUTION_PLATFORM).",
    inputSchema: S.truecoverageJsonInput,
    execute: async (args, { postMcp }) =>
      postMcp("/api/mcp/truecoverage_event_details", (args as Record<string, unknown>) ?? {}),
  },
  {
    kebab: "get-truecoverage-child-event-tree",
    description:
      "TrueCoverage next-event tree for an event (ListChildEventTreeRequest JSON). " +
      "Optional platform on baseScope / coverageScope (inside each ExecutionScope).",
    inputSchema: S.truecoverageJsonInput,
    execute: async (args, { postMcp }) =>
      postMcp("/api/mcp/truecoverage_list_child_event_tree", (args as Record<string, unknown>) ?? {}),
  },
  {
    kebab: "get-truecoverage-event-transition",
    description:
      "TrueCoverage detailed transition summary between events (GetDetailedEventTransitionSummaryRequest JSON). " +
      "Optional platform on baseScope / coverageScope (inside each ExecutionScope).",
    inputSchema: S.truecoverageJsonInput,
    execute: async (args, { postMcp }) =>
      postMcp("/api/mcp/truecoverage_detailed_event_transition", (args as Record<string, unknown>) ?? {}),
  },
  {
    kebab: "get-truecoverage-event-time-series",
    description:
      "TrueCoverage time series for sessions or metrics (EventTimeSeriesRequest JSON). " +
      "Optional platform on baseExecutionScope.",
    inputSchema: S.truecoverageJsonInput,
    execute: async (args, { postMcp }) =>
      postMcp("/api/mcp/truecoverage_event_time_series", (args as Record<string, unknown>) ?? {}),
  },
  {
    kebab: "get-truecoverage-session-metadata-keys",
    description: "List session-level metadata keys observed for TrueCoverage.",
    inputSchema: S.emptyInput,
    execute: async (_args, { postMcp }) => postMcp("/api/mcp/truecoverage_session_metadata_keys", {}),
  },
  {
    kebab: "get-truecoverage-event-metadata-keys",
    description: "List metadata keys for a given event title.",
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
