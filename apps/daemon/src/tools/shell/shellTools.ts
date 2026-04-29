import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  ShellRunInputSchema,
  ShellRunInteractiveInputSchema,
  ShellRunOutputSchema,
  type JsonValue,
  type ShellRunInput,
  type ShellRunInteractiveInput,
  type ShellRunOutput
} from "@operator-dock/protocol";
import type { ToolDefinition, ToolExecutionContext } from "../runtime/toolTypes.js";
import { ToolRuntimeError } from "../runtime/toolTypes.js";
import { collectSecretValues, redactText } from "../runtime/secretRedaction.js";
import { classifyShellCommand } from "./commandRiskClassifier.js";

export function shellRunTool(): ToolDefinition<ShellRunInput, ShellRunOutput> {
  return {
    name: "shell.run",
    description: "Run a non-interactive zsh command with bounded output capture.",
    riskLevel: "medium",
    inputSchema: ShellRunInputSchema,
    outputSchema: ShellRunOutputSchema,
    classifyRisk: (input, context) =>
      classifyShellCommand(input.command, context.workspace.getWorkspace()?.rootPath).riskLevel,
    requiresApproval: (input, context) => {
      const classification = classifyShellCommand(input.command, context.workspace.getWorkspace()?.rootPath);
      if (classification.decision === "deny") {
        return {
          reason: classification.reason ?? "This command is denied by the safety governor.",
          riskLevel: "dangerous",
          code: "TOOL_DENIED"
        };
      }
      if (classification.decision === "approval_required" && context.approvalToken === undefined) {
        return {
          reason: classification.reason ?? "This command requires approval.",
          riskLevel: classification.riskLevel
        };
      }

      return undefined;
    },
    execute: (input, context) => runShell(input, context)
  };
}

export function shellRunInteractiveTool(): ToolDefinition<ShellRunInteractiveInput, ShellRunOutput> {
  return {
    name: "shell.runInteractive",
    description: "Run a zsh command and provide stdin for simple interactive flows.",
    riskLevel: "medium",
    inputSchema: ShellRunInteractiveInputSchema,
    outputSchema: ShellRunOutputSchema,
    classifyRisk: (input, context) =>
      classifyShellCommand(input.command, context.workspace.getWorkspace()?.rootPath).riskLevel,
    requiresApproval: (input, context) => {
      const classification = classifyShellCommand(input.command, context.workspace.getWorkspace()?.rootPath);
      if (classification.decision === "deny") {
        return {
          reason: classification.reason ?? "This command is denied by the safety governor.",
          riskLevel: "dangerous",
          code: "TOOL_DENIED"
        };
      }
      if (classification.decision === "approval_required" && context.approvalToken === undefined) {
        return {
          reason: classification.reason ?? "This command requires approval.",
          riskLevel: classification.riskLevel
        };
      }

      return undefined;
    },
    execute: (input, context) => runShell(input, context, input.stdin)
  };
}

async function runShell(
  input: ShellRunInput,
  context: ToolExecutionContext,
  stdin = ""
): Promise<ShellRunOutput> {
  const workspace = context.workspace.requireWorkspace();
  const cwd = input.cwd === undefined ? workspace.rootPath : resolve(input.cwd);
  const redactionInput: JsonValue = {
    command: input.command,
    env: input.env,
    timeoutMs: input.timeoutMs,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.approvalToken === undefined ? {} : { approvalToken: input.approvalToken })
  };
  const secrets = collectSecretValues(redactionInput);

  const result = await new Promise<ShellRunOutput>((resolvePromise, reject) => {
    const child = spawn("/bin/zsh", ["-lc", input.command], {
      cwd,
      env: {
        ...process.env,
        ...input.env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      context.signal.removeEventListener("abort", abort);
      callback();
    };

    const abort = (): void => {
      const reason = context.signal.reason === "timeout" ? "TOOL_TIMEOUT" : "TOOL_CANCELLED";
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      settle(() => {
        reject(new ToolRuntimeError(
          reason,
          reason === "TOOL_TIMEOUT" ? "Tool execution timed out." : "Tool execution was cancelled."
        ));
      });
    };

    context.signal.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      settle(() => {
        reject(new ToolRuntimeError("TOOL_EXECUTION_FAILED", error.message));
      });
    });

    child.on("close", (exitCode) => {
      settle(() => {
        resolvePromise({
          exitCode,
          stdout: redactText(stdout, secrets),
          stderr: redactText(stderr, secrets)
        });
      });
    });

    if (stdin.length > 0) {
      child.stdin.write(stdin);
    }
    child.stdin.end();

    if (context.signal.aborted) {
      abort();
    }
  });

  const rawOutputRef = await writeShellRawOutput(context, result);
  context.setRawOutputRef(rawOutputRef);
  return ShellRunOutputSchema.parse(result);
}

async function writeShellRawOutput(context: ToolExecutionContext, output: ShellRunOutput): Promise<string> {
  const workspace = context.workspace.requireWorkspace();
  const outputDir = join(workspace.folders.logs, "tool-output");
  const outputPath = join(outputDir, `${context.executionId}.log`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    outputPath,
    [
      `exitCode=${output.exitCode === null ? "null" : output.exitCode}`,
      "",
      "stdout:",
      output.stdout,
      "",
      "stderr:",
      output.stderr
    ].join("\n"),
    "utf8"
  );
  return outputPath;
}
