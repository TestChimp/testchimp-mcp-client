import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DEFAULT_BACKEND, DEFAULT_INGRESS, postIngress, postMcp } from "../core/client.js";
import { deepMerge } from "../core/merge.js";
import { runTool } from "../core/tools.js";
import { TOOL_DEFINITIONS } from "../core/tools.js";
import { resolveGitHeadSha } from "../core/gitSha.js";
import { PACKAGE_VERSION } from "../core/version.js";

export { PACKAGE_VERSION };

/** True when ComparePerfToBaselineResponse (or a flat PerfComparison) reports a regression. */
function isPerfComparisonRegressed(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const body = parsed as { regressed?: unknown; comparison?: { regressed?: unknown } };
  return body.regressed === true || body.comparison?.regressed === true;
}

/** Ack statuses that mean the id or bot identity is wrong (exit non-zero). */
const BOT_ACK_FAILURE_STATUSES = new Set([
  "BOT_ACK_UNKNOWN_EVENT",
  "BOT_ACK_NOT_A_TARGET",
  "BOT_ACK_MISSING_BOT_ID",
]);

/** Numeric x.y.z comparison; prerelease / build suffixes are ignored. */
export function compareSemver(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/, "").split(/[-+]/)[0].split(".").map((p) => parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

type CoverageRecordTypeAlias = "smart_test" | "manual" | "perf_test";

function parseRecordTypesCsv(raw: string): CoverageRecordTypeAlias[] {
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
      if (s === "perf" || s === "perftest" || s === "perf_test") return "perf_test";
      return s as CoverageRecordTypeAlias;
    })
    .filter((v): v is CoverageRecordTypeAlias =>
      v === "smart_test" || v === "manual" || v === "perf_test");
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
    .option("--agent-model <model>", "Optional agent model id (agent/CLI only)")
    .option("--skill-version <semver>", "TestChimp skill version from SKILL.md frontmatter")
    .option("--cli-version <semver>", "CLI version (defaults to this package version)");
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
  if (opts.skillVersion) body.skillVersion = String(opts.skillVersion).trim();
  if (opts.cliVersion) body.cliVersion = String(opts.cliVersion).trim();
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
    .description("Start the TestChimp MCP server (stdio transport; --http for remote Streamable HTTP with OAuth bearer auth)")
    .option("--http", "Serve MCP over Streamable HTTP (stateless) at /mcp instead of stdio")
    .option("--port <n>", "HTTP port (default: PORT env or 8080)", (v) => parseInt(v, 10))
    .option("--host <h>", "HTTP bind host", "0.0.0.0")
    .action(async (opts) => {
      if (opts.http) {
        const port = opts.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 8080);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${port}`);
        const { runMcpHttpServer } = await import("../mcp/httpServer.js");
        await runMcpHttpServer({ port, host: String(opts.host) });
        return;
      }
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
    .option("--record-types <csv>", "coverage sources: smart_test,manual,perf_test (aliases: automated,smarttest,perf)")
    .option("--include-manual", "include manual session coverage in addition to automated SmartTests")
    .option("--include-perf", "include PERF_TEST journey coverage in addition to automated SmartTests")
    .option("--manual-only", "manual-only coverage (no automated)")
    .option("--lifecycle-statuses <csv>", "scenario lifecycle allowlist (e.g. ready or draft,ready)")
    .option("--limit <n>", "top N gaps after filter+rank into rankedScenarios (max 200)", (v) => parseInt(v, 10))
    .option("--consider-scenario-priority", "rank by scenario priority high→medium→low→unset")
    .option("--consider-semantic-coverage", "reserved ranking signal (accepted; no server effect yet)")
    .option("--auto-verification-only", "exclude verification_strategy=manual (server default when unset)")
    .option("--include-manual-verification", "include verification_strategy=manual (overrides --auto-verification-only)")
    .option("--file-paths <csv>", "comma-separated paths under platform tests root")
    .option("--folder-path <path>", "folder under tests root, slash-separated")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.release) body.release = opts.release;
      if (opts.environment) body.environment = opts.environment;
      if (opts.branchName) body.branchName = opts.branchName;
      if (opts.platform) body.platform = opts.platform;
      let recordTypes: CoverageRecordTypeAlias[] | undefined;
      if (opts.recordTypes) recordTypes = parseRecordTypesCsv(String(opts.recordTypes));
      if (opts.includeManual) recordTypes = Array.from(new Set([...(recordTypes ?? ["smart_test"]), "manual"]));
      if (opts.manualOnly) recordTypes = ["manual"];
      if (opts.includePerf) {
        recordTypes = Array.from(new Set([...(recordTypes ?? ["smart_test"]), "perf_test"]));
      }
      if (recordTypes && recordTypes.length > 0) body.recordTypes = recordTypes;
      if (opts.lifecycleStatuses) {
        body.scenarioLifecycleStatuses = String(opts.lifecycleStatuses)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (opts.limit != null && !Number.isNaN(opts.limit)) body.limit = opts.limit;
      if (opts.considerScenarioPriority) body.considerScenarioPriority = true;
      if (opts.considerSemanticCoverage) body.considerSemanticCoverage = true;
      if (opts.includeManualVerification) body.autoVerificationOnly = false;
      else if (opts.autoVerificationOnly) body.autoVerificationOnly = true;
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
    .command("get-suite-execution-stats")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-suite-execution-stats")!.description)
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
      const out = await runTool("get-suite-execution-stats", merged, { postMcp });
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

  program
    .command("upload-attachment")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "upload-attachment")!.description)
    .addOption(jsonInputOption())
    .option("--file <path>", "Path to file to upload (e.g. screenshot PNG)")
    .option("--filename <name>", "Original filename for extension inference")
    .option("--content-type <type>", "MIME type (default application/octet-stream)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.file) body.file = String(opts.file);
      if (opts.filename) body.filename = String(opts.filename);
      if (opts.contentType) body.contentType = String(opts.contentType);
      const merged = mergeBodies(body, opts.jsonInput) as {
        file?: string;
        filename?: string;
        contentType?: string;
      };
      if (!merged.file || String(merged.file).trim() === "") {
        throw new Error("file is required (--file)");
      }
      const out = await runTool(
        "upload-attachment",
        {
          file: String(merged.file).trim(),
          ...(merged.filename ? { filename: String(merged.filename) } : {}),
          ...(merged.contentType ? { contentType: String(merged.contentType) } : {}),
        },
        { postMcp },
      );
      console.log(out);
    });

  program
    .command("get-batch-view-url")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-batch-view-url")!.description)
    .addOption(jsonInputOption())
    .option("--batch-invocation-id <id>", "Batch invocation id")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.batchInvocationId) body.batchInvocationId = String(opts.batchInvocationId);
      const merged = mergeBodies(body, opts.jsonInput) as { batchInvocationId?: string };
      if (!merged.batchInvocationId || String(merged.batchInvocationId).trim() === "") {
        throw new Error("batchInvocationId is required (--batch-invocation-id)");
      }
      const out = await runTool(
        "get-batch-view-url",
        { batchInvocationId: String(merged.batchInvocationId).trim() },
        { postMcp },
      );
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
    .command("list-test-scenarios-for-scope")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-test-scenarios-for-scope")!.description)
    .addOption(jsonInputOption())
    .option("--named-test-run-id <id>", "named test run id")
    .option("--release <label>", "release catalog version / label")
    .option(
      "--plans-path <path>",
      "platform plans folder or .md file (e.g. plans/scenarios/checkout or plans/scenarios/checkout/login.md)",
    )
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.namedTestRunId) body.namedTestRunId = String(opts.namedTestRunId).trim();
      if (opts.release) body.release = String(opts.release).trim();
      if (opts.plansPath) body.plansPath = String(opts.plansPath).trim();
      const merged = mergeBodies(body, opts.jsonInput) as Record<string, unknown>;
      for (const key of ["namedTestRunId", "release", "plansPath"] as const) {
        const value = merged[key];
        if (typeof value !== "string") {
          continue;
        }
        const trimmed = value.trim();
        if (!trimmed) {
          delete merged[key];
        } else {
          merged[key] = trimmed;
        }
      }
      const out = await runTool("list-test-scenarios-for-scope", merged, { postMcp });
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
    .command("get-meeting-transcript")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-meeting-transcript")!.description)
    .addOption(jsonInputOption())
    .option(
      "--meeting-id <id>",
      "meeting id (calendar event id, or URL hash for ad-hoc; same as Studio folder under ~/.testchimp/data/meetings/)",
    )
    .option("--summary-only", "return only the post-meeting summary (omit the transcript body)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.meetingId) {
        body.meetingId = String(opts.meetingId).trim();
      }
      if (opts.summaryOnly) {
        body.summaryOnly = true;
      }
      const merged = mergeBodies(body, opts.jsonInput) as { meetingId?: string; summaryOnly?: boolean };
      if (!merged.meetingId || String(merged.meetingId).trim() === "") {
        throw new Error("meetingId is required (--meeting-id)");
      }
      const out = await runTool(
        "get-meeting-transcript",
        {
          meetingId: String(merged.meetingId).trim(),
          ...(merged.summaryOnly ? { summaryOnly: true } : {}),
        },
        { postMcp },
      );
      console.log(out);
    });

  program
    .command("get-meeting-set")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-meeting-set")!.description)
    .addOption(jsonInputOption())
    .option("--meeting-set-id <id>", "meeting-set ULID (from `/testchimp using meeting-set context <id>`)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.meetingSetId) {
        body.meetingSetId = String(opts.meetingSetId).trim();
      }
      const merged = mergeBodies(body, opts.jsonInput) as { meetingSetId?: string };
      if (!merged.meetingSetId || String(merged.meetingSetId).trim() === "") {
        throw new Error("meetingSetId is required (--meeting-set-id)");
      }
      const out = await runTool(
        "get-meeting-set",
        { meetingSetId: String(merged.meetingSetId).trim() },
        { postMcp },
      );
      console.log(out);
    });

  const collectRepeatable = (value: string, previous: string[] = []): string[] => [
    ...previous,
    ...value.split(",").map((s) => s.trim()).filter(Boolean),
  ];

  program
    .command("list-meetings")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-meetings")!.description)
    .addOption(jsonInputOption())
    .option("--from <date>", "inclusive start: YYYY-MM-DD (local start of day), ISO datetime, or epoch millis")
    .option("--to <date>", "inclusive end: YYYY-MM-DD (local end of day), ISO datetime, or epoch millis")
    .option("--label <label>", "label filter (repeatable or comma-separated; OR, case-insensitive)", collectRepeatable)
    .option(
      "--participant <emailOrUserId>",
      "participant filter by email or user id (repeatable or comma-separated; OR)",
      collectRepeatable,
    )
    .option("--domain <domain>", "participant email domain filter (repeatable or comma-separated; OR)", collectRepeatable)
    .option("--search <text>", "full-text search over title + transcript")
    .option("--page-size <n>", "page size (default 50, max 200; max 25 when searching)")
    .option("--page-token <token>", "nextPageToken from the previous page")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.from) body.from = String(opts.from).trim();
      if (opts.to) body.to = String(opts.to).trim();
      if (opts.label?.length) body.labels = opts.label;
      if (opts.participant?.length) body.participantKeys = opts.participant;
      if (opts.domain?.length) body.participantDomains = opts.domain;
      if (opts.search) body.searchText = String(opts.search);
      if (opts.pageSize) {
        const n = Number(opts.pageSize);
        if (!Number.isInteger(n) || n <= 0) throw new Error("--page-size must be a positive integer");
        body.pageSize = n;
      }
      if (opts.pageToken) body.pageToken = String(opts.pageToken).trim();
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("list-meetings", merged, { postMcp });
      console.log(out);
    });

  program
    .command("list-meeting-filter-options")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-meeting-filter-options")!.description)
    .action(async () => {
      const out = await runTool("list-meeting-filter-options", {}, { postMcp });
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

  program
    .command("get-spec-lifecycle-details")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-spec-lifecycle-details")!.description)
    .addOption(jsonInputOption())
    .option(
      "--scenario-ids <csv>",
      "comma-separated scenario ordinals (bare 107 or TS-107 / #TS-107)",
    )
    .option(
      "--story-ids <csv>",
      "comma-separated story ordinals (bare 12 or US-12 / #US-12)",
    )
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.scenarioIds) {
        const ids = String(opts.scenarioIds)
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
        if (ids.length > 0) body.scenarioIds = ids;
      }
      if (opts.storyIds) {
        const ids = String(opts.storyIds)
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
        if (ids.length > 0) body.storyIds = ids;
      }
      const merged = mergeBodies(body, opts.jsonInput) as Record<string, unknown>;
      if (Array.isArray(merged.scenarioIds) && merged.scenarioIds.length === 0) {
        delete merged.scenarioIds;
      }
      if (Array.isArray(merged.storyIds) && merged.storyIds.length === 0) {
        delete merged.storyIds;
      }
      const out = await runTool("get-spec-lifecycle-details", merged, { postMcp });
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
    .command("get-project-init-status")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-project-init-status")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("get-project-init-status", merged, { postMcp });
      console.log(out);
    });

  program
    .command("update-project-init-status")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "update-project-init-status")!.description)
    .addOption(jsonInputOption())
    .option("--status-json <json>", "ProjectInitStatus JSON object")
    .action(async (opts) => {
      let status: unknown;
      if (opts.statusJson) {
        status = JSON.parse(String(opts.statusJson));
      }
      const body: Record<string, unknown> = {};
      if (status != null) body.status = status;
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("update-project-init-status", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-git-folder-mapping")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-git-folder-mapping")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("get-git-folder-mapping", merged, { postMcp });
      console.log(out);
    });

  program
    .command("update-git-folder-mapping")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "update-git-folder-mapping")!.description)
    .addOption(jsonInputOption())
    .option("--tests-folder-path <path>")
    .option("--plans-folder-path <path>")
    .option("--repository-full-name <name>")
    .option("--plans-branch <branch>", "Branch plans sync against (empty string = repository default)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.plansBranch !== undefined) body.plansBranch = opts.plansBranch;
      if (opts.testsFolderPath) body.tests_folder_path = opts.testsFolderPath;
      if (opts.plansFolderPath) body.plans_folder_path = opts.plansFolderPath;
      if (opts.repositoryFullName) body.repository_full_name = opts.repositoryFullName;
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("update-git-folder-mapping", merged, { postMcp });
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
    .command("mark-tests-for-review")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "mark-tests-for-review")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("mark-tests-for-review", merged, { postMcp });
      console.log(out);
    });

  program
    .command("list-semantic-nearby")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-semantic-nearby")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("list-semantic-nearby", merged, { postMcp });
      console.log(out);
    });

  program
    .command("mark-entity-distinct")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "mark-entity-distinct")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("mark-entity-distinct", merged, { postMcp });
      console.log(out);
    });

  program
    .command("unmark-entity-distinct")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "unmark-entity-distinct")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("unmark-entity-distinct", merged, { postMcp });
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
    .option("--skill-version <semver>", "TestChimp skill version from SKILL.md frontmatter")
    .option("--cli-version <semver>", "CLI version (defaults to this package version)")
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
      if (opts.skillVersion) body.skillVersion = String(opts.skillVersion).trim();
      if (opts.cliVersion) body.cliVersion = String(opts.cliVersion).trim();
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
    "get-org-capabilities",
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

  program
    .command("get-plans-support-file")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-plans-support-file")!.description)
    .addOption(jsonInputOption())
    .option(
      "--file-path <path>",
      "path relative to mapped plans root (e.g. knowledge/workflow_plans/run-qa/<ulid>.plan.md)",
    )
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.filePath) body.filePath = String(opts.filePath);
      const merged = mergeBodies(body, opts.jsonInput) as Record<string, unknown>;
      if (!merged.filePath) {
        throw new Error("Provide --file-path (or full body via --json-input)");
      }
      console.log(await runTool("get-plans-support-file", merged, { postMcp }));
    });

  program
    .command("list-api-operation-services")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-api-operation-services")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      console.log(await runTool("list-api-operation-services", merged, { postMcp }));
    });

  program
    .command("list-api-operations")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-api-operations")!.description)
    .addOption(jsonInputOption())
    .option("--root-file-path <path>", "Repo-relative OpenAPI root path (preferred service resource id)")
    .option("--service-key <key>", "Internal service key alias")
    .option("--include-manual", "Include MANUAL test_mode coverage in previews")
    .option("--include-removed", "Include soft-deleted (REMOVED) operations")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.rootFilePath) body.rootFilePath = String(opts.rootFilePath);
      if (opts.serviceKey) body.serviceKey = String(opts.serviceKey);
      if (opts.includeManual) body.includeManual = true;
      if (opts.includeRemoved) body.includeRemoved = true;
      const merged = mergeBodies(body, opts.jsonInput);
      console.log(await runTool("list-api-operations", merged, { postMcp }));
    });

  program
    .command("get-api-operation-detail")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-api-operation-detail")!.description)
    .addOption(jsonInputOption())
    .option("--id <ulid>", "TestChimp operation id (ULID PK) — preferred")
    .option("--root-file-path <path>", "Repo-relative OpenAPI root path")
    .option("--service-key <key>", "Internal service key")
    .option("--oas-operation-id <id>", "OpenAPI operationId")
    .option("--http-method <method>", "HTTP method (with --path-template)")
    .option("--path-template <path>", "OpenAPI path template (with --http-method)")
    .option("--include-manual", "Include MANUAL test_mode coverage")
    .option("--include-removed", "Include soft-deleted schema fields / response codes")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.id) body.id = String(opts.id);
      if (opts.rootFilePath) body.rootFilePath = String(opts.rootFilePath);
      if (opts.serviceKey) body.serviceKey = String(opts.serviceKey);
      if (opts.oasOperationId) body.oasOperationId = String(opts.oasOperationId);
      if (opts.httpMethod) body.httpMethod = String(opts.httpMethod);
      if (opts.pathTemplate) body.pathTemplate = String(opts.pathTemplate);
      if (opts.includeManual) body.includeManual = true;
      if (opts.includeRemoved) body.includeRemoved = true;
      const merged = mergeBodies(body, opts.jsonInput);
      console.log(await runTool("get-api-operation-detail", merged, { postMcp }));
    });

  program
    .command("list-perf-runs")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-perf-runs")!.description)
    .addOption(jsonInputOption())
    .option("--testchimp-id <id>")
    .option("--kind <kind>", "JOURNEY | COMPOSITE")
    .option("--branch-name <name>")
    .option("--profile <name>")
    .option("--dataset <name>")
    .option("--llm-mode <mode>")
    .option("--environment <name>")
    .option("--limit <n>", "Maximum results", (v) => Number(v))
    .option("--offset <n>", "Pagination offset", (v) => Number(v))
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.testchimpId) body.testchimpId = String(opts.testchimpId);
      if (opts.kind) body.kind = String(opts.kind);
      if (opts.branchName) body.branchName = String(opts.branchName);
      if (opts.profile) body.profile = String(opts.profile);
      if (opts.dataset) body.dataset = String(opts.dataset);
      if (opts.llmMode) body.llmMode = String(opts.llmMode);
      if (opts.environment) body.environment = String(opts.environment);
      if (opts.limit != null) body.limit = opts.limit;
      if (opts.offset != null) body.offset = opts.offset;
      console.log(await runTool("list-perf-runs", mergeBodies(body, opts.jsonInput), { postMcp }));
    });

  program
    .command("get-perf-run")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-perf-run")!.description)
    .addOption(jsonInputOption())
    .option("--run-id <id>")
    .option("--include-raw", "Include the raw performance payload")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.runId) body.runId = String(opts.runId);
      if (opts.includeRaw) body.includeRaw = true;
      console.log(await runTool("get-perf-run", mergeBodies(body, opts.jsonInput), { postMcp }));
    });

  program
    .command("list-perf-baselines")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-perf-baselines")!.description)
    .addOption(jsonInputOption())
    .option("--testchimp-id <id>")
    .option("--limit <n>", "Maximum results", (v) => Number(v))
    .option("--offset <n>", "Pagination offset", (v) => Number(v))
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.testchimpId) body.testchimpId = String(opts.testchimpId);
      if (opts.limit != null) body.limit = opts.limit;
      if (opts.offset != null) body.offset = opts.offset;
      console.log(await runTool("list-perf-baselines", mergeBodies(body, opts.jsonInput), { postMcp }));
    });

  addAgentTraceabilityOptions(
    program
      .command("promote-perf-baseline")
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === "promote-perf-baseline")!.description)
      .addOption(jsonInputOption())
      .option("--run-id <id>")
      .option("--env-class <name>"),
  ).action(async (opts) => {
    const body: Record<string, unknown> = {
      ...collectAgentTraceabilityFlags(opts),
    };
    if (opts.runId) body.runId = String(opts.runId);
    if (opts.envClass) body.envClass = String(opts.envClass);
    console.log(await runTool("promote-perf-baseline", mergeBodies(body, opts.jsonInput), { postMcp }));
  });

  program
    .command("compare-perf-to-baseline")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "compare-perf-to-baseline")!.description)
    .addOption(jsonInputOption())
    .option("--run-id <id>")
    .option("--testchimp-id <id>")
    .option("--profile <name>")
    .option("--dataset <name>")
    .option("--llm-mode <mode>")
    .option("--environment <name>")
    .option("--env-class <name>", "Baseline environment class (required)")
    .option("--max-p95-regression-percent <n>", "Allowed p95 regression percent", (v) => Number(v))
    .option("--max-fail-rate-increase <n>", "Allowed fail-rate increase", (v) => Number(v))
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.runId) body.runId = String(opts.runId);
      if (opts.testchimpId) body.testchimpId = String(opts.testchimpId);
      if (opts.profile) body.profile = String(opts.profile);
      if (opts.dataset) body.dataset = String(opts.dataset);
      if (opts.llmMode) body.llmMode = String(opts.llmMode);
      if (opts.environment) body.environment = String(opts.environment);
      if (opts.envClass) body.envClass = String(opts.envClass);
      if (opts.maxP95RegressionPercent != null) {
        body.maxP95RegressionPercent = opts.maxP95RegressionPercent;
      }
      if (opts.maxFailRateIncrease != null) body.maxFailRateIncrease = opts.maxFailRateIncrease;
      const out = await runTool("compare-perf-to-baseline", mergeBodies(body, opts.jsonInput), { postMcp });
      // Always print response JSON; gate CI on regressed after stdout flush.
      console.log(out);
      try {
        if (isPerfComparisonRegressed(JSON.parse(out))) process.exitCode = 1;
      } catch {
        /* non-JSON responses still printed; leave exit 0 unless runTool threw */
      }
    });

  program
    .command("list-related-perf-tests")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-related-perf-tests")!.description)
    .addOption(jsonInputOption())
    .option("--scenario-titles <csv>", "Comma-separated scenario titles")
    .option("--testchimp-ids <csv>", "Comma-separated TestChimp ids")
    .option("--no-include-composites", "Exclude COMPOSITE tests")
    .option("--limit <n>", "Maximum results (max 100)", (v) => Number(v))
    .action(async (opts) => {
      const body: Record<string, unknown> = {
        includeComposites: opts.includeComposites,
      };
      if (opts.scenarioTitles) {
        body.scenarioTitles = String(opts.scenarioTitles).split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (opts.testchimpIds) {
        body.testchimpIds = String(opts.testchimpIds).split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (opts.limit != null) body.limit = opts.limit;
      console.log(await runTool("list-related-perf-tests", mergeBodies(body, opts.jsonInput), { postMcp }));
    });

  program
    .command("list-api-operation-interactions")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-api-operation-interactions")!.description)
    .addOption(jsonInputOption())
    .option("--test-id <id>")
    .option("--operation-id <id>")
    .option("--interaction-type <type>", "REAL | MOCKED", "REAL")
    .option("--limit <n>", "Maximum results (max 100)", (v) => Number(v))
    .action(async (opts) => {
      const body: Record<string, unknown> = {
        interactionType: opts.interactionType,
      };
      if (opts.testId) body.testId = String(opts.testId);
      if (opts.operationId) body.operationId = String(opts.operationId);
      if (opts.limit != null) body.limit = opts.limit;
      console.log(
        await runTool("list-api-operation-interactions", mergeBodies(body, opts.jsonInput), { postMcp }),
      );
    });

  program
    .command("send-feedback")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "send-feedback")!.description)
    .addOption(jsonInputOption())
    .option("--category <category>", "BUG | USER_STRUGGLE | FEATURE_REQUEST | DOCS_GAP | OTHER")
    .option("--message <text>", "What happened")
    .option("--context <text>", "What you were doing: workflow, command, error text, versions")
    .option("--agent-name <name>", "Agent / host, e.g. Cursor, Claude Code")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.category) body.category = String(opts.category).toUpperCase();
      if (opts.message) body.message = String(opts.message);
      if (opts.context) body.context = String(opts.context);
      if (opts.agentName) body.agentName = String(opts.agentName);
      console.log(await runTool("send-feedback", mergeBodies(body, opts.jsonInput), { postMcp }));
    });

  for (const kebab of ["get-qa-posture", "get-bot-compat"] as const) {
    program
      .command(kebab)
      .description(TOOL_DEFINITIONS.find((t) => t.kebab === kebab)!.description)
      .addOption(jsonInputOption())
      .action(async (opts) => {
        console.log(await runTool(kebab, mergeBodies({}, opts.jsonInput), { postMcp }));
      });
  }

  program
    .command("get-my-tasks")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-my-tasks")!.description)
    .addOption(jsonInputOption())
    .option("--user-id <id>", "Team member user id (required with an API key; OAuth tokens imply the user)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.userId) body.userId = String(opts.userId);
      console.log(await runTool("get-my-tasks", mergeBodies(body, opts.jsonInput), { postMcp }));
    });

  program
    .command("list-tests-awaiting-verification")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "list-tests-awaiting-verification")!.description)
    .addOption(jsonInputOption())
    .option("--user-id <id>", "Team member user id")
    .option("--limit <n>", "Maximum results", (v) => parseInt(v, 10))
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.userId) body.userId = String(opts.userId);
      if (opts.limit != null && !Number.isNaN(opts.limit)) body.limit = opts.limit;
      console.log(
        await runTool("list-tests-awaiting-verification", mergeBodies(body, opts.jsonInput), { postMcp }),
      );
    });

  program
    .command("get-bot-profile")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-bot-profile")!.description)
    .addOption(jsonInputOption())
    .option("--bot-id <id>", "Bot id (defaults to TESTCHIMP_BOT_ID / OAuth token)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.botId) body.botId = String(opts.botId);
      console.log(await runTool("get-bot-profile", mergeBodies(body, opts.jsonInput), { postMcp }));
    });

  const bot = program.command("bot").description("TestChimp QA-bot helpers (profile, event acks, compatibility)");
  bot
    .command("ack")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "ack-bot-events")!.description)
    .argument("<eventIds...>", "Event ids from the webhook delivery (max 100)")
    .option("--ack-url <url>", "Delivery ackUrl (default: TESTCHIMP_INGRESS_URL + /bot/events/ack)")
    .action(async (eventIds: string[], opts) => {
      const body: Record<string, unknown> = { eventIds };
      if (opts.ackUrl) body.ackUrl = String(opts.ackUrl);
      const out = await runTool("ack-bot-events", body, { postMcp, postIngress });
      let results: Array<{ eventId?: string; status?: string }> = [];
      try {
        const parsed = JSON.parse(out) as { results?: Array<{ eventId?: string; status?: string }> };
        results = Array.isArray(parsed.results) ? parsed.results : [];
      } catch {
        console.log(out);
        process.exitCode = 1;
        return;
      }
      let failed = results.length === 0;
      for (const r of results) {
        const status = String(r.status ?? "UNKNOWN");
        console.log(`${r.eventId ?? "?"}\t${status}`);
        if (BOT_ACK_FAILURE_STATUSES.has(status)) failed = true;
      }
      if (failed) process.exitCode = 1;
    });

  bot
    .command("register-profile")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "register-bot-profile")!.description)
    .addOption(jsonInputOption())
    .option("--bot-id <id>", "Bot id (defaults to TESTCHIMP_BOT_ID / OAuth token)")
    .option("--role <role>", "QA_LEAD | PM | QA_ENGINEER | DEVELOPER")
    .option("--responsibilities <text>", "Free-text responsibilities in the user's words")
    .option(
      "--capability <name>",
      "Capability (repeatable): REQUIREMENTS_UPDATE, E2E_AUTHORING, ISSUE_FIX, MANUAL_TEST_COORDINATION, TEST_BATCH_FIX, QA_POSTURE",
      (v: string, prev: string[] = []) => [...prev, ...v.split(",").map((s) => s.trim()).filter(Boolean)],
    )
    .option("--subscriptions-json <json>", "Subscriptions array JSON or @file: [{eventType, filters:[{field, op, value}]}]")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.botId) body.botId = String(opts.botId);
      if (opts.role) body.role = String(opts.role).trim().toUpperCase();
      if (opts.responsibilities != null) body.responsibilities = String(opts.responsibilities);
      if (opts.capability?.length) body.capabilities = (opts.capability as string[]).map((c) => c.toUpperCase());
      if (opts.subscriptionsJson) {
        const raw = String(opts.subscriptionsJson).trim();
        const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
        const parsed = JSON.parse(text) as unknown;
        body.subscriptions = Array.isArray(parsed)
          ? parsed
          : (parsed as { subscriptions?: unknown }).subscriptions ?? parsed;
      }
      console.log(await runTool("register-bot-profile", mergeBodies(body, opts.jsonInput), { postMcp }));
    });

  bot
    .command("get-profile")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-bot-profile")!.description)
    .addOption(jsonInputOption())
    .option("--bot-id <id>", "Bot id (defaults to TESTCHIMP_BOT_ID / OAuth token)")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.botId) body.botId = String(opts.botId);
      console.log(await runTool("get-bot-profile", mergeBodies(body, opts.jsonInput), { postMcp }));
    });

  bot
    .command("compat")
    .description("Check this CLI (and optionally the testchimp skill) against the deployment's minimum bot versions")
    .option("--skill-version <semver>", "Installed testchimp skill version (SKILL.md frontmatter) to check too")
    .action(async (opts) => {
      const out = await runTool("get-bot-compat", {}, { postMcp });
      const compat = JSON.parse(out) as { minSkillVersion?: string; minCliVersion?: string; eventSchemaVersion?: number };
      const cliUpgradeRequired = !!compat.minCliVersion && compareSemver(PACKAGE_VERSION, compat.minCliVersion) < 0;
      const skillVersion = opts.skillVersion ? String(opts.skillVersion).trim() : undefined;
      const skillUpgradeRequired =
        skillVersion != null && !!compat.minSkillVersion && compareSemver(skillVersion, compat.minSkillVersion) < 0;
      console.log(
        JSON.stringify(
          {
            ...compat,
            cliVersion: PACKAGE_VERSION,
            cliUpgradeRequired,
            ...(skillVersion != null ? { skillVersion, skillUpgradeRequired } : {}),
          },
          null,
          2,
        ),
      );
      if (cliUpgradeRequired) {
        console.error(
          `[testchimp] CLI ${PACKAGE_VERSION} is older than required ${compat.minCliVersion}; run: npm i -g @testchimp/cli@latest`,
        );
      } else {
        console.error(`[testchimp] CLI ${PACKAGE_VERSION} meets minimum ${compat.minCliVersion ?? "(none)"}; no upgrade required.`);
      }
      if (skillUpgradeRequired) {
        console.error(
          `[testchimp] testchimp skill ${skillVersion} is older than required ${compat.minSkillVersion}; reinstall the skill.`,
        );
      }
    });

  bot
    .command("connect")
    .description(
      "Store this user's id, PAT and the project API key for headless AgentWatch (no TestChimp Studio needed): browser sign-in (OAuth), or --pair / --finish-pair approved by your QA bot",
    )
    .option("--project-id <id>", "Fail unless the project approved on the consent page is this one")
    .option("--port <n>", "Loopback port for the OAuth redirect (default: a free port)")
    .option("--no-browser", "Only print the approval URL")
    .option("--timeout-ms <n>", "How long to wait for approval (default 300000; 60000 with --finish-pair)")
    .option(
      "--pair",
      "No browser: print a pairing code for your QA bot to approve (approve-agentwatch-pairing), then run --finish-pair",
    )
    .option("--finish-pair", "Store the credentials once the QA bot has approved the pairing code from --pair")
    .action(async (opts) => {
      const { connectAgentWatch, ingressUrlForBackend } = await import("../agentwatch/connect.js");
      const { getBackendUrl, getIngressUrl } = await import("../core/client.js");
      try {
        const backendUrl = getBackendUrl();
        const ingressUrl = process.env.TESTCHIMP_INGRESS_URL?.trim() ? getIngressUrl() : ingressUrlForBackend(backendUrl);
        const expectedProjectId = opts.projectId ? String(opts.projectId).trim() : undefined;
        if (opts.pair && opts.finishPair) throw new Error("Use either --pair or --finish-pair, not both");
        if (opts.pair) {
          const { startAgentWatchPairing } = await import("../agentwatch/pairing.js");
          const started = startAgentWatchPairing({ backendUrl, ingressUrl, expectedProjectId });
          stderrProgress(
            "Ask your QA bot to approve this pairing code (approve-agentwatch-pairing), then run: testchimp bot connect --finish-pair",
          );
          console.log(JSON.stringify(started, null, 2));
          return;
        }
        let result;
        if (opts.finishPair) {
          const { finishAgentWatchPairing } = await import("../agentwatch/pairing.js");
          result = await finishAgentWatchPairing({
            backendUrl,
            timeoutMs: opts.timeoutMs != null ? Number(opts.timeoutMs) : undefined,
          });
        } else {
          result = await connectAgentWatch({
            backendUrl,
            ingressUrl,
            expectedProjectId,
            port: opts.port != null ? Number(opts.port) : undefined,
            timeoutMs: opts.timeoutMs != null ? Number(opts.timeoutMs) : undefined,
            openUrl: opts.browser === false ? () => undefined : undefined,
            log: stderrProgress,
          });
        }
        stderrProgress(
          `Saved AgentWatch credentials for project ${result.projectId} in ${result.credentialsPath}` +
            (result.botId ? `; set TESTCHIMP_BOT_ID=${result.botId} for this bot` : ""),
        );
        console.log(JSON.stringify(result, null, 2));
      } catch (e: unknown) {
        console.error(`[testchimp bot connect] ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
    });

  bot
    .command("approve-pairing")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "approve-agentwatch-pairing")!.description)
    .argument("<pairingCode>", "Code printed by testchimp bot connect --pair on the user's computer")
    .action(async (pairingCode: string) => {
      console.log(await runTool("approve-agentwatch-pairing", { pairingCode }, { postMcp }));
    });

  bot
    .command("disconnect")
    .description("Remove the stored AgentWatch credentials for a project")
    .requiredOption("--project-id <id>", "TestChimp project id")
    .action(async (opts) => {
      const { removeProjectCredentials, agentwatchCredentialsPath } = await import("../agentwatch/credentialsFile.js");
      const projectId = String(opts.projectId).trim();
      const removed = removeProjectCredentials(projectId);
      console.log(JSON.stringify({ projectId, removed, credentialsPath: agentwatchCredentialsPath() }));
    });

  const workspace = program
    .command("workspace")
    .description("Per-user local folder ↔ TestChimp project mapping (~/.testchimp/projects.json, shared with TestChimp Studio)");
  workspace
    .command("map")
    .description("Map a local git repo folder to a TestChimp project (same rules as Studio folder mapping)")
    .requiredOption("--project-id <id>", "TestChimp project id")
    .requiredOption("--folder <path>", "Local repository folder (must be a git repo)")
    .option("--project-name <name>", "Project display name stored with the mapping")
    .option("--reassign", "Move the folder from another project's mapping to this project")
    .option("--skip-repo-check", "Do not compare the git remote with the project's connected repository")
    .action(async (opts) => {
      const { upsertWorkspaceFolder, projectsRegistryPath } = await import("../workspace/projectsRegistry.js");
      const { assertFolderMatchesRepo, inspectLocalGitRepo } = await import("../workspace/gitRepo.js");
      const projectId = String(opts.projectId).trim();
      try {
        if (!projectId) throw new Error("INVALID_PAYLOAD: --project-id");
        const inspection = inspectLocalGitRepo(String(opts.folder));
        let expectedRepo: string | null = null;
        if (opts.skipRepoCheck) {
          stderrProgress("Skipping connected-repository check (--skip-repo-check).");
        } else if (!process.env.TESTCHIMP_API_KEY?.trim() && !process.env.TESTCHIMP_OAUTH_TOKEN?.trim()) {
          stderrProgress("No TESTCHIMP_API_KEY / TESTCHIMP_OAUTH_TOKEN set; skipping connected-repository check.");
        } else {
          try {
            const out = await runTool("get-git-folder-mapping", {}, { postMcp });
            const parsed = JSON.parse(out) as { repositoryFullName?: string };
            expectedRepo = parsed.repositoryFullName?.trim() || null;
            if (!expectedRepo) stderrProgress("Project has no connected repository; skipping remote check.");
          } catch (e: unknown) {
            stderrProgress(`Could not load the project's connected repository (${e instanceof Error ? e.message : String(e)}); skipping remote check.`);
          }
        }
        assertFolderMatchesRepo(inspection, expectedRepo);
        const mapping = upsertWorkspaceFolder({
          projectId,
          projectName: opts.projectName != null ? String(opts.projectName).trim() || undefined : undefined,
          rootPath: inspection.selectedPath,
          reassign: opts.reassign === true,
        });
        stderrProgress(`Mapped ${inspection.selectedPath} → project ${projectId} in ${projectsRegistryPath()}`);
        console.log(JSON.stringify(mapping, null, 2));
      } catch (e: unknown) {
        console.error(`[testchimp workspace map] ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
    });
  workspace
    .command("get")
    .description("Print the folder mapping JSON for a project (exit 1 when unmapped)")
    .requiredOption("--project-id <id>", "TestChimp project id")
    .action(async (opts) => {
      const { findWorkspaceMapping } = await import("../workspace/projectsRegistry.js");
      try {
        const mapping = findWorkspaceMapping(String(opts.projectId).trim());
        if (!mapping) {
          console.error(`[testchimp workspace get] project ${opts.projectId} is not mapped to a local folder; run: testchimp workspace map --project-id ${opts.projectId} --folder <path>`);
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(mapping, null, 2));
      } catch (e: unknown) {
        console.error(`[testchimp workspace get] ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
    });

  const chimphands = program.command("chimphands").description("ChimpHands GitHub Actions agent bridge");
  chimphands
    .command("report-branch")
    .description("Report the conversation working branch (and optional PR URL) to TestChimp")
    .requiredOption("--branch <name>", "Agent feature branch name (testchimp-* only)")
    .option("--pr-url <url>", "Open pull request URL")
    .option("--session-id <id>", "ChimpHands session id (or SESSION_ID env)")
    .action(async (opts) => {
      const { reportWorkingBranch } = await import("../chimphands/run.js");
      try {
        await reportWorkingBranch({
          sessionId: String(opts.sessionId || process.env.SESSION_ID || "").trim(),
          branch: String(opts.branch || "").trim(),
          pullRequestUrl: opts.prUrl != null ? String(opts.prUrl).trim() : undefined,
        });
        console.log(JSON.stringify({ ok: true }));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[testchimp chimphands report-branch] ${msg}`);
        process.exit(1);
      }
    });

  chimphands
    .command("refresh-git-auth")
    .description(
      "Remint a short-lived GitHub App installation token and apply it for git/gh (never prints the token)",
    )
    .action(async () => {
      const { refreshGitAuth } = await import("../chimphands/refreshGitAuth.js");
      try {
        const result = await refreshGitAuth();
        console.log(JSON.stringify(result));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[testchimp chimphands refresh-git-auth] ${msg}`);
        process.exit(1);
      }
    });

  chimphands
    .command("run")
    .description("Bootstrap session, configure OpenCode, and run the interactive bridge")
    .option("--session-id <id>", "ChimpHands session id (or SESSION_ID env)")
    .option("--prompt <text>", "Initial prompt (or PROMPT env)")
    .option("--attach <url>", "Attach to OpenCode server (e.g. http://127.0.0.1:4096)")
    .action(async (opts) => {
      const { runChimphands } = await import("../chimphands/run.js");
      try {
        await runChimphands({
          sessionId: String(opts.sessionId || process.env.SESSION_ID || "").trim(),
          prompt: opts.prompt != null ? String(opts.prompt) : undefined,
          attachUrl: opts.attach != null ? String(opts.attach).trim() : undefined,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[testchimp chimphands] ${msg}`);
        process.exit(1);
      }
    });

  chimphands
    .command("serve")
    .description("Register ChimpHands Runtime, attach to OpenCode server, run session bridge + UI tunnel")
    .option("--session-id <id>", "ChimpHands session id (or SESSION_ID env)")
    .option("--prompt <text>", "Initial prompt (or PROMPT env)")
    .requiredOption("--attach <url>", "OpenCode server URL (e.g. http://127.0.0.1:4096)")
    .action(async (opts) => {
      const { serveChimphands } = await import("../chimphands/run.js");
      try {
        await serveChimphands({
          sessionId: String(opts.sessionId || process.env.SESSION_ID || "").trim(),
          prompt: opts.prompt != null ? String(opts.prompt) : undefined,
          attachUrl: String(opts.attach || "").trim(),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[testchimp chimphands serve] ${msg}`);
        process.exit(1);
      }
    });

  program.on("--help", () => {
    /* default */
  });

  program.addHelpText(
    "after",
    `\nEnvironment:\n  TESTCHIMP_API_KEY          required unless TESTCHIMP_OAUTH_TOKEN is set\n  TESTCHIMP_OAUTH_TOKEN      optional OAuth access token (sent as Authorization: Bearer)\n  TESTCHIMP_BOT_ID           optional QA bot id (sent as bot-id header)\n  TESTCHIMP_BACKEND_URL      optional (default ${DEFAULT_BACKEND})\n  TESTCHIMP_INGRESS_URL      optional (default ${DEFAULT_INGRESS})\n  TESTCHIMP_HOME             optional Studio/CLI home for workspace mappings (default ~/.testchimp)\n\nOutput:\n  Response JSON on stdout.\n  provision-ephemeral-environment-and-wait progress on stderr.\n\nAdvanced:\n  --json-input merges a JSON object over flags (JSON wins on key conflicts). Use @file.json to read from disk.\n`
  );

  return program;
}
