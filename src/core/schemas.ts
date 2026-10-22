import { z } from "zod";

export const scopeSchema = z
  .object({
    filePaths: z.array(z.string()).optional(),
    folderPath: z.union([z.array(z.string()), z.string()]).optional(),
  })
  .optional();

const executionPlatformSchema = z.enum(["web", "ios", "android"]);

const requirementCoverageRecordTypeSchema = z.enum([
  "smart_test",
  "manual",
  "perf_test",
  "SMART_TEST",
  "MANUAL",
  "PERF_TEST",
]);

export const executionJobDimensionFilterSchema = z.object({
  dimension: z.string().min(1),
  values: z.array(z.string()).min(1),
});

export const listCoverageInput = z.object({
  release: z.string().optional(),
  environment: z.string().optional(),
  scope: scopeSchema,
  includeNonCoveredUserStories: z.boolean().optional(),
  includeNonCoveredTestScenarios: z.boolean().optional(),
  branchName: z.string().optional(),
  branchId: z.union([z.string().min(1), z.coerce.number()]).optional(),
  timeWindow: z
    .object({
      relativeWindow: z.string().optional(),
      fixedWindow: z.object({ startTime: z.string().min(1), endTime: z.string().min(1) }).optional(),
    })
    .optional(),
  platform: executionPlatformSchema.optional(),
  /**
   * Which coverage sources to include.
   *
   * Omit for legacy default: SMART_TEST only.
   * When provided, send proto enum names ("SMART_TEST", "MANUAL", "PERF_TEST")
   * or CLI-friendly aliases ("smart_test", "manual", "perf_test").
   */
  recordTypes: z.array(requirementCoverageRecordTypeSchema).optional(),
  /** Allowlist of scenario lifecycle statuses (e.g. ["ready"] or ["draft","ready"]). Empty/omit = no status filter. */
  scenarioLifecycleStatuses: z.array(z.string().min(1)).optional(),
  /** When set (>0), truncate rankedScenarios to top N after filter+rank (server clamps to 200). */
  limit: z.number().int().positive().max(200).optional(),
  /** Rank by scenario priority high > medium > low > unset. */
  considerScenarioPriority: z.boolean().optional(),
  /** Reserved for future semantic-gap ranking; accepted by server, ignored in v1. */
  considerSemanticCoverage: z.boolean().optional(),
  /**
   * Exclude scenarios with verification_strategy=manual. Server defaults to true when unset.
   * Prefer --include-manual-verification (sets false) over setting this explicitly.
   */
  autoVerificationOnly: z.boolean().optional(),
});

export const listExecutionInput = z.object({
  release: z.string().optional(),
  environment: z.string().optional(),
  scope: scopeSchema,
  branchName: z.string().optional(),
  branchId: z.union([z.string().min(1), z.coerce.number()]).optional(),
  timeWindow: z
    .object({
      relativeWindow: z.string().optional(),
      fixedWindow: z.object({ startTime: z.string().min(1), endTime: z.string().min(1) }).optional(),
    })
    .optional(),
  scenarioId: z.string().optional(),
  testId: z.string().optional(),
  platform: executionPlatformSchema.optional(),
  dimensionFilters: z.array(executionJobDimensionFilterSchema).optional(),
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
  /** When true, return suite timing aggregates instead of per-test history (replaces get-suite-execution-stats). */
  aggregate: z.boolean().optional(),
});

export const fetchExecutionReportInput = z
  .object({
    batchInvocationId: z.string().optional(),
    jobId: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const batch = (v.batchInvocationId ?? "").trim();
    const job = (v.jobId ?? "").trim();
    if ((batch === "" && job === "") || (batch !== "" && job !== "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of batchInvocationId or jobId",
      });
    }
  });

export const agentActorTypeSchema = z.enum(["LOCAL_AGENT", "CLOUD_AGENT", "local-agent", "cloud-agent"]);

/** Nested AgentActionTraceability (agent_traceability.proto) for mutating MCP CRUDs. */
export const agentActionTraceabilitySchema = z
  .object({
    workflowId: z.string().optional(),
    workflowExecutionId: z.string().optional(),
    policyFile: z.string().optional(),
    policyVersion: z.string().optional(),
    gitSha: z.string().optional(),
    actorType: agentActorTypeSchema.optional(),
    userId: z.string().optional(),
    branchName: z.string().optional(),
    agentModel: z.string().optional(),
    skillVersion: z.string().optional(),
    cliVersion: z.string().optional(),
  })
  .strict();

/** Flat + nested traceability fields shared by create/update MCP tools. */
export const agentTraceabilityFieldsSchema = z.object({
  workflowId: z.string().optional(),
  workflowExecutionId: z.string().optional(),
  policyFile: z.string().optional(),
  policyVersion: z.string().optional(),
  gitSha: z.string().optional(),
  actorType: agentActorTypeSchema.optional(),
  userId: z.string().optional(),
  branchName: z.string().optional(),
  agentModel: z.string().optional(),
  skillVersion: z.string().optional(),
  cliVersion: z.string().optional(),
  agentTraceability: agentActionTraceabilitySchema.optional(),
});

export const createUserStoryInput = z.object({
  platformFilePath: z.string().min(1),
  title: z.string().min(1),
}).merge(agentTraceabilityFieldsSchema);

export const createTestScenarioInput = z.object({
  platformFilePath: z.string().min(1),
  title: z.string().min(1),
  userStoryOrdinalId: z.coerce.number().int().positive(),
}).merge(agentTraceabilityFieldsSchema);

export const updatePlanMarkdownInput = z.object({
  content: z.string().min(1),
}).merge(agentTraceabilityFieldsSchema);

export const markPlanItemsImplementationDoneInput = z.object({
  scenarioOrdinalIds: z.array(z.coerce.number().int().positive()).optional(),
  userStoryOrdinalIds: z.array(z.coerce.number().int().positive()).optional(),
});

export const updatePlanItemsLifecycleStatusInput = z.object({
  /** story | scenario (also accepts user_story / USER_STORY / SCENARIO) */
  entityType: z.string().min(1),
  ordinalId: z.coerce.number().int().positive(),
  /** draft | ready | in progress | blocked | done | archived */
  status: z.string().min(1),
});

export const getSpecLifecycleDetailsInput = z
  .object({
    /** Bare ordinals or TS-/ #TS- forms; numbers coerced to strings. */
    scenarioIds: z
      .array(z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1)))
      .optional(),
    /** Bare ordinals or US-/ #US- forms; numbers coerced to strings. */
    storyIds: z
      .array(z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1)))
      .optional(),
  })
  .refine(
    (v) =>
      (v.scenarioIds != null && v.scenarioIds.length > 0) ||
      (v.storyIds != null && v.storyIds.length > 0),
    { message: "Provide scenarioIds and/or storyIds (non-empty)" },
  );

export const getUserStoriesInput = z
  .object({
    userStoryOrdinalIds: z.array(z.coerce.number().int().positive()).min(1),
  });

