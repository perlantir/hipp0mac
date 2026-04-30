import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const idSchema = z.string().uuid();
export const isoDateTimeSchema = z.string().datetime();

export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_for_approval",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled"
]);

export const TaskPrioritySchema = z.enum(["low", "normal", "high"]);

export const TaskCreateInputSchema = z.object({
  projectId: idSchema.optional(),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(12000),
  priority: TaskPrioritySchema.default("normal"),
  metadata: jsonObjectSchema.default({})
});

export const TaskSchema = z.object({
  id: idSchema,
  projectId: idSchema.optional(),
  title: z.string().min(1).max(160),
  prompt: z.string().min(1).max(12000),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  metadata: jsonObjectSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const ToolCallStatusSchema = z.enum([
  "requested",
  "running",
  "succeeded",
  "failed",
  "cancelled"
]);

export const ToolCallSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  toolName: z.string().trim().min(1).max(120),
  status: ToolCallStatusSchema,
  input: jsonObjectSchema.default({}),
  output: jsonValueSchema.optional(),
  error: z.string().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);

export const ApprovalRequestSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(4000),
  status: ApprovalStatusSchema,
  requestedAction: z.string().trim().min(1).max(4000),
  metadata: jsonObjectSchema.default({}),
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.optional()
});

export const ArtifactKindSchema = z.enum([
  "file",
  "directory",
  "url",
  "log",
  "image",
  "document",
  "other"
]);

export const ArtifactSchema = z.object({
  id: idSchema,
  taskId: idSchema.optional(),
  projectId: idSchema.optional(),
  kind: ArtifactKindSchema,
  name: z.string().trim().min(1).max(255),
  uri: z.string().trim().min(1).max(2048),
  mimeType: z.string().trim().min(1).max(255).optional(),
  metadata: jsonObjectSchema.default({}),
  createdAt: isoDateTimeSchema
});

export const ModelMessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export const ModelMessagePartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string()
  }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: idSchema,
    toolName: z.string().trim().min(1),
    input: jsonObjectSchema.default({})
  }),
  z.object({
    type: z.literal("tool-result"),
    toolCallId: idSchema,
    output: jsonValueSchema
  }),
  z.object({
    type: z.literal("artifact"),
    artifactId: idSchema
  })
]);

export const ModelMessageSchema = z.object({
  id: idSchema,
  taskId: idSchema.optional(),
  role: ModelMessageRoleSchema,
  parts: z.array(ModelMessagePartSchema).min(1),
  createdAt: isoDateTimeSchema
});

export const ProviderIdSchema = z.enum(["openai", "anthropic", "openrouter", "ollama", "lmstudio", "mock"]);

export const ProviderKindSchema = z.enum(["hosted", "local"]);

export const ModelPurposeSchema = z.enum([
  "planner",
  "executor",
  "verifier",
  "summarizer",
  "memory_curator"
]);

export const ModelCapabilitySchema = z.object({
  vision: z.boolean(),
  tools: z.boolean(),
  streaming: z.boolean(),
  maxContextTokens: z.number().int().positive().optional(),
  inputCostPerMillionTokens: z.number().nonnegative().optional(),
  outputCostPerMillionTokens: z.number().nonnegative().optional()
});

export const ProviderModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  capabilities: ModelCapabilitySchema
});

export const ModelPurposeDefaultsSchema = z.object({
  planner: z.string().trim().min(1).optional(),
  executor: z.string().trim().min(1).optional(),
  verifier: z.string().trim().min(1).optional(),
  summarizer: z.string().trim().min(1).optional(),
  memoryCurator: z.string().trim().min(1).optional()
});

export const ProviderConfigSchema = z.object({
  id: ProviderIdSchema,
  kind: ProviderKindSchema,
  displayName: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  endpoint: z.string().url().optional(),
  defaultModel: z.string().trim().min(1).optional(),
  roleDefaults: ModelPurposeDefaultsSchema.default({}),
  apiKeyConfigured: z.boolean(),
  models: z.array(ProviderModelSchema),
  updatedAt: isoDateTimeSchema.optional()
});

export const ProviderConfigUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().url().optional(),
  defaultModel: z.string().trim().min(1).optional(),
  roleDefaults: ModelPurposeDefaultsSchema.optional()
});

export const ProviderListResponseSchema = z.object({
  providers: z.array(ProviderConfigSchema)
});

export const ProviderResponseSchema = z.object({
  provider: ProviderConfigSchema
});

