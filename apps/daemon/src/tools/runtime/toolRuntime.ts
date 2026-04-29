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
import { FsToolSafetyError } from "../fs/fsToolService.js";
import { collectSecretValues, redactJson, redactText } from "./secretRedaction.js";
import type { ToolApprovalStore, StoredToolApproval } from "./toolApprovalStore.js";
import type { ToolEventStore } from "./toolEventStore.js";
import { ToolRuntimeError, type ToolDefinition, type ToolErrorCode } from "./toolTypes.js";

export interface ToolRuntimeDependencies {
  workspace: WorkspaceService;
  events: ToolEventStore;
  approvals: ToolApprovalStore;
}

interface ActiveExecution {
  controller: AbortController;
}

interface NormalizedToolError {
  code: ToolErrorCode;
  message: string;
  status: ToolExecutionStatus;
}

export class ToolRuntime {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();
  private readonly active = new Map<string, ActiveExecution>();

  constructor(private readonly dependencies: ToolRuntimeDependencies) {}

  register(tool: ToolDefinition<unknown, unknown>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

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

    if (!approved) {
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

    return this.executeParsed(
      {
        toolName: approval.toolName,
        input: approval.input,
        retry: 0,
        approvalToken: approval.token
      },
      existing,
      approval
    );
  }

  cancel(executionId: string): ToolResult | undefined {
    const active = this.active.get(executionId);
    if (active !== undefined && !active.controller.signal.aborted) {
      active.controller.abort("cancelled");
    }

    return this.dependencies.events.getExecution(executionId);
  }

  private async executeParsed(
    request: ToolExecutionRequest,
    existingResult?: ToolResult,
    resumedApproval?: StoredToolApproval
  ): Promise<ToolResult> {
    const tool = this.tools.get(request.toolName);
    if (tool === undefined) {
      throw new ToolRuntimeError("TOOL_NOT_FOUND", `Tool is not registered: ${request.toolName}`);
    }

    const secretValues = collectSecretValues(request.input);
    const redactedInput = redactJson(request.input, secretValues) as Record<string, JsonValue>;
    const approvalToken = request.approvalToken ?? inputApprovalToken(request.input);
    const parseResult = tool.inputSchema.safeParse(request.input);
    const baseRisk = parseResult.success
      ? tool.classifyRisk?.(parseResult.data, { workspace: this.dependencies.workspace }) ?? tool.riskLevel
      : tool.riskLevel;
    const workspaceRoot = this.dependencies.workspace.getWorkspace()?.rootPath;
    const createExecutionInput = {
      toolName: tool.name,
      input: redactedInput,
      riskLevel: baseRisk,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot })
    };
    let result = existingResult === undefined
      ? this.dependencies.events.createExecution(createExecutionInput)
      : this.dependencies.events.markRunning(existingResult);

    if (!parseResult.success) {
      return this.failWithSchemaError(result, tool.name, parseResult.error);
    }

    const started = this.dependencies.events.recordEvent(result.executionId, tool.name, "tool.started", {
      input: redactedInput,
      ...(resumedApproval === undefined ? {} : { resumedApprovalId: resumedApproval.id })
    });
    result = {
      ...result,
      riskLevel: baseRisk,
      events: [...result.events, started]
    };

    const approval = tool.requiresApproval?.(parseResult.data, {
      workspace: this.dependencies.workspace,
      ...(approvalToken === undefined ? {} : { approvalToken })
    });

    if (approval !== undefined) {
      if (approval.code === "TOOL_DENIED") {
        const denied = this.dependencies.events.recordEvent(result.executionId, tool.name, "tool.failed", {
          code: "TOOL_DENIED",
          message: approval.reason
        });
        return this.dependencies.events.updateExecution(
          {
            ...result,
            events: [...result.events, denied]
          },
          "failed",
          undefined,
          "TOOL_DENIED",
          approval.reason
        );
      }

      const pendingApproval = this.dependencies.approvals.create({
        executionId: result.executionId,
        toolName: tool.name,
        riskLevel: approval.riskLevel ?? baseRisk,
        reason: approval.reason,
        input: redactedInput
      });
      const approvalEvent = this.dependencies.events.recordEvent(result.executionId, tool.name, "approval.required", {
        approvalId: pendingApproval.id,
        reason: pendingApproval.reason,
        riskLevel: pendingApproval.riskLevel
      });

      return this.dependencies.events.updateExecution(
        {
          ...result,
          events: [...result.events, approvalEvent]
        },
        "waiting_for_approval",
        undefined,
        "TOOL_APPROVAL_REQUIRED",
        approval.reason,
        undefined,
        {
          approvalId: pendingApproval.id
        }
      );
    }

    return this.runWithRetries(tool, parseResult.data, request, result, secretValues);
  }

  private async runWithRetries(
    tool: ToolDefinition<unknown, unknown>,
    input: unknown,
    request: ToolExecutionRequest,
    initialResult: ToolResult,
    secretValues: string[]
  ): Promise<ToolResult> {
    const maxAttempts = request.retry + 1;
    let result = initialResult;
    let lastError: NormalizedToolError | undefined;
    const approvalToken = request.approvalToken ?? inputApprovalToken(request.input);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      result = this.dependencies.events.updateAttempts(result, attempt);
      const controller = new AbortController();
      this.active.set(result.executionId, { controller });
      const timeoutMs = effectiveTimeout(request, input);
      let timeout: NodeJS.Timeout | undefined;
      let rawOutputRef: string | undefined;

      const context = {
        executionId: result.executionId,
        workspace: this.dependencies.workspace,
        signal: controller.signal,
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

        return this.dependencies.events.updateExecution(
          result,
          "completed",
          redactedOutput,
          undefined,
          undefined,
          rawOutputRef
        );
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
          return this.dependencies.events.updateExecution(
            result,
            lastError.status,
            undefined,
            lastError.code,
            redactText(lastError.message, secretValues),
            rawOutputRef
          );
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
    return this.dependencies.events.updateExecution(
      result,
      fallback.status,
      undefined,
      fallback.code,
      redactText(fallback.message, secretValues)
    );
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

  private async writeRawOutput(executionId: string, content: string, extension: string): Promise<string> {
    const workspace = this.dependencies.workspace.requireWorkspace();
    const outputDir = join(workspace.folders.logs, "tool-output");
    const outputPath = join(outputDir, `${executionId}.${extension}`);
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, content, "utf8");
    return outputPath;
  }
}

function effectiveTimeout(request: ToolExecutionRequest, input: unknown): number {
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

  return 30_000;
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
