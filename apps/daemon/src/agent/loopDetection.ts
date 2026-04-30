import type { JsonValue, RecoveryFailureType } from "@operator-dock/protocol";
import { canonicalJson } from "../persistence/canonicalJson.js";

export interface LoopDetectorOptions {
  noProgressStepThreshold?: number;
}

export interface LoopEventSlice {
  eventType: string;
  payload: Record<string, JsonValue>;
}

export interface LoopAnalysis {
  failureType: Extract<RecoveryFailureType, "repeated_step_loop" | "no_progress_loop"> | null;
  repeatedStepCount: number;
  consecutiveRepeatCount: number;
  stepsWithoutProgress: number;
}

interface StepObservation {
  stepId: string;
  signature: string;
  passed: boolean;
  progress: boolean;
}

export class LoopDetector {
  private readonly noProgressStepThreshold: number;

  constructor(options: LoopDetectorOptions = {}) {
    this.noProgressStepThreshold = options.noProgressStepThreshold ?? 5;
  }

  analyze(events: LoopEventSlice[]): LoopAnalysis {
    const observations = observationsSinceLatestPlan(events);
    let repeatedStepCount = 0;
    const seenSignatures = new Set<string>();
    let previousSignature: string | undefined;
    let consecutiveRepeatCount = 0;
    let stepsWithoutProgress = 0;

    for (const observation of observations) {
      if (seenSignatures.has(observation.signature)) {
        repeatedStepCount += 1;
      }
      seenSignatures.add(observation.signature);

      if (observation.signature === previousSignature) {
        consecutiveRepeatCount += 1;
      } else {
        consecutiveRepeatCount = 0;
      }
      previousSignature = observation.signature;

      if (observation.progress) {
        stepsWithoutProgress = 0;
      } else {
        stepsWithoutProgress += 1;
      }
    }

    if (consecutiveRepeatCount > 1) {
      return {
        failureType: "repeated_step_loop",
        repeatedStepCount,
        consecutiveRepeatCount,
        stepsWithoutProgress
      };
    }

    if (stepsWithoutProgress >= this.noProgressStepThreshold) {
      return {
        failureType: "no_progress_loop",
        repeatedStepCount,
        consecutiveRepeatCount,
        stepsWithoutProgress
      };
    }

    return {
      failureType: null,
      repeatedStepCount,
      consecutiveRepeatCount,
      stepsWithoutProgress
    };
  }
}

export function normalizeStepSignature(
  selectedTool: string,
  toolInput: Record<string, JsonValue>,
  intent: string
): string {
  return canonicalJson({
    intent: intent.trim().toLowerCase().replace(/\s+/g, " "),
    selectedTool,
    toolInput
  });
}

function observationsSinceLatestPlan(events: LoopEventSlice[]): StepObservation[] {
  const latestReplanIndex = Math.max(
    events.findLastIndex((event) => event.eventType === "plan_generated"),
    events.findLastIndex((event) => event.eventType === "plan_revised")
  );
  const selected = new Map<string, string>();
  const observations: StepObservation[] = [];

  for (const event of events.slice(latestReplanIndex + 1)) {
    if (event.eventType === "step_selected" && typeof event.payload.stepId === "string") {
      const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : "unknown";
      const input = isRecord(event.payload.toolInput) ? event.payload.toolInput : {};
      const intent = typeof event.payload.intent === "string" ? event.payload.intent : String(event.payload.stepId);
      selected.set(event.payload.stepId, normalizeStepSignature(toolName, input, intent));
      continue;
    }

    if (event.eventType === "step_verification" && typeof event.payload.stepId === "string") {
      const refs = Array.isArray(event.payload.evidenceRefs)
        ? event.payload.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
        : [];
      observations.push({
        stepId: event.payload.stepId,
        signature: selected.get(event.payload.stepId) ?? event.payload.stepId,
        passed: event.payload.passed === true,
        progress: event.payload.passed === true && refs.length > 0
      });
    }

    if (event.eventType === "artifact_created" || event.eventType === "artifact.created") {
      const last = observations.at(-1);
      if (last !== undefined) {
        last.progress = true;
      }
    }
  }

  return observations;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
