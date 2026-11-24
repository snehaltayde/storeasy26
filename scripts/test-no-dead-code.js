// Phase 1 line 10 (docs/plans/phase-1.md, "Line 10", section 3): no dead or
// legacy code comes back.
//   node scripts/test-no-dead-code.js            the self-test, then the repo (pnpm test:no-dead-code)
//   node scripts/test-no-dead-code.js --report   the repo's findings, always exit 0 (for cleanups)
//
// Checks, over the files git knows (tracked and new, never ignored):
//   1. reachability: a walk of the real import graph from the roots below.
//      app/ and components/ must be reached from a production root; lib/ from
//      a production or a tooling root; scripts/ from a tooling root.
//      Edges come from TypeScript's own parser (comments never count): import,
//      export from, import(), require(), new URL(…, import.meta.url), any
//      string literal (or template piece, or the literal arguments of a
//      join()/resolve() call) that names an existing file from the repo root
//      or from the file's folder, the @/ alias, CSS @import, and extension and
//      index resolution.
//   2. ALLOWLIST: files the walk cannot see reached, each with a reason. An
//      entry fails when its file is gone or the walk now reaches it.
//   3. legacy names: a string literal naming a retired table or job, or an
//      identifier of the retired content-mode code (outside LEGACY_EXEMPT).
//   4. path mentions: every lib|components|app|scripts/….js|mjs named in
//      app/, components/ or lib/ (comments included) exists.
//   5. wiring: every `node <file>` in package.json exists, every
//      scripts/test-*.js has a test:* script, every .env.example key is used.
//   6. self-test: a temp tree that passes, then one mutation per check that
//      must fail it.
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/test-no-dead-code.js";

// Files nothing reaches through a literal the walk can read. Every entry says
// why it stays; a path ending in "/" covers everything under it.
export const ALLOWLIST = [
  { path: "components/console/README.md", reason: "the folder's notes for people (which console parts to use); Markdown is read, never imported" },
  { path: "components/ui/README.md", reason: "the folder's notes for people (the shadcn copy-in rules); Markdown is read, never imported" },
  { path: "lib/types/", reason: "TypeScript contracts that pnpm typecheck checks through tsconfig.json's include; JS modules adopt them one at a time, so nothing imports them yet" },
];

const CODE = /\.(js|mjs|cjs|jsx|ts|tsx)$/;
const EXTS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".css"];
const SUBJECT_DIRS = ["app/", "components/", "lib/", "scripts/"];

// Next 16 file conventions (app router) and metadata files.
const APP_CONVENTIONS = new Set(["page", "layout", "route", "loading", "error", "global-error", "not-found", "template", "default", "forbidden", "unauthorized"]);
const APP_METADATA = /^(sitemap|robots|manifest|icon\d*|apple-icon\d*|opengraph-image\d*|twitter-image\d*|favicon)\./;
const ROOT_PRODUCTION = ["instrumentation.js", "instrumentation-client.js", "next.config.mjs", "postcss.config.mjs", "proxy.js", "middleware.js", "app/globals.css"];
// Files whose commands name tooling (scanned word by word).
const COMMAND_FILES = (files) => files.filter((f) => f.startsWith(".githooks/") || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));

