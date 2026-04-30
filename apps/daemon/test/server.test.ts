import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { CreateTaskResponseSchema, HealthResponseSchema } from "@operator-dock/protocol";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { EventStore } from "../src/persistence/eventStore.js";
import { OperatorDockPaths } from "../src/persistence/paths.js";
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

function testConfig() {
  const root = mkdtempSync(join(tmpdir(), "operator-dock-daemon-"));
  tempRoots.add(root);

  return loadConfig({
    HOME: root,
    OPERATOR_DOCK_STATE_ROOT: join(root, "state"),
    OPERATOR_DOCK_DB_PATH: join(root, "operator-dock.sqlite"),
    OPERATOR_DOCK_MIGRATIONS_DIR: resolve("migrations")
  });
}

describe("daemon server", () => {
  it("returns health status", async () => {
    const app = await buildApp({
      config: testConfig(),
      authTokenStore: authStore(),
      persistenceKeyManager: persistenceKeyManager(),
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: authHeaders()
    });

    await app.close();

    expect(response.statusCode).toBe(200);
    const health = HealthResponseSchema.parse(response.json());
    expect(health.status).toBe("ok");
    expect(health.state).toBe("starting");
    expect(health.build.gitCommit).toMatch(/^[0-9a-f]{40}$|^unknown$/);
    expect(health.build.serverFileMtimeMs).toBeGreaterThan(0);
  });

  it("serves health while startup recovery completes in the background", async () => {
    const config = testConfig();
    const keyManager = persistenceKeyManager();
    const keys = await keyManager.loadOrCreateKeys();
    const paths = new OperatorDockPaths(config.stateRoot);
    paths.createLayout();
    const eventStore = new EventStore(paths, keys);
    const taskId = "startup-recovery-health";
    eventStore.append(taskId, "tool_call_intended", {
      executionId: "startup-recovery-execution",
      toolName: "sleep.wait",
      toolVersion: "1",
      idempotencyKey: null,
      resolvedInput: { durationMs: 150 },
      safetyDecision: { eventId: "synthetic", decision: "allow" },
      scopeChecks: [],
      timeoutMs: 5000,
      lockEventId: "synthetic-lock"
    });

    const app = await buildApp({
      config,
      authTokenStore: authStore(),
      persistenceKeys: keys,
      logger: false
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/health`;

    const recoveringResponse = await fetch(url, { headers: authHeaders() });
    const recoveringHealth = HealthResponseSchema.parse(await recoveringResponse.json());
    expect(recoveringHealth.state).toBe("recovering");

    await waitFor(async () => {
      const response = await fetch(url, { headers: authHeaders() });
      const health = HealthResponseSchema.parse(await response.json());
      return health.state === "ready";
    });

    await app.close();

    expect(eventStore.readAll(taskId).some((event) => event.eventType === "tool_call_result")).toBe(true);
    expect(existsSync(paths.startupRecoveryCheckpoint())).toBe(true);
  });

  it("creates a task and emits a live event", async () => {
    const eventBus = new EventBus();
    const events: unknown[] = [];
    eventBus.subscribe((event) => events.push(event));

    const app = await buildApp({
      config: testConfig(),
      eventBus,
      authTokenStore: authStore(),
      persistenceKeyManager: persistenceKeyManager(),
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

  it("requires bearer token auth on HTTP and WebSocket requests", async () => {
    const app = await buildApp({
      config: testConfig(),
      authTokenStore: authStore(),
      persistenceKeyManager: persistenceKeyManager(),
      logger: false
    });

    const missingHttp = await app.inject({
      method: "GET",
      url: "/health"
    });
    const wrongHttp = await app.inject({
      method: "GET",
      url: "/health",
      headers: authHeaders("wrong-token")
    });
    const missingWebSocket = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: {
        connection: "upgrade",
        upgrade: "websocket"
      }
    });

    await app.close();

    expect(missingHttp.statusCode).toBe(401);
    expect(wrongHttp.statusCode).toBe(401);
    expect(missingWebSocket.statusCode).toBe(401);
  });

  it("rejects non-loopback daemon hosts unless explicitly enabled", () => {
    expect(() => loadConfig({ OPERATOR_DOCK_HOST: "0.0.0.0" })).toThrow("Refusing to bind");
    expect(() => loadConfig({ OPERATOR_DOCK_HOST: "localhost" })).toThrow("Refusing to bind");
    expect(loadConfig({
      OPERATOR_DOCK_HOST: "0.0.0.0",
      OPERATOR_DOCK_ALLOW_NETWORK_BIND: "1"
    }).host).toBe("0.0.0.0");
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

  it("encrypts SQLite pages with the persistence master key", async () => {
    const root = mkdtempSync(join(tmpdir(), "operator-dock-sqlcipher-"));
    tempRoots.add(root);
    const config = loadConfig({
      HOME: root,
      OPERATOR_DOCK_STATE_ROOT: join(root, "state"),
      OPERATOR_DOCK_DB_PATH: join(root, "operator-dock.sqlite"),
      OPERATOR_DOCK_MIGRATIONS_DIR: resolve("migrations")
    });
    const app = await buildApp({
      config,
      authTokenStore: authStore(),
      persistenceKeyManager: persistenceKeyManager(),
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeaders(),
      payload: {
        title: "Encrypted SQLite Needle",
        prompt: "Store this in the encrypted page database."
      }
    });

    await app.close();

    expect(response.statusCode).toBe(201);
    expect(readFileSync(config.databasePath)).not.toContain(Buffer.from("Encrypted SQLite Needle"));
    expect(() => openDatabase({
      databasePath: config.databasePath,
      encryptionKey: Buffer.alloc(32, 0x99)
    })).toThrow();
  });

  it("migrates existing plaintext SQLite content to SQLCipher pages", () => {
    const root = mkdtempSync(join(tmpdir(), "operator-dock-sqlcipher-migrate-"));
    tempRoots.add(root);
    const databasePath = join(root, "operator-dock.sqlite");
    const plaintext = new Database(databasePath);
    plaintext.exec("CREATE TABLE secrets (value TEXT NOT NULL); INSERT INTO secrets VALUES ('plaintext migration needle');");
    plaintext.close();
    expect(readFileSync(databasePath).subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");

    const encryptionKey = Buffer.alloc(32, 0x42);
    const encrypted = openDatabase({ databasePath, encryptionKey });

    expect(encrypted.prepare("SELECT value FROM secrets").get()).toEqual({
      value: "plaintext migration needle"
    });
    encrypted.close();
    expect(readFileSync(databasePath)).not.toContain(Buffer.from("plaintext migration needle"));
    expect(readFileSync(databasePath).subarray(0, 16).toString("utf8")).not.toBe("SQLite format 3\0");
    expect(existsSync(`${databasePath}.plaintext-v0.bak`)).toBe(true);
  });

  it("redacts secrets from Fastify error logs", async () => {
    const logSink = new CapturingWritable();
    const app = await buildApp({
      config: testConfig(),
      authTokenStore: authStore(),
      persistenceKeyManager: persistenceKeyManager(),
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for predicate.");
}
