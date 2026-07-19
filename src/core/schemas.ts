import { z } from "zod";

export const scopeSchema = z
  .object({
    filePaths: z.array(z.string()).optional(),
    folderPath: z.union([z.array(z.string()), z.string()]).optional(),
  })
  .optional();

const executionPlatformSchema = z.enum(["web", "ios", "android"]);

const requirementCoverageRecordTypeSchema = z.enum(["smart_test", "manual", "SMART_TEST", "MANUAL"]);

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
  platform: executionPlatformSchema.optional(),
  /**
   * Which coverage sources to include.
   *
   * Omit for legacy default: SMART_TEST only.
   * When provided, send proto enum names ("SMART_TEST", "MANUAL") or CLI-friendly aliases ("smart_test", "manual").
   */
  recordTypes: z.array(requirementCoverageRecordTypeSchema).optional(),
});

export const listExecutionInput = z.object({
  release: z.string().optional(),
  environment: z.string().optional(),
  scope: scopeSchema,
  branchName: z.string().optional(),
  scenarioId: z.string().optional(),
  platform: executionPlatformSchema.optional(),
  dimensionFilters: z.array(executionJobDimensionFilterSchema).optional(),
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
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

export const createUserStoryInput = z.object({
  platformFilePath: z.string().min(1),
  title: z.string().min(1),
});

export const createTestScenarioInput = z.object({
  platformFilePath: z.string().min(1),
  title: z.string().min(1),
  userStoryOrdinalId: z.coerce.number().int().positive(),
});

export const updatePlanMarkdownInput = z.object({
  content: z.string().min(1),
});

export const markPlanItemsImplementationDoneInput = z.object({
  scenarioOrdinalIds: z.array(z.coerce.number().int().positive()).optional(),
  userStoryOrdinalIds: z.array(z.coerce.number().int().positive()).optional(),
});

export const getUserStoriesInput = z
  .object({
    userStoryOrdinalIds: z.array(z.coerce.number().int().positive()).min(1),
  });

export const getTestScenariosInput = z
  .object({
    scenarioOrdinalIds: z.array(z.coerce.number().int().positive()).min(1),
  });

export const getManualSessionDetailsInput = z.object({
  manualSessionId: z.string().min(1),
});

export const getIssueDetailsInput = z.object({
  /** Accepts #B-123, B-123, #B123, B123, or plain 123 */
  issueId: z.string().min(1),
});

export const updateIssueStatusInput = z.object({
  issueId: z.string().min(1),
  status: z.enum([
    "ACTIVE",
    "IGNORED",
    "FIXED",
    "DUPLICATE",
    "IN_PROGRESS_BUG",
    "ARCHIVED_BUG",
    "BLOCKED",
  ]),
  ignoreReason: z
    .enum(["INTENDED_BEHAVIOUR", "INACCURATE_ASSESSMENT", "NOT_IMPORTANT"])
    .optional(),
});

const linkedEntityTypeSchema = z.enum([
  "STORY",
  "SCENARIO",
  "TEST",
  "ISSUE",
  "EXTERNAL",
  "TEST_EXECUTION",
  "BATCH_INVOCATION",
]);

const createIssueLinkTargetSchema = z.object({
  toEntityType: linkedEntityTypeSchema,
  toEntityId: z.string().min(1),
});

export const createIssueInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  issueType: z
    .enum(["BUG_ISSUE", "SUGGESTION_ISSUE", "OBSERVATION_ISSUE", "TASK_ISSUE"])
    .optional(),
  category: z
    .enum([
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
      "OTHER",
    ])
    .optional(),
  severity: z
    .enum(["LOW_SEVERITY", "MEDIUM_SEVERITY", "HIGH_SEVERITY", "CRITICAL_SEVERITY"])
    .optional(),
  status: z
    .enum([
      "ACTIVE",
      "IGNORED",
      "FIXED",
      "DUPLICATE",
      "IN_PROGRESS_BUG",
      "ARCHIVED_BUG",
      "BLOCKED",
    ])
    .optional(),
  reportedReleaseId: z.string().optional(),
  dueDateMillis: z.coerce.number().optional(),
  assignee: z.string().optional(),
  linkTargets: z.array(createIssueLinkTargetSchema).optional(),
  labels: z.array(z.string()).optional(),
  source: z.string().optional(),
  environment: z.string().optional(),
  attachments: z.array(z.record(z.string(), z.unknown())).optional(),
  artifactReference: z.record(z.string(), z.unknown()).optional(),
});

export const emptyInput = z.object({});

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

export const provisionEphemeralInput = z.object({
  branchName: z.string().optional(),
});

export const bnsEnvironmentIdInput = z.object({
  bnsEnvironmentId: z.string().min(1),
});

export const provisionEphemeralWaitInput = z.object({
  branchName: z.string().optional(),
  pollIntervalSeconds: z.number().optional(),
  maxWaitMinutes: z.number().optional(),
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
});

export const getReleaseInput = z.object({
  /** Release catalog version / label — maps to McpGetReleaseRequest.version */
  version: z.string().min(1),
});

export const getReleaseDetailsInput = z.object({
  /** Release catalog version / label — maps to McpGetReleaseDetailsRequest.version */
  version: z.string().min(1),
});

export const getSecurityScanConfigInput = z.object({
  id: z.string().min(1),
});

export const updateScanProgressInput = z.object({
  id: z.string().min(1),
  /** ScanStatus enum name: QUEUED | IN_PROGRESS | COMPLETED | EXCEPTION */
  status: z.enum(["QUEUED", "IN_PROGRESS", "COMPLETED", "EXCEPTION"]),
});

export const reportDastFindingsInput = z.object({
  id: z.string().min(1),
  /** Path to ZAP Traditional JSON report file */
  reportFile: z.string().min(1),
});

export const reportSastFindingsInput = z.object({
  id: z.string().min(1),
  /** Path to full Semgrep CLI JSON report file */
  reportFile: z.string().min(1),
});

export const reportSecretsFindingsInput = z.object({
  id: z.string().min(1),
  /** Path to full Gitleaks JSON report file */
  reportFile: z.string().min(1),
});

export const reportDepsFindingsInput = z.object({
  id: z.string().min(1),
  /** Path to full Trivy JSON report file */
  reportFile: z.string().min(1),
});

const screenStatesEntrySchema = z.object({
  screen: z.string().optional(),
  states: z.array(z.string()),
});

/** UpsertScreenStatesRequest JSON (proto camelCase). */
export const upsertScreenStatesInput = z.object({
  screenStates: z.array(screenStatesEntrySchema).min(1),
});

export const testLocatorSchema = z.object({
  folderPath: z.array(z.string()).optional(),
  fileName: z.string().min(1),
  testSuite: z.array(z.string()).optional(),
  testName: z.string().min(1),
});

export const listSemanticSimilarTestsInput = z.object({
  scope: scopeSchema,
});

export const markSemanticTestsDistinctInput = z.object({
  focusTest: testLocatorSchema,
  distinctTest: testLocatorSchema,
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
