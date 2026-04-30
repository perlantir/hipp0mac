# Phase 5D Failure Taxonomy

Phase 5D classifies every recovery-triggering failure before selecting a
strategy. Known failures emit `recovery_classification`; unknown failures
emit `recovery_classification_miss` and are treated as defects.

## Failure Types

- `validation_error`: tool input/output schema invalid.
- `tool_failure`: tool returned an error status.
- `no_effect`: tool succeeded but the expected change was absent.
- `context_loss`: required context was missing or compacted away.
- `model_error`: model output or provider failed.
- `auth_required`: credentials or auth are missing.
- `timeout`: operation exceeded timeout policy.
- `safety_block`: Safety Governor denied the action.
- `injection_detected`: prompt-injection detector triggered.
- `repeated_step_loop`: more than two consecutive identical step
  signatures without a replan.
- `no_progress_loop`: configured step window without evidence,
  artifacts, or satisfied criteria.
- `low_quality_path`: verifier quality concerns fell below threshold.
- `excessive_user_interruption`: user ask budget was exceeded.
- `schema_version_mismatch`: event record schema is newer than the
  daemon understands.
- `verifier_disagreement`: double verification disagreed.
- `unknown`: classifier could not determine a known type.

## Invariants

- Classification happens before recovery strategy selection.
- `unknown` never silently continues; it emits
  `recovery_classification_miss`.
- Safety and injection failures never retry the same dangerous call.
- Replay continues to derive state only from events; it does not invoke
  models or tools.
