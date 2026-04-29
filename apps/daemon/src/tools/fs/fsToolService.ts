import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  FileAppendInputSchema,
  FileCopyInputSchema,
  FileDeleteInputSchema,
  FileListInputSchema,
  FileMoveInputSchema,
  FileReadInputSchema,
  FileReadOutputSchema,
  FileSearchInputSchema,
  FileSearchOutputSchema,
  FileWriteInputSchema,
  type FileAppendInput,
  type FileCopyInput,
  type FileDeleteInput,
  type FileEntry,
  type FileListInput,
  type FileMoveInput,
  type FileReadInput,
  type FileSearchInput,
  type FileWriteInput,
  type JsonValue,
  type ToolResult,
  type ToolRiskLevel
} from "@operator-dock/protocol";
import { WorkspacePathSafety, type SafetyDecision } from "../../workspace/pathSafety.js";
import type { WorkspaceService } from "../../workspace/workspaceService.js";
import type { ToolEventStore } from "../runtime/toolEventStore.js";
import { FileOperationLogger } from "./fileOperationLogger.js";

type FsOperation = "read" | "write" | "append" | "list" | "search" | "copy" | "move" | "delete";

export interface FsToolExecutionContext {
  executionId: string;
  approvalToken?: string;
}

export class FsToolSafetyError extends Error {
  constructor(
    readonly code: "APPROVAL_REQUIRED" | "PATH_BLOCKED",
    message: string,
    readonly approvalRequired: boolean
  ) {
    super(message);
    this.name = "FsToolSafetyError";
  }
}

