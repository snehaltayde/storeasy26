// The fonts are self-hosted (app/fonts/), never fetched from Google at build.
//   pnpm test:fonts
// No browser, no network. This suite proves:
//   1. no file in app/, components/ or lib/ imports next/font/google (its
//      Turbopack build sometimes failed and left every page answering 500)
//   2. every url() in app/fonts/fonts.css and every src path in
//      app/fonts/fonts.js is a woff2 file that exists
//   3. each family fonts.css declares is a font binding exported by fonts.js
//      (Turbopack names a next/font/local family after its binding), and
//      every family fonts.js exports has its latin face there and its other
//      subsets in fonts.css
//   4. each fallback fonts.js names has its metric-matched face in fonts.css
//   5. both root layouts take their fonts from app/fonts/fonts.js
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const SOURCE = /\.(m?[jt]sx?|cjs)$/;
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE.test(name)) out.push(p);
  }
  return out;
}

const js = readFileSync(join(FONTS, "fonts.js"), "utf8");
const css = readFileSync(join(FONTS, "fonts.css"), "utf8");
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => ({
  family: /font-family:\s*'([^']+)'/.exec(m[1])?.[1],
  url: /url\("([^"]+)"\)/.exec(m[1])?.[1],
  local: /local\("([^"]+)"\)/.exec(m[1])?.[1],
}));
const bindings = [...js.matchAll(/export const (\w+) = localFont\(\{([\s\S]*?)\n\}\);/g)].map((m) => ({ name: m[1], body: m[2] }));

t("no file in app/, components/ or lib/ imports next/font/google", () => {
  const bad = [];
  for (const dir of ["app", "components", "lib"]) {
    for (const f of walk(join(ROOT, dir))) {
      if (/["']next\/font\/google["']/.test(readFileSync(f, "utf8"))) bad.push(relative(ROOT, f));
    }
  }
  ok(!bad.length, `next/font/google in: ${bad.join(", ")}`);
});

t("the guard bites: a next/font/google import is caught by the pattern", () => {
  ok(/["']next\/font\/google["']/.test('import { Geist } from "next/font/google";'), "the pattern missed an import");
});

t("every font file fonts.css and fonts.js name is a woff2 that exists", () => {
  const paths = [...faces.filter((f) => f.url).map((f) => f.url), ...[...js.matchAll(/["'](\.\/[^"']+\.woff2)["']/g)].map((m) => m[1])];
  ok(paths.length >= 14, `only ${paths.length} font paths found`);
  const missing = paths.filter((p) => !p.endsWith(".woff2") || !existsSync(resolve(FONTS, p)));
  ok(!missing.length, `missing: ${missing.join(", ")}`);
});

t("fonts.css families are fonts.js bindings; each binding has its latin face in fonts.js and other subsets in fonts.css", () => {
  const names = bindings.map((b) => b.name);
  ok(names.join(",") === "Geist,GeistMono,Fraunces", `bindings: ${names.join(",")}`);
  const webFamilies = new Set(faces.filter((f) => f.url).map((f) => f.family));
  for (const fam of webFamilies) ok(names.includes(fam), `fonts.css declares '${fam}', which no fonts.js binding names`);
  for (const b of bindings) {
    ok(webFamilies.has(b.name), `${b.name} has no other subsets in fonts.css`);
    ok(/\/latin\.woff2/.test(b.body) && /prop: "unicode-range", value: LATIN|declarations: latin/.test(b.body), `${b.name}: its latin face is not the unicode-range'd latin file`);
    ok(/adjustFontFallback: false/.test(b.body), `${b.name}: adjustFontFallback must be false (the fallback face is in fonts.css)`);
  }
  ok(js.includes('import "./fonts.css"'), "fonts.js does not import fonts.css");
});

t("each fallback fonts.js names has its metric-matched face in fonts.css", () => {
  const fallbacks = bindings.map((b) => /fallback: \['"([^"]+)"'\]/.exec(b.body)?.[1]);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
