/* Build the Kanban Manager canvas extension into one self-contained browser
   ESM file: the bundle carries the board, the stylesheet and the manager
   automation's python sources, because an extension is a single file.

   The stylesheet is NOT copied: it is read from ../../static/style.css so the
   standalone SPA stays the single source of truth for the design. Two
   transforms adapt it to living inside Canvas:

   1. Every selector is scoped under .vibe-ext, and the page-level selectors
      (:root, html, body, *) are rewritten onto that root, so the extension
      cannot restyle Canvas.
   2. rem lengths become calc(N * var(--vibe-rem)). The SPA sets
      html { font-size: 120% } to scale itself, which an extension must not do
      to the host page; --vibe-rem reproduces that scale locally instead.
*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import postcss from "postcss";
import prefixer from "postcss-prefix-selector";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_CLASS = ".vibe-ext";

/* Two inputs come from the vibe-manager repo around this package, which stays
   their single source of truth. When the package is published on its own (the
   canvas-extensions repo), the same files sit vendored under src/ — so each is
   looked up in both places rather than the copies being kept in sync by hand. */
function vendored(...candidates) {
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`none of these exist: ${candidates.join(", ")}`);
  return found;
}

const SOURCE_CSS = vendored(
  join(here, "..", "..", "static", "style.css"),
  join(here, "src", "board.css"),
);

const BACKEND_DIR = vendored(join(here, "../..", "app.py"), join(here, "backend", "app.py"));
const backendRoot = dirname(BACKEND_DIR);
const backend = JSON.parse(execFileSync("python3", ["-c", `
import base64,gzip,hashlib,io,json,sys,tarfile
from pathlib import Path
root=Path(sys.argv[1]); buf=io.BytesIO()
files=['app.py','requirements.txt']
for directory in ['sidecar','automation','static']:
    files += [str(p.relative_to(root)) for p in (root/directory).rglob('*') if p.is_file() and p.suffix in ('.py','.js','.css','.html') and '__pycache__' not in p.parts]
with tarfile.open(fileobj=buf,mode='w') as tar:
    for name in sorted(files):
        data=(root/name).read_bytes(); info=tarfile.TarInfo(name); info.size=len(data); info.mode=0o600
        tar.addfile(info,io.BytesIO(data))
archive=gzip.compress(buf.getvalue(),mtime=0)
print(json.dumps({'archive':base64.b64encode(archive).decode(),'sha256':hashlib.sha256(archive).hexdigest()}))
`, backendRoot], { encoding: "utf8" }));
const bootstrap = Buffer.from(readFileSync(join(backendRoot, "sidecar/bootstrap.py"))).toString("base64");

/* The manifest decides where the bundle goes, so the declared entrypoint and
   the built file cannot drift apart (this package publishes it under dist/,
   the canvas-extensions repo at the package root). */
const MANIFEST = JSON.parse(readFileSync(join(here, "canvas-extension.json"), "utf8"));
const OUTFILE = join(here, "dist/extension.js");

// Selectors that target the page itself. Inside the extension they all mean
// "our root element" instead.
const PAGE_LEVEL = new Set([
  ":root",
  "html",
  "body",
  "html, body",
  "html,body",
]);

function scopeSelector(selector) {
  const trimmed = selector.trim();
  if (PAGE_LEVEL.has(trimmed)) return ROOT_CLASS;

  // html[data-theme="light"] -> .vibe-ext[data-theme="light"]  (the SPA's light
  // mode is a token override; we keep it on our own root so the toggle never
  // touches Canvas's <html>).
  if (trimmed.startsWith("html[")) {
    return ROOT_CLASS + trimmed.slice("html".length);
  }
  // html[data-theme="light"] .foo -> .vibe-ext[data-theme="light"] .foo
  if (trimmed.startsWith("html[data-theme")) {
    return ROOT_CLASS + trimmed.slice("html".length);
  }
  if (trimmed === "*") return `${ROOT_CLASS}, ${ROOT_CLASS} *`;
  return null; // fall through to the default prefixer behaviour
}

function remToScaled(css) {
  // 0.9375rem -> calc(0.9375 * var(--vibe-rem)). Skip 0rem and anything already
  // inside a var() fallback chain we generated.
  return css.replace(/(-?\d*\.?\d+)rem\b/g, (match, value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return match;
    return `calc(${value} * var(--vibe-rem))`;
  });
}

async function buildCss() {
  const raw = readFileSync(SOURCE_CSS, "utf8");
  const result = await postcss([
    prefixer({
      prefix: ROOT_CLASS,
      transform(prefix, selector, prefixedSelector) {
        return scopeSelector(selector) ?? prefixedSelector;
      },
    }),
  ]).process(raw, { from: SOURCE_CSS });

  // --vibe-rem reproduces the SPA's html { font-size: 120% } locally. Change
  // this one value to rescale the whole board inside Canvas.
  const scale = `${ROOT_CLASS} { --vibe-rem: 1.2rem; }\n`;
  // setup.css is extension-only and already written scoped, so it bypasses the
  // prefixer but still gets the rem rescale.
  const setup = readFileSync(join(here, "src", "setup.css"), "utf8");
  return scale + remToScaled(result.css) + remToScaled(setup);
}

const css = await buildCss();
mkdirSync(dirname(OUTFILE), { recursive: true });

await esbuild.build({
  entryPoints: [join(here, "src", "app.jsx")],
  outfile: OUTFILE,
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  define: {
    __VIBE_CSS__: JSON.stringify(css),
    __VIBE_BACKEND__: JSON.stringify(backend),
    __VIBE_BOOTSTRAP__: JSON.stringify(bootstrap),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

const out = readFileSync(OUTFILE, "utf8");
writeFileSync(OUTFILE, `/* Generated by build.mjs - do not edit. */\n${out}`);
execFileSync("node", [join(here, "validate.mjs"), OUTFILE], { stdio: "inherit" });
writeFileSync(join(here, MANIFEST.entrypoint), readFileSync(OUTFILE));
console.log(`built ${MANIFEST.entrypoint} (${(out.length / 1024).toFixed(1)} KB)`);