export class FsToolService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly events: ToolEventStore,
    private readonly fileLogger: FileOperationLogger
  ) {}

  async read(rawInput: unknown): Promise<ToolResult> {
    const input = FileReadInputSchema.parse(rawInput);
    return this.run("fs.read", "safe", input as Record<string, JsonValue>, (executionId) =>
      this.captureSafety(() => this.readOutput(input, { executionId }))
    );
  }

  async write(rawInput: unknown): Promise<ToolResult> {
    const input = FileWriteInputSchema.parse(rawInput);
    return this.run("fs.write", "medium", input as Record<string, JsonValue>, (executionId) =>
      this.captureSafety(() => this.writeOutput(input, { executionId }))
    );
  }

  async append(rawInput: unknown): Promise<ToolResult> {
    const input = FileAppendInputSchema.parse(rawInput);
    return this.run("fs.append", "medium", input as Record<string, JsonValue>, (executionId) =>
      this.captureSafety(() => this.appendOutput(input, { executionId }))
    );
  }

  async list(rawInput: unknown): Promise<ToolResult> {
    const input = FileListInputSchema.parse(rawInput);
    return this.run("fs.list", "safe", input as Record<string, JsonValue>, (executionId) =>
      this.captureSafety(() => this.listOutput(input, { executionId }))
    );
  }

  async search(rawInput: unknown): Promise<ToolResult> {
    const input = FileSearchInputSchema.parse(rawInput);
    return this.run("fs.search", "safe", input as Record<string, JsonValue>, (executionId) =>
      this.captureSafety(() => this.searchOutput(input, { executionId }))
    );
  }

  async copy(rawInput: unknown): Promise<ToolResult> {
    const input = FileCopyInputSchema.parse(rawInput);
    return this.run("fs.copy", "medium", input as Record<string, JsonValue>, (executionId) =>
      this.captureSafety(() => this.copyOutput(input, { executionId }))
    );
  }

  async move(rawInput: unknown): Promise<ToolResult> {
    const input = FileMoveInputSchema.parse(rawInput);
    return this.run("fs.move", "medium", input as Record<string, JsonValue>, (executionId) =>
      this.captureSafety(() => this.moveOutput(input, { executionId }))
    );
  }

  async delete(rawInput: unknown): Promise<ToolResult> {
    const input = FileDeleteInputSchema.parse(rawInput);
    return this.run("fs.delete", "dangerous", input as Record<string, JsonValue>, (executionId) =>
      this.captureSafety(() => this.deleteOutput(input, { executionId }))
    );
  }

  async readOutput(input: FileReadInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const safety = this.safety().checkRead(input.path);
    this.log("read", context.executionId, safety);

    const fileStat = await stat(safety.absolutePath);
    const maxBytes = Math.min(input.maxBytes, Number(fileStat.size));
    const content = await readFile(safety.absolutePath, {
      encoding: input.encoding
    });
    const sliced = content.slice(0, maxBytes);

    return FileReadOutputSchema.parse({
      path: safety.absolutePath,
      relativePath: safety.relativePath,
      content: sliced,
      bytesRead: Buffer.byteLength(sliced, input.encoding)
    });
  }

  async writeOutput(input: FileWriteInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const safety = this.safety().checkWrite(input.path, context.approvalToken ?? input.approvalToken);
    this.log("write", context.executionId, safety);
    assertSafe(safety);

    if (input.createDirs) {
      await mkdir(dirname(safety.absolutePath), { recursive: true });
    }
    await writeFile(safety.absolutePath, input.content, {
      encoding: "utf8",
      flag: input.overwrite ? "w" : "wx"
    });

    return {
      path: safety.absolutePath,
      relativePath: safety.relativePath,
      bytesWritten: Buffer.byteLength(input.content, "utf8")
    };
  }

  async appendOutput(input: FileAppendInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const safety = this.safety().checkWrite(input.path, context.approvalToken ?? input.approvalToken);
    this.log("append", context.executionId, safety);
    assertSafe(safety);

    if (input.createDirs) {
      await mkdir(dirname(safety.absolutePath), { recursive: true });
    }
    await appendFile(safety.absolutePath, input.content, "utf8");

    return {
      path: safety.absolutePath,
      relativePath: safety.relativePath,
      bytesWritten: Buffer.byteLength(input.content, "utf8")
    };
  }

  async listOutput(input: FileListInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const safety = this.safety().checkRead(input.path);
    this.log("list", context.executionId, safety);

    const entries = await this.listEntries(safety.absolutePath, input.recursive, input.maxEntries);
    return {
      entries: entries.map(fileEntryToJson)
    };
  }

  async searchOutput(input: FileSearchInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const safety = this.safety().checkRead(input.path);
    this.log("search", context.executionId, safety);

    const entries = await this.listEntries(safety.absolutePath, true, input.maxResults * 10);
    const files = entries.filter((entry) => entry.kind === "file").slice(0, input.maxResults * 10);
    const matches = [];

    for (const file of files) {
      if (matches.length >= input.maxResults) {
        break;
      }

      const fileMatches = await findInFile(file.path, file.relativePath, input.query, input.maxResults - matches.length);
      matches.push(...fileMatches);
    }

    return FileSearchOutputSchema.parse({ matches });
  }

  async copyOutput(input: FileCopyInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const from = this.safety().checkRead(input.from);
    const to = this.safety().checkWrite(input.to, context.approvalToken ?? input.approvalToken);
    this.log("copy", context.executionId, to, from.absolutePath);
    assertSafe(to);

    await mkdir(dirname(to.absolutePath), { recursive: true });
    await copyFile(from.absolutePath, to.absolutePath, input.overwrite ? 0 : constants.COPYFILE_EXCL);
    return {
      path: to.absolutePath,
      relativePath: to.relativePath
    };
  }

  async moveOutput(input: FileMoveInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const approvalToken = context.approvalToken ?? input.approvalToken;
    const from = this.safety().checkWrite(input.from, approvalToken);
    const to = this.safety().checkWrite(input.to, approvalToken);
    this.log("move", context.executionId, to, from.absolutePath);
    assertSafe(from);
    assertSafe(to);

    await mkdir(dirname(to.absolutePath), { recursive: true });
    if (!input.overwrite) {
      await stat(to.absolutePath).then(
        () => {
          throw new Error("Destination already exists.");
        },
        () => undefined
      );
    }
    await rename(from.absolutePath, to.absolutePath);
    return {
      path: to.absolutePath,
      relativePath: to.relativePath
    };
  }

  async deleteOutput(input: FileDeleteInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const safety = this.safety().checkDelete(input.path, context.approvalToken ?? input.approvalToken);
    this.log("delete", context.executionId, safety);
    assertSafe(safety);

    await rm(safety.absolutePath, {
      recursive: input.recursive,
      force: false
    });
    return {
      path: safety.absolutePath,
      relativePath: safety.relativePath
    };
  }

  private async run(
    toolName: string,
    riskLevel: ToolRiskLevel,
    input: Record<string, JsonValue>,
    operation: (executionId: string) => Promise<JsonValue | SafetyFailure>
  ): Promise<ToolResult> {
    const workspace = this.workspaceService.requireWorkspace();
    let result = this.events.createExecution({
      toolName,
      input,
      riskLevel,
      workspaceRoot: workspace.rootPath
    });

    const started = this.events.recordEvent(result.executionId, toolName, "tool.started", {
      input
    });

    try {
      const output = await operation(result.executionId);

      if (isSafetyFailure(output)) {
        const eventType = output.approvalRequired ? "approval.required" : "tool.failed";
        const event = this.events.recordEvent(result.executionId, toolName, eventType, {
          code: output.code,
          message: output.message
        });
        result = {
          ...result,
          events: [started, event]
        };

        return this.events.updateExecution(
          result,
          output.approvalRequired ? "waiting_for_approval" : "failed",
          undefined,
          output.code,
          output.message
        );
      }

      const outputEvent = this.events.recordEvent(result.executionId, toolName, "tool.output", {
        output: output as JsonValue
      });
      const completed = this.events.recordEvent(result.executionId, toolName, "tool.completed", {});
      result = {
        ...result,
        events: [started, outputEvent, completed]
      };

      return this.events.updateExecution(result, "completed", output as JsonValue);
    } catch (error) {
      const failed = this.events.recordEvent(result.executionId, toolName, "tool.failed", {
        code: "FILE_OPERATION_FAILED",
        message: (error as Error).message
      });
      result = {
        ...result,
        events: [started, failed]
      };

      return this.events.updateExecution(
        result,
        "failed",
        undefined,
        "FILE_OPERATION_FAILED",
        (error as Error).message
      );
    }
  }

  private safety(): WorkspacePathSafety {
    return new WorkspacePathSafety(this.workspaceService.requireWorkspace());
  }

  private async listEntries(root: string, recursive: boolean, maxEntries: number): Promise<FileEntry[]> {
    const workspace = this.workspaceService.requireWorkspace();
    const safety = new WorkspacePathSafety(workspace);
    const entries: FileEntry[] = [];

    const visit = async (dir: string): Promise<void> => {
      if (entries.length >= maxEntries) {
        return;
      }

      const children = await readdir(dir, { withFileTypes: true });
      for (const child of children) {
        if (entries.length >= maxEntries) {
          break;
        }

        const absolutePath = join(dir, child.name);
        const childStat = await stat(absolutePath);
        const resolved = safety.resolvePath(absolutePath);
        const entry: FileEntry = {
          name: child.name,
          path: absolutePath,
          relativePath: resolved.relativePath,
          kind: child.isDirectory() ? "directory" : "file",
          modifiedAt: childStat.mtime.toISOString()
        };
        if (child.isFile()) {
          entry.size = Number(childStat.size);
        }
        entries.push(entry);

        if (recursive && child.isDirectory()) {
          await visit(absolutePath);
        }
      }
    };

    await visit(root);
    return entries;
  }

  private log(
    operation: FsOperation,
    executionId: string,
    decision: SafetyDecision,
    secondaryPath?: string
  ): void {
    const logInput = {
      executionId,
      operation,
      primaryPath: decision.absolutePath,
      allowed: decision.allowed,
      approvalRequired: decision.approvalRequired,
      metadata: {
        insideWorkspace: decision.insideWorkspace
      }
    };

    this.fileLogger.log({
      ...logInput,
      ...(secondaryPath === undefined ? {} : { secondaryPath }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason })
    });
  }

  private async captureSafety(operation: () => Promise<JsonValue>): Promise<JsonValue | SafetyFailure> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof FsToolSafetyError) {
        return {
          code: error.code,
          message: error.message,
          approvalRequired: error.approvalRequired
        };
      }

      throw error;
    }
  }
}

function fileEntryToJson(entry: FileEntry): Record<string, JsonValue> {
  return {
    name: entry.name,
    path: entry.path,
    relativePath: entry.relativePath,
    kind: entry.kind,
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt })
  };
}

interface SafetyFailure {
  code: "APPROVAL_REQUIRED" | "PATH_BLOCKED";
  message: string;
  approvalRequired: boolean;
}

function assertSafe(decision: SafetyDecision): void {
  if (decision.allowed) {
    return;
  }

  throw new FsToolSafetyError(
    decision.approvalRequired ? "APPROVAL_REQUIRED" : "PATH_BLOCKED",
    decision.reason ?? "File operation blocked by workspace safety policy.",
    decision.approvalRequired
  );
}

function isSafetyFailure(value: JsonValue | SafetyFailure): value is SafetyFailure {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "code" in value
    && "approvalRequired" in value;
}

async function findInFile(path: string, relativePath: string, query: string, maxResults: number) {
  const matches = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({
    input: stream,
    crlfDelay: Infinity
  });
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.includes(query)) {
        matches.push({
          path,
          relativePath,
          line: lineNumber,
          preview: line.trim()
        });
        if (matches.length >= maxResults) {
          break;
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return matches;
}