const LEGACY_TABLES = ["cms_blocks", "cms_pages", "cms_history", "cms_templates", "cms_approvals", "cms_preview_candidates", "product_overrides", "collection_overrides", "placements", "cms_migration_runs", "content_live_reversed", "publish_release"];
const LEGACY_STRING = new RegExp(`\\b(${LEGACY_TABLES.join("|")})\\b`);
const LEGACY_IDENTIFIERS = new Set(["assertLegacyContentWrites", "runLegacyBatch", "legacyGuardStatement", "migratingGuardStatement", "STORE_USES_LEGACY", "STORE_MIGRATING", "MIGRATING_MESSAGE"]);
// Tests that write or count a retired table to prove the documents path
// ignores it. An entry fails once its file no longer names one.
const LEGACY_PROOFS = [
  { path: "scripts/test-sections-render.js", reason: "seeds a leftover collection_overrides pin to prove a documents store's rails never read it" },
  { path: "scripts/test-design-doc.js", reason: "counts cms_blocks rows to prove a design save writes no legacy block" },
];
const LEGACY_EXEMPT = (f) =>
  f.startsWith("migrations/") ||
  LEGACY_PROOFS.some((e) => e.path === f) ||
  [
    "lib/schema.sql",
    "lib/platform/provision.js",
    "lib/platform/export.js",
    "lib/admin/saved-templates.js",
    "app/(console)/admin/(authed)/editor/templates/page.js",
    "scripts/test-schema-compat.js",
    "scripts/test-provision.js",
    "scripts/test-tenant-ops.js",
    "scripts/support/tenant-fixture.js",
    SELF,
  ].includes(f);

const PATH_MENTION = /(?<![\w-])((?:lib|components|app|scripts)\/[A-Za-z0-9_\-.()[\]/]*?\.m?js)(?![\w])/g;

function listFiles(root) {
  let out;
  try {
    out = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter(Boolean);
  } catch {
    out = walk(root, "");
  }
  return out.filter((f) => existsSync(join(root, f)));
}

function walk(root, rel) {
  const out = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (["node_modules", ".git", ".next"].includes(e.name)) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, p));
    else out.push(p);
  }
  return out;
}

// A literal is read as a path only where code could load it: a module
// specifier, an argument of a call or new (import(), require(), join(),
// readFile(), new URL(), spawn()), or an element of a list (argument lists,
// file lists). A path held as data ({ where: "components/x.js" }, a constant
// compared against) names a file without loading it, so it is no edge.
function loads(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(node)) return true;
  if (ts.isArrayLiteralExpression(p)) return true;
  if (ts.isLiteralTypeNode(p) && ts.isImportTypeNode(p.parent)) return true;
  return false;
}

