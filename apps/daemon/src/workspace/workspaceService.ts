import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { WorkspaceSettingsSchema, type WorkspaceSettings } from "@operator-dock/protocol";
import { WorkspaceSettingsRepository } from "./workspaceSettingsRepository.js";

const folderNames = ["projects", "tasks", "artifacts", "logs", "skills", "memory"] as const;

export class WorkspaceService {
  constructor(private readonly repository: WorkspaceSettingsRepository) {}

  getWorkspace(): WorkspaceSettings | undefined {
    return this.repository.get();
  }

  configure(rootPath: string): WorkspaceSettings {
    const resolvedRoot = resolve(rootPath);
    const now = new Date().toISOString();
    const existing = this.repository.get();
    const folders = {
      projects: join(resolvedRoot, "projects"),
      tasks: join(resolvedRoot, "tasks"),
      artifacts: join(resolvedRoot, "artifacts"),
      logs: join(resolvedRoot, "logs"),
      skills: join(resolvedRoot, "skills"),
      memory: join(resolvedRoot, "memory")
    };

    mkdirSync(resolvedRoot, { recursive: true });
    for (const name of folderNames) {
      mkdirSync(folders[name], { recursive: true });
    }

    return this.repository.save(
      WorkspaceSettingsSchema.parse({
        rootPath: resolvedRoot,
        folders,
        initialized: true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    );
  }

  createProjectFolder(name: string): string {
    const workspace = this.requireWorkspace();
    const safeName = slugify(name);
    const projectPath = join(workspace.folders.projects, safeName);
    mkdirSync(projectPath, { recursive: true });
    return projectPath;
  }

  requireWorkspace(): WorkspaceSettings {
    const workspace = this.repository.get();
    if (workspace === undefined) {
      throw new Error("Workspace is not configured.");
    }

    return workspace;
  }
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return basename(slug.length > 0 ? slug : "project");
}

