# Reconciliation

An orphan is a `tool_call_intended` event without a later
`tool_call_result` whose `intendedEventId` matches it.

Reconciliation runs on daemon startup after tool registration and can
also be invoked per task by the runtime test harness. It scans the most
recent intended event for each task before allowing new work on that
task.

## Matrix

| Side-effect class | Behavior |
| --- | --- |
| `pure` | Re-execute and append a fresh intended/result pair. |
| `read` | Re-execute and append a fresh intended/result pair. |
| `write-idempotent` | Re-execute with the original idempotency key. |
| `write-non-idempotent` with status query | Query the tool. If applied, synthesize `tool_call_result`; otherwise re-execute with the original key. |
| `write-non-idempotent` without status query | Append `reconciliation_blocked`; human intervention is required. |
| `external` with status query | Same as write-non-idempotent. |
| `external` without status query | Append `reconciliation_blocked`; human intervention is required. |

## Events

Reconciliation emits:

- `orphan_reconciliation_started`
- `orphan_reconciliation_reexecute`
- `orphan_reconciliation_synthesized`
- `reconciliation_blocked`

Synthesized results include `synthesized: true` and do not invoke the tool
function.

## Current Notes

The filesystem mutation tools support status queries through durable
idempotency logs:

- `fs.append` records a per-file append log under
  `state/tool-tombstones/fs.append/`.
- `fs.copy` records tombstones at `state/tool-tombstones/fs.copy.log`.
- `fs.move` records tombstones at `state/tool-tombstones/fs.move.log`.
- `fs.delete` records tombstones in the idempotency store.

`shell.exec` is external without native idempotency/status query, so an
orphaned execution blocks instead of guessing whether a side effect
occurred. External tools with status query support must still get a fresh
approval before re-execution when the original single-use approval was
consumed by the orphaned attempt.