export const ProviderConnectionTestResponseSchema = z.object({
  providerId: ProviderIdSchema,
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().nonnegative().optional(),
  checkedAt: isoDateTimeSchema
});

export const RouterModeSchema = z.enum(["auto", "manual"]);

export const ModelRouterConfigSchema = z.object({
  mode: RouterModeSchema,
  purposeDefaults: ModelPurposeDefaultsSchema,
  fallbackProvider: ProviderIdSchema.optional(),
  updatedAt: isoDateTimeSchema.optional()
});

export const ModelRouterConfigUpdateSchema = z.object({
  mode: RouterModeSchema.optional(),
  purposeDefaults: ModelPurposeDefaultsSchema.optional(),
  fallbackProvider: ProviderIdSchema.optional()
});

export const ModelRouterConfigResponseSchema = z.object({
  router: ModelRouterConfigSchema
});

export const ModelRouterMessageSchema = z.object({
  role: ModelMessageRoleSchema.exclude(["tool"]),
  content: z.string().min(1)
});

export const ModelRouterToolSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  parameters: jsonObjectSchema
});

export const ModelProviderErrorKindSchema = z.enum([
  "rate_limit",
  "server_error",
  "bad_request",
  "auth",
  "other"
]);

export const ModelFallbackTargetSchema = z.object({
  providerId: ProviderIdSchema,
  model: z.string().trim().min(1).optional()
});

export const ModelRouterChatRequestSchema = z.object({
  purpose: ModelPurposeSchema,
  providerId: ProviderIdSchema.optional(),
  model: z.string().trim().min(1).optional(),
  promptVersion: z.string().trim().min(1).default("prompt-unversioned"),
  schemaDigest: z.string().trim().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  fallbackChain: z.array(ModelFallbackTargetSchema).default([]),
  messages: z.array(ModelRouterMessageSchema).min(1),
  tools: z.array(ModelRouterToolSchema).default([]),
  stream: z.boolean().default(false),
  metadata: jsonObjectSchema.default({})
});

export const ModelRouterToolCallSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  input: jsonObjectSchema
});

export const ModelRouterChatResponseSchema = z.object({
  providerId: ProviderIdSchema,
  providerName: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1),
  modelVersion: z.string().trim().min(1).optional(),
  promptVersion: z.string().trim().min(1).optional(),
  providerError: ModelProviderErrorKindSchema.optional(),
  message: z.object({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(ModelRouterToolCallSchema).default([])
  }),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional()
  }).default({})
});

export const WorkspaceFoldersSchema = z.object({
  projects: z.string(),
  tasks: z.string(),
  artifacts: z.string(),
  logs: z.string(),
  skills: z.string(),
  memory: z.string()
});

export const WorkspaceSettingsSchema = z.object({
  rootPath: z.string().min(1),
  folders: WorkspaceFoldersSchema,
  initialized: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const WorkspaceConfigureInputSchema = z.object({
  rootPath: z.string().trim().min(1)
});

export const WorkspaceResponseSchema = z.object({
  workspace: WorkspaceSettingsSchema
});

export const ProjectFolderCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export const FileEntryKindSchema = z.enum(["file", "directory"]);

export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  relativePath: z.string(),
  kind: FileEntryKindSchema,
  size: z.number().int().nonnegative().optional(),
  modifiedAt: isoDateTimeSchema.optional()
});

export const FileListResponseSchema = z.object({
  entries: z.array(FileEntrySchema)
});

export const FileReadInputSchema = z.object({
  path: z.string().trim().min(1),
  encoding: z.literal("utf8").default("utf8"),
  maxBytes: z.number().int().positive().max(5_000_000).default(1_000_000)
});

export const FileReadOutputSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  content: z.string(),
  contents: z.string(),
  bytesRead: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  mtime: isoDateTimeSchema
});

export const FileWriteInputSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string().optional(),
  contents: z.string().optional(),
  createDirs: z.boolean().default(true),
  overwrite: z.boolean().default(true),
  mode: z.number().int().min(0).max(0o777).optional(),
  approvalToken: z.string().optional()
}).refine((input) => input.content !== undefined || input.contents !== undefined, {
  message: "Either content or contents is required.",
  path: ["contents"]
});

export const FileAppendInputSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  createDirs: z.boolean().default(true),
  approvalToken: z.string().optional()
});

export const FileListInputSchema = z.object({
  path: z.string().trim().min(1).default("."),
  recursive: z.boolean().default(false),
  maxEntries: z.number().int().positive().max(1000).default(200)
});

