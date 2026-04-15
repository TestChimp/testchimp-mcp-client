/**
 * Poll TestChimp MCP EaaS endpoints until BunnyShell reports deployed + component URLs,
 * or a terminal failure / timeout. See plan: provision_ephemeral_environment_and_wait.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ProvisionWaitArgs {
  branchName?: string;
  pollIntervalSeconds?: number;
  maxWaitMinutes?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "";
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function componentUrlsNonEmpty(componentUrlsJson: string): boolean {
  const t = componentUrlsJson.trim();
  if (!t) return false;
  try {
    const v = JSON.parse(t) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    return Object.keys(v as Record<string, unknown>).length > 0;
  } catch {
    return false;
  }
}

/** True if BNS / aggregate status indicates we should stop polling with failure (deploy phase). */
function isTerminalDeployFailure(
  aggregateStatus: string,
  operationStatus: string,
  clusterStatus: string
): boolean {
  const ag = aggregateStatus.toLowerCase().trim();
  if (ag === "deployed") return false;

  const op = operationStatus.toLowerCase();
  const cl = clusterStatus.toLowerCase();

  if (op.includes("deploying") || op.includes("in_progress") || op.includes("in progress")) {
    return false;
  }

  const bad = /\b(fail|failed|failure|error|deleted)\b/;
  if (bad.test(op) || bad.test(cl) || bad.test(ag)) return true;

  return false;
}

function lastStatusSnapshot(obj: Record<string, unknown>): Record<string, unknown> {
  return {
    status: pickStr(obj, "status", "Status"),
    operationStatus: pickStr(obj, "operationStatus", "operation_status"),
    clusterStatus: pickStr(obj, "clusterStatus", "cluster_status"),
    environmentType: pickStr(obj, "environmentType", "environment_type"),
    dashboardUrl: pickStr(obj, "dashboardUrl", "dashboard_url"),
  };
}

async function logInfo(server: McpServer, message: string): Promise<void> {
  try {
    await server.sendLoggingMessage({
      level: "info",
      data: message,
    });
  } catch {
    // Client may not support logging; ignore.
  }
}

