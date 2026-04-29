import type { Predicate, ToolCapabilityManifest, ToolSideEffectClass } from "@operator-dock/protocol";

const never: Predicate = { op: "never" };
const always: Predicate = { op: "always" };

export function toolManifest(input: {
  name: string;
  description: string;
  sideEffectClass: ToolSideEffectClass;
  supportsIdempotency?: boolean;
  supportsDryRun?: boolean;
  supportsStatusQuery?: boolean;
  filesystemScope?: ToolCapabilityManifest["filesystemScope"];
  networkScope?: ToolCapabilityManifest["networkScope"];
  approvalPolicy?: Predicate;
  forbiddenInputPatterns?: Predicate[];
  timeoutPolicy?: ToolCapabilityManifest["timeoutPolicy"];
  inputSchema?: ToolCapabilityManifest["inputSchema"];
  outputSchema?: ToolCapabilityManifest["outputSchema"];
}): ToolCapabilityManifest {
  return {
    schemaVersion: 1,
    version: "1",
    description: input.description,
    inputSchema: input.inputSchema ?? jsonObject("input"),
    outputSchema: input.outputSchema ?? jsonObject("output"),
    supportsIdempotency: input.supportsIdempotency ?? false,
    supportsDryRun: input.supportsDryRun ?? false,
    supportsStatusQuery: input.supportsStatusQuery ?? false,
    filesystemScope: input.filesystemScope ?? { mode: "none", paths: [] },
    networkScope: input.networkScope ?? { mode: "none", hosts: [] },
    approvalPolicy: input.approvalPolicy ?? never,
    forbiddenInputPatterns: input.forbiddenInputPatterns ?? [],
    timeoutPolicy: input.timeoutPolicy ?? { defaultMs: 30_000, maxMs: 120_000 },
    name: input.name,
    sideEffectClass: input.sideEffectClass
  };
}

export function fsReadManifest(name = "fs.read"): ToolCapabilityManifest {
  return toolManifest({
    name,
    description: "Read a file from the configured Operator Dock workspace.",
    sideEffectClass: "read",
    filesystemScope: { mode: "workspace", paths: [] },
    timeoutPolicy: { defaultMs: 10_000, maxMs: 30_000 }
  });
}

export function fsWriteManifest(): ToolCapabilityManifest {
  return toolManifest({
    name: "fs.write",
    description: "Write UTF-8 content to a workspace file with idempotency-key dedupe.",
    sideEffectClass: "write-idempotent",
    supportsIdempotency: true,
    supportsStatusQuery: true,
    filesystemScope: { mode: "workspace", paths: [] },
    timeoutPolicy: { defaultMs: 10_000, maxMs: 30_000 }
  });
}

export function fsDeleteManifest(): ToolCapabilityManifest {
  return toolManifest({
    name: "fs.delete",
    description: "Delete a workspace file with tombstone-backed idempotency.",
    sideEffectClass: "write-non-idempotent",
    supportsIdempotency: true,
    supportsStatusQuery: true,
    filesystemScope: { mode: "workspace", paths: [] },
    approvalPolicy: always,
    timeoutPolicy: { defaultMs: 10_000, maxMs: 30_000 }
  });
}

export function shellExecManifest(name = "shell.exec"): ToolCapabilityManifest {
  return toolManifest({
    name,
    description: "Run an approved command in the workspace without network access.",
    sideEffectClass: "external",
    filesystemScope: { mode: "workspace", paths: [] },
    networkScope: { mode: "none", hosts: [] },
    approvalPolicy: always,
    forbiddenInputPatterns: shellForbiddenPredicates(),
    timeoutPolicy: { defaultMs: 30_000, maxMs: 120_000 }
  });
}

export function httpFetchManifest(): ToolCapabilityManifest {
  return toolManifest({
    name: "http.fetch",
    description: "Fetch an allowlisted HTTP(S) URL with GET semantics.",
    sideEffectClass: "read",
    networkScope: { mode: "explicit", hosts: [] },
    forbiddenInputPatterns: httpForbiddenPredicates(),
    timeoutPolicy: { defaultMs: 30_000, maxMs: 120_000 }
  });
}

export function sleepWaitManifest(): ToolCapabilityManifest {
  return toolManifest({
    name: "sleep.wait",
    description: "Wait for a bounded duration. Test-only pure tool.",
    sideEffectClass: "pure",
    timeoutPolicy: { defaultMs: 5_000, maxMs: 120_000 }
  });
}

export function shellForbiddenPredicates(): Predicate[] {
  return [
    { op: "match", path: "command", regex: "(^|[;&|]\\s*)rm\\s+-(?:[A-Za-z]*r[A-Za-z]*f|[A-Za-z]*f[A-Za-z]*r)\\s+(?:--\\s+)?[\"']?/[\"']?(?:\\s|$)" },
    { op: "match", path: "command", regex: "(^|[;&|]\\s*)rm\\s+-(?:[A-Za-z]*r[A-Za-z]*f|[A-Za-z]*f[A-Za-z]*r)\\s+(?:--\\s+)?(?:~|\\$HOME)(?:\\s|$)" },
    { op: "match", path: "command", regex: "(^|[;&|]\\s*)(mkfs|newfs|shutdown|reboot|halt)(\\s|$)" },
    { op: "match", path: "command", regex: "(^|[;&|]\\s*)diskutil\\s+(erase\\w*|partition\\w*|apfs\\s+delete\\w*|unmountDisk\\s+force)(\\s|$)" },
    { op: "match", path: "command", regex: "(^|[;&|]\\s*)dd\\s+.*\\bof=/dev/" },
    { op: "match", path: "command", regex: ":\\s*\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}" },
    { op: "match", path: "command", regex: "(^|[;&|]\\s*)sudo(\\s|$)" },
    { op: "match", path: "command", regex: "(^|[;&|]\\s*)su(\\s|$)" },
    { op: "match", path: "command", regex: "\\b(curl|wget)\\b[\\s\\S]*\\|\\s*(?:env\\s+)?(?:bash|sh|zsh)\\b" }
  ];
}

export function httpForbiddenPredicates(): Predicate[] {
  return [
    { op: "match", path: "url", regex: "^file:" }
  ];
}

function jsonObject(title: string) {
  return {
    type: "object",
    title,
    additionalProperties: true
  };
}
