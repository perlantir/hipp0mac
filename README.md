# Operator Dock

Operator Dock is a Mac-first autonomous AI agent workspace. This repository starts with a native SwiftUI macOS shell, a local TypeScript daemon, shared protocol schemas, and local SQLite persistence.

## Structure

- `apps/mac` - SwiftUI macOS app built with Swift Package Manager.
- `apps/daemon` - local Node/TypeScript daemon with HTTP, WebSocket events, SQLite, and migrations.
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

Example task creation:

```bash
curl -s http://127.0.0.1:4768/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Smoke test","prompt":"Create a test task from curl"}'
```

## Testing

```bash
npm test
```

This runs TypeScript package tests and SwiftPM tests for the macOS app core networking helpers.

## Product Context

- Project memory and standing quality directives: `docs/project-memory.md`
- Roadmap phases: `docs/roadmap.md`
- Claude design handoff: `docs/design/claude-handoff`

## Provider Security

The Mac app stores hosted provider API keys in macOS Keychain using service `com.perlantir.operatordock.providers`. The daemon reads credentials from the same local Keychain service when it needs to test or use a provider. Provider settings stored in SQLite contain only non-secret configuration such as enabled state, endpoint, default model, and role defaults.
