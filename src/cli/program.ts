import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DEFAULT_BACKEND, postMcp } from "../core/client.js";
import { deepMerge } from "../core/merge.js";
import { runTool } from "../core/tools.js";
import { TOOL_DEFINITIONS } from "../core/tools.js";
import { resolveGitHeadSha } from "../core/gitSha.js";
import { PACKAGE_VERSION } from "../core/version.js";

export { PACKAGE_VERSION };

function parseRecordTypesCsv(raw: string): ("smart_test" | "manual")[] {
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    .map((s) => {
      if (s === "automated") return "smart_test";
      if (s === "smarttest") return "smart_test";
      if (s === "smart_test") return "smart_test";
      if (s === "manual") return "manual";
      return s as "smart_test" | "manual";
    })
    .filter((v): v is "smart_test" | "manual" => v === "smart_test" || v === "manual");
}

function parseJsonInput(raw: string | undefined): Record<string, unknown> {
  if (raw == null || raw.trim() === "") return {};
  const trimmed = raw.trim();
  if (trimmed.startsWith("@")) {
    const path = trimmed.slice(1);
    const buf = readFileSync(path, "utf8");
    return JSON.parse(buf) as Record<string, unknown>;
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function mergeBodies(flagBody: Record<string, unknown>, jsonInputRaw: string | undefined): unknown {
  const extra = parseJsonInput(jsonInputRaw);
  if (Object.keys(extra).length === 0) return flagBody;
  return deepMerge(flagBody, extra);
}

/** Shared agent policy/traceability flags for mutating CRUD commands. */
function addAgentTraceabilityOptions(cmd: Command): Command {
  return cmd
    .option("--workflow-id <id>", "Catalog workflow id for agent Activity")
    .option("--workflow-execution-id <ulid>", "Stable ULID for the whole agent run")
    .option("--policy-file <name>", "Policy filename (e.g. run-qa.policy.md)")
    .option("--policy-version <semver>", "Policy version from frontmatter")
    .option("--git-sha <sha>", "Git SHA (defaults to HEAD)")
    .option("--actor-type <type>", "LOCAL_AGENT | CLOUD_AGENT")
    .option("--user-id <id>", "Optional user id")
    .option("--branch-name <name>", "Git branch name")
    .option("--agent-model <model>", "Optional agent model id (agent/CLI only)");
}

function collectAgentTraceabilityFlags(opts: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.workflowId) body.workflowId = String(opts.workflowId).trim();
  if (opts.workflowExecutionId) body.workflowExecutionId = String(opts.workflowExecutionId).trim();
  if (opts.policyFile) body.policyFile = String(opts.policyFile).trim();
  if (opts.policyVersion) body.policyVersion = String(opts.policyVersion).trim();
  if (opts.gitSha) body.gitSha = String(opts.gitSha).trim();
  if (opts.actorType) body.actorType = String(opts.actorType).trim();
  if (opts.userId) body.userId = String(opts.userId).trim();
  if (opts.branchName) body.branchName = String(opts.branchName).trim();
  if (opts.agentModel) body.agentModel = String(opts.agentModel).trim();
  return body;
}

function stderrProgress(msg: string): void {
  console.error(`[testchimp] ${msg}`);
}

export function buildCliProgram(): Command {
  const program = new Command();
  program.name("testchimp").description("TestChimp CLI — call project MCP HTTP APIs").version(PACKAGE_VERSION);

  program
    .command("mcp")
    .description("Start the TestChimp MCP server (stdio transport)")
    .action(async () => {
      const { runMcpServer } = await import("../mcp/server.js");
      await runMcpServer();
    });

  function jsonInputOption(): Option {
    return new Option("--json-input <json>", "Advanced: JSON object or @path; merged over flags (JSON wins on conflicts)");
  }

  /** Seed a minimal ExecutionScope from common flags (JSON can override / extend). */
  function scopeFromFlags(opts: {
    environment?: string;
    relativeWindow?: string;
    platform?: string;
    release?: string;
    branchName?: string;
  }): Record<string, unknown> | undefined {
    const scope: Record<string, unknown> = {};
    if (opts.environment) scope.environment = String(opts.environment);
    if (opts.relativeWindow) scope.timeWindow = { relativeWindow: String(opts.relativeWindow) };
    if (opts.platform) scope.platform = String(opts.platform);
    if (opts.release) scope.release = String(opts.release);
    if (opts.branchName) scope.branchName = String(opts.branchName);
    return Object.keys(scope).length > 0 ? scope : undefined;
  }

  function addTruecoverageScopeFlags(cmd: Command): Command {
    return cmd
      .option("--environment <s>", "RUM environment tag (seeds base scope)")
      .option("--relative-window <duration>", 'Duration string ending in s, e.g. 604800s (seeds base scope timeWindow)')
      .option("--platform <web|ios|android>", "Platform filter on base scope (aliases or WEB_/IOS_/ANDROID_EXECUTION_PLATFORM)")
      .option("--release <s>", "Optional release filter on base scope")
      .option("--branch-name <s>", "Optional branchName on base scope");
  }

  program
    .command("get-requirement-coverage")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-requirement-coverage")!.description)
    .addOption(jsonInputOption())
    .option("--release <s>")
    .option("--environment <s>")
    .option("--branch-name <s>")
    .option("--platform <web|ios|android>")
    .option("--record-types <csv>", "coverage sources: smart_test,manual (aliases: automated,smarttest)")
    .option("--include-manual", "include manual sessions in addition to automated (default)")
    .option("--manual-only", "manual-only coverage (no automated)")
    .option("--file-paths <csv>", "comma-separated paths under platform tests root")
    .option("--folder-path <path>", "folder under tests root, slash-separated")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.release) body.release = opts.release;
      if (opts.environment) body.environment = opts.environment;
      if (opts.branchName) body.branchName = opts.branchName;
      if (opts.platform) body.platform = opts.platform;
      let recordTypes: ("smart_test" | "manual")[] | undefined;
      if (opts.recordTypes) recordTypes = parseRecordTypesCsv(String(opts.recordTypes));
      if (opts.includeManual) recordTypes = Array.from(new Set([...(recordTypes ?? ["smart_test"]), "manual"]));
      if (opts.manualOnly) recordTypes = ["manual"];
      if (recordTypes && recordTypes.length > 0) body.recordTypes = recordTypes;
      const scope: { filePaths?: string[]; folderPath?: string } = {};
      if (opts.filePaths) scope.filePaths = String(opts.filePaths).split(",").map((s: string) => s.trim()).filter(Boolean);
      if (opts.folderPath) scope.folderPath = opts.folderPath;
      if (Object.keys(scope).length) body.scope = scope;
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("get-requirement-coverage", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-execution-history")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-execution-history")!.description)
    .addOption(jsonInputOption())
    .option("--release <s>")
    .option("--environment <s>")
    .option("--branch-name <s>")
    .option("--scenario-id <id>")
    .option("--test-id <id>")
    .option("--platform <web|ios|android>")
    .option("--file-paths <csv>")
    .option("--folder-path <path>")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.release) body.release = opts.release;
      if (opts.environment) body.environment = opts.environment;
      if (opts.branchName) body.branchName = opts.branchName;
      if (opts.scenarioId) body.scenarioId = opts.scenarioId;
      if (opts.testId) body.testId = opts.testId;
      if (opts.platform) body.platform = opts.platform;
      const scope: { filePaths?: string[]; folderPath?: string } = {};
      if (opts.filePaths) scope.filePaths = String(opts.filePaths).split(",").map((s: string) => s.trim()).filter(Boolean);
      if (opts.folderPath) scope.folderPath = opts.folderPath;
      if (Object.keys(scope).length) body.scope = scope;
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("get-execution-history", merged, { postMcp });
      console.log(out);
    });

  program
    .command("fetch-execution-report")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "fetch-execution-report")!.description)
    .addOption(jsonInputOption())
    .option("--batch-invocation-id <id>")
    .option("--job-id <id>")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.batchInvocationId) body.batchInvocationId = String(opts.batchInvocationId);
      if (opts.jobId) body.jobId = String(opts.jobId);
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("fetch-execution-report", merged, { postMcp });
      console.log(out);
    });

  addAgentTraceabilityOptions(
    program
      .command("create-user-story")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "create-user-story")!.description)
      .addOption(jsonInputOption())
      .requiredOption("--platform-file-path <path>")
      .requiredOption("--title <title>"),
  ).action(async (opts) => {
    const body = {
      platformFilePath: opts.platformFilePath,
      title: opts.title,
      ...collectAgentTraceabilityFlags(opts),
    };
    const merged = mergeBodies(body, opts.jsonInput);
    const out = await runTool("create-user-story", merged, { postMcp });
    console.log(out);
  });

  addAgentTraceabilityOptions(
    program
      .command("create-test-scenario")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "create-test-scenario")!.description)
      .addOption(jsonInputOption())
      .requiredOption("--platform-file-path <path>")
      .requiredOption("--title <title>")
      .requiredOption("--user-story-ordinal-id <n>"),
  ).action(async (opts) => {
    const body = {
      platformFilePath: opts.platformFilePath,
      title: opts.title,
      userStoryOrdinalId: Number(opts.userStoryOrdinalId),
      ...collectAgentTraceabilityFlags(opts),
    };
    const merged = mergeBodies(body, opts.jsonInput);
    const out = await runTool("create-test-scenario", merged, { postMcp });
    console.log(out);
  });

  addAgentTraceabilityOptions(
    program
      .command("update-user-story")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "update-user-story")!.description)
      .addOption(jsonInputOption())
      .option("--content <markdown>", "full markdown including frontmatter")
      .option("--content-file <path>", "read markdown from file"),
  ).action(async (opts) => {
    let content = opts.content as string | undefined;
    if (opts.contentFile) content = await readFile(String(opts.contentFile), "utf8");
    if (!content) throw new Error("Provide --content or --content-file (or full body via --json-input)");
    const body = { content, ...collectAgentTraceabilityFlags(opts) };
    const merged = mergeBodies(body, opts.jsonInput);
    const out = await runTool("update-user-story", merged, { postMcp });
    console.log(out);
  });

  program
    .command("get-user-stories")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-user-stories")!.description)
    .addOption(jsonInputOption())
    .option("--user-story-ordinal-ids <csv>", "comma-separated US-<n> numeric ids")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.userStoryOrdinalIds) {
        body.userStoryOrdinalIds = String(opts.userStoryOrdinalIds)
          .split(",")
          .map((s: string) => Number(s.trim()))
          .filter((n: number) => Number.isFinite(n) && n > 0);
      }
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("get-user-stories", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-test-scenarios")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-test-scenarios")!.description)
    .addOption(jsonInputOption())
    .option("--scenario-ordinal-ids <csv>", "comma-separated TS-<n> numeric ids")
    .option(
      "--external-ids <csv>",
      "comma-separated external TMS ids (e.g. C12345,PROJ-101); server matches exact then numerical part",
    )
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.scenarioOrdinalIds) {
        const ids = String(opts.scenarioOrdinalIds)
          .split(",")
          .map((s: string) => Number(s.trim()))
          .filter((n: number) => Number.isFinite(n) && n > 0);
        if (ids.length > 0) body.scenarioOrdinalIds = ids;
      }
      if (opts.externalIds) {
        const ids = String(opts.externalIds)
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
        if (ids.length > 0) body.externalIds = ids;
      }
      const merged = mergeBodies(body, opts.jsonInput) as Record<string, unknown>;
      // Drop empty arrays so refine / merge with json-input does not fail misleadingly.
      if (Array.isArray(merged.scenarioOrdinalIds) && merged.scenarioOrdinalIds.length === 0) {
        delete merged.scenarioOrdinalIds;
      }
      if (Array.isArray(merged.externalIds) && merged.externalIds.length === 0) {
        delete merged.externalIds;
      }
      const out = await runTool("get-test-scenarios", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-manual-session-details")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-manual-session-details")!.description)
    .addOption(jsonInputOption())
    .option("--manual-session-id <id>", "manual test session id (same as job id in the viewer URL)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.manualSessionId) {
        body.manualSessionId = String(opts.manualSessionId).trim();
      }
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("get-manual-session-details", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-issue-details")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-issue-details")!.description)
    .addOption(jsonInputOption())
    .option("--issue-id <id>", "Issue ordinal id (#B-123, B-123, B123, or 123)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.issueId) body.issueId = String(opts.issueId).trim();
      const merged = mergeBodies(body, opts.jsonInput) as { issueId?: string };
      if (!merged.issueId || String(merged.issueId).trim() === "") {
        throw new Error("issueId is required (--issue-id)");
      }
      const out = await runTool(
        "get-issue-details",
        { issueId: String(merged.issueId).trim() },
        { postMcp },
      );
      console.log(out);
    });

  addAgentTraceabilityOptions(
    program
      .command("update-issue-status")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "update-issue-status")!.description)
      .addOption(jsonInputOption())
      .option("--issue-id <id>", "Issue ordinal id (#B-123, B-123, B123, or 123)")
      .option(
        "--status <status>",
        "ACTIVE | IGNORED | FIXED | DUPLICATE | IN_PROGRESS_BUG | ARCHIVED_BUG | BLOCKED",
      )
      .option(
        "--ignore-reason <reason>",
        "When status=IGNORED: INTENDED_BEHAVIOUR | INACCURATE_ASSESSMENT | NOT_IMPORTANT",
      ),
  ).action(async (opts) => {
    const body: Record<string, unknown> = {
      ...collectAgentTraceabilityFlags(opts),
    };
    if (opts.issueId) body.issueId = String(opts.issueId).trim();
    if (opts.status) body.status = String(opts.status).trim();
    if (opts.ignoreReason) body.ignoreReason = String(opts.ignoreReason).trim();
    const merged = mergeBodies(body, opts.jsonInput) as Record<string, unknown>;
    if (!merged.issueId || String(merged.issueId).trim() === "") {
      throw new Error("issueId is required (--issue-id)");
    }
    if (!merged.status || String(merged.status).trim() === "") {
      throw new Error(
        "status is required (ACTIVE | IGNORED | FIXED | DUPLICATE | IN_PROGRESS_BUG | ARCHIVED_BUG | BLOCKED)",
      );
    }
    const out = await runTool("update-issue-status", merged, { postMcp });
    console.log(out);
  });

  addAgentTraceabilityOptions(
    program
      .command("create-issue")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "create-issue")!.description)
      .addOption(jsonInputOption())
      .option("--title <title>", "Issue title (required unless provided via --json-input)")
      .option("--description <text>", "Issue description (markdown supported)")
      .option(
        "--issue-type <type>",
        "BUG_ISSUE | SUGGESTION_ISSUE | OBSERVATION_ISSUE | TASK_ISSUE",
      )
      .option(
        "--category <category>",
        "FUNCTIONAL | SECURITY | ACCESSIBILITY | PERFORMANCE | VISUAL | …",
      )
      .option(
        "--severity <severity>",
        "LOW_SEVERITY | MEDIUM_SEVERITY | HIGH_SEVERITY | CRITICAL_SEVERITY",
      )
      .option(
        "--status <status>",
        "ACTIVE | IGNORED | FIXED | DUPLICATE | IN_PROGRESS_BUG | ARCHIVED_BUG | BLOCKED",
      )
      .option("--reported-release-id <id>", "Release label/id to attach to the issue")
      .option("--due-date-millis <ms>", "Due date as UTC epoch millis")
      .option("--assignee <userId>", "Assignee user id")
      .option("--labels <csv>", "Comma-separated labels")
      .option("--source <name>", "External ingest source identifier (stored as label source:<name>)")
      .option("--environment <name>", "Environment tag (defaults to QA when omitted)"),
  ).action(async (opts) => {
    const body: Record<string, unknown> = {
      ...collectAgentTraceabilityFlags(opts),
    };
    if (opts.title) body.title = String(opts.title).trim();
    if (opts.description) body.description = String(opts.description);
    if (opts.issueType) body.issueType = String(opts.issueType).trim();
    if (opts.category) body.category = String(opts.category).trim();
    if (opts.severity) body.severity = String(opts.severity).trim();
    if (opts.status) body.status = String(opts.status).trim();
    if (opts.reportedReleaseId) body.reportedReleaseId = String(opts.reportedReleaseId).trim();
    if (opts.dueDateMillis != null) body.dueDateMillis = Number(opts.dueDateMillis);
    if (opts.assignee) body.assignee = String(opts.assignee).trim();
    if (opts.labels) {
      body.labels = String(opts.labels)
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
    if (opts.source) body.source = String(opts.source).trim();
    if (opts.environment) body.environment = String(opts.environment).trim();
    const merged = mergeBodies(body, opts.jsonInput) as { title?: string };
    if (!merged.title || String(merged.title).trim() === "") {
      throw new Error("title is required (--title or --json-input {\"title\":\"...\"})");
    }
    const out = await runTool("create-issue", merged, { postMcp });
    console.log(out);
  });

  program
    .command("mark-plan-items-implementation-done")
    .description(
      TOOL_DEFINITIONS.find((t) => t.kebab === "mark-plan-items-implementation-done")!.description
    )
    .addOption(jsonInputOption())
    .option("--scenario-ordinal-ids <csv>", "comma-separated TS-<n> numeric ids")
    .option("--user-story-ordinal-ids <csv>", "comma-separated US-<n> numeric ids")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.scenarioOrdinalIds) {
        body.scenarioOrdinalIds = String(opts.scenarioOrdinalIds)
          .split(",")
          .map((s: string) => Number(s.trim()))
          .filter((n: number) => Number.isFinite(n) && n > 0);
      }
      if (opts.userStoryOrdinalIds) {
        body.userStoryOrdinalIds = String(opts.userStoryOrdinalIds)
          .split(",")
          .map((s: string) => Number(s.trim()))
          .filter((n: number) => Number.isFinite(n) && n > 0);
      }
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("mark-plan-items-implementation-done", merged, { postMcp });
      console.log(out);
    });

  program
    .command("update-plan-items-lifecycle-status")
    .description(
      TOOL_DEFINITIONS.find((t) => t.kebab === "update-plan-items-lifecycle-status")!.description
    )
    .addOption(jsonInputOption())
    .option("--entity-type <type>", "story | scenario")
    .option("--ordinal-id <n>", "numeric US-/TS- ordinal")
    .option(
      "--status <status>",
      "draft | ready | in progress | blocked | done | archived"
    )
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.entityType) body.entityType = String(opts.entityType).trim();
      if (opts.ordinalId != null && String(opts.ordinalId).trim() !== "") {
        body.ordinalId = Number(String(opts.ordinalId).trim());
      }
      if (opts.status) body.status = String(opts.status).trim();
      const merged = mergeBodies(body, opts.jsonInput) as {
        entityType?: string;
        ordinalId?: number;
        status?: string;
      };
      if (!merged.entityType || String(merged.entityType).trim() === "") {
        throw new Error("entity-type is required (story | scenario)");
      }
      if (merged.ordinalId == null || !Number.isFinite(merged.ordinalId) || merged.ordinalId <= 0) {
        throw new Error("ordinal-id is required (positive integer)");
      }
      if (!merged.status || String(merged.status).trim() === "") {
        throw new Error(
          "status is required (draft | ready | in progress | blocked | done | archived)"
        );
      }
      const out = await runTool(
        "update-plan-items-lifecycle-status",
        {
          entityType: String(merged.entityType).trim(),
          ordinalId: merged.ordinalId,
          status: String(merged.status).trim(),
        },
        { postMcp }
      );
      console.log(out);
    });

  addAgentTraceabilityOptions(
    program
      .command("update-test-scenario")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "update-test-scenario")!.description)
      .addOption(jsonInputOption())
      .option("--content <markdown>")
      .option("--content-file <path>"),
  ).action(async (opts) => {
    let content = opts.content as string | undefined;
    if (opts.contentFile) content = await readFile(String(opts.contentFile), "utf8");
    if (!content) throw new Error("Provide --content or --content-file (or full body via --json-input)");
    const body = { content, ...collectAgentTraceabilityFlags(opts) };
    const merged = mergeBodies(body, opts.jsonInput);
    const out = await runTool("update-test-scenario", merged, { postMcp });
    console.log(out);
  });

  program
    .command("get-eaas-config")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-eaas-config")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("get-eaas-config", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-branch-specific-endpoint-config")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-branch-specific-endpoint-config")!.description)
    .addOption(jsonInputOption())
    .option("--branch-name <s>")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.branchName) body.branchName = opts.branchName;
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("get-branch-specific-endpoint-config", merged, { postMcp });
      console.log(out);
    });

  program
    .command("provision-ephemeral-environment-and-wait")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "provision-ephemeral-environment-and-wait")!.description)
    .addOption(jsonInputOption())
    .option("--branch-name <s>")
    .option("--poll-interval-seconds <n>")
    .option("--max-wait-minutes <n>")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.branchName) body.branchName = opts.branchName;
      if (opts.pollIntervalSeconds != null) body.pollIntervalSeconds = Number(opts.pollIntervalSeconds);
      if (opts.maxWaitMinutes != null) body.maxWaitMinutes = Number(opts.maxWaitMinutes);
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("provision-ephemeral-environment-and-wait", merged, {
        postMcp,
        onProgress: stderrProgress,
      });
      console.log(out);
    });

  program
    .command("provision-ephemeral-environment")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "provision-ephemeral-environment")!.description)
    .addOption(jsonInputOption())
    .option("--branch-name <s>")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.branchName) body.branchName = opts.branchName;
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("provision-ephemeral-environment", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-ephemeral-environment-status")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-ephemeral-environment-status")!.description)
    .addOption(jsonInputOption())
    .requiredOption("--bns-environment-id <id>")
    .action(async (opts) => {
      const body = { bnsEnvironmentId: opts.bnsEnvironmentId };
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("get-ephemeral-environment-status", merged, { postMcp });
      console.log(out);
    });

  program
    .command("destroy-ephemeral-environment")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "destroy-ephemeral-environment")!.description)
    .addOption(jsonInputOption())
    .requiredOption("--bns-environment-id <id>")
    .action(async (opts) => {
      const body = { bnsEnvironmentId: opts.bnsEnvironmentId };
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("destroy-ephemeral-environment", merged, { postMcp });
      console.log(out);
    });

  program
    .command("list-bunnyshell-environment-events")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-bunnyshell-environment-events")!.description)
    .addOption(jsonInputOption())
    .requiredOption("--bns-environment-id <id>")
    .option("--event-type <s>")
    .option("--event-status <s>")
    .option("--page <n>")
    .action(async (opts) => {
      const body: Record<string, unknown> = { bnsEnvironmentId: opts.bnsEnvironmentId };
      if (opts.eventType) body.eventType = opts.eventType;
      if (opts.eventStatus) body.eventStatus = opts.eventStatus;
      if (opts.page != null) body.page = Number(opts.page);
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("list-bunnyshell-environment-events", merged, { postMcp });
      console.log(out);
    });

  program
    .command("list-bunnyshell-workflow-jobs")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-bunnyshell-workflow-jobs")!.description)
    .addOption(jsonInputOption())
    .requiredOption("--bns-environment-id <id>")
    .option("--page <n>")
    .action(async (opts) => {
      const body: Record<string, unknown> = { bnsEnvironmentId: opts.bnsEnvironmentId };
      if (opts.page != null) body.page = Number(opts.page);
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("list-bunnyshell-workflow-jobs", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-bunnyshell-workflow-job-logs")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-bunnyshell-workflow-job-logs")!.description)
    .addOption(jsonInputOption())
    .requiredOption("--bns-environment-id <id>")
    .requiredOption("--workflow-job-id <id>")
    .action(async (opts) => {
      const body = { bnsEnvironmentId: opts.bnsEnvironmentId, workflowJobId: opts.workflowJobId };
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("get-bunnyshell-workflow-job-logs", merged, { postMcp });
      console.log(out);
    });

  program
    .command("list-rum-environments")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-rum-environments")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("list-rum-environments", merged, { postMcp });
      console.log(out);
    });

  addTruecoverageScopeFlags(
    program
      .command("get-truecoverage-events")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-events")!.description)
      .addOption(jsonInputOption())
  ).action(async (opts) => {
    const body: Record<string, unknown> = {};
    const base = scopeFromFlags(opts);
    if (base) body.baseExecutionScope = base;
    const merged = mergeBodies(body, opts.jsonInput);
    const out = await runTool("get-truecoverage-events", merged, { postMcp });
    console.log(out);
  });

  addTruecoverageScopeFlags(
    program
      .command("get-truecoverage-event-details")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-event-details")!.description)
      .addOption(jsonInputOption())
      .option("--event-title <title>", "Event title (or set eventTitle in --json-input)")
  ).action(async (opts) => {
    const body: Record<string, unknown> = {};
    if (opts.eventTitle) body.eventTitle = String(opts.eventTitle);
    const base = scopeFromFlags(opts);
    if (base) body.baseExecutionScope = base;
    const merged = mergeBodies(body, opts.jsonInput);
    const out = await runTool("get-truecoverage-event-details", merged, { postMcp });
    console.log(out);
  });

  addTruecoverageScopeFlags(
    program
      .command("get-truecoverage-child-event-tree")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-child-event-tree")!.description)
      .addOption(jsonInputOption())
      .option("--event-title <title>", "Parent event title (or set eventTitle in --json-input)")
  ).action(async (opts) => {
    const body: Record<string, unknown> = {};
    if (opts.eventTitle) body.eventTitle = String(opts.eventTitle);
    const base = scopeFromFlags(opts);
    if (base) body.baseScope = base;
    const merged = mergeBodies(body, opts.jsonInput);
    const out = await runTool("get-truecoverage-child-event-tree", merged, { postMcp });
    console.log(out);
  });

  addTruecoverageScopeFlags(
    program
      .command("get-truecoverage-event-transition")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-event-transition")!.description)
      .addOption(jsonInputOption())
      .option("--event-title <title>", "From event (or eventTitle in --json-input)")
      .option("--next-event-title <title>", "To event (or nextEventTitle in --json-input)")
  ).action(async (opts) => {
    const body: Record<string, unknown> = {};
    if (opts.eventTitle) body.eventTitle = String(opts.eventTitle);
    if (opts.nextEventTitle) body.nextEventTitle = String(opts.nextEventTitle);
    const base = scopeFromFlags(opts);
    if (base) body.baseScope = base;
    const merged = mergeBodies(body, opts.jsonInput);
    const out = await runTool("get-truecoverage-event-transition", merged, { postMcp });
    console.log(out);
  });

  addTruecoverageScopeFlags(
    program
      .command("get-truecoverage-event-time-series")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-event-time-series")!.description)
      .addOption(jsonInputOption())
      .option("--event-title <title>", "Optional event title")
      .option(
        "--metric-type <name>",
        "SESSION_COUNT | RELATIVE_FREQUENCY | PERCENTAGE_TERMINAL_EVENT | SESSION_POSITION | …"
      )
  ).action(async (opts) => {
    const body: Record<string, unknown> = {};
    if (opts.eventTitle) body.eventTitle = String(opts.eventTitle);
    if (opts.metricType) body.metricType = String(opts.metricType);
    const base = scopeFromFlags(opts);
    if (base) body.baseExecutionScope = base;
    const merged = mergeBodies(body, opts.jsonInput);
    const out = await runTool("get-truecoverage-event-time-series", merged, { postMcp });
    console.log(out);
  });

  program
    .command("get-truecoverage-session-metadata-keys")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-session-metadata-keys")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("get-truecoverage-session-metadata-keys", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-truecoverage-event-metadata-keys")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-event-metadata-keys")!.description)
    .addOption(jsonInputOption())
    .option("--event-title <title>", "Event title (or set eventTitle in --json-input)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.eventTitle) body.eventTitle = String(opts.eventTitle);
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("get-truecoverage-event-metadata-keys", merged, { postMcp });
      console.log(out);
    });

  program
    .command("list-screen-states")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-screen-states")!.description)
    .addOption(jsonInputOption())
    .option("--environment <s>", "optional environment tag (forward compatibility)")
    .action(async (opts) => {
      const body: Record<string, string> = {};
      if (opts.environment) body.environment = String(opts.environment);
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("list-screen-states", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-release")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-release")!.description)
    .addOption(jsonInputOption())
    .option("--version <version>", "Release version / label (McpGetReleaseRequest.version)")
    .action(async (opts) => {
      const body: Record<string, string> = {};
      if (opts.version) body.version = String(opts.version);
      const merged = mergeBodies(body, opts.jsonInput) as { version?: string };
      if (!merged.version || String(merged.version).trim() === "") {
        throw new Error("version is required (--version or --json-input {\"version\":\"...\"})");
      }
      const out = await runTool("get-release", { version: String(merged.version).trim() }, { postMcp });
      console.log(out);
    });

  program
    .command("get-release-details")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-release-details")!.description)
    .addOption(jsonInputOption())
    .option("--version <version>", "Release version / label (McpGetReleaseDetailsRequest.version)")
    .action(async (opts) => {
      const body: Record<string, string> = {};
      if (opts.version) body.version = String(opts.version);
      const merged = mergeBodies(body, opts.jsonInput) as { version?: string };
      if (!merged.version || String(merged.version).trim() === "") {
        throw new Error("version is required (--version or --json-input {\"version\":\"...\"})");
      }
      const out = await runTool(
        "get-release-details",
        { version: String(merged.version).trim() },
        { postMcp },
      );
      console.log(out);
    });

  program
    .command("get-security-scan-config")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-security-scan-config")!.description)
    .addOption(jsonInputOption())
    .option("--id <scanId>", "Security scan id")
    .action(async (opts) => {
      const body: Record<string, string> = {};
      if (opts.id) body.id = String(opts.id);
      const merged = mergeBodies(body, opts.jsonInput) as { id?: string };
      if (!merged.id || String(merged.id).trim() === "") {
        throw new Error("id is required (--id or --json-input {\"id\":\"...\"})");
      }
      const out = await runTool("get-security-scan-config", { id: String(merged.id).trim() }, { postMcp });
      console.log(out);
    });

  program
    .command("update-scan-progress")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "update-scan-progress")!.description)
    .addOption(jsonInputOption())
    .option("--id <scanId>", "Security scan id")
    .option("--status <status>", "QUEUED | IN_PROGRESS | COMPLETED | EXCEPTION")
    .action(async (opts) => {
      const body: Record<string, string> = {};
      if (opts.id) body.id = String(opts.id);
      if (opts.status) body.status = String(opts.status);
      const merged = mergeBodies(body, opts.jsonInput) as { id?: string; status?: string };
      if (!merged.id || String(merged.id).trim() === "") {
        throw new Error("id is required");
      }
      if (!merged.status || String(merged.status).trim() === "") {
        throw new Error("status is required (QUEUED | IN_PROGRESS | COMPLETED | EXCEPTION)");
      }
      const out = await runTool(
        "update-scan-progress",
        { id: String(merged.id).trim(), status: String(merged.status).trim() },
        { postMcp },
      );
      console.log(out);
    });

  program
    .command("report-dast-findings")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "report-dast-findings")!.description)
    .addOption(jsonInputOption())
    .option("--id <scanId>", "Security scan id")
    .option("--report-file <path>", "Path to ZAP Traditional JSON report")
    .action(async (opts) => {
      const body: Record<string, string> = {};
      if (opts.id) body.id = String(opts.id);
      if (opts.reportFile) body.reportFile = String(opts.reportFile);
      const merged = mergeBodies(body, opts.jsonInput) as { id?: string; reportFile?: string };
      if (!merged.id || String(merged.id).trim() === "") {
        throw new Error("id is required");
      }
      if (!merged.reportFile || String(merged.reportFile).trim() === "") {
        throw new Error("reportFile is required (--report-file)");
      }
      const out = await runTool(
        "report-dast-findings",
        { id: String(merged.id).trim(), reportFile: String(merged.reportFile).trim() },
        { postMcp },
      );
      console.log(out);
    });

  program
    .command("report-sast-findings")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "report-sast-findings")!.description)
    .addOption(jsonInputOption())
    .option("--id <scanId>", "Security scan id")
    .option("--report-file <path>", "Path to full Semgrep CLI JSON report")
    .action(async (opts) => {
      const body: Record<string, string> = {};
      if (opts.id) body.id = String(opts.id);
      if (opts.reportFile) body.reportFile = String(opts.reportFile);
      const merged = mergeBodies(body, opts.jsonInput) as { id?: string; reportFile?: string };
      if (!merged.id || String(merged.id).trim() === "") {
        throw new Error("id is required");
      }
      if (!merged.reportFile || String(merged.reportFile).trim() === "") {
        throw new Error("reportFile is required (--report-file)");
      }
      const out = await runTool(
        "report-sast-findings",
        { id: String(merged.id).trim(), reportFile: String(merged.reportFile).trim() },
        { postMcp },
      );
      console.log(out);
    });

  program
    .command("report-secrets-findings")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "report-secrets-findings")!.description)
    .addOption(jsonInputOption())
    .option("--id <scanId>", "Security scan id")
    .option("--report-file <path>", "Path to full Gitleaks JSON report")
    .action(async (opts) => {
      const body: Record<string, string> = {};
      if (opts.id) body.id = String(opts.id);
      if (opts.reportFile) body.reportFile = String(opts.reportFile);
      const merged = mergeBodies(body, opts.jsonInput) as { id?: string; reportFile?: string };
      if (!merged.id || String(merged.id).trim() === "") {
        throw new Error("id is required");
      }
      if (!merged.reportFile || String(merged.reportFile).trim() === "") {
        throw new Error("reportFile is required (--report-file)");
      }
      const out = await runTool(
        "report-secrets-findings",
        { id: String(merged.id).trim(), reportFile: String(merged.reportFile).trim() },
        { postMcp },
      );
      console.log(out);
    });

  program
    .command("report-deps-findings")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "report-deps-findings")!.description)
    .addOption(jsonInputOption())
    .option("--id <scanId>", "Security scan id")
    .option("--report-file <path>", "Path to full Trivy JSON report")
    .action(async (opts) => {
      const body: Record<string, string> = {};
      if (opts.id) body.id = String(opts.id);
      if (opts.reportFile) body.reportFile = String(opts.reportFile);
      const merged = mergeBodies(body, opts.jsonInput) as { id?: string; reportFile?: string };
      if (!merged.id || String(merged.id).trim() === "") {
        throw new Error("id is required");
      }
      if (!merged.reportFile || String(merged.reportFile).trim() === "") {
        throw new Error("reportFile is required (--report-file)");
      }
      const out = await runTool(
        "report-deps-findings",
        { id: String(merged.id).trim(), reportFile: String(merged.reportFile).trim() },
        { postMcp },
      );
      console.log(out);
    });

  program
    .command("upsert-screen-states")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "upsert-screen-states")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("upsert-screen-states", merged, { postMcp });
      console.log(out);
    });

  program
    .command("list-semantic-similar-tests")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-semantic-similar-tests")!.description)
    .addOption(jsonInputOption())
    .option("--folder-path <path>", "folder under tests root, slash-separated")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      const scope: { folderPath?: string } = {};
      if (opts.folderPath) scope.folderPath = opts.folderPath;
      if (Object.keys(scope).length) body.scope = scope;
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("list-semantic-similar-tests", merged, { postMcp });
      console.log(out);
    });

  program
    .command("mark-semantic-tests-distinct")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "mark-semantic-tests-distinct")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("mark-semantic-tests-distinct", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-requirement-quality-report")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-requirement-quality-report")!.description)
    .addOption(jsonInputOption())
    .option("--subject-type <STORY|SCENARIO>", "STORY for US-<n>, SCENARIO for TS-<n>")
    .option("--subject-entity-id <id>", "Platform subject entity id")
    .option("--ordinal-id <n>", "Numeric part of US-<n> or TS-<n>")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.subjectType) body.subjectType = String(opts.subjectType).trim();
      if (opts.subjectEntityId) body.subjectEntityId = String(opts.subjectEntityId).trim();
      if (opts.ordinalId != null) body.ordinalId = Number(opts.ordinalId);
      const merged = mergeBodies(body, opts.jsonInput) as {
        subjectType?: string;
        subjectEntityId?: string;
        ordinalId?: number;
      };
      if (!merged.subjectType || String(merged.subjectType).trim() === "") {
        throw new Error("subjectType is required (STORY | SCENARIO)");
      }
      const out = await runTool(
        "get-requirement-quality-report",
        {
          subjectType: String(merged.subjectType).trim(),
          ...(merged.subjectEntityId ? { subjectEntityId: String(merged.subjectEntityId).trim() } : {}),
          ...(merged.ordinalId != null ? { ordinalId: Number(merged.ordinalId) } : {}),
        },
        { postMcp },
      );
      console.log(out);
    });

  program
    .command("report-requirement-quality-findings")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "report-requirement-quality-findings")!.description)
    .addOption(jsonInputOption())
    .option("--report-file <path>", "Path to RequirementQualityReport JSON (camelCase)")
    .option("--subject-type <STORY|SCENARIO>", "Merge into report.subject when resolving entity id")
    .option("--subject-entity-id <id>", "Platform subject entity id (story DB id or scenario UUID)")
    .option("--ordinal-id <n>", "US-<n> or TS-<n> numeric id; resolves subjectEntityId via get-report")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.reportFile) body.reportFile = String(opts.reportFile);
      if (opts.subjectType) body.subjectType = String(opts.subjectType).trim();
      if (opts.subjectEntityId) body.subjectEntityId = String(opts.subjectEntityId).trim();
      if (opts.ordinalId != null) body.ordinalId = Number(opts.ordinalId);
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("report-requirement-quality-findings", merged, { postMcp });
      console.log(out);
    });

  // Workflow policy + traceability tools (US-181). Prefer --json-input for nested TestLocator.
  program
    .command("report-agent-action")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "report-agent-action")!.description)
    .addOption(jsonInputOption())
    .requiredOption("--workflow-id <id>", "Catalog workflow id")
    .requiredOption("--workflow-execution-id <ulid>", "Stable ULID for the whole run")
    .requiredOption(
      "--action-type <type>",
      "CREATED|UPDATED|DELETED|ANALYZED|IMPLEMENTED|ACTION_COMPLETED|ACTION_FAILED",
    )
    .option("--policy-file <name>", "Policy filename")
    .option("--policy-version <semver>", "Policy version from frontmatter")
    .option("--git-sha <sha>", "Current HEAD sha")
    .option("--actor-type <type>", "LOCAL_AGENT|CLOUD_AGENT (or local-agent|cloud-agent)")
    .option("--user-id <id>", "Optional user id for traceability")
    .option("--branch-name <name>", "Git branch")
    .option("--agent-model <model>", "Optional agent model id (agent/CLI only)")
    .requiredOption(
      "--entity-type <type>",
      "USER_STORY|SCENARIO|SMART_TEST|POLICY|ISSUE|TEST_EXECUTION|TEST_INVOCATION_BATCH|EXPLORATION|EVENT|WORKFLOW",
    )
    .option("--entity-identity <ordinal>", "Project-scoped ordinal id (mutually exclusive with --test-json)")
    .option("--test-json <json>", "TestLocator JSON (folderPath/fileName/testSuite/testName)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {
        workflowId: String(opts.workflowId),
        workflowExecutionId: String(opts.workflowExecutionId),
        actionType: String(opts.actionType),
        entityType: String(opts.entityType),
      };
      if (opts.policyFile) body.policyFile = String(opts.policyFile);
      if (opts.policyVersion) body.policyVersion = String(opts.policyVersion);
      const gitSha = resolveGitHeadSha(opts.gitSha ? String(opts.gitSha) : undefined);
      if (gitSha) body.gitSha = gitSha;
      if (opts.actorType) body.actorType = String(opts.actorType);
      if (opts.userId) body.userId = String(opts.userId);
      if (opts.branchName) body.branchName = String(opts.branchName);
      if (opts.agentModel) body.agentModel = String(opts.agentModel).trim();
      if (opts.entityIdentity) body.entityIdentity = String(opts.entityIdentity);
      if (opts.testJson) body.test = JSON.parse(String(opts.testJson));
      const merged = mergeBodies(body, opts.jsonInput);
      console.log(await runTool("report-agent-action", merged, { postMcp }));
    });

  program
    .command("get-last-run-workflow-detail")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-last-run-workflow-detail")!.description)
    .addOption(jsonInputOption())
    .requiredOption("--workflow-id <id>", "Catalog workflow id")
    .option("--branch-name <name>", "Optional branch filter (omit for any branch)")
    .option("--user-id <id>", "Optional per-user last run")
    .action(async (opts) => {
      const body: Record<string, unknown> = { workflowId: String(opts.workflowId) };
      if (opts.branchName) body.branchName = String(opts.branchName);
      if (opts.userId) body.userId = String(opts.userId);
      const merged = mergeBodies(body, opts.jsonInput);
      console.log(await runTool("get-last-run-workflow-detail", merged, { postMcp }));
    });

  for (const kebab of [
    "list-workflow-executions",
    "get-workflow-execution",
    "get-policy",
    "list-policies",
    "list-workflow-catalog",
  ] as const) {
    program
      .command(kebab)
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === kebab)!.description)
      .addOption(jsonInputOption())
      .action(async (opts) => {
        const merged = mergeBodies({}, opts.jsonInput);
        console.log(await runTool(kebab, merged, { postMcp }));
      });
  }

  program
    .command("upsert-policy")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "upsert-policy")!.description)
    .addOption(jsonInputOption())
    .option("--policy-file-name <name>", "e.g. connect-to-test-env.policy.md")
    .option("--content <markdown>", "full markdown including frontmatter")
    .option("--content-file <path>", "read markdown from file")
    .action(async (opts) => {
      let content = opts.content as string | undefined;
      if (opts.contentFile) content = await readFile(String(opts.contentFile), "utf8");
      const body: Record<string, unknown> = {};
      if (opts.policyFileName) body.policyFileName = String(opts.policyFileName);
      if (content) body.content = content;
      const merged = mergeBodies(body, opts.jsonInput) as Record<string, unknown>;
      if (!merged.policyFileName || !merged.content) {
        throw new Error(
          "Provide --policy-file-name and --content or --content-file (or full body via --json-input)",
        );
      }
      console.log(await runTool("upsert-policy", merged, { postMcp }));
    });

  program
    .command("upsert-plans-support-file")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "upsert-plans-support-file")!.description)
    .addOption(jsonInputOption())
    .option(
      "--file-path <path>",
      "path relative to mapped plans root (e.g. knowledge/workflow_plans/run-qa/<ulid>.plan.md)",
    )
    .option("--content <markdown>", "full file content")
    .option("--content-file <path>", "read content from local file")
    .action(async (opts) => {
      let content = opts.content as string | undefined;
      if (opts.contentFile) content = await readFile(String(opts.contentFile), "utf8");
      const body: Record<string, unknown> = {};
      if (opts.filePath) body.filePath = String(opts.filePath);
      if (content !== undefined) body.content = content;
      const merged = mergeBodies(body, opts.jsonInput) as Record<string, unknown>;
      if (!merged.filePath || merged.content === undefined || merged.content === null) {
        throw new Error(
          "Provide --file-path and --content or --content-file (or full body via --json-input)",
        );
      }
      console.log(await runTool("upsert-plans-support-file", merged, { postMcp }));
    });

  program.on("--help", () => {
    /* default */
  });

  program.addHelpText(
    "after",
    `\nEnvironment:\n  TESTCHIMP_API_KEY          required\n  TESTCHIMP_BACKEND_URL      optional (default ${DEFAULT_BACKEND})\n\nOutput:\n  Response JSON on stdout.\n  provision-ephemeral-environment-and-wait progress on stderr.\n\nAdvanced:\n  --json-input merges a JSON object over flags (JSON wins on key conflicts). Use @file.json to read from disk.\n`
  );

  return program;
}
