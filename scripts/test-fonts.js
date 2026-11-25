// The fonts are self-hosted (app/fonts/), never fetched from Google at build.
//   pnpm test:fonts
// No browser, no network. This suite proves:
//   1. no code file in app/, components/, lib/ or the repo root names
//      next/font/google (its Turbopack build sometimes failed and left every
//      page answering 500), and no .css there loads fonts.googleapis.com; the
//      walk itself is tested on a planted folder
//   2. every url() in app/fonts/fonts.css and every src path in
//      app/fonts/fonts.js is a woff2 file that exists, and every file under
//      app/fonts/ is one of them (or fonts.js / fonts.css)
//   3. each family fonts.css declares is a font binding exported by fonts.js
//      (Turbopack names a next/font/local family after its binding), and
//      every family fonts.js exports has its latin face there and its other
//      subsets in fonts.css
//   4. each fallback fonts.js names has its metric-matched face in fonts.css
//   5. both root layouts take their fonts from app/fonts/fonts.js
//   6. scripts/check-built-fonts.js (run after next build) fails a --font-*
//      value whose family fonts.css does not declare (a hashed name) or that
//      has no ₹ face, and passes the real shape
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBuiltFonts } from "./check-built-fonts.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONTS = join(ROOT, "app/fonts");
let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`✗ ${name}\n    ${e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m);
};
const eq = (a, b) => ok(a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const CODE = /\.(m?[jt]sx?|cjs)$/;
const GOOGLE_IMPORT = /["'`]@?next\/font\/google[/"'`]/;
const GOOGLE_CSS = /fonts\.googleapis\.com/;
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
// → the files under root (app/, components/, lib/ and the root's own files)
// that name next/font/google (code) or load fonts.googleapis.com (.css)
export function googleFontUses(root) {
  const rootFiles = readdirSync(root).map((n) => join(root, n)).filter((p) => statSync(p).isFile());
  const files = [...rootFiles, ...["app", "components", "lib"].flatMap((d) => walk(join(root, d)))];
  return files
    .filter((f) => (CODE.test(f) && GOOGLE_IMPORT.test(readFileSync(f, "utf8"))) || (f.endsWith(".css") && GOOGLE_CSS.test(readFileSync(f, "utf8"))))
    .map((f) => relative(root, f));
}

const js = readFileSync(join(FONTS, "fonts.js"), "utf8");
const css = readFileSync(join(FONTS, "fonts.css"), "utf8");
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => ({
  family: /font-family:\s*'([^']+)'/.exec(m[1])?.[1],
  url: /url\("([^"]+)"\)/.exec(m[1])?.[1],
  local: /local\("([^"]+)"\)/.exec(m[1])?.[1],
}));
const bindings = [...js.matchAll(/export const (\w+) = localFont\(\{([\s\S]*?)\n\}\);/g)].map((m) => ({ name: m[1], body: m[2] }));

t("no file in app/, components/, lib/ or the repo root names next/font/google or loads fonts.googleapis.com", () => {
  const bad = googleFontUses(ROOT);
  ok(!bad.length, `Google Fonts in: ${bad.join(", ")}`);
});

