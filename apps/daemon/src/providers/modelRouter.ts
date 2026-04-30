import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z, type ZodTypeAny } from "zod";
import {
  ModelRouterChatRequestSchema,
  ModelRouterChatResponseSchema,
  type ModelProviderErrorKind,
  type ModelFallbackTarget,
  JsonValue,
  ModelPurpose,
  ModelRouterChatRequest,
  ModelRouterChatResponse,
  ProviderConfig,
  ProviderId
} from "@operator-dock/protocol";
import type { CredentialStore } from "./credentialStore.js";
import type { EventStore } from "../persistence/eventStore.js";
import { canonicalJson } from "../persistence/canonicalJson.js";

export type ModelStreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; id?: string; name: string; input?: Record<string, JsonValue> }
  | { type: "done"; tokensIn?: number; tokensOut?: number; modelVersion?: string };

export interface ModelProviderAdapter {
  readonly providerId: ProviderId;
  chat(request: ModelRouterChatRequest, model: string): Promise<ModelRouterChatResponse>;
  stream?(request: ModelRouterChatRequest, model: string): AsyncIterable<ModelStreamChunk>;
}

export interface ModelCallEventSink {
  modelCallIntended(input: ModelCallIntendedInput): string;
  modelCallResult(input: ModelCallResultInput): string;
  modelFallbackUsed(input: ModelFallbackUsedInput): string;
}

export interface ModelCallIntendedInput {
  taskId: string;
  purpose: ModelPurpose;
  promptHash: string;
  promptVersion: string;
  modelHint: string;
  providerId: ProviderId;
  schemaDigest?: string;
  maxTokens?: number;
  fallbackChain: ModelFallbackTarget[];
}

export interface ModelCallResultInput {
  taskId: string;
  intendedEventId: string;
  status: "ok" | "model_error" | "orphan_discarded";
  providerId: ProviderId;
  providerName: string;
  model: string;
  modelVersion: string;
  promptVersion: string;
  outputText: string;
  toolCalls: JsonValue[];
  tokensIn?: number;
  tokensOut?: number;
  providerError?: ModelProviderErrorKind;
  latencyMs: number;
  synthesized?: boolean;
}

export interface ModelFallbackUsedInput {
  taskId: string;
  fromProviderId: ProviderId;
  toProviderId: ProviderId;
  reason: ModelProviderErrorKind;
}

export interface ModelRouterOptions {
  eventSink?: ModelCallEventSink;
  crashAfterIntended?: (context: { taskId: string; intendedEventId: string; providerId: ProviderId }) => void | Promise<void>;
}

