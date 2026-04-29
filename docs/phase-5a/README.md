# Phase 5A Persistence Platform

Phase 5A establishes the storage and platform foundation for Operator Dock. There is no planner, agent loop, model execution, or tool orchestration in this layer.

## Helper Role

`apps/helper` is a new SwiftPM package added for Phase 5A. It is the future signed helper daemon that owns persistence, XPC admission, encryption, append-only events, checkpoints, locks, and task metadata.

The existing Node daemon remains the Phase 0-4 HTTP/WebSocket runtime. The helper does not replace it yet. It changes the Phase 5A assumption from "Node owns all local state" to "Node continues serving current product endpoints while the Swift helper becomes the authoritative persistence foundation for future agent infrastructure."

## Filesystem Layout

The helper creates daemon-owned state under:

```text
~/Library/Application Support/OperatorDock/state/
  event-store/
  checkpoints/
  artifacts/
  memory/
  tasks/
  config/
  locks/
```

This state is opaque product infrastructure. It is separate from the user-selected workspace introduced in Phase 3.

The Node daemon also stores its SQLite database under:

```text
~/Library/Application Support/OperatorDock/state/operator-dock.sqlite
```

On first launch, Node migrates the previous `~/.operator-dock` directory into the state directory and writes `.migrated-from-v0`. The Swift helper migrates the previous `~/Library/Application Support/OperatorDock/<state-folders>` layout into `~/Library/Application Support/OperatorDock/state/` and writes the same marker.

## Event Schema

Current schema version is `1`.

```json
{
  "schemaVersion": 1,
  "eventId": "UUIDv7",
  "taskId": "string",
  "parentEventId": "string-or-null",
  "timestamp": "ISO-8601-with-milliseconds",
  "eventType": "string",
  "payload": {},
  "prevHash": "sha256-hex",
  "hmac": "hmac-sha256-hex"
}
```

Every persisted helper event is encrypted as an AES-256-GCM length-prefixed record:

```text
[4-byte length][12-byte nonce][ciphertext][16-byte GCM tag]
```

The event store is append-only and is the source of truth. Task metadata and checkpoints are derived caches.

## Migrations

Every persisted record carries `schemaVersion`. Loading a future version is a hard error. Loading an older version goes through the forward-only migration framework.

To add a future migration:

1. Add an idempotent `migrate_<from>_to_<to>` function.
2. Register it in `SchemaMigrator`.
3. Add a fixture from the old schema.
4. Add tests for fixture load, idempotency, and future-version refusal.
5. Emit `schema_migration_applied` the first time a task is migrated.

Phase 5A includes a synthetic `v0 -> v1` migration fixture to prove the path.

## Recovery Procedure

Startup order:

1. Load Keychain material. If unavailable, fail closed.
2. Create or verify the filesystem layout.
3. Scan lock files and reclaim stale locks.
4. Truncate torn final event records to the last valid record.
5. Verify hash chains and HMACs before loading any task.
6. Accept XPC connections only after startup reconciliation.

Task recovery:

1. Find the latest valid checkpoint.
2. Replay events after the checkpoint event id.
3. If no checkpoint exists, replay the full event store.
4. If a checkpoint is corrupt, discard it and replay from the event store.

Crash behavior:

- Mid-record event writes are truncated on restart.
- Acknowledged appends have already fsynced.
- Locks with fresh heartbeats remain held.
- Stale locks are reclaimed after double-read verification.
- Checkpoints are never authoritative; corrupt checkpoints are discarded.