export const FileSearchInputSchema = z.object({
  path: z.string().trim().min(1).default("."),
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(1000).default(100)
});

export const FileSearchMatchSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  line: z.number().int().positive(),
  preview: z.string()
});

export const FileSearchOutputSchema = z.object({
  matches: z.array(FileSearchMatchSchema)
});

export const FileCopyInputSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  overwrite: z.boolean().default(false),
  approvalToken: z.string().optional()
});

export const FileMoveInputSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  overwrite: z.boolean().default(false),
  approvalToken: z.string().optional()
});

export const FileDeleteInputSchema = z.object({
  path: z.string().trim().min(1),
  recursive: z.boolean().default(false),
  approvalToken: z.string().optional()
});

export const FileMutationOutputSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  bytesWritten: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  hash: z.string().optional(),
  idempotent: z.boolean().optional()
});

export const ToolRiskLevelSchema = z.enum(["safe", "medium", "dangerous"]);

export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("always") }),
    z.object({ op: z.literal("never") }),
    z.object({ op: z.literal("and"), clauses: z.array(PredicateSchema) }),
    z.object({ op: z.literal("or"), clauses: z.array(PredicateSchema) }),
    z.object({ op: z.literal("not"), clause: PredicateSchema }),
    z.object({ op: z.literal("match"), path: z.string().min(1), regex: z.string().min(1) }),
    z.object({ op: z.literal("equals"), path: z.string().min(1), value: jsonValueSchema }),
    z.object({ op: z.literal("in"), path: z.string().min(1), values: z.array(jsonValueSchema) }),
    z.object({
      op: z.literal("pathOutsideScope"),
      inputPath: z.string().min(1),
      scope: z.enum(["filesystem", "network"])
    })
  ])
);

export type Predicate =
  | { op: "always" }
  | { op: "never" }
  | { op: "and"; clauses: Predicate[] }
  | { op: "or"; clauses: Predicate[] }
  | { op: "not"; clause: Predicate }
  | { op: "match"; path: string; regex: string }
  | { op: "equals"; path: string; value: JsonValue }
  | { op: "in"; path: string; values: JsonValue[] }
  | { op: "pathOutsideScope"; inputPath: string; scope: "filesystem" | "network" };

export const ToolSideEffectClassSchema = z.enum([
  "pure",
  "read",
  "write-idempotent",
  "write-non-idempotent",
  "external"
]);

export const ToolFilesystemScopeSchema = z.object({
  mode: z.enum(["none", "workspace", "explicit"]),
  paths: z.array(z.string()).default([])
});

export const ToolNetworkScopeSchema = z.object({
  mode: z.enum(["none", "explicit"]),
  hosts: z.array(z.string()).default([])
});

export const ToolTimeoutPolicySchema = z.object({
  defaultMs: z.number().int().positive(),
  maxMs: z.number().int().positive()
}).refine((policy) => policy.defaultMs <= policy.maxMs, {
  message: "defaultMs must be less than or equal to maxMs.",
  path: ["defaultMs"]
});

export const ToolCapabilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(2000),
  inputSchema: jsonObjectSchema,
  outputSchema: jsonObjectSchema,
  sideEffectClass: ToolSideEffectClassSchema,
  supportsIdempotency: z.boolean(),
  supportsDryRun: z.boolean(),
  supportsStatusQuery: z.boolean(),
  filesystemScope: ToolFilesystemScopeSchema,
  networkScope: ToolNetworkScopeSchema,
  approvalPolicy: PredicateSchema,
  forbiddenInputPatterns: z.array(PredicateSchema),
  timeoutPolicy: ToolTimeoutPolicySchema
});

export const SafetyDecisionValueSchema = z.enum(["allow", "approval_required", "deny"]);

export const ToolCallCanonicalStatusSchema = z.enum(["ok", "error", "timeout", "cancelled"]);

export const TaskBudgetLimitSchema = z.object({
  used: z.number().nonnegative().default(0),
  limit: z.number().nonnegative()
});

export const TaskBudgetLimitsSchema = z.object({
  toolCalls: TaskBudgetLimitSchema,
  wallClockMs: TaskBudgetLimitSchema,
  costUsd: TaskBudgetLimitSchema,
  bytesProcessed: TaskBudgetLimitSchema
});

export const ToolExecutionStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_for_approval",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "timed_out"
]);

export const ToolEventTypeSchema = z.enum([
  "tool.started",
  "tool.output",
  "tool.completed",
  "tool.failed",
  "tool.cancelled",
  "approval.required"
]);

