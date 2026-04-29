import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "@operator-dock/protocol";

export interface CanonicalEventInput {
  taskId: string;
  eventType: string;
  payload: Record<string, JsonValue>;
}

export interface CanonicalEventRecord extends CanonicalEventInput {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
}

export interface CanonicalEventStore {
  append(input: CanonicalEventInput): string;
}

export class InMemoryCanonicalEventStore implements CanonicalEventStore {
  readonly events: CanonicalEventRecord[] = [];

  append(input: CanonicalEventInput): string {
    const record = makeCanonicalEvent(input);
    this.events.push(record);
    return record.eventId;
  }
}

export class EncryptedFileCanonicalEventStore implements CanonicalEventStore {
  private readonly key: Buffer;

  constructor(
    private readonly logPath: string,
    secret: string
  ) {
    this.key = createHash("sha256").update(secret).digest();
  }

  append(input: CanonicalEventInput): string {
    const record = makeCanonicalEvent(input);
    const plaintext = Buffer.from(JSON.stringify(record), "utf8");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const body = Buffer.concat([nonce, ciphertext, tag]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);

    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, Buffer.concat([length, body]), { mode: 0o600 });
    return record.eventId;
  }
}

function makeCanonicalEvent(input: CanonicalEventInput): CanonicalEventRecord {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    taskId: input.taskId,
    eventType: input.eventType,
    payload: input.payload,
    occurredAt: new Date().toISOString()
  };
}
