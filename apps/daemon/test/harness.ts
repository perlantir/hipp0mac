import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryDaemonAuthTokenStore } from "../src/security/daemonAuth.js";
import { loadConfig } from "../src/config.js";
import { MemoryPersistenceKeychainClient, PersistenceKeyManager } from "../src/persistence/persistenceKeys.js";

export const testBearerToken = "test-daemon-token-0123456789";

export function authHeaders(token = testBearerToken): Record<string, string> {
  return {
    authorization: `Bearer ${token}`
  };
}

export function authStore(token = testBearerToken): MemoryDaemonAuthTokenStore {
  return new MemoryDaemonAuthTokenStore(token);
}

export function persistenceKeyManager(): PersistenceKeyManager {
  return new PersistenceKeyManager(new MemoryPersistenceKeychainClient());
}

export function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testConfig(root: string) {
  return loadConfig({
    HOME: root,
    OPERATOR_DOCK_STATE_ROOT: join(root, "state"),
    OPERATOR_DOCK_DB_PATH: join(root, "operator-dock.sqlite"),
    OPERATOR_DOCK_MIGRATIONS_DIR: resolve("migrations")
  });
}
