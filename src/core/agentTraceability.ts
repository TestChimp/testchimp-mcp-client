import { resolveGitHeadSha } from "./gitSha.js";

/** Flat CLI/MCP fields that map to AgentActionTraceability. */
export type AgentTraceabilityFields = {
  workflowId?: string;
  workflowExecutionId?: string;
  policyFile?: string;
  policyVersion?: string;
  gitSha?: string;
  actorType?: string;
  userId?: string;
  branchName?: string;
  agentModel?: string;
  /** Nested form (wins over flat when both present and non-empty). */
  agentTraceability?: Record<string, unknown>;
};

function nonEmptyString(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function hasExplicitTraceabilityIntent(a: AgentTraceabilityFields): boolean {
  if (nonEmptyString(a.workflowId)) return true;
  if (nonEmptyString(a.workflowExecutionId)) return true;
  if (nonEmptyString(a.policyFile)) return true;
  if (nonEmptyString(a.policyVersion)) return true;
  if (nonEmptyString(a.gitSha)) return true;
  if (nonEmptyString(a.actorType)) return true;
  if (nonEmptyString(a.userId)) return true;
  if (nonEmptyString(a.branchName)) return true;
  if (nonEmptyString(a.agentModel)) return true;
  if (a.agentTraceability && typeof a.agentTraceability === "object") {
    return Object.keys(a.agentTraceability).some(
      (k) => nonEmptyString((a.agentTraceability as Record<string, unknown>)[k]) != null,
    );
  }
  return false;
}

function normalizeActorType(raw: unknown): "LOCAL_AGENT" | "CLOUD_AGENT" | undefined {
  if (raw == null) return undefined;
  const s = String(raw).toUpperCase().replace(/-/g, "_");
  if (s === "CLOUD_AGENT") return "CLOUD_AGENT";
  if (s === "LOCAL_AGENT") return "LOCAL_AGENT";
  return undefined;
}

/**
 * Build camelCase AgentActionTraceability for MCP JSON bodies.
 * Returns undefined unless the caller supplied explicit traceability intent
 * **and** a non-empty workflowId (server requires workflow_id for inline Activity).
 * Auto-fills gitSha / agentModel / userId only after that bar is met.
 * Non-empty nested `agentTraceability` wins over flat for overlapping keys.
 */
export function buildAgentTraceabilityPayload(
  a: AgentTraceabilityFields,
): Record<string, unknown> | undefined {
  if (!hasExplicitTraceabilityIntent(a)) {
    return undefined;
  }

  const nested =
    a.agentTraceability &&
    typeof a.agentTraceability === "object" &&
    Object.keys(a.agentTraceability).some(
      (k) => nonEmptyString((a.agentTraceability as Record<string, unknown>)[k]) != null,
    )
      ? { ...a.agentTraceability }
      : null;

  const out: Record<string, unknown> = {};

  const workflowId = nonEmptyString(nested?.workflowId) ?? nonEmptyString(a.workflowId);
  const workflowExecutionId =
    nonEmptyString(nested?.workflowExecutionId) ?? nonEmptyString(a.workflowExecutionId);
  const policyFile = nonEmptyString(nested?.policyFile) ?? nonEmptyString(a.policyFile);
  const policyVersion = nonEmptyString(nested?.policyVersion) ?? nonEmptyString(a.policyVersion);
  const gitShaExplicit = nonEmptyString(nested?.gitSha) ?? nonEmptyString(a.gitSha);
  const actorType =
    normalizeActorType(nested?.actorType) ?? normalizeActorType(a.actorType);
  const userId =
    nonEmptyString(nested?.userId) ??
    nonEmptyString(a.userId) ??
    nonEmptyString(process.env.TESTCHIMP_USER_ID);
  const branchName = nonEmptyString(nested?.branchName) ?? nonEmptyString(a.branchName);
  const agentModel =
    nonEmptyString(nested?.agentModel) ??
    nonEmptyString(a.agentModel) ??
    nonEmptyString(process.env.TESTCHIMP_AGENT_MODEL);

  // Server requires workflow_id for inline mutation Activity — do not send orphan payloads.
  if (!workflowId) {
    return undefined;
  }

  out.workflowId = workflowId;
  if (workflowExecutionId) out.workflowExecutionId = workflowExecutionId;
  if (policyFile) out.policyFile = policyFile;
  if (policyVersion) out.policyVersion = policyVersion;
  const gitSha = resolveGitHeadSha(gitShaExplicit);
  if (gitSha) out.gitSha = gitSha;
  if (actorType) out.actorType = actorType;
  if (userId) out.userId = userId;
  if (branchName) out.branchName = branchName;
  if (agentModel) out.agentModel = agentModel;

  return out;
}
