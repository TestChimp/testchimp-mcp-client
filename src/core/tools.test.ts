import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWithRequestAuth, TestChimpHttpError } from "./client.js";
import { buildAgentTraceabilityPayload } from "./agentTraceability.js";
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

describe("list-meetings", () => {
  async function capture(args: Record<string, unknown>) {
    let request: { path: string; body: unknown } | undefined;
    await runTool("list-meetings", args, {
      postMcp: async (path, body) => {
        request = { path, body };
        return "{}";
      },
    });
    return request;
  }

  it("maps filters and converts date-only bounds to inclusive local-day millis", async () => {
    const request = await capture({
      from: "2026-09-01",
      to: "2026-09-30",
      labels: ["Sales "],
      participantKeys: ["buyer@customer.com"],
      participantDomains: ["@customer.com"],
      searchText: " pricing ",
      pageSize: 10,
      pageToken: "tok",
    });
    assert.deepEqual(request, {
      path: "/api/mcp/list_meetings",
      body: {
        startDateMillis: String(new Date(2026, 8, 1, 0, 0, 0, 0).getTime()),
        endDateMillis: String(new Date(2026, 8, 30, 23, 59, 59, 999).getTime()),
        labels: ["Sales"],
        participantKeys: ["buyer@customer.com"],
        participantDomains: ["customer.com"],
        searchText: "pricing",
        pageSize: 10,
        pageToken: "tok",
      },
    });
  });

  it("accepts ISO datetimes and raw epoch millis, and omits empty filters", async () => {
    const request = await capture({ from: "2026-09-01T10:00:00Z", endDateMillis: "1790000000000" });
    assert.deepEqual(request, {
      path: "/api/mcp/list_meetings",
      body: {
        startDateMillis: String(Date.parse("2026-09-01T10:00:00Z")),
        endDateMillis: "1790000000000",
      },
    });
    assert.deepEqual(await capture({}), { path: "/api/mcp/list_meetings", body: {} });
  });

  it("rejects unparseable dates", async () => {
    await assert.rejects(() => capture({ from: "last tuesday" }), /Invalid date/);
    await assert.rejects(() => capture({ to: "2026-02-30" }), /Invalid date/);
  });
});

describe("list-meeting-filter-options", () => {
  it("posts an empty body to list_meeting_filter_options", async () => {
    let request: { path: string; body: unknown } | undefined;
    await runTool("list-meeting-filter-options", {}, {
      postMcp: async (path, body) => {
        request = { path, body };
        return "{}";
      },
    });
    assert.deepEqual(request, { path: "/api/mcp/list_meeting_filter_options", body: {} });
  });
});

describe("ack-bot-events", () => {
  it("posts deduped eventIds to the delivery ackUrl", async () => {
    let request: { pathOrUrl: string; body: unknown } | undefined;
    const response = JSON.stringify({ results: [{ eventId: "e1", status: "BOT_ACK_ACKED" }] });
    const result = await runTool(
      "ack-bot-events",
      { eventIds: ["e1", "e1", "e2"], ackUrl: "https://ingress.testchimp.io/bot/events/ack" },
      {
        postMcp: async () => assert.fail("ack must not go to featureservice"),
        postIngress: async (pathOrUrl, body) => {
          request = { pathOrUrl, body };
          return response;
        },
      },
    );
    assert.deepEqual(request, {
      pathOrUrl: "https://ingress.testchimp.io/bot/events/ack",
      body: { eventIds: ["e1", "e2"] },
    });
    assert.equal(result, response);
  });

  it("defaults to the ingress ack path", async () => {
    let target: string | undefined;
    await runTool("ack-bot-events", { eventIds: ["e1"] }, {
      postMcp: async () => "{}",
      postIngress: async (pathOrUrl) => {
        target = pathOrUrl;
        return "{}";
      },
    });
    assert.equal(target, "/bot/events/ack");
  });

  it("explains a 404 from an older backend", async () => {
    await assert.rejects(
      runTool("ack-bot-events", { eventIds: ["e1"] }, {
        postMcp: async () => "{}",
        postIngress: async () => {
          throw new TestChimpHttpError(404, "Not Found", "");
        },
      }),
      /does not support bot acks yet/,
    );
  });

  it("validates eventIds count and characters", async () => {
    const ctx = { postMcp: async () => "{}", postIngress: async () => "{}" };
    await assert.rejects(runTool("ack-bot-events", { eventIds: [] }, ctx), /Invalid input/);
    const tooMany = Array.from({ length: 101 }, (_, i) => `e${i}`);
    await assert.rejects(runTool("ack-bot-events", { eventIds: tooMany }, ctx), /Invalid input/);
    await assert.rejects(runTool("ack-bot-events", { eventIds: ["é"] }, ctx), /Invalid input/);
  });
});

