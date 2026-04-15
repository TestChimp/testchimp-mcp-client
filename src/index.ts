#!/usr/bin/env node
/**
 * TestChimp MCP server — calls TestChimp /api/mcp/* with TestChimp-Api-Key only.
 * Env: TESTCHIMP_BACKEND_URL (optional), TESTCHIMP_API_KEY (required).
 * Includes SmartTests coverage, plan authoring, EaaS, and TrueCoverage analytics endpoints.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runProvisionEphemeralEnvironmentAndWait } from "./ephemeralProvisionWait.js";

const DEFAULT_BACKEND = "https://featureservice.testchimp.io";

function getBackendUrl(): string {
  const raw = process.env.TESTCHIMP_BACKEND_URL?.trim();
  if (!raw) return DEFAULT_BACKEND;
  return raw.replace(/\/$/, "");
}

function requireApiKey(): string {
  const k = process.env.TESTCHIMP_API_KEY?.trim();
  if (!k) {
    throw new Error(
      "TESTCHIMP_API_KEY is required. Set it in <project>/.cursor/mcp.json env (project-level MCP config), not IDE-wide config."
    );
  }
  return k;
}

async function postMcp(path: string, body: unknown): Promise<string> {
  const apiKey = requireApiKey();
  const url = `${getBackendUrl()}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "TestChimp-Api-Key": apiKey,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TestChimp API ${res.status} ${res.statusText}: ${text}`);
  }
  return text;
}

const scopeSchema = z
  .object({
    /** Relative paths from platform tests root, e.g. "e2e/checkout.spec.ts" */
    filePaths: z.array(z.string()).optional(),
    folderPath: z.union([z.array(z.string()), z.string()]).optional(),
  })
  .optional();

const listCoverageInput = z.object({
  release: z.string().optional(),
  environment: z.string().optional(),
  scope: scopeSchema,
  includeNonCoveredUserStories: z.boolean().optional(),
  includeNonCoveredTestScenarios: z.boolean().optional(),
  /** Git branch name (e.g. "main"). Prefer over internal branch ids. */
  branchName: z.string().optional(),
});

const listExecutionInput = z.object({
  release: z.string().optional(),
  environment: z.string().optional(),
  scope: scopeSchema,
  branchName: z.string().optional(),
});

/** Platform path to the new markdown file, e.g. plans/stories/auth/login-flow.md */
const createUserStoryInput = z.object({
  platformFilePath: z.string().min(1),
  title: z.string().min(1),
});

const createTestScenarioInput = z.object({
  platformFilePath: z.string().min(1),
  title: z.string().min(1),
  /** Parent story ordinal (the number n in US-n). */
  userStoryOrdinalId: z.coerce.number().int().positive(),
});

const updatePlanMarkdownInput = z.object({
  /** Full markdown including YAML frontmatter and body (as written under the repo plans root). */
  content: z.string().min(1),
});

const emptyInput = z.object({});

const getBranchSpecificEndpointConfigInput = z.object({
  /** Git branch name (e.g. PR head). Required to resolve template or per-branch override. */
  branchName: z.string().optional(),
});

/** Proto-shaped JSON for TrueCoverage (e.g. list_events: baseExecutionScope, comparisonExecutionScope). */
const truecoverageJsonInput = z.record(z.string(), z.unknown());

const eventMetadataKeysInput = z.object({
  eventTitle: z.string().min(1),
});

const provisionEphemeralInput = z.object({
  /** Git branch to deploy; omit to use the repo default branch. */
  branchName: z.string().optional(),
});

const bnsEnvironmentIdInput = z.object({
  /** BunnyShell environment id returned from provision_ephemeral_environment. */
  bnsEnvironmentId: z.string().min(1),
});

const provisionEphemeralWaitInput = z.object({
  /** Git branch to deploy; omit to use the repo default branch. */
  branchName: z.string().optional(),
  /** Seconds between status polls (clamped 30–120). Default 60. */
  pollIntervalSeconds: z.number().optional(),
  /** Max minutes to wait for deployed + URLs (clamped 5–45). Default 25. */
  maxWaitMinutes: z.number().optional(),
});

const listBunnyshellEnvironmentEventsInput = z.object({
  bnsEnvironmentId: z.string().min(1),
  /** BunnyShell event type filter (e.g. env_deploy). */
  eventType: z.string().optional(),
  /** BunnyShell event status: new | in_progress | success | fail */
  eventStatus: z.string().optional(),
  page: z.number().int().positive().optional(),
});

const listBunnyshellWorkflowJobsInput = z.object({
  bnsEnvironmentId: z.string().min(1),
  page: z.number().int().positive().optional(),
});

