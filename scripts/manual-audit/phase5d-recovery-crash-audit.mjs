#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  api,
  assertFreshDaemonBuild,
  configureAuditWorkspace,
  currentDaemonPid,
  defaultDaemonUrl,
  loadBearerToken,
  parseArgs,
  resolveApproval,
  resolveApprovalAndKillDaemon,
  restoreWorkspace,
  sleep,
  waitForDaemonRespawn
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const daemonUrl = args.get("daemon-url") ?? defaultDaemonUrl;
const workspaceRoot = resolve(args.get("workspace") ?? "/tmp/operator-dock-phase5d-manual-audit-workspace");
const killDelayMs = Number.parseInt(args.get("kill-delay-ms") ?? "100", 10);
const approvalKillDelayMs = Number.parseInt(args.get("approval-kill-delay-ms") ?? "25", 10);
const keepWorkspace = args.get("keep-workspace") === "true";
let token;

if (isDirectRun()) {
  let previousWorkspace;
  try {
    token = await loadBearerToken(args);
    await assertFreshDaemonBuild(daemonUrl, token);
    previousWorkspace = await configureAuditWorkspace(daemonUrl, token, workspaceRoot);
    await run();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (!keepWorkspace && previousWorkspace !== undefined) {
      await restoreWorkspace(daemonUrl, token, previousWorkspace);
    }
  }
}

async function run() {
  console.log(`Using daemon ${daemonUrl}`);
  console.log(`Using audit workspace ${workspaceRoot}`);
  console.log(`Killing daemon ${killDelayMs}ms after agent request starts.`);

  await crashMidPlanStep();
  await crashMidVerificationWindow();
  await crashDuringRecoveryPath();
  await crashWithConsumedApprovalInFlight();

  console.log("\nPASS: Phase 5D recovery crash audit harness completed.");
}

async function crashMidPlanStep() {
  console.log("\n[agent loop] crash mid-plan-step");
  const taskId = await createTask("Phase 5D audit: plan crash", "Plan crash audit [mock-delay-ms=5000]");
  const crash = await runAgentAndKill(taskId, { maxIterations: 1, plannerProviderId: "mock" }, killDelayMs);
  console.log(`  killed daemon pid ${crash.killedPid}; respawned pid ${crash.newPid}`);
  const result = await runAgent(taskId, { maxIterations: 5, plannerProviderId: "mock" });
  assertStatus(result, "completed", "rerun after plan crash should complete");
  await assertReplayInvariant(taskId);
}

async function crashMidVerificationWindow() {
  console.log("\n[agent loop] crash mid-verification/tool boundary");
  const taskId = await createTask("Phase 5D audit: verification crash", "Verification crash audit [mock-step-delay-ms=5000]");
  const crash = await runAgentAndKill(taskId, { maxIterations: 1, plannerProviderId: "mock" }, killDelayMs);
  console.log(`  killed daemon pid ${crash.killedPid}; respawned pid ${crash.newPid}`);
  const result = await runAgent(taskId, { maxIterations: 5, plannerProviderId: "mock" });
  assertStatus(result, "completed", "rerun after verification/tool-boundary crash should complete");
  await assertReplayInvariant(taskId);
}

async function crashDuringRecoveryPath() {
  console.log("\n[agent loop] crash during safety recovery path");
  const taskId = await createTask("Phase 5D audit: recovery crash", "Recovery crash audit [mock-plan=safety-block]");
  const crash = await runAgentAndKill(taskId, { maxIterations: 1, plannerProviderId: "mock" }, Math.max(25, Math.floor(killDelayMs / 2)));
  console.log(`  killed daemon pid ${crash.killedPid}; respawned pid ${crash.newPid}`);
  const result = await runAgent(taskId, { maxIterations: 2, plannerProviderId: "mock" });
  assertStatus(result, "step_failed", "safety-block recovery rerun should fail the step without executing it");
  await assertReplayInvariant(taskId);
}

async function crashWithConsumedApprovalInFlight() {
  console.log("\n[agent loop] crash with consumed approval in flight");
  const taskId = await createTask("Phase 5D audit: consumed approval", "Consumed approval audit [mock-plan=approval]");
  const first = await runAgent(taskId, { maxIterations: 1, plannerProviderId: "mock" });
  assertStatus(first, "awaiting_approval", "approval audit should pause for shell.run approval");
  const approval = await latestPendingApproval("shell.run");
  const crash = await resolveApprovalAndKillDaemon(daemonUrl, token, approval.id, approvalKillDelayMs);
  console.log(`  killed daemon pid ${crash.killedPid}; respawned pid ${crash.newPid}`);
  const second = await runAgent(taskId, { maxIterations: 1, plannerProviderId: "mock" });
  assertStatus(second, "awaiting_approval", "rerun after consumed approval crash should request a fresh approval");
  const fresh = await latestPendingApproval("shell.run");
  if (fresh.id === approval.id) {
    throw new Error("Expected a fresh pending approval after consumed approval recovery.");
  }
  await resolveApproval(daemonUrl, token, fresh.id, false);
  await assertReplayInvariant(taskId);
}

async function createTask(title, prompt) {
  const response = await api(daemonUrl, token, "/v1/tasks", {
    method: "POST",
    body: {
      title,
      prompt,
      priority: "normal",
      metadata: { phase: "5D", audit: true }
    }
  });
  return response.task.id;
}

async function runAgent(taskId, body) {
  const response = await api(daemonUrl, token, `/v1/tasks/${taskId}/agent/run`, {
    method: "POST",
    body
  });
  return response.result;
}

async function runAgentAndKill(taskId, body, delayMs) {
  const pid = await currentDaemonPid(daemonUrl);
  const request = fetch(new URL(`/v1/tasks/${taskId}/agent/run`, daemonUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  }).catch((error) => error);

  await sleep(delayMs);
  killPid(pid);
  await Promise.race([
    request,
    sleep(750)
  ]);
  const newPid = await waitForDaemonRespawn(daemonUrl, token, pid);
  return { killedPid: pid, newPid };
}

async function latestPendingApproval(toolName) {
  const response = await api(daemonUrl, token, "/v1/tools/approvals");
  const approval = [...response.approvals]
    .filter((candidate) => candidate.toolName === toolName && candidate.status === "pending")
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  if (approval === undefined) {
    throw new Error(`Expected a pending ${toolName} approval.`);
  }
  return approval;
}

async function assertReplayInvariant(taskId) {
  const response = await api(daemonUrl, token, `/v1/tasks/${taskId}/agent/replay`);
  const replay = response.replay;
  if (replay.modelInvocations !== 0) {
    throw new Error(`Replay invoked models for ${taskId}.`);
  }
  if (replay.reexecutedWriteOrExternalTools !== 0) {
    throw new Error(`Replay re-executed write/external tools for ${taskId}.`);
  }
}

function assertStatus(result, expected, message) {
  if (result.status !== expected) {
    throw new Error(`${message}. Expected ${expected}, got ${result.status}: ${JSON.stringify(result)}`);
  }
}

function killPid(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}
