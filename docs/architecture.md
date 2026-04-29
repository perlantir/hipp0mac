# Architecture

Operator Dock starts as three local layers:

1. A native SwiftUI macOS app in `apps/mac`.
2. A localhost daemon in `apps/daemon`.
3. Shared TypeScript protocol schemas in `packages/protocol`.

The app talks to the daemon over:

- HTTP for command-style requests such as creating tasks.
- WebSocket for live task events such as task creation, tool calls, approvals, artifacts, and model messages.

The daemon persists local state in SQLite. Migrations live in `apps/daemon/migrations` and are applied on daemon startup.

## Protocol Surface

The protocol package defines zod schemas for:

- tasks and task lifecycle events
- model messages
- tool call request, output, and failure events
- approval request and resolution events
- artifact creation events

Swift models in the app mirror the wire protocol needed by the shell. As the product grows, these schemas should become the source of truth for generated clients.

## Local Storage

The first migration creates durable tables for:

- `projects`
- `tasks`
- `memory_entries`
- `settings`
- `schedules`
- `artifacts`

