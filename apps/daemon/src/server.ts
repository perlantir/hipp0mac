import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import {
  CreateTaskResponseSchema,
  HealthResponseSchema,
  TaskCreateInputSchema,
  TaskListResponseSchema,
  type OperatorEvent
} from "@operator-dock/protocol";
import { loadConfig, type DaemonConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import type { DatabaseConnection } from "./db/types.js";
import { runMigrations } from "./db/migrations.js";
import { ApiError } from "./errors.js";
import { EventStore } from "./persistence/eventStore.js";
import { LockController } from "./persistence/lockController.js";
import { OperatorDockPaths } from "./persistence/paths.js";
import {
  PersistenceKeyManager,
  persistenceKeyManagerFromEnv,
  type PersistenceKeys
} from "./persistence/persistenceKeys.js";
import { MacOSKeychainCredentialStore, type CredentialStore } from "./providers/credentialStore.js";
import { ProviderSettingsRepository } from "./providers/providerSettingsRepository.js";
import { registerProviderRoutes } from "./providers/routes.js";
import {
  bearerTokenFromRequest,
  daemonAuthTokenStoreFromEnv,
  tokensEqual,
  type DaemonAuthTokenStore
} from "./security/daemonAuth.js";
import { fastifyLoggerOptions } from "./security/redactedLogger.js";
import { TaskRepository } from "./tasks/taskRepository.js";
import { fsToolDefinitions } from "./tools/fs/fsToolDefinitions.js";
import { FileOperationLogger } from "./tools/fs/fileOperationLogger.js";
import { FsToolService } from "./tools/fs/fsToolService.js";
import { httpFetchTool } from "./tools/http/httpFetchTool.js";
import { shellExecTool, shellRunInteractiveTool, shellRunTool } from "./tools/shell/shellTools.js";
import { sleepWaitTool } from "./tools/sleep/sleepWaitTool.js";
import { BudgetManager } from "./tools/runtime/budgetManager.js";
import { IdempotencyStore } from "./tools/runtime/idempotencyStore.js";
import { ToolManifestRegistry } from "./tools/runtime/manifestRegistry.js";
import { SafetyGovernor } from "./tools/runtime/safetyGovernor.js";
import { ToolApprovalStore } from "./tools/runtime/toolApprovalStore.js";
import { ToolEventStore } from "./tools/runtime/toolEventStore.js";
import { ToolRuntime } from "./tools/runtime/toolRuntime.js";
import { registerToolRuntimeRoutes } from "./tools/runtime/routes.js";
import { EventBus, registerEventRoutes } from "./websocket/eventBus.js";
import { registerWorkspaceRoutes } from "./workspace/routes.js";
import { WorkspaceSettingsRepository } from "./workspace/workspaceSettingsRepository.js";
import { WorkspaceService } from "./workspace/workspaceService.js";

export interface BuildAppOptions {
  config?: DaemonConfig;
  database?: DatabaseConnection;
  eventBus?: EventBus;
  credentialStore?: CredentialStore;
  authTokenStore?: DaemonAuthTokenStore;
  persistenceKeyManager?: PersistenceKeyManager;
  persistenceKeys?: PersistenceKeys;
  logger?: boolean;
  logStream?: Writable;
  migrate?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const paths = new OperatorDockPaths(config.stateRoot);
  paths.createLayout();
  const persistenceKeys = options.persistenceKeys
    ?? await (options.persistenceKeyManager
      ?? persistenceKeyManagerFromEnv(process.env)).loadOrCreateKeys();
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? openDatabase({
    databasePath: config.databasePath,
    encryptionKey: persistenceKeys.encryptionKey
  });
  const eventBus = options.eventBus ?? new EventBus();
  const credentialStore = options.credentialStore ?? new MacOSKeychainCredentialStore();
  const authToken = await (options.authTokenStore ?? daemonAuthTokenStoreFromEnv(process.env)).loadOrCreateToken();
  const eventStore = new EventStore(paths, persistenceKeys);
  const locks = new LockController(paths, eventStore);

  if (options.migrate !== false) {
    runMigrations(database, config.migrationsDir);
    emitLegacyProjectionNotice(database, eventStore);
  }

  const tasks = new TaskRepository(database);
  const providerSettings = new ProviderSettingsRepository(database);
  const workspace = new WorkspaceService(new WorkspaceSettingsRepository(database));
  const toolEvents = new ToolEventStore(database, eventBus, eventStore);
  const fileLogger = new FileOperationLogger(database);
  const idempotency = new IdempotencyStore(paths);
  const fsTools = new FsToolService(workspace, toolEvents, fileLogger, locks, idempotency);
  const toolApprovals = new ToolApprovalStore(database);
  const manifests = new ToolManifestRegistry(eventStore);
  const safety = new SafetyGovernor(eventStore, workspace);
  const budgets = new BudgetManager(eventStore);
  const toolRuntime = new ToolRuntime({
    workspace,
    events: toolEvents,
    approvals: toolApprovals,
    locks,
    manifests,
    safety,
    budgets
  });
  for (const tool of fsToolDefinitions(fsTools, idempotency)) {
    toolRuntime.register(tool);
  }
  toolRuntime.register(shellExecTool());
  toolRuntime.register(shellRunTool());
  toolRuntime.register(shellRunInteractiveTool());
  toolRuntime.register(httpFetchTool());
  toolRuntime.register(sleepWaitTool());
  await toolRuntime.reconcileAll();
  const app = Fastify({
    logger: fastifyLoggerOptions({
      enabled: options.logger ?? true,
      ...(options.logStream === undefined ? {} : { stream: options.logStream })
    })
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!tokensEqual(bearerTokenFromRequest(request), authToken)) {
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid daemon bearer token."
        }
      });
    }

    return undefined;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      });
      return;
    }

    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request or response payload failed validation.",
          details: error.flatten()
        }
      });
      return;
    }

    app.log.error(error);
    void reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected daemon error."
      }
    });
  });

  app.addHook("onClose", async () => {
    if (ownsDatabase) {
      database.close();
    }
  });

  app.get("/health", async () => {
    database.prepare("SELECT 1").get();

    return HealthResponseSchema.parse({
      status: "ok",
      service: "operator-dock-daemon",
      version: "0.1.0",
      database: "ok",
      timestamp: new Date().toISOString()
    });
  });

  app.get("/v1/tasks", async () => {
    return TaskListResponseSchema.parse({
      tasks: tasks.listTasks()
    });
  });

  app.post("/v1/tasks", async (request, reply) => {
    const parsed = TaskCreateInputSchema.safeParse(request.body);

    if (!parsed.success) {
      throw new ApiError(400, "VALIDATION_ERROR", "Invalid task creation payload.", parsed.error.flatten());
    }

    const task = tasks.createTask(parsed.data);
    eventStore.append(task.id, "task_created", {
      title: task.title,
      priority: task.priority,
      metadata: task.metadata
    });
    const event: OperatorEvent = {
      id: randomUUID(),
      type: "task.created",
      occurredAt: task.createdAt,
      payload: {
        task
      }
    };

    eventBus.publish(event);

    return reply.status(201).send(
      CreateTaskResponseSchema.parse({
        task
      })
    );
  });

  await registerEventRoutes(app, eventBus);
  await registerProviderRoutes(app, {
    settings: providerSettings,
    credentialStore
  });
  await registerWorkspaceRoutes(app, {
    workspace,
    runtime: toolRuntime
  });
  await registerToolRuntimeRoutes(app, {
    runtime: toolRuntime,
    approvals: toolApprovals
  });

  return app;
}

function emitLegacyProjectionNotice(database: DatabaseConnection, eventStore: EventStore): void {
  const marker = database
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get("phase5a.legacy_data_present_emitted") as { value_json: string } | undefined;
  if (marker !== undefined) {
    return;
  }

  const toolExecutions = (database.prepare("SELECT COUNT(*) AS count FROM tool_executions WHERE legacy = 1").get() as { count: number }).count;
  const toolEvents = (database.prepare("SELECT COUNT(*) AS count FROM tool_events WHERE legacy = 1").get() as { count: number }).count;
  const fileLogs = (database.prepare("SELECT COUNT(*) AS count FROM file_operation_logs WHERE legacy = 1").get() as { count: number }).count;

  if (toolExecutions + toolEvents + fileLogs > 0) {
    eventStore.append("daemon", "legacy_data_present", {
      toolExecutions,
      toolEvents,
      fileOperationLogs: fileLogs
    });
  }

  database
    .prepare(`
      INSERT INTO settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `)
    .run(
      "phase5a.legacy_data_present_emitted",
      JSON.stringify({ schemaVersion: 1, emitted: true }),
      new Date().toISOString()
    );
}
