import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getBackendUrl, runWithRequestAuth } from "../core/client.js";
import { createMcpServer } from "./server.js";

export const MAX_MCP_BODY_BYTES = 1024 * 1024;
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

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
  const token = bearerToken(req);
  if (!token) {
    const metadataUrl = `${publicBaseUrl(req)}${PROTECTED_RESOURCE_PATH}`;
    jsonRpcError(res, 401, "Unauthorized: Authorization: Bearer <token> is required", {
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
    });
    return;
  }
  if (isExpiredJwt(token)) {
    const metadataUrl = `${publicBaseUrl(req)}${PROTECTED_RESOURCE_PATH}`;
    jsonRpcError(res, 401, "Unauthorized: access token expired", {
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="expired", resource_metadata="${metadataUrl}"`,
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
  await runWithRequestAuth({ bearerToken: token, botId, isolated: true }, async () => {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";

  if (path === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (path === PROTECTED_RESOURCE_PATH || path === `${PROTECTED_RESOURCE_PATH}/mcp`) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" }, { Allow: "GET" });
      return;
    }
    // RFC 9728 protected-resource metadata keys are spec-mandated snake_case.
    sendJson(res, 200, {
      resource: `${publicBaseUrl(req)}/mcp`,
      authorization_servers: [authorizationServer()],
      bearer_methods_supported: ["header"],
      scopes_supported: ["testchimp"],
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
