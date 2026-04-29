import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ToolEventRecordSchema,
  type JsonValue,
  type OperatorEvent,
  type ToolEventRecord,
  type ToolEventType,
  type ToolExecutionStatus,
  type ToolResult,
  type ToolRiskLevel
} from "@operator-dock/protocol";
import type { EventBus } from "../../websocket/eventBus.js";

export interface CreateExecutionInput {
  toolName: string;
  input: Record<string, JsonValue>;
  riskLevel: ToolRiskLevel;
  workspaceRoot?: string;
}

export class ToolEventStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly eventBus: EventBus
  ) {}

  createExecution(input: CreateExecutionInput): ToolResult {
    const now = new Date().toISOString();
    const executionId = randomUUID();
    const replay = {
      inputHash: hashJson(input.input),
      workspaceRoot: input.workspaceRoot,
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
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        executionId,
        input.toolName,
        "running",
        input.riskLevel,
        JSON.stringify(input.input),
        JSON.stringify(replay),
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
    rawOutputRef?: string
  ): ToolResult {
    const now = new Date().toISOString();
    const replay = {
      ...result.replay,
      completedAt: now
    };

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
        now,
        result.executionId
      );

    return {
      ...result,
      status,
      ok: status === "completed",
      output,
      error: errorCode === undefined || errorMessage === undefined
        ? undefined
        : {
          code: errorCode,
          message: errorMessage
        },
      rawOutputRef,
      replay
    };
  }
}

function hashJson(value: Record<string, JsonValue>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

