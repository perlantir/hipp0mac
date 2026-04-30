import type { AgentPlan } from "@operator-dock/protocol";
import type { DatabaseConnection } from "../db/types.js";

export interface TaskStepHistoryRow {
  taskType: string;
  mean: number;
  stddev: number;
  sampleCount: number;
}

export interface ExpectedStepEstimatorOptions {
  evalNorms?: Record<string, number>;
  heuristicEnabled?: boolean;
  estimatorModel?: (input: ExpectedStepEstimateInput) => number | null | Promise<number | null>;
}

export interface ExpectedStepEstimateInput {
  taskType: string;
  plan: AgentPlan;
}

export class TaskStepHistoryRepository {
  constructor(private readonly database: DatabaseConnection) {}

  get(taskType: string): TaskStepHistoryRow | undefined {
    const row = this.database
      .prepare(`
        SELECT task_type, mean, stddev, sample_count
        FROM task_step_history
        WHERE task_type = ?
      `)
      .get(taskType) as { task_type: string; mean: number; stddev: number; sample_count: number } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      taskType: row.task_type,
      mean: row.mean,
      stddev: row.stddev,
      sampleCount: row.sample_count
    };
  }

  recordCompletedTask(taskType: string, actualSteps: number): void {
    if (!Number.isFinite(actualSteps) || actualSteps < 0) {
      throw new Error("actualSteps must be a nonnegative finite number.");
    }
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const existing = this.database
        .prepare(`
          SELECT mean, m2, sample_count
          FROM task_step_history
          WHERE task_type = ?
        `)
        .get(taskType) as { mean: number; m2: number; sample_count: number } | undefined;
      if (existing === undefined) {
        this.database
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
      this.database
        .prepare(`
          UPDATE task_step_history
          SET mean = ?, m2 = ?, stddev = ?, sample_count = ?, updated_at = ?
          WHERE task_type = ?
        `)
        .run(mean, m2, stddev, sampleCount, now, taskType);
    });
    transaction();
  }
}

export class ExpectedStepEstimator {
  private readonly evalNorms: Record<string, number>;
  private readonly heuristicEnabled: boolean;

  constructor(
    private readonly history: TaskStepHistoryRepository,
    private readonly options: ExpectedStepEstimatorOptions = {}
  ) {
    this.evalNorms = options.evalNorms ?? {};
    this.heuristicEnabled = options.heuristicEnabled ?? true;
  }

  estimate(input: ExpectedStepEstimateInput): number | null {
    const historical = this.history.get(input.taskType);
    if (historical !== undefined && historical.sampleCount >= 10) {
      return Math.max(1, Math.round(historical.mean));
    }

    const benchmark = this.evalNorms[input.taskType];
    if (benchmark !== undefined) {
      return Math.max(1, Math.round(benchmark));
    }

    if (this.heuristicEnabled) {
      return heuristicEstimate(input.plan);
    }

    return null;
  }
}

export function heuristicEstimate(plan: Pick<AgentPlan, "doneConditions" | "expectedArtifacts" | "taskGoal">): number {
  const goalSignals = plan.taskGoal
    .split(/(?:\s+|[,.;:!?()[\]{}]+)/)
    .filter((part) => part.trim().length > 0);
  const goalComplexity = goalSignals.length >= 12 ? 2 : goalSignals.length >= 6 ? 1 : 0;
  return Math.max(1, 2 + plan.doneConditions.length + plan.expectedArtifacts.length + goalComplexity);
}
