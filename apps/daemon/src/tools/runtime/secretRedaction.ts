import type { JsonValue } from "@operator-dock/protocol";

const sensitiveKeyPattern = /(api[_-]?key|authorization|bearer|credential|password|secret|token)/i;
const credentialPatterns = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g,
  /\b(api[_-]?key|token|secret|password)=([^\s"'`]+)/gi
];

export function collectSecretValues(value: JsonValue): string[] {
  const secrets = new Set<string>();

  const visit = (candidate: JsonValue, keyHint?: string): void => {
    if (candidate === null) {
      return;
    }

    if (typeof candidate === "string") {
      if (keyHint !== undefined && sensitiveKeyPattern.test(keyHint) && candidate.length > 0) {
        secrets.add(candidate);
      }
      return;
    }

    if (typeof candidate === "number" || typeof candidate === "boolean") {
      return;
    }

    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        visit(entry);
      }
      return;
    }

    for (const [key, nested] of Object.entries(candidate)) {
      visit(nested, key);
    }
  };

  visit(value);
  return [...secrets].filter((secret) => secret.length >= 4);
}

export function redactText(input: string, secrets: string[] = []): string {
  let redacted = input;

  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }

    redacted = redacted.split(secret).join("[REDACTED]");
  }

  for (const pattern of credentialPatterns) {
    redacted = redacted.replace(pattern, (match: string, key?: string) => {
      if (key !== undefined && /=/.test(match)) {
        return `${key}=[REDACTED]`;
      }

      return match.startsWith("Bearer ") ? "Bearer [REDACTED]" : "[REDACTED]";
    });
  }

  return redacted;
}

export function redactJson(value: JsonValue, secrets: string[] = []): JsonValue {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactJson(entry, secrets));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKeyPattern.test(key) && typeof nested === "string"
        ? "[REDACTED]"
        : redactJson(nested, secrets)
    ])
  );
}
