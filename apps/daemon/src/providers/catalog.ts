import type {
  ModelCapability,
  ModelPurposeDefaults,
  ProviderConfig,
  ProviderId,
  ProviderKind,
  ProviderModel
} from "@operator-dock/protocol";

export interface ProviderTemplate {
  id: ProviderId;
  kind: ProviderKind;
  displayName: string;
  endpoint?: string;
  defaultModel: string;
  roleDefaults: ModelPurposeDefaults;
  models: ProviderModel[];
}

const standardHostedCapabilities: ModelCapability = {
  vision: true,
  tools: true,
  streaming: true,
  maxContextTokens: 128000
};

const localCapabilities: ModelCapability = {
  vision: false,
  tools: true,
  streaming: true
};

export const providerCatalog: ProviderTemplate[] = [
  {
    id: "openai",
    kind: "hosted",
    displayName: "OpenAI",
    defaultModel: "gpt-4.1",
    roleDefaults: {
      planner: "gpt-4.1",
      executor: "gpt-4.1",
      verifier: "gpt-4.1-mini",
      summarizer: "gpt-4.1-mini",
      memoryCurator: "gpt-4.1-mini"
    },
    models: [
      {
        id: "gpt-4.1",
        displayName: "GPT-4.1",
        capabilities: {
          ...standardHostedCapabilities,
          inputCostPerMillionTokens: 2,
          outputCostPerMillionTokens: 8
        }
      },
      {
        id: "gpt-4.1-mini",
        displayName: "GPT-4.1 Mini",
        capabilities: {
          ...standardHostedCapabilities,
          inputCostPerMillionTokens: 0.4,
          outputCostPerMillionTokens: 1.6
        }
      }
    ]
  },
  {
    id: "anthropic",
    kind: "hosted",
    displayName: "Anthropic",
    defaultModel: "claude-3-5-sonnet-latest",
    roleDefaults: {
      planner: "claude-3-5-sonnet-latest",
      executor: "claude-3-5-sonnet-latest",
      verifier: "claude-3-5-haiku-latest",
      summarizer: "claude-3-5-haiku-latest",
      memoryCurator: "claude-3-5-haiku-latest"
    },
    models: [
      {
        id: "claude-3-5-sonnet-latest",
        displayName: "Claude Sonnet",
        capabilities: {
          ...standardHostedCapabilities,
          inputCostPerMillionTokens: 3,
          outputCostPerMillionTokens: 15
        }
      },
      {
        id: "claude-3-5-haiku-latest",
        displayName: "Claude Haiku",
        capabilities: {
          ...standardHostedCapabilities,
          inputCostPerMillionTokens: 0.8,
          outputCostPerMillionTokens: 4
        }
      }
    ]
  },
  {
    id: "openrouter",
    kind: "hosted",
    displayName: "OpenRouter",
    defaultModel: "openai/gpt-4.1",
    roleDefaults: {
      planner: "openai/gpt-4.1",
      executor: "anthropic/claude-3.5-sonnet",
      verifier: "openai/gpt-4.1-mini",
      summarizer: "openai/gpt-4.1-mini",
      memoryCurator: "openai/gpt-4.1-mini"
    },
    models: [
      {
        id: "openai/gpt-4.1",
        displayName: "OpenAI GPT-4.1",
        capabilities: standardHostedCapabilities
      },
      {
        id: "anthropic/claude-3.5-sonnet",
        displayName: "Anthropic Claude Sonnet",
        capabilities: standardHostedCapabilities
      }
    ]
  },
  {
    id: "ollama",
    kind: "local",
    displayName: "Ollama",
    endpoint: "http://127.0.0.1:11434",
    defaultModel: "llama3.1",
    roleDefaults: {
      planner: "llama3.1",
      executor: "llama3.1",
      verifier: "llama3.1",
      summarizer: "llama3.1",
      memoryCurator: "llama3.1"
    },
    models: [
      {
        id: "llama3.1",
        displayName: "Llama 3.1",
        capabilities: localCapabilities
      }
    ]
  },
  {
    id: "lmstudio",
    kind: "local",
    displayName: "LM Studio",
    endpoint: "http://127.0.0.1:1234",
    defaultModel: "local-model",
    roleDefaults: {
      planner: "local-model",
      executor: "local-model",
      verifier: "local-model",
      summarizer: "local-model",
      memoryCurator: "local-model"
    },
    models: [
      {
        id: "local-model",
        displayName: "Local OpenAI-compatible model",
        capabilities: localCapabilities
      }
    ]
  }
];

export function defaultProviderConfig(template: ProviderTemplate): ProviderConfig {
  const base = {
    id: template.id,
    kind: template.kind,
    displayName: template.displayName,
    enabled: template.kind === "local",
    defaultModel: template.defaultModel,
    roleDefaults: template.roleDefaults,
    apiKeyConfigured: false,
    models: template.models
  };

  return template.endpoint === undefined ? base : { ...base, endpoint: template.endpoint };
}

export function findProviderTemplate(providerId: ProviderId): ProviderTemplate {
  const template = providerCatalog.find((provider) => provider.id === providerId);

  if (template === undefined) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  return template;
}

