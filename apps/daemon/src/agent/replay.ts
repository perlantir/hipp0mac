import type { JsonValue, ToolSideEffectClass } from "@operator-dock/protocol";
import { canonicalJson } from "../persistence/canonicalJson.js";

export interface ReplayEventSlice {
  eventType: string;
  payload: Record<string, JsonValue>;
}

export interface ReplayResult {
  derivedState: {
    eventDigests: string[];
    completedSteps: string[];
    failedSteps: string[];
    toolResults: Record<string, JsonValue>;
    modelResults: Record<string, JsonValue>;
  };
  modelInvocations: number;
  reexecutedWriteOrExternalTools: number;
}

export function replayEventSlice(events: ReplayEventSlice[]): ReplayResult {
  const completedSteps = new Set<string>();
  const failedSteps = new Set<string>();
  const toolResults: Record<string, JsonValue> = {};
  const modelResults: Record<string, JsonValue> = {};

  for (const event of events) {
    if (event.eventType === "step_verification" && typeof event.payload.stepId === "string") {
      if (event.payload.passed === true) {
        completedSteps.add(event.payload.stepId);
      } else {
        failedSteps.add(event.payload.stepId);
      }
    }

    if (event.eventType === "tool_call_result") {
      const executionId = typeof event.payload.executionId === "string" ? event.payload.executionId : `tool-${Object.keys(toolResults).length}`;
      toolResults[executionId] = event.payload;
    }

    if (event.eventType === "model_call_result") {
      const intendedEventId = typeof event.payload.intendedEventId === "string"
        ? event.payload.intendedEventId
        : `model-${Object.keys(modelResults).length}`;
      modelResults[intendedEventId] = event.payload;
    }
  }

  return {
    derivedState: {
      eventDigests: events.map((event) => canonicalJson(event)),
      completedSteps: [...completedSteps].sort(),
      failedSteps: [...failedSteps].sort(),
      toolResults: sortRecord(toolResults),
      modelResults: sortRecord(modelResults)
    },
    modelInvocations: 0,
    reexecutedWriteOrExternalTools: 0
  };
}

export function isWriteOrExternal(sideEffectClass: unknown): sideEffectClass is ToolSideEffectClass {
  return sideEffectClass === "write-idempotent"
    || sideEffectClass === "write-non-idempotent"
    || sideEffectClass === "external";
}

function sortRecord(record: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}
