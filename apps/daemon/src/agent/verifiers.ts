import type {
  AgentPlan,
  AgentStep,
  GoalVerification,
  StepVerification,
  ToolCapabilityManifest
} from "@operator-dock/protocol";
import { GoalVerificationSchema, StepVerificationSchema } from "@operator-dock/protocol";
import { evaluatePredicate } from "../tools/runtime/predicateEngine.js";

export interface StepVerificationInput {
  output: unknown;
  evidenceRefs: string[];
  confidence?: number;
}

export interface EvidenceStatus {
  met: boolean;
  evidenceRefs: string[];
}

export function verifyStep(
  step: AgentStep,
  _manifest: ToolCapabilityManifest,
  input: StepVerificationInput
): StepVerification {
  const predicatePassed = evaluatePredicate(step.successCheck, { output: input.output as never }, noScopeContext());
  const passed = predicatePassed && input.evidenceRefs.length > 0;
  return StepVerificationSchema.parse({
    passed,
    confidence: input.confidence ?? (passed ? 0.7 : 0.2),
    evidenceRefs: input.evidenceRefs,
    issuesFound: passed ? [] : ["Step success predicate failed or evidenceRefs were missing."],
    qualityConcerns: []
  });
}

export function verifyGoal(
  plan: AgentPlan,
  evidence: Record<string, EvidenceStatus>
): GoalVerification {
  const successCriteriaMet = plan.successCriteria.map((criterion) => {
    const status = evidence[criterion.id] ?? { met: false, evidenceRefs: [] };
    return {
      criterionId: criterion.id,
      met: status.met && (!criterion.requiresEvidence || status.evidenceRefs.length > 0),
      evidenceRefs: status.evidenceRefs
    };
  });
  const doneConditionsMet = plan.doneConditions.map((condition) => {
    const status = evidence[condition.id] ?? { met: false, evidenceRefs: [] };
    return {
      conditionId: condition.id,
      met: status.met && (!condition.requiresEvidence || status.evidenceRefs.length > 0),
      evidenceRefs: status.evidenceRefs
    };
  });
  const passed = successCriteriaMet.every((item) => item.met && item.evidenceRefs.length > 0)
    && doneConditionsMet.every((item) => item.met && item.evidenceRefs.length > 0);

  return GoalVerificationSchema.parse({
    successCriteriaMet,
    doneConditionsMet,
    passed,
    qualityConcerns: []
  });
}

export function goalVerifierInput(
  plan: AgentPlan,
  evidence: Record<string, EvidenceStatus>
): unknown {
  return {
    plan: {
      ...plan,
      steps: plan.steps.map(({ rationale: _rationale, ...step }) => step)
    },
    evidence
  };
}

export function requiresDoubleVerification(
  step: AgentStep,
  manifest: ToolCapabilityManifest
): boolean {
  return manifest.sideEffectClass === "external"
    || manifest.sideEffectClass === "write-non-idempotent"
    || step.riskLevel === "critical"
    || step.taint;
}

export function combineDoubleVerification(results: StepVerification[]): StepVerification {
  if (results.length !== 2) {
    throw new Error("Double verification requires exactly two verifier results.");
  }

  const [first, second] = results;
  if (first?.passed !== true || second?.passed !== true) {
    throw new Error("Step verification disagreement halted the loop.");
  }

  return StepVerificationSchema.parse({
    passed: true,
    confidence: Math.min(first.confidence, second.confidence),
    evidenceRefs: [...new Set([...first.evidenceRefs, ...second.evidenceRefs])],
    issuesFound: [],
    qualityConcerns: [...first.qualityConcerns, ...second.qualityConcerns]
  });
}

function noScopeContext() {
  return {
    filesystemScopeContains: () => false,
    networkScopeContains: () => false
  };
}
