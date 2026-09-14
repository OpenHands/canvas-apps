import artifactJson from "../runtime/artifact.json";
import type { CanvasHost } from "./types";

const APP_SUBPATH = ".openhands/apps/backend-terminal";
const SIDECAR_URL = "http://127.0.0.1:18080";

interface RuntimeFile {
  path: string;
  sha256: string;
  base64: string;
}

interface RuntimeArtifact {
  schemaVersion: number;
  app: string;
  version: string;
  sha256: string;
  files: RuntimeFile[];
}

interface CommandResponse {
  exit_code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

interface HomeResponse { home?: unknown }

export type SidecarState = "missing" | "stopped" | "ready" | "incompatible";
export interface SidecarProbe {
  state: SidecarState;
  version: string | null;
  nodeVersion: string | null;
  npmVersion: string | null;
  supported: boolean;
  message: string | null;
}

export const artifact = artifactJson as RuntimeArtifact;
const FILE_HASHES_BASE64 = utf8Base64(JSON.stringify(Object.fromEntries(artifact.files.map((file) => [file.path, file.sha256]))));

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function validAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 4096 &&
    !/[\0-\x1f\x7f]/.test(value) && !value.includes("//") &&
    value.split("/").filter(Boolean).every((part) => part !== "." && part !== "..");
}

function shellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const VERIFY_FILES_COMMAND = artifact.files.map((file) => (
  `[ "$(sha_file "$app_dir"/${shellSingleQuoted(file.path)})" = '${file.sha256}' ] || { printf 'Bundled sidecar file checksum mismatch: ${file.path}\\n' >&2; exit 1; }`
)).join("\n");

function canvasOrigin(value: string): string {
  const parsed = new URL(value);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.origin !== value) {
    throw new Error("Canvas reported an invalid origin for sidecar startup.");
  }
  return parsed.origin;
}



async function execute(host: CanvasHost, home: string, command: string, timeout: number): Promise<string> {
  if (!validAbsolutePath(home)) throw new Error("The Agent Server returned an unsafe home directory.");
  const response = await host.agentServer.request<CommandResponse>({
    method: "POST",
    path: "/api/bash/execute_bash_command",
    body: { command, cwd: home, timeout },
  });
  const stdout = typeof response?.stdout === "string" ? response.stdout : "";
  const stderr = typeof response?.stderr === "string" ? response.stderr.trim() : "";
  if (response?.exit_code !== 0) throw new Error(stderr || "The Agent Server command failed.");
  return stdout;
}

function taggedJson(stdout: string, tag: string): unknown {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(`${tag}\t`));
  if (!line) throw new Error(`The sidecar operation did not return ${tag}.`);
  try { return JSON.parse(atob(line.slice(tag.length + 1))); }
  catch { throw new Error(`The sidecar operation returned invalid ${tag} data.`); }
}

export async function discoverHome(host: CanvasHost): Promise<string> {
  const raw = await host.agentServer.request<HomeResponse | string>({ path: "/api/file/home" });
  let response: HomeResponse;
  try { response = typeof raw === "string" ? JSON.parse(raw) as HomeResponse : raw; }
  catch { throw new Error("The Agent Server home response was not valid JSON."); }
  if (!validAbsolutePath(response?.home)) throw new Error("The Agent Server did not report a safe absolute home directory.");
  return response.home;
}

export function runtimeDirectory(home: string): string {
  if (!validAbsolutePath(home)) throw new Error("The Agent Server returned an unsafe home directory.");
  return `${home.replace(/\/+$/, "")}/${APP_SUBPATH}`;
}

export const PROBE_COMMAND = String.raw`python3 - <<'PY'
exec("import base64, hashlib, json, platform, re, shutil, subprocess, urllib.request")
from pathlib import Path
home = Path.cwd().resolve()
app = home / "${APP_SUBPATH}"
expected_version = "${artifact.version}"
expected_artifact = "${artifact.sha256}"
hashes = json.loads(base64.b64decode("${FILE_HASHES_BASE64}"))
def safe_path(path):
    current = home
    try: parts = path.absolute().relative_to(home).parts
    except ValueError: return False
    for part in parts:
        current = current / part
        if current.is_symlink(): return False
    return True
def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""): value.update(chunk)
    return value.hexdigest()
def command_version(name):
    executable = shutil.which(name)
    if not executable: return None
    try: return subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5).stdout.strip()[:80] or None
    except (OSError, subprocess.SubprocessError): return None
files_verified = safe_path(app) and all((app / path).is_file() and safe_path(app / path) and digest(app / path) == expected for path, expected in hashes.items())
marker_ok = (app / ".runtime-version").is_file() and (app / ".runtime-version").read_text(errors="replace").strip() == expected_version
artifact_ok = (app / ".artifact-sha256").is_file() and (app / ".artifact-sha256").read_text(errors="replace").strip() == expected_artifact
node_version, npm_version = command_version("node"), command_version("npm")
node_match = re.search(r"v?(\d+)", node_version or "")
supported = platform.system() in {"Linux", "Darwin"} and platform.machine() in {"x86_64", "aarch64", "arm64"} and bool(node_match and int(node_match.group(1)) >= 18) and npm_version is not None
health = None
try:
    with urllib.request.urlopen("${SIDECAR_URL}/api/health", timeout=1) as response:
        health = json.loads(response.read(16384))
except Exception: pass
if health and health.get("status") == "ok" and health.get("version") == expected_version:
    state, message = "ready", None
elif health:
    state, message = "incompatible", "Port 18080 is occupied by an incompatible service."
elif files_verified and marker_ok and artifact_ok:
    state, message = "stopped", None
elif app.exists():
    state, message = "incompatible", "The installed sidecar is incomplete or does not match this App version."
else:
    state, message = "missing", None
result = {"state": state, "version": health.get("version") if isinstance(health, dict) else None, "nodeVersion": node_version, "npmVersion": npm_version, "supported": supported, "message": message}
print("BACKEND_TERMINAL_PROBE\t" + base64.b64encode(json.dumps(result, separators=(",", ":")).encode()).decode())
PY`;

