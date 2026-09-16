import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getBackendUrl, postMcp } from "./client.js";

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