export async function runProvisionEphemeralEnvironmentAndWait(
  postMcp: (path: string, body: unknown) => Promise<string>,
  server: McpServer,
  args: ProvisionWaitArgs
): Promise<string> {
  const pollIntervalSec = clamp(Math.round(args.pollIntervalSeconds ?? 60), 30, 120);
  const maxWaitMin = clamp(Math.round(args.maxWaitMinutes ?? 25), 5, 45);
  const deadline = Date.now() + maxWaitMin * 60 * 1000;
  const intervalMs = pollIntervalSec * 1000;

  const provisionBody: Record<string, unknown> = {};
  if (args.branchName != null && args.branchName.trim() !== "") {
    provisionBody.branchName = args.branchName.trim();
  }

  let bnsEnvironmentId = "";
  let branch = "";
  let provisionRaw = "";

  try {
    provisionRaw = await postMcp("/api/mcp/provision_ephemeral_environment", provisionBody);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return JSON.stringify({
      outcome: "failed",
      failure_phase: "provision",
      message: `Could not start ephemeral environment (create/deploy trigger failed). ${errMsg}`,
      bns_environment_id: "",
      branch: "",
      component_urls_json: "",
      last_status: {},
    });
  }

  const prov = parseJsonObject(provisionRaw);
  bnsEnvironmentId = pickStr(prov, "bnsEnvironmentId", "bns_environment_id");
  branch = pickStr(prov, "branch", "branch_name");

  if (!bnsEnvironmentId) {
    return JSON.stringify({
      outcome: "failed",
      failure_phase: "provision",
      message:
        "Provision response did not include bns_environment_id. Check BunnyShell + GitHub integration and project EaaS settings.",
      bns_environment_id: "",
      branch,
      component_urls_json: "",
      last_status: prov,
    });
  }

  await logInfo(
    server,
    `Ephemeral env provision started (bns=${bnsEnvironmentId}, branch=${branch || "?"}). Polling up to ${maxWaitMin} min, every ${pollIntervalSec}s.`
  );

  let pollIndex = 0;
  let lastSnapshot: Record<string, unknown> = {};
  let lastComponentUrlsJson = "";
  let lastDashboardUrl = "";

  while (Date.now() < deadline) {
    pollIndex += 1;
    let statusRaw: string;
    try {
      statusRaw = await postMcp("/api/mcp/get_ephemeral_environment_status", {
        bnsEnvironmentId,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return JSON.stringify({
        outcome: "failed",
        failure_phase: "deploy",
        message: `Status check failed while waiting for deployment: ${errMsg}`,
        bns_environment_id: bnsEnvironmentId,
        branch,
        component_urls_json: "",
        last_status: lastSnapshot,
      });
    }

    const st = parseJsonObject(statusRaw);
    lastSnapshot = lastStatusSnapshot(st);

    const aggregateStatus = pickStr(st, "status", "Status");
    const operationStatus = pickStr(st, "operationStatus", "operation_status");
    const clusterStatus = pickStr(st, "clusterStatus", "cluster_status");
    const componentUrlsJson = pickStr(st, "componentUrlsJson", "component_urls_json");
    const dashboardUrl = pickStr(st, "dashboardUrl", "dashboard_url");
    lastComponentUrlsJson = componentUrlsJson;
    lastDashboardUrl = dashboardUrl;

    await logInfo(
      server,
      `Ephemeral env poll ${pollIndex}: status=${aggregateStatus} op=${operationStatus} cluster=${clusterStatus} bns=${bnsEnvironmentId}`
    );

    const deployed = aggregateStatus.toLowerCase() === "deployed";
    const urlsOk = componentUrlsNonEmpty(componentUrlsJson);

    if (deployed && urlsOk) {
      return JSON.stringify({
        outcome: "success",
        message: "Ephemeral environment is deployed and component URLs are available.",
        bns_environment_id: bnsEnvironmentId,
        branch,
        dashboard_url: dashboardUrl,
        component_urls_json: componentUrlsJson,
        ready_for_seeding: true,
        last_status: lastSnapshot,
      });
    }

    if (deployed && !urlsOk) {
      return JSON.stringify({
        outcome: "success",
        message:
          "Environment reports deployed but component URL map is empty or missing; check BunnyShell definition or dashboard.",
        warnings: ["component_urls_json_empty_or_unparsed"],
        bns_environment_id: bnsEnvironmentId,
        branch,
        dashboard_url: dashboardUrl,
        component_urls_json: componentUrlsJson,
        ready_for_seeding: false,
        last_status: lastSnapshot,
      });
    }

    if (isTerminalDeployFailure(aggregateStatus, operationStatus, clusterStatus)) {
      return JSON.stringify({
        outcome: "failed",
        failure_phase: "deploy",
        message: `BunnyShell deployment did not succeed (status=${aggregateStatus}, operation=${operationStatus}, cluster=${clusterStatus}).`,
        bns_environment_id: bnsEnvironmentId,
        branch,
        dashboard_url: dashboardUrl,
        component_urls_json: componentUrlsJson,
        last_status: lastSnapshot,
      });
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const sleepMs = Math.min(intervalMs, remainingMs);
    await sleep(sleepMs);
  }

  return JSON.stringify({
    outcome: "timeout",
    failure_phase: "wait",
    message: `Timed out after ${maxWaitMin} minutes waiting for ephemeral environment ${bnsEnvironmentId} to become ready.`,
    bns_environment_id: bnsEnvironmentId,
    branch,
    dashboard_url: lastDashboardUrl,
    component_urls_json: lastComponentUrlsJson,
    last_status: lastSnapshot,
  });
}
