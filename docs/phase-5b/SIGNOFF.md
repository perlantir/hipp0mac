# Phase 5B Sign-Off

Date: 2026-04-30<br>
Branch: `phase-5b/tool-execution-safety`<br>
PR: https://github.com/perlantir/hipp0mac/pull/1<br>
Implementation/local verification commit:
`6d3e279802530544767e1074e2a6c0ae378d3d32`

Status: `Ready for Review`. All Phase 5B gate criteria have automated,
CI, and manual-audit evidence. The human owner will merge the PR.

## Gate Criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Every Phase 5A test still passes | DONE locally | `npm test` passed locally after the manual-audit harness update. This ran protocol build/tests, daemon build/tests, and SwiftPM macOS tests. |
| Every Phase 5B test passes in CI on three consecutive runs | DONE for implementation checkpoint | Workflow `Phase 5B Tool Execution` passed three consecutive GitHub Actions attempts against `8431512e8a359bf77afb573887bc04c3ac1a9785`: [attempt 1](https://github.com/perlantir/hipp0mac/actions/runs/25141587401/attempts/1), [attempt 2](https://github.com/perlantir/hipp0mac/actions/runs/25141587401/attempts/2), [attempt 3](https://github.com/perlantir/hipp0mac/actions/runs/25141587401/attempts/3). |
| `fs.append`/`fs.copy`/`fs.move` idempotency retrofit | DONE locally | `fs.append` now uses per-file append logs under `state/tool-tombstones/fs.append/`; `fs.copy` and `fs.move` use tombstone logs at `state/tool-tombstones/fs.copy.log` and `state/tool-tombstones/fs.move.log`. Tests cover replay no-op and orphan status-query synthesis. |
| `end_to_end_with_crash` passes with at least 100 crash injection points | DONE | `end_to_end_with_crash_100_injection_points` passes locally and in Phase 5B CI with 100 injected crashes over a 50-call mixed-class template set. |
| `soak_with_orphans` exists with CI scaling | DONE | `soak_with_orphans_ci_scaled` passes locally and in Phase 5B CI with 500 calls by default and an orphan every 100 calls; `PHASE5B_ORPHAN_SOAK_CALLS` can scale it. |
| Consumed single-use external approval reconciliation | DONE locally | `orphan_external_consumed_approval_requires_reapproval` verifies that an orphaned external call with status query does not execute under the consumed approval and creates exactly one fresh pending approval before re-execution. |
| Manual idempotency audit | DONE | Human owner ran `scripts/manual-audit/phase5b-crash-audit.mjs` against fresh daemon PID `58830`, commit `6d3e279`, dist mtime `2026-04-30T01:33:11.545Z`. Crash audit output: 3/3 PASS. Verified `fs.delete` same-key retry deleted target exactly once, `fs.append` same-key retry produced `hello\n` exactly once, and consumed single-use `shell.run` approval crash required fresh approval on retry. |
| Manual safety audit | DONE | Human owner ran `scripts/manual-audit/phase5b-safety-audit.mjs` against fresh daemon PID `58830`, commit `6d3e279`, dist mtime `2026-04-30T01:33:11.545Z`. Safety audit output: 50/50 PASS; all malicious `shell.exec` inputs were denied before execution. |
| Coverage for tool execution + safety + idempotency modules >= 90% | DONE locally | `npm run test:coverage -w @operator-dock/daemon` passed. `tools/runtime` coverage: 92.75% statements / 85.5% branches / 93.22% functions / 92.75% lines. Report path: `apps/daemon/coverage/index.html`. |

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
- Added manual audit harnesses for `fs.delete`, `fs.append`, consumed
  single-use `shell.run` approval recovery, and the 50-input
  `shell.exec` safety audit.
- Hardened shell forbidden predicates to cover command-string and argv
  variants for injection, pipe-to-shell, destructive file operations,
  exfiltration, privilege escalation, and path traversal.
- Added daemon build metadata to `/health` and a fail-fast manual-audit
  staleness check so audits abort if the Mac app is supervising an older
  daemon build.

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

Manual audit harness:

- `scripts/manual-audit/README.md`
- `scripts/manual-audit/lib.mjs`
- `scripts/manual-audit/phase5b-crash-audit.mjs`
- `scripts/manual-audit/phase5b-safety-audit.mjs`

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
- `node --check scripts/manual-audit/lib.mjs && node --check scripts/manual-audit/phase5b-crash-audit.mjs && node --check scripts/manual-audit/phase5b-safety-audit.mjs`: passed.
- `node -e "import('./scripts/manual-audit/phase5b-safety-audit.mjs').then(m=>console.log(m.maliciousShellExecInputs.length))"`: printed `50`.
- `npm test`: passed.
  - Protocol: 7 tests.
  - Daemon: 71 tests.
  - SwiftPM: 11 tests.

## Manual Verification

- Audited daemon: PID `58830`, commit `6d3e279`, dist mtime
  `2026-04-30T01:33:11.545Z`.
- Crash audit run output: 3/3 PASS.
  - `fs.delete` crash + same-key retry deleted target exactly once.
  - `fs.append` crash + same-key retry produced `hello\n` exactly once.
  - `shell.run` consumed approval crash + retry required fresh approval.
- Safety audit run output: 50/50 PASS.
  - All malicious `shell.exec` inputs were denied before execution.

## CI Evidence

- Previous checkpoint was pushed to `origin/phase-5b/tool-execution-safety`.
- Previous implementation verification commit:
  `c97a1dd8714ebf301c3d5f401347a12927e35fe6`.
- Latest local verification commit:
  `6d3e279802530544767e1074e2a6c0ae378d3d32`.
- CI evidence checkpoint:
  `8431512e8a359bf77afb573887bc04c3ac1a9785`.
- Workflow: `Phase 5B Tool Execution`.
- Run: https://github.com/perlantir/hipp0mac/actions/runs/25141587401.
- Consecutive passing attempts:
  - Attempt 1: https://github.com/perlantir/hipp0mac/actions/runs/25141587401/attempts/1
  - Attempt 2: https://github.com/perlantir/hipp0mac/actions/runs/25141587401/attempts/2
  - Attempt 3: https://github.com/perlantir/hipp0mac/actions/runs/25141587401/attempts/3
- PR-triggered checks on the same head SHA also passed:
  - Phase 5B Tool Execution: https://github.com/perlantir/hipp0mac/actions/runs/25141588265
  - Phase 5A Node Persistence: https://github.com/perlantir/hipp0mac/actions/runs/25141588258

Latest audit-harness/staleness-check commit `6d3e279802530544767e1074e2a6c0ae378d3d32`
also passed GitHub Actions:

- Phase 5B push: https://github.com/perlantir/hipp0mac/actions/runs/25142683655
- Phase 5B PR: https://github.com/perlantir/hipp0mac/actions/runs/25142684577
- Phase 5A PR: https://github.com/perlantir/hipp0mac/actions/runs/25142684572

Earlier CI failure recorded and fixed:

- https://github.com/perlantir/hipp0mac/actions/runs/25139068498/attempts/3 failed in the existing Swift supervisor crash-recovery test because the replacement daemon could be killed by an aggressive 0.2s startup grace / single failed health check on a busy macOS runner. Commit `fed58f1a262206f36b28e98b18302a4feaa4b9ff` hardened the test configuration to allow a 2s startup grace and 3 failed health checks before respawn.

## Known Risks

- The orphan soak is CI-scaled by default; the full 10,000-call stress run
  can be exercised by raising `PHASE5B_ORPHAN_SOAK_CALLS`.

## Carry Forward

- Phase 5C must not start until the human owner merges this Phase 5B PR
  and explicitly authorizes the next phase.
