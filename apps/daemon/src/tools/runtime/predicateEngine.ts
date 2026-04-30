import type { JsonValue, Predicate } from "@operator-dock/protocol";
import { canonicalJson } from "../../persistence/canonicalJson.js";

export interface PredicateEvaluationContext {
  filesystemScopeContains(inputPath: string): boolean;
  networkScopeContains(inputPath: string): boolean;
}

export interface PredicateMatch {
  matched: boolean;
  predicate?: Predicate;
}

export function evaluatePredicate(
  predicate: Predicate,
  input: Record<string, JsonValue>,
  context: PredicateEvaluationContext
): boolean {
  switch (predicate.op) {
  case "always":
    return true;
  case "never":
    return false;
  case "and":
    return predicate.clauses.every((clause) => evaluatePredicate(clause, input, context));
  case "or":
    return predicate.clauses.some((clause) => evaluatePredicate(clause, input, context));
  case "not":
    return !evaluatePredicate(predicate.clause, input, context);
  case "match": {
    const value = valueAtPath(input, predicate.path);
    if (value === undefined) {
      return false;
    }
    const matchedValue = typeof value === "string" ? value : canonicalJson(value);
    return new RegExp(predicate.regex).test(matchedValue);
  }
  case "equals":
    return canonicalJson(valueAtPath(input, predicate.path) ?? null) === canonicalJson(predicate.value);
  case "in": {
    const value = canonicalJson(valueAtPath(input, predicate.path) ?? null);
    return predicate.values.some((candidate) => canonicalJson(candidate) === value);
  }
  case "pathOutsideScope": {
    const value = valueAtPath(input, predicate.inputPath);
    if (typeof value !== "string") {
      return false;
    }
    return predicate.scope === "filesystem"
      ? !context.filesystemScopeContains(value)
      : !context.networkScopeContains(value);
  }
  }
}

export function firstMatchingPredicate(
  predicates: Predicate[],
  input: Record<string, JsonValue>,
  context: PredicateEvaluationContext
): PredicateMatch {
  for (const predicate of predicates) {
    if (evaluatePredicate(predicate, input, context)) {
      return { matched: true, predicate };
    }
  }

  return { matched: false };
}

export function valueAtPath(input: Record<string, JsonValue>, path: string): JsonValue | undefined {
  const normalized = path.startsWith("$.") ? path.slice(2) : path === "$" ? "" : path;
  if (normalized.length === 0) {
    return input;
  }

  let current: JsonValue | undefined = input;
  for (const segment of normalized.split(".")) {
    if (
      typeof current !== "object"
      || current === null
      || Array.isArray(current)
      || !(segment in current)
    ) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

export function validatePredicateRegexes(predicate: Predicate): void {
  switch (predicate.op) {
  case "match":
    new RegExp(predicate.regex);
    break;
  case "and":
  case "or":
    for (const clause of predicate.clauses) {
      validatePredicateRegexes(clause);
    }
    break;
  case "not":
    validatePredicateRegexes(predicate.clause);
    break;
  default:
    break;
  }
}
