# Phase 5B Sign-Off Draft

Date: 2026-04-29<br>
Branch: `phase-5b/tool-execution-safety`<br>
PR: https://github.com/perlantir/hipp0mac/pull/1<br>
Local verification: pending new commit for fs retrofit / crash harness work

Status: `In Review`. This draft records the current implementation
checkpoint. Phase 5B is not complete until the remaining gate criteria
below have CI and manual-audit evidence. The PR remains Draft.

## Gate Criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Every Phase 5A test still passes | DONE locally | `npm test` passed locally on 2026-04-29. This ran protocol build/tests, daemon build/tests, and SwiftPM macOS tests. |
| Every Phase 5B test passes in CI on three consecutive runs | PENDING new tip | Previous checkpoint passed three CI attempts against `fed58f1a262206f36b28e98b18302a4feaa4b9ff`; new fs retrofit/crash harness commit still needs three consecutive GitHub Actions passes. |
| `fs.append`/`fs.copy`/`fs.move` idempotency retrofit | DONE locally | `fs.append` now uses per-file append logs under `state/tool-tombstones/fs.append/`; `fs.copy` and `fs.move` use tombstone logs at `state/tool-tombstones/fs.copy.log` and `state/tool-tombstones/fs.move.log`. Tests cover replay no-op and orphan status-query synthesis. |
| `end_to_end_with_crash` passes with at least 100 crash injection points | DONE locally | `end_to_end_with_crash_100_injection_points` passes locally with 100 injected crashes over a 50-call mixed-class template set. CI evidence pending. |
| `soak_with_orphans` exists with CI scaling | DONE locally | `soak_with_orphans_ci_scaled` passes locally with 500 calls by default and an orphan every 100 calls; `PHASE5B_ORPHAN_SOAK_CALLS` can scale it. CI evidence pending. |
| Consumed single-use external approval reconciliation | DONE locally | `orphan_external_consumed_approval_requires_reapproval` verifies that an orphaned external call with status query does not execute under the consumed approval and creates exactly one fresh pending approval before re-execution. |
| Manual idempotency audit | BLOCKED | Human owner will manually induce crashes during `fs.delete` and `fs.append` and verify zero double effects before merge. |
| Manual safety audit | BLOCKED | Not yet run manually. Automated coverage includes 20 malicious shell inputs, fs scope denial, network scope denial, approval pause/resume/denial, and safety-before-intent event ordering. |
| Coverage for tool execution + safety + idempotency modules >= 90% | DONE locally | `npm run test:coverage -w @operator-dock/daemon` passed. `tools/runtime` coverage: 92.5% statements / 85.16% branches / 93.22% functions / 92.5% lines. Report path: `apps/daemon/coverage/index.html`. |

## Implementation Summary

- Added protocol schemas for manifests, predicates, side-effect classes,
  canonical result statuses, budgets, and starter tool shapes.
- Added manifest registry with duplicate and semantic registration
  rejection.
- Added deterministic predicate engine and Safety Governor.
- Reworked `ToolRuntime` so schema validation, safety, approvals,
  budgets, task locks, idempotency keys, intended/result event pairs,
  timeouts, cancellation, pause, and orphan reconciliation are centralized.
- Added idempotency store support for prepared/applied file mutation
  records, per-file `fs.append` append logs, and `fs.copy`/`fs.move`
  tombstone logs.
- Added starter `shell.exec`, `http.fetch`, and `sleep.wait` tools.
- Hardened orphan reconciliation so consumed single-use external approvals
  require fresh approval before re-execution.
- Added Phase 5B docs for adding tools, predicates, and reconciliation.

## Files Changed

Protocol:

- `packages/protocol/src/index.ts`

Daemon execution:

- `apps/daemon/src/tools/runtime/*`
- `apps/daemon/src/tools/fs/*`
- `apps/daemon/src/tools/shell/shellTools.ts`
- `apps/daemon/src/tools/http/httpFetchTool.ts`
- `apps/daemon/src/tools/sleep/sleepWaitTool.ts`
- `apps/daemon/src/server.ts`
- `apps/daemon/src/workspace/pathSafety.ts`

Persistence/config:

- `apps/daemon/src/persistence/eventStore.ts`
- `apps/daemon/src/persistence/paths.ts`
- `apps/daemon/migrations/004_phase5b_task_statuses.sql`
- `apps/daemon/vitest.config.ts`

Tests:

- `apps/daemon/test/phase5bToolExecution.test.ts`
- `apps/daemon/test/toolRuntime.test.ts`
- `apps/daemon/test/workspace.test.ts`

Docs:

- `docs/architecture.md`
- `docs/phase-5b/HOW_TO_ADD_A_TOOL.md`
- `docs/phase-5b/SAFETY_PREDICATES.md`
- `docs/phase-5b/RECONCILIATION.md`
- `docs/phase-5b/SIGNOFF.md`

## Local Test Results

- `npm run typecheck`: passed.
- `npm run test -w @operator-dock/daemon -- phase5bToolExecution.test.ts`: passed, 30 Phase 5B tests.
- `npm run test -w @operator-dock/daemon`: passed, 71 daemon tests.
- `npm run test:coverage -w @operator-dock/daemon`: passed.
- `npm test`: passed.
  - Protocol: 7 tests.
  - Daemon: 71 tests.
  - SwiftPM: 11 tests.

## CI Evidence

- Previous checkpoint was pushed to `origin/phase-5b/tool-execution-safety`.
- Previous verification commit: `fed58f1a262206f36b28e98b18302a4feaa4b9ff`.
- Previous workflow: `Phase 5B Tool Execution`.
- Previous run: https://github.com/perlantir/hipp0mac/actions/runs/25139274241.
- Previous consecutive passing attempts:
  - Attempt 1: https://github.com/perlantir/hipp0mac/actions/runs/25139274241/attempts/1
  - Attempt 2: https://github.com/perlantir/hipp0mac/actions/runs/25139274241/attempts/2
  - Attempt 3: https://github.com/perlantir/hipp0mac/actions/runs/25139274241/attempts/3

New fs retrofit / crash harness commit still needs three consecutive CI
passes on GitHub Actions after it is pushed.

Earlier CI failure recorded and fixed:

- https://github.com/perlantir/hipp0mac/actions/runs/25139068498/attempts/3 failed in the existing Swift supervisor crash-recovery test because the replacement daemon could be killed by an aggressive 0.2s startup grace / single failed health check on a busy macOS runner. Commit `fed58f1a262206f36b28e98b18302a4feaa4b9ff` hardened the test configuration to allow a 2s startup grace and 3 failed health checks before respawn.

## Known Risks

- Manual idempotency and safety audits are still pending human execution.
- The orphan soak is CI-scaled by default; the full 10,000-call stress run
  can be exercised by raising `PHASE5B_ORPHAN_SOAK_CALLS`.

## Carry Forward

- Complete the three consecutive CI runs on the new branch tip.
- Human owner to complete manual idempotency and safety audit evidence
  before declaring Phase 5B done.
- Keep CI evidence refreshed if additional implementation commits are added
  before human review.
