import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface ProductionPathOptions {
  home?: string;
}

export class OperatorDockPaths {
  readonly eventStoreRoot: string;
  readonly checkpointsRoot: string;
  readonly artifactsRoot: string;
  readonly memoryRoot: string;
  readonly tasksRoot: string;
  readonly configRoot: string;
  readonly locksRoot: string;
  readonly logsRoot: string;
  readonly databasePath: string;

  constructor(readonly root: string) {
    this.eventStoreRoot = join(root, "event-store");
    this.checkpointsRoot = join(root, "checkpoints");
    this.artifactsRoot = join(root, "artifacts");
    this.memoryRoot = join(root, "memory");
    this.tasksRoot = join(root, "tasks");
    this.configRoot = join(root, "config");
    this.locksRoot = join(root, "locks");
    this.logsRoot = join(root, "logs");
    this.databasePath = join(root, "operator-dock.sqlite");
  }

  static production(options: ProductionPathOptions = {}): OperatorDockPaths {
    const home = options.home ?? process.env.HOME ?? homedir();
    const root = join(home, "Library", "Application Support", "OperatorDock", "state");
    migrateV0State(home, root);
    const paths = new OperatorDockPaths(root);
    paths.createLayout();
    return paths;
  }

  createLayout(): void {
    for (const directory of [
      this.root,
      this.eventStoreRoot,
      this.checkpointsRoot,
      this.artifactsRoot,
      this.memoryRoot,
      this.tasksRoot,
      this.configRoot,
      this.locksRoot,
      this.logsRoot
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  }

  eventLog(taskId: string): string {
    return join(this.eventStoreRoot, `${safeId(taskId)}.log`);
  }

  checkpointDir(taskId: string): string {
    return join(this.checkpointsRoot, safeId(taskId));
  }

  checkpoint(taskId: string, eventId: string): string {
    return join(this.checkpointDir(taskId), `${safeId(eventId)}.checkpoint`);
  }

  lockFile(taskId: string): string {
    return join(this.locksRoot, `${safeId(taskId)}.lock`);
  }
}

function migrateV0State(home: string, newRoot: string): void {
  const oldRoot = join(home, ".operator-dock");
  const marker = join(newRoot, ".migrated-from-v0");

  if (!existsSync(oldRoot) || existsSync(marker)) {
    return;
  }

  mkdirSync(dirname(newRoot), { recursive: true, mode: 0o700 });

  if (!existsSync(newRoot)) {
    renameSync(oldRoot, newRoot);
  } else {
    for (const entry of readdirSync(oldRoot)) {
      renameSync(join(oldRoot, entry), join(newRoot, entry));
    }
    rmSync(oldRoot, { recursive: true, force: true });
  }

  writeFileSync(marker, JSON.stringify({
    schemaVersion: 1,
    migratedFrom: oldRoot,
    migratedAt: new Date().toISOString()
  }), { encoding: "utf8", mode: 0o600 });
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
