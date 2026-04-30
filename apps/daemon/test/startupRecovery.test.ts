import { rmSync } from "node:fs";
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
});

function fakeEvents(taskIds: string[]): StartupRecoveryEvents {
  return {
    canonicalTaskIds: () => taskIds,
    appendCanonical: () => "event-id"
  };
}

const silentLogger = {
  info: () => undefined,
  error: () => undefined
};
