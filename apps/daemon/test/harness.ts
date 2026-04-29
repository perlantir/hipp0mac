import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { MemoryDaemonAuthTokenStore } from "../src/security/daemonAuth.js";

export const testBearerToken = "test-daemon-bearer-token";

export function authHeaders(token = testBearerToken): Record<string, string> {
  return {
    authorization: `Bearer ${token}`
  };
}

export function authStore(token = testBearerToken): MemoryDaemonAuthTokenStore {
  return new MemoryDaemonAuthTokenStore(token);
}

export function testConfig(root: string) {
  return loadConfig({
    HOME: root,
    OPERATOR_DOCK_DB_PATH: join(root, "operator-dock.sqlite"),
    OPERATOR_DOCK_MIGRATIONS_DIR: resolve("migrations")
  });
}