export const getTestScenariosInput = z
  .object({
    scenarioOrdinalIds: z.array(z.coerce.number().int().positive()).min(1).optional(),
    /** Full TMS external ids (e.g. C12345, PROJ-101). Server matches exact then numerical part. */
    externalIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine(
    (v) =>
      (v.scenarioOrdinalIds != null && v.scenarioOrdinalIds.length > 0) ||
      (v.externalIds != null && v.externalIds.length > 0),
    { message: "Provide scenarioOrdinalIds and/or externalIds (non-empty)" },
  );

export const listTestScenariosForScopeInput = z
  .object({
    namedTestRunId: z.string().min(1).optional(),
    release: z.string().min(1).optional(),
    plansPath: z.string().min(1).optional(),
  })
  .refine(
    (v) =>
      [v.namedTestRunId, v.release, v.plansPath].filter(
        (x) => x != null && String(x).trim() !== "",
      ).length === 1,
    { message: "Provide exactly one of namedTestRunId, release, or plansPath" },
  );

export const getManualSessionDetailsInput = z.object({
  manualSessionId: z.string().min(1),
});

export const getMeetingTranscriptInput = z.object({
  /** Calendar event id, or URL hash for ad-hoc meetings */
  meetingId: z.string().min(1),
  /** Return only the post-meeting summary (transcript body omitted). */
  summaryOnly: z.boolean().optional(),
});

export const listMeetingsInput = z.object({
  /** Inclusive start bound: YYYY-MM-DD (local start of day), ISO datetime, or epoch millis. */
  from: z.union([z.string().min(1), z.number()]).optional(),
  /** Inclusive end bound: YYYY-MM-DD (local end of day), ISO datetime, or epoch millis. */
  to: z.union([z.string().min(1), z.number()]).optional(),
  /** Raw inclusive start (epoch millis); `from` wins when both are set. */
  startDateMillis: z.union([z.string().min(1), z.number()]).optional(),
  /** Raw inclusive end (epoch millis); `to` wins when both are set. */
  endDateMillis: z.union([z.string().min(1), z.number()]).optional(),
  /** OR filter, case-insensitive (exact values from includeFilterOptions). */
  labels: z.array(z.string().min(1)).optional(),
  /** OR filter: participant user ids or emails (keys from includeFilterOptions). */
  participantKeys: z.array(z.string().min(1)).optional(),
  /** OR filter: participant email domains (e.g. customer.com). */
  participantDomains: z.array(z.string().min(1)).optional(),
  /** Full-text search over title + transcript (web-search syntax: quotes, OR, -exclude). */
  searchText: z.string().optional(),
  /** Default 50, max 200 (max 25 when searchText is set). */
  pageSize: z.number().int().positive().optional(),
  /** nextPageToken from the previous page. */
  pageToken: z.string().min(1).optional(),
  /** Include label / participant / domain filter option catalogs (replaces list-meeting-filter-options). */
  includeFilterOptions: z.boolean().optional(),
  /** ULID from `/testchimp using meeting-set context <id>` (replaces get-meeting-set). */
  meetingSetId: z.string().min(1).optional(),
});

export const getIssueDetailsInput = z.object({
  /** Accepts #B-123, B-123, #B123, B123, or plain 123 */
  issueId: z.string().min(1),
});

export const issueStatusSchema = z.enum([
  "ACTIVE",
  "IGNORED",
  "FIXED",
  "DUPLICATE",
  "IN_PROGRESS_BUG",
  "ARCHIVED_BUG",
  "BLOCKED",
]);

export const issueIgnoreReasonSchema = z.enum([
  "INTENDED_BEHAVIOUR",
  "INACCURATE_ASSESSMENT",
  "NOT_IMPORTANT",
]);

const linkedEntityTypeSchema = z.enum([
  "UNKNOWN_LINKED_ENTITY_TYPE",
  "STORY",
  "SCENARIO",
  "TEST",
  "ISSUE",
  "EXTERNAL",
  "TEST_EXECUTION",
  "BATCH_INVOCATION",
  "POLICY",
  "EXPLORATION_ENTITY",
  "EVENT",
  "WORKFLOW",
  "JOURNEY_EXECUTION_ENTITY",
  "RELEASE",
  "NAMED_TEST_RUN",
  "SCREEN",
  "SCREEN_STATE",
  "API_OPERATION",
]);

const createIssueLinkTargetSchema = z.object({
  toEntityType: linkedEntityTypeSchema,
  toEntityId: z.string().min(1),
});

export const issueTypeSchema = z.enum([
  "BUG_ISSUE",
  "SUGGESTION_ISSUE",
  "OBSERVATION_ISSUE",
  "TASK_ISSUE",
]);

export const issueCategorySchema = z.enum([
  "ACCESSIBILITY",
  "SECURITY",
  "VISUAL",
  "PERFORMANCE",
  "FUNCTIONAL",
  "NETWORK",
  "USABILITY",
  "COMPATIBILITY",
  "DATA_INTEGRITY",
  "INTERACTION",
  "LOCALIZATION",
  "RESPONSIVENESS",
  "LAYOUT",
  "VISUAL_REGRESSION",
  "MEMORY",
  "PERFORMANCE_REGRESSION",
  "MEMORY_REGRESSION",
  "FORM_VALIDATION_BUG",
  "REQUIREMENT_QUALITY",
  "TEST_COVERAGE",
  "OTHER",
]);

export const issueSeveritySchema = z.enum([
  "LOW_SEVERITY",
  "MEDIUM_SEVERITY",
  "HIGH_SEVERITY",
  "CRITICAL_SEVERITY",
]);

/** Create when issueId is omitted (title required); patch when issueId is set. */
export const upsertIssueInput = z
  .object({
    issueId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    issueType: issueTypeSchema.optional(),
    category: issueCategorySchema.optional(),
    severity: issueSeveritySchema.optional(),
    status: issueStatusSchema.optional(),
    ignoreReason: issueIgnoreReasonSchema.optional(),
    reportedReleaseId: z.string().optional(),
    dueDateMillis: z.union([z.string().min(1), z.coerce.number()]).optional(),
    assignee: z.string().optional(),
    linkTargets: z.array(createIssueLinkTargetSchema).optional(),
    labels: z.array(z.string()).optional(),
    addLabels: z.array(z.string().min(1)).optional(),
    removeLabels: z.array(z.string().min(1)).optional(),
    source: z.string().optional(),
    environment: z.string().optional(),
  })
  .merge(agentTraceabilityFieldsSchema)
  .superRefine((v, ctx) => {
    const issueId = (v.issueId ?? "").trim();
    const title = (v.title ?? "").trim();
    if (!issueId && !title) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide title to create an issue, or issueId to patch one",
        path: ["title"],
      });
    }
  });

export const listIssuesInput = z.object({
  searchText: z.string().optional(),
  statuses: z.array(issueStatusSchema).optional(),
  /** Alias folded into statuses. */
  status: issueStatusSchema.optional(),
  severities: z.array(issueSeveritySchema).optional(),
  /** Alias folded into severities. */
  severity: issueSeveritySchema.optional(),
  assignee: z.string().optional(),
  assignees: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1)).optional(),
  release: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  ordinalIds: z.array(z.union([z.string().min(1), z.coerce.number()])).optional(),
  /** Alias folded into ordinalIds. */
  issueId: z.string().min(1).optional(),
});

