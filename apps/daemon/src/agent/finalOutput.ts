import { createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import type {
  AgentPlan,
  ArtifactKind,
  FailureOutput,
  FinalOutput,
  FinalOutputArtifact,
  GoalVerification,
  QualityReport
} from "@operator-dock/protocol";
import {
  FailureOutputSchema,
  FinalOutputArtifactSchema,
  FinalOutputSchema
} from "@operator-dock/protocol";

export interface FinalOutputInput {
  taskId: string;
  plan: AgentPlan;
  verification: GoalVerification;
  qualityReport: QualityReport;
  summary: string;
  artifacts: FinalOutputArtifact[];
  limitations: string[];
  skippedItems: Array<{ item: string; reason: string }>;
  nextSuggestedActions: string[];
}

export interface FailureOutputInput {
  taskId: string;
  plan: AgentPlan;
  verification: GoalVerification;
  qualityReport: QualityReport;
  partialSummary: string;
  partialArtifacts: FinalOutputArtifact[];
  failedSteps: Array<{ stepId: string; reason: string; evidenceRefs: string[] }>;
  recommendedNextActions: string[];
}

export function assembleFinalOutput(input: FinalOutputInput): FinalOutput {
  return FinalOutputSchema.parse({
    schemaVersion: 1,
    taskId: input.taskId,
    generatedAt: new Date().toISOString(),
    summary: input.summary,
    artifacts: input.artifacts,
    successCriteria: input.plan.successCriteria.map((criterion) => {
      const verification = input.verification.successCriteriaMet.find((item) => item.criterionId === criterion.id);
      return {
        criterion: criterion.description,
        met: verification?.met ?? false,
        evidenceRefs: verification?.evidenceRefs ?? []
      };
    }),
    doneConditions: input.plan.doneConditions.map((condition) => {
      const verification = input.verification.doneConditionsMet.find((item) => item.conditionId === condition.id);
      return {
        condition: condition.description,
        met: verification?.met ?? false,
        evidenceRefs: verification?.evidenceRefs ?? []
      };
    }),
    limitations: input.limitations,
    skippedItems: input.skippedItems,
    qualityReport: input.qualityReport,
    nextSuggestedActions: input.nextSuggestedActions
  });
}

export function assembleFailureOutput(input: FailureOutputInput): FailureOutput {
  return FailureOutputSchema.parse({
    schemaVersion: 1,
    taskId: input.taskId,
    generatedAt: new Date().toISOString(),
    partialSummary: input.partialSummary,
    partialArtifacts: input.partialArtifacts,
    successCriteria: input.plan.successCriteria.map((criterion) => {
      const verification = input.verification.successCriteriaMet.find((item) => item.criterionId === criterion.id);
      return {
        criterion: criterion.description,
        met: verification?.met ?? false,
        evidenceRefs: verification?.evidenceRefs ?? []
      };
    }),
    doneConditions: input.plan.doneConditions.map((condition) => {
      const verification = input.verification.doneConditionsMet.find((item) => item.conditionId === condition.id);
      return {
        condition: condition.description,
        met: verification?.met ?? false,
        evidenceRefs: verification?.evidenceRefs ?? []
      };
    }),
    failedSteps: input.failedSteps,
    qualityReport: input.qualityReport,
    recommendedNextActions: input.recommendedNextActions
  });
}

export function hashFileArtifact(id: string, path: string, kind: ArtifactKind): FinalOutputArtifact {
  const file = readFileSync(path);
  const stats = statSync(path);
  return FinalOutputArtifactSchema.parse({
    id,
    path,
    kind,
    sizeBytes: stats.size,
    hash: createHash("sha256").update(file).digest("hex")
  });
}
