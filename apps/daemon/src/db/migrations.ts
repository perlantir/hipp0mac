import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseConnection } from "./types.js";

export function runMigrations(database: DatabaseConnection, migrationsDir: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as Array<{ version: string }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    if (applied.has(file)) {
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), "utf8");

    database.exec("BEGIN;");
    try {
      database.exec(sql);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(file, new Date().toISOString());
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw new Error(`Failed to apply migration ${file}: ${(error as Error).message}`);
    }
  }
}

