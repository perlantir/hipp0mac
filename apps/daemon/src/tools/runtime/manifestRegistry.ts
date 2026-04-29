import {
  ToolCapabilityManifestSchema,
  type JsonValue,
  type Predicate,
  type ToolCapabilityManifest
} from "@operator-dock/protocol";
import type { EventStore } from "../../persistence/eventStore.js";
import { validatePredicateRegexes } from "./predicateEngine.js";

export class ToolManifestRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolManifestRegistrationError";
  }
}

export class ToolManifestRegistry {
  private readonly manifestsByKey = new Map<string, ToolCapabilityManifest>();
  private readonly manifestsByName = new Map<string, ToolCapabilityManifest>();

  constructor(private readonly eventStore: EventStore) {}

  register(rawManifest: unknown): ToolCapabilityManifest {
    const parsed = ToolCapabilityManifestSchema.safeParse(rawManifest);
    if (!parsed.success) {
      throw new ToolManifestRegistrationError(`Invalid tool manifest: ${parsed.error.message}`);
    }

    const manifest = parsed.data;
    const key = manifestKey(manifest.name, manifest.version);
    if (this.manifestsByKey.has(key)) {
      throw new ToolManifestRegistrationError(`Duplicate tool manifest registration: ${key}`);
    }

    validateManifestSemantics(manifest);

    this.manifestsByKey.set(key, manifest);
    this.manifestsByName.set(manifest.name, manifest);
    this.eventStore.append("daemon", "tool_manifest_registered", {
      manifest: manifest as unknown as JsonValue
    });

    return manifest;
  }

  get(name: string, version?: string): ToolCapabilityManifest | undefined {
    return version === undefined
      ? this.manifestsByName.get(name)
      : this.manifestsByKey.get(manifestKey(name, version));
  }

  list(): ToolCapabilityManifest[] {
    return [...this.manifestsByKey.values()];
  }
}

function validateManifestSemantics(manifest: ToolCapabilityManifest): void {
  if (manifest.sideEffectClass === "write-non-idempotent" && !manifest.supportsIdempotency) {
    throw new ToolManifestRegistrationError(
      `Tool ${manifest.name}@${manifest.version} is write-non-idempotent and must support idempotency.`
    );
  }

  if (
    manifest.sideEffectClass === "external"
    && !manifest.supportsIdempotency
    && manifest.approvalPolicy.op !== "always"
  ) {
    throw new ToolManifestRegistrationError(
      `Tool ${manifest.name}@${manifest.version} is external without idempotency and must require approval for every call.`
    );
  }

  if (manifest.filesystemScope.mode !== "explicit" && manifest.filesystemScope.paths.length > 0) {
    throw new ToolManifestRegistrationError("filesystemScope.paths is only valid when mode is explicit.");
  }

  if (manifest.networkScope.mode !== "explicit" && manifest.networkScope.hosts.length > 0) {
    throw new ToolManifestRegistrationError("networkScope.hosts is only valid when mode is explicit.");
  }

  validatePredicateRegexes(manifest.approvalPolicy as Predicate);
  for (const predicate of manifest.forbiddenInputPatterns) {
    validatePredicateRegexes(predicate as Predicate);
  }
}

function manifestKey(name: string, version: string): string {
  return `${name}@${version}`;
}
