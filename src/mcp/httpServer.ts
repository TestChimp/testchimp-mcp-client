import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getBackendUrl, isValidProjectId, runWithRequestAuth } from "../core/client.js";
import { createMcpServer } from "./server.js";

export const MAX_MCP_BODY_BYTES = 1024 * 1024;
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
const AUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const AUTH_SERVER_METADATA_TTL_MS = 5 * 60 * 1000;
const SCOPE = "testchimp";

/**
 * Bearer-only API (no cookies), so any origin may call it: browser-hosted MCP clients and inspectors
 * need the preflight and to read WWW-Authenticate for OAuth discovery.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID, bot-id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

let authServerMetadataCache: { issuer: string; body: string; fetchedAt: number } | undefined;

export interface McpHttpServerOptions {
  port: number;
  host: string;
}

class BodyTooLargeError extends Error {}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Public origin of this server: TESTCHIMP_MCP_PUBLIC_URL, else derived from the request (Cloud Run sets X-Forwarded-Proto). */
function publicBaseUrl(req: IncomingMessage): string {
  const configured = process.env.TESTCHIMP_MCP_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "").replace(/\/mcp$/, "");
  const proto = firstHeader(req.headers["x-forwarded-proto"])?.split(",")[0].trim() === "https" ? "https" : "http";
  const host = firstHeader(req.headers["x-forwarded-host"])?.split(",")[0].trim() || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function authorizationServer(): string {
  return process.env.TESTCHIMP_OAUTH_ISSUER?.trim().replace(/\/+$/, "") || getBackendUrl();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function jsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);
}

type ProjectScope = { projectId?: string; invalid?: true };

/** `?projectId=` on the MCP URL scopes every tool call to that project (one URL per repo). */
function projectScope(req: IncomingMessage): ProjectScope {
  const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("projectId");
  if (raw == null) return {};
  const projectId = raw.trim();
  return isValidProjectId(projectId) ? { projectId } : { invalid: true };
}

function scopeQuery(scope: ProjectScope): string {
  return scope.projectId ? `?projectId=${encodeURIComponent(scope.projectId)}` : "";
}

/** RFC 9728 metadata URL for this resource; scoped URLs get path-inserted metadata echoing their query. */
function resourceMetadataUrl(req: IncomingMessage, scope: ProjectScope): string {
  const base = `${publicBaseUrl(req)}${PROTECTED_RESOURCE_PATH}`;
  return scope.projectId ? `${base}/mcp${scopeQuery(scope)}` : base;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(firstHeader(req.headers.authorization) ?? "");
  return match?.[1];
}

/**
 * Unverified peek at a JWT `exp` so expired access tokens get an HTTP 401 (which makes MCP clients
 * refresh) instead of a tool-level error. Signature verification stays with TestChimp.
 */
export function isExpiredJwt(token: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && payload.exp <= nowSeconds;
  } catch {
    return false;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_MCP_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() === "" ? undefined : JSON.parse(text);
}

async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const scope = projectScope(req);
  if (scope.invalid) {
    jsonRpcError(res, 400, "Invalid projectId query parameter");
    return;
  }
  const token = bearerToken(req);
  if (!token) {
    const metadataUrl = resourceMetadataUrl(req, scope);
    jsonRpcError(res, 401, "Unauthorized: Authorization: Bearer <token> is required", {
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", scope="${SCOPE}"`,
    });
    return;
  }
  if (isExpiredJwt(token)) {
    const metadataUrl = resourceMetadataUrl(req, scope);
    jsonRpcError(res, 401, "Unauthorized: access token expired", {
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="expired", resource_metadata="${metadataUrl}", scope="${SCOPE}"`,
    });
    return;
  }
  const declaredLength = Number(firstHeader(req.headers["content-length"]) ?? 0);
  if (declaredLength > MAX_MCP_BODY_BYTES) {
    jsonRpcError(res, 413, "Request body too large");
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    if (e instanceof BodyTooLargeError) jsonRpcError(res, 413, "Request body too large");
    else jsonRpcError(res, 400, "Parse error: request body must be JSON");
    return;
  }

  const server = createMcpServer({ bindingArgs: true });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  const botId = firstHeader(req.headers["bot-id"])?.trim() || undefined;
  await runWithRequestAuth({ bearerToken: token, botId, projectId: scope.projectId, isolated: true }, async () => {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
}

/**
 * Older MCP clients (2025-03-26 spec) skip protected-resource metadata and look for authorization-server
 * metadata on the MCP origin. Serve TestChimp's (endpoints are absolute, so they lead to the real issuer).
 */
async function handleAuthServerMetadata(res: ServerResponse): Promise<void> {
  const issuer = authorizationServer();
  const cached = authServerMetadataCache;
  if (cached && cached.issuer === issuer && Date.now() - cached.fetchedAt < AUTH_SERVER_METADATA_TTL_MS) {
    sendRaw(res, cached.body);
    return;
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${issuer}${AUTH_SERVER_METADATA_PATH}`, { headers: { Accept: "application/json" } });
  } catch {
    sendJson(res, 502, { error: "Authorization server metadata unavailable" });
    return;
  }
  if (!upstream.ok) {
    sendJson(res, 502, { error: "Authorization server metadata unavailable" });
    return;
  }
  const body = await upstream.text();
  authServerMetadataCache = { issuer, body, fetchedAt: Date.now() };
  sendRaw(res, body);
}

function sendRaw(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "public, max-age=300",
  });
  res.end(body);
}

export function resetAuthServerMetadataCache(): void {
  authServerMetadataCache = undefined;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";

  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === AUTH_SERVER_METADATA_PATH || path === `${AUTH_SERVER_METADATA_PATH}/mcp`) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" }, { Allow: "GET" });
      return;
    }
    await handleAuthServerMetadata(res);
    return;
  }
  if (path === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (path === PROTECTED_RESOURCE_PATH || path === `${PROTECTED_RESOURCE_PATH}/mcp`) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" }, { Allow: "GET" });
      return;
    }
    const scope = projectScope(req);
    if (scope.invalid) {
      sendJson(res, 400, { error: "Invalid projectId query parameter" });
      return;
    }
    // RFC 9728 protected-resource metadata keys are spec-mandated snake_case.
    sendJson(res, 200, {
      resource: `${publicBaseUrl(req)}/mcp${scopeQuery(scope)}`,
      authorization_servers: [authorizationServer()],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
    });
    return;
  }
  if (path === "/mcp") {
    if (req.method === "POST") {
      await handleMcpPost(req, res);
      return;
    }
    jsonRpcError(res, 405, "Method not allowed (stateless server: use POST)", { Allow: "POST" });
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

/** Remote MCP (Streamable HTTP, stateless). Each caller's bearer is forwarded to TestChimp; env credentials are never used. */
export function createMcpHttpServer(): Server {
  return createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      console.error(`[testchimp mcp] request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
      else res.end();
    });
  });
}

export async function runMcpHttpServer(options: McpHttpServerOptions): Promise<Server> {
  const server = createMcpHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  console.error(`[testchimp mcp] Streamable HTTP listening on http://${options.host}:${options.port}/mcp`);
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}
