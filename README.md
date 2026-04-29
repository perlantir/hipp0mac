# Operator Dock

Operator Dock is a Mac-first autonomous AI agent workspace. This repository starts with a native SwiftUI macOS shell, a local TypeScript daemon, shared protocol schemas, and local SQLite persistence.

## Structure

- `apps/mac` - SwiftUI macOS app built with Swift Package Manager.
- `apps/daemon` - local Node/TypeScript daemon with HTTP, WebSocket events, SQLCipher SQLite, encrypted canonical event store, and migrations.
- `packages/protocol` - shared zod schemas for task events, tool calls, approvals, artifacts, and model messages.
- `packages/shared` - shared TypeScript utilities and default daemon connection settings.
- `docs` - architecture notes, roadmap, design handoff, and local API docs.

## Requirements

- macOS 14 or newer for the app shell.
- Swift 6 or newer.
- Node.js 24.x. The daemon uses `better-sqlite3-multiple-ciphers` for SQLCipher-compatible page encryption.
- npm 10 or newer.

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

The Codex desktop Run action is wired to `./script/build_and_run.sh` and launches the SwiftPM app as a real `.app` bundle from `dist/OperatorDock.app`.

## Local Daemon

Default daemon address:

```text
http://127.0.0.1:4768
ws://127.0.0.1:4768/v1/events
```

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
TOKEN="$(security find-generic-password -s com.perlantir.operatordock.daemon -a daemon:httpBearerToken -w)"
curl -s http://127.0.0.1:4768/v1/tasks \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Smoke test","prompt":"Create a test task from curl"}'
```

## Testing

```bash
npm test
npm run test:coverage -w @operator-dock/daemon
```

This runs TypeScript package tests and SwiftPM tests for the macOS app core networking and daemon supervision helpers.

## Product Context

- Project memory and standing quality directives: `docs/project-memory.md`
- Roadmap phases: `docs/roadmap.md`
- Claude design handoff: `docs/design/claude-handoff`

## Provider Security

The Mac app stores hosted provider API keys in macOS Keychain using service `com.perlantir.operatordock.providers`. The daemon reads credentials from the same local Keychain service when it needs to test or use a provider. Provider settings stored in SQLite contain only non-secret configuration such as enabled state, endpoint, default model, and role defaults.

The daemon also generates local bearer auth and persistence keys in Keychain:

- `com.perlantir.operatordock.daemon` / `daemon:httpBearerToken`
- `com.perlantir.operatordock.persistence` / `OperatorDock.encryption.master`
- `com.perlantir.operatordock.persistence` / `OperatorDock.signing.hmac`

By default the HTTP and WebSocket server binds only to `127.0.0.1` or `::1`; network binding requires `OPERATOR_DOCK_ALLOW_NETWORK_BIND=1`.

## Phase 5A Persistence

Daemon-owned state lives under `~/Library/Application Support/OperatorDock/state/`, distinct from the user-selected workspace. The event store is encrypted, hash-chained, append-only, and canonical for execution history. SQLite is encrypted at the page level and serves user-facing metadata plus projections derived from canonical events.

The Mac app supervises the Node daemon subprocess while the app is running. It starts the daemon from app-bundle configuration, respawns it after crash exits, and stops it when the app exits. No LaunchAgent is installed in Phase 5A.

See:

- `docs/phase-5a/README.md`
- `docs/phase-5a/ARCHITECTURE.md`
- `docs/phase-5a/RETROFIT_NOTES.md`

## Tool Runtime Safety

All tool calls now flow through a typed runtime with zod input/output validation, deterministic error codes, persisted events, replay metadata, timeout/cancellation support, approval hooks, and secret redaction. File tools are registered as runtime tools, and `shell.run` / `shell.runInteractive` are guarded by command classification for sudo, broad deletes, curl-pipe-shell, destructive denylisted commands, and outside-workspace mutations.
