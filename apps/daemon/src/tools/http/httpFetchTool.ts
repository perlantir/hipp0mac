import {
  HttpFetchInputSchema,
  HttpFetchOutputSchema,
  type HttpFetchInput,
  type HttpFetchOutput
} from "@operator-dock/protocol";
import { httpFetchManifest } from "../runtime/toolManifests.js";
import type { ToolDefinition } from "../runtime/toolTypes.js";

export function httpFetchTool(): ToolDefinition<HttpFetchInput, HttpFetchOutput> {
  return {
    name: "http.fetch",
    version: "1",
    description: "Fetch an allowlisted HTTP(S) URL with GET semantics.",
    riskLevel: "safe",
    manifest: httpFetchManifest(),
    inputSchema: HttpFetchInputSchema,
    outputSchema: HttpFetchOutputSchema,
    execute: async (input, context) => {
      const response = await fetch(input.url, {
        method: "GET",
        headers: input.headers,
        signal: context.signal
      });
      const body = await response.text();
      return HttpFetchOutputSchema.parse({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        sizeBytes: Buffer.byteLength(body, "utf8")
      });
    }
  };
}