export const releaseTypeSchema = z.enum(["UNKNOWN_RELEASE_TYPE", "MAJOR", "MINOR", "HOTFIX"]);

export const upsertReleaseInput = z.object({
  version: z.string().min(1),
  gitCommitSha: z.string().min(1).optional(),
  /** Alias mapped to gitCommitSha. */
  gitSha: z.string().min(1).optional(),
  priorReleaseVersion: z.string().min(1).optional(),
  releaseType: releaseTypeSchema.optional(),
  lifecycleStatus: z.string().min(1).optional(),
  /** Create only. */
  environment: z.string().min(1).optional(),
  /** Update only; int64 string on the wire. */
  dueDateMillis: z.union([z.string().min(1), z.coerce.number()]).optional(),
  /** Update only; int64 string on the wire. */
  branchId: z.union([z.string().min(1), z.coerce.number()]).optional(),
});

export const manageTestRunStatusSchema = z.enum([
  "UNKNOWN_NAMED_TEST_RUN_STATUS",
  "ACTIVE",
  "COMPLETED",
  "ARCHIVED",
]);
export const manageTestRunCommitRangeSchema = z.enum([
  "FIND",
  "LINK",
  "MCP_TEST_RUN_COMMIT_RANGE_FIND",
  "MCP_TEST_RUN_COMMIT_RANGE_LINK",
  "MCP_TEST_RUN_COMMIT_RANGE_UNSPECIFIED",
]);

export const manageTestRunInput = z
  .object({
    /** Omit to create (release required). */
    id: z.string().min(1).optional(),
    release: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    /** Server defaults to QA on create. */
    environment: z.string().min(1).optional(),
    /** int64 millis string on the wire. */
    dueDate: z.union([z.string().min(1), z.number()]).optional(),
    status: manageTestRunStatusSchema.optional(),
    batchInvocationIds: z.array(z.string().min(1)).optional(),
    /** FIND discovers batches; LINK attaches unlinked ones. */
    commitRange: manageTestRunCommitRangeSchema.optional(),
    limitWhenNoPrior: z.coerce.number().int().positive().optional(),
  })
  .superRefine((v, ctx) => {
    if (!(v.id ?? "").trim() && !(v.release ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide release to create a test run, or id to update one",
        path: ["release"],
      });
    }
  });

export const emptyInput = z.object({});

const projectInitItemStatusSchema = z.enum([
  "PROJECT_INIT_ITEM_STATUS_INCOMPLETE",
  "PROJECT_INIT_ITEM_STATUS_DONE",
  "PROJECT_INIT_ITEM_STATUS_SKIPPED",
  "PROJECT_INIT_ITEM_STATUS_NOT_APPLICABLE",
  "INCOMPLETE",
  "DONE",
  "SKIPPED",
  "NOT_APPLICABLE",
]);

/** Backend proto JSON field names. Advertised schema is snake_case only. */
export const PROJECT_INIT_STATUS_INPUT_KEYS = [
  "platform_comms",
  "folder_mapping",
  "connect_to_test_env",
  "ci_wiring",
  "import_plans",
  "import_tests",
  "smoke_validation",
] as const;

const PROJECT_INIT_STATUS_DROPPED_KEYS = new Set(["overallComplete", "overall_complete"]);

/** Drop server-computed overall_* keys; leave every other key (including legacy camelCase) intact. */
export function stripProjectInitOverallComplete(raw: unknown): unknown {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (PROJECT_INIT_STATUS_DROPPED_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export const projectInitStatusFieldsSchema = z
  .object({
    platform_comms: projectInitItemStatusSchema.optional(),
    folder_mapping: projectInitItemStatusSchema.optional(),
    connect_to_test_env: projectInitItemStatusSchema.optional(),
    ci_wiring: projectInitItemStatusSchema.optional(),
    import_plans: projectInitItemStatusSchema.optional(),
    import_tests: projectInitItemStatusSchema.optional(),
    smoke_validation: projectInitItemStatusSchema.optional(),
  })
  .passthrough()
  .describe(
    "Partial ProjectInitStatus. Advertised keys are snake_case: platform_comms, folder_mapping, connect_to_test_env, " +
      "ci_wiring, import_plans, import_tests, smoke_validation. overall_complete is server-computed and ignored. " +
      "Legacy camelCase keys are forwarded to the backend (not advertised).",
  );

/** Strip overall_* then passthrough so old camelCase reaches featureservice. JSON schema still lists only snake_case. */
export const projectInitStatusSchema = z.preprocess(
  stripProjectInitOverallComplete,
  projectInitStatusFieldsSchema,
);

export const updateProjectInitStatusInput = z.object({
  status: projectInitStatusSchema,
});

export const saveWorkspaceCredsInput = z.object({
  folder: z
    .string()
    .min(1)
    .describe(
      "Repository root on the machine running this MCP server. Writes <folder>/.testchimp/mcp.json (mode 0600, dir 0700) " +
        "and maps the folder in ~/.testchimp/projects.json. Hosted mcp.testchimp.io cannot write your laptop — call " +
        "get-project-credentials and write <repo>/.testchimp/mcp.json with a file-write tool (mode 0600, dir 0700).",
    ),
  projectId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional()
    .describe("Defaults to the connection's project from get-project-credentials."),
  projectName: z.string().optional(),
  backendUrl: z.string().optional(),
  ingressUrl: z.string().optional(),
  reassign: z
    .boolean()
    .optional()
    .describe("Replace another project's key in this folder and move the folder mapping to this project."),
});

export const updateGitFolderMappingInput = z.object({
  testsFolderPath: z.string().min(1).optional(),
  plansFolderPath: z.string().min(1).optional(),
  repositoryFullName: z.string().optional(),
  plansBranch: z
    .string()
    .optional()
    .describe("Branch plans sync against. Empty string resets to the repository default branch."),
  tests_folder_path: z.string().min(1).optional(),
  plans_folder_path: z.string().min(1).optional(),
  repository_full_name: z.string().optional(),
});

export const inviteTeamMembersInput = z.object({
  emails: z
    .array(z.string().min(3).max(254))
    .min(1)
    .max(20)
    .describe("Teammate email addresses to invite (max 20 per call)."),
});

export const getBranchSpecificEndpointConfigInput = z.object({
  branchName: z.string().optional(),
});

/** Protobuf JSON Duration — must end in `s`, e.g. "604800s", "1.5s". */
const protobufDurationSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?s$/, 'Duration must be protobuf JSON ending in "s", e.g. "604800s"');

const fixedWindowSchema = z
  .object({
    startTime: z.string().min(1).describe("RFC 3339 timestamp"),
    endTime: z.string().min(1).describe("RFC 3339 timestamp"),
  })
  .describe("Fixed calendar window (both bounds required)");

/** TimeWindow oneof — exactly one branch (union exposes clearly to MCP agents). */
export const timeWindowSchema = z.union([
  z.object({ relativeWindow: protobufDurationSchema }).strict(),
  z.object({ fixedWindow: fixedWindowSchema }).strict(),
]);

/** Accept CLI aliases (web|ios|android) or proto enum names; normalize to proto. */
const executionScopePlatformSchema = z
  .enum([
    "web",
    "ios",
    "android",
    "UNKNOWN_EXECUTION_PLATFORM",
    "WEB_EXECUTION_PLATFORM",
    "IOS_EXECUTION_PLATFORM",
    "ANDROID_EXECUTION_PLATFORM",
  ])
  .transform((p): "UNKNOWN_EXECUTION_PLATFORM" | "WEB_EXECUTION_PLATFORM" | "IOS_EXECUTION_PLATFORM" | "ANDROID_EXECUTION_PLATFORM" => {
    switch (p) {
      case "web":
        return "WEB_EXECUTION_PLATFORM";
      case "ios":
        return "IOS_EXECUTION_PLATFORM";
      case "android":
        return "ANDROID_EXECUTION_PLATFORM";
      default:
        return p;
    }
  });

const typedValueSchema = z
  .object({
    stringValue: z.string().optional(),
    /** Protobuf JSON often encodes int64 as string. */
    intValue: z.union([z.string(), z.number()]).optional(),
    floatValue: z.number().optional(),
    boolValue: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    const set = [v.stringValue, v.intValue, v.floatValue, v.boolValue].filter((x) => x !== undefined);
    if (set.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TypedValue requires exactly one of stringValue, intValue, floatValue, boolValue",
      });
    }
  });

