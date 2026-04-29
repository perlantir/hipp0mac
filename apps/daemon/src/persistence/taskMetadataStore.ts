import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@operator-dock/protocol";
import { EncryptedRecordCodec } from "./encryptedRecordCodec.js";
import type { EventStore } from "./eventStore.js";
import type { PersistenceKeys } from "./persistenceKeys.js";
import type { OperatorDockPaths } from "./paths.js";

export type PersistedTaskState = "created" | "paused" | "completed" | "failed" | "cancelled";

export interface TaskMetadataRecord {
  schemaVersion: 1;
  taskId: string;
  createdAt: string;
  state: PersistedTaskState;
  lastEventId: string | null;
  lastCheckpointId: string | null;
}

export class TaskMetadataStore {
  constructor(
    private readonly paths: OperatorDockPaths,
    private readonly keys: PersistenceKeys,
    private readonly eventStore: EventStore
  ) {}

  create(taskId: string): TaskMetadataRecord {
    const eventId = this.eventStore.append(taskId, "task_created", {});
    const record: TaskMetadataRecord = {
      schemaVersion: 1,
      taskId,
      createdAt: new Date().toISOString(),
      state: "created",
      lastEventId: eventId,
      lastCheckpointId: null
    };
    this.write(record);
    return record;
  }

  transition(taskId: string, state: PersistedTaskState): TaskMetadataRecord {
    const existing = this.get(taskId);
    if (existing === undefined) {
      throw new Error(`Task metadata not found: ${taskId}`);
    }

    const eventId = this.eventStore.append(taskId, "task_state_transition", {
      from: existing.state,
      to: state
    });
    const updated = {
      ...existing,
      state,
      lastEventId: eventId
    };
    this.write(updated);
    return updated;
  }

  get(taskId: string): TaskMetadataRecord | undefined {
    const path = this.metadataPath(taskId);
    if (!existsSync(path)) {
      return undefined;
    }

    const records = EncryptedRecordCodec.readRecords<TaskMetadataRecord>(path, this.keys);
    const record = records[0]?.plaintext;
    return record?.schemaVersion === 1 ? record : undefined;
  }

  private write(record: TaskMetadataRecord): void {
    mkdirSync(this.paths.tasksRoot, { recursive: true, mode: 0o700 });
    EncryptedRecordCodec.rewriteRecords(this.metadataPath(record.taskId), this.keys, [record as unknown as Record<string, JsonValue>]);
  }

  private metadataPath(taskId: string): string {
    return join(this.paths.tasksRoot, `${taskId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }
}
