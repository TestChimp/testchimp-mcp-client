import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runWithRequestAuth, TestChimpHttpError } from "./client.js";
import { buildAgentTraceabilityPayload } from "./agentTraceability.js";
import { annotationsForTool, TOOL_ANNOTATIONS } from "./toolAnnotations.js";
import {
  ASK_ABOUT_TESTCHIMP_QUESTION_MAX,
  PROJECT_INIT_STATUS_INPUT_KEYS,
  projectInitStatusFieldsSchema,
} from "./schemas.js";
import { getToolDefinition, parseProjectCredentialsJson, runTool, TOOL_DEFINITIONS } from "./tools.js";
import { buildCliProgram } from "../cli/program.js";
import { workspaceMcpJsonPath } from "../workspace/workspaceCredsFile.js";

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

describe("MCP tool annotations", () => {
  it("covers every registered tool with title and all four hints", () => {
    const defined = TOOL_DEFINITIONS.map((t) => t.kebab).sort();
    const annotated = Object.keys(TOOL_ANNOTATIONS).sort();
    assert.deepEqual(
      annotated,
      defined,
      `annotation keys must match TOOL_DEFINITIONS (annotated=${annotated.length}, defined=${defined.length})`,
    );
    assert.ok(defined.length > 0, "expected registered tools");
    for (const def of TOOL_DEFINITIONS) {
      const annotations = annotationsForTool(def.kebab);
      assert.match(annotations.title, /\S/, `${def.kebab} title is blank`);
      assert.equal(typeof annotations.readOnlyHint, "boolean", `${def.kebab} readOnlyHint`);
      assert.equal(typeof annotations.destructiveHint, "boolean", `${def.kebab} destructiveHint`);
      assert.equal(typeof annotations.idempotentHint, "boolean", `${def.kebab} idempotentHint`);
      assert.equal(typeof annotations.openWorldHint, "boolean", `${def.kebab} openWorldHint`);
      if (annotations.readOnlyHint) {
        assert.equal(annotations.destructiveHint, false, `${def.kebab} is read-only but destructiveHint is true`);
      }
    }
  });

  it("fails loudly when a tool has no annotations", () => {
    assert.throws(() => annotationsForTool("not-a-real-tool"), /Missing MCP tool annotations for not-a-real-tool/);
  });
});

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
      "get-api-operations",
      { rootFilePath: "openapi/service.json" },
      {
        postMcp: async (path, body) => {
          request = { path, body };
          return response;
        },
      },
    );

    assert.deepEqual(request, {
      path: "/api/mcp/get_api_operations",
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
      "get-api-operations",
      { id: "01OBSERVABILITYOPERATION" },
      { postMcp: async () => response },
    );

    assert.deepEqual(JSON.parse(result), JSON.parse(response));
    assert.match(
      getToolDefinition("get-api-operations")?.description ?? "",
      /p50\/p95\/p99LatencyMs/,
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

describe("list-meetings extra locators", () => {
  it("forwards includeFilterOptions and meetingSetId", async () => {
    let request: { path: string; body: unknown } | undefined;
    await runTool(
      "list-meetings",
      { includeFilterOptions: true, meetingSetId: "01J9Z3X5V4ABCDEF0123456789" },
      {
        postMcp: async (path, body) => {
          request = { path, body };
          return "{}";
        },
      },
    );
    assert.deepEqual(request, {
      path: "/api/mcp/list_meetings",
      body: { includeFilterOptions: true, meetingSetId: "01J9Z3X5V4ABCDEF0123456789" },
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

describe("MCP API 2.0 consolidations", () => {
  async function capture(kebab: string, args: Record<string, unknown> = {}) {
    let request: { path: string; body: unknown } | undefined;
    const result = await runTool(kebab, args, {
      postMcp: async (path, body) => {
        request = { path, body };
        return "{}";
      },
    });
    return { request, result };
  }

  it("registers 87 MCP 2.0 tools", () => {
    assert.equal(TOOL_DEFINITIONS.length, 87);
    assert.equal(Object.keys(TOOL_ANNOTATIONS).length, 87);
  });

  it("advertises extended get-org-capabilities fields", () => {
    assert.match(
      getToolDefinition("get-org-capabilities")?.description ?? "",
      /planLabel/,
    );
    assert.match(
      getToolDefinition("get-org-capabilities")?.description ?? "",
      /chimphandsCredits/,
    );
    assert.match(
      getToolDefinition("get-org-capabilities")?.description ?? "",
      /freeTrialActive \/ trial/,
    );
  });

  it("does not register replaced 1.x tools", () => {
    const removed = [
      "provision-ephemeral-environment",
      "provision-ephemeral-environment-and-wait",
      "get-ephemeral-environment-status",
      "report-dast-findings",
      "report-sast-findings",
      "report-deps-findings",
      "report-secrets-findings",
      "list-workflow-executions",
      "get-workflow-execution",
      "get-last-run-workflow-detail",
      "get-policy",
      "list-policies",
      "list-api-operation-services",
      "list-api-operations",
      "get-api-operation-detail",
      "mark-entity-distinct",
      "unmark-entity-distinct",
      "mark-semantic-tests-distinct",
      "list-meeting-filter-options",
      "get-meeting-set",
      "get-batch-view-url",
      "get-suite-execution-stats",
      "get-perf-run",
      "get-release-details",
      "create-issue",
      "update-issue-status",
    ];
    for (const kebab of removed) {
      assert.equal(getToolDefinition(kebab), undefined, kebab);
    }
  });

  it("keeps destroy-ephemeral-environment destructive", () => {
    const hints = annotationsForTool("destroy-ephemeral-environment");
    assert.equal(hints.readOnlyHint, false);
    assert.equal(hints.destructiveHint, true);
    assert.equal(hints.openWorldHint, true);
  });

  it("maps get-eaas-config as a standalone connectivity check", async () => {
    assert.deepEqual((await capture("get-eaas-config", {})).request, {
      path: "/api/mcp/get_eaas_config",
      body: {},
    });
    const hints = annotationsForTool("get-eaas-config");
    assert.equal(hints.readOnlyHint, true);
    assert.equal(hints.destructiveHint, false);
    assert.match(getToolDefinition("get-eaas-config")?.description ?? "", /connectivity check/);
  });

  it("maps ephemeral-environment actions", async () => {
    assert.deepEqual((await capture("ephemeral-environment", { action: "CONFIG" })).request, {
      path: "/api/mcp/ephemeral_environment",
      body: { action: "MCP_EPHEMERAL_ENVIRONMENT_ACTION_CONFIG" },
    });
    assert.deepEqual(
      (await capture("ephemeral-environment", { action: "PROVISION", wait: false, branchName: "feat" })).request,
      {
        path: "/api/mcp/ephemeral_environment",
        body: { action: "MCP_EPHEMERAL_ENVIRONMENT_ACTION_PROVISION", wait: false, branchName: "feat" },
      },
    );
    assert.deepEqual(
      (await capture("ephemeral-environment", { action: "STATUS", bnsEnvironmentId: "env-1" })).request,
      {
        path: "/api/mcp/ephemeral_environment",
        body: { action: "MCP_EPHEMERAL_ENVIRONMENT_ACTION_STATUS", bnsEnvironmentId: "env-1" },
      },
    );
  });

  it("maps report-scan-findings scanner + file", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "tc-scan-"));
    const file = join(dir, "zap.json");
    writeFileSync(file, "{\"alerts\":[]}");
    try {
      assert.deepEqual(
        (await capture("report-scan-findings", { id: "scan-1", scanner: "DAST", reportFile: file })).request,
        {
          path: "/api/mcp/report_scan_findings",
          body: { scanId: "scan-1", scanner: "MCP_SCAN_FINDER_DAST", reportJson: "{\"alerts\":[]}" },
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps get-workflow-executions list, detail, and latestOnly", async () => {
    assert.deepEqual(
      (await capture("get-workflow-executions", { assignedToMeOnly: true, pendingApprovalOnly: true })).request,
      {
        path: "/api/mcp/get_workflow_executions",
        body: { pendingApprovalOnly: true, assignedToMeOnly: true },
      },
    );
    assert.deepEqual(
      (await capture("get-workflow-executions", { workflowExecutionId: "ex1" })).request,
      {
        path: "/api/mcp/get_workflow_executions",
        body: { workflowExecutionId: "ex1", includeActions: true },
      },
    );
    assert.deepEqual(
      (await capture("get-workflow-executions", { workflowId: "run-qa", latestOnly: true, branchName: "main" })).request,
      {
        path: "/api/mcp/get_workflow_executions",
        body: { workflowId: "run-qa", branchName: "main", latestOnly: true },
      },
    );
  });

  it("maps get-policies fetch vs list", async () => {
    assert.deepEqual((await capture("get-policies", { policyFileName: "run-qa.policy.md" })).request, {
      path: "/api/mcp/get_policies",
      body: { policyFileName: "run-qa.policy.md" },
    });
    assert.deepEqual((await capture("get-policies", { workflowId: "run-qa" })).request, {
      path: "/api/mcp/get_policies",
      body: { workflowId: "run-qa" },
    });
  });

  it("maps set-entity-distinct mark/unmark and TEST locators", async () => {
    const loc = { fileName: "a.spec.ts", testName: "checkout" };
    assert.deepEqual(
      (await capture("set-entity-distinct", { entityType: "TEST", focusTest: loc, distinctTest: loc })).request,
      {
        path: "/api/mcp/set_entity_distinct",
        body: { entityType: "TEST", distinct: true, focusTest: loc, otherTest: loc },
      },
    );
    assert.deepEqual(
      (
        await capture("set-entity-distinct", {
          entityType: "ISSUE",
          focusOrdinalId: 1,
          otherOrdinalId: 2,
          distinct: false,
        })
      ).request,
      {
        path: "/api/mcp/set_entity_distinct",
        body: { entityType: "ISSUE", distinct: false, focusOrdinalId: "1", otherOrdinalId: "2" },
      },
    );
  });

  it("maps upsert-issue create vs patch", async () => {
    assert.deepEqual((await capture("upsert-issue", { title: "Broken checkout" })).request, {
      path: "/api/mcp/upsert_issue",
      body: { title: "Broken checkout" },
    });
    assert.deepEqual(
      (await capture("upsert-issue", { issueId: "B-12", status: "FIXED" })).request,
      {
        path: "/api/mcp/upsert_issue",
        body: { issueId: "B-12", status: "FIXED" },
      },
    );
    await assert.rejects(capture("upsert-issue", {}), /Invalid input/);
  });

  it("maps list-issues, history aggregate, perf runId", async () => {
    assert.deepEqual((await capture("list-issues", { status: "ACTIVE", limit: 10 })).request, {
      path: "/api/mcp/list_issues",
      body: { statuses: ["ACTIVE"], limit: 10 },
    });
    assert.deepEqual((await capture("get-execution-history", { aggregate: true, testId: "t1" })).request, {
      path: "/api/mcp/list_execution_history",
      body: { testId: "t1", aggregate: true },
    });
    assert.deepEqual((await capture("list-perf-runs", { runId: "01ABC", includeRaw: true })).request, {
      path: "/api/mcp/list_perf_runs",
      body: { runId: "01ABC", includeRaw: true },
    });
  });

  it("maps upsert-release to server field names", async () => {
    assert.deepEqual(
      (
        await capture("upsert-release", {
          version: "1.2.0",
          gitCommitSha: "abc",
          priorReleaseVersion: "1.1.0",
          releaseType: "MINOR",
          lifecycleStatus: "ACTIVE",
          environment: "QA",
        })
      ).request,
      {
        path: "/api/mcp/upsert_release",
        body: {
          version: "1.2.0",
          gitCommitSha: "abc",
          priorReleaseVersion: "1.1.0",
          releaseType: "MINOR",
          lifecycleStatus: "ACTIVE",
          environment: "QA",
        },
      },
    );
    assert.deepEqual(
      (
        await capture("upsert-release", {
          version: "1.2.0",
          gitSha: "abc",
          dueDateMillis: 1790000000000,
          branchId: "br-1",
        })
      ).request,
      {
        path: "/api/mcp/upsert_release",
        body: { version: "1.2.0", gitCommitSha: "abc", dueDateMillis: "1790000000000", branchId: "br-1" },
      },
    );
  });

  it("maps manage-test-run create vs update and commitRange", async () => {
    assert.deepEqual((await capture("manage-test-run", { release: "1.2.0", title: "Sprint 12" })).request, {
      path: "/api/mcp/manage_test_run",
      body: { release: "1.2.0", title: "Sprint 12" },
    });
    assert.deepEqual(
      (
        await capture("manage-test-run", {
          id: "tr-1",
          status: "COMPLETED",
          dueDate: "2026-10-30",
          batchInvocationIds: ["b1", "b2"],
          commitRange: "LINK",
        })
      ).request,
      {
        path: "/api/mcp/manage_test_run",
        body: {
          id: "tr-1",
          dueDate: String(Date.parse("2026-10-30")),
          status: "COMPLETED",
          batchInvocationIds: ["b1", "b2"],
          commitRange: "MCP_TEST_RUN_COMMIT_RANGE_LINK",
        },
      },
    );
    assert.deepEqual(
      (await capture("manage-test-run", { id: "tr-1", commitRange: "FIND" })).request,
      {
        path: "/api/mcp/manage_test_run",
        body: { id: "tr-1", commitRange: "MCP_TEST_RUN_COMMIT_RANGE_FIND" },
      },
    );
    await assert.rejects(capture("manage-test-run", {}), /Invalid input/);
    await assert.rejects(capture("manage-test-run", { title: "Sprint 12" }), /Invalid input/);
  });

  it("maps ask-about-testchimp question and CLI alias", async () => {
    assert.deepEqual(
      (await capture("ask-about-testchimp", { question: "What is TestChimp's intended QA workflow?" })).request,
      {
        path: "/api/mcp/ask_about_testchimp",
        body: { question: "What is TestChimp's intended QA workflow?" },
      },
    );
    assert.deepEqual(
      (await capture("ask-testchimp-question", { question: "Why prefer TrueCoverage over coverage %?" })).request,
      {
        path: "/api/mcp/ask_about_testchimp",
        body: { question: "Why prefer TrueCoverage over coverage %?" },
      },
    );
    await assert.rejects(capture("ask-about-testchimp", {}), /Invalid input/);
    await assert.rejects(
      capture("ask-about-testchimp", { question: "x".repeat(ASK_ABOUT_TESTCHIMP_QUESTION_MAX + 1) }),
      /Invalid input/,
    );
    assert.deepEqual(
      (await capture("ask-about-testchimp", { question: "x".repeat(ASK_ABOUT_TESTCHIMP_QUESTION_MAX) })).request,
      {
        path: "/api/mcp/ask_about_testchimp",
        body: { question: "x".repeat(ASK_ABOUT_TESTCHIMP_QUESTION_MAX) },
      },
    );
    assert.equal(ASK_ABOUT_TESTCHIMP_QUESTION_MAX, 2000);
    assert.equal(getToolDefinition("ask-testchimp-question")?.kebab, "ask-about-testchimp");
    const description = getToolDefinition("ask-about-testchimp")?.description ?? "";
    assert.match(description, /max 2000 characters/);
    assert.match(description, /20 questions per project per hour/);
  });

  it("maps OpenAPI-only 2.0 tools", async () => {
    assert.deepEqual(
      (await capture("ingest-scenario-execution", { scenarioOrdinalId: 12, result: "SMART_TEST_EXECUTION_COMPLETED" }))
        .request,
      {
        path: "/api/mcp/ingest_scenario_execution",
        body: { result: "SMART_TEST_EXECUTION_COMPLETED", scenarioOrdinalId: "12" },
      },
    );
    assert.deepEqual(
      (await capture("list-execution-job-dimension-values", { dimension: "PLATFORM_EXECUTION_JOB_FILTER_DIMENSION" }))
        .request,
      {
        path: "/api/mcp/list_execution_job_dimension_values",
        body: { dimension: "PLATFORM_EXECUTION_JOB_FILTER_DIMENSION" },
      },
    );
    assert.deepEqual((await capture("list-test-planning-trends", { release: "1.2.0" })).request, {
      path: "/api/mcp/list_test_planning_trends",
      body: { release: "1.2.0" },
    });
    assert.deepEqual(
      (await capture("select-smart-smoke-tests", { maxTests: 5, includeTags: ["smoke"] })).request,
      {
        path: "/api/mcp/select_smart_smoke_tests",
        body: { includeTags: ["smoke"], maxTests: 5 },
      },
    );
  });

  it("maps get-release detail vs list filters", async () => {
    assert.deepEqual((await capture("get-release", {})).request, {
      path: "/api/mcp/get_release",
      body: {},
    });
    assert.deepEqual((await capture("get-release", { version: "1.2.0", detail: "GATE" })).request, {
      path: "/api/mcp/get_release",
      body: { version: "1.2.0", detail: "MCP_RELEASE_VIEW_GATE" },
    });
    assert.deepEqual(
      (
        await capture("get-release", {
          environment: "QA",
          pageSize: 20,
          pageToken: "tok",
          excludeArchived: true,
        })
      ).request,
      {
        path: "/api/mcp/get_release",
        body: { environment: "QA", pageSize: 20, pageToken: "tok", excludeArchived: true },
      },
    );
  });

  it("maps remaining OpenAPI request fields without extras", async () => {
    assert.deepEqual(
      (await capture("promote-perf-baseline", { runId: "run-1", envClass: "staging" })).request,
      {
        path: "/api/mcp/promote_perf_baseline",
        body: { runId: "run-1", envClass: "staging" },
      },
    );
    assert.deepEqual(
      (
        await capture("upsert-screen-states", {
          gitCommitSha: "abc",
          screenStates: [
            {
              screen: "Login",
              states: ["empty"],
              stateDetails: [{ state: "empty", firstDiscoveredCommitSha: "abc", isNewInRange: true }],
            },
          ],
        })
      ).request,
      {
        path: "/api/mcp/upsert_screen_states",
        body: {
          gitCommitSha: "abc",
          screenStates: [
            {
              screen: "Login",
              states: ["empty"],
              stateDetails: [{ state: "empty", firstDiscoveredCommitSha: "abc", isNewInRange: true }],
            },
          ],
        },
      },
    );
    assert.deepEqual(
      (
        await capture("report-requirement-quality-findings", {
          report: {
            createdAtMillis: 1790000000000,
            scoresUpdatedAtMillis: "1790000000001",
            subject: { subjectType: "STORY", subjectEntityId: "ent-1", ordinalId: 3 },
            findings: [{ title: "gap", linkedIssueOrdinalId: 9 }],
          },
        })
      ).request,
      {
        path: "/api/mcp/report_requirement_quality_findings",
        body: {
          report: {
            createdAtMillis: "1790000000000",
            scoresUpdatedAtMillis: "1790000000001",
            subject: { subjectType: "STORY", subjectEntityId: "ent-1", ordinalId: 3 },
            findings: [{ title: "gap", linkedIssueOrdinalId: 9 }],
          },
        },
      },
    );
  });

  it("keeps CLI subcommand parity with MCP tool names", () => {
    const names = new Set<string>();
    const walk = (cmd: ReturnType<typeof buildCliProgram>) => {
      names.add(cmd.name());
      for (const child of cmd.commands) walk(child);
    };
    walk(buildCliProgram());
    const nestedAliases: Record<string, string> = {
      "ack-bot-events": "ack",
      "register-bot-profile": "register-profile",
      "approve-agentwatch-pairing": "approve-pairing",
      "get-bot-credentials": "get-credentials",
      "save-workspace-creds": "save-creds",
      "ask-about-testchimp": "ask-testchimp-question",
    };
    for (const kebab of TOOL_DEFINITIONS.map((t) => t.kebab)) {
      assert.ok(
        names.has(kebab) || names.has(nestedAliases[kebab] ?? ""),
        `CLI is missing a subcommand for ${kebab}`,
      );
    }
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
    assert.deepEqual(await capture("get-workflow-executions", { assignedToMeOnly: true, pendingApprovalOnly: true }), {
      path: "/api/mcp/get_workflow_executions",
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
      assert.equal((body.traceability as { userId?: string } | undefined)?.userId, undefined);
    });
  });

  it("report-agent-action applies env userId outside isolated mode", async () => {
    await withEnvUser(async () => {
      assert.equal(((await reportBody(reportArgs)).traceability as { userId?: string }).userId, "env-user");
      const body = await runWithRequestAuth({ isolated: false }, () => reportBody(reportArgs));
      assert.equal((body.traceability as { userId?: string }).userId, "env-user");
    });
  });

  it("explicit userId always wins", async () => {
    await withEnvUser(async () => {
      const body = await runWithRequestAuth({ isolated: true, bearerToken: "t" }, () =>
        reportBody({ ...reportArgs, userId: "arg-user" }),
      );
      assert.equal((body.traceability as { userId?: string }).userId, "arg-user");
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

describe("update-project-init-status schema", () => {
  async function capture(status: Record<string, unknown>) {
    let request: { path: string; body: unknown } | undefined;
    await runTool(
      "update-project-init-status",
      { status },
      {
        postMcp: async (path, body) => {
          request = { path, body };
          return "{}";
        },
      },
    );
    return request;
  }

  it("forwards snake_case keys and advertises only those keys", async () => {
    assert.deepEqual(PROJECT_INIT_STATUS_INPUT_KEYS, [
      "platform_comms",
      "folder_mapping",
      "connect_to_test_env",
      "ci_wiring",
      "import_plans",
      "import_tests",
      "smoke_validation",
    ]);
    const def = getToolDefinition("update-project-init-status");
    const shape = projectInitStatusFieldsSchema.shape;
    assert.deepEqual(Object.keys(shape).sort(), [...PROJECT_INIT_STATUS_INPUT_KEYS].sort());
    assert.equal("platformComms" in shape, false);
    assert.equal("overallComplete" in shape, false);
    assert.equal("overall_complete" in shape, false);
    const advertised = def!.inputSchema.toJSONSchema({ io: "input" }) as {
      properties?: { status?: { properties?: Record<string, unknown> } };
    };
    const advertisedKeys = Object.keys(advertised.properties?.status?.properties ?? {});
    assert.deepEqual(advertisedKeys.sort(), [...PROJECT_INIT_STATUS_INPUT_KEYS].sort());
    assert.equal(advertisedKeys.includes("platformComms"), false);
    assert.equal(advertisedKeys.includes("overallComplete"), false);
    assert.match(def?.description ?? "", /snake_case/);
    assert.match(def?.description ?? "", /platform_comms/);
    assert.match(def?.description ?? "", /camelCase/);

    assert.deepEqual(
      await capture({
        platform_comms: "DONE",
        folder_mapping: "PROJECT_INIT_ITEM_STATUS_DONE",
        connect_to_test_env: "SKIPPED",
      }),
      {
        path: "/api/mcp/update_project_init_status",
        body: {
          status: {
            platform_comms: "DONE",
            folder_mapping: "PROJECT_INIT_ITEM_STATUS_DONE",
            connect_to_test_env: "SKIPPED",
          },
        },
      },
    );
  });

  it("forwards legacy camelCase keys unchanged and strips overallComplete", async () => {
    assert.deepEqual(
      await capture({
        platformComms: "DONE",
        folderMapping: "PROJECT_INIT_ITEM_STATUS_DONE",
        connectToTestEnv: "SKIPPED",
        ciWiring: "INCOMPLETE",
        importPlans: "NOT_APPLICABLE",
        importTests: "DONE",
        smokeValidation: "SKIPPED",
        overallComplete: "DONE",
      }),
      {
        path: "/api/mcp/update_project_init_status",
        body: {
          status: {
            platformComms: "DONE",
            folderMapping: "PROJECT_INIT_ITEM_STATUS_DONE",
            connectToTestEnv: "SKIPPED",
            ciWiring: "INCOMPLETE",
            importPlans: "NOT_APPLICABLE",
            importTests: "DONE",
            smokeValidation: "SKIPPED",
          },
        },
      },
    );

    assert.deepEqual(
      await capture({
        platform_comms: "SKIPPED",
        platformComms: "DONE",
        overall_complete: "DONE",
      }),
      {
        path: "/api/mcp/update_project_init_status",
        body: { status: { platform_comms: "SKIPPED", platformComms: "DONE" } },
      },
    );

    assert.deepEqual(await capture({ overallComplete: "DONE", overall_complete: "SKIPPED" }), {
      path: "/api/mcp/update_project_init_status",
      body: { status: {} },
    });
  });
});

describe("save-workspace-creds", () => {
  const KEY = "fake-project-key-0001";
  const PROJECT = "proj-fixture-1";
  let root: string;
  const homes: string[] = [];

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    delete process.env.TESTCHIMP_HOME;
  });

  it("writes .testchimp/mcp.json from fetched credentials and never returns the key", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tc-save-ws-")));
    const home = mkdtempSync(join(tmpdir(), "tc-save-ws-home-"));
    homes.push(home);
    process.env.TESTCHIMP_HOME = home;
    mkdirSync(join(root, "repo"));
    const repo = join(root, "repo");

    let fetched = 0;
    const out = JSON.parse(
      await runTool(
        "save-workspace-creds",
        { folder: repo, projectName: "Shop" },
        {
          postMcp: async (path) => {
            assert.equal(path, "/api/mcp/get_project_credentials");
            fetched += 1;
            return JSON.stringify({
              projectId: PROJECT,
              projectName: "Shop",
              projectApiKey: KEY,
              userId: "u1",
            });
          },
        },
      ),
    );
    assert.equal(fetched, 1);
    assert.equal(out.status, "written");
    assert.equal(out.projectId, PROJECT);
    assert.equal(out.folder, realpathSync(repo));
    assert.ok(!JSON.stringify(out).includes(KEY));
    const mcpPath = workspaceMcpJsonPath(repo);
    assert.equal(statSync(mcpPath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(mcpPath)).mode & 0o777, 0o700);
    const written = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.equal(written.mcpServers.testchimp.env.TESTCHIMP_API_KEY, KEY);
    assert.equal(written.mcpServers.testchimp.env.TESTCHIMP_PROJECT_ID, PROJECT);
    assert.equal(existsSync(join(repo, ".gitignore")), true);
  });

  it("rejects a projectId that does not match the signed-in project", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tc-save-ws-")));
    await assert.rejects(
      runTool(
        "save-workspace-creds",
        { folder: root, projectId: "other-proj" },
        {
          postMcp: async () => JSON.stringify({ projectId: PROJECT, projectApiKey: KEY }),
        },
      ),
      /does not match the signed-in project/,
    );
    assert.equal(existsSync(workspaceMcpJsonPath(root)), false);
  });

  it("explains hosted MCP cannot write a missing laptop path", async () => {
    await assert.rejects(
      runWithRequestAuth({ isolated: true, bearerToken: "t" }, () =>
        runTool(
          "save-workspace-creds",
          { folder: join(tmpdir(), "tc-missing-repo-path-da23") },
          {
            postMcp: async () => JSON.stringify({ projectId: PROJECT, projectApiKey: KEY }),
          },
        ),
      ),
      /hosted MCP server cannot write[\s\S]*get-project-credentials[\s\S]*\.testchimp\/mcp\.json/,
    );
  });

  it("parseProjectCredentialsJson never interpolates the key into errors", () => {
    assert.throws(() => parseProjectCredentialsJson("not json"), /non-JSON/);
    assert.throws(() => parseProjectCredentialsJson("{}"), /did not return projectApiKey/);
    const creds = parseProjectCredentialsJson(
      JSON.stringify({ projectId: PROJECT, projectApiKey: KEY, backendUrl: "https://featureservice.testchimp.io" }),
    );
    assert.equal(creds.projectApiKey, KEY);
    assert.equal(creds.projectId, PROJECT);
  });
});