export const ToolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: jsonObjectSchema.optional()
});

export const ToolReplayMetadataSchema = z.object({
  taskId: z.string().trim().min(1).optional(),
  inputHash: z.string(),
  workspaceRoot: z.string().optional(),
  lockEventId: z.string().optional(),
  intendedEventId: z.string().optional(),
  resultEventId: z.string().optional(),
  idempotencyKey: z.string().uuid().optional(),
  safetyDecisionEventId: z.string().optional(),
  safetyDecision: SafetyDecisionValueSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  bytesIn: z.number().int().nonnegative().optional(),
  bytesOut: z.number().int().nonnegative().optional(),
  pricingVersion: z.string().optional(),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  attempts: z.number().int().positive().default(1)
});

export const ToolEventRecordSchema = z.object({
  id: idSchema,
  executionId: idSchema,
  toolName: z.string().min(1),
  type: ToolEventTypeSchema,
  createdAt: isoDateTimeSchema,
  payload: jsonObjectSchema.default({})
});

export const ToolResultSchema = z.object({
  executionId: idSchema,
  toolName: z.string().min(1),
  status: ToolExecutionStatusSchema,
  riskLevel: ToolRiskLevelSchema,
  ok: z.boolean(),
  output: jsonValueSchema.optional(),
  error: ToolErrorSchema.optional(),
  rawOutputRef: z.string().optional(),
  events: z.array(ToolEventRecordSchema).default([]),
  replay: ToolReplayMetadataSchema
});

export const ToolExecutionRequestSchema = z.object({
  taskId: z.string().trim().min(1).optional(),
  toolName: z.string().trim().min(1),
  input: jsonObjectSchema,
  timeoutMs: z.number().int().positive().optional(),
  retry: z.number().int().nonnegative().max(3).default(0),
  approvalToken: z.string().optional(),
  idempotencyKey: z.string().uuid().optional(),
  allowedNetworkHosts: z.array(z.string().min(1)).default([]),
  budgetLimits: TaskBudgetLimitsSchema.optional()
});

export const ToolExecutionResponseSchema = z.object({
  result: ToolResultSchema
});

export const ApprovalDecisionInputSchema = z.object({
  executionId: idSchema,
  approved: z.boolean()
});

export const ToolApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);

export const ToolApprovalSchema = z.object({
  id: idSchema,
  executionId: idSchema,
  toolName: z.string().min(1),
  riskLevel: ToolRiskLevelSchema,
  reason: z.string(),
  status: ToolApprovalStatusSchema,
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.optional()
});

export const ToolApprovalListResponseSchema = z.object({
  approvals: z.array(ToolApprovalSchema)
});

export const ToolApprovalResolveInputSchema = z.object({
  approved: z.boolean()
});

export const ShellRunInputSchema = z.object({
  command: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string()).default({}),
  timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  approvalToken: z.string().optional()
});

export const ShellRunOutputSchema = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative().optional()
});

export const ShellRunInteractiveInputSchema = ShellRunInputSchema.extend({
  stdin: z.string().default("")
});

export const ShellExecInputSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string()).default({})
});

export const ShellExecOutputSchema = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative()
});

export const HttpFetchInputSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).default({})
});

export const HttpFetchOutputSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string()),
  body: z.string(),
  sizeBytes: z.number().int().nonnegative()
});

export const SleepWaitInputSchema = z.object({
  durationMs: z.number().int().nonnegative().max(120_000)
});

export const SleepWaitOutputSchema = z.object({
  durationMs: z.number().int().nonnegative()
});

export const AgentCriterionSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
  predicate: PredicateSchema,
  requiresEvidence: z.boolean()
});

export const AgentRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const AgentRiskSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
  level: AgentRiskLevelSchema,
  mitigation: z.string().trim().min(1).optional()
});

export const AgentArtifactDescriptorSchema = z.object({
  kind: ArtifactKindSchema,
  name: z.string().trim().min(1),
  uri: z.string().trim().min(1).optional(),
  metadata: jsonObjectSchema.default({})
});

export const AgentStepSchema = z.object({
  stepId: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  selectedTool: z.string().trim().min(1),
  selectedToolVersion: z.string().trim().min(1),
  toolInput: jsonObjectSchema,
  expectedObservation: z.string().trim().min(1),
  successCheck: PredicateSchema,
  riskLevel: AgentRiskLevelSchema,
  fallbackStrategies: z.array(z.string()).default([]),
  rationale: z.string().trim().min(1),
  estimatedValue: z.number().min(0).max(1),
  dependsOn: z.array(z.string().trim().min(1)),
  produces: z.array(z.string().trim().min(1)),
  consumes: z.array(z.string().trim().min(1)),
  taint: z.boolean()
});

