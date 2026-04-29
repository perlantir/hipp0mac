import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
import { ApiError } from "./errors.js";
import { MacOSKeychainCredentialStore, type CredentialStore } from "./providers/credentialStore.js";
import { ProviderSettingsRepository } from "./providers/providerSettingsRepository.js";
import { registerProviderRoutes } from "./providers/routes.js";
import { TaskRepository } from "./tasks/taskRepository.js";
import { EventBus, registerEventRoutes } from "./websocket/eventBus.js";

export interface BuildAppOptions {
  config?: DaemonConfig;
  database?: DatabaseSync;
  eventBus?: EventBus;
  credentialStore?: CredentialStore;
  logger?: boolean;
  migrate?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? openDatabase(config.databasePath);
  const eventBus = options.eventBus ?? new EventBus();
  const credentialStore = options.credentialStore ?? new MacOSKeychainCredentialStore();

  if (options.migrate !== false) {
    runMigrations(database, config.migrationsDir);
  }

  const tasks = new TaskRepository(database);
  const providerSettings = new ProviderSettingsRepository(database);
  const app = Fastify({
    logger: options.logger ?? true
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

  return app;
}
