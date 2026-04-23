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
  return body;
}

function listExecutionBody(args: z.infer<typeof S.listExecutionInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.release != null) body.release = args.release;
  if (args.environment != null) body.environment = args.environment;
  if (args.scope != null) body.scope = normalizeScope(args.scope);
  if (args.branchName != null && args.branchName.trim() !== "") body.branchName = args.branchName.trim();
  return body;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    kebab: "get-requirement-coverage",
    description:
      "Fetch requirement (scenario) coverage under an optional platform-rooted folder scope (tests/... or plans/...). " +
      "Use branchName (Git branch) and scope.filePaths (paths under platform tests root) rather than internal ids.",
    inputSchema: S.listCoverageInput,
    execute: async (args, { postMcp }) => {
      const json = await postMcp("/api/mcp/list_requirement_coverage", listCoverageBody(args as z.infer<typeof S.listCoverageInput>));
      return json;
    },
  },
  {
    kebab: "get-execution-history",
    description:
      "Fetch SmartTest execution history for an optional platform-rooted folder scope. " +
      "Use branchName and scope.filePaths as for coverage.",
    inputSchema: S.listExecutionInput,
    execute: async (args, { postMcp }) => {
      const json = await postMcp("/api/mcp/list_execution_history", listExecutionBody(args as z.infer<typeof S.listExecutionInput>));
      return json;
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
      "Parses frontmatter (id: US-..., title, priority, status) and updates the linked support file and entity.",
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
      "Parses frontmatter (id: TS-..., story: US-..., title, priority, status) and updates linking if story changes.",
    inputSchema: S.updatePlanMarkdownInput,
    execute: async (args, { postMcp }) => {
      const a = args as z.infer<typeof S.updatePlanMarkdownInput>;
      return postMcp("/api/mcp/update_test_scenario", { content: a.content });
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
    description: "TrueCoverage event funnel summaries (ListEventsRequest JSON: baseExecutionScope, comparisonExecutionScope).",
    inputSchema: S.truecoverageJsonInput,
    execute: async (args, { postMcp }) => postMcp("/api/mcp/truecoverage_list_events", (args as Record<string, unknown>) ?? {}),
  },
  {
    kebab: "get-truecoverage-event-details",
    description: "TrueCoverage drill-down for one event title (GetEventDetailsRequest JSON).",
    inputSchema: S.truecoverageJsonInput,
    execute: async (args, { postMcp }) => postMcp("/api/mcp/truecoverage_event_details", (args as Record<string, unknown>) ?? {}),
  },
  {
    kebab: "get-truecoverage-child-event-tree",
    description: "TrueCoverage next-event tree for an event (ListChildEventTreeRequest JSON).",
    inputSchema: S.truecoverageJsonInput,
    execute: async (args, { postMcp }) =>
      postMcp("/api/mcp/truecoverage_list_child_event_tree", (args as Record<string, unknown>) ?? {}),
  },
  {
    kebab: "get-truecoverage-event-transition",
    description: "TrueCoverage detailed transition summary between events (GetDetailedEventTransitionSummaryRequest JSON).",
    inputSchema: S.truecoverageJsonInput,
    execute: async (args, { postMcp }) =>
      postMcp("/api/mcp/truecoverage_detailed_event_transition", (args as Record<string, unknown>) ?? {}),
  },
  {
    kebab: "get-truecoverage-event-time-series",
    description: "TrueCoverage time series for sessions or metrics (EventTimeSeriesRequest JSON).",
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