export const AgentPlanSchema = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  revision: z.number().int().nonnegative(),
  parentPlanId: z.string().trim().min(1).nullable(),
  taskGoal: z.string().trim().min(1),
  assumptions: z.array(z.string()),
  constraints: z.array(z.string()),
  successCriteria: z.array(AgentCriterionSchema),
  doneConditions: z.array(AgentCriterionSchema),
  forbiddenActions: z.array(PredicateSchema),
  expectedStepEstimate: z.number().int().positive().nullable(),
  risks: z.array(AgentRiskSchema),
  expectedArtifacts: z.array(AgentArtifactDescriptorSchema),
  openQuestions: z.array(z.string()),
  steps: z.array(AgentStepSchema)
});

export const EventRefSchema = z.string().trim().min(1);

export const StepVerificationSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(EventRefSchema),
  issuesFound: z.array(z.string()),
  qualityConcerns: z.array(z.string())
});

export const GoalVerificationItemSchema = z.object({
  criterionId: z.string().trim().min(1).optional(),
  conditionId: z.string().trim().min(1).optional(),
  met: z.boolean(),
  evidenceRefs: z.array(EventRefSchema)
});

export const GoalVerificationSchema = z.object({
  successCriteriaMet: z.array(GoalVerificationItemSchema.extend({
    criterionId: z.string().trim().min(1)
  })),
  doneConditionsMet: z.array(GoalVerificationItemSchema.extend({
    conditionId: z.string().trim().min(1)
  })),
  passed: z.boolean(),
  qualityConcerns: z.array(z.string())
});

export const RecoveryFailureTypeSchema = z.enum([
  "validation_error",
  "tool_failure",
  "no_effect",
  "context_loss",
  "model_error",
  "auth_required",
  "timeout",
  "safety_block",
  "injection_detected",
  "repeated_step_loop",
  "no_progress_loop",
  "low_quality_path",
  "excessive_user_interruption",
  "schema_version_mismatch",
  "verifier_disagreement",
  "unknown"
]);

export const RecoveryStrategySchema = z.enum([
  "retry_same_tool",
  "retry_modified_input",
  "switch_tool",
  "re_evaluate_context",
  "replan_subgraph",
  "ask_user",
  "fail_gracefully",
  "stop_for_safety"
]);

export const RecoveryClassificationSchema = z.object({
  failureType: RecoveryFailureTypeSchema,
  classifiedReason: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
  sourceEventId: EventRefSchema.nullable()
});

export const RecoveryDecisionSchema = z.object({
  failureType: RecoveryFailureTypeSchema,
  classifiedReason: z.string().trim().min(1),
  strategy: RecoveryStrategySchema,
  retryCount: z.number().int().nonnegative(),
  capReached: z.boolean(),
  nextStepOverride: z.string().trim().min(1).nullable(),
  escalationRequired: z.boolean(),
  rationale: z.string().trim().min(1)
});

export const QualityMetricValueSchema = z.union([z.number().min(0).max(1), z.literal("N/A")]);

export const QualityMetricSetSchema = z.object({
  stepEfficiency: QualityMetricValueSchema,
  toolEfficiency: QualityMetricValueSchema,
  recoveryEfficiency: QualityMetricValueSchema,
  contextEfficiency: QualityMetricValueSchema,
  userInterruptionScore: QualityMetricValueSchema,
  redundancyScore: QualityMetricValueSchema,
  completionQuality: QualityMetricValueSchema
});

export const QualityWeightSetSchema = z.object({
  completionQuality: z.number().min(0).max(1),
  stepEfficiency: z.number().min(0).max(1),
  toolEfficiency: z.number().min(0).max(1),
  recoveryEfficiency: z.number().min(0).max(1),
  contextEfficiency: z.number().min(0).max(1),
  redundancyScore: z.number().min(0).max(1),
  userInterruptionScore: z.number().min(0).max(1)
});

export const RecommendedFixSchema = z.object({
  targetComponent: z.enum([
    "planner",
    "executor",
    "verifier",
    "recovery",
    "context",
    "safety",
    "tool",
    "memory",
    "model_adapter",
    "other"
  ]),
  changeType: z.enum([
    "prompt_change",
    "predicate_change",
    "manifest_change",
    "threshold_change",
    "logic_change",
    "new_tool",
    "other"
  ]),
  rationale: z.string().trim().min(1),
  evidenceRefs: z.array(EventRefSchema).min(1)
});