const metadataFilterSchema = z.object({
  key: z.string().min(1),
  value: typedValueSchema,
  operator: z
    .enum(["UNKNOWN_OPERATOR", "EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN"])
    .optional(),
});

/**
 * ExecutionScope (rum_service.proto) — wire shape for Protobuf JsonFormat.
 * Window must be nested under timeWindow (canonical). Flat relativeWindow on the scope is not accepted here.
 */
export const executionScopeSchema = z.object({
  environment: z
    .string()
    .min(1)
    .describe("RUM environment tag from list-rum-environments (e.g. QA, production)"),
  timeWindow: timeWindowSchema,
  release: z.string().optional(),
  branchName: z.string().optional(),
  platform: executionScopePlatformSchema.optional(),
  automationEmitsOnly: z
    .boolean()
    .optional()
    .describe("On comparison/coverage scopes only: restrict to emits with test_id"),
  metadataFilters: z.array(metadataFilterSchema).optional(),
});

export const listTruecoverageEventsInput = z.object({
  baseExecutionScope: executionScopeSchema,
  comparisonExecutionScope: executionScopeSchema.optional(),
});

export const getTruecoverageEventDetailsInput = z.object({
  eventTitle: z.string().min(1),
  baseExecutionScope: executionScopeSchema,
  comparisonExecutionScope: executionScopeSchema.optional(),
});

export const listTruecoverageChildEventTreeInput = z.object({
  eventTitle: z.string().min(1),
  baseScope: executionScopeSchema,
  coverageScope: executionScopeSchema.optional(),
});

export const getTruecoverageEventTransitionInput = z.object({
  eventTitle: z.string().min(1),
  nextEventTitle: z.string().min(1),
  baseScope: executionScopeSchema,
  coverageScope: executionScopeSchema.optional(),
});

/** EventTimeSeriesMetricType — must match rum_service.proto enum names. */
export const eventTimeSeriesMetricSchema = z.enum([
  "EVENT_TIME_SERIES_METRIC_UNSPECIFIED",
  "SESSION_COUNT",
  "RELATIVE_FREQUENCY",
  "PERCENTAGE_TERMINAL_EVENT",
  "SESSION_POSITION",
  "TIME_TO_NEXT_EVENT",
  "REVERSE_INDEX",
  "TIME_FROM_START",
  "TIME_TO_END",
  "TIME_SINCE_PREVIOUS_EVENT",
]);

export const getTruecoverageEventTimeSeriesInput = z.object({
  baseExecutionScope: executionScopeSchema,
  eventTitle: z.string().optional(),
  metricType: eventTimeSeriesMetricSchema.optional(),
});

export const eventMetadataKeysInput = z.object({
  eventTitle: z.string().min(1),
});

export const ephemeralEnvironmentActionSchema = z.enum([
  "CONFIG",
  "PROVISION",
  "STATUS",
  "MCP_EPHEMERAL_ENVIRONMENT_ACTION_CONFIG",
  "MCP_EPHEMERAL_ENVIRONMENT_ACTION_PROVISION",
  "MCP_EPHEMERAL_ENVIRONMENT_ACTION_STATUS",
  "MCP_EPHEMERAL_ENVIRONMENT_ACTION_UNSPECIFIED",
]);

export const ephemeralEnvironmentInput = z
  .object({
    action: ephemeralEnvironmentActionSchema,
    branchName: z.string().optional(),
    /** When action=PROVISION, wait for deploy (defaults true). Send false for fire-and-forget. */
    wait: z.boolean().optional(),
    bnsEnvironmentId: z.string().min(1).optional(),
    /** Client-only poll interval while waiting; not sent to the server. */
    pollIntervalSeconds: z.number().optional(),
    maxWaitMinutes: z.number().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action.endsWith("STATUS") && !(v.bnsEnvironmentId ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "STATUS requires bnsEnvironmentId",
        path: ["bnsEnvironmentId"],
      });
    }
  });

export const bnsEnvironmentIdInput = z.object({
  bnsEnvironmentId: z.string().min(1),
});

export const listBunnyshellEnvironmentEventsInput = z.object({
  bnsEnvironmentId: z.string().min(1),
  eventType: z.string().optional(),
  eventStatus: z.string().optional(),
  page: z.number().int().positive().optional(),
});

export const listBunnyshellWorkflowJobsInput = z.object({
  bnsEnvironmentId: z.string().min(1),
  page: z.number().int().positive().optional(),
});

export const getBunnyshellWorkflowJobLogsInput = z.object({
  bnsEnvironmentId: z.string().min(1),
  workflowJobId: z.string().min(1),
});

/** ListScreenStatesRequest JSON (proto camelCase). */
export const listScreenStatesInput = z.object({
  environment: z.string().optional(),
  platform: executionPlatformSchema.optional(),
  startCommitSha: z.string().min(1).optional(),
  endCommitSha: z.string().min(1).optional(),
});

export const getReleaseDetailSchema = z.enum([
  "CATALOG",
  "GATE",
  "MCP_RELEASE_VIEW_CATALOG",
  "MCP_RELEASE_VIEW_GATE",
  "MCP_RELEASE_VIEW_UNSPECIFIED",
]);

export const getReleaseInput = z.object({
  /** Release catalog version / label. Omit to list releases. */
  version: z.string().min(1).optional(),
  /** CATALOG (default when version is set) or GATE (replaces get-release-details). */
  detail: getReleaseDetailSchema.optional(),
  /** List filter: environment tag. */
  environment: z.string().min(1).optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
  pageToken: z.string().min(1).optional(),
  excludeArchived: z.boolean().optional(),
});

