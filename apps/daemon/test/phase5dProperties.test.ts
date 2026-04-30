import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { QualityMetricValue, RecoveryFailureType } from "@operator-dock/protocol";
import { classifyFailure, strategyForFailureType } from "../src/agent/recoveryManager.js";
import { computeQualityScore, defaultQualityWeights } from "../src/agent/quality.js";

describe("Phase 5D property tests", () => {
  it("recovery decisions classify adversarial known failure signals without unknown", () => {
    fc.assert(
      fc.property(knownFailureSignalArbitrary(), (signal) => {
        expect(classifyFailure(signal).failureType).not.toBe("unknown");
      }),
      { numRuns: 500 }
    );
  });

  it("safety and injection failures never select same-call auto retry strategies", () => {
    fc.assert(
      fc.property(fc.constantFrom("safety_block", "injection_detected" as const), (failureType) => {
        const strategy = strategyForFailureType(failureType, new Map(), "S1", 0);
        expect(strategy.strategy).not.toBe("retry_same_tool");
        expect(strategy.strategy).not.toBe("retry_modified_input");
        expect(strategy.strategy).not.toBe("switch_tool");
      }),
      { numRuns: 100 }
    );
  });

  it("quality scoring stays clamped and redistributed weights sum to one", () => {
    fc.assert(
      fc.property(
        fc.record({
          completionQuality: metricArbitrary(),
          stepEfficiency: metricArbitrary(),
          toolEfficiency: metricArbitrary(),
          recoveryEfficiency: metricArbitrary(),
          contextEfficiency: metricArbitrary(),
          redundancyScore: metricArbitrary(),
          userInterruptionScore: metricArbitrary()
        }),
        (metrics) => {
          const score = computeQualityScore({ metrics, weights: defaultQualityWeights });
          expect(score.overallScore).toBeGreaterThanOrEqual(0);
          expect(score.overallScore).toBeLessThanOrEqual(1);
          expect(Object.values(score.weights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
        }
      ),
      { numRuns: 500 }
    );
  });
});

function metricArbitrary(): fc.Arbitrary<QualityMetricValue> {
  return fc.oneof(
    fc.constant("N/A"),
    fc.float({ min: 0, max: 1, noNaN: true }).map((value) => Number(value))
  );
}

function knownFailureSignalArbitrary() {
  return fc.constantFrom<RecoveryFailureType>(
    "validation_error",
    "tool_failure",
    "no_effect",
    "context_loss",
    "model_error",
    "auth_required",
    "timeout",
    "safety_block",
    "injection_detected",
    "repeated_step_loop",
    "no_progress_loop",
    "low_quality_path",
    "excessive_user_interruption",
    "schema_version_mismatch",
    "verifier_disagreement"
  ).map((failureType) => {
    switch (failureType) {
    case "validation_error": return { validationError: true };
    case "tool_failure": return { toolStatus: "failed", errorCode: "TOOL_EXECUTION_FAILED" };
    case "no_effect": return { noEffect: true };
    case "context_loss": return { contextMissing: true };
    case "model_error": return { modelError: true };
    case "auth_required": return { authRequired: true };
    case "timeout": return { timedOut: true };
    case "safety_block": return { safetyDecision: "deny" };
    case "injection_detected": return { injectionDetected: true };
    case "repeated_step_loop": return { loopFailureType: "repeated_step_loop" };
    case "no_progress_loop": return { loopFailureType: "no_progress_loop" };
    case "low_quality_path": return { lowQualityPath: true };
    case "excessive_user_interruption": return { excessiveUserInterruption: true };
    case "schema_version_mismatch": return { recordSchemaVersion: 2, knownSchemaVersion: 1 };
    case "verifier_disagreement": return { verifierDisagreement: true };
    case "unknown": return {};
    }
  });
}
