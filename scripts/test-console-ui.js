// shadcn/ui for the consoles only; the storefront is unchanged (Phase 0 line 7).
//   pnpm test:console-ui
// No browser, no network. This suite proves:
//   1. nothing reachable from app/(storefront)/** (or proxy.js / middleware.js /
//      instrumentation.js) resolves into components/ui/, radix-ui,
//      class-variance-authority or tailwind-merge
//   2. every app/console.css rule outside @theme, @utility, @property,
//      @custom-variant and @keyframes is scoped to [data-console] or .console
//      (no :root, *, html or body); tw-animate-css itself adds only @property,
//      @theme, @utility and keyframes
//   3. the console theme adds no default Tailwind key and no globals.css key;
//      --color-primary and --color-ring are the only two re-pointed names
//   4. no storefront file uses the new utility names, dark: or class "console"
//   5. .console / .console.dark hold exactly docs/UI.md's colour table
//   6. components/ui has no hex, oklch(, rgb( or palette utilities, and uses
//      the docs/UI.md radius, shadow and weight rules
//   7. cn merges rounded-ctl/rounded-card and shadow-card/shadow-overlay
//   8. the components render server-side (Next's SWC, real radix-ui) with their
//      data-slots; the sheet keeps Esc and the overlays motion-reduce
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
const UI_FILES = ["avatar", "button", "dropdown-menu", "input", "separator", "sheet", "sidebar", "skeleton", "tooltip", "use-mobile", "utils"].map((n) => `${UI}/${n}.js`);
const BANNED_PACKAGES = ["radix-ui", "class-variance-authority", "tailwind-merge"];
const CONSOLE_DIRS = ["components/admin/", "components/console/", "components/platform/", "components/ui/"];

const walkFiles = (rel, out = []) => {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) return (out.push(rel), out);
  for (const f of readdirSync(abs)) walkFiles(join(rel, f), out);
  return out;
};
const code = (f) => /\.(m?js|jsx)$/.test(f);

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
const ruleBody = (css, selector) => blocks(stripComments(css)).find((b) => b.prelude === selector)?.body ?? null;

const consoleCss = read("app/console.css");

// ---------- 1. the storefront never reaches the console components ----------

await t("nothing reachable from the storefront resolves into components/ui/, radix-ui, class-variance-authority or tailwind-merge", async () => {
  const entries = [...walkFiles("app/(storefront)").filter(code), ...["proxy.js", "middleware.js", "instrumentation.js"].filter((f) => existsSync(join(ROOT, f)))];
  ok(entries.length > 20, `found ${entries.length} storefront entry files:`);
  const seen = new Set();
  const bad = [];
  const resolveLocal = (from, id) => {
    const base = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(join(ROOT, from)), id);
    for (const c of [base, `${base}.js`, `${base}.mjs`, `${base}.jsx`, join(base, "index.js")]) if (existsSync(c) && statSync(c).isFile()) return relative(ROOT, c);
    return null;
  };
  const visit = (rel, chain) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    if (rel.startsWith(`${UI}/`)) return bad.push(`${chain.join(" → ")} → ${rel}`);
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
});

// ---------- 2. console.css is scoped ----------

await t("every console.css rule outside @theme/@utility/@property/@custom-variant/@keyframes is scoped to [data-console] or .console", async () => {
  const rules = styleRules(consoleCss);
  ok(rules.length >= 5, `found ${rules.length} rules:`);
  const unscoped = rules.flatMap((r) => r.split(",").map((s) => s.trim())).filter((s) => !/^(\[data-console\]|\.console)(?![\w-])/.test(s));
  eq(unscoped, [], "unscoped selectors:");
  for (const s of rules.join(",").split(",")) ok(!/(^|[\s>+~,])(:root|html|body|\*)(?![\w-])/.test(s.replace(/^(\[data-console\]|\.console(\.dark)?)/, "").replace(/\.console \*/, "")), `no :root/html/body/* outside the scope in "${s.trim()}":`);
  ok(/^\s*@import\s+"tw-animate-css";/m.test(stripComments(consoleCss)) && stripComments(consoleCss).trim().startsWith('@import "tw-animate-css"'), "@import \"tw-animate-css\" comes first:");
  // the bite: an unscoped rule is caught
  eq(styleRules(":root{--x:1} .console a{color:red} @media (x){body{margin:0}}"), [":root", ".console a", "body"], "parser sees nested rules:");
});

await t("tw-animate-css adds only @property, @theme, @utility and keyframes (no selector reaches a storefront element)", async () => {
  const css = read("node_modules/tw-animate-css/dist/tw-animate.css");
  const kinds = new Set(blocks(stripComments(css)).map((b) => (b.prelude.match(/^@[\w-]+/) || [b.prelude])[0]));
  eq([...kinds].sort(), ["@property", "@theme", "@utility"], "top-level kinds:");
});

// ---------- 3. the theme ----------

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
  const theme = Object.assign({}, ...blocks(stripComments(consoleCss)).filter((b) => /^@theme\b/.test(b.prelude)).map((b) => declsOf(b.body)));
  eq(theme["--color-primary"], "var(--primary)", "--color-primary:");
  eq(theme["--color-ring"], "var(--ring)", "--color-ring:");
  const legacy = declsOf(ruleBody(consoleCss, "[data-console]"));
  eq([legacy["--primary"], legacy["--ring"]], ["var(--c-primary)", "var(--c-ring)"], "[data-console] keeps the legacy primary and ring:");
  ok(/^@custom-variant dark \(&:where\(\.console\.dark, \.console\.dark \*\)\);$/m.test(consoleCss), "dark: matches only inside .console.dark:");
});

// ---------- 4. the storefront doesn't use the new names ----------

await t("no storefront file uses the new utility names, dark: or class \"console\"", async () => {
  const files = [...walkFiles("app").filter((f) => !f.startsWith("app/(console)/") && !f.startsWith("app/api/") && (code(f) || f.endsWith(".css")) && f !== "app/console.css"), ...walkFiles("components").filter((f) => code(f) && !CONSOLE_DIRS.some((d) => f.startsWith(d)))];
  ok(files.length > 50, `scanned ${files.length} files:`);
  const prefixes = "bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|divide|from|via|to|shadow|accent|caret|decoration|placeholder";
  const names = [...NEW_KEYS].sort((a, b) => b.length - a.length).join("|");
  const utility = new RegExp(`(?<![\\w-])(?:[\\w-]+:)*-?(?:${prefixes})-(?:${names})(?:\\/\\d+)?(?![\\w-])`);
  const anim = /(?<![\w-])(?:animate-in|animate-out|fade-(?:in|out)(?:-\d+)?|zoom-(?:in|out)(?:-\d+)?|slide-(?:in-from|out-to)-[a-z]+(?:-\d+)?)(?![\w-])/;
  const hits = [];
  for (const f of files) {
    const src = read(f);
    for (const [re, what] of [
      [utility, "a new utility"],
      [anim, "a tw-animate utility"],
      [/(?<![\w-])dark:/, "dark:"],
      [/class(?:Name)?=\{?["'`][^"'`]*(?<![\w-])console(?![\w-])/, 'class "console"'],
      [/(?<![\w-])radius-ctl|rounded-card|shadow-card|shadow-overlay(?![\w-])/, "a console radius/shadow"],
    ]) {
      const m = re.exec(src);
      if (m) hits.push(`${f}: ${what} (${m[0]})`);
    }
  }
  eq(hits, [], "storefront uses:");
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

await t("the components render server-side with their data-slots", async () => {
  const swc = require("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const cache = new Map();
  const load = async (rel) => {
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
