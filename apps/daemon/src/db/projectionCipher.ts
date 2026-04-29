import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const prefix = "enc:v1:";

export class ProjectionCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  encrypt(value: string): string {
    if (this.isEncrypted(value)) {
      return value;
    }

    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${prefix}${Buffer.concat([nonce, tag, ciphertext]).toString("base64url")}`;
  }

  decrypt(value: string): string {
    if (!this.isEncrypted(value)) {
      return value;
    }

    const sealed = Buffer.from(value.slice(prefix.length), "base64url");
    const nonce = sealed.subarray(0, 12);
    const tag = sealed.subarray(12, 28);
    const ciphertext = sealed.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  encryptNullable(value: string | null): string | null {
    return value === null ? null : this.encrypt(value);
  }

  decryptNullable(value: string | null): string | null {
    return value === null ? null : this.decrypt(value);
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(prefix);
  }
}
