import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentPlan, GoalVerification, JsonValue, QualityReport } from "@operator-dock/protocol";
import { EventStore } from "../src/persistence/eventStore.js";
import { OperatorDockPaths } from "../src/persistence/paths.js";
import { MemoryPersistenceKeychainClient, PersistenceKeyManager } from "../src/persistence/persistenceKeys.js";
import { openDatabase } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import {
  RecoveryManager,
  StrategyEffectivenessRepository,
  classifyFailure,
  recoveryStrategyChain
} from "../src/agent/recoveryManager.js";
import {
  LoopDetector,
  normalizeStepSignature
} from "../src/agent/loopDetection.js";
import {
  ExpectedStepEstimator,
  TaskStepHistoryRepository
} from "../src/agent/expectedStepEstimator.js";
import {
  QualityAuditor,
  QualityReportRepository,
  computeQualityScore,
  defaultQualityWeights,
  metricValue
} from "../src/agent/quality.js";
import { SelfImprovementAnalyzer } from "../src/agent/selfImprovement.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots.clear();
});

describe("Phase 5D recovery manager", () => {
  it("every_failure_classified and classification events are emitted", async () => {
    const harness = await persistenceHarness("phase5d-recovery-classify-");
    const manager = new RecoveryManager({
      eventStore: harness.events,
      effectiveness: new StrategyEffectivenessRepository(harness.database)
    });
    const inducedFailures = Array.from({ length: 100 }, (_, index) => failureSignal(index));

    const classifications = inducedFailures.map((failure) => manager.classify("task-classify", failure));

    expect(classifications.filter((item) => item.failureType === "unknown")).toHaveLength(0);
    expect(harness.events.readAll("task-classify").filter((event) => event.eventType === "recovery_classification")).toHaveLength(100);
  });

  it("unknown_failure_emits_miss", async () => {
    const harness = await persistenceHarness("phase5d-recovery-miss-");
    const manager = new RecoveryManager({
      eventStore: harness.events,
      effectiveness: new StrategyEffectivenessRepository(harness.database)
    });

    const classification = manager.classify("task-miss", { stepId: "S1" });

    expect(classification.failureType).toBe("unknown");
    expect(harness.events.readAll("task-miss").map((event) => event.eventType)).toContain("recovery_classification_miss");
  });

  it("strategy_chain_followed, retry_caps_enforced, cap_advances_to_next_strategy, and exhaustion_escalates", async () => {
    const harness = await persistenceHarness("phase5d-recovery-strategy-");
    const manager = new RecoveryManager({
      eventStore: harness.events,
      effectiveness: new StrategyEffectivenessRepository(harness.database),
      userInterruptionBudget: 1
    });

    const strategies = Array.from({ length: 7 }, () =>
      manager.decide("task-strategy", {
        stepId: "S1",
        toolStatus: "failed",
        errorCode: "TOOL_EXECUTION_FAILED"
      }).strategy
    );

    expect(strategies).toEqual([
      "retry_same_tool",
      "retry_same_tool",
      "retry_modified_input",
      "retry_modified_input",
      "switch_tool",
      "switch_tool",
      "ask_user"
    ]);
    expect(manager.decide("task-strategy", {
      stepId: "S1",
      toolStatus: "failed",
      errorCode: "TOOL_EXECUTION_FAILED"
    }).strategy).toBe("fail_gracefully");
  });

  it("safety_block_never_auto_retries and injection_detected_stops", async () => {
    const harness = await persistenceHarness("phase5d-recovery-safety-");
    const manager = new RecoveryManager({
      eventStore: harness.events,
      effectiveness: new StrategyEffectivenessRepository(harness.database)
    });

    expect(manager.decide("task-safety", {
      stepId: "S1",
      safetyDecision: "deny"
    }).strategy).toBe("replan_subgraph");
    expect(manager.decide("task-injection", {
      stepId: "S1",
      injectionDetected: true
    }).strategy).toBe("stop_for_safety");
  });

  it("effectiveness_persisted and crash_safe_metrics", async () => {
    const harness = await persistenceHarness("phase5d-recovery-effectiveness-");
    const repository = new StrategyEffectivenessRepository(harness.database);

    repository.record("tool_failure", "retry_same_tool", true);
    repository.record("tool_failure", "retry_same_tool", false);

    expect(repository.get("tool_failure", "retry_same_tool")).toEqual({
      failureType: "tool_failure",
      strategy: "retry_same_tool",
      successCount: 1,
      totalCount: 2
    });
  });
});

