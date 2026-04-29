import type { FastifyInstance } from "fastify";
import {
  ModelRouterConfigResponseSchema,
  ModelRouterConfigUpdateSchema,
  ModelRouterChatRequestSchema,
  ModelRouterChatResponseSchema,
  ProviderConfigUpdateSchema,
  ProviderIdSchema,
  ProviderListResponseSchema,
  ProviderResponseSchema
} from "@operator-dock/protocol";
import { ApiError } from "../errors.js";
import { buildDefaultModelRouter } from "./modelRouter.js";
import { ProviderConnectionTester } from "./providerConnectionTester.js";
import { ProviderSettingsRepository } from "./providerSettingsRepository.js";
import type { CredentialStore } from "./credentialStore.js";

export interface ProviderRouteDependencies {
  settings: ProviderSettingsRepository;
  credentialStore: CredentialStore;
}

export async function registerProviderRoutes(
  app: FastifyInstance,
  dependencies: ProviderRouteDependencies
): Promise<void> {
  const tester = new ProviderConnectionTester(dependencies.credentialStore);

  app.get("/v1/providers", async () => {
    const providers = await hydrateProviderSecrets(dependencies);
    return ProviderListResponseSchema.parse({ providers });
  });

  app.put("/v1/providers/:providerId", async (request) => {
    const providerId = parseProviderId((request.params as { providerId?: string }).providerId);
    const input = ProviderConfigUpdateSchema.parse(request.body);
    dependencies.settings.updateProvider(providerId, input);
    const provider = await hydrateProviderSecret(dependencies, providerId);
    return ProviderResponseSchema.parse({ provider });
  });

  app.post("/v1/providers/:providerId/test", async (request) => {
    const providerId = parseProviderId((request.params as { providerId?: string }).providerId);
    const provider = await hydrateProviderSecret(dependencies, providerId);
    return tester.test(provider);
  });

  app.get("/v1/model-router", async () => {
    return ModelRouterConfigResponseSchema.parse({
      router: dependencies.settings.getRouterConfig()
    });
  });

  app.put("/v1/model-router", async (request) => {
    const input = ModelRouterConfigUpdateSchema.parse(request.body);
    return ModelRouterConfigResponseSchema.parse({
      router: dependencies.settings.updateRouterConfig(input)
    });
  });

  app.post("/v1/model-router/chat", async (request) => {
    const input = ModelRouterChatRequestSchema.parse(request.body);
    const providers = await hydrateProviderSecrets(dependencies);
    const router = buildDefaultModelRouter(providers, dependencies.credentialStore);
    return ModelRouterChatResponseSchema.parse(await router.chat(input));
  });
}

async function hydrateProviderSecrets(dependencies: ProviderRouteDependencies) {
  const providers = dependencies.settings.listProviders();

  return Promise.all(
    providers.map(async (provider) => ({
      ...provider,
      apiKeyConfigured: provider.kind === "local"
        ? false
        : await dependencies.credentialStore.hasCredential(provider.id)
    }))
  );
}

async function hydrateProviderSecret(dependencies: ProviderRouteDependencies, providerId: ReturnType<typeof parseProviderId>) {
  const provider = dependencies.settings.getProvider(providerId);

  if (provider === undefined) {
    throw new ApiError(404, "PROVIDER_NOT_FOUND", `Unknown provider: ${providerId}`);
  }

  return {
    ...provider,
    apiKeyConfigured: provider.kind === "local"
      ? false
      : await dependencies.credentialStore.hasCredential(provider.id)
  };
}

function parseProviderId(value: string | undefined) {
  const parsed = ProviderIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(404, "PROVIDER_NOT_FOUND", `Unknown provider: ${value ?? ""}`);
  }

  return parsed.data;
}
