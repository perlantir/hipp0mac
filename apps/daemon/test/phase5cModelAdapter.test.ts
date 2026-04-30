import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ModelRouterChatRequestSchema,
  type ModelRouterChatRequest,
  type ProviderConfig
} from "@operator-dock/protocol";
import { EventStore } from "../src/persistence/eventStore.js";
import { OperatorDockPaths } from "../src/persistence/paths.js";
import { MemoryPersistenceKeychainClient, PersistenceKeyManager } from "../src/persistence/persistenceKeys.js";
import {
  EventStoreModelEventSink,
  FixtureMockModelProviderAdapter,
  ModelProviderError,
  ModelRouter,
  reconcileModelCallOrphans,
  promptHashForRequest,
  type ModelProviderAdapter
} from "../src/providers/modelRouter.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots.clear();
});

describe("Phase 5C model adapter extensions", () => {
  it("model_call_intended_before_invoke and model_call_result_after_complete", async () => {
    const harness = await modelHarness();
    const taskId = "task-model-ordering";
    const adapter: ModelProviderAdapter = {
      providerId: "mock",
      chat: vi.fn(async (_request, model) => {
        const eventTypes = harness.events.readAll(taskId).map((event) => event.eventType);
        expect(eventTypes).toEqual(["model_call_intended"]);
        return {
          providerId: "mock",
          providerName: "mock",
          model,
          modelVersion: "mock-model-v1",
          promptVersion: "prompt-v1",
          message: { role: "assistant", content: "complete", toolCalls: [] },
          usage: { inputTokens: 2, outputTokens: 1 }
        };
      })
    };
    const router = new ModelRouter([mockProvider()], new Map([["mock", adapter]]), {
      eventSink: new EventStoreModelEventSink(harness.events)
    });

    const response = await router.chat(modelRequest({ taskId, promptVersion: "prompt-v1" }));

    expect(response).toMatchObject({
      providerId: "mock",
      providerName: "mock",
      modelVersion: "mock-model-v1",
      promptVersion: "prompt-v1",
      usage: { inputTokens: 2, outputTokens: 1 }
    });
    expect(harness.events.readAll(taskId).map((event) => event.eventType)).toEqual([
      "model_call_intended",
      "model_call_result"
    ]);
  });

  it("streaming_chunks_buffered_until_complete", async () => {
    const harness = await modelHarness();
    const request = modelRequest({ taskId: "task-stream-buffered", promptVersion: "stream-v1" });
    const fixtureRoot = fixtureRootFor(harness.root);
    writeFixture(fixtureRoot, promptHashForRequest(request), {
      chunks: [
        { type: "text", text: "partial " },
        { type: "text", text: "complete" },
        { type: "done", tokensIn: 4, tokensOut: 2, modelVersion: "mock-stream-v1" }
      ]
    });
    const router = new ModelRouter([mockProvider()], new Map([
      ["mock", new FixtureMockModelProviderAdapter("mock", fixtureRoot)]
    ]), {
      eventSink: new EventStoreModelEventSink(harness.events)
    });

    const response = await router.stream(request);
    const events = harness.events.readAll("task-stream-buffered");

    expect(response.message.content).toBe("partial complete");
    expect(events).toHaveLength(2);
    expect(events[0]?.eventType).toBe("model_call_intended");
    expect(events[0]?.payload).not.toHaveProperty("partialText");
    expect(events[1]?.eventType).toBe("model_call_result");
    expect(events[1]?.payload).toMatchObject({
      outputText: "partial complete",
      modelVersion: "mock-stream-v1",
      promptVersion: "stream-v1",
      providerName: "mock"
    });
  });

  it("crash_during_stream_creates_orphan_without_reinvoking_model", async () => {
    const harness = await modelHarness();
    const request = modelRequest({ taskId: "task-stream-crash", promptVersion: "stream-crash-v1" });
    const adapter = new FixtureMockModelProviderAdapter("mock", fixtureRootFor(harness.root));
    const router = new ModelRouter([mockProvider()], new Map([["mock", adapter]]), {
      eventSink: new EventStoreModelEventSink(harness.events),
      crashAfterIntended: () => {
        throw new Error("simulated stream crash");
      }
    });

    await expect(router.stream(request)).rejects.toThrow("simulated stream crash");
    expect(harness.events.readAll("task-stream-crash").map((event) => event.eventType)).toEqual(["model_call_intended"]);

    const chat = vi.spyOn(adapter, "chat");
    await reconcileModelCallOrphans("task-stream-crash", harness.events);
    expect(chat).not.toHaveBeenCalled();
    expect(harness.events.readAll("task-stream-crash").map((event) => event.eventType)).toEqual([
      "model_call_intended",
      "model_call_result",
      "model_orphan_discarded"
    ]);
  });

  it("fallback_on_rate_limit and no_fallback_on_bad_request", async () => {
    const harness = await modelHarness();
    const primary: ModelProviderAdapter = {
      providerId: "openai",
      chat: async () => {
        throw new ModelProviderError("rate_limit", "primary throttled");
      }
    };
    const secondary: ModelProviderAdapter = {
      providerId: "mock",
      chat: async (_request, model) => ({
        providerId: "mock",
        providerName: "mock",
        model,
        modelVersion: "mock-fallback-v1",
        promptVersion: "fallback-v1",
        message: { role: "assistant", content: "fallback", toolCalls: [] },
        usage: {}
      })
    };
    const router = new ModelRouter([provider("openai"), mockProvider()], new Map([
      ["openai", primary],
      ["mock", secondary]
    ]), {
      eventSink: new EventStoreModelEventSink(harness.events)
    });

    const response = await router.chat(modelRequest({
      taskId: "task-fallback",
      providerId: "openai",
      promptVersion: "fallback-v1",
      fallbackChain: [{ providerId: "mock", model: "mock-model" }]
    }));

    expect(response.providerId).toBe("mock");
    expect(response.modelVersion).toBe("mock-fallback-v1");
    expect(harness.events.readAll("task-fallback").map((event) => event.eventType)).toEqual([
      "model_call_intended",
      "model_call_result",
      "model_fallback_used",
      "model_call_intended",
      "model_call_result"
    ]);

    const badRequestRouter = new ModelRouter([provider("openai"), mockProvider()], new Map([
      ["openai", {
        providerId: "openai",
        chat: async () => {
          throw new ModelProviderError("bad_request", "invalid prompt");
        }
      }],
      ["mock", secondary]
    ]), {
      eventSink: new EventStoreModelEventSink(harness.events)
    });

    await expect(badRequestRouter.chat(modelRequest({
      taskId: "task-no-fallback",
      providerId: "openai",
      promptVersion: "no-fallback-v1",
      fallbackChain: [{ providerId: "mock", model: "mock-model" }]
    }))).rejects.toThrow("invalid prompt");
    expect(harness.events.readAll("task-no-fallback").map((event) => event.eventType)).toEqual([
      "model_call_intended",
      "model_call_result"
    ]);
  });

  it("mock_provider_deterministic and missing_fixture_fails_loud", async () => {
    const harness = await modelHarness();
    const request = modelRequest({ taskId: "task-mock-deterministic", promptVersion: "fixture-v1" });
    const fixtureRoot = fixtureRootFor(harness.root);
    writeFixture(fixtureRoot, promptHashForRequest(request), {
      chunks: [
        { type: "text", text: "fixture-response" },
        { type: "done", tokensIn: 3, tokensOut: 1, modelVersion: "mock-fixture-v1" }
      ]
    });
    const adapter = new FixtureMockModelProviderAdapter("mock", fixtureRoot);

    const first = await adapter.chat(request, "mock-model");
    for (let index = 0; index < 1000; index += 1) {
      expect(await adapter.chat(request, "mock-model")).toEqual(first);
    }

    const missing = modelRequest({ taskId: "task-missing-fixture", promptVersion: "missing-v1" });
    await expect(adapter.chat(missing, "mock-model")).rejects.toThrow(promptHashForRequest(missing));
  });

  it("schema_repair_once and schema_double_invalid_fails", async () => {
    const harness = await modelHarness();
    const responses = ["not json", "{\"answer\":\"ok\"}"];
    const router = new ModelRouter([mockProvider()], new Map([[
      "mock",
      {
        providerId: "mock",
        chat: async (_request, model) => ({
          providerId: "mock",
          providerName: "mock",
          model,
          modelVersion: "repair-v1",
          promptVersion: "repair-v1",
          message: { role: "assistant", content: responses.shift() ?? "not json", toolCalls: [] },
          usage: {}
        })
      }
    ]]), {
      eventSink: new EventStoreModelEventSink(harness.events)
    });

    const repaired = await router.chatStructured(
      modelRequest({ taskId: "task-repair", promptVersion: "repair-v1" }),
      z.object({ answer: z.literal("ok") })
    );
    expect(repaired.parsed).toEqual({ answer: "ok" });
    expect(harness.events.readAll("task-repair").map((event) => event.eventType)).toEqual([
      "model_call_intended",
      "model_call_result",
      "model_call_intended",
      "model_call_result"
    ]);

    const invalidRouter = new ModelRouter([mockProvider()], new Map([[
      "mock",
      {
        providerId: "mock",
        chat: async (_request, model) => ({
          providerId: "mock",
          providerName: "mock",
          model,
          modelVersion: "repair-v1",
          promptVersion: "repair-v1",
          message: { role: "assistant", content: "still invalid", toolCalls: [] },
          usage: {}
        })
      }
    ]]), {
      eventSink: new EventStoreModelEventSink(harness.events)
    });

    await expect(invalidRouter.chatStructured(
      modelRequest({ taskId: "task-double-invalid", promptVersion: "repair-v1" }),
      z.object({ answer: z.literal("ok") })
    )).rejects.toThrow("Model response failed schema validation twice");
  });
});

