import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { TOOL_ANNOTATIONS } from "../core/toolAnnotations.js";
import { HOSTED_OMITTED_TOOLS } from "./server.js";
import { createMcpHttpServer, isExpiredJwt, resetAuthServerMetadataCache } from "./httpServer.js";

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

  it("serves the SEP-2127 MCP Server Card without auth", async () => {
    process.env.TESTCHIMP_MCP_PUBLIC_URL = "https://mcp.example.com";
    const res = await originalFetch(`${baseUrl}/mcp/server-card`, {
      headers: { Accept: "application/mcp-server-card+json" },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/mcp-server-card\+json/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("cache-control") ?? "", /max-age=3600/);
    const card = (await res.json()) as {
      name: string;
      version: string;
      description: string;
      remotes: Array<{ type: string; url: string }>;
    };
    assert.equal(card.name, "io.testchimp/qa");
    assert.ok(card.version);
    assert.ok(card.description.length <= 100);
    assert.deepEqual(card.remotes, [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }]);
  });

  it("serves /.well-known/ai-catalog.json pointing at the Server Card", async () => {
    process.env.TESTCHIMP_MCP_PUBLIC_URL = "https://mcp.example.com";
    const res = await originalFetch(`${baseUrl}/.well-known/ai-catalog.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/ai-catalog\+json/);
    const catalog = (await res.json()) as {
      specVersion: string;
      entries: Array<{ identifier: string; type: string; url: string }>;
    };
    assert.equal(catalog.specVersion, "1.0");
    assert.equal(catalog.entries.length, 1);
    assert.equal(catalog.entries[0].type, "application/mcp-server-card+json");
    assert.equal(catalog.entries[0].url, "https://mcp.example.com/mcp/server-card");
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
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="testchimp"',
    );
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-expose-headers") ?? "", /WWW-Authenticate/);
  });

  it("answers CORS preflight for browser-hosted clients", async () => {
    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://inspector.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type, mcp-protocol-version",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /Mcp-Protocol-Version/);
  });

  it("serves the authorization server's metadata on the MCP origin for older clients", async () => {
    resetAuthServerMetadataCache();
    process.env.TESTCHIMP_OAUTH_ISSUER = "https://featureservice.example.com";
    const metadata = {
      issuer: "https://featureservice.example.com",
      authorization_endpoint: "https://featureservice.example.com/oauth/authorize",
      token_endpoint: "https://featureservice.example.com/oauth/token",
      registration_endpoint: "https://featureservice.example.com/oauth/register",
    };
    const upstream: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return originalFetch(input, init);
      upstream.push(url);
      return new Response(JSON.stringify(metadata));
    }) as typeof fetch;

    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
      const res = await originalFetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), metadata);
    }
    assert.deepEqual(upstream, ["https://featureservice.example.com/.well-known/oauth-authorization-server"]);

    const botRes = await originalFetch(`${baseUrl}/.well-known/oauth-authorization-server/bot/mcp`);
    assert.equal(botRes.status, 200);
    assert.deepEqual(await botRes.json(), {
      ...metadata,
      authorization_endpoint: "https://featureservice.example.com/oauth/bot/authorize",
    });
  });

  it("returns 502 when the authorization server metadata is unreachable", async () => {
    resetAuthServerMetadataCache();
    process.env.TESTCHIMP_OAUTH_ISSUER = "https://featureservice.example.com";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return originalFetch(input, init);
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const res = await originalFetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 502);
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
    const botMeta = await originalFetch(`${baseUrl}/.well-known/oauth-protected-resource/bot/mcp`, {
      headers: { "X-Forwarded-Proto": "https" },
    });
    assert.equal(botMeta.status, 200);
    const host = new URL(baseUrl).host;
    assert.equal(((await botMeta.json()) as { resource: string }).resource, `https://${host}/bot/mcp`);
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

  it("points scoped URLs at path-inserted metadata that echoes ?projectId=", async () => {
    process.env.TESTCHIMP_MCP_PUBLIC_URL = "https://mcp.example.com";
    const res = await originalFetch(`${baseUrl}/mcp?projectId=proj-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get("www-authenticate"),
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp?projectId=proj-2", scope="testchimp"',
    );
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const meta = await originalFetch(`${baseUrl}${path}?projectId=proj-2`);
      assert.equal(meta.status, 200);
      assert.equal(((await meta.json()) as { resource: string }).resource, "https://mcp.example.com/mcp?projectId=proj-2");
    }
  });

  it("rejects a malformed ?projectId=", async () => {
    const res = await originalFetch(`${baseUrl}/mcp?projectId=${encodeURIComponent("../x y")}`, {
      method: "POST",
      headers: { Authorization: "Bearer caller-jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 400);
    const meta = await originalFetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp?projectId=a%20b`);
    assert.equal(meta.status, 400);
  });

  it("sends ?projectId= as TestChimp-Project-Id unless a projectApiKey names the project", async () => {
    process.env.TESTCHIMP_BACKEND_URL = "https://featureservice.example.com";
    const upstream: Array<Record<string, string>> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return originalFetch(input, init);
      upstream.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    const call = (id: number, args: Record<string, unknown>) =>
      originalFetch(`${baseUrl}/mcp?projectId=proj-2`, {
        method: "POST",
        headers: {
          Authorization: "Bearer caller-jwt",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get-bot-profile", arguments: args } }),
      });
    assert.equal((await call(10, {})).status, 200);
    assert.equal((await call(11, { projectApiKey: "project-b-key" })).status, 200);
    assert.deepEqual(upstream, [
      { "Content-Type": "application/json", Authorization: "Bearer caller-jwt", "TestChimp-Project-Id": "proj-2" },
      { "Content-Type": "application/json", Authorization: "Bearer caller-jwt", "TestChimp-Api-Key": "project-b-key" },
    ]);
  });

  describe("projectId argument", () => {
    const callTool = (
      id: number,
      args: Record<string, unknown>,
      path = "/mcp",
      name = "get-project-init-status",
    ) =>
      originalFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer caller-jwt",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
      });
    const captureUpstream = () => {
      const upstream: Array<{ headers: Record<string, string>; body: string }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith(baseUrl)) return originalFetch(input, init);
        upstream.push({ headers: init?.headers as Record<string, string>, body: String(init?.body) });
        return new Response(JSON.stringify({}));
      }) as typeof fetch;
      return upstream;
    };

    it("sends a projectId argument as TestChimp-Project-Id and strips it from the body", async () => {
      process.env.TESTCHIMP_BACKEND_URL = "https://featureservice.example.com";
      const upstream = captureUpstream();
      assert.equal((await callTool(20, { projectId: "proj-3" })).status, 200);
      assert.deepEqual(upstream, [
        {
          headers: { "Content-Type": "application/json", Authorization: "Bearer caller-jwt", "TestChimp-Project-Id": "proj-3" },
          body: "{}",
        },
      ]);
    });

    it("a projectId argument overrides ?projectId= on the URL", async () => {
      process.env.TESTCHIMP_BACKEND_URL = "https://featureservice.example.com";
      const upstream = captureUpstream();
      assert.equal((await callTool(21, { projectId: "proj-3" }, "/mcp?projectId=proj-2")).status, 200);
      assert.equal(upstream[0]?.headers["TestChimp-Project-Id"], "proj-3");
    });

    it("projectApiKey wins over a projectId argument", async () => {
      process.env.TESTCHIMP_BACKEND_URL = "https://featureservice.example.com";
      const upstream = captureUpstream();
      assert.equal((await callTool(22, { projectApiKey: "project-b-key", projectId: "proj-3" })).status, 200);
      assert.equal(upstream[0]?.headers["TestChimp-Api-Key"], "project-b-key");
      assert.equal("TestChimp-Project-Id" in (upstream[0]?.headers ?? {}), false);
    });

    it("rejects a malformed projectId argument without calling TestChimp", async () => {
      process.env.TESTCHIMP_BACKEND_URL = "https://featureservice.example.com";
      const upstream = captureUpstream();
      const res = await callTool(23, { projectId: "../x y" });
      const payload = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      assert.equal(payload.result?.isError, true);
      assert.match(payload.result?.content?.[0]?.text ?? "", /Invalid projectId/);
      assert.equal(upstream.length, 0);
    });
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
      assert.ok(tool.inputSchema?.properties?.projectId, `${tool.name} lacks projectId`);
    }
  });

  it("advertises MCP tool annotations on every tools/list entry", async () => {
    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer caller-jwt",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }),
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as {
      result?: {
        tools?: Array<{
          name: string;
          title?: string;
          annotations?: {
            title?: string;
            readOnlyHint?: boolean;
            destructiveHint?: boolean;
            idempotentHint?: boolean;
            openWorldHint?: boolean;
          };
        }>;
      };
    };
    const tools = payload.result?.tools ?? [];
    assert.equal(tools.length, Object.keys(TOOL_ANNOTATIONS).length - HOSTED_OMITTED_TOOLS.size);
    assert.ok(!tools.some((t) => HOSTED_OMITTED_TOOLS.has(t.name)), "hosted tools/list must omit laptop-write tools");
    for (const tool of tools) {
      const expected = TOOL_ANNOTATIONS[tool.name];
      assert.ok(expected, `${tool.name} is registered but missing from TOOL_ANNOTATIONS`);
      assert.equal(tool.title, expected.title, `${tool.name} tools/list title`);
      assert.deepEqual(tool.annotations, expected, `${tool.name} tools/list annotations`);
    }
  });
});
