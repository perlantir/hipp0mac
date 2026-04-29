import type { DatabaseSync } from "node:sqlite";
import type { CanonicalEventStore } from "./canonicalEventStore.js";

export function emitLegacyProjectionNoticeIfNeeded(
  database: DatabaseSync,
  canonicalEvents: CanonicalEventStore
): void {
  const markerKey = "phase5.legacy_data_present_event_id";
  const existing = database
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(markerKey) as { value_json: string } | undefined;
  if (existing !== undefined) {
    return;
  }

  const counts = {
    toolExecutions: legacyCount(database, "tool_executions"),
    toolEvents: legacyCount(database, "tool_events"),
    fileOperationLogs: legacyCount(database, "file_operation_logs")
  };
  const total = counts.toolExecutions + counts.toolEvents + counts.fileOperationLogs;
  if (total === 0) {
    return;
  }

  const eventId = canonicalEvents.append({
    taskId: "daemon",
    eventType: "legacy_data_present",
    payload: {
      total,
      toolExecutions: counts.toolExecutions,
      toolEvents: counts.toolEvents,
      fileOperationLogs: counts.fileOperationLogs
    }
  });
  database
    .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)")
    .run(markerKey, JSON.stringify({ eventId }), new Date().toISOString());
}

function legacyCount(database: DatabaseSync, tableName: string): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE legacy = 1`)
    .get() as { count: number };
  return row.count;
}