t("the guard bites: a planted folder's imports, a subpath, a template literal and a .css @import are all found", () => {
  const dir = mkdtempSync(join(tmpdir(), "fonts-guard-"));
  try {
    const plant = (f, text) => (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), text));
    plant("instrumentation.js", 'import { Geist } from "next/font/google";\n');
    plant("app/(x)/layout.js", "import { Inter } from 'next/font/google/target.css';\n");
    plant("components/a/b.tsx", "const m = await import(`@next/font/google`);\n");
    plant("lib/c.css", '@import url("https://fonts.googleapis.com/css2?family=Inter");\n');
    plant("lib/ok.js", 'import localFont from "next/font/local";\n');
    plant("lib/note.md", 'import "next/font/google"\n');
    eq(googleFontUses(dir).sort().join(","), ["app/(x)/layout.js", "components/a/b.tsx", "instrumentation.js", "lib/c.css"].sort().join(","));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t("every font file fonts.css and fonts.js name is a woff2 that exists; every file under app/fonts/ is named", () => {
  const paths = [...faces.filter((f) => f.url).map((f) => f.url), ...[...js.matchAll(/["'](\.\/[^"']+\.woff2)["']/g)].map((m) => m[1])];
  ok(paths.length >= 14, `only ${paths.length} font paths found`);
  const missing = paths.filter((p) => !p.endsWith(".woff2") || !existsSync(resolve(FONTS, p)));
  ok(!missing.length, `missing: ${missing.join(", ")}`);
  const named = new Set([...paths.map((p) => resolve(FONTS, p)), join(FONTS, "fonts.js"), join(FONTS, "fonts.css")]);
  const stray = walk(FONTS).filter((f) => !named.has(f)).map((f) => relative(ROOT, f));
  ok(!stray.length, `under app/fonts/ but named by neither fonts.js nor fonts.css: ${stray.join(", ")}`);
});

t("fonts.css families are fonts.js bindings; each binding has its latin face in fonts.js and other subsets in fonts.css", () => {
  const names = bindings.map((b) => b.name);
  ok(names.join(",") === "Geist,GeistMono,Fraunces", `bindings: ${names.join(",")}`);
  const webFamilies = new Set(faces.filter((f) => f.url).map((f) => f.family));
  for (const fam of webFamilies) ok(names.includes(fam), `fonts.css declares '${fam}', which no fonts.js binding names`);
  for (const b of bindings) {
    ok(webFamilies.has(b.name), `${b.name} has no other subsets in fonts.css`);
    ok(/\/latin\.woff2/.test(b.body) && b.body.includes('{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" }'), `${b.name}: its latin face is not the unicode-range'd latin file`);
    ok(/adjustFontFallback: false/.test(b.body), `${b.name}: adjustFontFallback must be false (the fallback face is in fonts.css)`);
  }
  ok(js.includes('import "./fonts.css"'), "fonts.js does not import fonts.css");
});

t("each fallback fonts.js names has its metric-matched face in fonts.css", () => {
  const fallbacks = bindings.map((b) => /fallback: \["'([^']+)'"\]/.exec(b.body)?.[1]);
  ok(fallbacks.every(Boolean), `a binding has no fallback: ${fallbacks}`);
  for (const fb of fallbacks) {
    const face = faces.find((f) => f.family === fb);
    ok(face?.local, `no local() face for '${fb}'`);
    ok(new RegExp(`font-family: '${fb}';[^}]*size-adjust`).test(css), `'${fb}' has no metric overrides`);
  }
});

t("both root layouts take their fonts from app/fonts/fonts.js", () => {
  for (const f of ["app/(storefront)/layout.js", "app/(console)/layout.js"]) {
    ok(/from "@\/app\/fonts\/fonts"/.test(readFileSync(join(ROOT, f), "utf8")), `${f} does not import @/app/fonts/fonts`);
  }
});

t("check-built-fonts: a hashed family, an unset variable or a missing ₹ face fails; the real shape passes", () => {
  const good =
    ":root{--font-geist-sans:\"Geist\", \"Geist Fallback\";--font-geist-mono:\"GeistMono\", \"Geist Mono Fallback\";--font-fraunces:\"Fraunces\", \"Fraunces Fallback\"}" +
    ["Geist", "GeistMono", "Fraunces"].map((f) => `@font-face{font-family:${f};src:url(x.woff2);unicode-range:U+100-2BA,U+20AD-20C4}`).join("");
  eq(checkBuiltFonts(good, css).join(" | "), "");
  const hashed = good.replace('--font-geist-sans:"Geist"', '--font-geist-sans:"__Geist_1a2b3c"');
  ok(/--font-geist-sans: .*__Geist_1a2b3c.*does not declare/.test(checkBuiltFonts(hashed, css).join(" | ")), "a hashed family name passed");
  ok(/--font-fraunces is not set/.test(checkBuiltFonts(good.replace(/--font-fraunces:[^}]*/, ""), css).join(" | ")), "an unset variable passed");
  ok(/no "GeistMono" face covering ₹/.test(checkBuiltFonts(good.replace("font-family:GeistMono;src:url(x.woff2);unicode-range:U+100-2BA,U+20AD-20C4", "font-family:GeistMono;src:url(x.woff2);unicode-range:U+0000-00FF"), css).join(" | ")), "a family without a ₹ face passed");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
