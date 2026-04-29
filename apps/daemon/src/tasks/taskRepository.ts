import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "../db/types.js";
import type { Task, TaskCreateInput } from "@operator-dock/protocol";

interface TaskRow {
  id: string;
  project_id: string | null;
  title: string;
  prompt: string;
  status: Task["status"];
  priority: Task["priority"];
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export class TaskRepository {
  constructor(private readonly database: DatabaseConnection) {}

  createTask(input: TaskCreateInput): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      prompt: input.prompt,
      status: "queued",
      priority: input.priority,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now
    };

    this.database
      .prepare(`
        INSERT INTO tasks (
          id,
          project_id,
          title,
          prompt,
          status,
          priority,
          metadata_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.projectId ?? null,
        task.title,
        task.prompt,
        task.status,
        task.priority,
        JSON.stringify(task.metadata),
        task.createdAt,
        task.updatedAt
      );

    return task;
  }

  listTasks(): Task[] {
    const rows = this.database
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC")
      .all() as unknown as TaskRow[];

    return rows.map(mapTaskRow);
  }
}

function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    priority: row.priority,
    metadata: JSON.parse(row.metadata_json) as Task["metadata"],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
