// shadcn/ui for the consoles only; the storefront is unchanged (Phase 0 line 7).
//   pnpm test:console-ui
// No browser, no network. This suite proves:
//   1. nothing reachable from app/(storefront)/** (or proxy.js / middleware.js /
//      instrumentation.js) resolves into components/ui/, components/kit/
//      (Phase 2 line 0), radix-ui, class-variance-authority or tailwind-merge
//   2. every app/console.css rule outside @theme, @utility, @property,
//      @custom-variant and @keyframes is scoped to [data-console] or .console
//      (no :root, *, html or body); tw-animate-css itself adds only @property,
//      @theme, @utility and keyframes; console.css @imports only tw-animate-css;
//      no storefront file uses a tw-animate utility that collides with a
//      Tailwind built-in (delay-*), found by compiling Tailwind core
//   3. the console theme's keys are exactly the expected list: no default
//      Tailwind key, no globals.css key; --color-primary and --color-ring are
//      the only two re-pointed names
//   4. no storefront file uses the new utility names, any tw-animate utility
//      (names read from the package), dark: or class "console"
//   5. .console / .console.dark hold exactly docs/UI.md's colour table
//   6. components/ui has no hex, oklch(, rgb( or palette utilities, and uses
//      the docs/UI.md radius, shadow and weight rules
//   7. cn merges rounded-ctl/rounded-card and shadow-card/shadow-overlay
//   8. the components render server-side (Next's SWC, real radix-ui) with their
//      data-slots; the sheet keeps Esc and the overlays motion-reduce
//   9. Cmd/Ctrl+B skips inputs and contenteditable; the sidebar cookie is
//      path-scoped (/admin by default) and SameSite=Lax
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n    ")}`);
  }
}
const eq = (a, b, m = "") => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${m} expected ${y}, got ${x}`);
};
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};

const UI = "components/ui";
const KIT = "components/kit";
const UI_FILES = ["alert-dialog", "avatar", "badge", "button", "card", "checkbox", "dropdown-menu", "input", "label", "popover", "progress", "select", "separator", "sheet", "sidebar", "skeleton", "switch", "table", "tabs", "textarea", "tooltip", "use-mobile", "utils"].map((n) => `${UI}/${n}.js`);
const BANNED_PACKAGES = ["radix-ui", "class-variance-authority", "tailwind-merge"];
const CONSOLE_DIRS = ["components/admin/", "components/console/", "components/platform/", "components/ui/", "components/kit/"];

const walkFiles = (rel, out = []) => {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) return (out.push(rel), out);
  for (const f of readdirSync(abs)) walkFiles(join(rel, f), out);
  return out;
};
const code = (f) => /\.(m?js|jsx|tsx?)$/.test(f);

// ---------- CSS: a small block parser (enough for these files) ----------

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
// → [{ prelude, body }] at one nesting level; statements (no body) have body null
function blocks(css) {
  const out = [];
  let i = 0;
  let start = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === ";") {
      const prelude = css.slice(start, i).trim();
      if (prelude) out.push({ prelude, body: null });
      start = ++i;
    } else if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
        j++;
      }
      out.push({ prelude: css.slice(start, i).trim(), body: css.slice(i + 1, j - 1) });
      start = i = j;
    } else i++;
  }
  return out;
}
const AT_FREE = /^@(theme|utility|property|custom-variant|keyframes|import)\b/;
// Every style rule's selector list (recursing into @media / @layer / @supports).
function styleRules(css, out = []) {
  for (const b of blocks(stripComments(css))) {
    if (AT_FREE.test(b.prelude)) continue;
    if (/^@(media|layer|supports)\b/.test(b.prelude)) {
      if (b.body != null) styleRules(b.body, out);
      continue;
    }
    if (b.body != null) out.push(b.prelude);
  }
  return out;
}
const themeKeys = (css) =>
  blocks(stripComments(css))
    .filter((b) => /^@theme\b/.test(b.prelude) && b.body)
    .flatMap((b) => blocks(b.body).filter((d) => d.body == null).map((d) => d.prelude.split(":")[0].trim()))
    .filter((k) => k.startsWith("--"));
const declsOf = (body) => Object.fromEntries(blocks(body).filter((d) => d.body == null && d.prelude.startsWith("--")).map((d) => [d.prelude.slice(0, d.prelude.indexOf(":")).trim(), d.prelude.slice(d.prelude.indexOf(":") + 1).trim()]));
const ruleBody = (css, selector) => blocks(stripComments(css)).find((b) => b.prelude.replace(/\s+/g, " ") === selector)?.body ?? null;

const consoleCss = read("app/console.css");
const IMPORT_ALLOWLIST = ['"tw-animate-css"'];
const importsOf = (css) => blocks(stripComments(css)).filter((b) => /^@import\b/.test(b.prelude)).map((b) => b.prelude.replace(/^@import\s+/, ""));

// tw-animate-css's utility names, read from the package (not hand-listed)
const TWA_CSS = read("node_modules/tw-animate-css/dist/tw-animate.css");
const TWA_UTILS = [...stripComments(TWA_CSS).matchAll(/@utility\s+(-?[a-z0-9-]+(?:-\*)?)\s*\{([^}]*)\}/g)].map((m) => ({ name: m[1], body: m[2] }));
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// one class token (variants and ! stripped) against utility names; "x-*" takes any value
const utilityMatcher = (names) => {
  const alt = names.map((n) => (n.endsWith("-*") ? `${reEsc(n.slice(0, -2))}-[^\\s]+` : reEsc(n))).join("|");
  const re = new RegExp(`^(?:${alt})$`);
  return (token) => re.test(token.replace(/^(?:[^\s:]+:)*/, "").replace(/^!|!$/g, ""));
};
// class tokens of a storefront file: string literals in JS (comments stripped), @apply in CSS.
// Hyphen-free names (running, paused) count only inside className/class/cn()/clsx().
function classTokens(src, isCss) {
  if (isCss) return { any: [...stripComments(src).matchAll(/@apply\s+([^;]+);/g)].flatMap((m) => m[1].split(/\s+/)), cls: [] };
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const any = [...noComments.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].flatMap((m) => m[2].split(/\s+/)).filter(Boolean);
  const cls = [...noComments.matchAll(/\b(?:className|class)\s*=\s*\{?\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1|\b(?:cn|clsx|cva)\(([^)]*)\)/g)].flatMap((m) => (m[2] ?? m[3] ?? "").replace(/["'`,]/g, " ").split(/\s+/)).filter(Boolean);
  return { any, cls };
}
const twaUses = (src, isCss, names = TWA_UTILS.map((u) => u.name)) => {
  const hyphen = utilityMatcher(names.filter((n) => n.includes("-")));
  const bare = utilityMatcher(names.filter((n) => !n.includes("-")));
  const { any, cls } = classTokens(src, isCss);
  return [...any.filter(hyphen), ...cls.filter((t) => bare(t) || hyphen(t))];
};

