# Phase 5D: Recovery + Quality + Self-Improvement (TypeScript / Node)

This is the fourth of five sub-phases. It transforms a working agent into
one that's measurably efficient, recovers intelligently from failure, and
produces actionable analysis when it underperforms.

Do not begin until Phase 5C's gate is fully satisfied.

This phase is largely platform-agnostic: the recovery, quality scoring,
and self-improvement logic is pure code that doesn't care whether the
daemon is Node or Swift. The previous version of this spec is
substantially correct; the changes here are integration points (uses
Phase 5A event store, Phase 5B safety governor, Phase 5C verifiers and
ModelRouter).

==================================================
GOAL
==================================================

Add the systems that separate "agent that works" from "agent worth
shipping":

- Recovery Manager with full failure taxonomy and strategy enforcement
- Loop / no-progress / redundancy detection
- Behavioral Quality System with all metrics and N/A handling
- expectedStepEstimate sourcing (full implementation, including
  historical from accumulated traces)
- QualityAuditor producing the QualityReport
- Final Output Contract assembly
- Eval mode with strict thresholds
- Self-Improvement Hook (analysis only, no auto-modify)

End state: every task ends with a structured quality report. Failed
tasks produce structured root cause + recommended fixes. Eval mode
reliably fails low-quality technically-passing behavior.

==================================================
RECOVERY MANAGER
==================================================

Failure types (full taxonomy):

- validation_error           tool input/output schema invalid
- tool_failure               tool returned status = error
- no_effect                  tool succeeded but expected change
                             absent
- context_loss               required context missing or compacted
                             away
- model_error                model invalid output 2x, or provider
                             classifies as error
- auth_required              tool needs auth not yet provided
- timeout                    tool exceeded timeoutPolicy
- safety_block               Safety Governor denied
- injection_detected         injection detector triggered
- repeated_step_loop         > 2 near-identical consecutive steps
- no_progress_loop           N steps without measurable progress
- low_quality_path           verifier flagged qualityConcerns +
                             below threshold
- excessive_user_interruption ratio of user.ask above threshold
- schema_version_mismatch    record version exceeds known max
- verifier_disagreement      double verification mismatch
- unknown                    classifier could not determine

Every failure is classified before recovery selects a strategy. An
unclassified failure is itself a defect — emit a
recovery_classification_miss event so it surfaces in metrics.

Strategies:

- retry_same_tool             same tool, same input
- retry_modified_input        same tool, modified input
- switch_tool                 different tool for same intent
- re_evaluate_context         compact and rebuild context, retry
- replan_subgraph             revise affected DAG nodes
- ask_user                    intervention requested
- fail_gracefully             mark step failed, surface in output
- stop_for_safety             halt task; never auto-retry