export class ModelProviderError extends Error {
  constructor(
    readonly kind: ModelProviderErrorKind,
    message: string
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

export class EventStoreModelEventSink implements ModelCallEventSink {
  constructor(private readonly eventStore: EventStore) {}

  modelCallIntended(input: ModelCallIntendedInput): string {
    return this.eventStore.append(input.taskId, "model_call_intended", {
      purpose: input.purpose,
      promptHash: input.promptHash,
      promptVersion: input.promptVersion,
      modelHint: input.modelHint,
      providerId: input.providerId,
      schemaDigest: input.schemaDigest ?? null,
      maxTokens: input.maxTokens ?? null,
      fallbackChain: input.fallbackChain as unknown as JsonValue
    });
  }

  modelCallResult(input: ModelCallResultInput): string {
    return this.eventStore.append(input.taskId, "model_call_result", {
      intendedEventId: input.intendedEventId,
      status: input.status,
      providerId: input.providerId,
      providerName: input.providerName,
      model: input.model,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
      outputText: input.outputText,
      toolCalls: input.toolCalls,
      tokensIn: input.tokensIn ?? null,
      tokensOut: input.tokensOut ?? null,
      providerError: input.providerError ?? null,
      latencyMs: input.latencyMs,
      synthesized: input.synthesized ?? false
    });
  }

  modelFallbackUsed(input: ModelFallbackUsedInput): string {
    return this.eventStore.append(input.taskId, "model_fallback_used", {
      fromProviderId: input.fromProviderId,
      toProviderId: input.toProviderId,
      reason: input.reason
    });
  }
}

export class ModelRouter {
  constructor(
    private readonly providers: ProviderConfig[],
    private readonly adapters: Map<ProviderId, ModelProviderAdapter>,
    private readonly options: ModelRouterOptions = {}
  ) {}

  async chat(request: ModelRouterChatRequest): Promise<ModelRouterChatResponse> {
    return this.generate(ModelRouterChatRequestSchema.parse(request), "chat");
  }

  async stream(request: ModelRouterChatRequest): Promise<ModelRouterChatResponse> {
    return this.generate(ModelRouterChatRequestSchema.parse({ ...request, stream: true }), "stream");
  }

  async chatStructured<Schema extends ZodTypeAny>(
    request: ModelRouterChatRequest,
    schema: Schema
  ): Promise<{ response: ModelRouterChatResponse; parsed: z.infer<Schema> }> {
    let nextRequest = ModelRouterChatRequestSchema.parse(request);
    let lastError: unknown;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await this.chat(nextRequest);
      try {
        const json = JSON.parse(response.message.content) as unknown;
        return {
          response,
          parsed: schema.parse(json) as z.infer<Schema>
        };
      } catch (error) {
        lastError = error;
        if (attempt === 2) {
          break;
        }

        nextRequest = {
          ...nextRequest,
          messages: [
            ...nextRequest.messages,
            {
              role: "user",
              content: `The previous response failed schema validation. Return only valid JSON for the requested schema. Parse error: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }

    throw new Error(`Model response failed schema validation twice: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private async generate(
    request: ModelRouterChatRequest,
    mode: "chat" | "stream"
  ): Promise<ModelRouterChatResponse> {
    const attempts = this.providerAttempts(request);
    let lastError: unknown;

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]!;
      const adapter = this.adapters.get(attempt.provider.id);

      if (adapter === undefined) {
        throw new Error(`No model adapter is registered for ${attempt.provider.id}.`);
      }

      const taskId = taskIdFor(request);
      const promptHash = promptHashForRequest(request);
      const intendedEventId = this.options.eventSink?.modelCallIntended({
        taskId,
        purpose: request.purpose,
        promptHash,
        promptVersion: request.promptVersion,
        modelHint: attempt.model,
        providerId: attempt.provider.id,
        ...(request.schemaDigest === undefined ? {} : { schemaDigest: request.schemaDigest }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        fallbackChain: request.fallbackChain
      }) ?? "";
      await this.options.crashAfterIntended?.({ taskId, intendedEventId, providerId: attempt.provider.id });

      const startedAt = performance.now();
      try {
        const response = mode === "stream"
          ? await this.generateStream(adapter, request, attempt.model)
          : await adapter.chat(request, attempt.model);
        const normalized = normalizeModelResponse(response, attempt.provider.id, attempt.model, request.promptVersion);
        this.options.eventSink?.modelCallResult({
          taskId,
          intendedEventId,
          status: "ok",
          providerId: normalized.providerId,
          providerName: normalized.providerName ?? normalized.providerId,
          model: normalized.model,
          modelVersion: normalized.modelVersion ?? normalized.model,
          promptVersion: normalized.promptVersion ?? request.promptVersion,
          outputText: normalized.message.content,
          toolCalls: normalized.message.toolCalls as unknown as JsonValue[],
          ...(normalized.usage.inputTokens === undefined ? {} : { tokensIn: normalized.usage.inputTokens }),
          ...(normalized.usage.outputTokens === undefined ? {} : { tokensOut: normalized.usage.outputTokens }),
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt))
        });
        return normalized;
      } catch (error) {
        lastError = error;
        const kind = classifyProviderError(error);
        this.options.eventSink?.modelCallResult({
          taskId,
          intendedEventId,
          status: "model_error",
          providerId: attempt.provider.id,
          providerName: attempt.provider.displayName,
          model: attempt.model,
          modelVersion: attempt.model,
          promptVersion: request.promptVersion,
          outputText: "",
          toolCalls: [],
          providerError: kind,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt))
        });

        const next = attempts[index + 1];
        if (next === undefined || !isRetryableProviderError(kind)) {
          break;
        }

        this.options.eventSink?.modelFallbackUsed({
          taskId,
          fromProviderId: attempt.provider.id,
          toProviderId: next.provider.id,
          reason: kind
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Model provider failed.");
  }

  private async generateStream(
    adapter: ModelProviderAdapter,
    request: ModelRouterChatRequest,
    model: string
  ): Promise<ModelRouterChatResponse> {
    if (adapter.stream === undefined) {
      return adapter.chat(request, model);
    }

    let content = "";
    const toolCalls: Array<{ id: string; name: string; input: Record<string, JsonValue> }> = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let modelVersion = model;

    for await (const chunk of adapter.stream(request, model)) {
      if (chunk.type === "text") {
        content += chunk.text;
      } else if (chunk.type === "tool_call") {
        toolCalls.push({
          id: chunk.id ?? `tool-call-${toolCalls.length + 1}`,
          name: chunk.name,
          input: chunk.input ?? {}
        });
      } else {
        inputTokens = chunk.tokensIn;
        outputTokens = chunk.tokensOut;
        modelVersion = chunk.modelVersion ?? modelVersion;
      }
    }

    return {
      providerId: adapter.providerId,
      providerName: adapter.providerId,
      model,
      modelVersion,
      promptVersion: request.promptVersion,
      message: {
        role: "assistant",
        content,
        toolCalls
      },
      usage: {
        inputTokens,
        outputTokens
      }
    };
  }

  private providerAttempts(request: ModelRouterChatRequest): Array<{ provider: ProviderConfig; model: string }> {
    const primary = this.selectProvider(request.purpose, request.providerId);
    const roleDefault = primary.roleDefaults[purposeToConfigKey(request.purpose)];
    const attempts = [{
      provider: primary,
      model: request.model ?? roleDefault ?? primary.defaultModel ?? primary.models[0]?.id ?? "auto"
    }];

    for (const fallback of request.fallbackChain) {
      const provider = this.selectProvider(request.purpose, fallback.providerId);
      const fallbackDefault = provider.roleDefaults[purposeToConfigKey(request.purpose)];
      attempts.push({
        provider,
        model: fallback.model ?? fallbackDefault ?? provider.defaultModel ?? provider.models[0]?.id ?? "auto"
      });
    }

    return attempts;
  }

  selectProvider(purpose: ModelPurpose, explicitProviderId?: ProviderId): ProviderConfig {
    if (explicitProviderId !== undefined) {
      const explicit = this.providers.find((provider) =>
        provider.id === explicitProviderId
        && (provider.enabled || explicitProviderId === "mock")
      );
      if (explicit === undefined) {
        throw new Error(`Provider ${explicitProviderId} is not enabled.`);
      }

      return explicit;
    }

    const enabled = this.providers.find((provider) => provider.enabled && provider.roleDefaults[purposeToConfigKey(purpose)] !== undefined);
    if (enabled !== undefined) {
      return enabled;
    }

    const fallback = this.providers.find((provider) => provider.enabled);
    if (fallback === undefined) {
      throw new Error("No enabled model provider is configured.");
    }

    return fallback;
  }
}

export class MockModelProviderAdapter implements ModelProviderAdapter {
  constructor(readonly providerId: ProviderId) {}

  async chat(request: ModelRouterChatRequest, model: string): Promise<ModelRouterChatResponse> {
    const delay = mockDelayMs(request);
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (this.providerId === "mock" && request.purpose === "planner") {
      const taskId = taskIdFor(request);
      return {
        providerId: this.providerId,
        providerName: this.providerId,
        model,
        modelVersion: model,
        promptVersion: request.promptVersion,
        message: {
          role: "assistant",
          content: JSON.stringify(mockPlan(taskId, request.messages.at(-1)?.content ?? "Mock task")),
          toolCalls: []
        },
        usage: {}
      };
    }

    return {
      providerId: this.providerId,
      providerName: this.providerId,
      model,
      modelVersion: model,
      promptVersion: request.promptVersion,
      message: {
        role: "assistant",
        content: `Mock ${this.providerId} response for ${request.purpose}.`,
        toolCalls: []
      },
      usage: {}
    };
  }
}

function mockDelayMs(request: ModelRouterChatRequest): number {
  const content = request.messages.map((message) => message.content).join("\n");
  const match = content.match(/\[mock-delay-ms=(\d{1,5})]/);
  if (match?.[1] === undefined) {
    return 0;
  }
  return Math.min(Number.parseInt(match[1], 10), 10_000);
}

function mockPlan(taskId: string, taskGoal: string): JsonValue {
  const variant = mockPlanVariant(taskGoal);
  return {
    schemaVersion: 1,
    planId: `mock-plan-${taskId}`,
    taskId,
    revision: 0,
    parentPlanId: null,
    taskGoal,
    assumptions: [],
    constraints: [],
    successCriteria: [{
      id: "success",
      description: "The mock step completed.",
      predicate: { op: "always" },
      requiresEvidence: true
    }],
    doneConditions: [{
      id: "done",
      description: "The mock task has evidence.",
      predicate: { op: "always" },
      requiresEvidence: true
    }],
    forbiddenActions: [],
    expectedStepEstimate: 1,
    risks: [],
    expectedArtifacts: [],
    openQuestions: [],
    steps: [mockStep(taskGoal, variant)]
  };
}

function mockPlanVariant(taskGoal: string): "sleep" | "safety-block" | "approval" {
  if (taskGoal.includes("[mock-plan=safety-block]")) {
    return "safety-block";
  }
  if (taskGoal.includes("[mock-plan=approval]")) {
    return "approval";
  }
  return "sleep";
}

function mockStep(taskGoal: string, variant: "sleep" | "safety-block" | "approval"): Record<string, JsonValue> {
  const base = {
    stepId: "S1",
    selectedToolVersion: "1",
    successCheck: { op: "always" },
    fallbackStrategies: [],
    estimatedValue: 1,
    dependsOn: [],
    produces: ["mock-evidence"],
    consumes: [],
    taint: false
  };

  if (variant === "safety-block") {
    return {
      ...base,
      intent: "Attempt a blocked command for recovery audit.",
      selectedTool: "shell.exec",
      toolInput: { command: "rm", args: ["-rf", "/"] },
      expectedObservation: "The safety governor blocks the command.",
      riskLevel: "critical",
      rationale: "Deterministic safety-block plan for recovery audit."
    };
  }

  if (variant === "approval") {
    return {
      ...base,
      intent: "Request approval for a delayed shell command.",
      selectedTool: "shell.run",
      toolInput: { command: "sleep 5", timeoutMs: 10_000 },
      expectedObservation: "The command waits for approval.",
      riskLevel: "medium",
      rationale: "Deterministic approval plan for recovery audit."
    };
  }

  return {
    ...base,
    intent: "Run deterministic mock wait.",
    selectedTool: "sleep.wait",
    toolInput: { durationMs: mockStepDelayMs(taskGoal) },
    expectedObservation: "The wait completes.",
    riskLevel: "low",
    rationale: "Deterministic mock plan for eval and audit mode."
  };
}

function mockStepDelayMs(taskGoal: string): number {
  const match = taskGoal.match(/\[mock-step-delay-ms=(\d{1,5})]/);
  if (match?.[1] === undefined) {
    return 0;
  }
  return Math.min(Number.parseInt(match[1], 10), 10_000);
}

export class FixtureMockModelProviderAdapter implements ModelProviderAdapter {
  constructor(
    readonly providerId: ProviderId,
    private readonly fixtureRoot: string
  ) {}

  async chat(request: ModelRouterChatRequest, model: string): Promise<ModelRouterChatResponse> {
    return responseFromChunks(this.providerId, request, model, this.loadFixture(request).response.chunks);
  }

  async *stream(request: ModelRouterChatRequest, _model: string): AsyncIterable<ModelStreamChunk> {
    for (const chunk of this.loadFixture(request).response.chunks) {
      yield chunk;
    }
  }

  private loadFixture(request: ModelRouterChatRequest): ModelFixture {
    const promptHash = promptHashForRequest(request);
    const fixturePath = join(this.fixtureRoot, `${promptHash}.json`);
    if (!existsSync(fixturePath)) {
      throw new Error(`Missing mock model fixture for prompt hash ${promptHash}. Record ${fixturePath}.`);
    }

    const parsed = ModelFixtureSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")) as unknown);
    if (parsed.promptHash !== promptHash) {
      throw new Error(`Mock model fixture promptHash mismatch. Expected ${promptHash}, found ${parsed.promptHash}.`);
    }
    if (parsed.simulateError !== undefined) {
      throw new ModelProviderError(parsed.simulateError.kind, `Mock provider simulated ${parsed.simulateError.kind}.`);
    }

    return parsed;
  }
}

export class OpenAICompatibleModelProviderAdapter implements ModelProviderAdapter {
  constructor(
    readonly providerId: ProviderId,
    private readonly baseURL: string,
    private readonly credentialStore: CredentialStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly apiKeyRequired = true
  ) {}

  async chat(request: ModelRouterChatRequest, model: string): Promise<ModelRouterChatResponse> {
    const apiKey = await this.credentialStore.getCredential(this.providerId);
    if (apiKey === undefined && this.apiKeyRequired) {
      throw new Error("API key is not configured in the local Keychain.");
    }

    const headers: Record<string, string> = {
      "content-type": "application/json"
    };

    if (apiKey !== undefined) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await this.fetcher(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: request.messages,
        tools: request.tools.length > 0
          ? request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters
            }
          }))
          : undefined,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Provider returned HTTP ${response.status}.`);
    }

    const body = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };

    const message = body.choices?.[0]?.message;
    return {
      providerId: this.providerId,
      providerName: this.providerId,
      model,
      modelVersion: model,
      promptVersion: request.promptVersion,
      message: {
        role: "assistant",
        content: message?.content ?? "",
        toolCalls: (message?.tool_calls ?? []).map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function?.name ?? "tool",
          input: parseToolArguments(toolCall.function?.arguments)
        }))
      },
      usage: {
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens
      }
    };
  }
}

export class AnthropicModelProviderAdapter implements ModelProviderAdapter {
  readonly providerId = "anthropic" as const;

  constructor(
    private readonly credentialStore: CredentialStore,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async chat(request: ModelRouterChatRequest, model: string): Promise<ModelRouterChatResponse> {
    const apiKey = await this.credentialStore.getCredential("anthropic");
    if (apiKey === undefined) {
      throw new Error("API key is not configured in the local Keychain.");
    }

    const response = await this.fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: request.messages.filter((message) => message.role !== "system"),
        system: request.messages.find((message) => message.role === "system")?.content,
        tools: request.tools.length > 0
          ? request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters
          }))
          : undefined,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Provider returned HTTP ${response.status}.`);
    }

    const body = await response.json() as {
      content?: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input?: Record<string, JsonValue> }
      >;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };

    return {
      providerId: "anthropic",
      providerName: "anthropic",
      model,
      modelVersion: model,
      promptVersion: request.promptVersion,
      message: {
        role: "assistant",
        content: body.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "",
        toolCalls: body.content?.flatMap((part) => part.type === "tool_use"
          ? [{
            id: part.id,
            name: part.name,
            input: part.input ?? {}
          }]
          : []) ?? []
      },
      usage: {
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens
      }
    };
  }
}

