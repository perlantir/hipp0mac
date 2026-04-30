import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelRouterChatRequestSchema,
  ProviderConfigUpdateSchema,
  ProviderListResponseSchema
} from "@operator-dock/protocol";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { MemoryCredentialStore } from "../src/providers/credentialStore.js";
import { defaultProviderConfig, findProviderTemplate } from "../src/providers/catalog.js";
import { ProviderConnectionTester } from "../src/providers/providerConnectionTester.js";
import {
  AnthropicModelProviderAdapter,
  buildDefaultModelRouter,
  MockModelProviderAdapter,
  ModelRouter,
  OllamaModelProviderAdapter,
  OpenAICompatibleModelProviderAdapter
} from "../src/providers/modelRouter.js";
import { authHeaders, authStore, persistenceKeyManager } from "./harness.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots.clear();
});

function testConfig() {
  const root = mkdtempSync(join(tmpdir(), "operator-dock-provider-"));
  tempRoots.add(root);

  return loadConfig({
    HOME: root,
    OPERATOR_DOCK_STATE_ROOT: join(root, "state"),
    OPERATOR_DOCK_DB_PATH: join(root, "operator-dock.sqlite"),
    OPERATOR_DOCK_MIGRATIONS_DIR: resolve("migrations")
  });
}

describe("provider schemas and routes", () => {
  it("validates provider config updates", () => {
    const parsed = ProviderConfigUpdateSchema.parse({
      enabled: true,
      defaultModel: "gpt-4.1-mini"
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed).not.toHaveProperty("apiKey");
  });

  it("lists providers with keychain credential status only", async () => {
    const app = await buildApp({
      config: testConfig(),
      credentialStore: new MemoryCredentialStore({
        openai: "sk-test-secret"
      }),
      authTokenStore: authStore(),
      persistenceKeyManager: persistenceKeyManager(),
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/providers",
      headers: authHeaders()
    });

    await app.close();

    expect(response.statusCode).toBe(200);
    const body = ProviderListResponseSchema.parse(response.json());
    const openAI = body.providers.find((provider) => provider.id === "openai");
    expect(openAI?.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-test-secret");
  });

  it("updates non-secret provider settings", async () => {
    const app = await buildApp({
      config: testConfig(),
      credentialStore: new MemoryCredentialStore({}),
      authTokenStore: authStore(),
      persistenceKeyManager: persistenceKeyManager(),
      logger: false
    });

    const response = await app.inject({
      method: "PUT",
      url: "/v1/providers/ollama",
      headers: authHeaders(),
      payload: {
        enabled: true,
        endpoint: "http://127.0.0.1:11434",
        defaultModel: "llama3.2"
      }
    });

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: {
        id: "ollama",
        enabled: true,
        endpoint: "http://127.0.0.1:11434",
        defaultModel: "llama3.2"
      }
    });
  });
});

describe("provider connection tester", () => {
  it("tests hosted providers without leaking API keys", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const tester = new ProviderConnectionTester(
      new MemoryCredentialStore({
        openai: "sk-sensitive-value"
      }),
      fetcher
    );
    const result = await tester.test(defaultProviderConfig(findProviderTemplate("openai")));

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("sk-sensitive-value");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("tests local providers through their endpoint", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const tester = new ProviderConnectionTester(new MemoryCredentialStore({}), fetcher);
    const result = await tester.test(defaultProviderConfig(findProviderTemplate("ollama")));

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:11434/api/tags", { method: "GET" });
  });
});

