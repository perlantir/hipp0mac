import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
import type { LockController } from "../../persistence/lockController.js";
import type { ToolEventStore } from "../runtime/toolEventStore.js";
import type { FileMutationRecord, IdempotencyStore } from "../runtime/idempotencyStore.js";
import type { ToolStatusQueryResult } from "../runtime/toolTypes.js";
import { FileOperationLogger } from "./fileOperationLogger.js";

type FsOperation = "read" | "write" | "append" | "list" | "search" | "copy" | "move" | "delete";

export interface FsToolExecutionContext {
  executionId: string;
  idempotencyKey?: string;
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
    private readonly fileLogger: FileOperationLogger,
    private readonly locks: LockController,
    private readonly idempotency: IdempotencyStore
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
      contents: sliced,
      bytesRead: Buffer.byteLength(sliced, input.encoding),
      sizeBytes: Number(fileStat.size),
      mtime: fileStat.mtime.toISOString()
    });
  }

  async writeOutput(input: FileWriteInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const safety = this.safety().checkWrite(input.path, context.approvalToken ?? input.approvalToken);
    this.log("write", context.executionId, safety);
    assertSafe(safety);
    const contents = input.contents ?? input.content ?? "";
    const hash = this.idempotency.contentHash(contents);
    if (context.idempotencyKey !== undefined) {
      const previous = this.idempotency.lookup("fs.write", context.idempotencyKey);
      if (previous !== undefined) {
        if (previous.contentHash !== hash) {
          throw new Error("Idempotency key was already used with different file contents.");
        }

        return {
          ...(previous.output as Record<string, JsonValue>),
          idempotent: true
        };
      }
    }

    if (input.createDirs) {
      await mkdir(dirname(safety.absolutePath), { recursive: true });
    }
    await writeFile(safety.absolutePath, contents, {
      mode: input.mode,
      encoding: "utf8",
      flag: input.overwrite ? "w" : "wx"
    });

    const output = {
      path: safety.absolutePath,
      relativePath: safety.relativePath,
      bytesWritten: Buffer.byteLength(contents, "utf8"),
      sizeBytes: Buffer.byteLength(contents, "utf8"),
      hash
    };
    if (context.idempotencyKey !== undefined) {
      this.idempotency.record({
        toolName: "fs.write",
        idempotencyKey: context.idempotencyKey,
        contentHash: hash,
        output
      });
    }

    return output;
  }

  async appendOutput(input: FileAppendInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const safety = this.safety().checkWrite(input.path, context.approvalToken ?? input.approvalToken);
    this.log("append", context.executionId, safety);
    assertSafe(safety);
    const contentBuffer = Buffer.from(input.content, "utf8");
    const contentHash = this.idempotency.bufferHash(contentBuffer);
    if (context.idempotencyKey !== undefined) {
      const previous = this.idempotency.lookupFileMutation("fs.append", context.idempotencyKey);
      if (previous !== undefined) {
        this.assertFileMutationReplay(previous, "fs.append", safety.absolutePath, contentHash);
        const output = await this.applyPreparedAppend(previous, input.content);
        return {
          ...(output as Record<string, JsonValue>),
          idempotent: true
        };
      }
    }

    if (input.createDirs) {
      await mkdir(dirname(safety.absolutePath), { recursive: true });
    }
    if (context.idempotencyKey === undefined) {
      await writeFile(safety.absolutePath, input.content, { encoding: "utf8", flag: "a" });
      return {
        path: safety.absolutePath,
        relativePath: safety.relativePath,
        bytesWritten: Buffer.byteLength(input.content, "utf8")
      };
    }

    const before = await this.readFileOrEmpty(safety.absolutePath);
    const after = Buffer.concat([before, contentBuffer]);
    const output = {
      path: safety.absolutePath,
      relativePath: safety.relativePath,
      bytesWritten: contentBuffer.byteLength,
      sizeBytes: after.byteLength,
      hash: this.idempotency.bufferHash(after)
    };
    const record = this.idempotency.prepareFileMutation({
      toolName: "fs.append",
      idempotencyKey: context.idempotencyKey,
      targetPath: safety.absolutePath,
      relativePath: safety.relativePath,
      inputDigest: this.idempotency.contentHash(JSON.stringify({
        path: input.path,
        createDirs: input.createDirs
      })),
      contentHash,
      beforeHash: this.idempotency.bufferHash(before),
      afterHash: output.hash,
      output
    });

    return this.applyPreparedAppend(record, input.content);
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
    if (context.idempotencyKey !== undefined) {
      const previous = this.idempotency.lookupFileMutation("fs.copy", context.idempotencyKey);
      if (previous !== undefined) {
        this.assertFileMutationReplay(previous, "fs.copy", to.absolutePath, undefined, from.absolutePath);
        const output = await this.applyPreparedCopy(previous, input.overwrite);
        return {
          ...(output as Record<string, JsonValue>),
          idempotent: true
        };
      }
    }

    await mkdir(dirname(to.absolutePath), { recursive: true });
    if (context.idempotencyKey === undefined) {
      if (!input.overwrite && await this.fileExists(to.absolutePath)) {
        throw new Error("Destination already exists.");
      }
      const source = await readFile(from.absolutePath);
      await this.atomicWriteBuffer(to.absolutePath, source);
      return {
        path: to.absolutePath,
        relativePath: to.relativePath,
        sizeBytes: source.byteLength,
        hash: this.idempotency.bufferHash(source)
      };
    }

    if (!input.overwrite && await this.fileExists(to.absolutePath)) {
      throw new Error("Destination already exists.");
    }
    const source = await readFile(from.absolutePath);
    const sourceHash = this.idempotency.bufferHash(source);
    const output = {
      path: to.absolutePath,
      relativePath: to.relativePath,
      sizeBytes: source.byteLength,
      hash: sourceHash
    };
    const record = this.idempotency.prepareFileMutation({
      toolName: "fs.copy",
      idempotencyKey: context.idempotencyKey,
      sourcePath: from.absolutePath,
      targetPath: to.absolutePath,
      relativePath: to.relativePath,
      inputDigest: this.idempotency.contentHash(JSON.stringify({
        from: input.from,
        to: input.to,
        overwrite: input.overwrite
      })),
      contentHash: sourceHash,
      afterHash: sourceHash,
      output
    });

    return this.applyPreparedCopy(record, input.overwrite);
  }

  async moveOutput(input: FileMoveInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const approvalToken = context.approvalToken ?? input.approvalToken;
    const from = this.safety().checkWrite(input.from, approvalToken);
    const to = this.safety().checkWrite(input.to, approvalToken);
    this.log("move", context.executionId, to, from.absolutePath);
    assertSafe(from);
    assertSafe(to);
    if (context.idempotencyKey !== undefined) {
      const previous = this.idempotency.lookupFileMutation("fs.move", context.idempotencyKey);
      if (previous !== undefined) {
        this.assertFileMutationReplay(previous, "fs.move", to.absolutePath, undefined, from.absolutePath);
        const output = await this.applyPreparedMove(previous, input.overwrite);
        return {
          ...(output as Record<string, JsonValue>),
          idempotent: true
        };
      }
    }

    await mkdir(dirname(to.absolutePath), { recursive: true });
    if (!input.overwrite) {
      await stat(to.absolutePath).then(
        () => {
          throw new Error("Destination already exists.");
        },
        () => undefined
      );
    }
    if (context.idempotencyKey === undefined) {
      const source = await readFile(from.absolutePath);
      await rename(from.absolutePath, to.absolutePath);
      return {
        path: to.absolutePath,
        relativePath: to.relativePath,
        sizeBytes: source.byteLength,
        hash: this.idempotency.bufferHash(source)
      };
    }

    const source = await readFile(from.absolutePath);
    const sourceHash = this.idempotency.bufferHash(source);
    const output = {
      path: to.absolutePath,
      relativePath: to.relativePath,
      sizeBytes: source.byteLength,
      hash: sourceHash
    };
    const record = this.idempotency.prepareFileMutation({
      toolName: "fs.move",
      idempotencyKey: context.idempotencyKey,
      sourcePath: from.absolutePath,
      targetPath: to.absolutePath,
      relativePath: to.relativePath,
      inputDigest: this.idempotency.contentHash(JSON.stringify({
        from: input.from,
        to: input.to,
        overwrite: input.overwrite
      })),
      contentHash: sourceHash,
      afterHash: sourceHash,
      output
    });

    return this.applyPreparedMove(record, input.overwrite);
  }

  async appendStatus(idempotencyKey: string): Promise<ToolStatusQueryResult> {
    const record = this.idempotency.lookupFileMutation("fs.append", idempotencyKey);
    if (record === undefined) {
      return { applied: false };
    }

    return this.fileMutationStatus(record);
  }

  async copyStatus(idempotencyKey: string): Promise<ToolStatusQueryResult> {
    const record = this.idempotency.lookupFileMutation("fs.copy", idempotencyKey);
    if (record === undefined) {
      return { applied: false };
    }

    return this.fileMutationStatus(record);
  }

  async moveStatus(idempotencyKey: string): Promise<ToolStatusQueryResult> {
    const record = this.idempotency.lookupFileMutation("fs.move", idempotencyKey);
    if (record === undefined) {
      return { applied: false };
    }

    return this.fileMutationStatus(record, { requireSourceRemoved: true });
  }

  private async applyPreparedAppend(record: FileMutationRecord, content: string): Promise<JsonValue> {
    const status = await this.fileMutationStatus(record);
    if (status.applied) {
      return status.output ?? record.output;
    }

    const current = await this.readFileOrEmpty(record.targetPath);
    if (this.idempotency.bufferHash(current) !== record.beforeHash) {
      throw new Error("Cannot safely replay fs.append: target changed since the idempotency record was prepared.");
    }

    await this.atomicWriteBuffer(record.targetPath, Buffer.concat([current, Buffer.from(content, "utf8")]));
    const applied = this.idempotency.markFileMutationApplied(record.toolName, record.idempotencyKey);
    return applied?.output ?? record.output;
  }

  private async applyPreparedCopy(record: FileMutationRecord, overwrite: boolean): Promise<JsonValue> {
    const status = await this.fileMutationStatus(record);
    if (status.applied) {
      return status.output ?? record.output;
    }

    if (record.sourcePath === undefined) {
      throw new Error("Cannot safely replay fs.copy: source path is missing from the idempotency record.");
    }

    const targetHash = await this.fileHash(record.targetPath);
    if (!overwrite && targetHash !== undefined) {
      throw new Error("Destination already exists.");
    }
    const source = await readFile(record.sourcePath);
    if (this.idempotency.bufferHash(source) !== record.contentHash) {
      throw new Error("Cannot safely replay fs.copy: source changed since the idempotency record was prepared.");
    }

    await mkdir(dirname(record.targetPath), { recursive: true });
    await this.atomicWriteBuffer(record.targetPath, source);
    const applied = this.idempotency.markFileMutationApplied(record.toolName, record.idempotencyKey);
    return applied?.output ?? record.output;
  }

  private async applyPreparedMove(record: FileMutationRecord, overwrite: boolean): Promise<JsonValue> {
    const status = await this.fileMutationStatus(record, { requireSourceRemoved: true });
    if (status.applied) {
      return status.output ?? record.output;
    }

    if (record.sourcePath === undefined) {
      throw new Error("Cannot safely replay fs.move: source path is missing from the idempotency record.");
    }

    const targetHash = await this.fileHash(record.targetPath);
    if (!overwrite && targetHash !== undefined) {
      throw new Error("Destination already exists.");
    }
    const source = await readFile(record.sourcePath);
    if (this.idempotency.bufferHash(source) !== record.contentHash) {
      throw new Error("Cannot safely replay fs.move: source changed since the idempotency record was prepared.");
    }

    await mkdir(dirname(record.targetPath), { recursive: true });
    await rename(record.sourcePath, record.targetPath);
    const applied = this.idempotency.markFileMutationApplied(record.toolName, record.idempotencyKey);
    return applied?.output ?? record.output;
  }

  private async fileMutationStatus(
    record: FileMutationRecord,
    options: { requireSourceRemoved?: boolean } = {}
  ): Promise<ToolStatusQueryResult> {
    if (record.status === "applied") {
      return { applied: true, output: record.output };
    }

    const targetHash = await this.fileHash(record.targetPath);
    if (targetHash !== record.afterHash) {
      return { applied: false };
    }

    if (options.requireSourceRemoved === true && record.sourcePath !== undefined) {
      if (await this.fileExists(record.sourcePath)) {
        return { applied: false };
      }
    }

    const applied = this.idempotency.markFileMutationApplied(record.toolName, record.idempotencyKey);
    return { applied: true, output: applied?.output ?? record.output };
  }

  private assertFileMutationReplay(
    record: FileMutationRecord,
    toolName: string,
    targetPath: string,
    contentHash?: string,
    sourcePath?: string
  ): void {
    if (record.toolName !== toolName || record.targetPath !== targetPath) {
      throw new Error(`Idempotency key was already used for a different ${toolName} target.`);
    }

    if (sourcePath !== undefined && record.sourcePath !== sourcePath) {
      throw new Error(`Idempotency key was already used for a different ${toolName} source.`);
    }

    if (contentHash !== undefined && record.contentHash !== contentHash) {
      throw new Error(`Idempotency key was already used with different ${toolName} content.`);
    }
  }

  private async readFileOrEmpty(path: string): Promise<Buffer> {
    try {
      return await readFile(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return Buffer.alloc(0);
      }

      throw error;
    }
  }

  private async fileHash(path: string): Promise<string | undefined> {
    try {
      return this.idempotency.bufferHash(await readFile(path));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  private async atomicWriteBuffer(path: string, contents: Buffer): Promise<void> {
    const tempPath = join(dirname(path), `.operator-dock-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(tempPath, contents);
    await rename(tempPath, path);
  }

  async deleteOutput(input: FileDeleteInput, context: FsToolExecutionContext): Promise<JsonValue> {
    const safety = this.safety().checkDelete(input.path, context.approvalToken ?? input.approvalToken);
    this.log("delete", context.executionId, safety);
    assertSafe(safety);
    if (context.idempotencyKey !== undefined) {
      const previous = this.idempotency.lookup("fs.delete", context.idempotencyKey);
      if (previous !== undefined) {
        return {
          ...(previous.output as Record<string, JsonValue>),
          idempotent: true
        };
      }
    }

    await rm(safety.absolutePath, {
      recursive: input.recursive,
      force: false
    });
    const output = {
      path: safety.absolutePath,
      relativePath: safety.relativePath
    };
    if (context.idempotencyKey !== undefined) {
      this.idempotency.record({
        toolName: "fs.delete",
        idempotencyKey: context.idempotencyKey,
        output
      });
    }

    return output;
  }

  private async run(
    toolName: string,
    riskLevel: ToolRiskLevel,
    input: Record<string, JsonValue>,
    operation: (executionId: string) => Promise<JsonValue | SafetyFailure>
  ): Promise<ToolResult> {
    const workspace = this.workspaceService.requireWorkspace();
    const taskId = "legacy-fs-direct";
    const lock = this.locks.acquire(taskId);
    let result = this.events.createExecution({
      taskId,
      toolName,
      input,
      riskLevel,
      workspaceRoot: workspace.rootPath
    });
    let started = this.events.recordEvent(result.executionId, toolName, "tool.started", {
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
    } finally {
      this.locks.release(lock);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
