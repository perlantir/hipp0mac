# Phase 5A Persistence Platform

Phase 5A ships inside the existing TypeScript/Node daemon. There is no Swift helper, XPC layer, launchd-only persistence owner, or SecCode gate in the shipping Phase 5A branch.

## Filesystem Layout

Daemon-owned opaque state:

```text
~/Library/Application Support/OperatorDock/state/
  event-store/
  checkpoints/
  artifacts/
  memory/
  tasks/
  config/
  locks/
  logs/
  operator-dock.sqlite
```

This is separate from the user-selected workspace folder used for projects, task outputs, artifacts, logs, skills, and memory content.

On first run, the daemon migrates the old `~/.operator-dock` layout into the new state root and writes `.migrated-from-v0`.

## Event Schema

Canonical event records are encrypted per record with AES-256-GCM:

```json
{
  "schemaVersion": 1,
  "eventId": "UUIDv7",
  "taskId": "string",
  "parentEventId": "string | null",
  "timestamp": "ISO 8601",
  "eventType": "string",
  "payload": {},
  "prevHash": "sha256(previous encrypted record bytes)",
  "hmac": "hmac-sha256(canonical unsigned record)"
}
```

Record bytes on disk:

```text
[4-byte length][12-byte nonce][ciphertext][16-byte GCM tag]
```

## SQLite Ownership

SQLite is encrypted with SQLCipher-compatible page encryption. It owns user-facing metadata and deterministic projections. Execution history is owned by the event store. If SQLite and the event store disagree, the event store wins and SQLite is rebuilt.

Legacy projection tables from Phases 3-4 are marked with `legacy = 1`. New tool execution projections are written only after the canonical event store has accepted `tool_call_intended` / `tool_call_result`.

## Migrations

Every persisted record carries `schemaVersion`. The migration framework is forward-only and read-time:

1. Reject records newer than the daemon's known schema version.
2. Apply migrations one version at a time.
3. Emit `schema_migration_applied` once per task/version pair.
4. Never rewrite immutable event records on disk.

Synthetic `v0 -> v1` fixtures are covered in daemon tests.

## Recovery Procedure

On startup:

1. Create the state layout.
2. Load persistence keys from Keychain; fail closed if unavailable.
3. Open SQLCipher SQLite and apply forward migrations.
4. Recover event logs by truncating torn final records to the last valid encrypted record.
5. Verify event chains before loading task state.
6. Reclaim stale task locks only after a second stale read.

Checkpoints are encrypted derived-state snapshots only. If a checkpoint is corrupt, it is discarded and state is replayed from the event store.

## App Supervision

The SwiftUI app starts the configured Node daemon subprocess on launch and respawns it after crash exits. Supervision does not rely only on `Process.terminationHandler`; it also polls process liveness and the daemon `/health` endpoint every 2 seconds, so external `kill -9`, Activity Monitor force-quit, segfaults, and OOM-style exits are detected even if the termination callback is missed.

The dev app bundle created by `script/build_and_run.sh` writes `Contents/Resources/operator-dock-daemon.json` with the daemon command and health URL. Crash recovery integration tests use this supervisor against the real Node daemon and verify task state after both supervisor-issued SIGKILL and separate `/bin/kill -9` recovery paths.
