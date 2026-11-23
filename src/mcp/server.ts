import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodTypeAny } from "zod";
import { currentRequestAuth, isValidProjectId, postIngress, postMcp, runWithRequestAuth } from "../core/client.js";
import { annotationsForTool } from "../core/toolAnnotations.js";
import { TOOL_DEFINITIONS, runTool } from "../core/tools.js";
import { PACKAGE_VERSION } from "../core/version.js";

function textResult(json: string) {
  return {
    content: [{ type: "text" as const, text: json }],
  };
}

export interface CreateMcpServerOptions {
  /**
   * Remote MCP: every tool also takes `projectId`, `projectApiKey` and `botId`. Hosts share one connector
   * (one OAuth token, the user's) across all of a user's repos and QA bots, so a repo names its project with
   * `projectId` (from its .testchimp/creds.json) and each bot with its own key.
   */
  bindingArgs?: boolean;
}

/**
 * Tools that write the caller's laptop. Hosted mcp.testchimp.io cannot do that, so they are omitted
 * from HTTP tools/list (annotation tests still require a TOOL_DEFINITIONS entry). Hosted / plugin
 * agents should call get-project-credentials and write `.testchimp/creds.json` with a file-write tool.
 */
export const HOSTED_OMITTED_TOOLS: ReadonlySet<string> = new Set(["save-workspace-creds"]);

export const BINDING_ARGS = {
  projectId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "The TestChimp project this repo belongs to: projectId from the repo's .testchimp/creds.json. Pass it on " +
        "every call when working in a repo. Not a secret."
    ),
  projectApiKey: z
    .string()
    .trim()
    .min(8)
    .max(256)
    .optional()
    .describe(
      "Project API key. QA bots: required on every call except get-bot-credentials, get-project-credentials " +
        "and get-bot-compat. Others: only to look up a repo's projectId via get-project-credentials when its " +
        "creds file has a key but no projectId. Prefer projectId. Never print it."
    ),
  botId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe("QA bots: your botId from your stored TestChimp binding."),
};

/** The tool's schema plus the binding arguments, when it is an object schema. */
function withBindingArgs(schema: ZodTypeAny): ZodTypeAny {
  if (!(schema instanceof z.ZodObject)) return schema;
  return schema.safeExtend(BINDING_ARGS);
}

/** Splits the binding arguments off a tool call's arguments. */
export function splitBindingArgs(args: Record<string, unknown>): {
  toolArgs: Record<string, unknown>;
  projectApiKey?: string;
  projectId?: string;
  botId?: string;
} {
  const { projectApiKey, projectId, botId, ...toolArgs } = args;
  const key = typeof projectApiKey === "string" && projectApiKey.trim() ? projectApiKey.trim() : undefined;
  const project = typeof projectId === "string" && projectId.trim() ? projectId.trim() : undefined;
  const bot = typeof botId === "string" && botId.trim() ? botId.trim() : undefined;
  return { toolArgs, projectApiKey: key, projectId: project, botId: bot };
}

/** McpServer with every TestChimp tool registered (shared by stdio and HTTP transports). */
export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "testchimp", version: PACKAGE_VERSION },
    { capabilities: { tools: {}, logging: {} } }
  );

  for (const def of TOOL_DEFINITIONS) {
    if (options.bindingArgs && HOSTED_OMITTED_TOOLS.has(def.kebab)) continue;
    const annotations = annotationsForTool(def.kebab);
    server.registerTool(
      def.kebab,
      {
        title: annotations.title,
        description: def.description,
        inputSchema: options.bindingArgs ? withBindingArgs(def.inputSchema) : def.inputSchema,
        annotations,
      },
      async (args) => {
        const onProgress =
          def.kebab === "ephemeral-environment"
            ? async (message: string) => {
                try {
                  await server.sendLoggingMessage({ level: "info", data: message });
                } catch {
                  /* ignore */
                }
              }
            : undefined;
        const raw = (args ?? {}) as Record<string, unknown>;
        const auth = currentRequestAuth();
        if (!options.bindingArgs || !auth) {
          return textResult(await runTool(def.kebab, raw, { postMcp, postIngress, onProgress }));
        }
        const { toolArgs, projectApiKey, projectId, botId } = splitBindingArgs(raw);
        if (projectId !== undefined && !isValidProjectId(projectId)) {
          throw new Error("Invalid projectId argument: use the projectId from the repo's .testchimp/creds.json");
        }
        const json = await runWithRequestAuth(
          { ...auth, projectApiKey, projectId: projectId ?? auth.projectId, botId: botId ?? auth.botId },
          () => runTool(def.kebab, toolArgs, { postMcp, postIngress, onProgress })
        );
        return textResult(json);
      }
    );
  }
  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
