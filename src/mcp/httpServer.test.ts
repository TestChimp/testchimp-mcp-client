import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { createMcpHttpServer, isExpiredJwt } from "./httpServer.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

let server: Server;
let baseUrl: string;

before(async () => {
  server = createMcpHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("isExpiredJwt", () => {
  const jwt = (payload: object) =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

  it("flags expired tokens and passes live or opaque ones", () => {
    assert.equal(isExpiredJwt(jwt({ exp: 100 }), 200), true);
    assert.equal(isExpiredJwt(jwt({ exp: 300 }), 200), false);
    assert.equal(isExpiredJwt(jwt({}), 200), false);
    assert.equal(isExpiredJwt("opaque-token", 200), false);
  });
});

describe("remote MCP over HTTP", () => {
  it("serves /healthz", async () => {
    const res = await originalFetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
  });

  it("rejects /mcp without a bearer and points at the resource metadata", async () => {
    process.env.TESTCHIMP_MCP_PUBLIC_URL = "https://mcp.example.com";
    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get("www-authenticate"),
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
    );
  });

  it("returns 405 for GET /mcp in stateless mode", async () => {
    const res = await originalFetch(`${baseUrl}/mcp`, { headers: { Authorization: "Bearer t" } });
    assert.equal(res.status, 405);
  });

  it("publishes RFC 9728 protected-resource metadata", async () => {
    process.env.TESTCHIMP_BACKEND_URL = "https://featureservice-staging.testchimp.io";
    delete process.env.TESTCHIMP_MCP_PUBLIC_URL;
    delete process.env.TESTCHIMP_OAUTH_ISSUER;
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await originalFetch(`${baseUrl}${path}`, { headers: { "X-Forwarded-Proto": "https" } });
      assert.equal(res.status, 200);
      const host = new URL(baseUrl).host;
      assert.deepEqual(await res.json(), {
        resource: `https://${host}/mcp`,
        authorization_servers: ["https://featureservice-staging.testchimp.io"],
        bearer_methods_supported: ["header"],
        scopes_supported: ["testchimp"],
      });
    }
  });

  it("rejects oversized bodies", async () => {
    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }),
    });
    assert.equal(res.status, 413);
  });

  it("forwards the caller's bearer (never the server API key) on tool calls", async () => {
    process.env.TESTCHIMP_BACKEND_URL = "https://featureservice.example.com";
    process.env.TESTCHIMP_API_KEY = "server-key";
    process.env.TESTCHIMP_OAUTH_TOKEN = "server-token";
    const upstream: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return originalFetch(input, init);
      upstream.push({ url, headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ minSkillVersion: "1.0.53", minCliVersion: "0.1.85", eventSchemaVersion: 1 }));
    }) as typeof fetch;

    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer caller-jwt",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "get-bot-compat", arguments: {} },
      }),
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
    assert.equal(JSON.parse(payload.result?.content?.[0]?.text ?? "{}").minCliVersion, "0.1.85");
    assert.deepEqual(upstream, [
      {
        url: "https://featureservice.example.com/api/mcp/get_bot_compat",
        headers: { "Content-Type": "application/json", Authorization: "Bearer caller-jwt" },
      },
    ]);
  });

  it("sends a QA bot's projectApiKey / botId arguments as headers and strips them from the body", async () => {
    process.env.TESTCHIMP_BACKEND_URL = "https://featureservice.example.com";
    const upstream: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return originalFetch(input, init);
      upstream.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body) });
      return new Response(JSON.stringify({ bot: { botId: "bot-2" } }));
    }) as typeof fetch;

    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer caller-jwt",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "get-bot-profile", arguments: { projectApiKey: "project-b-key", botId: "bot-2" } },
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(upstream, [
      {
        url: "https://featureservice.example.com/api/mcp/get_bot_profile",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer caller-jwt",
          "TestChimp-Api-Key": "project-b-key",
          "bot-id": "bot-2",
        },
        body: "{}",
      },
    ]);
  });

  it("advertises the binding arguments on every tool", async () => {
    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer caller-jwt",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    const payload = (await res.json()) as {
      result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> };
    };
    const tools = payload.result?.tools ?? [];
    assert.ok(tools.length > 50);
    for (const tool of tools) {
      assert.ok(tool.inputSchema?.properties?.projectApiKey, `${tool.name} lacks projectApiKey`);
      assert.ok(tool.inputSchema?.properties?.botId, `${tool.name} lacks botId`);
    }
  });
});