const storefrontFiles = () => [...walkFiles("app").filter((f) => !f.startsWith("app/(console)/") && !f.startsWith("app/api/") && (code(f) || f.endsWith(".css")) && f !== "app/console.css"), ...walkFiles("components").filter((f) => code(f) && !CONSOLE_DIRS.some((d) => f.startsWith(d)))];

// ---------- 1. the storefront never reaches the console components ----------

await t("nothing reachable from the storefront resolves into components/ui/, components/kit/, radix-ui, class-variance-authority or tailwind-merge", async () => {
  const entries = [...walkFiles("app/(storefront)").filter(code), ...["proxy.js", "middleware.js", "instrumentation.js"].filter((f) => existsSync(join(ROOT, f)))];
  ok(entries.length > 20, `found ${entries.length} storefront entry files:`);
  const seen = new Set();
  const bad = [];
  const resolveLocal = (from, id) => {
    const base = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(join(ROOT, from)), id);
    for (const c of [base, ...[".js", ".mjs", ".jsx", ".ts", ".tsx"].map((x) => `${base}${x}`), ...["index.js", "index.jsx", "index.ts", "index.tsx"].map((x) => join(base, x))]) if (existsSync(c) && statSync(c).isFile()) return relative(ROOT, c);
    return null;
  };
  const visit = (rel, chain) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    if (rel.startsWith(`${UI}/`) || rel.startsWith(`${KIT}/`)) return bad.push(`${chain.join(" → ")} → ${rel}`);
    const src = readFileSync(join(ROOT, rel), "utf8");
    const ids = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])([^"'`$]+)\1/g)].map((m) => m[2]);
    for (const id of ids) {
      if (BANNED_PACKAGES.some((p) => id === p || id.startsWith(`${p}/`))) bad.push(`${[...chain, rel].join(" → ")} imports ${id}`);
      else if (id.startsWith("@/") || id.startsWith(".")) {
        const target = resolveLocal(rel, id);
        if (target && code(target)) visit(target, [...chain, rel]);
      }
    }
  };
  for (const e of entries) visit(e, []);
  ok(seen.size > 100, `followed ${seen.size} files:`);
  eq(bad, [], "reached:");
  // the bite: a storefront file that reached components/kit/ would be caught
  visit(`${KIT}/money-cell.js`, ["(a storefront file)"]);
  ok(bad.some((b) => b.endsWith(`${KIT}/money-cell.js`)), "a path into components/kit/ is caught:");
});

// ---------- 2. console.css is scoped ----------

