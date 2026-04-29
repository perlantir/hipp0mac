# Phase 5A Sign-Off

Date: 2026-04-29
Branch: `phase-5a/persistence-retrofit`
Implementation commit with three passing CI runs: `a6efba7c3f11afefe9e3b7515370ad82ca13e15b`

## Gate Criteria

1. Every test above passes in CI on three consecutive runs

Status: passed for commit `a6efba7c3f11afefe9e3b7515370ad82ca13e15b`.

Evidence:

- CI run 1: https://github.com/perlantir/hipp0mac/actions/runs/25132789140
- CI run 2: https://github.com/perlantir/hipp0mac/actions/runs/25132794326
- CI run 3: https://github.com/perlantir/hipp0mac/actions/runs/25132800792
- All three completed with success and ran `npm run typecheck`, `npm test`, and helper coverage.

Notes:

- Earlier CI attempts failed on previous commits because clean CI exposed missing workspace build outputs before daemon typecheck, then a macOS Swift portability issue around `Swift.Task`. Both were fixed before the three counted runs.

2. Manual crash test passes

Status: blocked.

Evidence available:

- `EventStoreTests.testCrashMidAppendNoPartialRecord`
- `EventStoreTests.testPowerLossSimulationTruncatesCleanly`
- `Phase5AIntegrationTests.testFullLifecycleSmokeReconstructsByteIdenticalStateAfterRestart`
- `Phase5AIntegrationTests.testDaemonRelaunchesAfterCrashWhenEnabled` exists and is explicitly blocked until `OPERATOR_DOCK_RUN_LAUNCHD_CRASH_TESTS=1` and a signed long-running helper fixture are available.

Blocker:

- The signed launchd-managed helper fixture needed for a true SIGKILL daemon mid-write manual test is not configured yet. This is signing/infrastructure setup, not application code.

3. Manual security audit passes

Status: blocked.

Passed evidence:

- Raw event store ciphertext check: `EventStoreTests.testEventStoreCiphertextContainsNoPlaintextPayloadFields`
- Missing key fails closed: `FoundationSecurityTests.testMissingKeyFailsClosedWhenKeychainUnavailable`
- Log secret audit: `Phase5AIntegrationTests.testNoSecretsInLogsAuditDetectsCleanRun`
- Mock unsigned XPC rejection: `XPCSecurityTests.testUnsignedClientRejectedEmitsEvent`
- HTTP/WS auth and host safety: daemon tests cover missing bearer token, wrong token, WebSocket missing token, and bad host rejection.

Blocker:

- Real signed/unsigned binary XPC tests require signing identity setup and audit-token fixtures. The conditional tests exist and are explicitly blocked until `OPERATOR_DOCK_RUN_SIGNED_BINARY_TESTS=1` with signed and unsigned client audit token fixtures.

4. Schema migration framework runs end-to-end on the v0 to v1 fixture

Status: passed.

Evidence:

- `SchemaMigrationTests.testV0ToV1MigrationFixtureLoadsAndEmitsAuditEvent`
- `SchemaMigrationTests.testMigrationIdempotent`
- `SchemaMigrationTests.testUnknownFutureVersionHardErrors`
- `SchemaMigrationTests.testEventStoreMigrationAuditSinkEmitsSchemaMigrationAppliedEvent`

5. Coverage for persistence and concurrency modules is at least 90 percent

Status: passed.

Evidence:

- Coverage report: `docs/phase-5a/coverage-report.txt`
- Latest helper source line coverage: `90.10%`
- Command used:

```bash
swift test --package-path apps/helper --enable-code-coverage
xcrun llvm-cov report apps/helper/.build/debug/OperatorDockHelperPackageTests.xctest/Contents/MacOS/OperatorDockHelperPackageTests -instr-profile apps/helper/.build/debug/codecov/default.profdata -ignore-filename-regex='Tests|main.swift'
```

## Local Verification

Passed:

- `npm run typecheck`
- `npm test` three consecutive local runs on 2026-04-29
- `swift test --package-path apps/mac`
- `swift test --package-path apps/helper --enable-code-coverage`

Current counted local suite totals:

- Protocol: 7 tests
- Daemon: 28 tests
- Mac app package: 8 tests
- Helper package: 68 executed, 5 explicitly blocked/skipped infrastructure tests

## Audit Corrections

HTTP/WS auth:

- Passed. Bearer token auth is required for HTTP requests and WebSocket upgrades.
- Passed. `OPERATOR_DOCK_HOST` rejects non-loopback binding by default.

State layout:

- Passed. Swift helper and Node daemon state moved to `~/Library/Application Support/OperatorDock/state/`.
- Passed. Node migrates `~/.operator-dock` once and writes `.migrated-from-v0`.
- Passed. Swift helper migrates the previous direct Application Support layout once and writes `.migrated-from-v0`.

SQLite versus event store:

- Passed. Existing `tool_executions`, `tool_events`, and `file_operation_logs` rows are marked `legacy=1`.
- Passed. Existing legacy rows emit one `legacy_data_present` daemon event.
- Passed. New tool executions append `tool_call_intended` before SQLite projection insertion and `tool_call_result` before terminal projection update.
- Partial. Execution-derived SQLite values are field-encrypted with AES-256-GCM envelopes. Full SQLCipher page encryption is not implemented because the current Node built-in SQLite driver does not provide SQLCipher. This is documented in `RETROFIT_NOTES.md`.

Redaction:

- Passed. Fastify logging uses a redacting stream.
- Passed. `apps/daemon/src` has no direct `console.log` or raw Pino logger path.
- Passed. Fastify error logging test verifies fake secrets are redacted.

## Deviations

- Full SQLite database page encryption is not implemented. The retrofit encrypts execution-derived projection fields instead. Rationale: Node's built-in `node:sqlite` does not expose SQLCipher. Question that should have been asked before implementation: "Should we add a SQLCipher-capable SQLite dependency now, or accept field-level projection encryption until the helper owns projections?"
- CI workflow uses `actions/checkout@v4` and `actions/setup-node@v4`, which currently emit GitHub's Node.js 20 action deprecation warning. The warning does not fail the run.

## Carry Forward

Phase 5A blockers before declaring the full gate complete:

- Configure signing identity and signed/unsigned client fixtures.
- Run the signed XPC tests with `OPERATOR_DOCK_RUN_SIGNED_BINARY_TESTS=1`.
- Configure a signed long-running launchd helper fixture.
- Run the manual SIGKILL daemon mid-write crash test.
- Decide whether to introduce SQLCipher or move SQLite projections fully behind the Swift helper.

Phase 5B:

- Tool manifests for every tool.
- Idempotency keys and tombstones for write/external tools.
- Canonical `tool_call_intended` / `tool_call_result` as the internal event pair for all tools.
- Predicate AST Safety Governor.
- Canonical `safety_decision`, `approval_granted`, and `approval_denied` events.

Phase 5C:

- `promptVersion` and `modelVersion` recording.
- Deterministic fixture-driven mock provider.
- Provider fallback chains for retryable errors.
- Streaming cancellation hardening.

Phase 5E:

- Persistent approval scope and expiry.
- Deterministic UI event projections from canonical event store records.
- Observability joins across event store and SQLite projections.

