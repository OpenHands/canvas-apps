import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtime = resolve(root, "runtime");
const rootPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const runtimePackage = JSON.parse(await readFile(resolve(runtime, "package.json"), "utf8"));
if (rootPackage.version !== runtimePackage.version) throw new Error("Root and runtime package versions must match.");

const paths = [
  "runtime/package.json",
  "runtime/package-lock.json",
  "sidecar-dist/server/agent-server-auth.js",
  "sidecar-dist/server/config.js",
  "sidecar-dist/server/index.js",
  "sidecar-dist/server/tokens.js",
];

const files = [];
const combined = createHash("sha256");
for (const sourcePath of paths) {
  const content = await readFile(resolve(root, sourcePath));
  const destination = sourcePath
    .replace(/^runtime\//, "")
    .replace(/^sidecar-dist\//, "");
  const sha256 = createHash("sha256").update(content).digest("hex");
  files.push({ path: destination, sha256, base64: content.toString("base64") });
  combined.update(destination).update("\0").update(content).update("\0");
}

const artifact = {
  schemaVersion: 1,
  app: "backend-terminal",
  version: rootPackage.version,
  sha256: combined.digest("hex"),
  files,
};
await writeFile(resolve(runtime, "artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${relative(root, resolve(runtime, "artifact.json"))} (${files.length} files).`);
