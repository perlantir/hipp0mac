import { resolve, sep } from "node:path";
import {
  type JsonValue,
  type Predicate,
  type SafetyDecisionValue,
  type ToolCapabilityManifest
} from "@operator-dock/protocol";
import type { EventStore } from "../../persistence/eventStore.js";
import { canonicalJson, sha256Hex } from "../../persistence/canonicalJson.js";
import { WorkspacePathSafety } from "../../workspace/pathSafety.js";
import type { WorkspaceService } from "../../workspace/workspaceService.js";
import { evaluatePredicate, firstMatchingPredicate } from "./predicateEngine.js";

export interface ScopeCheck {
  scope: "filesystem" | "network";
  inputPath: string;
  allowed: boolean;
  reason?: string;
}

export interface ScopeViolation extends ScopeCheck {
  allowed: false;
}

export interface SafetyGovernorDecision {
  eventId: string;
  decision: SafetyDecisionValue;
  matchedPredicate: Predicate | null;
  scopeViolation: ScopeViolation | null;
  scopeChecks: ScopeCheck[];
}

export interface SafetyDecisionOptions {
  taskId: string;
  manifest: ToolCapabilityManifest;
  input: Record<string, JsonValue>;
  allowedNetworkHosts?: string[];
}

export class SafetyGovernor {
  constructor(
    private readonly eventStore: EventStore,
    private readonly workspace: WorkspaceService
  ) {}

  decide(options: SafetyDecisionOptions): SafetyGovernorDecision {
    const scopeContext = this.scopeContext(options.manifest, options.allowedNetworkHosts ?? []);
    const forbidden = firstMatchingPredicate(
      options.manifest.forbiddenInputPatterns,
      options.input,
      scopeContext
    );
    const scopeChecks = this.scopeChecks(options.manifest, options.input, options.allowedNetworkHosts ?? []);
    const scopeViolation = scopeChecks.find((check): check is ScopeViolation => !check.allowed) ?? null;

    let decision: SafetyDecisionValue = "allow";
    let matchedPredicate: Predicate | null = null;
    if (forbidden.matched) {
      decision = "deny";
      matchedPredicate = forbidden.predicate ?? null;
    } else if (scopeViolation !== null) {
      decision = "deny";
    } else if (evaluatePredicate(options.manifest.approvalPolicy, options.input, scopeContext)) {
      decision = "approval_required";
      matchedPredicate = options.manifest.approvalPolicy;
    }

    const eventId = this.eventStore.append(options.taskId, "safety_decision", {
      toolName: options.manifest.name,
      toolVersion: options.manifest.version,
      decision,
      matchedPredicate: matchedPredicate as unknown as JsonValue ?? null,
      scopeViolation: scopeViolation as unknown as JsonValue ?? null,
      inputDigest: sha256Hex(canonicalJson(options.input))
    });

    return {
      eventId,
      decision,
      matchedPredicate,
      scopeViolation,
      scopeChecks,
    };
  }

  scopeContext(manifest: ToolCapabilityManifest, allowedNetworkHosts: string[] = []) {
    return {
      filesystemScopeContains: (inputPath: string) => this.filesystemContains(manifest, inputPath),
      networkScopeContains: (inputPath: string) => this.networkContains(manifest, inputPath, allowedNetworkHosts)
    };
  }

  private scopeChecks(
    manifest: ToolCapabilityManifest,
    input: Record<string, JsonValue>,
    allowedNetworkHosts: string[]
  ): ScopeCheck[] {
    const checks: ScopeCheck[] = [];

    for (const path of filesystemPathCandidates(input)) {
      const allowed = this.filesystemContains(manifest, path);
      checks.push({
        scope: "filesystem",
        inputPath: path,
        allowed,
        ...(allowed ? {} : { reason: "Filesystem path is outside the tool manifest scope." })
      });
    }

    for (const path of networkPathCandidates(input)) {
      const allowed = this.networkContains(manifest, path, allowedNetworkHosts);
      checks.push({
        scope: "network",
        inputPath: path,
        allowed,
        ...(allowed ? {} : { reason: "Network host is outside the tool manifest scope." })
      });
    }

    return checks;
  }

  private filesystemContains(manifest: ToolCapabilityManifest, inputPath: string): boolean {
    if (manifest.filesystemScope.mode === "none") {
      return false;
    }

    const workspace = this.workspace.requireWorkspace();
    const resolved = new WorkspacePathSafety(workspace).resolvePath(inputPath).absolutePath;
    if (manifest.filesystemScope.mode === "workspace") {
      return new WorkspacePathSafety(workspace).resolvePath(inputPath).insideWorkspace;
    }

    return manifest.filesystemScope.paths.some((scopePath) => pathMatchesScope(resolved, scopePath, workspace.rootPath));
  }

  private networkContains(
    manifest: ToolCapabilityManifest,
    inputPath: string,
    allowedNetworkHosts: string[]
  ): boolean {
    if (manifest.networkScope.mode === "none") {
      return false;
    }

    const host = hostFromInput(inputPath);
    if (host === undefined) {
      return false;
    }

    return [...manifest.networkScope.hosts, ...allowedNetworkHosts]
      .some((allowed) => allowed.toLowerCase() === host.toLowerCase());
  }
}

function filesystemPathCandidates(value: JsonValue): string[] {
  return pathCandidates(value, new Set(["path", "from", "to", "cwd"]));
}

function networkPathCandidates(value: JsonValue): string[] {
  return pathCandidates(value, new Set(["url"]));
}

function pathCandidates(value: JsonValue, names: Set<string>): string[] {
  const paths: string[] = [];
  const visit = (candidate: JsonValue, key?: string): void => {
    if (typeof candidate === "string" && key !== undefined && names.has(key)) {
      paths.push(candidate);
      return;
    }

    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return;
    }

    for (const [childKey, child] of Object.entries(candidate)) {
      visit(child, childKey);
    }
  };

  visit(value);
  return paths;
}

function pathMatchesScope(inputPath: string, scopePath: string, workspaceRoot: string): boolean {
  const absoluteScope = scopePath.startsWith(sep) ? resolve(scopePath) : resolve(workspaceRoot, scopePath);
  if (scopePath.endsWith("/**")) {
    const prefix = absoluteScope.slice(0, -3);
    return inputPath === prefix || inputPath.startsWith(`${prefix}${sep}`);
  }

  return inputPath === absoluteScope || inputPath.startsWith(`${absoluteScope}${sep}`);
}

function hostFromInput(input: string): string | undefined {
  try {
    return new URL(input).hostname;
  } catch {
    return input.includes(".") ? input : undefined;
  }
}
