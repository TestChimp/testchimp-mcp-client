import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { postMcp } from "../core/client.js";
import { TOOL_DEFINITIONS, runTool } from "../core/tools.js";

const PACKAGE_VERSION = "0.1.7";

function textResult(json: string) {
  return {
    content: [{ type: "text" as const, text: json }],
  };
}

export async function runMcpServer(): Promise<void> {
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
          onProgress,
        });
        return textResult(json);
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
