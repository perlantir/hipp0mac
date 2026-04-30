import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentPlan,
  GoalVerification,
  JsonValue,
  QualityMetricValue,
  QualityReport,
  RecommendedFix,
  RecoveryFailureType
} from "@operator-dock/protocol";
import {
  AgentPlanSchema,
  GoalVerificationSchema,
  QualityReportSchema
} from "@operator-dock/protocol";
import type { DatabaseConnection } from "../db/types.js";
import type { EventStore } from "../persistence/eventStore.js";
import type { CanonicalEventRecord } from "../persistence/eventStore.js";
import { LoopDetector } from "./loopDetection.js";
import { SelfImprovementAnalyzer } from "./selfImprovement.js";

export const defaultQualityWeights = {
  completionQuality: 0.35,
  stepEfficiency: 0.20,
  toolEfficiency: 0.15,
  recoveryEfficiency: 0.10,
  contextEfficiency: 0.10,
  redundancyScore: 0.05,
  userInterruptionScore: 0.05
} as const;

export type QualityWeights = typeof defaultQualityWeights;

export interface QualityScoreInput {
  metrics: QualityReport["metrics"];
  weights?: QualityWeights;
}

export interface QualityScoreOutput {
  metrics: QualityReport["metrics"];
  weights: QualityReport["weights"];
  overallScore: number;
}

export interface QualityAuditorDependencies {
  eventStore: EventStore;
  reports: QualityReportRepository;
  workspaceRoot: string;
}

export interface QualityAuditRequest {
  taskId: string;
  projectId?: string;
  taskType?: string;
}

export interface QualityReportRow {
  taskId: string;
  projectId?: string;
  completed: boolean;
  overallScore: number;
  report: QualityReport;
  artifactPath?: string;
}

export class QualityAuditor {
  constructor(private readonly dependencies: QualityAuditorDependencies) {}

  generateAndPersist(request: QualityAuditRequest): QualityReport {
    const events = this.dependencies.eventStore.readAll(request.taskId);
    const report = this.generate(request, events);
    const artifactPath = this.writeArtifact(report);
    this.dependencies.reports.saveWithHistory(report, {
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      artifactPath,
      ...(request.taskType === undefined ? {} : {
        history: {
          taskType: request.taskType,
          actualSteps: report.counts.totalSteps
        }
      })
    });
    this.dependencies.eventStore.append(request.taskId, "quality_report_final", {
      report: report as unknown as JsonValue,
      artifactPath
    });
    return report;
  }

  generate(request: QualityAuditRequest, events: CanonicalEventRecord[]): QualityReport {
    const plan = latestPlan(events);
    const goal = latestGoalVerification(events);
    const completed = events.some((event) => event.eventType === "loop_completed")
      && goal?.passed === true;
    const safetyViolation = events.some((event) =>
      event.eventType === "agent_loop_halted"
      && event.payload.reason === "injection_detected"
    );
    const counts = countsFromEvents(events, plan);
    const metrics = metricsFromEvents(events, plan, goal, completed, counts);
    const score = computeQualityScore({ metrics });
    const reportWithoutAnalysis = QualityReportSchema.parse({
      schemaVersion: 1,
      taskId: request.taskId,
      generatedAt: new Date().toISOString(),
      completed,
      safetyViolation,
      metrics: score.metrics,
      weights: score.weights,
      overallScore: score.overallScore,
      counts,
      rootCauseIfLowScore: null,
      recommendedFixes: [] as RecommendedFix[],
      qualityConcerns: qualityConcerns(events, score.overallScore)
    });
    const analysis = new SelfImprovementAnalyzer(this.dependencies.eventStore).analyze(request.taskId, reportWithoutAnalysis);
    const report = QualityReportSchema.parse({
      ...reportWithoutAnalysis,
      rootCauseIfLowScore: reportWithoutAnalysis.overallScore < 0.8 ? analysis.rootCauseIfLowScore : null,
      recommendedFixes: reportWithoutAnalysis.overallScore < 0.8 ? analysis.recommendedFixes : []
    });

    if (report.completed && metricValue(report.metrics.completionQuality) < 1) {
      this.dependencies.eventStore.append(request.taskId, "quality_inconsistency", {
        completionQuality: metricValue(report.metrics.completionQuality)
      });
    }

    return report;
  }

