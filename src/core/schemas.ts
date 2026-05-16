import { z } from "zod";

export const scopeSchema = z
  .object({
    filePaths: z.array(z.string()).optional(),
    folderPath: z.union([z.array(z.string()), z.string()]).optional(),
  })
  .optional();

export const listCoverageInput = z.object({
  release: z.string().optional(),
  environment: z.string().optional(),
  scope: scopeSchema,
  includeNonCoveredUserStories: z.boolean().optional(),
  includeNonCoveredTestScenarios: z.boolean().optional(),
  branchName: z.string().optional(),
});

export const listExecutionInput = z.object({
  release: z.string().optional(),
  environment: z.string().optional(),
  scope: scopeSchema,
  branchName: z.string().optional(),
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

export const emptyInput = z.object({});

export const getBranchSpecificEndpointConfigInput = z.object({
  branchName: z.string().optional(),
});

export const truecoverageJsonInput = z.record(z.string(), z.unknown());

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

const screenStatesEntrySchema = z.object({
  screen: z.string().optional(),
  states: z.array(z.string()),
});

/** UpsertScreenStatesRequest JSON (proto camelCase). */
export const upsertScreenStatesInput = z.object({
  screenStates: z.array(screenStatesEntrySchema).min(1),
});
