import {
  FileAppendInputSchema,
  FileCopyInputSchema,
  FileDeleteInputSchema,
  FileListInputSchema,
  FileListResponseSchema,
  FileMoveInputSchema,
  FileMutationOutputSchema,
  FileReadInputSchema,
  FileReadOutputSchema,
  FileSearchInputSchema,
  FileSearchOutputSchema,
  FileWriteInputSchema,
  type FileAppendInput,
  type FileCopyInput,
  type FileDeleteInput,
  type FileListInput,
  type FileMoveInput,
  type FileReadInput,
  type FileSearchInput,
  type FileWriteInput,
  type JsonValue
} from "@operator-dock/protocol";
import { WorkspacePathSafety, type SafetyDecision } from "../../workspace/pathSafety.js";
import type { ToolDefinition, ToolExecutionContext, ToolApprovalRequirement } from "../runtime/toolTypes.js";
import type { IdempotencyStore } from "../runtime/idempotencyStore.js";
import { fsDeleteManifest, fsReadManifest, fsWriteManifest, toolManifest } from "../runtime/toolManifests.js";
import type { FsToolService } from "./fsToolService.js";

export function fsToolDefinitions(
  fsTools: FsToolService,
  idempotency: IdempotencyStore
): Array<ToolDefinition<unknown, JsonValue>> {
  return [
    {
      name: "fs.read",
      version: "1",
      description: "Read a file from the workspace or an approved local path.",
      riskLevel: "safe",
      manifest: fsReadManifest("fs.read"),
      inputSchema: FileReadInputSchema,
      outputSchema: FileReadOutputSchema,
      execute: (input, context) => fsTools.readOutput(input as FileReadInput, context)
    },
    {
      name: "fs.write",
      version: "1",
      description: "Write UTF-8 content to a workspace file, creating folders when requested.",
      riskLevel: "medium",
      manifest: fsWriteManifest(),
      inputSchema: FileWriteInputSchema,
      outputSchema: FileMutationOutputSchema,
      classifyRisk: (input, context) => writeRisk(context, (input as FileWriteInput).path),
      requiresApproval: (input, context) => writeApproval(context, (input as FileWriteInput).path),
      execute: (input, context) => fsTools.writeOutput(input as FileWriteInput, fsContext(context)),
      statusQuery: async (idempotencyKey) => {
        const record = idempotency.lookup("fs.write", idempotencyKey);
        return record === undefined ? { applied: false } : { applied: true, output: record.output };
      }
    },
    {
      name: "fs.append",
      version: "1",
      description: "Append UTF-8 content to a workspace file.",
      riskLevel: "medium",
      manifest: toolManifest({
        name: "fs.append",
        description: "Append UTF-8 content to a workspace file.",
        sideEffectClass: "write-non-idempotent",
        supportsIdempotency: true,
        filesystemScope: { mode: "workspace", paths: [] },
        approvalPolicy: { op: "always" }
      }),
      inputSchema: FileAppendInputSchema,
      outputSchema: FileMutationOutputSchema,
      classifyRisk: (input, context) => writeRisk(context, (input as FileAppendInput).path),
      requiresApproval: (input, context) => writeApproval(context, (input as FileAppendInput).path),
      execute: (input, context) => fsTools.appendOutput(input as FileAppendInput, fsContext(context))
    },
    {
      name: "fs.list",
      version: "1",
      description: "List files and folders below a workspace path.",
      riskLevel: "safe",
      manifest: fsReadManifest("fs.list"),
      inputSchema: FileListInputSchema,
      outputSchema: FileListResponseSchema,
      execute: (input, context) => fsTools.listOutput(input as FileListInput, context)
    },
    {
      name: "fs.search",
      version: "1",
      description: "Search UTF-8 files below a workspace path.",
      riskLevel: "safe",
      manifest: fsReadManifest("fs.search"),
      inputSchema: FileSearchInputSchema,
      outputSchema: FileSearchOutputSchema,
      execute: (input, context) => fsTools.searchOutput(input as FileSearchInput, context)
    },
    {
      name: "fs.copy",
      version: "1",
      description: "Copy a file into a workspace or approved local path.",
      riskLevel: "medium",
      manifest: toolManifest({
        name: "fs.copy",
        description: "Copy a file into a workspace path.",
        sideEffectClass: "write-non-idempotent",
        supportsIdempotency: true,
        filesystemScope: { mode: "workspace", paths: [] },
        approvalPolicy: { op: "always" }
      }),
      inputSchema: FileCopyInputSchema,
      outputSchema: FileMutationOutputSchema,
      classifyRisk: (input, context) => writeRisk(context, (input as FileCopyInput).to),
      requiresApproval: (input, context) => writeApproval(context, (input as FileCopyInput).to),
      execute: (input, context) => fsTools.copyOutput(input as FileCopyInput, fsContext(context))
    },
    {
      name: "fs.move",
      version: "1",
      description: "Move a file between workspace or approved local paths.",
      riskLevel: "medium",
      manifest: toolManifest({
        name: "fs.move",
        description: "Move a file inside the workspace.",
        sideEffectClass: "write-non-idempotent",
        supportsIdempotency: true,
        filesystemScope: { mode: "workspace", paths: [] },
        approvalPolicy: { op: "always" }
      }),
      inputSchema: FileMoveInputSchema,
      outputSchema: FileMutationOutputSchema,
      classifyRisk: (input, context) => {
        const moveInput = input as FileMoveInput;
        const fromRisk = writeRisk(context, moveInput.from);
        const toRisk = writeRisk(context, moveInput.to);
        return fromRisk === "dangerous" || toRisk === "dangerous" ? "dangerous" : "medium";
      },
      requiresApproval: (input, context) => {
        const moveInput = input as FileMoveInput;
        return writeApproval(context, moveInput.from) ?? writeApproval(context, moveInput.to);
      },
      execute: (input, context) => fsTools.moveOutput(input as FileMoveInput, fsContext(context))
    },
    {
      name: "fs.delete",
      version: "1",
      description: "Delete a workspace file or an approved local path. System folders are denied.",
      riskLevel: "dangerous",
      manifest: fsDeleteManifest(),
      inputSchema: FileDeleteInputSchema,
      outputSchema: FileMutationOutputSchema,
      classifyRisk: () => "dangerous",
      requiresApproval: (input, context) => deleteApproval(context, (input as FileDeleteInput).path),
      execute: (input, context) => fsTools.deleteOutput(input as FileDeleteInput, fsContext(context)),
      statusQuery: async (idempotencyKey) => {
        const record = idempotency.lookup("fs.delete", idempotencyKey);
        return record === undefined ? { applied: false } : { applied: true, output: record.output };
      }
    }
  ];
}

