import { createRequire } from "node:module";
import { PACKAGE_VERSION } from "../core/version.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as {
  mcpName?: string;
  homepage?: string;
  repository?: { url?: string };
};

/** SEP-2127 media type for MCP Server Cards. */
export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";

/** AI Catalog media type (Agent-Card / SEP-2127 discovery). */
export const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";

const SERVER_NAME = pkg.mcpName?.trim() || "io.testchimp/qa";
const WEBSITE_URL = "https://testchimp.io";
/** Keep ≤100 chars (Server Card schema). Matches server.json. */
const DESCRIPTION =
  "QA platform for agents: coverage signals, in-repo test plans, verified tests and release governance.";

function githubBrowseUrl(gitUrl: string | undefined): string | undefined {
  if (!gitUrl) return undefined;
  const m = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i.exec(gitUrl.trim());
  return m ? `https://github.com/${m[1]}` : undefined;
}

/**
 * Static MCP Server Card for pre-connection discovery (SEP-2127).
 * Served at GET {mcpBase}/server-card with no auth.
 */
export function buildServerCard(mcpEndpointUrl: string): Record<string, unknown> {
  const endpoint = mcpEndpointUrl.replace(/\/+$/, "");
  const repoUrl = githubBrowseUrl(pkg.repository?.url);
  const card: Record<string, unknown> = {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: SERVER_NAME,
    version: PACKAGE_VERSION,
    description: DESCRIPTION,
    title: "TestChimp",
    websiteUrl: WEBSITE_URL,
    remotes: [
      {
        type: "streamable-http",
        url: endpoint,
      },
    ],
  };
  if (repoUrl) {
    card.repository = { url: repoUrl, source: "github" };
  }
  return card;
}

/** Domain AI Catalog entry pointing at the hosted Server Card. */
export function buildAiCatalog(serverCardUrl: string): Record<string, unknown> {
  return {
    specVersion: "1.0",
    entries: [
      {
        identifier: "urn:air:testchimp.io:mcp:qa",
        type: SERVER_CARD_MEDIA_TYPE,
        url: serverCardUrl,
      },
    ],
  };
}
