import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  contentHash(contents: string): string {
    return createHash("sha256").update(contents).digest("hex");
  }

  private recordPath(toolName: string, idempotencyKey: string): string {
    return join(this.paths.idempotencyRoot, safeId(toolName), `${safeId(idempotencyKey)}.json`);
  }
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
