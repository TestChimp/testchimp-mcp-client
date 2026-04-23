#!/usr/bin/env node
/**
 * Back-compat entry: same as `testchimp mcp` for users/scripts that invoke the MCP binary directly.
 */
import { runMcpServer } from "../mcp/server.js";

runMcpServer().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
