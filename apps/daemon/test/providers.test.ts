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
import { MockModelProviderAdapter, ModelRouter } from "../src/providers/modelRouter.js";

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
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/providers"
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
      logger: false
    });

    const response = await app.inject({
      method: "PUT",
      url: "/v1/providers/ollama",
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
});

