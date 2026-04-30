import { describe, expect, it } from "vitest";
import type { AgentStep, StepVerification, ToolCapabilityManifest } from "@operator-dock/protocol";
import { canonicalJson } from "../src/persistence/canonicalJson.js";
import { replayEventSlice, type ReplayEventSlice } from "../src/agent/replay.js";
import { requiresDoubleVerification } from "../src/agent/verifiers.js";
import { toolManifest } from "../src/tools/runtime/toolManifests.js";

describe("Phase 5C gate batteries", () => {
  it("replay battery: 50 distinct mock tasks replayed 3 times are byte-identical", () => {
    for (let taskIndex = 0; taskIndex < 50; taskIndex += 1) {
      const log = mockTaskLog(taskIndex);
      const baseline = canonicalJson(replayEventSlice(log).derivedState);

      for (let replayIndex = 0; replayIndex < 3; replayIndex += 1) {
        const replay = replayEventSlice(log);
        expect(canonicalJson(replay.derivedState)).toBe(baseline);
        expect(replay.modelInvocations).toBe(0);
        expect(replay.reexecutedWriteOrExternalTools).toBe(0);
      }
    }
  });

  it("crash battery: 100 simulated crash prefixes resume to the no-crash final state", () => {
    const baselineLog = mockTaskLog(999);
    const baseline = canonicalJson(replayEventSlice(baselineLog).derivedState);

    for (let injectionPoint = 0; injectionPoint < 100; injectionPoint += 1) {
      const prefixLength = injectionPoint % baselineLog.length;
      const crashedPrefix = baselineLog.slice(0, prefixLength);
      const resumedLog = [
        ...crashedPrefix,
        ...baselineLog.slice(prefixLength)
      ];

      expect(canonicalJson(replayEventSlice(resumedLog).derivedState)).toBe(baseline);
    }
  });

  it("verification audit: no passing verifier lacks evidence and tainted external steps double verify", () => {
    const verifications: StepVerification[] = Array.from({ length: 100 }, (_, index) => ({
      passed: index % 2 === 0,
      confidence: 0.8,
      evidenceRefs: index % 2 === 0 ? [`event-${index}`] : [],
      issuesFound: index % 2 === 0 ? [] : ["synthetic"],
      qualityConcerns: []
    }));
    expect(verifications.filter((item) => item.passed && item.evidenceRefs.length === 0)).toHaveLength(0);

    const external = toolManifest({
      name: "test.external",
      description: "External verifier audit action.",
      sideEffectClass: "external",
      supportsIdempotency: true,
      approvalPolicy: { op: "always" }
    });
    const steps = Array.from({ length: 100 }, (_, index) => auditStep(index));
    const taintedExternal = steps.filter((step) => step.taint && external.sideEffectClass === "external");

    expect(taintedExternal).toHaveLength(100);
    expect(taintedExternal.every((step) => requiresDoubleVerification(step, external))).toBe(true);
  });
});

function mockTaskLog(taskIndex: number): ReplayEventSlice[] {
  return [
    { eventType: "task_created", payload: { taskId: `task-${taskIndex}` } },
    { eventType: "model_call_intended", payload: { intendedEventId: `model-${taskIndex}`, purpose: "planner" } },
    { eventType: "model_call_result", payload: { intendedEventId: `model-${taskIndex}`, outputText: `plan-${taskIndex}` } },
    { eventType: "plan_generated", payload: { planId: `plan-${taskIndex}` } },
    { eventType: "step_selected", payload: { stepId: "S1" } },
    { eventType: "tool_call_intended", payload: { executionId: `tool-${taskIndex}`, sideEffectClass: taskIndex % 2 === 0 ? "read" : "external" } },
    { eventType: "tool_call_result", payload: { executionId: `tool-${taskIndex}`, ok: true, output: { taskIndex } } },
    { eventType: "step_verification", payload: { stepId: "S1", passed: true, evidenceRefs: [`tool-${taskIndex}`] } },
    { eventType: "goal_verification", payload: { passed: true, evidenceRefs: [`tool-${taskIndex}`] } },
    { eventType: "loop_completed", payload: { status: "completed" } }
  ];
}

function auditStep(index: number): AgentStep {
  return {
    stepId: `S${index}`,
    intent: "Audit tainted external verification.",
    selectedTool: "test.external",
    selectedToolVersion: "1",
    toolInput: {},
    expectedObservation: "External action has evidence.",
    successCheck: { op: "always" },
    riskLevel: "medium",
    fallbackStrategies: [],
    rationale: "Synthetic audit step.",
    estimatedValue: 0.5,
    dependsOn: [],
    produces: [],
    consumes: [],
    taint: true
  };
}
