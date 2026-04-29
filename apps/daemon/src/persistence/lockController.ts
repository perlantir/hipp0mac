import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { EventStore } from "./eventStore.js";
import type { OperatorDockPaths } from "./paths.js";

export interface LockControllerOptions {
  daemonInstanceId?: string;
  staleAfterMs?: number;
  reclaimDelayMs?: number;
}

export interface TaskLockRecord {
  schemaVersion: 1;
  daemonInstanceId: string;
  pid: number;
  acquiredAt: string;
  lastHeartbeat: string;
}

export interface TaskLockHandle extends TaskLockRecord {
  taskId: string;
  lockEventId: string;
}

export class LockHeldError extends Error {
  constructor(taskId: string) {
    super(`Task lock is already held: ${taskId}`);
    this.name = "LockHeldError";
  }
}

export class LockController {
  readonly daemonInstanceId: string;
  private readonly staleAfterMs: number;
  private readonly reclaimDelayMs: number;

  constructor(
    private readonly paths: OperatorDockPaths,
    private readonly eventStore: EventStore,
    options: LockControllerOptions = {}
  ) {
    this.daemonInstanceId = options.daemonInstanceId ?? randomUUID();
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    this.reclaimDelayMs = options.reclaimDelayMs ?? 1_000;
  }

  acquire(taskId: string): TaskLockHandle {
    const record = this.lockRecord();
    const eventId = this.tryCreate(taskId, record);
    if (eventId !== undefined) {
      return {
        ...record,
        taskId,
        lockEventId: eventId
      };
    }

    const existing = this.read(taskId);
    if (!this.isStale(existing)) {
      throw new LockHeldError(taskId);
    }

    sleep(this.reclaimDelayMs);
    const secondRead = this.read(taskId);
    if (!this.isStale(secondRead)) {
      throw new LockHeldError(taskId);
    }

    const reclaimedPath = `${this.paths.lockFile(taskId)}.${this.daemonInstanceId}.reclaimed`;
    try {
      renameSync(this.paths.lockFile(taskId), reclaimedPath);
    } catch {
      throw new LockHeldError(taskId);
    }

    rmSync(reclaimedPath, { force: true });
    this.eventStore.append(taskId, "lock_reclaimed", {
      previousHolder: secondRead.daemonInstanceId,
      previousPid: secondRead.pid,
      previousLastHeartbeat: secondRead.lastHeartbeat,
      daemonInstanceId: this.daemonInstanceId
    });

    const acquiredId = this.tryCreate(taskId, record);
    if (acquiredId === undefined) {
      throw new LockHeldError(taskId);
    }

    return {
      ...record,
      taskId,
      lockEventId: acquiredId
    };
  }

  heartbeat(handle: TaskLockHandle): void {
    this.assertOwned(handle);
    const updated = {
      schemaVersion: 1 as const,
      daemonInstanceId: this.daemonInstanceId,
      pid: process.pid,
      acquiredAt: handle.acquiredAt,
      lastHeartbeat: new Date().toISOString()
    };
    this.writeLock(handle.taskId, updated, "w");
  }

  release(handle: TaskLockHandle): string {
    this.assertOwned(handle);
    rmSync(this.paths.lockFile(handle.taskId), { force: true });
    return this.eventStore.append(handle.taskId, "lock_released", {
      daemonInstanceId: this.daemonInstanceId,
      pid: process.pid
    });
  }

  private tryCreate(taskId: string, record: TaskLockRecord): string | undefined {
    try {
      this.writeLock(taskId, record, "wx");
      return this.eventStore.append(taskId, "lock_acquired", {
        daemonInstanceId: this.daemonInstanceId,
        pid: process.pid
      });
    } catch {
      return undefined;
    }
  }

  private writeLock(taskId: string, record: TaskLockRecord, flag: "w" | "wx"): void {
    const path = this.paths.lockFile(taskId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, flag, 0o600);
    try {
      writeSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private read(taskId: string): TaskLockRecord {
    return JSON.parse(readFileSync(this.paths.lockFile(taskId), "utf8")) as TaskLockRecord;
  }

  private assertOwned(handle: TaskLockHandle): void {
    if (!existsSync(this.paths.lockFile(handle.taskId))) {
      throw new Error("Lock is not owned by this daemon instance.");
    }

    const record = this.read(handle.taskId);
    if (record.daemonInstanceId !== this.daemonInstanceId || record.pid !== process.pid) {
      throw new Error("Lock is not owned by this daemon instance.");
    }
  }

  private isStale(record: TaskLockRecord): boolean {
    return Date.now() - Date.parse(record.lastHeartbeat) >= this.staleAfterMs;
  }

  private lockRecord(): TaskLockRecord {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      daemonInstanceId: this.daemonInstanceId,
      pid: process.pid,
      acquiredAt: now,
      lastHeartbeat: now
    };
  }
}

function sleep(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
