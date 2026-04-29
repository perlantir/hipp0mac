import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from "@operator-dock/shared";

export interface DaemonConfig {
  host: string;
  port: number;
  databasePath: string;
  migrationsDir: string;
}

const daemonRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const port = Number.parseInt(env.OPERATOR_DOCK_PORT ?? `${DEFAULT_DAEMON_PORT}`, 10);
  const host = env.OPERATOR_DOCK_HOST ?? DEFAULT_DAEMON_HOST;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid OPERATOR_DOCK_PORT: ${env.OPERATOR_DOCK_PORT}`);
  }

  if (!isAllowedHost(host) && env.OPERATOR_DOCK_ALLOW_NETWORK_BIND !== "1") {
    throw new Error(
      `Refusing to bind Operator Dock daemon to non-loopback host ${host}. Set OPERATOR_DOCK_ALLOW_NETWORK_BIND=1 only for an explicit network-binding deployment.`
    );
  }

  const stateRoot = defaultStateRoot(env);
  migrateLegacyNodeState({
    legacyRoot: resolve(env.HOME ?? homedir(), ".operator-dock"),
    stateRoot
  });

  return {
    host,
    port,
    databasePath:
      env.OPERATOR_DOCK_DB_PATH ?? resolve(stateRoot, "operator-dock.sqlite"),
    migrationsDir: env.OPERATOR_DOCK_MIGRATIONS_DIR ?? resolve(daemonRoot, "migrations")
  };
}

function isAllowedHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

function defaultStateRoot(env: NodeJS.ProcessEnv): string {
  return resolve(
    env.HOME ?? homedir(),
    "Library",
    "Application Support",
    "OperatorDock",
    "state"
  );
}

export function migrateLegacyNodeState(input: { legacyRoot: string; stateRoot: string }): void {
  const markerPath = join(input.stateRoot, ".migrated-from-v0");
  if (existsSync(markerPath) || !existsSync(input.legacyRoot)) {
    mkdirSync(input.stateRoot, { recursive: true });
    return;
  }

  mkdirSync(dirname(input.stateRoot), { recursive: true });
  if (!existsSync(input.stateRoot)) {
    renameSync(input.legacyRoot, input.stateRoot);
  } else {
    for (const entry of readdirSync(input.legacyRoot)) {
      renameSync(join(input.legacyRoot, entry), join(input.stateRoot, entry));
    }
    rmSync(input.legacyRoot, { recursive: true, force: true });
  }

  const migratedFiles = readdirSync(input.stateRoot).filter((entry) => entry !== ".migrated-from-v0");
  writeFileSync(
    markerPath,
    JSON.stringify({
      schemaVersion: 1,
      migratedAt: new Date().toISOString(),
      from: input.legacyRoot,
      movedEntries: migratedFiles
    }, null, 2)
  );
}
