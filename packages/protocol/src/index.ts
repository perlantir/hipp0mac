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

export const OperatorEventSchema = z.discriminatedUnion("type", [
  TaskCreatedEventSchema,
  TaskUpdatedEventSchema,
  ModelMessageCreatedEventSchema,
  ToolCallRequestedEventSchema,
  ToolCallUpdatedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  ArtifactCreatedEventSchema
]);

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("operator-dock-daemon"),
  version: z.string(),
  database: z.literal("ok"),
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
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ModelMessage = z.infer<typeof ModelMessageSchema>;
export type OperatorEvent = z.infer<typeof OperatorEventSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type CreateTaskResponse = z.infer<typeof CreateTaskResponseSchema>;
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

