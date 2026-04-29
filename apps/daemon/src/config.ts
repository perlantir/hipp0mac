import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from "@operator-dock/shared";
import { OperatorDockPaths } from "./persistence/paths.js";

export interface DaemonConfig {
  host: string;
  port: number;
  databasePath: string;
  stateRoot: string;
  migrationsDir: string;
}

const daemonRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const host = env.OPERATOR_DOCK_HOST ?? DEFAULT_DAEMON_HOST;
  const port = Number.parseInt(env.OPERATOR_DOCK_PORT ?? `${DEFAULT_DAEMON_PORT}`, 10);

  if (!isAllowedLoopbackHost(host) && env.OPERATOR_DOCK_ALLOW_NETWORK_BIND !== "1") {
    throw new Error(`Refusing to bind Operator Dock daemon to non-loopback host: ${host}`);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid OPERATOR_DOCK_PORT: ${env.OPERATOR_DOCK_PORT}`);
  }

  const statePaths = env.OPERATOR_DOCK_STATE_ROOT === undefined
    ? OperatorDockPaths.production(env.HOME === undefined ? {} : { home: env.HOME })
    : new OperatorDockPaths(env.OPERATOR_DOCK_STATE_ROOT);
  statePaths.createLayout();

  return {
    host,
    port,
    stateRoot: statePaths.root,
    databasePath: env.OPERATOR_DOCK_DB_PATH ?? statePaths.databasePath,
    migrationsDir: env.OPERATOR_DOCK_MIGRATIONS_DIR ?? resolve(daemonRoot, "migrations")
  };
}

function isAllowedLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}
