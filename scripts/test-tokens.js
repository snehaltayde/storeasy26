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
];
const allowed = (rel) => ALLOWLIST.find((a) => [].concat(a.path).some((p) => rel === p || (p.endsWith("/") && rel.startsWith(p))));

const PALETTES = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white";
const COLOUR_PROPS = "bg|text|border|border-[trblxy]|ring|ring-offset|divide|outline|fill|stroke|from|via|to|decoration|placeholder|caret|accent|shadow";
// One class (variants such as hover: stripped) → the rule it breaks, or null.
export const RULES = [
  { id: "palette colour", re: new RegExp(`^(?:${COLOUR_PROPS})-(?:${PALETTES})(?:-\\d{2,3})?(?:\\/\\d+)?$`) },
  { id: "accent ladder step (use an accent role)", re: /^(?:bg|text|border|ring|divide|outline|fill|stroke|from|via|to|decoration)-accent-(?:\d{2,3}|label)(?:\/\d+)?$/ },
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
      const cls = raw.replace(/^!/, "").split(":").pop().replace(/^!/, "");
      const rule = RULES.find((r) => r.re.test(cls));
      if (rule) found.push({ cls: raw, rule: rule.id });
    }
  }
  // inline style colours: style={{ color: "#…" }} and friends. A colour handed
  // to a third party (Razorpay's own window theme in CheckoutFlow) is not
  // page style and is not matched.
  for (const m of src.matchAll(/style=\{\{[^}]*?\b(color|background|backgroundColor|borderColor)\s*:\s*["'`](#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/g)) found.push({ cls: m[0].slice(m[0].indexOf(m[1])), rule: "inline style colour" });
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
    const e = <div style={{ color: "#123456" }} />;`;
  const hits = lintSource(src).map((h) => h.cls);
  for (const want of ["text-zinc-500", "hover:bg-white/95", "md:border-red-200", "group-hover:text-accent-700", "bg-accent-400", "text-accent-label", "bg-[#ff0000]", "text-[rgb(1,2,3)]", "shadow-[0_1px_2px_rgba(0,0,0,0.1)]", "text-[11px]", "rounded-2xl", "rounded-t-xl", "rounded", "rounded-[9px]"]) {
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

await t("a brand with exactly the platform's colours (the Pulse kit's brand) writes no role variable", () => {
  eq(B.roleCssLines(B.resolveBrand({ accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b" }), "pulse-1").length, 0);
  const css = B.brandCssVars(B.resolveBrand({ accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b", radius: "xl" }));
  ok(!css.includes("--sf-"), `role variables written: ${css}`);
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

// ---------------------------------------------------------------------------
// the pixel comparison tool
// ---------------------------------------------------------------------------
console.log("— scripts/pixel-diff.js");

await t("comparePixels counts every changed pixel and its box; identical images give 0", () => {
  const img = (w, h, f) => ({ width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => f(i)) });
  const a = img(4, 3, () => 200);
  const b = img(4, 3, (i) => (i === (1 * 4 + 2) * 4 + 1 ? 201 : 200)); // pixel (2,1), green +1
  eq(comparePixels(a, a).differing, 0);
  const r = comparePixels(a, b);
  eq(r.differing, 1);
  eq(JSON.stringify(r.box), JSON.stringify({ x: 2, y: 1, width: 1, height: 1 }));
  eq(comparePixels(a, b, { tolerance: 1 }).differing, 0, "tolerance 1:");
  eq(comparePixels(a, img(4, 4, () => 200)).sameSize, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
