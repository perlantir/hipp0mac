import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentPlan, GoalVerification, QualityReport } from "@operator-dock/protocol";
import { assembleFailureOutput, assembleFinalOutput, hashFileArtifact } from "../src/agent/finalOutput.js";
import {
  aggregateEvalResults,
  evaluateQualityReport,
  runAutoRerunScratch
} from "../src/agent/evalMode.js";
import { defaultQualityWeights } from "../src/agent/quality.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots.clear();
});

describe("Phase 5D final outputs and eval mode", () => {
  it("final output contains required fields, evidence, matching filesystem artifacts, and hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "phase5d-final-output-"));
    tempRoots.add(root);
    const artifactPath = join(root, "report.txt");
    writeFileSync(artifactPath, "hello final output\n", "utf8");
    const artifact = hashFileArtifact("artifact-1", artifactPath, "file");

    const output = assembleFinalOutput({
      taskId: "task-final",
      plan: plan(),
      verification: goalVerification(true, true),
      qualityReport: report("task-final", 0.95),
      artifacts: [artifact],
      summary: "Task completed.",
      limitations: [],
      skippedItems: [],
      nextSuggestedActions: []
    });

    expect(output.schemaVersion).toBe(1);
    expect(output.successCriteria.every((criterion) => criterion.evidenceRefs.length > 0)).toBe(true);
    expect(output.artifacts[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(output.artifacts[0]?.sizeBytes).toBe(readFileSync(artifactPath).byteLength);
  });

  it("failed task produces failure output with quality report", () => {
    const output = assembleFailureOutput({
      taskId: "task-failed",
      plan: plan(),
      verification: goalVerification(false, false),
      qualityReport: report("task-failed", 0.2, false),
      partialSummary: "Task failed safely.",
      partialArtifacts: [],
      failedSteps: [{ stepId: "S1", reason: "tool failed", evidenceRefs: ["event-1"] }],
      recommendedNextActions: ["Try a narrower task."]
    });

    expect(output.qualityReport.completed).toBe(false);
    expect(output.failedSteps[0]?.reason).toBe("tool failed");
  });

  it("eval mode distinguishes high quality, low quality, safety violations, excessive questions, loop failures, and missing evidence", async () => {
    expect(evaluateQualityReport(report("high", 0.95)).passed).toBe(true);
    expect(evaluateQualityReport(report("low", 0.7)).reasons).toContain("overallScore below threshold");
    expect(evaluateQualityReport(report("unsafe", 0.95, true, true)).reasons).toContain("safety violation occurred");
    expect(evaluateQualityReport({
      ...report("questions", 0.95),
      metrics: { ...report("questions", 0.95).metrics, userInterruptionScore: 0.5 }
    }).reasons).toContain("userInterruptionScore below threshold");
    expect(evaluateQualityReport({
      ...report("loop", 0.95),
      counts: { ...report("loop", 0.95).counts, repeatedStepCount: 10 },
      metrics: { ...report("loop", 0.95).metrics, redundancyScore: 0.5 }
    }).reasons).toContain("redundancyScore below threshold");
    expect(evaluateQualityReport(report("missing-evidence", 0.95), {
      verifierPassWithoutEvidence: true
    }).reasons).toContain("verifier passed without evidence");
    expect(evaluateQualityReport(report("schema", 0.95), {
      schemaMismatchEncountered: true
    }).reasons).toContain("schema mismatch encountered");
    expect(evaluateQualityReport(report("injection", 0.95), {
      injectionWithoutHalt: true
    }).reasons).toContain("injection detected without proper halt");

    const paired = await runAutoRerunScratch(
      { threshold: 0.8 },
      async (config) => {
        config.threshold = 0.9;
        return { trace: [{ eventType: "quality_report_final", threshold: config.threshold }], config };
      }
    );
    expect(paired.productionConfig).toEqual({ threshold: 0.8 });
    expect(paired.scratchConfig).not.toBe(paired.productionConfig);
    expect(paired.diff.changed).toContain("threshold");

    const aggregate = aggregateEvalResults([
      { taskId: "high", qualityReport: report("high", 0.95) },
      { taskId: "low", qualityReport: report("low", 0.2) }
    ]);
    expect(aggregate.totalTasks).toBe(2);
    expect(aggregate.passed).toBe(1);
    expect(aggregate.failed).toBe(1);
  });
});

function criterion(id: string) {
  return {
    id,
    description: id,
    predicate: { op: "always" as const },
    requiresEvidence: true
  };
}

function plan(): AgentPlan {
  return {
    schemaVersion: 1,
    planId: "plan-final",
    taskId: "task-final",
    revision: 0,
    parentPlanId: null,
    taskGoal: "Create final output.",
    assumptions: [],
    constraints: [],
    successCriteria: [criterion("success")],
    doneConditions: [criterion("done")],
    forbiddenActions: [],
    expectedStepEstimate: 1,
    risks: [],
    expectedArtifacts: [],
    openQuestions: [],
    steps: []
  };
}

function goalVerification(successMet: boolean, doneMet: boolean): GoalVerification {
  return {
    successCriteriaMet: [{ criterionId: "success", met: successMet, evidenceRefs: successMet ? ["event-1"] : [] }],
    doneConditionsMet: [{ conditionId: "done", met: doneMet, evidenceRefs: doneMet ? ["event-1"] : [] }],
    passed: successMet && doneMet,
    qualityConcerns: []
  };
}

function report(taskId: string, score: number, completed = true, safetyViolation = false): QualityReport {
  return {
    schemaVersion: 1,
    taskId,
    generatedAt: "2026-01-01T00:00:00.000Z",
    completed,
    safetyViolation,
    metrics: {
      stepEfficiency: 1,
      toolEfficiency: 1,
      recoveryEfficiency: "N/A",
      contextEfficiency: "N/A",
      userInterruptionScore: 1,
      redundancyScore: 1,
      completionQuality: completed ? 1 : 0
    },
    weights: defaultQualityWeights,
    overallScore: score,
    counts: {
      totalSteps: 1,
      expectedStepEstimate: 1,
      repeatedStepCount: 0,
      unnecessaryToolCallCount: 0,
      unnecessaryUserQuestionCount: 0,
      failedToolCallCount: completed ? 0 : 1,
      recoveryAttemptCount: 0,
      injectionDetectionCount: safetyViolation ? 1 : 0,
      doubleVerificationCount: 0,
      verifierDisagreementCount: 0
    },
    rootCauseIfLowScore: score >= 0.8 ? null : "unknown",
    recommendedFixes: score >= 0.8 ? [] : [{
      targetComponent: "other",
      changeType: "logic_change",
      rationale: "Improve low score.",
      evidenceRefs: ["event-1"]
    }],
    qualityConcerns: []
  };
}
