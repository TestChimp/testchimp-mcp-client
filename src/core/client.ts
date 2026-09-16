/** HTTP client for TestChimp MCP proxy APIs. */

export const DEFAULT_BACKEND = "https://featureservice.testchimp.io";

function isTestChimpSaasFeatureservice(hostname: string): boolean {
  return hostname === "featureservice.testchimp.io"
    || /^featureservice-[a-z0-9-]+\.testchimp\.io$/i.test(hostname);
}

export function getBackendUrl(): string {
  const raw = process.env.TESTCHIMP_BACKEND_URL?.trim();
  if (!raw) return DEFAULT_BACKEND;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `TESTCHIMP_BACKEND_URL must be an absolute http(s) URL; received ${JSON.stringify(raw)}`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `TESTCHIMP_BACKEND_URL must use http or https; received ${parsed.protocol}`
    );
  }
  if (parsed.protocol === "http:" && isTestChimpSaasFeatureservice(parsed.hostname)) {
    throw new Error(
      `TESTCHIMP_BACKEND_URL must use https for TestChimp SaaS; change it to https://${parsed.host}`
    );
  }
  return raw.replace(/\/+$/, "");
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
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      "TestChimp-Api-Key": apiKey,
    },
    body: JSON.stringify(body ?? {}),
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    const destination = location ? ` to ${location}` : "";
    throw new Error(
      `TestChimp API redirected ${res.status}${destination}. Refusing to follow because an HTTP redirect may rewrite POST to GET; set TESTCHIMP_BACKEND_URL to the final HTTPS featureservice URL.`
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TestChimp API ${res.status} ${res.statusText}: ${text}`);
  }
  return text;
}

export type PostMcpFn = (path: string, body: unknown) => Promise<string>;
