export function redactSecrets(message: string, secrets: Array<string | undefined>): string {
  let redacted = message;

  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) {
      continue;
    }

    redacted = redacted.split(secret).join("[REDACTED]");
  }

  return redacted;
}
