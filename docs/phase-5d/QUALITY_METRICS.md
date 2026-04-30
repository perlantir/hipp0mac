# Phase 5D Quality Metrics

Every terminal task gets a `QualityReport`. Metrics are numbers in
`[0, 1]` or `N/A`.

## Metrics

- `stepEfficiency`: `expectedStepEstimate / actualSteps`, clamped.
  Returns `N/A` when the estimate is missing or there are no steps.
- `toolEfficiency`: correct tool calls divided by total tool calls.
  A call is correct when the related step verifier passed.
- `recoveryEfficiency`: successful recovery decisions divided by all
  recovery attempts. Returns `N/A` when there were no recoveries.
- `contextEfficiency`: used context items divided by total context
  items. Returns `N/A` when there was no context.
- `userInterruptionScore`: necessary asks divided by total asks. Zero
  asks score `1.0`.
- `redundancyScore`: `1 - repeatedStepCount / max(totalSteps, 1)`.
- `completionQuality`: fraction of success criteria and done conditions
  met with evidence. Incomplete tasks score `0`.

## Weights

Default weights:

- `completionQuality`: 0.35
- `stepEfficiency`: 0.20
- `toolEfficiency`: 0.15
- `recoveryEfficiency`: 0.10
- `contextEfficiency`: 0.10
- `redundancyScore`: 0.05
- `userInterruptionScore`: 0.05

`N/A` weights redistribute proportionally across metrics that are not
`N/A`. If every metric is `N/A`, the score is `0`.

## Worked Example

If `recoveryEfficiency` and `contextEfficiency` are `N/A`, their combined
0.20 weight is redistributed to the remaining 0.80 weight pool. A metric
with original weight 0.20 receives `0.20 / 0.80 = 0.25`.

## Persistence

Reports are emitted as `quality_report_final`, written to
`artifacts/quality_reports/<taskId>.json`, and upserted into
`quality_reports`. Completed tasks update `task_step_history` in the same
SQLite transaction as the report row.
