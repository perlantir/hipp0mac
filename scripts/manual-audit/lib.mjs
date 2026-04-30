import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, "../..");
export const defaultDaemonUrl = "http://127.0.0.1:4768";
export const defaultWorkspaceRoot = "/tmp/operator-dock-phase5b-manual-audit-workspace";

export function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = entry.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args.set(key, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

export async function loadBearerToken(args) {
  const explicit = args.get("token") ?? process.env.OPERATOR_DOCK_BEARER_TOKEN;
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-generic-password",
    "-s",
    "com.perlantir.operatordock.daemon",
    "-a",
    "daemon:httpBearerToken",
    "-w"
  ]);
  return stdout.trim();
}

export async function api(daemonUrl, token, path, options = {}) {
  const response = await fetch(new URL(path, daemonUrl), {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  const text = await response.text();
  const body = text.length === 0 ? undefined : JSON.parse(text);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed: HTTP ${response.status} ${text}`);
  }

  return body;
}

export async function assertFreshDaemonBuild(daemonUrl, token) {
  const daemonHealth = await api(daemonUrl, token, "/health");
  const daemonBuild = daemonHealth?.build;
  const localBuild = await localBuildInfo();
  if (!isBuildInfo(daemonBuild) || !sameBuild(daemonBuild, localBuild)) {
    const daemonBuiltAt = isBuildInfo(daemonBuild) ? daemonBuild.serverFileMtimeIso : "unknown";
    const daemonCommit = isBuildInfo(daemonBuild) ? daemonBuild.gitCommit : "unknown";
    throw new Error(
      "Stale daemon detected. "
      + `The Mac app is supervising a daemon built at ${daemonBuiltAt} from commit ${daemonCommit}, `
      + `but the local repo dist was built at ${localBuild.serverFileMtimeIso} from commit ${localBuild.gitCommit}. `
      + "Quit the Mac app and relaunch, then rerun the audit."
    );
  }
}

export async function configureAuditWorkspace(daemonUrl, token, workspaceRoot) {
  let previous;
  try {
    previous = await api(daemonUrl, token, "/v1/workspace");
  } catch {
    previous = undefined;
  }

  await mkdir(workspaceRoot, { recursive: true });
  await api(daemonUrl, token, "/v1/workspace", {
    method: "PUT",
    body: { rootPath: workspaceRoot }
  });

  return previous?.workspace?.rootPath;
}

export async function restoreWorkspace(daemonUrl, token, previousWorkspaceRoot) {
  if (previousWorkspaceRoot === undefined) {
    return;
  }

  await api(daemonUrl, token, "/v1/workspace", {
    method: "PUT",
    body: { rootPath: previousWorkspaceRoot }
  });
}

export async function executeTool(daemonUrl, token, body) {
  const response = await api(daemonUrl, token, "/v1/tools/execute", {
    method: "POST",
    body
  });
  return response.result;
}

export function approvalIdFrom(result) {
  const approvalId = result?.error?.details?.approvalId;
  if (typeof approvalId !== "string") {
    throw new Error(`Expected waiting_for_approval result with approvalId, got ${JSON.stringify(result)}`);
  }
  return approvalId;
}

export async function resolveApproval(daemonUrl, token, approvalId, approved) {
  const response = await api(daemonUrl, token, `/v1/tools/approvals/${approvalId}/resolve`, {
    method: "POST",
    body: { approved }
  });
  return response.result;
}

export async function resolveApprovalAndKillDaemon(daemonUrl, token, approvalId, killDelayMs) {
  const pid = await currentDaemonPid(daemonUrl);
  const approvalRequest = fetch(new URL(`/v1/tools/approvals/${approvalId}/resolve`, daemonUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ approved: true })
  }).catch((error) => error);

  await sleep(killDelayMs);
  await killPid(pid);
  await Promise.race([
    approvalRequest,
    sleep(750)
  ]);
  const newPid = await waitForDaemonRespawn(daemonUrl, token, pid);
  return { killedPid: pid, newPid };
}

export async function currentDaemonPid(daemonUrl) {
  const port = new URL(daemonUrl).port || "4768";
  const { stdout } = await execFileAsync("/usr/sbin/lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t"
  ]);
  const pid = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Could not find daemon PID listening on port ${port}. Is the Mac app supervising the daemon?`);
  }
  return pid;
}

export async function waitForDaemonRespawn(daemonUrl, token, oldPid, timeoutMs = 45_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const pid = await currentDaemonPid(daemonUrl);
      await api(daemonUrl, token, "/health");
      if (pid !== oldPid) {
        return pid;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw new Error(`Daemon did not respawn within ${timeoutMs}ms. Last error: ${lastError?.message ?? "none"}`);
}

export async function prepareCleanDir(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

export async function writeTextFile(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

export function newAuditKey() {
  return randomUUID();
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function countOccurrences(value, needle) {
  if (needle.length === 0) {
    return 0;
  }
  return value.split(needle).length - 1;
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function localBuildInfo() {
  const distServer = join(repoRoot, "apps", "daemon", "dist", "server.js");
  let serverFile;
  try {
    serverFile = await stat(distServer);
  } catch (error) {
    throw new Error(`Local daemon dist file is missing at ${distServer}. Run npm run build, relaunch the Mac app, then rerun the audit.`, {
      cause: error
    });
  }

  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot
  });
  return {
    gitCommit: stdout.trim(),
    serverFileMtimeMs: Math.trunc(serverFile.mtimeMs),
    serverFileMtimeIso: serverFile.mtime.toISOString()
  };
}

function isBuildInfo(value) {
  return value !== undefined
    && value !== null
    && typeof value.gitCommit === "string"
    && typeof value.serverFileMtimeMs === "number"
    && typeof value.serverFileMtimeIso === "string";
}

function sameBuild(daemonBuild, localBuild) {
  return daemonBuild.gitCommit === localBuild.gitCommit
    && Math.trunc(daemonBuild.serverFileMtimeMs) === localBuild.serverFileMtimeMs;
}

async function killPid(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}
