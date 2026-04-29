import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolExecutionResponseSchema, WorkspaceResponseSchema } from "@operator-dock/protocol";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { EventBus } from "../src/websocket/eventBus.js";
import { authHeaders, authStore, persistenceKeyManager } from "./harness.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots.clear();
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

function testConfig(root: string) {
  return loadConfig({
    HOME: root,
    OPERATOR_DOCK_STATE_ROOT: join(root, "state"),
    OPERATOR_DOCK_DB_PATH: join(root, "operator-dock.sqlite"),
    OPERATOR_DOCK_MIGRATIONS_DIR: resolve("migrations")
  });
}

async function configuredApp(prefix = "operator-dock-workspace-") {
  const root = tempRoot(prefix);
  const workspaceRoot = join(root, "Operator Dock Workspace");
  const eventBus = new EventBus();
  const app = await buildApp({
    config: testConfig(root),
    eventBus,
    authTokenStore: authStore(),
    persistenceKeyManager: persistenceKeyManager(),
    logger: false
  });

  const response = await app.inject({
    method: "PUT",
    url: "/v1/workspace",
    headers: authHeaders(),
    payload: {
      rootPath: workspaceRoot
    }
  });

  expect(response.statusCode).toBe(200);

  return {
    app,
    root,
    workspaceRoot,
    eventBus
  };
}

describe("workspace setup", () => {
  it("creates a selectable workspace and required folders", async () => {
    const { app, workspaceRoot } = await configuredApp();

    const response = await app.inject({
      method: "GET",
      url: "/v1/workspace",
      headers: authHeaders()
    });

    await app.close();

    const body = WorkspaceResponseSchema.parse(response.json());
    expect(body.workspace.rootPath).toBe(workspaceRoot);
    for (const folder of ["projects", "tasks", "artifacts", "logs", "skills", "memory"]) {
      expect(existsSync(join(workspaceRoot, folder))).toBe(true);
    }
  });

  it("creates project folders under workspace/projects", async () => {
    const { app, workspaceRoot } = await configuredApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/workspace/projects",
      headers: authHeaders(),
      payload: {
        name: "Q3 Competitive Scan"
      }
    });

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      relativePath: "projects/q3-competitive-scan"
    });
    expect(existsSync(join(workspaceRoot, "projects", "q3-competitive-scan"))).toBe(true);
  });
});

describe("file tools", () => {
  it("writes, reads, lists, and searches workspace files", async () => {
    const { app } = await configuredApp();

    const write = await app.inject({
      method: "POST",
      url: "/v1/tools/fs/write",
      headers: authHeaders(),
      payload: {
        path: "tasks/demo.md",
        content: "alpha\nbeta search-target\n"
      }
    });
    expect(ToolExecutionResponseSchema.parse(write.json()).result.status).toBe("completed");

    const read = await app.inject({
      method: "POST",
      url: "/v1/tools/fs/read",
      headers: authHeaders(),
      payload: {
        path: "tasks/demo.md"
      }
    });
    expect(ToolExecutionResponseSchema.parse(read.json()).result.output).toMatchObject({
      relativePath: "tasks/demo.md",
      content: "alpha\nbeta search-target\n"
    });

    const list = await app.inject({
      method: "POST",
      url: "/v1/tools/fs/list",
      headers: authHeaders(),
      payload: {
        path: "tasks"
      }
    });
    expect(JSON.stringify(ToolExecutionResponseSchema.parse(list.json()).result.output)).toContain("demo.md");

    const search = await app.inject({
      method: "POST",
      url: "/v1/tools/fs/search",
      headers: authHeaders(),
      payload: {
        path: "tasks",
        query: "search-target"
      }
    });

    await app.close();

    expect(JSON.stringify(ToolExecutionResponseSchema.parse(search.json()).result.output)).toContain("search-target");
  });

  it("blocks unsafe system directory deletion", async () => {
    const { app } = await configuredApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/tools/fs/delete",
      headers: authHeaders(),
      payload: {
        path: "/System",
        recursive: true
      }
    });

    await app.close();

    const result = ToolExecutionResponseSchema.parse(response.json()).result;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("TOOL_DENIED");
  });

  it("requires approval for outside-workspace writes", async () => {
    const { app, root } = await configuredApp();
    const outsidePath = join(root, "outside.txt");

    const response = await app.inject({
      method: "POST",
      url: "/v1/tools/fs/write",
      headers: authHeaders(),
      payload: {
        path: outsidePath,
        content: "outside"
      }
    });

    await app.close();

    const result = ToolExecutionResponseSchema.parse(response.json()).result;
    expect(result.status).toBe("waiting_for_approval");
    expect(result.error?.code).toBe("TOOL_APPROVAL_REQUIRED");
    expect(existsSync(outsidePath)).toBe(false);
  });

  it("emits structured tool events", async () => {
    const { app, eventBus } = await configuredApp();
    const events: string[] = [];
    eventBus.subscribe((event) => events.push(event.type));

    const response = await app.inject({
      method: "POST",
      url: "/v1/tools/fs/write",
      headers: authHeaders(),
      payload: {
        path: "logs/run.txt",
        content: "hello"
      }
    });

    await app.close();

    const result = ToolExecutionResponseSchema.parse(response.json()).result;
    expect(result.status).toBe("completed");
    expect(events).toContain("tool.started");
    expect(events).toContain("tool.output");
    expect(events).toContain("tool.completed");
  });

  it("allows approved outside-workspace writes and records the file", async () => {
    const { app, root } = await configuredApp();
    const outsidePath = join(root, "approved-outside.txt");

    const response = await app.inject({
      method: "POST",
      url: "/v1/tools/fs/write",
      headers: authHeaders(),
      payload: {
        path: outsidePath,
        content: "approved",
        approvalToken: "manual-approval"
      }
    });

    await app.close();

    expect(ToolExecutionResponseSchema.parse(response.json()).result.status).toBe("completed");
    expect(readFileSync(outsidePath, "utf8")).toBe("approved");
  });
});
