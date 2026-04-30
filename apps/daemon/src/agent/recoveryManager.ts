import type {
  JsonValue,
  RecoveryClassification,
  RecoveryDecision,
  RecoveryFailureType,
  RecoveryStrategy,
  SafetyDecisionValue,
  ToolExecutionStatus
} from "@operator-dock/protocol";
import {
  RecoveryClassificationSchema,
  RecoveryDecisionSchema
} from "@operator-dock/protocol";
import type { DatabaseConnection } from "../db/types.js";
import type { EventStore } from "../persistence/eventStore.js";

export interface FailureSignal {
  stepId?: string;
  sourceEventId?: string;
  validationError?: boolean;
  toolStatus?: ToolExecutionStatus | "error" | "ok" | "failed";
  toolOk?: boolean;
  errorCode?: string;
  errorMessage?: string;
  noEffect?: boolean;
  contextMissing?: boolean;
  modelError?: boolean;
  authRequired?: boolean;
  timedOut?: boolean;
  safetyDecision?: SafetyDecisionValue | "deny";
  injectionDetected?: boolean;
  loopFailureType?: "repeated_step_loop" | "no_progress_loop";
  lowQualityPath?: boolean;
  excessiveUserInterruption?: boolean;
  recordSchemaVersion?: number;
  knownSchemaVersion?: number;
  verifierDisagreement?: boolean;
}

export interface RecoveryManagerDependencies {
  eventStore: EventStore;
  effectiveness: StrategyEffectivenessRepository;
  userInterruptionBudget?: number;
}

export interface StrategyEffectivenessRow {
  failureType: RecoveryFailureType;
  strategy: RecoveryStrategy;
  successCount: number;
  totalCount: number;
}

export const recoveryStrategyChain: Record<RecoveryFailureType, RecoveryStrategy[]> = {
  validation_error: ["retry_modified_input", "switch_tool", "fail_gracefully"],
  tool_failure: ["retry_same_tool", "retry_modified_input", "switch_tool"],
  no_effect: ["re_evaluate_context", "replan_subgraph"],
  context_loss: ["re_evaluate_context", "replan_subgraph"],
  model_error: ["retry_same_tool", "fail_gracefully"],
  auth_required: ["ask_user"],
  timeout: ["retry_modified_input", "switch_tool"],
  safety_block: ["replan_subgraph"],
  injection_detected: ["stop_for_safety"],
  repeated_step_loop: ["replan_subgraph"],
  no_progress_loop: ["replan_subgraph", "ask_user"],
  low_quality_path: ["replan_subgraph"],
  excessive_user_interruption: ["fail_gracefully"],
  schema_version_mismatch: ["fail_gracefully"],
  verifier_disagreement: ["re_evaluate_context", "replan_subgraph"],
  unknown: ["fail_gracefully"]
};

const retryCaps: Record<RecoveryStrategy, number> = {
  retry_same_tool: 2,
  retry_modified_input: 2,
  switch_tool: 2,
  re_evaluate_context: 1,
  replan_subgraph: 3,
  ask_user: 1,
  fail_gracefully: Number.POSITIVE_INFINITY,
  stop_for_safety: Number.POSITIVE_INFINITY
};

export class RecoveryManager {
  constructor(private readonly dependencies: RecoveryManagerDependencies) {}

  classify(taskId: string, signal: FailureSignal): RecoveryClassification {
    const classification = classifyFailure(signal);
    if (classification.failureType === "unknown") {
      this.dependencies.eventStore.append(taskId, "recovery_classification_miss", {
        classifiedReason: classification.classifiedReason,
        sourceEventId: classification.sourceEventId
      });
    } else {
      this.dependencies.eventStore.append(taskId, "recovery_classification", classification as unknown as Record<string, JsonValue>);
    }
    return classification;
  }

