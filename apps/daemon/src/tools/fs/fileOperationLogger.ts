import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "../../db/types.js";
import type { JsonValue } from "@operator-dock/protocol";

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
  constructor(private readonly database: DatabaseConnection) {}

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
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        input.executionId ?? null,
        input.operation,
        input.primaryPath,
        input.secondaryPath ?? null,
        input.allowed ? 1 : 0,
        input.approvalRequired ? 1 : 0,
        input.reason ?? null,
        JSON.stringify(input.metadata ?? {}),
        new Date().toISOString()
      );
  }
}