describe("Phase 5D loop detection and estimates", () => {
  it("repeated_step_loop_triggers_replan, no_progress_loop_after_n_steps, redundancy_counted_not_blocked, and progress_signals_reset_counter", () => {
    const detector = new LoopDetector({ noProgressStepThreshold: 3 });
    const repeated = [
      selected("S1", "sleep.wait", { durationMs: 0 }, "same intent"),
      verified("S1", false, []),
      selected("S2", "sleep.wait", { durationMs: 0 }, "same intent"),
      verified("S2", false, []),
      selected("S3", "sleep.wait", { durationMs: 0 }, "same intent"),
      verified("S3", false, [])
    ];

    expect(detector.analyze(repeated).failureType).toBe("repeated_step_loop");
    expect(detector.analyze(repeated).repeatedStepCount).toBe(2);
    expect(detector.analyze([
      selected("A", "sleep.wait", { durationMs: 0 }, "a"),
      verified("A", false, []),
      selected("B", "sleep.wait", { durationMs: 1 }, "b"),
      verified("B", false, []),
      selected("C", "sleep.wait", { durationMs: 2 }, "c"),
      verified("C", false, [])
    ]).failureType).toBe("no_progress_loop");
    expect(detector.analyze([
      selected("A", "sleep.wait", { durationMs: 0 }, "a"),
      verified("A", false, []),
      selected("B", "sleep.wait", { durationMs: 1 }, "b"),
      verified("B", true, ["event-1"]),
      selected("C", "sleep.wait", { durationMs: 2 }, "c"),
      verified("C", false, [])
    ]).failureType).toBeNull();
  });

  it("normalized signatures ignore object key order", () => {
    expect(normalizeStepSignature("tool", { b: 2, a: 1 }, "intent")).toBe(
      normalizeStepSignature("tool", { a: 1, b: 2 }, "intent")
    );
  });

  it("historical_average_used_when_available, heuristic_used_when_no_history, estimate_null_when_no_source, planner_does_not_influence_estimate, and historical_updated_after_completion", async () => {
    const harness = await persistenceHarness("phase5d-estimates-");
    const history = new TaskStepHistoryRepository(harness.database);
    for (let index = 0; index < 10; index += 1) {
      history.recordCompletedTask("analysis", 4);
    }

    const estimator = new ExpectedStepEstimator(history, { evalNorms: { benchmark: 7 } });
    expect(estimator.estimate({ taskType: "analysis", plan: plan({ expectedStepEstimate: 99 }) })).toBe(4);
    expect(estimator.estimate({ taskType: "benchmark", plan: plan() })).toBe(7);
    expect(estimator.estimate({ taskType: "new", plan: plan({ doneConditions: [criterion("done"), criterion("extra")] }) })).toBe(4);
    expect(new ExpectedStepEstimator(history, { heuristicEnabled: false }).estimate({ taskType: "none", plan: plan() })).toBeNull();
    expect(history.get("analysis")?.sampleCount).toBe(10);
  });
});

