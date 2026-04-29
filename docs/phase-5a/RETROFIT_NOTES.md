# Phase 5A Retrofit Notes

## Swift Helper Rollback

The Swift helper was preserved on branch `exploration/swift-helper` and removed from the shipping Phase 5A path. Phase 5A now continues inside the existing TypeScript/Node daemon.

## HTTP and WebSocket Auth

The daemon requires `Authorization: Bearer <token>` for HTTP requests and WebSocket upgrades. The token is generated once and stored in macOS Keychain under:

```text
service: com.perlantir.operatordock.daemon
account: daemon:httpBearerToken
```

The daemon rejects non-loopback binds by default. Only `127.0.0.1` and `::1` are accepted unless `OPERATOR_DOCK_ALLOW_NETWORK_BIND=1` is set.

## State Layout Migration

Default daemon state moved from `~/.operator-dock` to:

```text
~/Library/Application Support/OperatorDock/state/
```

The migration moves the old directory contents and writes `.migrated-from-v0`. User workspace content remains outside this daemon state root.

## SQLite and Event Store Ownership

Existing `tool_executions`, `tool_events`, and `file_operation_logs` rows are legacy projection data. Migration `003_phase5a_legacy_projection_columns.sql` adds:

- `legacy`
- `task_id`
- `intended_event_id`
- `result_event_id`
- `lock_event_id`

Existing rows are marked `legacy = 1`. New rows are written after canonical event store writes and use `legacy = 0`.

No attempt is made to reconstruct canonical events from old SQLite rows.

## Encryption

The daemon uses Keychain-backed keys:

```text
OperatorDock.encryption.master
OperatorDock.signing.hmac
```

Event store, checkpoints, and task metadata use AES-256-GCM record encryption. SQLite uses SQLCipher-compatible full-page encryption through `better-sqlite3-multiple-ciphers`.

## Logging Redaction

Fastify logging is routed through the same redaction transform used by tool output redaction. Tests cover Fastify error logging with synthetic API-key and token-shaped values.

## Carry Forward

Phase 5B must add manifests and idempotency to every tool. Phase 5C must add prompt/model version recording, deterministic mock model fixtures, fallback chains, and hardened streaming cancellation. Phase 5E must formalize persistent approvals and deterministic UI projections.
