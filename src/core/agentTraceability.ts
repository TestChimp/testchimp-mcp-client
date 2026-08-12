import { resolveGitHeadSha } from "./gitSha.js";
import { PACKAGE_VERSION } from "./version.js";

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
  skillVersion?: string;
  cliVersion?: string;
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
  if (nonEmptyString(a.skillVersion)) return true;
  if (nonEmptyString(a.cliVersion)) return true;
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
 * Resolve skill / CLI versions for traceability payloads.
 * CLI version defaults to this package's version; skill version from flag/env only.
 */
export function resolveToolchainVersions(a: {
  skillVersion?: string;
  cliVersion?: string;
  nested?: Record<string, unknown> | null;
}): { skillVersion?: string; cliVersion?: string } {
  const skillVersion =
    nonEmptyString(a.nested?.skillVersion) ??
    nonEmptyString(a.skillVersion) ??
    nonEmptyString(process.env.TESTCHIMP_SKILL_VERSION);
  const cliVersion =
    nonEmptyString(a.nested?.cliVersion) ??
    nonEmptyString(a.cliVersion) ??
    nonEmptyString(process.env.TESTCHIMP_CLI_VERSION) ??
    PACKAGE_VERSION;
  return { skillVersion, cliVersion };
}

/**
 * Build camelCase AgentActionTraceability for MCP JSON bodies.
 * Returns undefined unless the caller supplied explicit traceability intent
 * **and** a non-empty workflowId (server requires workflow_id for inline Activity).
 * For Activity/timeline attachment the server also requires workflowExecutionId
 * (stable Plan ULID for the whole run) — omit it and the mutation still succeeds
 * but no workflow_executions / Activity row is recorded (server does not auto-mint).
 * Auto-fills gitSha / agentModel / userId / cliVersion only after the workflowId bar is met.
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
  const { skillVersion, cliVersion } = resolveToolchainVersions({
    skillVersion: a.skillVersion,
    cliVersion: a.cliVersion,
    nested,
  });

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
  if (skillVersion) out.skillVersion = skillVersion;
  if (cliVersion) out.cliVersion = cliVersion;

  return out;
}
