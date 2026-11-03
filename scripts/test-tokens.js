// Design tokens (TOK-01, TOK-02; spec 7.6 and the test-tokens row of 8.15).
//   pnpm test:tokens
//
// 1. The lint: storefront components may not hard-code a colour, a radius
//    step or a pixel font size. They use the semantic roles (bg-sf-surface,
//    text-sf-text-muted, rounded-sf-card, …). A short written allowlist names
//    each exception and why; an entry that no longer matches anything fails,
//    so the list can only shrink.
// 2. The role table: every role in lib/brand.js has its CSS variable and its
//    Tailwind colour in app/globals.css, the defaults are exactly the Tailwind
//    values the classes had, and the kit surfaces match the [data-kit] CSS.
// 3. The default look is unchanged: no brand (and a brand with the platform's
//    own colours) emits no role override at all.
// 4. A brand with its own colours derives every role from them, readable.
// 5. Pair coverage: every role a component uses as a text colour, or as a
//    background under text, is in the pairing matrix (PAIRS).
// Plain node, no database, no browser. The pixel comparison and the
// measured contrast are browser drills (scripts/drills/p1/tok.mjs).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const B = await import("../lib/brand.js");
const { comparePixels } = await import("./pixel-diff.js");
const { drawnPairs, classRole } = await import("./token-pairs.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------------------
// 1. the lint
// ---------------------------------------------------------------------------

// Storefront code: the (storefront) route group and the components it renders.
// The consoles (admin, console, platform, partners) and Storeasy's own
// marketing components (components/site) are not storefront.
export const SCOPE_DIRS = ["app/(storefront)", "components/cart", "components/checkout", "components/sections", "components/pdp", "components/account", "components/analytics", "components/preview"];
const TOP_LEVEL_COMPONENTS = "components"; // its *.js files, not its folders

// The allowlist. Short, each with a reason. A path is a file or a folder prefix.
export const ALLOWLIST = [
  {
    path: "app/(storefront)/layout.js",
    reason:
      "Holds the maintenance curtain (and the Draft preview bar and the Storeasy marketing-site shell). The maintenance branch claude/musing-williamson-4c86b3 rewrites this markup; it is left to that merge so the two don't conflict.",
  },
  {
    path: "app/(storefront)/not-found.js",
    reason: "Rewritten by the maintenance branch claude/musing-williamson-4c86b3; left to that merge.",
  },
  {
    path: ["app/(storefront)/pricing/", "app/(storefront)/templates/", "app/(storefront)/trust/", "app/(storefront)/integrations/", "app/(storefront)/customers/", "app/(storefront)/verticals/", "app/(storefront)/legal/"],
    reason: "Storeasy's own marketing pages. They answer 404 on every store's host (isPlatformSiteHost) and wear Storeasy's look, not a store's brand.",
  },
  {
    path: "components/preview/ExperimentNote.js",
    reason:
      "PV-08's purple preview note on a section a running test changes. It is preview chrome, matching the Draft preview bar, not the store's brand, and it renders only in a founder's preview, never for a shopper.",
  },
];
const allowed = (rel) => ALLOWLIST.find((a) => [].concat(a.path).some((p) => rel === p || (p.endsWith("/") && rel.startsWith(p))));

const PALETTES = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white";
const COLOUR_PROPS = "bg|text|border|border-[trblxy]|ring|ring-offset|divide|outline|fill|stroke|from|via|to|decoration|placeholder|caret|accent|shadow";
// One class (variants such as hover: stripped) → the rule it breaks, or null.
export const RULES = [
  { id: "palette colour", re: new RegExp(`^(?:${COLOUR_PROPS})-(?:${PALETTES})(?:-\\d{2,3})?(?:\\/(?:\\d+|\\[[^\\]]+\\]))?$`) },
  { id: "accent ladder step (use an accent role)", re: /^(?:bg|text|border|ring|divide|outline|fill|stroke|from|via|to|decoration)-accent-(?:\d{2,3}|label)(?:\/(?:\d+|\[[^\]]+\]))?$/ },
  { id: "arbitrary colour value", re: /^[a-z-]+-\[[^\]]*(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|color-mix)/ },
  { id: "pixel font size (use text-sf-2xs / text-sf-3xs or a Tailwind size)", re: /^text-\[\d+(?:\.\d+)?px\]$/ },
  { id: "radius step (use rounded-sf-card / -control / -small / -xs / -2xs, rounded-sf-button or rounded-full)", re: /^rounded(?:-[trblse]{1,2})?(?:-(?:xs|sm|md|lg|xl|2xl|3xl))?$/ },
  { id: "arbitrary radius", re: /^rounded(?:-[trblse]{1,2})?-\[/ },
];

// Every string literal in a JS source (", ', ` and the text parts of template
// literals). Comments are skipped; JSX text is not a string literal, so copy
// such as "rounded corners" never trips the lint.
export function stringLiterals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const tplStack = [];
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i = src.indexOf("*/", i + 2);
      i = i < 0 ? n : i + 2;
      continue;
    }
    if (c === "}" && tplStack.length && tplStack[tplStack.length - 1] === 0) {
      tplStack.pop();
      i++;
      // back inside a template literal
      let s = "";
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") {
          s += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          tplStack.push(0);
          i += 2;
          break;
        }
        s += src[i++];
      }
      out.push(s);
      if (src[i] === "`") i++;
      continue;
    }
    if (c === "{" && tplStack.length) tplStack[tplStack.length - 1]++;
    if (c === "}" && tplStack.length) tplStack[tplStack.length - 1]--;
    if (c === '"' || c === "'") {
      let s = "";
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          s += src[i + 1];
          i += 2;
          continue;
        }
        s += src[i++];
      }
      out.push(s);
      i++;
      continue;
    }
    if (c === "`") {
      let s = "";
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") {
          s += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          tplStack.push(0);
          i += 2;
          break;
        }
        s += src[i++];
      }
      out.push(s);
      if (src[i] === "`") i++;
      continue;
    }
    i++;
  }
  return out;
}