const INSTALL_PREPARE_COMMAND = String.raw`set -eu
app_dir='${APP_SUBPATH}'
for checked in '.openhands' '.openhands/apps' "$app_dir" "$app_dir/server" "$app_dir/public" "$app_dir/public/assets" "$app_dir/run" "$app_dir/logs" "$app_dir/node_modules"; do [ ! -L "$checked" ] || { printf 'Sidecar path contains a symbolic link\n' >&2; exit 1; }; done
command -v node >/dev/null 2>&1 || { printf 'Node.js 18 or newer is required\n' >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { printf 'Node.js 18 or newer is required\n' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf 'npm is required\n' >&2; exit 1; }
mkdir -p "$app_dir/server" "$app_dir/public/assets" "$app_dir/run" "$app_dir/logs"
rm -f "$app_dir/.runtime-version" "$app_dir/.artifact-sha256"`;

function installCommands(): string[] {
  const commands = [INSTALL_PREPARE_COMMAND];
  const prefix = `set -eu\napp_dir='${APP_SUBPATH}'\numask 077\n`;
  let command = prefix;
  const flush = (): void => {
    if (command !== prefix) commands.push(command);
    command = prefix;
  };
  for (const file of artifact.files) {
    const staging = `"$app_dir"/${shellSingleQuoted(`${file.path}.b64`)}`;
    const initialize = `rm -f ${staging}; : > ${staging}\n`;
    if (command.length + initialize.length > 48_000) flush();
    command += initialize;
    for (let index = 0; index < file.base64.length; index += 24_000) {
      const line = `printf '%s' '${file.base64.slice(index, index + 24_000)}' >> ${staging}\n`;
      if (command.length + line.length > 48_000) flush();
      command += line;
    }
  }
  flush();
  const decodes = artifact.files.map((file) => {
    const source = `"$app_dir"/${shellSingleQuoted(`${file.path}.b64`)}`;
    const destination = `"$app_dir"/${shellSingleQuoted(file.path)}`;
    return `decode_file ${source} ${destination}`;
  }).join("\n");
  commands.push(String.raw`set -eu
app_dir='${APP_SUBPATH}'
decode_file() {
  source="$1"; destination="$2"; rm -f "$destination.tmp"
  if base64 --decode < "$source" > "$destination.tmp" 2>/dev/null; then :
  else base64 -D < "$source" > "$destination.tmp"; fi
  chmod 600 "$destination.tmp"; mv "$destination.tmp" "$destination"; rm -f "$source"
}
sha_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
${decodes}
${VERIFY_FILES_COMMAND}
(cd "$app_dir" && npm ci --omit=dev --no-audit --no-fund)
printf '%s\n' '${artifact.version}' > "$app_dir/.runtime-version.tmp"
printf '%s\n' '${artifact.sha256}' > "$app_dir/.artifact-sha256.tmp"
chmod 600 "$app_dir/.runtime-version.tmp" "$app_dir/.artifact-sha256.tmp"
mv "$app_dir/.runtime-version.tmp" "$app_dir/.runtime-version"
mv "$app_dir/.artifact-sha256.tmp" "$app_dir/.artifact-sha256"
printf 'BACKEND_TERMINAL_INSTALLED\t${artifact.version}\n'`);
  return commands;
}

export const INSTALL_COMMANDS = installCommands();