  decide(taskId: string, signal: FailureSignal): RecoveryDecision {
    const classification = this.classify(taskId, signal);
    const events = this.dependencies.eventStore.readAll(taskId);
    const stepId = signal.stepId ?? null;
    const attempts = recoveryAttemptsByStepAndStrategy(events, stepId);
    const taskReplanAttempts = events.filter((event) =>
      event.eventType === "recovery_decision"
      && event.payload.strategy === "replan_subgraph"
    ).length;
    const askUserAttempts = events.filter((event) =>
      event.eventType === "recovery_decision"
      && event.payload.strategy === "ask_user"
    ).length;
    const selected = strategyForFailureType(
      classification.failureType,
      attempts,
      stepId,
      taskReplanAttempts,
      askUserAttempts,
      this.dependencies.userInterruptionBudget ?? 1
    );
    const retryCount = selected.previousCount + 1;
    const capReached = retryCount >= selected.cap;
    const decision = RecoveryDecisionSchema.parse({
      failureType: classification.failureType,
      classifiedReason: classification.classifiedReason,
      strategy: selected.strategy,
      retryCount,
      capReached,
      nextStepOverride: stepIdForStrategy(selected.strategy, stepId),
      escalationRequired: selected.strategy === "ask_user"
        || selected.strategy === "fail_gracefully"
        || selected.strategy === "stop_for_safety",
      rationale: rationaleFor(classification.failureType, selected.strategy, retryCount, selected.cap)
    });

    this.dependencies.eventStore.append(taskId, "recovery_decision", decision as unknown as Record<string, JsonValue>);
    return decision;
  }

  recordEffectiveness(failureType: RecoveryFailureType, strategy: RecoveryStrategy, succeeded: boolean): void {
    this.dependencies.effectiveness.record(failureType, strategy, succeeded);
  }
}

export class StrategyEffectivenessRepository {
  constructor(private readonly database: DatabaseConnection) {}

