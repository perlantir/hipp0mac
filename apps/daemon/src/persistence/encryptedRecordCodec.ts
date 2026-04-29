import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, openSync, readFileSync, truncateSync, writeSync, fsyncSync, closeSync } from "node:fs";
import type { PersistenceKeys } from "./persistenceKeys.js";

export interface EncryptedRecord<T = unknown> {
  raw: Buffer;
  nonce: Buffer;
  plaintext: T;
  endOffset: number;
}

export interface EncryptedRecordReadOptions {
  truncateTrailing?: boolean;
}

const lengthBytes = 4;
const nonceBytes = 12;
const tagBytes = 16;

export class EncryptedRecordCodec {
  static encode(value: unknown, keys: Pick<PersistenceKeys, "encryptionKey">): Buffer {
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv("aes-256-gcm", keys.encryptionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const body = Buffer.concat([nonce, ciphertext, tag]);
    const length = Buffer.alloc(lengthBytes);
    length.writeUInt32BE(body.length, 0);
    return Buffer.concat([length, body]);
  }

  static append(filePath: string, value: unknown, keys: Pick<PersistenceKeys, "encryptionKey">): Buffer {
    const record = EncryptedRecordCodec.encode(value, keys);
    const fd = openSync(filePath, "a", 0o600);
    try {
      writeSync(fd, record, 0, record.length);
      fsyncSync(fd);
      return record;
    } finally {
      closeSync(fd);
    }
  }

  static readRecords<T = unknown>(
    filePath: string,
    keys: Pick<PersistenceKeys, "encryptionKey">,
    options: EncryptedRecordReadOptions = {}
  ): Array<EncryptedRecord<T>> {
    if (!existsSync(filePath)) {
      return [];
    }

    const data = readFileSync(filePath);
    const records: Array<EncryptedRecord<T>> = [];
    let offset = 0;

    while (offset < data.length) {
      if (data.length - offset < lengthBytes) {
        truncateIfRequested(filePath, offset, options);
        break;
      }

      const bodyLength = data.readUInt32BE(offset);
      const bodyStart = offset + lengthBytes;
      const bodyEnd = bodyStart + bodyLength;
      if (bodyLength < nonceBytes + tagBytes || bodyEnd > data.length) {
        truncateIfRequested(filePath, offset, options);
        break;
      }

      const raw = data.subarray(offset, bodyEnd);
      const body = data.subarray(bodyStart, bodyEnd);
      const nonce = body.subarray(0, nonceBytes);
      const tag = body.subarray(body.length - tagBytes);
      const ciphertext = body.subarray(nonceBytes, body.length - tagBytes);
      const decipher = createDecipheriv("aes-256-gcm", keys.encryptionKey, nonce);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

      records.push({
        raw: Buffer.from(raw),
        nonce: Buffer.from(nonce),
        plaintext: JSON.parse(plaintext) as T,
        endOffset: bodyEnd
      });
      offset = bodyEnd;
    }

    return records;
  }

  static rewriteRecords(filePath: string, keys: Pick<PersistenceKeys, "encryptionKey">, records: unknown[]): void {
    const fd = openSync(filePath, "w", 0o600);
    try {
      for (const record of records) {
        const encoded = EncryptedRecordCodec.encode(record, keys);
        writeSync(fd, encoded, 0, encoded.length);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

function truncateIfRequested(filePath: string, offset: number, options: EncryptedRecordReadOptions): void {
  if (options.truncateTrailing === true) {
    truncateSync(filePath, offset);
  }
}
