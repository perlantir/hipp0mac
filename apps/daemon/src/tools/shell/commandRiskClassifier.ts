import { resolve, sep } from "node:path";
import type { ToolRiskLevel } from "@operator-dock/protocol";

export type CommandDecision = "allow" | "approval_required" | "deny";

export interface CommandRiskClassification {
  decision: CommandDecision;
  riskLevel: ToolRiskLevel;
  reason?: string;
  triggers: string[];
}

const denylist: Array<{ pattern: RegExp; reason: string; trigger: string }> = [
  {
    pattern: /(^|[;&|]\s*)rm\s+-(?:[A-Za-z]*r[A-Za-z]*f|[A-Za-z]*f[A-Za-z]*r)\s+(?:--\s+)?["']?\/["']?(?:\s|$)/,
    reason: "Deleting the filesystem root is denied.",
    trigger: "root-delete"
  },
  {
    pattern: /(^|[;&|]\s*)rm\s+-(?:[A-Za-z]*r[A-Za-z]*f|[A-Za-z]*f[A-Za-z]*r)\s+(?:--\s+)?(?:~|\$HOME)(?:\s|$)/,
    reason: "Deleting the home directory is denied.",
    trigger: "home-delete"
  },
  {
    pattern: /(^|[;&|]\s*)(mkfs|newfs|shutdown|reboot|halt)(\s|$)/,
    reason: "System-destructive commands are denied.",
    trigger: "system-destructive"
  },
  {
    pattern: /(^|[;&|]\s*)diskutil\s+(erase|partition|apfs\s+delete|unmountDisk\s+force)(\s|$)/,
    reason: "Destructive disk operations are denied.",
    trigger: "disk-destructive"
  },
  {
    pattern: /(^|[;&|]\s*)dd\s+.*\bof=\/dev\//,
    reason: "Raw device writes are denied.",
    trigger: "raw-device-write"
  },
  {
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,
    reason: "Fork-bomb style commands are denied.",
    trigger: "fork-bomb"
  }
];

export function classifyShellCommand(command: string, workspaceRoot?: string): CommandRiskClassification {
  const trimmed = command.trim();
  const triggers: string[] = [];

  for (const denied of denylist) {
    if (denied.pattern.test(trimmed)) {
      return {
        decision: "deny",
        riskLevel: "dangerous",
        reason: denied.reason,
        triggers: [denied.trigger]
      };
    }
  }

  if (/(^|[;&|]\s*)sudo(\s|$)/.test(trimmed)) {
    triggers.push("sudo");
  }

  if (/\b(curl|wget)\b[\s\S]*\|\s*(?:env\s+)?(?:bash|sh|zsh)\b/.test(trimmed)) {
    triggers.push("curl-pipe-shell");
  }

  if (/(^|[;&|]\s*)rm\s+-(?:[A-Za-z]*r[A-Za-z]*f|[A-Za-z]*f[A-Za-z]*r)\s+(?:--\s+)?(?:\.|\*|\.\.)(?:\s|$)/.test(trimmed)) {
    triggers.push("broad-delete");
  }

  const outsideWrite = workspaceRoot === undefined
    ? undefined
    : findOutsideWorkspaceMutation(trimmed, workspaceRoot);
  if (outsideWrite !== undefined) {
    triggers.push(`outside-workspace:${outsideWrite}`);
  }

  if (triggers.length > 0) {
    return {
      decision: "approval_required",
      riskLevel: "dangerous",
      reason: approvalReason(triggers),
      triggers
    };
  }

  if (/\b(rm|mv|cp|chmod|chown|mkdir|touch|tee)\b/.test(trimmed) || />{1,2}/.test(trimmed)) {
    return {
      decision: "allow",
      riskLevel: "medium",
      triggers: []
    };
  }

  return {
    decision: "allow",
    riskLevel: "safe",
    triggers: []
  };
}

function approvalReason(triggers: string[]): string {
  if (triggers.includes("sudo")) {
    return "Commands using sudo require approval.";
  }
  if (triggers.includes("curl-pipe-shell")) {
    return "Piping a remote download into a shell requires approval.";
  }
  if (triggers.includes("broad-delete")) {
    return "Broad recursive deletes require approval.";
  }
  if (triggers.some((trigger) => trigger.startsWith("outside-workspace:"))) {
    return "Commands that mutate files outside the Operator Dock workspace require approval.";
  }

  return "This command requires approval.";
}

function findOutsideWorkspaceMutation(command: string, workspaceRoot: string): string | undefined {
  const normalizedRoot = resolve(workspaceRoot);
  const absolutePathPattern = /(?:^|\s)(?:>|>>|rm|mv|cp|touch|mkdir|tee|chmod|chown)\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|(\/[^\s"'`]+))/g;
  let match: RegExpExecArray | null;

  while ((match = absolutePathPattern.exec(command)) !== null) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (candidate === undefined || !candidate.startsWith(sep)) {
      continue;
    }

    const absolutePath = resolve(candidate);
    if (!isInside(absolutePath, normalizedRoot)) {
      return absolutePath;
    }
  }

  return undefined;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}