// Problems in one source: [{ cls, rule }].
export function lintSource(src) {
  const found = [];
  for (const lit of stringLiterals(src)) {
    for (const raw of lit.split(/\s+/)) {
      if (!raw) continue;
      // Tailwind v4 also takes `!` at the end (text-zinc-900!)
      const cls = raw.replace(/^!/, "").split(":").pop().replace(/^!/, "").replace(/!$/, "");
      const rule = RULES.find((r) => r.re.test(cls));
      if (rule) found.push({ cls: raw, rule: rule.id });
    }
  }
  // inline style colours: style={{ color: "#…" }} and friends. A colour handed
  // to a third party (Razorpay's own window theme in CheckoutFlow) is not
  // page style and is not matched.
  for (const m of src.matchAll(/style=\{\{[^}]*?\b(color|background|backgroundColor|borderColor)\s*:\s*["'`](#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/g)) found.push({ cls: m[0].slice(m[0].indexOf(m[1])), rule: "inline style colour" });
  // SVG paint attributes: fill="#…", stroke={"#…"}, stopColor="#…"
  for (const m of src.matchAll(/\b(fill|stroke|stopColor|floodColor|lightingColor)=\{?\s*["'`](#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/g)) found.push({ cls: m[0], rule: "SVG paint colour" });
  return found;
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx|mjs)$/.test(p)) out.push(p);
  }
  return out;
}
export function storefrontFiles(root = ROOT) {
  const files = SCOPE_DIRS.flatMap((d) => walk(join(root, d)));
  for (const f of readdirSync(join(root, TOP_LEVEL_COMPONENTS))) if (f.endsWith(".js")) files.push(join(root, TOP_LEVEL_COMPONENTS, f));
  return files.map((f) => relative(root, f)).sort();
}

console.log("— the lint: no hard-coded colours, radii or pixel sizes in storefront code");

await t("the lint catches each kind of hard-coded value, with variants and opacity", () => {
  const src = `
    const a = "text-zinc-500 hover:bg-white/95 md:border-red-200";
    const b = \`px-2 \${on ? "group-hover:text-accent-700" : "bg-accent-400"} text-accent-label\`;
    const c = "bg-[#ff0000] text-[rgb(1,2,3)] shadow-[0_1px_2px_rgba(0,0,0,0.1)]";
    const d = "text-[11px] rounded-2xl rounded-t-xl rounded rounded-[9px]";
    const e = <div style={{ color: "#123456" }} />;
    const f = "text-zinc-900! bg-zinc-900/[0.5] hover:text-accent-700/[.8]";
    const g = <svg><path fill="#ff0000" stroke={"#00ff00"} /><path fill="currentColor" stroke="none" /></svg>;`;
  const hits = lintSource(src).map((h) => h.cls);
  ok(lintSource(src).filter((h) => h.rule === "SVG paint colour").length === 2, `SVG paint: ${JSON.stringify(lintSource(src).filter((h) => h.rule === "SVG paint colour"))}`);
  for (const want of ["text-zinc-900!", "bg-zinc-900/[0.5]", "hover:text-accent-700/[.8]", "text-zinc-500", "hover:bg-white/95", "md:border-red-200", "group-hover:text-accent-700", "bg-accent-400", "text-accent-label", "bg-[#ff0000]", "text-[rgb(1,2,3)]", "shadow-[0_1px_2px_rgba(0,0,0,0.1)]", "text-[11px]", "rounded-2xl", "rounded-t-xl", "rounded", "rounded-[9px]"]) {
    ok(hits.includes(want), `missed ${want}; caught ${JSON.stringify(hits)}`);
  }
  ok(lintSource(src).some((h) => h.rule === "inline style colour"), "missed the inline style colour");
});

await t("NEGATIVE: role classes, rounded-full, comments and visible copy are not flagged", () => {
  const src = `
    // text-zinc-500 in a comment, rounded-2xl too
    /* bg-white */
    const a = "bg-sf-surface text-sf-text-muted border-sf-border rounded-sf-card rounded-full rounded-brand rounded-sf-button text-sf-2xs hover:bg-sf-accent-hover";
    const b = <p className="text-hero-fg bg-header">Rounded corners on white paper</p>;
    const c = "text-sm text-lg text-xs text-center text-balance text-header-muted bg-hero bg-gradient-to-br";`;
  eq(JSON.stringify(lintSource(src)), "[]");
});

await t("THE LINT: no storefront component hard-codes a colour, radius or pixel size (outside the allowlist)", () => {
  const problems = [];
  for (const rel of storefrontFiles()) {
    if (allowed(rel)) continue;
    for (const h of lintSource(readFileSync(join(ROOT, rel), "utf8"))) problems.push(`${rel}: ${h.cls} (${h.rule})`);
  }
  ok(!problems.length, `${problems.length} hard-coded value(s):\n      ${problems.slice(0, 40).join("\n      ")}`);
});

await t("the allowlist is short, every entry has a reason, and every entry is still needed", () => {
  ok(ALLOWLIST.length <= 5, `the allowlist has ${ALLOWLIST.length} entries; keep it short`);
  for (const a of ALLOWLIST) {
    ok(typeof a.reason === "string" && a.reason.length > 30, `entry ${JSON.stringify(a.path)} needs a written reason`);
    const files = storefrontFiles().filter((rel) => [].concat(a.path).some((p) => rel === p || (p.endsWith("/") && rel.startsWith(p))));
    ok(files.length > 0, `entry ${JSON.stringify(a.path)} matches no file: remove it`);
    ok(
      files.some((rel) => lintSource(readFileSync(join(ROOT, rel), "utf8")).length > 0),
      `entry ${JSON.stringify(a.path)} no longer hides anything: remove it`,
    );
  }
});

await t("preview chrome on the allowlist is one file that renders only with a preview notice; the rest of components/preview is still linted", () => {
  const entry = ALLOWLIST.find((a) => [].concat(a.path).includes("components/preview/ExperimentNote.js"));
  ok(entry, "the preview note has no allowlist entry");
  ok([].concat(entry.path).every((p) => p === "components/preview/ExperimentNote.js"), "the preview note's entry must name that one file, not a folder");
  const src = readFileSync(join(ROOT, "components/preview/ExperimentNote.js"), "utf8");
  ok(/if \(!notice\) return null;/.test(src), "ExperimentNote must render nothing without a notice (shoppers never get one)");
  const files = storefrontFiles();
  ok(files.includes("components/preview/PreviewBridge.js") && !allowed("components/preview/PreviewBridge.js"), "the rest of components/preview must stay in the lint");
});

await t("the lint scans the storefront files that matter (cart, checkout, product card, footer, home)", () => {
  const files = storefrontFiles();
  for (const f of ["components/cart/CartDrawer.js", "components/checkout/CheckoutFlow.js", "components/ProductCard.js", "components/Footer.js", "app/(storefront)/page.js", "components/sections/HomeSections.js", "components/Header.js"]) {
    ok(files.includes(f), `${f} is not scanned`);
  }
  ok(!files.some((f) => f.startsWith("components/admin/") || f.startsWith("components/console/")), "a console file is in the storefront scope");
});

await t("rich text styles use roles: no fixed colour or radius left in the .rte block (links were lime on every store)", () => {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
  const rte = [...css.matchAll(/\.rte[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join("\n");
  ok(!/#[0-9a-fA-F]{3,8}\b|rgb\(|oklch\(/.test(rte), `.rte still has a fixed colour:\n${rte}`);
  ok(/\.rte a\s*\{[^}]*color:\s*var\(--sf-accent-text\)/.test(css), ".rte a must use var(--sf-accent-text)");
  ok(/\.rte img\s*\{[^}]*border-radius:\s*var\(--sf-radius-small\)/.test(css), ".rte img must use the small radius role");
});

// ---------------------------------------------------------------------------
// 2. the role table
// ---------------------------------------------------------------------------
console.log("— the role table");

const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const themeBlock = css.slice(css.indexOf("@theme inline {"), css.indexOf("}", css.indexOf("@theme inline {")));
const decl = (block, name) => {
  const m = new RegExp(`${name.replace(/[-]/g, "\\-")}:\\s*([^;]+);`).exec(block);
  return m ? m[1].trim() : null;
};

await t("the spec's roles exist: surface, muted surface, text, muted text, border, accent, text on accent, sale, success, danger, header, hero", () => {
  for (const id of ["surface", "surface-muted", "text", "text-muted", "border", "accent", "on-accent", "sale", "success", "danger", "header-accent", "hero-accent", "header", "hero"]) ok(B.ROLE_IDS.includes(id), `no ${id} role`);
});

await t("every role has its CSS variable in globals.css :root with the table's default, and a Tailwind colour", () => {
  for (const r of B.ROLES) {
    if (r.from.startsWith("kit:") || r.from === "brandfg") continue; // the kit's --header-*/--hero-*, and --foreground
    if (r.css === null) {
      // placeholder: unset by default, so Tailwind's own placeholder colour applies (see ::placeholder in globals.css)
      eq(decl(rootBlock, `--sf-${r.id}`), null, `--sf-${r.id} must not be set by default:`);
      ok(css.includes(`var(--sf-${r.id}, color-mix(in oklab, currentcolor 50%, transparent))`), "the ::placeholder rule must fall back to Tailwind's default");
      continue;
    }
    eq(decl(rootBlock, `--sf-${r.id}`), r.css, `--sf-${r.id}:`);
    eq(decl(themeBlock, `--color-sf-${r.id}`), `var(--sf-${r.id})`, `--color-sf-${r.id}:`);
  }
  for (const [k, v] of Object.entries(B.RADIUS_ROLES)) {
    eq(decl(rootBlock, `--sf-radius-${k}`), v.css, `--sf-radius-${k}:`);
    eq(decl(themeBlock, `--radius-sf-${k}`), `var(--sf-radius-${k})`, `--radius-sf-${k}:`);
  }
});

await t("the default palette values are Tailwind's own (tailwindcss/theme.css), so a role renders exactly as its class did", () => {
  const tw = readFileSync(join(ROOT, "node_modules/tailwindcss/theme.css"), "utf8");
  for (const [name, v] of Object.entries(B.PALETTE)) eq(decl(tw, `--color-${name}`), v.css, `--color-${name}:`);
  // and each hex is that oklch in sRGB (±1 per channel)
  const toRgb = (s) => {
    const m = /oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)/.exec(s);
    if (!m) return null;
    const [L, C, h] = [Number(m[1]) / 100, Number(m[2]), Number(m[3])];
    const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s2 = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s2, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s2, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s2];
    return lin.map((x) => Math.round(Math.max(0, Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)) * 255));
  };
  for (const [name, v] of Object.entries(B.PALETTE)) {
    const want = toRgb(v.css);
    if (!want) continue;
    const got = B.hexToRgb(v.hex);
    ok(got.every((c, i) => Math.abs(c - want[i]) <= 1), `${name}: ${v.hex} is not ${v.css} (${want})`);
  }
});

await t("the kit surfaces in lib/brand.js match the [data-kit] blocks and :root defaults in globals.css", () => {
  const block = (sel) => css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
  const pulse = B.KIT_SURFACES["pulse-1"];
  for (const [part, key, v] of [["header", "bg", "--header-bg"], ["header", "fg", "--header-fg"], ["header", "muted", "--header-muted"], ["hero", "bg", "--hero-bg"], ["hero", "fg", "--hero-fg"], ["hero", "muted", "--hero-muted"]]) {
    eq(decl(rootBlock, v), pulse[part][key], `pulse-1 ${v}:`);
    eq(decl(block('[data-kit="glow-1"]'), v), B.KIT_SURFACES["glow-1"][part][key], `glow-1 ${v}:`);
  }
  const kitsInCss = [...css.matchAll(/\[data-kit="([a-z]+-\d+)"\]/g)].map((m) => m[1]);
  for (const k of kitsInCss) ok(B.KIT_SURFACES[k], `kit ${k} has CSS but no KIT_SURFACES entry`);
});

await t("the default accent ladder in lib/brand.js is the one globals.css carries", () => {
  for (const [step, hex] of Object.entries(B.DEFAULT_ACCENT_LADDER)) eq(decl(rootBlock, `--accent-${step}`), hex, `--accent-${step}:`);
});

// ---------------------------------------------------------------------------
// 3. the default look is unchanged
// ---------------------------------------------------------------------------
console.log("— the default look is unchanged");

await t("no brand config: every role is today's value, nothing corrected", () => {
  const { roles, derived, corrections } = B.brandRoles(null);
  eq(derived, false);
  eq(corrections.length, 0);
  for (const r of B.ROLES) if (r.hex && !/^(bg|kit)/.test(r.from)) eq(roles[r.id], r.hex, `${r.id}:`);
  eq(roles["accent-text"], B.DEFAULT_ACCENT_LADDER[700], "accent-text (and so .rte links) on the default look:");
});

await t("a brand with the platform's own colours (the Pulse kit's brand) keeps today's greys; only accent roles that read badly move", () => {
  const lines = B.roleCssLines(B.resolveBrand({ accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b" }), "pulse-1");
  for (const l of lines) ok(/^--sf-accent-(text|strong|mark):/.test(l), `unexpected ${l}`);
  const css = B.brandCssVars(B.resolveBrand({ accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b", radius: "xl" }));
  ok(!/--sf-(surface|text|border|inverse|success|warning|danger)/.test(css), `neutral or status role written: ${css}`);
  ok(css.includes("--brand-radius:1.5rem"), "the radius still applies");
});

await t("an accent-only brand rewrites only accent roles that had to move, never the neutral greys", () => {
  for (const accent of ["#0ea5e9", "#000000", "#fde047", "#e11d48"]) {
    const lines = B.roleCssLines(B.resolveBrand({ accent }), "pulse-1");
    for (const l of lines) ok(/^--sf-(accent|on-accent|header-accent|hero-accent)/.test(l), `${accent}: ${l} written`);
  }
});

await t("radius roles are multiples of the brand radius that give today's Tailwind steps at the default md", () => {
  const rem = (expr) => Function(`"use strict"; return (${expr.replace(/var\(--brand-radius\)/g, "0.75").replace(/calc/g, "")})`)();
  eq(rem(B.RADIUS_ROLES.card.css), 1, "card (rounded-2xl 1rem):");
  eq(rem(B.RADIUS_ROLES.control.css), 0.75, "control (rounded-xl):");
  eq(rem(B.RADIUS_ROLES.small.css), 0.5, "small (rounded-lg):");
  eq(rem(B.RADIUS_ROLES.xs.css), 0.375, "xs (rounded-md):");
  eq(rem(B.RADIUS_ROLES["2xs"].css), 0.25, "2xs (rounded):");
});

// ---------------------------------------------------------------------------
// 4. a brand with its own colours
// ---------------------------------------------------------------------------
console.log("— a brand's own colours reach every role");

const LIGHT = { accent: "#c2410c", background: "#fffdf8", foreground: "#1c1917" };
const DARK = { accent: "#2dd4bf", background: "#0b0f17", foreground: "#f1f5f9" };

await t("a dark brand makes product titles light: the title role is the brand's text colour (was zinc-900 everywhere)", () => {
  const { roles } = B.brandRoles({ accent: "#0d9488", background: "#0a0a0b", foreground: "#fafafa" });
  eq(roles.text, "#fafafa");
  ok(B.contrastRatio(roles.text, roles.surface) >= 4.5, `titles ${B.contrastRatio(roles.text, roles.surface)}`);
  // before TOK-01 the product card's title was text-zinc-900 whatever the brand
  ok(B.contrastRatio("#18181b", "#0a0a0b") < 1.2, "the old hard-coded title would be 1.12:1");
});

await t("derived text roles keep today's order (strong to faint) and each passes on every surface it sits on", () => {
  for (const [name, brand] of Object.entries({ LIGHT, DARK, seeded: { accent: "#0d9488", background: "#fffdf8", foreground: "#1c1917" } })) {
    const { roles } = B.brandRoles(brand);
    const order = ["text", "text-soft", "text-body", "text-muted", "text-subtle", "text-faint"].map((id) => B.contrastRatio(roles[id], roles.surface));
    for (let i = 1; i < order.length; i++) ok(order[i] <= order[i - 1] + 1e-9, `${name}: ${order.map((x) => x.toFixed(2))}`);
    const m = B.pairMatrix(brand);
    const bad = m.filter((p) => p.enforced && !p.pass).map((p) => `${p.id} ${p.ratio}`);
    ok(!bad.length, `${name}: ${bad.join(", ")}`);
  }
});

await t("brandCssVars writes every derived role for a brand with its own colours, and nothing for kit or photo roles", () => {
  const out = B.brandCssVars(B.resolveBrand(DARK), { kit: "pulse-1" });
  for (const id of ["surface-muted", "text", "text-faint", "border", "inverse", "on-inverse", "success", "danger"]) ok(out.includes(`--sf-${id}:`), `--sf-${id} missing`);
  for (const id of ["header", "hero", "overlay", "on-overlay", "media", "sale"]) ok(!out.includes(`--sf-${id}:`), `--sf-${id} must not be written`);
  ok(!out.includes("--sf-surface:"), "surface follows --background, it is not written");
});

await t("roles are derived from the kit too: the same brand on Glow corrects the accent for Glow's light header", () => {
  const brand = { accent: "#84cc16", background: "#fffdf8", foreground: "#1c1917" };
  const pulse = B.brandRoles(brand, "pulse-1").roles["header-accent"];
  const glow = B.brandRoles(brand, "glow-1").roles["header-accent"];
  ok(pulse !== glow, "the header accent should differ between kits");
  ok(B.contrastRatio(glow, B.KIT_SURFACES["glow-1"].header.bg) >= 3, `glow header accent ${glow}`);
});

// ---------------------------------------------------------------------------
// 5. pair coverage
// ---------------------------------------------------------------------------
console.log("— every role pair a renderer draws is in the matrix");

const KIT_CLASS_ROLES = { "header-fg": "header-fg", "header-muted": "header-muted", "hero-fg": "hero-fg", "hero-muted": "hero-muted", header: "header", hero: "hero" };
function rolesUsed() {
  const text = new Map();
  const bg = new Map();
  for (const rel of storefrontFiles()) {
    if (allowed(rel)) continue;
    for (const lit of stringLiterals(readFileSync(join(ROOT, rel), "utf8"))) {
      for (const raw of lit.split(/\s+/)) {
        const cls = raw.split(":").pop().replace(/\/\d+$/, "");
        let m = /^text-sf-([a-z0-9-]+)$/.exec(cls) || /^text-(header-fg|header-muted|hero-fg|hero-muted)$/.exec(cls);
        if (m && B.ROLE_IDS.includes(KIT_CLASS_ROLES[m[1]] || m[1])) text.set(KIT_CLASS_ROLES[m[1]] || m[1], rel);
        m = /^bg-sf-([a-z0-9-]+)$/.exec(cls) || /^bg-(header|hero)$/.exec(cls);
        if (m && B.ROLE_IDS.includes(KIT_CLASS_ROLES[m[1]] || m[1])) bg.set(KIT_CLASS_ROLES[m[1]] || m[1], rel);
      }
    }
  }
  return { text, bg };
}
// Backgrounds that never carry text of their own: scrims, photo placeholders,
// the hero glow, and fills whose text pair is listed under another name.
const BG_WITHOUT_TEXT = {
  overlay: "a scrim over the page or a photo",
  media: "behind a collection photo; the name sits on the scrim",
  "hero-glow": "a blurred decoration",
  "hero-accent": "the dot in the hero badge (pair hero-dot, decorative)",
  "success-soft": "pair success-chip",
  "warning-soft": "pair warning",
};

await t("every role used as a text colour by a storefront component is the foreground of a pair in PAIRS", () => {
  const { text } = rolesUsed();
  const fgs = new Set(B.PAIRS.map((p) => p.fg));
  const missing = [...text.entries()].filter(([id]) => !fgs.has(id)).map(([id, f]) => `${id} (${f})`);
  ok(!missing.length, `text roles with no pair: ${missing.join(", ")}`);
  ok(text.size >= 20, `only ${text.size} text roles found: the scan is broken`);
});

await t("every role used as a background by a storefront component is in PAIRS, or named as carrying no text", () => {
  const { bg } = rolesUsed();
  const bgs = new Set(B.PAIRS.flatMap((p) => [p.bg, p.fg]));
  const missing = [...bg.entries()].filter(([id]) => !bgs.has(id) && !BG_WITHOUT_TEXT[id]).map(([id, f]) => `${id} (${f})`);
  ok(!missing.length, `background roles with no pair: ${missing.join(", ")}`);
});

await t("every pair names roles that exist, a known kind, and a renderer file that exists and uses its foreground", () => {
  for (const p of B.PAIRS) {
    ok(B.ROLE_IDS.includes(p.fg) && B.ROLE_IDS.includes(p.bg), `${p.id}: unknown role`);
    ok(p.kind in B.PAIR_NEEDS, `${p.id}: kind ${p.kind}`);
    ok(statSync(join(ROOT, p.where), { throwIfNoEntry: false }), `${p.id}: ${p.where} doesn't exist`);
    ok(p.label && !/[{}]/.test(p.label), `${p.id}: label`);
  }
  const ids = B.PAIRS.map((p) => p.id);
  eq(new Set(ids).size, ids.length, "pair ids unique:");
});

// P1-CONTRAST: pairs, not just roles. scripts/token-pairs.js reads every
// storefront file for a text role drawn over a background role, on one
// element or nested inside one (see its header for what it can't see).
// Every pair it finds must be in PAIRS, or below with the reason it is not
// a real pair. An entry the scan no longer finds fails, so the list only
// shrinks.
const PAIR_SCAN_EXEMPT = [
  {
    pair: "on-inverse-muted|surface",
    file: "app/(storefront)/collections/[handle]/page.js",
    reason: "The filter chip's count. It turns on-inverse-muted only when the chip is active and inverse (pair on-inverse-muted); the scan can't tie the count's `active ?` to the chip's.",
  },
  {
    pair: "text-faint|inverse",
    file: "app/(storefront)/collections/[handle]/page.js",
    reason: "The same count, the other way round: text-faint only on the inactive chip, which is the page surface (pair text-faint).",
  },
];
const scanPairs = () => {
  const out = [];
  for (const rel of storefrontFiles()) {
    if (allowed(rel)) continue;
    for (const p of drawnPairs(readFileSync(join(ROOT, rel), "utf8"), B.ROLE_IDS)) out.push({ ...p, file: rel });
  }
  return out;
};

await t("the pair scan finds a pair on one element, across a template's branches, through a same-file constant, nested, and under inherited text", () => {
  const src = `
    const activeCls = (i) => (i === active ? "bg-sf-surface-sunken" : "hover:bg-sf-surface-muted");
    const STATUS = { a: "bg-sf-success-soft text-sf-success", b: "bg-sf-warning-soft text-sf-warning" };
    export default function X({ on, s }) {
      return (
        <div className="bg-sf-surface-muted">
          {/* a comment before a tag */}
          <p className="text-sf-text-body">Nothing here</p>
          <button className={\`px-2 text-sf-accent-text \${on ? "bg-sf-accent-soft" : "hover:bg-sf-surface-sunken"}\`}>Go</button>
          <span className={\`block text-sf-text-soft \${activeCls(1)}\`}>x</span>
          <span className={STATUS[s]}>ok</span>
          <span className="bg-sf-inverse">plain words</span>
          <i className="text-sf-mark disabled:bg-sf-surface-strong placeholder:text-sf-text-faint" />
        </div>
      );
    }`;
  const got = new Set(drawnPairs(src, B.ROLE_IDS).map((p) => `${p.fg}|${p.bg}`));
  for (const want of ["text-body|surface-muted", "accent-text|accent-soft", "accent-text|surface-sunken", "text-soft|surface-sunken", "text-soft|surface-muted", "success|success-soft", "warning|warning-soft", "foreground|inverse", "mark|surface-muted"])
    ok(got.has(want), `missed ${want}; found ${[...got].join(", ")}`);
  for (const not of ["success|warning-soft", "warning|success-soft", "mark|surface-strong", "text-faint|surface-muted"]) ok(!got.has(not), `${not} is not drawn, but the scan found it`);
});

await t("the pair scan finds each pair the TOK review found missing, in the real files", () => {
  const found = scanPairs();
  const at = (pair, file) => found.some((p) => `${p.fg}|${p.bg}` === pair && p.file === file);
  ok(at("text-body|surface-muted", "app/(storefront)/search/page.js"), "the search page's no-results panel");
  ok(at("text-body|surface-muted", "components/cart/CartDrawer.js"), "the cart drawer's button on hover");
  ok(at("accent-text|surface-sunken", "components/SearchBox.js"), "the search box's View all on hover");
  ok(at("on-overlay|media", "components/CollectionCard.js"), "collection names on the card");
  ok(found.length >= 200, `only ${found.length} drawn pairs found: the scan is broken`);
});

await t("every pair a storefront renderer draws is in PAIRS (pairs, not just roles)", () => {
  const listed = new Set(B.PAIRS.map((p) => `${p.fg}|${p.bg}`));
  const exempt = (p) => PAIR_SCAN_EXEMPT.some((e) => e.pair === `${p.fg}|${p.bg}` && e.file === p.file);
  const missing = [...new Set(scanPairs().filter((p) => !listed.has(`${p.fg}|${p.bg}`) && !exempt(p)).map((p) => `${p.fg} on ${p.bg} (${p.file}:${p.line}, ${p.how})`))];
  ok(!missing.length, `pairs drawn but not in PAIRS:\n      ${missing.join("\n      ")}`);
});

await t("each pair the scan is excused from has a reason and is still found", () => {
  const found = scanPairs();
  for (const e of PAIR_SCAN_EXEMPT) {
    ok(e.reason.length > 40, `${e.pair}: a written reason`);
    ok(!B.PAIRS.some((p) => `${p.fg}|${p.bg}` === e.pair), `${e.pair} is in PAIRS now: remove the exemption`);
    ok(found.some((p) => `${p.fg}|${p.bg}` === e.pair && p.file === e.file), `${e.pair} in ${e.file} is no longer found: remove the exemption`);
  }
});

// The two pairs batch C's drills measured under 4.5:1 (P1-DRILLS-C findings
// 2 and 4), on every look a shopper can get: no brand on both kits, the
// Pulse kit's own brand, and both test themes.
const LOOKS = {
  "no brand, Pulse": [null, "pulse-1"],
  "no brand, Glow": [null, "glow-1"],
  "the Pulse kit's brand": [{ accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b" }, "pulse-1"],
  "the Glow kit's brand": [{ accent: "#e11d48", background: "#fffbf7", foreground: "#1c1917" }, "glow-1"],
  "light test theme": [{ accent: "#c2410c", background: "#fffdf8", foreground: "#1c1917" }, "glow-1"],
  "dark test theme": [{ accent: "#2dd4bf", background: "#0b0f17", foreground: "#f1f5f9" }, "pulse-1"],
};
const rolesOfClass = (cls) => {
  const text = [];
  const bg = [];
  for (const tok of cls.split(/\s+/)) {
    const r = classRole(tok, B.ROLE_IDS);
    if (r && !tok.includes(":")) (r.kind === "text" ? text : bg).push(r.role);
  }
  return { text, bg };
};
const readableEverywhere = (fg, bg, what) => {
  for (const [look, [brand, kit]] of Object.entries(LOOKS)) {
    const { roles } = B.brandRoles(brand, kit);
    const ratio = B.contrastRatio(roles[fg], roles[bg]);
    ok(ratio >= 4.5, `${what}, ${look}: ${fg} ${roles[fg]} on ${bg} ${roles[bg]} is ${ratio.toFixed(2)}:1`);
    ok(B.PAIRS.some((p) => p.fg === fg && p.bg === bg && p.kind === "text"), `${what}: ${fg} on ${bg} is not a text pair in PAIRS`);
  }
};

await t("FINDING 4: the wishlist's missing-photo \"?\" is 4.5:1 or better on every look, the default one included", () => {
  const src = readFileSync(join(ROOT, "components/WishlistPage.js"), "utf8");
  const m = /className="([^"]*)">\?</.exec(src);
  ok(m, 'the "?" placeholder is gone from WishlistPage.js: update this test');
  const { text, bg } = rolesOfClass(m[1]);
  eq(text.length, 1, `text roles on the "?": ${text}`);
  eq(bg.length, 1, `background roles on the "?": ${bg}`);
  readableEverywhere(text[0], bg[0], 'the wishlist "?"');
});

await t("FINDING 2: the content page's links (Home, Contact us) are 4.5:1 or better on every look, the Pulse kit's brand included", () => {
  const src = readFileSync(join(ROOT, "components/ContentPage.js"), "utf8");
  const links = [...src.matchAll(/<Link\b[^>]*?className="([^"]*)"[^>]*>\s*([^<]+?)\s*</g)].map((m) => ({ cls: m[1], label: m[2] }));
  for (const label of ["Home", "Contact us"]) ok(links.some((l) => l.label === label), `no "${label}" link with a className in ContentPage.js: ${JSON.stringify(links)}`);
  for (const l of links) {
    const { text } = rolesOfClass(l.cls);
    eq(text.length, 1, `"${l.label}" sets its own text role (it inherited the faint grey before):`);
    readableEverywhere(text[0], "surface", `"${l.label}"`);
  }
});

// ---------------------------------------------------------------------------
// the pixel comparison tool
// ---------------------------------------------------------------------------
console.log("— scripts/pixel-diff.js");

await t("comparePixels counts every changed pixel and its box; identical images give 0", () => {
  const img = (w, h, f) => ({ width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => f(i)) });
  const a = img(4, 3, () => 200);
  const b = img(4, 3, (i) => (i === (1 * 4 + 2) * 4 + 1 ? 201 : 200)); // pixel (2,1), green +1
  eq(comparePixels(a, a).differing, 0);
  for (let ch = 0; ch < 4; ch++) {
    const c = img(4, 3, (i) => (i === 5 * 4 + ch ? 199 : 200)); // pixel (1,1), one channel −1
    eq(comparePixels(a, c).differing, 1, `a change in channel ${"rgba"[ch]} only:`);
  }
  const r = comparePixels(a, b);
  eq(r.differing, 1);
  eq(JSON.stringify(r.box), JSON.stringify({ x: 2, y: 1, width: 1, height: 1 }));
  eq(comparePixels(a, b, { tolerance: 1 }).differing, 0, "tolerance 1:");
  eq(comparePixels(a, img(4, 4, () => 200)).sameSize, false);
});

// ---------------------------------------------------------------------------
// TOK-02: the pairing matrix at save and at publish
// ---------------------------------------------------------------------------
console.log("— TOK-02: the matrix (pure)");

const hasMatrix = typeof B.checkBrand === "function";
const needMatrix = () => ok(hasMatrix, "lib/brand.js has no checkBrand: only the single text-on-background check exists");
const TEST_THEMES = {
  light: { brand: { accent: "#c2410c", background: "#fffdf8", foreground: "#1c1917" }, kit: "glow-1" },
  dark: { brand: { accent: "#2dd4bf", background: "#0b0f17", foreground: "#f1f5f9" }, kit: "pulse-1" },
};
// a brand the old check passes (text 4.61:1 on white) while other pairs it
// draws fail: text on the light panels and grey chips
const BORDERLINE = { accent: "#0d9488", background: "#ffffff", foreground: "#757575" };
const DARK_TITLES = { accent: "#0d9488", background: "#0a0a0b", foreground: "#18181b" };
const BLACK_ACCENT = { accent: "#000000", background: "#fffdf8", foreground: "#1c1917" };

// The platform default look (no brand) keeps today's colours, so it keeps
// today's failing pairs. Pinned here so a change to it is a decision.
const PLATFORM_DEFAULT_FAILS = new Set(["text-subtle-sunken", "text-subtle-strong", "text-faint", "text-faint-panel", "text-faint-sunken", "mark", "placeholder", "placeholder-muted", "accent-strong", "accent-mark", "danger", "accent-text", "accent-text-panel", "accent-text-soft"]);
await t("every pair a renderer uses passes on both test themes (light on Glow, dark on Pulse)", () => {
  for (const [name, th] of Object.entries(TEST_THEMES)) {
    const bad = B.pairMatrix(th.brand, th.kit).filter((p) => p.enforced && !p.pass);
    ok(!bad.length, `${name}: ${bad.map((p) => `${p.id} ${p.fgHex}/${p.bgHex} ${p.ratio}<${p.need}`).join(", ")}`);
  }
});

await t("hero and header pairs are in the matrix and measured against the theme kit's own surfaces", () => {
  for (const id of ["hero-fg", "hero-muted", "hero-accent", "header-fg", "header-muted", "header-accent"]) ok(B.PAIRS.some((p) => p.id === id), `no ${id} pair`);
  const glow = B.pairMatrix(TEST_THEMES.light.brand, "glow-1").find((p) => p.id === "hero-muted");
  eq(glow.bgHex, B.KIT_SURFACES["glow-1"].hero.bg, "glow hero bg:");
  eq(glow.fgHex, B.KIT_SURFACES["glow-1"].hero.muted, "glow hero muted:");
});

await t("a failing hero pair in a theme's look is reported in plain words (a stand-in kit with a pale subtitle)", () => {
  needMatrix();
  B.KIT_SURFACES["tok-test-1"] = { header: { ...B.KIT_SURFACES["pulse-1"].header }, hero: { bg: "#ffffff", fg: "#111111", muted: "#dddddd" } };
  try {
    const r = B.checkBrand(TEST_THEMES.light.brand, { kit: "tok-test-1" });
    const i = r.issues.find((x) => x.pairs.includes("hero-muted"));
    ok(i && i.severity === "error", `no blocking hero-muted issue: ${JSON.stringify(r.issues)}`);
    ok(/Hero subtitle/.test(i.message) && /theme's look/.test(i.message), i.message);
  } finally {
    delete B.KIT_SURFACES["tok-test-1"];
  }
});

await t("every theme kit's own brand passes the whole matrix on its own kit", () => {
  const kits = { pulse: { kit: "pulse-1", brand: { accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b" } }, glow: { kit: "glow-1", brand: { accent: "#e11d48", background: "#fffbf7", foreground: "#1c1917" } } };
  for (const [name, k] of Object.entries(kits)) {
    const bad = B.pairMatrix(k.brand, k.kit).filter((p) => p.enforced && !p.pass && !PLATFORM_DEFAULT_FAILS.has(p.id));
    ok(!bad.length, `${name}: ${bad.map((p) => `${p.id} ${p.ratio}`).join(", ")}`);
  }
});

await t("the platform default look's own failing pairs are exactly the known list (an owner decision, not fixed here)", () => {
  const failing = B.pairMatrix(null).filter((p) => p.enforced && !p.pass).map((p) => p.id);
  for (const id of failing) ok(PLATFORM_DEFAULT_FAILS.has(id), `new failing pair on the default look: ${id}`);
  eq(failing.includes("text-faint"), true, "faint text at 2.6:1 is the known one:");
});

await t("THE BUG: the old single check passes a brand whose other pairs fail; the matrix finds them", () => {
  ok(B.contrastRatio(BORDERLINE.foreground, BORDERLINE.background) >= 4.5, "the borderline brand passes text-on-background");
  needMatrix();
  const r = B.checkBrand(BORDERLINE);
  ok(!r.ok, "the matrix must refuse it");
  ok(r.failing.some((f) => !/^(body|inherited)$/.test(f.pair)), `only the text-on-background pair was caught: ${JSON.stringify(r.failing.map((f) => f.pair))}`);
});

await t("NEGATIVE: dark background with dark product titles: refused, naming the pair and a suggestion that passes", () => {
  needMatrix();
  const r = B.checkBrand(DARK_TITLES);
  eq(r.ok, false);
  const i = r.errors[0];
  ok(/^Product titles, prices and body text: #18181b on #0a0a0b has a contrast of 1\.12 to 1, and small text needs at least 4\.5 to 1/.test(i.message), i.message);
  ok(i.suggestion && i.suggestion.token === "foreground", JSON.stringify(i.suggestion));
  ok(i.message.includes(`Try text colour ${i.suggestion.value}.`), i.message);
  ok(B.checkBrand({ ...DARK_TITLES, foreground: i.suggestion.value }).ok, `the suggestion ${i.suggestion.value} still fails`);
});

await t("the suggestion is the NEAREST passing colour: one step closer to the chosen colour fails", () => {
  needMatrix();
  const s = B.suggestFix(DARK_TITLES, "pulse-1", "foreground");
  const hsl = (hex) => {
    const [r, g, b] = B.hexToRgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return (max + min) / 2;
  };
  const l0 = hsl(DARK_TITLES.foreground);
  const l1 = hsl(s.value);
  ok(l1 > l0, "suggests lighter text on a dark background");
  // the same hue at 0.02 less lightness must still fail somewhere
  const closer = B.mixHex(DARK_TITLES.foreground, s.value, 0.9);
  ok(!B.checkBrand({ ...DARK_TITLES, foreground: closer }).ok, `${closer} (closer) already passes, so ${s.value} isn't the nearest`);
});

await t("NEGATIVE: a black accent never gives a 2.08:1 hero highlight: corrected, and the save answer says so", () => {
  // before: the hero highlight was the accent's 400 shade on the hero
  const raw400 = B.accentShades("#000000")[400];
  ok(Math.abs(B.contrastRatio(raw400, B.KIT_SURFACES["pulse-1"].hero.bg) - 2.08) < 0.01, `raw ${raw400}`);
  const hero = B.pairMatrix(BLACK_ACCENT).find((p) => p.id === "hero-accent");
  ok(hero.ratio >= 4.5, `hero highlight ${hero.fgHex} at ${hero.ratio}`);
  needMatrix();
  const r = B.checkBrand(BLACK_ACCENT);
  ok(r.notes.some((n) => /hero highlight/i.test(n) && n.includes(hero.fgHex)), `no note: ${JSON.stringify(r.notes)}`);
});

await t("unchanged failing pairs warn; changed ones block (comparison is by the colours the shopper sees)", () => {
  needMatrix();
  const live = DARK_TITLES;
  const same = B.checkBrand({ ...DARK_TITLES, radius: "lg" }, { live });
  eq(same.ok, true, "same colours as live:");
  ok(same.warnings.length > 0 && same.warnings.every((w) => /already shows this/.test(w.message)), JSON.stringify(same.warnings));
  const moved = B.checkBrand({ ...DARK_TITLES, foreground: "#202020" }, { live });
  eq(moved.ok, false, "a changed text colour that still fails:");
});

await t("a failing pair's group is one plain message, not one per pair", () => {
  needMatrix();
  const r = B.checkBrand(DARK_TITLES);
  eq(r.errors.length, 1);
  ok(r.failing.length > 10, `${r.failing.length} pairs fail`);
  ok(/\(\d+ more colour pairs on your store have the same problem\)/.test(r.errors[0].message), r.errors[0].message);
});

await t("a malformed colour is still refused at save; readability never is", () => {
  eq(B.validateBrand({ accent: "green" }).ok, false);
  eq(B.validateBrand(DARK_TITLES).ok, true, "dark titles at save:");
});

// Fix round 1. The platform's own look (no brand, or the platform's white and
// #0a0a0b) keeps the default greys and status colours, whose failing pairs
// are the platform's, not the founder's: they never block and never show.
const SEEDED = { accent: "#0d9488", background: "#fffdf8", foreground: "#1c1917", radius: "xl", type_scale: "large" };
const PULSE_BRAND = { accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b", radius: "md", type_scale: "regular" };
const WHITE_BLUE = { accent: "#2563eb", background: "#ffffff", foreground: "#0a0a0b" };
await t("REGRESSION: over a store that had its own colours, a reset, the Pulse kit's brand and white/#0a0a0b with a new accent all publish", () => {
  for (const [name, draft] of Object.entries({ reset: null, pulse: PULSE_BRAND, whiteBlue: WHITE_BLUE })) {
    const r = B.checkBrand(draft, { kit: "pulse-1", live: B.resolveBrand(SEEDED), liveKit: "pulse-1" });
    eq(r.ok, true, `${name} ok (${JSON.stringify(r.errors.map((e) => e.message))}):`);
    eq(r.issues.length, 0, `${name}: the platform's own pairs are not reported (${JSON.stringify(r.issues.map((e) => e.message))}):`);
    ok(r.inherited.length > 0, `${name}: the default look's failing pairs are still listed as the platform's own`);
    eq(B.publishBlocked(draft, { kit: "pulse-1", live: B.resolveBrand(SEEDED), liveKit: "pulse-1" }), false, `${name} publishBlocked:`);
  }
});

await t("the platform's own pairs excuse only identical colours: a brand that moves a grey still blocks", () => {
  const r = B.checkBrand(BORDERLINE, { live: B.resolveBrand(SEEDED) });
  eq(r.ok, false);
  ok(r.failing.some((f) => f.severity === "error" && f.pair === "text-faint-sunken"), JSON.stringify(r.failing.map((f) => `${f.pair}:${f.severity}`)));
});

await t("NO BRAND on the Glow kit: header and hero accents are corrected against the kit, the page gets them, nothing blocks", () => {
  const raw = B.contrastRatio(B.DEFAULT_ACCENT_LADDER[400], B.KIT_SURFACES["glow-1"].header.bg);
  ok(raw < 3, `the uncorrected lime wordmark is ${raw.toFixed(2)}:1 on the cream header`);
  const m = B.pairMatrix(null, "glow-1");
  for (const id of ["header-accent", "hero-accent"]) ok(m.find((p) => p.id === id).pass, `${id} fails on Glow with no brand`);
  const r = B.checkBrand(null, { kit: "glow-1" });
  eq(r.ok, true, `first publish: ${JSON.stringify(r.errors.map((e) => e.message))}`);
  eq(B.publishBlocked(null, { kit: "glow-1" }), false, "publishBlocked:");
  ok(r.notes.some((n) => /header wordmark/.test(n)), `no note: ${JSON.stringify(r.notes)}`);
  const css = B.brandCssVars(null, { kit: "glow-1" });
  const hdr = m.find((p) => p.id === "header-accent").fgHex;
  ok(css.includes(`--sf-header-accent:${hdr};`) && css.includes("--sf-hero-accent:"), css);
  eq(B.brandCssVars(null, { kit: "pulse-1" }), "", "no brand on Pulse writes nothing (default look unchanged):");
});

// What the page renders, from the CSS the layout writes: each role's variable
// as brandCssVars sets it, else its globals.css default, following var()s.
function renderedRoles(brand, kit) {
  const css = B.brandCssVars(brand, { kit });
  const vars = Object.fromEntries([...css.matchAll(/--([\w-]+):([^;]+);/g)].map((m) => [m[1], m[2]]));
  const k = B.KIT_SURFACES[kit];
  const base = { background: "#ffffff", foreground: "#0a0a0b", "accent-label": "#0a0a0b" };
  for (const [part, s] of Object.entries(k)) for (const [key, v] of Object.entries(s)) base[`${part}-${key}`] = v;
  for (const [step, hex] of Object.entries(B.DEFAULT_ACCENT_LADDER)) base[`accent-${step}`] = hex;
  for (const r of B.ROLES) base[`sf-${r.id}`] = r.css && r.css.startsWith("var(") ? r.css : r.hex;
  const get = (name, depth = 0) => {
    const v = vars[name] ?? base[name];
    const m = /^var\(--([\w-]+)\)$/.exec(v || "");
    return m && depth < 8 ? get(m[1], depth + 1) : v;
  };
  return Object.fromEntries(B.ROLES.map((r) => [r.id, String(get(`sf-${r.id}`)).toLowerCase()]));
}
await t("what the page renders is what the matrix measures: every corrected or derived role reaches the CSS", () => {
  const cases = { seeded: [SEEDED, "pulse-1"], light: [TEST_THEMES.light.brand, "glow-1"], dark: [TEST_THEMES.dark.brand, "pulse-1"], black: [BLACK_ACCENT, "pulse-1"], pulse: [PULSE_BRAND, "pulse-1"], glowKit: [{ accent: "#e11d48", background: "#fffbf7", foreground: "#1c1917" }, "glow-1"], noBrandGlow: [null, "glow-1"], noBrandPulse: [null, "pulse-1"] };
  const used = new Set(B.PAIRS.flatMap((p) => [p.fg, p.bg]));
  for (const [name, [brand, kit]] of Object.entries(cases)) {
    const { roles } = B.brandRoles(brand, kit);
    const shown = renderedRoles(brand, kit);
    const off = [...used].filter((id) => shown[id] !== roles[id]).map((id) => `${id} page ${shown[id]} vs matrix ${roles[id]}`);
    ok(!off.length, `${name}: ${off.join(", ")}`);
  }
});

// P1-CONTRAST (TOK review, R12): every correction the matrix counts on is
// written into the CSS, for many brands, not only the eight above.
await t("R12: every accent correction and tint brandRoles makes is a --sf- line in brandCssVars, for 200 random brands, five named ones and no brand, on both kits", () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const hex = () => "#" + [0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join("");
  const brands = [null, PULSE_BRAND, WHITE_BLUE, BLACK_ACCENT, SEEDED];
  for (let i = 0; i < 100; i++) brands.push({ accent: hex() }, { accent: hex(), background: hex(), foreground: hex() });
  let corrections = 0;
  for (const brand of brands)
    for (const kit of ["pulse-1", "glow-1"]) {
      const resolved = brand ? B.resolveBrand(brand) : null;
      const css = B.brandCssVars(resolved, { kit });
      const { roles, ladder, corrections: list } = B.brandRoles(resolved, kit);
      for (const c of list) {
        corrections++;
        ok(css.includes(`--sf-${c.role}:${c.to};`), `${JSON.stringify(brand)} on ${kit}: ${c.role} corrected to ${c.to} but the CSS says ${/--sf-[\w-]+:[^;]+;/.exec(css.slice(css.indexOf(`--sf-${c.role}:`)))?.[0] || "nothing"}`);
      }
      for (const r of B.ROLES.filter((x) => x.from.startsWith("tint:"))) {
        const step = r.from.split(":")[1];
        if (roles[r.id] !== ladder[step]) ok(css.includes(`--sf-${r.id}:${roles[r.id]};`), `${JSON.stringify(brand)} on ${kit}: tint ${r.id} ${roles[r.id]} not written`);
      }
    }
  ok(corrections > 100, `only ${corrections} corrections across the brands: the sweep is not exercising roleCssLines`);
});

// P1-CONTRAST (TOK review): the storefront layout must send a store with no
// brand its kit's corrections. The chrome's brandCss expression is read from
// app/(storefront)/layout.js and run as written (the layout itself needs Next).
await t("the storefront layout's chrome calls brandCssVars for a store with no brand (Glow gets its corrected accents)", () => {
  const src = readFileSync(join(ROOT, "app/(storefront)/layout.js"), "utf8");
  const start = src.indexOf("async function chromeData(");
  const end = src.indexOf("\nasync function ", start + 10);
  ok(start >= 0 && end > start, "chromeData is gone from the layout: update this test");
  const body = src.slice(start, end);
  const lines = [...body.matchAll(/^\s*brandCss:\s*(.+),\s*$/gm)].map((m) => m[1]);
  ok(lines.length >= 1, "the chrome sets no brandCss");
  const live = lines.filter((e) => e.trim() !== '""');
  eq(live.length, 1, `one brandCss expression besides the error fallback (${JSON.stringify(lines)}):`);
  const Kits = { kitAttr: (theme) => `${theme?.kit || "pulse"}-${theme?.version || 1}` };
  let run;
  try {
    run = Function("brandCssVars", "resolveBrand", "kitAttr", "brand", "theme", `"use strict"; return (${live[0]});`);
  } catch (e) {
    throw new Error(`the layout's brandCss expression doesn't parse: ${live[0]} (${e.message})`);
  }
  const shown = (brand, theme) => run(B.brandCssVars, B.resolveBrand, Kits.kitAttr, brand, theme);
  const glow = shown(null, { kit: "glow", version: 1 });
  eq(glow, B.brandCssVars(null, { kit: "glow-1" }), "no brand on Glow:");
  ok(/--sf-header-accent:#[0-9a-f]{6};/.test(glow) && /--sf-hero-accent:#[0-9a-f]{6};/.test(glow), `no brand on Glow must carry the corrected accents: ${glow}`);
  eq(shown(null, null), "", "no brand, no theme (the default look) writes nothing:");
  eq(shown(PULSE_BRAND, { kit: "pulse", version: 1 }), B.brandCssVars(B.resolveBrand(PULSE_BRAND), { kit: "pulse-1" }), "the Pulse kit's brand:");
  eq(shown(SEEDED, { kit: "glow", version: 1 }), B.brandCssVars(B.resolveBrand(SEEDED), { kit: "glow-1" }), "a brand on Glow gets Glow's corrections:");
  // and the page writes what the chrome computed, guarded only by being non-empty
  ok(/\{chrome\.brandCss \? <style id="brand-vars"[^>]*>\{chrome\.brandCss\}<\/style> : null\}/.test(src), "the layout no longer writes chrome.brandCss into <style id=\"brand-vars\">");
});

await t("a theme kit change counts as a change: a pair the new kit breaks blocks even when the brand is the same as live", () => {
  B.KIT_SURFACES["tok-test-1"] = { header: { ...B.KIT_SURFACES["pulse-1"].header }, hero: { bg: "#ffffff", fg: "#111111", muted: "#dddddd" } };
  try {
    const r = B.checkBrand(TEST_THEMES.light.brand, { kit: "tok-test-1", live: TEST_THEMES.light.brand, liveKit: "glow-1" });
    ok(r.errors.some((e) => e.pairs.includes("hero-muted")), `not blocking: ${JSON.stringify(r.issues.map((i) => i.severity + " " + i.pair))}`);
    const same = B.checkBrand(TEST_THEMES.light.brand, { kit: "tok-test-1", live: TEST_THEMES.light.brand, liveKit: "tok-test-1" });
    ok(same.ok && same.warnings.some((w) => w.pairs.includes("hero-muted")), "the same kit live: a warning");
  } finally {
    delete B.KIT_SURFACES["tok-test-1"];
  }
});

await t("a mid-tone background where no text colour reads gets a background suggestion, not none", () => {
  const brand = { accent: "#0d9488", background: "#866ac7", foreground: "#746787" };
  const r = B.checkBrand(brand);
  const i = r.errors.find((e) => e.pairs.includes("body"));
  ok(i && i.suggestion, `no suggestion: ${JSON.stringify(r.errors.map((e) => e.message))}`);
  ok(/Try (text|background) colour #[0-9a-f]{6}\./.test(i.message), i.message);
  const fixed = { ...brand, [i.suggestion.token]: i.suggestion.value };
  ok(!B.checkBrand(fixed).failing.some((f) => f.severity === "error" && f.fix === "foreground"), `${i.suggestion.value} leaves text pairs failing`);
});

// ---------------------------------------------------------------------------
// TOK-02 through the real routes, on a real tenant database
// ---------------------------------------------------------------------------
console.log("— TOK-02: save and publish through the real code");

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const { rm, readFile } = await import("node:fs/promises");
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2).endsWith(".js") ? spec.slice(2) : `${spec.slice(2)}.js`)).href, ctx);
    if (/^next\/(server|headers|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-tokens-default.db";
process.env.PLATFORM_DB_URL = "file:.test-tokens-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "0";
const DBS = [".test-tokens-default.db", ".test-tokens-platform.db", ".test-tokens-tenant.db"];
for (const f of DBS) await rm(join(ROOT, f), { force: true });

const C = await import("../lib/platform/control.js");
const Sess = await import("../lib/platform/sessions.js");
const Id = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { createClient } = await import("@libsql/client");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const brandRoute = await import("../app/api/admin/brand/route.js");
const RelApi = await import("../lib/admin/releases-api.js");
const Resolve = await import("../lib/content/resolve.js");

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "tk", name: "Token Store", domains: ["tk.test"], dbUrl: "file:.test-tokens-tenant.db", config: {}, secrets: { order_link_secret: "tk-secret" } });
const tdb = createClient({ url: "file:.test-tokens-tenant.db" });
await tdb.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
await runMigrations(tdb, await loadMigrations("tenant"));
const owner = await Id.createUser({ email: "owner@tk.test", password: "owner-pass-tok" });
await Id.addMembership(owner.id, "tk", "owner");
const tok = (await Sess.createSession({ userId: owner.id, kind: "merchant", ttlMs: 600_000 })).token;
const inTk = async (fn) => withTenant(await C.getTenant("tk"), fn);
const req = (body) => ({
  headers: { get: (k) => ({ host: "tk.test", origin: "http://tk.test" })[k.toLowerCase()] ?? null },
  cookies: { get: (name) => (name === "_admin" ? { value: tok } : undefined) },
  json: async () => body,
});
const putBrand = async (body) => {
  const res = await inTk(() => brandRoute.PUT(req(body)));
  return { status: res.status, json: await res.json() };
};
const publish = async () => inTk(() => RelApi.handleReleasesPost(req({ action: "publish", note: "tok test" })));
const storedBrand = async () => (await C.getTenant("tk")).config?.brand || null;

await t("save never fails midway through a custom colour: dark text on a dark background is SAVED, with a warning and a suggestion", async () => {
  const r = await putBrand({ brand: DARK_TITLES });
  eq(r.status, 200, `status (body ${JSON.stringify(r.json).slice(0, 300)}):`);
  eq((await storedBrand())?.foreground, DARK_TITLES.foreground, "stored foreground:");
  const w = (r.json.warnings || []).join(" ");
  ok(/Product titles, prices and body text/.test(w) && /Try text colour #[0-9a-f]{6}/.test(w), `warnings: ${w}`);
});

await t("the read-only preview call answers the same warnings and stores nothing", async () => {
  const before = JSON.stringify(await storedBrand());
  const r = await putBrand({ preview: { ...DARK_TITLES, foreground: "#222222" } });
  eq(r.status, 200);
  ok((r.json.warnings || []).some((m) => /Product titles/.test(m)), JSON.stringify(r.json.warnings));
  eq(JSON.stringify(await storedBrand()), before, "nothing stored:");
});

await t("before the first publish, a saved brand that fails a pair is not shown to shoppers (drafts are the live store then)", async () => {
  const shown = await inTk(() => Resolve.resolvedBrand());
  eq(shown, null, "shoppers get the platform default look:");
});

await t("NEGATIVE: publishing a dark background with dark product titles is refused, in plain words naming the pair", async () => {
  const r = await publish();
  eq(r.status, 422, `status ${r.status} ${JSON.stringify(r.body).slice(0, 300)}:`);
  const msg = (r.body.errors || []).join(" ");
  ok(/Product titles, prices and body text: #18181b on #0a0a0b has a contrast of 1\.12 to 1/.test(msg), msg);
  ok(/Try text colour #[0-9a-f]{6}/.test(msg), msg);
  const i = r.body.issues.find((x) => x.code === "BRAND_PAIR");
  ok(i && i.documentId === "doc_design" && i.severity === "error", JSON.stringify(r.body.issues));
});

await t("the suggested colour publishes", async () => {
  const fix = B.checkBrand ? B.checkBrand(DARK_TITLES).errors[0].suggestion.value : "#888895";
  eq((await putBrand({ brand: { ...DARK_TITLES, foreground: fix } })).status, 200);
  const r = await publish();
  eq(r.status, 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 300)}:`);
});

await t("THE BUG, at publish: the old single check let a brand through whose text on light panels and grey chips fails", async () => {
  eq((await putBrand({ brand: BORDERLINE })).status, 200);
  const r = await publish();
  eq(r.status, 422, `publish answered ${r.status}`);
});

await t("a pair that already failed on the live store and wasn't changed warns but does not block", async () => {
  // put a failing brand live the way an old release could carry one
  const live = { ...BORDERLINE };
  await inTk(async () => {
    const id = "rel_toktestlive01";
    const content = { v: 3, blocks: {}, pages: [], brand: B.resolveBrand(live), theme: null, product_overrides: [], collection_pins: [], placements: [], redirects: [] };
    await tdb.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, 'old', NULL, ?, NULL, ?)", args: [id, JSON.stringify(content), "x".repeat(64), new Date().toISOString(), new Date().toISOString()] });
    await tdb.execute({ sql: "UPDATE release_state SET live_release_id = ? WHERE id = 1", args: [id] });
  });
  eq((await putBrand({ brand: { ...live, radius: "lg" } })).status, 200);
  const r = await publish();
  eq(r.status, 200, `publish answered ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  ok((r.body.published?.warnings || []).some((w) => /already shows this/.test(w)), `no warning: ${JSON.stringify(r.body.published)}`);
});

await t("NEGATIVE: a black accent saves with a note that the hero highlight uses a readable shade, and publishes", async () => {
  const r = await putBrand({ brand: BLACK_ACCENT });
  eq(r.status, 200);
  ok((r.json.notes || []).some((n) => /hero highlight/i.test(n)), `notes: ${JSON.stringify(r.json.notes)}`);
  const p = await publish();
  eq(p.status, 200, `publish ${p.status} ${JSON.stringify(p.body).slice(0, 200)}`);
});

// Fix round 1, through the founder's own calls: the Brand screen's save and
// reset, the theme library's apply (the console's default: brand unticked),
// and Publish.
const themeRoute = await import("../app/api/admin/theme/route.js");
const applyTheme = async (kit, withBrand) => {
  const res = await inTk(() => themeRoute.POST(req({ action: "apply", kit, withBrand, withPresets: false })));
  return { status: res.status, json: await res.json() };
};
const pubErr = (r) => `${r.status} ${JSON.stringify(r.body?.errors || r.body).slice(0, 400)}`;

await t("REGRESSION, real routes: with a theme pinned and the store's own colours live, Reset, the Pulse kit with its brand, and white/#0a0a0b with a new accent each publish", async () => {
  const goLive = async () => {
    eq((await putBrand({ brand: SEEDED })).status, 200, "seeded saves:");
    eq((await applyTheme("pulse", false)).status, 200, "pulse pinned:");
    const r = await publish();
    eq(r.status, 200, `seeded publishes: ${pubErr(r)}`);
  };
  await goLive();
  const reset = await putBrand({ reset: true });
  eq(reset.status, 200);
  eq((reset.json.warnings || []).length, 0, `reset shows nothing hard to read: ${JSON.stringify(reset.json.warnings)}`);
  let r = await publish();
  eq(r.status, 200, `reset publishes: ${pubErr(r)}`);

  await goLive();
  eq((await applyTheme("pulse", true)).status, 200);
  eq((await storedBrand())?.foreground, "#0a0a0b", "the kit's brand is the draft:");
  r = await publish();
  eq(r.status, 200, `the Pulse kit's brand publishes: ${pubErr(r)}`);

  await goLive();
  const s = await putBrand({ brand: WHITE_BLUE });
  eq(s.status, 200);
  eq(s.json.blocking, false, "nothing blocking:");
  ok(!(s.json.warnings || []).some((w) => /#080808|#fcfcfc/.test(w)), `odd suggestions: ${JSON.stringify(s.json.warnings)}`);
  r = await publish();
  eq(r.status, 200, `white/#0a0a0b with a blue accent publishes: ${pubErr(r)}`);
});

await t("NO BRAND, real routes: a store with no brand and no theme applies the Glow kit the console's default way and publishes", async () => {
  eq((await putBrand({ reset: true })).status, 200);
  await C.patchTenant("tk", { config: { theme: null } });
  let r = await publish();
  eq(r.status, 200, `no brand, no theme publishes: ${pubErr(r)}`);
  eq((await applyTheme("glow", false)).status, 200);
  eq(await storedBrand(), null, "still no brand:");
  r = await publish();
  eq(r.status, 200, `Glow with no brand publishes: ${pubErr(r)}`);
  // the Brand screen (its reset answer uses the same check as the page on
  // arrival) explains the corrected wordmark even with no brand saved
  const again = await putBrand({ reset: true });
  ok((again.json.notes || []).some((n) => /header wordmark/.test(n)), `notes: ${JSON.stringify(again.json.notes)}`);
});

await t("a theme-only change is checked at publish (no brand, a kit whose own hero subtitle is unreadable)", async () => {
  const Kits = await import("../lib/themes/kits.js");
  const Rel = await import("../lib/releases.js");
  Kits.KITS.toktest = { id: "toktest", version: 1 };
  B.KIT_SURFACES["toktest-1"] = { header: { ...B.KIT_SURFACES["pulse-1"].header }, hero: { bg: "#ffffff", fg: "#111111", muted: "#dddddd" } };
  try {
    const v = await inTk(() => Rel.validateRelease({ blocks: {}, pages: [], brand: null, theme: { kit: "toktest", version: 1 } }, { live: null }));
    ok(v.issues.some((i) => i.code === "BRAND_PAIR" && i.severity === "error" && /Hero subtitle/.test(i.message)), JSON.stringify(v.issues));
  } finally {
    delete Kits.KITS.toktest;
    delete B.KIT_SURFACES["toktest-1"];
  }
});

// P1-CONTRAST (TOK review, R2): the same, through Publish now on a real
// tenant: no brand saved, only the theme changes, and publishing is refused.
await t("R2, real routes: a store with no brand that only changes its theme kit is checked at Publish now, and refused", async () => {
  const Kits = await import("../lib/themes/kits.js");
  const was = (await C.getTenant("tk")).config?.theme ?? null;
  eq((await putBrand({ reset: true })).status, 200, "brand reset:");
  await C.patchTenant("tk", { config: { theme: { kit: "pulse", version: 1 } } });
  let r = await publish();
  eq(r.status, 200, `no brand on Pulse publishes first: ${pubErr(r)}`);
  Kits.KITS.toktest = { ...Kits.KITS.pulse, id: "toktest", version: 1, label: "Tok test" };
  B.KIT_SURFACES["toktest-1"] = { header: { ...B.KIT_SURFACES["pulse-1"].header }, hero: { bg: "#ffffff", fg: "#111111", muted: "#dddddd" } };
  try {
    await C.patchTenant("tk", { config: { theme: { kit: "toktest", version: 1 } } });
    eq(await storedBrand(), null, "still no brand:");
    r = await publish();
    eq(r.status, 422, `a theme whose hero subtitle is unreadable must not publish: ${pubErr(r)}`);
    const i = (r.body.issues || []).find((x) => x.code === "BRAND_PAIR" && x.severity === "error");
    ok(i && /Hero subtitle/.test(i.message), JSON.stringify(r.body.issues));
  } finally {
    await C.patchTenant("tk", { config: { theme: was } });
    delete Kits.KITS.toktest;
    delete B.KIT_SURFACES["toktest-1"];
  }
});

await t("the Publishing screen compares with the live store too: an unchanged failing pair is a warning there, not a blocker", async () => {
  await inTk(async () => {
    const id = "rel_toktestlive02";
    const content = { v: 3, blocks: {}, pages: [], brand: B.resolveBrand(BORDERLINE), theme: null, product_overrides: [], collection_pins: [], placements: [], redirects: [] };
    await tdb.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, 'old', NULL, ?, NULL, ?)", args: [id, JSON.stringify(content), "y".repeat(64), new Date().toISOString(), new Date().toISOString()] });
    await tdb.execute({ sql: "UPDATE release_state SET live_release_id = ? WHERE id = 1", args: [id] });
  });
  await C.patchTenant("tk", { config: { theme: null } });
  const saved = await putBrand({ brand: { ...BORDERLINE, radius: "lg" } });
  eq(saved.status, 200);
  ok(saved.json.warnings.length > 0 && saved.json.blocking === false, `already-live warnings don't block: ${JSON.stringify(saved.json).slice(0, 300)}`);
  const g = await inTk(() => RelApi.handleReleasesGet(req({})));
  eq(g.status, 200);
  const brandIssues = g.body.validation.issues.filter((i) => i.code === "BRAND_PAIR");
  ok(brandIssues.length > 0 && brandIssues.every((i) => i.severity === "warning"), JSON.stringify(brandIssues));
});

await t("the save answer says whether a warning would stop a publish (the toast's words depend on it)", async () => {
  const bad = await putBrand({ brand: DARK_TITLES });
  eq(bad.json.blocking, true, "dark titles block:");
  const fine = await putBrand({ brand: SEEDED });
  eq(fine.json.blocking, false, "seeded doesn't:");
});

for (const f of DBS) await rm(join(ROOT, f), { force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
