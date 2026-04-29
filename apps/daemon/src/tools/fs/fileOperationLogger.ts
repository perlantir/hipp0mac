import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@operator-dock/protocol";
import { ProjectionCipher } from "../../db/projectionCipher.js";

export interface FileOperationLogInput {
  executionId?: string;
  operation: string;
  primaryPath: string;
  secondaryPath?: string;
  allowed: boolean;
  approvalRequired: boolean;
  reason?: string;
  metadata?: Record<string, JsonValue>;
}

export class FileOperationLogger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: ProjectionCipher
  ) {}

  log(input: FileOperationLogInput): void {
    this.database
      .prepare(`
        INSERT INTO file_operation_logs (
          id,
          execution_id,
          operation,
          primary_path,
          secondary_path,
          allowed,
          approval_required,
          reason,
          metadata_json,
          legacy,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        input.executionId ?? null,
        input.operation,
        this.cipher.encrypt(input.primaryPath),
        this.cipher.encryptNullable(input.secondaryPath ?? null),
        input.allowed ? 1 : 0,
        input.approvalRequired ? 1 : 0,
        this.cipher.encryptNullable(input.reason ?? null),
        this.cipher.encrypt(JSON.stringify(input.metadata ?? {})),
        0,
        new Date().toISOString()
      );
  }
}
