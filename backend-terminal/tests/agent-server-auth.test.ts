// @vitest-environment node

import { describe, expect, it } from "vitest";
import { normalizeAgentServerUrl } from "../server/agent-server-auth.js";

describe("Agent Server authentication configuration", () => {
  it("accepts explicit loopback origins", () => {
    expect(normalizeAgentServerUrl("http://127.0.0.1:18000")).toBe("http://127.0.0.1:18000");
    expect(normalizeAgentServerUrl("http://localhost:18000")).toBe("http://localhost:18000");
  });

  it("rejects remote hosts, credentials, paths, and unsupported protocols", () => {
    expect(() => normalizeAgentServerUrl("https://agent.example.test")).toThrow("loopback");
    expect(() => normalizeAgentServerUrl("http://user:pass@127.0.0.1:18000")).toThrow("bare origin");
    expect(() => normalizeAgentServerUrl("http://127.0.0.1:18000/api")).toThrow("bare origin");
    expect(() => normalizeAgentServerUrl("file:///tmp/socket")).toThrow("HTTP or HTTPS");
  });
});
