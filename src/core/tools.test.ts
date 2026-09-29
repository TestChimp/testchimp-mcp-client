import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getToolDefinition, runTool } from "./tools.js";

const runtimeObservation = {
  windowStartMillis: "1789497600000",
  windowEndMillis: "1789584000000",
  requestCount: "125000",
  rpm: 86.8,
  errorCount: "2500",
  errorRate: 0.02,
  p50LatencyMs: 42,
  p95LatencyMs: 180,
  p99LatencyMs: 420,
  status2xxCount: "122000",
  status4xxCount: "1000",
  status5xxCount: "2000",
  syncStatus: "OBSERVABILITY_SYNC_SUCCESS",
};

describe("API operation observability", () => {
  it("preserves daily observability summaries when listing operations", async () => {
    const response = JSON.stringify({
      operations: [{
        id: "01OBSERVABILITYOPERATION",
        coverageSummary: { coverageScore: 25 },
        obsMappingState: "API_OBS_MAPPED",
        runtimeObservation,
      }],
    });
    let request: { path: string; body: unknown } | undefined;

    const result = await runTool(
      "list-api-operations",
      { rootFilePath: "openapi/service.json" },
      {
        postMcp: async (path, body) => {
          request = { path, body };
          return response;
        },
      },
    );

    assert.deepEqual(request, {
      path: "/api/mcp/list_api_operations",
      body: { rootFilePath: "openapi/service.json" },
    });
    assert.deepEqual(JSON.parse(result), JSON.parse(response));
  });

  it("preserves observability on operation schema coverage detail", async () => {
    const response = JSON.stringify({
      operation: {
        id: "01OBSERVABILITYOPERATION",
        obsMappingState: "API_OBS_MAPPED",
        runtimeObservation,
      },
      requestFields: [{ jsonPointer: "/customerId", coveringTests: [] }],
      responseCodes: [{ responseCode: "500", coveringTests: [] }],
    });

    const result = await runTool(
      "get-api-operation-detail",
      { id: "01OBSERVABILITYOPERATION" },
      { postMcp: async () => response },
    );

    assert.deepEqual(JSON.parse(result), JSON.parse(response));
    assert.match(
      getToolDefinition("get-api-operation-detail")?.description ?? "",
      /p95\/p99 latency/,
    );
  });
});

describe("get-meeting-transcript", () => {
  it("posts meetingId to get_meeting_transcript", async () => {
    const response = JSON.stringify({
      meetingId: "evt-123",
      transcriptMarkdown: "# Meeting\n\nP1: hello",
    });
    let request: { path: string; body: unknown } | undefined;

    const result = await runTool(
      "get-meeting-transcript",
      { meetingId: "evt-123" },
      {
        postMcp: async (path, body) => {
          request = { path, body };
          return response;
        },
      },
    );

    assert.deepEqual(request, {
      path: "/api/mcp/get_meeting_transcript",
      body: { meetingId: "evt-123" },
    });
    assert.deepEqual(JSON.parse(result), JSON.parse(response));
  });

  it("passes summaryOnly when requested", async () => {
    let body: unknown;
    await runTool(
      "get-meeting-transcript",
      { meetingId: "evt-123", summaryOnly: true },
      {
        postMcp: async (_path, b) => {
          body = b;
          return "{}";
        },
      },
    );
    assert.deepEqual(body, { meetingId: "evt-123", summaryOnly: true });
  });
});

describe("get-meeting-set", () => {
  it("posts meetingSetId to get_meeting_set", async () => {
    let request: { path: string; body: unknown } | undefined;
    await runTool(
      "get-meeting-set",
      { meetingSetId: "01J9Z3X5V4ABCDEF0123456789" },
      {
        postMcp: async (path, body) => {
          request = { path, body };
          return "{}";
        },
      },
    );
    assert.deepEqual(request, {
      path: "/api/mcp/get_meeting_set",
      body: { meetingSetId: "01J9Z3X5V4ABCDEF0123456789" },
    });
  });
});
