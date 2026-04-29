# Phase 5A Sign-Off

Date: 2026-04-29  
Branch: `phase-5a/node-persistence`

## Scope Decision

Swift helper work was preserved on `exploration/swift-helper` and is not part of this Phase 5A implementation. The Node daemon owns persistence, keys, event store, checkpoints, locks, SQLite, and runtime lock enforcement.

## Gate Criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Every test passes in CI on three consecutive runs | Passed locally / CI workflow added | Three consecutive final local CI-equivalent runs completed after adding watchdog supervision: `bash -n script/build_and_run.sh && npm run typecheck && npm test && npm run test:coverage -w @operator-dock/daemon`. Each run passed protocol tests, daemon tests, SwiftPM tests, supervisor crash recovery, detached external-kill recovery, and coverage. Workflow added at `.github/workflows/phase5a-node.yml` for GitHub macOS/Node 24 execution after push. |
| Manual crash test | Passed | No LaunchAgent was added. The Mac app now owns minimal subprocess supervision: spawn on launch, termination callback as fast path, process liveness + `/health` watchdog every 2 seconds, and respawn after crash. `swift test --package-path apps/mac --filter DaemonSupervisorTests` starts the real Node daemon, creates a task, verifies supervisor-issued SIGKILL recovery, verifies separate `/bin/kill -9` recovery, waits for `/health`, and verifies the task still lists after recovery. Manual app verification also passed on the final code: daemon PID `79307` was killed from an external shell with `/bin/kill -9`; after 5 seconds `pgrep -fl 'apps/daemon/dist/index.js'` showed replacement PID `79484`. |
| Manual security audit | Passed for Node implementation | Tests assert raw event logs contain no plaintext payloads, SQLCipher DB pages do not contain task needles, wrong SQLite key fails, and Fastify logs redact synthetic API keys/tokens. |
| Schema migration framework v0 -> v1 | Passed | `apps/daemon/test/persistence.test.ts` covers synthetic `v0 -> v1`, idempotent migration output, and `schema_migration_applied` event emission. |
| Persistence/concurrency coverage >= 90% | Passed | `npm run test:coverage -w @operator-dock/daemon` reports 91.21% statements / 91.21% lines for `apps/daemon/src/persistence/**/*.ts`. Report path: `apps/daemon/coverage/index.html`. |

## Test Evidence

Latest local run:

- `npm run typecheck`: passed.
- `npm test`: passed.
  - Protocol: 7 tests passed.
  - Daemon: 41 tests passed.
- SwiftPM: 11 tests passed.
- Supervisor crash recovery: `DaemonSupervisorTests` passed against the real Node daemon for both internal crash and detached external-kill paths.
- `npm run test:coverage -w @operator-dock/daemon`: passed.
  - Persistence coverage: 91.21% statements, 85.54% branches, 97.4% functions, 91.21% lines.

## Phase 5A Corrections Included

- HTTP and WebSocket bearer auth.
- Host validation rejecting anything other than `127.0.0.1` or `::1` unless explicitly enabled.
- Default daemon state moved to `~/Library/Application Support/OperatorDock/state/`.
- One-time state layout migration from `~/.operator-dock`.
- SQLCipher-compatible SQLite page encryption.
- Plaintext SQLite migration into encrypted database files.
- Encrypted AES-256-GCM record codec for event store, checkpoints, and task metadata.
- HMAC-SHA256 event integrity and hash-chain verification.
- Durable task lock controller with stale-lock reclaim.
- Node tool runtime lock acquisition before `tool_call_intended`.
- Canonical `tool_call_intended` / `tool_call_result` events with SQLite projection fields.
- Legacy Phase 3-4 projection rows marked with `legacy = 1`.
- Redacted Fastify logging and secret-safe raw tool output.
- Swift Mac client now attaches the daemon bearer token from Keychain for HTTP/WebSocket calls.
- Swift Mac app now starts and supervises the configured Node daemon subprocess with termination-handler and watchdog health/liveness recovery, without adding a LaunchAgent.

## Deviations

- Production Keychain access class enforcement is represented in the Node abstraction and unit harness. The current production Node implementation uses the macOS `security` CLI, matching the existing daemon credential pattern, but the CLI does not expose `kSecAttrAccessibleAfterFirstUnlock`. A native Security framework bridge or addon is needed to enforce that attribute from Node without reintroducing the Swift helper.
- LaunchAgent supervision is deliberately not implemented in Phase 5A. Mac-app supervision covers app-open durability now; daemon-while-app-closed scheduling remains a later product decision.

## Carry Forward

- Phase 5B: tool manifests, idempotency keys, canonical safety decision events, and projection tests.
- Phase 5C: ModelRouter prompt/model version recording, deterministic mock fixtures, fallback chains, and stream cancellation hardening.
- Phase 5E: persistent approval event representation and deterministic UI projection observability.