export const QualityReportSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().trim().min(1),
  generatedAt: isoDateTimeSchema,
  completed: z.boolean(),
  safetyViolation: z.boolean(),
  metrics: QualityMetricSetSchema,
  weights: QualityWeightSetSchema,
  overallScore: z.number().min(0).max(1),
  counts: z.object({
    totalSteps: z.number().int().nonnegative(),
    expectedStepEstimate: z.number().int().positive().nullable(),
    repeatedStepCount: z.number().int().nonnegative(),
    unnecessaryToolCallCount: z.number().int().nonnegative(),
    unnecessaryUserQuestionCount: z.number().int().nonnegative(),
    failedToolCallCount: z.number().int().nonnegative(),
    recoveryAttemptCount: z.number().int().nonnegative(),
    injectionDetectionCount: z.number().int().nonnegative(),
    doubleVerificationCount: z.number().int().nonnegative(),
    verifierDisagreementCount: z.number().int().nonnegative()
  }),
  rootCauseIfLowScore: z.string().trim().min(1).nullable(),
  recommendedFixes: z.array(RecommendedFixSchema),
  qualityConcerns: z.array(z.string())
});

export const FinalOutputArtifactSchema = z.object({
  id: z.string().trim().min(1),
  path: z.string().trim().min(1),
  kind: ArtifactKindSchema,
  sizeBytes: z.number().int().nonnegative(),
  hash: z.string().trim().min(1)
});

export const FinalOutputCheckSchema = z.object({
  criterion: z.string().trim().min(1),
  met: z.boolean(),
  evidenceRefs: z.array(EventRefSchema)
});

export const FinalOutputSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().trim().min(1),
  generatedAt: isoDateTimeSchema,
  summary: z.string(),
  artifacts: z.array(FinalOutputArtifactSchema),
  successCriteria: z.array(FinalOutputCheckSchema),
  doneConditions: z.array(z.object({
    condition: z.string().trim().min(1),
    met: z.boolean(),
    evidenceRefs: z.array(EventRefSchema)
  })),
  limitations: z.array(z.string()),
  skippedItems: z.array(z.object({
    item: z.string().trim().min(1),
    reason: z.string().trim().min(1)
  })),
  qualityReport: QualityReportSchema,
  nextSuggestedActions: z.array(z.string())
});

export const FailureOutputSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().trim().min(1),
  generatedAt: isoDateTimeSchema,
  partialSummary: z.string(),
  partialArtifacts: z.array(FinalOutputArtifactSchema),
  successCriteria: z.array(FinalOutputCheckSchema),
  doneConditions: z.array(z.object({
    condition: z.string().trim().min(1),
    met: z.boolean(),
    evidenceRefs: z.array(EventRefSchema)
  })),
  failedSteps: z.array(z.object({
    stepId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    evidenceRefs: z.array(EventRefSchema)
  })),
  qualityReport: QualityReportSchema,
  recommendedNextActions: z.array(z.string())
});

export const EvalTaskResultSchema = z.object({
  taskId: z.string().trim().min(1),
  passed: z.boolean(),
  reasons: z.array(z.string()),
  qualityReport: QualityReportSchema,
  pairedTraceDiff: jsonObjectSchema.nullable()
});

export const EvalAggregateReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoDateTimeSchema,
  totalTasks: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(EvalTaskResultSchema)
});

export const ContextItemProvenanceSchema = z.object({
  source: z.string().trim().min(1),
  eventRef: EventRefSchema,
  includedBecause: z.string().trim().min(1),
  tokens: z.number().int().nonnegative(),
  taint: z.boolean()
});

export const ContextPackItemSchema = z.object({
  itemId: z.string().trim().min(1),
  content: z.string(),
  provenance: ContextItemProvenanceSchema,
  rawEventRef: EventRefSchema.optional(),
  compacted: z.boolean().default(false)
});

export const ContextPackSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().trim().min(1),
  totalTokens: z.number().int().nonnegative(),
  budgetTokens: z.number().int().positive(),
  items: z.array(ContextPackItemSchema)
});

export const MemoryTrustLevelSchema = z.enum(["trusted", "untrusted", "unknown"]);

export const MemoryRefSchema = z.object({
  memoryId: z.string().trim().min(1),
  summary: z.string(),
  provenance: jsonObjectSchema,
  trustLevel: MemoryTrustLevelSchema,
  ttl: z.string().nullable()
});

