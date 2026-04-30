import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ProviderIdSchema } from "@operator-dock/protocol";
import { ApiError } from "../errors.js";
import type { TaskRepository } from "../tasks/taskRepository.js";
import type { AgentLoop } from "./agentLoop.js";

export interface AgentLoopRouteDependencies {
  tasks: TaskRepository;
  loop: AgentLoop;
}

const AgentLoopRunInputSchema = z.object({
  goal: z.string().trim().min(1).optional(),
  plannerProviderId: ProviderIdSchema.optional(),
  maxIterations: z.number().int().positive().max(100).default(1)
});

export async function registerAgentLoopRoutes(
  app: FastifyInstance,
  dependencies: AgentLoopRouteDependencies
): Promise<void> {
  app.post("/v1/tasks/:taskId/agent/iterate", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const input = AgentLoopRunInputSchema.parse(request.body ?? {});
    const goal = input.goal ?? taskGoal(dependencies.tasks, taskId);
    return {
      result: await dependencies.loop.runIteration({
        taskId,
        goal,
        ...(input.plannerProviderId === undefined ? {} : { plannerProviderId: input.plannerProviderId })
      })
    };
  });

  app.post("/v1/tasks/:taskId/agent/run", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const input = AgentLoopRunInputSchema.parse(request.body ?? {});
    const goal = input.goal ?? taskGoal(dependencies.tasks, taskId);
    return {
      result: await dependencies.loop.runUntilBlockedOrComplete({
        taskId,
        goal,
        ...(input.plannerProviderId === undefined ? {} : { plannerProviderId: input.plannerProviderId })
      }, input.maxIterations)
    };
  });

  app.get("/v1/tasks/:taskId/agent/replay", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    return {
      replay: dependencies.loop.replay(taskId)
    };
  });
}

function taskGoal(tasks: TaskRepository, taskId: string): string {
  const task = tasks.getTask(taskId);
  if (task === undefined) {
    throw new ApiError(404, "TASK_NOT_FOUND", `Task not found: ${taskId}`);
  }

  return task.prompt;
}