  record(failureType: RecoveryFailureType, strategy: RecoveryStrategy, succeeded: boolean): void {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO strategy_effectiveness (
            failure_type,
            strategy,
            success_count,
            total_count,
            updated_at
          ) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(failure_type, strategy) DO UPDATE SET
            success_count = success_count + excluded.success_count,
            total_count = total_count + 1,
            updated_at = excluded.updated_at
        `)
        .run(failureType, strategy, succeeded ? 1 : 0, now);
    });
    transaction();
  }

  get(failureType: RecoveryFailureType, strategy: RecoveryStrategy): StrategyEffectivenessRow | undefined {
    const row = this.database
      .prepare(`
        SELECT failure_type, strategy, success_count, total_count
        FROM strategy_effectiveness
        WHERE failure_type = ? AND strategy = ?
      `)
      .get(failureType, strategy) as {
        failure_type: RecoveryFailureType;
        strategy: RecoveryStrategy;
        success_count: number;
        total_count: number;
      } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      failureType: row.failure_type,
      strategy: row.strategy,
      successCount: row.success_count,
      totalCount: row.total_count
    };
  }
}

export function classifyFailure(signal: FailureSignal): RecoveryClassification {
  const sourceEventId = signal.sourceEventId ?? null;
  const error = `${signal.errorCode ?? ""} ${signal.errorMessage ?? ""}`.toLowerCase();
  const knownSchemaVersion = signal.knownSchemaVersion ?? 1;
  const recordSchemaVersion = signal.recordSchemaVersion ?? knownSchemaVersion;

  if (recordSchemaVersion > knownSchemaVersion) {
    return classification("schema_version_mismatch", "Record schema version exceeds the daemon's known maximum.", sourceEventId, 1);
  }
  if (signal.injectionDetected === true) {
    return classification("injection_detected", "Injection detector triggered.", sourceEventId, 1);
  }
  if (signal.safetyDecision === "deny" || error.includes("denied") || error.includes("safety")) {
    return classification("safety_block", "Safety Governor denied the action.", sourceEventId, 0.95);
  }
  if (signal.verifierDisagreement === true) {
    return classification("verifier_disagreement", "Double verification produced a mismatch.", sourceEventId, 0.95);
  }
  if (signal.loopFailureType === "repeated_step_loop") {
    return classification("repeated_step_loop", "Repeated step loop detected.", sourceEventId, 0.95);
  }
  if (signal.loopFailureType === "no_progress_loop") {
    return classification("no_progress_loop", "No-progress loop detected.", sourceEventId, 0.95);
  }
  if (signal.authRequired === true || error.includes("auth") || error.includes("credential") || error.includes("keychain")) {
    return classification("auth_required", "Tool or model requires authentication that is not available.", sourceEventId, 0.9);
  }
  if (signal.timedOut === true || signal.toolStatus === "timed_out" || error.includes("timeout") || error.includes("timed out")) {
    return classification("timeout", "Operation exceeded its timeout policy.", sourceEventId, 0.9);
  }
  if (signal.modelError === true || error.includes("model") || error.includes("provider")) {
    return classification("model_error", "Model provider or schema generation failed.", sourceEventId, 0.85);
  }
  if (signal.validationError === true || error.includes("validation") || error.includes("schema")) {
    return classification("validation_error", "Tool input or output failed schema validation.", sourceEventId, 0.85);
  }
  if (signal.contextMissing === true || error.includes("context")) {
    return classification("context_loss", "Required context was missing or compacted away.", sourceEventId, 0.8);
  }
  if (signal.noEffect === true) {
    return classification("no_effect", "Tool succeeded but the expected change was absent.", sourceEventId, 0.85);
  }
  if (signal.lowQualityPath === true) {
    return classification("low_quality_path", "Verifier flagged quality concerns below threshold.", sourceEventId, 0.8);
  }
  if (signal.excessiveUserInterruption === true) {
    return classification("excessive_user_interruption", "User-interruption budget was exceeded.", sourceEventId, 0.8);
  }
  if (signal.toolOk === false || signal.toolStatus === "failed" || signal.toolStatus === "error") {
    return classification("tool_failure", "Tool returned an error status.", sourceEventId, 0.9);
  }

  return classification("unknown", "Failure classifier could not determine a known failure type.", sourceEventId, 0);
}

export function strategyForFailureType(
  failureType: RecoveryFailureType,
  attemptsByStepAndStrategy: Map<string, number>,
  stepId: string | null,
  taskReplanAttempts: number,
  askUserAttempts = 0,
  userInterruptionBudget = 1
): { strategy: RecoveryStrategy; previousCount: number; cap: number } {
  for (const strategy of recoveryStrategyChain[failureType]) {
    if (strategy === "ask_user" && askUserAttempts >= userInterruptionBudget) {
      continue;
    }
    const cap = capFor(strategy);
    const count = strategy === "replan_subgraph"
      ? taskReplanAttempts
      : attemptsByStepAndStrategy.get(strategyKey(stepId, strategy)) ?? 0;
    if (count < cap) {
      return { strategy, previousCount: count, cap };
    }
  }

  if (askUserAttempts < userInterruptionBudget && failureType !== "injection_detected" && failureType !== "excessive_user_interruption") {
    return { strategy: "ask_user", previousCount: askUserAttempts, cap: userInterruptionBudget };
  }
  return { strategy: "fail_gracefully", previousCount: 0, cap: Number.POSITIVE_INFINITY };
}

function classification(
  failureType: RecoveryFailureType,
  classifiedReason: string,
  sourceEventId: string | null,
  confidence: number
): RecoveryClassification {
  return RecoveryClassificationSchema.parse({
    failureType,
    classifiedReason,
    confidence,
    sourceEventId
  });
}

function recoveryAttemptsByStepAndStrategy(
  events: Array<{ eventType: string; payload: Record<string, JsonValue> }>,
  stepId: string | null
): Map<string, number> {
  const attempts = new Map<string, number>();
  for (const event of events) {
    if (event.eventType !== "recovery_decision" || typeof event.payload.strategy !== "string") {
      continue;
    }
    const eventStepId = typeof event.payload.nextStepOverride === "string" ? event.payload.nextStepOverride : stepId;
    const key = strategyKey(eventStepId, event.payload.strategy as RecoveryStrategy);
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
  }
  return attempts;
}

function strategyKey(stepId: string | null, strategy: RecoveryStrategy): string {
  return `${stepId ?? "task"}:${strategy}`;
}

function capFor(strategy: RecoveryStrategy): number {
  return retryCaps[strategy];
}

function stepIdForStrategy(strategy: RecoveryStrategy, stepId: string | null): string | null {
  if (strategy === "fail_gracefully" || strategy === "ask_user" || strategy === "stop_for_safety") {
    return null;
  }
  return stepId;
}

function rationaleFor(
  failureType: RecoveryFailureType,
  strategy: RecoveryStrategy,
  retryCount: number,
  cap: number
): string {
  const capText = Number.isFinite(cap) ? `${retryCount}/${cap}` : `${retryCount}`;
  return `Selected ${strategy} for ${failureType}; attempt ${capText}.`;
}
