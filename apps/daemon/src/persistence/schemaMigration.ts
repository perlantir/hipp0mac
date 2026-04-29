import type { JsonValue } from "@operator-dock/protocol";
import type { EventStore } from "./eventStore.js";

export interface VersionedRecord {
  schemaVersion: number;
  [key: string]: JsonValue;
}

export type MigrationFunction = (record: VersionedRecord) => VersionedRecord;

export class UnknownFutureSchemaVersionError extends Error {
  constructor(version: number, currentVersion: number) {
    super(`Record schema version ${version} is newer than supported version ${currentVersion}.`);
    this.name = "UnknownFutureSchemaVersionError";
  }
}

export class MissingMigrationError extends Error {
  constructor(from: number, to: number) {
    super(`Missing schema migration from ${from} to ${to}.`);
    this.name = "MissingMigrationError";
  }
}

export class SchemaMigrationManager {
  private readonly emitted = new Set<string>();

  constructor(
    private readonly currentVersion: number,
    private readonly migrations: Map<string, MigrationFunction>,
    private readonly eventStore?: EventStore
  ) {}

  migrate(taskId: string, record: VersionedRecord): VersionedRecord {
    if (record.schemaVersion > this.currentVersion) {
      throw new UnknownFutureSchemaVersionError(record.schemaVersion, this.currentVersion);
    }

    let migrated = clone(record);
    while (migrated.schemaVersion < this.currentVersion) {
      const from = migrated.schemaVersion;
      const to = from + 1;
      const migration = this.migrations.get(key(from, to));
      if (migration === undefined) {
        throw new MissingMigrationError(from, to);
      }

      migrated = migration(migrated);
      migrated.schemaVersion = to;
      this.emitMigration(taskId, from, to);
    }

    return migrated;
  }

  private emitMigration(taskId: string, from: number, to: number): void {
    const migrationKey = `${taskId}:${from}:${to}`;
    if (this.eventStore === undefined || this.emitted.has(migrationKey)) {
      return;
    }

    this.eventStore.append(taskId, "schema_migration_applied", {
      fromVersion: from,
      toVersion: to
    });
    this.emitted.add(migrationKey);
  }
}

export function migrationKey(from: number, to: number): string {
  return key(from, to);
}

function key(from: number, to: number): string {
  return `${from}->${to}`;
}

function clone(record: VersionedRecord): VersionedRecord {
  return JSON.parse(JSON.stringify(record)) as VersionedRecord;
}
