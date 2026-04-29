# Phase 5A Sign-Off

Date: 2026-04-29<br>
Branch: `phase-5a/node-persistence`<br>
Implementation verification commit: `718e16054b33b24074f185a7217579a981585a2f`

Note: this sign-off document was updated after the three GitHub Actions attempts completed so it could record their immutable URLs. The linked attempts verify the pushed implementation commit above.

## Scope Decision

Swift helper work was preserved on `exploration/swift-helper` and is not part of this Phase 5A implementation. The Node daemon owns persistence, keys, event store, checkpoints, locks, SQLite, and runtime lock enforcement.

## Gate Criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Every test passes in CI on three consecutive runs | Passed in GitHub Actions | Workflow `Phase 5A Node Persistence` passed three consecutive GitHub Actions attempts against pushed commit `718e16054b33b24074f185a7217579a981585a2f`: [attempt 1](https://github.com/perlantir/hipp0mac/actions/runs/25137242439/attempts/1), [attempt 2](https://github.com/perlantir/hipp0mac/actions/runs/25137242439/attempts/2), [attempt 3](https://github.com/perlantir/hipp0mac/actions/runs/25137242439/attempts/3). Each attempt ran install, `npm run typecheck`, `npm test`, and `npm run test:coverage -w @operator-dock/daemon` on GitHub macOS CI. |
| Manual crash test | Passed | No LaunchAgent was added. The Mac app now owns minimal subprocess supervision: spawn on launch, termination callback as fast path, process liveness + `/health` watchdog every 2 seconds, and respawn after crash. `swift test --package-path apps/mac --filter DaemonSupervisorTests` starts the real Node daemon, creates a task, verifies supervisor-issued SIGKILL recovery, verifies separate `/bin/kill -9` recovery, waits for `/health`, and verifies the task still lists after recovery. Manual app verification also passed on the final code: daemon PID `79307` was killed from an external shell with `/bin/kill -9`; after 5 seconds `pgrep -fl 'apps/daemon/dist/index.js'` showed replacement PID `79484`. |
| Manual security audit | Passed for Node implementation | Tests assert raw event logs contain no plaintext payloads, SQLCipher DB pages do not contain task needles, wrong SQLite key fails, and Fastify logs redact synthetic API keys/tokens. |
| Schema migration framework v0 -> v1 | Passed | `apps/daemon/test/persistence.test.ts` covers synthetic `v0 -> v1`, idempotent migration output, and `schema_migration_applied` event emission. |
| Persistence/concurrency coverage >= 90% | Passed in local and GitHub Actions runs | `npm run test:coverage -w @operator-dock/daemon` reports 91.21% statements / 91.21% lines for `apps/daemon/src/persistence/**/*.ts` locally. The same coverage command passed in all three GitHub Actions attempts linked above. Local report path: `apps/daemon/coverage/index.html`. |

## Test Evidence

### GitHub Actions

- Branch pushed to `origin/phase-5a/node-persistence`.
- Verification commit: `718e16054b33b24074f185a7217579a981585a2f`.
- Workflow: `Phase 5A Node Persistence`.
- Run: https://github.com/perlantir/hipp0mac/actions/runs/25137242439.
- Consecutive passing attempts:
  - Attempt 1: https://github.com/perlantir/hipp0mac/actions/runs/25137242439/attempts/1
  - Attempt 2: https://github.com/perlantir/hipp0mac/actions/runs/25137242439/attempts/2
  - Attempt 3: https://github.com/perlantir/hipp0mac/actions/runs/25137242439/attempts/3
- Each attempt passed:
  - `npm run typecheck`
  - `npm test`
  - `npm run test:coverage -w @operator-dock/daemon`

Earlier CI failures are recorded and fixed:

- https://github.com/perlantir/hipp0mac/actions/runs/25136840645 failed because the initial workflow used `macos-14`, whose Swift 5.10 toolchain could not build the Swift tools 6 package. Commit `9c0c50fd652be093c2fff30028f5e8b25cf8c413` moved Phase 5A CI to `macos-15`.
- https://github.com/perlantir/hipp0mac/actions/runs/25136882182 failed because GitHub's Swift toolchain rejected `Swift.Task`. Commit `d08c92251b60c39452682eec44a21ff147551e8d` changed this to `_Concurrency.Task`.
- https://github.com/perlantir/hipp0mac/actions/runs/25137158681 failed because the real-daemon supervisor test used a 5-second health wait that was too tight on a fresh GitHub runner. Commit `718e16054b33b24074f185a7217579a981585a2f` hardened the readiness wait and failure reporting.

### Local Verification

Latest local verification before pushing:

- `npm run typecheck`: passed.
- `npm test`: passed.
  - Protocol: 7 tests passed.
  - Daemon: 41 tests passed.
- SwiftPM: 11 tests passed.
- Supervisor crash recovery: `DaemonSupervisorTests` passed against the real Node daemon for both internal crash and detached external-kill paths.
- `npm run test:coverage -w @operator-dock/daemon`: passed.
  - Persistence coverage: 91.21% statements, 85.54% branches, 97.4% functions, 91.21% lines.
- Manual app-level external kill verification: app PID `79187` supervised daemon PID `79307`; `/bin/kill -9 79307` was issued from a separate shell; after 5 seconds `pgrep -fl 'apps/daemon/dist/index.js'` showed replacement daemon PID `79484`.

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
