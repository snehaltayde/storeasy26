// Phase 2 line 11 (docs/plans/phase-2.md, "Line 11"): the merchant console has
// no old screen left, and none comes back.
//   node scripts/test-no-legacy-ui.js        (pnpm test:no-legacy-ui)
//
// Checks, over the files git knows (tracked and new, never ignored):
//   1. every merchant console route file (app/(console)/admin/**: pages,
//      layouts, error and loading) and the shared console root
//      (app/(console)/{layout,error,not-found}.js) is new UI: its import graph
//      never reaches components/console/ and no file in it holds data-legacy;
//   2. no file in app/, components/ or lib/ imports components/console;
//   3. no file there holds data-legacy;
//   4. lib/admin/new-ui-routes.js (the old/new route switch) is gone.
// PLATFORM_EXEMPT is the operator console, which Phase 3 rebuilds on
// components/ui; Phase 3 line 7 removes these rows and widens the scan to
// scripts/. An entry fails once nothing under it needs it, so remove it then.
// (Test fixtures in scripts/ may still stub the operator console's old parts
// until then.)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/test-no-legacy-ui.js";

export const PLATFORM_EXEMPT = [
  { path: "app/(console)/platform/", reason: "removed by Phase 3 line 7 (the operator console's pages keep the old parts until Phase 3 rebuilds them)" },
  { path: "components/platform/", reason: "removed by Phase 3 line 7 (the operator console's panels keep the old parts until Phase 3 rebuilds them)" },
  { path: "components/console/", reason: "removed by Phase 3 line 7 (the old parts the operator console still imports; the merchant-only ones are gone)" },
  { path: "app/console.css", reason: "removed by Phase 3 line 7 (the .console [data-legacy] token block the operator console's old parts render in)" },
];

// an import of an old part: "@/components/console/…" or a relative "…/components/console/…"
const OLD_PARTS = /["'`](?:@\/|(?:\.\.?\/)+)components\/console\//;
const LEGACY = /data-legacy/;
const CODE = /\.(?:js|mjs|jsx|ts|tsx|css)$/;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "app", "components", "lib"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && CODE.test(f) && existsSync(join(ROOT, f)));
const src = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
const exempt = (f) => PLATFORM_EXEMPT.some((e) => (e.path.endsWith("/") ? f.startsWith(e.path) : f === e.path));

let failed = 0;
const t = (name, fn) => {
  const problems = fn();
  if (problems.length) {
    failed++;
    console.log(`✗ ${name}`);
    for (const p of problems) console.log(`    ${p}`);
  } else console.log(`✓ ${name}`);
};

// ---- the import graph: import/export from, import(), require() of @/ and relative paths
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;
function resolve(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else return null;
  for (const c of [base, `${base}.js`, `${base}.jsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.js`]) if (src.has(c)) return c;
  return null;
}
function reach(start) {
  const seen = new Set([start]);
  const todo = [start];
  while (todo.length) {
    const f = todo.pop();
    for (const m of src.get(f).matchAll(SPEC)) {
      const r = resolve(f, m[1]);
      if (r && !seen.has(r)) seen.add(r), todo.push(r);
    }
  }
  return seen;
}

const ROUTE_FILE = /\/(?:page|layout|error|loading|not-found|template)\.js$/;
const routeFiles = files.filter((f) => (f.startsWith("app/(console)/admin/") && ROUTE_FILE.test(f)) || /^app\/\(console\)\/(?:layout|error|not-found)\.js$/.test(f));

t("there are merchant console route files to check", () => (routeFiles.filter((f) => f.endsWith("/page.js")).length > 20 ? [] : [`only ${routeFiles.length} route files found`]));

t("every merchant console page, layout, error and loading file is new UI (no old part, no data-legacy, anywhere in its imports)", () => {
  const out = [];
  for (const f of routeFiles) {
    for (const r of reach(f)) {
      if (r.startsWith("components/console/")) out.push(`${f} reaches ${r}`);
      else if (LEGACY.test(src.get(r))) out.push(`${f} reaches ${r}, which holds data-legacy`);
    }
  }
  return out;
});

t("no file imports components/console (outside the operator console)", () =>
  files.filter((f) => f !== SELF && !exempt(f) && OLD_PARTS.test(src.get(f))).map((f) => `${f} names components/console`));

t("no source holds data-legacy (outside the operator console)", () =>
  files.filter((f) => f !== SELF && !exempt(f) && LEGACY.test(src.get(f))).map((f) => `${f} holds data-legacy`));

t("the old/new route switch is gone (lib/admin/new-ui-routes.js)", () => (existsSync(join(ROOT, "lib/admin/new-ui-routes.js")) ? ["lib/admin/new-ui-routes.js still exists"] : []));

t("every operator-console exemption is still needed", () =>
  PLATFORM_EXEMPT.filter((e) => !files.some((f) => (e.path.endsWith("/") ? f.startsWith(e.path) : f === e.path) && (OLD_PARTS.test(src.get(f)) || LEGACY.test(src.get(f)) || f.startsWith("components/console/")))).map(
    (e) => `${e.path} is exempt but needs no exemption: remove the entry`
  ));

console.log(failed ? `\n${failed} failure(s)` : "\nno old console UI in the merchant console");
process.exit(failed ? 1 : 0);
