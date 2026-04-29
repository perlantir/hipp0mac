import type { FastifyInstance } from "fastify";
import {
  FileListResponseSchema,
  ProjectFolderCreateInputSchema,
  ToolExecutionResponseSchema,
  WorkspaceConfigureInputSchema,
  WorkspaceResponseSchema
} from "@operator-dock/protocol";
import { ApiError } from "../errors.js";
import type { FsToolService } from "../tools/fs/fsToolService.js";
import type { WorkspaceService } from "./workspaceService.js";
import { WorkspacePathSafety } from "./pathSafety.js";

export interface WorkspaceRouteDependencies {
  workspace: WorkspaceService;
  fsTools: FsToolService;
}

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  dependencies: WorkspaceRouteDependencies
): Promise<void> {
  app.get("/v1/workspace", async () => {
    const workspace = dependencies.workspace.getWorkspace();
    if (workspace === undefined) {
      throw new ApiError(404, "WORKSPACE_NOT_CONFIGURED", "Operator Dock workspace is not configured.");
    }

    return WorkspaceResponseSchema.parse({ workspace });
  });

  app.put("/v1/workspace", async (request) => {
    const input = WorkspaceConfigureInputSchema.parse(request.body);
    return WorkspaceResponseSchema.parse({
      workspace: dependencies.workspace.configure(input.rootPath)
    });
  });

  app.post("/v1/workspace/projects", async (request) => {
    const input = ProjectFolderCreateInputSchema.parse(request.body);
    const projectPath = dependencies.workspace.createProjectFolder(input.name);
    const workspace = dependencies.workspace.requireWorkspace();
    return {
      path: projectPath,
      relativePath: new WorkspacePathSafety(workspace).resolvePath(projectPath).relativePath
    };
  });

  app.get("/v1/workspace/files", async (request) => {
    const query = request.query as { path?: string; recursive?: string; maxEntries?: string };
    const result = await dependencies.fsTools.list({
      path: query.path ?? ".",
      recursive: query.recursive === "true",
      maxEntries: query.maxEntries === undefined ? 200 : Number(query.maxEntries)
    });

    if (!result.ok) {
      throw new ApiError(400, result.error?.code ?? "FILE_LIST_FAILED", result.error?.message ?? "Unable to list files.");
    }

    return FileListResponseSchema.parse(result.output);
  });

  app.post("/v1/tools/fs/read", async (request) => {
    return ToolExecutionResponseSchema.parse({
      result: await dependencies.fsTools.read(request.body)
    });
  });

  app.post("/v1/tools/fs/write", async (request) => {
    return ToolExecutionResponseSchema.parse({
      result: await dependencies.fsTools.write(request.body)
    });
  });

  app.post("/v1/tools/fs/append", async (request) => {
    return ToolExecutionResponseSchema.parse({
      result: await dependencies.fsTools.append(request.body)
    });
  });

  app.post("/v1/tools/fs/list", async (request) => {
    return ToolExecutionResponseSchema.parse({
      result: await dependencies.fsTools.list(request.body)
    });
  });

  app.post("/v1/tools/fs/search", async (request) => {
    return ToolExecutionResponseSchema.parse({
      result: await dependencies.fsTools.search(request.body)
    });
  });

  app.post("/v1/tools/fs/copy", async (request) => {
    return ToolExecutionResponseSchema.parse({
      result: await dependencies.fsTools.copy(request.body)
    });
  });

  app.post("/v1/tools/fs/move", async (request) => {
    return ToolExecutionResponseSchema.parse({
      result: await dependencies.fsTools.move(request.body)
    });
  });

  app.post("/v1/tools/fs/delete", async (request) => {
    return ToolExecutionResponseSchema.parse({
      result: await dependencies.fsTools.delete(request.body)
    });
  });
}