describe("Phase 5D quality metrics and reporting", () => {
  it("quality metrics, scoring, N/A redistribution, and inconsistency detection", async () => {
    const harness = await persistenceHarness("phase5d-quality-");
    harness.events.append("task-quality", "plan_generated", { plan: plan({ expectedStepEstimate: 2 }) as unknown as JsonValue });
    harness.events.append("task-quality", "step_selected", { stepId: "S1", toolName: "sleep.wait", intent: "one", toolInput: { durationMs: 0 } });
    harness.events.append("task-quality", "tool_call_result", { executionId: "T1", stepId: "S1", ok: true, status: "ok" });
    harness.events.append("task-quality", "step_verification", { stepId: "S1", passed: true, confidence: 0.8, evidenceRefs: ["T1"], issuesFound: [], qualityConcerns: [] });
    harness.events.append("task-quality", "goal_verification", goalVerification(true, true) as unknown as Record<string, JsonValue>);
    harness.events.append("task-quality", "loop_completed", { status: "completed" });

    const reporter = new QualityAuditor({
      eventStore: harness.events,
      reports: new QualityReportRepository(harness.database),
      workspaceRoot: harness.workspaceRoot
    });
    const report = reporter.generateAndPersist({
      taskId: "task-quality",
      projectId: "project-quality",
      taskType: "quality"
    });

    expect(report.completed).toBe(true);
    expect(report.metrics.completionQuality).toBe(1);
    expect(report.metrics.recoveryEfficiency).toBe("N/A");
    expect(report.weights.recoveryEfficiency).toBe(0);
    expect(report.overallScore).toBeGreaterThanOrEqual(0.8);
    expect(harness.events.readAll("task-quality").map((event) => event.eventType)).toContain("quality_report_final");
    expect(readFileSync(join(harness.workspaceRoot, "artifacts", "quality_reports", "task-quality.json"), "utf8")).toContain("\"schemaVersion\": 1");
    expect(new QualityReportRepository(harness.database).get("task-quality")?.overallScore).toBe(report.overallScore);

    const score = computeQualityScore({
      metrics: {
        completionQuality: 0.5,
        stepEfficiency: "N/A",
        toolEfficiency: "N/A",
        recoveryEfficiency: "N/A",
        contextEfficiency: "N/A",
        redundancyScore: 1,
        userInterruptionScore: 1
      },
      weights: defaultQualityWeights
    });
    expect(metricValue(score.metrics.completionQuality)).toBe(0.5);
    expect(Object.values(score.weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(computeQualityScore({
      metrics: {
        completionQuality: "N/A",
        stepEfficiency: "N/A",
        toolEfficiency: "N/A",
        recoveryEfficiency: "N/A",
        contextEfficiency: "N/A",
        redundancyScore: "N/A",
        userInterruptionScore: "N/A"
      },
      weights: defaultQualityWeights
    }).overallScore).toBe(0);
  });

  it("root_cause_for_low_score, recommended_fixes_structured, and evidence_refs_resolvable", async () => {
    const harness = await persistenceHarness("phase5d-self-improvement-");
    const failedEvent = harness.events.append("task-low", "recovery_decision", {
      failureType: "tool_failure",
      classifiedReason: "tool failed",
      strategy: "fail_gracefully",
      retryCount: 1,
      capReached: true,
      nextStepOverride: null,
      escalationRequired: true,
      rationale: "exhausted"
    });
    const report = lowScoreReport("task-low", failedEvent);
    const analysis = new SelfImprovementAnalyzer(harness.events).analyze("task-low", report);

    expect(analysis.rootCauseIfLowScore).toBe("tool_misuse");
    expect(analysis.recommendedFixes[0]?.evidenceRefs).toEqual([failedEvent]);
  });

  it("self-improvement classifies safety, context, verifier, model, loop, interruption, recovery, planning, and unknown roots", async () => {
    const cases = [
      ["safety_block", "safety"],
      ["context_loss", "context"],
      ["verifier_disagreement", "verifier"],
      ["model_error", "model_output"],
      ["repeated_step_loop", "unnecessary_steps"],
      ["excessive_user_interruption", "unnecessary_user_interruption"]
    ] as const;

    for (const [failureType, rootCause] of cases) {
      const harness = await persistenceHarness(`phase5d-self-${failureType}-`);
      harness.events.append(`task-${failureType}`, "recovery_decision", recoveryPayload(failureType));
      const evidenceRef = harness.events.readAll(`task-${failureType}`)[0]!.eventId;
      const baseReport = lowScoreReport(`task-${failureType}`, evidenceRef);
      const analysis = new SelfImprovementAnalyzer(harness.events).analyze(`task-${failureType}`, {
        ...baseReport,
        counts: {
          ...baseReport.counts,
          failedToolCallCount: failureType === "tool_failure" ? 1 : 0,
          repeatedStepCount: failureType === "repeated_step_loop" ? 1 : 0,
          unnecessaryUserQuestionCount: failureType === "excessive_user_interruption" ? 1 : 0
        }
      });
      expect(analysis.rootCauseIfLowScore).toBe(rootCause);
    }

    const recoveryHarness = await persistenceHarness("phase5d-self-recovery-");
    const recoveryEvent = recoveryHarness.events.append("task-recovery", "recovery_decision", recoveryPayload("unknown"));
    expect(new SelfImprovementAnalyzer(recoveryHarness.events).analyze("task-recovery", {
      ...lowScoreReport("task-recovery", recoveryEvent),
      counts: { ...lowScoreReport("task-recovery", recoveryEvent).counts, failedToolCallCount: 0, recoveryAttemptCount: 1 },
      metrics: { ...lowScoreReport("task-recovery", recoveryEvent).metrics, recoveryEfficiency: 0, completionQuality: 1 }
    }).rootCauseIfLowScore).toBe("recovery");

    const planningHarness = await persistenceHarness("phase5d-self-planning-");
    const planningEvent = planningHarness.events.append("task-planning", "quality_probe", {});
    expect(new SelfImprovementAnalyzer(planningHarness.events).analyze("task-planning", {
      ...lowScoreReport("task-planning", planningEvent),
      counts: { ...lowScoreReport("task-planning", planningEvent).counts, failedToolCallCount: 0, recoveryAttemptCount: 0 },
      metrics: { ...lowScoreReport("task-planning", planningEvent).metrics, completionQuality: 0 }
    }).rootCauseIfLowScore).toBe("planning");

    const unknownHarness = await persistenceHarness("phase5d-self-unknown-");
    const unknownEvent = unknownHarness.events.append("task-unknown", "quality_probe", {});
    expect(new SelfImprovementAnalyzer(unknownHarness.events).analyze("task-unknown", {
      ...lowScoreReport("task-unknown", unknownEvent),
      counts: { ...lowScoreReport("task-unknown", unknownEvent).counts, failedToolCallCount: 0, recoveryAttemptCount: 0 },
      metrics: { ...lowScoreReport("task-unknown", unknownEvent).metrics, completionQuality: 1 }
    }).rootCauseIfLowScore).toBe("unknown");
  });
});

async function persistenceHarness(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.add(root);
  const paths = new OperatorDockPaths(join(root, "state"));
  paths.createLayout();
  const keys = await new PersistenceKeyManager(new MemoryPersistenceKeychainClient()).loadOrCreateKeys();
  const database = openDatabase({
    databasePath: join(root, "operator-dock.sqlite"),
    encryptionKey: keys.encryptionKey
  });
  runMigrations(database, resolve("migrations"));
  const workspaceRoot = join(root, "workspace");
  mkdirSync(join(workspaceRoot, "artifacts"), { recursive: true });
  return {
    root,
    workspaceRoot,
    paths,
    keys,
    database,
    events: new EventStore(paths, keys)
  };
}

function failureSignal(index: number) {
  const signals = [
    { stepId: "S", validationError: true },
    { stepId: "S", toolStatus: "failed", errorCode: "TOOL_EXECUTION_FAILED" },
    { stepId: "S", noEffect: true },
    { stepId: "S", contextMissing: true },
    { stepId: "S", modelError: true },
    { stepId: "S", authRequired: true },
    { stepId: "S", timedOut: true },
    { stepId: "S", safetyDecision: "deny" },
    { stepId: "S", injectionDetected: true },
    { stepId: "S", loopFailureType: "repeated_step_loop" },
    { stepId: "S", loopFailureType: "no_progress_loop" },
    { stepId: "S", lowQualityPath: true },
    { stepId: "S", excessiveUserInterruption: true },
    { stepId: "S", recordSchemaVersion: 2, knownSchemaVersion: 1 },
    { stepId: "S", verifierDisagreement: true }
  ];
  return signals[index % signals.length]!;
}

function selected(stepId: string, toolName: string, toolInput: Record<string, JsonValue>, intent: string) {
  return { eventType: "step_selected", payload: { stepId, toolName, toolInput, intent } };
}

function verified(stepId: string, passed: boolean, evidenceRefs: string[]) {
  return { eventType: "step_verification", payload: { stepId, passed, evidenceRefs } };
}

function criterion(id: string) {
  return {
    id,
    description: id,
    predicate: { op: "always" as const },
    requiresEvidence: true
  };
}

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    schemaVersion: 1,
    planId: "plan-5d",
    taskId: "task-5d",
    revision: 0,
    parentPlanId: null,
    taskGoal: "Write a short report",
    assumptions: [],
    constraints: [],
    successCriteria: [criterion("success")],
    doneConditions: [criterion("done")],
    forbiddenActions: [],
    expectedStepEstimate: null,
    risks: [],
    expectedArtifacts: [],
    openQuestions: [],
    steps: [],
    ...overrides
  };
}