  private writeArtifact(report: QualityReport): string {
    const directory = join(this.dependencies.workspaceRoot, "artifacts", "quality_reports");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const artifactPath = join(directory, `${report.taskId}.json`);
    writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return artifactPath;
  }
}

export class QualityReportRepository {
  constructor(private readonly database: DatabaseConnection) {}

  save(report: QualityReport, options: { projectId?: string; artifactPath?: string } = {}): void {
    this.saveWithHistory(report, options);
  }

  saveWithHistory(
    report: QualityReport,
    options: {
      projectId?: string;
      artifactPath?: string;
      history?: { taskType: string; actualSteps: number };
    } = {}
  ): void {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO quality_reports (
            task_id,
            project_id,
            completed,
            overall_score,
            report_json,
            artifact_path,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            project_id = excluded.project_id,
            completed = excluded.completed,
            overall_score = excluded.overall_score,
            report_json = excluded.report_json,
            artifact_path = excluded.artifact_path,
            updated_at = excluded.updated_at
        `)
        .run(
          report.taskId,
          options.projectId ?? null,
          report.completed ? 1 : 0,
          report.overallScore,
          JSON.stringify(report),
          options.artifactPath ?? null,
          now,
          now
        );

      if (report.completed && options.history !== undefined) {
        upsertStepHistory(this.database, options.history.taskType, options.history.actualSteps, now);
      }
    });
    transaction();
  }

  get(taskId: string): QualityReportRow | undefined {
    const row = this.database
      .prepare(`
        SELECT task_id, project_id, completed, overall_score, report_json, artifact_path
        FROM quality_reports
        WHERE task_id = ?
      `)
      .get(taskId) as {
        task_id: string;
        project_id: string | null;
        completed: number;
        overall_score: number;
        report_json: string;
        artifact_path: string | null;
      } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      taskId: row.task_id,
      ...(row.project_id === null ? {} : { projectId: row.project_id }),
      completed: row.completed === 1,
      overallScore: row.overall_score,
      report: QualityReportSchema.parse(JSON.parse(row.report_json) as unknown),
      ...(row.artifact_path === null ? {} : { artifactPath: row.artifact_path })
    };
  }
}

function upsertStepHistory(database: DatabaseConnection, taskType: string, actualSteps: number, now: string): void {
  const existing = database
    .prepare(`
      SELECT mean, m2, sample_count
      FROM task_step_history
      WHERE task_type = ?
    `)
    .get(taskType) as { mean: number; m2: number; sample_count: number } | undefined;

  if (existing === undefined) {
    database
      .prepare(`
        INSERT INTO task_step_history (task_type, mean, m2, stddev, sample_count, updated_at)
        VALUES (?, ?, 0, 0, 1, ?)
      `)
      .run(taskType, actualSteps, now);
    return;
  }

  const sampleCount = existing.sample_count + 1;
  const delta = actualSteps - existing.mean;
  const mean = existing.mean + delta / sampleCount;
  const delta2 = actualSteps - mean;
  const m2 = existing.m2 + delta * delta2;
  const stddev = sampleCount > 1 ? Math.sqrt(m2 / (sampleCount - 1)) : 0;
  database
    .prepare(`
      UPDATE task_step_history
      SET mean = ?, m2 = ?, stddev = ?, sample_count = ?, updated_at = ?
      WHERE task_type = ?
    `)
    .run(mean, m2, stddev, sampleCount, now, taskType);
}

export function computeQualityScore(input: QualityScoreInput): QualityScoreOutput {
  const weights = input.weights ?? defaultQualityWeights;
  const nonNaEntries = Object.entries(input.metrics)
    .filter((entry): entry is [keyof QualityWeights, number] => entry[1] !== "N/A");
  const retainedWeight = nonNaEntries.reduce((sum, [key]) => sum + weights[key], 0);
  const redistributed = Object.fromEntries(
    Object.keys(weights).map((key) => [key, 0])
  ) as QualityReport["weights"];

  if (retainedWeight === 0) {
    redistributed.completionQuality = 1;
    return {
      metrics: input.metrics,
      weights: redistributed,
      overallScore: 0
    };
  }

  let overallScore = 0;
  for (const [key, value] of nonNaEntries) {
    const actualWeight = weights[key] / retainedWeight;
    redistributed[key] = actualWeight;
    overallScore += clamp(value) * actualWeight;
  }

  return {
    metrics: input.metrics,
    weights: redistributed,
    overallScore: clamp(overallScore)
  };
}

export function metricValue(value: QualityMetricValue): number {
  return value === "N/A" ? 0 : value;
}

function metricsFromEvents(
  events: CanonicalEventRecord[],
  plan: AgentPlan | null,
  goal: GoalVerification | null,
  completed: boolean,
  counts: QualityReport["counts"]
): QualityReport["metrics"] {
  const totalToolCalls = events.filter((event) => event.eventType === "tool_call_result").length;
  const passedSteps = new Set(events
    .filter((event) => event.eventType === "step_verification" && event.payload.passed === true && typeof event.payload.stepId === "string")
    .map((event) => event.payload.stepId as string));
  const correctCalls = events
    .filter((event) => event.eventType === "tool_call_result")
    .filter((event) => typeof event.payload.stepId !== "string" || passedSteps.has(event.payload.stepId))
    .length;
  const successfulRecoveries = events
    .filter((event) => event.eventType === "recovery_decision")
    .filter((event) => event.payload.nextStepOverride === null || passedSteps.has(String(event.payload.nextStepOverride)))
    .length;
  const contextItems = contextItemsFrom(events);
  const usedContextItems = new Set<string>();
  const evidenceRefs = events.flatMap((event) => Array.isArray(event.payload.evidenceRefs)
    ? event.payload.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
    : []);
  for (const item of contextItems) {
    if (evidenceRefs.includes(item.eventRef) || evidenceRefs.includes(item.itemId)) {
      usedContextItems.add(item.itemId);
    }
  }
  const userAskEvents = events.filter((event) => event.eventType === "user_intervention");
  const necessaryAsks = userAskEvents.filter((event) =>
    ["blocked", "ambiguous", "unsafe", "approval_required"].includes(String(event.payload.intent ?? ""))
  ).length;

  return {
    stepEfficiency: counts.expectedStepEstimate === null || counts.totalSteps === 0
      ? "N/A"
      : clamp(counts.expectedStepEstimate / counts.totalSteps),
    toolEfficiency: totalToolCalls === 0 ? "N/A" : clamp(correctCalls / totalToolCalls),
    recoveryEfficiency: counts.recoveryAttemptCount === 0
      ? "N/A"
      : clamp(successfulRecoveries / counts.recoveryAttemptCount),
    contextEfficiency: contextItems.length === 0 ? "N/A" : clamp(usedContextItems.size / contextItems.length),
    userInterruptionScore: userAskEvents.length === 0 ? 1 : clamp(necessaryAsks / userAskEvents.length),
    redundancyScore: clamp(1 - (counts.repeatedStepCount / Math.max(counts.totalSteps, 1))),
    completionQuality: completionQuality(plan, goal, completed)
  };
}

function countsFromEvents(events: CanonicalEventRecord[], plan: AgentPlan | null): QualityReport["counts"] {
  const detector = new LoopDetector();
  const loop = detector.analyze(events.map((event) => ({ eventType: event.eventType, payload: event.payload })));
  const totalSteps = events.filter((event) => event.eventType === "step_verification").length;
  const failedToolCallCount = events.filter((event) =>
    event.eventType === "tool_call_result"
    && (event.payload.ok === false || event.payload.status === "error")
  ).length;
  const recoveryAttemptCount = events.filter((event) => event.eventType === "recovery_decision").length;
  const injectionDetectionCount = events.filter((event) =>
    event.eventType === "injection_detected"
    || (event.eventType === "agent_loop_halted" && event.payload.reason === "injection_detected")
  ).length;
  const doubleVerificationCount = events.filter((event) =>
    event.eventType === "step_verification"
    && Array.isArray(event.payload.evidenceRefs)
    && event.payload.evidenceRefs.length > 1
  ).length;
  const verifierDisagreementCount = events.filter((event) =>
    event.eventType === "recovery_decision"
    && event.payload.failureType === "verifier_disagreement"
  ).length;
  const unnecessaryUserQuestionCount = events.filter((event) =>
    event.eventType === "user_intervention"
    && !["blocked", "ambiguous", "unsafe", "approval_required"].includes(String(event.payload.intent ?? ""))
  ).length;

  return {
    totalSteps,
    expectedStepEstimate: plan?.expectedStepEstimate ?? null,
    repeatedStepCount: loop.repeatedStepCount,
    unnecessaryToolCallCount: loop.repeatedStepCount,
    unnecessaryUserQuestionCount,
    failedToolCallCount,
    recoveryAttemptCount,
    injectionDetectionCount,
    doubleVerificationCount,
    verifierDisagreementCount
  };
}

function latestPlan(events: CanonicalEventRecord[]): AgentPlan | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if ((event.eventType === "plan_generated" || event.eventType === "plan_revised") && event.payload.plan !== undefined) {
      return AgentPlanSchema.parse(event.payload.plan);
    }
  }
  return null;
}

function latestGoalVerification(events: CanonicalEventRecord[]): GoalVerification | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.eventType === "goal_verification") {
      return GoalVerificationSchema.parse(event.payload);
    }
  }
  return null;
}

function completionQuality(
  plan: AgentPlan | null,
  goal: GoalVerification | null,
  completed: boolean
): QualityMetricValue {
  if (!completed) {
    return 0;
  }
  if (plan === null || goal === null) {
    return 0;
  }
  const metCount = [
    ...goal.successCriteriaMet,
    ...goal.doneConditionsMet
  ].filter((item) => item.met && item.evidenceRefs.length > 0).length;
  const totalCount = plan.successCriteria.length + plan.doneConditions.length;
  return totalCount === 0 ? 1 : clamp(metCount / totalCount);
}

function contextItemsFrom(events: CanonicalEventRecord[]): Array<{ itemId: string; eventRef: string }> {
  const items: Array<{ itemId: string; eventRef: string }> = [];
  for (const event of events) {
    if (event.eventType !== "context_pack_built" || !Array.isArray(event.payload.items)) {
      continue;
    }
    for (const item of event.payload.items) {
      if (isRecord(item) && typeof item.itemId === "string" && typeof item.eventRef === "string") {
        items.push({ itemId: item.itemId, eventRef: item.eventRef });
      }
    }
  }
  return items;
}

function qualityConcerns(events: CanonicalEventRecord[], overallScore: number): string[] {
  const concerns = events.flatMap((event) => Array.isArray(event.payload.qualityConcerns)
    ? event.payload.qualityConcerns.filter((entry): entry is string => typeof entry === "string")
    : []);
  if (overallScore < 0.8) {
    concerns.push("overallScore below pass threshold.");
  }
  return [...new Set(concerns)];
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function primaryFailureType(events: CanonicalEventRecord[]): RecoveryFailureType | null {
  const counts = new Map<RecoveryFailureType, number>();
  for (const event of events) {
    if (event.eventType !== "recovery_decision" || typeof event.payload.failureType !== "string") {
      continue;
    }
    const failureType = event.payload.failureType as RecoveryFailureType;
    counts.set(failureType, (counts.get(failureType) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}
