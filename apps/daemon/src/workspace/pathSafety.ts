import { resolve, relative, sep } from "node:path";
import type { WorkspaceSettings } from "@operator-dock/protocol";

export interface PathResolution {
  absolutePath: string;
  relativePath: string;
  insideWorkspace: boolean;
}

export interface SafetyDecision extends PathResolution {
  allowed: boolean;
  approvalRequired: boolean;
  reason?: string;
}

const systemDeleteDenylist = [
  "/",
  "/System",
  "/bin",
  "/sbin",
  "/usr",
  "/etc",
  "/var",
  "/private",
  "/Library",
  "/Applications"
];

export class WorkspacePathSafety {
  constructor(private readonly workspace: WorkspaceSettings) {}

  resolvePath(inputPath: string): PathResolution {
    const absolutePath = inputPath.startsWith(sep)
      ? resolve(inputPath)
      : resolve(this.workspace.rootPath, inputPath);
    const relativePath = relative(this.workspace.rootPath, absolutePath);
    const insideWorkspace = relativePath === "" || (!relativePath.startsWith("..") && !inputPathIsAbsolute(relativePath));

    return {
      absolutePath,
      relativePath: insideWorkspace ? relativePath || "." : absolutePath,
      insideWorkspace
    };
  }

  checkRead(inputPath: string): SafetyDecision {
    return {
      ...this.resolvePath(inputPath),
      allowed: true,
      approvalRequired: false
    };
  }

  checkWrite(inputPath: string, approvalToken?: string): SafetyDecision {
    const resolution = this.resolvePath(inputPath);
    if (resolution.insideWorkspace || hasApproval(approvalToken)) {
      return {
        ...resolution,
        allowed: true,
        approvalRequired: false
      };
    }

    return {
      ...resolution,
      allowed: false,
      approvalRequired: true,
      reason: "Writes outside the Operator Dock workspace require approval."
    };
  }

  checkDelete(inputPath: string, approvalToken?: string): SafetyDecision {
    const resolution = this.resolvePath(inputPath);
    if (resolution.insideWorkspace) {
      return {
        ...resolution,
        allowed: true,
        approvalRequired: false
      };
    }

    if (isSystemDirectory(resolution.absolutePath)) {
      return {
        ...resolution,
        allowed: false,
        approvalRequired: false,
        reason: "Deleting system directories is blocked."
      };
    }

    if (hasApproval(approvalToken)) {
      return {
        ...resolution,
        allowed: true,
        approvalRequired: false
      };
    }

    return {
      ...resolution,
      allowed: false,
      approvalRequired: true,
      reason: "Deletes outside the Operator Dock workspace require approval."
    };
  }
}

function hasApproval(token: string | undefined): boolean {
  return token !== undefined && token.trim().length > 0;
}

function isSystemDirectory(path: string): boolean {
  return systemDeleteDenylist.some((blocked) => path === blocked || path.startsWith(`${blocked}${sep}`));
}

function inputPathIsAbsolute(path: string): boolean {
  return path.startsWith(sep);
}
