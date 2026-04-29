import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
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
import { runMigrations } from "./db/migrations.js";
import { ProjectionCipher } from "./db/projectionCipher.js";
import { encryptProjectionRows } from "./db/projectionEncryptionMigration.js";
import { ApiError } from "./errors.js";
import {
  EncryptedFileCanonicalEventStore,
  type CanonicalEventStore
} from "./events/canonicalEventStore.js";
import { emitLegacyProjectionNoticeIfNeeded } from "./events/legacyProjectionMigration.js";
import { MacOSKeychainCredentialStore, type CredentialStore } from "./providers/credentialStore.js";
import { ProviderSettingsRepository } from "./providers/providerSettingsRepository.js";
import { registerProviderRoutes } from "./providers/routes.js";
import {
  bearerTokenFromAuthorizationHeader,
  isAuthorizedBearerToken,
  MacOSKeychainDaemonAuthTokenStore,
  type DaemonAuthTokenStore
} from "./security/daemonAuth.js";
import { redactedFastifyLoggerOptions } from "./security/redactedLogger.js";
import { TaskRepository } from "./tasks/taskRepository.js";
import { fsToolDefinitions } from "./tools/fs/fsToolDefinitions.js";
import { FileOperationLogger } from "./tools/fs/fileOperationLogger.js";
import { FsToolService } from "./tools/fs/fsToolService.js";
import { shellRunInteractiveTool, shellRunTool } from "./tools/shell/shellTools.js";
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
  database?: DatabaseSync;
  eventBus?: EventBus;
  credentialStore?: CredentialStore;
  authTokenStore?: DaemonAuthTokenStore;
  canonicalEventStore?: CanonicalEventStore;
  logger?: boolean;
  logStream?: Writable;
  migrate?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? openDatabase(config.databasePath);
  const eventBus = options.eventBus ?? new EventBus();
  const credentialStore = options.credentialStore ?? new MacOSKeychainCredentialStore();
  const bearerToken = await (options.authTokenStore ?? new MacOSKeychainDaemonAuthTokenStore()).loadOrCreateToken();
  const projectionCipher = new ProjectionCipher(bearerToken);
  const canonicalEventStore = options.canonicalEventStore
    ?? new EncryptedFileCanonicalEventStore(
      join(dirname(config.databasePath), "event-store", "node-projection-events.log"),
      bearerToken
    );

  if (options.migrate !== false) {
    runMigrations(database, config.migrationsDir);
    encryptProjectionRows(database, projectionCipher);
    emitLegacyProjectionNoticeIfNeeded(database, canonicalEventStore);
  }

  const tasks = new TaskRepository(database);
  const providerSettings = new ProviderSettingsRepository(database);
  const workspace = new WorkspaceService(new WorkspaceSettingsRepository(database));
  const toolEvents = new ToolEventStore(database, eventBus, canonicalEventStore, projectionCipher);
  const fileLogger = new FileOperationLogger(database, projectionCipher);
  const fsTools = new FsToolService(workspace, toolEvents, fileLogger);
  const toolApprovals = new ToolApprovalStore(database, projectionCipher);
  const toolRuntime = new ToolRuntime({
    workspace,
    events: toolEvents,
    approvals: toolApprovals
  });
  for (const tool of fsToolDefinitions(fsTools)) {
    toolRuntime.register(tool);
  }
  toolRuntime.register(shellRunTool());
  toolRuntime.register(shellRunInteractiveTool());
  const app = Fastify({
    logger: options.logger === false ? false : redactedFastifyLoggerOptions(options.logStream)
  });

  app.addHook("onRequest", async (request, reply) => {
    const actual = bearerTokenFromAuthorizationHeader(request.headers.authorization);
    if (!isAuthorizedBearerToken(actual, bearerToken)) {
      return reply.status(401).send({
        error: {
          code: "AUTH_REQUIRED",
          message: "Operator Dock daemon bearer token is required."
        }
      });
    }
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
