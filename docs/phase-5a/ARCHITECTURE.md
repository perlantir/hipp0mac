# Phase 5A Architecture

## Invariants

- Event store records are append-only. No in-place mutation is allowed.
- Event store records are the source of truth for execution history.
- Checkpoints, task metadata, and SQLite projection rows are caches or indexes.
- Every persisted helper record carries `schemaVersion`.
- Hash chain integrity is verified on load.
- HMAC validation is mandatory before a record is trusted.
- Encryption at rest has no plaintext fallback for helper event records, checkpoints, task metadata, or memory.
- Keychain material is never logged, serialized into events, or written outside Keychain.
- A daemon without required keys fails closed.
- One runner may hold a task lock at a time.
- Stale lock reclaim requires a second read before ownership transfer.
- XPC peer validation happens before accepting a client.
- Rejected XPC connections are logged as events.
- HTTP and WebSocket daemon endpoints are loopback-only by default and bearer-token protected.
- SQLite tables that overlap with execution history are projections only.

## Process Boundary

The Swift helper is the future signed persistence daemon. It owns Phase 5A storage primitives and signing/XPC scaffolding.

The Node daemon continues to serve the Phase 0-4 local HTTP/WebSocket API. For the retrofit, it writes canonical tool-intent/result records before deriving SQLite projection rows, but the long-term authoritative event store is the Swift helper event store.

## Storage Ownership

SQLite owns user-facing metadata where no execution event exists: projects, settings, memory entries, schedules, and artifact descriptors.

Event store owns execution history: task lifecycle, tool calls, approvals, recoveries, verification, model events, and future agent loop events.

When data overlaps, event store wins. SQLite is rebuilt from events rather than used as truth.

## Security Model

The helper uses two Keychain-backed keys:

- `OperatorDock.encryption.master` for AES-256-GCM record encryption.
- `OperatorDock.signing.hmac` for HMAC-SHA256 event-chain integrity.

Both use `kSecAttrAccessibleAfterFirstUnlock`. Tests run with a mock Keychain in CI and optional real Keychain tests on macOS infrastructure.

Node HTTP/WebSocket auth uses a separate Keychain item:

- service `com.perlantir.operatordock.daemon`
- account `daemon:httpBearerToken`

The Mac app reads that token and attaches it to HTTP requests and WebSocket upgrades.

