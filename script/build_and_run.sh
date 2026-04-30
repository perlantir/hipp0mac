#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="OperatorDock"
BUNDLE_ID="com.perlantir.operatordock"
MIN_SYSTEM_VERSION="14.0"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAC_DIR="$ROOT_DIR/apps/mac"
DIST_DIR="$ROOT_DIR/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_MACOS/$APP_NAME"
INFO_PLIST="$APP_CONTENTS/Info.plist"
DAEMON_ENTRY="$ROOT_DIR/apps/daemon/dist/index.js"
DAEMON_CONFIG="$APP_RESOURCES/operator-dock-daemon.json"
DAEMON_PORT="4768"
DAEMON_URL="http://127.0.0.1:$DAEMON_PORT"

pkill -x "$APP_NAME" >/dev/null 2>&1 || true

swift build --package-path "$MAC_DIR"
npm run build
BUILD_BINARY="$(swift build --package-path "$MAC_DIR" --show-bin-path)/$APP_NAME"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS"
mkdir -p "$APP_RESOURCES"
cp "$BUILD_BINARY" "$APP_BINARY"
chmod +x "$APP_BINARY"

DAEMON_ENTRY="$DAEMON_ENTRY" \
DAEMON_CONFIG="$DAEMON_CONFIG" \
ROOT_DIR="$ROOT_DIR" \
DAEMON_PORT="$DAEMON_PORT" \
node - <<'NODE'
const { writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const port = process.env.DAEMON_PORT;
const config = {
  executablePath: "/usr/bin/env",
  arguments: ["node", process.env.DAEMON_ENTRY],
  environment: {
    OPERATOR_DOCK_HOST: "127.0.0.1",
    OPERATOR_DOCK_PORT: port,
    OPERATOR_DOCK_MIGRATIONS_DIR: `${process.env.ROOT_DIR}/apps/daemon/migrations`
  },
  workingDirectory: process.env.ROOT_DIR,
  respawnDelaySeconds: 1,
  maxRespawnDelaySeconds: 30,
  watchdogIntervalSeconds: 2,
  healthTimeoutSeconds: 1,
  startupGraceSeconds: 60,
  healthFailureThreshold: 5,
  maxRestartFailures: 10,
  restartFailureWindowSeconds: 300,
  healthURLString: `http://127.0.0.1:${port}/health`,
  logFilePath: join(homedir(), "Library", "Logs", "OperatorDock", "daemon.log"),
  logRotationBytes: 10 * 1024 * 1024,
  logRotationCount: 5
};
writeFileSync(process.env.DAEMON_CONFIG, JSON.stringify(config, null, 2));
NODE

cat >"$INFO_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MIN_SYSTEM_VERSION</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

verify_daemon() {
  DAEMON_URL="$DAEMON_URL" \
  ROOT_DIR="$ROOT_DIR" \
  node - <<'NODE'
const { execFileSync } = require("node:child_process");
const { statSync } = require("node:fs");
const { join } = require("node:path");

const daemonUrl = process.env.DAEMON_URL;
const rootDir = process.env.ROOT_DIR;
const deadline = Date.now() + 30_000;
const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: rootDir,
  encoding: "utf8"
}).trim();
const expectedMtimeMs = Math.trunc(statSync(join(rootDir, "apps", "daemon", "dist", "server.js")).mtimeMs);
let lastError = "daemon did not respond";

function bearerToken() {
  try {
    return execFileSync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      "com.perlantir.operatordock.daemon",
      "-a",
      "daemon:httpBearerToken",
      "-w"
    ], { encoding: "utf8" }).trim();
  } catch (error) {
    lastError = "bearer token not yet available in Keychain";
    return "";
  }
}

async function main() {
  while (Date.now() < deadline) {
    const token = bearerToken();
    if (token.length > 0) {
      try {
        const response = await fetch(new URL("/health", daemonUrl), {
          headers: { authorization: `Bearer ${token}` }
        });
        const text = await response.text();
        if (!response.ok) {
          lastError = `/health returned HTTP ${response.status}: ${text}`;
        } else {
          const health = JSON.parse(text);
          const build = health.build ?? {};
          if (build.gitCommit !== expectedCommit || Math.trunc(build.serverFileMtimeMs) !== expectedMtimeMs) {
            lastError = `stale daemon build: expected ${expectedCommit}/${expectedMtimeMs}, got ${build.gitCommit}/${build.serverFileMtimeMs}`;
          } else {
            console.log(`Daemon healthy at ${daemonUrl} (${health.state ?? "unknown"}).`);
            process.exit(0);
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.error(`Operator Dock daemon smoke check failed at ${daemonUrl}: ${lastError}`);
  console.error("Quit Operator Dock, check ~/Library/Logs/OperatorDock/daemon.log, and rerun script/build_and_run.sh.");
  process.exit(1);
}

main().catch((error) => {
  console.error(`Operator Dock daemon smoke check failed at ${daemonUrl}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
NODE
}

case "$MODE" in
  run)
    open_app
    verify_daemon
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    verify_daemon
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    verify_daemon
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    pgrep -x "$APP_NAME" >/dev/null
    verify_daemon
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