describe("bot tools", () => {
  async function capture(kebab: string, args: Record<string, unknown>) {
    let request: { path: string; body: unknown } | undefined;
    await runTool(kebab, args, {
      postMcp: async (path, body) => {
        request = { path, body };
        return "{}";
      },
    });
    return request;
  }

  it("maps read tools to their endpoints", async () => {
    assert.deepEqual(await capture("get-my-tasks", { userId: "u1" }), {
      path: "/api/mcp/get_my_tasks",
      body: { userId: "u1" },
    });
    assert.deepEqual(await capture("get-my-tasks", {}), { path: "/api/mcp/get_my_tasks", body: {} });
    assert.deepEqual(await capture("list-tests-awaiting-verification", { limit: 5 }), {
      path: "/api/mcp/list_tests_awaiting_verification",
      body: { limit: 5 },
    });
    assert.deepEqual(await capture("get-qa-posture", {}), { path: "/api/mcp/get_qa_posture", body: {} });
    assert.deepEqual(await capture("get-bot-compat", {}), { path: "/api/mcp/get_bot_compat", body: {} });
    assert.deepEqual(await capture("get-bot-profile", {}), { path: "/api/mcp/get_bot_profile", body: {} });
    assert.deepEqual(await capture("get-project-credentials", {}), {
      path: "/api/mcp/get_project_credentials",
      body: {},
    });
  });

  it("maps invite-team-members to its endpoint and caps the batch", async () => {
    assert.deepEqual(await capture("invite-team-members", { emails: [" a@x.io ", "b@x.io"] }), {
      path: "/api/mcp/invite_team_members",
      body: { emails: ["a@x.io", "b@x.io"] },
    });
    await assert.rejects(capture("invite-team-members", { emails: [] }), /Invalid input/);
    const tooMany = Array.from({ length: 21 }, (_, i) => `u${i}@x.io`);
    await assert.rejects(capture("invite-team-members", { emails: tooMany }), /Invalid input/);
  });

  it("maps update-workflow-execution-assignees ids and emails to the right fields", async () => {
    assert.deepEqual(
      await capture("update-workflow-execution-assignees", {
        workflowExecutionId: " ex1 ",
        assignee: "bob@x.io",
        addCc: ["u2", "carol@x.io"],
        removeCc: ["u3"],
      }),
      {
        path: "/api/mcp/update_workflow_execution_assignees",
        body: {
          workflowExecutionId: "ex1",
          assigneeEmail: "bob@x.io",
          addCcUserIds: ["u2"],
          addCcEmails: ["carol@x.io"],
          removeCcUserIds: ["u3"],
        },
      },
    );
    assert.deepEqual(
      await capture("update-workflow-execution-assignees", { workflowExecutionId: "ex1", assignee: "u9" }),
      { path: "/api/mcp/update_workflow_execution_assignees", body: { workflowExecutionId: "ex1", assigneeUserId: "u9" } },
    );
    assert.deepEqual(await capture("list-workflow-executions", { assignedToMeOnly: true, pendingApprovalOnly: true }), {
      path: "/api/mcp/list_workflow_executions",
      body: { pendingApprovalOnly: true, assignedToMeOnly: true },
    });
  });

  it("adds public backend / ingress hosts to project credentials", async () => {
    const saved = { ...process.env };
    try {
      delete process.env.TESTCHIMP_PUBLIC_BACKEND_URL;
      delete process.env.TESTCHIMP_PUBLIC_INGRESS_URL;
      delete process.env.TESTCHIMP_INGRESS_URL;
      process.env.TESTCHIMP_BACKEND_URL = "https://featureservice-staging.testchimp.io/";
      const ctx = { postMcp: async () => JSON.stringify({ projectId: "p1", projectApiKey: "fake-key" }) };
      assert.deepEqual(JSON.parse(await runTool("get-project-credentials", {}, ctx)), {
        projectId: "p1",
        projectApiKey: "fake-key",
        backendUrl: "https://featureservice-staging.testchimp.io",
        ingressUrl: "https://ingress-staging.testchimp.io",
      });

      process.env.TESTCHIMP_BACKEND_URL = "http://featureservice.internal:8080";
      process.env.TESTCHIMP_PUBLIC_BACKEND_URL = "https://tc.example.com/api";
      process.env.TESTCHIMP_PUBLIC_INGRESS_URL = "https://ingress.example.com";
      const out = JSON.parse(await runTool("get-project-credentials", {}, ctx));
      assert.equal(out.backendUrl, "https://tc.example.com/api");
      assert.equal(out.ingressUrl, "https://ingress.example.com");

      delete process.env.TESTCHIMP_PUBLIC_BACKEND_URL;
      delete process.env.TESTCHIMP_PUBLIC_INGRESS_URL;
      const internal = JSON.parse(await runTool("get-project-credentials", {}, ctx));
      assert.equal(internal.backendUrl, "http://featureservice.internal:8080");
      assert.equal("ingressUrl" in internal, false);

      process.env.TESTCHIMP_INGRESS_URL = "http://ingress.internal:8080";
      process.env.TESTCHIMP_PUBLIC_BACKEND_URL = "https://featureservice.testchimp.io";
      const publicOnly = JSON.parse(await runTool("get-project-credentials", {}, ctx));
      assert.equal(publicOnly.ingressUrl, "https://ingress.testchimp.io");

      const raw = await runTool("get-project-credentials", {}, { postMcp: async () => "not json" });
      assert.equal(raw, "not json");
    } finally {
      process.env = saved;
    }
  });

  it("registers a bot profile with default filter op", async () => {
    assert.deepEqual(
      await capture("register-bot-profile", {
        role: "QA_ENGINEER",
        responsibilities: " checkout flows ",
        capabilities: ["E2E_AUTHORING", "TEST_BATCH_FIX"],
        subscriptions: [
          { eventType: "git-push", filters: [{ field: "author", value: "me" }] },
          { eventType: "e2e-batch-completed" },
        ],
      }),
      {
        path: "/bots/register_profile",
        body: {
          role: "QA_ENGINEER",
          responsibilities: "checkout flows",
          capabilities: ["E2E_AUTHORING", "TEST_BATCH_FIX"],
          subscriptions: [
            { eventType: "git-push", filters: [{ field: "author", op: "eq", value: "me" }] },
            { eventType: "e2e-batch-completed", filters: [] },
          ],
        },
      },
    );
    await assert.rejects(capture("register-bot-profile", { role: "CEO" }), /Invalid input/);
  });

  it("approves an AgentWatch pairing code", async () => {
    const pairingCode = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    assert.deepEqual(await capture("approve-agentwatch-pairing", { pairingCode: ` ${pairingCode} ` }), {
      path: "/bots/approve_agentwatch_pairing",
      body: { pairingCode },
    });
    await assert.rejects(capture("approve-agentwatch-pairing", { pairingCode: "short" }), /Invalid input/);
  });
});

