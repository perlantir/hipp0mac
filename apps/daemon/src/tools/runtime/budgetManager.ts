import type { JsonValue, TaskBudgetLimits, ToolCapabilityManifest } from "@operator-dock/protocol";
import type { EventStore } from "../../persistence/eventStore.js";
import { canonicalJson } from "../../persistence/canonicalJson.js";

export const pricingVersion = "phase5b-pricing-v1";

export interface BudgetProjection {
  name: keyof TaskBudgetLimits;
  used: number;
  projected: number;
  limit: number;
}

export interface BudgetDecision {
  allowed: boolean;
  exceeded?: BudgetProjection;
}

export interface BudgetCheckInput {
  taskId: string;
  manifest: ToolCapabilityManifest;
  input: Record<string, JsonValue>;
  timeoutMs: number;
  limits?: TaskBudgetLimits;
}

export class BudgetManager {
  constructor(private readonly eventStore: EventStore) {}

  checkBeforeExecute(input: BudgetCheckInput): BudgetDecision {
    const limits = input.limits ?? defaultBudgetLimits();
    const used = this.usage(input.taskId);
    const projected: Record<keyof TaskBudgetLimits, number> = {
      toolCalls: used.toolCalls.used + 1,
      wallClockMs: used.wallClockMs.used + input.timeoutMs,
      costUsd: used.costUsd.used + estimatedCostUsd(input.manifest),
      bytesProcessed: used.bytesProcessed.used + Buffer.byteLength(canonicalJson(input.input), "utf8")
    };

    for (const name of budgetOrder) {
      if (projected[name] > limits[name].limit) {
        const exceeded = {
          name,
          used: used[name].used,
          projected: projected[name],
          limit: limits[name].limit
        };
        this.eventStore.append(input.taskId, "budget_exceeded", exceeded as unknown as Record<string, JsonValue>);
        return { allowed: false, exceeded };
      }
    }

    return { allowed: true };
  }

  usage(taskId: string): TaskBudgetLimits {
    const usage = zeroBudgetUsage(defaultBudgetLimits());
    for (const event of this.eventStore.readAll(taskId)) {
      if (event.eventType !== "tool_call_result") {
        continue;
      }

      usage.toolCalls.used += 1;
      usage.wallClockMs.used += numericPayload(event.payload.durationMs);
      usage.costUsd.used += numericPayload(event.payload.costUsd);
      usage.bytesProcessed.used += numericPayload(event.payload.bytesIn) + numericPayload(event.payload.bytesOut);
    }

    return usage;
  }
}

export function defaultBudgetLimits(): TaskBudgetLimits {
  return {
    toolCalls: { used: 0, limit: 100 },
    wallClockMs: { used: 0, limit: 10 * 60 * 1000 },
    costUsd: { used: 0, limit: 0 },
    bytesProcessed: { used: 0, limit: 50 * 1024 * 1024 }
  };
}

export function resultBytes(input: Record<string, JsonValue>, output: JsonValue | undefined): { bytesIn: number; bytesOut: number } {
  return {
    bytesIn: Buffer.byteLength(canonicalJson(input), "utf8"),
    bytesOut: output === undefined ? 0 : Buffer.byteLength(canonicalJson(output), "utf8")
  };
}

function zeroBudgetUsage(limits: TaskBudgetLimits): TaskBudgetLimits {
  return {
    toolCalls: { used: 0, limit: limits.toolCalls.limit },
    wallClockMs: { used: 0, limit: limits.wallClockMs.limit },
    costUsd: { used: 0, limit: limits.costUsd.limit },
    bytesProcessed: { used: 0, limit: limits.bytesProcessed.limit }
  };
}

function estimatedCostUsd(_manifest: ToolCapabilityManifest): number {
  return 0;
}

function numericPayload(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const budgetOrder: Array<keyof TaskBudgetLimits> = [
  "costUsd",
  "toolCalls",
  "wallClockMs",
  "bytesProcessed"
];