describe("model router", () => {
  it("routes chat requests to enabled providers", async () => {
    const provider = {
      ...defaultProviderConfig(findProviderTemplate("openai")),
      enabled: true,
      apiKeyConfigured: true
    };
    const router = new ModelRouter(
      [provider],
      new Map([["openai", new MockModelProviderAdapter("openai")]])
    );
    const request = ModelRouterChatRequestSchema.parse({
      purpose: "planner",
      messages: [
        {
          role: "user",
          content: "Plan the next task."
        }
      ]
    });

    const response = await router.chat(request);

    expect(response.providerId).toBe("openai");
    expect(response.model).toBe("gpt-4.1");
    expect(response.message.content).toContain("Mock openai response");
  });

  it("exercises OpenAI-compatible adapter request and response mapping", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer sk-test-key"
      });
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        tools?: unknown[];
      };
      expect(body.model).toBe("gpt-test");
      expect(body.tools).toHaveLength(1);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "mapped",
            tool_calls: [{
              id: "call-1",
              function: {
                name: "fs.read",
                arguments: "{\"path\":\"README.md\"}"
              }
            }]
          }
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3
        }
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new OpenAICompatibleModelProviderAdapter(
      "openai",
      "https://api.test/v1",
      new MemoryCredentialStore({ openai: "sk-test-key" }),
      fetcher
    );

    const response = await adapter.chat(ModelRouterChatRequestSchema.parse({
      purpose: "planner",
      promptVersion: "prompt-v1",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "fs.read", description: "read", parameters: { type: "object" } }]
    }), "gpt-test");

    expect(response.message.toolCalls).toEqual([{
      id: "call-1",
      name: "fs.read",
      input: { path: "README.md" }
    }]);
    expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 3 });
  });

  it("classifies OpenAI-compatible adapter credential and HTTP failures", async () => {
    const missingKey = new OpenAICompatibleModelProviderAdapter(
      "openai",
      "https://api.test/v1",
      new MemoryCredentialStore({}),
      vi.fn() as unknown as typeof fetch
    );
    await expect(missingKey.chat(ModelRouterChatRequestSchema.parse({
      purpose: "planner",
      messages: [{ role: "user", content: "hi" }]
    }), "gpt-test")).rejects.toThrow(/API key/);

    const httpFailure = new OpenAICompatibleModelProviderAdapter(
      "lmstudio",
      "http://127.0.0.1:1234/v1",
      new MemoryCredentialStore({}),
      vi.fn(async () => new Response("bad", { status: 500 })) as unknown as typeof fetch,
      false
    );
    await expect(httpFailure.chat(ModelRouterChatRequestSchema.parse({
      purpose: "planner",
      messages: [{ role: "user", content: "hi" }]
    }), "local")).rejects.toThrow(/HTTP 500/);
  });

  it("exercises Anthropic and Ollama adapter mappings", async () => {
    const anthropic = new AnthropicModelProviderAdapter(
      new MemoryCredentialStore({ anthropic: "sk-ant-test" }),
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { system?: string; messages: unknown[]; tools?: unknown[] };
        expect(body.system).toBe("system prompt");
        expect(body.messages).toHaveLength(1);
        expect(body.tools).toHaveLength(1);
        return new Response(JSON.stringify({
          content: [
            { type: "text", text: "anthropic text" },
            { type: "tool_use", id: "tool-1", name: "fs.list", input: { path: "." } }
          ],
          usage: { input_tokens: 8, output_tokens: 4 }
        }), { status: 200 });
      }) as unknown as typeof fetch
    );
    const anthropicResponse = await anthropic.chat(ModelRouterChatRequestSchema.parse({
      purpose: "planner",
      promptVersion: "prompt-v1",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hi" }
      ],
      tools: [{ name: "fs.list", description: "list", parameters: { type: "object" } }]
    }), "claude-test");
    expect(anthropicResponse.message).toMatchObject({
      content: "anthropic text",
      toolCalls: [{ id: "tool-1", name: "fs.list", input: { path: "." } }]
    });

    const ollama = new OllamaModelProviderAdapter(
      "http://127.0.0.1:11434",
      vi.fn(async () => new Response(JSON.stringify({
        message: {
          content: "ollama text",
          tool_calls: [{ function: { name: "fs.search", arguments: { query: "needle" } } }]
        }
      }), { status: 200 })) as unknown as typeof fetch
    );
    const ollamaResponse = await ollama.chat(ModelRouterChatRequestSchema.parse({
      purpose: "planner",
      promptVersion: "prompt-v1",
      messages: [{ role: "user", content: "hi" }]
    }), "llama-test");
    expect(ollamaResponse.message.toolCalls).toEqual([{
      id: "ollama-tool-1",
      name: "fs.search",
      input: { query: "needle" }
    }]);
  });

  it("builds the default router with local and mock adapters", async () => {
    const providers = [
      {
        ...defaultProviderConfig(findProviderTemplate("ollama")),
        enabled: false
      },
      {
        id: "mock" as const,
        kind: "local" as const,
        displayName: "Mock",
        enabled: true,
        defaultModel: "mock-model",
        roleDefaults: { planner: "mock-model" },
        apiKeyConfigured: false,
        models: [{
          id: "mock-model",
          displayName: "Mock model",
          capabilities: { vision: false, tools: true, streaming: true }
        }]
      }
    ];
    const router = buildDefaultModelRouter(providers, new MemoryCredentialStore({}));
    const response = await router.chat(ModelRouterChatRequestSchema.parse({
      purpose: "planner",
      providerId: "mock",
      promptVersion: "prompt-v1",
      messages: [{ role: "user", content: "hi" }]
    }));

    expect(response.providerId).toBe("mock");
    expect(response.modelVersion).toBe("mock-model");
  });

  it("mock planner produces deterministic sleep, safety, and approval plans", async () => {
    const adapter = new MockModelProviderAdapter("mock");
    const baseRequest = ModelRouterChatRequestSchema.parse({
      purpose: "planner",
      providerId: "mock",
      promptVersion: "prompt-v1",
      messages: [{ role: "user", content: "hi [mock-step-delay-ms=25]" }],
      metadata: { taskId: "task-mock" }
    });
    const sleepPlan = JSON.parse((await adapter.chat(baseRequest, "mock-loop")).message.content) as { steps: Array<{ selectedTool: string; toolInput: { durationMs?: number } }> };
    const safetyPlan = JSON.parse((await adapter.chat({
      ...baseRequest,
      messages: [{ role: "user", content: "hi [mock-plan=safety-block]" }]
    }, "mock-loop")).message.content) as { steps: Array<{ selectedTool: string }> };
    const approvalPlan = JSON.parse((await adapter.chat({
      ...baseRequest,
      messages: [{ role: "user", content: "hi [mock-plan=approval]" }]
    }, "mock-loop")).message.content) as { steps: Array<{ selectedTool: string }> };

    expect(sleepPlan.steps[0]).toMatchObject({ selectedTool: "sleep.wait", toolInput: { durationMs: 25 } });
    expect(safetyPlan.steps[0]?.selectedTool).toBe("shell.exec");
    expect(approvalPlan.steps[0]?.selectedTool).toBe("shell.run");
  });
});
