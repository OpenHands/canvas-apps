import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgentServerUrl } from "./agent-server-auth.js";

export type SidecarConfig = {
  host: string;
  port: number;
  allowedOrigins: ReadonlySet<string>;
  agentServerUrl: string;
  agentServerTimeoutMs: number;
  requireRoot: boolean;
  cwd: string;
  shell: string;
  shellArgs: string[];
  tokenTtlMs: number;
  maxSessions: number;
  maxMessageBytes: number;
  idleTimeoutMs: number;
  publicDir: string;
};

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function boolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly true or false.`);
}

function normalizeOrigins(value: string | undefined): ReadonlySet<string> {
  const raw = value ?? "http://localhost:8000,http://127.0.0.1:8000";
  const origins = raw.split(",").map((entry) => new URL(entry.trim()).origin);
  if (origins.length === 0) throw new Error("TERMINAL_ALLOWED_ORIGINS cannot be empty.");
  return new Set(origins);
}

function existingDirectory(value: string): string {
  const directory = resolve(value);
  if (!isAbsolute(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`TERMINAL_CWD is not a directory: ${directory}`);
  }
  return directory;
}

function stringArray(value: string | undefined): string[] {
  if (value === undefined) return process.platform === "win32" ? [] : ["-l"];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("TERMINAL_SHELL_ARGS must be a JSON array of strings.");
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  return {
    host: env.TERMINAL_HOST ?? "127.0.0.1",
    port: integer(env.TERMINAL_PORT, 18_080, 0, 65_535, "TERMINAL_PORT"),
    allowedOrigins: normalizeOrigins(env.TERMINAL_ALLOWED_ORIGINS),
    agentServerUrl: normalizeAgentServerUrl(env.TERMINAL_AGENT_SERVER_URL ?? "http://127.0.0.1:18000"),
    agentServerTimeoutMs: integer(env.TERMINAL_AGENT_SERVER_TIMEOUT_MS, 3_000, 500, 10_000, "TERMINAL_AGENT_SERVER_TIMEOUT_MS"),
    requireRoot: boolean(env.TERMINAL_REQUIRE_ROOT, true, "TERMINAL_REQUIRE_ROOT"),
    cwd: existingDirectory(env.TERMINAL_CWD ?? homedir()),
    shell: env.TERMINAL_SHELL ?? env.SHELL ?? (process.platform === "win32" ? "powershell.exe" : "/bin/bash"),
    shellArgs: stringArray(env.TERMINAL_SHELL_ARGS),
    tokenTtlMs: integer(env.TERMINAL_TOKEN_TTL_MS, 30_000, 5_000, 300_000, "TERMINAL_TOKEN_TTL_MS"),
    maxSessions: integer(env.TERMINAL_MAX_SESSIONS, 4, 1, 32, "TERMINAL_MAX_SESSIONS"),
    maxMessageBytes: integer(env.TERMINAL_MAX_MESSAGE_BYTES, 65_536, 1_024, 1_048_576, "TERMINAL_MAX_MESSAGE_BYTES"),
    idleTimeoutMs: integer(env.TERMINAL_IDLE_TIMEOUT_MS, 1_800_000, 60_000, 86_400_000, "TERMINAL_IDLE_TIMEOUT_MS"),
    publicDir: resolve(env.TERMINAL_PUBLIC_DIR ?? fileURLToPath(new URL("../public", import.meta.url))),
  };
}
