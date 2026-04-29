import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";
import {
  ToolExecutionRequestSchema,
  type JsonValue,
  type ToolExecutionRequest,
  type ToolExecutionStatus,
  type ToolResult,
  type ToolRiskLevel
} from "@operator-dock/protocol";
import type { WorkspaceService } from "../../workspace/workspaceService.js";
import type { LockController, TaskLockHandle } from "../../persistence/lockController.js";
import { uuidv7 } from "../../persistence/uuidv7.js";
import { FsToolSafetyError } from "../fs/fsToolService.js";
import { BudgetManager, pricingVersion, resultBytes } from "./budgetManager.js";
import { collectSecretValues, redactJson, redactText } from "./secretRedaction.js";
import { SafetyGovernor, type SafetyGovernorDecision } from "./safetyGovernor.js";
import type { ToolApprovalStore, StoredToolApproval } from "./toolApprovalStore.js";
import type { ToolEventStore } from "./toolEventStore.js";
import { ToolManifestRegistry } from "./manifestRegistry.js";
import { ToolRuntimeError, type ToolDefinition, type ToolErrorCode } from "./toolTypes.js";

export interface ToolRuntimeDependencies {
  workspace: WorkspaceService;
  events: ToolEventStore;
  approvals: ToolApprovalStore;
  locks: LockController;
  manifests: ToolManifestRegistry;
  safety: SafetyGovernor;
  budgets: BudgetManager;
  crashAfterIntended?: (context: { taskId: string; executionId: string; toolName: string }) => void | Promise<void>;
}

interface ActiveExecution {
  controller: AbortController;
  taskId: string;
}

interface NormalizedToolError {
  code: ToolErrorCode;
  message: string;
  status: ToolExecutionStatus;
}

export class ToolRuntime {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();
  private readonly active = new Map<string, ActiveExecution>();
  private readonly pauseAfterActive = new Set<string>();

  constructor(private readonly dependencies: ToolRuntimeDependencies) {}

  register(tool: ToolDefinition<unknown, unknown>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.dependencies.manifests.register(tool.manifest);
    this.tools.set(tool.name, tool);
  }

  async execute(rawRequest: unknown): Promise<ToolResult> {
    const request = ToolExecutionRequestSchema.parse(rawRequest);
    return this.executeParsed(request);
  }

  async resumeApproval(approvalId: string, approved: boolean): Promise<ToolResult> {
    const approval = this.dependencies.approvals.resolve(approvalId, approved);
    if (approval === undefined) {
      throw new ToolRuntimeError("TOOL_EXECUTION_FAILED", "Approval request was not found.");
    }

    const existing = this.dependencies.events.getExecution(approval.executionId);
    if (existing === undefined) {
      throw new ToolRuntimeError("TOOL_EXECUTION_FAILED", "Approval execution was not found.");
    }

    const taskId = existing.replay.taskId ?? "tool-runtime";
    if (!approved) {
      this.dependencies.events.appendCanonical(taskId, "approval_denied", {
        approvalId,
        executionId: existing.executionId,
        toolName: existing.toolName
      });
      const failed = this.dependencies.events.recordEvent(existing.executionId, existing.toolName, "tool.failed", {
        code: "TOOL_APPROVAL_REJECTED",
        message: "Approval was rejected."
      });
      return this.dependencies.events.updateExecution(
        {
          ...existing,
          events: [...existing.events, failed]
        },
        "failed",
        undefined,
        "TOOL_APPROVAL_REJECTED",
        "Approval was rejected."
      );
    }

    const approvalEventId = this.dependencies.events.appendCanonical(taskId, "approval_granted", {
      approvalId,
      executionId: existing.executionId,
      toolName: existing.toolName,
      idempotencyKey: typeof existing.replay.idempotencyKey === "string" ? existing.replay.idempotencyKey : null
    });

    return this.executeParsed(
      {
        toolName: approval.toolName,
        input: approval.input,
        retry: 0,
        approvalToken: approval.token,
        allowedNetworkHosts: [],
        idempotencyKey: typeof existing.replay.idempotencyKey === "string" ? existing.replay.idempotencyKey : undefined
      },
      existing,
      approval,
      approvalEventId
    );
  }

  cancel(executionId: string): ToolResult | undefined {
    const active = this.active.get(executionId);
    if (active !== undefined && !active.controller.signal.aborted) {
      active.controller.abort("cancelled");
    }

    return this.dependencies.events.getExecution(executionId);
  }

