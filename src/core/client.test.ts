import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  getBackendUrl,
  isValidBotId,
  postIngress,
  postMcp,
  resetClientWarningsForTests,
  runWithRequestAuth,
} from "./client.js";

const originalBackendUrl = process.env.TESTCHIMP_BACKEND_URL;
const originalApiKey = process.env.TESTCHIMP_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalBackendUrl == null) delete process.env.TESTCHIMP_BACKEND_URL;
  else process.env.TESTCHIMP_BACKEND_URL = originalBackendUrl;
  if (originalApiKey == null) delete process.env.TESTCHIMP_API_KEY;
  else process.env.TESTCHIMP_API_KEY = originalApiKey;
  globalThis.fetch = originalFetch;
});

describe("getBackendUrl", () => {
  it("rejects insecure TestChimp SaaS URLs", () => {
    process.env.TESTCHIMP_BACKEND_URL = "http://featureservice.testchimp.io";
    assert.throws(() => getBackendUrl(), /must use https for TestChimp SaaS/);

    process.env.TESTCHIMP_BACKEND_URL = "http://featureservice-staging.testchimp.io/";
    assert.throws(() => getBackendUrl(), /must use https for TestChimp SaaS/);
  });

  it("allows HTTP for local and self-hosted development", () => {
    process.env.TESTCHIMP_BACKEND_URL = "http://localhost:4301/";
    assert.equal(getBackendUrl(), "http://localhost:4301");

    process.env.TESTCHIMP_BACKEND_URL = "http://featureservice.internal/";
    assert.equal(getBackendUrl(), "http://featureservice.internal");
  });

  it("rejects invalid and unsupported URLs", () => {
    process.env.TESTCHIMP_BACKEND_URL = "featureservice.testchimp.io";
    assert.throws(() => getBackendUrl(), /absolute http\(s\) URL/);

    process.env.TESTCHIMP_BACKEND_URL = "ftp://featureservice.internal";
    assert.throws(() => getBackendUrl(), /must use http or https/);
  });
});

describe("postMcp", () => {
  it("does not follow redirects that could change POST to GET", async () => {
    process.env.TESTCHIMP_BACKEND_URL = "https://featureservice.example.com";
    process.env.TESTCHIMP_API_KEY = "test-key";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return new Response(null, {
        status: 301,
        headers: { location: "https://featureservice.testchimp.io/api/mcp/example" },
      });
    }) as typeof fetch;

    await assert.rejects(
      postMcp("/api/mcp/example", {}),
      /Refusing to follow because an HTTP redirect may rewrite POST to GET/
    );
    assert.equal(requestInit?.method, "POST");
    assert.equal(requestInit?.redirect, "manual");
  });
});

