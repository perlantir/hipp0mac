import type { ZodTypeAny } from "zod";
import type { JsonValue, ToolRiskLevel } from "@operator-dock/protocol";
import type { WorkspaceService } from "../../workspace/workspaceService.js";

export type ToolErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_SCHEMA_INVALID"
  | "TOOL_OUTPUT_INVALID"
  | "TOOL_APPROVAL_REQUIRED"
  | "TOOL_APPROVAL_REJECTED"
  | "TOOL_DENIED"
  | "TOOL_TIMEOUT"
  | "TOOL_CANCELLED"
  | "TOOL_EXECUTION_FAILED";

export interface ToolApprovalRequirement {
  reason: string;
  riskLevel?: ToolRiskLevel;
  code?: ToolErrorCode;
}

export interface ToolExecutionContext {
  executionId: string;
  workspace: WorkspaceService;
  signal: AbortSignal;
  approvalToken?: string;
  setRawOutputRef(rawOutputRef: string): void;
  writeRawOutput(content: string, extension?: string): Promise<string>;
}

export interface ToolDefinition<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly riskLevel: ToolRiskLevel;
  readonly inputSchema: ZodTypeAny;
  readonly outputSchema: ZodTypeAny;
  classifyRisk?(input: Input, context: Pick<ToolExecutionContext, "workspace">): ToolRiskLevel;
  requiresApproval?(input: Input, context: Pick<ToolExecutionContext, "workspace" | "approvalToken">): ToolApprovalRequirement | undefined;
  execute(input: Input, context: ToolExecutionContext): Promise<Output>;
}

export class ToolRuntimeError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details?: Record<string, JsonValue>
  ) {
    super(message);
    this.name = "ToolRuntimeError";
  }
}