  async pause(taskId: string): Promise<void> {
    const active = [...this.active.values()].find((execution) => execution.taskId === taskId);
    this.dependencies.events.appendCanonical(taskId, "pause_requested", {});
    if (active === undefined) {
      this.dependencies.events.appendCanonical(taskId, "task_state_transition", { state: "paused" });
      return;
    }

    this.pauseAfterActive.add(taskId);
  }

  kill(taskId: string): void {
    for (const [executionId, active] of this.active.entries()) {
      if (active.taskId === taskId && !active.controller.signal.aborted) {
        active.controller.abort("cancelled");
        this.dependencies.events.appendCanonical(taskId, "kill_requested", { executionId });
      }
    }
  }

  async reconcileAll(): Promise<void> {
    for (const taskId of this.dependencies.events.canonicalTaskIds()) {
      await this.reconcileTask(taskId);
    }
  }

  async reconcileTask(taskId: string): Promise<void> {
    const orphan = this.findLatestOrphan(taskId);
    if (orphan === undefined) {
      return;
    }

    const payload = orphan.payload;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
    if (toolName === undefined) {
      return;
    }

    const tool = this.tools.get(toolName);
    if (tool === undefined) {
      this.dependencies.events.appendCanonical(taskId, "reconciliation_blocked", {
        intendedEventId: orphan.eventId,
        reason: "Tool is not registered."
      });
      return;
    }

    const manifest = tool.manifest;
    const idempotencyKey = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined;
    const resolvedInput = isJsonObject(payload.resolvedInput) ? payload.resolvedInput : {};
    this.dependencies.events.appendCanonical(taskId, "orphan_reconciliation_started", {
      intendedEventId: orphan.eventId,
      toolName,
      sideEffectClass: manifest.sideEffectClass,
      idempotencyKey: idempotencyKey ?? null
    });

    if (
      (manifest.sideEffectClass === "write-non-idempotent" || manifest.sideEffectClass === "external")
      && manifest.supportsStatusQuery
      && idempotencyKey !== undefined
      && tool.statusQuery !== undefined
    ) {
      const status = await tool.statusQuery(idempotencyKey);
      if (status.applied) {
        this.dependencies.events.appendCanonical(taskId, "tool_call_result", {
          intendedEventId: orphan.eventId,
          executionId: typeof payload.executionId === "string" ? payload.executionId : null,
          toolName,
          status: "ok",
          ok: true,
          output: status.output ?? null,
          synthesized: true,
          durationMs: 0,
          bytesIn: 0,
          bytesOut: status.output === undefined ? 0 : JSON.stringify(status.output).length,
          costUsd: 0,
          pricingVersion
        });
        this.dependencies.events.appendCanonical(taskId, "orphan_reconciliation_synthesized", {
          intendedEventId: orphan.eventId,
          toolName
        });
        return;
      }
    }

    if (
      (manifest.sideEffectClass === "write-non-idempotent" || manifest.sideEffectClass === "external")
      && !manifest.supportsStatusQuery
    ) {
      this.dependencies.events.appendCanonical(taskId, "reconciliation_blocked", {
        intendedEventId: orphan.eventId,
        toolName,
        reason: "Tool cannot answer whether the idempotency key applied."
      });
      return;
    }

    this.dependencies.events.appendCanonical(taskId, "orphan_reconciliation_reexecute", {
      intendedEventId: orphan.eventId,
      toolName,
      idempotencyKey: idempotencyKey ?? null
    });
    await this.execute({
      taskId,
      toolName,
      input: resolvedInput,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey })
    });
  }

  private async executeParsed(
    request: ToolExecutionRequest,
    existingResult?: ToolResult,
    resumedApproval?: StoredToolApproval,
    approvalEventId?: string
  ): Promise<ToolResult> {
    const tool = this.tools.get(request.toolName);
    if (tool === undefined) {
      throw new ToolRuntimeError("TOOL_NOT_FOUND", `Tool is not registered: ${request.toolName}`);
    }

    const manifest = tool.manifest;
    const taskId = existingResult?.replay.taskId ?? request.taskId ?? "tool-runtime";
    const workspaceRoot = this.dependencies.workspace.getWorkspace()?.rootPath;
    const parseResult = tool.inputSchema.safeParse(request.input);
    const secretValues = collectSecretValues(request.input);
    const redactedInput = redactJson(request.input, secretValues) as Record<string, JsonValue>;
    const baseRisk = parseResult.success
      ? tool.classifyRisk?.(parseResult.data, { workspace: this.dependencies.workspace }) ?? tool.riskLevel
      : tool.riskLevel;
    const idempotencyKey = this.idempotencyKeyFor(manifest.sideEffectClass, request, existingResult);

    let result = existingResult ?? this.dependencies.events.createPendingExecution({
      taskId,
      toolName: tool.name,
      input: redactedInput,
      riskLevel: baseRisk,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey })
    });

    if (!parseResult.success) {
      return this.failWithSchemaError(result, tool.name, parseResult.error);
    }

    const safety = resumedApproval === undefined
      ? this.dependencies.safety.decide({
        taskId,
        manifest,
        input: redactedInput,
        allowedNetworkHosts: request.allowedNetworkHosts
      })
      : {
        eventId: typeof result.replay.safetyDecisionEventId === "string"
          ? result.replay.safetyDecisionEventId
          : "",
        decision: "approval_required" as const,
        matchedPredicate: manifest.approvalPolicy,
        scopeViolation: null,
        scopeChecks: []
      } satisfies SafetyGovernorDecision;

    if (resumedApproval === undefined) {
      result = this.dependencies.events.withReplay(result, {
        safetyDecisionEventId: safety.eventId,
        safetyDecision: safety.decision
      });
    }

    if (safety.decision === "deny") {
      const denied = this.dependencies.events.recordEvent(result.executionId, tool.name, "tool.failed", {
        code: "TOOL_DENIED",
        message: safety.scopeViolation?.reason ?? "Tool input was denied by the Safety Governor."
      });
      return this.dependencies.events.updateExecution(
        {
          ...result,
          events: [...result.events, denied]
        },
        "failed",
        undefined,
        "TOOL_DENIED",
        safety.scopeViolation?.reason ?? "Tool input was denied by the Safety Governor."
      );
    }

    if (safety.decision === "approval_required" && resumedApproval === undefined) {
      const pendingApproval = this.dependencies.approvals.create({
        executionId: result.executionId,
        toolName: tool.name,
        riskLevel: baseRisk,
        reason: "Tool execution requires approval.",
        input: redactedInput
      });
      const approvalEvent = this.dependencies.events.recordEvent(result.executionId, tool.name, "approval.required", {
        approvalId: pendingApproval.id,
        reason: pendingApproval.reason,
        riskLevel: pendingApproval.riskLevel,
        idempotencyKey: idempotencyKey ?? null
      });

      return this.dependencies.events.updateExecution(
        {
          ...result,
          events: [...result.events, approvalEvent]
        },
        "waiting_for_approval",
        undefined,
        "TOOL_APPROVAL_REQUIRED",
        pendingApproval.reason,
        undefined,
        {
          approvalId: pendingApproval.id,
          safetyDecisionEventId: safety.eventId
        }
      );
    }

    const timeoutMs = effectiveTimeout(request, parseResult.data, manifest.timeoutPolicy.defaultMs);
    if (timeoutMs > manifest.timeoutPolicy.maxMs) {
      const failed = this.dependencies.events.recordEvent(result.executionId, tool.name, "tool.failed", {
        code: "TOOL_TIMEOUT",
        message: "Requested timeout exceeds the tool manifest maxMs."
      });
      return this.dependencies.events.updateExecution(
        {
          ...result,
          events: [...result.events, failed]
        },
        "failed",
        undefined,
        "TOOL_TIMEOUT",
        "Requested timeout exceeds the tool manifest maxMs."
      );
    }

    const budget = this.dependencies.budgets.checkBeforeExecute({
      taskId,
      manifest,
      input: redactedInput,
      timeoutMs,
      ...(request.budgetLimits === undefined ? {} : { limits: request.budgetLimits })
    });
    if (!budget.allowed) {
      const failed = this.dependencies.events.recordEvent(result.executionId, tool.name, "tool.failed", {
        code: "TOOL_EXECUTION_FAILED",
        message: "Task budget would be exceeded before executing the tool.",
        budget: budget.exceeded as unknown as JsonValue
      });
      return this.dependencies.events.updateExecution(
        {
          ...result,
          events: [...result.events, failed]
        },
        "blocked",
        undefined,
        "TOOL_EXECUTION_FAILED",
        "Task budget would be exceeded before executing the tool.",
        undefined,
        {
          budget: budget.exceeded as unknown as JsonValue
        }
      );
    }

    const lock = this.dependencies.locks.acquire(taskId);
    try {
      result = this.dependencies.events.startExecution(result, {
        manifest,
        resolvedInput: redactedInput,
        safetyDecision: {
          eventId: safety.eventId,
          decision: safety.decision
        },
        scopeChecks: safety.scopeChecks as unknown as JsonValue,
        timeoutMs,
        lockEventId: lock.lockEventId,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(approvalEventId === undefined ? {} : { approvalEventId })
      });

      await this.dependencies.crashAfterIntended?.({ taskId, executionId: result.executionId, toolName: tool.name });

      const started = this.dependencies.events.recordEvent(result.executionId, tool.name, "tool.started", {
        input: redactedInput,
        ...(resumedApproval === undefined ? {} : { resumedApprovalId: resumedApproval.id })
      });
      result = {
        ...result,
        riskLevel: baseRisk,
        events: [...result.events, started]
      };

      return await this.runWithRetries(tool, parseResult.data, request, result, secretValues, timeoutMs, idempotencyKey);
    } finally {
      releaseLock(this.dependencies.locks, lock);
    }
  }

  private async runWithRetries(
    tool: ToolDefinition<unknown, unknown>,
    input: unknown,
    request: ToolExecutionRequest,
    initialResult: ToolResult,
    secretValues: string[],
    timeoutMs: number,
    idempotencyKey: string | undefined
  ): Promise<ToolResult> {
    const maxAttempts = request.retry + 1;
    let result = initialResult;
    let lastError: NormalizedToolError | undefined;
    const approvalToken = request.approvalToken ?? inputApprovalToken(request.input);
    const startedAt = performance.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      result = this.dependencies.events.updateAttempts(result, attempt);
      const controller = new AbortController();
      this.active.set(result.executionId, { controller, taskId: result.replay.taskId ?? "tool-runtime" });
      let timeout: NodeJS.Timeout | undefined;
      let rawOutputRef: string | undefined;

      const context = {
        executionId: result.executionId,
        workspace: this.dependencies.workspace,
        signal: controller.signal,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(approvalToken === undefined ? {} : { approvalToken }),
        setRawOutputRef: (ref: string) => {
          rawOutputRef = ref;
        },
        writeRawOutput: async (content: string, extension = "txt") => {
          const ref = await this.writeRawOutput(result.executionId, redactText(content, secretValues), extension);
          rawOutputRef = ref;
          return ref;
        }
      };

      try {
        const operation = Promise.resolve(tool.execute(input, context));
        const output = await new Promise<unknown>((resolvePromise, reject) => {
          timeout = setTimeout(() => {
            controller.abort("timeout");
            reject(new ToolRuntimeError("TOOL_TIMEOUT", "Tool execution timed out."));
          }, timeoutMs);

          operation.then(resolvePromise, reject);
        });

        if (timeout !== undefined) {
          clearTimeout(timeout);
        }

        const parsedOutput = tool.outputSchema.parse(output) as JsonValue;
        const redactedOutput = redactJson(parsedOutput, secretValues);
        const outputEvent = this.dependencies.events.recordEvent(result.executionId, tool.name, "tool.output", {
          output: redactedOutput
        });
        const completed = this.dependencies.events.recordEvent(result.executionId, tool.name, "tool.completed", {
          attempt
        });
        result = {
          ...result,
          events: [...result.events, outputEvent, completed]
        };

        const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        const bytes = resultBytes(request.input, redactedOutput);
        result = this.dependencies.events.withReplay(result, {
          durationMs,
          bytesIn: bytes.bytesIn,
          bytesOut: bytes.bytesOut,
          pricingVersion
        });
        const updated = this.dependencies.events.updateExecution(
          result,
          "completed",
          redactedOutput,
          undefined,
          undefined,
          rawOutputRef
        );
        this.completePauseIfNeeded(updated);
        return updated;
      } catch (error) {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }

        lastError = normalizeToolError(error);
        const eventType = lastError.status === "cancelled" ? "tool.cancelled" : "tool.failed";
        const failed = this.dependencies.events.recordEvent(result.executionId, tool.name, eventType, {
          code: lastError.code,
          message: redactText(lastError.message, secretValues),
          attempt
        });
        result = {
          ...result,
          events: [...result.events, failed]
        };

        if (!shouldRetry(lastError) || attempt >= maxAttempts) {
          const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
          const bytes = resultBytes(request.input, undefined);
          result = this.dependencies.events.withReplay(result, {
            durationMs,
            bytesIn: bytes.bytesIn,
            bytesOut: bytes.bytesOut,
            pricingVersion
          });
          const updated = this.dependencies.events.updateExecution(
            result,
            lastError.status,
            undefined,
            lastError.code,
            redactText(lastError.message, secretValues),
            rawOutputRef
          );
          this.completePauseIfNeeded(updated);
          return updated;
        }
      } finally {
        this.active.delete(result.executionId);
      }
    }

    const fallback = lastError ?? {
      code: "TOOL_EXECUTION_FAILED" as const,
      message: "Tool execution failed.",
      status: "failed" as const
    };
    const updated = this.dependencies.events.updateExecution(
      result,
      fallback.status,
      undefined,
      fallback.code,
      redactText(fallback.message, secretValues)
    );
    this.completePauseIfNeeded(updated);
    return updated;
  }

  private failWithSchemaError(result: ToolResult, toolName: string, error: ZodError): ToolResult {
    const event = this.dependencies.events.recordEvent(result.executionId, toolName, "tool.failed", {
      code: "TOOL_SCHEMA_INVALID",
      message: "Tool input failed schema validation.",
      issues: error.issues.map((issue) => issue.message)
    });

    return this.dependencies.events.updateExecution(
      {
        ...result,
        events: [...result.events, event]
      },
      "failed",
      undefined,
      "TOOL_SCHEMA_INVALID",
      "Tool input failed schema validation.",
      undefined,
      {
        issues: error.issues.map((issue) => issue.message)
      }
    );
  }

  private idempotencyKeyFor(
    sideEffectClass: string,
    request: ToolExecutionRequest,
    existingResult?: ToolResult
  ): string | undefined {
    if (sideEffectClass === "pure" || sideEffectClass === "read") {
      return undefined;
    }

    if (typeof existingResult?.replay.idempotencyKey === "string") {
      return existingResult.replay.idempotencyKey;
    }

    return request.idempotencyKey ?? uuidv7();
  }

  private findLatestOrphan(taskId: string) {
    const events = this.dependencies.events.canonicalEvents(taskId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.eventType !== "tool_call_intended") {
        continue;
      }

      const hasResult = events
        .slice(index + 1)
        .some((candidate) =>
          candidate.eventType === "tool_call_result"
          && candidate.payload.intendedEventId === event.eventId
        );
      return hasResult ? undefined : event;
    }

    return undefined;
  }

  private completePauseIfNeeded(result: ToolResult): void {
    const taskId = result.replay.taskId;
    if (typeof taskId === "string" && this.pauseAfterActive.delete(taskId)) {
      this.dependencies.events.appendCanonical(taskId, "task_state_transition", { state: "paused" });
    }
  }

  private async writeRawOutput(executionId: string, content: string, extension: string): Promise<string> {
    const workspace = this.dependencies.workspace.requireWorkspace();
    const outputDir = join(workspace.folders.logs, "tool-output");
    const outputPath = join(outputDir, `${executionId}.${extension}`);
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, content, "utf8");
    return outputPath;
  }
}

