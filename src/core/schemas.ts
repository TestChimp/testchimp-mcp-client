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

export const stubSecurityScanInput = z.object({
  id: z.string().min(1).optional(),
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
