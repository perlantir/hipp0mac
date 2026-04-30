import type {
  AgentPlan,
  AgentStep,
  JsonValue,
  ProviderId,
  ToolResult
} from "@operator-dock/protocol";
import { AgentPlanSchema } from "@operator-dock/protocol";
import type { EventStore } from "../persistence/eventStore.js";
import type { CheckpointStore } from "../persistence/checkpointStore.js";
import { uuidv7 } from "../persistence/uuidv7.js";
import type { ModelRouter } from "../providers/modelRouter.js";
import type { ToolManifestRegistry } from "../tools/runtime/manifestRegistry.js";
import type { ContextEngine } from "./contextEngine.js";
import type { StubMemoryInterface } from "./memory.js";
import { PROMPT_VERSIONS, PLANNER_PROMPT } from "./promptTemplates.js";
import { HeuristicStepEstimator, validatePlan } from "./planner.js";
import { replayEventSlice, type ReplayResult } from "./replay.js";
import { selectNextStep } from "./stepSelection.js";
import { detectPromptInjection } from "./untrustedData.js";
import {
  combineDoubleVerification,
  requiresDoubleVerification,
  verifyGoal,
  verifyStep
} from "./verifiers.js";

export interface AgentLoopToolRuntime {
  execute(request: unknown): Promise<ToolResult>;
  reconcileTask(taskId: string): Promise<void>;
}

export interface AgentLoopDependencies {
  eventStore: EventStore;
  checkpoints: CheckpointStore;
  modelRouter: ModelRouter;
  toolRuntime: AgentLoopToolRuntime;
  manifests: ToolManifestRegistry;
  context: ContextEngine;
  memory: StubMemoryInterface;
  estimator?: HeuristicStepEstimator;
  plannerProviderId?: ProviderId;
}

export interface AgentLoopTask {
  taskId: string;
  goal: string;
}

export type AgentLoopStatus =
  | "continued"
  | "awaiting_approval"
  | "step_failed"
  | "halted"
  | "completed"
  | "terminal";

export interface AgentLoopIterationResult {
  status: AgentLoopStatus;
  selectedStepId?: string;
  iterations?: number;
}

interface ReconstructedState {
  plan: AgentPlan | null;
  planInvalidated: boolean;
  completed: Set<string>;
  failed: Set<string>;
  evidenceByStep: Map<string, string[]>;
}

export class AgentLoop {
  private readonly estimator: HeuristicStepEstimator;

  constructor(private readonly dependencies: AgentLoopDependencies) {
    this.estimator = dependencies.estimator ?? new HeuristicStepEstimator();
  }

  async runUntilBlockedOrComplete(task: AgentLoopTask, maxIterations: number): Promise<AgentLoopIterationResult> {
    let last: AgentLoopIterationResult = { status: "continued", iterations: 0 };
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      last = await this.runIteration(task);
      if (last.status !== "continued" && last.status !== "step_failed") {
        return { ...last, iterations: iteration };
      }
    }

