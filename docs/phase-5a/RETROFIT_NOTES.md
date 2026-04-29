# Phase 0-4 Retrofit Notes For Phase 5A

These notes capture the accepted audit corrections folded into the Phase 5A worktree.

## 1. HTTP and WebSocket Auth

Status: implemented.

The Node daemon now requires `Authorization: Bearer <token>` on every HTTP request and WebSocket upgrade. The token is generated on first daemon start and stored in macOS Keychain under:

```text
service: com.perlantir.operatordock.daemon
account: daemon:httpBearerToken
```

`OPERATOR_DOCK_HOST` is constrained to `127.0.0.1` or `::1` by default. Network binding requires the explicit `OPERATOR_DOCK_ALLOW_NETWORK_BIND=1` flag.

Tests cover missing HTTP token, missing WebSocket token, wrong token, successful token, and bad host rejection.

## 2. State Layout Migration

Status: implemented.

Daemon-owned state now lives under:

```text
~/Library/Application Support/OperatorDock/state/
```

Node migrates the old `~/.operator-dock` layout into the state directory and writes `.migrated-from-v0`.

The Swift helper migrates a previous direct Application Support layout:

```text
~/Library/Application Support/OperatorDock/event-store/
~/Library/Application Support/OperatorDock/checkpoints/
...
```

into:

```text
~/Library/Application Support/OperatorDock/state/
```

and writes `.migrated-from-v0`.

## 3. SQLite Versus Event Store

Status: implemented as a Phase 5A retrofit bridge.

The existing `tool_executions`, `tool_events`, and `file_operation_logs` tables are now classified as legacy/projection tables. Migration `003_phase5_projection_legacy.sql` adds:

- `legacy`
- `intended_event_id` / `result_event_id` where applicable
- `canonical_event_id` where applicable

Existing rows default to `legacy=1`. If any legacy rows are present, the daemon emits one `legacy_data_present` canonical daemon event. It does not attempt to reconstruct canonical events from old SQLite rows, because that would risk inventing history.

New tool executions append a `tool_call_intended` event before SQLite insertion and append `tool_call_result` before terminal SQLite update. SQLite rows are therefore projections of canonical intent/result records.

Projection encryption note: the Node daemon currently uses field-level AES-256-GCM envelope encryption for execution-derived SQLite columns. This protects projection payloads, outputs, errors, replay metadata, approval tokens, and file operation paths from plaintext storage. It is not SQLCipher full-database page encryption. Full SQLCipher or a helper-owned encrypted projection database remains a hardening item if the product requires the SQLite file header, schema, and indexes to be encrypted as well.

## 4. Redacted Logging

Status: implemented.

Fastify now uses a redacting logger stream. Daemon logging paths route through Fastify's `app.log`; no `console.log` or direct Pino logger remains in `apps/daemon/src`.

The redaction transform removes API keys, bearer tokens, token assignments, secret assignments, and explicitly supplied secret values before log output is written.

Tests trigger Fastify error logging with fake secrets and assert that secret values do not appear in captured logs.

## Carry Forward To Later Phase 5 Work

Phase 5B:

- Wrap all file tools with manifests.
- Add idempotency keys for write/external tools.
- Convert UI `tool.started` / `tool.output` / `tool.completed` / `tool.failed` events into deterministic projections of canonical intended/result events.
- Extend the Safety Governor from command classification to predicate AST policies.
- Formalize `safety_decision`, `approval_granted`, and `approval_denied` event semantics.

Phase 5C:

- Add promptVersion and modelVersion to model call results.
- Add deterministic fixture-driven mock provider.
- Add fallback chains for retryable provider errors.
- Harden model streaming cancellation.

Phase 5E:

- Formalize persistent approval scopes and expiries.
- Build observability projections across event store and SQLite.

