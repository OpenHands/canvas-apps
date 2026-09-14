// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { CapabilityStore } from "../server/tokens.js";

describe("CapabilityStore", () => {
  it("issues opaque one-use capabilities", () => {
    const store = new CapabilityStore(30_000);
    const issued = store.issue({ extension: "backend-terminal", backendId: "local" });

    expect(issued?.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(store.consume(issued?.token ?? "")).toMatchObject({
      extension: "backend-terminal",
      backendId: "local",
    });
    expect(store.consume(issued?.token ?? "")).toBeNull();
  });

  it("rejects expired and unknown capabilities", () => {
    vi.useFakeTimers();
    const store = new CapabilityStore(1_000);
    const issued = store.issue({ extension: "backend-terminal", backendId: "local" });
    vi.advanceTimersByTime(1_001);

    expect(store.consume(issued?.token ?? "")).toBeNull();
    expect(store.consume("not-a-real-capability")).toBeNull();
    vi.useRealTimers();
  });

  it("bounds pending capability growth", () => {
    const store = new CapabilityStore(30_000, 1);
    expect(store.issue({ extension: "backend-terminal", backendId: "first" })).not.toBeNull();
    expect(store.issue({ extension: "backend-terminal", backendId: "second" })).toBeNull();
  });
});
