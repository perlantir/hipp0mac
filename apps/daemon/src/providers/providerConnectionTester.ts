import type {
  ProviderConfig,
  ProviderConnectionTestResponse,
  ProviderId
} from "@operator-dock/protocol";
import { redactSecrets } from "./redaction.js";
import type { CredentialStore } from "./credentialStore.js";

export type Fetcher = typeof fetch;

export class ProviderConnectionTester {
  constructor(
    private readonly credentialStore: CredentialStore,
    private readonly fetcher: Fetcher = fetch
  ) {}

  async test(provider: ProviderConfig): Promise<ProviderConnectionTestResponse> {
    const started = performance.now();
    const checkedAt = new Date().toISOString();

    try {
      await this.testProvider(provider);
      return {
        providerId: provider.id,
        ok: true,
        message: `${provider.displayName} connection succeeded.`,
        latencyMs: Math.round(performance.now() - started),
        checkedAt
      };
    } catch (error) {
      const secret = await this.credentialStore.getCredential(provider.id);
      return {
        providerId: provider.id,
        ok: false,
        message: redactSecrets((error as Error).message, [secret]),
        latencyMs: Math.round(performance.now() - started),
        checkedAt
      };
    }
  }

  private async testProvider(provider: ProviderConfig): Promise<void> {
    switch (provider.id) {
    case "openai":
      await this.testOpenAICompatible(provider.id, "https://api.openai.com/v1/models");
      return;
    case "openrouter":
      await this.testOpenAICompatible(provider.id, "https://openrouter.ai/api/v1/models");
      return;
    case "anthropic":
      await this.testAnthropic();
      return;
    case "ollama":
      await this.testLocal(`${provider.endpoint ?? "http://127.0.0.1:11434"}/api/tags`);
      return;
    case "lmstudio":
      await this.testLocal(`${provider.endpoint ?? "http://127.0.0.1:1234"}/v1/models`);
      return;
    }
  }

  private async testOpenAICompatible(providerId: ProviderId, url: string): Promise<void> {
    const apiKey = await this.requiredApiKey(providerId);
    const response = await this.fetcher(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Provider returned HTTP ${response.status}.`);
    }
  }

  private async testAnthropic(): Promise<void> {
    const apiKey = await this.requiredApiKey("anthropic");
    const response = await this.fetcher("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    });

    if (!response.ok) {
      throw new Error(`Provider returned HTTP ${response.status}.`);
    }
  }

  private async testLocal(url: string): Promise<void> {
    const response = await this.fetcher(url, {
      method: "GET"
    });

    if (!response.ok) {
      throw new Error(`Local endpoint returned HTTP ${response.status}.`);
    }
  }

  private async requiredApiKey(providerId: ProviderId): Promise<string> {
    const apiKey = await this.credentialStore.getCredential(providerId);
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new Error("API key is not configured in the local Keychain.");
    }

    return apiKey;
  }
}

