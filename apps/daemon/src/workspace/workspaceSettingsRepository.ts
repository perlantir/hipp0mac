import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceSettings } from "@operator-dock/protocol";

interface SettingsRow {
  value_json: string;
}

const workspaceSettingsKey = "workspace.config";

export class WorkspaceSettingsRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(): WorkspaceSettings | undefined {
    const row = this.database
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(workspaceSettingsKey) as SettingsRow | undefined;

    if (row === undefined) {
      return undefined;
    }

    return JSON.parse(row.value_json) as WorkspaceSettings;
  }

  save(settings: WorkspaceSettings): WorkspaceSettings {
    this.database
      .prepare(`
        INSERT INTO settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `)
      .run(workspaceSettingsKey, JSON.stringify(settings), settings.updatedAt);

    return settings;
  }
}

