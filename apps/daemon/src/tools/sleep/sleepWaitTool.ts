import {
  SleepWaitInputSchema,
  SleepWaitOutputSchema,
  type SleepWaitInput,
  type SleepWaitOutput
} from "@operator-dock/protocol";
import { sleepWaitManifest } from "../runtime/toolManifests.js";
import { ToolRuntimeError, type ToolDefinition } from "../runtime/toolTypes.js";

export function sleepWaitTool(): ToolDefinition<SleepWaitInput, SleepWaitOutput> {
  return {
    name: "sleep.wait",
    version: "1",
    description: "Wait for a bounded duration. Test-only pure tool.",
    riskLevel: "safe",
    manifest: sleepWaitManifest(),
    inputSchema: SleepWaitInputSchema,
    outputSchema: SleepWaitOutputSchema,
    execute: async (input, context) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, input.durationMs);
        const abort = (): void => {
          clearTimeout(timer);
          reject(new ToolRuntimeError(
            context.signal.reason === "timeout" ? "TOOL_TIMEOUT" : "TOOL_CANCELLED",
            context.signal.reason === "timeout" ? "Tool execution timed out." : "Tool execution was cancelled."
          ));
        };
        context.signal.addEventListener("abort", abort, { once: true });
        if (context.signal.aborted) {
          abort();
        }
      });
      return { durationMs: input.durationMs };
    }
  };
}