// What a file names: possible paths (resolved later) and, for code, its
// string literals and identifiers (comments are never in the tree).
function scan(root, file) {
  const text = readFileSync(join(root, file), "utf8");
  const specs = [];
  const strings = [];
  const identifiers = [];
  if (file.endsWith(".css")) {
    for (const m of text.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/g)) specs.push(m[1]);
    return { text, specs, strings, identifiers };
  }
  if (!CODE.test(file)) return { text, specs, strings, identifiers };
  const kind = file.endsWith(".ts") ? ts.ScriptKind.TS : file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      strings.push(node.text);
      if (loads(node)) specs.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      for (const piece of [node.head.text, ...node.templateSpans.map((s) => s.literal.text)]) {
        strings.push(piece);
        if (loads(node)) specs.push(piece);
      }
    } else if (ts.isIdentifier(node)) {
      identifiers.push(node.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : "";
      if (callee === "join" || callee === "resolve") {
        const parts = node.arguments.filter((a) => ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)).map((a) => a.text);
        if (parts.length > 1) specs.push(parts.join("/"));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { text, specs, strings, identifiers };
}

function makeResolver(present) {
  const tryPath = (p) => {
    const n = posix.normalize(p);
    if (n.startsWith("../") || n === "..") return null;
    if (present.has(n)) return n;
    for (const e of EXTS) if (present.has(n + e)) return n + e;
    for (const e of EXTS) if (present.has(`${n}/index${e}`)) return `${n}/index${e}`;
    return null;
  };
  return (spec, fromFile) => {
    if (typeof spec !== "string" || !spec || spec.length > 300 || /\s/.test(spec) || spec.includes("://")) return null;
    // a bare word ("loading", "error") is never read as a path
    if (!spec.includes("/") && !/\.\w+$/.test(spec)) return null;
    const dir = posix.dirname(fromFile);
    if (spec.startsWith("@/")) return tryPath(spec.slice(2));
    if (spec.startsWith("./") || spec.startsWith("../")) return tryPath(posix.join(dir, spec));
    if (spec.startsWith("/")) return tryPath(spec.slice(1)) || tryPath(posix.join(dir, spec.slice(1)));
    return tryPath(spec) || tryPath(posix.join(dir, spec));
  };
}

const commandWords = (s) => s.split(/[\s;&|()"'`=]+/).filter(Boolean);

export function audit(root, { allowlist = ALLOWLIST } = {}) {
  const problems = [];
  const fail = (check, msg) => problems.push({ check, msg });
  const files = listFiles(root);
  const present = new Set(files);
  const resolve = makeResolver(present);
  const scans = new Map();
  const scanOf = (f) => {
    if (!scans.has(f)) scans.set(f, scan(root, f));
    return scans.get(f);
  };

  const pkg = existsSync(join(root, "package.json")) ? JSON.parse(readFileSync(join(root, "package.json"), "utf8")) : {};
  const scripts = pkg.scripts || {};

  // ---- 1. reachability ----
  const productionRoots = files.filter((f) => {
    if (ROOT_PRODUCTION.includes(f)) return true;
    if (!f.startsWith("app/")) return false;
    const base = posix.basename(f);
    return (CODE.test(base) && APP_CONVENTIONS.has(base.replace(CODE, ""))) || APP_METADATA.test(base);
  });
  const toolingRoots = new Set(files.filter((f) => f.startsWith("scripts/real-checks/")));
  const commandSources = [...Object.values(scripts), ...COMMAND_FILES(files).map((f) => readFileSync(join(root, f), "utf8"))];
  for (const cmd of commandSources) {
    for (const w of commandWords(cmd)) {
      const hit = resolve(w, "package.json");
      if (hit) toolingRoots.add(hit);
    }
  }

  const reach = (roots) => {
    const seen = new Set();
    const stack = [...roots];
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const spec of scanOf(f).specs) {
        const to = resolve(spec, f);
        if (to && !seen.has(to)) stack.push(to);
      }
    }
    return seen;
  };
  const production = reach(productionRoots);
  const tooling = reach(toolingRoots);
  const reached = (f) => {
    if (f.startsWith("app/") || f.startsWith("components/")) return production.has(f);
    if (f.startsWith("lib/")) return production.has(f) || tooling.has(f);
    if (f.startsWith("scripts/")) return tooling.has(f);
    return true;
  };
  const unreached = files.filter((f) => SUBJECT_DIRS.some((d) => f.startsWith(d)) && !reached(f));
  const covers = (entry, f) => (entry.path.endsWith("/") ? f.startsWith(entry.path) : f === entry.path);

  // ---- 2. allowlist ----
  for (const entry of allowlist) {
    if (!entry || typeof entry.path !== "string" || typeof entry.reason !== "string" || entry.reason.trim().length < 10) {
      fail("allowlist", `entry ${JSON.stringify(entry)} needs a path and a real reason`);
      continue;
    }
    const under = files.filter((f) => covers(entry, f));
    if (!under.length) fail("allowlist", `${entry.path} is allowlisted but no longer exists: remove the entry`);
    else if (!under.some((f) => unreached.includes(f))) fail("allowlist", `${entry.path} is allowlisted but the walk now reaches it: remove the entry`);
  }
  for (const f of unreached) {
    if (allowlist.some((e) => e && typeof e.path === "string" && covers(e, f))) continue;
    const rule = f.startsWith("scripts/") ? "a tooling root" : f.startsWith("lib/") ? "a production or tooling root" : "a production root";
    fail("reachability", `${f} is not reached from ${rule}: delete it, or allowlist it with the reason the walk cannot see it`);
  }

  // ---- 3. legacy names ----
  for (const f of files) {
    if (!CODE.test(f) || !SUBJECT_DIRS.some((d) => f.startsWith(d)) || LEGACY_EXEMPT(f)) continue;
    const { strings, identifiers } = scanOf(f);
    for (const s of strings) {
      const m = LEGACY_STRING.exec(s);
      if (m) fail("legacy", `${f} names the retired ${m[1]} in a string`);
    }
    for (const id of new Set(identifiers)) if (LEGACY_IDENTIFIERS.has(id)) fail("legacy", `${f} uses the retired ${id}`);
  }
  for (const e of root === ROOT ? LEGACY_PROOFS : []) {
    if (!present.has(e.path) || !scanOf(e.path).strings.some((s) => LEGACY_STRING.test(s))) fail("legacy", `${e.path} is exempt as a legacy proof but no longer names a retired table: remove the entry`);
  }

  // ---- 4. path mentions ----
  for (const f of files) {
    if (!CODE.test(f) || !["app/", "components/", "lib/"].some((d) => f.startsWith(d))) continue;
    for (const m of scanOf(f).text.matchAll(PATH_MENTION)) {
      if (!present.has(m[1])) fail("paths", `${f} mentions ${m[1]}, which does not exist`);
    }
  }

  // ---- 5. wiring ----
  for (const [name, cmd] of Object.entries(scripts)) {
    const words = commandWords(cmd);
    words.forEach((w, i) => {
      if (w !== "node") return;
      // past node's flags; --env-file=.env.local splits on "=" into two words
      let j = i + 1;
      while (j < words.length && (words[j].startsWith("-") || words[j].startsWith(".env"))) j++;
      const file = words[j];
      if (file && !present.has(posix.normalize(file))) fail("wiring", `package.json ${name} runs ${file}, which does not exist`);
    });
  }
  const testCommands = new Set(Object.entries(scripts).filter(([n]) => n.startsWith("test:")).map(([, c]) => c.trim()));
  for (const f of files) {
    if (/^scripts\/test-[^/]+\.js$/.test(f) && !testCommands.has(`node ${f}`)) fail("wiring", `${f} has no test:* script in package.json`);
  }
  if (present.has(".env.example")) {
    const keys = readFileSync(join(root, ".env.example"), "utf8")
      .split("\n")
      .map((l) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(l)?.[1])
      .filter(Boolean);
    const corpus = files.filter((f) => CODE.test(f) || f === "vercel.json").map((f) => scanOf(f).text);
    for (const k of new Set(keys)) {
      const word = new RegExp(`\\b${k}\\b`);
      if (!corpus.some((t) => word.test(t))) fail("wiring", `.env.example sets ${k}, which no code reads`);
    }
  }

  return { problems, unreached, production, tooling };
}

// ---- 6. self-test ----
function selfTest() {
  const write = (dir, tree) => {
    for (const [p, body] of Object.entries(tree)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
  };
  const base = {
    "package.json": JSON.stringify({ scripts: { "test:a": "node scripts/test-a.js", tool: "node --env-file=.env.local scripts/tool.js" } }),
    ".env.example": "FOO=\n",
    "app/layout.js": 'import "./globals.css";\nimport { x } from "@/lib/x";\nexport default function L({ children }) { return children; }\n',
    "app/globals.css": '@import "./extra.css";\n',
    "app/extra.css": "",
    "app/(shop)/page.js": 'import Comp from "../../components/Comp";\nexport default Comp;\n',
    // JSX text with an apostrophe must not open a string
    "components/Comp.js": 'import { y } from "./y";\nexport default function Comp() { return <p>Don\'t {y}</p>; }\n',
    "components/y.js": "export const y = 1;\n",
    "lib/x.js": "// lib/z.js does the rest\nexport const x = process.env.FOO;\n",
    "lib/z.js": "export const z = 1;\n",
    "scripts/test-a.js": 'import { join } from "node:path";\nimport "../lib/x.js";\nconst p = join(ROOT, "lib", "z.js");\nconst f = new URL("./fixtures/a.json", import.meta.url);\n',
    "scripts/fixtures/a.json": "{}",
    "scripts/tool.js": "",
  };
  const run = (extra = {}, opts = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "no-dead-code-"));
    try {
      write(dir, { ...base, ...extra });
      return audit(dir, { allowlist: [], ...opts }).problems;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const results = [];
  const expect = (label, problems, check, needle) => {
    const ok = check === null ? problems.length === 0 : problems.length > 0 && problems.every((p) => p.check === check) && problems.some((p) => p.msg.includes(needle));
    results.push({ label, ok, problems });
  };
  expect("a clean tree passes every check", run(), null);
  expect("an orphan component fails reachability", run({ "components/Orphan.js": "export default 1;\n" }), "reachability", "components/Orphan.js");
  expect("a component only a test reaches fails reachability", run({ "components/OnlyTested.js": "export default 1;\n", "scripts/test-a.js": `${base["scripts/test-a.js"]}import "../components/OnlyTested.js";\n` }), "reachability", "components/OnlyTested.js");
  expect("an orphan script fails reachability", run({ "scripts/old.js": "" }), "reachability", "scripts/old.js");
  expect("a retired table in a string fails legacy names", run({ "lib/z.js": 'export const z = "select * from cms_pages";\n' }), "legacy", "cms_pages");
  expect("a retired identifier fails legacy names", run({ "lib/z.js": "export const runLegacyBatch = 1;\n" }), "legacy", "runLegacyBatch");
  expect("a retired table in a comment does not count", run({ "lib/z.js": "// cms_pages was here\nexport const z = 1;\n" }), null);
  expect("a comment naming a missing file fails path mentions", run({ "lib/z.js": "// see lib/gone.js\nexport const z = 1;\n" }), "paths", "lib/gone.js");
  expect("an allowlist entry for a reached file is stale", run({}, { allowlist: [{ path: "lib/z.js", reason: "a reason that is long enough" }] }), "allowlist", "now reaches");
  expect("an allowlist entry for a missing file is stale", run({}, { allowlist: [{ path: "lib/nope.js", reason: "a reason that is long enough" }] }), "allowlist", "no longer exists");
  expect("an allowlisted orphan passes", run({ "lib/dyn.js": "" }, { allowlist: [{ path: "lib/dyn.js", reason: "loaded by a template-built path" }] }), null);
  expect("a package.json script naming a missing file fails wiring", run({ "package.json": JSON.stringify({ scripts: { ...JSON.parse(base["package.json"]).scripts, gone: "node scripts/gone.js" } }) }), "wiring", "scripts/gone.js");
  expect("an unused .env.example key fails wiring", run({ ".env.example": "FOO=\nUNUSED_KEY=\n" }), "wiring", "UNUSED_KEY");
  expect("a test file with no test:* script fails wiring", run({ "scripts/test-b.js": "", "package.json": JSON.stringify({ scripts: { ...JSON.parse(base["package.json"]).scripts, b: "node scripts/test-b.js" } }) }), "wiring", "scripts/test-b.js");
  return results;
}

const report = process.argv.includes("--report");
let failed = 0;
if (!report) {
  console.log("— self-test: each check fails on a tree that breaks it");
  for (const r of selfTest()) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.label}`);
    if (!r.ok) {
      failed++;
      for (const p of r.problems) console.log(`    [${p.check}] ${p.msg}`);
    }
  }
}
console.log("— this repo");
const { problems } = audit(ROOT);
if (report) {
  for (const p of problems) console.log(`[${p.check}] ${p.msg}`);
  console.log(`${problems.length} finding(s) (report only)`);
  process.exit(0);
}
for (const check of ["reachability", "allowlist", "legacy", "paths", "wiring"]) {
  const mine = problems.filter((p) => p.check === check);
  console.log(`${mine.length ? "✗" : "✓"} ${check}`);
  for (const p of mine) console.log(`    ${p.msg}`);
}
failed += problems.length;
console.log(failed ? `\n${failed} failure(s)` : "\nno dead or legacy code");
process.exit(failed ? 1 : 0);