describe("send-feedback", () => {
  async function capture(args: Record<string, unknown>) {
    let request: { path: string; body: unknown } | undefined;
    await runTool("send-feedback", args, {
      postMcp: async (path, body) => {
        request = { path, body };
        return "{}";
      },
    });
    return request;
  }

  it("maps the category to the proto enum and trims fields", async () => {
    assert.deepEqual(
      await capture({
        category: "USER_STRUGGLE",
        message: " Could not find the webhook key ",
        context: " bot onboarding step 5 ",
        agentName: " Grok QA bot ",
      }),
      {
        path: "/api/mcp/send_feedback",
        body: {
          category: "AGENT_FEEDBACK_CATEGORY_USER_STRUGGLE",
          message: "Could not find the webhook key",
          context: "bot onboarding step 5",
          agentName: "Grok QA bot",
        },
      },
    );
  });

  it("defaults the category to OTHER and requires a message", async () => {
    assert.deepEqual(await capture({ message: "hi" }), {
      path: "/api/mcp/send_feedback",
      body: { category: "AGENT_FEEDBACK_CATEGORY_OTHER", message: "hi" },
    });
    await assert.rejects(capture({ message: "  " }), /Invalid input/);
    await assert.rejects(capture({ message: "x", category: "PRAISE" }), /Invalid input/);
  });
});

describe("TESTCHIMP_USER_ID env fallback", () => {
  const reportArgs = {
    workflowId: "wf-1",
    workflowExecutionId: "exec-1",
    gitSha: "abc123",
    entityType: "SCENARIO",
    entityIdentity: "SC-1",
    actionType: "CREATED",
  };

  async function reportBody(args: Record<string, unknown>) {
    let body: Record<string, unknown> | undefined;
    await runTool("report-agent-action", args, {
      postMcp: async (_path, b) => {
        body = b as Record<string, unknown>;
        return "{}";
      },
    });
    return body!;
  }

  async function withEnvUser<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.TESTCHIMP_USER_ID;
    process.env.TESTCHIMP_USER_ID = "env-user";
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.TESTCHIMP_USER_ID;
      else process.env.TESTCHIMP_USER_ID = prev;
    }
  }

  it("report-agent-action skips env userId in isolated HTTP mode", async () => {
    await withEnvUser(async () => {
      const body = await runWithRequestAuth({ isolated: true, bearerToken: "t" }, () => reportBody(reportArgs));
      assert.equal(body.userId, undefined);
    });
  });

  it("report-agent-action applies env userId outside isolated mode", async () => {
    await withEnvUser(async () => {
      assert.equal((await reportBody(reportArgs)).userId, "env-user");
      const body = await runWithRequestAuth({ isolated: false }, () => reportBody(reportArgs));
      assert.equal(body.userId, "env-user");
    });
  });

  it("explicit userId always wins", async () => {
    await withEnvUser(async () => {
      const body = await runWithRequestAuth({ isolated: true, bearerToken: "t" }, () =>
        reportBody({ ...reportArgs, userId: "arg-user" }),
      );
      assert.equal(body.userId, "arg-user");
    });
  });

  it("agent traceability payload skips env userId in isolated mode", async () => {
    await withEnvUser(async () => {
      const fields = { workflowId: "wf-1", gitSha: "abc123" };
      assert.equal(buildAgentTraceabilityPayload(fields)?.userId, "env-user");
      const isolated = runWithRequestAuth({ isolated: true, bearerToken: "t" }, () =>
        buildAgentTraceabilityPayload(fields),
      );
      assert.equal(isolated?.userId, undefined);
      assert.equal(isolated?.workflowId, "wf-1");
    });
  });
});
