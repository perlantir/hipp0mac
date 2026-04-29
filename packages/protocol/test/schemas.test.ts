import { describe, expect, it } from "vitest";
import {
  ModelMessageSchema,
  ModelRouterChatRequestSchema,
  ProviderConfigSchema,
  OperatorEventSchema,
  TaskCreateInputSchema,
  TaskSchema,
  ToolApprovalSchema,
  ToolCallSchema,
  ToolExecutionRequestSchema,
  ToolResultSchema
} from "../src/index.js";

const task = {
  id: "3c765f62-0b9e-4902-a776-1fa2b9a0b513",
  title: "Index repo",
  prompt: "Inspect the repository and create an execution plan.",
  status: "queued",
  priority: "normal",
  metadata: {
    source: "test"
  },
  createdAt: "2026-04-29T13:00:00.000Z",
  updatedAt: "2026-04-29T13:00:00.000Z"
};

describe("protocol schemas", () => {
  it("validates task creation input and applies defaults", () => {
    const parsed = TaskCreateInputSchema.parse({
      title: "Smoke test",
      prompt: "Create a task."
    });

    expect(parsed.priority).toBe("normal");
    expect(parsed.metadata).toEqual({});
  });

  it("rejects empty task creation payloads", () => {
    expect(
      TaskCreateInputSchema.safeParse({
        title: "",
        prompt: ""
      }).success
    ).toBe(false);
  });

  it("validates task lifecycle events", () => {
    expect(
      OperatorEventSchema.parse({
        id: "054cdb48-950b-4794-9316-c7b0987efbef",
        type: "task.created",
        occurredAt: "2026-04-29T13:01:00.000Z",
        payload: {
          task: TaskSchema.parse(task)
        }
      }).type
    ).toBe("task.created");
  });

  it("validates model messages and tool calls", () => {
    const toolCall = ToolCallSchema.parse({
      id: "43bfdffe-fbc2-4e28-a818-9b7cf365c957",
      taskId: task.id,
      toolName: "filesystem.read",
      status: "requested",
      input: {
        path: "/tmp/example.txt"
      },
      createdAt: "2026-04-29T13:02:00.000Z",
      updatedAt: "2026-04-29T13:02:00.000Z"
    });

    const message = ModelMessageSchema.parse({
      id: "5af6e155-5c11-4d3c-8688-23a1ae3ae5ba",
      taskId: task.id,
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "I need to read a file."
        },
        {
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.toolName,
          input: toolCall.input
        }
      ],
      createdAt: "2026-04-29T13:03:00.000Z"
    });

    expect(message.parts).toHaveLength(2);
  });

  it("validates provider configuration without accepting plaintext secrets", () => {
    const provider = ProviderConfigSchema.parse({
      id: "openai",
      kind: "hosted",
      displayName: "OpenAI",
      enabled: true,
      defaultModel: "gpt-4.1",
      roleDefaults: {
        planner: "gpt-4.1"
      },
      apiKeyConfigured: true,
      models: [
        {
          id: "gpt-4.1",
          displayName: "GPT-4.1",
          capabilities: {
            vision: true,
            tools: true,
            streaming: true,
            maxContextTokens: 128000
          }
        }
      ]
    });

    expect(provider).not.toHaveProperty("apiKey");
  });

  it("validates normalized model router chat requests", () => {
    const parsed = ModelRouterChatRequestSchema.parse({
      purpose: "planner",
      messages: [
        {
          role: "user",
          content: "Create an execution plan."
        }
      ]
    });

    expect(parsed.stream).toBe(false);
    expect(parsed.tools).toEqual([]);
  });

  it("validates tool runtime requests, approvals, and replay metadata", () => {
    const request = ToolExecutionRequestSchema.parse({
      toolName: "fs.write",
      input: {
        path: "tasks/demo.md",
        content: "hello"
      }
    });

    expect(request.retry).toBe(0);

    const approval = ToolApprovalSchema.parse({
      id: "a1a5290c-121f-4e8c-bb1a-f4fd0504e4e5",
      executionId: "7c199b54-ac58-4f9c-acdc-a79d767ed776",
      toolName: "shell.run",
      riskLevel: "dangerous",
      reason: "Commands using sudo require approval.",
      status: "pending",
      createdAt: "2026-04-29T13:04:00.000Z"
    });

    const result = ToolResultSchema.parse({
      executionId: approval.executionId,
      toolName: "shell.run",
      status: "waiting_for_approval",
      riskLevel: "dangerous",
      ok: false,
      error: {
        code: "TOOL_APPROVAL_REQUIRED",
        message: approval.reason,
        details: {
          approvalId: approval.id
        }
      },
      events: [],
      replay: {
        inputHash: "0".repeat(64),
        startedAt: "2026-04-29T13:04:00.000Z",
        attempts: 1
      }
    });

    expect(result.error?.details?.approvalId).toBe(approval.id);
  });
});
