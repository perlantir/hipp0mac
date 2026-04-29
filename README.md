# Operator Dock

Operator Dock is a Mac-first autonomous AI agent workspace. This repository starts with a native SwiftUI macOS shell, a local TypeScript daemon, a Swift helper persistence foundation, shared protocol schemas, and local encrypted persistence.

## Structure

- `apps/mac` - SwiftUI macOS app built with Swift Package Manager.
- `apps/daemon` - local Node/TypeScript daemon with HTTP, WebSocket events, SQLite, and migrations.
- `apps/helper` - SwiftPM helper package for the Phase 5A signed persistence daemon foundation.
- `packages/protocol` - shared zod schemas for task events, tool calls, approvals, artifacts, and model messages.
- `packages/shared` - shared TypeScript utilities and default daemon connection settings.
- `docs` - architecture notes, roadmap, design handoff, and local API docs.

## Requirements

- macOS 14 or newer for the app shell.
- Swift 6 or newer.
- Node.js 25 or newer. The daemon uses Node's built-in `node:sqlite` module.
- npm 11 or newer.

## Setup

```bash
npm install
npm run build
```

Run the daemon:

```bash
npm run daemon
```

Run the Mac app:

```bash
npm run mac:run
```

Build and test the Phase 5A helper:

```bash
npm run helper:build
npm run helper:test
```

The Codex desktop Run action is wired to `./script/build_and_run.sh` and launches the SwiftPM app as a real `.app` bundle from `dist/OperatorDock.app`.

## Local Daemon

Default daemon address:

```text
http://127.0.0.1:4768
ws://127.0.0.1:4768/v1/events
```

The daemon refuses non-loopback bind hosts by default. `OPERATOR_DOCK_HOST` must be `127.0.0.1` or `::1` unless `OPERATOR_DOCK_ALLOW_NETWORK_BIND=1` is set for an explicit network-binding deployment.

HTTP requests and WebSocket upgrades require a bearer token stored in macOS Keychain under service `com.perlantir.operatordock.daemon`, account `daemon:httpBearerToken`. The Mac app reads the same token and attaches it automatically.

Daemon state lives under:

```text
~/Library/Application Support/OperatorDock/state/
```

The daemon migrates the earlier `~/.operator-dock` layout into the state directory once and writes `.migrated-from-v0`.

Useful endpoints:

- `GET /health`
- `GET /v1/tasks`
- `POST /v1/tasks`
- `GET /v1/providers`
- `PUT /v1/providers/:providerId`
- `POST /v1/providers/:providerId/test`
- `GET /v1/model-router`
- `PUT /v1/model-router`
- `POST /v1/model-router/chat`
- `GET /v1/workspace`
- `PUT /v1/workspace`
- `POST /v1/workspace/projects`
- `GET /v1/workspace/files`
- `POST /v1/tools/fs/:operation`
- `POST /v1/tools/execute`
- `POST /v1/tools/executions/:executionId/cancel`
- `GET /v1/tools/approvals`
- `POST /v1/tools/approvals/:approvalId/resolve`

Example task creation:

```bash
export OPERATOR_DOCK_DAEMON_TOKEN="$(security find-generic-password -s com.perlantir.operatordock.daemon -a daemon:httpBearerToken -w)"
curl -s http://127.0.0.1:4768/v1/tasks \
  -H "authorization: Bearer $OPERATOR_DOCK_DAEMON_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Smoke test","prompt":"Create a test task from curl"}'
```

## Testing

```bash
npm test
```

This runs TypeScript package tests and SwiftPM tests for the macOS app core networking helpers.

Phase 5A persistence documentation lives in `docs/phase-5a`.

## Product Context

- Project memory and standing quality directives: `docs/project-memory.md`
- Roadmap phases: `docs/roadmap.md`
- Claude design handoff: `docs/design/claude-handoff`

## Provider Security

The Mac app stores hosted provider API keys in macOS Keychain using service `com.perlantir.operatordock.providers`. The daemon reads credentials from the same local Keychain service when it needs to test or use a provider. Provider settings stored in SQLite contain only non-secret configuration such as enabled state, endpoint, default model, and role defaults.

## Tool Runtime Safety

All tool calls now flow through a typed runtime with zod input/output validation, deterministic error codes, persisted events, replay metadata, timeout/cancellation support, approval hooks, and secret redaction. File tools are registered as runtime tools, and `shell.run` / `shell.runInteractive` are guarded by command classification for sudo, broad deletes, curl-pipe-shell, destructive denylisted commands, and outside-workspace mutations.
