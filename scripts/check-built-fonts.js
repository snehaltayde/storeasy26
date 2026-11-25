// After `next build` (package.json "build" runs it): every --font-* variable
// the built CSS sets must name, first, a family that app/fonts/fonts.css
// declares, and the built CSS must carry that family's latin-ext face (₹ is
// U+20B9, in latin-ext). next/font/local names a family after its binding; if
// Next ever hashes that name, the non-latin faces in fonts.css stop joining
// the family and ₹ and other non-latin text quietly fall back. This fails the
// build instead.
//   node scripts/check-built-fonts.js [.next dir]   exit 1 with the reasons
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FONT_VARS = ["--font-geist-sans", "--font-geist-mono", "--font-fraunces"];
const RUPEE = 0x20b9;

const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");
// @font-face blocks → [{ family, ranges: [[lo, hi]] | null }]
export function fontFaces(css) {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const family = unquote(/font-family:\s*([^;}]+)/.exec(m[1])?.[1] || "");
    const range = /unicode-range:\s*([^;}]+)/.exec(m[1])?.[1];
    const ranges = range
      ? range.split(",").map((r) => {
          const [lo, hi = lo] = r.trim().replace(/^U\+/i, "").split("-");
          return lo.includes("?") ? [parseInt(lo.replace(/\?/g, "0"), 16), parseInt(lo.replace(/\?/g, "F"), 16)] : [parseInt(lo, 16), parseInt(hi, 16)];
        })
      : null;
    return { family, ranges };
  });
}

// builtCss: all built stylesheets joined; sourceCss: app/fonts/fonts.css. → problems[]
export function checkBuiltFonts(builtCss, sourceCss) {
  const problems = [];
  const declared = new Set(fontFaces(sourceCss).map((f) => f.family).filter((f) => !/ Fallback$/.test(f)));
  const built = fontFaces(builtCss);
  for (const name of FONT_VARS) {
    const values = new Set([...builtCss.matchAll(new RegExp(`${name}:\\s*([^;}]+)`, "g"))].map((m) => m[1].trim()));
    if (!values.size) problems.push(`${name} is not set in the built CSS`);
    for (const v of values) {
      const first = unquote(v.split(",")[0]);
      if (!declared.has(first)) {
        problems.push(`${name}: ${v} names "${first}", which app/fonts/fonts.css does not declare (its non-latin faces, ₹ included, would not join)`);
        continue;
      }
      const rupee = built.some((f) => f.family === first && f.ranges?.some(([lo, hi]) => lo <= RUPEE && RUPEE <= hi));
      if (!rupee) problems.push(`${name}: the built CSS has no "${first}" face covering ₹ (U+20B9)`);
    }
  }
  return problems;
}

function cssFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) cssFiles(p, out);
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = process.argv[2] || join(ROOT, ".next");
  const files = cssFiles(join(next, "static"));
  const problems = files.length ? checkBuiltFonts(files.map((f) => readFileSync(f, "utf8")).join("\n"), readFileSync(join(ROOT, "app/fonts/fonts.css"), "utf8")) : [`no built CSS under ${join(next, "static")}: run next build first`];
  if (problems.length) {
    for (const p of problems) console.error(`✗ built fonts: ${p}`);
    process.exit(1);
  }
  console.log(`✓ built fonts: ${FONT_VARS.join(", ")} name families app/fonts/fonts.css declares, each with a ₹ face (${files.length} stylesheets)`);
}
