import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "@operator-dock/protocol";
import type { OperatorDockPaths } from "../../persistence/paths.js";

export interface IdempotencyRecord {
  schemaVersion: 1;
  toolName: string;
  idempotencyKey: string;
  inputDigest?: string;
  contentHash?: string;
  output: JsonValue;
  appliedAt: string;
}

export interface FileMutationRecord {
  schemaVersion: 1;
  toolName: string;
  idempotencyKey: string;
  status: "prepared" | "applied";
  sourcePath?: string;
  targetPath: string;
  relativePath: string;
  inputDigest?: string;
  contentHash?: string;
  beforeHash?: string;
  afterHash: string;
  output: JsonValue;
  preparedAt: string;
  appliedAt?: string;
}

export class IdempotencyStore {
  constructor(private readonly paths: OperatorDockPaths) {}

  lookup(toolName: string, idempotencyKey: string): IdempotencyRecord | undefined {
    const path = this.recordPath(toolName, idempotencyKey);
    if (!existsSync(path)) {
      return undefined;
    }

    const parsed = JSON.parse(readFileSync(path, "utf8")) as IdempotencyRecord;
    return parsed.schemaVersion === 1 ? parsed : undefined;
  }

  record(input: Omit<IdempotencyRecord, "schemaVersion" | "appliedAt">): IdempotencyRecord {
    const record: IdempotencyRecord = {
      schemaVersion: 1,
      ...input,
      appliedAt: new Date().toISOString()
    };
    const path = this.recordPath(input.toolName, input.idempotencyKey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    return record;
  }

  lookupFileMutation(toolName: string, idempotencyKey: string): FileMutationRecord | undefined {
    const logged = this.lookupFileMutationLog(toolName, idempotencyKey);
    if (logged !== undefined) {
      return logged;
    }

    const path = this.fileMutationPath(toolName, idempotencyKey);
    if (!existsSync(path)) {
      return undefined;
    }

    const parsed = JSON.parse(readFileSync(path, "utf8")) as FileMutationRecord;
    return parsed.schemaVersion === 1 ? parsed : undefined;
  }

  prepareFileMutation(input: Omit<FileMutationRecord, "schemaVersion" | "status" | "preparedAt" | "appliedAt">): FileMutationRecord {
    const existing = this.lookupFileMutation(input.toolName, input.idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }

    const record: FileMutationRecord = {
      schemaVersion: 1,
      status: "prepared",
      ...input,
      preparedAt: new Date().toISOString()
    };
    this.writeFileMutation(record);
    return record;
  }

  markFileMutationApplied(
    toolName: string,
    idempotencyKey: string,
    output?: JsonValue
  ): FileMutationRecord | undefined {
    const existing = this.lookupFileMutation(toolName, idempotencyKey);
    if (existing === undefined) {
      return undefined;
    }

    const record: FileMutationRecord = {
      ...existing,
      status: "applied",
      ...(output === undefined ? {} : { output }),
      appliedAt: existing.appliedAt ?? new Date().toISOString()
    };
    this.writeFileMutation(record);
    return record;
  }

  contentHash(contents: string): string {
    return createHash("sha256").update(contents).digest("hex");
  }

  bufferHash(contents: Buffer): string {
    return createHash("sha256").update(contents).digest("hex");
  }

  private recordPath(toolName: string, idempotencyKey: string): string {
    return join(this.paths.idempotencyRoot, safeId(toolName), `${safeId(idempotencyKey)}.json`);
  }

  private fileMutationPath(toolName: string, idempotencyKey: string): string {
    return join(
      this.paths.idempotencyRoot,
      "file-mutations",
      safeId(toolName),
      `${safeId(idempotencyKey)}.json`
    );
  }

  private writeFileMutation(record: FileMutationRecord): void {
    this.appendFileMutationLog(record);
    const path = this.fileMutationPath(record.toolName, record.idempotencyKey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  }

  private lookupFileMutationLog(toolName: string, idempotencyKey: string): FileMutationRecord | undefined {
    if (toolName === "fs.copy" || toolName === "fs.move") {
      return this.latestRecordInLog(this.tombstoneLogPath(toolName), toolName, idempotencyKey);
    }

    if (toolName !== "fs.append") {
      return undefined;
    }

    const appendRoot = join(this.paths.toolTombstonesRoot, "fs.append");
    if (!existsSync(appendRoot)) {
      return undefined;
    }

    for (const entry of readdirSync(appendRoot)) {
      const record = this.latestRecordInLog(join(appendRoot, entry), toolName, idempotencyKey);
      if (record !== undefined) {
        return record;
      }
    }

    return undefined;
  }

  private latestRecordInLog(
    path: string,
    toolName: string,
    idempotencyKey: string
  ): FileMutationRecord | undefined {
    if (!existsSync(path)) {
      return undefined;
    }

    let latest: FileMutationRecord | undefined;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }

      const parsed = JSON.parse(line) as FileMutationRecord;
      if (
        parsed.schemaVersion === 1
        && parsed.toolName === toolName
        && parsed.idempotencyKey === idempotencyKey
      ) {
        latest = parsed;
      }
    }

    return latest;
  }

  private appendFileMutationLog(record: FileMutationRecord): void {
    const path = record.toolName === "fs.append"
      ? this.appendLogPath(record.targetPath)
      : this.tombstoneLogPath(record.toolName);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private tombstoneLogPath(toolName: string): string {
    return join(this.paths.toolTombstonesRoot, `${safeId(toolName)}.log`);
  }

  private appendLogPath(targetPath: string): string {
    return join(
      this.paths.toolTombstonesRoot,
      "fs.append",
      `${createHash("sha256").update(targetPath).digest("hex")}.appendlog`
    );
  }
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
