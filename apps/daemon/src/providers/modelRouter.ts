import type {
  JsonValue,
  ModelPurpose,
  ModelRouterChatRequest,
  ModelRouterChatResponse,
  ProviderConfig,
  ProviderId
} from "@operator-dock/protocol";
import type { CredentialStore } from "./credentialStore.js";

export interface ModelProviderAdapter {
  readonly providerId: ProviderId;
  chat(request: ModelRouterChatRequest, model: string): Promise<ModelRouterChatResponse>;
  stream?(request: ModelRouterChatRequest, model: string): AsyncIterable<ModelRouterChatResponse>;
}

export class ModelRouter {
  constructor(
    private readonly providers: ProviderConfig[],
    private readonly adapters: Map<ProviderId, ModelProviderAdapter>
  ) {}

  async chat(request: ModelRouterChatRequest): Promise<ModelRouterChatResponse> {
    const provider = this.selectProvider(request.purpose, request.providerId);
    const adapter = this.adapters.get(provider.id);

    if (adapter === undefined) {
      throw new Error(`No model adapter is registered for ${provider.id}.`);
    }

    const roleDefault = provider.roleDefaults[purposeToConfigKey(request.purpose)];
    return adapter.chat(request, request.model ?? roleDefault ?? provider.defaultModel ?? provider.models[0]?.id ?? "auto");
  }

  selectProvider(purpose: ModelPurpose, explicitProviderId?: ProviderId): ProviderConfig {
    if (explicitProviderId !== undefined) {
      const explicit = this.providers.find((provider) => provider.id === explicitProviderId && provider.enabled);
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
    return {
      providerId: this.providerId,
      model,
      message: {
        role: "assistant",
        content: `Mock ${this.providerId} response for ${request.purpose}.`,
        toolCalls: []
      },
      usage: {}
    };
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
      model,
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
      model,
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
      model,
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
  fetcher: typeof fetch = fetch
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

  return new ModelRouter(providers, adapters);
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