export const getSecurityScanConfigInput = z.object({
  scanId: z.string().min(1).optional(),
  /** Alias for scanId. */
  id: z.string().min(1).optional(),
}).superRefine((v, ctx) => {
  if (!(v.scanId ?? "").trim() && !(v.id ?? "").trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scanId is required", path: ["scanId"] });
  }
});

export const updateScanProgressInput = z.object({
  scanId: z.string().min(1).optional(),
  /** Alias for scanId. */
  id: z.string().min(1).optional(),
  /** ScanStatus enum name: QUEUED | IN_PROGRESS | COMPLETED | EXCEPTION */
  status: z.enum(["UNKNOWN_SCAN_STATUS", "QUEUED", "IN_PROGRESS", "COMPLETED", "EXCEPTION"]),
}).superRefine((v, ctx) => {
  if (!(v.scanId ?? "").trim() && !(v.id ?? "").trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scanId is required", path: ["scanId"] });
  }
});

export const scanFinderSchema = z.enum([
  "DAST",
  "SAST",
  "DEPS",
  "SECRETS",
  "MCP_SCAN_FINDER_DAST",
  "MCP_SCAN_FINDER_SAST",
  "MCP_SCAN_FINDER_DEPS",
  "MCP_SCAN_FINDER_SECRETS",
  "MCP_SCAN_FINDER_UNSPECIFIED",
]);

export const reportScanFindingsInput = z.object({
  scanId: z.string().min(1).optional(),
  /** Alias for scanId. */
  id: z.string().min(1).optional(),
  scanner: scanFinderSchema,
  /** Path to the scanner JSON report (ZAP / Semgrep / Trivy / Gitleaks). */
  reportFile: z.string().min(1).optional(),
  reportJson: z.string().min(1).optional(),
  markCompleted: z.boolean().optional(),
}).superRefine((v, ctx) => {
  if (!(v.scanId ?? "").trim() && !(v.id ?? "").trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scanId is required", path: ["scanId"] });
  }
  if (!(v.reportFile ?? "").trim() && !(v.reportJson ?? "").trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reportFile or reportJson is required", path: ["reportFile"] });
  }
});

const screenStatesEntrySchema = z.object({
  screen: z.string().optional(),
  states: z.array(z.string()),
  platform: executionPlatformSchema.optional(),
  firstDiscoveredCommitSha: z.string().optional(),
  isNewInRange: z.boolean().optional(),
});

/** UpsertScreenStatesRequest JSON (proto camelCase). */
export const upsertScreenStatesInput = z.object({
  screenStates: z.array(screenStatesEntrySchema).min(1),
  gitCommitSha: z.string().optional(),
});

export const testLocatorSchema = z.object({
  folderPath: z.array(z.string()).optional(),
  fileName: z.string().min(1),
  testSuite: z.array(z.string()).optional(),
  testName: z.string().min(1),
});

export const listSemanticSimilarTestsInput = z.object({
  scope: z
    .object({
      folderPath: z.union([z.array(z.string()), z.string()]).optional(),
      filePaths: z.array(z.string()).optional(),
      ids: z.array(z.string().min(1)).optional(),
      artifactType: z.enum(["UNKNOWN_ARTIFACT_TYPE", "USER_STORY_ARTIFACT", "SCENARIO_ARTIFACT"]).optional(),
    })
    .optional(),
});

export const markSemanticTestsDistinctInput = z.object({
  focusTest: testLocatorSchema,
  distinctTest: testLocatorSchema,
});

export const markTestsForReviewInput = z
  .object({
    tests: z
      .array(
        z.object({
          test: testLocatorSchema,
          confidence: z.number().int().min(0).max(100),
        }),
      )
      .min(1),
    gitCommitSha: z.string().optional(),
  })
  .merge(agentTraceabilityFieldsSchema);

/** LinkedEntityType names for semantic nearby / set-entity-distinct. */
export const semanticNearbyEntityTypeSchema = linkedEntityTypeSchema;

export const listSemanticNearbyInput = z
  .object({
    sourceEntityType: semanticNearbyEntityTypeSchema,
    sourceTest: testLocatorSchema.optional(),
    sourceOrdinalId: z.union([z.number(), z.string()]).optional(),
    sourceEventTitle: z.string().optional(),
    targetEntityTypes: z.array(semanticNearbyEntityTypeSchema).optional(),
    limit: z.number().int().positive().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.sourceEntityType === "TEST" && !val.sourceTest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TEST requires sourceTest (TestLocator)",
        path: ["sourceTest"],
      });
    }
    if (
      (val.sourceEntityType === "STORY" ||
        val.sourceEntityType === "SCENARIO" ||
        val.sourceEntityType === "ISSUE") &&
      (val.sourceOrdinalId == null || String(val.sourceOrdinalId).trim() === "")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${val.sourceEntityType} requires sourceOrdinalId`,
        path: ["sourceOrdinalId"],
      });
    }
    if (val.sourceEntityType === "EVENT" && !(val.sourceEventTitle ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "EVENT requires sourceEventTitle",
        path: ["sourceEventTitle"],
      });
    }
  });

export const setEntityDistinctInput = z
  .object({
    entityType: semanticNearbyEntityTypeSchema.optional(),
    focusTest: testLocatorSchema.optional(),
    otherTest: testLocatorSchema.optional(),
    /** Alias for otherTest (mark-semantic-tests-distinct locator name). */
    distinctTest: testLocatorSchema.optional(),
    focusOrdinalId: z.union([z.number(), z.string()]).optional(),
    otherOrdinalId: z.union([z.number(), z.string()]).optional(),
    focusEventTitle: z.string().optional(),
    otherEventTitle: z.string().optional(),
    /** Defaults true (mark). Set false to unmark. */
    distinct: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const otherTest = val.otherTest ?? val.distinctTest;
    const entityType =
      val.entityType ?? (val.focusTest && otherTest ? "TEST" : undefined);
    if (!entityType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "entityType is required (or provide TEST locators)",
        path: ["entityType"],
      });
      return;
    }
    if (entityType === "TEST") {
      if (!val.focusTest || !otherTest) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "TEST requires focusTest and otherTest (or distinctTest)",
        });
      }
    } else if (entityType === "EVENT") {
      if (!(val.focusEventTitle ?? "").trim() || !(val.otherEventTitle ?? "").trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "EVENT requires focusEventTitle and otherEventTitle",
        });
      }
    } else if (val.focusOrdinalId == null || val.otherOrdinalId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${entityType} requires focusOrdinalId and otherOrdinalId`,
      });
    }
  });

/** RequirementSubjectType — proto enum names (JsonFormat camelCase on wire). */
export const requirementSubjectTypeSchema = z.enum(["STORY", "SCENARIO"]);

/** RequirementFindingSeverity — proto enum names. */
export const requirementFindingSeveritySchema = z.enum(["CRITICAL", "MAJOR", "MINOR"]);