export class OllamaModelProviderAdapter implements ModelProviderAdapter {
  readonly providerId = "ollama" as const;

  constructor(
    private readonly endpoint: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async chat(request: ModelRouterChatRequest, model: string): Promise<ModelRouterChatResponse> {
    const response = await this.fetcher(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        tools: request.tools.length > 0 ? request.tools : undefined,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Local endpoint returned HTTP ${response.status}.`);
    }

    const body = await response.json() as {
      message?: {
        content?: string;
        tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, JsonValue> } }>;
      };
    };

    return {
      providerId: "ollama",
      providerName: "ollama",
      model,
      modelVersion: model,
      promptVersion: request.promptVersion,
      message: {
        role: "assistant",
        content: body.message?.content ?? "",
        toolCalls: (body.message?.tool_calls ?? []).map((toolCall, index) => ({
          id: `ollama-tool-${index + 1}`,
          name: toolCall.function?.name ?? "tool",
          input: toolCall.function?.arguments ?? {}
        }))
      },
      usage: {}
    };
  }
}

export function buildDefaultModelRouter(
  providers: ProviderConfig[],
  credentialStore: CredentialStore,
  fetcher: typeof fetch = fetch,
  options: ModelRouterOptions = {}
): ModelRouter {
  const adapters = new Map<ProviderId, ModelProviderAdapter>([
    ["openai", new OpenAICompatibleModelProviderAdapter("openai", "https://api.openai.com/v1", credentialStore, fetcher)],
    ["anthropic", new AnthropicModelProviderAdapter(credentialStore, fetcher)],
    ["openrouter", new OpenAICompatibleModelProviderAdapter("openrouter", "https://openrouter.ai/api/v1", credentialStore, fetcher)]
  ]);

  const ollama = providers.find((provider) => provider.id === "ollama");
  adapters.set(
    "ollama",
    new OllamaModelProviderAdapter(ollama?.endpoint ?? "http://127.0.0.1:11434", fetcher)
  );

  const lmStudio = providers.find((provider) => provider.id === "lmstudio");
  adapters.set(
    "lmstudio",
    new OpenAICompatibleModelProviderAdapter(
      "lmstudio",
      `${lmStudio?.endpoint ?? "http://127.0.0.1:1234"}/v1`,
      credentialStore,
      fetcher,
      false
    )
  );

  const mock = providers.find((provider) => provider.id === "mock");
  if (mock !== undefined) {
    adapters.set("mock", new MockModelProviderAdapter("mock"));
  }

  return new ModelRouter(providers, adapters, options);
}

export function promptHashForRequest(request: ModelRouterChatRequest): string {
  return createHash("sha256").update(canonicalJson({
    purpose: request.purpose,
    promptVersion: request.promptVersion,
    schemaDigest: request.schemaDigest ?? null,
    maxTokens: request.maxTokens ?? null,
    messages: request.messages,
    tools: request.tools
  })).digest("hex");
}

export function reconcileModelCallOrphans(taskId: string, eventStore: EventStore): void {
  const events = eventStore.readAll(taskId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.eventType !== "model_call_intended") {
      continue;
    }

    const hasResult = events.slice(index + 1).some((candidate) =>
      candidate.eventType === "model_call_result"
      && candidate.payload.intendedEventId === event.eventId
    );
    if (hasResult) {
      return;
    }

    eventStore.append(taskId, "model_call_result", {
      intendedEventId: event.eventId,
      status: "orphan_discarded",
      providerId: typeof event.payload.providerId === "string" ? event.payload.providerId : "unknown",
      providerName: typeof event.payload.providerId === "string" ? event.payload.providerId : "unknown",
      model: typeof event.payload.modelHint === "string" ? event.payload.modelHint : "unknown",
      modelVersion: typeof event.payload.modelHint === "string" ? event.payload.modelHint : "unknown",
      promptVersion: typeof event.payload.promptVersion === "string" ? event.payload.promptVersion : "unknown",
      outputText: "",
      toolCalls: [],
      tokensIn: null,
      tokensOut: null,
      providerError: "other",
      latencyMs: 0,
      synthesized: true
    });
    eventStore.append(taskId, "model_orphan_discarded", {
      intendedEventId: event.eventId
    });
    return;
  }
}

function purposeToConfigKey(purpose: ModelPurpose): keyof ProviderConfig["roleDefaults"] {
  switch (purpose) {
  case "planner": return "planner";
  case "executor": return "executor";
  case "verifier": return "verifier";
  case "summarizer": return "summarizer";
  case "memory_curator": return "memoryCurator";
  }
}

function normalizeModelResponse(
  response: ModelRouterChatResponse,
  providerId: ProviderId,
  model: string,
  promptVersion: string
): ModelRouterChatResponse {
  return ModelRouterChatResponseSchema.parse({
    ...response,
    providerId: response.providerId ?? providerId,
    providerName: response.providerName ?? response.providerId ?? providerId,
    model: response.model ?? model,
    modelVersion: response.modelVersion ?? response.model ?? model,
    promptVersion: response.promptVersion ?? promptVersion
  });
}

function taskIdFor(request: ModelRouterChatRequest): string {
  const taskId = request.metadata.taskId;
  return typeof taskId === "string" && taskId.trim().length > 0 ? taskId : "model-router";
}

function classifyProviderError(error: unknown): ModelProviderErrorKind {
  if (error instanceof ModelProviderError) {
    return error.kind;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("rate") || message.includes("429")) {
    return "rate_limit";
  }
  if (message.includes("server") || message.includes("500") || message.includes("503")) {
    return "server_error";
  }
  if (message.includes("auth") || message.includes("401") || message.includes("403")) {
    return "auth";
  }
  if (message.includes("bad request") || message.includes("400")) {
    return "bad_request";
  }

  return "other";
}

function isRetryableProviderError(kind: ModelProviderErrorKind): boolean {
  return kind === "rate_limit" || kind === "server_error";
}

function responseFromChunks(
  providerId: ProviderId,
  request: ModelRouterChatRequest,
  model: string,
  chunks: ModelStreamChunk[]
): ModelRouterChatResponse {
  let content = "";
  const toolCalls: Array<{ id: string; name: string; input: Record<string, JsonValue> }> = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let modelVersion = model;

  for (const chunk of chunks) {
    if (chunk.type === "text") {
      content += chunk.text;
    } else if (chunk.type === "tool_call") {
      toolCalls.push({
        id: chunk.id ?? `tool-call-${toolCalls.length + 1}`,
        name: chunk.name,
        input: chunk.input ?? {}
      });
    } else {
      inputTokens = chunk.tokensIn;
      outputTokens = chunk.tokensOut;
      modelVersion = chunk.modelVersion ?? modelVersion;
    }
  }

  return ModelRouterChatResponseSchema.parse({
    providerId,
    providerName: providerId,
    model,
    modelVersion,
    promptVersion: request.promptVersion,
    message: {
      role: "assistant",
      content,
      toolCalls
    },
    usage: {
      inputTokens,
      outputTokens
    }
  });
}

const ModelStreamChunkSchema: z.ZodType<ModelStreamChunk> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string()
  }),
  z.object({
    type: z.literal("tool_call"),
    id: z.string().optional(),
    name: z.string().min(1),
    input: z.record(z.string(), z.any()).optional()
  }),
  z.object({
    type: z.literal("done"),
    tokensIn: z.number().int().nonnegative().optional(),
    tokensOut: z.number().int().nonnegative().optional(),
    modelVersion: z.string().min(1).optional()
  })
]) as z.ZodType<ModelStreamChunk>;

const ModelFixtureSchema = z.object({
  promptHash: z.string().min(1),
  response: z.object({
    chunks: z.array(ModelStreamChunkSchema)
  }),
  simulateError: z.object({
    kind: z.enum(["rate_limit", "server_error", "bad_request", "auth", "other"])
  }).optional()
});

type ModelFixture = z.infer<typeof ModelFixtureSchema>;

function parseToolArguments(input: string | undefined): Record<string, JsonValue> {
  if (input === undefined || input.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, JsonValue>
      : {};
  } catch {
    return {};
  }
}
