import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "@operator-dock/protocol";
import { canonicalJson, sha256Hex } from "./canonicalJson.js";
import { EncryptedRecordCodec } from "./encryptedRecordCodec.js";
import type { EventStore } from "./eventStore.js";
import type { PersistenceKeys } from "./persistenceKeys.js";
import type { OperatorDockPaths } from "./paths.js";

export interface CheckpointRecord {
  schemaVersion: 1;
  eventId: string;
  derivedState: JsonValue;
  integrityHash: string;
  writtenAt: string;
}

export class CheckpointStore {
  constructor(
    private readonly paths: OperatorDockPaths,
    private readonly keys: PersistenceKeys,
    private readonly eventStore: EventStore
  ) {}

  writeCheckpoint(taskId: string, eventId: string, derivedState: JsonValue): CheckpointRecord {
    const checkpoint = {
      schemaVersion: 1 as const,
      eventId,
      derivedState,
      integrityHash: sha256Hex(canonicalJson({ eventId, derivedState })),
      writtenAt: new Date().toISOString()
    };
    mkdirSync(dirname(this.paths.checkpoint(taskId, eventId)), { recursive: true, mode: 0o700 });
    EncryptedRecordCodec.rewriteRecords(this.paths.checkpoint(taskId, eventId), this.keys, [checkpoint]);
    this.eventStore.append(taskId, "checkpoint_written", { eventId });
    return checkpoint;
  }

  latestCheckpoint(taskId: string): CheckpointRecord | null {
    const dir = this.paths.checkpointDir(taskId);
    if (!existsSync(dir)) {
      return null;
    }

    const candidates = readdirSync(dir)
      .filter((file) => file.endsWith(".checkpoint"))
      .sort()
      .reverse();

    for (const file of candidates) {
      const checkpoint = this.loadCheckpointFile(join(dir, file));
      if (checkpoint !== null) {
        return checkpoint;
      }
    }

    return null;
  }

  loadCheckpoint(taskId: string, eventId: string): CheckpointRecord | null {
    return this.loadCheckpointFile(this.paths.checkpoint(taskId, eventId));
  }

  private loadCheckpointFile(filePath: string): CheckpointRecord | null {
    try {
      const records = EncryptedRecordCodec.readRecords<CheckpointRecord>(filePath, this.keys);
      const checkpoint = records[0]?.plaintext;
      if (checkpoint === undefined || checkpoint.schemaVersion !== 1) {
        return null;
      }

      const expected = sha256Hex(canonicalJson({
        eventId: checkpoint.eventId,
        derivedState: checkpoint.derivedState
      }));

      return checkpoint.integrityHash === expected ? checkpoint : null;
    } catch {
      return null;
    }
  }
}