await t("every console.css rule outside @theme/@utility/@property/@custom-variant/@keyframes is scoped to [data-console] or .console", async () => {
  const rules = styleRules(consoleCss);
  ok(rules.length >= 5, `found ${rules.length} rules:`);
  const unscoped = rules.flatMap((r) => r.split(",").map((s) => s.trim())).filter((s) => !/^(\[data-console\]|\.console)(?![\w-])/.test(s));
  eq(unscoped, [], "unscoped selectors:");
  // line 8: ".console *" and ".console [data-legacy] *" are descendants of the scope
  for (const s of rules.join(",").split(",")) ok(!/(^|[\s>+~,])(:root|html|body|\*)(?![\w-])/.test(s.trim().replace(/^(\[data-console\]|\.console(\.dark)?)( \[data-legacy\])?( \*)?/, "")), `no :root/html/body/* outside the scope in "${s.trim()}":`);
  ok(/^\s*@import\s+"tw-animate-css";/m.test(stripComments(consoleCss)) && stripComments(consoleCss).trim().startsWith('@import "tw-animate-css"'), "@import \"tw-animate-css\" comes first:");
  eq(importsOf(consoleCss).filter((i) => !IMPORT_ALLOWLIST.includes(i)), [], "console.css @imports off the allowlist:");
  eq(importsOf(consoleCss).length, 1, "console.css has exactly one @import:");
  eq(importsOf('@import "tw-animate-css";\n@import "./x.css";'), ['"tw-animate-css"', '"./x.css"'], "the import check sees a second @import:");
  // the bite: an unscoped rule is caught
  eq(styleRules(":root{--x:1} .console a{color:red} @media (x){body{margin:0}}"), [":root", ".console a", "body"], "parser sees nested rules:");
});

await t("tw-animate-css adds only @property, @theme, @utility and keyframes (no selector reaches a storefront element)", async () => {
  const css = read("node_modules/tw-animate-css/dist/tw-animate.css");
  const kinds = new Set(blocks(stripComments(css)).map((b) => (b.prelude.match(/^@[\w-]+/) || [b.prelude])[0]));
  eq([...kinds].sort(), ["@property", "@theme", "@utility"], "top-level kinds:");
  ok(TWA_UTILS.length >= 50 && TWA_UTILS.some((u) => u.name === "delay-*") && TWA_UTILS.some((u) => u.name === "running"), `read ${TWA_UTILS.length} tw-animate utility names:`);
});

