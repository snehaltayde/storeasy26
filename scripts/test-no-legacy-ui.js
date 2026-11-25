// Phase 2 line 11 and Phase 3 line 7 (docs/plans/phase-2.md "Line 11",
// docs/plans/phase-3.md "Line 7"): neither console has an old screen left,
// and none comes back.
//   node scripts/test-no-legacy-ui.js        (pnpm test:no-legacy-ui)
//
// Checks, over every file git knows in the repo (tracked and new, never
// ignored), with no exemptions:
//   1. every console route file (app/(console)/**: pages, layouts, error and
//      loading, merchant and operator, and the shared root) is new UI: its
//      import graph never reaches components/console/ and no file in it holds
//      data-legacy;
//   2. no file imports components/console (scripts and drills included);
//   3. no source holds data-legacy;
//   4. components/console/, /platform/legacy and lib/admin/new-ui-routes.js
//      (the old/new route switch) are gone.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/test-no-legacy-ui.js";

// an import of an old part: "@/components/console/…" or a relative "…/components/console/…"
const OLD_PARTS = /["'`](?:@\/|(?:\.\.?\/)+)components\/console\//;
const LEGACY = /data-legacy/;
const CODE = /\.(?:js|mjs|jsx|ts|tsx|css)$/;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && CODE.test(f) && existsSync(join(ROOT, f)));
const src = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

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
const routeFiles = files.filter((f) => f.startsWith("app/(console)/") && ROUTE_FILE.test(f));

t("there are merchant and operator console route files to check", () => {
  const pages = (dir) => routeFiles.filter((f) => f.startsWith(dir) && f.endsWith("/page.js")).length;
  return pages("app/(console)/admin/") > 20 && pages("app/(console)/platform/") > 5 ? [] : [`only ${routeFiles.length} route files found`];
});

t("every console page, layout, error and loading file is new UI (no old part, no data-legacy, anywhere in its imports)", () => {
  const out = [];
  for (const f of routeFiles) {
    for (const r of reach(f)) {
      if (r.startsWith("components/console/")) out.push(`${f} reaches ${r}`);
      else if (LEGACY.test(src.get(r))) out.push(`${f} reaches ${r}, which holds data-legacy`);
    }
  }
  return out;
});

t("no file imports components/console", () =>
  files.filter((f) => f !== SELF && OLD_PARTS.test(src.get(f))).map((f) => `${f} names components/console`));

t("no source holds data-legacy", () =>
  files.filter((f) => f !== SELF && LEGACY.test(src.get(f))).map((f) => `${f} holds data-legacy`));

t("the old parts, the old operator console and the old/new route switch are gone", () =>
  ["components/console", "app/(console)/platform/legacy", "lib/admin/new-ui-routes.js", ...["BillingPanel", "CaseStudiesPanel", "GrowthOpsPanels", "IncidentsPanel", "OverviewPanel", "PlatformAdmin", "PrivacyOpsPanel", "ProvisionRunsPanel", "QueuesPanel", "TenantDetail", "ThemesPanel"].map((n) => `components/platform/${n}.js`)].filter((p) => files.some((f) => f === p || f.startsWith(`${p}/`))).map((p) => `${p} still exists`));

console.log(failed ? `\n${failed} failure(s)` : "\nno old console UI in either console");
process.exit(failed ? 1 : 0);
