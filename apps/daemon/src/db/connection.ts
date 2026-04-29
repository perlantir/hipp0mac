import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import type { DatabaseConnection } from "./types.js";

export interface OpenDatabaseOptions {
  databasePath: string;
  encryptionKey: Buffer;
  readonly?: boolean;
}

interface SchemaObjectRow {
  type: "table" | "index" | "trigger" | "view";
  name: string;
  tbl_name: string;
  sql: string | null;
}

export function openDatabase(options: OpenDatabaseOptions): DatabaseConnection {
  if (options.encryptionKey.length !== 32) {
    throw new Error("SQLite encryption key must be 32 bytes.");
  }

  mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  migratePlaintextDatabaseIfNeeded(options.databasePath, options.encryptionKey);

  const database = new Database(options.databasePath, {
    ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
    ...(options.readonly === undefined ? {} : { fileMustExist: options.readonly })
  });
  applySqlCipherKey(database, options.encryptionKey);
  database.prepare("SELECT count(*) AS count FROM sqlite_master").get();
  database.pragma("foreign_keys = ON");
  if (options.readonly !== true) {
    database.pragma("journal_mode = WAL");
  }
  return database;
}

function applySqlCipherKey(database: DatabaseConnection, key: Buffer): void {
  database.pragma("cipher = 'sqlcipher'");
  database.pragma("legacy = 4");
  database.key(key);
}

function migratePlaintextDatabaseIfNeeded(databasePath: string, encryptionKey: Buffer): void {
  if (!existsSync(databasePath) || !hasPlaintextSqliteHeader(databasePath)) {
    return;
  }

  const tempPath = `${databasePath}.encrypted-v1.tmp`;
  const backupPath = `${databasePath}.plaintext-v0.bak`;
  rmSync(tempPath, { force: true });

  const source = new Database(databasePath);
  const target = new Database(tempPath);
  try {
    applySqlCipherKey(target, encryptionKey);
    exportPlaintextDatabase(source, target);
    target.prepare("SELECT count(*) AS count FROM sqlite_master").get();
  } finally {
    source.close();
    target.close();
  }

  renameSync(databasePath, backupPath);
  renameSync(tempPath, databasePath);
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

function hasPlaintextSqliteHeader(databasePath: string): boolean {
  return readFileSync(databasePath).subarray(0, 16).toString("utf8") === "SQLite format 3\0";
}

function exportPlaintextDatabase(source: DatabaseConnection, target: DatabaseConnection): void {
  const schemaRows = source
    .prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END
    `)
    .all() as SchemaObjectRow[];

  for (const row of schemaRows.filter((entry) => entry.type === "table" && entry.sql !== null)) {
    target.exec(row.sql!);
    copyRows(source, target, row.name);
  }

  for (const row of schemaRows.filter((entry) => entry.type !== "table" && entry.sql !== null)) {
    target.exec(row.sql!);
  }
}

function copyRows(source: DatabaseConnection, target: DatabaseConnection, tableName: string): void {
  const columns = source.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>;
  if (columns.length === 0) {
    return;
  }

  const names = columns.map((column) => column.name);
  const rows = source.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all() as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    return;
  }

  const placeholders = names.map(() => "?").join(", ");
  const insert = target.prepare(`
    INSERT INTO ${quoteIdentifier(tableName)} (${names.map(quoteIdentifier).join(", ")})
    VALUES (${placeholders})
  `);
  const transaction = target.transaction((records: Array<Record<string, unknown>>) => {
    for (const row of records) {
      insert.run(...names.map((name) => row[name]));
    }
  });
  transaction(rows);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}
