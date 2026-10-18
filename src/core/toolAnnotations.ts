/**
 * MCP tool annotations advertised on tools/list.
 *
 * Spec defaults (readOnlyHint=false, destructiveHint=true, idempotentHint=false,
 * openWorldHint=true) are unsafe to omit, so every registered tool fills title
 * plus all four hints. Read-only tools still set destructiveHint=false so clients
 * do not inherit the spec default of true.
 */

export interface ToolAnnotationsHints {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

function readOnly(title: string, openWorldHint = false): ToolAnnotationsHints {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint,
  };
}

function mutating(
  title: string,
  opts: { destructive?: boolean; idempotent?: boolean; openWorld?: boolean } = {},
): ToolAnnotationsHints {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: opts.destructive ?? false,
    idempotentHint: opts.idempotent ?? false,
    openWorldHint: opts.openWorld ?? false,
  };
}

/** Complete annotations for every tool in TOOL_DEFINITIONS, keyed by kebab-case name. */
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotationsHints> = {
  "get-org-capabilities": readOnly("Get Org Capabilities"),
  "get-requirement-coverage": readOnly("Get Requirement Coverage"),
  "get-execution-history": readOnly("Get Execution History"),
  "get-suite-execution-stats": readOnly("Get Suite Execution Stats"),
  "fetch-execution-report": readOnly("Fetch Execution Report"),
  "create-user-story": mutating("Create User Story"),
  "create-test-scenario": mutating("Create Test Scenario"),
  "update-user-story": mutating("Update User Story", { destructive: true, idempotent: true }),
  "update-test-scenario": mutating("Update Test Scenario", { destructive: true, idempotent: true }),
  "get-user-stories": readOnly("Get User Stories"),
  "get-test-scenarios": readOnly("Get Test Scenarios"),
  "list-test-scenarios-for-scope": readOnly("List Test Scenarios For Scope"),
  "get-manual-session-details": readOnly("Get Manual Session Details"),
  "get-meeting-transcript": readOnly("Get Meeting Transcript"),
  "get-meeting-set": readOnly("Get Meeting Set"),
  "list-meetings": readOnly("List Meetings"),
  "list-meeting-filter-options": readOnly("List Meeting Filter Options"),
  "get-issue-details": readOnly("Get Issue Details"),
  "update-issue-status": mutating("Update Issue Status", { idempotent: true }),
  "create-issue": mutating("Create Issue"),
  "mark-plan-items-implementation-done": mutating("Mark Plan Items Implementation Done", { idempotent: true }),
  "update-plan-items-lifecycle-status": mutating("Update Plan Items Lifecycle Status", { idempotent: true }),
  "get-spec-lifecycle-details": readOnly("Get Spec Lifecycle Details"),
  "get-eaas-config": readOnly("Get EaaS Config"),
  "get-branch-specific-endpoint-config": readOnly("Get Branch Specific Endpoint Config"),
  "provision-ephemeral-environment-and-wait": mutating("Provision Ephemeral Environment And Wait", {
    openWorld: true,
  }),
  "provision-ephemeral-environment": mutating("Provision Ephemeral Environment", { openWorld: true }),
  "get-ephemeral-environment-status": readOnly("Get Ephemeral Environment Status", true),
  "destroy-ephemeral-environment": mutating("Destroy Ephemeral Environment", {
    destructive: true,
    openWorld: true,
  }),
  "list-bunnyshell-environment-events": readOnly("List BunnyShell Environment Events", true),
  "list-bunnyshell-workflow-jobs": readOnly("List BunnyShell Workflow Jobs", true),
  "get-bunnyshell-workflow-job-logs": readOnly("Get BunnyShell Workflow Job Logs", true),
  "list-rum-environments": readOnly("List RUM Environments"),
  "get-truecoverage-events": readOnly("Get TrueCoverage Events"),
  "get-truecoverage-event-details": readOnly("Get TrueCoverage Event Details"),
  "get-truecoverage-child-event-tree": readOnly("Get TrueCoverage Child Event Tree"),
  "get-truecoverage-event-transition": readOnly("Get TrueCoverage Event Transition"),
  "get-truecoverage-event-time-series": readOnly("Get TrueCoverage Event Time Series"),
  "get-truecoverage-session-metadata-keys": readOnly("Get TrueCoverage Session Metadata Keys"),
  "get-truecoverage-event-metadata-keys": readOnly("Get TrueCoverage Event Metadata Keys"),
  "list-screen-states": readOnly("List Screen States"),
  "get-release": readOnly("Get Release"),
  "get-release-details": readOnly("Get Release Details"),
  "get-security-scan-config": readOnly("Get Security Scan Config"),
  "update-scan-progress": mutating("Update Scan Progress", { idempotent: true }),
  "report-dast-findings": mutating("Report DAST Findings"),
  "report-sast-findings": mutating("Report SAST Findings"),
  "report-secrets-findings": mutating("Report Secrets Findings"),
  "report-deps-findings": mutating("Report Deps Findings"),
  "upsert-screen-states": mutating("Upsert Screen States", { idempotent: true }),
  "list-semantic-similar-tests": readOnly("List Semantic Similar Tests"),
  "mark-semantic-tests-distinct": mutating("Mark Semantic Tests Distinct", { idempotent: true }),
  "mark-tests-for-review": mutating("Mark Tests For Review"),
  "list-semantic-nearby": readOnly("List Semantic Nearby"),
  "mark-entity-distinct": mutating("Mark Entity Distinct", { idempotent: true }),
  "unmark-entity-distinct": mutating("Unmark Entity Distinct", { destructive: true, idempotent: true }),
  "get-requirement-quality-report": readOnly("Get Requirement Quality Report"),
  "report-requirement-quality-findings": mutating("Report Requirement Quality Findings"),
  "report-agent-action": mutating("Report Agent Action"),
  "get-last-run-workflow-detail": readOnly("Get Last Run Workflow Detail"),
  "list-workflow-executions": readOnly("List Workflow Executions"),
  "update-workflow-execution-assignees": mutating("Update Workflow Execution Assignees", { idempotent: true }),
  "get-workflow-execution": readOnly("Get Workflow Execution"),
  "get-policy": readOnly("Get Policy"),
  "list-policies": readOnly("List Policies"),
  "upsert-policy": mutating("Upsert Policy", { destructive: true, idempotent: true }),
  "upsert-plans-support-file": mutating("Upsert Plans Support File", { destructive: true, idempotent: true }),
  "get-plans-support-file": readOnly("Get Plans Support File"),
  "list-workflow-catalog": readOnly("List Workflow Catalog"),
  "list-api-operation-services": readOnly("List API Operation Services"),
  "list-api-operations": readOnly("List API Operations"),
  "get-api-operation-detail": readOnly("Get API Operation Detail"),
  "list-perf-runs": readOnly("List Perf Runs"),
  "get-perf-run": readOnly("Get Perf Run"),
  "list-perf-baselines": readOnly("List Perf Baselines"),
  "promote-perf-baseline": mutating("Promote Perf Baseline", { destructive: true, idempotent: true }),
  "compare-perf-to-baseline": readOnly("Compare Perf To Baseline"),
  "get-project-init-status": readOnly("Get Project Init Status"),
  "update-project-init-status": mutating("Update Project Init Status", { idempotent: true }),
  "get-git-folder-mapping": readOnly("Get Git Folder Mapping"),
  "update-git-folder-mapping": mutating("Update Git Folder Mapping", { destructive: true, idempotent: true }),
  "invite-team-members": mutating("Invite Team Members"),
  "list-related-perf-tests": readOnly("List Related Perf Tests"),
  "list-api-operation-interactions": readOnly("List API Operation Interactions"),
  "upload-attachment": mutating("Upload Attachment"),
  "get-batch-view-url": readOnly("Get Batch View URL"),
  "get-my-tasks": readOnly("Get My Tasks"),
  "list-tests-awaiting-verification": readOnly("List Tests Awaiting Verification"),
  "get-qa-posture": readOnly("Get QA Posture"),
  "get-bot-compat": readOnly("Get Bot Compat"),
  "get-bot-credentials": readOnly("Get Bot Credentials"),
  "get-project-credentials": readOnly("Get Project Credentials"),
  "save-workspace-creds": mutating("Save Workspace Creds", { idempotent: true }),
  "get-bot-profile": readOnly("Get Bot Profile"),
  "register-bot-profile": mutating("Register Bot Profile", { destructive: true, idempotent: true }),
  "approve-agentwatch-pairing": mutating("Approve AgentWatch Pairing", { idempotent: true }),
  "send-feedback": mutating("Send Feedback"),
  "ack-bot-events": mutating("Ack Bot Events", { idempotent: true }),
};

const REQUIRED_HINT_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

export function annotationsForTool(kebab: string): ToolAnnotationsHints {
  const annotations = TOOL_ANNOTATIONS[kebab];
  if (!annotations) {
    throw new Error(`Missing MCP tool annotations for ${kebab}`);
  }
  if (typeof annotations.title !== "string" || annotations.title.trim() === "") {
    throw new Error(`MCP tool annotations for ${kebab} are missing title`);
  }
  for (const key of REQUIRED_HINT_KEYS) {
    if (typeof annotations[key] !== "boolean") {
      throw new Error(`MCP tool annotations for ${kebab} are missing ${key}`);
    }
  }
  return annotations;
}
