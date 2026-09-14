import { describe, expect, it, vi } from "vitest";
import {
  INSTALL_COMMANDS,
  PROBE_COMMAND,
  START_COMMAND,
  STOP_COMMAND,
  artifact,
  discoverHome,
  installSidecar,
  probeSidecar,
  runtimeDirectory,
  startSidecar,
} from "../src/sidecar-service";
import type { AgentServerRequest, CanvasHost } from "../src/types";

function hostWith(request: (request: AgentServerRequest) => Promise<unknown>): CanvasHost {
  return {
    apiVersion: "1",
    extension: { name: "backend-terminal", version: artifact.version, resolvedRef: null },
    backend: { id: "local", kind: "local", orgId: null },
    registerPage: vi.fn(),
    agentServer: { request: request as CanvasHost["agentServer"]["request"] },
  };
}

function probeOutput(value: unknown): string {
  return `BACKEND_TERMINAL_PROBE\t${btoa(JSON.stringify(value))}\n`;
}

describe("sidecar provisioning", () => {
  it("discovers a safe backend home and rejects traversal", async () => {
    await expect(discoverHome(hostWith(async () => ({ home: "/root" })))).resolves.toBe("/root");
    await expect(discoverHome(hostWith(async () => ({ home: "/root/../tmp" })))).rejects.toThrow("safe absolute home");
    expect(runtimeDirectory("/root")).toBe("/root/.openhands/apps/backend-terminal");
  });

  it("parses a complete non-mutating probe", async () => {
    const request = vi.fn(async () => ({
      exit_code: 0,
      stdout: probeOutput({ state: "missing", version: null, nodeVersion: "v22.0.0", npmVersion: "10.0.0", supported: true, message: null }),
      stderr: "",
    }));
    await expect(probeSidecar(hostWith(request), "/root")).resolves.toMatchObject({ state: "missing", supported: true });
    expect(request).toHaveBeenCalledWith({ method: "POST", path: "/api/bash/execute_bash_command", body: { command: PROBE_COMMAND, cwd: "/root", timeout: 20 } });
    expect(PROBE_COMMAND).not.toMatch(/mkdir|unlink|rmtree|npm ci|nohup/);
  });

  it("uses fixed app-scoped install and start commands", async () => {
    const request = vi.fn(async (_request: AgentServerRequest) => ({ exit_code: 0, stdout: "ok", stderr: "" }));
    const host = hostWith(request);
    await installSidecar(host, "/root");
    await startSidecar(host, "/root", "https://canvas.example");
    const commands = request.mock.calls.map((call) => (call[0].body as { command: string }).command);
    expect(commands.slice(0, -1)).toEqual([STOP_COMMAND, ...INSTALL_COMMANDS]);
    const startup = commands.at(-1)!;
    expect(startup).toContain("TERMINAL_ALLOWED_ORIGINS='http://localhost:8000,http://127.0.0.1:8000,https://canvas.example'");
    const installation = INSTALL_COMMANDS.join("\n");
    expect(STOP_COMMAND).toContain("PID file does not identify the managed sidecar; refusing to stop it");
    expect(STOP_COMMAND).not.toContain("kill -9");
    expect(Math.max(...INSTALL_COMMANDS.map((command) => command.length))).toBeLessThan(64_000);
    expect(installation).toContain("app_dir='.openhands/apps/backend-terminal'");
    expect(installation).toContain("npm ci --omit=dev --no-audit --no-fund");
    expect(installation).toContain("Bundled sidecar file checksum mismatch");
    expect(installation).toContain('base64 --decode < "$source"');
    expect(installation).toContain('base64 -D < "$source"');
    expect(installation).not.toMatch(/base64 (?:--decode|-D) "\$source"/);
    expect(installation).not.toContain("id -u");
    expect(installation.indexOf("npm ci --omit=dev")).toBeLessThan(installation.indexOf(".runtime-version.tmp"));

    expect(START_COMMAND).toContain("127.0.0.1:18080");
    expect(START_COMMAND).toContain("nohup env HOME=");
    expect(START_COMMAND).toContain("TERMINAL_CWD=\"$home\"");
    expect(START_COMMAND).toContain("Bundled sidecar file checksum mismatch");
    expect(START_COMMAND).not.toMatch(/\b(?:USER|LOGNAME)='root'/);
    expect(START_COMMAND).not.toContain("id -u");
    expect(installation).not.toContain("/root");
  });

  it("surfaces command and malformed probe failures", async () => {
    await expect(installSidecar(hostWith(async () => ({ exit_code: 1, stdout: "", stderr: "npm failed" })), "/root")).rejects.toThrow("npm failed");
    await expect(probeSidecar(hostWith(async () => ({ exit_code: 0, stdout: "bad", stderr: "" })), "/root")).rejects.toThrow("did not return");
  });

  it("rejects unsafe Canvas origins before issuing a command", async () => {
    const request = vi.fn();
    await expect(startSidecar(hostWith(request), "/root", "https://user@example.com")).rejects.toThrow("invalid origin");
    await expect(startSidecar(hostWith(request), "/root", "https://example.com/extra")).rejects.toThrow("invalid origin");
    expect(request).not.toHaveBeenCalled();
  });


  it("embeds only checksummed runtime files and matching versions", () => {
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.app).toBe("backend-terminal");
    expect(artifact.version).toBe("0.3.2");
    expect(artifact.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "package.json",
      "package-lock.json",
      "server/index.js",
      "public/index.html",
    ]));
    for (const file of artifact.files) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
