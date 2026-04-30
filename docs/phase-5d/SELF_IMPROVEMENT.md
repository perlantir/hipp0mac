# Phase 5D Self-Improvement Hook

Phase 5D self-improvement is analysis only. It never modifies production
code, prompts, predicates, manifests, or provider settings.

## Analysis

For below-threshold or failed tasks, the analyzer:

1. Finds dominant `recovery_decision` failure types.
2. Maps the dominant failure to a root cause.
3. Keeps or generates structured `recommendedFixes`.
4. Ensures every recommended fix references resolvable event evidence.

## Root Causes

- `planning`
- `tool_misuse`
- `context`
- `verifier`
- `recovery`
- `safety`
- `unnecessary_steps`
- `unnecessary_user_interruption`
- `injection`
- `model_output`
- `unknown`

## Recommended Fixes

Each fix includes:

- `targetComponent`
- `changeType`
- `rationale`
- `evidenceRefs`

Fixes are stored inside the `QualityReport`, emitted in
`quality_report_final`, and persisted to SQLite/artifacts.
