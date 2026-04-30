import type {
  AgentPlan,
  AgentStep,
  JsonValue,
  Predicate,
  ToolCapabilityManifest
} from "@operator-dock/protocol";
import { AgentPlanSchema } from "@operator-dock/protocol";
import type { ToolManifestRegistry } from "../tools/runtime/manifestRegistry.js";
import { evaluatePredicate } from "../tools/runtime/predicateEngine.js";

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

export interface PlanRevisionResult {
  plan: AgentPlan;
  diff: {
    added: string[];
    removed: string[];
    modified: string[];
  };
  carriedEvidence: Map<string, string[]>;
}

export class HeuristicStepEstimator {
  estimate(plan: Pick<AgentPlan, "doneConditions" | "expectedArtifacts" | "taskGoal">): number {
    const structuralBump = plan.taskGoal.split(/\s+/).filter(Boolean).length >= 5 ? 0 : 0;
    return 2 + plan.doneConditions.length + plan.expectedArtifacts.length + structuralBump;
  }
}

export function validatePlan(rawPlan: unknown, registry: ToolManifestRegistry): AgentPlan {
  const plan = AgentPlanSchema.parse(rawPlan);
  const stepIds = new Set(plan.steps.map((step) => step.stepId));
  if (stepIds.size !== plan.steps.length) {
    throw new PlanValidationError("Plan contains duplicate stepIds.");
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        throw new PlanValidationError(`Step ${step.stepId} has missing dependency ${dependency}.`);
      }
    }

    const manifest = registry.get(step.selectedTool, step.selectedToolVersion);
    if (manifest === undefined) {
      throw new PlanValidationError(`Unknown tool ${step.selectedTool}@${step.selectedToolVersion}.`);
    }

    validateToolInput(step, manifest);
    rejectForbiddenActions(plan.forbiddenActions, step, manifest);
  }

  if (hasCycle(plan.steps)) {
    throw new PlanValidationError("Plan DAG contains a cycle.");
  }

  return plan;
}

export function revisePlan(
  original: AgentPlan,
  revised: AgentPlan,
  changedStepId: string,
  evidence: Map<string, string[]>
): PlanRevisionResult {
  const affected = affectedSubgraph(original, changedStepId);
  const originalIds = new Set(original.steps.map((step) => step.stepId));
  const revisedIds = new Set(revised.steps.map((step) => step.stepId));
  const added = [...revisedIds].filter((id) => !originalIds.has(id)).sort();
  const removed = [...originalIds].filter((id) => !revisedIds.has(id)).sort();
  const modified = [...affected].filter((id) => revisedIds.has(id)).sort();
  const carriedEvidence = new Map<string, string[]>();

  for (const [stepId, refs] of evidence.entries()) {
    if (!affected.has(stepId)) {
      carriedEvidence.set(stepId, refs);
    }
  }

  return {
    plan: {
      ...revised,
      planId: original.planId,
      revision: original.revision + 1,
      parentPlanId: original.parentPlanId
    },
    diff: { added, removed, modified },
    carriedEvidence
  };
}

function validateToolInput(step: AgentStep, manifest: ToolCapabilityManifest): void {
  const schema = manifest.inputSchema;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const requiredProperty of required) {
    if (typeof requiredProperty === "string" && !(requiredProperty in step.toolInput)) {
      throw new PlanValidationError(`Step ${step.stepId} tool input is missing required property ${requiredProperty}.`);
    }
  }

  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  for (const [property, definition] of Object.entries(properties)) {
    if (!(property in step.toolInput) || !isJsonObject(definition)) {
      continue;
    }
    const expectedType = definition.type;
    const value = step.toolInput[property];
    if (typeof expectedType === "string" && expectedType !== "object" && value !== undefined && value !== null && typeof value !== expectedType) {
      throw new PlanValidationError(`Step ${step.stepId} tool input property ${property} must be ${expectedType}.`);
    }
  }
}

function rejectForbiddenActions(
  forbiddenActions: Predicate[],
  step: AgentStep,
  manifest: ToolCapabilityManifest
): void {
  const input = {
    toolName: step.selectedTool,
    toolVersion: step.selectedToolVersion,
    sideEffectClass: manifest.sideEffectClass,
    input: step.toolInput
  } satisfies Record<string, JsonValue>;

  for (const predicate of forbiddenActions) {
    if (evaluatePredicate(predicate, input, noScopeContext())) {
      throw new PlanValidationError(`Step ${step.stepId} matches a forbidden action.`);
    }
  }
}

function hasCycle(steps: AgentStep[]): boolean {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (stepId: string): boolean => {
    if (visited.has(stepId)) {
      return false;
    }
    if (visiting.has(stepId)) {
      return true;
    }
    visiting.add(stepId);
    for (const dependency of byId.get(stepId)?.dependsOn ?? []) {
      if (visit(dependency)) {
        return true;
      }
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };

  return steps.some((step) => visit(step.stepId));
}

function affectedSubgraph(plan: AgentPlan, changedStepId: string): Set<string> {
  const affected = new Set([changedStepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of plan.steps) {
      if (!affected.has(step.stepId) && step.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(step.stepId);
        changed = true;
      }
    }
  }
  return affected;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noScopeContext() {
  return {
    filesystemScopeContains: () => false,
    networkScopeContains: () => false
  };
}
