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
- provider configuration, model capabilities, provider connection tests, and model router chat requests

Swift models in the app mirror the wire protocol needed by the shell. As the product grows, these schemas should become the source of truth for generated clients.

## Local Storage

The first migration creates durable tables for:

- `projects`
- `tasks`
- `memory_entries`
- `settings`
- `schedules`
- `artifacts`

Provider settings are stored in the `settings` table as non-secret JSON. Hosted provider API keys are never stored in SQLite.

## Provider And Model Router

The Mac app writes hosted provider API keys to macOS Keychain under service `com.perlantir.operatordock.providers`. The daemon reads those keys from local secure storage through the system Keychain when it needs to test or call a hosted provider.

The daemon exposes provider setup endpoints under `/v1/providers` and model-router endpoints under `/v1/model-router`. The normalized router supports:

- OpenAI-compatible chat completions for OpenAI, OpenRouter, and LM Studio style endpoints.
- Anthropic messages.
- Ollama local chat.
- Tool-call style response normalization where the provider exposes tool calls.

Streaming capability is tracked per model in protocol metadata and reserved in the router adapter interface for the execution layer that will consume streams.

## Local Workspace And File Tools

The daemon owns workspace initialization and persists workspace settings in SQLite's `settings` table. A configured workspace creates the following managed folders:

- `projects`
- `tasks`
- `artifacts`
- `logs`
- `skills`
- `memory`

File writes and deletes default to the configured workspace boundary. Outside-workspace writes/deletes return an approval-required result unless an approved execution token is supplied by the tool runtime. Deletes targeting system directories are blocked outright. Every file operation writes a raw audit record to `file_operation_logs` and emits structured tool events.
