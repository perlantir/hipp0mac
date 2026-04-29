import { createHash, randomUUID } from "node:crypto";
import type { DatabaseConnection } from "../../db/types.js";
import {
  ToolEventRecordSchema,
  ToolResultSchema,
  type JsonValue,
  type OperatorEvent,
  type SafetyDecisionValue,
  type ToolEventRecord,
  type ToolEventType,
  type ToolExecutionStatus,
  type ToolResult,
  type ToolRiskLevel,
  type ToolCapabilityManifest
} from "@operator-dock/protocol";
import type { EventStore } from "../../persistence/eventStore.js";
import { canonicalJson } from "../../persistence/canonicalJson.js";
import type { EventBus } from "../../websocket/eventBus.js";

export interface CreateExecutionInput {
  taskId: string;
  toolName: string;
  input: Record<string, JsonValue>;
  riskLevel: ToolRiskLevel;
  workspaceRoot?: string;
  idempotencyKey?: string;
}

export interface StartExecutionInput {
  manifest: ToolCapabilityManifest;
  resolvedInput: Record<string, JsonValue>;
  safetyDecision: {
    eventId: string;
    decision: SafetyDecisionValue;
  };
  scopeChecks: JsonValue;
  timeoutMs: number;
  lockEventId: string;
  idempotencyKey?: string;
  approvalEventId?: string;
}

interface ToolExecutionRow {
  id: string;
  tool_name: string;
  status: ToolExecutionStatus;
  risk_level: ToolRiskLevel;
  output_json: string | null;
  error_code: string | null;
  error_message: string | null;
  raw_output_ref: string | null;
  replay_json: string;
  task_id: string | null;
  intended_event_id: string | null;
  result_event_id: string | null;
  lock_event_id: string | null;
}

interface ToolEventRow {
  id: string;
  execution_id: string;
  tool_name: string;
  event_type: ToolEventType;
  payload_json: string;
  created_at: string;
}

