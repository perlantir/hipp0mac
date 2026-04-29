# Phase 5A Architecture

## Shipping Boundary

Phase 5A is Node-daemon-owned persistence. The preserved Swift helper work lives on `exploration/swift-helper` only and is not part of the shipping architecture.

## Invariants

- The Node daemon is the sole writer for canonical Phase 5A event store, checkpoint, lock, task metadata, and SQLite state.
- Event store records are append-only and encrypted before they touch disk.
- Event store HMAC and hash-chain verification is mandatory before trusting task history.
- Checkpoints are never authoritative.
- SQLite is encrypted at rest and is a metadata/projection store, not the source of truth for execution history.
- Every new tool execution acquires a task lock before `tool_call_intended`.
- Every completed tool execution writes `tool_call_result` before SQLite projection fields are updated.
- HTTP and WebSocket access requires the daemon bearer token.
- Daemon network binding is loopback-only unless explicitly enabled.
- Secrets must not be written to events, logs, raw tool output, or SQLite projection payloads.

## Data Flow

```text
Mac app
  -> localhost HTTP/WebSocket with bearer token
  -> supervises Node daemon subprocess while app is running
Node daemon
  -> Keychain persistence keys
  -> SQLCipher SQLite metadata/projections
  -> encrypted event-store task logs
  -> encrypted checkpoints
  -> durable lock files
```

## Supervision

The Mac app owns minimal daemon supervision for Phase 5A:

- Spawn the configured Node daemon subprocess when the app launches.
- Watch for process termination as a fast signal.
- Poll the daemon every 2 seconds using process liveness plus `/health`.
- Respawn when either the process is gone or health checks fail.
- Stop the child process when the app terminates.

No LaunchAgent is installed in Phase 5A. Running the daemon while the app is closed is a later scheduled-tasks product decision.

## Tool Execution Ordering

For a normal tool call:

```text
lock_acquired
tool_call_intended
tool.started / tool.output / tool.completed projection events
tool_call_result
lock_released
```

The WebSocket stream remains UI-friendly. Canonical event store events remain strict and replayable.
