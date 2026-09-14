import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { INSTALL_COMMANDS, START_COMMAND, STOP_COMMAND, artifact } from "../../src/sidecar-service";

const exec = promisify(execFile);
const enabled = process.env.RUN_INSTALL_SMOKE === "true";
const home = enabled ? await mkdtemp(join(tmpdir(), "backend-terminal-fresh-")) : "";
const app = enabled ? join(home, ".openhands/apps/backend-terminal") : "";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

afterAll(async () => {
  if (!enabled) return;
  try {
    const pid = Number((await readFile(join(app, "run/sidecar.pid"), "utf8")).trim());
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 150));
  await rm(home, { recursive: true, force: true });
});

it.runIf(enabled)(
  "installs and starts from only the embedded fresh-install artifact",
  async () => {
    await exec("bash", ["-c", STOP_COMMAND], { cwd: home, timeout: 30_000 });
    for (const command of INSTALL_COMMANDS) {
      await exec("bash", ["-c", command], { cwd: home, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    }
    expect((await readFile(join(app, ".runtime-version"), "utf8")).trim()).toBe(artifact.version);

    const port = await freePort();
    const start = START_COMMAND
      .replaceAll("127.0.0.1:18080", `127.0.0.1:${port}`)
      .replace("TERMINAL_CWD=\"$home\"", `TERMINAL_PORT='${port}' TERMINAL_CWD=\"$home\"`);
    await exec("bash", ["-c", start], { cwd: home, timeout: 30_000 });
    const pid = Number((await readFile(join(app, "run/sidecar.pid"), "utf8")).trim());
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json())).resolves.toMatchObject({
      status: "ok",
      version: artifact.version,
    });
  },
  210_000,
);