async function modelHarness() {
  const root = mkdtempSync(join(tmpdir(), "operator-dock-phase5c-model-"));
  tempRoots.add(root);
  const paths = new OperatorDockPaths(join(root, "state"));
  paths.createLayout();
  const keys = await new PersistenceKeyManager(new MemoryPersistenceKeychainClient()).loadOrCreateKeys();
  return {
    root,
    events: new EventStore(paths, keys)
  };
}

function fixtureRootFor(root: string): string {
  return join(root, "state", "fixtures");
}

function writeFixture(
  fixtureRoot: string,
  promptHash: string,
  response: { chunks: Array<Record<string, unknown>> }
): void {
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, `${promptHash}.json`), JSON.stringify({
    promptHash,
    response
  }), "utf8");
}

function modelRequest(input: {
  taskId: string;
  promptVersion: string;
  providerId?: ModelRouterChatRequest["providerId"];
  fallbackChain?: ModelRouterChatRequest["fallbackChain"];
}): ModelRouterChatRequest {
  return ModelRouterChatRequestSchema.parse({
    purpose: "planner",
    providerId: input.providerId ?? "mock",
    model: "mock-model",
    promptVersion: input.promptVersion,
    messages: [{ role: "user", content: "Plan the next task." }],
    metadata: { taskId: input.taskId },
    fallbackChain: input.fallbackChain
  });
}

function mockProvider(): ProviderConfig {
  return provider("mock");
}

function provider(id: ProviderConfig["id"]): ProviderConfig {
  return {
    id,
    kind: id === "mock" ? "local" : "hosted",
    displayName: id,
    enabled: true,
    defaultModel: id === "mock" ? "mock-model" : "test-model",
    roleDefaults: {
      planner: id === "mock" ? "mock-model" : "test-model"
    },
    apiKeyConfigured: id !== "mock",
    models: [{
      id: id === "mock" ? "mock-model" : "test-model",
      displayName: "Test model",
      capabilities: { vision: false, tools: true, streaming: true }
    }]
  };
}