const getBunnyshellWorkflowJobLogsInput = z.object({
  bnsEnvironmentId: z.string().min(1),
  workflowJobId: z.string().min(1),
});

function textResult(json: string) {
  return {
    content: [{ type: "text" as const, text: json }],
  };
}

function normalizeScope(scope: {
  filePaths?: string[];
  folderPath?: string[] | string;
}): { filePaths?: string[]; folderPath?: string[] } {
  let folderPath: string[] | undefined;
  if (Array.isArray(scope.folderPath)) {
    folderPath = scope.folderPath;
  } else if (typeof scope.folderPath === "string" && scope.folderPath.trim() !== "") {
    folderPath = scope.folderPath
      .split("/")
      .map((seg) => seg.trim())
      .filter(Boolean);
  }
  const out: { filePaths?: string[]; folderPath?: string[] } = {};
  if (scope.filePaths?.length) out.filePaths = scope.filePaths;
  if (folderPath) out.folderPath = folderPath;
  return out;
}

async function main() {
  const server = new McpServer(
    { name: "testchimp-mcp", version: "0.0.8" },
    { capabilities: { tools: {}, logging: {} } }
  );

  server.registerTool(
    "get_requirement_coverage",
    {
      description:
        "Fetch requirement (scenario) coverage under an optional platform-rooted folder scope (tests/... or plans/...). " +
        "Use branchName (Git branch) and scope.filePaths (paths under platform tests root) rather than internal ids. " +
        "Maps to TestChimp list_requirement_coverage API.",
      inputSchema: listCoverageInput,
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.release != null) body.release = args.release;
      if (args.environment != null) body.environment = args.environment;
      if (args.scope != null) body.scope = normalizeScope(args.scope);
      if (args.includeNonCoveredUserStories != null) {
        body.includeNonCoveredUserStories = args.includeNonCoveredUserStories;
      }
      if (args.includeNonCoveredTestScenarios != null) {
        body.includeNonCoveredTestScenarios = args.includeNonCoveredTestScenarios;
      }
      if (args.branchName != null && args.branchName.trim() !== "") {
        body.branchName = args.branchName.trim();
      }
      const json = await postMcp("/api/mcp/list_requirement_coverage", body);
      return textResult(json);
    }
  );

  server.registerTool(
    "get_execution_history",
    {
      description:
        "Fetch SmartTest execution history for an optional platform-rooted folder scope (tests/... or plans/...). " +
        "Use branchName and scope.filePaths as for coverage.",
      inputSchema: listExecutionInput,
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.release != null) body.release = args.release;
      if (args.environment != null) body.environment = args.environment;
      if (args.scope != null) body.scope = normalizeScope(args.scope);
      if (args.branchName != null && args.branchName.trim() !== "") {
        body.branchName = args.branchName.trim();
      }
      const json = await postMcp("/api/mcp/list_execution_history", body);
      return textResult(json);
    }
  );

  server.registerTool(
    "create_user_story",
    {
      description:
        "Create a user story on the TestChimp project and its plan file stub. " +
        "Always call this before writing a new story markdown file; use the returned ordinalId as US-<ordinalId> in frontmatter. " +
        "platformFilePath must be under plans/stories/ and end with .md.",
      inputSchema: createUserStoryInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/create_user_story", {
        platformFilePath: args.platformFilePath,
        title: args.title,
      });
      return textResult(json);
    }
  );

  server.registerTool(
    "create_test_scenario",
    {
      description:
        "Create a test scenario linked to a user story. Call after the parent story exists. " +
        "platformFilePath must be under plans/scenarios/ and end with .md. " +
        "userStoryOrdinalId is the numeric part of the parent US-<n> id.",
      inputSchema: createTestScenarioInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/create_test_scenario", {
        platformFilePath: args.platformFilePath,
        title: args.title,
        userStoryOrdinalId: args.userStoryOrdinalId,
      });
      return textResult(json);
    }
  );

  server.registerTool(
    "update_user_story",
    {
      description:
        "Sync a user story markdown file to the platform after local edits. " +
        "Parses frontmatter (id: US-..., title, priority, status) and updates the linked support file and entity.",
      inputSchema: updatePlanMarkdownInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/update_user_story", { content: args.content });
      return textResult(json);
    }
  );

  server.registerTool(
    "update_test_scenario",
    {
      description:
        "Sync a test scenario markdown file to the platform after local edits. " +
        "Parses frontmatter (id: TS-..., story: US-..., title, priority, status) and updates linking if story changes.",
      inputSchema: updatePlanMarkdownInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/update_test_scenario", { content: args.content });
      return textResult(json);
    }
  );

  server.registerTool(
    "get_eaas_config",
    {
      description:
        "Return the project's BunnyShell (Environment-as-a-Service) settings: ymlRepoPath and bunnyshellProjectName. " +
        "Secrets (API token) are never returned. Response is {} when EaaS is not configured or has no public fields.",
      inputSchema: emptyInput,
    },
    async () => {
      const json = await postMcp("/api/mcp/get_eaas_config", {});
      return textResult(json);
    }
  );

  server.registerTool(
    "get_branch_specific_endpoint_config",
    {
      description:
        "Resolve BASE_URL for a Git branch from TestChimp Branch Management (URL template and per-branch overrides). " +
        "Prefer this when BunnyShell EaaS is not configured and the project uses bespoke PR preview URLs. " +
        "Pass branchName (e.g. the PR branch). Response includes baseUrl and resolution: override | template | none.",
      inputSchema: getBranchSpecificEndpointConfigInput,
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.branchName != null && args.branchName.trim() !== "") {
        body.branchName = args.branchName.trim();
      }
      const json = await postMcp("/api/mcp/get_branch_specific_endpoint_config", body);
      return textResult(json);
    }
  );

  server.registerTool(
    "provision_ephemeral_environment_and_wait",
    {
      description:
        "Preferred: provision a BunnyShell ephemeral environment for the current Git branch, then poll until the stack is deployed and component URLs are available (typically ~5–10 minutes). " +
        "Returns one JSON with outcome success|failed|timeout, failure_phase (provision|deploy|wait), user-facing message, and component_urls_json on success. " +
        "Requires BunnyShell + GitHub integration. If this tool is unavailable or the host aborts long calls, fall back to provision_ephemeral_environment + polling get_ephemeral_environment_status (~1/min, max ~25m).",
      inputSchema: provisionEphemeralWaitInput,
    },
    async (args) => {
      const json = await runProvisionEphemeralEnvironmentAndWait(postMcp, server, {
        branchName: args.branchName,
        pollIntervalSeconds: args.pollIntervalSeconds,
        maxWaitMinutes: args.maxWaitMinutes,
      });
      return textResult(json);
    }
  );

  server.registerTool(
    "provision_ephemeral_environment",
    {
      description:
        "Create a BunnyShell ephemeral environment (create + deploy trigger only). Prefer provision_ephemeral_environment_and_wait unless you must poll manually. " +
        "Requires BunnyShell + GitHub integration. Use get_ephemeral_environment_status with bnsEnvironmentId to poll until deployed.",
      inputSchema: provisionEphemeralInput,
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.branchName != null && args.branchName.trim() !== "") {
        body.branchName = args.branchName.trim();
      }
      const json = await postMcp("/api/mcp/provision_ephemeral_environment", body);
      return textResult(json);
    }
  );

  server.registerTool(
    "get_ephemeral_environment_status",
    {
      description:
        "Poll BunnyShell for environment status and component_urls_json. Used for manual fallback when provision_ephemeral_environment_and_wait is not available; prefer the wait tool for normal flows.",
      inputSchema: bnsEnvironmentIdInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/get_ephemeral_environment_status", {
        bnsEnvironmentId: args.bnsEnvironmentId,
      });
      return textResult(json);
    }
  );

  server.registerTool(
    "destroy_ephemeral_environment",
    {
      description: "Delete a BunnyShell environment created for this project (bnsEnvironmentId from provision).",
      inputSchema: bnsEnvironmentIdInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/destroy_ephemeral_environment", {
        bnsEnvironmentId: args.bnsEnvironmentId,
      });
      return textResult(json);
    }
  );

  server.registerTool(
    "list_bunnyshell_environment_events",
    {
      description:
        "Troubleshooting: list BunnyShell platform events for an environment (GET /v1/events). " +
        "Use after a failed or stuck ephemeral deploy. The HTTP response body is the BunnyShell payload as returned by the API (no extra wrapping). " +
        "Optional filters: eventType, eventStatus (new|in_progress|success|fail), page.",
      inputSchema: listBunnyshellEnvironmentEventsInput,
    },
    async (args) => {
      const body: Record<string, unknown> = { bnsEnvironmentId: args.bnsEnvironmentId };
      if (args.eventType != null && args.eventType.trim() !== "") body.eventType = args.eventType.trim();
      if (args.eventStatus != null && args.eventStatus.trim() !== "") body.eventStatus = args.eventStatus.trim();
      if (args.page != null) body.page = args.page;
      const json = await postMcp("/api/mcp/list_bunnyshell_environment_events", body);
      return textResult(json);
    }
  );

  server.registerTool(
    "list_bunnyshell_workflow_jobs",
    {
      description:
        "Troubleshooting: list BunnyShell workflow jobs for an environment. Response body is the BunnyShell API payload as returned (no extra wrapping). " +
        "Use to find workflowJobId for get_bunnyshell_workflow_job_logs.",
      inputSchema: listBunnyshellWorkflowJobsInput,
    },
    async (args) => {
      const body: Record<string, unknown> = { bnsEnvironmentId: args.bnsEnvironmentId };
      if (args.page != null) body.page = args.page;
      const json = await postMcp("/api/mcp/list_bunnyshell_workflow_jobs", body);
      return textResult(json);
    }
  );

  server.registerTool(
    "get_bunnyshell_workflow_job_logs",
    {
      description:
        "Troubleshooting: fetch logs for a BunnyShell workflow job (deploy/build pipeline). " +
        "Response body is the BunnyShell /v1/workflow_jobs/{id}/logs payload as returned (no truncation or wrapping).",
      inputSchema: getBunnyshellWorkflowJobLogsInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/get_bunnyshell_workflow_job_logs", {
        bnsEnvironmentId: args.bnsEnvironmentId,
        workflowJobId: args.workflowJobId,
      });
      return textResult(json);
    }
  );

  server.registerTool(
    "list_rum_environments",
    {
      description:
        "List distinct RUM environment tags seen for this project (for TrueCoverage scoping). " +
        "Maps to POST /api/mcp/list_rum_environments.",
      inputSchema: emptyInput,
    },
    async () => {
      const json = await postMcp("/api/mcp/list_rum_environments", {});
      return textResult(json);
    }
  );

  server.registerTool(
    "get_truecoverage_events",
    {
      description:
        "TrueCoverage event funnel summaries for the given execution scopes (same JSON body as platform list_events). " +
        "Maps to POST /api/mcp/truecoverage_list_events.",
      inputSchema: truecoverageJsonInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/truecoverage_list_events", args ?? {});
      return textResult(json);
    }
  );

  server.registerTool(
    "get_truecoverage_event_details",
    {
      description:
        "TrueCoverage drill-down for one event title (GetEventDetailsRequest JSON). " +
        "Maps to POST /api/mcp/truecoverage_event_details.",
      inputSchema: truecoverageJsonInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/truecoverage_event_details", args ?? {});
      return textResult(json);
    }
  );

  server.registerTool(
    "get_truecoverage_child_event_tree",
    {
      description:
        "TrueCoverage next-event tree for an event (ListChildEventTreeRequest JSON). " +
        "Maps to POST /api/mcp/truecoverage_list_child_event_tree.",
      inputSchema: truecoverageJsonInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/truecoverage_list_child_event_tree", args ?? {});
      return textResult(json);
    }
  );

  server.registerTool(
    "get_truecoverage_event_transition",
    {
      description:
        "TrueCoverage detailed transition summary between events (GetDetailedEventTransitionSummaryRequest JSON). " +
        "Maps to POST /api/mcp/truecoverage_detailed_event_transition.",
      inputSchema: truecoverageJsonInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/truecoverage_detailed_event_transition", args ?? {});
      return textResult(json);
    }
  );

  server.registerTool(
    "get_truecoverage_event_time_series",
    {
      description:
        "TrueCoverage time series for sessions or metrics (EventTimeSeriesRequest JSON). " +
        "Maps to POST /api/mcp/truecoverage_event_time_series.",
      inputSchema: truecoverageJsonInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/truecoverage_event_time_series", args ?? {});
      return textResult(json);
    }
  );

  server.registerTool(
    "get_truecoverage_session_metadata_keys",
    {
      description:
        "List session-level metadata keys observed for TrueCoverage. Maps to POST /api/mcp/truecoverage_session_metadata_keys.",
      inputSchema: emptyInput,
    },
    async () => {
      const json = await postMcp("/api/mcp/truecoverage_session_metadata_keys", {});
      return textResult(json);
    }
  );

  server.registerTool(
    "get_truecoverage_event_metadata_keys",
    {
      description:
        "List metadata keys for a given event title. Maps to POST /api/mcp/truecoverage_event_metadata_keys.",
      inputSchema: eventMetadataKeysInput,
    },
    async (args) => {
      const json = await postMcp("/api/mcp/truecoverage_event_metadata_keys", {
        eventTitle: args.eventTitle,
      });
      return textResult(json);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
