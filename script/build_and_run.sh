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

pkill -x "$APP_NAME" >/dev/null 2>&1 || true

swift build --package-path "$MAC_DIR"
npm run build -w @operator-dock/daemon
BUILD_BINARY="$(swift build --package-path "$MAC_DIR" --show-bin-path)/$APP_NAME"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS"
mkdir -p "$APP_RESOURCES"
cp "$BUILD_BINARY" "$APP_BINARY"
chmod +x "$APP_BINARY"

DAEMON_ENTRY="$DAEMON_ENTRY" \
DAEMON_CONFIG="$DAEMON_CONFIG" \
ROOT_DIR="$ROOT_DIR" \
node - <<'NODE'
const { writeFileSync } = require("node:fs");
const config = {
  executablePath: "/usr/bin/env",
  arguments: ["node", process.env.DAEMON_ENTRY],
  environment: {
    OPERATOR_DOCK_HOST: "127.0.0.1",
    OPERATOR_DOCK_PORT: "4768",
    OPERATOR_DOCK_MIGRATIONS_DIR: `${process.env.ROOT_DIR}/apps/daemon/migrations`
  },
  workingDirectory: process.env.ROOT_DIR,
  respawnDelaySeconds: 0.5,
  watchdogIntervalSeconds: 2,
  healthTimeoutSeconds: 1,
  startupGraceSeconds: 3,
  healthFailureThreshold: 1,
  healthURLString: "http://127.0.0.1:4768/health"
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

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    sleep 1
    pgrep -x "$APP_NAME" >/dev/null
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
