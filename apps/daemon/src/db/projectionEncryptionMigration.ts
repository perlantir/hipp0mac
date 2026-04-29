import type { DatabaseSync } from "node:sqlite";
import { ProjectionCipher } from "./projectionCipher.js";

export function encryptProjectionRows(database: DatabaseSync, cipher: ProjectionCipher): void {
  encryptToolExecutions(database, cipher);
  encryptToolEvents(database, cipher);
  encryptToolApprovals(database, cipher);
  encryptFileOperationLogs(database, cipher);
}

function encryptToolExecutions(database: DatabaseSync, cipher: ProjectionCipher): void {
  const rows = database
    .prepare("SELECT id, input_json, output_json, error_message, raw_output_ref, replay_json FROM tool_executions")
    .all() as Array<{
      id: string;
      input_json: string | null;
      output_json: string | null;
      error_message: string | null;
      raw_output_ref: string | null;
      replay_json: string | null;
    }>;
  const update = database.prepare(`
    UPDATE tool_executions
    SET input_json = ?, output_json = ?, error_message = ?, raw_output_ref = ?, replay_json = ?
    WHERE id = ?
  `);

  for (const row of rows) {
    update.run(
      cipher.encrypt(row.input_json ?? "{}"),
      cipher.encryptNullable(row.output_json),
      cipher.encryptNullable(row.error_message),
      cipher.encryptNullable(row.raw_output_ref),
      cipher.encrypt(row.replay_json ?? "{}"),
      row.id
    );
  }
}

function encryptToolEvents(database: DatabaseSync, cipher: ProjectionCipher): void {
  const rows = database
    .prepare("SELECT id, payload_json FROM tool_events")
    .all() as Array<{ id: string; payload_json: string }>;
  const update = database.prepare("UPDATE tool_events SET payload_json = ? WHERE id = ?");
  for (const row of rows) {
    update.run(cipher.encrypt(row.payload_json), row.id);
  }
}

function encryptToolApprovals(database: DatabaseSync, cipher: ProjectionCipher): void {
  const rows = database
    .prepare("SELECT id, reason, input_json, token FROM tool_approvals")
    .all() as Array<{ id: string; reason: string; input_json: string; token: string }>;
  const update = database.prepare("UPDATE tool_approvals SET reason = ?, input_json = ?, token = ? WHERE id = ?");
  for (const row of rows) {
    update.run(cipher.encrypt(row.reason), cipher.encrypt(row.input_json), cipher.encrypt(row.token), row.id);
  }
}

function encryptFileOperationLogs(database: DatabaseSync, cipher: ProjectionCipher): void {
  const rows = database
    .prepare("SELECT id, primary_path, secondary_path, reason, metadata_json FROM file_operation_logs")
    .all() as Array<{
      id: string;
      primary_path: string | null;
      secondary_path: string | null;
      reason: string | null;
      metadata_json: string | null;
    }>;
  const update = database.prepare(`
    UPDATE file_operation_logs
    SET primary_path = ?, secondary_path = ?, reason = ?, metadata_json = ?
    WHERE id = ?
  `);
  for (const row of rows) {
    update.run(
      cipher.encrypt(row.primary_path ?? ""),
      cipher.encryptNullable(row.secondary_path),
      cipher.encryptNullable(row.reason),
      cipher.encrypt(row.metadata_json ?? "{}"),
      row.id
    );
  }
}
