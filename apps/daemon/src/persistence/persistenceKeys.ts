import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const persistenceKeychainService = "com.perlantir.operatordock.persistence";
export const encryptionKeyAccount = "OperatorDock.encryption.master";
export const hmacKeyAccount = "OperatorDock.signing.hmac";
export const persistenceKeyAccessClass = "kSecAttrAccessibleAfterFirstUnlock";

export interface PersistenceKeys {
  encryptionKey: Buffer;
  hmacKey: Buffer;
}

export interface PersistenceKeychainClient {
  get(account: string): Promise<Buffer | undefined>;
  set(account: string, value: Buffer, accessClass: string): Promise<void>;
}

export class PersistenceKeyManager {
  constructor(private readonly keychain: PersistenceKeychainClient = new MacOSPersistenceKeychainClient()) {}

  async loadOrCreateKeys(): Promise<PersistenceKeys> {
    const encryptionKey = await this.loadOrCreateKey(encryptionKeyAccount);
    const hmacKey = await this.loadOrCreateKey(hmacKeyAccount);
    return { encryptionKey, hmacKey };
  }

  private async loadOrCreateKey(account: string): Promise<Buffer> {
    let key: Buffer | undefined;
    try {
      key = await this.keychain.get(account);
    } catch (error) {
      throw new Error(`Keychain unavailable for ${account}: ${redactKeychainError(error)}`);
    }

    if (key !== undefined) {
      validateKey(account, key);
      return key;
    }

    const generated = randomBytes(32);
    try {
      await this.keychain.set(account, generated, persistenceKeyAccessClass);
    } catch (error) {
      throw new Error(`Keychain unavailable for ${account}: ${redactKeychainError(error)}`);
    }

    return generated;
  }
}

export function persistenceKeyManagerFromEnv(env: NodeJS.ProcessEnv): PersistenceKeyManager {
  if (
    env.OPERATOR_DOCK_TEST_MODE === "1"
    && env.OPERATOR_DOCK_TEST_ENCRYPTION_KEY_BASE64 !== undefined
    && env.OPERATOR_DOCK_TEST_HMAC_KEY_BASE64 !== undefined
  ) {
    return new PersistenceKeyManager(new MemoryPersistenceKeychainClient({
      initialValues: {
        [encryptionKeyAccount]: Buffer.from(env.OPERATOR_DOCK_TEST_ENCRYPTION_KEY_BASE64, "base64"),
        [hmacKeyAccount]: Buffer.from(env.OPERATOR_DOCK_TEST_HMAC_KEY_BASE64, "base64")
      }
    }));
  }

  return new PersistenceKeyManager(new MacOSPersistenceKeychainClient());
}

/* v8 ignore start -- exercised by macOS integration/manual Keychain tests, not unit CI. */
export class MacOSPersistenceKeychainClient implements PersistenceKeychainClient {
  constructor(private readonly serviceName = persistenceKeychainService) {}

  async get(account: string): Promise<Buffer | undefined> {
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", [
        "find-generic-password",
        "-s",
        this.serviceName,
        "-a",
        account,
        "-w"
      ]);
      const value = stdout.trim();
      return value.length === 0 ? undefined : Buffer.from(value, "base64");
    } catch (error) {
      if (isMissingKeychainItem(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async set(account: string, value: Buffer): Promise<void> {
    await execFileAsync("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-s",
      this.serviceName,
      "-a",
      account,
      "-w",
      value.toString("base64")
    ]);
  }
}
/* v8 ignore stop */

export class MemoryPersistenceKeychainClient implements PersistenceKeychainClient {
  private readonly values = new Map<string, Buffer>();
  private readonly accessClasses = new Map<string, string>();
  private readonly failReads: boolean;

  constructor(options: { failReads?: boolean; initialValues?: Record<string, Buffer> } = {}) {
    this.failReads = options.failReads ?? false;
    for (const [account, value] of Object.entries(options.initialValues ?? {})) {
      this.values.set(account, Buffer.from(value));
      this.accessClasses.set(account, persistenceKeyAccessClass);
    }
  }

  async get(account: string): Promise<Buffer | undefined> {
    if (this.failReads) {
      throw new Error("Keychain unavailable");
    }
    return this.values.get(account);
  }

  async set(account: string, value: Buffer, accessClass: string): Promise<void> {
    this.values.set(account, Buffer.from(value));
    this.accessClasses.set(account, accessClass);
  }

  accessClassFor(account: string): string | undefined {
    return this.accessClasses.get(account);
  }
}

function validateKey(account: string, key: Buffer): void {
  if (key.length !== 32) {
    throw new Error(`Invalid persistence key length for ${account}.`);
  }
}

function redactKeychainError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown error";
  }
  return error.message.replace(/[A-Za-z0-9+/=]{24,}/g, "[REDACTED]");
}

/* v8 ignore start */
function isMissingKeychainItem(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; stderr?: unknown; message?: unknown };
  return candidate.code === 44
    || String(candidate.stderr ?? candidate.message ?? "").includes("could not be found");
}
/* v8 ignore stop */
