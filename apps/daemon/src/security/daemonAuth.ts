import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";

const execFileAsync = promisify(execFile);
const authService = "com.perlantir.operatordock.daemon";
const authAccount = "daemon:httpBearerToken";

export interface DaemonAuthTokenStore {
  loadOrCreateToken(): Promise<string>;
}

export function daemonAuthTokenStoreFromEnv(env: NodeJS.ProcessEnv): DaemonAuthTokenStore {
  if (env.OPERATOR_DOCK_TEST_MODE === "1" && env.OPERATOR_DOCK_TEST_BEARER_TOKEN !== undefined) {
    return new MemoryDaemonAuthTokenStore(env.OPERATOR_DOCK_TEST_BEARER_TOKEN);
  }

  return new MacOSKeychainDaemonAuthTokenStore();
}

export class MacOSKeychainDaemonAuthTokenStore implements DaemonAuthTokenStore {
  async loadOrCreateToken(): Promise<string> {
    const existing = await this.get();
    if (existing !== undefined) {
      return existing;
    }

    const token = randomBytes(32).toString("base64url");
    await execFileAsync("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-s",
      authService,
      "-a",
      authAccount,
      "-w",
      token
    ]);
    return token;
  }

  private async get(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", [
        "find-generic-password",
        "-s",
        authService,
        "-a",
        authAccount,
        "-w"
      ]);
      const token = stdout.trim();
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  }
}

export class MemoryDaemonAuthTokenStore implements DaemonAuthTokenStore {
  constructor(private readonly token = randomBytes(32).toString("base64url")) {}

  async loadOrCreateToken(): Promise<string> {
    return this.token;
  }
}

export function bearerTokenFromRequest(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }

  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token !== undefined && token.length > 0
    ? token
    : undefined;
}

export function tokensEqual(left: string | undefined, right: string): boolean {
  if (left === undefined) {
    return false;
  }

  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
