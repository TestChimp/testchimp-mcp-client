import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodTypeAny } from "zod";
import { currentRequestAuth, postIngress, postMcp, runWithRequestAuth } from "../core/client.js";
import { TOOL_DEFINITIONS, runTool } from "../core/tools.js";
import { PACKAGE_VERSION } from "../core/version.js";

function textResult(json: string) {
  return {
    content: [{ type: "text" as const, text: json }],
  };
}

export interface CreateMcpServerOptions {
  /**
   * Remote MCP: every tool also takes `projectApiKey` and `botId`. Hosts share one connector (one OAuth
   * token, the user's) across all of a user's QA bots, so each bot names its project with its own key.
   */
  bindingArgs?: boolean;
}

export const BINDING_ARGS = {
  projectApiKey: z
    .string()
    .trim()
    .min(8)
    .max(256)
    .optional()
    .describe(
      "QA bots: your own project API key from your stored TestChimp binding. Required on every call except " +
        "get-bot-credentials, get-project-credentials and get-bot-compat. Never print it."
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
  botId?: string;
} {
  const { projectApiKey, botId, ...toolArgs } = args;
  const key = typeof projectApiKey === "string" && projectApiKey.trim() ? projectApiKey.trim() : undefined;
  const bot = typeof botId === "string" && botId.trim() ? botId.trim() : undefined;
  return { toolArgs, projectApiKey: key, botId: bot };
}

/** McpServer with every TestChimp tool registered (shared by stdio and HTTP transports). */
export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "testchimp", version: PACKAGE_VERSION },
    { capabilities: { tools: {}, logging: {} } }
  );

  for (const def of TOOL_DEFINITIONS) {
    server.registerTool(
      def.kebab,
      {
        description: def.description,
        inputSchema: options.bindingArgs ? withBindingArgs(def.inputSchema) : def.inputSchema,
      },
      async (args) => {
        const onProgress =
          def.kebab === "provision-ephemeral-environment-and-wait"
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
        const { toolArgs, projectApiKey, botId } = splitBindingArgs(raw);
        const json = await runWithRequestAuth({ ...auth, projectApiKey, botId: botId ?? auth.botId }, () =>
          runTool(def.kebab, toolArgs, { postMcp, postIngress, onProgress })
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