/** RequirementFindingUserState — proto enum names. */
export const requirementFindingUserStateSchema = z.enum(["ACTIVE", "IGNORED", "APPLIED"]);

/** RequirementQualityReportSource — proto enum names. */
export const requirementQualityReportSourceSchema = z.enum(["CLOUD", "LOCAL_AGENT"]);

/** SuggestedFixKind — proto enum names. */
export const suggestedFixKindSchema = z.enum([
  "REWORD_EXCERPT",
  "REWRITE_SECTION",
  "ADD_CONTENT",
  "CREATE_SCENARIO",
  "CREATE_STORY",
  "DELETE_SCENARIO",
  "DELETE_STORY",
  "LINK_OR_UNLINK",
  "OTHER",
]);

/** TextReplacement (requirement_quality.proto) — camelCase wire shape. */
export const textReplacementSchema = z.object({
  originalExcerpt: z.string().optional(),
  suggestedText: z.string().optional(),
  contextBefore: z.string().optional(),
  contextAfter: z.string().optional(),
});

/** SuggestedFix (requirement_quality.proto). isDestructive is derived server-side from kind. */
export const suggestedFixSchema = z.object({
  kind: suggestedFixKindSchema.optional(),
  isDestructive: z.boolean().optional(),
  /** "STORY" | "SCENARIO" — target of the fix (may differ from the finding's own subject). */
  targetEntityType: z.string().optional(),
  targetOrdinalId: z.coerce.number().int().optional(),
  summary: z.string().optional(),
  agentPrompt: z.string().optional(),
  replacements: z.array(textReplacementSchema).optional(),
  rationale: z.string().optional(),
});

/** RequirementQualityFinding (requirement_quality.proto). */
export const requirementQualityFindingSchema = z.object({
  id: z.string().optional(),
  fingerprint: z.string().optional(),
  analyst: z.string().optional(),
  severity: requirementFindingSeveritySchema.optional(),
  confidence: z.coerce.number().int().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  suggestedFix: suggestedFixSchema.optional(),
  /** Omit (defaults ACTIVE server-side) for new findings; set explicitly to carry forward IGNORED/APPLIED. */
  userState: requirementFindingUserStateSchema.optional(),
});

/** RequirementQualityMetrics (requirement_quality.proto) — scores 0-100, counts among ACTIVE findings. */
export const requirementQualityMetricsSchema = z.object({
  overall: z.coerce.number().int().optional(),
  clarity: z.coerce.number().int().optional(),
  completeness: z.coerce.number().int().optional(),
  testability: z.coerce.number().int().optional(),
  consistency: z.coerce.number().int().optional(),
  ambiguityRisk: z.coerce.number().int().optional(),
  scenarioCoverage: z.coerce.number().int().optional(),
  criticalCount: z.coerce.number().int().optional(),
  majorCount: z.coerce.number().int().optional(),
  minorCount: z.coerce.number().int().optional(),
});

/** RequirementQualitySubject (requirement_quality.proto). subjectEntityId is the platform-internal id. */
export const requirementQualitySubjectSchema = z.object({
  subjectType: requirementSubjectTypeSchema.optional(),
  subjectEntityId: z.string().optional(),
  ordinalId: z.coerce.number().int().optional(),
  title: z.string().optional(),
});

/** RequirementQualityReport (requirement_quality.proto) — full upload body shape. */
export const requirementQualityReportSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().optional(),
  subject: requirementQualitySubjectSchema.optional(),
  source: requirementQualityReportSourceSchema.optional(),
  metrics: requirementQualityMetricsSchema.optional(),
  findings: z.array(requirementQualityFindingSchema).optional(),
  createdAtMillis: z.coerce.number().optional(),
  jobId: z.string().optional(),
  contentFingerprint: z.string().optional(),
  scoresUpdatedAtMillis: z.coerce.number().optional(),
});

const requirementSubjectRefinement = (
  v: { subjectEntityId?: string; ordinalId?: number },
  ctx: z.RefinementCtx,
): void => {
  const entityId = (v.subjectEntityId ?? "").trim();
  const ordinal = v.ordinalId;
  if (entityId === "" && (ordinal == null || ordinal <= 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide subjectEntityId or ordinalId",
    });
  }
};

export const getRequirementQualityReportInput = z
  .object({
    subjectType: requirementSubjectTypeSchema,
    subjectEntityId: z.string().optional(),
    ordinalId: z.coerce.number().int().positive().optional(),
  })
  .superRefine(requirementSubjectRefinement);

export const reportRequirementQualityFindingsInput = z
  .object({
    /** Full RequirementQualityReport JSON object (camelCase, requirement_quality.proto). */
    report: requirementQualityReportSchema.optional(),
    /** Path to RequirementQualityReport JSON file. */
    reportFile: z.string().optional(),
    /** Convenience: merged into report.subject when report lacks subjectEntityId. */
    subjectType: requirementSubjectTypeSchema.optional(),
    subjectEntityId: z.string().optional(),
    ordinalId: z.coerce.number().int().positive().optional(),
  })
  .superRefine((v, ctx) => {
    const hasReport = v.report != null && Object.keys(v.report).length > 0;
    const hasFile = (v.reportFile ?? "").trim() !== "";
    if (!hasReport && !hasFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide report object, reportFile path, or full body via --json-input",
      });
    }
  });

/** Closed vocabulary for report-agent-action entity_type (agent_workflow.proto AgentActionEntityType). */
export const agentActionEntityTypeSchema = z.enum([
  "USER_STORY",
  "SCENARIO",
  "SMART_TEST",
  "POLICY",
  "ISSUE",
  "TEST_EXECUTION",
  "TEST_INVOCATION_BATCH",
  "EXPLORATION",
  "EVENT",
  "WORKFLOW",
]);

export const agentActionTypeSchema = z.enum([
  "CREATED",
  "UPDATED",
  "DELETED",
  "ANALYZED",
  "ACTION_COMPLETED",
  "ACTION_FAILED",
  "IMPLEMENTED",
  "created",
  "updated",
  "deleted",
  "analyzed",
  "completed",
  "failed",
  "action_completed",
  "action_failed",
  "implemented",
]);