export const STOP_COMMAND = String.raw`set -eu
app_dir='${APP_SUBPATH}'
pid_file="$app_dir/run/sidecar.pid"
for checked in '.openhands' '.openhands/apps' "$app_dir" "$app_dir/run" "$pid_file"; do [ ! -L "$checked" ] || { printf 'Sidecar path contains a symbolic link\n' >&2; exit 1; }; done
[ -f "$pid_file" ] || { printf 'BACKEND_TERMINAL_STOPPED\tnot-running\n'; exit 0; }
pid=$(cat "$pid_file" 2>/dev/null || true)
case "$pid" in ''|*[!0-9]*) printf 'Invalid sidecar PID file; remove it manually after inspection\n' >&2; exit 1;; esac
if ! kill -0 "$pid" 2>/dev/null; then rm -f "$pid_file"; printf 'BACKEND_TERMINAL_STOPPED\tstale-pid\n'; exit 0; fi
args=$(ps -p "$pid" -o args= 2>/dev/null || true)
case "$args" in *'.openhands/apps/backend-terminal/server/index.js'*) ;; *) printf 'PID file does not identify the managed sidecar; refusing to stop it\n' >&2; exit 1;; esac
kill -TERM "$pid"
attempt=0
while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt 50 ]; do attempt=$((attempt + 1)); sleep 0.1; done
if kill -0 "$pid" 2>/dev/null; then printf 'Managed sidecar did not stop cleanly\n' >&2; exit 1; fi
rm -f "$pid_file"
printf 'BACKEND_TERMINAL_STOPPED\tstopped\n'`;


function startCommand(activeCanvasOrigin: string): string {
  const allowedOrigins = [...new Set(["http://localhost:8000", "http://127.0.0.1:8000", canvasOrigin(activeCanvasOrigin)])].join(",");
  return String.raw`set -eu
app_dir='${APP_SUBPATH}'
pid_file="$app_dir/run/sidecar.pid"
for checked in '.openhands' '.openhands/apps' "$app_dir" "$app_dir/run" "$pid_file"; do [ ! -L "$checked" ] || { printf 'Sidecar path contains a symbolic link\n' >&2; exit 1; }; done
[ "$(cat "$app_dir/.runtime-version" 2>/dev/null)" = '${artifact.version}' ] || { printf 'Sidecar version mismatch; reinstall it\n' >&2; exit 1; }
[ "$(cat "$app_dir/.artifact-sha256" 2>/dev/null)" = '${artifact.sha256}' ] || { printf 'Sidecar artifact mismatch; reinstall it\n' >&2; exit 1; }
sha_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
${VERIFY_FILES_COMMAND}
if curl -fsS --max-time 1 '${SIDECAR_URL}/api/health' 2>/dev/null | grep -q '"version":"${artifact.version}"'; then printf 'BACKEND_TERMINAL_STARTED\talready-running\n'; exit 0; fi
if [ -f "$pid_file" ]; then
  pid=$(cat "$pid_file" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then printf 'Recorded sidecar process is running but unhealthy; inspect the log\n' >&2; exit 1; fi
  rm -f "$pid_file"
fi
home=$(pwd -P)
nohup env HOME="$home" TERMINAL_CWD="$home" TERMINAL_ALLOWED_ORIGINS=${shellSingleQuoted(allowedOrigins)} TERMINAL_AGENT_SERVER_URL='http://127.0.0.1:18000' node "$app_dir/server/index.js" >> "$app_dir/logs/service.log" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pid_file.tmp"; chmod 600 "$pid_file.tmp"; mv "$pid_file.tmp" "$pid_file"
attempt=0
while [ "$attempt" -lt 50 ]; do
  if curl -fsS --max-time 1 '${SIDECAR_URL}/api/health' 2>/dev/null | grep -q '"version":"${artifact.version}"'; then printf 'BACKEND_TERMINAL_STARTED\tready\n'; exit 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then printf 'Sidecar exited during startup; inspect the log\n' >&2; exit 1; fi
  attempt=$((attempt + 1)); sleep 0.1
done
printf 'Sidecar did not become healthy; inspect the log\n' >&2
exit 1`;
}

export const START_COMMAND = startCommand("http://localhost:8000");

export async function probeSidecar(host: CanvasHost, home: string): Promise<SidecarProbe> {
  const value = taggedJson(await execute(host, home, PROBE_COMMAND, 20), "BACKEND_TERMINAL_PROBE") as Partial<SidecarProbe>;
  if (!value || !["missing", "stopped", "ready", "incompatible"].includes(value.state ?? "") || typeof value.supported !== "boolean") {
    throw new Error("The sidecar probe returned incomplete data.");
  }
  return {
    state: value.state as SidecarState,
    version: typeof value.version === "string" ? value.version : null,
    nodeVersion: typeof value.nodeVersion === "string" ? value.nodeVersion : null,
    npmVersion: typeof value.npmVersion === "string" ? value.npmVersion : null,
    supported: value.supported,
    message: typeof value.message === "string" ? value.message : null,
  };
}

export async function installSidecar(host: CanvasHost, home: string): Promise<void> {
  await execute(host, home, STOP_COMMAND, 30);
  for (let index = 0; index < INSTALL_COMMANDS.length; index += 1) {
    await execute(host, home, INSTALL_COMMANDS[index]!, index === INSTALL_COMMANDS.length - 1 ? 900 : 30);
  }
}

export async function startSidecar(host: CanvasHost, home: string, activeCanvasOrigin: string): Promise<void> {
  await execute(host, home, startCommand(activeCanvasOrigin), 30);
}
