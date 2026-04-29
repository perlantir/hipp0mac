import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CreateTaskResponseSchema, HealthResponseSchema } from "@operator-dock/protocol";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { EventBus } from "../src/websocket/eventBus.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots.clear();
});

function testConfig() {
  const root = mkdtempSync(join(tmpdir(), "operator-dock-daemon-"));
  tempRoots.add(root);

  return loadConfig({
    OPERATOR_DOCK_DB_PATH: join(root, "operator-dock.sqlite"),
    OPERATOR_DOCK_MIGRATIONS_DIR: resolve("migrations")
  });
}

describe("daemon server", () => {
  it("returns health status", async () => {
    const app = await buildApp({
      config: testConfig(),
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/health"
    });

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json()).status).toBe("ok");
  });

  it("creates a task and emits a live event", async () => {
    const eventBus = new EventBus();
    const events: unknown[] = [];
    eventBus.subscribe((event) => events.push(event));

    const app = await buildApp({
      config: testConfig(),
      eventBus,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      payload: {
        title: "Write an outline",
        prompt: "Create a short implementation outline.",
        metadata: {
          source: "test"
        }
      }
    });

    await app.close();

    expect(response.statusCode).toBe(201);

    const body = CreateTaskResponseSchema.parse(response.json());
    expect(body.task.status).toBe("queued");
    expect(body.task.title).toBe("Write an outline");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task.created",
      payload: {
        task: {
          id: body.task.id
        }
      }
    });
  });
});

