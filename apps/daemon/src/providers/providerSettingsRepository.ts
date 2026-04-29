import type { DatabaseSync } from "node:sqlite";
import {
  ModelRouterConfigSchema,
  ProviderConfigSchema,
  ProviderConfigUpdateSchema,
  type ModelRouterConfig,
  type ModelRouterConfigUpdate,
  type ProviderConfig,
  type ProviderConfigUpdate,
  type ProviderId
} from "@operator-dock/protocol";
import { defaultProviderConfig, providerCatalog } from "./catalog.js";

interface SettingsRow {
  value_json: string;
}

interface ProviderSettingsDocument {
  providers: Partial<Record<ProviderId, ProviderConfigUpdate>>;
  router: ModelRouterConfig;
}

const settingsKey = "providers.config";

const defaultRouterConfig: ModelRouterConfig = {
  mode: "auto",
  purposeDefaults: {
    planner: "gpt-4.1",
    executor: "gpt-4.1",
    verifier: "gpt-4.1-mini",
    summarizer: "gpt-4.1-mini",
    memoryCurator: "gpt-4.1-mini"
  },
  fallbackProvider: "openai"
};

export class ProviderSettingsRepository {
  constructor(private readonly database: DatabaseSync) {}

  listProviders(): ProviderConfig[] {
    const document = this.readDocument();

    return providerCatalog.map((template) => {
      const defaults = defaultProviderConfig(template);
      const override = document.providers[template.id] ?? {};

      const merged = {
        ...defaults,
        ...cleanUpdate(override),
        id: defaults.id,
        kind: defaults.kind,
        displayName: defaults.displayName,
        models: defaults.models
      };

      return ProviderConfigSchema.parse(merged);
    });
  }

  getProvider(providerId: ProviderId): ProviderConfig | undefined {
    return this.listProviders().find((provider) => provider.id === providerId);
  }

  updateProvider(providerId: ProviderId, input: ProviderConfigUpdate): ProviderConfig {
    const parsed = ProviderConfigUpdateSchema.parse(input);
    const document = this.readDocument();
    const current = document.providers[providerId] ?? {};
    document.providers[providerId] = cleanUpdate({
      ...current,
      ...parsed
    });
    this.writeDocument(document);

    const provider = this.getProvider(providerId);
    if (provider === undefined) {
      throw new Error(`Provider not found after update: ${providerId}`);
    }

    return provider;
  }

  getRouterConfig(): ModelRouterConfig {
    return this.readDocument().router;
  }

  updateRouterConfig(input: ModelRouterConfigUpdate): ModelRouterConfig {
    const document = this.readDocument();
    document.router = ModelRouterConfigSchema.parse({
      ...document.router,
      ...input,
      purposeDefaults: {
        ...document.router.purposeDefaults,
        ...input.purposeDefaults
      },
      updatedAt: new Date().toISOString()
    });
    this.writeDocument(document);
    return document.router;
  }

  private readDocument(): ProviderSettingsDocument {
    const row = this.database
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(settingsKey) as SettingsRow | undefined;

    if (row === undefined) {
      return {
        providers: {},
        router: defaultRouterConfig
      };
    }

    const parsed = JSON.parse(row.value_json) as Partial<ProviderSettingsDocument>;

    return {
      providers: parsed.providers ?? {},
      router: ModelRouterConfigSchema.parse(parsed.router ?? defaultRouterConfig)
    };
  }

  private writeDocument(document: ProviderSettingsDocument): void {
    this.database
      .prepare(`
        INSERT INTO settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `)
      .run(settingsKey, JSON.stringify(document), new Date().toISOString());
  }
}

function cleanUpdate(input: ProviderConfigUpdate): ProviderConfigUpdate {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as ProviderConfigUpdate;
}
