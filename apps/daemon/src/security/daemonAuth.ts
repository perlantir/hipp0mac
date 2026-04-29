import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const daemonAuthKeychainService = "com.perlantir.operatordock.daemon";
export const daemonAuthKeychainAccount = "daemon:httpBearerToken";

export interface DaemonAuthTokenStore {
  loadOrCreateToken(): Promise<string>;
}

export class MacOSKeychainDaemonAuthTokenStore implements DaemonAuthTokenStore {
  async loadOrCreateToken(): Promise<string> {
    const existing = await this.readToken();
    if (existing !== undefined) {
      return existing;
    }

    const token = generateBearerToken();
    try {
      await execFileAsync("/usr/bin/security", [
        "add-generic-password",
        "-U",
        "-s",
        daemonAuthKeychainService,
        "-a",
        daemonAuthKeychainAccount,
        "-w",
        token
      ]);
    } catch {
      throw new Error("Unable to store Operator Dock daemon bearer token in Keychain.");
    }
    return token;
  }

  private async readToken(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", [
        "find-generic-password",
        "-s",
        daemonAuthKeychainService,
        "-a",
        daemonAuthKeychainAccount,
        "-w"
      ]);
      const token = stdout.trim();
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  }
}

export class MemoryDaemonAuthTokenStore implements DaemonAuthTokenStore {
  constructor(private token = generateBearerToken()) {}

  async loadOrCreateToken(): Promise<string> {
    return this.token;
  }
}

export function bearerTokenFromAuthorizationHeader(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

export function isAuthorizedBearerToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined || actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function generateBearerToken(): string {
  return randomBytes(32).toString("base64url");
}
