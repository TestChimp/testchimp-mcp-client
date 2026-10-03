import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { postIngress, postMcp } from "../core/client.js";
import { TOOL_DEFINITIONS, runTool } from "../core/tools.js";
import { PACKAGE_VERSION } from "../core/version.js";

function textResult(json: string) {
  return {
    content: [{ type: "text" as const, text: json }],
  };
}

/** McpServer with every TestChimp tool registered (shared by stdio and HTTP transports). */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "testchimp", version: PACKAGE_VERSION },
    { capabilities: { tools: {}, logging: {} } }
  );

  for (const def of TOOL_DEFINITIONS) {
    server.registerTool(
      def.kebab,
      {
        description: def.description,
        inputSchema: def.inputSchema,
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
        const json = await runTool(def.kebab, args ?? {}, {
          postMcp,
          postIngress,
          onProgress,
        });
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
