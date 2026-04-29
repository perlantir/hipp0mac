import { dirname, resolve } from "node:path";
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

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid OPERATOR_DOCK_PORT: ${env.OPERATOR_DOCK_PORT}`);
  }

  return {
    host: env.OPERATOR_DOCK_HOST ?? DEFAULT_DAEMON_HOST,
    port,
    databasePath:
      env.OPERATOR_DOCK_DB_PATH ?? resolve(homedir(), ".operator-dock", "operator-dock.sqlite"),
    migrationsDir: env.OPERATOR_DOCK_MIGRATIONS_DIR ?? resolve(daemonRoot, "migrations")
  };
}