export const MemoryWriteProposalSchema = z.object({
  proposalId: z.string().trim().min(1),
  item: jsonValueSchema,
  provenance: jsonObjectSchema,
  status: z.enum(["proposed", "committed", "rejected"]).default("proposed")
});

const EventBaseSchema = z.object({
  id: idSchema,
  occurredAt: isoDateTimeSchema
});

export const TaskCreatedEventSchema = EventBaseSchema.extend({
  type: z.literal("task.created"),
  payload: z.object({
    task: TaskSchema
  })
});

export const TaskUpdatedEventSchema = EventBaseSchema.extend({
  type: z.literal("task.updated"),
  payload: z.object({
    task: TaskSchema
  })
});

export const ModelMessageCreatedEventSchema = EventBaseSchema.extend({
  type: z.literal("model.message.created"),
  payload: z.object({
    message: ModelMessageSchema
  })
});

export const ToolCallRequestedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.call.requested"),
  payload: z.object({
    toolCall: ToolCallSchema
  })
});

export const ToolCallUpdatedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.call.updated"),
  payload: z.object({
    toolCall: ToolCallSchema
  })
});

export const ApprovalRequestedEventSchema = EventBaseSchema.extend({
  type: z.literal("approval.requested"),
  payload: z.object({
    approval: ApprovalRequestSchema
  })
});

export const ApprovalResolvedEventSchema = EventBaseSchema.extend({
  type: z.literal("approval.resolved"),
  payload: z.object({
    approval: ApprovalRequestSchema
  })
});

export const ArtifactCreatedEventSchema = EventBaseSchema.extend({
  type: z.literal("artifact.created"),
  payload: z.object({
    artifact: ArtifactSchema
  })
});

export const ToolRuntimeEventSchema = EventBaseSchema.extend({
  type: ToolEventTypeSchema,
  payload: z.object({
    event: ToolEventRecordSchema
  })
});

export const OperatorEventSchema = z.discriminatedUnion("type", [
  TaskCreatedEventSchema,
  TaskUpdatedEventSchema,
  ModelMessageCreatedEventSchema,
  ToolCallRequestedEventSchema,
  ToolCallUpdatedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  ArtifactCreatedEventSchema,
  ToolRuntimeEventSchema
]);

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("operator-dock-daemon"),
  version: z.string(),
  database: z.literal("ok"),
  state: z.enum(["starting", "recovering", "ready"]),
  build: z.object({
    gitCommit: z.string().trim().min(1),
    serverFileMtimeMs: z.number().nonnegative(),
    serverFileMtimeIso: isoDateTimeSchema
  }),
  timestamp: isoDateTimeSchema
});

export const CreateTaskResponseSchema = z.object({
  task: TaskSchema
});

