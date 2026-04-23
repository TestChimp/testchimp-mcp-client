/** HTTP client for TestChimp MCP proxy APIs. */

export const DEFAULT_BACKEND = "https://featureservice.testchimp.io";

export function getBackendUrl(): string {
  const raw = process.env.TESTCHIMP_BACKEND_URL?.trim();
  if (!raw) return DEFAULT_BACKEND;
  return raw.replace(/\/$/, "");
}

export function requireApiKey(): string {
  const k = process.env.TESTCHIMP_API_KEY?.trim();
  if (!k) {
    throw new Error(
      "TESTCHIMP_API_KEY is required. Set it in your project MCP config env (e.g. Cursor .cursor/mcp.json), then export it in the shell for CLI, or rely on the IDE for MCP."
    );
  }
  return k;
}

export async function postMcp(path: string, body: unknown): Promise<string> {
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

export type PostMcpFn = (path: string, body: unknown) => Promise<string>;