export class ToolEventStore {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly eventBus: EventBus,
    private readonly eventStore: EventStore
  ) {}

  createExecution(input: CreateExecutionInput): ToolResult {
    return this.createPendingExecution(input, "running");
  }

  createPendingExecution(input: CreateExecutionInput, status: ToolExecutionStatus = "pending"): ToolResult {
    const now = new Date().toISOString();
    const executionId = randomUUID();
    const replay = {
      taskId: input.taskId,
      inputHash: hashJson(input.input),
      workspaceRoot: input.workspaceRoot,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      startedAt: now,
      attempts: 1
    };

    this.database
      .prepare(`
        INSERT INTO tool_executions (
          id,
          tool_name,
          status,
          risk_level,
          input_json,
          replay_json,
          legacy,
          task_id,
          lock_event_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `)
      .run(
        executionId,
        input.toolName,
        status,
        input.riskLevel,
        JSON.stringify(input.input),
        JSON.stringify(replay),
        0,
        input.taskId,
        now,
        now
      );

    return {
      executionId,
      toolName: input.toolName,
      status,
      riskLevel: input.riskLevel,
      ok: false,
      events: [],
      replay
    };
  }

  startExecution(result: ToolResult, input: StartExecutionInput): ToolResult {
    const intendedEventId = this.eventStore.append(result.replay.taskId ?? "tool-runtime", "tool_call_intended", {
      executionId: result.executionId,
      toolName: input.manifest.name,
      toolVersion: input.manifest.version,
      idempotencyKey: input.idempotencyKey ?? null,
      resolvedInput: input.resolvedInput,
      safetyDecision: {
        eventId: input.safetyDecision.eventId,
        decision: input.safetyDecision.decision
      },
      ...(input.approvalEventId === undefined ? {} : { approvalEventId: input.approvalEventId }),
      scopeChecks: input.scopeChecks,
      timeoutMs: input.timeoutMs,
      lockEventId: input.lockEventId
    });
    const replay = {
      ...result.replay,
      lockEventId: input.lockEventId,
      intendedEventId,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey })
    };

    this.database
      .prepare(`
        UPDATE tool_executions
        SET
          status = 'running',
          replay_json = ?,
          intended_event_id = ?,
          lock_event_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(replay), intendedEventId, input.lockEventId, new Date().toISOString(), result.executionId);

    return {
      ...result,
      status: "running",
      replay
    };
  }

  appendCanonical(taskId: string, eventType: string, payload: Record<string, JsonValue> = {}): string {
    return this.eventStore.append(taskId, eventType, payload);
  }

  canonicalEvents(taskId: string) {
    return this.eventStore.readAll(taskId);
  }

  canonicalTaskIds(): string[] {
    return this.eventStore.listTaskIds();
  }

  getExecution(executionId: string): ToolResult | undefined {
    const row = this.database
      .prepare(`
        SELECT
          id,
          tool_name,
          status,
          risk_level,
          output_json,
          error_code,
          error_message,
          raw_output_ref,
          replay_json,
          task_id,
          intended_event_id,
          result_event_id,
          lock_event_id
        FROM tool_executions
        WHERE id = ?
      `)
      .get(executionId) as ToolExecutionRow | undefined;

    if (row === undefined) {
      return undefined;
    }

    const events = this.database
      .prepare(`
        SELECT id, execution_id, tool_name, event_type, payload_json, created_at
        FROM tool_events
        WHERE execution_id = ?
        ORDER BY created_at ASC
      `)
      .all(executionId) as unknown as ToolEventRow[];

    return ToolResultSchema.parse({
      executionId: row.id,
      toolName: row.tool_name,
      status: row.status,
      riskLevel: row.risk_level,
      ok: row.status === "completed",
      ...(row.output_json === null ? {} : { output: JSON.parse(row.output_json) as JsonValue }),
      ...(row.error_code === null || row.error_message === null
        ? {}
        : {
          error: {
            code: row.error_code,
            message: row.error_message
          }
        }),
      ...(row.raw_output_ref === null ? {} : { rawOutputRef: row.raw_output_ref }),
      events: events.map((event) => ToolEventRecordSchema.parse({
        id: event.id,
        executionId: event.execution_id,
        toolName: event.tool_name,
        type: event.event_type,
        createdAt: event.created_at,
        payload: JSON.parse(event.payload_json) as Record<string, JsonValue>
      })),
      replay: JSON.parse(row.replay_json) as JsonValue
    });
  }

  recordEvent(
    executionId: string,
    toolName: string,
    type: ToolEventType,
    payload: Record<string, JsonValue> = {}
  ): ToolEventRecord {
    const createdAt = new Date().toISOString();
    const event = ToolEventRecordSchema.parse({
      id: randomUUID(),
      executionId,
      toolName,
      type,
      createdAt,
      payload
    });

    this.database
      .prepare(`
        INSERT INTO tool_events (
          id,
          execution_id,
          tool_name,
          event_type,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.executionId,
        event.toolName,
        event.type,
        JSON.stringify(event.payload),
        event.createdAt
      );

    const runtimeEvent: OperatorEvent = {
      id: randomUUID(),
      type: event.type,
      occurredAt: event.createdAt,
      payload: {
        event
      }
    };
    this.eventBus.publish(runtimeEvent);

    return event;
  }

  updateExecution(
    result: ToolResult,
    status: ToolExecutionStatus,
    output: JsonValue | undefined,
    errorCode?: string,
    errorMessage?: string,
    rawOutputRef?: string,
    errorDetails?: Record<string, JsonValue>
  ): ToolResult {
    const now = new Date().toISOString();
    const terminal = status === "completed"
      || status === "failed"
      || status === "cancelled"
      || status === "timed_out";
    const taskId = typeof result.replay.taskId === "string" ? result.replay.taskId : undefined;
    const canonicalStatus = canonicalStatusFor(status);
    const bytesIn = numericReplay(result.replay.bytesIn);
    const bytesOut = numericReplay(result.replay.bytesOut);
    const durationMs = numericReplay(result.replay.durationMs);
    const pricingVersion = typeof result.replay.pricingVersion === "string"
      ? result.replay.pricingVersion
      : undefined;
    const hasIntended = typeof result.replay.intendedEventId === "string";
    const resultEventId = terminal && taskId !== undefined && hasIntended
      ? this.eventStore.append(taskId, "tool_call_result", {
        intendedEventId: result.replay.intendedEventId as string,
        executionId: result.executionId,
        toolName: result.toolName,
        status: canonicalStatus,
        ok: status === "completed",
        ...(output === undefined ? {} : { output }),
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(errorMessage === undefined ? {} : { errorMessage }),
        ...(rawOutputRef === undefined ? {} : { rawOutputRef }),
        durationMs,
        bytesIn,
        bytesOut,
        costUsd: 0,
        ...(pricingVersion === undefined ? {} : { pricingVersion })
      })
      : undefined;
    const replay = terminal
      ? {
        ...result.replay,
        ...(resultEventId === undefined ? {} : { resultEventId }),
        completedAt: now
      }
      : result.replay;

    this.database
      .prepare(`
        UPDATE tool_executions
        SET
          status = ?,
          output_json = ?,
          error_code = ?,
          error_message = ?,
          raw_output_ref = ?,
          replay_json = ?,
          result_event_id = COALESCE(?, result_event_id),
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        output === undefined ? null : JSON.stringify(output),
        errorCode ?? null,
        errorMessage ?? null,
        rawOutputRef ?? null,
        JSON.stringify(replay),
        resultEventId ?? null,
        now,
        result.executionId
      );

    const updated: ToolResult = {
      ...result,
      status,
      ok: status === "completed",
      replay
    };

    if (output !== undefined) {
      updated.output = output;
    } else {
      delete updated.output;
    }

    if (rawOutputRef !== undefined) {
      updated.rawOutputRef = rawOutputRef;
    } else {
      delete updated.rawOutputRef;
    }

    if (errorCode !== undefined && errorMessage !== undefined) {
      updated.error = {
        code: errorCode,
        message: errorMessage,
        ...(errorDetails === undefined ? {} : { details: errorDetails })
      };
    } else {
      delete updated.error;
    }

    return updated;
  }

  markRunning(result: ToolResult): ToolResult {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE tool_executions
        SET
          status = 'running',
          output_json = NULL,
          error_code = NULL,
          error_message = NULL,
          updated_at = ?
        WHERE id = ?
      `)
      .run(now, result.executionId);

    const updated: ToolResult = {
      ...result,
      status: "running",
      ok: false
    };

    delete updated.output;
    delete updated.error;
    return updated;
  }

  updateAttempts(result: ToolResult, attempts: number): ToolResult {
    const replay = {
      ...result.replay,
      attempts
    };

    this.database
      .prepare("UPDATE tool_executions SET replay_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(replay), new Date().toISOString(), result.executionId);

    return {
      ...result,
      replay
    };
  }

  withReplay(result: ToolResult, replayPatch: Record<string, JsonValue>): ToolResult {
    const replay = {
      ...result.replay,
      ...replayPatch
    };

    this.database
      .prepare("UPDATE tool_executions SET replay_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(replay), new Date().toISOString(), result.executionId);

    return {
      ...result,
      replay
    };
  }
}

function hashJson(value: Record<string, JsonValue>): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalStatusFor(status: ToolExecutionStatus): "ok" | "error" | "timeout" | "cancelled" {
  switch (status) {
  case "completed":
    return "ok";
  case "timed_out":
    return "timeout";
  case "cancelled":
    return "cancelled";
  default:
    return "error";
  }
}

function numericReplay(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
