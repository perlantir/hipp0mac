import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CreateTaskResponseSchema, HealthResponseSchema } from "@operator-dock/protocol";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { EventBus } from "../src/websocket/eventBus.js";
import { authHeaders, authStore, testBearerToken } from "./harness.js";

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
    HOME: root,
    OPERATOR_DOCK_DB_PATH: join(root, "operator-dock.sqlite"),
    OPERATOR_DOCK_MIGRATIONS_DIR: resolve("migrations")
  });
}

describe("daemon server", () => {
  it("rejects invalid daemon host by default", () => {
    expect(() => loadConfig({
      OPERATOR_DOCK_HOST: "0.0.0.0"
    })).toThrow("Refusing to bind Operator Dock daemon to non-loopback host");
  });

  it("requires bearer token auth on HTTP requests", async () => {
    const app = await buildApp({
      config: testConfig(),
      authTokenStore: authStore(),
      logger: false
    });

    const missing = await app.inject({
      method: "GET",
      url: "/health"
    });
    const wrong = await app.inject({
      method: "GET",
      url: "/health",
      headers: authHeaders("wrong-token")
    });
    const ok = await app.inject({
      method: "GET",
      url: "/health",
      headers: authHeaders()
    });

    await app.close();

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(ok.statusCode).toBe(200);
  });

  it("requires bearer token auth on WebSocket event stream upgrades", async () => {
    const app = await buildApp({
      config: testConfig(),
      authTokenStore: authStore(),
      logger: false
    });

    const missing = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: {
        connection: "upgrade",
        upgrade: "websocket"
      }
    });

    await app.close();

    expect(missing.statusCode).toBe(401);
  });

  it("returns health status", async () => {
    const app = await buildApp({
      config: testConfig(),
      authTokenStore: authStore(),
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: authHeaders()
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
      authTokenStore: authStore(),
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeaders(),
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

  it("migrates default Node daemon state from the v0 dot-folder layout", () => {
    const home = mkdtempSync(join(tmpdir(), "operator-dock-node-state-"));
    tempRoots.add(home);
    const legacyRoot = join(home, ".operator-dock");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, "operator-dock.sqlite"), "legacy-db");
    writeFileSync(join(legacyRoot, "operator-dock.sqlite-wal"), "legacy-wal");

    const config = loadConfig({
      HOME: home,
      OPERATOR_DOCK_MIGRATIONS_DIR: resolve("migrations")
    });

    const stateRoot = join(home, "Library", "Application Support", "OperatorDock", "state");
    expect(config.databasePath).toBe(join(stateRoot, "operator-dock.sqlite"));
    expect(existsSync(join(stateRoot, "operator-dock.sqlite"))).toBe(true);
    expect(existsSync(join(stateRoot, "operator-dock.sqlite-wal"))).toBe(true);
    expect(existsSync(join(stateRoot, ".migrated-from-v0"))).toBe(true);
    expect(existsSync(legacyRoot)).toBe(false);
  });

  it("redacts secrets from Fastify error logs", async () => {
    const logSink = new CapturingWritable();
    const app = await buildApp({
      config: testConfig(),
      authTokenStore: authStore(),
      logger: true,
      logStream: logSink
    });
    app.post("/__test/secret-error", async (request) => {
      throw new Error(`synthetic failure ${(request.body as { apiKey: string }).apiKey} token=super-secret-token`);
    });

    const response = await app.inject({
      method: "POST",
      url: "/__test/secret-error",
      headers: authHeaders(),
      payload: {
        apiKey: "sk-test-secret-value"
      }
    });

    await app.close();

    expect(response.statusCode).toBe(500);
    expect(logSink.output).toContain("[REDACTED]");
    expect(logSink.output).not.toContain("sk-test-secret-value");
    expect(logSink.output).not.toContain("super-secret-token");
  });
});

class CapturingWritable extends Writable {
  output = "";

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString("utf8");
    callback();
  }
}
