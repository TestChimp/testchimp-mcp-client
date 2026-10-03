/** HTTP client for TestChimp MCP proxy APIs. */

import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_BACKEND = "https://featureservice.testchimp.io";
export const DEFAULT_INGRESS = "https://ingress.testchimp.io";

function isTestChimpSaasFeatureservice(hostname: string): boolean {
  return hostname === "featureservice.testchimp.io"
    || /^featureservice-[a-z0-9-]+\.testchimp\.io$/i.test(hostname);
}

function isTestChimpSaasIngress(hostname: string): boolean {
  return hostname === "ingress.testchimp.io"
    || /^ingress-[a-z0-9-]+\.testchimp\.io$/i.test(hostname);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
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

export function getIngressUrl(): string {
  const raw = process.env.TESTCHIMP_INGRESS_URL?.trim();
  if (!raw) return DEFAULT_INGRESS;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `TESTCHIMP_INGRESS_URL must be an absolute http(s) URL; received ${JSON.stringify(raw)}`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`TESTCHIMP_INGRESS_URL must use http or https; received ${parsed.protocol}`);
  }
  if (parsed.protocol === "http:" && isTestChimpSaasIngress(parsed.hostname)) {
    throw new Error(
      `TESTCHIMP_INGRESS_URL must use https for TestChimp SaaS; change it to https://${parsed.host}`
    );
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Validate an explicit absolute ingress URL (e.g. webhook `ackUrl`). Credentials are attached, so only
 * https (or http on loopback) to the configured ingress host or a TestChimp SaaS host is allowed.
 */
export function resolveIngressTargetUrl(absoluteUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(absoluteUrl.trim());
  } catch {
    throw new Error(`Invalid ingress URL ${JSON.stringify(absoluteUrl)}; expected an absolute https URL`);
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(
      `Ingress URL must use https (http is only allowed for localhost / 127.0.0.1); received ${parsed.protocol}//${parsed.host}`
    );
  }
  const configuredHost = new URL(getIngressUrl()).hostname;
  const trustedHost = loopback
    || parsed.hostname === configuredHost
    || parsed.hostname === "testchimp.io"
    || parsed.hostname.endsWith(".testchimp.io");
  if (!trustedHost) {
    throw new Error(
      `Refusing to send credentials to untrusted ingress host ${parsed.hostname}; set TESTCHIMP_INGRESS_URL to your TestChimp ingress URL`
    );
  }
  return parsed.toString();
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

/**
 * Per-request caller credentials (remote MCP over HTTP). When `isolated` is true the process env
 * credentials (TESTCHIMP_API_KEY / TESTCHIMP_OAUTH_TOKEN / TESTCHIMP_BOT_ID) are never used.
 */
export interface RequestAuth {
  bearerToken?: string;
  botId?: string;
  isolated: boolean;
}

const requestAuthStorage = new AsyncLocalStorage<RequestAuth>();

export function runWithRequestAuth<T>(auth: RequestAuth, fn: () => T): T {
  return requestAuthStorage.run(auth, fn);
}

const BOT_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;

/** 1..64 printable ASCII characters, no spaces or control characters. */
export function isValidBotId(value: string): boolean {
  return BOT_ID_PATTERN.test(value);
}

let warnedInvalidBotId = false;

/** Test hook: allow the once-per-process TESTCHIMP_BOT_ID warning to fire again. */
export function resetClientWarningsForTests(): void {
  warnedInvalidBotId = false;
}

function envBotId(): string | undefined {
  const raw = process.env.TESTCHIMP_BOT_ID;
  if (raw == null || raw === "") return undefined;
  if (isValidBotId(raw)) return raw;
  if (!warnedInvalidBotId) {
    warnedInvalidBotId = true;
    console.error(
      "[testchimp] Ignoring TESTCHIMP_BOT_ID: must be 1-64 printable ASCII characters without spaces; bot-id header not sent."
    );
  }
  return undefined;
}

/** Headers for featureservice / ingress calls. API-key-only callers get exactly the legacy header set. */
export function buildRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const requestAuth = requestAuthStorage.getStore();
  if (requestAuth?.isolated) {
    if (!requestAuth.bearerToken) {
      throw new Error("Authorization: Bearer token is required for remote TestChimp MCP requests.");
    }
    headers.Authorization = `Bearer ${requestAuth.bearerToken}`;
    if (requestAuth.botId && isValidBotId(requestAuth.botId)) headers["bot-id"] = requestAuth.botId;
    return headers;
  }

  const bearer = requestAuth?.bearerToken || process.env.TESTCHIMP_OAUTH_TOKEN?.trim();
  const apiKey = process.env.TESTCHIMP_API_KEY?.trim();
  if (!bearer) {
    headers["TestChimp-Api-Key"] = requireApiKey();
  } else {
    if (apiKey) headers["TestChimp-Api-Key"] = apiKey;
    headers.Authorization = `Bearer ${bearer}`;
  }
  const botId = requestAuth?.botId && isValidBotId(requestAuth.botId) ? requestAuth.botId : envBotId();
  if (botId) headers["bot-id"] = botId;
  return headers;
}

/** Non-2xx TestChimp API response (message format matches the historical client errors). */
export class TestChimpHttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    readonly body: string,
  ) {
    super(`TestChimp API ${status} ${statusText}: ${body}`);
    this.name = "TestChimpHttpError";
  }
}

async function postJson(url: string, body: unknown, redirectHint: string): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: buildRequestHeaders(),
    body: JSON.stringify(body ?? {}),
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    const destination = location ? ` to ${location}` : "";
    throw new Error(
      `TestChimp API redirected ${res.status}${destination}. Refusing to follow because an HTTP redirect may rewrite POST to GET; ${redirectHint}`
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new TestChimpHttpError(res.status, res.statusText, text);
  }
  return text;
}

export async function postMcp(path: string, body: unknown): Promise<string> {
  return postJson(
    `${getBackendUrl()}${path}`,
    body,
    "set TESTCHIMP_BACKEND_URL to the final HTTPS featureservice URL.",
  );
}

/** POST to TestChimp ingress: a path under TESTCHIMP_INGRESS_URL, or an explicit absolute URL (e.g. ackUrl). */
export async function postIngress(pathOrUrl: string, body: unknown): Promise<string> {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(pathOrUrl.trim())
    ? resolveIngressTargetUrl(pathOrUrl)
    : `${getIngressUrl()}${pathOrUrl}`;
  return postJson(url, body, "set TESTCHIMP_INGRESS_URL to the final HTTPS ingress URL.");
}

export type PostMcpFn = (path: string, body: unknown) => Promise<string>;
export type PostIngressFn = (pathOrUrl: string, body: unknown) => Promise<string>;
