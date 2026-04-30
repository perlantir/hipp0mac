#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  api,
  approvalIdFrom,
  configureAuditWorkspace,
  countOccurrences,
  defaultDaemonUrl,
  defaultWorkspaceRoot,
  executeTool,
  loadBearerToken,
  newAuditKey,
  parseArgs,
  prepareCleanDir,
  resolveApproval,
  resolveApprovalAndKillDaemon,
  restoreWorkspace,
  shellQuote,
  writeTextFile
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const daemonUrl = args.get("daemon-url") ?? defaultDaemonUrl;
const workspaceRoot = resolve(args.get("workspace") ?? defaultWorkspaceRoot);
const killDelayMs = Number.parseInt(args.get("kill-delay-ms") ?? "25", 10);
const keepWorkspace = args.get("keep-workspace") === "true";
let token;

if (isDirectRun()) {
  token = await loadBearerToken(args);
  const previousWorkspace = await configureAuditWorkspace(daemonUrl, token, workspaceRoot);

  try {
    await run(token);
  } finally {
    if (!keepWorkspace) {
      await restoreWorkspace(daemonUrl, token, previousWorkspace);
    }
  }
}

async function run(token) {
  const auditRoot = join(workspaceRoot, "tasks", "manual-audit");
  await prepareCleanDir(auditRoot);
  console.log(`Using daemon ${daemonUrl}`);
  console.log(`Using audit workspace ${workspaceRoot}`);
  console.log(`Killing daemon ${killDelayMs}ms after approval POST starts.`);

  await fsDeleteCrashAudit(auditRoot);
  await fsAppendCrashAudit(auditRoot);
  await shellRunConsumedApprovalAudit(auditRoot);

  console.log("\nPASS: Phase 5B manual crash/idempotency audit harness completed.");
}

async function fsDeleteCrashAudit(auditRoot) {
  console.log("\n[fs.delete] crash audit");
  const key = newAuditKey();
  const relativePath = "tasks/manual-audit/delete-target.txt";
  const absolutePath = join(workspaceRoot, relativePath);
  await writeTextFile(absolutePath, "delete me\n");

  const pending = await executeTool(daemonUrl, token, {
    taskId: "manual-audit-fs-delete",
    toolName: "fs.delete",
    idempotencyKey: key,
    input: { path: relativePath }
  });
  assertStatus(pending, "waiting_for_approval", "fs.delete should require approval");
  const approvalId = approvalIdFrom(pending);
  const crash = await resolveApprovalAndKillDaemon(daemonUrl, token, approvalId, killDelayMs);
  console.log(`  killed daemon pid ${crash.killedPid}; respawned pid ${crash.newPid}`);

  const retryPending = await executeTool(daemonUrl, token, {
    taskId: "manual-audit-fs-delete-retry",
    toolName: "fs.delete",
    idempotencyKey: key,
    input: { path: relativePath }
  });
  const retry = retryPending.status === "waiting_for_approval"
    ? await resolveApproval(daemonUrl, token, approvalIdFrom(retryPending), true)
    : retryPending;
  assertStatus(retry, "completed", "fs.delete retry should complete");
  if (existsSync(absolutePath)) {
    throw new Error("fs.delete audit failed: target file still exists after retry.");
  }

  const secondRetryPending = await executeTool(daemonUrl, token, {
    taskId: "manual-audit-fs-delete-second-retry",
    toolName: "fs.delete",
    idempotencyKey: key,
    input: { path: relativePath }
  });
  const secondRetry = secondRetryPending.status === "waiting_for_approval"
    ? await resolveApproval(daemonUrl, token, approvalIdFrom(secondRetryPending), true)
    : secondRetryPending;
  assertStatus(secondRetry, "completed", "fs.delete second retry should be idempotent");
  console.log("  verified target deleted and same key re-submit does not error");
}

async function fsAppendCrashAudit(auditRoot) {
  console.log("\n[fs.append] crash audit");
  const key = newAuditKey();
  const relativePath = "tasks/manual-audit/append-target.txt";
  const absolutePath = join(workspaceRoot, relativePath);
  await writeTextFile(absolutePath, "");

  const pending = await executeTool(daemonUrl, token, {
    taskId: "manual-audit-fs-append",
    toolName: "fs.append",
    idempotencyKey: key,
    input: { path: relativePath, content: "hello\n" }
  });
  assertStatus(pending, "waiting_for_approval", "fs.append should require approval");
  const crash = await resolveApprovalAndKillDaemon(daemonUrl, token, approvalIdFrom(pending), killDelayMs);
  console.log(`  killed daemon pid ${crash.killedPid}; respawned pid ${crash.newPid}`);

  const retryPending = await executeTool(daemonUrl, token, {
    taskId: "manual-audit-fs-append-retry",
    toolName: "fs.append",
    idempotencyKey: key,
    input: { path: relativePath, content: "hello\n" }
  });
  const retry = retryPending.status === "waiting_for_approval"
    ? await resolveApproval(daemonUrl, token, approvalIdFrom(retryPending), true)
    : retryPending;
  assertStatus(retry, "completed", "fs.append retry should complete");

  const contents = await readFile(absolutePath, "utf8");
  const count = countOccurrences(contents, "hello\n");
  if (count !== 1) {
    throw new Error(`fs.append audit failed: expected exactly one "hello\\n", found ${count}. Contents: ${JSON.stringify(contents)}`);
  }
  console.log("  verified append content appears exactly once");
}

async function shellRunConsumedApprovalAudit(auditRoot) {
  console.log("\n[shell.run] consumed approval audit");
  const key = newAuditKey();
  const markerPath = join(auditRoot, "shell-run-marker.txt");
  await rm(markerPath, { force: true });
  const command = `sleep 5; printf ${shellQuote("ran\n")} > ${shellQuote(markerPath)}`;

  const pending = await executeTool(daemonUrl, token, {
    taskId: "manual-audit-shell-run",
    toolName: "shell.run",
    idempotencyKey: key,
    input: { command, timeoutMs: 10_000 }
  });
  assertStatus(pending, "waiting_for_approval", "shell.run should require approval");
  const crash = await resolveApprovalAndKillDaemon(daemonUrl, token, approvalIdFrom(pending), killDelayMs);
  console.log(`  killed daemon pid ${crash.killedPid}; respawned pid ${crash.newPid}`);

  if (existsSync(markerPath)) {
    throw new Error("shell.run audit failed: marker exists, meaning the orphaned command executed after crash.");
  }

  const reapproval = await executeTool(daemonUrl, token, {
    taskId: "manual-audit-shell-run-reapproval",
    toolName: "shell.run",
    idempotencyKey: key,
    input: { command, timeoutMs: 10_000 }
  });
  assertStatus(reapproval, "waiting_for_approval", "shell.run retry should ask for a fresh approval");
  if (args.get("leave-reapproval-pending") !== "true") {
    await resolveApproval(daemonUrl, token, approvalIdFrom(reapproval), false);
    console.log("  verified fresh approval was requested; denied it for cleanup");
  } else {
    console.log(`  verified fresh approval was requested; left approval ${approvalIdFrom(reapproval)} pending`);
  }

  if (existsSync(markerPath)) {
    throw new Error("shell.run audit failed: marker exists after denial cleanup.");
  }
}

function assertStatus(result, expected, message) {
  if (result.status !== expected) {
    throw new Error(`${message}. Expected ${expected}, got ${result.status}: ${JSON.stringify(result.error ?? result.output ?? {})}`);
  }
}

function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}
