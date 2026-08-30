import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import {
  fetchUpstreamWithRetry,
  isChimphandsLlmRetryEnabled,
  isRetryableLlmFailure,
  isRetryableLlmNetworkError,
  startLlmRetryProxy,
} from "./llmRetryProxy.js";

describe("isRetryableLlmFailure", () => {
  it("retries 502/503/504 only", () => {
    assert.equal(isRetryableLlmFailure(503), true);
    assert.equal(isRetryableLlmFailure(502), true);
    assert.equal(isRetryableLlmFailure(504), true);
    assert.equal(isRetryableLlmFailure(500), false);
    assert.equal(isRetryableLlmFailure(429), false);
    assert.equal(isRetryableLlmFailure(401), false);
  });
});

describe("isRetryableLlmNetworkError", () => {
  it("detects common network failures", () => {
    assert.equal(isRetryableLlmNetworkError(Object.assign(new Error("fetch failed"), { cause: "x" })), true);
    assert.equal(isRetryableLlmNetworkError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), true);
    assert.equal(isRetryableLlmNetworkError(new Error("401 Unauthorized")), false);
  });
});

describe("isChimphandsLlmRetryEnabled", () => {
  it("defaults to enabled", () => {
    const prev = process.env.CHIMPHANDS_LLM_RETRY;
    delete process.env.CHIMPHANDS_LLM_RETRY;
    assert.equal(isChimphandsLlmRetryEnabled(), true);
    process.env.CHIMPHANDS_LLM_RETRY = "0";
    assert.equal(isChimphandsLlmRetryEnabled(), false);
    if (prev === undefined) delete process.env.CHIMPHANDS_LLM_RETRY;
    else process.env.CHIMPHANDS_LLM_RETRY = prev;
  });
});

describe("fetchUpstreamWithRetry", () => {
  it("503 twice then 200 succeeds after two waits", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const res = await fetchUpstreamWithRetry(
      "http://example.test/v1/responses",
      { method: "POST" },
      {
        delayMs: 30,
        maxMs: 300,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        fetchFn: async () => {
          calls += 1;
          if (calls <= 2) {
            return new Response("unavailable", { status: 503 });
          }
          return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [30, 30]);
  });

  it("503 until deadline returns last 503", async () => {
    let calls = 0;
    let now = 0;
    const res = await fetchUpstreamWithRetry(
      "http://example.test/v1/responses",
      { method: "POST" },
      {
        delayMs: 100,
        maxMs: 250,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        fetchFn: async () => {
          calls += 1;
          return new Response("unavailable", { status: 503 });
        },
      },
    );
    assert.equal(res.status, 503);
    assert.equal(calls, 4);
  });

  it("network error then success", async () => {
    let calls = 0;
    const res = await fetchUpstreamWithRetry(
      "http://example.test/v1/responses",
      { method: "POST" },
      {
        delayMs: 10,
        maxMs: 100,
        sleep: async () => {},
        fetchFn: async () => {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
          }
          return new Response("ok", { status: 200 });
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  });
});

describe("startLlmRetryProxy", () => {
  it("503 twice then 200 via proxy", async () => {
    let upstreamCalls = 0;
    const upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      if (upstreamCalls <= 2) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("down");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startLlmRetryProxy(`http://127.0.0.1:${upstreamPort}/v1`, {
      delayMs: 20,
      maxMs: 200,
      sleep: async () => {},
    });

    try {
      const res = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: "{}" });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '{"ok":true}');
      assert.equal(upstreamCalls, 3);
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("streams chunked success without duplication after 503", async () => {
    let upstreamCalls = 0;
    const upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        res.writeHead(503);
        res.end("down");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: one\n\n");
      res.write("data: two\n\n");
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startLlmRetryProxy(`http://127.0.0.1:${upstreamPort}/v1`, {
      delayMs: 10,
      maxMs: 100,
      sleep: async () => {},
    });

    try {
      const res = await fetch(`${proxy.baseUrl}/chat/completions`, { method: "POST", body: "{}" });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "data: one\n\ndata: two\n\n");
      assert.equal(upstreamCalls, 2);
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