function fsContext(context: ToolExecutionContext) {
  return {
    executionId: context.executionId,
    ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
    ...(context.approvalToken === undefined ? {} : { approvalToken: context.approvalToken })
  };
}

function writeRisk(context: Pick<ToolExecutionContext, "workspace">, path: string) {
  const workspace = context.workspace.requireWorkspace();
  return new WorkspacePathSafety(workspace).checkWrite(path).insideWorkspace ? "medium" : "dangerous";
}

function writeApproval(
  context: Pick<ToolExecutionContext, "workspace" | "approvalToken">,
  path: string
): ToolApprovalRequirement | undefined {
  return approvalFromDecision(new WorkspacePathSafety(context.workspace.requireWorkspace()).checkWrite(path, context.approvalToken));
}

function deleteApproval(
  context: Pick<ToolExecutionContext, "workspace" | "approvalToken">,
  path: string
): ToolApprovalRequirement | undefined {
  return approvalFromDecision(new WorkspacePathSafety(context.workspace.requireWorkspace()).checkDelete(path, context.approvalToken));
}

function approvalFromDecision(decision: SafetyDecision): ToolApprovalRequirement | undefined {
  if (decision.allowed) {
    return undefined;
  }

  return {
    reason: decision.reason ?? "File operation blocked by workspace safety policy.",
    riskLevel: "dangerous",
    code: decision.approvalRequired ? "TOOL_APPROVAL_REQUIRED" : "TOOL_DENIED"
  };
}
