import type { AgentPlan, AgentStep } from "@operator-dock/protocol";

export interface StepExecutionState {
  completed: Set<string>;
  failed: Set<string>;
}

export type StepSelection =
  | { kind: "step"; step: AgentStep }
  | { kind: "goal"; step?: undefined };

const riskRank = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
} as const;

export function selectNextStep(plan: AgentPlan, state: StepExecutionState): StepSelection {
  const incomplete = plan.steps.filter((step) => !state.completed.has(step.stepId) && !state.failed.has(step.stepId));
  if (incomplete.length === 0) {
    return { kind: "goal" };
  }

  const candidates = incomplete.filter((step) =>
    step.dependsOn.length > 0
      ? step.dependsOn.every((dependency) => state.completed.has(dependency))
      : true
  );
  if (candidates.length === 0) {
    throw new Error("Step selection deadlock: incomplete steps remain but no dependency-satisfied steps are eligible.");
  }

  const [step] = candidates.sort((left, right) =>
    riskRank[left.riskLevel] - riskRank[right.riskLevel]
    || right.estimatedValue - left.estimatedValue
    || left.stepId.localeCompare(right.stepId)
  );

  return { kind: "step", step: step! };
}
