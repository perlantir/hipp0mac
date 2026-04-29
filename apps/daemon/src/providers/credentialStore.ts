import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderId } from "@operator-dock/protocol";

const execFileAsync = promisify(execFile);

export interface CredentialStore {
  hasCredential(providerId: ProviderId): Promise<boolean>;
  getCredential(providerId: ProviderId): Promise<string | undefined>;
}

export const keychainServiceName = "com.perlantir.operatordock.providers";

export function keychainAccountForProvider(providerId: ProviderId): string {
  return `provider:${providerId}:apiKey`;
}

export class MacOSKeychainCredentialStore implements CredentialStore {
  async hasCredential(providerId: ProviderId): Promise<boolean> {
    return (await this.getCredential(providerId)) !== undefined;
  }

  async getCredential(providerId: ProviderId): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", [
        "find-generic-password",
        "-s",
        keychainServiceName,
        "-a",
        keychainAccountForProvider(providerId),
        "-w"
      ]);
      const value = stdout.trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

export class EmptyCredentialStore implements CredentialStore {
  async hasCredential(): Promise<boolean> {
    return false;
  }

  async getCredential(): Promise<string | undefined> {
    return undefined;
  }
}

export class MemoryCredentialStore implements CredentialStore {
  constructor(private readonly credentials: Partial<Record<ProviderId, string>>) {}

  async hasCredential(providerId: ProviderId): Promise<boolean> {
    return this.credentials[providerId] !== undefined;
  }

  async getCredential(providerId: ProviderId): Promise<string | undefined> {
    return this.credentials[providerId];
  }
}

