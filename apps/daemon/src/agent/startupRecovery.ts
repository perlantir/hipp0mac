import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { JsonValue } from "@operator-dock/protocol";
import { EncryptedRecordCodec } from "../persistence/encryptedRecordCodec.js";
import type { OperatorDockPaths } from "../persistence/paths.js";
import type { PersistenceKeys } from "../persistence/persistenceKeys.js";

export type DaemonRuntimeState = "starting" | "recovering" | "ready";

export interface StartupRecoveryCheckpoint {
  schemaVersion: 1;
  runId: string;
  status: "running" | "completed";
  taskIds: string[];
  nextIndex: number;
  currentTaskId: string | null;
  startedAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface StartupRecoveryEvents {
  canonicalTaskIds(): string[];
  appendCanonical(taskId: string, eventType: string, payload?: Record<string, JsonValue>): string;
}

export interface StartupRecoveryToolRuntime {
  reconcileTask(taskId: string): Promise<void>;
}

export interface StartupRecoveryLogger {
  info(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}

export class StartupRecoveryCheckpointStore {
  constructor(
    private readonly paths: OperatorDockPaths,
    private readonly keys: PersistenceKeys
  ) {}

  load(): StartupRecoveryCheckpoint | null {
    const path = this.paths.startupRecoveryCheckpoint();
    if (!existsSync(path)) {
      return null;
    }

    try {
      const checkpoint = EncryptedRecordCodec.readRecords<StartupRecoveryCheckpoint>(path, this.keys)
        .at(-1)?.plaintext;
      return checkpoint?.schemaVersion === 1 ? checkpoint : null;
    } catch {
      return null;
    }
  }

  save(checkpoint: StartupRecoveryCheckpoint): void {
    EncryptedRecordCodec.rewriteRecords(this.paths.startupRecoveryCheckpoint(), this.keys, [checkpoint]);
  }
}

export async function runStartupRecovery(input: {
  events: StartupRecoveryEvents;
  toolRuntime: StartupRecoveryToolRuntime;
  checkpoints: StartupRecoveryCheckpointStore;
  logger: StartupRecoveryLogger;
}): Promise<void> {
  const previous = input.checkpoints.load();
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const taskIds = taskIdsForRun(previous, input.events.canonicalTaskIds());
  const startIndex = previous?.status === "running"
    ? Math.min(previous.nextIndex, taskIds.length)
    : 0;

  input.logger.info({ taskCount: taskIds.length, startIndex }, "startup recovery started");

  for (let index = startIndex; index < taskIds.length; index += 1) {
    const taskId = taskIds[index]!;
    input.checkpoints.save({
      schemaVersion: 1,
      runId,
      status: "running",
      taskIds,
      nextIndex: index,
      currentTaskId: taskId,
      startedAt,
      updatedAt: new Date().toISOString(),
      lastError: null
    });

    try {
      await input.toolRuntime.reconcileTask(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.logger.error({ taskId, error: message }, "startup recovery task failed");
      try {
        input.events.appendCanonical(taskId, "startup_recovery_task_failed", {
          message,
          runId
        });
      } catch {
        input.logger.error({ taskId }, "startup recovery could not persist task failure event");
      }
      input.checkpoints.save({
        schemaVersion: 1,
        runId,
        status: "running",
        taskIds,
        nextIndex: index + 1,
        currentTaskId: null,
        startedAt,
        updatedAt: new Date().toISOString(),
        lastError: message
      });
      continue;
    }

    input.checkpoints.save({
      schemaVersion: 1,
      runId,
      status: "running",
      taskIds,
      nextIndex: index + 1,
      currentTaskId: null,
      startedAt,
      updatedAt: new Date().toISOString(),
      lastError: null
    });
  }

  input.checkpoints.save({
    schemaVersion: 1,
    runId,
    status: "completed",
    taskIds,
    nextIndex: taskIds.length,
    currentTaskId: null,
    startedAt,
    updatedAt: new Date().toISOString(),
    lastError: null
  });
  input.logger.info({ taskCount: taskIds.length }, "startup recovery completed");
}

function taskIdsForRun(previous: StartupRecoveryCheckpoint | null, current: string[]): string[] {
  if (previous?.status !== "running") {
    return current;
  }

  const seen = new Set(previous.taskIds);
  return [
    ...previous.taskIds,
    ...current.filter((taskId) => !seen.has(taskId))
  ];
}
