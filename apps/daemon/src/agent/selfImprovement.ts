import type {
  QualityReport,
  RecommendedFix,
  RecoveryFailureType
} from "@operator-dock/protocol";
import type { EventStore } from "../persistence/eventStore.js";

export type RootCause =
  | "planning"
  | "tool_misuse"
  | "context"
  | "verifier"
  | "recovery"
  | "safety"
  | "unnecessary_steps"
  | "unnecessary_user_interruption"
  | "injection"
  | "model_output"
  | "unknown";

export interface SelfImprovementAnalysis {
  rootCauseIfLowScore: RootCause;
  recommendedFixes: RecommendedFix[];
}

export class SelfImprovementAnalyzer {
  constructor(private readonly eventStore: EventStore) {}

  analyze(taskId: string, report: QualityReport): SelfImprovementAnalysis {
    const events = this.eventStore.readAll(taskId);
    const recoveryEvents = events.filter((event) => event.eventType === "recovery_decision");
    const primary = primaryRecoveryFailure(recoveryEvents);
    const rootCause = rootCauseFor(primary, report);
    const evidenceRefs = recoveryEvents.map((event) => event.eventId);
    const fallbackEvidence = events.at(-1)?.eventId;
    const refs = evidenceRefs.length > 0 ? evidenceRefs : fallbackEvidence === undefined ? [] : [fallbackEvidence];
    const existingFixes = report.recommendedFixes.filter((fix) =>
      fix.evidenceRefs.every((ref) => events.some((event) => event.eventId === ref))
    );

    return {
      rootCauseIfLowScore: rootCause,
      recommendedFixes: existingFixes.length > 0 ? existingFixes : refs.length === 0 ? [] : [{
        targetComponent: componentFor(rootCause),
        changeType: rootCause === "safety" ? "predicate_change" : "logic_change",
        rationale: rationaleFor(rootCause),
        evidenceRefs: refs
      }]
    };
  }
}

function primaryRecoveryFailure(
  events: Array<{ payload: Record<string, unknown> }>
): RecoveryFailureType | null {
  const counts = new Map<RecoveryFailureType, number>();
  for (const event of events) {
    if (typeof event.payload.failureType !== "string") {
      continue;
    }
    const failureType = event.payload.failureType as RecoveryFailureType;
    counts.set(failureType, (counts.get(failureType) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function rootCauseFor(failureType: RecoveryFailureType | null, report: QualityReport): RootCause {
  if (report.counts.injectionDetectionCount > 0 || failureType === "injection_detected") {
    return "injection";
  }
  if (failureType === "safety_block") {
    return "safety";
  }
  if (failureType === "context_loss") {
    return "context";
  }
  if (failureType === "verifier_disagreement") {
    return "verifier";
  }
  if (failureType === "model_error") {
    return "model_output";
  }
  if (failureType === "tool_failure" || report.counts.failedToolCallCount > 0) {
    return "tool_misuse";
  }
  if (failureType === "repeated_step_loop" || report.counts.repeatedStepCount > 0) {
    return "unnecessary_steps";
  }
  if (failureType === "excessive_user_interruption" || report.counts.unnecessaryUserQuestionCount > 0) {
    return "unnecessary_user_interruption";
  }
  if (report.counts.recoveryAttemptCount > 0 && metric(report.metrics.recoveryEfficiency) === 0) {
    return "recovery";
  }
  if (metric(report.metrics.completionQuality) < 1) {
    return "planning";
  }
  return "unknown";
}

function componentFor(rootCause: RootCause): RecommendedFix["targetComponent"] {
  switch (rootCause) {
  case "planning": return "planner";
  case "tool_misuse": return "executor";
  case "context": return "context";
  case "verifier": return "verifier";
  case "recovery": return "recovery";
  case "safety": return "safety";
  case "unnecessary_steps": return "planner";
  case "unnecessary_user_interruption": return "planner";
  case "injection": return "safety";
  case "model_output": return "model_adapter";
  case "unknown": return "other";
  }
}

function rationaleFor(rootCause: RootCause): string {
  return `Quality analysis identified ${rootCause} as the most likely root cause.`;
}

function metric(value: QualityReport["metrics"][keyof QualityReport["metrics"]]): number {
  return value === "N/A" ? 0 : value;
}
