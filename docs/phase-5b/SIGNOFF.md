# Phase 5B Sign-Off Draft

Date: 2026-04-29<br>
Branch: `phase-5b/tool-execution-safety`<br>
PR: https://github.com/perlantir/hipp0mac/pull/1<br>
Local/CI verification commit: `fed58f1a262206f36b28e98b18302a4feaa4b9ff`

Status: `In Review`. This draft records the current implementation
checkpoint. Phase 5B is not complete until the remaining gate criteria
below have CI and manual-audit evidence.

## Gate Criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Every Phase 5A test still passes | DONE locally | `npm test` passed locally on 2026-04-29. This ran protocol build/tests, daemon build/tests, and SwiftPM macOS tests. |
| Every Phase 5B test passes in CI on three consecutive runs | DONE for current automated suite | Workflow `Phase 5B Tool Execution` passed three consecutive GitHub Actions attempts against `fed58f1a262206f36b28e98b18302a4feaa4b9ff`: [attempt 1](https://github.com/perlantir/hipp0mac/actions/runs/25139274241/attempts/1), [attempt 2](https://github.com/perlantir/hipp0mac/actions/runs/25139274241/attempts/2), [attempt 3](https://github.com/perlantir/hipp0mac/actions/runs/25139274241/attempts/3). |
| `end_to_end_with_crash` passes with at least 100 crash injection points | BLOCKED | A reusable crash hook and orphan tests exist, but the 100-point end-to-end crash harness is not yet implemented. |
| Manual idempotency audit | BLOCKED | Not yet run manually. Current automated coverage includes fs.write replay, fs.delete tombstone dedupe, pure orphan re-exec, synthesized delete result, and no-status-query block. |
| Manual safety audit | BLOCKED | Not yet run manually. Automated coverage includes 20 malicious shell inputs, fs scope denial, network scope denial, approval pause/resume/denial, and safety-before-intent event ordering. |
| Coverage for tool execution + safety + idempotency modules >= 90% | DONE locally | `npm run test:coverage -w @operator-dock/daemon` passed. `tools/runtime` coverage: 92.46% statements / 84.85% branches / 92.45% functions / 92.46% lines. Report path: `apps/daemon/coverage/index.html`. |

## Implementation Summary

- Added protocol schemas for manifests, predicates, side-effect classes,
  canonical result statuses, budgets, and starter tool shapes.
- Added manifest registry with duplicate and semantic registration
  rejection.
- Added deterministic predicate engine and Safety Governor.
- Reworked `ToolRuntime` so schema validation, safety, approvals,
  budgets, task locks, idempotency keys, intended/result event pairs,
  timeouts, cancellation, pause, and orphan reconciliation are centralized.
- Added idempotency store for fs.write/fs.delete and tombstone status
  query for fs.delete.
- Added starter `shell.exec`, `http.fetch`, and `sleep.wait` tools.
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
- `npm run test -w @operator-dock/daemon`: passed, 63 daemon tests.
- `npm run test:coverage -w @operator-dock/daemon`: passed.
- `npm test`: passed.
  - Protocol: 7 tests.
  - Daemon: 63 tests.
  - SwiftPM: 11 tests.

## CI Evidence

- Branch pushed to `origin/phase-5b/tool-execution-safety`.
- Verification commit: `fed58f1a262206f36b28e98b18302a4feaa4b9ff`.
- Workflow: `Phase 5B Tool Execution`.
- Run: https://github.com/perlantir/hipp0mac/actions/runs/25139274241.
- Consecutive passing attempts:
  - Attempt 1: https://github.com/perlantir/hipp0mac/actions/runs/25139274241/attempts/1
  - Attempt 2: https://github.com/perlantir/hipp0mac/actions/runs/25139274241/attempts/2
  - Attempt 3: https://github.com/perlantir/hipp0mac/actions/runs/25139274241/attempts/3

Earlier CI failure recorded and fixed:

- https://github.com/perlantir/hipp0mac/actions/runs/25139068498/attempts/3 failed in the existing Swift supervisor crash-recovery test because the replacement daemon could be killed by an aggressive 0.2s startup grace / single failed health check on a busy macOS runner. Commit `fed58f1a262206f36b28e98b18302a4feaa4b9ff` hardened the test configuration to allow a 2s startup grace and 3 failed health checks before respawn.

## Known Risks

- Full randomized crash harness and 10,000-call orphan soak are not yet
  implemented.
- External orphan reapproval semantics for consumed single-use approvals
  need a dedicated test and hardening pass.
- Legacy `fs.append`, `fs.copy`, and `fs.move` are manifest-registered for
  compatibility but do not yet have the same depth of idempotency coverage
  as the Phase 5B starter tools.

## Carry Forward

- Complete the remaining Phase 5B crash/soak/manual audit gate evidence
  before declaring Phase 5B done.
- Update this sign-off with PR link and three consecutive GitHub Actions
  run URLs after CI is exercised.