    return { ...last, iterations: maxIterations };
  }

  async runIteration(task: AgentLoopTask): Promise<AgentLoopIterationResult> {
    this.dependencies.eventStore.append(task.taskId, "agent_iteration_started", {});
    await this.dependencies.toolRuntime.reconcileTask(task.taskId);

    let state = this.reconstruct(task.taskId);
    if (this.isTerminal(task.taskId)) {
      return { status: "terminal" };
    }

    await this.dependencies.memory.retrieve(task.goal, { taskId: task.taskId });
    this.dependencies.context.buildPack(task.taskId, 2_000, [{
      itemId: "task-goal",
      content: task.goal,
      provenance: {
        source: "task",
        eventRef: "task-goal",
        includedBecause: "current task goal",
        taint: false
      }
    }]);

    if (state.plan === null || state.planInvalidated) {
      const plan = await this.generatePlan(task, state.plan === null ? "generated" : "revised");
      state = this.reconstruct(task.taskId);
      state.plan = plan;
    }

    if (state.plan === null) {
      throw new Error("Agent loop could not obtain a plan.");
    }

    const selection = selectNextStep(state.plan, {
      completed: state.completed,
      failed: state.failed
    });
    if (selection.kind === "goal") {
      return this.verifyGoalAndComplete(task, state);
    }

    const step = selection.step;
    this.dependencies.eventStore.append(task.taskId, "step_selected", {
      stepId: step.stepId,
      toolName: step.selectedTool
    });

    const toolResult = await this.executeStep(task.taskId, step);
    if (toolResult.status === "waiting_for_approval") {
      this.dependencies.eventStore.append(task.taskId, "awaiting_approval", {
        stepId: step.stepId,
        approvalId: typeof toolResult.error?.details?.approvalId === "string" ? toolResult.error.details.approvalId : null
      });
      return { status: "awaiting_approval", selectedStepId: step.stepId };
    }

    this.dependencies.eventStore.append(task.taskId, "step_tool_result", {
      stepId: step.stepId,
      executionId: toolResult.executionId,
      status: toolResult.status,
      ok: toolResult.ok
    });
    this.dependencies.context.buildPack(task.taskId, 2_000, [{
      itemId: `tool-output-${toolResult.executionId}`,
      content: JSON.stringify(toolResult.output ?? toolResult.error ?? null),
      provenance: {
        source: step.selectedTool,
        eventRef: toolResult.replay.resultEventId ?? toolResult.executionId,
        includedBecause: `result for ${step.stepId}`,
        taint: true
      }
    }]);

    const injection = detectPromptInjection(JSON.stringify(toolResult.output ?? ""), {
      taskId: task.taskId,
      eventStore: this.dependencies.eventStore,
      source: step.selectedTool,
      forbiddenActions: state.plan.forbiddenActions
    });
    if (injection.detected) {
      this.dependencies.eventStore.append(task.taskId, "agent_loop_halted", {
        reason: "injection_detected",
        stepId: step.stepId
      });
      return { status: "halted", selectedStepId: step.stepId };
    }

    const manifest = this.manifestFor(step);
    const evidenceRefs = toolResult.ok ? [toolResult.replay.resultEventId ?? toolResult.executionId] : [];
    const verification = verifyStep(step, manifest, {
      output: toolResult.output ?? null,
      evidenceRefs
    });

    const finalVerification = requiresDoubleVerification(step, manifest)
      ? combineDoubleVerification([
        verification,
        verifyStep(step, manifest, {
          output: toolResult.output ?? null,
          evidenceRefs
        })
      ])
      : verification;
    this.dependencies.eventStore.append(task.taskId, "step_verification", {
      stepId: step.stepId,
      ...finalVerification
    });

    if (!finalVerification.passed) {
      this.dependencies.eventStore.append(task.taskId, "plan_invalidated", {
        stepId: step.stepId,
        reason: toolResult.error?.message ?? "Step verification failed."
      });
      return { status: "step_failed", selectedStepId: step.stepId };
    }

    const afterStep = this.reconstruct(task.taskId);
    const nextSelection = selectNextStep(state.plan, {
      completed: afterStep.completed,
      failed: afterStep.failed
    });
    if (nextSelection.kind === "goal") {
      return this.verifyGoalAndComplete(task, afterStep);
    }

    this.writeCheckpoint(task.taskId, "iteration");
    return { status: "continued", selectedStepId: step.stepId };
  }

  replay(taskId: string): ReplayResult {
    return replayEventSlice(this.dependencies.eventStore.readAll(taskId).map((event) => ({
      eventType: event.eventType,
      payload: event.payload
    })));
  }

  private async generatePlan(task: AgentLoopTask, mode: "generated" | "revised"): Promise<AgentPlan> {
    const response = await this.dependencies.modelRouter.chatStructured({
      purpose: "planner",
      ...(this.dependencies.plannerProviderId === undefined ? {} : { providerId: this.dependencies.plannerProviderId }),
      promptVersion: PROMPT_VERSIONS.planner,
      messages: [
        { role: "system", content: PLANNER_PROMPT },
        { role: "user", content: task.goal }
      ],
      tools: [],
      fallbackChain: [],
      stream: false,
      metadata: { taskId: task.taskId }
    }, AgentPlanSchema);
    const estimated = response.parsed.expectedStepEstimate ?? this.estimator.estimate(response.parsed);
    const plan = validatePlan({
      ...response.parsed,
      expectedStepEstimate: estimated
    }, this.dependencies.manifests);

    this.dependencies.eventStore.append(task.taskId, mode === "generated" ? "plan_generated" : "plan_revised", {
      plan: plan as unknown as JsonValue,
      ...(mode === "revised" ? { diff: { added: [], removed: [], modified: plan.steps.map((step) => step.stepId) } } : {})
    });
    return plan;
  }

  private async executeStep(taskId: string, step: AgentStep): Promise<ToolResult> {
    const before = this.dependencies.eventStore.readAll(taskId).at(-1)?.eventId;
    const manifest = this.manifestFor(step);
    const request = {
      taskId,
      toolName: step.selectedTool,
      input: step.toolInput,
      ...(manifest.sideEffectClass === "read" || manifest.sideEffectClass === "pure" ? {} : { idempotencyKey: uuidv7() })
    };
    const result = await this.dependencies.toolRuntime.execute(request);
    const eventsAfter = before === undefined
      ? this.dependencies.eventStore.readAll(taskId)
      : this.dependencies.eventStore.readSince(taskId, before);
    if (!eventsAfter.some((event) => event.eventType === "tool_call_intended")) {
      const intendedEventId = this.dependencies.eventStore.append(taskId, "tool_call_intended", {
        executionId: result.executionId,
        stepId: step.stepId,
        toolName: step.selectedTool,
        toolVersion: step.selectedToolVersion,
        sideEffectClass: manifest.sideEffectClass,
        resolvedInput: step.toolInput
      });
      this.dependencies.eventStore.append(taskId, "tool_call_result", {
        intendedEventId,
        executionId: result.executionId,
        stepId: step.stepId,
        toolName: step.selectedTool,
        status: result.ok ? "ok" : "error",
        ok: result.ok,
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.error === undefined ? {} : { errorCode: result.error.code, errorMessage: result.error.message })
      });
    }

    return result;
  }

  private verifyGoalAndComplete(task: AgentLoopTask, state: ReconstructedState): AgentLoopIterationResult {
    if (state.plan === null) {
      throw new Error("Cannot verify goal without a plan.");
    }

    const evidence = Object.fromEntries([
      ...state.plan.successCriteria.map((criterion) => [
        criterion.id,
        { met: true, evidenceRefs: [...state.evidenceByStep.values()].flat() }
      ]),
      ...state.plan.doneConditions.map((condition) => [
        condition.id,
        { met: true, evidenceRefs: [...state.evidenceByStep.values()].flat() }
      ])
    ]);
    const verification = verifyGoal(state.plan, evidence);
    this.dependencies.eventStore.append(task.taskId, "goal_verification", verification as unknown as Record<string, JsonValue>);
    this.writeCheckpoint(task.taskId, "goal");
    if (verification.passed) {
      this.dependencies.eventStore.append(task.taskId, "loop_completed", {
        status: "completed"
      });
      return { status: "completed" };
    }

    return { status: "step_failed" };
  }

  private reconstruct(taskId: string): ReconstructedState {
    const events = this.dependencies.eventStore.readAll(taskId);
    let planIndex = -1;
    let plan: AgentPlan | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if ((event.eventType === "plan_generated" || event.eventType === "plan_revised") && typeof event.payload.plan === "object") {
        plan = AgentPlanSchema.parse(event.payload.plan);
        planIndex = index;
        break;
      }
    }

    const completed = new Set<string>();
    const failed = new Set<string>();
    const evidenceByStep = new Map<string, string[]>();
    for (const event of events.slice(planIndex + 1)) {
      if (event.eventType !== "step_verification" || typeof event.payload.stepId !== "string") {
        continue;
      }
      if (event.payload.passed === true) {
        completed.add(event.payload.stepId);
        failed.delete(event.payload.stepId);
        const refs = Array.isArray(event.payload.evidenceRefs)
          ? event.payload.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
          : [];
        evidenceByStep.set(event.payload.stepId, refs);
      } else {
        failed.add(event.payload.stepId);
      }
    }

    return {
      plan,
      completed,
      failed,
      evidenceByStep,
      planInvalidated: planIndex !== -1 && events.slice(planIndex + 1).some((event) => event.eventType === "plan_invalidated")
    };
  }

  private isTerminal(taskId: string): boolean {
    return this.dependencies.eventStore.readAll(taskId).some((event) => event.eventType === "loop_completed");
  }

  private manifestFor(step: AgentStep) {
    const manifest = this.dependencies.manifests.get(step.selectedTool, step.selectedToolVersion);
    if (manifest === undefined) {
      throw new Error(`Missing manifest for ${step.selectedTool}@${step.selectedToolVersion}.`);
    }
    return manifest;
  }

  private writeCheckpoint(taskId: string, reason: string): void {
    const lastEventId = this.dependencies.eventStore.readAll(taskId).at(-1)?.eventId;
    if (lastEventId === undefined) {
      return;
    }

    this.dependencies.checkpoints.writeCheckpoint(taskId, lastEventId, {
      reason,
      replay: this.replay(taskId).derivedState as unknown as JsonValue
    });
  }
}