await t("tw-animate-css utilities that collide with a Tailwind built-in are found, and no storefront file uses one", async () => {
  // compile Tailwind core alone (no tw-animate) on sample candidates of every tw-animate utility
  const { compile } = require("tailwindcss");
  const tw = await compile('@import "tailwindcss/theme.css";\n@import "tailwindcss/utilities.css";', {
    base: ROOT,
    loadStylesheet: async (id) => {
      const path = require.resolve(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  const twaTheme = [...TWA_CSS.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]);
  const samples = (u) => {
    if (!u.name.endsWith("-*")) return [u.name];
    const v = new Set(["0", "1", "2", "50", "100", "150", "300", "1000", "initial", "[1s]"]);
    for (const [, ns] of u.body.matchAll(/--value\((--[a-z0-9-]+)-\*/g)) for (const k of twaTheme) if (k.startsWith(`${ns}-`)) v.add(k.slice(ns.length + 1));
    for (const [, x] of u.body.matchAll(/"([\w-]+)"/g)) v.add(x);
    return [...v].map((x) => `${u.name.slice(0, -2)}-${x}`);
  };
  const cands = TWA_UTILS.flatMap((u) => samples(u).map((c) => [u.name, c]));
  const out = tw.build(cands.map(([, c]) => c));
  const sel = (c) => new RegExp(`\\.${reEsc(c.replace(/[^\w-]/g, "\\$&"))}(?![\\w\\\\-])`);
  const colliding = [...new Set(cands.filter(([, c]) => sel(c).test(out)).map(([n]) => n))];
  ok(colliding.includes("delay-*"), `the collision check bites (delay-* is Tailwind's transition-delay too); found ${JSON.stringify(colliding)}:`);
  const hits = [];
  for (const f of storefrontFiles()) {
    const used = twaUses(read(f), f.endsWith(".css"), colliding);
    if (used.length) hits.push(`${f}: ${[...new Set(used)].join(" ")}`);
  }
  eq(hits, [], "storefront uses a colliding utility:");
});

// ---------- 3. the theme ----------

// --color-* names console.css had before shadcn (Phase 0 line 7 keeps them)
const LEGACY_KEYS = ["surface", "surface-muted", "surface-sunken", "edge", "edge-strong", "fg", "fg-muted", "fg-subtle", "primary-hover", "primary-fg", "caccent", "caccent-bg", "caccent-edge", ...["success", "warning", "danger", "info"].flatMap((k) => [k, `${k}-bg`, `${k}-edge`])];
const REPOINTED_KEYS = ["primary", "ring"];
const CONSOLE_ONLY_KEYS = ["warning-text"]; // maps onto --c-warning-text, not a shadcn variable
const NEW_KEYS = ["card", "card-foreground", "popover", "popover-foreground", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive", "border", "input", "sidebar", "sidebar-foreground", "sidebar-primary", "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground", "sidebar-border", "sidebar-ring"];

await t("the console theme adds no default Tailwind key and no globals.css key; only --color-primary and --color-ring are re-pointed", async () => {
  const defaults = new Set(themeKeys(readFileSync(require.resolve("tailwindcss/theme.css"), "utf8")));
  ok(defaults.has("--color-red-500") && defaults.has("--radius-md"), "read Tailwind's default theme:");
  const ours = themeKeys(consoleCss);
  eq(ours.filter((k) => defaults.has(k)), [], "default keys overridden:");
  eq(ours.filter((k) => /^--(radius|shadow|font|text)-/.test(k) && !["--radius-ctl", "--radius-card", "--shadow-card", "--shadow-overlay"].includes(k)), [], "radius/shadow/font/text keys:");
  const globals = new Set(themeKeys(read("app/globals.css")));
  eq(ours.filter((k) => globals.has(k)), [], "globals.css keys redefined:");
  for (const k of NEW_KEYS) ok(ours.includes(`--color-${k}`), `--color-${k} is in the theme:`);
  const expected = [...[...LEGACY_KEYS, ...REPOINTED_KEYS, ...CONSOLE_ONLY_KEYS, ...NEW_KEYS].map((k) => `--color-${k}`), "--radius-ctl", "--radius-card", "--shadow-card", "--shadow-overlay"];
  eq(ours.filter((k) => !expected.includes(k)), [], "unexpected theme keys:");
  eq(expected.filter((k) => !ours.includes(k)), [], "missing theme keys:");
  eq(ours.length, new Set(ours).size, "no theme key set twice:");
  const theme = Object.assign({}, ...blocks(stripComments(consoleCss)).filter((b) => /^@theme\b/.test(b.prelude)).map((b) => declsOf(b.body)));
  eq(theme["--color-primary"], "var(--primary)", "--color-primary:");
  eq(theme["--color-ring"], "var(--ring)", "--color-ring:");
  const legacy = declsOf(ruleBody(consoleCss, "[data-console], .console [data-legacy]"));
  eq([legacy["--primary"], legacy["--ring"]], ["var(--c-primary)", "var(--c-ring)"], "[data-console] keeps the legacy primary and ring:");
  ok(/^@custom-variant dark \(&:where\(\.console\.dark, \.console\.dark \*\)\);$/m.test(consoleCss), "dark: matches only inside .console.dark:");
});

// ---------- 4. the storefront doesn't use the new names ----------

await t("no storefront file uses the new utility names, a tw-animate utility, dark: or class \"console\"", async () => {
  const files = storefrontFiles();
  ok(files.length > 50, `scanned ${files.length} files:`);
  const prefixes = "bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|divide|from|via|to|shadow|accent|caret|decoration|placeholder";
  const names = [...NEW_KEYS, ...REPOINTED_KEYS, ...CONSOLE_ONLY_KEYS].sort((a, b) => b.length - a.length).join("|");
  const utility = new RegExp(`(?<![\\w-])(?:[\\w-]+:)*-?(?:${prefixes})-(?:${names})(?:\\/\\d+)?(?![\\w-])`);
  const anim = /(?<![\w-])(?:animate-in|animate-out|fade-(?:in|out)(?:-\d+)?|zoom-(?:in|out)(?:-\d+)?|slide-(?:in-from|out-to)-[a-z]+(?:-\d+)?)(?![\w-])/;
  const hits = [];
  for (const f of files) {
    const src = read(f);
    for (const [re, what] of [
      [utility, "a new utility"],
      [anim, "an animate-in/out utility"],
      [/(?<![\w-])dark:/, "dark:"],
      [/class(?:Name)?=\{?["'`][^"'`]*(?<![\w-])console(?![\w-])/, 'class "console"'],
      [/(?<![\w-])radius-ctl|rounded-card|shadow-card|shadow-overlay(?![\w-])/, "a console radius/shadow"],
    ]) {
      const m = re.exec(src);
      if (m) hits.push(`${f}: ${what} (${m[0]})`);
    }
    const twa = twaUses(src, f.endsWith(".css"));
    if (twa.length) hits.push(`${f}: a tw-animate utility (${[...new Set(twa)].join(" ")})`);
  }
  eq(hits, [], "storefront uses:");
  const tokenCount = files.reduce((n, f) => n + classTokens(read(f), f.endsWith(".css")).any.length, 0);
  ok(tokenCount > 5000, `read ${tokenCount} string tokens from storefront files:`);
  const bites = ['<i className="hover:delay-150 x" />', '<i className="running" />', "cn('paused', a)", 'const k = "repeat-infinite fill-mode-forwards";', '`direction-reverse play-state-paused`', '"blur-in spin-out-90 animation-duration-300"', '"-spin-in-45 md:fade-in"'];
  eq(bites.filter((b) => !twaUses(b, false).length), [], "the tw-animate check bites on:");
  eq(twaUses('// a test is running\nconst s = status === "running"; const t = "delayed";', false), [], "prose, comments and non-class strings are spared:");
  ok(twaUses(".x { @apply delay-100; }", true).length === 1, "the CSS @apply check bites:");
  ok(utility.test('className="bg-card"') && !utility.test('className="bg-accent-400"') && utility.test("hover:text-muted-foreground/80"), "the name pattern bites (bg-card, hover:text-muted-foreground/80) and spares bg-accent-400:");
});

// ---------- 5. tokens equal docs/UI.md ----------

await t(".console and .console.dark hold exactly docs/UI.md's colour table", async () => {
  const rows = [...read("docs/UI.md").matchAll(/^\| `(--c-[\w-]+)` \| `([^`]+)`[^|]*\| `([^`]+)`[^|]*\|/gm)].map((m) => ({ name: m[1], light: m[2], dark: m[3] }));
  eq(rows.length, 13, "UI.md rows:"); // 12 + --c-warning-text (contrast fix)
  const light = declsOf(ruleBody(consoleCss, ".console"));
  const dark = declsOf(ruleBody(consoleCss, ".console.dark"));
  for (const r of rows) {
    eq(light[r.name], r.light, `.console ${r.name}:`);
    eq(dark[r.name], r.dark, `.console.dark ${r.name}:`);
  }
  eq(Object.keys(dark).sort(), rows.map((r) => r.name).sort(), ".console.dark sets only the table's tokens:");
  const cTokens = Object.keys(light).filter((k) => k.startsWith("--c-"));
  eq(cTokens.sort(), rows.map((r) => r.name).sort(), ".console's --c-* tokens are the table's:");
  const map = { "--background": "var(--c-bg)", "--foreground": "var(--c-text)", "--card": "var(--c-surface)", "--primary": "var(--c-accent)", "--primary-foreground": "var(--c-accent-fg)", "--ring": "var(--c-accent)", "--border": "var(--c-border)", "--muted-foreground": "var(--c-muted)", "--destructive": "var(--c-danger)", "--sidebar": "var(--c-sunken)" };
  for (const [k, v] of Object.entries(map)) eq(light[k], v, `.console ${k}:`);
  for (const k of NEW_KEYS) ok(light[`--${k}`], `.console sets --${k}:`);
});

// ---------- 6. components/ui follows docs/UI.md ----------

await t("components/ui has no raw colours or palette utilities, and follows the radius, shadow and weight rules", async () => {
  for (const f of UI_FILES) ok(existsSync(join(ROOT, f)), `${f} exists:`);
  ok(existsSync(join(ROOT, UI, "README.md")), "README.md exists:");
  const palette = /(?<![\w-])(?:[\w-]+:)*-?(?:bg|text|border|ring|ring-offset|outline|fill|stroke|divide|from|via|to|shadow|accent|caret|decoration|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?![\w])/;
  const hits = [];
  for (const f of UI_FILES) {
    const src = read(f);
    for (const [re, what] of [
      [/#[0-9a-fA-F]{3,8}\b/, "a hex colour"],
      [/oklch\(|rgba?\(|hsla?\(/, "a raw colour function"],
      [palette, "a palette utility"],
      [/(?<![\w-])rounded-(?:sm|lg|xl|2xl|3xl|\[)/, "a radius off the scale"],
      [/(?<![\w-])shadow-(?:sm|md|lg|xl|2xl)(?![\w-])/, "a stock shadow"],
      [/(?<![\w-])font-(?:bold|extrabold|black|heading)(?![\w-])/, "a weight off the scale"],
      [/(?<![\w-])data-(?:open|closed|horizontal|vertical|active|checked|selected):/, "a shadcn/tailwind.css variant"],
      [/from ["'](?:cn|@\/lib\/utils|@\/hooks\/)/, "the CLI's cn or hooks path"],
    ]) {
      const m = re.exec(src);
      if (m) hits.push(`${f}: ${what} (${m[0]})`);
    }
  }
  eq(hits, [], "found:");
  ok(/rounded-md/.test(read(`${UI}/button.js`)) && /rounded-md/.test(read(`${UI}/input.js`)), "controls are rounded-md (6px):");
  for (const f of ["dropdown-menu", "sheet"]) ok(/rounded-(?:[trbl]-)?card/.test(read(`${UI}/${f}.js`)), `${f} uses rounded-card (10px):`);
  for (const f of ["button", "input"]) ok(read(`${UI}/${f}.js`).includes("focus-visible:ring-ring"), `${f} has the accent focus ring:`);
  for (const f of ["sheet", "dropdown-menu", "tooltip"]) ok(read(`${UI}/${f}.js`).includes("motion-reduce:animate-none"), `${f} overlays stop animating with reduced motion:`);
  ok(!/onEscapeKeyDown/.test(read(`${UI}/sheet.js`)), "the sheet keeps Radix's Esc-to-close:");
  const cfg = JSON.parse(read("components.json"));
  eq([cfg.style, cfg.rsc, cfg.tsx, cfg.aliases.ui, cfg.aliases.utils, cfg.tailwind.css], ["radix-nova", true, false, "@/components/ui", "@/components/ui/utils", "app/console.css"], "components.json:");
});

// ---------- 7. cn ----------

await t("cn merges rounded-ctl/rounded-card and shadow-card/shadow-overlay with the stock scale", async () => {
  const { cn } = await import(pathToFileURL(join(ROOT, UI, "utils.js")).href);
  eq(cn("rounded-md", "rounded-card"), "rounded-card", "rounded-md then rounded-card:");
  eq(cn("rounded-card", "rounded-md"), "rounded-md", "rounded-card then rounded-md:");
  eq(cn("rounded-ctl rounded-full"), "rounded-full", "rounded-ctl then rounded-full:");
  eq(cn("shadow-card", "shadow-overlay"), "shadow-overlay", "shadow-card then shadow-overlay:");
  eq(cn("shadow-overlay", "shadow-none"), "shadow-none", "shadow-overlay then shadow-none:");
  eq(cn("px-2", false && "px-3", null, ["text-sm", { "font-medium": true, hidden: false }], "px-4"), "text-sm font-medium px-4", "clsx inputs and a stock conflict:");
  eq(cn("bg-muted text-muted-foreground"), "bg-muted text-muted-foreground", "colours stay:");
});

// ---------- 8. server render ----------

// Next's SWC compiles components/ui; real radix-ui and react
const swc = require("next/dist/build/swc/index.js");
let swcReady = null;
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const cache = new Map();
const load = async (rel) => {
  await (swcReady ??= swc.loadBindings());
  const file = join(ROOT, rel);
  if (cache.has(file)) return cache.get(file);
  const out = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const deps = new Map();
  for (const [, , id] of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
    if (deps.has(id)) continue;
    if (id.startsWith("@/components/ui/")) deps.set(id, await load(`${id.slice(2)}.js`));
    else if (id.startsWith("@/") || id.startsWith(".")) throw new Error(`${rel} imports ${id}, outside components/ui`);
    else deps.set(id, require(id));
  }
  const mod = { exports: {} };
  new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
};
await t("the components render server-side with their data-slots", async () => {
  const h = React.createElement;
  const [B, I, Sep, Sk, Tt, Sh, Dd, Av, Sb] = await Promise.all(["button", "input", "separator", "skeleton", "tooltip", "sheet", "dropdown-menu", "avatar", "sidebar"].map((n) => load(`${UI}/${n}.js`)));
  const html = renderToStaticMarkup(
    h(Tt.TooltipProvider, null,
      h(Sb.SidebarProvider, null,
        h(Sb.Sidebar, null,
          h(Sb.SidebarHeader, null, h(Sb.SidebarInput, { placeholder: "Search" })),
          h(Sb.SidebarContent, null, h(Sb.SidebarGroup, null, h(Sb.SidebarGroupLabel, null, "Store"), h(Sb.SidebarMenu, null, h(Sb.SidebarMenuItem, null, h(Sb.SidebarMenuButton, { isActive: true }, "Orders")), h(Sb.SidebarMenuItem, null, h(Sb.SidebarMenuSkeleton))))),
          h(Sb.SidebarFooter, null, h(Sep.Separator)),
        ),
        h(Sb.SidebarInset, null,
          h(Sb.SidebarTrigger),
          h(B.Button, { variant: "outline", size: "sm" }, "Publish home page"),
          h(B.Button, { variant: "destructive" }, "Archive"),
          h(I.Input, { "aria-label": "Title" }),
          h(Sep.Separator, { orientation: "vertical" }),
          h(Sk.Skeleton, { className: "h-4 w-24" }),
          h(Tt.Tooltip, null, h(Tt.TooltipTrigger, null, "Why?"), h(Tt.TooltipContent, null, "Only owners can publish")),
          h(Sh.Sheet, null, h(Sh.SheetTrigger, null, "Menu"), h(Sh.SheetContent, null, h(Sh.SheetTitle, null, "Menu"))),
          h(Dd.DropdownMenu, null, h(Dd.DropdownMenuTrigger, null, "Account"), h(Dd.DropdownMenuContent, null, h(Dd.DropdownMenuItem, null, "Sign out"))),
          h(Av.Avatar, null, h(Av.AvatarImage, { src: "/a.png", alt: "" }), h(Av.AvatarFallback, null, "ST")),
        ),
      ),
    ),
  );
  const slots = new Set([...html.matchAll(/data-slot="([\w-]+)"/g)].map((m) => m[1]));
  const want = ["sidebar-wrapper", "sidebar", "sidebar-header", "sidebar-input", "input", "sidebar-content", "sidebar-group", "sidebar-group-label", "sidebar-menu", "sidebar-menu-item", "sidebar-menu-button", "sidebar-menu-skeleton", "skeleton", "sidebar-footer", "separator", "sidebar-inset", "sidebar-trigger", "button", "tooltip-trigger", "sheet-trigger", "dropdown-menu-trigger", "avatar", "avatar-fallback"];
  eq(want.filter((s) => !slots.has(s)), [], "missing data-slots:");
  ok(/data-slot="sidebar-menu-button"[^>]*data-active="true"/.test(html) || /data-active="true"[^>]*data-slot="sidebar-menu-button"/.test(html), "the active menu button carries data-active=\"true\":");
  ok(html.includes("Publish home page") && html.includes("Orders"), "the text renders:");
  ok(/class="[^"]*rounded-md[^"]*"[^>]*data-slot="button"|data-slot="button"[^>]*class="[^"]*rounded-md/.test(html), "a button is rounded-md:");
  // portal content (sheet, menu, tooltip) mounts only in a browser; their parts carry data-slot in the source
  for (const [f, s] of [["sheet", ["sheet-content", "sheet-overlay", "sheet-title", "sheet-close"]], ["dropdown-menu", ["dropdown-menu-content", "dropdown-menu-item"]], ["tooltip", ["tooltip-content"]], ["avatar", ["avatar-image"]]]) for (const x of s) ok(read(`${UI}/${f}.js`).includes(`data-slot="${x}"`), `${f}.js has data-slot="${x}":`);
});

await t("Phase 2 line 0's card, tabs, select, switch, checkbox and popover render server-side with their data-slots and the docs/UI.md radius and focus rules", async () => {
  const h = React.createElement;
  const [C, Tb, Se, Sw, Cb, Po] = await Promise.all(["card", "tabs", "select", "switch", "checkbox", "popover"].map((n) => load(`${UI}/${n}.js`)));
  const html = renderToStaticMarkup(
    h("div", null,
      h(C.Card, null, h(C.CardHeader, null, h(C.CardTitle, null, "Sales"), h(C.CardDescription, null, "Last 7 days"), h(C.CardAction, null, "…")), h(C.CardContent, null, "₹1,499"), h(C.CardFooter, null, "Updated now")),
      h(Tb.Tabs, { defaultValue: "a" }, h(Tb.TabsList, null, h(Tb.TabsTrigger, { value: "a" }, "All"), h(Tb.TabsTrigger, { value: "b" }, "Open")), h(Tb.TabsContent, { value: "a" }, "All orders")),
      h(Se.Select, { defaultValue: "x" }, h(Se.SelectTrigger, { "aria-label": "Status" }, h(Se.SelectValue, { placeholder: "Any status" })), h(Se.SelectContent, null, h(Se.SelectItem, { value: "x" }, "Paid"))),
      h(Sw.Switch, { "aria-label": "Enabled", defaultChecked: true }),
      h(Cb.Checkbox, { "aria-label": "Select row", defaultChecked: true }),
      h(Po.Popover, null, h(Po.PopoverTrigger, null, "Filters"), h(Po.PopoverContent, null, "x")),
    ),
  );
  const slots = new Set([...html.matchAll(/data-slot="([\w-]+)"/g)].map((m) => m[1]));
  const want = ["card", "card-header", "card-title", "card-description", "card-action", "card-content", "card-footer", "tabs", "tabs-list", "tabs-trigger", "tabs-content", "select-trigger", "select-value", "switch", "switch-thumb", "checkbox", "checkbox-indicator", "popover-trigger"];
  eq(want.filter((x) => !slots.has(x)), [], "missing data-slots:");
  ok(/data-slot="tabs-trigger"[^>]*data-state="active"|data-state="active"[^>]*data-slot="tabs-trigger"/.test(html) && /<button [^>]*data-state="checked"[^>]*data-slot="switch"|data-slot="switch"[^>]*data-state="checked"/.test(html), "Radix sets data-state (the variants we use):");
  ok(/data-slot="card"[^>]*class="[^"]*\brounded-card\b[^"]*\bshadow-card\b|class="[^"]*\brounded-card\b[^"]*\bshadow-card\b[^"]*"[^>]*data-slot="card"/.test(html), "a card is rounded-card with shadow-card:");
  for (const f of ["select", "switch", "checkbox", "tabs"]) ok(read(`${UI}/${f}.js`).includes("focus-visible:ring-ring focus-visible:ring-offset-2"), `${f} has the accent focus ring:`);
  for (const f of ["select", "checkbox", "tabs"]) ok(/\brounded-md\b/.test(read(`${UI}/${f}.js`)), `${f}'s control is rounded-md:`);
  for (const f of ["select", "popover"]) ok(/rounded-card/.test(read(`${UI}/${f}.js`)) && /shadow-overlay/.test(read(`${UI}/${f}.js`)) && read(`${UI}/${f}.js`).includes("motion-reduce:animate-none"), `${f}'s overlay: rounded-card, shadow-overlay, motion-reduce:`);
  for (const [f, s] of [["select", ["select-content", "select-item", "select-label", "select-separator"]], ["popover", ["popover-content", "popover-title", "popover-description"]]]) for (const x of s) ok(read(`${UI}/${f}.js`).includes(`data-slot="${x}"`), `${f}.js has data-slot="${x}":`);
});

// ---------- 10. line 8: old screens keep the old tokens inside [data-legacy] ----------

await t("line 8: .console [data-legacy] gets the old block, globals.css's :root --background/--foreground, the body's line height and colour, and the old border default", async () => {
  const shared = ruleBody(consoleCss, "[data-console], .console [data-legacy]");
  ok(shared, "the old block's selector is [data-console], .console [data-legacy]:");
  const old = declsOf(shared);
  for (const k of ["--c-surface", "--c-border", "--c-accent", "--c-success", "--c-warning", "--c-danger", "--c-info", "--primary", "--ring"]) ok(old[k], `the old block sets ${k}:`);
  ok(/font-size:\s*1rem/.test(shared), "and font-size 1rem (the shell root is text-sm):");
  const restore = ruleBody(consoleCss, ".console [data-legacy]");
  const root = declsOf(ruleBody(read("app/globals.css"), ":root"));
  const r = declsOf(restore);
  eq([r["--background"], r["--foreground"]], [root["--background"], root["--foreground"]], "--background/--foreground equal globals.css :root:");
  ok(/line-height:\s*1\.5/.test(restore) && /(^|;)\s*color:\s*var\(--foreground\)/.test(restore), "line-height 1.5 and color var(--foreground) (globals.css body):");
  const base = blocks(stripComments(consoleCss)).find((b) => b.prelude === "@layer base")?.body || "";
  const rules = blocks(base).map((b) => ({ sel: b.prelude.replace(/\s+/g, " "), body: b.body }));
  const border = rules.find((x) => /border-color:\s*var\(--border\)/.test(x.body));
  eq(border?.sel, ".console *, .console ::before, .console ::after", "the border default is for descendants of .console only:");
  const legacyBorder = rules.find((x) => /border-color:\s*currentcolor/.test(x.body));
  eq(legacyBorder?.sel, ".console [data-legacy], .console [data-legacy] *, .console [data-legacy] ::before, .console [data-legacy] ::after", "inside an old region, borders keep currentcolor:");
  ok(!/:is\([^)]*::/.test(stripComments(consoleCss)), "no pseudo-element inside :is() (that drops the whole rule):");
  ok(/<body className="console /.test(read("app/(console)/layout.js")), "the console <body> carries .console:");
});

// ---------- 9. sidebar shortcut and cookie ----------

await t("Cmd/Ctrl+B toggles the sidebar except while typing; the sidebar cookie is path-scoped and SameSite=Lax", async () => {
  const { isSidebarShortcut, sidebarCookie } = await load(`${UI}/sidebar.js`);
  const el = (tagName, extra = {}) => ({ tagName, isContentEditable: false, closest: () => null, ...extra });
  const key = (target, mods = { metaKey: true }) => ({ key: "b", ctrlKey: false, metaKey: false, ...mods, target });
  eq(isSidebarShortcut(key(el("BUTTON"))), true, "Cmd+B on a button:");
  eq(isSidebarShortcut(key(el("DIV"), { ctrlKey: true })), true, "Ctrl+B on a div:");
  eq(isSidebarShortcut(key(null)), true, "Cmd+B with no target:");
  eq(isSidebarShortcut({ key: "b", metaKey: false, ctrlKey: false, target: el("DIV") }), false, "plain b:");
  eq(isSidebarShortcut(key(el("DIV"), { metaKey: true, key: "c" })), false, "Cmd+C:");
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) eq(isSidebarShortcut(key(el(tag))), false, `Cmd+B in ${tag}:`);
  eq(isSidebarShortcut(key(el("DIV", { isContentEditable: true }))), false, "Cmd+B in a contenteditable (rich text bold):");
  eq(isSidebarShortcut(key(el("STRONG", { closest: (q) => (q.includes("contenteditable") ? {} : null) }))), false, "Cmd+B inside a contenteditable's child:");
  eq(sidebarCookie(true), "sidebar_state=true; path=/admin; max-age=604800; SameSite=Lax", "default cookie:");
  eq(sidebarCookie(false, "/platform"), "sidebar_state=false; path=/platform; max-age=604800; SameSite=Lax", "platform cookie:");
  const src = read(`${UI}/sidebar.js`);
  ok(/document\.cookie = sidebarCookie\(openState, cookiePath\)/.test(src) && !/path=\/;/.test(src), "the provider writes only the scoped cookie:");
  ok(/if \(isSidebarShortcut\(event\)\)/.test(src), "the keydown handler uses isSidebarShortcut:");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
