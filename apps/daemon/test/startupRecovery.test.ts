import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  runStartupRecovery,
  StartupRecoveryCheckpointStore,
  type StartupRecoveryEvents
} from "../src/agent/startupRecovery.js";
import { OperatorDockPaths } from "../src/persistence/paths.js";
import { persistenceKeyManager, tempRoot } from "./harness.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots.clear();
});

describe("startup recovery", () => {
  it("ignores corrupt checkpoint files instead of blocking startup", async () => {
    const root = tempRoot("operator-dock-startup-recovery-");
    tempRoots.add(root);
    const paths = new OperatorDockPaths(root);
    paths.createLayout();
    const keys = await persistenceKeyManager().loadOrCreateKeys();
    const checkpoints = new StartupRecoveryCheckpointStore(paths, keys);
    writeFileSync(paths.startupRecoveryCheckpoint(), "not an encrypted checkpoint");

    expect(checkpoints.load()).toBeNull();
  });

  it("resumes from the checkpointed task after recovery crashes", async () => {
    const root = tempRoot("operator-dock-startup-recovery-");
    tempRoots.add(root);
    const paths = new OperatorDockPaths(root);
    paths.createLayout();
    const keys = await persistenceKeyManager().loadOrCreateKeys();
    const checkpoints = new StartupRecoveryCheckpointStore(paths, keys);
    checkpoints.save({
      schemaVersion: 1,
      runId: "previous-run",
      status: "running",
      taskIds: ["already-done", "crashed-current", "later"],
      nextIndex: 1,
      currentTaskId: "crashed-current",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: null
    });

    const reconciled: string[] = [];
    await runStartupRecovery({
      events: fakeEvents(["already-done", "crashed-current", "later", "new-task"]),
      checkpoints,
      logger: silentLogger,
      toolRuntime: {
        reconcileTask: async (taskId) => {
          reconciled.push(taskId);
        }
      }
    });

    expect(reconciled).toEqual(["crashed-current", "later", "new-task"]);
    expect(checkpoints.load()).toMatchObject({
      status: "completed",
      nextIndex: 4,
      currentTaskId: null
    });
  });

  it("records task-level recovery failures and continues", async () => {
    const root = tempRoot("operator-dock-startup-recovery-");
    tempRoots.add(root);
    const paths = new OperatorDockPaths(root);
    paths.createLayout();
    const keys = await persistenceKeyManager().loadOrCreateKeys();
    const checkpoints = new StartupRecoveryCheckpointStore(paths, keys);
    const events = fakeEvents(["bad-task", "good-task"]);
    const reconciled: string[] = [];

    await runStartupRecovery({
      events,
      checkpoints,
      logger: silentLogger,
      toolRuntime: {
        reconcileTask: async (taskId) => {
          reconciled.push(taskId);
          if (taskId === "bad-task") {
            throw new Error("synthetic recovery failure");
          }
        }
      }
    });

    expect(reconciled).toEqual(["bad-task", "good-task"]);
    expect(events.appended).toMatchObject([
      {
        taskId: "bad-task",
        eventType: "startup_recovery_task_failed",
        payload: {
          message: "synthetic recovery failure"
        }
      }
    ]);
    expect(checkpoints.load()).toMatchObject({
      status: "completed",
      nextIndex: 2,
      currentTaskId: null,
      lastError: null
    });
  });

  it("continues when persisting a task-level recovery failure event fails", async () => {
    const root = tempRoot("operator-dock-startup-recovery-");
    tempRoots.add(root);
    const paths = new OperatorDockPaths(root);
    paths.createLayout();
    const keys = await persistenceKeyManager().loadOrCreateKeys();
    const checkpoints = new StartupRecoveryCheckpointStore(paths, keys);
    const reconciled: string[] = [];

    await runStartupRecovery({
      events: throwingEvents(["bad-task", "good-task"]),
      checkpoints,
      logger: silentLogger,
      toolRuntime: {
        reconcileTask: async (taskId) => {
          reconciled.push(taskId);
          if (taskId === "bad-task") {
            throw "string failure";
          }
        }
      }
    });

    expect(reconciled).toEqual(["bad-task", "good-task"]);
    expect(checkpoints.load()).toMatchObject({
      status: "completed",
      nextIndex: 2
    });
  });
});

interface FakeStartupRecoveryEvents extends StartupRecoveryEvents {
  appended: Array<{ taskId: string; eventType: string; payload: Record<string, unknown> | undefined }>;
}

function fakeEvents(taskIds: string[]): FakeStartupRecoveryEvents {
  const appended: FakeStartupRecoveryEvents["appended"] = [];
  return {
    appended,
    canonicalTaskIds: () => taskIds,
    appendCanonical: (taskId, eventType, payload) => {
      appended.push({ taskId, eventType, payload });
      return "event-id";
    }
  };
}

function throwingEvents(taskIds: string[]): StartupRecoveryEvents {
  return {
    canonicalTaskIds: () => taskIds,
    appendCanonical: () => {
      throw new Error("event append failed");
    }
  };
}

const silentLogger = {
  info: () => undefined,
  error: () => undefined
};