export const reportAgentActionInput = z
  .object({
    workflowId: z.string().min(1),
    workflowExecutionId: z.string().min(1),
    policyFile: z.string().optional(),
    policyVersion: z.string().optional(),
    gitSha: z.string().optional(),
    actorType: agentActorTypeSchema.optional(),
    userId: z.string().optional(),
    branchName: z.string().optional(),
    agentModel: z.string().optional(),
    skillVersion: z.string().optional(),
    cliVersion: z.string().optional(),
    traceability: agentActionTraceabilitySchema.optional(),
    entityType: agentActionEntityTypeSchema,
    /** Project-scoped ordinal id (or explicitly provided execution/batch id). Mutually exclusive with `test`. */
    entityIdentity: z.string().optional(),
    /** SmartTest TestLocator. Mutually exclusive with `entityIdentity`. */
    test: testLocatorSchema.optional(),
    actionType: agentActionTypeSchema,
    chimphandsSessionId: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    const actionNorm = val.actionType.toString().toUpperCase().replace(/-/g, "_");
    const isCompletion =
      actionNorm === "ACTION_COMPLETED" ||
      actionNorm === "ACTION_FAILED" ||
      actionNorm === "COMPLETED" ||
      actionNorm === "FAILED";

    if (isCompletion) {
      if (val.entityType !== "WORKFLOW") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ACTION_COMPLETED / ACTION_FAILED require entityType WORKFLOW",
          path: ["entityType"],
        });
      }
      const identity = (val.entityIdentity ?? "").trim();
      if (identity === "" || identity !== val.workflowId.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "entityIdentity must equal workflowId for WORKFLOW completion",
          path: ["entityIdentity"],
        });
      }
      if (val.test) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "test must not be set for WORKFLOW completion",
          path: ["test"],
        });
      }
      return;
    }

    if (val.entityType === "WORKFLOW") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "WORKFLOW entityType is only valid with ACTION_COMPLETED / ACTION_FAILED",
        path: ["entityType"],
      });
      return;
    }

    if (
      actionNorm === "IMPLEMENTED" &&
      val.entityType !== "USER_STORY" &&
      val.entityType !== "SCENARIO"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "IMPLEMENTED is only valid for USER_STORY or SCENARIO",
        path: ["entityType"],
      });
    }

    if (val.entityType === "SMART_TEST") {
      if (!val.test) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "SMART_TEST requires test (TestLocator)",
          path: ["test"],
        });
      }
      if (val.entityIdentity != null && val.entityIdentity.trim() !== "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "SMART_TEST forbids entityIdentity; use test (TestLocator)",
          path: ["entityIdentity"],
        });
      }
      return;
    }

    if (!(val.entityIdentity ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entityIdentity is required for ${val.entityType}`,
        path: ["entityIdentity"],
      });
    }
  });

export const getWorkflowExecutionsInput = z.object({
  workflowExecutionId: z.string().min(1).optional(),
  workflowId: z.string().optional(),
  branchName: z.string().optional(),
  userId: z.string().optional(),
  /** Last execution for workflowId (+ optional branchName / userId). Replaces get-last-run-workflow-detail. */
  latestOnly: z.boolean().optional(),
  includeActions: z.boolean().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  pendingApprovalOnly: z.boolean().optional().describe("Only PENDING_INVOKE_APPROVAL / PLANNED executions."),
  assignedToMeOnly: z
    .boolean()
    .optional()
    .describe("Only executions assigned to the calling user (OAuth user, or the bot's owner with --bot)."),
});

const assigneeRef = z.string().min(1).max(254);

export const updateWorkflowExecutionAssigneesInput = z.object({
  workflowExecutionId: z.string().min(1),
  assignee: assigneeRef.optional().describe("New assignee: team member user id or email."),
  addCc: z.array(assigneeRef).max(20).optional().describe("User ids or emails to CC."),
  removeCc: z.array(z.string().min(1)).max(20).optional().describe("User ids to remove from CC."),
});

export const getPoliciesInput = z.object({
  /** When set, fetch that file (filename coerced to *.policy.md). Omit to list. */
  policyFileName: z.string().min(1).optional(),
  workflowId: z.string().optional(),
});

export const upsertPolicyInput = z.object({
  policyFileName: z.string().min(1),
  content: z.string().min(1),
});

export const upsertPlansSupportFileInput = z.object({
  /** Path relative to mapped plans root (e.g. knowledge/workflow_plans/run-qa/<ulid>.plan.md). */
  filePath: z.string().min(1),
  content: z.string().min(1),
});

export const getPlansSupportFileInput = z.object({
  /** Path relative to mapped plans root (e.g. knowledge/workflow_plans/run-qa/<ulid>.plan.md). */
  filePath: z.string().min(1),
});

export const listWorkflowCatalogInput = z.object({});

/** API operation coverage (OpenAPI ops + denorm coverage). No identity args lists services. */
export const getApiOperationsInput = z.object({
  /** TestChimp operation id (ULID PK). Preferred for detail. */
  id: z.string().optional(),
  /** Preferred: repo-relative OpenAPI root path. */
  rootFilePath: z.string().optional(),
  /** Alias for rootFilePath resolution; internal service key. */
  serviceKey: z.string().optional(),
  oasOperationId: z.string().optional(),
  httpMethod: z.string().optional(),
  pathTemplate: z.string().optional(),
  includeManual: z.boolean().optional(),
  includeRemoved: z.boolean().optional(),
});

/** Performance run kind persisted by the Phase 2 performance API. */
export const perfRunKindSchema = z.enum(["JOURNEY", "COMPOSITE"]);

export const listPerfRunsInput = z.object({
  /** When set, fetch that run (replaces get-perf-run). */
  runId: z.string().min(1).optional(),
  includeRaw: z.boolean().optional(),
  testchimpId: z.string().min(1).optional(),
  kind: perfRunKindSchema.optional(),
  branchName: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  dataset: z.string().min(1).optional(),
  llmMode: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  release: z.string().min(1).optional(),
  folderPath: z.string().min(1).optional(),
  fileIds: z.array(z.string().min(1)).optional(),
  batchInvocationId: z.string().min(1).optional(),
  groupByBatch: z.boolean().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const listPerfBaselinesInput = z.object({
  testchimpId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const promotePerfBaselineInput = z
  .object({
    runId: z.string().min(1),
    envClass: z.string().min(1),
  })
  .merge(agentTraceabilityFieldsSchema);

export const comparePerfToBaselineInput = z
  .object({
    runId: z.string().min(1).optional(),
    testchimpId: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    dataset: z.string().min(1).optional(),
    llmMode: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    envClass: z.string().min(1),
    maxP95RegressionPercent: z.coerce.number().nonnegative().optional(),
    maxFailRateIncrease: z.coerce.number().nonnegative().optional(),
  })
  .superRefine((v, ctx) => {
    if (!(v.runId ?? "").trim() && !(v.testchimpId ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide runId or testchimpId",
      });
    }
  });

export const listRelatedPerfTestsInput = z
  .object({
    scenarioTitles: z.array(z.string().min(1)).min(1).optional(),
    testchimpIds: z.array(z.string().min(1)).min(1).optional(),
    includeComposites: z.boolean().default(true),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.scenarioTitles?.length && !v.testchimpIds?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide scenarioTitles and/or testchimpIds",
      });
    }
  });

export const listApiOperationInteractionsInput = z
  .object({
    testId: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
    interactionType: z.enum(["UNKNOWN_API_OPERATION_INTERACTION_TYPE", "REAL", "MOCKED"]).default("REAL"),
    limit: z.coerce.number().int().positive().max(100).optional(),
    executionId: z.string().min(1).optional(),
    retryCount: z.coerce.number().int().nonnegative().optional(),
    includePayloads: z.boolean().optional(),
    interactionId: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (!(v.testId ?? "").trim() && !(v.operationId ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide testId and/or operationId",
      });
    }
  });

/** Max decoded upload size for agent evidence (matches backend ExploreSnapsPathUtil). */
export const MAX_AGENT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const uploadAttachmentInput = z.object({
  file: z.string().min(1),
  filename: z.string().min(1).optional(),
  contentType: z.string().min(1).optional(),
});

export const getBatchViewUrlInput = z.object({
  batchInvocationId: z.string().min(1),
});

export const botRoleSchema = z.enum(["QA_LEAD", "PM", "QA_ENGINEER", "DEVELOPER"]);

export const botCapabilitySchema = z.enum([
  "REQUIREMENTS_UPDATE",
  "E2E_AUTHORING",
  "ISSUE_FIX",
  "MANUAL_TEST_COORDINATION",
  "TEST_BATCH_FIX",
  "QA_POSTURE",
]);

export const botSubscriptionFilterSchema = z.object({
  /** Payload filter field, e.g. author / assignee / adder. */
  field: z.string().min(1),
  op: z.literal("eq").default("eq"),
  /** Literal value, or the token `me` (resolved to the bot's user). */
  value: z.string().min(1),
});

export const botSubscriptionSchema = z.object({
  /** Wire event type, e.g. git-push, issue-assigned, e2e-batch-completed. */
  eventType: z.string().min(1),
  filters: z.array(botSubscriptionFilterSchema).optional(),
});

export const registerBotProfileInput = z.object({
  /** Defaults to the bot-id header (TESTCHIMP_BOT_ID) or the OAuth token's bot. */
  botId: z.string().min(1).max(64).optional(),
  role: botRoleSchema,
  responsibilities: z.string().optional(),
  capabilities: z.array(botCapabilitySchema).default([]),
  subscriptions: z.array(botSubscriptionSchema).default([]),
});

export const getBotProfileInput = z.object({
  botId: z.string().min(1).max(64).optional(),
});

export const getMyTasksInput = z.object({
  /** Required with an API key; ignored with an OAuth token (the token's user is used). */
  userId: z.string().min(1).optional(),
});

export const listTestsAwaitingVerificationInput = z.object({
  userId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const approveAgentwatchPairingInput = z.object({
  /** Printed by `testchimp bot connect --pair` on the user's computer: BASE64URL(SHA-256(verifier)). */
  pairingCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{43}$/, "pairingCode must be the 43-character code printed by testchimp bot connect --pair"),
});

export const feedbackCategorySchema = z.enum([
  "BUG",
  "USER_STRUGGLE",
  "FEATURE_REQUEST",
  "DOCS_GAP",
  "OTHER",
]);

export const sendFeedbackInput = z.object({
  category: feedbackCategorySchema.default("OTHER"),
  message: z.string().trim().min(1).max(10_000),
  /** What the agent was doing: workflow, tool or command, error text, versions. */
  context: z.string().trim().max(20_000).optional(),
  /** Agent / host sending it, e.g. Cursor, Claude Code, Grok QA bot. */
  agentName: z.string().trim().max(100).optional(),
});

export const MAX_BOT_ACK_EVENT_IDS = 100;

export const ackBotEventsInput = z.object({
  eventIds: z
    .array(z.string().regex(/^[\x20-\x7e]+$/, "eventIds must be printable ASCII").min(1))
    .min(1)
    .max(MAX_BOT_ACK_EVENT_IDS),
  /** Webhook delivery ackUrl; defaults to ${TESTCHIMP_INGRESS_URL}/bot/events/ack. */
  ackUrl: z.string().min(1).optional(),
});

export const smartTestExecutionStatusSchema = z.enum([
  "UNKNOWN_SMART_TEST_EXECUTION_STATUS",
  "SMART_TEST_EXECUTION_QUEUED",
  "SMART_TEST_EXECUTION_IN_PROGRESS",
  "SMART_TEST_EXECUTION_COMPLETED",
  "SMART_TEST_EXECUTION_FAILED",
  "SMART_TEST_EXECUTION_COMPLETED_WITH_REPAIRS",
  "SMART_TEST_EXECUTION_CANCELLED",
  "SMART_TEST_EXECUTION_SKIPPED",
  "SMART_TEST_EXECUTION_INTERRUPTED",
  "SMART_TEST_EXECUTION_ARCHIVED",
  "SMART_TEST_EXECUTION_BLOCKED",
  "SMART_TEST_EXECUTION_OUT_OF_SCOPE",
]);

export const ingestScenarioExecutionInput = z.object({
  scenarioOrdinalId: z.union([z.string().min(1), z.coerce.number()]).optional(),
  externalId: z.string().min(1).optional(),
  result: smartTestExecutionStatusSchema,
  release: z.string().min(1).optional(),
  testRunLabel: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  platform: executionPlatformSchema.optional(),
  notes: z.string().optional(),
});

export const executionJobFilterDimensionSchema = z.enum([
  "UNKNOWN_EXECUTION_JOB_FILTER_DIMENSION",
  "PLATFORM_EXECUTION_JOB_FILTER_DIMENSION",
  "DEVICE_FAMILY_EXECUTION_JOB_FILTER_DIMENSION",
  "OS_VERSION_EXECUTION_JOB_FILTER_DIMENSION",
  "SCREEN_RESOLUTION_EXECUTION_JOB_FILTER_DIMENSION",
  "SCREEN_ORIENTATION_EXECUTION_JOB_FILTER_DIMENSION",
]);

export const listExecutionJobDimensionValuesInput = z.object({
  scenarioId: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  release: z.string().min(1).optional(),
  timeWindow: z
    .object({
      relativeWindow: z.string().optional(),
      fixedWindow: z.object({ startTime: z.string().min(1), endTime: z.string().min(1) }).optional(),
    })
    .optional(),
  branchId: z.union([z.string().min(1), z.coerce.number()]).optional(),
  branchName: z.string().min(1).optional(),
  dimensionFilters: z.array(executionJobDimensionFilterSchema).optional(),
  dimension: executionJobFilterDimensionSchema.optional(),
});

export const listTestPlanningTrendsInput = z.object({
  release: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  timeWindow: z
    .object({
      relativeWindow: z.string().optional(),
      fixedWindow: z.object({ startTime: z.string().min(1), endTime: z.string().min(1) }).optional(),
    })
    .optional(),
  coverageScope: scopeSchema,
  branchId: z.union([z.string().min(1), z.coerce.number()]).optional(),
  branchName: z.string().min(1).optional(),
  scenarioId: z.array(z.string().min(1)).optional(),
  userStoryId: z.array(z.string().min(1)).optional(),
  userStoryIdInScope: z.array(z.string().min(1)).optional(),
  platform: executionPlatformSchema.optional(),
});

export const selectSmartSmokeTestsInput = z.object({
  relatedTests: z.array(testLocatorSchema).optional(),
  includeTags: z.array(z.string().min(1)).optional(),
  taggedTests: z.array(testLocatorSchema).optional(),
  suiteCandidates: z.array(testLocatorSchema).optional(),
  maxTimeBudgetMins: z.coerce.number().int().positive().optional(),
  maxTests: z.coerce.number().int().positive().optional(),
  suitePercentage: z.coerce.number().optional(),
  branchName: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
});
