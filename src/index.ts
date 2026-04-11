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
      "TESTCHIMP_API_KEY is required. Set it in the MCP server env (e.g. Cursor mcp.json)."
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

const testAdviceInput = z.object({
  branchName: z.string().optional(),
  prUrl: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
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
    "get_test_advice",
    {
      description:
        "Placeholder for PR-scoped test advice. Returns not_implemented until the backend provides analysis.",
      inputSchema: testAdviceInput,
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.branchName != null && args.branchName.trim() !== "") {
        body.branchName = args.branchName.trim();
      }
      if (args.prUrl != null) body.pr_url = args.prUrl;
      if (args.baseSha != null) body.base_sha = args.baseSha;
      if (args.headSha != null) body.head_sha = args.headSha;
      const json = await postMcp("/api/mcp/get_test_advice", body);
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