function goalVerification(successMet: boolean, doneMet: boolean): GoalVerification {
  return {
    successCriteriaMet: [{ criterionId: "success", met: successMet, evidenceRefs: successMet ? ["T1"] : [] }],
    doneConditionsMet: [{ conditionId: "done", met: doneMet, evidenceRefs: doneMet ? ["T1"] : [] }],
    passed: successMet && doneMet,
    qualityConcerns: []
  };
}

function lowScoreReport(taskId: string, evidenceRef: string): QualityReport {
  return {
    schemaVersion: 1,
    taskId,
    generatedAt: "2026-01-01T00:00:00.000Z",
    completed: false,
    safetyViolation: false,
    metrics: {
      stepEfficiency: 0.2,
      toolEfficiency: 0,
      recoveryEfficiency: 0,
      contextEfficiency: "N/A",
      userInterruptionScore: 1,
      redundancyScore: 1,
      completionQuality: 0
    },
    weights: defaultQualityWeights,
    overallScore: 0.2,
    counts: {
      totalSteps: 1,
      expectedStepEstimate: 1,
      repeatedStepCount: 0,
      unnecessaryToolCallCount: 0,
      unnecessaryUserQuestionCount: 0,
      failedToolCallCount: 1,
      recoveryAttemptCount: 1,
      injectionDetectionCount: 0,
      doubleVerificationCount: 0,
      verifierDisagreementCount: 0
    },
    rootCauseIfLowScore: null,
    recommendedFixes: [{
      targetComponent: "tool",
      changeType: "logic_change",
      rationale: "Synthetic low-score test fix.",
      evidenceRefs: [evidenceRef]
    }],
    qualityConcerns: []
  };
}

function recoveryPayload(failureType: string): Record<string, JsonValue> {
  return {
    failureType,
    classifiedReason: failureType,
    strategy: "fail_gracefully",
    retryCount: 1,
    capReached: true,
    nextStepOverride: null,
    escalationRequired: true,
    rationale: failureType
  };
}