function releaseLock(locks: LockController, lock: TaskLockHandle): void {
  locks.release(lock);
}

function effectiveTimeout(
  request: ToolExecutionRequest,
  input: unknown,
  defaultMs: number
): number {
  if (request.timeoutMs !== undefined) {
    return request.timeoutMs;
  }

  if (
    typeof input === "object"
    && input !== null
    && "timeoutMs" in input
    && typeof input.timeoutMs === "number"
  ) {
    return input.timeoutMs;
  }

  return defaultMs;
}

function normalizeToolError(error: unknown): NormalizedToolError {
  if (error instanceof ToolRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      status: statusForErrorCode(error.code)
    };
  }

  if (error instanceof FsToolSafetyError) {
    return {
      code: error.approvalRequired ? "TOOL_APPROVAL_REQUIRED" : "TOOL_DENIED",
      message: error.message,
      status: error.approvalRequired ? "waiting_for_approval" : "failed"
    };
  }

  if (error instanceof ZodError) {
    return {
      code: "TOOL_OUTPUT_INVALID",
      message: "Tool output failed schema validation.",
      status: "failed"
    };
  }

  return {
    code: "TOOL_EXECUTION_FAILED",
    message: error instanceof Error ? error.message : "Tool execution failed.",
    status: "failed"
  };
}

function statusForErrorCode(code: ToolErrorCode): ToolExecutionStatus {
  switch (code) {
  case "TOOL_TIMEOUT":
    return "timed_out";
  case "TOOL_CANCELLED":
    return "cancelled";
  case "TOOL_APPROVAL_REQUIRED":
    return "waiting_for_approval";
  default:
    return "failed";
  }
}

function shouldRetry(error: NormalizedToolError): boolean {
  return error.code === "TOOL_EXECUTION_FAILED" || error.code === "TOOL_OUTPUT_INVALID";
}

function inputApprovalToken(input: Record<string, JsonValue>): string | undefined {
  const token = input.approvalToken;
  return typeof token === "string" && token.trim().length > 0 ? token : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
