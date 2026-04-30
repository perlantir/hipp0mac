import { createHash } from "node:crypto";
import type {
  AgentPlan,
  AgentStep,
  Predicate,
  SafetyDecisionValue
} from "@operator-dock/protocol";
import type { EventStore } from "../persistence/eventStore.js";
import { evaluatePredicate } from "../tools/runtime/predicateEngine.js";
import { INJECTION_RULE_TEXT } from "./promptTemplates.js";

export { INJECTION_RULE_TEXT };

export interface InjectionDetectionOptions {
  taskId?: string;
  eventStore?: EventStore;
  source?: string;
  forbiddenActions: Predicate[];
}

export interface InjectionDetection {
  detected: boolean;
  shouldHalt: boolean;
  maliciousActionAllowed: boolean;
  matchedRules: string[];
  snippetHash: string;
}

export function wrapUntrustedData(source: string, eventRef: string, content: string): string {
  return [
    `<untrusted_data source="${escapeAttribute(source)}" event="${escapeAttribute(eventRef)}">`,
    content,
    "</untrusted_data>"
  ].join("\n");
}

export function detectPromptInjection(
  payload: string,
  options: InjectionDetectionOptions = { forbiddenActions: [] }
): InjectionDetection {
  const matchedRules = new Set<string>();
  const normalized = payload.toLowerCase();
  const lines = payload.split(/\r?\n/);

  matchRule(normalized, /\b(ignore|disregard)\s+(previous|all|your)\s+(instructions|guidelines|rules)\b/, "ignore_previous_instructions", matchedRules);
  matchRule(normalized, /\byou are now\b/, "role_reassignment", matchedRules);
  if (lines.some((line) => /^(system|assistant|developer)\s*:/i.test(line.trim()))) {
    matchedRules.add("system_prompt_mimicry");
  }
  matchRule(payload, /<\/?(system|assistant|developer)>|\[INST\]|<<SYS>>/i, "embedded_role_tag", matchedRules);
  matchRule(normalized, /\b(instead|your real task is|new objective|forget the task)\b/, "goal_hijack", matchedRules);
  matchRule(normalized, /\b(use|call|invoke)\s+(?:a\s+)?tool\s+(?:called|named)?\s*[a-z0-9_.-]+/i, "tool_introduction_attempt", matchedRules);
  matchRule(normalized, /\b(the user said|authorized by the user|system says)\b/, "false_authority_claim", matchedRules);

  for (const predicate of options.forbiddenActions) {
    if (evaluatePredicate(predicate, { text: payload }, noScopeContext())) {
      matchedRules.add("forbidden_action_reference");
      break;
    }
  }

  const detection = {
    detected: matchedRules.size > 0,
    shouldHalt: matchedRules.size > 0,
    maliciousActionAllowed: false,
    matchedRules: [...matchedRules].sort(),
    snippetHash: createHash("sha256").update(payload.slice(0, 4096)).digest("hex")
  };

  if (detection.detected && options.eventStore !== undefined && options.taskId !== undefined) {
    options.eventStore.append(options.taskId, "injection_detected", {
      source: options.source ?? "untrusted",
      snippetHash: detection.snippetHash,
      matchedRules: detection.matchedRules,
      strategy: "stop_for_safety"
    });
  }

  return detection;
}

export function propagateTaint(plan: AgentPlan, taintedOutputs: Set<string>): AgentPlan {
  const tainted = new Set(taintedOutputs);
  const steps = plan.steps.map((step) => ({ ...step }));
  let changed = true;

  while (changed) {
    changed = false;
    for (const step of steps) {
      const consumesTainted = step.consumes.some((name) => tainted.has(name));
      if ((step.taint || consumesTainted) && !step.taint) {
        step.taint = true;
        changed = true;
      }
      if (step.taint || consumesTainted) {
        for (const produced of step.produces) {
          if (!tainted.has(produced)) {
            tainted.add(produced);
            changed = true;
          }
        }
      }
    }
  }

  return {
    ...plan,
    steps
  };
}

export function escalatedDecisionForTaint(
  decision: SafetyDecisionValue,
  step: AgentStep
): SafetyDecisionValue {
  if (!step.taint || decision !== "allow") {
    return decision;
  }

  return "approval_required";
}

function matchRule(input: string, pattern: RegExp, rule: string, matchedRules: Set<string>): void {
  if (pattern.test(input)) {
    matchedRules.add(rule);
  }
}

function escapeAttribute(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function noScopeContext() {
  return {
    filesystemScopeContains: () => false,
    networkScopeContains: () => false
  };
}
