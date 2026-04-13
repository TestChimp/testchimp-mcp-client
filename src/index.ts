#!/usr/bin/env node
/**
 * TestChimp MCP server — calls TestChimp /api/mcp/* with TestChimp-Api-Key only.
 * Env: TESTCHIMP_BACKEND_URL (optional), TESTCHIMP_API_KEY (required).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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

const provisionEphemeralInput = z.object({
  /** Git branch to deploy; omit to use the repo default branch. */
  branchName: z.string().optional(),
});

const bnsEnvironmentIdInput = z.object({
  /** BunnyShell environment id returned from provision_ephemeral_environment. */
  bnsEnvironmentId: z.string().min(1),
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
    { name: "testchimp-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
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
    "provision_ephemeral_environment",
    {
      description:
        "Create a BunnyShell ephemeral environment for the TestChimp project from the configured Git repo + YAML path. " +
        "Requires BunnyShell + GitHub integration in project settings. Poll with get_ephemeral_environment_status using bnsEnvironmentId.",
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
        "Poll BunnyShell for environment status and definition. When deployed, environmentSpec may contain URLs/components JSON.",
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
