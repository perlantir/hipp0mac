import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "@operator-dock/protocol";
import { canonicalJson, sha256Hex } from "./canonicalJson.js";
import { EncryptedRecordCodec } from "./encryptedRecordCodec.js";
import type { PersistenceKeys } from "./persistenceKeys.js";
import type { OperatorDockPaths } from "./paths.js";
import { uuidv7 } from "./uuidv7.js";

export interface CanonicalEventRecord {
  schemaVersion: 1;
  eventId: string;
  taskId: string;
  parentEventId: string | null;
  timestamp: string;
  eventType: string;
  payload: Record<string, JsonValue>;
  prevHash: string;
  hmac: string;
}

export interface EventStoreVerification {
  ok: true;
  eventCount: number;
  lastEventId: string | null;
}

export interface EventLogRecovery {
  truncated: boolean;
  eventCount: number;
}

export class EventStoreCorruptionError extends Error {
  constructor(message: string, readonly eventId?: string) {
    super(message);
    this.name = "EventStoreCorruptionError";
  }
}

export class EventStore {
  constructor(
    private readonly paths: OperatorDockPaths,
    private readonly keys: PersistenceKeys
  ) {}

  append(taskId: string, eventType: string, payload: Record<string, JsonValue> = {}): string {
    const existing = EncryptedRecordCodec.readRecords<CanonicalEventRecord>(this.paths.eventLog(taskId), this.keys, {
      truncateTrailing: true
    });
    const previous = existing.at(-1);
    const event = this.eventRecord(taskId, eventType, payload, previous);
    mkdirSync(dirname(this.paths.eventLog(taskId)), { recursive: true, mode: 0o700 });
    EncryptedRecordCodec.append(this.paths.eventLog(taskId), event, this.keys);
    return event.eventId;
  }

  readAll(taskId: string): CanonicalEventRecord[] {
    const records = EncryptedRecordCodec.readRecords<CanonicalEventRecord>(this.paths.eventLog(taskId), this.keys);
    return records.map((record) => {
      this.validateHmac(record.plaintext);
      return record.plaintext;
    });
  }

  readSince(taskId: string, eventId: string): CanonicalEventRecord[] {
    const events = this.readAll(taskId);
    const index = events.findIndex((event) => event.eventId === eventId);
    return index === -1 ? [] : events.slice(index + 1);
  }

  verify(taskId: string): EventStoreVerification {
    const records = EncryptedRecordCodec.readRecords<CanonicalEventRecord>(this.paths.eventLog(taskId), this.keys);
    let previousRaw = Buffer.alloc(0);
    let previousEventId: string | null = null;

    for (const record of records) {
      const event = record.plaintext;
      this.validateHmac(event);

      const expectedPrevHash = sha256Hex(previousRaw);
      if (event.prevHash !== expectedPrevHash) {
        throw new EventStoreCorruptionError(
          `Event store hash chain break at event ${event.eventId}.`,
          event.eventId
        );
      }

      if (event.parentEventId !== previousEventId) {
        throw new EventStoreCorruptionError(
          `Event store parent chain break at event ${event.eventId}.`,
          event.eventId
        );
      }

      previousRaw = Buffer.from(record.raw);
      previousEventId = event.eventId;
    }

    return {
      ok: true,
      eventCount: records.length,
      lastEventId: previousEventId
    };
  }

  recoverTaskLog(taskId: string): EventLogRecovery {
    const filePath = this.paths.eventLog(taskId);
    if (!existsSync(filePath)) {
      return { truncated: false, eventCount: 0 };
    }

    const before = statSync(filePath).size;
    const records = EncryptedRecordCodec.readRecords<CanonicalEventRecord>(filePath, this.keys, {
      truncateTrailing: true
    });
    const after = records.at(-1)?.endOffset ?? 0;
    return {
      truncated: before !== after,
      eventCount: records.length
    };
  }

  private eventRecord(
    taskId: string,
    eventType: string,
    payload: Record<string, JsonValue>,
    previous: { raw: Buffer; plaintext: CanonicalEventRecord } | undefined
  ): CanonicalEventRecord {
    const unsigned = {
      schemaVersion: 1 as const,
      eventId: uuidv7(),
      taskId,
      parentEventId: previous?.plaintext.eventId ?? null,
      timestamp: new Date().toISOString(),
      eventType,
      payload,
      prevHash: sha256Hex(previous?.raw ?? Buffer.alloc(0))
    };

    return {
      ...unsigned,
      hmac: this.hmac(unsigned)
    };
  }

  private validateHmac(event: CanonicalEventRecord): void {
    if (event.schemaVersion !== 1) {
      throw new EventStoreCorruptionError(`Unsupported event schema version ${event.schemaVersion}.`, event.eventId);
    }

    const expected = this.hmac({
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      taskId: event.taskId,
      parentEventId: event.parentEventId,
      timestamp: event.timestamp,
      eventType: event.eventType,
      payload: event.payload,
      prevHash: event.prevHash
    });

    if (expected !== event.hmac) {
      throw new EventStoreCorruptionError(`Event HMAC mismatch at event ${event.eventId}.`, event.eventId);
    }
  }

  private hmac(value: Omit<CanonicalEventRecord, "hmac">): string {
    return createHmac("sha256", this.keys.hmacKey).update(canonicalJson(value)).digest("hex");
  }
}
