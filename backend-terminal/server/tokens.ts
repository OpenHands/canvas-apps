import { randomBytes, timingSafeEqual } from "node:crypto";

export type Capability = {
  extension: string;
  backendId: string;
  expiresAt: number;
};

export class CapabilityStore {
  readonly #tokens = new Map<string, Capability>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxPending = 64,
  ) {}

  issue(metadata: Omit<Capability, "expiresAt">): { token: string; expiresAt: number } | null {
    this.purge();
    if (this.#tokens.size >= this.maxPending) return null;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    this.#tokens.set(token, { ...metadata, expiresAt });
    return { token, expiresAt };
  }

  consume(candidate: string): Capability | null {
    this.purge();
    const candidateBytes = Buffer.from(candidate);
    for (const [token, capability] of this.#tokens) {
      const tokenBytes = Buffer.from(token);
      const matches = tokenBytes.length === candidateBytes.length && timingSafeEqual(tokenBytes, candidateBytes);
      if (!matches) continue;
      this.#tokens.delete(token);
      return capability;
    }
    return null;
  }

  purge(now = Date.now()): void {
    for (const [token, capability] of this.#tokens) {
      if (capability.expiresAt <= now) this.#tokens.delete(token);
    }
  }
}
