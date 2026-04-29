import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ToolEventRecordSchema,
  ToolResultSchema,
  type JsonValue,
  type OperatorEvent,
  type ToolEventRecord,
  type ToolEventType,
  type ToolExecutionStatus,
  type ToolResult,
  type ToolRiskLevel
} from "@operator-dock/protocol";
import { ProjectionCipher } from "../../db/projectionCipher.js";
import type { CanonicalEventStore } from "../../events/canonicalEventStore.js";
import type { EventBus } from "../../websocket/eventBus.js";

export interface CreateExecutionInput {
  toolName: string;
  input: Record<string, JsonValue>;
  riskLevel: ToolRiskLevel;
  workspaceRoot?: string;
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
    private readonly database: DatabaseSync,
    private readonly eventBus: EventBus,
    private readonly canonicalEvents: CanonicalEventStore,
    private readonly cipher: ProjectionCipher
  ) {}

  createExecution(input: CreateExecutionInput): ToolResult {
    const now = new Date().toISOString();
    const executionId = randomUUID();
    const intendedEventId = this.canonicalEvents.append({
      taskId: executionId,
      eventType: "tool_call_intended",
      payload: {
        executionId,
        toolName: input.toolName,
        input: input.input,
        riskLevel: input.riskLevel,
        ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot })
      }
    });
    const replay = {
      inputHash: hashJson(input.input),
      workspaceRoot: input.workspaceRoot,
      intendedEventId,
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
          intended_event_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        executionId,
        input.toolName,
        "running",
        input.riskLevel,
        this.cipher.encrypt(JSON.stringify(input.input)),
        this.cipher.encrypt(JSON.stringify(replay)),
        0,
        intendedEventId,
        now,
        now
      );

    return {
      executionId,
      toolName: input.toolName,
      status: "running",
      riskLevel: input.riskLevel,
      ok: false,
      events: [],
      replay
    };
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
          replay_json
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
      ...(row.output_json === null ? {} : { output: JSON.parse(this.cipher.decrypt(row.output_json)) as JsonValue }),
      ...(row.error_code === null || row.error_message === null
        ? {}
        : {
          error: {
            code: row.error_code,
            message: this.cipher.decrypt(row.error_message)
          }
        }),
      ...(row.raw_output_ref === null ? {} : { rawOutputRef: this.cipher.decrypt(row.raw_output_ref) }),
      events: events.map((event) => ToolEventRecordSchema.parse({
        id: event.id,
        executionId: event.execution_id,
        toolName: event.tool_name,
        type: event.event_type,
        createdAt: event.created_at,
        payload: JSON.parse(this.cipher.decrypt(event.payload_json)) as Record<string, JsonValue>
      })),
      replay: JSON.parse(this.cipher.decrypt(row.replay_json)) as JsonValue
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
          legacy,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.executionId,
        event.toolName,
        event.type,
        this.cipher.encrypt(JSON.stringify(event.payload)),
        0,
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
    const resultEventId = terminal
      ? this.canonicalEvents.append({
        taskId: result.executionId,
        eventType: "tool_call_result",
        payload: {
          executionId: result.executionId,
          toolName: result.toolName,
          status,
          ok: status === "completed",
          ...(output === undefined ? {} : { output }),
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(errorMessage === undefined ? {} : { errorMessage }),
          ...(rawOutputRef === undefined ? {} : { rawOutputRef })
        }
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
          legacy = 0,
          result_event_id = COALESCE(?, result_event_id),
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        output === undefined ? null : this.cipher.encrypt(JSON.stringify(output)),
        errorCode ?? null,
        errorMessage === undefined ? null : this.cipher.encrypt(errorMessage),
        rawOutputRef === undefined ? null : this.cipher.encrypt(rawOutputRef),
        this.cipher.encrypt(JSON.stringify(replay)),
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
      .run(this.cipher.encrypt(JSON.stringify(replay)), new Date().toISOString(), result.executionId);

    return {
      ...result,
      replay
    };
  }
}

function hashJson(value: Record<string, JsonValue>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
