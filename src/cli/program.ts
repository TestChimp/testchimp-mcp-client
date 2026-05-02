import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DEFAULT_BACKEND, postMcp } from "../core/client.js";
import { deepMerge } from "../core/merge.js";
import { runTool } from "../core/tools.js";
import { TOOL_DEFINITIONS } from "../core/tools.js";

export const PACKAGE_VERSION = "0.1.4";

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

  program
    .command("get-requirement-coverage")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-requirement-coverage")!.description)
    .addOption(jsonInputOption())
    .option("--release <s>")
    .option("--environment <s>")
    .option("--branch-name <s>")
    .option("--file-paths <csv>", "comma-separated paths under platform tests root")
    .option("--folder-path <path>", "folder under tests root, slash-separated")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.release) body.release = opts.release;
      if (opts.environment) body.environment = opts.environment;
      if (opts.branchName) body.branchName = opts.branchName;
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
    .option("--file-paths <csv>")
    .option("--folder-path <path>")
    .action(async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts.release) body.release = opts.release;
      if (opts.environment) body.environment = opts.environment;
      if (opts.branchName) body.branchName = opts.branchName;
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

  program
    .command("create-user-story")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "create-user-story")!.description)
    .addOption(jsonInputOption())
    .requiredOption("--platform-file-path <path>")
    .requiredOption("--title <title>")
    .action(async (opts) => {
      const body = { platformFilePath: opts.platformFilePath, title: opts.title };
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("create-user-story", merged, { postMcp });
      console.log(out);
    });

  program
    .command("create-test-scenario")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "create-test-scenario")!.description)
    .addOption(jsonInputOption())
    .requiredOption("--platform-file-path <path>")
    .requiredOption("--title <title>")
    .requiredOption("--user-story-ordinal-id <n>")
    .action(async (opts) => {
      const body = {
        platformFilePath: opts.platformFilePath,
        title: opts.title,
        userStoryOrdinalId: Number(opts.userStoryOrdinalId),
      };
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("create-test-scenario", merged, { postMcp });
      console.log(out);
    });

  program
    .command("update-user-story")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "update-user-story")!.description)
    .addOption(jsonInputOption())
    .option("--content <markdown>", "full markdown including frontmatter")
    .option("--content-file <path>", "read markdown from file")
    .action(async (opts) => {
      let content = opts.content as string | undefined;
      if (opts.contentFile) content = await readFile(String(opts.contentFile), "utf8");
      if (!content) throw new Error("Provide --content or --content-file (or full body via --json-input)");
      const body = { content };
      const merged = mergeBodies(body, opts.jsonInput);
      const out = await runTool("update-user-story", merged, { postMcp });
      console.log(out);
    });

  program
    .command("update-test-scenario")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "update-test-scenario")!.description)
    .addOption(jsonInputOption())
    .option("--content <markdown>")
    .option("--content-file <path>")
    .action(async (opts) => {
      let content = opts.content as string | undefined;
      if (opts.contentFile) content = await readFile(String(opts.contentFile), "utf8");
      if (!content) throw new Error("Provide --content or --content-file (or full body via --json-input)");
      const body = { content };
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

  const truecoverageHelp =
    "Prefer --json-input with full request JSON (proto-shaped). Flags are optional shortcuts where listed.";

  program
    .command("get-truecoverage-events")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-events")!.description + " " + truecoverageHelp)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("get-truecoverage-events", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-truecoverage-event-details")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-event-details")!.description + " " + truecoverageHelp)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("get-truecoverage-event-details", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-truecoverage-child-event-tree")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-child-event-tree")!.description + " " + truecoverageHelp)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("get-truecoverage-child-event-tree", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-truecoverage-event-transition")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-event-transition")!.description + " " + truecoverageHelp)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("get-truecoverage-event-transition", merged, { postMcp });
      console.log(out);
    });

  program
    .command("get-truecoverage-event-time-series")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "get-truecoverage-event-time-series")!.description + " " + truecoverageHelp)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
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
    .requiredOption("--event-title <title>")
    .action(async (opts) => {
      const body = { eventTitle: opts.eventTitle };
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
    .command("upsert-screen-states")
    .description(TOOL_DEFINITIONS.find((t) => t.kebab === "upsert-screen-states")!.description)
    .addOption(jsonInputOption())
    .action(async (opts) => {
      const merged = mergeBodies({}, opts.jsonInput);
      const out = await runTool("upsert-screen-states", merged, { postMcp });
      console.log(out);
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
