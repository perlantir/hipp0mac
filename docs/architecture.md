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

## Enterprise Tool Runtime And Safety Governor

The daemon owns a strict local tool runtime used by every file, shell,
HTTP, and test-only sleep operation. Each executable tool registers a
Phase 5B capability manifest at daemon startup. No tool runs without a
manifest.

Each manifest declares:

- zod-backed runtime input/output validation plus JSON-schema metadata
- side-effect class
- idempotency support
- filesystem and network scope
- approval predicates and forbidden-input predicates
- timeout policy

Execution order is:

```text
input schema validation
safety_decision
budget check
lock_acquired
tool_call_intended
tool function
tool_call_result
lock_released
```

Approval-required calls stop after `safety_decision` and create a pending
approval. The tool function is not invoked until an approval event resumes
the same logical call and idempotency key.

Write and external tools receive an idempotency key generated before
`tool_call_intended`. Replays and reconciliations reuse the same key.
Write/external replay returns recorded or synthesized results and does not
blindly double-execute side effects.

Filesystem mutation idempotency is durable in daemon state. `fs.append`
uses per-file append logs under `state/tool-tombstones/fs.append/`.
`fs.copy` and `fs.move` use tombstone logs at
`state/tool-tombstones/fs.copy.log` and
`state/tool-tombstones/fs.move.log`. These logs let status queries
synthesize results after a crash when the side effect applied but
`tool_call_result` was not appended.

The Safety Governor evaluates predicates mechanically: forbidden patterns,
scope checks, approval policy, then allow. Scope violations deny. Every
safety decision is recorded with an input digest rather than raw input.

The Phase 5B starter tools are:

- `fs.read`
- `fs.write`
- `fs.delete`
- `shell.exec`
- `http.fetch`
- `sleep.wait`

Legacy `fs.append`, `fs.copy`, `fs.move`, `shell.run`, and
`shell.runInteractive` remain registered through the manifest-backed
runtime for compatibility.
