import { describe, expect, it } from "vitest";
import {
  ModelMessageSchema,
  OperatorEventSchema,
  TaskCreateInputSchema,
  TaskSchema,
  ToolCallSchema
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
});