describe("request headers", () => {
  const originalBotId = process.env.TESTCHIMP_BOT_ID;
  const originalOauthToken = process.env.TESTCHIMP_OAUTH_TOKEN;
  const originalIngressUrl = process.env.TESTCHIMP_INGRESS_URL;
  const originalConsoleError = console.error;

  beforeEach(() => {
    process.env.TESTCHIMP_BACKEND_URL = "https://featureservice.example.com";
    delete process.env.TESTCHIMP_API_KEY;
    delete process.env.TESTCHIMP_BOT_ID;
    delete process.env.TESTCHIMP_OAUTH_TOKEN;
    delete process.env.TESTCHIMP_INGRESS_URL;
    resetClientWarningsForTests();
  });

  afterEach(() => {
    for (const [key, value] of [
      ["TESTCHIMP_BOT_ID", originalBotId],
      ["TESTCHIMP_OAUTH_TOKEN", originalOauthToken],
      ["TESTCHIMP_INGRESS_URL", originalIngressUrl],
    ] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    console.error = originalConsoleError;
  });

  function captureFetch(): { calls: Array<{ url: string; init?: RequestInit }> } {
    const capture = { calls: [] as Array<{ url: string; init?: RequestInit }> };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capture.calls.push({ url: String(input), init });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return capture;
  }

  it("sends exactly the legacy header set with an API key and no bot env", async () => {
    process.env.TESTCHIMP_API_KEY = "test-key";
    const capture = captureFetch();
    await postMcp("/api/mcp/example", { a: 1 });
    assert.equal(capture.calls[0].url, "https://featureservice.example.com/api/mcp/example");
    assert.deepEqual(capture.calls[0].init?.headers, {
      "Content-Type": "application/json",
      "TestChimp-Api-Key": "test-key",
    });
    assert.equal(capture.calls[0].init?.body, JSON.stringify({ a: 1 }));
  });

  it("keeps the missing API key error when no credentials are set", async () => {
    captureFetch();
    await assert.rejects(postMcp("/api/mcp/example", {}), /TESTCHIMP_API_KEY is required/);
  });

  it("adds a valid bot-id header", async () => {
    process.env.TESTCHIMP_API_KEY = "test-key";
    process.env.TESTCHIMP_BOT_ID = "grok-bot_01";
    const capture = captureFetch();
    await postMcp("/api/mcp/example", {});
    assert.deepEqual(capture.calls[0].init?.headers, {
      "Content-Type": "application/json",
      "TestChimp-Api-Key": "test-key",
      "bot-id": "grok-bot_01",
    });
  });

  it("drops an invalid bot id and warns once", async () => {
    process.env.TESTCHIMP_API_KEY = "test-key";
    process.env.TESTCHIMP_BOT_ID = "bad bot id";
    const warnings: string[] = [];
    console.error = (msg: unknown) => warnings.push(String(msg));
    const capture = captureFetch();
    await postMcp("/api/mcp/example", {});
    await postMcp("/api/mcp/example", {});
    assert.deepEqual(capture.calls[0].init?.headers, {
      "Content-Type": "application/json",
      "TestChimp-Api-Key": "test-key",
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /TESTCHIMP_BOT_ID/);

    assert.equal(isValidBotId("x".repeat(64)), true);
    assert.equal(isValidBotId("x".repeat(65)), false);
    assert.equal(isValidBotId("bot\u0007"), false);
  });

  it("uses the OAuth token without requiring an API key", async () => {
    process.env.TESTCHIMP_OAUTH_TOKEN = "jwt-token";
    const capture = captureFetch();
    await postMcp("/api/mcp/example", {});
    assert.deepEqual(capture.calls[0].init?.headers, {
      "Content-Type": "application/json",
      Authorization: "Bearer jwt-token",
    });
  });

  it("sends both the API key and the bearer when both are set", async () => {
    process.env.TESTCHIMP_API_KEY = "test-key";
    process.env.TESTCHIMP_OAUTH_TOKEN = "jwt-token";
    process.env.TESTCHIMP_BOT_ID = "bot-1";
    const capture = captureFetch();
    await postMcp("/api/mcp/example", {});
    assert.deepEqual(capture.calls[0].init?.headers, {
      "Content-Type": "application/json",
      "TestChimp-Api-Key": "test-key",
      Authorization: "Bearer jwt-token",
      "bot-id": "bot-1",
    });
  });

  it("isolated request auth ignores env credentials", async () => {
    process.env.TESTCHIMP_API_KEY = "server-key";
    process.env.TESTCHIMP_BOT_ID = "server-bot";
    const capture = captureFetch();
    await runWithRequestAuth({ bearerToken: "caller-token", isolated: true }, () =>
      postMcp("/api/mcp/example", {}),
    );
    assert.deepEqual(capture.calls[0].init?.headers, {
      "Content-Type": "application/json",
      Authorization: "Bearer caller-token",
    });
  });

  it("isolated request auth sends the URL project only when no project key is given", async () => {
    const capture = captureFetch();
    await runWithRequestAuth({ bearerToken: "caller-token", projectId: "proj-2", isolated: true }, () =>
      postMcp("/api/mcp/example", {}),
    );
    await runWithRequestAuth(
      { bearerToken: "caller-token", projectId: "proj-2", projectApiKey: "key-b", isolated: true },
      () => postMcp("/api/mcp/example", {}),
    );
    assert.deepEqual(capture.calls[0].init?.headers, {
      "Content-Type": "application/json",
      Authorization: "Bearer caller-token",
      "TestChimp-Project-Id": "proj-2",
    });
    assert.deepEqual(capture.calls[1].init?.headers, {
      "Content-Type": "application/json",
      Authorization: "Bearer caller-token",
      "TestChimp-Api-Key": "key-b",
    });
  });

  it("posts to the ingress base or a trusted absolute URL", async () => {
    process.env.TESTCHIMP_API_KEY = "test-key";
    const capture = captureFetch();
    await postIngress("/bot/events/ack", { eventIds: ["e1"] });
    assert.equal(capture.calls[0].url, "https://ingress.testchimp.io/bot/events/ack");
    assert.equal(capture.calls[0].init?.redirect, "manual");

    await postIngress("https://ingress-staging.testchimp.io/bot/events/ack", {});
    assert.equal(capture.calls[1].url, "https://ingress-staging.testchimp.io/bot/events/ack");

    await postIngress("http://localhost:4302/bot/events/ack", {});
    assert.equal(capture.calls[2].url, "http://localhost:4302/bot/events/ack");

    await assert.rejects(postIngress("http://ingress.testchimp.io/bot/events/ack", {}), /must use https/);
    await assert.rejects(postIngress("https://evil.example.com/bot/events/ack", {}), /untrusted ingress host/);
    assert.equal(capture.calls.length, 3);

    process.env.TESTCHIMP_INGRESS_URL = "https://ingress.customer.example/";
    await postIngress("https://ingress.customer.example/bot/events/ack", {});
    assert.equal(capture.calls[3].url, "https://ingress.customer.example/bot/events/ack");
  });
});