export const TaskListResponseSchema = z.object({
  tasks: z.array(TaskSchema)
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ModelMessage = z.infer<typeof ModelMessageSchema>;
export type OperatorEvent = z.infer<typeof OperatorEventSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type CreateTaskResponse = z.infer<typeof CreateTaskResponseSchema>;
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type ProviderKind = z.infer<typeof ProviderKindSchema>;
export type ModelPurpose = z.infer<typeof ModelPurposeSchema>;
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;
export type ProviderModel = z.infer<typeof ProviderModelSchema>;
export type ModelPurposeDefaults = z.infer<typeof ModelPurposeDefaultsSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderConfigUpdate = z.infer<typeof ProviderConfigUpdateSchema>;
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;
export type ProviderConnectionTestResponse = z.infer<typeof ProviderConnectionTestResponseSchema>;
export type ModelRouterConfig = z.infer<typeof ModelRouterConfigSchema>;
export type ModelRouterConfigUpdate = z.infer<typeof ModelRouterConfigUpdateSchema>;
export type ModelRouterChatRequest = z.infer<typeof ModelRouterChatRequestSchema>;
export type ModelRouterChatResponse = z.infer<typeof ModelRouterChatResponseSchema>;
export type ModelProviderErrorKind = z.infer<typeof ModelProviderErrorKindSchema>;
export type ModelFallbackTarget = z.infer<typeof ModelFallbackTargetSchema>;
export type WorkspaceFolders = z.infer<typeof WorkspaceFoldersSchema>;
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
export type WorkspaceConfigureInput = z.infer<typeof WorkspaceConfigureInputSchema>;
export type FileEntry = z.infer<typeof FileEntrySchema>;
export type FileReadInput = z.infer<typeof FileReadInputSchema>;
export type FileReadOutput = z.infer<typeof FileReadOutputSchema>;
export type FileWriteInput = z.infer<typeof FileWriteInputSchema>;
export type FileAppendInput = z.infer<typeof FileAppendInputSchema>;
export type FileListInput = z.infer<typeof FileListInputSchema>;
export type FileSearchInput = z.infer<typeof FileSearchInputSchema>;
export type FileSearchOutput = z.infer<typeof FileSearchOutputSchema>;
export type FileCopyInput = z.infer<typeof FileCopyInputSchema>;
export type FileMoveInput = z.infer<typeof FileMoveInputSchema>;
export type FileDeleteInput = z.infer<typeof FileDeleteInputSchema>;
export type ToolRiskLevel = z.infer<typeof ToolRiskLevelSchema>;
export type ToolSideEffectClass = z.infer<typeof ToolSideEffectClassSchema>;
export type ToolCapabilityManifest = z.infer<typeof ToolCapabilityManifestSchema>;
export type SafetyDecisionValue = z.infer<typeof SafetyDecisionValueSchema>;
export type ToolCallCanonicalStatus = z.infer<typeof ToolCallCanonicalStatusSchema>;
export type TaskBudgetLimits = z.infer<typeof TaskBudgetLimitsSchema>;
export type ToolExecutionStatus = z.infer<typeof ToolExecutionStatusSchema>;
export type ToolEventType = z.infer<typeof ToolEventTypeSchema>;
export type ToolError = z.infer<typeof ToolErrorSchema>;
export type ToolEventRecord = z.infer<typeof ToolEventRecordSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ToolExecutionRequest = z.infer<typeof ToolExecutionRequestSchema>;
export type ToolApproval = z.infer<typeof ToolApprovalSchema>;
export type ShellRunInput = z.infer<typeof ShellRunInputSchema>;
export type ShellRunOutput = z.infer<typeof ShellRunOutputSchema>;
export type ShellRunInteractiveInput = z.infer<typeof ShellRunInteractiveInputSchema>;
export type ShellExecInput = z.infer<typeof ShellExecInputSchema>;
export type ShellExecOutput = z.infer<typeof ShellExecOutputSchema>;
export type HttpFetchInput = z.infer<typeof HttpFetchInputSchema>;
export type HttpFetchOutput = z.infer<typeof HttpFetchOutputSchema>;
export type SleepWaitInput = z.infer<typeof SleepWaitInputSchema>;
export type SleepWaitOutput = z.infer<typeof SleepWaitOutputSchema>;
export type AgentCriterion = z.infer<typeof AgentCriterionSchema>;
export type AgentRiskLevel = z.infer<typeof AgentRiskLevelSchema>;
export type AgentRisk = z.infer<typeof AgentRiskSchema>;
export type AgentArtifactDescriptor = z.infer<typeof AgentArtifactDescriptorSchema>;
export type AgentStep = z.infer<typeof AgentStepSchema>;
export type AgentPlan = z.infer<typeof AgentPlanSchema>;
export type StepVerification = z.infer<typeof StepVerificationSchema>;
export type GoalVerification = z.infer<typeof GoalVerificationSchema>;
export type RecoveryFailureType = z.infer<typeof RecoveryFailureTypeSchema>;
export type RecoveryStrategy = z.infer<typeof RecoveryStrategySchema>;
export type RecoveryClassification = z.infer<typeof RecoveryClassificationSchema>;
export type RecoveryDecision = z.infer<typeof RecoveryDecisionSchema>;
export type QualityMetricValue = z.infer<typeof QualityMetricValueSchema>;
export type RecommendedFix = z.infer<typeof RecommendedFixSchema>;
export type QualityReport = z.infer<typeof QualityReportSchema>;
export type FinalOutputArtifact = z.infer<typeof FinalOutputArtifactSchema>;
export type FinalOutput = z.infer<typeof FinalOutputSchema>;
export type FailureOutput = z.infer<typeof FailureOutputSchema>;
export type EvalTaskResult = z.infer<typeof EvalTaskResultSchema>;
export type EvalAggregateReport = z.infer<typeof EvalAggregateReportSchema>;
export type ContextPack = z.infer<typeof ContextPackSchema>;
export type ContextPackItem = z.infer<typeof ContextPackItemSchema>;
export type MemoryRef = z.infer<typeof MemoryRefSchema>;
export type MemoryWriteProposal = z.infer<typeof MemoryWriteProposalSchema>;
