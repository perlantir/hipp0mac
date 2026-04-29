import type { FastifyInstance } from "fastify";
import {
  ToolApprovalListResponseSchema,
  ToolApprovalResolveInputSchema,
  ToolExecutionResponseSchema
} from "@operator-dock/protocol";
import { ApiError } from "../../errors.js";
import type { ToolApprovalStore } from "./toolApprovalStore.js";
import { ToolRuntime } from "./toolRuntime.js";
import { ToolRuntimeError } from "./toolTypes.js";

export interface ToolRuntimeRouteDependencies {
  runtime: ToolRuntime;
  approvals: ToolApprovalStore;
}

export async function registerToolRuntimeRoutes(
  app: FastifyInstance,
  dependencies: ToolRuntimeRouteDependencies
): Promise<void> {
  app.post("/v1/tools/execute", async (request) => {
    return ToolExecutionResponseSchema.parse({
      result: await translateRuntimeError(() => dependencies.runtime.execute(request.body))
    });
  });

  app.post("/v1/tools/executions/:executionId/cancel", async (request) => {
    const params = request.params as { executionId: string };
    const result = dependencies.runtime.cancel(params.executionId);
    if (result === undefined) {
      throw new ApiError(404, "TOOL_EXECUTION_NOT_FOUND", "Tool execution was not found.");
    }

    return ToolExecutionResponseSchema.parse({ result });
  });

  app.post("/v1/tasks/:taskId/pause", async (request) => {
    const params = request.params as { taskId: string };
    await dependencies.runtime.pause(params.taskId);
    return { ok: true };
  });

  app.post("/v1/tasks/:taskId/kill", async (request) => {
    const params = request.params as { taskId: string };
    dependencies.runtime.kill(params.taskId);
    return { ok: true };
  });

  app.get("/v1/tools/approvals", async () => {
    return ToolApprovalListResponseSchema.parse({
      approvals: dependencies.approvals.listPending()
    });
  });

  app.post("/v1/tools/approvals/:approvalId/resolve", async (request) => {
    const params = request.params as { approvalId: string };
    const input = ToolApprovalResolveInputSchema.parse(request.body);
    return ToolExecutionResponseSchema.parse({
      result: await translateRuntimeError(() => dependencies.runtime.resumeApproval(params.approvalId, input.approved))
    });
  });
}

async function translateRuntimeError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ToolRuntimeError) {
      const statusCode = error.code === "TOOL_NOT_FOUND" ? 404 : 400;
      throw new ApiError(statusCode, error.code, error.message, error.details);
    }

    throw error;
  }
}