Strategy selection (deterministic, by failure type):

  validation_error          → retry_modified_input → switch_tool
                              → fail_gracefully
  tool_failure              → retry_same_tool → retry_modified_input
                              → switch_tool
  no_effect                 → re_evaluate_context → replan_subgraph
  context_loss              → re_evaluate_context → replan_subgraph
  model_error               → retry_same_tool (with model fallback)
                              → fail_gracefully
  auth_required             → ask_user
  timeout                   → retry_modified_input (smaller scope)
                              → switch_tool
  safety_block              → replan_subgraph (NEVER auto-retry same
                              call)
  injection_detected        → stop_for_safety
  repeated_step_loop        → replan_subgraph
  no_progress_loop          → replan_subgraph → ask_user
  low_quality_path          → replan_subgraph
  excessive_user_interruption → fail_gracefully (don't ask more)
  schema_version_mismatch   → fail_gracefully (hard error path)
  verifier_disagreement     → re_evaluate_context → replan_subgraph
  unknown                   → fail_gracefully

Retry caps (per (stepId, strategy) pair):
- retry_same_tool: 2
- retry_modified_input: 2
- switch_tool: 2
- re_evaluate_context: 1
- replan_subgraph: 3 per task lifetime
- ask_user: bounded by user interruption budget

When a strategy's cap is hit, advance to the next strategy in the
chain. When all strategies exhausted, escalate to ask_user (if
budget allows) or fail_gracefully.

Recovery decision events:

  recovery_decision {
    failureType,
    classifiedReason,
    strategy,
    retryCount,
    capReached: boolean,
    nextStepOverride: stepId | null,
    escalationRequired: boolean,
    rationale
  }

Strategy effectiveness tracking:
- For each (failureType, strategy) pair, accumulate success / total
  across all tasks
- Stored in SQLite (extended schema): strategy_effectiveness table
- Used by quality scoring + future strategy ordering tuning
- Atomic update via transaction; crash-safe

==================================================
LOOP / NO-PROGRESS / REDUNDANCY DETECTION
==================================================

Repeated step loop:
- Trigger: > 2 consecutive steps with similarity > threshold to a
  previous step in the same task, no intervening replan
- Similarity computed over normalized (selectedTool, toolInput,
  intent) — exact match in Phase 5D; embedding-based optional in 5E+
- Triggers repeated_step_loop failure → replan_subgraph

No-progress loop:
- Trigger: N steps (configurable, default 5) without any of:
    - new evidence accumulated for a doneCondition
    - new artifact produced
    - successCriterion newly satisfied
- Triggers no_progress_loop failure

Redundancy (non-failing, scored only):
- Detected per step: identical or near-identical to any prior step
- Counted in repeatedStepCount metric
- Does not by itself trigger recovery (only consecutive repeats do)

All three checks run after every step_verification event.

==================================================
EXPECTED STEP ESTIMATE — FULL IMPLEMENTATION
==================================================

Sources, in priority order:

1. Historical average:
   - SQLite table: task_step_history (taskType, mean, stddev,
     sampleCount)
   - Updated after every completed task (in transaction with
     QualityReport persistence)
   - Used only when sampleCount >= 10
   - Encrypted at rest (per Phase 5A)

2. Eval benchmark norm:
   - Static map of taskType → expected steps from eval suite
   - Loaded from config

3. Heuristic estimator:
   - Rule-based on task signals (number of doneConditions,
     declared expectedArtifacts, taskGoal length and structure)
   - Deterministic function; documented

4. Separate estimator model:
   - Different prompt, isolated context (planner's prompt is NOT
     visible)
   - Optional; configured per deployment

If none returns a value: estimate = null. stepEfficiency metric
returns N/A; weight redistributes (see Quality scoring).

==================================================
BEHAVIORAL QUALITY SYSTEM
==================================================

All metrics in [0, 1] or N/A. Computed at task end.

Definitions (precise):

  stepEfficiency:
    if expectedStepEstimate is null OR actualSteps == 0:
      return N/A
    return clamp(expectedStepEstimate / actualSteps, 0, 1)

  toolEfficiency:
    if totalToolCalls == 0:
      return N/A
    correctCalls = count of tool calls where:
      - StepVerifier passed AND
      - the call was not later retried OR replaced via switch_tool
    return correctCalls / totalToolCalls

  recoveryEfficiency:
    if recoveryAttempts == 0:
      return N/A
    successfulRecoveries = count of recovery decisions whose next
      step (or replanned subgraph) ultimately succeeded
    return successfulRecoveries / recoveryAttempts

  contextEfficiency:
    if totalContextItems == 0:
      return N/A
    used = count of items referenced by any subsequent model_call or
      verification (tracked via item id surfaced in those calls'
      contextRefs field)
    return used / totalContextItems

  userInterruptionScore:
    if totalUserAsks == 0:
      return 1.0
    necessary = asks classified as: blocked, ambiguous, unsafe,
      approval_required (by recorded intent on the user_intervention
      event)
    return necessary / totalUserAsks

  redundancyScore:
    return 1 - (repeatedStepCount / max(totalSteps, 1))

  completionQuality:
    if task did not complete (state != completed):
      return 0
    metCount = count of (successCriteria ∪ doneConditions) verified
      met by GoalVerifier with at least one evidenceRef
    totalCount = |successCriteria ∪ doneConditions|
    return metCount / totalCount

Default weights:

  completionQuality      0.35
  stepEfficiency         0.20
  toolEfficiency         0.15
  recoveryEfficiency     0.10
  contextEfficiency      0.10
  redundancyScore        0.05
  userInterruptionScore  0.05

overallScore computation:
1. Compute each metric
2. Identify N/A metrics
3. Redistribute N/A weights proportionally across remaining metrics
   (preserve weight ratios among non-N/A metrics)
4. weighted sum, clamp to [0, 1]

Invariant check:
- If task.state == completed AND completionQuality < 1.0:
    emit quality_inconsistency event (should not occur; bug signal)

Default pass thresholds (configurable per task type / eval suite):

  completed = true
  safetyViolation = false
  successCriteria fully met
  doneConditions fully met
  overallScore >= 0.80
  userInterruptionScore >= 0.80
  redundancyScore >= 0.80

==================================================
QUALITY REPORT
==================================================

Schema (zod, schemaVersion: 1):

  {
    schemaVersion: 1,
    taskId,
    generatedAt,
    completed: boolean,
    safetyViolation: boolean,

    metrics: {
      stepEfficiency,                 // number | "N/A"
      toolEfficiency,
      recoveryEfficiency,
      contextEfficiency,
      userInterruptionScore,
      redundancyScore,
      completionQuality
    },

    weights: {                        // actual weights after
                                      // redistribution
      completionQuality, stepEfficiency, toolEfficiency,
      recoveryEfficiency, contextEfficiency, redundancyScore,
      userInterruptionScore
    },

    overallScore: number,

    counts: {
      totalSteps,
      expectedStepEstimate,           // number | null
      repeatedStepCount,
      unnecessaryToolCallCount,
      unnecessaryUserQuestionCount,
      failedToolCallCount,
      recoveryAttemptCount,
      injectionDetectionCount,
      doubleVerificationCount,
      verifierDisagreementCount
    },

    rootCauseIfLowScore: string | null,
    recommendedFixes: RecommendedFix[],
    qualityConcerns: string[]
  }

  RecommendedFix:
    {
      targetComponent: enum("planner","executor","verifier",
                            "recovery","context","safety","tool",
                            "memory","model_adapter","other"),
      changeType: enum("prompt_change","predicate_change",
                       "manifest_change","threshold_change",
                       "logic_change","new_tool","other"),
      rationale: string,
      evidenceRefs: eventId[]
    }

The QualityReport is emitted as quality_report_final event AND
written to:
  workspace/<projectId>/quality_reports/<taskId>.json
  (or wherever artifact storage from Phase 3 places quality artifacts;
  honor the existing artifact storage convention)

Also stored as a record in SQLite quality_reports table for fast
listing/querying in observability surfaces (Phase 5E).

==================================================
SELF-IMPROVEMENT HOOK
==================================================

Phase 5D: ANALYSIS ONLY. No auto-modification of production code.

After every task that fails or scores below threshold:

1. Failure analysis:
   - Identify primary failure type from recovery_decision events
   - Identify failure cluster (which subsystem dominated failures)
   - Walk back from failure to most likely root cause event

2. Root cause classification (for rootCauseIfLowScore):
   - planning              plan was malformed or unrealistic
   - tool_misuse           wrong tool selected for intent
   - context               required info missing or polluted
   - verifier              verifier failed or disagreed
   - recovery              recovery exhausted strategies
   - safety                safety_block required different approach
   - unnecessary_steps     redundancy / detours dominated
   - unnecessary_user_interruption
   - injection             halted by injection defense
   - model_output          repeated model errors
   - unknown               none of the above with confidence

3. Generate recommendedFixes (structured, see schema above):
   - Each fix references the events that motivated it
   - Each fix targets a specific component
   - Free-text rationale, structured everything else

4. If --auto-rerun flag set in eval mode AND fix is local +
   deterministic (e.g., threshold change, prompt addition):
     - Apply fix to a scratch config (NOT production)
     - Re-run task with same fixtures
     - Persist paired traces (original + improved)
     - Generate diff between runs

5. Persist analysis as part of QualityReport

Eval mode exposes the paired-trace diff via observability (Phase 5E).

==================================================
FINAL OUTPUT CONTRACT
==================================================

Assembled at task end (state = completed, GoalVerifier passed):

  {
    schemaVersion: 1,
    taskId,
    generatedAt,
    summary: string,                  // produced by goal verifier
    artifacts: [
      { id, path, kind, sizeBytes, hash }
    ],
    successCriteria: [
      { criterion, met, evidenceRefs }
    ],
    doneConditions: [
      { condition, met, evidenceRefs }
    ],
    limitations: string[],
    skippedItems: [
      { item, reason }
    ],
    qualityReport: QualityReport,
    nextSuggestedActions: string[]
  }

Stored at workspace/<projectId>/final_outputs/<taskId>.json (or
existing artifact convention).

For failed tasks, an analogous failure_output.json is produced with:
- partial summary
- partial artifacts
- which criteria/conditions met vs not
- which steps failed and why
- qualityReport (still produced)
- recommended next actions for the user

==================================================
EVAL MODE
==================================================

Activated via flag (per task or global config).

Behavior:
- Uses deterministic mock model (Phase 5C)
- Uses fixture-based tool responses where configured
- Strict thresholds (no relaxation for "edge cases")
- Pass criteria checked at task end:
    - state = completed
    - safetyViolation = false
    - all successCriteria met
    - all doneConditions met
    - overallScore >= threshold
    - userInterruptionScore >= threshold
    - redundancyScore >= threshold
    - no uncontrolled loops detected
    - no missing evidence on any verifier pass
    - no injection_detected without proper halt

Failure conditions in eval mode (any one fails the eval):
- Completed with low overallScore (technically passed, low quality)
- Safety violation occurred
- Excessive unnecessary user questions
- Loop detected without recovery
- Verifier passed without evidence
- Schema mismatch encountered

Eval output:
- pass / fail
- All metrics
- Paired traces if --auto-rerun
- Aggregate report across an eval suite

==================================================
TESTS THAT MUST PASS
==================================================

All Phase 5A, 5B, 5C tests must continue to pass.

RECOVERY — CLASSIFICATION  (unit)

- every_failure_classified: across 100 induced failures, every one
  has a known failureType (`unknown` rate < 1%)
- classification_emits_event: recovery_classification event for
  every failure
- unknown_failure_emits_miss: unclassifiable case emits
  recovery_classification_miss

RECOVERY — STRATEGY SELECTION  (unit + macos-integration)

- strategy_chain_followed: induced tool_failure tries
  retry_same_tool → retry_modified_input → switch_tool in order
- safety_block_never_auto_retries
- injection_detected_stops
- retry_caps_enforced: each (stepId, strategy) pair respects cap
- cap_advances_to_next_strategy
- exhaustion_escalates: all strategies exhausted → ask_user (if
  budget) or fail_gracefully

RECOVERY — EFFECTIVENESS TRACKING  (macos-integration)

- effectiveness_persisted: success/total per (failureType, strategy)
  written to SQLite
- crash_safe_metrics: kill daemon mid-update; metrics remain valid
  (transactional)

LOOP DETECTION  (unit)

- repeated_step_loop_triggers_replan
- no_progress_loop_after_n_steps
- redundancy_counted_not_blocked
- progress_signals_reset_counter

EXPECTED STEP ESTIMATE  (unit + macos-integration)

- historical_average_used_when_available
- heuristic_used_when_no_history
- estimate_null_when_no_source
- planner_does_not_influence_estimate
- historical_updated_after_completion: SQLite history row updated
  after task completes; transactional with QualityReport

QUALITY METRICS  (unit)

- step_efficiency_clamped
- step_efficiency_na_when_estimate_null
- step_efficiency_na_when_zero_steps
- tool_efficiency_correct_count
- recovery_efficiency_na_when_no_recoveries
- context_efficiency_tracks_actual_usage
- user_interruption_classification
- redundancy_score_decreases_with_repeats
- completion_quality_zero_for_incomplete
- completion_quality_fraction_of_met_with_evidence

QUALITY SCORING  (unit)

- na_weight_redistribution_correct
- multiple_na_redistribute_correctly
- overall_score_clamped_0_1
- inconsistency_detected: completed=true and completionQuality<1
  emits quality_inconsistency

QUALITY REPORT  (macos-integration)

- emitted_for_every_completed_task
- emitted_for_every_failed_task
- schema_validated
- counts_match_events: every count cross-checks against event store
- written_to_artifact_path: file present and matches event payload
- sqlite_record_present: row in quality_reports table

SELF-IMPROVEMENT  (unit + macos-integration)

- root_cause_for_low_score
- recommended_fixes_structured
- evidence_refs_resolvable
- auto_rerun_produces_paired_trace
- auto_rerun_diff_generated
- no_auto_modify_production: scratch config used; production
  config unchanged

EVAL MODE  (macos-integration)

- low_score_completed_task_fails_eval
- safety_violation_fails_eval
- excessive_user_questions_fails_eval
- loop_without_recovery_fails_eval
- verifier_pass_without_evidence_fails_eval
- eval_aggregate_report: 20 mock tasks → aggregate report

FINAL OUTPUT  (macos-integration)

- contains_all_required_fields
- success_criteria_each_have_evidence
- failed_task_produces_failure_output
- artifacts_listed_match_filesystem
- file_hashes_match

INTEGRATION  (macos-integration)

- end_to_end_with_recovery: induce a failure, recovery succeeds,
  task completes, report shows correct recoveryEfficiency
- end_to_end_with_low_quality: induce inefficient path, task
  completes but eval fails on overallScore
- end_to_end_with_injection: injection detected, stop_for_safety,
  failure_output produced, no malicious action taken
- crash_during_recovery
- crash_during_quality_report

==================================================
GATE CRITERION
==================================================

Phase 5D is COMPLETE when, and only when:

1. All Phase 5A, 5B, 5C tests still pass
2. Every test above passes in CI on three consecutive runs
3. Recovery battery: 50 distinct induced failures across all
   failureTypes; each follows the documented strategy chain; each
   logs all decisions; recovery succeeds where intended, escalates
   where designed
4. Quality battery: 30 mock tasks of varying quality; metric values
   match hand-computed expected values within floating-point
   tolerance
5. Eval mode reliably distinguishes:
   - High-quality completion (passes)
   - Technically completed but low quality (fails on overallScore)
   - Safety violation (fails)
   - Excessive user questions (fails)
6. Self-improvement audit:
   - Every below-threshold task in test corpus produces non-null
     rootCauseIfLowScore
   - Every recommendedFix has resolvable evidenceRefs
   - --auto-rerun produces paired traces and parseable diffs
7. Coverage for new modules ≥ 90%

Until all seven hold, do not begin Phase 5E.

==================================================
DELIVERABLES
==================================================

- Source code: Recovery Manager, loop/no-progress/redundancy
  detectors, expected-step estimator (all sources), Behavioral
  Quality System, QualityAuditor, Final Output assembler, Eval Mode
  runner, Self-Improvement Hook
- Updated zod schemas in /packages/protocol for QualityReport,
  RecommendedFix, recovery events
- Extended SQLite schema: task_step_history,
  strategy_effectiveness, quality_reports tables
- Test suite for all tests above
- Eval suite scaffolding: 20+ mock tasks of varying quality, with
  expected pass/fail outcomes per task
- Documentation:
    - FAILURE_TAXONOMY.md
    - RECOVERY_STRATEGIES.md
    - QUALITY_METRICS.md (every metric, formula, edge cases, worked
      examples)
    - EVAL_MODE.md
    - SELF_IMPROVEMENT.md
- Sign-off document with each gate criterion item checked
