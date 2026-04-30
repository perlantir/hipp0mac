# Phase 5D Recovery Strategies

Recovery strategy selection is deterministic. The manager walks the
configured chain for a failure type and advances when a retry cap is hit.

## Strategy Chains

| Failure type | Chain |
| --- | --- |
| `validation_error` | `retry_modified_input` -> `switch_tool` -> `fail_gracefully` |
| `tool_failure` | `retry_same_tool` -> `retry_modified_input` -> `switch_tool` |
| `no_effect` | `re_evaluate_context` -> `replan_subgraph` |
| `context_loss` | `re_evaluate_context` -> `replan_subgraph` |
| `model_error` | `retry_same_tool` -> `fail_gracefully` |
| `auth_required` | `ask_user` |
| `timeout` | `retry_modified_input` -> `switch_tool` |
| `safety_block` | `replan_subgraph` |
| `injection_detected` | `stop_for_safety` |
| `repeated_step_loop` | `replan_subgraph` |
| `no_progress_loop` | `replan_subgraph` -> `ask_user` |
| `low_quality_path` | `replan_subgraph` |
| `excessive_user_interruption` | `fail_gracefully` |
| `schema_version_mismatch` | `fail_gracefully` |
| `verifier_disagreement` | `re_evaluate_context` -> `replan_subgraph` |
| `unknown` | `fail_gracefully` |

## Retry Caps

- `retry_same_tool`: 2 per step.
- `retry_modified_input`: 2 per step.
- `switch_tool`: 2 per step.
- `re_evaluate_context`: 1 per step.
- `replan_subgraph`: 3 per task.
- `ask_user`: user interruption budget.

Each decision emits `recovery_decision` with the chosen strategy,
retry count, cap state, escalation state, and rationale.

## Effectiveness

`strategy_effectiveness` stores success and total counts per
`(failureType, strategy)`. Updates are SQLite transactions, so a crash
cannot leave partial counters.
